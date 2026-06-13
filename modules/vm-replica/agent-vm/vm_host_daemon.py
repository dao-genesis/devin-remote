r"""vm_host_daemon.py (v2) - Host daemon managing RDP "VM" sessions.

Runs as Administrator in the INTERACTIVE console session (so mstsc can render the
RDP windows). Exposes a REST API to manage account-backed "VMs" and proxies every
operation to the per-session inner agents.

Lifecycle endpoints : vm.create / vm.ensure / vm.destroy / vm.list / vm.sessions
Proxy endpoints     : vm.exec / vm.screenshot / vm.click / vm.double_click /
                      vm.right_click / vm.mouse_move / vm.drag / vm.scroll /
                      vm.type / vm.key / vm.hold_key / vm.file_read / vm.file_write /
                      vm.file_append / vm.ui_info / vm.desktop_info

Improvements vs v1: token auth, 127.0.0.1 bind, token propagated to inner agents,
config persisted to C:\ProgramData\dao_vm\config.json, idempotent ensure(), and
robust connect via cmdkey + mstsc.
"""
import http.server, json, subprocess, os, sys, time, threading, secrets
import traceback, urllib.request, socketserver, base64, ctypes

CONFIG_DIR  = r'C:\ProgramData\dao_vm'
CONFIG_PATH = os.path.join(CONFIG_DIR, 'config.json')

def load_config():
    os.makedirs(CONFIG_DIR, exist_ok=True)
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try: cfg = json.load(open(CONFIG_PATH, encoding='utf-8'))
        except Exception: cfg = {}
    cfg.setdefault('host_port', int(os.environ.get('VM_HOST_PORT', '9000')))
    cfg.setdefault('base_port', 9001)
    cfg.setdefault('token', os.environ.get('VM_HOST_TOKEN', '') or secrets.token_hex(16))
    cfg.setdefault('python_exe', sys.executable or r'C:\devin\python\python.exe')
    cfg.setdefault('inner_script', r'C:\dao_vm\vm_inner_agent.py')
    cfg.setdefault('inner_exe', r'C:\dao_vm\dao_inner_agent.exe')
    cfg.setdefault('rdp_target', '127.0.0.2')
    cfg.setdefault('default_password', 'Vm@2026dao!')
    json.dump(cfg, open(CONFIG_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    return cfg

CFG = load_config()
PORT        = CFG['host_port']
TOKEN       = CFG['token']
BASE_PORT   = CFG['base_port']
PYTHON_EXE  = CFG['python_exe']
INNER_SCRIPT= CFG['inner_script']
INNER_EXE   = CFG['inner_exe']
RDP_TARGET  = CFG['rdp_target']
DEFAULT_PW  = CFG['default_password']

def ensure_rdp_active(target=None, offscreen=True):
    """Keep the loopback RDP "VM" operable exactly like Devin's own VM.

    A minimized mstsc client makes Windows SUPPRESS the session's graphics AND drop
    its active input desktop (GetForegroundWindow -> 0), which black-frames BitBlt and
    silently swallows SendInput. We therefore ensure the mstsc window for <target> is
    NOT minimized so the session stays active; and (offscreen) move it off the visible
    work area so it never clutters / disturbs the administrator desktop. We never steal
    foreground (SWP_NOACTIVATE), so the admin's active window is untouched. Runs in the
    host's interactive console session (session 1) where mstsc lives."""
    target = target or RDP_TARGET
    try:
        u = ctypes.windll.user32
        EnumProc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        def _title(h):
            n = u.GetWindowTextLengthW(h)
            if n <= 0: return ''
            b = ctypes.create_unicode_buffer(n + 1); u.GetWindowTextW(h, b, n + 1); return b.value
        def _cls(h):
            b = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, b, 256); return b.value
        # Manage EVERY mstsc window for <target>: with multiple concurrent VMs they all
        # connect to the same loopback target, so each VM has its own client window and
        # each must be kept un-suppressed (otherwise only one session stays operable).
        found = []
        def cb(h, _):
            if 'TscShellContainerClass' in _cls(h) and target in _title(h):
                found.append({'h': int(h), 'iconic': bool(u.IsIconic(h)), 'title': _title(h)})
            return 1
        u.EnumWindows(EnumProc(cb), 0)
        if not found:
            return {'ok': False, 'error': f'no mstsc window for {target}'}
        for i, w in enumerate(found):
            h = ctypes.c_void_p(w['h'])
            if w['iconic']:
                u.ShowWindow(h, 9)   # SW_RESTORE -> un-suppress the session
            u.ShowWindow(h, 5)       # SW_SHOWNORMAL
            if offscreen:
                # SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE -> move only, keep z-order & focus.
                # Stagger x so stacked client windows don't fully overlap off-screen.
                u.SetWindowPos(h, None, -4000 - i * 120, 0, 0, 0, 0x1 | 0x4 | 0x10)
        return {'ok': True, 'managed': len(found), 'target': target, 'offscreen': offscreen,
                'windows': found}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def _keepalive_loop():
    """Optional watchdog: periodically re-assert that the target RDP session is active
    (un-minimize + offscreen). Keeps the VM continuously operable without manual steps."""
    interval = int(CFG.get('keepalive_secs', 5))
    while True:
        try: ensure_rdp_active(RDP_TARGET, offscreen=True)
        except Exception: pass
        time.sleep(interval)

def inner_launch_cmd():
    """Prefer the frozen inner-agent EXE (Python-free); else python + script."""
    if os.path.exists(INNER_EXE):
        return f'"{INNER_EXE}"'
    return f'"{PYTHON_EXE}" "{INNER_SCRIPT}"'

vms = {}  # {name: {port, status, created_at, password, session_user}}

def ps_run(script, timeout=40):
    full = "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$ProgressPreference='SilentlyContinue'\n" + script
    r = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', full],
                       capture_output=True, timeout=timeout, encoding='utf-8', errors='replace')
    return r.stdout.strip(), r.stderr.strip(), r.returncode

