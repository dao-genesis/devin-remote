#!/usr/bin/env python3
"""
═════════════════════════════════════════════════════════════
 ☰ 道 · CF云端Agent — 天下之至柔驰骋於天下之致坚

 与cloud_agent.py完全镜像，但走Cloudflare HTTPS通道
 核心改进: 双通道自动切换 (CF优先 → 阿里云frpc备用)
 解决: Devin Cloud无法访问阿里云 → CF HTTPS全球可达

 用法:
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --health
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --agents
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --exec "hostname"
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --broadcast "hello"
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --screenshot
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --download /path/file
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --upload /local/file /remote/path
   python cf_cloud_agent.py --url https://xxx.trycloudflare.com --token dao-cf-xxx --agent
   python cf_cloud_agent.py --auto    # 自动发现CF连接字符串

 道法自然: 零配置, 双通道, 自愈, 万机归一
═════════════════════════════════════════════════════════════
"""
import sys, os, json, time, base64, argparse, subprocess, platform
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from pathlib import Path

__version__ = '4.0-cf'

# ════════════════════════════════════════════════════════════
# 道 · 双通道配置
# ════════════════════════════════════════════════════════════
DAO_HOME = Path.home() / '.dao'
CF_CONN_FILE = DAO_HOME / 'cf-hub-conn.json'
FRPC_CONN_FILE = DAO_HOME / 'hub-conn.json'

# 阿里云frpc备用URL (Devin Cloud可能无法访问, 但本地网络可以)
FRPC_FALLBACK_URLS = {
    '141': 'http://60.205.171.100:19910',
    '179': 'http://60.205.171.100:29910',
    'desktop': 'http://60.205.171.100:19910',
    'laptop': 'http://60.205.171.100:29910',
}

# ════════════════════════════════════════════════════════════
# 道 · 连接字符串自动发现
# 帛书·五十二「见小曰明·守柔曰强」— 自动发现一切
# ════════════════════════════════════════════════════════════
def auto_discover():
    """道法自然: 自动发现CF连接字符串, 优先CF, 备用frpc"""
    # 1. CF连接字符串
    if CF_CONN_FILE.exists():
        try:
            conn = json.loads(CF_CONN_FILE.read_text(encoding='utf8'))
            if conn.get('url', '').startswith('https://'):
                return conn['url'], conn.get('token', '')
        except: pass

    # 2. 环境变量
    cf_url = os.environ.get('DAO_CF_URL', '')
    cf_token = os.environ.get('PS_AGENT_MASTER_TOKEN', '')
    if cf_url.startswith('https://'):
        return cf_url, cf_token

    # 3. frpc连接字符串 (备用)
    if FRPC_CONN_FILE.exists():
        try:
            conn = json.loads(FRPC_CONN_FILE.read_text(encoding='utf8'))
            url = conn.get('url', '')
            token = conn.get('token', '')
            if url:
                return url, token
        except: pass

    # 4. frpc备用URL
    alias = os.environ.get('DAO_ALIAS', '')
    if alias in FRPC_FALLBACK_URLS:
        return FRPC_FALLBACK_URLS[alias], ''

    return None, None


def discover_all_channels():
    """发现所有可用通道, 返回 [(url, token, channel_name), ...]"""
    channels = []

    # CF通道
    if CF_CONN_FILE.exists():
        try:
            conn = json.loads(CF_CONN_FILE.read_text(encoding='utf8'))
            if conn.get('url', '').startswith('https://'):
                channels.append((conn['url'], conn.get('token', ''), 'CF-HTTPS'))
        except: pass

    # frpc通道
    if FRPC_CONN_FILE.exists():
        try:
            conn = json.loads(FRPC_CONN_FILE.read_text(encoding='utf8'))
            url = conn.get('url', '')
            if url:
                channels.append((url, conn.get('token', ''), 'FRPC-HTTP'))
        except: pass

    # frpc备用
    for alias, url in FRPC_FALLBACK_URLS.items():
        channels.append((url, '', f'FRPC-{alias}'))

    return channels


# ════════════════════════════════════════════════════════════
# 道 · HTTP客户端 — 天下之至柔驰骋於天下之致坚
# CF HTTPS: ssl_context自动处理, 无需额外配置
# ════════════════════════════════════════════════════════════
import ssl

