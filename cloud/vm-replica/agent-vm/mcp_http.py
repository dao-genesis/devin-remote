r"""mcp_http.py - Streamable-HTTP MCP server for the DAO four-module surface.

道法自然 · 无为而无不为. One public MCP endpoint exposes the user's machine + the
二合一 plugin to ANY remote MCP client (Devin Cloud / Claude / Cursor). It reuses
the already-proven, already-deployed agent-vm computer-control surface (the
"Windows multi-RDP" module's inner agent) instead of reinventing it.

Transport: MCP Streamable HTTP (spec 2025-03-26). Single endpoint that accepts
POST with a JSON-RPC 2.0 body and replies `application/json` (one object). GET
returns 200 so clients that probe the endpoint don't choke. Pure Python stdlib
=> freezable to a single .exe with PyInstaller, same as the rest of agent-vm.

Tool groups (table-driven; see TOOLS):
  pc.*       -> proxied to the console inner agent (vm_inner_agent.py) on PC_PORT
  browser.*  -> same inner agent (Chrome via CDP)
  plugin.* / devin.* / vscode.*  -> proxied to dao-vsix workspace API (DV_PORT)

"先不用多RDP": PC_PORT points at an inner agent running in the interactive console
session, i.e. the user's real desktop. The per-account RDP isolation (vm_host_daemon)
can be layered back on later without changing this server's tool contract.

Env / config (C:\\ProgramData\\dao_vm\\mcp_http.json overrides env):
  MCP_HTTP_PORT   (default 9100)      local listen port
  MCP_HTTP_TOKEN  (default '' = none) Bearer required from the MCP client
  PC_PORT         (default 9050)      inner-agent port (console session)
  PC_TOKEN        (default '')        inner-agent Bearer
  DV_PORT         (default 9920)      dao-vsix workspace server port
  DV_TOKEN        (default '')        dao-vsix Bearer
"""
import http.server, socketserver, json, os, sys, urllib.request, traceback

PROTOCOL_VERSION = '2024-11-05'  # widely-accepted; Streamable HTTP negotiates up
SERVER_INFO = {'name': 'dao-bridge-mcp', 'version': '1.0.0'}

def _load_cfg():
    cfg = {}
    p = r'C:\ProgramData\dao_vm\mcp_http.json'
    try:
        if os.path.exists(p):
            cfg = json.load(open(p, encoding='utf-8'))
    except Exception:
        cfg = {}
    def g(k, d):
        return str(cfg.get(k, os.environ.get(k, d)))
    return {
        'port': int(g('MCP_HTTP_PORT', '9100')),
        'token': g('MCP_HTTP_TOKEN', ''),
        'pc_port': int(g('PC_PORT', '9050')),
        'pc_token': g('PC_TOKEN', ''),
        'dv_port': int(g('DV_PORT', '9920')),
        'dv_token': g('DV_TOKEN', ''),
    }

CFG = _load_cfg()

def log(*a):
    print('[mcp-http]', *a, file=sys.stderr); sys.stderr.flush()

# ---- upstream proxies -------------------------------------------------------
def _post_json(url, body, token, timeout=120):
    data = json.dumps(body).encode()
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, method='POST', headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or '{}')

def pc_call(action, args):
    """Proxy a computer/browser action to the console inner agent."""
    body = dict(args or {}); body['action'] = action
    return _post_json('http://127.0.0.1:%d/' % CFG['pc_port'], body, CFG['pc_token'])

def dv_call(method, path, args):
    """Proxy to the dao-vsix workspace API (GET/POST)."""
    url = 'http://127.0.0.1:%d%s' % (CFG['dv_port'], path)
    if method == 'GET':
        headers = {}
        if CFG['dv_token']:
            headers['Authorization'] = 'Bearer ' + CFG['dv_token']
        req = urllib.request.Request(url, method='GET', headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode() or '{}')
    return _post_json(url, args or {}, CFG['dv_token'])

# ---- tool catalog -----------------------------------------------------------
# name -> dict(kind, action|path|method, desc, props, required)
S = 'string'; I = 'integer'; N = 'number'; B = 'boolean'
def XY(extra=None):
    p = {'x': {'type': I}, 'y': {'type': I}}
    if extra: p.update(extra)
    return p

