/*
 * rdp-web 网关 · 官方 RDP 协议(node-rdpjs) <-> 浏览器(WebSocket) 桥
 *
 * 道法自然 · 不生产新体系: 直接搬运 Windows 官方 RDP 的线协议(node-rdpjs 协议栈)
 * 与官方 mstsc.js 前端渲染(canvas/rle/keyboard), 把「远程桌面连接」的前端模块、
 * 交互流程原样嵌入 IDE 内页, 用户体感与原生 RDP 完全一致。
 *
 * 纯 Node 内置模块实现(http/crypto), 不引第三方: WebSocket 服务端手写(RFC6455)。
 * 复制品会话凭据由本机守护 config.json 解析(域=本机名, 用户=分身名, 口令=default_password),
 * 全程 127.0.0.1 环回, 零 GUI 依赖, 后端可无头验证。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const rdp = require('./rdpjs/lib');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WEB_ROOT = path.join(__dirname, 'webclient');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function daemonConfig() {
    try {
        const pd = process.env.ProgramData || 'C:\\ProgramData';
        return JSON.parse(fs.readFileSync(path.join(pd, 'dao_vm', 'config.json'), 'utf8'));
    } catch (e) { return {}; }
}

/* ── 静态资源: 官方 mstsc.js 前端 + 本网关 ws 传输层 ─────────────────── */
function serveStatic(req, res) {
    let rel = decodeURIComponent((req.url.split('?')[0] || '/'));
    if (rel === '/' || rel === '') rel = '/index.html';
    const fp = path.normalize(path.join(WEB_ROOT, rel));
    if (!fp.startsWith(WEB_ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
}

/* ── 手写 WebSocket 帧编解码(RFC6455) ─────────────────────────────── */
function wsAccept(key) {
    return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsEncode(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
    }
    return Buffer.concat([header, payload]);
}

function attachWs(socket, onMessage, onClose) {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            const need = off + (masked ? 4 : 0) + len;
            if (buf.length < need) return;
            let mask = null;
            if (masked) { mask = buf.slice(off, off + 4); off += 4; }
            const data = Buffer.from(buf.slice(off, off + len));
            if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
            buf = buf.slice(need);
            if (opcode === 0x8) { try { socket.end(); } catch (e) {} onClose && onClose(); return; }
            if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch (e) {} continue; }
            if (opcode === 0x1) { onMessage && onMessage(data.toString('utf8')); }
        }
    });
    socket.on('close', () => onClose && onClose());
    socket.on('error', () => onClose && onClose());
}

/* ── RDP 会话代理: 一条 WS <-> 一路官方 RDP 连接(同源共控复制品会话) ── */
function bridgeRdp(socket, vm) {
    const cfg = daemonConfig();
    const target = cfg.rdp_target || '127.0.0.2';
    const domain = process.env.COMPUTERNAME || os.hostname();
    const password = cfg.default_password || '';
    const send = (o) => { try { socket.write(wsEncode(JSON.stringify(o))); } catch (e) {} };

    let client = rdp.createClient({
        domain: domain, userName: vm, password: password,
        enablePerf: true, autoLogin: true,
        screen: { width: 1280, height: 800 }, locale: 'en', logLevel: 'ERROR'
    }).on('connect', () => send({ e: 'rdp-connect' }))
        .on('bitmap', (b) => send({ e: 'rdp-bitmap', b: {
            destTop: b.destTop, destLeft: b.destLeft, destBottom: b.destBottom, destRight: b.destRight,
            width: b.width, height: b.height, bitsPerPixel: b.bitsPerPixel, isCompress: b.isCompress,
            data: Buffer.from(b.data).toString('base64') } }))
        .on('close', () => { send({ e: 'rdp-close' }); try { socket.end(); } catch (e) {} })
        .on('error', (err) => send({ e: 'rdp-error', m: String((err && err.message) || err) }))
        .connect(target, 3389);

    attachWs(socket, (raw) => {
        let m; try { m = JSON.parse(raw); } catch (e) { return; }
        if (!client) return;
        try {
            if (m.t === 'mouse') client.sendPointerEvent(m.x, m.y, m.button, m.pressed);
            else if (m.t === 'wheel') client.sendWheelEvent(m.x, m.y, m.step, m.neg, m.horiz);
            else if (m.t === 'scancode') client.sendKeyEventScancode(m.code, m.pressed);
            else if (m.t === 'unicode') client.sendKeyEventUnicode(m.code, m.pressed);
        } catch (e) {}
    }, () => { try { client && client.close(); } catch (e) {} client = null; });
}

const PORT = Number(process.env.RDP_WEB_PORT) || 9040;
const server = http.createServer(serveStatic);
server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.url.split('?')[0] !== '/rdp')) { try { socket.destroy(); } catch (e) {} return; }
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
    const url = new URL(req.url, 'http://127.0.0.1');
    bridgeRdp(socket, url.searchParams.get('vm') || 'vm01');
});
server.listen(PORT, '127.0.0.1', () => console.log('[rdp-web] listening 127.0.0.1:' + PORT));
