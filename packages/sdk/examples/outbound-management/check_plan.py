import json
import sys
from crm import check_contacts, check_tasks
args = json.load(sys.stdin)
given, out = args['inputs'], args['outputs']
try:
    if sys.argv[1] == 'contacts':
        check_contacts(given['contacts'], given['resolved'], given['messages'], given['enrichment'],
            out['updated_contacts'], out['resolutions'])
    else:
        contacts = {c['id']: c for c in given['contacts'] + given['updated_contacts']}
        check_tasks(given['day'], contacts, out['day_tasks'])
    result = {'status': 'pass', 'reason': 'The ' + sys.argv[1] + ' are valid.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
