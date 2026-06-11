# -*- coding: utf-8 -*-
"""Comprehensive full-chain proof on 141/zhou via the host REST API (127.0.0.1:9000).
Covers: host.activate_rdp, exec, file r/w, ui_info, foreground, type+key (HARD proof
via shell redirect read back), screenshot, scroll, and isolation — all without
disturbing the administrator account. Uses a throwaway DAOTEST window only."""
import json, base64, urllib.request, time, sys, io, hashlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']; TOKEN = CFG['token']; VM = 'zhou'
def call(action, **kw):
    req = urllib.request.Request(HOST, data=json.dumps(dict(action=action, **kw)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())

print("=== A) host.activate_rdp (ensure session active, offscreen) ===")
print(call('host.activate_rdp'))
print("\n=== B) exec identity / session ===")
r = call('vm.exec', vm=VM, command='whoami & echo SID:%SESSIONNAME% & hostname')
print(r.get('stdout','').strip())
print("\n=== C) file round-trip (Chinese) ===")
txt = '道法自然 zhou full-chain 2026 — 操作zhou==操作本体'
call('vm.file_write', vm=VM, path=r'C:\dao_vm\fc_zhou.txt',
     content_base64=base64.b64encode(txt.encode('utf-8')).decode())
rb = call('vm.file_read', vm=VM, path=r'C:\dao_vm\fc_zhou.txt')
back = base64.b64decode(rb['content_base64']).decode('utf-8')
print("match:", back == txt, "| text:", back)
print("\n=== D) foreground (should be non-zero now that session is active) ===")
print(call('vm.foreground', vm=VM).get('foreground'))
print("\n=== E) input HARD proof: type a shell redirect + key Enter, then read file ===")
call('vm.exec', vm=VM, command='start "DAOTEST" cmd /k prompt DAO$G$S')
time.sleep(2.0)
call('vm.activate', vm=VM, title='DAOTEST')
call('vm.type', vm=VM, title='DAOTEST', text='echo DAO-TYPED-PROOF-2026 ok > C:\\dao_vm\\typed_proof.txt')
call('vm.key', vm=VM, key='enter')
# a visible unicode line for the screenshot
call('vm.type', vm=VM, text='echo 道法自然 操作zhou等于操作本体')
call('vm.key', vm=VM, key='enter')
time.sleep(0.6)
pr = call('vm.file_read', vm=VM, path=r'C:\dao_vm\typed_proof.txt')
typed = base64.b64decode(pr.get('content_base64','')).decode('utf-8', 'replace').strip()
print("typed_proof file says:", repr(typed), "| PASS:", 'DAO-TYPED-PROOF-2026' in typed)
print("\n=== F) screenshot (full BitBlt of zhou desktop) ===")
sh = call('vm.screenshot', vm=VM, format='png')
raw = base64.b64decode(sh['image_base64']); open(r'C:\dao_vm\zhou_fc.png','wb').write(raw)
print("png", sh['width'], 'x', sh['height'], len(raw), "bytes sha", hashlib.sha256(raw).hexdigest()[:12])
print("\n=== G) scroll + ui_info (operate like own VM) ===")
print("scroll ok:", call('vm.scroll', vm=VM, x=900, y=500, clicks=-3).get('ok'))
wins = call('vm.ui_info', vm=VM)['windows']
print("windows:", ", ".join(w['title'][:24] for w in wins[:8]))
print("\n=== H) isolation: zhou procs in SID 2, admin console SID 1 untouched ===")
iso = call('vm.exec', vm=VM, command='powershell -NoProfile -Command "(Get-Process -Id $PID).SessionId"')
print("inner-agent SID (zhou=2):", iso.get('stdout','').strip())
# cleanup the throwaway window only
call('vm.exec', vm=VM, command='taskkill /fi "WINDOWTITLE eq DAOTEST*" /f')
print("\n=== cleaned up DAOTEST ===")
