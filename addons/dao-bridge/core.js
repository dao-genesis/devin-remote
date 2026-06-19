"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAuth = checkAuth;
exports.handleRoute = handleRoute;
exports.findAvailablePort = findAvailablePort;
exports.startServer = startServer;
exports.connectRelay = connectRelay;
exports.buildExecCommand = buildExecCommand;
exports.buildBootstrap = buildBootstrap;
exports.buildBootstrapSh = buildBootstrapSh;
exports.platformOf = platformOf;
exports.psq = psq;
// 道 · core — 纯 Node 核心：本地 HTTP server + 路由 + 出站中继桥
// 不依赖 vscode，可单独被 Node 测试与复用（VSIX 与独立 Agent 共用本源）。
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const child_process_1 = require("child_process");
const crypto = require("crypto");
const os = require("os");
const isWin = process.platform === 'win32';
// PowerShell 单引号字面量转义（路径/参数含空格或引号也安全）
function psq(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"; }
// POSIX(/bin/sh) 单引号字面量转义（Linux/macOS 本机执行用）
function shq(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'"; }
// 按平台生成 sysinfo 采集命令：Win→Get-ComputerInfo；Linux/macOS→uname/os-release/cpu/mem/disk
function sysinfoCmd(platform) {
    if ((platform || process.platform) === 'win32') return 'Get-ComputerInfo | Out-String';
    return "echo '=== SYSTEM ==='; uname -a; echo; (lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null); " +
        "echo; echo '=== CPU ==='; (lscpu 2>/dev/null | head -25 || sysctl -n machdep.cpu.brand_string 2>/dev/null); " +
        "echo; echo '=== MEMORY ==='; (free -h 2>/dev/null || vm_stat 2>/dev/null); " +
        "echo; echo '=== DISK ==='; df -h 2>/dev/null; echo; echo '=== UPTIME ==='; uptime 2>/dev/null";
}
// 由被控端登记的 sysinfo 推断其平台：显式 platform 优先；否则按 os_version 关键字判定；缺省回退 win32（向后兼容）。
function platformOf(agent) {
    const s = (agent && agent.sysinfo) || {};
    if (s.platform) return String(s.platform);
    if (/linux|darwin|mac|bsd/i.test(s.os_version || '')) return 'linux';
    return 'win32';
}
// 强制 UTF-8 输出 + 透传原生退出码（powershell -Command 默认只返 0/1，吹掉 .bat 的原生退出码）
function wrapPwsh(cmd) {
    return ('$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\n' +
        "$ErrorActionPreference='Continue'; $Error.Clear(); $global:LASTEXITCODE=0\n" +
        cmd +
        '\n$__c=0; if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){$__c=$LASTEXITCODE} elseif($Error.Count -gt 0){$__c=1}; exit $__c');
}
// 把高层 exec 请求规范化为一条健壮命令表达式。
// targetPlatform 缺省 'win32'(PowerShell)——被控端经 bootstrap 恒为 Windows；中枢本机(SELF)按 process.platform 传入，linux/darwin 走 POSIX。
// type：shell(默认/原样) | cmd|bat(Win:cmd.exe /c+chcp 65001; POSIX:当普通 shell 命令) | run|file(运行文件+args) | detached|spawn(后台启动回 PID)
function buildExecCommand(body, targetPlatform) {
    body = body || {};
    const posix = (targetPlatform || 'win32') !== 'win32';
    const type = String(body.type || 'shell').toLowerCase();
    const file = body.file || body.exe || body.program || '';
    const args = Array.isArray(body.args) ? body.args : [];
    const cmd = body.cmd || body.command || (body.payload && body.payload.command) || '';
    if (posix) {
        const cwdP = body.cwd ? 'cd ' + shq(body.cwd) + ' && ' : '';
        if (type === 'detached' || type === 'spawn' || body.detached) {
            const target = file ? shq(file) : cmd;
            const al = args.length ? ' ' + args.map(shq).join(' ') : '';
            return cwdP + 'nohup ' + target + al + ' >/dev/null 2>&1 & echo "started pid=$! file=' + (file || cmd) + '"';
        }
        if (type === 'run' || type === 'file' || (file && !cmd)) {
            const al = args.length ? ' ' + args.map(shq).join(' ') : '';
            const runner = /\.sh$/i.test(file) ? 'sh ' : '';
            return cwdP + runner + shq(file || cmd) + al + ' 2>&1';
        }
        return cwdP + cmd;
    }
    const cwd = body.cwd ? 'Set-Location -LiteralPath ' + psq(body.cwd) + '; ' : '';
    if (type === 'detached' || type === 'spawn' || body.detached) {
        const target = file || cmd;
        const al = args.length ? ' -ArgumentList ' + args.map(psq).join(',') : '';
        const win = body.show ? '' : ' -WindowStyle Hidden';
        const verb = body.elevate ? ' -Verb RunAs' : '';
        return cwd + '$p=Start-Process -FilePath ' + psq(target) + al + win + verb +
            " -PassThru; 'started pid=' + $p.Id + ' file=' + " + psq(target);
    }
    if (type === 'run' || type === 'file' || (file && !cmd)) {
        const al = args.length ? ' ' + args.map(psq).join(' ') : '';
        return cwd + '& ' + psq(file || cmd) + al + ' 2>&1 | Out-String';
    }
    if (type === 'cmd' || type === 'bat' || type === 'batch') {
        return cwd + '& cmd.exe /d /c ' + psq('chcp 65001>nul & ' + cmd) + ' 2>&1 | Out-String';
    }
    return cwd + cmd;
}
function runShell(cmd, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const shell = isWin ? 'powershell.exe' : '/bin/sh';
        const args = isWin ? ['-NoProfile', '-Command', wrapPwsh(cmd)] : ['-c', cmd];
        (0, child_process_1.execFile)(shell, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
            resolve({ stdout: stdout || '', stderr: stderr || (err && err.killed ? 'timeout' : ''), exit_code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0 });
        });
    });
}
// 被控端一行接入脚本（动态注入当前公网 URL）— 长轮询命令队列, 回传结果。
function buildBootstrap(hubUrl) {
    hubUrl = (hubUrl || '').replace(/\/$/, '');
    return `# dao 被控端 · 一行接入 · 道生一,一命接万机
$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
try{ $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8 }catch{}
$U='${hubUrl}'
function Dao-Post($path,$obj){ $b=[Text.Encoding]::UTF8.GetBytes(($obj|ConvertTo-Json -Depth 8 -Compress)); return irm "$U$path" -Method POST -Body $b -ContentType 'application/json; charset=utf-8' -TimeoutSec 35 }
$sys=@{ hostname=$env:COMPUTERNAME; username=$env:USERNAME; platform='win32'; os_version=[Environment]::OSVersion.VersionString; ps_version=$PSVersionTable.PSVersion.ToString(); capabilities=@('shell','cmd','run','detached') }
try { $reg = Dao-Post '/api/connect' @{sysinfo=$sys} } catch { Write-Host "[dao] connect failed: $($_.Exception.Message)" -ForegroundColor Red; return }
$aid=$reg.agent_id; $tok=$reg.token
Write-Host "[dao] 已接入中枢 as $aid  (Ctrl+C 退出)" -ForegroundColor Green
while($true){
  try{
    $poll = Dao-Post '/api/poll' @{id=$aid;token=$tok;timeout=25}
    foreach($c in @($poll.commands)){
      if(-not $c){ continue }
      $out=''; $err=''; $code=0
      $sw=[Diagnostics.Stopwatch]::StartNew()
      $global:LASTEXITCODE=0
      try{
        switch($c.type){
          'sysinfo' { $out = (Get-ComputerInfo | Out-String) }
          default {
            $Error.Clear()
            $ErrorActionPreference='Continue'
            $raw = Invoke-Expression $c.payload.command 2>&1
            $ErrorActionPreference='SilentlyContinue'
            $out = ($raw | Out-String)
            if($Error.Count -gt 0){
              $code=1
              $msgs = (@($Error | Select-Object -First 20) | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
              if([string]::IsNullOrWhiteSpace($out)){ $out=$msgs } else { $out = $out + [Environment]::NewLine + $msgs }
            }
            if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){ $code=$LASTEXITCODE }
          }
        }
      }catch{ $err=$_.Exception.Message; $code=1 }
      $sw.Stop()
      $res=@{ stdout=$out; stderr=$err; exit_code=$code; execution_time_ms=$sw.ElapsedMilliseconds }
      try{ Dao-Post '/api/result' @{agent_id=$aid;token=$tok;cmd_id=$c.cmd_id;result=$res} | Out-Null }catch{}
    }
  }catch{
    try{ $reg = Dao-Post '/api/connect' @{sysinfo=$sys}; $aid=$reg.agent_id; $tok=$reg.token }catch{ Start-Sleep 3 }
  }
}
`;
}
// Linux/macOS 被控端 · 一行接入：curl -fsSL <hub>/api/bootstrap.sh | sh
// bash 仅引导，connect→poll→exec→result 循环交给 python3（Linux/macOS 普遍自带），命令经 /bin/sh 执行；
// 登记 platform=本机平台，中枢据此按 POSIX 规范化下发指令。轮询用 POST /api/poll（与本中枢一致）。
function buildBootstrapSh(hubUrl) {
    hubUrl = (hubUrl || '').replace(/\/$/, '');
    return `#!/bin/sh
# dao Linux/macOS 被控端 · 一行接入 · 道生一,一命接万机
U="${hubUrl}"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "[dao] 需要 python3 才能接入（Linux/macOS 通常自带）"; exit 1; fi
exec "$PY" - "$U" <<'DAOEOF'
import sys, os, json, time, socket, platform, subprocess, urllib.request
U = sys.argv[1].rstrip('/')
SYSINFO = r'''echo '=== SYSTEM ==='; uname -a; echo; (lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null); echo; echo '=== CPU ==='; (lscpu 2>/dev/null | head -25 || sysctl -n machdep.cpu.brand_string 2>/dev/null); echo; echo '=== MEMORY ==='; (free -h 2>/dev/null || vm_stat 2>/dev/null); echo; echo '=== DISK ==='; df -h 2>/dev/null; echo; echo '=== UPTIME ==='; uptime 2>/dev/null'''
SYS = {
  'hostname': socket.gethostname(),
  'username': os.environ.get('USER') or os.environ.get('LOGNAME') or 'user',
  'platform': sys.platform,
  'os_version': ' '.join(platform.uname()),
  'capabilities': ['shell', 'run', 'detached', 'sysinfo'],
}
def post(path, obj):
    d = json.dumps(obj).encode('utf-8')
    req = urllib.request.Request(U + path, data=d, headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=40).read().decode('utf-8'))
def connect():
    r = post('/api/connect', {'sysinfo': SYS})
    return r['agent_id'], r['token']
aid, tok = connect()
sys.stderr.write('[dao] 已接入中枢 as %s  (Ctrl+C 退出)\\n' % aid)
while True:
    try:
        poll = post('/api/poll', {'id': aid, 'token': tok, 'timeout': 25})
        for c in (poll.get('commands') or []):
            if not c: continue
            t0 = time.time(); out = ''; err = ''; code = 0
            try:
                cmd = SYSINFO if c.get('type') == 'sysinfo' else (c.get('payload') or {}).get('command', '')
                p = subprocess.run(['/bin/sh', '-c', cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
                out = p.stdout.decode('utf-8', 'replace'); err = p.stderr.decode('utf-8', 'replace'); code = p.returncode
            except Exception as e:
                err = str(e); code = 1
            res = {'stdout': out, 'stderr': err, 'exit_code': code, 'execution_time_ms': int((time.time() - t0) * 1000)}
            try: post('/api/result', {'agent_id': aid, 'token': tok, 'cmd_id': c['cmd_id'], 'result': res})
            except Exception: pass
    except Exception:
        try: aid, tok = connect()
        except Exception: time.sleep(3)
DAOEOF
`;
}
// 中枢分发：被控端登记 + 每 agent 命令队列/结果表/唤醒器（operator→hub→agent 三明治）
class DaoHub {
    constructor() {
        this.agents = new Map();
        this.HEARTBEAT_TIMEOUT = 120 * 1000;
        this.POLL_MAX = 25;
    }
    registerAgent(sysinfo) {
        sysinfo = sysinfo || {};
        const id = sysinfo.hostname || ('agent-' + crypto.randomBytes(3).toString('hex'));
        const token = crypto.randomBytes(24).toString('hex');
        const existing = this.agents.get(id);
        if (existing) {
            existing.id = id; existing.token = token; existing.sysinfo = sysinfo;
            existing.lastSeen = Date.now(); existing.status = 'online';
            existing.hostname = sysinfo.hostname || id;
            existing.capabilities = sysinfo.capabilities || existing.capabilities || ['shell'];
            return existing;
        }
        const a = {
            id, token, sysinfo, hostname: sysinfo.hostname || id,
            capabilities: sysinfo.capabilities || ['shell'],
            connectedAt: Date.now(), lastSeen: Date.now(), status: 'online',
            queue: [], waiters: [], results: new Map(), resultWaiters: new Map(),
        };
        this.agents.set(id, a);
        return a;
    }
    getAgent(id) {
        if (!id) return null;
        let a = this.agents.get(id);
        if (a) return a;
        const t = String(id).toLowerCase();
        for (const [k, v] of this.agents) if (k.toLowerCase() === t) return v;
        return null;
    }
    agentAlive(a) { return Date.now() - (a.lastSeen || 0) < this.HEARTBEAT_TIMEOUT; }
    isSelf(agentId) {
        const k = String(agentId || '').toLowerCase().trim();
        return k === '' || k === 'self' || k === 'local' || k === os.hostname().toLowerCase();
    }
    queueCommand(agentId, type, payload) {
        const a = this.getAgent(agentId);
        if (!a) return { err: 'agent not found' };
        const cmdId = 'cmd_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
        a.queue.push({ cmd_id: cmdId, type: type || 'shell', payload: payload || {} });
        const w = a.waiters.shift(); if (w) w();
        return { cmdId, agent: a };
    }
    pollCommands(a, timeoutSec) {
        a.lastSeen = Date.now(); a.status = 'online';
        const ms = Math.min(timeoutSec || this.POLL_MAX, this.POLL_MAX) * 1000;
        return new Promise((resolve) => {
            if (a.queue.length) return resolve(a.queue.splice(0));
            let done = false;
            const finish = (cmds) => {
                if (done) return; done = true; clearTimeout(timer);
                const i = a.waiters.indexOf(wake); if (i >= 0) a.waiters.splice(i, 1);
                resolve(cmds);
            };
            const wake = () => finish(a.queue.splice(0));
            a.waiters.push(wake);
            const timer = setTimeout(() => finish([]), ms);
        });
    }
    submitResult(a, cmdId, result) {
        a.lastSeen = Date.now();
        a.results.set(cmdId, Object.assign({ completed_at: Date.now() }, result));
        const w = a.resultWaiters.get(cmdId);
        if (w) w(a.results.get(cmdId));
    }
    waitResult(a, cmdId, timeoutMs) {
        return new Promise((resolve) => {
            const existing = a.results.get(cmdId);
            if (existing) return resolve(existing);
            let done = false;
            const finish = (r) => { if (done) return; done = true; clearTimeout(timer); a.resultWaiters.delete(cmdId); resolve(r); };
            a.resultWaiters.set(cmdId, finish);
            const timer = setTimeout(() => finish(null), timeoutMs);
        });
    }
    agentList() {
        const out = [];
        for (const [id, a] of this.agents) {
            const si = a.sysinfo || {};
            out.push({
                id, hostname: a.hostname || id,
                status: this.agentAlive(a) ? 'online' : 'offline',
                os: si.os_version || '?', user: si.username || '?',
                capabilities: a.capabilities || ['shell'],
                last_seen: new Date(a.lastSeen || 0).toISOString(),
                pending: a.queue.length,
            });
        }
        return out;
    }
}
function getHub(host) {
    if (!host._daoHub) host._daoHub = new DaoHub();
    return host._daoHub;
}
function checkAuth(headers, token) {
    const h = (headers['authorization'] || headers['Authorization'] || '');
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    return !!token && bearer === token;
}
// 统一路由：HTTP 直连与 relay 转发共用。返回普通对象（JSON）。
async function handleRoute(host, route, method, headers, bodyRaw, token) {
    const root = host.workspaceRoot();
    let body = {};
    try {
        body = bodyRaw ? JSON.parse(bodyRaw) : {};
    }
    catch {
        body = {};
    }
    const hub = getHub(host);
    if (route === '/api/health') {
        return { status: 200, body: { status: 'ok', service: 'dao-bridge', version: '1.0.0', platform: process.platform, host: require('os').hostname(), workspace: root, agents_online: hub.agents.size, pid: process.pid } };
    }
    // ── 被控端端点（以 per-agent token 自证, 免 master token）+ 一行接入脚本 ──
    if (route === '/api/bootstrap.ps1' || route === '/bootstrap.ps1') {
        const hubUrl = host.publicUrl ? host.publicUrl() : '';
        return { status: 200, contentType: 'text/plain; charset=utf-8', raw: buildBootstrap(hubUrl), body: buildBootstrap(hubUrl) };
    }
    if (route === '/api/bootstrap.sh' || route === '/bootstrap.sh') {
        const hubUrl = host.publicUrl ? host.publicUrl() : '';
        return { status: 200, contentType: 'text/plain; charset=utf-8', raw: buildBootstrapSh(hubUrl), body: buildBootstrapSh(hubUrl) };
    }
    if (route === '/api/connect' && method === 'POST') {
        const a = hub.registerAgent(body.sysinfo || body || {});
        return { status: 200, body: { agent_id: a.id, token: a.token, server_time: new Date().toISOString() } };
    }
    if (route === '/api/poll' && method === 'POST') {
        const a = hub.getAgent(body.id);
        if (!a || a.token !== body.token) return { status: 401, body: { error: 'unauthorized' } };
        const cmds = await hub.pollCommands(a, parseInt(body.timeout, 10) || hub.POLL_MAX);
        return { status: 200, body: { commands: cmds } };
    }
    if (route === '/api/result' && method === 'POST') {
        const a = hub.getAgent(body.agent_id);
        if (!a || a.token !== body.token) return { status: 401, body: { error: 'unauthorized' } };
        hub.submitResult(a, body.cmd_id, body.result || {});
        return { status: 200, body: { ok: true } };
    }
    if (route === '/api/heartbeat' && method === 'POST') {
        const a = hub.getAgent(body.agent_id);
        if (a && a.token === body.token) { a.lastSeen = Date.now(); a.status = 'online'; }
        return { status: 200, body: { ok: true } };
    }
    // 其余端点需要鉴权
    if (!checkAuth(headers, token))
        return { status: 401, body: { error: 'unauthorized' } };
    if (route === '/api/agents' && method === 'GET')
        return { status: 200, body: { agents: hub.agentList() } };
    if (route === '/api/result-fetch' && method === 'POST') {
        const a = hub.getAgent(body.agent_id);
        if (!a) return { status: 404, body: { error: 'agent not found' } };
        const r = a.results.get(body.cmd_id);
        if (!r) return { status: 200, body: { status: 'pending', agent_id: a.id, cmd_id: body.cmd_id } };
        return { status: 200, body: { status: 'completed', agent_id: a.id, cmd_id: body.cmd_id, result: r } };
    }
    if ((route === '/api/exec' || route === '/api/exec-sync' || route === '/api/command') && method === 'POST') {
        const sync = route === '/api/exec-sync';
        const timeoutMs = ((body.timeout && Number(body.timeout)) || 30) * 1000;
        const type = String(body.type || 'shell').toLowerCase();
        // 按 agent_id 路由：SELF(本机·按本机平台规范化 linux/darwin→POSIX, win→PowerShell)；否则 → 入队转发被控端(恒 PowerShell/Windows)
        if (hub.isSelf(body.agent_id)) {
            const command = type === 'sysinfo' ? sysinfoCmd(process.platform) : buildExecCommand(body, process.platform);
            if (!command) return { status: 400, body: { error: 'cmd/file required' } };
            const r = await runShell(command, body.cwd || root, timeoutMs);
            return sync ? { status: 200, body: { status: 'completed', agent_id: require('os').hostname(), result: r } } : { status: 200, body: r };
        }
        if (type === 'sysinfo') {
            const sq = hub.queueCommand(body.agent_id, 'sysinfo', {});
            if (sq.err) return { status: 404, body: { error: sq.err } };
            if (!sync) return { status: 200, body: { cmd_id: sq.cmdId, agent_id: sq.agent.id } };
            const sr = await hub.waitResult(sq.agent, sq.cmdId, timeoutMs);
            if (!sr) return { status: 504, body: { status: 'timeout', agent_id: sq.agent.id, cmd_id: sq.cmdId } };
            return { status: 200, body: { status: 'completed', agent_id: sq.agent.id, cmd_id: sq.cmdId, result: sr } };
        }
        // 被控端按其登记平台规范化（Windows→PowerShell；Linux/macOS→/bin/sh），即"两套指令由中枢按目标自动选"。
        const tgt = hub.getAgent(body.agent_id);
        if (!tgt) return { status: 404, body: { error: 'agent not found' } };
        const qd = hub.queueCommand(body.agent_id, 'shell', { command: buildExecCommand(body, platformOf(tgt)) });
        if (qd.err) return { status: 404, body: { error: qd.err } };
        if (!sync) return { status: 200, body: { cmd_id: qd.cmdId, agent_id: qd.agent.id } };
        const result = await hub.waitResult(qd.agent, qd.cmdId, timeoutMs);
        if (!result) return { status: 504, body: { status: 'timeout', agent_id: qd.agent.id, cmd_id: qd.cmdId } };
        return { status: 200, body: { status: 'completed', agent_id: qd.agent.id, cmd_id: qd.cmdId, result } };
    }
    if (route === '/api/broadcast' && method === 'POST') {
        const delivered = [];
        for (const [id, a] of hub.agents) {
            const qd = hub.queueCommand(id, 'shell', { command: buildExecCommand(body, platformOf(a)) });
            if (qd.cmdId) delivered.push({ agent_id: id, cmd_id: qd.cmdId });
        }
        return { status: 200, body: { ok: true, delivered } };
    }
    switch (route) {
        case '/api/exec':
        case '/api/command': {
            // 规范化：.bat/.cmd/.exe/.ps1/后台进程皆可（type: shell/cmd/run/detached），默认 shell 向后兼容。
            const command = buildExecCommand(body);
            if (!command)
                return { status: 400, body: { error: 'cmd/file required' } };
            const timeoutMs = ((body.timeout && Number(body.timeout)) || 30) * 1000;
            const r = await runShell(command, body.cwd || root, timeoutMs);
            return { status: 200, body: r };
        }
        case '/api/file':
        case '/api/read': {
            const p = body.path || '';
            try {
                return { status: 200, body: { path: p, content: fs.readFileSync(p, 'utf8') } };
            }
            catch (e) {
                return { status: 404, body: { error: String(e.message || e) } };
            }
        }
        case '/api/write': {
            const p = body.path || '';
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, body.content ?? '', 'utf8');
                return { status: 200, body: { ok: true, path: p, bytes: Buffer.byteLength(body.content ?? '') } };
            }
            catch (e) {
                return { status: 500, body: { error: String(e.message || e) } };
            }
        }
        case '/api/ls': {
            const p = body.path || root;
            try {
                const items = fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
                return { status: 200, body: { path: p, items } };
            }
            catch (e) {
                return { status: 404, body: { error: String(e.message || e) } };
            }
        }
        case '/api/info': {
            return { status: 200, body: host.info ? host.info() : { workspace: root } };
        }
        default:
            if (host.handleExtra) {
                const extra = await host.handleExtra(route, method, body, headers);
                if (extra)
                    return extra;
            }
            return { status: 404, body: { error: 'not_found', route } };
    }
}
async function findAvailablePort(base) {
    for (let p = base; p < base + 50; p++) {
        const free = await new Promise((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.once('listening', () => srv.close(() => resolve(true)));
            srv.listen(p, '127.0.0.1');
        });
        if (free)
            return p;
    }
    return base;
}
async function startServer(host, opts) {
    const port = await findAvailablePort(opts.port);
    const token = opts.token;
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                const out = await handleRoute(host, url.pathname, req.method || 'GET', req.headers, raw, token);
                if (out.raw !== undefined) {
                    res.writeHead(out.status, { 'Content-Type': out.contentType || 'text/plain; charset=utf-8' });
                    res.end(out.raw);
                } else {
                    res.writeHead(out.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(out.body, null, 2));
                }
            }
            catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(e && e.message || e) }));
            }
        });
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    host.log(`dao-bridge server on http://127.0.0.1:${port}`);
    return { port, token, close: () => server.close() };
}
function connectRelay(host, opts) {
    const WebSocket = require('ws');
    let wsAgent = undefined;
    if (opts.proxy) {
        try {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            wsAgent = new HttpsProxyAgent(opts.proxy);
            host.log('bridge via proxy ' + opts.proxy);
        }
        catch (e) {
            host.log('proxy agent load failed: ' + (e && e.message || e));
        }
    }
    let sock = null;
    let connected = false;
    let stopped = false;
    let pingTimer = null;
    let reconnectTimer = null;
    let pubUrl = null;
    const base = opts.relayUrl.replace(/\/$/, '');
    const wsUrl = base.replace(/^http/, 'ws') + `/connect?session=${encodeURIComponent(opts.sessionId)}&token=${encodeURIComponent(opts.token)}`;
    function open() {
        if (stopped)
            return;
        try {
            sock = new WebSocket(wsUrl, wsAgent ? { agent: wsAgent } : undefined);
        }
        catch {
            schedule();
            return;
        }
        sock.on('open', () => {
            connected = true;
            pubUrl = base + '/relay/' + opts.sessionId;
            host.log('bridge connected: ' + pubUrl);
            pingTimer = setInterval(() => { try {
                sock.send(JSON.stringify({ type: 'ping' }));
            }
            catch { } }, 15000);
        });
        sock.on('message', async (data) => {
            let m;
            try {
                m = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (m.type === 'pong')
                return;
            if (m.type === 'request' && m.id) {
                // 桥已在 /connect 时用 token 鉴权，转发请求视为已授权：注入 token 供统一路由校验通过
                const fwdHeaders = Object.assign({}, m.headers || {}, { authorization: 'Bearer ' + opts.token });
                const out = await handleRoute(host, m.path || '/api/health', m.method || 'GET', fwdHeaders, typeof m.body === 'string' ? m.body : JSON.stringify(m.body || {}), opts.token);
                try {
                    sock.send(JSON.stringify({ type: 'response', id: m.id, status: out.status, body: out.body }));
                }
                catch { }
            }
        });
        sock.on('close', () => { connected = false; if (pingTimer)
            clearInterval(pingTimer); pubUrl = null; schedule(); });
        sock.on('error', () => { try {
            sock.close();
        }
        catch { } });
    }
    function schedule() {
        if (stopped || reconnectTimer)
            return;
        reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!connected)
            open(); }, 5000);
    }
    open();
    return {
        stop() { stopped = true; if (pingTimer)
            clearInterval(pingTimer); if (reconnectTimer)
            clearTimeout(reconnectTimer); try {
            sock && sock.close();
        }
        catch { } },
        isConnected: () => connected,
        publicUrl: () => pubUrl,
    };
}
