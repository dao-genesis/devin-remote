# -*- coding: utf-8 -*-
import json, urllib.request, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']; TOKEN = CFG['token']
def call(a, **k):
    req = urllib.request.Request(HOST, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
# kill any cmd whose window title contains DAOTEST (matches the 管理员: DAOTEST prefix too)
ps = r"Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*DAOTEST*' } | ForEach-Object { $_.Id } | ForEach-Object { Stop-Process -Id $_ -Force }; (Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*DAOTEST*' }).Count"
r = call('vm.exec', vm='zhou', command='powershell -NoProfile -Command "%s"' % ps)
print("remaining DAOTEST windows:", r.get('stdout','').strip())