TOOLS = {
    # ---- 模块3 · 操作用户电脑 (console session · 先不用多RDP) ----
    'pc_exec':        dict(kind='pc', action='exec', desc='Run a shell command on the user PC and wait for output.',
                           props={'command': {'type': S}, 'detach': {'type': B}}, required=['command']),
    'pc_desktop_info':dict(kind='pc', action='desktop_info', desc='Get screen size + session user of the user PC.', props={}, required=[]),
    'pc_screenshot':  dict(kind='pc', action='screenshot', desc='Capture the user PC desktop as PNG.',
                           props={'format': {'type': S, 'enum': ['png', 'bmp']}}, required=[]),
    'pc_click':       dict(kind='pc', action='click', desc='Left click at (x,y).', props=XY(), required=['x', 'y']),
    'pc_double_click':dict(kind='pc', action='double_click', desc='Double click at (x,y).', props=XY(), required=['x', 'y']),
    'pc_right_click': dict(kind='pc', action='right_click', desc='Right click at (x,y).', props=XY(), required=['x', 'y']),
    'pc_mouse_move':  dict(kind='pc', action='mouse_move', desc='Move mouse to (x,y).', props=XY(), required=['x', 'y']),
    'pc_drag':        dict(kind='pc', action='drag', desc='Drag from (x1,y1) to (x2,y2).',
                           props={'x1': {'type': I}, 'y1': {'type': I}, 'x2': {'type': I}, 'y2': {'type': I}}, required=['x1', 'y1', 'x2', 'y2']),
    'pc_scroll':      dict(kind='pc', action='scroll', desc='Scroll wheel at (x,y); clicks>0 up, <0 down.', props=XY({'clicks': {'type': I}}), required=['x', 'y', 'clicks']),
    'pc_type':        dict(kind='pc', action='type', desc='Type Unicode text (supports CJK).', props={'text': {'type': S}}, required=['text']),
    'pc_key':         dict(kind='pc', action='key', desc="Press a key combo, e.g. 'ctrl+a', 'enter'.", props={'key': {'type': S}}, required=['key']),
    'pc_hold_key':    dict(kind='pc', action='hold_key', desc='Hold a key for duration seconds.', props={'key': {'type': S}, 'duration': {'type': N}}, required=['key', 'duration']),
    'pc_file_read':   dict(kind='pc', action='file_read', desc='Read a file on the user PC (returns base64).', props={'path': {'type': S}}, required=['path']),
    'pc_file_write':  dict(kind='pc', action='file_write', desc='Write a file on the user PC from base64 content.', props={'path': {'type': S}, 'content_base64': {'type': S}}, required=['path', 'content_base64']),
    'pc_ui_info':     dict(kind='pc', action='ui_info', desc='Enumerate visible top-level windows (title/hwnd/rect).', props={}, required=[]),
    'pc_ui_tree':     dict(kind='pc', action='ui_tree', desc='Dump the control tree under a window (element-level grounding).',
                           props={'title': {'type': S}, 'hwnd': {'type': I}, 'max_depth': {'type': I}}, required=[]),
    'pc_activate':    dict(kind='pc', action='activate', desc='Bring a window (matched by title substring) to the foreground.', props={'title': {'type': S}}, required=['title']),
    'pc_foreground':  dict(kind='pc', action='foreground', desc='Get the current foreground window (hwnd/title).', props={}, required=[]),
    # ---- 模块1 · 浏览器 (CDP) ----
    'browser_launch':     dict(kind='pc', action='browser_launch', desc='Launch/ensure Chrome on the user PC with CDP; optional initial url.', props={'url': {'type': S}}, required=[]),
    'browser_navigate':   dict(kind='pc', action='browser_navigate', desc='Navigate the browser to a URL (CDP).', props={'url': {'type': S}}, required=['url']),
    'browser_eval':       dict(kind='pc', action='browser_eval', desc='Evaluate JavaScript in the browser page and return the value (CDP).', props={'expression': {'type': S}}, required=['expression']),
    'browser_screenshot': dict(kind='pc', action='browser_screenshot', desc='Capture the browser page as PNG (CDP).', props={}, required=[]),
    'browser_targets':    dict(kind='pc', action='browser_targets', desc='List CDP targets (open tabs).', props={}, required=[]),
    # ---- 模块2 · 插件本体 (dao-vsix workspace API) ----
    'plugin_health':  dict(kind='dv', method='GET', path='/api/health', desc='二合一插件存活与版本。', props={}, required=[]),
    'plugin_exec':    dict(kind='dv', method='POST', path='/api/exec', desc='经二合一插件执行命令(整机)。', props={'cmd': {'type': S}, 'timeout': {'type': I}}, required=['cmd']),
    # ---- 模块4 · VSCode / Devin Cloud (dao-vsix workspace API) ----
    'vscode_command': dict(kind='dv', method='POST', path='/api/command', desc='执行一个 VS Code 命令 (command/args)。', props={'command': {'type': S}, 'args': {'type': 'array'}}, required=['command']),
}

