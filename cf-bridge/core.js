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
// 道 · core — 纯 Node 核心：本地 HTTP server + 路由 + 出站中继桥
// 不依赖 vscode，可单独被 Node 测试与复用（VSIX 与独立 Agent 共用本源）。
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const child_process_1 = require("child_process");
const isWin = process.platform === 'win32';
function runShell(cmd, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const shell = isWin ? 'powershell.exe' : '/bin/sh';
        const args = isWin ? ['-NoProfile', '-Command', cmd] : ['-c', cmd];
        (0, child_process_1.execFile)(shell, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ stdout: stdout || '', stderr: stderr || (err && err.killed ? 'timeout' : ''), exit_code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0 });
        });
    });
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
    if (route === '/api/health') {
        return { status: 200, body: { status: 'ok', service: 'dao-bridge', version: '1.0.0', platform: process.platform, host: require('os').hostname(), workspace: root, pid: process.pid } };
    }
    // 其余端点需要鉴权
    if (!checkAuth(headers, token))
        return { status: 401, body: { error: 'unauthorized' } };
    switch (route) {
        case '/api/exec':
        case '/api/command': {
            const cmd = body.cmd || body.command || '';
            if (!cmd)
                return { status: 400, body: { error: 'cmd required' } };
            const timeoutMs = ((body.timeout && Number(body.timeout)) || 30) * 1000;
            const r = await runShell(cmd, body.cwd || root, timeoutMs);
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
                res.writeHead(out.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out.body, null, 2));
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
