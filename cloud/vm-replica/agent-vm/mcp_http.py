r"""mcp_http.py - Streamable-HTTP MCP server for the DAO four-module surface.

道法自然 · 无为而无不为. One public MCP endpoint exposes the user's machine + the
二合一 plugin to ANY remote MCP client (Devin Cloud / Claude / Cursor). It reuses
the already-proven, already-deployed agent-vm computer-control surface (the
"Windows multi-RDP" module's inner agent) instead of reinventing it.

Transport: MCP Streamable HTTP (spec 2025-03-26). Single endpoint that accepts
POST with a JSON-RPC 2.0 body and replies `application/json` (one object). GET
returns 200 so clients that probe the endpoint don't choke. Pure Python stdlib
=> freezable to a single .exe with PyInstaller, same as the rest of agent-vm.

归一 · 综合 MCP (one endpoint, five tool groups — 不分而治之):
  pc_*       -> console inner agent (vm_inner_agent.py · PC_PORT): 整机操作(exec/截屏/鼠键/文件/窗口/ui_tree)
  browser_*  -> same inner agent (Chrome via CDP): 新开/导航/eval/截屏/targets
  plugin_*   -> dao-vsix workspace API (DV_PORT): 插件本体/工作区(exec/ls/file/write/edit/search/terminal/git/tools)
  vscode_*   -> dao-vsix workspace API (DV_PORT): VSCode 暴露的命令/诊断/定义/引用/符号
  vm_*       -> vm_host_daemon (HOST_PORT): Windows 多 RDP — 每账号隔离会话(创建/接管/销毁/快照)+会话内整机面

原本分散的「浏览器 / 软件本体 / VSCode / 多RDP」四模块自定义 MCP 在此整合归一为单一综合 MCP:
操作浏览器即操作插件本体的一部分。pc_*/browser_* 走交互式控制台会话(用户真实桌面·单目标);
需要每账号隔离时改用 vm_* (vm_host_daemon 的多会话编排), 两套操作面同构、工具契约一致。

Env / config (C:\\ProgramData\\dao_vm\\mcp_http.json overrides env):
  MCP_HTTP_PORT   (default 9100)      local listen port
  MCP_HTTP_TOKEN  (default '' = none) Bearer required from the MCP client
  PC_PORT         (default 9050)      inner-agent port (console session)
  PC_TOKEN        (default '')        inner-agent Bearer
  DV_PORT         (default 9920)      dao-vsix workspace server port
  DV_TOKEN        (default '')        dao-vsix Bearer
  HOST_PORT       (default 9000 / config.json host_port)  vm_host_daemon port (多RDP)
  HOST_TOKEN      (default config.json token)             vm_host_daemon Bearer
"""
import http.server, socketserver, json, os, sys, urllib.request, urllib.parse, traceback

PROTOCOL_VERSION = '2024-11-05'  # widely-accepted; Streamable HTTP negotiates up
SERVER_INFO = {'name': 'dao-bridge-mcp', 'version': '2.0.0'}  # 综合 MCP 归一: pc/browser/plugin/vscode/vm 五组