def tool_schema():
    out = []
    for name, t in TOOLS.items():
        out.append({'name': name, 'description': t['desc'],
                    'inputSchema': {'type': 'object', 'properties': t['props'], 'required': t['required']}})
    return out

def call_tool(name, args):
    t = TOOLS.get(name)
    if not t:
        return {'content': [{'type': 'text', 'text': 'unknown tool ' + str(name)}], 'isError': True}
    args = dict(args or {})
    if t['kind'] == 'pc':
        res = pc_call(t['action'], args)
        if t['action'] in ('screenshot', 'browser_screenshot') and isinstance(res, dict) and res.get('image_base64'):
            meta = '%sx%s %sB %s' % (res.get('width'), res.get('height'), res.get('size'), res.get('format', 'png'))
            return {'content': [{'type': 'image', 'data': res['image_base64'], 'mimeType': 'image/png'},
                                {'type': 'text', 'text': meta}]}
    else:
        res = dv_call(t['method'], t['path'], args)
    is_err = bool(isinstance(res, dict) and res.get('error'))
    return {'content': [{'type': 'text', 'text': json.dumps(res, ensure_ascii=False)}], 'isError': is_err}

# ---- JSON-RPC dispatch ------------------------------------------------------
def handle_rpc(req):
    mid = req.get('id'); method = req.get('method'); params = req.get('params', {})
    if method == 'initialize':
        return {'jsonrpc': '2.0', 'id': mid, 'result': {
            'protocolVersion': PROTOCOL_VERSION, 'capabilities': {'tools': {}}, 'serverInfo': SERVER_INFO}}
    if method in ('notifications/initialized', 'initialized'):
        return None
    if method == 'tools/list':
        return {'jsonrpc': '2.0', 'id': mid, 'result': {'tools': tool_schema()}}
    if method == 'tools/call':
        try:
            r = call_tool(params.get('name'), params.get('arguments'))
        except Exception as e:
            r = {'content': [{'type': 'text', 'text': 'error: %s' % e}], 'isError': True}
        return {'jsonrpc': '2.0', 'id': mid, 'result': r}
    if method == 'ping':
        return {'jsonrpc': '2.0', 'id': mid, 'result': {}}
    return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'method not found: %s' % method}}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _auth_ok(self):
        if not CFG['token']:
            return True
        h = self.headers.get('Authorization', '')
        return h == 'Bearer ' + CFG['token']

    def _send(self, code, obj, ctype='application/json'):
        body = (json.dumps(obj, ensure_ascii=False) if not isinstance(obj, (bytes, str)) else obj)
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        # Health / capability probe. Some clients GET the endpoint first.
        self._send(200, {'status': 'ok', 'service': SERVER_INFO['name'], 'version': SERVER_INFO['version'],
                         'transport': 'streamable-http', 'tools': len(TOOLS)})

    def do_POST(self):
        if not self._auth_ok():
            return self._send(401, {'error': 'unauthorized'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(n) if n else b''
            req = json.loads(raw.decode() or '{}')
        except Exception:
            return self._send(400, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})
        # Support JSON-RPC batch arrays per spec.
        if isinstance(req, list):
            out = [r for r in (handle_rpc(x) for x in req) if r is not None]
            return self._send(200, out)
        resp = handle_rpc(req)
        if resp is None:
            # notification: 202 Accepted, no body
            self.send_response(202); self.end_headers(); return
        self._send(200, resp)

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    srv = ThreadedHTTPServer(('127.0.0.1', CFG['port']), Handler)
    log('dao-bridge-mcp up on 127.0.0.1:%d ; tools=%d ; pc:%d dv:%d' % (CFG['port'], len(TOOLS), CFG['pc_port'], CFG['dv_port']))
    srv.serve_forever()

if __name__ == '__main__':
    main()
