# -*- coding: utf-8 -*-
"""Runs ON 141. Safe input proof into zhou's session using a DEDICATED cmd window
titled DAOTEST (activated explicitly), so none of the user's apps are touched."""
import json, base64, urllib.request, time, sys, io, hashlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']; TOKEN = CFG['token']; VM = 'zhou'
def call(action, **kw):
    req = urllib.request.Request(HOST, data=json.dumps(dict(action=action, **kw)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())

# 1) open a dedicated, uniquely-titled console window in zhou's session
call('vm.exec', vm=VM, command='start "DAOTEST" cmd /k prompt DAO$G$S')
time.sleep(2.0)
print("foreground before activate:", call('vm.foreground', vm=VM).get('foreground'))
# 2) explicitly activate it by title (robust focus on suppressed session)
print("activate DAOTEST:", call('vm.activate', vm=VM, title='DAOTEST'))
# 3) type into it with title-targeted focus, then Enter
r = call('vm.type', vm=VM, title='DAOTEST', text='echo 道法自然 zhou-input-proof 2026')
print("type result:", json.dumps(r, ensure_ascii=False))
call('vm.key', vm=VM, key='enter')
time.sleep(0.5)
# 4) screenshot proof
sh = call('vm.screenshot', vm=VM, format='png')
img = sh.get('image_base64')
if img:
    raw = base64.b64decode(img); open(r'C:\dao_vm\zhou_daotest.png','wb').write(raw)
    print("png bytes=", len(raw), "sha=", hashlib.sha256(raw).hexdigest()[:12])
# 5) surgical cleanup: kill ONLY the DAOTEST window (by title), nothing else
call('vm.exec', vm=VM, command='taskkill /fi "WINDOWTITLE eq DAOTEST*" /f')
print("closed DAOTEST window")
