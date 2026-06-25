"""mcp_server.py - Model Context Protocol server for the multi-RDP VM module.

Exposes the host daemon's capabilities as MCP tools over stdio (newline-delimited
JSON-RPC 2.0), so ANY MCP-compatible agent (Devin / Claude / Cursor / Windsurf)
can drive the RDP "VMs" with the exact same operation surface Devin uses on its
own VM. Pure stdlib (no deps) => can be frozen to a single .exe with PyInstaller.

Run:  python mcp_server.py            (reads C:\\ProgramData\\dao_vm\\config.json)
Transport: stdio. Logs go to stderr ONLY (stdout is reserved for protocol).
"""
import sys, os, json, urllib.request, traceback

CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
TOKEN = CFG['token']
HOST = f"http://127.0.0.1:{CFG['host_port']}"
PROTOCOL_VERSION = '2024-11-05'

def log(*a):
    print('[mcp]', *a, file=sys.stderr); sys.stderr.flush()

def daemon(action, **kw):
    body = dict(action=action, **kw)
    req = urllib.request.Request(HOST + '/', data=json.dumps(body).encode(),
        method='POST', headers={'Content-Type': 'application/json',
                                'Authorization': f'Bearer {TOKEN}'})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())

# ---- tool catalog: name -> (daemon action, description, input properties, required) ----
def _vm(extra=None, req=True):
    props = {'vm': {'type': 'string', 'description': 'VM/account name, e.g. vm01'}}
    if extra: props.update(extra)
    return props, (['vm'] + (list(extra.keys()) if (extra and req) else []))

