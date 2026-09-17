#!/usr/bin/env python3
"""Build the complete website from the writer's selected content.

Reads accepted prepared data and an Markdown briefing. Never rewrites either.
"""
import argparse
import datetime as dt
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit
from briefing_markdown import parse
from briefing_sessions import social_sessions
from briefing_progress import progress

TEMPLATES=Path(__file__).resolve().parent/'reader'


def load(path):return json.loads(path.read_text())
def optional(path):return load(path) if path.exists() else []
def h(value):return html.escape(str(value),quote=True)
def put(path,text):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);path.chmod(0o600)
def stamp(value):return dt.datetime.fromisoformat(value)
def clock(value):return stamp(value).strftime('%I:%M %p').lstrip('0')
def quotes(text):
    result=[];depth=0;start=0
    for i,char in enumerate(text):
        if char=='“':
            if depth==0:start=i+1
            depth+=1
        elif char=='”' and depth:
            depth-=1
            if depth==0:result.append(text[start:i])
    return result

def readable_time(e):
    time=e['time']
    return stamp(time['local']).strftime('%b %d · %I:%M %p').replace(' 0',' ') if time['local'] else time['day']
def host(url):return (urlsplit(url or '').hostname or '').removeprefix('www.').removeprefix('mobile.')
def safe_url(url):return url if urlsplit(url or '').scheme in ['http','https'] else ''

def render_markdown(texts,marked,source_urls=None):
    # Original HTML is shown as source text. Links open HTTP(S), anchors, or local website pages.
    code="""import {marked} from MARKED;
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
marked.use({renderer:{html(token){return escape(token.text)},link(token){let label=this.parser.parseInline(token.tokens);let href=token.href;if(href.startsWith('source:')){const ids=href.slice(7).split(',');return ids.map((id,i)=>{if(!Object.hasOwn(sources,id))throw Error('Unknown source record: '+id);return '<a target="_blank" rel="noopener noreferrer" href="'+escape(sources[id])+'">'+(i===0?label:'['+(i+1)+']')+'</a>'}).join(' ')}return /^(https?:|#|[a-zA-Z0-9_-]+[.]html(?:#|$))/.test(href)?'<a target="_blank" rel="noopener noreferrer" href="'+escape(href)+'">'+label+'</a>':label},image(token){return escape(token.text||'Image referenced in saved text')}}});
let chunks=[];for await(const c of process.stdin)chunks.push(c);const {texts:inputs,sources}=JSON.parse(Buffer.concat(chunks).toString());
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,marked.parse(value)]))));
""".replace('MARKED',json.dumps(marked.resolve().as_uri()))
    return json.loads(subprocess.run(['node','--input-type=module','-e',code],input=json.dumps({'texts':texts,'sources':source_urls or {}}),text=True,capture_output=True,check=True).stdout)


def convert_photo(original,target):
    from PIL import Image, ImageOps
    from pillow_heif import register_heif_opener
    register_heif_opener()
    with Image.open(original) as source:
        preview=ImageOps.exif_transpose(source)
        preview.thumbnail((1600,1600))
        if preview.mode in ('RGBA','LA') or 'transparency' in preview.info:
            rgba=preview.convert('RGBA');background=Image.new('RGB',rgba.size,'white');background.paste(rgba,mask=rgba.getchannel('A'));preview=background
        preview.convert('RGB').save(target,format='JPEG',quality=85)


