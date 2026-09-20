import json
import sys
from crm import checked
args = json.load(sys.stdin)
try:
    checked(args['inputs']['context'], args['outputs']['plan'], args['inputs']['observations'])
    result = {'status': 'pass', 'reason': 'Contact identities, message coverage, sources, and daily tasks are valid.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