def inner_request(port, body, timeout=60):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(f'http://127.0.0.1:{port}/', data=data, method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {TOKEN}'})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8'))

def inner_health(port, timeout=3):
    try:
        req = urllib.request.Request(f'http://127.0.0.1:{port}/health',
                                     headers={'Authorization': f'Bearer {TOKEN}'})
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8'))
    except Exception:
        return None

def find_next_port():
    used = {v['port'] for v in vms.values()}
    p = BASE_PORT
    while p in used: p += 1
    return p

def deploy_inner_script():
    """Ensure the inner agent is reachable from C:\\dao_vm for every account.
    Prefer the bundled EXE (self-contained). Only copy the .py when running from
    source; a frozen daemon has no source .py to copy (it lives in a temp _MEI dir)."""
    os.makedirs(os.path.dirname(INNER_SCRIPT), exist_ok=True)
    if os.path.exists(INNER_EXE) or getattr(sys, 'frozen', False):
        return  # exe path is self-contained; nothing to copy
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vm_inner_agent.py')
    if os.path.abspath(src) != os.path.abspath(INNER_SCRIPT):
        import shutil; shutil.copyfile(src, INNER_SCRIPT)

def create_vm(name, password=None):
    if name in vms and inner_health(vms[name]['port']):
        return {'ok': True, 'name': name, 'port': vms[name]['port'],
                'status': 'running', 'note': 'already running'}
    deploy_inner_script()
    pw = password or DEFAULT_PW
    port = vms[name]['port'] if name in vms else find_next_port()

    s1 = f"""
$pw = ConvertTo-SecureString '{pw}' -AsPlainText -Force
$u = Get-LocalUser -Name '{name}' -ErrorAction SilentlyContinue
if (-not $u) {{ New-LocalUser -Name '{name}' -Password $pw -PasswordNeverExpires -AccountNeverExpires -Description 'DAO VM' | Out-Null }}
else {{ Set-LocalUser -Name '{name}' -Password $pw }}
$m = Get-LocalGroupMember -Group 'Remote Desktop Users' -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -like '*\\{name}' }}
if (-not $m) {{ Add-LocalGroupMember -Group 'Remote Desktop Users' -Member '{name}' -ErrorAction SilentlyContinue }}
Write-Output 'user-ok'
"""
    out, err, _ = ps_run(s1)
    if 'user-ok' not in out:
        return {'error': f'user creation failed: {out} {err}'}

    # NOTE: do NOT pre-create C:\Users\<name>; that forces the real profile to land
    # at C:\Users\<name>.<HOST>. Instead use a machine-wide launcher + scheduled task
    # bound to the user's INTERACTIVE session (profile-path independent).
    bat_path = f"C:\\dao_vm\\start_{name}.bat"
    bat = (f"@echo off\r\nset VM_AGENT_PORT={port}\r\nset VM_AGENT_TOKEN={TOKEN}\r\n"
           f"set VM_AGENT_BIND=127.0.0.1\r\n{inner_launch_cmd()}\r\n")
    bat_b64 = base64.b64encode(bat.encode('utf-8')).decode()
    ps_run(f"""
New-Item -ItemType Directory -Path 'C:\\dao_vm' -Force | Out-Null
[IO.File]::WriteAllBytes('{bat_path}', [Convert]::FromBase64String('{bat_b64}'))
# Suppress mstsc server-identity warning for unattended loopback connects
New-Item -Path 'HKCU:\\Software\\Microsoft\\Terminal Server Client' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Terminal Server Client' -Name 'AuthenticationLevelOverride' -Value 0 -PropertyType DWord -Force | Out-Null
Write-Output 'launcher-ok'
""")

    # Store credential + launch RDP from THIS (interactive) session -> creates the session.
    ps_run(f"""
cmdkey /generic:TERMSRV/{RDP_TARGET} /user:{name} /pass:'{pw}' | Out-Null
Start-Process mstsc -ArgumentList '/v:{RDP_TARGET} /w:1280 /h:800'
Write-Output 'rdp-started'
""")

    vms[name] = {'port': port, 'status': 'starting', 'password': pw,
                 'created_at': time.strftime('%Y-%m-%d %H:%M:%S')}

    def bring_up():
        # 1) wait for the RDP session to become active (first-logon profile creation)
        for _ in range(40):
            out, _, _ = ps_run("quser 2>$null")
            if any(l.split() and l.split()[0].lstrip('>').lower() == name.lower()
                   for l in out.split('\n')[1:]):
                break
            time.sleep(2)
        # 1.5) move the freshly-connected mstsc window off-screen but keep it ACTIVE
        # (un-suppressed) so screenshot/input behave like operating Devin's own VM.
        ensure_rdp_active(offscreen=True)
        # 2) register + start the inner-agent task inside the user's interactive session
        register_agent_task(name, port)
        # 3) wait for the inner agent to answer
        for _ in range(45):
            time.sleep(2)
            h = inner_health(port)
            if h and h.get('status') == 'ok':
                vms[name]['status'] = 'running'
                vms[name]['session_user'] = h.get('user', name)
                return
        vms[name]['status'] = 'timeout'
    threading.Thread(target=bring_up, daemon=True).start()
    return {'ok': True, 'name': name, 'port': port, 'status': 'starting'}