def build(prepared,briefing_file,out,marked,day=None,proposal=None):
    proposal=proposal or parse(briefing_file.read_text(),day,marked)
    dest=out
    dest.mkdir(parents=True,exist_ok=True)
    for name in ['reader.css','reader.js']:shutil.copyfile(TEMPLATES/name,dest/name)
    raw={f.stem:load(f) for f in (prepared/'records').glob('*.json')}
    records={cid:data['prepared'] for cid,data in raw.items()}
    entries={r['entry_id']:r for name in ['timeline.jsonl','untimed.jsonl'] for r in map(json.loads,(prepared/name).read_text().splitlines())}
    day=proposal['day']
    title=proposal['title']
    day_label=dt.date.fromisoformat(day).strftime('%b %d, %Y').replace(' 0',' ').upper()
    source_ids={cid:r['source_record_ids'] for r in entries.values() for cid in r['source_record_ids']}
    documents=load(prepared/'metadata/documents.json')
    doc_by_record={cid:d for d in documents for cid in d['record_ids']}
    source_ranges=proposal.get('source_ranges',{})
    texts={cid:e['text'] for cid,e in records.items()}
    for supplement in proposal.get('supplements',[]):texts[supplement['id']]=supplement['text']
    for cid,ranges in source_ranges.items():
        for name,(first,last) in ranges.items():texts[cid+':'+name]='\n'.join(texts[cid].splitlines()[first-1:last])
    contexts=optional(prepared/'context.json')
    for c in contexts:
        data=load(prepared/c['source_json'])
        for r in data['records']:texts['context-'+(r.get('message_id') or r['id'])]=r['text']
    def document_page(doc):
        return 'source-'+Path(doc['path']).stem+'.html'
    source_urls={cid:document_page(doc)+'#'+cid for cid,doc in doc_by_record.items()}
    source_urls.update({s['id']:s['id']+'.html' for s in proposal.get('supplements',[])})
    rendered=render_markdown(texts,marked,source_urls)
    media={}
    for asset in optional(prepared/'media.json'):
        original=prepared/asset['path'];name=Path(asset['path']).stem+'.jpg';target=dest/'media'/name;target.parent.mkdir(exist_ok=True)
        if not target.exists():
            convert_photo(original,target)
        original_target=dest/asset['path'];original_target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(original,original_target)
        for cid in asset['records']:media[cid]={'png':'media/'+name,'original':asset['path']}
    def photo(cid,caption):
        asset=media[cid]
        return f'<figure class="photo"><button data-photo="{h(asset["png"])}" aria-label="Enlarge photo"><img src="{h(asset["png"])}" alt="{h(caption)}" loading="lazy"></button><figcaption>{h(caption)} · <a href="{h(asset["original"])}">Original</a></figcaption></figure>'
    groups=social_sessions(prepared)
    browser_rows=[r for r in entries.values() if records[r['source_record_ids'][0]]['source'] in ['browser','google_takeout']]
    navigation=' · '.join((['<a href="sessions.html">X and Instagram sessions</a>'] if groups else [])+(['<a href="browser.html">All browser visits</a>'] if browser_rows else []))
    def page(title,body):
        return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{h(title)}</title><link rel="stylesheet" href="reader.css"></head><body><nav><a href="index.html">{h(day_label)}</a><span>{navigation}</span></nav><main>{body}</main><dialog><button data-close-photo>Close</button><img alt=""></dialog><script src="reader.js"></script></body></html>'
    for supplement in proposal.get('supplements',[]):
        sid=supplement['id'];filename=sid+'.html'
        put(dest/filename,page(supplement['title'],'<h1>'+h(supplement['title'])+'</h1><div class="source-text">'+rendered[sid]+'</div>'))
        put(dest/'data'/f'{sid}.json',json.dumps({'id':sid,'html':rendered[sid],'time':'','date':'','speaker':'','basis':'','document':filename,'reading_label':'Full supporting document','ranges':{name:rendered[sid+':'+name] for name in source_ranges.get(sid,{})}},ensure_ascii=False))
    def speaker(e):
        role=e['actor_role']
        if e['source']=='imessage':return 'User' if role=='user_written' else e['attributes'].get('sender') or 'Not supplied'
        return {'user_written':'User','user':'User','assistant':'Assistant','other_person':'Other person'}.get(role,'')
    def record_html(cid):
        e=records[cid];meta=' · '.join(filter(None,[readable_time(e),speaker(e)]))
        return f'<article class="record" id="{h(cid)}"><div class="record-head">{h(meta)} <a href="records/{h(cid)}.json">Source JSON</a></div><div class="source-text">{rendered[cid]}</div>'+ (photo(cid,'Saved photo') if cid in media else '')+'</article>'
    for cid,e in records.items():
        doc=doc_by_record[cid];docname=document_page(doc)
        basis=('Saved with this activity' if e['text_basis']=='dated_google_activity_title' else 'Browser saved title') if e['source'] in ['browser','google_takeout'] else ''
        if e.get('post_text_partial'):basis+=' · partial saved title'
        data={'id':cid,'html':rendered[cid],'time':readable_time(e),'other_sources':[c for c in dict.fromkeys(source_ids.get(cid,[])) if c!=cid],'date':e['time']['day'],'speaker':speaker(e),'basis':basis,'document':docname+'#'+cid,'conversation':doc['kind']=='conversation','reading_label':'Read full conversation' if doc['kind']=='conversation' else 'Read full note' if e['source'] in ['roam','apple_notes'] else 'Read full document','ranges':{name:rendered[cid+':'+name] for name in source_ranges.get(cid,{})}}
        put(dest/'data'/f'{cid}.json',json.dumps(data,ensure_ascii=False))
        target=dest/'records'/f'{cid}.json';target.parent.mkdir(exist_ok=True);shutil.copyfile(prepared/'records'/f'{cid}.json',target)
    for doc in documents:
        body='<h1>'+h(doc['title'])+'</h1>'
        body+=''.join(record_html(cid) for cid in doc['record_ids'])
        put(dest/document_page(doc),page(doc['title'],body))
    for c in contexts:
        data=load(prepared/c['source_json']);body='<h1>'+h(c['title'])+'</h1><p class="small">Earlier conversation</p>'
        for r in data['records']:
            cid='context-'+(r.get('message_id') or r['id']);body+=f'<article id="{h(cid)}" class="record"><div class="record-head">{h(r.get("occurred_at") or r.get("day") or "Time not supplied")} · {h(r.get("role") or "")}</div><div class="source-text">{rendered[cid]}</div></article>'
        put(dest/('context-'+c['conversation_id']+'.html'),page(c['title'],body))
    def cite(ids,key,text='',label=None,range_name=None):
        return f'<button class="{("source-link" if label else "cite")}" data-ids="{h(json.dumps(ids))}" data-quotes="{h(json.dumps(quotes(text)))}" data-panel="{h(key)}"'+(f' data-range="{h(range_name)}"' if range_name else '')+f' aria-expanded="false" aria-label="{h(label or "Read supporting sources")}">{h(label or ("↗" if key.startswith("event-") else key))}</button>'
    def selected(row):
        sources=[(cid,records[cid]) for cid in row['source_record_ids']]
        dated=[(cid,e) for cid,e in sources if e['text_basis']=='dated_google_activity_title']
        if dated:
            titles={re.sub(r'^Visited\s+','',e['text']) for cid,e in dated}
            if len(titles)>1:return None
            cid,e=next(((cid,e) for cid,e in dated if not e['text'].startswith('Visited ')),dated[0])
        else:cid,e=sources[0]
        url=e['url'] or row.get('url') or ''
        is_instagram=e['platform']=='Instagram'
        if e['source']=='browser' and not dated:
            route=urlsplit(url).path
            if not re.search(r'/status/\d+|/(?:p|reel)/[^/]+',route):return None
        text=e.get('post_text') or (e['text'] if is_instagram and not e['text'].startswith('http') else '')
        text=html.unescape(text)
        if not text.strip() or text.strip().lower() in ['instagram','instagram photos and videos','home / x','x','twitter']:return None
        return {'id':row['entry_id'],'cid':cid,'text':text,'author':e.get('post_author') or '','url':url,'partial':e.get('post_text_partial',False),'time':row['time'],'source_ids':row['source_record_ids'],'platform':e['platform']}
    def post_row(row):
        sel=selected(row);e=records[row['source_record_ids'][0]];url=(sel or {}).get('url') or row.get('url') or e['url'] or ''
        ids=row['source_record_ids'];key=row['entry_id']+'-full'
        title=(sel or {}).get('text') or row.get('url') or row.get('title') or e['event_kind']
        who=(sel or {}).get('author','');body=h(title)
        link=safe_url(url)
        if sel:body='“'+h(title)+'”'
        if link:body=f'<a class="original" href="{h(link)}" target="_blank" rel="noopener noreferrer">'+body+'</a>'
        if sel and sel['partial']:body+='<span class="partial" title="The saved post text is incomplete." aria-label="The saved post text is incomplete."> …</span>'
        if who:body='<strong>'+h(who)+'</strong> '+body
        time=clock(row['time']) if row['time'] else 'Untimed'
        return f'<li class="evidence-host" data-entry="{h(row["entry_id"])}"><div class="post"><time datetime="{h(row["time"])}">{h(time)}</time><div class="post-text">'+body+' '+cite(ids,key,'“'+title+'”',label=None)+'</div></div></li>'
    for g in groups:
        g['full'].sort(key=lambda r:(stamp(r['time']),records[r['source_record_ids'][0]]['source_order'],r['entry_id']))
    def session_html(g):
        label=g['platform']+' '+clock(g['start'])
        if g['start']!=g['end']:label+='–'+clock(g['end'])
        label+=f" · {len(g['full'])} records"
        return f'<section class="session" id="{h(g["id"])}"><h3>{h(label)}</h3><div class="session-preview"><ol class="records">'+''.join(post_row(r) for r in g['social'] if selected(r))+'</ol></div><details class="full-session"><summary>Show all</summary><ol class="records">'+''.join(post_row(r) for r in g['full'])+'</ol></details></section>'
    put(dest/'sessions.html',page('X and Instagram sessions','<h1>X and Instagram sessions</h1>'+(''.join(session_html(g) for g in groups) or '<p>No saved social sessions for this day.</p>')))
    if browser_rows: put(dest/'browser.html',page('All browser visits','<h1>All browser visits</h1><ol class="records" style="max-height:none">'+''.join(post_row(r) for r in browser_rows)+'</ol>'))
    library='<h1>Full documents</h1><ul class="simple-list">'+''.join('<li><a href="'+h(document_page(d))+'">'+h(d['title'])+'</a></li>' for d in documents)+'</ul>'
    if contexts:library+='<h2>Earlier conversations</h2><ul>'+''.join('<li><a href="context-'+c['conversation_id']+'.html">'+h(c['title'])+'</a></li>' for c in contexts)+'</ul>'
    put(dest/'documents.html',page('Full documents',library))
    story=''
    sessions_by_id={g['id']:g for g in groups}
    for n,block in enumerate(proposal['blocks'],1):
        if block.get('session'):
            session=sessions_by_id.get(block['session'])
            if session is None:
                warning='Session link '+block['session']+' was not found. Linking to all saved social sessions.'
                print(warning,file=sys.stderr)
                progress(warning)
                story+='<p>This session link could not be found. <a href="sessions.html">View all saved social sessions</a>.</p>'
            else:
                story+=session_html(session)
            continue
        body=block['html']
        if block['type']=='paragraph':body=body.replace('<p>', '<p class="story-p">', 1)
        for i,citation in enumerate(proposal['citations']):
            label=citation['label']
            button=cite(citation['citations'],f'{n}-{i}',text=block['text'],label='Source',range_name=citation.get('source_range'))
            button=button.replace('>Source</button>', '>'+label+'</button>')
            body=body.replace(f'<!--briefing-citation-{i}-->',button)
        for i,asset in enumerate(proposal['photos']):
            body=body.replace(f'<!--briefing-photo-{i}-->',photo(asset['id'],asset['caption']))
        story+=f'<div class="evidence-host" id="p{n}">'+body+'</div>'
    story+='<footer><a href="documents.html">Full documents</a></footer>'
    put(dest/'index.html',page(title,story))
    put(dest/'display-groups.json',json.dumps([{'id':g['id'],'parent':g['parent'],'platform':g['platform'],'start':g['start'],'end':g['end'],'full':[r['entry_id'] for r in g['full']]} for g in groups],indent=2))
    print(json.dumps({'output':str(out),'blocks':len(proposal['blocks']),'display_groups':len(groups),'source_records':len(records)}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['prepared','briefing','out','marked']:parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args();build(args.prepared,args.briefing,args.out,args.marked)
