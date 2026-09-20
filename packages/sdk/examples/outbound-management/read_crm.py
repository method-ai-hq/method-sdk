import json
import sys
from crm import read
print(json.dumps(read(json.load(sys.stdin))))