def _load_cfg():
    cfg = {}
    p = r'C:\ProgramData\dao_vm\mcp_http.json'
    try:
        if os.path.exists(p):
            cfg = json.load(open(p, encoding='utf-8'))
    except Exception:
        cfg = {}
    # 归一 · 多RDP 主机守护进程的端口/token 落在 vm_host_daemon 的 config.json;
    #   读取它作为 host_port/host_token 默认值, 让综合 MCP 无需重复配置即可代理 vm_* 工具组。
    hd = {}
    try:
        hp = r'C:\ProgramData\dao_vm\config.json'
        if os.path.exists(hp):
            hd = json.load(open(hp, encoding='utf-8'))
    except Exception:
        hd = {}
    def g(k, d):
        return str(cfg.get(k, os.environ.get(k, d)))
    return {
        'port': int(g('MCP_HTTP_PORT', '9100')),
        'token': g('MCP_HTTP_TOKEN', ''),
        'pc_port': int(g('PC_PORT', '9050')),
        'pc_token': g('PC_TOKEN', ''),
        'dv_port': int(g('DV_PORT', '9920')),
        'dv_token': g('DV_TOKEN', ''),
        'host_port': int(g('HOST_PORT', str(hd.get('host_port', 9000)))),
        'host_token': g('HOST_TOKEN', str(hd.get('token', ''))),
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

def vm_call(action, args):
    """归一 · Proxy a multi-RDP action to the vm_host_daemon (POST / {action,...})."""
    body = dict(args or {}); body['action'] = action
    return _post_json('http://127.0.0.1:%d/' % CFG['host_port'], body, CFG['host_token'])

def dv_call(method, path, args, query_keys=None):
    """Proxy to the dao-vsix workspace API (GET/POST). query_keys move those args
    into the query string (some dao-vsix endpoints read ?path= rather than a body)."""
    args = dict(args or {})
    if query_keys:
        qs = {}
        for k in query_keys:
            if k in args and args[k] is not None:
                qs[k] = args.pop(k)
        if qs:
            path = path + ('&' if '?' in path else '?') + urllib.parse.urlencode(qs)
    url = 'http://127.0.0.1:%d%s' % (CFG['dv_port'], path)
    if method == 'GET':
        headers = {}
        if CFG['dv_token']:
            headers['Authorization'] = 'Bearer ' + CFG['dv_token']
        req = urllib.request.Request(url, method='GET', headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode() or '{}')
    return _post_json(url, args, CFG['dv_token'])

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
    # ---- 模块2 · 插件本体 / 工作区 (dao-vsix workspace API · DV_PORT) ----
    'plugin_health':       dict(kind='dv', method='GET',  path='/api/health', desc='二合一插件存活与版本。', props={}, required=[]),
    'plugin_exec':         dict(kind='dv', method='POST', path='/api/exec', desc='经二合一插件在本机集成终端执行命令并回收输出(整机核心)。', props={'cmd': {'type': S}, 'cwd': {'type': S}, 'timeout': {'type': I}}, required=['cmd']),
    'plugin_ls':           dict(kind='dv', method='GET',  path='/api/ls', query=['path'], desc='列目录(默认工作区根)。', props={'path': {'type': S}}, required=[]),
    'plugin_file_read':    dict(kind='dv', method='GET',  path='/api/file', query=['path'], desc='读取工作区内某个文件(UTF-8)。', props={'path': {'type': S}}, required=['path']),
    'plugin_file_write':   dict(kind='dv', method='POST', path='/api/write', desc='写入/覆盖一个文件。', props={'path': {'type': S}, 'content': {'type': S}}, required=['path', 'content']),
    'plugin_edit':         dict(kind='dv', method='POST', path='/api/edit', desc='对一个文件应用范围替换 edits=[{startLine,startChar,endLine,endChar,newText}]。', props={'file': {'type': S}, 'edits': {'type': 'array'}}, required=['file', 'edits']),
    'plugin_search':       dict(kind='dv', method='POST', path='/api/search', desc='按 glob 搜索工作区文件。', props={'pattern': {'type': S}, 'exclude': {'type': S}, 'maxResults': {'type': I}}, required=[]),
    'plugin_terminal_create': dict(kind='dv', method='POST', path='/api/terminal/create', desc='新建一个集成终端, 返回 terminalId。', props={'name': {'type': S}, 'cwd': {'type': S}}, required=[]),
    'plugin_terminal_send':   dict(kind='dv', method='POST', path='/api/terminal/send', desc='向指定(或活动)终端发送一行文本。', props={'terminalId': {'type': S}, 'text': {'type': S}}, required=['text']),
    'plugin_git_status':   dict(kind='dv', method='GET',  path='/api/git/status', desc='当前 git 仓库状态(分支/领先落后/改动数)。', props={}, required=[]),
    'plugin_tools':        dict(kind='dv', method='POST', path='/api/tools', desc='调用插件内置工具桥 (tool/args)。', props={'tool': {'type': S}, 'args': {'type': 'object'}}, required=['tool']),
    # ---- 模块4 · VSCode 暴露的各 API (dao-vsix workspace API · DV_PORT) ----
    'vscode_command':      dict(kind='dv', method='POST', path='/api/command', desc='执行任意一个 VS Code 命令 (command/args)。', props={'command': {'type': S}, 'args': {'type': 'array'}}, required=['command']),
    'vscode_commands':     dict(kind='dv', method='GET',  path='/api/commands', desc='列出所有可用的 VS Code 命令 id。', props={}, required=[]),
    'vscode_diagnostics':  dict(kind='dv', method='GET',  path='/api/diagnostics', desc='当前工作区诊断(错误/警告)汇总。', props={}, required=[]),
    'vscode_definitions':  dict(kind='dv', method='POST', path='/api/definitions', desc='求某位置符号的定义处。', props={'file': {'type': S}, 'line': {'type': I}, 'char': {'type': I}}, required=['file', 'line', 'char']),
    'vscode_references':   dict(kind='dv', method='POST', path='/api/references', desc='求某位置符号的引用处。', props={'file': {'type': S}, 'line': {'type': I}, 'char': {'type': I}}, required=['file', 'line', 'char']),
    'vscode_symbols':      dict(kind='dv', method='POST', path='/api/symbols', desc='按名称搜索工作区符号。', props={'query': {'type': S}}, required=['query']),
    # ---- 模块5 · Windows 多 RDP (vm_host_daemon · HOST_PORT) · 归一并入综合 MCP ----
    #   每账号一台隔离 RDP 会话(创建/接管/销毁/快照) + 会话内整机操作面(与 pc_* 同构, 但带 vm 目标)。
    'vm_create':       dict(kind='vm', action='vm.create',  desc='Create/ensure an RDP VM (account+session+inner agent).', props={'vm': {'type': S}}, required=['vm']),
    'vm_attach':       dict(kind='vm', action='vm.attach',  desc='Attach to an ALREADY-logged-in account (existing RDP session); no password change.', props={'vm': {'type': S}}, required=['vm']),
    'vm_destroy':      dict(kind='vm', action='vm.destroy', desc='Logoff + delete a CREATED VM account/profile (attached accounts only detached).', props={'vm': {'type': S}}, required=['vm']),
    'vm_list':         dict(kind='vm', action='vm.list',    desc='List all VMs and live sessions.', props={}, required=[]),
    'vm_sessions':     dict(kind='vm', action='vm.sessions',desc='List Windows sessions (quser) on the host.', props={}, required=[]),
    'vm_exec':         dict(kind='vm', action='vm.exec',    desc='Run a shell command inside the VM and wait for output.', props={'vm': {'type': S}, 'command': {'type': S}}, required=['vm', 'command']),
    'vm_launch':       dict(kind='vm', action='vm.launch',  desc='Launch a GUI app / detached process inside the VM (non-blocking).', props={'vm': {'type': S}, 'command': {'type': S}}, required=['vm', 'command']),
    'vm_screenshot':   dict(kind='vm', action='vm.screenshot', desc='Capture the VM desktop as PNG.', props={'vm': {'type': S}}, required=['vm']),
    'vm_desktop_info': dict(kind='vm', action='vm.desktop_info', desc='Get VM screen size + session user.', props={'vm': {'type': S}}, required=['vm']),
    'vm_click':        dict(kind='vm', action='vm.click',        desc='Left click at (x,y) in the VM.', props={'vm': {'type': S}, 'x': {'type': I}, 'y': {'type': I}}, required=['vm', 'x', 'y']),
    'vm_double_click': dict(kind='vm', action='vm.double_click', desc='Double click at (x,y) in the VM.', props={'vm': {'type': S}, 'x': {'type': I}, 'y': {'type': I}}, required=['vm', 'x', 'y']),
    'vm_right_click':  dict(kind='vm', action='vm.right_click',  desc='Right click at (x,y) in the VM.', props={'vm': {'type': S}, 'x': {'type': I}, 'y': {'type': I}}, required=['vm', 'x', 'y']),
    'vm_mouse_move':   dict(kind='vm', action='vm.mouse_move',   desc='Move mouse to (x,y) in the VM.', props={'vm': {'type': S}, 'x': {'type': I}, 'y': {'type': I}}, required=['vm', 'x', 'y']),
    'vm_drag':         dict(kind='vm', action='vm.drag',         desc='Drag from (x1,y1) to (x2,y2) in the VM.', props={'vm': {'type': S}, 'x1': {'type': I}, 'y1': {'type': I}, 'x2': {'type': I}, 'y2': {'type': I}}, required=['vm', 'x1', 'y1', 'x2', 'y2']),
    'vm_scroll':       dict(kind='vm', action='vm.scroll',       desc='Scroll wheel at (x,y) in the VM; clicks>0 up, <0 down.', props={'vm': {'type': S}, 'x': {'type': I}, 'y': {'type': I}, 'clicks': {'type': I}}, required=['vm', 'x', 'y', 'clicks']),
    'vm_type':         dict(kind='vm', action='vm.type',         desc='Type Unicode text in the VM (supports CJK).', props={'vm': {'type': S}, 'text': {'type': S}}, required=['vm', 'text']),
    'vm_key':          dict(kind='vm', action='vm.key',          desc="Press a key combo in the VM, e.g. 'ctrl+a'.", props={'vm': {'type': S}, 'key': {'type': S}}, required=['vm', 'key']),
    'vm_hold_key':     dict(kind='vm', action='vm.hold_key',     desc='Hold a key in the VM for duration seconds.', props={'vm': {'type': S}, 'key': {'type': S}, 'duration': {'type': N}}, required=['vm', 'key', 'duration']),
    'vm_file_read':    dict(kind='vm', action='vm.file_read',    desc='Read a file in the VM (returns base64).', props={'vm': {'type': S}, 'path': {'type': S}}, required=['vm', 'path']),
    'vm_file_write':   dict(kind='vm', action='vm.file_write',   desc='Write a file in the VM from base64 content.', props={'vm': {'type': S}, 'path': {'type': S}, 'content_base64': {'type': S}}, required=['vm', 'path', 'content_base64']),
    'vm_ui_info':      dict(kind='vm', action='vm.ui_info',      desc='Enumerate visible top-level windows in the VM.', props={'vm': {'type': S}}, required=['vm']),
    'vm_ui_tree':      dict(kind='vm', action='vm.ui_tree',      desc='Dump the control tree under a window in the VM (element-level grounding).', props={'vm': {'type': S}, 'title': {'type': S}, 'hwnd': {'type': I}, 'max_depth': {'type': I}}, required=['vm']),
    'vm_activate':     dict(kind='vm', action='vm.activate',     desc='Bring a window (by title substring) to foreground in the VM.', props={'vm': {'type': S}, 'title': {'type': S}}, required=['vm', 'title']),
    'vm_foreground':   dict(kind='vm', action='vm.foreground',   desc='Get the current foreground window in the VM session.', props={'vm': {'type': S}}, required=['vm']),
    'vm_browser_launch':     dict(kind='vm', action='vm.browser_launch',     desc='Launch/ensure Chrome/Edge with CDP inside the VM; optional initial url.', props={'vm': {'type': S}, 'url': {'type': S}}, required=['vm']),
    'vm_browser_navigate':   dict(kind='vm', action='vm.browser_navigate',   desc='Navigate the VM browser to a URL (CDP).', props={'vm': {'type': S}, 'url': {'type': S}}, required=['vm', 'url']),
    'vm_browser_eval':       dict(kind='vm', action='vm.browser_eval',       desc='Evaluate JavaScript in the VM browser page (CDP).', props={'vm': {'type': S}, 'expression': {'type': S}}, required=['vm', 'expression']),
    'vm_browser_screenshot': dict(kind='vm', action='vm.browser_screenshot', desc='Capture the VM browser page as PNG (CDP).', props={'vm': {'type': S}}, required=['vm']),
    'vm_browser_targets':    dict(kind='vm', action='vm.browser_targets',    desc='List CDP targets (open tabs) in the VM browser.', props={'vm': {'type': S}}, required=['vm']),
    'vm_snapshot':     dict(kind='vm', action='vm.snapshot',  desc='Snapshot the VM user profile (robocopy mirror). Optional tag/path.', props={'vm': {'type': S}, 'tag': {'type': S}, 'path': {'type': S}}, required=['vm']),
    'vm_restore':      dict(kind='vm', action='vm.restore',   desc='Restore a VM profile snapshot by tag.', props={'vm': {'type': S}, 'tag': {'type': S}}, required=['vm', 'tag']),
    'vm_snapshots':    dict(kind='vm', action='vm.snapshots', desc='List snapshot tags for a VM.', props={'vm': {'type': S}}, required=['vm']),
}

