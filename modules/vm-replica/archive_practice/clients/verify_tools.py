# -*- coding: utf-8 -*-
import json, urllib.request, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
H = 'http://127.0.0.1:%d/' % CFG['host_port']; T = CFG['token']
def call(a, **k):
    r = urllib.request.Request(H, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+T})
    return json.loads(urllib.request.urlopen(r, timeout=90).read().decode())
cmd = ('code --version & echo ---NODE--- & node --version & echo ---PY--- & python --version '
       '& echo ---GIT--- & git --version & echo ---CHROME--- & where chrome 2>nul & '
       'if exist "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" echo chrome-pf')
print(call('vm.exec', vm='zhou', command=cmd).get('stdout', '').strip())
