"""test_mcp_http.py - offline self-test for the unified comprehensive MCP catalog.

Imports mcp_http WITHOUT starting the server (main is __main__-guarded) and checks:
  - the five tool groups are all present (pc/browser/plugin/vscode/vm)
  - every tool schema is well-formed (required keys are declared in properties)
  - call_tool routes to the correct upstream proxy (pc_call/vm_call/dv_call)
  - dv query_keys move the arg into the query string (e.g. plugin_file_read ?path=)
  - screenshot results are returned as MCP image content
Pure stdlib; run: python test_mcp_http.py
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp_http as M

fails = []
def check(cond, msg):
    if not cond:
        fails.append(msg)

# ---- 1) catalog: five groups present ----------------------------------------
prefixes = {}
for name in M.TOOLS:
    prefixes.setdefault(name.split('_')[0], 0)
    prefixes[name.split('_')[0]] += 1
for grp in ('pc', 'browser', 'plugin', 'vscode', 'vm'):
    check(prefixes.get(grp, 0) > 0, 'missing tool group: ' + grp)

# ---- 2) schema well-formed: required ⊆ properties, kind valid ---------------
for name, t in M.TOOLS.items():
    check(t['kind'] in ('pc', 'vm', 'dv'), name + ' bad kind ' + str(t.get('kind')))
    for r in t['required']:
        check(r in t['props'], '%s: required %s not in props' % (name, r))
    if t['kind'] == 'dv':
        check('method' in t and 'path' in t, name + ' dv tool missing method/path')
    else:
        check('action' in t, name + ' non-dv tool missing action')

# tool_schema() must emit one entry per tool with inputSchema
sch = M.tool_schema()
check(len(sch) == len(M.TOOLS), 'tool_schema count mismatch')
for s in sch:
    check('name' in s and 'description' in s and 'inputSchema' in s, 'bad schema entry: ' + str(s)[:60])

# ---- 3) routing: monkeypatch the three proxies, assert correct target -------
calls = {}
M.pc_call = lambda action, args: {'_via': 'pc', 'action': action, 'args': args}
M.vm_call = lambda action, args: {'_via': 'vm', 'action': action, 'args': args}
def fake_dv(method, path, args, query_keys=None):
    return {'_via': 'dv', 'method': method, 'path': path, 'args': args, 'query_keys': query_keys}
M.dv_call = fake_dv

r = M.call_tool('pc_exec', {'command': 'hostname'})
body = json.loads(r['content'][0]['text'])
check(body['_via'] == 'pc' and body['action'] == 'exec', 'pc_exec routing')

r = M.call_tool('vm_create', {'vm': 'vm01'})
body = json.loads(r['content'][0]['text'])
check(body['_via'] == 'vm' and body['action'] == 'vm.create', 'vm_create routing')

r = M.call_tool('vscode_command', {'command': 'workbench.action.files.save'})
body = json.loads(r['content'][0]['text'])
check(body['_via'] == 'dv' and body['method'] == 'POST' and body['path'] == '/api/command', 'vscode_command routing')

# ---- 4) dv query_keys passed through for ?path= endpoints -------------------
r = M.call_tool('plugin_file_read', {'path': '/tmp/x'})
body = json.loads(r['content'][0]['text'])
check(body['query_keys'] == ['path'], 'plugin_file_read query_keys')
check(body['path'] == '/api/file', 'plugin_file_read path')

# ---- 5) image result shape for screenshots ----------------------------------
M.pc_call = lambda action, args: {'image_base64': 'QUJD', 'width': 800, 'height': 600, 'size': 3, 'format': 'png'}
r = M.call_tool('pc_screenshot', {})
check(r['content'][0]['type'] == 'image' and r['content'][0]['data'] == 'QUJD', 'pc_screenshot image content')
M.vm_call = lambda action, args: {'image_base64': 'WFla', 'width': 1, 'height': 1, 'size': 3, 'format': 'png'}
r = M.call_tool('vm_screenshot', {'vm': 'vm01'})
check(r['content'][0]['type'] == 'image', 'vm_screenshot image content')

# ---- 6) unknown tool is a clean error ---------------------------------------
r = M.call_tool('does_not_exist', {})
check(r.get('isError') is True, 'unknown tool not flagged as error')

if fails:
    print('FAIL (%d):' % len(fails))
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('OK · %d tools · groups=%s' % (len(M.TOOLS), {k: prefixes[k] for k in sorted(prefixes)}))