S = 'string'; I = 'integer'; N = 'number'
TOOLS = {
    'vm_create':       ('vm.create',      'Create/ensure an RDP VM (account+session+inner agent).',
                        {'name': {'type': S}}, ['name']),
    'vm_attach':       ('vm.attach',       'Attach to an ALREADY-logged-in account (existing RDP session); no password change, no mstsc. Use for user-opened sessions.',
                        {'name': {'type': S}}, ['name']),
    'vm_destroy':      ('vm.destroy',      'Logoff + delete a CREATED VM account/profile. Attached accounts are only detached (preserved).',
                        {'name': {'type': S}}, ['name']),
    'vm_list':         ('vm.list',         'List all VMs and live sessions.', {}, []),
    'vm_exec':         ('vm.exec',         'Run a shell command inside the VM and wait for output.',
                        {'vm': {'type': S}, 'command': {'type': S}, 'detach': {'type': 'boolean'}},
                        ['vm', 'command']),
    'vm_launch':       ('vm.launch',       'Launch a GUI app / detached process inside the VM (non-blocking; use for notepad, chrome, etc.).',
                        *(_vm({'command': {'type': S}}))),
    'vm_screenshot':   ('vm.screenshot',   'Capture the VM desktop as PNG.',
                        *(_vm({'format': {'type': S, 'enum': ['png', 'bmp']}}, req=False))),
    'vm_desktop_info': ('vm.desktop_info', 'Get VM screen size + session user.', *(_vm())),
    'vm_click':        ('vm.click',        'Left click at (x,y).', *(_vm({'x': {'type': I}, 'y': {'type': I}}))),
    'vm_double_click': ('vm.double_click', 'Double click at (x,y).', *(_vm({'x': {'type': I}, 'y': {'type': I}}))),
    'vm_right_click':  ('vm.right_click',  'Right click at (x,y).', *(_vm({'x': {'type': I}, 'y': {'type': I}}))),
    'vm_mouse_move':   ('vm.mouse_move',   'Move mouse to (x,y).', *(_vm({'x': {'type': I}, 'y': {'type': I}}))),
    'vm_drag':         ('vm.drag',         'Drag from (x1,y1) to (x2,y2).',
                        *(_vm({'x1': {'type': I}, 'y1': {'type': I}, 'x2': {'type': I}, 'y2': {'type': I}}))),
    'vm_scroll':       ('vm.scroll',       'Scroll wheel at (x,y); clicks>0 up, <0 down.',
                        *(_vm({'x': {'type': I}, 'y': {'type': I}, 'clicks': {'type': I}}))),
    'vm_type':         ('vm.type',         'Type Unicode text (supports CJK).', *(_vm({'text': {'type': S}}))),
    'vm_key':          ('vm.key',          "Press a key combo, e.g. 'ctrl+a', 'enter'.", *(_vm({'key': {'type': S}}))),
    'vm_hold_key':     ('vm.hold_key',     'Hold a key for duration seconds.',
                        *(_vm({'key': {'type': S}, 'duration': {'type': N}}))),
    'vm_file_read':    ('vm.file_read',    'Read a file (returns base64).', *(_vm({'path': {'type': S}}))),
    'vm_file_write':   ('vm.file_write',   'Write a file from base64 content.',
                        *(_vm({'path': {'type': S}, 'content_base64': {'type': S}}))),
    'vm_file_append':  ('vm.file_append',  'Append base64 content to a file (created if absent).',
                        *(_vm({'path': {'type': S}, 'content_base64': {'type': S}}))),
    'vm_ui_info':      ('vm.ui_info',      'Enumerate visible top-level windows (title/hwnd/rect).', *(_vm())),
    'vm_activate':     ('vm.activate',     'Bring a window (matched by title substring) to the foreground.',
                        *(_vm({'title': {'type': S}}))),
    'vm_foreground':   ('vm.foreground',   'Get the current foreground window (hwnd/title) in the VM session.', *(_vm())),
    'vm_sessions':     ('vm.sessions',     'List Windows sessions (quser) on the host.', {}, []),
    'vm_ui_tree':      ('vm.ui_tree',      'Dump the control tree (class/text/rect/ctrlId/visible) under a window; foreground window if none given. Element-level grounding.',
                        *(_vm({'title': {'type': S}, 'hwnd': {'type': I}, 'max_depth': {'type': I}}, req=False))),
    # --- Predictive Operation Layer (active inference): predict -> act -> verify -> reflex ---
    'vm_observe':      ('vm.observe',       'Cheap perception: compact state signature (foreground+focus+control-tree hash, hundreds of bytes, NO screenshot). Optional region/screen perceptual hash. Use to verify changes instead of re-screenshotting.',
                        *(_vm({'region': {'type': 'array', 'items': {'type': I}, 'description': '[l,t,r,b] to also return a perceptual hash for'},
                               'screen_hash': {'type': 'boolean'}}, req=False))),
    'vm_find':         ('vm.find',          'Locate UI element(s) LOCALLY by text/class/id/regex/control_type (no LLM vision grounding). Tries the raw Win32 control tree first, then auto-falls back to UI Automation for modern frameworks the HWND tree cannot see (Ribbon e.g. mspaint/wordpad, WPF, UWP/XAML e.g. Calculator, Chromium/Electron, Qt). Returns rect+center to act on semantically; response "backend" is tree or uia.',
                        *(_vm({'text': {'type': S}, 'class': {'type': S}, 'id': {'type': I}, 'regex': {'type': S},
                               'control_type': {'type': S, 'description': 'UIA control type name/id, e.g. Button/Edit/MenuItem/TabItem'},
                               'title': {'type': S, 'description': 'root window title; default foreground'}, 'max_depth': {'type': I}}, req=False))),
    'vm_read':         ('vm.read',          'Read a control\'s semantic VALUE/STATE LOCALLY via UI Automation (no pixels, no LLM): checkbox/toggle state (toggle 0/1/2), edit/combo text value, slider/progress range, list/tab selection. Returns only the keys meaningful for the matched control type. Use to verify outcomes by MEANING (e.g. "is this box now checked") instead of inferring from a screenshot.',
                        *(_vm({'text': {'type': S}, 'class': {'type': S}, 'id': {'type': I}, 'regex': {'type': S},
                               'control_type': {'type': S}, 'title': {'type': S, 'description': 'root window title; default foreground'}}, req=False))),
    'vm_region_hash':  ('vm.region_hash',   'Return the 64-bit perceptual (dHash) of a screen rectangle [l,t,r,b]. 8 bytes; for cheap change detection.',
                        *(_vm({'rect': {'type': 'array', 'items': {'type': I}}}))),
    'vm_where_changed':('vm.where_changed', 'Localize WHERE the screen changed for no-control-tree apps (canvas/custom-drawn/games). First call (no baseline) returns a tile baseline; pass it back to get changed cells + a union bbox in screen coords (hundreds of bytes, no PNG). Optional region/cols/rows/threshold.',
                        *(_vm({'region': {'type': 'array', 'items': {'type': I}}, 'baseline': {'type': 'object'},
                               'cols': {'type': I}, 'rows': {'type': I}, 'threshold': {'type': I}}, req=False))),
    'vm_wait_change':  ('vm.wait_change',   'Block until the state signature (or a region) changes from a baseline, or timeout. Event-style verification (replaces screenshot polling).',
                        *(_vm({'baseline': {'type': S}, 'region': {'type': 'array', 'items': {'type': I}},
                               'timeout': {'type': N}, 'poll': {'type': N}}, req=False))),
    'vm_act':          ('vm.act',           "Predict-act-verify in ONE call: perform op on a semantic target {text/class/id} or {x,y}, then verify a predicted outcome (expect) LOCALLY; reflex-retry on mismatch; only escalate (region PNG + signature diff) on genuine surprise. op: click/double_click/right_click/mouse_move/drag/scroll/type/key/hold_key. expect predicates: changed/foreground/foreground_regex/focus_class/appears/disappears/value/region_changed; plus SEMANTIC state via UIA: checked/unchecked (toggle) and state ({text,toggle/selected/value/range}); plus PIXEL-ONLY effect ({action,region,learn}) for canvas/no-semantics apps -- verifies the action's local visual change against a forward model grown from practice (presence+magnitude+locus, phase-stable), learns the episode, and flags a novel action as the genuine-surprise/escalation signal. Reflex re-issue is skipped when effect is asserted (drags/scrolls are non-idempotent).",
                        *(_vm({'op': {'type': S}, 'target': {'type': 'object'}, 'x': {'type': I}, 'y': {'type': I},
                               'x2': {'type': I}, 'y2': {'type': I}, 'text': {'type': S}, 'key': {'type': S},
                               'clicks': {'type': I}, 'duration': {'type': N}, 'expect': {'type': 'object'}, 'retry': {'type': I}}, req=False))),
    'vm_act_seq':      ('vm.act_seq',       'Speculative multi-action: run a predicted chain of act() steps with per-step self-verification. One plan, zero per-step LLM/screenshot on the happy path; aborts+escalates at the first unrecoverable prediction error.',
                        *(_vm({'steps': {'type': 'array', 'items': {'type': 'object'}}, 'stop_on_error': {'type': 'boolean'}}))),
    'vm_browser_launch':     ('vm.browser_launch',     'Launch/ensure Chrome or Edge inside the VM with CDP remote-debugging; optional initial url.',
                        *(_vm({'url': {'type': S}}, req=False))),
    'vm_browser_navigate':   ('vm.browser_navigate',   'Navigate the VM browser to a URL (CDP Page.navigate).',
                        *(_vm({'url': {'type': S}}))),
    'vm_browser_eval':       ('vm.browser_eval',       'Evaluate JavaScript in the VM browser page and return the value (CDP Runtime.evaluate). Parity with Devin browser_console.',
                        *(_vm({'expression': {'type': S}}))),
    'vm_browser_screenshot': ('vm.browser_screenshot', 'Capture the VM browser page as PNG (CDP Page.captureScreenshot).', *(_vm())),
    'vm_browser_targets':    ('vm.browser_targets',    'List CDP targets (open tabs) in the VM browser.', *(_vm())),
    'vm_snapshot':     ('vm.snapshot',     'Snapshot the VM user profile (robocopy backup-mode mirror). Devin blueprint/snapshot analog. Optional tag/path.',
                        *(_vm({'tag': {'type': S}, 'path': {'type': S}}, req=False))),
    'vm_restore':      ('vm.restore',      'Restore a VM profile snapshot by tag (tag required).',
                        *(_vm({'tag': {'type': S}, 'path': {'type': S}}, req=False))),
    'vm_snapshots':    ('vm.snapshots',    'List snapshot tags for a VM.', *(_vm())),
}

