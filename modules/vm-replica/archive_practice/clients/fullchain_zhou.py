# -*- coding: utf-8 -*-
"""Runs ON 141. Drives the zhou attached VM through the host daemon (127.0.0.1:9000)
and proves operate-zhou == operate-own-VM, while staying isolated from administrator.
Writes the zhou screenshot to C:\\dao_vm\\zhou_shot.png and prints a compact report."""
import json, base64, urllib.request, time, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']
TOKEN = CFG['token']

def call(action, **kw):
    body = dict(action=action, **kw)
    req = urllib.request.Request(HOST, data=json.dumps(body).encode('utf-8'), method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode('utf-8'))

VM = 'zhou'
print("=== 1) identity / session ===")
r = call('vm.exec', vm=VM, command='whoami & echo SID:%SESSIONNAME% & hostname')
print(r.get('stdout', r))

print("=== 2) file round-trip ===")
payload = '道法自然 zhou-attach roundtrip 2026'
b64 = base64.b64encode(payload.encode('utf-8')).decode()
call('vm.file_write', vm=VM, path=r'C:\Users\Public\dao_zhou.txt', content_base64=b64)
rr = call('vm.file_read', vm=VM, path=r'C:\Users\Public\dao_zhou.txt')
got = base64.b64decode(rr.get('content_base64', '')).decode('utf-8', 'replace')
print("readback:", got, "| match:", got == payload)

print("=== 3) desktop_info ===")
print(call('vm.desktop_info', vm=VM))

print("=== 4) ui_info (top windows) ===")
ui = call('vm.ui_info', vm=VM)
wins = ui.get('windows', ui)
print(json.dumps(wins, ensure_ascii=False)[:600])

print("=== 5) screenshot -> file ===")
sh = call('vm.screenshot', vm=VM, format='png')
img_b64 = sh.get('image_base64') or sh.get('content_base64') or sh.get('base64')
if img_b64:
    raw = base64.b64decode(img_b64)
    open(r'C:\dao_vm\zhou_shot.png', 'wb').write(raw)
    import hashlib
    print("png bytes=", len(raw), "sha256=", hashlib.sha256(raw).hexdigest()[:16],
          "size=", sh.get('width'), 'x', sh.get('height'))
else:
    print("screenshot keys:", list(sh.keys()), str(sh)[:300])

print("=== 6) isolation: zhou processes carry SessionId=2, console=1 ===")
r2 = call('vm.exec', vm=VM, command='powershell -NoProfile -Command "(Get-Process -Id $PID).SessionId"')
print("inner-agent SessionId (should be 2):", r2.get('stdout', r2).strip())
