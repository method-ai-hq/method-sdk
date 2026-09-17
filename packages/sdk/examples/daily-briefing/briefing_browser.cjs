// Open the actual saved website. Return its exact rendered text and available links.
// No model calls. Each request gets a fresh local page; the saved files stay unchanged.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.DAILY_BRIEFING_PLAYWRIGHT);

async function main(input) {
  const root = await fs.realpath(path.join(process.env.DAILY_BRIEFING_EXAMPLE, 'website'));
  const presentation = 'website/reader.css';
  async function file(name) {
    const p = await fs.realpath(path.resolve(root, name));
    if (p !== root && !p.startsWith(root + path.sep)) throw Error('Path leaves the website');
    return p;
  }
  const types = {'.html':'text/html; charset=utf-8','.json':'application/json','.js':'text/javascript',
    '.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
  const server = http.createServer(async (req,res) => {
    try {
      const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1) || 'index.html';
      const p = await file(name);
      res.setHeader('Content-Type',types[path.extname(p)] || 'application/octet-stream');
      res.end(await fs.readFile(p));
    } catch {res.writeHead(404);res.end('File not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const requested = new URL(input.page, 'http://example/');
    if (requested.origin !== 'http://example') throw Error('Use a relative website page');
    await file(decodeURIComponent(requested.pathname).slice(1));
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:960,height:1050}});
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + requested.pathname + requested.search + requested.hash);
    let scope = page.locator('body');
    if(input.action === 'citation') {
      const button = page.locator(`[data-panel=${JSON.stringify(input.target)}]`).first();
      await button.evaluate(e=>e.closest('.evidence-host').setAttribute('data-inspect','current'));
      scope = page.locator('[data-inspect="current"]');
      const expected = JSON.parse(await button.getAttribute('data-ids')).length;
      await button.click();
      await page.waitForFunction(count=>document.querySelector('[data-inspect="current"] .evidence')?.querySelectorAll('.record').length===count,expected,{timeout:10000});
      scope = scope.locator('.evidence-scroll');
    } else {
      if(input.target) {
        scope = page.locator(`[id=${JSON.stringify(input.target)}]`);
        if(!await scope.count()) throw Error('Unknown target ID');
      }
      if(input.action === 'session') {
        const details = scope.locator('details.full-session').first();
        if(!await details.count()) throw Error('This target has no full session');
        await details.evaluate(e=>{e.open=true});
        scope = details;
      } else if(input.action !== 'read') throw Error('Choose read, citation, or session');
    }
    const text = await scope.innerText();
    if(!Number.isInteger(input.offset) || input.offset<0 || input.offset>text.length) throw Error('Invalid offset');
    const end = Math.min(text.length,input.offset+20000);
    const actions = await scope.evaluate(el=>Array.from(el.querySelectorAll('a[href],button[data-ids],details.full-session,img')).filter(e=>e.checkVisibility()).map(e=>{
      const owner=e.closest('.evidence-host,.session');
      if(e.tagName==='IMG')return {kind:'image',path:e.getAttribute('src'),text:e.getAttribute('alt')||''};
      if(e.tagName==='A')return {kind:'link',path:e.getAttribute('href'),text:e.innerText};
      return {kind:e.tagName==='DETAILS'?'session':'citation',target:e.tagName==='DETAILS'?(owner?.id||''):e.dataset.panel,text:e.tagName==='DETAILS'?e.querySelector('summary')?.innerText:e.innerText};
    }).filter(a=>a.kind==='link'||a.kind==='image'||a.target));
    return {content:text.slice(input.offset,end),next_offset:end<text.length?end:-1,total_chars:text.length,
      actions:JSON.stringify(actions),presentation,
      view:'Exact rendered text. Image paths and alt text are included; image pixels are not sent by this runtime.'};
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
let chunks=[];process.stdin.on('data',x=>chunks.push(x));
process.stdin.on('end',()=>main(JSON.parse(Buffer.concat(chunks))).then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1}));