def tool_schema():
    out = []
    for name, (action, desc, props, required) in TOOLS.items():
        out.append({'name': name, 'description': desc,
                    'inputSchema': {'type': 'object', 'properties': props, 'required': required}})
    return out

def call_tool(name, args):
    if name not in TOOLS:
        return {'content': [{'type': 'text', 'text': f'unknown tool {name}'}], 'isError': True}
    action = TOOLS[name][0]
    args = dict(args or {})
    # daemon proxy expects 'vm' for the target; lifecycle uses 'name'
    res = daemon(action, **args)
    if name in ('vm_screenshot', 'vm_browser_screenshot') and res.get('image_base64'):
        meta = (f"{res.get('width')}x{res.get('height')} {res.get('size')}B {res.get('format')}"
                if name == 'vm_screenshot' else 'browser page (png)')
        return {'content': [
            {'type': 'image', 'data': res['image_base64'], 'mimeType': 'image/png'},
            {'type': 'text', 'text': meta}]}
    # act/act_seq escalate on surprise with a cropped region PNG -> surface it as an image
    # block so the brain only pays the vision cost on genuine prediction error.
    crop = res.get('region_png_base64')
    if not crop and isinstance(res.get('steps'), list):
        for st in res['steps']:
            if st.get('region_png_base64'):
                crop = st['region_png_base64']; break
    if crop:
        slim = {k: v for k, v in res.items() if k != 'region_png_base64'}
        if isinstance(slim.get('steps'), list):
            slim['steps'] = [{k: v for k, v in s.items() if k != 'region_png_base64'} for s in slim['steps']]
        return {'content': [
            {'type': 'text', 'text': json.dumps(slim, ensure_ascii=False)},
            {'type': 'image', 'data': crop, 'mimeType': 'image/png'}]}
    is_err = bool(res.get('error'))
    return {'content': [{'type': 'text', 'text': json.dumps(res, ensure_ascii=False)}], 'isError': is_err}

