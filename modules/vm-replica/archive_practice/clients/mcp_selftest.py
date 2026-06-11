# -*- coding: utf-8 -*-
"""Run ON 141: act as a generic MCP client. Spawn mcp_server.py over stdio
(newline-delimited JSON-RPC 2.0) and drive zhou exactly as ANY external agent
(Claude/Cursor/Windsurf) would, proving the universal layer works."""
import subprocess, json, base64, sys, io, time, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
PY = r'C:\ProgramData\anaconda3\python.exe'
SRV = r'C:\dao_vm\mcp_server.py'
VM = 'zhou'

p = subprocess.Popen([PY, SRV], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, bufsize=1,
                     universal_newlines=True, encoding='utf-8')
_id = 0
def rpc(method, params=None, notify=False):
    global _id
    msg = {'jsonrpc': '2.0', 'method': method}
    if not notify:
        _id += 1; msg['id'] = _id
    if params is not None:
        msg['params'] = params
    p.stdin.write(json.dumps(msg) + '\n'); p.stdin.flush()
    if notify:
        return None
    line = p.stdout.readline()
    return json.loads(line)

R = []
def rec(n, ok, d=''): R.append((n, 'PASS' if ok else 'FAIL', d)); print(('PASS ' if ok else 'FAIL '), n, '::', d)

try:
    init = rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'generic-agent', 'version': '1'}})
    si = init['result']['serverInfo']
    rec('initialize', si.get('name') == 'dao-multi-rdp-vm', json.dumps(si, ensure_ascii=False))
    rpc('notifications/initialized', notify=True)

    tl = rpc('tools/list')
    tools = [t['name'] for t in tl['result']['tools']]
    need = ['vm_exec','vm_screenshot','vm_type','vm_key','vm_hold_key','vm_drag','vm_file_read',
            'vm_file_write','vm_file_append','vm_ui_info','vm_activate','vm_foreground']
    rec('tools/list', all(n in tools for n in need), '%d tools; missing=%s' % (len(tools), [n for n in need if n not in tools]))

    r = rpc('tools/call', {'name': 'vm_exec', 'arguments': {'vm': VM, 'command': 'whoami'}})
    txt = r['result']['content'][0]['text']
    rec('tools/call vm_exec whoami', 'zhou' in txt.lower(), txt.strip()[:80])

    # file roundtrip via MCP
    payload = '道法自然 MCP-UNIVERSAL 物无非彼\n'
    P = r'C:\dao_vm\mcp_selftest_%s.txt' % time.strftime('%H%M%S')
    rpc('tools/call', {'name': 'vm_file_write', 'arguments': {'vm': VM, 'path': P, 'content_base64': base64.b64encode(payload.encode()).decode()}})
    rr = rpc('tools/call', {'name': 'vm_file_read', 'arguments': {'vm': VM, 'path': P}})
    rd = json.loads(rr['result']['content'][0]['text'])
    got = base64.b64decode(rd['content_base64']).decode('utf-8')
    rec('tools/call file write+read roundtrip(CJK)', got == payload, 'equal=%s' % (got == payload))

    # screenshot via MCP -> image content block
    rs = rpc('tools/call', {'name': 'vm_screenshot', 'arguments': {'vm': VM, 'format': 'png'}})
    blocks = rs['result']['content']
    img = next((b for b in blocks if b.get('type') == 'image'), None)
    ok = img is not None and img.get('mimeType') == 'image/png' and len(img.get('data', '')) > 1000
    rec('tools/call vm_screenshot -> image/png', ok, ('bytes_b64=%d' % len(img['data'])) if img else 'no image block')

    fg = rpc('tools/call', {'name': 'vm_foreground', 'arguments': {'vm': VM}})
    rec('tools/call vm_foreground', not fg['result'].get('isError'), fg['result']['content'][0]['text'][:80])

    # cleanup our file
    rpc('tools/call', {'name': 'vm_exec', 'arguments': {'vm': VM, 'command': 'del "%s"' % P}})
finally:
    try: p.stdin.close(); p.terminate()
    except Exception: pass

npass = sum(1 for _,s,_ in R if s == 'PASS')
print('\nMCP_SELFTEST %d/%d PASS' % (npass, len(R)))
