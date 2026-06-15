# -*- coding: utf-8 -*-
"""Clean re-proof of type(CJK+ascii+newline) + hold_key + key(ctrl+s) using a
DEDICATED fresh file so no user document is ever touched."""
import json, base64, urllib.request, time, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG=json.load(open(r'C:\ProgramData\dao_vm\config.json',encoding='utf-8'))
H='http://127.0.0.1:%d/'%CFG['host_port']; T=CFG['token']; VM='zhou'; TS=time.strftime('%H%M%S')
def call(a,**k):
    r=urllib.request.Request(H,data=json.dumps(dict(action=a,**k)).encode(),method='POST',
        headers={'Content-Type':'application/json','Authorization':'Bearer '+T})
    return json.loads(urllib.request.urlopen(r,timeout=120).read().decode())
def shot(n):
    call('host.activate_rdp'); s=call('vm.screenshot',vm=VM,format='png'); raw=base64.b64decode(s['image_base64'])
    open(r'C:\dao_vm\%s'%n,'wb').write(raw); print('  shot %s %dx%d %dB'%(n,s['width'],s['height'],len(raw)))
def rd(p):
    rb=call('vm.file_read',vm=VM,path=p); return base64.b64decode(rb.get('content_base64','')).decode('utf-8','replace') if rb.get('content_base64') else ''
def b64(s): return base64.b64encode(s.encode('utf-8')).decode()

F = r'C:\dao_vm\phase2_typed_%s.txt' % TS
call('vm.file_write', vm=VM, path=F, content_base64=b64(''))   # dedicated empty file
call('host.activate_rdp')
call('vm.exec', vm=VM, command='cmd /c start "" notepad "%s"' % F); time.sleep(3.0)
# find the window for OUR file (unique title), never a user doc
key = 'phase2_typed_%s' % TS; title=None
for w in call('vm.ui_info', vm=VM).get('windows', []):
    if key in w.get('title',''):
        title=w['title']; break
print('target window:', repr(title))
assert title, 'dedicated notepad window not found'
call('vm.activate', vm=VM, title=title); time.sleep(1.0)
call('vm.type', vm=VM, text='DAO-PHASE2 道法自然 物无非彼\n'); time.sleep(0.6)
call('vm.type', vm=VM, text='HOLD:'); time.sleep(0.3)
call('vm.hold_key', vm=VM, key='a', duration=0.5); time.sleep(0.4)
call('vm.type', vm=VM, text='\nL3-END 无为而无不为\n'); time.sleep(0.6)
shot('phase2_typeproof_%s.png' % TS)
call('vm.key', vm=VM, key='ctrl+s'); time.sleep(1.6)   # titled doc -> saves directly, no dialog
c = rd(F); na = c.count('a')
ok = all(m in c for m in ('DAO-PHASE2','道法自然','物无非彼','L3-END','无为而无不为')) and na>=3
print('=== saved dedicated file ===\n'+c)
print('RESULT type+hold+key:', 'PASS' if ok else 'FAIL', '| held_a=%d len=%d'%(na,len(c)))
call('vm.exec', vm=VM, command='taskkill /f /im notepad.exe 2>nul')
