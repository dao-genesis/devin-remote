# -*- coding: utf-8 -*-
import json, urllib.request, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']; TOKEN = CFG['token']
def call(a, **k):
    req = urllib.request.Request(HOST, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
print("health:", call('host.health'))
print("activate_rdp:", call('host.activate_rdp'))
print("zhou whoami:", call('vm.exec', vm='zhou', command='whoami').get('stdout','').strip())
print("vm.list status:", call('vm.list')['vms'].get('zhou',{}).get('status'))
