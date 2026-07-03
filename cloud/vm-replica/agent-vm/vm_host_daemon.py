r"""vm_host_daemon.py (v3) - Host daemon managing RDP "VM" sessions.

Runs as Administrator in the INTERACTIVE console session (so mstsc can render the
RDP windows). Exposes a REST API to manage account-backed "VMs" and proxies every
operation to the per-session inner agents.

v3 additions over v2:
  * Stealth/Silent mode — zero-footprint when idle, system fully invisible to user:
    - Idle detection watchdog: auto-hibernate after configurable inactivity timeout
    - Graceful shutdown: logoff RDP sessions, kill mstsc, stop inner agents, revert
      termsrv.dll patches, clean temp files. User's admin desktop pristine.
    - On-demand cold restart: one API call wakes the full stack back up.
    - System tray / process visibility: zero stray windows, zero tray icons.
  * Universal Windows adaptation: auto-detect edition (Home/Pro/Enterprise/Server),
    version (Win10/11 builds), and adapt ts_multifix strategy accordingly.
  * Host-level lifecycle: hibernate / wake / stealth_status / cleanup commands.

Lifecycle endpoints : vm.create / vm.ensure / vm.destroy / vm.list / vm.sessions
Stealth endpoints   : host.hibernate / host.wake / host.stealth_status / host.cleanup
Proxy endpoints     : vm.exec / vm.screenshot / vm.click / vm.double_click /
                      vm.right_click / vm.mouse_move / vm.drag / vm.scroll /
                      vm.type / vm.key / vm.hold_key / vm.file_read / vm.file_write /
                      vm.file_append / vm.ui_info / vm.desktop_info

Improvements vs v1: token auth, 127.0.0.1 bind, token propagated to inner agents,
config persisted to C:\ProgramData\dao_vm\config.json, idempotent ensure(), and
robust connect via cmdkey + mstsc.
"""
import http.server, json, subprocess, os, sys, time, threading, secrets
import traceback, urllib.request, socketserver, base64, ctypes, logging

CONFIG_DIR  = r'C:\ProgramData\dao_vm'
CONFIG_PATH = os.path.join(CONFIG_DIR, 'config.json')
STEALTH_LOG = os.path.join(CONFIG_DIR, 'stealth.log')

logging.basicConfig(level=logging.INFO, format='[host %(asctime)s] %(message)s',
                    datefmt='%H:%M:%S')
log = logging.getLogger('host')

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
    # Stealth mode configuration
    cfg.setdefault('stealth_idle_timeout', 300)   # seconds of inactivity before auto-hibernate
    cfg.setdefault('stealth_auto', False)          # auto-hibernate when idle (opt-in)
    cfg.setdefault('cleanup_temp_on_hibernate', True)
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

