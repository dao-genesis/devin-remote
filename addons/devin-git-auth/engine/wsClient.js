"use strict";
// 零依赖 WebSocket 客户端（Node 内置 http/tls/crypto 自实现 RFC6455）。
//
// Node 20 没有全局 WebSocket，而「点掉 $20 引导页」要在 launch 一返回就立刻通过
// WS 发 {type:'stop'} 把 onboarding 会话停掉（不停就会真跑、白白吃掉 $20）。为契合本仓库
// 「纯客户端 / 零运行时依赖」，这里不引 `ws`，而是用 Node 内置模块手搓一个够用的 WS 客户端：
//   - 握手：HTTP/1.1 Upgrade（Sec-WebSocket-Key/Accept 校验）
//   - 传输：客户端帧必须掩码（mask）；解析服务端帧（text/binary/close/ping/pong，含分片）
//   - 代理：HTTP CONNECT 隧道 + TLS（与 http.ts 的代理走法一致）
//   - 关 TLS 校验：自签 CA / 拦截代理兜底
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
exports.WsClient = void 0;
const crypto = __importStar(require("crypto"));
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const tls = __importStar(require("tls"));
const url_1 = require("url");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_TIMEOUT_MS = 15_000;
/** 建底层 socket：wss 直连 tls.connect / ws 直连 net.connect；走代理则先 CONNECT 再按需 TLS。 */
function openSocket(target, opts, proxy) {
    const host = target.hostname;
    const secure = target.protocol === "wss:";
    const port = target.port ? Number(target.port) : secure ? 443 : 80;
    return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        const wrapTls = (socket) => {
            const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: opts.verify }, () => resolve(tlsSocket));
            tlsSocket.on("error", onError);
        };
        if (proxy) {
            const proxyPort = proxy.port ? Number(proxy.port) : 80;
            const headers = {};
            if (proxy.username) {
                const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
                headers["proxy-authorization"] = "Basic " + Buffer.from(cred).toString("base64");
            }
            const connectReq = http.request({
                host: proxy.hostname,
                port: proxyPort,
                method: "CONNECT",
                path: `${host}:${port}`,
                headers,
            });
            connectReq.setTimeout(opts.timeoutMs, () => connectReq.destroy(new Error("代理连接超时")));
            connectReq.on("error", onError);
            connectReq.on("connect", (res, socket) => {
                if (res.statusCode !== 200) {
                    socket.destroy();
                    reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
                    return;
                }
                if (secure) {
                    wrapTls(socket);
                }
                else {
                    resolve(socket);
                }
            });
            connectReq.end();
            return;
        }
        if (secure) {
            const tlsSocket = tls.connect({ host, port, servername: host, rejectUnauthorized: opts.verify }, () => resolve(tlsSocket));
            tlsSocket.setTimeout(opts.timeoutMs, () => tlsSocket.destroy(new Error("连接超时")));
            tlsSocket.on("error", onError);
            return;
        }
        const plain = net.connect({ host, port }, () => resolve(plain));
        plain.setTimeout(opts.timeoutMs, () => plain.destroy(new Error("连接超时")));
        plain.on("error", onError);
    });
}
/** 解出一条完整文本/二进制消息时回调 onText；自动回 pong、处理 close。 */
class FrameParser {
    constructor(onText, onClose, sendPong) {
        this.onText = onText;
        this.onClose = onClose;
        this.sendPong = sendPong;
        this.buf = Buffer.alloc(0);
        this.fragments = [];
    }
    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        this.parse();
    }
    parse() {
        for (;;) {
            if (this.buf.length < 2) {
                return;
            }
            const b0 = this.buf[0];
            const b1 = this.buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0; // 服务端帧不应带掩码
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (this.buf.length < offset + 2) {
                    return;
                }
                len = this.buf.readUInt16BE(offset);
                offset += 2;
            }
            else if (len === 127) {
                if (this.buf.length < offset + 8) {
                    return;
                }
                const big = this.buf.readBigUInt64BE(offset);
                len = Number(big);
                offset += 8;
            }
            const maskLen = masked ? 4 : 0;
            if (this.buf.length < offset + maskLen + len) {
                return; // 帧还没收全
            }
            let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
            if (masked) {
                const mask = this.buf.subarray(offset, offset + 4);
                const unmasked = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i++) {
                    unmasked[i] = payload[i] ^ mask[i & 3];
                }
                payload = unmasked;
            }
            this.buf = this.buf.subarray(offset + maskLen + len);
            if (opcode === 0x8) {
                this.onClose();
                return;
            }
            if (opcode === 0x9) {
                this.sendPong(payload);
                continue;
            }
            if (opcode === 0xa) {
                continue; // pong，忽略
            }
            // 0x0 续帧 / 0x1 text / 0x2 binary
            this.fragments.push(payload);
            if (fin) {
                const full = Buffer.concat(this.fragments);
                this.fragments = [];
                this.onText(full.toString("utf8"));
            }
        }
    }
}
/** 编一帧客户端 → 服务端的消息（客户端帧必须掩码）。 */
function encodeFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | len]);
    }
    else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
    }
    return Buffer.concat([header, mask, masked]);
}
/** 极简 WebSocket 客户端：connect → onMessage → send → close。仅覆盖本工程「停会话」所需。 */
class WsClient {
    constructor() {
        this.socket = null;
        this.parser = null;
        this.handlers = [];
        this.closed = false;
    }
    get isOpen() {
        return !this.closed && !!this.socket && !this.socket.destroyed;
    }
    onMessage(cb) {
        this.handlers.push(cb);
    }
    /** 连接 ws(s):// URL，握手成功后 resolve。失败 / 超时 reject。 */
    static connect(wsUrl, options = {}) {
        const verify = options.verify !== false;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const proxyStr = (options.proxy || "").trim();
        const proxy = proxyStr ? new url_1.URL(proxyStr) : undefined;
        const u = new url_1.URL(wsUrl);
        if (u.protocol !== "wss:" && u.protocol !== "ws:") {
            return Promise.reject(new Error(`不支持的 WS 协议：${u.protocol}`));
        }
        const client = new WsClient();
        const key = crypto.randomBytes(16).toString("base64");
        const expectAccept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        return openSocket(u, { verify, timeoutMs }, proxy).then((socket) => new Promise((resolve, reject) => {
            let settled = false;
            const fail = (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    socket.destroy();
                }
                catch {
                    /* ignore */
                }
                reject(err);
            };
            const timer = setTimeout(() => fail(new Error("WS 握手超时")), timeoutMs);
            socket.on("error", fail);
            const path = u.pathname + u.search;
            const extra = Object.entries(options.headers || {})
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join("");
            const req = `GET ${path} HTTP/1.1\r\n` +
                `Host: ${u.host}\r\n` +
                `Upgrade: websocket\r\n` +
                `Connection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${key}\r\n` +
                `Sec-WebSocket-Version: 13\r\n` +
                extra +
                `\r\n`;
            socket.write(req);
            let handshakeBuf = Buffer.alloc(0);
            const onHandshakeData = (chunk) => {
                handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
                const sep = handshakeBuf.indexOf("\r\n\r\n");
                if (sep < 0) {
                    return; // 响应头还没收全
                }
                const headerText = handshakeBuf.subarray(0, sep).toString("utf8");
                const rest = handshakeBuf.subarray(sep + 4);
                const statusLine = headerText.split("\r\n")[0] || "";
                if (!/\s101\s/.test(" " + statusLine + " ")) {
                    fail(new Error(`WS 握手失败：${statusLine}`));
                    return;
                }
                const acceptMatch = /sec-websocket-accept:\s*(\S+)/i.exec(headerText);
                if (!acceptMatch || acceptMatch[1] !== expectAccept) {
                    fail(new Error("WS 握手失败：Sec-WebSocket-Accept 校验不通过"));
                    return;
                }
                // 握手成功：切到帧解析模式。
                clearTimeout(timer);
                settled = true;
                socket.removeListener("data", onHandshakeData);
                socket.removeListener("error", fail);
                client.socket = socket;
                client.parser = new FrameParser((s) => {
                    for (const h of client.handlers) {
                        h(s);
                    }
                }, () => client.close(), (payload) => client.rawSend(0xa, payload));
                socket.on("data", (c) => client.parser?.push(c));
                socket.on("close", () => {
                    client.closed = true;
                });
                socket.on("error", () => {
                    client.closed = true;
                });
                resolve(client);
                if (rest.length > 0) {
                    client.parser.push(rest);
                }
            };
            socket.on("data", onHandshakeData);
        }));
    }
    rawSend(opcode, payload) {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        try {
            this.socket.write(encodeFrame(opcode, payload));
        }
        catch {
            /* ignore */
        }
    }
    /** 发一条文本消息。 */
    send(text) {
        this.rawSend(0x1, Buffer.from(text, "utf8"));
    }
    /** 发关闭帧并销毁底层 socket。 */
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.rawSend(0x8, Buffer.alloc(0));
        try {
            this.socket?.destroy();
        }
        catch {
            /* ignore */
        }
    }
}
exports.WsClient = WsClient;
//# sourceMappingURL=wsClient.js.map