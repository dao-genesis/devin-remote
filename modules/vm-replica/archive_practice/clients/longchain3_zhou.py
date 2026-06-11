# -*- coding: utf-8 -*-
"""Robustly clear VSCode first-run walkthrough, then type real code, save, read back."""
import json, base64, urllib.request, time, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
H = 'http://127.0.0.1:%d/' % CFG['host_port']; T = CFG['token']; VM = 'zhou'
def call(a, **k):
    r = urllib.request.Request(H, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+T})
    return json.loads(urllib.request.urlopen(r, timeout=120).read().decode())
def shot(name):
    call('host.activate_rdp')
    s = call('vm.screenshot', vm=VM, format='png'); raw = base64.b64decode(s['image_base64'])
    open(r'C:\dao_vm\%s' % name, 'wb').write(raw)
    print('  shot %s -> %dx%d %dB' % (name, s['width'], s['height'], len(raw)))

# 0) suppress startup walkthrough for a clean editor (parity) - write zhou's settings.json
appdata = call('vm.exec', vm=VM, command='echo %APPDATA%').get('stdout','').strip()
print('zhou APPDATA =', appdata)
udir = appdata + r'\Code\User'
call('vm.exec', vm=VM, command='mkdir "%s" 2>nul' % udir)
settings = '{\n  "workbench.startupEditor": "none",\n  "telemetry.telemetryLevel": "off",\n  "update.mode": "manual"\n}\n'
call('vm.file_write', vm=VM, path=udir + r'\settings.json',
     content_base64=base64.b64encode(settings.encode()).decode())

# 1) clear current modal/walkthrough
call('host.activate_rdp'); call('vm.activate', vm=VM, title='Visual Studio Code'); time.sleep(0.6)
for _ in range(3):
    call('vm.key', vm=VM, key='escape'); time.sleep(0.3)
call('vm.click', vm=VM, x=1958, y=343); time.sleep(0.8)   # modal close X (native coords)
for _ in range(3):
    call('vm.key', vm=VM, key='ctrl+w'); time.sleep(0.4)   # close Welcome/walkthrough tabs
time.sleep(0.6)
# 2) new file + type
call('vm.click', vm=VM, x=1300, y=700); time.sleep(0.3)
call('vm.key', vm=VM, key='ctrl+n'); time.sleep(1.0)
code_text = "// dao fa zi ran - operate zhou == operate my own VM\nfunction dao(x){ return x*x; }\nconsole.log('dao(7) =', dao(7));\n"
call('vm.type', vm=VM, text=code_text); time.sleep(0.6)
shot('zhou_vscode_typed3.png')
# 3) save via Save-As dialog
call('vm.key', vm=VM, key='ctrl+s'); time.sleep(1.6)
call('vm.type', vm=VM, text=r'C:\dao_vm\demo\dao_typed.js'); time.sleep(0.6)
call('vm.key', vm=VM, key='enter'); time.sleep(1.6)
shot('zhou_vscode_saved.png')
# 4) hard proof: read the file + run it
rb = call('vm.file_read', vm=VM, path=r'C:\dao_vm\demo\dao_typed.js')
content = base64.b64decode(rb.get('content_base64','')).decode('utf-8','replace') if rb.get('content_base64') else '(missing)'
print("=== dao_typed.js (typed via VSCode GUI) ===\n" + content)
print("FILE PASS:", 'dao(7)' in content)
print("=== node runs the GUI-typed file ===")
print(call('vm.exec', vm=VM, command=r'node "C:\dao_vm\demo\dao_typed.js"').get('stdout','').strip())
