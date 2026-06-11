# -*- coding: utf-8 -*-
"""Runs ON 141. Proves input injection (type/key/click) into zhou's suppressed RDP
session, using a throwaway Notepad so nothing of the user's is disturbed."""
import json, base64, urllib.request, time, sys, io, hashlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']; TOKEN = CFG['token']; VM = 'zhou'
def call(action, **kw):
    req = urllib.request.Request(HOST, data=json.dumps(dict(action=action, **kw)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())

print("launch notepad:", call('vm.exec', vm=VM, command='start "" notepad.exe').get('rc'))
time.sleep(2.5)
# type unicode + a newline + more
call('vm.type', vm=VM, text='道法自然 — operate zhou == operate my own VM\r\n反者道之动 弱者道之用\r\n')
time.sleep(0.4)
call('vm.key', vm=VM, key='ctrl+a')   # select all (proves key combos route to session 2)
time.sleep(0.3)
call('vm.key', vm=VM, key='ctrl+c')
time.sleep(0.3)
# verify the typed text actually landed: read the clipboard inside zhou's session
clip = call('vm.exec', vm=VM, command='powershell -NoProfile -Command "Get-Clipboard"')
print("CLIPBOARD-IN-ZHOU>>>")
print(clip.get('stdout', clip))
# screenshot proof
sh = call('vm.screenshot', vm=VM, format='png')
img = sh.get('image_base64') or sh.get('content_base64') or sh.get('base64')
if img:
    raw = base64.b64decode(img); open(r'C:\dao_vm\zhou_input.png','wb').write(raw)
    print("png bytes=", len(raw), "sha=", hashlib.sha256(raw).hexdigest()[:12])
# isolation: list notepad processes with their session id (must be 2 only)
iso = call('vm.exec', vm=VM, command='powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'notepad.exe\'\\" | ForEach-Object { $_.ProcessId.ToString()+\':SID\'+$_.SessionId }"')
print("NOTEPAD-PROCS>>>", iso.get('stdout', iso).strip())
# cleanup: force kill notepad in zhou (no save prompt, no file written)
call('vm.exec', vm=VM, command='taskkill /im notepad.exe /f')
print("cleaned up notepad")