def tool_schema():
    out = []
    for name, t in TOOLS.items():
        out.append({'name': name, 'description': t['desc'],
                    'inputSchema': {'type': 'object', 'properties': t['props'], 'required': t['required']}})
    return out

def _img_result(res):
    meta = '%sx%s %sB %s' % (res.get('width'), res.get('height'), res.get('size'), res.get('format', 'png'))
    return {'content': [{'type': 'image', 'data': res['image_base64'], 'mimeType': 'image/png'},
                        {'type': 'text', 'text': meta}]}

def call_tool(name, args):
    t = TOOLS.get(name)
    if not t:
        return {'content': [{'type': 'text', 'text': 'unknown tool ' + str(name)}], 'isError': True}
    args = dict(args or {})
    if t['kind'] == 'pc':
        res = pc_call(t['action'], args)
        if t['action'] in ('screenshot', 'browser_screenshot') and isinstance(res, dict) and res.get('image_base64'):
            return _img_result(res)
    elif t['kind'] == 'vm':
        res = vm_call(t['action'], args)
        if t['action'] in ('vm.screenshot', 'vm.browser_screenshot') and isinstance(res, dict) and res.get('image_base64'):
            return _img_result(res)
    else:
        res = dv_call(t['method'], t['path'], args, t.get('query'))
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
    log('dao-bridge-mcp up on 127.0.0.1:%d ; tools=%d ; pc:%d dv:%d host:%d' % (CFG['port'], len(TOOLS), CFG['pc_port'], CFG['dv_port'], CFG['host_port']))
    srv.serve_forever()

if __name__ == '__main__':
    main()
