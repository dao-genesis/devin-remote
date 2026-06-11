"use strict";
// 零依赖 HTTP 客户端：用 Node 内置 https/http 实现，支持
//   - 每个实例独立的 Cookie jar（对应 Python httpx.Client 的 cookie 隔离）
//   - 手动跟随重定向，并记录整条重定向链（拿 installation_id 要用）
//   - HTTP 代理（CONNECT 隧道走 https；翻墙 / 公司网关时用）
//   - 读响应 Date 头（用服务器时间算 TOTP，躲本机时钟漂移）
//   - 可选关闭 TLS 校验（自签 CA / 拦截代理兜底）
//
// 之所以不用 playwright、也不用全局 fetch：fetch 在不同 Node 版本下对
// 「手动重定向 + Set-Cookie 读取 + 代理」支持参差，而 https/http 跨版本稳定，
// 且零运行时依赖——契合「纯客户端、不下载浏览器」。
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
exports.HttpClient = exports.CookieJar = void 0;
exports.registrableDomain = registrableDomain;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const tls = __importStar(require("tls"));
const url_1 = require("url");
/** 取可注册域（取最后两段）：app.devin.ai → devin.ai，github.com → github.com。 */
function registrableDomain(host) {
    const h = (host || "").toLowerCase().replace(/\.$/, "");
    const parts = h.split(".").filter(Boolean);
    if (parts.length <= 2) {
        return h;
    }
    return parts.slice(-2).join(".");
}
/** 极简 Cookie jar：按可注册域存 name→value，不处理过期 / path（够覆盖登录流程）。 */
class CookieJar {
    constructor() {
        this.store = new Map();
    }
    setFromResponse(requestUrl, setCookie) {
        if (!setCookie || setCookie.length === 0) {
            return;
        }
        const reqHost = new url_1.URL(requestUrl).hostname;
        for (const raw of setCookie) {
            const segs = raw.split(";");
            const first = (segs[0] || "").trim();
            const eq = first.indexOf("=");
            if (eq <= 0) {
                continue;
            }
            const name = first.slice(0, eq).trim();
            const value = first.slice(eq + 1).trim();
            let domain = reqHost;
            for (const seg of segs.slice(1)) {
                const [k, v] = seg.split("=");
                if ((k || "").trim().toLowerCase() === "domain" && v) {
                    domain = v.trim().replace(/^\./, "");
                }
            }
            const key = registrableDomain(domain);
            let bucket = this.store.get(key);
            if (!bucket) {
                bucket = new Map();
                this.store.set(key, bucket);
            }
            // value 为空（形如 name=; Max-Age=0）视为删除。
            if (value === "") {
                bucket.delete(name);
            }
            else {
                bucket.set(name, value);
            }
        }
    }
    cookieHeader(requestUrl) {
        const key = registrableDomain(new url_1.URL(requestUrl).hostname);
        const bucket = this.store.get(key);
        if (!bucket || bucket.size === 0) {
            return "";
        }
        return [...bucket.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
    }
    /** 导出某 URL 下的 cookie 列表（name/value），用于持久化复用上次登录的会话。 */
    list(requestUrl) {
        const key = registrableDomain(new url_1.URL(requestUrl).hostname);
        const bucket = this.store.get(key);
        if (!bucket) {
            return [];
        }
        return [...bucket.entries()].map(([name, value]) => ({ name, value }));
    }
    /**
     * 把外部保存的 cookie 灌进 jar（按 requestUrl 的可注册域归桶），用于复用上次登录的会话。
     * value 为空视为删除（与 setFromResponse 一致）。
     */
    setCookies(requestUrl, cookies) {
        const key = registrableDomain(new url_1.URL(requestUrl).hostname);
        let bucket = this.store.get(key);
        if (!bucket) {
            bucket = new Map();
            this.store.set(key, bucket);
        }
        for (const c of cookies) {
            if (!c || !c.name) {
                continue;
            }
            if (c.value === "") {
                bucket.delete(c.name);
            }
            else {
                bucket.set(c.name, c.value);
            }
        }
    }
}
exports.CookieJar = CookieJar;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 建一个「经 HTTP 代理 CONNECT 隧道 + TLS」的 https Agent，并开 keep-alive：同一目标主机的
 * 后续请求复用已建好的隧道+TLS 套接字，不再每次重新 CONNECT/握手（这是换登提速的关键）。
 * Node 的 Agent 只在「池里没有空闲 socket」时才调 createConnection，所以握手按主机摊一次。
 */
function makeProxyHttpsAgent(proxy, verify, timeoutMs, proxyAuth) {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
    const proxyPort = proxy.port ? Number(proxy.port) : 80;
    const createConnection = (options, callback) => {
        const host = options.host || "";
        const port = Number(options.port) || 443;
        const connectReq = http.request({
            host: proxy.hostname,
            port: proxyPort,
            method: "CONNECT",
            path: `${host}:${port}`,
            headers: proxyAuth,
        });
        connectReq.on("connect", (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                callback(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
                return;
            }
            const tlsSocket = tls.connect({ socket, servername: options.servername || host, rejectUnauthorized: verify }, () => callback(null, tlsSocket));
            tlsSocket.on("error", (err) => callback(err));
        });
        connectReq.on("error", (err) => callback(err));
        connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error("代理连接超时")));
        connectReq.end();
    };
    // Agent.createConnection 的官方签名返回 Duplex；这里改成「异步 callback、返回 void」的等价用法
    // （Node createSocket 见到返回空就等 callback），用断言绕过类型差异，不引入 any。
    agent.createConnection = createConnection;
    return agent;
}
class HttpClient {
    constructor(opts = {}) {
        this.jar = new CookieJar();
        this.baseHeaders = lowerKeys({
            "accept-encoding": "identity",
            ...(opts.headers || {}),
        });
        this.verify = opts.verify !== false;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const proxyStr = (opts.proxy || "").trim();
        this.proxy = proxyStr ? new url_1.URL(proxyStr) : undefined;
        const keep = { keepAlive: true, maxSockets: 8 };
        this.httpAgent = new http.Agent(keep);
        this.httpsAgent = this.proxy
            ? makeProxyHttpsAgent(this.proxy, this.verify, this.timeoutMs, this.proxyAuthHeader())
            : new https.Agent(keep);
    }
    /** 释放连接池里 keep-alive 常驻的 socket。换登流程结束后调一次，避免 socket 堆积。 */
    dispose() {
        try {
            this.httpsAgent.destroy();
        }
        catch {
            /* ignore */
        }
        try {
            this.httpAgent.destroy();
        }
        catch {
            /* ignore */
        }
    }
    get(url, opts = {}) {
        return this.request("GET", url, opts);
    }
    post(url, opts = {}) {
        return this.request("POST", url, opts);
    }
    put(url, opts = {}) {
        return this.request("PUT", url, opts);
    }
    async request(method, url, opts = {}) {
        const followRedirects = opts.followRedirects !== false;
        const maxRedirects = opts.maxRedirects ?? 10;
        const reqTimeout = opts.timeoutMs ?? this.timeoutMs;
        let curMethod = method.toUpperCase();
        let curUrl = url;
        const curHeaders = lowerKeys(opts.headers || {});
        let curBody = encodeBody(opts, curHeaders);
        const history = [];
        for (let i = 0; i <= maxRedirects; i++) {
            // keep-alive 复用连接时，偶发拿到对端已半关闭的常驻 socket，复用即报 ECONNRESET/socket hang up。
            // 此前每请求新建连接没这风险；这里对「连接层错误」自动重试一次（坏 socket 会被 Agent 剔除，重试拿新连接）。
            let raw;
            try {
                raw = await this.rawRequest(curMethod, curUrl, curHeaders, curBody, reqTimeout);
            }
            catch (err) {
                if (!isRetriableConnError(err)) {
                    throw err;
                }
                raw = await this.rawRequest(curMethod, curUrl, curHeaders, curBody, reqTimeout);
            }
            this.jar.setFromResponse(curUrl, raw.headers["set-cookie"]);
            const status = raw.status;
            const location = raw.headers["location"] || "";
            const isRedirect = status >= 300 && status < 400 && location && followRedirects;
            if (!isRedirect) {
                return { status, url: curUrl, headers: raw.headers, text: raw.body, history };
            }
            history.push({ url: curUrl, status, location });
            const next = new url_1.URL(location, curUrl).toString();
            // 301/302/303 + 非 GET/HEAD：按浏览器/httpx 习惯转成 GET 并丢弃体；307/308 保持。
            if ((status === 301 || status === 302 || status === 303) && curMethod !== "GET" && curMethod !== "HEAD") {
                curMethod = "GET";
                curBody = undefined;
                delete curHeaders["content-type"];
                delete curHeaders["content-length"];
            }
            curUrl = next;
        }
        throw new Error(`重定向次数超过上限（${maxRedirects}）：${curUrl}`);
    }
    rawRequest(method, urlStr, perReqHeaders, body, timeoutMs = this.timeoutMs) {
        const u = new url_1.URL(urlStr);
        const isHttps = u.protocol === "https:";
        const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
        const headers = {
            ...this.baseHeaders,
            ...perReqHeaders,
            host: u.host,
        };
        const cookie = this.jar.cookieHeader(urlStr);
        if (cookie) {
            headers["cookie"] = cookie;
        }
        if (body && headers["content-length"] === undefined) {
            headers["content-length"] = String(body.length);
        }
        return new Promise((resolve, reject) => {
            const onResponse = (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString("utf8"),
                }));
                res.on("error", reject);
            };
            const finish = (req) => {
                req.on("error", reject);
                req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
                if (body) {
                    req.write(body);
                }
                req.end();
            };
            // 走代理
            if (this.proxy) {
                if (isHttps) {
                    // 经自定义 https Agent：复用「CONNECT 隧道 + TLS」套接字，握手按主机摊一次。
                    const req = https.request({
                        host: u.hostname,
                        port,
                        method,
                        path: u.pathname + u.search,
                        headers,
                        rejectUnauthorized: this.verify,
                        agent: this.httpsAgent,
                    }, onResponse);
                    finish(req);
                    return;
                }
                // http 目标走代理：绝对形式 URL 发给代理（keep-alive 复用到代理的连接）。
                const proxyPort = this.proxy.port ? Number(this.proxy.port) : 80;
                const req = http.request({
                    host: this.proxy.hostname,
                    port: proxyPort,
                    method,
                    path: urlStr,
                    headers: { ...headers, ...this.proxyAuthHeader() },
                    agent: this.httpAgent,
                }, onResponse);
                finish(req);
                return;
            }
            // 直连（keep-alive 复用连接）。
            const mod = isHttps ? https : http;
            const req = mod.request({
                host: u.hostname,
                port,
                method,
                path: u.pathname + u.search,
                headers,
                rejectUnauthorized: this.verify,
                agent: isHttps ? this.httpsAgent : this.httpAgent,
            }, onResponse);
            finish(req);
        });
    }
    proxyAuthHeader() {
        if (this.proxy && this.proxy.username) {
            const cred = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
            return { "proxy-authorization": "Basic " + Buffer.from(cred).toString("base64") };
        }
        return {};
    }
}
exports.HttpClient = HttpClient;
/** 连接层错误（与 HTTP 状态无关）：复用 keep-alive 坏 socket / 隧道断开时出现，安全重试一次即可。 */
function isRetriableConnError(err) {
    const code = err?.code || "";
    if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ECONNABORTED"].includes(code)) {
        return true;
    }
    const msg = err?.message || "";
    return /socket hang up|socket disconnected|代理 CONNECT 失败|代理连接超时/.test(msg);
}
function lowerKeys(h) {
    const out = {};
    for (const [k, v] of Object.entries(h)) {
        out[k.toLowerCase()] = v;
    }
    return out;
}
/** 按 form/json/body 生成请求体，并把 content-type 写进 headers（原地）。 */
function encodeBody(opts, headers) {
    if (opts.form !== undefined) {
        const usp = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.form)) {
            usp.append(k, v);
        }
        if (headers["content-type"] === undefined) {
            headers["content-type"] = "application/x-www-form-urlencoded";
        }
        return Buffer.from(usp.toString(), "utf8");
    }
    if (opts.json !== undefined) {
        if (headers["content-type"] === undefined) {
            headers["content-type"] = "application/json";
        }
        return Buffer.from(JSON.stringify(opts.json), "utf8");
    }
    if (opts.body !== undefined) {
        return Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf8");
    }
    return undefined;
}
//# sourceMappingURL=http.js.map