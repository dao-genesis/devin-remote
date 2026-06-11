"""Simulate an MCP client over stdio against mcp_server.py."""
import subprocess, json, sys, base64, os

PY = r'C:\devin\python\python.exe'
SRV = r"C:\\dao_vm\\dao_mcp_server.exe"

p = subprocess.Popen([SRV], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)

def rpc(method, params=None, mid=1):
    p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'method': method,
                              'params': params or {}}) + '\n')
    p.stdin.flush()
    if mid is None:
        return None
    return json.loads(p.stdout.readline())

init = rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}}, 1)
print('[initialize] server =', init['result']['serverInfo'], 'proto =', init['result']['protocolVersion'])

p.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n'); p.stdin.flush()

tl = rpc('tools/list', {}, 2)
names = [t['name'] for t in tl['result']['tools']]
print(f'[tools/list] {len(names)} tools:', ', '.join(names))

ex = rpc('tools/call', {'name': 'vm_exec', 'arguments': {'vm': 'vm01', 'command': 'whoami & echo SESSION=%SESSIONNAME%'}}, 3)
print('[tools/call vm_exec] ->', ex['result']['content'][0]['text'])

ss = rpc('tools/call', {'name': 'vm_screenshot', 'arguments': {'vm': 'vm01'}}, 4)
img = next((c for c in ss['result']['content'] if c['type'] == 'image'), None)
meta = next((c for c in ss['result']['content'] if c['type'] == 'text'), None)
if img:
    raw = base64.b64decode(img['data'])
    out = r'C:\Users\Administrator\dao_work\mcp_vm01_screenshot.png'
    open(out, 'wb').write(raw)
    print(f"[tools/call vm_screenshot] image mimeType={img['mimeType']} meta={meta['text']} saved={out} bytes={len(raw)}")
else:
    print('[tools/call vm_screenshot] NO IMAGE:', ss)

ui = rpc('tools/call', {'name': 'vm_ui_info', 'arguments': {'vm': 'vm01'}}, 5)
print('[tools/call vm_ui_info] ->', ui['result']['content'][0]['text'][:200])

p.stdin.close()
print('[stderr]', p.stderr.read().strip()[:300])
p.terminate()
