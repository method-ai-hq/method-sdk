"""Configure the single-day Method's local inputs and tools."""
import argparse
import json
import shlex
import shutil
import subprocess
from pathlib import Path


def field(kind, description):
    return {'type': kind, 'description': description}


def make_config(example, prepared, out, playwright, python='python3', node='node', models=None, marked=None):
    example, prepared, out = [Path(p).resolve() for p in (example, prepared, out)]
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    marked=Path(marked) if marked else Path(__file__).resolve().parent/'vendor/marked.mjs'
    if not marked.is_file():raise ValueError('Supply the installed marked ESM module with --marked')
    variables = {'DAILY_BRIEFING_MARKED':str(marked.resolve()),'DAILY_BRIEFING_EXAMPLE': str(example), 'DAILY_BRIEFING_PREPARED': str(prepared),
                 'DAILY_BRIEFING_PLAYWRIGHT': str(Path(playwright).resolve())}
    runtimes = {}
    for name, command in [('python', python), ('node', node)]:
        executable = shutil.which(command)
        if not executable:
            raise ValueError(f'Missing runtime: {command}')
        wrapper = out/(name+'-runtime.sh')
        wrapper.write_text('#!/bin/sh\n'+''.join('export '+k+'='+shlex.quote(v)+'\n' for k,v in variables.items())+
                           'exec '+shlex.quote(executable)+' "$@"\n')
        wrapper.chmod(0o700)
        runtimes[name] = {'command': str(wrapper), 'version': subprocess.check_output([executable,'--version'],text=True).strip(), 'env': ['HOME']}
    paged = {'content': field('text','Exact saved text, without a summary.'),
             'next_offset': field('number','Next character offset, or -1 when finished.'),
             'total_chars': field('number','Length of the complete text.')}
    def tool(description, inputs, outputs, runtime, entrypoint, args=None):
        return {'description': description, 'in': inputs, 'out': outputs,
                'run': {'kind':'run','runtime':runtime,'entrypoint':entrypoint,'args':args or []}, 'effects':[]}
    tools = {
        'inspect_briefing_example':tool('Open the actual approved website in a local browser. Read its visible text, expand full sessions, or open citations and writing passages. No summary is generated.',
            {'page':field('text','Relative website page, such as index.html or a linked document page.'),
             'target':field('text','Target returned in actions; empty string reads the whole page.'),
             'action':field('text','read, session, or citation. Read passage buttons use citation.'),
             'offset':field('number','Character offset; start at 0 and follow next_offset with the same page, target and action.')},
            {**paged,'actions':field('text','JSON list of visible links, images, and exact targets for controls.'),
             'presentation':field('text','Path to the actual stylesheet under the example root.'),
             'view':field('text','What this browser response provides.')},'node','briefing_browser.cjs')}
    tools['calculate_activity_times']=tool(
        'Calculate activity times and save time-plan.json and time-estimates.json in this run. Each successful call replaces both files; supply the complete plan each time. '
        'Calculate only the activities supplied in the plan. '
        'Choose records for the activities. Check whether messages are automated prompts before counting them as work. Record selection and exclusion reasons in the calculation plan. '
        'Gaps and playback do not measure continuous attention. Leave activities without enough evidence unestimated.',
        {'day':field('text','Selected date in YYYY-MM-DD form.'),
         'timezone':field('text','Selected named timezone.'),
         'plan':field('text',
             'JSON with activities and not_estimated (short reasons for activities without an estimate). '
             'Each activity has id, label, reason, mode, and optional excluded: [{record_ids, reason}]. '
             'A field reference is {record_id, field}, where field is a dotted path in the prepared record, such as time.local, time.end, or attributes.msPlayed. '
             'Use points with points: [field references], gap_minutes, and optional compare_gaps. This counts first-to-last time in each group; a single point adds zero. '
             'Use intervals with intervals: [{start: field reference, end: field reference}]. Record connections between different endpoint records in the activity reason. Intervals are clipped to the day and overlaps count once. '
             'Use durations with durations: [field references] and unit: milliseconds, seconds, or minutes. Each selected duration counts once. '
             'Supply saved fields, not invented times or calculated totals.')},
        {'estimates':field('text','Calculated durations and the records and assumptions used to calculate them.'), 'files':{'type':'list','description':'Supporting file references to return with the draft.','items':{'type':'file'}}},
        'python','briefing_times.py')
    return {'allow_local_processes':True,'runtimes':runtimes,'tools':tools,'models':{name: profile for name, profile in (models or {}).items() if name == 'writer'},
            'environment':{'approved_example':str(example),'prepared_day':str(prepared)},
            'limits':{'timeout_ms':21600000,'max_model_requests':384,'max_invocations':512,
                      'max_tool_calls':384,'max_output_bytes':134217728,'max_request_bytes':134217728}}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['example','prepared','out','playwright']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--marked',type=Path,help='Installed marked ESM module used by the website.');p.add_argument('--python',default='python3');p.add_argument('--node',default='node')
    p.add_argument('--models-from',type=Path,help='Copy existing model profiles from a runtime config; no key values.')
    a=p.parse_args();models=json.loads(a.models_from.read_text()).get('models',{}) if a.models_from else {}
    config=make_config(a.example,a.prepared,a.out,a.playwright,a.python,a.node,models,a.marked)
    target=a.out/'runtime.json';target.write_text(json.dumps(config,indent=2)+'\n');target.chmod(0o600)
    print(target)
    if not models:print('Writer steps use your existing Codex sign-in and default model. No run was started.')