def write_launcher(name, port):
    """Write the machine-wide launcher bat + suppress mstsc cert prompt (idempotent)."""
    bat_path = f"C:\\dao_vm\\start_{name}.bat"
    bat = (f"@echo off\r\nset VM_AGENT_PORT={port}\r\nset VM_AGENT_TOKEN={TOKEN}\r\n"
           f"set VM_AGENT_BIND=127.0.0.1\r\n{inner_launch_cmd()}\r\n")
    bat_b64 = base64.b64encode(bat.encode('utf-8')).decode()
    ps_run(f"""
New-Item -ItemType Directory -Path 'C:\\dao_vm' -Force | Out-Null
[IO.File]::WriteAllBytes('{bat_path}', [Convert]::FromBase64String('{bat_b64}'))
Write-Output 'launcher-ok'
""")

def attach_vm(name):
    """Attach to an ALREADY-logged-in account (e.g. a user-opened RDP session).
    Does NOT reset the password and does NOT launch mstsc — only deploys the inner
    agent and starts it inside the account's existing interactive session."""
    if name in vms and inner_health(vms[name]['port']):
        return {'ok': True, 'name': name, 'port': vms[name]['port'],
                'status': 'running', 'note': 'already attached'}
    # require an active session for this account
    out, _, _ = ps_run("quser 2>$null")
    active = any(l.split() and l.split()[0].lstrip('>').lower() == name.lower()
                 for l in out.split('\n')[1:])
    if not active:
        return {'error': f'account {name} has no active session; open its RDP first', 'sessions': out}
    deploy_inner_script()
    # make sure the account's RDP session is ACTIVE (not minimized) so screenshot &
    # input behave exactly like operating Devin's own VM; keep it off the admin desktop.
    rdp = ensure_rdp_active(offscreen=True)
    port = vms[name]['port'] if name in vms else find_next_port()
    write_launcher(name, port)
    register_agent_task(name, port)
    vms[name] = {'port': port, 'status': 'starting', 'password': None,
                 'created_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'attached': True}
    def bring_up():
        for _ in range(45):
            time.sleep(2)
            h = inner_health(port)
            if h and h.get('status') == 'ok':
                vms[name]['status'] = 'running'
                vms[name]['session_user'] = h.get('user', name)
                return
        vms[name]['status'] = 'timeout'
    threading.Thread(target=bring_up, daemon=True).start()
    return {'ok': True, 'name': name, 'port': port, 'status': 'starting', 'attached': True}

def register_agent_task(name, port):
    """Register + start a scheduled task that runs the inner agent in <name>'s
    interactive desktop session (robust, profile-path independent)."""
    bat_path = f"C:\\dao_vm\\start_{name}.bat"
    ps = f"""
$ErrorActionPreference='Continue'
$tn = 'dao_agent_{name}'
Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue
$a = New-ScheduledTaskAction -Execute '{bat_path}'
$t = New-ScheduledTaskTrigger -AtLogOn -User '{name}'
$p = New-ScheduledTaskPrincipal -UserId '{name}' -LogonType Interactive -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)
Register-ScheduledTask -TaskName $tn -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName $tn
Write-Output 'task-ok'
"""
    return ps_run(ps)

def destroy_vm(name, delete_user=True):
    # Safety: never log off or delete an ATTACHED account (a real user-owned session).
    # Attached VMs can only be detached (inner-agent task removed), leaving the user intact.
    if vms.get(name, {}).get('attached'):
        ps_run(f"Unregister-ScheduledTask -TaskName 'dao_agent_{name}' -Confirm:$false -ErrorAction SilentlyContinue")
        vms.pop(name, None)
        return {'ok': True, 'name': name, 'detached': True,
                'note': 'attached account preserved (no logoff, no user delete)'}
    ps_run(f"""
$s = quser 2>$null | Where-Object {{ $_ -match '\\b{name}\\b' }}
if ($s) {{ $id = ($s -replace '\\s+',' ').Trim().Split(' ')[2]; logoff $id 2>$null }}
""")
    if delete_user:
        ps_run(f"Unregister-ScheduledTask -TaskName 'dao_agent_{name}' -Confirm:$false -ErrorAction SilentlyContinue; "
               f"Remove-LocalUser -Name '{name}' -ErrorAction SilentlyContinue; "
               f"Get-CimInstance Win32_UserProfile | Where-Object {{ $_.LocalPath -like '*\\{name}*' }} | Remove-CimInstance -ErrorAction SilentlyContinue")
    vms.pop(name, None)
    return {'ok': True, 'name': name, 'destroyed': True}

def get_sessions():
    out, _, _ = ps_run("quser 2>$null")
    return out

def list_vms():
    out, _, _ = ps_run("quser 2>$null")
    active = set()
    for line in out.split('\n')[1:]:
        p = line.split()
        if p: active.add(p[0].lstrip('>').lower())
    for name, info in vms.items():
        h = inner_health(info['port'])
        if h: info['status'] = 'running'
        elif name.lower() in active: info['status'] = 'session_active_agent_down'
        else: info['status'] = 'disconnected'
    return {'vms': {k: {kk: vv for kk, vv in v.items() if kk != 'password'} for k, v in vms.items()},
            'sessions': out}

def proxy(name, body):
    if name not in vms:
        # allow attach-by-port if known
        return {'error': f'VM {name} not found'}
    try:
        return inner_request(vms[name]['port'], body)
    except Exception as e:
        return {'error': f'proxy failed: {e}'}

class HostHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _auth_ok(self):
        return self.headers.get('Authorization', '') == f'Bearer {TOKEN}'
    def _respond(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == '/health':
            self._respond({'status': 'ok', 'role': 'host_daemon', 'vms': len(vms),
                           'auth': bool(TOKEN)})
        elif self.path == '/vms':
            if not self._auth_ok(): return self._respond({'error': 'unauthorized'}, 401)
            self._respond(list_vms())
        else:
            self._respond({'error': 'not found'}, 404)
    def do_POST(self):
        try:
            if not self._auth_ok(): return self._respond({'error': 'unauthorized'}, 401)
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            self._respond(self._dispatch(body.get('action', ''), body))
        except Exception as e:
            self._respond({'error': str(e), 'trace': traceback.format_exc()}, 500)
    def _dispatch(self, action, body):
        if action in ('vm.create', 'vm.ensure'):
            return create_vm(body.get('name', 'vm01'), body.get('password'))
        if action == 'vm.attach':
            return attach_vm(body.get('name', ''))
        if action == 'vm.destroy':
            return destroy_vm(body.get('name', ''), body.get('delete_user', True))
        if action == 'vm.list':
            return list_vms()
        if action == 'vm.sessions':
            return {'sessions': get_sessions()}
        if action == 'host.health':
            return {'status': 'ok', 'role': 'host_daemon'}
        if action == 'host.activate_rdp':
            return ensure_rdp_active(body.get('target'), body.get('offscreen', True))
        if action.startswith('vm.'):
            name = body.get('vm', body.get('name', ''))
            inner = dict(body); inner['action'] = action.replace('vm.', '', 1)
            inner.pop('vm', None); inner.pop('name', None)
            return proxy(name, inner)
        return {'error': f'unknown action: {action}'}

class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True; daemon_threads = True

def main():
    # Auto-attach any inner agents already alive on base_port..+10
    for i in range(10):
        port = BASE_PORT + i
        h = inner_health(port)
        if h:
            user = h.get('user', f'vm{i+1:02d}')
            vms[user.lower()] = {'port': port, 'status': 'running',
                                 'created_at': 'pre-existing', 'password': DEFAULT_PW,
                                 'session_user': user}
            print(f'[host] attached existing agent {user} on :{port}')
    if CFG.get('keepalive', True):
        threading.Thread(target=_keepalive_loop, daemon=True).start()
        print(f'[host] rdp keepalive watchdog on for {RDP_TARGET}')
    srv = ThreadedServer(('127.0.0.1', PORT), HostHandler)
    print(f'[vm_host_daemon v2] listening on 127.0.0.1:{PORT} (token={"on" if TOKEN else "off"})')
    sys.stdout.flush()
    srv.serve_forever()

if __name__ == '__main__':
    main()
