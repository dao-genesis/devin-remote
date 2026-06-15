import sys,os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import urllib.request, json
TOKEN=json.load(open(r'C:\ProgramData\dao_vm\config.json'))['token']
def hreq(path):
    req=urllib.request.Request('http://127.0.0.1:9000'+path, headers={'Authorization':f'Bearer {TOKEN}'})
    return urllib.request.urlopen(req,timeout=5).read().decode()
print('HEALTH:', hreq('/health'))
print('VMS:', hreq('/vms'))
