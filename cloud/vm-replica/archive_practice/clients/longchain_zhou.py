# -*- coding: utf-8 -*-
"""Long-chain real-use test on zhou via the host REST API: run Node + Python,
open VSCode on a project, type code into VSCode, open Chrome to a URL. Captures
inner-agent screenshots at each stage as evidence. Operate zhou == operate own VM."""
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
    s = call('vm.screenshot', vm=VM, format='png')
    raw = base64.b64decode(s['image_base64'])
    open(r'C:\dao_vm\%s' % name, 'wb').write(raw)
    print('  shot %s -> %dx%d %dB' % (name, s['width'], s['height'], len(raw)))

DEMO = r'C:\dao_vm\demo'
call('vm.exec', vm=VM, command='mkdir "%s" 2>nul' % DEMO)
# demo files
js = "const os=require('os');\nconsole.log('DAO node', process.version, 'on', os.hostname());\nconsole.log('1+2+3 =', [1,2,3].reduce((a,b)=>a+b,0));\n"
py = "import sys, platform\nprint('DAO python', sys.version.split()[0], 'on', platform.node())\nprint('sum 1..10 =', sum(range(1,11)))\n"
call('vm.file_write', vm=VM, path=DEMO+r'\demo.js', content_base64=base64.b64encode(js.encode()).decode())
call('vm.file_write', vm=VM, path=DEMO+r'\demo.py', content_base64=base64.b64encode(py.encode()).decode())

print("=== 1) run Node ===")
print(call('vm.exec', vm=VM, command='node "%s\\demo.js"' % DEMO).get('stdout','').strip())
print("=== 2) run Python ===")
print(call('vm.exec', vm=VM, command='python "%s\\demo.py"' % DEMO).get('stdout','').strip())

print("=== 3) open VSCode on the project folder ===")
call('vm.exec', vm=VM, command='cmd /c start "" code "%s"' % DEMO)
time.sleep(12)
shot('zhou_vscode.png')

print("=== 4) type code into a new VSCode file ===")
# focus the VSCode window, new file, type, save
call('vm.activate', vm=VM, title='Visual Studio Code')
time.sleep(0.5)
call('vm.key', vm=VM, key='ctrl+n')
time.sleep(0.8)
code_text = "// 道法自然 - operate zhou == operate my own VM\nfunction dao(x){ return x*x; }\nconsole.log('dao(7) =', dao(7));\n"
call('vm.type', vm=VM, text=code_text)
time.sleep(0.5)
shot('zhou_vscode_typed.png')

print("=== 5) open Chrome to a URL ===")
call('vm.exec', vm=VM, command='cmd /c start "" chrome --new-window "https://example.com"')
time.sleep(8)
shot('zhou_chrome.png')

print("=== DONE long-chain ===")
