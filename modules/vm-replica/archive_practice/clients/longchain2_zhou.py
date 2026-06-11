# -*- coding: utf-8 -*-
"""Dismiss VSCode first-run modal, type real code into a new file, save via the
Save-As dialog, then READ THE FILE BACK as hard proof the GUI keystrokes landed."""
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

call('host.activate_rdp')
call('vm.activate', vm=VM, title='Visual Studio Code'); time.sleep(0.6)
# dismiss the "Continue without Signing In" first-run modal (native 2560x1440 coords)
call('vm.click', vm=VM, x=1818, y=1109); time.sleep(1.5)
# focus the editor surface, open a new file, type code
call('vm.click', vm=VM, x=1300, y=700); time.sleep(0.5)
call('vm.key', vm=VM, key='ctrl+n'); time.sleep(1.0)
code_text = "// dao fa zi ran - operate zhou == operate my own VM\nfunction dao(x){ return x*x; }\nconsole.log('dao(7) =', dao(7));\n"
call('vm.type', vm=VM, text=code_text); time.sleep(0.6)
shot('zhou_vscode_typed2.png')
# save via Save-As dialog to a known path, then read it back
call('vm.key', vm=VM, key='ctrl+s'); time.sleep(1.5)
call('vm.type', vm=VM, text=r'C:\dao_vm\demo\dao_typed.js'); time.sleep(0.6)
call('vm.key', vm=VM, key='enter'); time.sleep(1.5)
shot('zhou_vscode_saved.png')
rb = call('vm.file_read', vm=VM, path=r'C:\dao_vm\demo\dao_typed.js')
content = base64.b64decode(rb.get('content_base64','')).decode('utf-8','replace') if rb.get('content_base64') else '(missing)'
print("=== dao_typed.js content (typed via VSCode GUI) ===")
print(content)
print("PASS:", 'dao(7)' in content)
# run the file we just typed, to prove it is real working code
print("=== node runs the GUI-typed file ===")
print(call('vm.exec', vm=VM, command=r'node "C:\dao_vm\demo\dao_typed.js"').get('stdout','').strip())