def handle(req):
    mid = req.get('id'); method = req.get('method'); params = req.get('params', {})
    if method == 'initialize':
        return {'jsonrpc': '2.0', 'id': mid, 'result': {
            'protocolVersion': PROTOCOL_VERSION,
            'capabilities': {'tools': {}},
            'serverInfo': {'name': 'dao-multi-rdp-vm', 'version': '2.0.0'}}}
    if method == 'notifications/initialized' or method == 'initialized':
        return None
    if method == 'tools/list':
        return {'jsonrpc': '2.0', 'id': mid, 'result': {'tools': tool_schema()}}
    if method == 'tools/call':
        try:
            r = call_tool(params.get('name'), params.get('arguments'))
        except Exception as e:
            r = {'content': [{'type': 'text', 'text': f'error: {e}'}], 'isError': True}
        return {'jsonrpc': '2.0', 'id': mid, 'result': r}
    if method == 'ping':
        return {'jsonrpc': '2.0', 'id': mid, 'result': {}}
    return {'jsonrpc': '2.0', 'id': mid,
            'error': {'code': -32601, 'message': f'method not found: {method}'}}

def main():
    log(f'dao-multi-rdp-vm MCP server up; host={HOST}; tools={len(TOOLS)}')
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            log('bad json:', line[:120]); continue
        try:
            resp = handle(req)
        except Exception:
            log('handler error:', traceback.format_exc())
            resp = {'jsonrpc': '2.0', 'id': req.get('id'),
                    'error': {'code': -32603, 'message': 'internal error'}}
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + '\n')
            sys.stdout.flush()

if __name__ == '__main__':
    main()
