// Read delivery reports about one message from an IMAP mailbox. Read-only: EXAMINE and BODY.PEEK.
import tls from 'node:tls';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const args = process.argv.slice(2);
const name = args[args.indexOf('--connection') + 1];
const connections = JSON.parse(process.env.METHOD_ENVIRONMENT ?? '{}');
if (!name || !connections[name]) throw Error(`Observer connection ${name} is not configured`);
const url = new URL(connections[name]);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol !== 'imaps:' && !(url.protocol === 'imap:' && local)) throw Error('Use an imaps:// mailbox URL');
const password = process.env.MAIL_OBSERVER_PASSWORD;
if (!password) throw Error('MAIL_OBSERVER_PASSWORD is not set');
const mailbox = decodeURIComponent(url.pathname.slice(1) || 'INBOX');
const port = Number(url.port || (url.protocol === 'imaps:' ? 993 : 143));
const socket = url.protocol === 'imaps:' ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port });
socket.setTimeout(30_000, () => socket.destroy(Error('IMAP timeout')));

// A small reader for IMAP lines and {n} literals.
let buffer = Buffer.alloc(0), waiting = null, failure;
socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); waiting?.(); });
socket.on('error', error => { failure = error; waiting?.(); });
socket.on('close', () => { failure ??= Error('IMAP connection closed'); waiting?.(); });
const more = () => new Promise((resolve, reject) => {
  if (failure) return reject(failure);
  waiting = () => { waiting = null; if (buffer.length) resolve(); else reject(failure); };
});
async function line() {
  for (;;) {
    const end = buffer.indexOf('\r\n');
    if (end >= 0) {
      let text = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 2);
      const literal = /\{(\d+)\}$/.exec(text);
      if (literal) {
        const size = Number(literal[1]);
        while (buffer.length < size) await more();
        text += '\n' + buffer.subarray(0, size).toString('utf8'); buffer = buffer.subarray(size);
        text += await line();
      }
      return text;
    }
    await more();
  }
}
let tag = 0;
async function command(text) {
  const id = `m${++tag}`;
  socket.write(`${id} ${text}\r\n`);
  const untagged = [];
  for (;;) {
    const response = await line();
    if (response.startsWith(`${id} `)) {
      if (!/^\S+ OK/i.test(response)) throw Error(`IMAP ${text.split(' ')[0]} failed: ${response.slice(id.length + 1, 200)}`);
      return untagged;
    }
    untagged.push(response);
  }
}
const quote = value => '"' + String(value).replace(/["\\]/g, m => '\\' + m) + '"';
const since = new Date(Date.now() - 7 * 86_400_000);
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sinceText = `${since.getUTCDate()}-${months[since.getUTCMonth()]}-${since.getUTCFullYear()}`;

const greeting = await line();
if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw Error('Unexpected IMAP greeting');
await command(`LOGIN ${quote(decodeURIComponent(url.username))} ${quote(password)}`);
await command(`EXAMINE ${quote(mailbox)}`);
const search = await command(`UID SEARCH SINCE ${sinceText} OR TEXT ${quote(input.token)} OR FROM "mailer-daemon" FROM "postmaster"`);
const uids = search.flatMap(text => /^\* SEARCH/i.test(text) ? text.slice(8).trim().split(/\s+/).filter(Boolean) : []).slice(-50);
const recipient = String(input.inputs?.to ?? '').toLowerCase();
const observations = [];
for (const uid of uids) {
  const parts = (await command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.65536>)`)).join('\n');
  const header = key => (new RegExp(`^${key}:\\s*(.*)$`, 'im').exec(parts)?.[1] ?? '').trim();
  const lower = parts.toLowerCase();
  // Keep only what the judge needs; never the message text.
  observations.push({ source: 'imap', ref: `${mailbox}/uid:${uid}`, data: {
    from: header('From'), subject: header('Subject'), date: header('Date'),
    action: (/^action:\s*(\w+)/im.exec(parts)?.[1] ?? '').toLowerCase(), status: /^status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(parts)?.[1] ?? '',
    mentions_token: lower.includes(String(input.token).toLowerCase()), mentions_recipient: !!recipient && lower.includes(recipient),
  } });
}
await command('LOGOUT').catch(() => {});
socket.end();
console.log(JSON.stringify({ observations }));
