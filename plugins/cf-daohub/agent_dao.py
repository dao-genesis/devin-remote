#!/usr/bin/env python3
"""
Dao Agent Daemon — connects to hub, polls commands, executes, reports results.

Usage:
  python agent_dao.py                                         # default: localhost:9910
  python agent_dao.py --server http://192.168.31.179:9910     # remote hub via LAN
  python agent_dao.py --server https://xxx.trycloudflare.com  # remote hub via CF
  python agent_dao.py --server http://localhost:9910 --hostname MYPC

Architecture:
  Agent on target machine -> hub Server -> poll -> exec -> report
  Hub exposed via cloudflared tunnel for external clients
  LAN agents connect directly via local IP, no CF roundtrip, no 408 timeout
"""

import urllib.request, json, time, subprocess, threading, os, sys, ssl
import argparse, platform, socket, base64, tempfile

# ═══════════════════════════════════════════════════════════
# Proxy immunity — bypass system proxy
# ═══════════════════════════════════════════════════════════

def _build_opener():
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
        os.environ.pop(k, None)
    os.environ['NO_PROXY'] = '*'

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ctx),
    )
    urllib.request.install_opener(opener)
    return opener

# ═══════════════════════════════════════════════════════════
# API calls
# ═══════════════════════════════════════════════════════════

SERVER = ''  # set by main()

def api(method, path, data=None, timeout=30):
    url = SERVER + path
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body,
        headers={'Content-Type': 'application/json'} if body else {},
        method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except Exception as e:
        return {'error': str(e)}

# ═══════════════════════════════════════════════════════════
# Agent main loop
# ═══════════════════════════════════════════════════════════

def main():
    global SERVER

    parser = argparse.ArgumentParser(description='Dao Agent Daemon')
    parser.add_argument('--server', default='http://localhost:9910',
                        help='Hub URL, default http://localhost:9910')
    parser.add_argument('--hostname', default=platform.node(),
                        help='Agent hostname, auto-detected if omitted')
    args = parser.parse_args()

    SERVER = args.server.rstrip('/')
    hostname = args.hostname.upper()

    _build_opener()

    # ── Register ──
    sysinfo = {
        'hostname': hostname,
        'username': os.environ.get('USERNAME', '?'),
        'os_version': f'{platform.system()} {platform.release()}',
        'agent_version': 'dao-2.0',
        'local_ip': socket.gethostbyname(socket.gethostname()),
    }
    print(f'[agent] Register: {hostname} -> {SERVER}')
    reg = api('POST', '/api/connect', {'sysinfo': sysinfo})
    if 'error' in reg:
        print(f'[agent] Register failed: {reg["error"]}')
        sys.exit(1)

    agent_id = reg['agent_id']
    token = reg['token']
    print(f'[agent] Registered: {agent_id}  token={token[:12]}...')

    # ── Heartbeat ──
    def heartbeat():
        while True:
            try:
                api('POST', '/api/heartbeat',
                    {'agent_id': agent_id, 'token': token}, timeout=10)
            except:
                pass
            time.sleep(25)

    threading.Thread(target=heartbeat, daemon=True).start()

    # ── Poll loop ──
    n = 0
    print(f'[agent] Entering poll loop...')
    while True:
        try:
            resp = api('GET',
                f'/api/poll?id={agent_id}&token={token}&timeout=30',
                timeout=35)
            for cmd in resp.get('commands', []):
                n += 1
                cid = cmd.get('cmd_id', '')
                ctype = cmd.get('type', 'shell')
                payload = cmd.get('payload', {})
                print(f'[{n}] {ctype}:{cid[:20]}', end=' ', flush=True)

                result = _execute(ctype, payload)
                api('POST', '/api/result', {
                    'agent_id': agent_id, 'token': token,
                    'cmd_id': cid, 'result': result
                }, timeout=20)
                print(f'exit={result.get("exit_code", "?")}')
        except Exception as e:
            print(f'[agent] Poll error: {e}')
            time.sleep(5)

# ═══════════════════════════════════════════════════════════
# Command execution
# ═══════════════════════════════════════════════════════════

def _execute(ctype, payload):
    try:
        if ctype == 'shell':
            proc = subprocess.run(
                payload.get('command', ''),
                shell=True, capture_output=True, text=True, timeout=300)
            return {
                'stdout': proc.stdout[:500000],
                'stderr': proc.stderr[:200000],
                'exit_code': proc.returncode,
            }
        elif ctype == 'screenshot':
            return _screenshot()
        elif ctype == 'sysinfo':
            proc = subprocess.run('systeminfo', shell=True,
                capture_output=True, text=True, timeout=30)
            return {
                'stdout': proc.stdout[:100000],
                'stderr': proc.stderr,
                'exit_code': proc.returncode,
            }
        elif ctype == 'file_read':
            fp = payload.get('path', '')
            if os.path.isfile(fp):
                with open(fp, 'rb') as f:
                    return {
                        'content_base64': base64.b64encode(f.read()).decode(),
                        'filename': os.path.basename(fp),
                    }
            return {'error': f'file not found: {fp}'}
        elif ctype == 'file_write':
            fp = payload.get('path', '')
            data_b64 = payload.get('content_base64', '')
            os.makedirs(os.path.dirname(fp) or '.', exist_ok=True)
            raw = base64.b64decode(data_b64)
            with open(fp, 'wb') as f:
                f.write(raw)
            return {'written': fp, 'size': len(raw)}
        else:
            return {'error': f'unsupported type: {ctype}', 'exit_code': -1}
    except subprocess.TimeoutExpired:
        return {'error': 'timeout (300s)', 'exit_code': -1}
    except Exception as e:
        return {'error': str(e), 'exit_code': -1}

def _screenshot():
    tmp = tempfile.mktemp(suffix='.png')
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
        "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);"
        "$g=[System.Drawing.Graphics]::FromImage($bmp);"
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);"
        f"$bmp.Save('{tmp}');$g.Dispose();$bmp.Dispose()"
    )
    subprocess.run(['powershell', '-Command', ps],
        capture_output=True, timeout=30)
    if os.path.exists(tmp):
        with open(tmp, 'rb') as f:
            data = base64.b64encode(f.read()).decode()
        os.unlink(tmp)
        return {'screenshot_base64': data, 'format': 'png'}
    return {'error': 'screenshot failed'}

if __name__ == '__main__':
    main()