def _ssl_context():
    """CF隧道用自签证书时需要跳过验证"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

def api_call(url, token, path, method='GET', data=None, timeout=15):
    """通用API调用 — 自动处理HTTPS/HTTP"""
    full_url = url.rstrip('/') + path
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'

    body = json.dumps(data).encode('utf8') if data else None
    req = Request(full_url, data=body, headers=headers, method=method)

    is_https = full_url.startswith('https://')
    ctx = _ssl_context() if is_https else None

    try:
        resp = urlopen(req, timeout=timeout, context=ctx)
        return json.loads(resp.read().decode('utf8'))
    except HTTPError as e:
        if e.code == 401:
            return {'error': 'unauthorized', 'hint': 'token不正确'}
        try:
            return json.loads(e.read().decode('utf8'))
        except:
            return {'error': f'HTTP {e.code}'}
    except URLError as e:
        return {'error': f'connection_failed: {e.reason}'}
    except Exception as e:
        return {'error': str(e)}


def api_call_dual(path, method='GET', data=None, timeout=15, prefer_cf=True):
    """双通道API调用 — CF优先, frpc备用, 自动切换"""
    channels = discover_all_channels()
    if not channels:
        return {'error': 'no_channels_available'}

    # 排序: CF优先
    if prefer_cf:
        channels.sort(key=lambda c: 0 if 'CF' in c[2] else 1)

    errors = []
    for url, token, channel_name in channels:
        result = api_call(url, token, path, method, data, timeout)
        if 'error' not in result:
            result['_channel'] = channel_name
            result['_url'] = url
            return result
        errors.append(f'{channel_name}: {result.get("error", "?")}')

    return {'error': 'all_channels_failed', 'details': errors}


# ════════════════════════════════════════════════════════════
# 道 · 命令实现 — 万物负阴而抱阳, 中气以为和
# ════════════════════════════════════════════════════════════

def cmd_health(url, token):
    """健康检查"""
    r = api_call(url, token, '/api/health')
    if 'error' in r:
        print(f"[!] 健康检查失败: {r['error']}")
        return False
    print(f"[✓] 中枢在线")
    print(f"    状态:     {r.get('status', '?')}")
    print(f"    在线Agent: {r.get('agents_online', 0)}")
    print(f"    运行时间: {r.get('uptime', '?')}s")
    print(f"    通道:     CF-HTTPS")
    return True


def cmd_health_dual():
    """双通道健康检查 — 同时测试CF和frpc"""
    channels = discover_all_channels()
    if not channels:
        print("[!] 无可用通道")
        return

    print("─── 双通道健康检查 ───")
    for url, token, name in channels:
        r = api_call(url, token, '/api/health', timeout=8)
        status = '✓' if r.get('status') == 'ok' else '✗'
        detail = f"agents={r.get('agents_online', '?')}" if r.get('status') == 'ok' else r.get('error', '?')
        print(f"  [{status}] {name:12s} {url[:50]:50s} {detail}")
    print()


def cmd_agents(url, token):
    """列出在线Agent"""
    r = api_call(url, token, '/api/agents')
    if 'error' in r:
        print(f"[!] 获取Agent列表失败: {r['error']}")
        return
    agents = r.get('agents', [])
    if not agents:
        print("[i] 无在线Agent")
        return
    print(f"─── 在线Agent ({len(agents)}) ───")
    for a in agents:
        status_icon = '●' if a.get('status') == 'online' else '○'
        print(f"  [{status_icon}] {a.get('id', '?'):20s} {a.get('hostname', '?'):20s} {a.get('os', '?')}")
        print(f"      IP={a.get('ip', '?')} ver={a.get('agent_version', '?')} pending={a.get('pending_commands', 0)}")


def cmd_exec(url, token, command, agent_id=None, timeout=20):
    """远程执行命令 — 同步等待结果"""
    data = {'cmd': command, 'timeout': timeout, 'agent_id': agent_id or 'ZHOUMAC'}
    r = api_call(url, token, '/api/exec-sync', method='POST', data=data, timeout=timeout+10)
    if 'error' in r:
        print(f"[!] 执行失败: {r['error']}")
        return
    if r.get('status') == 'completed':
        result = r.get('result', {})
        stdout = result.get('stdout', '')
        stderr = result.get('stderr', '')
        exit_code = result.get('exit_code', 0)
        if stdout:
            print(stdout[:4000], end='')
        if stderr:
            print(f"[stderr] {stderr[:1000]}")
        if exit_code != 0:
            print(f"[exit={exit_code}]")
    elif r.get('status') == 'timeout':
        print(f"[!] 超时 ({timeout}s)")
    else:
        print(json.dumps(r, indent=2, ensure_ascii=False))


def cmd_broadcast(url, token, command, timeout=20):
    """广播命令到所有Agent"""
    data = {'type': 'shell', 'payload': {'command': command}, 'timeout': timeout}
    r = api_call(url, token, '/api/broadcast', method='POST', data=data)
    if 'error' in r:
        print(f"[!] 广播失败: {r['error']}")
        return
    print(f"[✓] 广播已发送")
    print(json.dumps(r, indent=2, ensure_ascii=False)[:500])


def cmd_screenshot(url, token, agent_id=None, timeout=20):
    """截屏 — 通过exec-sync同步获取"""
    data = {'agent_id': agent_id or '141', 'type': 'screenshot', 'payload': {}, 'timeout': timeout}
    r = api_call(url, token, '/api/exec-sync', method='POST', data=data, timeout=timeout+10)
    if 'error' in r:
        print(f"[!] 截屏失败: {r['error']}")
        return
    if r.get('status') == 'completed' and r.get('result', {}).get('screenshot_base64'):
        img_data = base64.b64decode(r['result']['screenshot_base64'])
        fname = f'screenshot_{agent_id or "cf"}_{int(time.time())}.png'
        with open(fname, 'wb') as f:
            f.write(img_data)
        info = r['result']
        print(f"[✓] 截屏已保存: {fname} ({len(img_data)} bytes, {info.get('width','?')}x{info.get('height','?')})")
    else:
        print(f"[!] 截屏数据为空")


def cmd_download(url, token, remote_path, local_path=None, agent_id=None, timeout=20):
    """下载文件 — 通过exec-sync同步获取"""
    data = {'agent_id': agent_id or '141', 'type': 'file_read', 'payload': {'path': remote_path}, 'timeout': timeout}
    r = api_call(url, token, '/api/exec-sync', method='POST', data=data, timeout=timeout+10)
    if 'error' in r:
        print(f"[!] 下载失败: {r['error']}")
        return
    if r.get('status') == 'completed' and r.get('result', {}).get('content_base64'):
        content = base64.b64decode(r['result']['content_base64'])
        if not local_path:
            local_path = Path(remote_path).name.replace('\\', '_').replace('/', '_')
        with open(local_path, 'wb') as f:
            f.write(content)
        print(f"[✓] 已下载: {local_path} ({len(content)} bytes)")
    else:
        print(f"[!] 文件内容为空")


def cmd_upload(url, token, local_path, remote_path, agent_id=None, timeout=20):
    """上传文件 — 通过exec-sync同步写入"""
    if not Path(local_path).exists():
        print(f"[!] 本地文件不存在: {local_path}")
        return
    content = base64.b64encode(Path(local_path).read_bytes()).decode('ascii')
    data = {'agent_id': agent_id or '141', 'type': 'file_write', 'payload': {'path': remote_path, 'content_base64': content, 'overwrite': True}, 'timeout': timeout}
    r = api_call(url, token, '/api/exec-sync', method='POST', data=data, timeout=timeout+10)
    if 'error' in r:
        print(f"[!] 上传失败: {r['error']}")
        return
    print(f"[✓] 已上传: {local_path} → {remote_path}")


def cmd_agent_mode(url, token):
    """被控模式 — 持续轮询中枢获取命令并执行"""
    hostname = platform.node()
    agent_id = f'cf-agent-{hostname}'
    print(f"[cf-agent] 被控模式启动 · ID={agent_id}")
    print(f"    中枢: {url}")
    print(f"    通道: CF-HTTPS")
    print(f"    Ctrl+C 退出")
    print()

    # 注册
    reg = api_call(url, token, '/api/register', method='POST',
                   data={'agent_id': agent_id, 'hostname': hostname,
                         'os': f'{platform.system()} {platform.release()}',
                         'ip': '127.0.0.1', 'agent_version': __version__})
    if reg.get('error'):
        print(f"[!] 注册失败: {reg['error']}")
        return

    poll_interval = 5
    while True:
        try:
            r = api_call(url, token, '/api/poll', method='POST',
                         data={'agent_id': agent_id}, timeout=30)
            if r.get('error'):
                print(f"[!] 轮询错误: {r['error']}")
                time.sleep(poll_interval * 2)
                continue

            commands = r.get('commands', [])
            for cmd in commands:
                cmd_id = cmd.get('id', '?')
                cmd_text = cmd.get('command', '')
                print(f"  [cmd#{cmd_id}] {cmd_text}")

                try:
                    result = subprocess.run(
                        cmd_text, shell=True, capture_output=True, text=True, timeout=60
                    )
                    output = result.stdout[:4000]
                    exit_code = result.returncode
                except subprocess.TimeoutExpired:
                    output = '[timeout]'
                    exit_code = -1
                except Exception as e:
                    output = str(e)
                    exit_code = -1

                # 回报结果
                api_call(url, token, '/api/result', method='POST',
                         data={'agent_id': agent_id, 'command_id': cmd_id,
                               'output': output, 'exit_code': exit_code})
                print(f"  [cmd#{cmd_id}] exit={exit_code} output={output[:100]}")

            # 心跳
            api_call(url, token, '/api/heartbeat', method='POST',
                     data={'agent_id': agent_id, 'status': 'online'})

            time.sleep(poll_interval)
        except KeyboardInterrupt:
            print("\n[cf-agent] 退出")
            api_call(url, token, '/api/unregister', method='POST',
                     data={'agent_id': agent_id})
            break
        except Exception as e:
            print(f"[!] 异常: {e}")
            time.sleep(poll_interval)


def cmd_channels():
    """显示所有可用通道"""
    channels = discover_all_channels()
    if not channels:
        print("[!] 无可用通道")
        return
    print("─── 可用通道 ───")
    for i, (url, token, name) in enumerate(channels, 1):
        token_mask = token[:8] + '...' if token and len(token) > 8 else '(无)'
        print(f"  [{i}] {name:12s} {url[:55]}")
        print(f"      token={token_mask}")
    print()


# ════════════════════════════════════════════════════════════
# 道 · 主入口 — 道法自然, 万物归一
# ════════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(
        description='道 · CF云端Agent — Cloudflare HTTPS通道',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
道法自然: 双通道自动切换, CF优先 → 阿里云备用
天下之至柔驰骋於天下之致坚 — 出站隧道绕过一切NAT/防火墙
        """
    )
    parser.add_argument('--url', '-u', help='CF中枢URL (https://xxx.trycloudflare.com)')
    parser.add_argument('--token', '-t', help='认证Token')
    parser.add_argument('--auto', '-a', action='store_true', help='自动发现CF连接字符串')
    parser.add_argument('--health', action='store_true', help='健康检查')
    parser.add_argument('--health-dual', action='store_true', help='双通道健康检查')
    parser.add_argument('--agents', action='store_true', help='列出在线Agent')
    parser.add_argument('--exec', '-e', metavar='CMD', help='远程执行命令')
    parser.add_argument('--broadcast', '-b', metavar='CMD', help='广播命令')
    parser.add_argument('--screenshot', action='store_true', help='截屏')
    parser.add_argument('--download', metavar='PATH', help='下载文件')
    parser.add_argument('--upload', nargs=2, metavar=('LOCAL', 'REMOTE'), help='上传文件')
    parser.add_argument('--agent', action='store_true', help='被控模式')
    parser.add_argument('--channels', action='store_true', help='显示可用通道')
    parser.add_argument('--agent-id', help='指定Agent ID (默认: 141)')
    parser.add_argument('--timeout', type=int, default=20, help='命令超时秒数 (默认: 20)')
    parser.add_argument('--version', '-v', action='store_true', help='版本')

    args = parser.parse_args()

    if args.version:
        print(f'cf_cloud_agent.py v{__version__}')
        return

    if args.channels:
        cmd_channels()
        return

    # 获取URL和Token
    url, token = args.url, args.token
    if not url or args.auto:
        auto_url, auto_token = auto_discover()
        if auto_url:
            url = url or auto_url
            token = token or auto_token
            print(f"[cf-agent] 自动发现: {url}")
        else:
            print("[!] 无法自动发现CF连接字符串")
            print("    请指定: --url https://xxx.trycloudflare.com --token xxx")
            print("    或运行: cf_start_hub.ps1 生成连接字符串")
            sys.exit(1)

    if not url:
        parser.print_help()
        sys.exit(1)

    # 执行命令
    if args.health:
        cmd_health(url, token)
    elif args.health_dual:
        cmd_health_dual()
    elif args.agents:
        cmd_agents(url, token)
    elif args.exec:
        cmd_exec(url, token, args.exec, agent_id=args.agent_id, timeout=args.timeout)
    elif args.broadcast:
        cmd_broadcast(url, token, args.broadcast, timeout=args.timeout)
    elif args.screenshot:
        cmd_screenshot(url, token, agent_id=args.agent_id, timeout=args.timeout)
    elif args.download:
        cmd_download(url, token, args.download, agent_id=args.agent_id, timeout=args.timeout)
    elif args.upload:
        cmd_upload(url, token, args.upload[0], args.upload[1], agent_id=args.agent_id, timeout=args.timeout)
    elif args.agent:
        cmd_agent_mode(url, token)
    else:
        # 默认: 健康检查
        cmd_health(url, token)


if __name__ == '__main__':
    main()
