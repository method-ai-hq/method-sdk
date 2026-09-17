import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, cpSync, openSync, closeSync, symlinkSync } from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const methodCache = () => process.env.METHOD_CACHE_DIR ?? join(homedir(), '.cache', 'method');
const uvVersion = '0.8.22';
export async function command(program: string, args: string[], cwd: string, env = process.env) {
  try { return await exec(program, args, {cwd, env, maxBuffer: 8_000_000, timeout:600_000}); }
  catch (e: any) { throw Error(`${program} failed: ${e.stderr || e.message}`); }
}
async function uv() {
  const platform = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-gnu' : undefined;
  if (!platform || !['arm64','x64'].includes(process.arch)) throw Error('Managed Python supports macOS and glibc Linux on arm64 and x64. Supply a custom runtime on this system.');
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform}`;
  const root = join(methodCache(), 'tools', `uv-${uvVersion}-${target}`), bin = join(root, `uv-${target}`, 'uv');
  if (existsSync(bin)) return bin;
  mkdirSync(root, {recursive:true, mode:0o700});
  const name = `uv-${target}.tar.gz`, url = `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${name}`;
  const [archive, check] = await Promise.all([fetch(url), fetch(`${url}.sha256`)]);
  if (!archive.ok || !check.ok) throw Error('Could not download the managed Python installer. Retry this run.');
  const data = Buffer.from(await archive.arrayBuffer()), expected = (await check.text()).trim().split(/\s+/)[0];
  if (createHash('sha256').update(data).digest('hex') !== expected) throw Error('Python installer checksum failed.');
  const tmp = join(root, `download-${process.pid}`); mkdirSync(tmp, {recursive:true});
  writeFileSync(join(tmp, name), data);
  await command('tar', ['-xzf', join(tmp, name), '-C', tmp], root);
  try { renameSync(join(tmp, `uv-${target}`), join(root, `uv-${target}`)); } catch (e) { if (!existsSync(bin)) throw e; }
  rmSync(tmp, {recursive:true, force:true}); return bin;
}
async function npm(root: string, args: string[]) {
  const bundled = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  if (existsSync(bundled)) return command(process.execPath, [bundled, ...args], root);
  return command(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, root);
}
export async function lockDependencies(root: string) {
  if (existsSync(join(root,'package.json')) && !existsSync(join(root,'package-lock.json'))) await npm(root, ['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund']);
  if (existsSync(join(root,'pyproject.toml')) && !existsSync(join(root,'uv.lock'))) await command(await uv(), ['lock','--project',root], root);
}
export async function prepareRuntime(root:string,config:any,method:any) {
  for(let attempt=0;;attempt++)try{return await prepareOnce(root,config,method);}catch(error:any){if(attempt||error.code!=='cache_damaged')throw error;}
}
async function prepareOnce(root: string, config: any, method: any) {
  const files = ['package.json','package-lock.json','pyproject.toml','uv.lock'];
  const hasNode = existsSync(join(root,'package.json')), hasPython = existsSync(join(root,'pyproject.toml'));
  if (hasNode && !existsSync(join(root,'package-lock.json')) || hasPython && !existsSync(join(root,'uv.lock'))) throw Error('Save this Method with its dependency lockfiles before running it.');
  const nodePackage = hasNode ? JSON.parse(readFileSync(join(root,'package.json'),'utf8')) : {};
  const hasNodeDependencies = ['dependencies','devDependencies','optionalDependencies'].some(key => Object.keys(nodePackage[key] ?? {}).length > 0);
  const runtimes = {...config.runtimes};
  const executions = Object.values(method.steps).flatMap((s:any) => [s.do,s.check]).filter(Boolean) as any[];
  for (const tool of Object.values(config.tools ?? {}) as any[]) executions.push(tool.run);
  const needsPython = hasPython || executions.some(e => e?.runtime === 'python' && !runtimes.python);
  const key = createHash('sha256').update(JSON.stringify([process.platform, process.arch, process.version, needsPython, ...files.map(n => existsSync(join(root,n)) ? readFileSync(join(root,n),'utf8') : null)])).digest('hex');
  const cache = join(methodCache(),'environments',key), ready = join(cache,'ready.json');
  mkdirSync(dirname(cache), {recursive:true,mode:0o700});
  const lock = `${cache}.lock`; let fd:number|undefined;
  const until = Date.now()+600_000;
  while (fd === undefined) {
    try { fd = openSync(lock,'wx',0o600); writeFileSync(fd,String(process.pid)); }
    catch (e:any) {
      if (e.code !== 'EEXIST') throw e;
      try { const pid = Number(readFileSync(lock,'utf8')); if (pid > 0) process.kill(pid,0); } catch(e:any) { if (e.code === 'ESRCH') { rmSync(lock,{force:true}); continue; } }
      if (Date.now()>until) throw Error('Another process is preparing this Method. Wait, then run again.');
      await new Promise(r=>setTimeout(r,300));
    }
  }
  try {
    if (!existsSync(ready)) {
      rmSync(cache,{recursive:true,force:true}); mkdirSync(cache,{recursive:true,mode:0o700});
      for (const name of files) if (existsSync(join(root,name))) cpSync(join(root,name),join(cache,name));
      if (hasNode) await npm(cache,['ci','--engine-strict','--no-audit','--no-fund']);
      if (needsPython) {
        const uvBin = await uv();
        if (hasPython) await command(uvBin,['sync','--locked','--no-install-project','--project',cache],cache);
        else await command(uvBin,['venv','--python','3.12',join(cache,'.venv')],cache);
      }
      const browser = join(cache,'node_modules','playwright','cli.js');
      if (existsSync(browser)) await command(process.execPath,[browser,'install','chromium'],cache);
      writeFileSync(`${ready}.tmp`,JSON.stringify({key,created_at:new Date().toISOString()}),{mode:0o600}); renameSync(`${ready}.tmp`,ready);
    }
    if(hasNodeDependencies&&!existsSync(join(cache,'node_modules','.package-lock.json'))){rmSync(ready,{force:true});throw Object.assign(Error('Rebuild incomplete Node packages.'),{code:'cache_damaged'});}
    const python = join(cache,'.venv','bin','python');
    if (needsPython) {
      try { await command(python,['-c','import sys; print(sys.version)'],cache); } catch(e) { rmSync(ready,{force:true}); throw Object.assign(e as Error,{code:'cache_damaged'}); }
      if (!runtimes.python) runtimes.python={command:python,version:(await command(python,['--version'],cache)).stdout.trim()};
    }
    if (executions.some(e=>e?.runtime==='node') && !runtimes.node) runtimes.node={command:process.execPath,version:process.version};
    const browser = join(cache,'node_modules','playwright','index.js');
    if (existsSync(browser)) {
      try { await command(process.execPath,['-e',`const {chromium}=require(${JSON.stringify(browser)}); (async()=>{const b=await chromium.launch({headless:true});try{const p=await b.newPage();await p.goto('data:text/html,<title>Method</title>');if(await p.title()!=='Method')throw Error('Browser page did not load');}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})`],cache); }
      catch(e:any) { throw Error(`The browser cannot start on this computer. ${e.message}`); }
    }
    return { config:{...config,runtimes}, processPath:[dirname(process.execPath),...(needsPython?[dirname(python)]:[]),process.env.PATH??''].join(delimiter),
      prepareBundle: async (bundle:string) => { const modules=join(cache,'node_modules'), dest=join(bundle,'node_modules'); if(existsSync(modules)&&!existsSync(dest)) symlinkSync(modules,dest,'dir'); } };
  } finally { closeSync(fd); rmSync(lock,{force:true}); }
}