# ====== Stealth / Silent mode state ======
_stealth_state = {
    'mode': 'active',          # active | hibernating
    'last_api_call': time.time(),
    'hibernate_time': None,
    'created_accounts': set(),  # accounts WE created (not attached)
}

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
    (un-minimize + offscreen). Keeps the VM continuously operable without manual steps.
    Skipped when in stealth/hibernate mode (zero visible activity)."""
    interval = int(CFG.get('keepalive_secs', 5))
    while True:
        if _stealth_state['mode'] == 'active':
            try: ensure_rdp_active(RDP_TARGET, offscreen=True)
            except Exception: pass
        time.sleep(interval)

def _idle_watchdog():
    """Auto-hibernate when no API calls received for stealth_idle_timeout seconds.
    Only active when stealth_auto=True. Checks every 30s."""
    while True:
        time.sleep(30)
        if not CFG.get('stealth_auto'):
            continue
        if _stealth_state['mode'] != 'active':
            continue
        if not vms:
            continue  # nothing to hibernate
        idle = time.time() - _stealth_state['last_api_call']
        timeout = CFG.get('stealth_idle_timeout', 300)
        if idle >= timeout:
            log.info('idle %.0fs >= %ds, auto-hibernating', idle, timeout)
            try: hibernate()
            except Exception as e: log.warning('auto-hibernate failed: %s', e)

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
    # Self-heal: make sure concurrent multi-session is enabled on the live TermService
    # (e.g. if it was restarted since daemon start). Idempotent + boot-safe.
    ensure_multisession()
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
    _stealth_state['created_accounts'].add(name)

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
        ps_run(f"Unregister-ScheduledTask -TaskName 'dao_agent_{name}' -Confirm:$false -ErrorAction SilentlyContinue; "
               f"Remove-Item 'C:\\dao_vm\\start_{name}.bat' -Force -ErrorAction SilentlyContinue")
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
               f"Remove-Item 'C:\\dao_vm\\start_{name}.bat' -Force -ErrorAction SilentlyContinue; "
               f"Get-CimInstance Win32_UserProfile | Where-Object {{ $_.LocalPath -like '*\\{name}*' }} | Remove-CimInstance -ErrorAction SilentlyContinue")
    vms.pop(name, None)
    _stealth_state['created_accounts'].discard(name)
    return {'ok': True, 'name': name, 'destroyed': True}


# ====== Stealth / Silent Mode (太上下知有之) ======
#
# Core principle: when the system is not actively being used, it must produce ZERO
# side effects on the user's normal workflow. All RDP windows, daemon processes,
# inner agents, and termsrv.dll patches are gracefully shut down. The user's
# administrator console session remains completely untouched. On-demand, one API
# call wakes everything back up.
#
# States: active → hibernating → active (on wake)
# Transition: hibernate() tears down all created VMs, closes mstsc, reverts
#   termsrv patch, cleans temp files. wake() re-enables multi-session and is
#   ready for vm.create. The daemon itself stays running (lightweight, invisible)
#   to accept the wake command.

# Language-neutral edition classification by numeric OperatingSystemSKU
# (Win32_OperatingSystem.OperatingSystemSKU == PRODUCT_* from GetProductInfo).
# Caption is localized (e.g. Chinese "教育版"), so NEVER classify by caption text.
_SKU_HOME = {98, 99, 100, 101}                       # Core / CoreN / CoreCountrySpecific / CoreSingleLanguage
_SKU_PRO  = {48, 49, 69, 103, 161, 162}              # Professional / N / SNGL / WMC / ForWorkstations(+N)
_SKU_EDU  = {121, 122}                                # Education / EducationN
_SKU_ENT  = {4, 27, 70, 72, 84, 135, 175, 191, 407, 408, 409, 410}  # Enterprise family + multi-session(135)
_SKU_LTSC = {125, 126, 133, 134, 175, 183, 184}      # Enterprise LTSB/LTSC (S) + IoT Enterprise LTSC

def _os_edition():
    """Detect Windows edition language-neutrally via OperatingSystemSKU + ProductType.
    Returns edition (caption, display-only), version, build, sku, and boolean class flags.
    Robust across localized (non-English) Windows where the caption is translated."""
    try:
        out, _, _ = ps_run(
            "$os = Get-CimInstance Win32_OperatingSystem; "
            "[pscustomobject]@{edition=$os.Caption;version=$os.Version;build=$os.BuildNumber;"
            "sku=[int]$os.OperatingSystemSKU;ptype=[int]$os.ProductType} | ConvertTo-Json -Compress",
            timeout=15)
        d = json.loads(out.strip().splitlines()[-1])
        cap = d.get('edition', '') or ''
        sku = d.get('sku')
        ptype = d.get('ptype')            # 1=Workstation, 2=DomainController, 3=Server
        capl = cap.lower()
        is_server = (ptype in (2, 3)) or ('server' in capl)
        is_home = (sku in _SKU_HOME)
        is_edu = (sku in _SKU_EDU)
        is_pro = (sku in _SKU_PRO)
        is_ent = (sku in _SKU_ENT) or is_edu   # Education is Enterprise-class for RDP/multi-session
        is_ltsc = (sku in _SKU_LTSC)
        # Fallback to caption substrings only if SKU is unknown/None (keeps old behavior working)
        if sku is None or not (is_home or is_pro or is_ent or is_server):
            is_server = is_server or ('server' in capl)
            is_home = is_home or ('home' in capl)
            is_pro = is_pro or ('pro' in capl and 'home' not in capl)
            is_ent = is_ent or ('enterprise' in capl) or ('education' in capl) or ('教育' in cap) or ('企业' in cap)
            is_ltsc = is_ltsc or ('ltsc' in capl) or ('ltsb' in capl)
            is_home = is_home or ('家庭' in cap)
            is_pro = is_pro or ('专业' in cap)
        return {
            'edition': cap, 'version': d.get('version', ''), 'build': d.get('build', ''),
            'sku': sku, 'product_type': ptype,
            'is_server': is_server, 'is_home': is_home, 'is_pro': is_pro,
            'is_enterprise': is_ent, 'is_education': is_edu, 'is_ltsc': is_ltsc,
        }
    except Exception as e:
        return {'edition': 'unknown', 'error': str(e)}

def _kill_all_mstsc():
    """Kill all mstsc.exe processes (RDP client windows). Safe: only affects
    loopback RDP sessions WE created, not user's remote connections.
    Selectively kills only mstsc windows targeting our RDP_TARGET."""
    try:
        u = ctypes.windll.user32
        EnumProc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        targets = []
        def cb(h, _):
            n = u.GetWindowTextLengthW(h)
            if n > 0:
                b = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(h, b, n + 1)
                cls = ctypes.create_unicode_buffer(256)
                u.GetClassNameW(h, cls, 256)
                if 'TscShellContainerClass' in cls.value and RDP_TARGET in b.value:
                    pid = ctypes.c_ulong(0)
                    u.GetWindowThreadProcessId(h, ctypes.byref(pid))
                    targets.append(pid.value)
            return 1
        u.EnumWindows(EnumProc(cb), 0)
        killed = 0
        for pid in set(targets):
            try:
                ps_run(f'Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue', timeout=10)
                killed += 1
            except Exception:
                pass
        return {'killed': killed, 'pids': list(set(targets))}
    except Exception as e:
        return {'error': str(e)}

def _cleanup_temp_files():
    """Remove temporary files created by the VM system in C:\\dao_vm\\.
    Preserves config files and scripts needed for restart."""
    cleaned = []
    keep = {'config.json', 'vm_inner_agent.py', 'dao_inner_agent.exe',
            'vm_host_daemon.py', 'ts_multifix.py', 'stealth.log'}
    dao_vm = r'C:\dao_vm'
    if os.path.isdir(dao_vm):
        for f in os.listdir(dao_vm):
            fp = os.path.join(dao_vm, f)
            if f in keep or not os.path.isfile(fp):
                continue
            # Only clean start_*.bat launchers and snapshot leftovers
            if f.startswith('start_') and f.endswith('.bat'):
                try: os.remove(fp); cleaned.append(f)
                except Exception: pass
    return cleaned

def _unregister_all_agent_tasks():
    """Unregister all dao_agent_* scheduled tasks."""
    ps_run("Get-ScheduledTask | Where-Object {$_.TaskName -like 'dao_agent_*'} | "
           "Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue",
           timeout=20)

def _revert_multisession():
    """Revert in-memory termsrv.dll patches (return to native single-session).
    This is a clean revert — a service restart also achieves the same."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import ts_multifix
        return ts_multifix.revert()
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def hibernate():
    """Gracefully shut down all VM activity → zero footprint (太上下知有之).
    The host daemon stays running (invisible, minimal CPU) to accept wake().
    Steps:
      1. Logoff all CREATED VM accounts (not attached user sessions)
      2. Kill mstsc windows for our RDP target
      3. Unregister scheduled tasks for inner agents
      4. Revert termsrv.dll multi-session patch
      5. Clean temporary files (opt-in)
      6. Clear stored credential cache
    """
    if _stealth_state['mode'] == 'hibernating':
        return {'ok': True, 'mode': 'hibernating', 'note': 'already hibernating'}

    log.info('hibernating: shutting down all VMs')
    results = {'destroyed': [], 'detached': [], 'errors': []}

    # 1. Destroy created VMs, detach attached ones
    for name in list(vms.keys()):
        try:
            if vms[name].get('attached'):
                r = destroy_vm(name)  # detach only
                results['detached'].append(name)
            else:
                r = destroy_vm(name, delete_user=True)
                results['destroyed'].append(name)
        except Exception as e:
            results['errors'].append(f'{name}: {e}')

    # 2. Kill remaining mstsc windows for our target
    mstsc = _kill_all_mstsc()
    results['mstsc'] = mstsc

    # 3. Unregister all agent tasks
    _unregister_all_agent_tasks()

    # 4. Revert termsrv.dll patch
    revert = _revert_multisession()
    results['termsrv_revert'] = revert

    # 5. Clean temp files
    if CFG.get('cleanup_temp_on_hibernate', True):
        results['cleaned'] = _cleanup_temp_files()

    # 6. Clear stored credentials for our RDP target
    ps_run(f"cmdkey /delete:TERMSRV/{RDP_TARGET} 2>$null", timeout=10)

    _stealth_state['mode'] = 'hibernating'
    _stealth_state['hibernate_time'] = time.strftime('%Y-%m-%d %H:%M:%S')
    log.info('hibernate complete: %s', results)
    return {'ok': True, 'mode': 'hibernating', **results}

