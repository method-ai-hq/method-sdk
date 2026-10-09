import json
import sys
from crm import check_email, check_enrichment, check_search
args = json.load(sys.stdin)
out = args['outputs']
checks = {'email': lambda: check_email(out['email_search'], out['messages']),
    'prospects': lambda: check_search(out['prospect_search'], 'happenstance'),
    'enrichment': lambda: check_enrichment(out['enrichment'])}
try:
    checks[sys.argv[1]]()
    result = {'status': 'pass', 'reason': 'Source records are complete.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
