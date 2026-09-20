import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

EXAMPLE = Path(__file__).resolve().parent
FIXTURES = EXAMPLE / 'fixtures'
spec = importlib.util.spec_from_file_location('outbound_crm', EXAMPLE / 'crm.py')
crm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crm)


class OutboundTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.crm = (FIXTURES / 'crm.json').read_text()
        self.previous_output = os.environ.get('METHOD_OUTPUT_DIR')
        os.environ['METHOD_OUTPUT_DIR'] = str(self.root / 'output')
        self.addCleanup(self.restore_env)

    def restore_env(self):
        if self.previous_output is None:
            os.environ.pop('METHOD_OUTPUT_DIR', None)
        else:
            os.environ['METHOD_OUTPUT_DIR'] = self.previous_output

    def plan(self, day=1):
        args = dict(crm=self.crm, from_date='2026-09-10', day=f'2026-09-{16+day}')
        context = crm.read(args)['context']
        ctx = json.loads(context)
        observed = dict(messages=json.loads((FIXTURES / f'day-{day}/messages.json').read_text()), prospects=[], searches={name: dict(status='complete',notes='Fixture') for name in ['email','happenstance','enrichment']})
        done = {m['id'] for m in ctx['crm']['messages'] if m['contact_id']}
        ctx['messages'] = [m for m in observed['messages'] if m['id'] not in done]
        contacts = copy.deepcopy(ctx['crm']['contacts'])
        contacts[0].update(status='replied', next_action='Send pricing' if day == 1 else 'Propose meeting times', next_action_date=args['day'])
        contacts[2].update(status='opted_out', next_action='', next_action_date='')
        plan = dict(contacts=contacts, messages=[dict(id=m['id'],contact_id=m.get('contact_id',''),resolution='Review sender' if not m.get('contact_id') else 'Recorded reply') for m in ctx['messages']], tasks=[dict(contact_id='c1',action=contacts[0]['next_action'],due_date=args['day'],reason='Requested by Alex',draft='Hello Alex, let us review your needs.')],research_notes='No new prospects in this state test.')
        return dict(crm=self.crm,context=context,plan=json.dumps(plan),observations=json.dumps(observed))

    def test_two_days_and_repeated_save(self):
        first = self.plan()
        self.crm = crm.save({**first, 'crm': self.crm})['state']['crm']
        before = self.crm
        self.crm = crm.save({**first, 'crm': self.crm})['state']['crm']
        self.assertEqual(before, self.crm)
        self.crm = crm.save(self.plan(2))['state']['crm']
        state = json.loads(self.crm)
        self.assertEqual(len(state['messages']), 4)
        self.assertEqual(len(state['days']), 2)
        self.assertEqual(state['contacts'][2]['status'], 'opted_out')
        self.assertEqual(state['contacts'][1]['status'], 'customer')
        self.assertEqual(state['contacts'][0]['manual_notes'], 'Keep this owner note.')
        self.assertIn('Propose meeting times', (self.root / 'output/tasks.md').read_text())

    def test_stale_write_does_not_change_state(self):
        args = self.plan()
        self.crm += '\n'
        args['crm'] = self.crm
        before = self.crm
        with self.assertRaisesRegex(ValueError, 'CRM changed'):
            self.crm = crm.save(args)['state']['crm']
        self.assertEqual(before, self.crm)

    def test_reject_opt_out_task_and_guessed_identity(self):
        args = self.plan()
        plan = json.loads(args['plan'])
        plan['tasks'][0]['contact_id'] = 'c3'
        with self.assertRaisesRegex(ValueError, 'inactive'):
            crm.checked(args['context'], json.dumps(plan), args['observations'])
        plan['tasks'][0]['contact_id'] = 'c1'
        plan['messages'][2]['contact_id'] = 'c1'
        with self.assertRaisesRegex(ValueError, 'identity'):
            crm.checked(args['context'], json.dumps(plan), args['observations'])

    def test_message_coverage_and_notes(self):
        args = self.plan()
        plan = json.loads(args['plan'])
        plan['contacts'][0]['manual_notes'] = 'Changed by agent'
        _, _, contacts = crm.checked(args['context'], json.dumps(plan), args['observations'])
        self.assertEqual(contacts['c1']['manual_notes'], 'Keep this owner note.')
        plan['messages'].pop()
        with self.assertRaisesRegex(ValueError, 'each new message'):
            crm.checked(args['context'], json.dumps(plan), args['observations'])

    def test_new_prospect_is_saved_with_sources(self):
        args = self.plan()
        plan = json.loads(args['plan'])
        new = dict(id='email:pat@west.example', name='Pat Jones', email='pat@west.example',
            introduction_path='', company='West', role='Operations lead', fit='Runs a logistics team',
            sources=['https://west.example/team'], status='new', next_action='Review introduction',
            next_action_date='2026-09-17')
        plan['contacts'].append(new)
        plan['tasks'].append(dict(contact_id=new['id'], action='Review introduction',
            due_date='2026-09-17', reason='Matches the target customer', draft='Hello Pat.'))
        args['plan'] = json.dumps(plan)
        evidence = json.loads(args['observations'])
        evidence['prospects'].append(dict(sources=[dict(url=new['sources'][0], facts='Operations lead at West')]))
        args['observations'] = json.dumps(evidence)
        self.crm = crm.save(args)['state']['crm']
        state = json.loads(self.crm)
        self.assertEqual(state['contacts'][-1]['sources'], new['sources'])
        self.assertEqual(state['contacts'][-1]['manual_notes'], '')
        self.assertIn('Pat Jones', (self.root / 'output/tasks.md').read_text())

    def test_research_notes_type_and_saved_paragraphs(self):
        args = self.plan()
        plan = json.loads(args['plan'])
        before = self.crm
        for notes in [['First note', 'Second note'], {'note': 'First note'}, None]:
            with self.subTest(notes=notes):
                plan['research_notes'] = notes
                args['plan'] = json.dumps(plan)
                with self.assertRaisesRegex(ValueError, 'Research notes must be text'):
                    self.crm = crm.save(args)['state']['crm']
                self.assertEqual(before, self.crm)
                self.assertFalse((self.root / 'output/tasks.md').exists())
        for notes in ['', 'First note\n\nSecond note']:
            with self.subTest(notes=notes):
                args = self.plan()
                plan = json.loads(args['plan'])
                plan['research_notes'] = notes
                args['plan'] = json.dumps(plan)
                self.crm = crm.save(args)['state']['crm']
                state = json.loads(self.crm)
                self.assertEqual(notes, state['days']['2026-09-17']['research_notes'])
                self.assertIn('## Research notes\n\n' + notes, (self.root / 'output/tasks.md').read_text())

    def test_blocked_source_stops_plan(self):
        args = self.plan()
        evidence = json.loads(args['observations'])
        evidence['searches']['email']['status'] = 'blocked'
        with self.assertRaisesRegex(ValueError, 'Source access'):
            crm.checked(args['context'], args['plan'], json.dumps(evidence))
