import json
import sys
from crm import sources
args = json.load(sys.stdin)
try:
    sources(args['outputs']['observations'])
    result = {'status': 'pass', 'reason': 'Source searches completed; email links and enrichment records are present.', 'evidence': []}
except (ValueError, KeyError, TypeError) as error:
    result = {'status': 'fail', 'reason': str(error), 'evidence': []}
print(json.dumps(result))
