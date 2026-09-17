import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

EXAMPLE = Path(__file__).resolve().parents[2]/'packages/sdk/examples/daily-briefing'
sys.path.insert(0, str(EXAMPLE))
from briefing_markdown import parse
from briefing_validation import check_draft, check_website, check_written_briefing
from briefing_render import render_and_save
from briefing_artifacts import source_digest, load, put
from briefing_times import calculate

DAY = {'day':'2026-05-11','timezone':'America/Chicago'}
DRAFT = '''# A small workday

This sample contains one conversation.

## The worker changed

**First change**, then **second change**. [Evidence](source:chatgpt-0024) Text after the citation.

- A list with a [selected passage](source:chatgpt-0025#L1-L3).
- A second item.

| Result | Source |
| --- | --- |
| Read the plan | [Plan](source:chatgpt-0028#L1-L2) |
'''

class BriefingExampleTest(unittest.TestCase):
    def test_ordinary_markdown_accepts_writing_variations(self):
        with patch('briefing_validation.folder', return_value=EXAMPLE/'sample'):
            doc = check_draft(DRAFT, DAY)
        self.assertEqual(len(doc['citations']), 3)
        self.assertEqual(doc['citations'][1]['source_range'], 'lines-1-3')
        html = ''.join(b['html'] for b in doc['blocks'])
        self.assertIn('<strong>First change</strong>', html)
        self.assertIn('<strong>second change</strong>', html)
        self.assertIn('Text after the citation.', html)
        self.assertIn('<ul>', html)
        self.assertIn('<table>', html)

    def test_unknown_sources_and_invalid_ranges_still_fail(self):
        with patch('briefing_validation.folder', return_value=EXAMPLE/'sample'):
            with self.assertRaisesRegex(ValueError,'Unknown citation'):
                check_draft(DRAFT.replace('chatgpt-0024','missing'), DAY)
            with self.assertRaisesRegex(ValueError,'outside the saved text'):
                check_draft(DRAFT.replace('#L1-L3','#L1-L999999'), DAY)


    def test_declared_writer_check_reports_failures_before_rendering(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {
            'METHOD_OUTPUT_DIR': temporary,
            'METHOD_ENVIRONMENT': json.dumps({'prepared_day': str(EXAMPLE/'sample')}),
        }):
            args = {'inputs': {'selected_day': DAY},
                    'outputs': {'draft': DRAFT, 'supporting_files': []}}
            self.assertEqual(check_written_briefing(args)['status'], 'pass')
            args['outputs']['draft'] = DRAFT.replace('chatgpt-0024', 'missing')
            result = check_written_briefing(args)
            self.assertEqual(result['status'], 'fail')
            self.assertEqual(result['reason'], 'Unknown citation')
            args['outputs']['draft'] = DRAFT
            ref = put(Path(temporary)/'notes.md', 'Calculation')
            args['outputs']['supporting_files'] = [ref]
            (Path(temporary)/'notes.md').write_text('Changed')
            self.assertEqual(check_written_briefing(args)['status'], 'fail')
            self.assertFalse((Path(temporary)/'saved').exists())

    def test_render_save_links_and_retry(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {
            'METHOD_OUTPUT_DIR':temporary,
            'METHOD_ENVIRONMENT':json.dumps({'prepared_day':str(EXAMPLE/'sample')}),
            'DAILY_BRIEFING_MARKED':str(EXAMPLE/'vendor/marked.mjs'),
        }):
            day={**DAY,'source_digest':source_digest()}
            args={'selected_day':day,'draft':DRAFT,'supporting_files':[]}
            saved=render_and_save(args)
            receipt=load(saved['saved_briefing'])
            website=(Path(temporary)/receipt['website']).parent
            check_website(website)
            html=(website/'index.html').read_text()
            self.assertIn('data-range="lines-1-3"',html)
            self.assertEqual(render_and_save(args), saved)
            self.assertEqual(source_digest(),day['source_digest'])
            (website/'reader.js').unlink()
            with self.assertRaisesRegex(ValueError,'Existing saved output changed'):
                render_and_save(args)

    def test_supporting_files_are_explicit_and_local_links_survive(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {
            'METHOD_OUTPUT_DIR':temporary,'METHOD_ENVIRONMENT':json.dumps({'prepared_day':str(EXAMPLE/'sample')}),
            'DAILY_BRIEFING_MARKED':str(EXAMPLE/'vendor/marked.mjs'),
        }):
            root=Path(temporary);day={**DAY,'source_digest':source_digest()}
            # A stray file is not a dependency of this report.
            (root/'time-plan.json').write_text('incomplete')
            saved=render_and_save({'selected_day':day,'draft':DRAFT})
            self.assertEqual(load(saved['saved_briefing'])['supporting_files'],[])
            ref=put(root/'time-estimates.json',{**DAY,'activities':[]})
            draft=DRAFT+'\n[Calculation](source:time-estimates#L1-L2) [Download](time-estimates.json)\n'
            saved=render_and_save({'selected_day':day,'draft':draft,'supporting_files':[ref]})
            receipt=load(saved['saved_briefing']);website=(root/receipt['website']).parent
            self.assertEqual((website/'time-estimates.json').read_bytes(),(root/'time-estimates.json').read_bytes())
            with self.assertRaisesRegex(ValueError,'Missing linked file: missing.png'):
                render_and_save({'selected_day':day,'draft':DRAFT+'\n![Photo](missing.png)'})

    def test_unknown_session_link_keeps_the_report_and_links_to_sessions(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {
            'METHOD_OUTPUT_DIR':temporary,'METHOD_ENVIRONMENT':json.dumps({'prepared_day':str(EXAMPLE/'sample')}),
            'DAILY_BRIEFING_MARKED':str(EXAMPLE/'vendor/marked.mjs'),
        }), contextlib.redirect_stderr(io.StringIO()) as diagnostics:
            day={**DAY,'source_digest':source_digest()}
            draft=DRAFT+'\n[Saved session](sessions.html#social-deadbeef)\n\n[Another session](sessions.html#misspelled-id)\n\nThe story continues.\n'
            saved=render_and_save({'selected_day':day,'draft':draft})
            website=(Path(temporary)/load(saved['saved_briefing'])['website']).parent
            check_website(website)
            html=(website/'index.html').read_text()
            self.assertEqual(html.count('This session link could not be found.'),2)
            self.assertIn('href="sessions.html"',html)
            self.assertIn('The story continues.',html)
            self.assertIn('No saved social sessions for this day.',(website/'sessions.html').read_text())
            self.assertIn('social-deadbeef was not found',diagnostics.getvalue())
            self.assertEqual((website.parent/'briefing.md').read_text(),draft)

    def test_calculator_does_not_invent_social_activities(self):
        # No prepared-folder reads are needed when the caller selects no activities.
        result=calculate({'activities':[]},Path('/does-not-exist'),DAY['day'],DAY['timezone'])
        self.assertEqual(result['activities'],[])