def wake():
    """Wake from hibernate: re-enable multi-session, ready for vm.create.
    Does NOT auto-create any VMs — the caller decides what to spin up."""
    if _stealth_state['mode'] == 'active':
        return {'ok': True, 'mode': 'active', 'note': 'already active'}

    log.info('waking from hibernate')
    # Re-enable multi-session
    ms = ensure_multisession()
    deploy_inner_script()

    _stealth_state['mode'] = 'active'
    _stealth_state['last_api_call'] = time.time()
    _stealth_state['hibernate_time'] = None
    log.info('wake complete: multisession=%s', ms)
    return {'ok': True, 'mode': 'active', 'multisession': ms}

def stealth_status():
    """Current stealth state + system footprint report."""
    # Count our processes
    mstsc_count = 0
    try:
        out, _, _ = ps_run("(Get-Process mstsc -ErrorAction SilentlyContinue).Count", timeout=10)
        mstsc_count = int(out.strip() or '0')
    except Exception:
        pass

    # Check for stray dao_agent tasks
    tasks = []
    try:
        out, _, _ = ps_run(
            "Get-ScheduledTask | Where-Object {$_.TaskName -like 'dao_agent_*'} | "
            "Select-Object TaskName,State | ConvertTo-Json -Compress", timeout=15)
        t = json.loads(out.strip() or '[]')
        tasks = t if isinstance(t, list) else [t] if t else []
    except Exception:
        pass

    edition = _os_edition()
    sessions = get_sessions()

    return {
        'ok': True,
        'mode': _stealth_state['mode'],
        'hibernate_time': _stealth_state['hibernate_time'],
        'idle_seconds': round(time.time() - _stealth_state['last_api_call']),
        'stealth_auto': CFG.get('stealth_auto', False),
        'stealth_idle_timeout': CFG.get('stealth_idle_timeout', 300),
        'active_vms': len(vms),
        'vm_names': list(vms.keys()),
        'mstsc_windows': mstsc_count,
        'agent_tasks': tasks,
        'os': edition,
        'sessions': sessions,
        'footprint': 'zero' if (_stealth_state['mode'] == 'hibernating'
                                and mstsc_count == 0 and not tasks) else 'non-zero',
    }

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

