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


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


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

    def args(self, day=1):
        """Return the save_day inputs: read_crm outputs, source outputs, and a plan."""
        date = f'2026-09-{16+day}'
        read = crm.read(dict(crm=self.crm, from_date='2026-09-10', day=date))
        read.pop('target')
        sources = {**fixture('observations.json'), 'messages': fixture(f'day-{day}/messages.json')}
        if day == 1:
            plan = fixture('plan.json')
        else:
            contacts = copy.deepcopy(read['contacts'])
            contacts[0].update(next_action='Propose meeting times', next_action_date=date)
            new = [m for m in sources['messages'] if m['id'] not in read['resolved']]
            plan = dict(updated_contacts=[contacts[0]],
                resolutions=[dict(id=m['id'], contact_id=m['contact_id'],
                    resolution='Recorded reply' if m['contact_id'] else 'Review sender') for m in new],
                day_tasks=[dict(contact_id='c1', action='Propose meeting times', due_date=date,
                    reason='Alex asked to meet', draft='Hello Alex, here are some times.')])
        return dict(crm=self.crm, day=date, **read, **sources, **plan)

    def test_fixture_outputs_are_current(self):
        result = crm.save(self.args())
        self.assertEqual(result['state']['crm'], (FIXTURES / 'state.json').read_text())
        self.assertEqual((self.root / 'output/tasks.md').read_text(), (FIXTURES / 'tasks.md').read_text())
        self.assertEqual((self.root / 'output/receipt.json').read_text(), (FIXTURES / 'receipt.json').read_text())

    def test_two_days_and_repeated_save(self):
        first = self.args()
        self.crm = crm.save(first)['state']['crm']
        before = self.crm
        self.crm = crm.save({**first, 'crm': self.crm})['state']['crm']
        self.assertEqual(before, self.crm)
        self.crm = crm.save(self.args(2))['state']['crm']
        state = json.loads(self.crm)
        self.assertEqual(len(state['messages']), 4)
        self.assertEqual(len(state['days']), 2)
        self.assertEqual(state['contacts'][2]['status'], 'opted_out')
        self.assertEqual(state['contacts'][1]['status'], 'customer')
        self.assertEqual(state['contacts'][0]['manual_notes'], 'Keep this owner note.')
        self.assertIn('Propose meeting times', (self.root / 'output/tasks.md').read_text())

    def test_stale_write_does_not_change_state(self):
        args = self.args()
        args['crm'] = self.crm + '\n'
        with self.assertRaisesRegex(ValueError, 'CRM changed'):
            crm.save(args)
        self.assertFalse((self.root / 'output/tasks.md').exists())

    def test_reject_opt_out_task_and_guessed_identity(self):
        args = self.args()
        contacts = crm.check_contacts(args['contacts'], args['resolved'], args['messages'],
            args['enrichment'], args['updated_contacts'], args['resolutions'])
        task = dict(args['day_tasks'][0], contact_id='c3')
        with self.assertRaisesRegex(ValueError, 'inactive'):
            crm.check_tasks(args['day'], contacts, [task])
        args['resolutions'][2]['contact_id'] = 'c1'
        with self.assertRaisesRegex(ValueError, 'identity'):
            crm.save(args)

    def test_keep_owner_notes_opt_outs_and_message_coverage(self):
        args = self.args()
        args['updated_contacts'][0]['manual_notes'] = 'Changed by agent'
        contacts = crm.check_contacts(args['contacts'], args['resolved'], args['messages'],
            args['enrichment'], args['updated_contacts'], args['resolutions'])
        self.assertEqual(contacts['c1']['manual_notes'], 'Keep this owner note.')
        args['updated_contacts'][1]['status'] = 'contacted'
        with self.assertRaisesRegex(ValueError, 'customer and opt-out'):
            crm.save(args)
        args['updated_contacts'][1]['status'] = 'customer'
        args['resolutions'].pop()
        with self.assertRaisesRegex(ValueError, 'each new message'):
            crm.save(args)

    def test_new_prospect_is_saved_with_sources(self):
        args = self.args()
        url = 'https://west.example/team'
        args['prospects'].append(dict(name='Pat Jones', email='', company='West', role='',
            profile_url='https://www.linkedin.com/in/pat-jones', introduction_path='Through Alex Kim'))
        args['enrichment'].append(dict(email='pat@west.example', role='Operations lead',
            fit='Runs a logistics team', sources=[dict(url=url, facts='Operations lead at West')], notes=''))
        new = dict(id='email:pat@west.example', name='Pat Jones', email='pat@west.example',
            introduction_path='Through Alex Kim', company='West', role='Operations lead',
            fit='Runs a logistics team', sources=[url], status='new', next_action='Review introduction',
            next_action_date='2026-09-17')
        args['updated_contacts'].append(new)
        args['day_tasks'].append(dict(contact_id=new['id'], action='Review introduction',
            due_date='2026-09-17', reason='Matches the target customer', draft='Hello Pat.'))
        state = json.loads(crm.save(args)['state']['crm'])
        self.assertEqual(state['contacts'][-1]['sources'], [url])
        self.assertEqual(state['contacts'][-1]['manual_notes'], '')
        self.assertIn('Pat Jones', (self.root / 'output/tasks.md').read_text())
        new['sources'] = ['https://west.example/other']
        with self.assertRaisesRegex(ValueError, 'not collected'):
            crm.save(args)

    def test_blocked_or_unsourced_records_fail(self):
        args = self.args()
        with self.assertRaisesRegex(ValueError, 'Source access'):
            crm.check_email(dict(status='blocked', notes='Sign-in required'), args['messages'])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            crm.check_email(args['email_search'], args['messages'] + args['messages'][:1])
        with self.assertRaisesRegex(ValueError, 'enrichment sources'):
            crm.check_enrichment(dict(email='', role='', fit='', sources=[], notes='LinkedIn blocked'))


if __name__ == '__main__':
    unittest.main()
