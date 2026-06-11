# -*- coding: utf-8 -*-
"""Disable VSCode auto-close/auto-indent (deterministic typing), then type a
multi-line program verbatim, save, read back, and run with node."""
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

udir = r'C:\Users\zhou\AppData\Roaming\Code\User'
settings = json.dumps({
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "manual",
    "editor.autoClosingBrackets": "never",
    "editor.autoClosingQuotes": "never",
    "editor.autoIndent": "none",
    "editor.acceptSuggestionOnEnter": "off",
    "editor.suggestOnTriggerCharacters": False,
    "editor.formatOnType": False,
}, indent=2)
call('vm.file_write', vm=VM, path=udir + r'\settings.json',
     content_base64=base64.b64encode(settings.encode()).decode())
time.sleep(2.0)

PATH = r'C:\dao_vm\demo\dao_run.js'
call('host.activate_rdp'); call('vm.activate', vm=VM, title='Visual Studio Code'); time.sleep(0.6)
call('vm.key', vm=VM, key='ctrl+n'); time.sleep(1.0)
code_text = ("function dao(x){\n  return x*x;\n}\n"
             "for (var i=1;i<=3;i++){\n  console.log('dao('+i+') =', dao(i));\n}\n")
call('vm.type', vm=VM, text=code_text); time.sleep(0.6)
shot('zhou_vscode_typed5.png')
call('vm.key', vm=VM, key='ctrl+s'); time.sleep(1.6)
call('vm.type', vm=VM, text=PATH); time.sleep(0.6)
call('vm.key', vm=VM, key='enter'); time.sleep(1.6)
call('vm.key', vm=VM, key='enter'); time.sleep(1.0)
shot('zhou_vscode_saved3.png')
rb = call('vm.file_read', vm=VM, path=PATH)
content = base64.b64decode(rb.get('content_base64','')).decode('utf-8','replace') if rb.get('content_base64') else '(missing)'
print("=== dao_run.js (typed via VSCode GUI, autoclose OFF) ===")
print(content)
print("=== node runs the GUI-typed multi-line file ===")
print(call('vm.exec', vm=VM, command='node "%s"' % PATH).get('stdout','').strip())
