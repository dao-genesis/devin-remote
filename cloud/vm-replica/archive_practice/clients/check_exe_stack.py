import sys, os, json, base64, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
TOKEN = CFG['token']; HOST = f"http://127.0.0.1:{CFG['host_port']}"
def call(body):
    req = urllib.request.Request(HOST + '/', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {TOKEN}'}, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=60).read())
ss = call({'action': 'vm.screenshot', 'vm': 'vm01', 'format': 'png'})
raw = base64.b64decode(ss['image_base64'])
out = r'C:\Users\Administrator\dao_work\exe_stack_vm01.png'
open(out, 'wb').write(raw)
print(f"screenshot via EXE stack: {ss['format']} {ss['width']}x{ss['height']} {len(raw)}B -> {out}")
ui = call({'action': 'vm.ui_info', 'vm': 'vm01'})
print('ui_info windows:', [w['title'] for w in ui.get('windows', [])][:5])
