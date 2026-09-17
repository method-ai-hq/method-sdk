const cache=new Map();
async function record(id){if(!cache.has(id))cache.set(id,fetch(`data/${id}.json`).then(r=>{if(!r.ok)throw Error('Source could not be opened');return r.json()}));return cache.get(id)}
function highlight(root,quotes){for(const quote of quotes){if(!quote.trim())continue;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];let joined='',node;while(node=walker.nextNode()){if(node.parentElement.closest('mark'))continue;nodes.push({node,start:joined.length});joined+=node.textContent}const normalized=[];let text='';for(let i=0;i<joined.length;i++){if(/\s/.test(joined[i])){if(text.endsWith(' '))continue;text+=' '}else{text+=joined[i]}normalized.push(i)}const q=quote.replace(/\s+/g,' ');const at=text.indexOf(q);if(at<0)continue;const start=normalized[at],end=normalized[at+q.length-1]+1;for(const item of nodes.reverse()){let a=Math.max(0,start-item.start),b=Math.min(item.node.length,end-item.start);if(b<=a)continue;const range=document.createRange();range.setStart(item.node,a);range.setEnd(item.node,b);const mark=document.createElement('mark');range.surroundContents(mark)}}}
function sourceElement(data,range){
  const article=document.createElement('article');article.className='record';article.id=data.id;
  const writing=/^(roam|apple_notes)-/.test(data.id);
  const time=document.createElement('time');time.textContent=(data.time||'').split(' · ').at(-1);
  if(!/AM|PM/.test(time.textContent))time.textContent='';
  if(!time.textContent)article.classList.add('untimed');
  const body=document.createElement('div');body.className='record-body';
  const head=document.createElement('div');head.className='record-head';
  if(!writing&&data.speaker){const speaker=document.createElement('strong');speaker.textContent=data.speaker==='User'?'You':data.speaker==='Assistant'?(data.id.startsWith('codex-')?'Codex':'ChatGPT'):data.speaker;head.append(speaker)}
  const link=document.createElement('a');link.href=data.document;link.target='_blank';link.rel='noopener';link.textContent=writing?'Full note ↗':'↗';link.title=[data.reading_label,data.basis].filter(Boolean).join(' · ');link.setAttribute('aria-label',data.reading_label);head.append(link);
  const text=document.createElement('div');text.className='source-text';text.innerHTML=range?data.ranges[range]:data.html;
  body.append(head,text);article.append(time,body);return article;
}
async function openEvidence(button){
  const host=button.closest('.evidence-host');let panel=host.querySelector(':scope > .evidence');
  if(!panel){panel=document.createElement('div');panel.className='evidence';host.append(panel)}
  const isOpen=!panel.hidden&&panel.dataset.owner===button.dataset.panel;
  host.querySelectorAll('[data-ids]').forEach(b=>{b.setAttribute('aria-expanded','false');if(b.dataset.readLabel)b.textContent=b.dataset.readLabel});
  panel.dataset.owner=button.dataset.panel;button.setAttribute('aria-expanded',String(!isOpen));
  if(isOpen){panel.hidden=true;return}
  panel.hidden=false;const request=Symbol();panel.request=request;panel.replaceChildren();
  const scroll=document.createElement('div');scroll.className='evidence-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Saved sources');
  panel.append(scroll);
  try{
    const ids=JSON.parse(button.dataset.ids),quotes=JSON.parse(button.dataset.quotes||'[]');
    for(const id of ids){
      const data=await record(id);if(panel.request!==request||panel.hidden)return;
      const el=sourceElement(data,button.dataset.range);scroll.append(el);highlight(el.querySelector('.source-text'),quotes);
      const mark=el.querySelector('mark');
      if(mark){const a=el.querySelector('.record-head a'),url=new URL(a.href);url.searchParams.set('quote',quotes.find(q=>el.querySelector('.source-text').textContent.includes(q))||mark.textContent);a.href=url}
    }
    const first=scroll.querySelector('mark');
    if(first)scroll.scrollTop=Math.max(0,first.getBoundingClientRect().top-scroll.getBoundingClientRect().top-30);
  }catch(error){if(panel.request===request&&!panel.hidden)scroll.append(document.createTextNode(error.message))}
}

document.addEventListener('click',e=>{const button=e.target.closest('[data-ids]');if(button)openEvidence(button);const photo=e.target.closest('[data-photo]');if(photo){const dlg=document.querySelector('dialog');dlg.querySelector('img').src=photo.dataset.photo;dlg.querySelector('img').alt=photo.querySelector('img').alt;dlg.showModal()}});
document.querySelector('dialog')?.addEventListener('click',e=>{if(e.target.tagName==='DIALOG'||e.target.closest('[data-close-photo]'))e.currentTarget.close()});
function revealHash(){const id=decodeURIComponent(location.hash.slice(1));if(!id)return;const el=document.getElementById(id);if(el){if(el.classList.contains('session')){const details=el.querySelector('.full-session');if(details)details.open=true}const q=new URLSearchParams(location.search).get('quote');if(q)highlight(el,[q]);(el.querySelector('mark')||el).scrollIntoView({block:'start'})}}window.addEventListener('hashchange',revealHash);revealHash();