SNAP_ROOT = r'C:\dao_vm\snapshots'

def _vm_profile(name):
    return os.path.join(r'C:\Users', name)

def snapshot_vm(name, tag=None, path=None):
    """Profile-level snapshot (Devin blueprint/snapshot analog). robocopy /B (backup
    mode, admin) mirrors even locked files; best on a logged-off VM but works live."""
    if not name:
        return {'error': 'name required'}
    tag = (tag or time.strftime('%Y%m%d-%H%M%S')).replace(' ', '_').replace(':', '')
    src = path or _vm_profile(name)
    dst = os.path.join(SNAP_ROOT, name, tag)
    ps = (f"$ErrorActionPreference='SilentlyContinue';"
          f"New-Item -ItemType Directory -Path '{dst}' -Force | Out-Null;"
          f"robocopy '{src}' '{dst}' /MIR /B /XJ /R:1 /W:1 /NFL /NDL /NP /NJH /NS /NC | Out-Null;"
          f"$rc=$LASTEXITCODE;"
          f"$m=Get-ChildItem -Path '{dst}' -Recurse -File -Force | Measure-Object -Property Length -Sum;"
          f"[pscustomobject]@{{rc=$rc;files=[int]$m.Count;bytes=[int64]$m.Sum}} | ConvertTo-Json -Compress")
    out, err, _ = ps_run(ps, timeout=600)
    try:
        d = json.loads(out.strip().splitlines()[-1])
    except Exception:
        return {'ok': False, 'error': 'snapshot failed', 'raw': out[:400], 'stderr': err[:400]}
    return {'ok': d.get('rc', 16) < 8, 'name': name, 'tag': tag, 'src': src, 'dst': dst,
            'rc': d.get('rc'), 'files': d.get('files'), 'bytes': d.get('bytes')}

def restore_vm(name, tag, path=None):
    if not (name and tag):
        return {'error': 'name and tag required'}
    src = os.path.join(SNAP_ROOT, name, tag)
    if not os.path.isdir(src):
        return {'ok': False, 'error': 'no such snapshot', 'name': name, 'tag': tag}
    dst = path or _vm_profile(name)
    ps = (f"robocopy '{src}' '{dst}' /MIR /B /XJ /R:1 /W:1 /NFL /NDL /NP /NJH /NS /NC | Out-Null;"
          f"$LASTEXITCODE")
    out, err, _ = ps_run(ps, timeout=600)
    try:
        rc = int(out.strip().splitlines()[-1])
    except Exception:
        rc = 16
    return {'ok': rc < 8, 'rc': rc, 'name': name, 'tag': tag, 'restored_to': dst,
            'stderr': err[:400] if rc >= 8 else None}

