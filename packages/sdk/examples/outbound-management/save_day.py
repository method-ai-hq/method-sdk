import json
import sys
from crm import save
print(json.dumps(save(json.load(sys.stdin))))
