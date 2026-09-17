"""Read ordinary Markdown and collect source links without prescribing prose."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
from zoneinfo import ZoneInfo


def parse(text, day=None, marked=None, supporting=()):
    # Older approved documents have metadata and marker comments. They remain readable.
    front = re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)', text, re.S)
    metadata = {}
    if front:
        metadata = dict(line.split(':', 1) for line in front[1].splitlines() if ':' in line)
        metadata = {k.strip(): v.strip() for k, v in metadata.items()}
        text = text[front.end():]
    if day is None:
        day = {'day': metadata['date'], 'timezone': metadata['timezone']}
    date = dt.date.fromisoformat(day['day'])
    ZoneInfo(day['timezone'])
    # Supplement comments in existing examples delimit separate supporting documents.
    legacy = bool(re.search(r'<!-- (?:paragraph|supplement):', text))
    definitions = '\n'.join(re.findall(r'^\[[^\]]+\]: source:.*$', text, re.M)) if legacy else ''
    pieces = re.split(r'<!-- supplement: ([A-Za-z0-9_-]+) -->', text)
    supplements = []
    for i in range(1, len(pieces), 2):
        body = pieces[i+1].strip()
        title = re.search(r'^# (.+)$', body, re.M)
        supplements.append({'id': pieces[i], 'title': title[1] if title else pieces[i], 'text': body+'\n\n'+definitions})
    supplements.extend(supporting)
    text = pieces[0]+'\n\n'+definitions
    # The legacy format allowed reference definitions directly after paragraph text.
    if legacy:
        text = re.sub(r'(?m)^(\[[^\]]+\]: source:.*)$', r'\n\1', text)
    # Marker comments are optional; the Markdown parser generates block IDs.
    text = re.sub(r'<!--(?: paragraph:| time:).*?-->', '', text, flags=re.S)
    module = Path(marked or os.environ.get('DAILY_BRIEFING_MARKED') or Path(__file__).parent/'vendor/marked.mjs').resolve()
    code = r'''
import {marked} from MARKED;
let chunks=[];for await(const c of process.stdin)chunks.push(c);
const text=Buffer.concat(chunks).toString();
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const citations=[],photos=[],local_files=[];
const target=(href,image=false)=>{
 if (/^(https?:|#)/.test(href)) return;
 if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) throw Error(`Unsupported file target: ${href}`);
 const path=decodeURIComponent(href.split(/[?#]/)[0]);
 if (path.split(/[\\/]/).some(x=>x==='..'||x==='sensitive'||x==='.git'||x.startsWith('.env'))) throw Error(`Unsafe file target: ${href}`);
 if(path)local_files.push({path,image});
};
marked.use({renderer:{
 html(token){return token.text.startsWith('<!--')?'':escape(token.text)},
 link(token){
  const label=this.parser.parseInline(token.tokens), href=token.href;
  if(href.startsWith('source:')){const index=citations.length;citations.push({target:href.slice(7),label});return `<!--briefing-citation-${index}-->`}
  target(href); return `<a href="${escape(href)}" rel="noopener noreferrer">${label}</a>`;
 },
 image(token){
  if(token.href.startsWith('source:')){const index=photos.length;photos.push({id:token.href.slice(7),caption:token.text});return `<!--briefing-photo-${index}-->`}
  target(token.href,true); return `<img src="${escape(token.href)}" alt="${escape(token.text||'')}" loading="lazy">`;
 }
}});
const tokens=marked.lexer(text),blocks=[];
for(const token of tokens){
 if(token.type==='space')continue;
 const one=[token];one.links=tokens.links;
 const session=token.type==='paragraph' && token.tokens?.length===1 && token.tokens[0].type==='link' && /^sessions\.html#.+$/.test(token.tokens[0].href) ? token.tokens[0].href.split('#')[1] : undefined;
 blocks.push({type:token.type,depth:token.depth,text:token.text||'',html:marked.parser(one),...(session?{session}: {})});
}
process.stdout.write(JSON.stringify({blocks,citations,photos,local_files}));
'''.replace('MARKED', json.dumps(module.as_uri()))
    document = json.loads(subprocess.run(['node', '--input-type=module', '-e', code], input=text, text=True, capture_output=True, check=True).stdout)
    ranges = {}
    for citation in document['citations']:
        ids, sep, selection = citation.pop('target').partition('#L')
        citation['citations'] = ids.split(',')
        if not all(re.fullmatch(r'[A-Za-z0-9_-]+', cid) for cid in citation['citations']):
            raise ValueError('Invalid source record ID')
        if sep:
            match = re.fullmatch(r'(\d+)-L(\d+)', selection)
            if not match or len(citation['citations']) != 1:
                raise ValueError('A passage needs one source and #Lfirst-Llast')
            bounds = [int(match[1]), int(match[2])]
            key = 'lines-' + '-'.join(map(str, bounds))
            ranges.setdefault(ids, {})[key] = bounds
            citation['source_range'] = key
    heading = next((b['text'] for b in document['blocks'] if b['type']=='heading' and b.get('depth')==1), date.strftime('%A, %B %d').replace(' 0',' '))
    return {**document, 'day': date.isoformat(), 'timezone': day['timezone'], 'heading': heading,
            'title': metadata.get('title', heading), 'source_ranges': ranges, 'supplements': supplements}
