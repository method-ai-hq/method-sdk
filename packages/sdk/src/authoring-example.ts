import {exampleSelection} from "./authoring-instructions.js";
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const authoringExamples = [
  {id:'notes-summary', description:'The smallest complete Method: reads a folder of meeting notes, finds decisions and action items with one model call that shows two good items, and saves a summary file. A recorded case keeps one correction.', teaches:'files connection, call with examples of good output, a recorded case in cases/', directory:'notes-summary', entrypoint:'notes-summary.method', lessonFiles:[
    'TASK.md','notes-summary.method','read-notes.mjs','save.mjs','cases/dates-in-decisions/case.json','README.md',
  ]},
  {id:'message-routing', description:"Classifies a customer message with Method's classifier, then a script rule chooses a support destination. ticket.method adds one ticket write that a retry does not repeat.", teaches:'classify with an unclear option, a threshold in a script, an effect that reads the ticket back, retry without a duplicate write', directory:'message-routing', entrypoint:'message-routing.method', lessonFiles:[
    'TASK.md','message-routing.method','routing.mjs','choose-destination.mjs','inputs.json','result.fixture.json','ticket.method','create-ticket.mjs','README.md',
  ]},
  {id:'support-triage', description:'Reads a help desk ticket, classifies its team, refund request, and urgency, drafts a first reply, updates the ticket, and asks a person when the team is unclear.', teaches:'models and secrets, classify with options, yes_no and levels, an unclear path, ask, effects with an http observer, a committed case, run_data: device, method connect', directory:'support-triage', entrypoint:'support-triage.method', lessonFiles:[
    'TASK.md','support-triage.method','triage.mjs','helpdesk.mjs','read-ticket.mjs','route.mjs','set-ticket.mjs','triage.test.mjs','inputs.json','cases/double-charge-to-billing/case.json','README.md',
  ]},
  {id:'outbound-management', description:'Reads email and prospect sources, updates persistent CRM state, and saves daily tasks and outreach drafts for review.', teaches:'state across runs, script checks, examples of good output, accept, fixtures', directory:'outbound-management', entrypoint:'outbound.method', lessonFiles:[
    'TASK.md','outbound.method','read_crm.py','crm.py','check_sources.py','check_plan.py','save_day.py','starter/crm.json','inputs.json','fixtures/crm.json','fixtures/observations.json','fixtures/plan.json','fixtures/tasks.md','fixtures/receipt.json','fixtures/state.json','README.md',
  ]},
  {id:'social-briefing', description:'Researches a topic through Grok, alphaXiv, and LinkedIn in the browser, then writes a briefing with quotes and source links.', teaches:'browser agent, call, no_effect_reason, accept', directory:'social-briefing', entrypoint:'social-briefing.method', lessonFiles:[
    'TASK.md','social-briefing.method','inputs.json','result.fixture.json','README.md',
  ]},
  {id:'daily-briefing', description:'Turns prepared records of one fictional day into a cited briefing website, using an approved writing example, a source check, and rendering scripts.', teaches:'approved example as an input, script tool, source check, website result', directory:'daily-briefing', entrypoint:'daily-briefing.method', lessonFiles:[
    'TASK.md','daily-briefing.method','approved-report.md','briefing_check_inputs.py','briefing_files.py','briefing_artifacts.py','briefing_times.py','briefing_sessions.py','briefing_validation.py','briefing_render.py','briefing_manifest.py','briefing_markdown.py','briefing_website.py','briefing_progress.py','reader/reader.css','reader/reader.js','inputs.json','sample-report.md','README.md',
  ]},
] as const;
export function exampleDirectory(id: string) {
  const example = authoringExamples.find(example=>example.id===id);
  if(!example)throw Error(`Unknown example '${id}'. Choose ${authoringExamples.map(example=>example.id).join(', ')}.\n\n${exampleCatalog()}`);
  return {example, directory:fileURLToPath(new URL(`../examples/${example.directory}/`,import.meta.url))};
}
export function exampleCatalog() {
  return '# Example catalog\n\n' + authoringExamples.map(example=>`- \`method authoring example ${example.id}\`: ${example.description} Teaches: ${example.teaches}.`).join('\n') + '\n\n' + exampleSelection + '\n';
}
export function renderExample(id: string, installedPaths = true) {
  const {example,directory}=exampleDirectory(id);
  const files = JSON.parse(readFileSync(new URL('../examples/files.json',import.meta.url),'utf8')) as string[];
  const location = (name:string) => installedPaths ? directory+name : `${example.directory}/${name}`;
  let result = `# Worked example: ${example.id}\n\n${example.description}\n\n`;
  // The sample inputs show how the example runs.
  const lessons: string[] = [...example.lessonFiles];
  for(const name of [...lessons, ...['inputs.json'].filter(name=>!lessons.includes(name)&&existsSync(directory+name))]) {
    const content=readFileSync(directory+name,'utf8');
    const language=name.endsWith('.method')?'yaml':name.endsWith('.json')?'json':name.endsWith('.py')?'python':/\.(mjs|js)$/.test(name)?'javascript':name.endsWith('.css')?'css':'markdown';
    const runs=content.match(/`+/g)??[]; const fence='`'.repeat(Math.max(3,...runs.map(run=>run.length+1)));
    result+=`## ${name}\n\n${fence}${language}\n${content.trimEnd()}\n${fence}\n\n`;
  }
  result+='## Installed files\n\n';
  result+=files.filter(name=>name.startsWith(example.directory+'/')).map(name=>`- ${location(name.slice(example.directory.length+1))}`).join('\n')+'\n';
  return result;
}