def list_snapshots(name):
    root = os.path.join(SNAP_ROOT, name)
    snaps = sorted(os.listdir(root)) if os.path.isdir(root) else []
    return {'ok': True, 'name': name, 'snapshots': snaps}

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
            _stealth_state['last_api_call'] = time.time()
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            action = body.get('action', '')
            # In hibernate mode, only allow wake/status/stealth commands
            if (_stealth_state['mode'] == 'hibernating'
                    and action not in ('host.wake', 'host.stealth_status',
                                       'host.stealth_config', 'host.health',
                                       'host.os_info', 'host.cleanup')):
                return self._respond(
                    {'error': 'system hibernating — call host.wake first',
                     'mode': 'hibernating',
                     'hibernate_time': _stealth_state['hibernate_time']}, 503)
            self._respond(self._dispatch(action, body))
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
        if action == 'host.multisession':
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import ts_multifix
                return ts_multifix.status()
            except Exception as e:
                return {'ok': False, 'error': str(e)}
        if action == 'host.enable_multisession':
            return ensure_multisession()
        # ── Stealth / Silent mode (太上下知有之) ──
        if action == 'host.hibernate':
            return hibernate()
        if action == 'host.wake':
            return wake()
        if action == 'host.stealth_status':
            return stealth_status()
        if action == 'host.stealth_config':
            # Update stealth config dynamically
            for k in ('stealth_auto', 'stealth_idle_timeout', 'cleanup_temp_on_hibernate'):
                if k in body:
                    CFG[k] = body[k]
            json.dump(CFG, open(CONFIG_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
            return {'ok': True, 'config': {k: CFG.get(k) for k in
                    ('stealth_auto', 'stealth_idle_timeout', 'cleanup_temp_on_hibernate')}}
        if action == 'host.cleanup':
            cleaned = _cleanup_temp_files()
            return {'ok': True, 'cleaned': cleaned}
        if action == 'host.os_info':
            return _os_edition()
        if action == 'vm.snapshot':
            return snapshot_vm(body.get('name', body.get('vm', '')), body.get('tag'), body.get('path'))
        if action == 'vm.restore':
            return restore_vm(body.get('name', body.get('vm', '')), body.get('tag', ''), body.get('path'))
        if action == 'vm.snapshots':
            return list_snapshots(body.get('name', body.get('vm', '')))
        if action.startswith('vm.'):
            name = body.get('vm', body.get('name', ''))
            inner = dict(body); inner['action'] = action.replace('vm.', '', 1)
            inner.pop('vm', None); inner.pop('name', None)
            return proxy(name, inner)
        return {'error': f'unknown action: {action}'}

class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True; daemon_threads = True

def ensure_multisession():
    """Enable concurrent multi-session on the live TermService (boot-safe, in-memory).
    Required so vm.create can open more than one RDP session on a client SKU. No-op on
    unsupported builds; never fatal. Mirrors the repo doctrine: never hang rdpwrap as
    ServiceDll, apply on demand instead."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import ts_multifix
        r = ts_multifix.ensure_multisession()
        print(f'[host] multi-session: {r}')
        return r
    except Exception as e:
        print(f'[host] multi-session enable skipped: {e}')
        return {'ok': False, 'error': str(e)}


def main():
    # Wu Wei: boot DORMANT. Do NOT patch termsrv at startup — that would leave a
    # non-zero footprint while idle. Multi-session is enabled lazily on the first
    # vm.create / host.wake (both call ensure_multisession). The control plane
    # itself is invisible (127.0.0.1 socket, no window, no tray).
    # Auto-attach any inner agents already alive on base_port..+10
    for i in range(10):
        port = BASE_PORT + i
        h = inner_health(port)
        if h:
            user = h.get('user', f'vm{i+1:02d}')
            vms[user.lower()] = {'port': port, 'status': 'running',
                                 'created_at': 'pre-existing', 'password': DEFAULT_PW,
                                 'session_user': user}
            log.info('attached existing agent %s on :%d', user, port)
    if CFG.get('keepalive', True):
        threading.Thread(target=_keepalive_loop, daemon=True).start()
        log.info('rdp keepalive watchdog on for %s', RDP_TARGET)
    # Idle watchdog for auto-hibernate (stealth_auto mode)
    threading.Thread(target=_idle_watchdog, daemon=True).start()
    edition = _os_edition()
    log.info('os: %s', edition.get('edition', 'unknown'))
    srv = ThreadedServer(('127.0.0.1', PORT), HostHandler)
    log.info('vm_host_daemon v3 listening on 127.0.0.1:%d (token=%s, stealth_auto=%s)',
             PORT, 'on' if TOKEN else 'off', CFG.get('stealth_auto'))
    sys.stdout.flush()
    srv.serve_forever()

if __name__ == '__main__':
    main()
