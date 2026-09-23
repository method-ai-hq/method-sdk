import {exampleSelection} from "./authoring-instructions.js";
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const authoringExamples = [
  {id:'daily-briefing', description:'Turns prepared records into a cited briefing website using an approved writing example, a source check, and rendering scripts.', directory:'daily-briefing', entrypoint:'daily-briefing.method', lessonFiles:[
    'TASK.md','daily-briefing.method','approved-report.md','briefing_check_inputs.py','briefing_files.py','briefing_artifacts.py','briefing_times.py','briefing_sessions.py','briefing_validation.py','briefing_render.py','briefing_manifest.py','briefing_markdown.py','briefing_website.py','briefing_progress.py','reader/reader.css','reader/reader.js','inputs.json','runtime.json','sample-report.md','README.md',
  ]},
  {id:'social-briefing', description:'Researches a topic through Grok, alphaXiv, and LinkedIn in the browser, then writes a briefing with quotes and source links.', directory:'social-briefing', entrypoint:'social-briefing.method', lessonFiles:[
    'TASK.md','social-briefing.method','inputs.json','result.fixture.json','README.md',
  ]},
  {id:'outbound-management', description:'Reads email and prospect sources, updates persistent CRM state, and saves daily tasks and outreach drafts for review.', directory:'outbound-management', entrypoint:'outbound.method', lessonFiles:[
    'TASK.md','outbound.method','read_crm.py','crm.py','check_sources.py','check_plan.py','save_day.py','starter/crm.json','inputs.json','runtime.json','fixtures/crm.json','fixtures/observations.json','fixtures/plan.json','fixtures/tasks.md','fixtures/receipt.json','fixtures/state.json','README.md',
  ]},
  {id:'message-routing', description:'Classifies a customer message with Jev, then applies a script rule to choose a support destination.', directory:'message-routing', entrypoint:'message-routing.method', lessonFiles:[
    'TASK.md','message-routing.method','routing.mjs','choose-destination.mjs','inputs.json','result.fixture.json','README.md',
  ]},
] as const;
export function exampleDirectory(id: string) {
  const example = authoringExamples.find(example=>example.id===id);
  if(!example)throw Error(`Unknown example '${id}'. Choose ${authoringExamples.map(example=>example.id).join(', ')}.\n\n${exampleCatalog()}`);
  return {example, directory:fileURLToPath(new URL(`../examples/${example.directory}/`,import.meta.url))};
}
export function exampleCatalog() {
  return '# Example catalog\n\n' + authoringExamples.map(example=>`- [${example.id}](examples/${example.id}.md): ${example.description}`).join('\n') + '\n\n' + exampleSelection + '\n';
}
export function renderExample(id: string, installedPaths = true) {
  const {example,directory}=exampleDirectory(id);
  const files = JSON.parse(readFileSync(new URL('../examples/files.json',import.meta.url),'utf8')) as string[];
  const location = (name:string) => installedPaths ? directory+name : `${example.directory}/${name}`;
  let result = `# Worked example: ${example.id}\n\n${example.description}\n\n`;
  for(const name of example.lessonFiles) {
    const content=readFileSync(directory+name,'utf8');
    const language=name.endsWith('.method')?'yaml':name.endsWith('.json')?'json':name.endsWith('.py')?'python':/\.(mjs|js)$/.test(name)?'javascript':name.endsWith('.css')?'css':'markdown';
    const runs=content.match(/`+/g)??[]; const fence='`'.repeat(Math.max(3,...runs.map(run=>run.length+1)));
    result+=`## ${name}\n\n${fence}${language}\n${content.trimEnd()}\n${fence}\n\n`;
  }
  result+='## Installed files\n\n';
  result+=files.filter(name=>name.startsWith(example.directory+'/')).map(name=>`- ${location(name.slice(example.directory.length+1))}`).join('\n')+'\n';
  return result;
}
