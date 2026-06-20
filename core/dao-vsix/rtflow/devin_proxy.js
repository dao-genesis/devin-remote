// ═══════════════════════════════════════════════════════════════════════════
// devin_proxy.js · v4.14.0 · IDE 内置浏览器自足注入反代 (不赖 dao-vsix) · 静态资源缓存提速 (内存 L1 + 磁盘 L2)
// ───────────────────────────────────────────────────────────────────────────
// 帛书·「天下之至柔·驰骋于天下之致坚；无有入于无间」: IDE 内置浏览器 (simpleBrowser /
//   webview) 是受沙箱约束的 iframe — 无 CDP 端口可控, 无法如系统浏览器般经 CDP
//   addScriptToEvaluateOnNewDocument 种 localStorage。故以本地反向代理为「无间」之道:
//   localhost:port 代 app.devin.ai 取页 → 剥 X-Frame-Options/CSP → <head> 起注入
//   localStorage['auth1_session'] 登录态 → SPA 自判已登录, 零 GUI/OAuth/反代依赖。
// 帛书·「鸡犬相闻·民至老死不相往来」: 每账号独立端口 (独立 origin) → localStorage 隔离 →
//   IDE 内多标签各登各号, 多实例并行不相悖。
// 零外部依赖: 仅 Node 内建 http/https/net/zlib。技法 1:1 移植自 dao-vsix 已验证反代。
// ═══════════════════════════════════════════════════════════════════════════
"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DEVIN_APP = "https://app.devin.ai";
const DEVIN_WS = "https://windsurf.com";
const DEVIN_REG = "https://register.windsurf.com";
const DEVIN_CDN = "https://server.codeium.com";
const DEVIN_SS = "https://server.self-serve.windsurf.com";
const DEVIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// v4.9.6 · E: keep-alive 连接池 — 根治「IDE 内路由官网非常慢」。SPA 一次加载数百请求,
//   旧实现每请求新建 TLS 握手 (默认 agent keepAlive=false) → 串行重握手即是卡顿主因。
//   复用 socket 后首屏与切页显著提速; maxSockets 适度并行, 空闲 15s 回收。
const _httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 16, timeout: 60000 });

// email → { server, port, auth }. 每账号独立端口 → origin 隔离 → 多实例不串号。
const _servers = new Map();

// 帛书·「为之于其未有·治之于其未乱」— 静态资源改写结果缓存。
//   Devin SPA 的 JS/CSS/字体 bundle 皆哈希不可变, 改写结果恒定 → 缓存后多标签/重载
//   免重复取上游 + 免重复多次全量 split/join (根治"很慢很卡")。键 = 上游 path,
//   与账号无关 (静态资源各账号同一份) → 跨账号共享, 多开更省。
const _assetCache = new Map(); // targetPath → { status, headers, body }
let _assetCacheBytes = 0;
const ASSET_CACHE_MAX = 96 * 1024 * 1024; // 96MB 上限 · 满则逐出最早
function _cachePut(key, val) {
  try {
    if (_assetCache.has(key)) {
      const old = _assetCache.get(key);
      _assetCacheBytes -= old && old.body ? old.body.length : 0;
      _assetCache.delete(key);
    }
    _assetCache.set(key, val);
    _assetCacheBytes += val.body ? val.body.length : 0;
    while (_assetCacheBytes > ASSET_CACHE_MAX && _assetCache.size) {
      const k = _assetCache.keys().next().value;
      const v = _assetCache.get(k);
      _assetCache.delete(k);
      _assetCacheBytes -= v && v.body ? v.body.length : 0;
    }
  } catch {}
}
// 哈希不可变静态资源 (可强缓存 + 入改写缓存)。HTML/API/json 不在此列 (动态·须实时)。
function isCacheableAsset(p) {
  return /\.(js|css|woff2?|ttf|eot|otf|png|jpe?g|gif|svg|ico|wasm)(\?|$)/i.test(p);
}

// ═══ 磁盘二级缓存 (L2) ═══════════════════════════════════════════════════════
// 帛书·「夫物芸芸·各复归其根」: 上面的内存缓存随进程消亡, IDE 重载/重开后内存全空,
//   首屏须重新取上游 + 全量改写 (即"首屏很慢很卡"之根)。故落盘一份: 重载后内存 miss →
//   从磁盘秒级恢复, 免上游往返与全量改写。键 = sha1(上游 path); 跨账号/跨进程共享。
//   注意: JS/CSS 改写体里 baked 了 localBase(含动态端口), 重载后端口可能不同 → 落盘
//   时一并记 base, 命中时若 base 变则仅对文本体做一次 split/join 重定基 (二进制资源里
//   绝不含 base 串, 直发不动以免坏字节)。
const ASSET_DISK_MAX = 256 * 1024 * 1024; // 256MB 磁盘上限 · 满则按 mtime 逐出最旧
let _diskDir = null;
let _diskEvicted = false;
function _diskCacheDir() {
  // 显式 env 覆盖 (运维/单测) 每次生效; 默认路径解析一次即缓存。
  const env = process.env.WAM_PROXY_CACHE_DIR;
  if (env) {
    try { fs.mkdirSync(env, { recursive: true }); return env; } catch { return ""; }
  }
  if (_diskDir !== null) return _diskDir;
  try {
    const d = path.join(os.homedir(), ".wam", "_proxy_asset_cache");
    fs.mkdirSync(d, { recursive: true });
    _diskDir = d;
  } catch {
    _diskDir = "";
  }
  return _diskDir;
}
function _diskKey(key) {
  return crypto.createHash("sha1").update(String(key)).digest("hex");
}
function _isTextCt(headers) {
  try {
    const ct = String((headers && (headers["Content-Type"] || headers["content-type"])) || "").toLowerCase();
    return ct.includes("javascript") || ct.includes("application/x-javascript") || ct.includes("text/css");
  } catch { return false; }
}
// 文本资源落盘时 baked 了旧 localBase(含动态端口); 命中时若端口已变则重定基。
//   仅文本体做 split/join — 二进制资源(字体/图片/wasm)里绝无 base 串, 直发不动以免坏字节。
function _rebaseAsset(body, fromBase, toBase, isText) {
  if (isText && fromBase && toBase && fromBase !== toBase) {
    return Buffer.from(body.toString("utf8").split(fromBase).join(toBase), "utf8");
  }
  return body;
}
// 落盘 (异步·尽力而为·不阻塞请求)。先写临时文件再 rename → 防半成品被读到。
function _diskPut(key, val, base) {
  try {
    const dir = _diskCacheDir();
    if (!dir || !val || !val.body) return;
    const h = _diskKey(key);
    const binPath = path.join(dir, h + ".bin");
    const metaPath = path.join(dir, h + ".json");
    const meta = { status: val.status, headers: val.headers, base: base || "", text: _isTextCt(val.headers), size: val.body.length, t: Date.now() };
    const tmpBin = binPath + ".tmp" + process.pid;
    const tmpMeta = metaPath + ".tmp" + process.pid;
    fs.writeFile(tmpBin, val.body, (e1) => {
      if (e1) { try { fs.unlink(tmpBin, () => {}); } catch {} return; }
      fs.rename(tmpBin, binPath, () => {
        fs.writeFile(tmpMeta, JSON.stringify(meta), (e2) => {
          if (e2) { try { fs.unlink(tmpMeta, () => {}); } catch {} return; }
          fs.rename(tmpMeta, metaPath, () => {});
        });
      });
    });
    if (!_diskEvicted) { _diskEvicted = true; setTimeout(_diskEvict, 2000); }
  } catch {}
}
// 读盘 (异步)。命中返回 { status, headers, body, base, text }, 否则 null。
function _diskGet(key) {
  return new Promise((resolve) => {
    try {
      const dir = _diskCacheDir();
      if (!dir) return resolve(null);
      const h = _diskKey(key);
      const binPath = path.join(dir, h + ".bin");
      const metaPath = path.join(dir, h + ".json");
      fs.readFile(metaPath, "utf8", (em, metaStr) => {
        if (em) return resolve(null);
        let meta;
        try { meta = JSON.parse(metaStr); } catch { return resolve(null); }
        fs.readFile(binPath, (eb, body) => {
          if (eb || !body) return resolve(null);
          resolve({ status: meta.status, headers: meta.headers || {}, body, base: meta.base || "", text: !!meta.text });
        });
      });
    } catch { resolve(null); }
  });
}
// 容量逐出: 累计 .bin 体积超上限则按 mtime 删最旧 (连带其 .json)。启动后延迟跑一次。
function _diskEvict() {
  try {
    const dir = _diskCacheDir();
    if (!dir) return;
    fs.readdir(dir, (er, names) => {
      if (er || !names) return;
      const bins = names.filter((n) => n.endsWith(".bin"));
      const stats = [];
      let pending = bins.length;
      let total = 0;
      if (!pending) return;
      bins.forEach((n) => {
        const p = path.join(dir, n);
        fs.stat(p, (es, st) => {
          if (!es && st) { stats.push({ p, base: n.slice(0, -4), size: st.size, mtime: st.mtimeMs }); total += st.size; }
          if (--pending === 0) {
            if (total <= ASSET_DISK_MAX) return;
            stats.sort((a, b) => a.mtime - b.mtime);
            let cur = total;
            for (const s of stats) {
              if (cur <= ASSET_DISK_MAX) break;
              try { fs.unlink(s.p, () => {}); } catch {}
              try { fs.unlink(path.join(dir, s.base + ".json"), () => {}); } catch {}
              cur -= s.size;
            }
          }
        });
      });
    });
  } catch {}
}

function safeStr(s) {
  return String(s == null ? "" : s);
}

// 取空闲本地端口。
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on("error", () => resolve(0));
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address() && srv.address().port;
      srv.close(() => resolve(p || 0));
    });
  });
}

// 帛书·「观天之道·执天之行」— 认证桥接脚本 (运行于 SPA 任何引导脚本之前)。
// Devin SPA 登录态唯一真源 = localStorage['auth1_session'] = {token, userId}。
// 一并注入 org 键 + post-auth 守卫键, 并拦截 fetch/XHR 以挂 Authorization (同源相对请求)。
function buildAuthBridge(localBase, auth) {
  const a1 = safeStr(auth.auth1);
  const uid = safeStr(auth.userId);
  const org = safeStr(auth.orgId);
  // org_name 源自 Devin post-auth 响应; 仍剥引号/反斜杠/尖括号 → 杜绝 </script> 闭合逃逸。
  const orgName = safeStr(auth.orgName).replace(/['"\\<>]/g, "");
  const J = JSON.stringify;
  return (
    "<script>(function(){try{" +
    "var __a1=" + J(a1) + ";var __uid=" + J(uid) + ";var __org=" + J(org) + ";var __orgName=" + J(orgName) + ";" +
    "if(__a1){" +
    "localStorage.setItem('auth1_session',JSON.stringify({token:__a1,userId:__uid}));" +
    "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');" +
    "if(__uid)localStorage.setItem('known-org-ids-'+__uid,JSON.stringify([__org]));" +
    "if(__org)localStorage.setItem('last-internal-org-for-external-org-v1-null',__org);" +
    "if(__org&&__uid&&__orgName){var __k='post-auth-v3-null-'+__uid+'-org_name-'+__orgName;" +
    "if(!localStorage.getItem(__k))localStorage.setItem(__k,JSON.stringify({externalOrgId:null,userId:__uid,internalOrgId:__org,orgName:__orgName,result:{resolved_external_org_id:null,org_id:__org,org_name:__orgName,is_valid_resource:true}}));}" +
    "}" +
    "document.cookie='webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';" +
    "var __base=" + J(localBase) + ";var __abs='https://app.devin.ai';" +
    // 运行时兜底: 拦截动态构造的绝对 app.devin.ai 整页跳转(assign/replace/history)→ 改指本地代理,
    //   防 SPA 漏改字面量时仍硬跳真站致掉登录(JS/HTML 静态改写之外的双保险)。
    "var __fix=function(u){return (typeof u==='string')?u.split(__abs).join(__base):u;};" +
    "try{var _la=window.location.assign.bind(window.location);window.location.assign=function(u){return _la(__fix(u));};}catch(e){}" +
    "try{var _lr=window.location.replace.bind(window.location);window.location.replace=function(u){return _lr(__fix(u));};}catch(e){}" +
    "try{var _ps=history.pushState;history.pushState=function(s,t,u){return _ps.call(history,s,t,__fix(u));};}catch(e){}" +
    "try{var _rs=history.replaceState;history.replaceState=function(s,t,u){return _rs.call(history,s,t,__fix(u));};}catch(e){}" +
    "var needAuth=function(u){return typeof u==='string'&&(u.charAt(0)==='/'||u.indexOf(__base)===0);};" +
    "var oF=window.fetch;" +
    "window.fetch=function(u,o){if(typeof u!=='string')return oF.call(this,u,o);" +
    "var nu=u.split('https://app.devin.ai').join('');o=o||{};" +
    "if(needAuth(nu)&&typeof o.headers==='object'&&o.headers&&!Array.isArray(o.headers)){" +
    "if(!o.headers['Authorization'])o.headers['Authorization']='Bearer '+__a1;" +
    "if(!o.headers['x-cog-org-id'])o.headers['x-cog-org-id']=__org;}" +
    "return oF.call(this,nu,o);};" +
    "var oX=XMLHttpRequest.prototype.open;" +
    "XMLHttpRequest.prototype.open=function(m,u){var nu=(typeof u==='string')?u.split('https://app.devin.ai').join(''):u;" +
    "var r=oX.apply(this,[m,nu].concat([].slice.call(arguments,2)));" +
    "if(needAuth(nu)){try{this.setRequestHeader('Authorization','Bearer '+__a1);this.setRequestHeader('x-cog-org-id',__org);}catch(e){}}return r;};" +
    "}catch(e){}})();</script>"
  );
}

// 路径前缀 → 上游源站映射 (跨域认证资源经各自前缀透传)。
function resolveUpstream(pathname) {
  if (pathname.startsWith("/__ws/")) return { base: DEVIN_WS, path: pathname.slice(5) };
  if (pathname.startsWith("/__reg/")) return { base: DEVIN_REG, path: pathname.slice(6) };
  if (pathname.startsWith("/__cdn/")) return { base: DEVIN_CDN, path: pathname.slice(6) };
  if (pathname.startsWith("/__ss/")) return { base: DEVIN_SS, path: pathname.slice(5) };
  return { base: DEVIN_APP, path: pathname };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function decode(buf, enc) {
  return new Promise((resolve) => {
    if (enc === "gzip") zlib.gunzip(buf, (e, b) => resolve(e ? buf : b));
    else if (enc === "br") zlib.brotliDecompress(buf, (e, b) => resolve(e ? buf : b));
    else if (enc === "deflate") zlib.inflate(buf, (e, b) => resolve(e ? buf : b));
    else resolve(buf);
  });
}

// 单账号请求处理: 取上游 → 剥安全头 → HTML 注入登录态 / JS 改写绝对 URL / 其余透传。
async function handleRequest(req, res, auth, port, log) {
  const localBase = "http://localhost:" + port;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-cog-org-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || "/", localBase);
  const up = resolveUpstream(reqUrl.pathname);
  const targetUrl = up.base + up.path + (reqUrl.search || "");
  const u = new URL(targetUrl);
  const targetPath = u.pathname + (u.search || "");

  const isPage = !targetPath.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|ttf|eot|map|json|wasm)(\?|$)/i);

  // 改写缓存命中 → 直发, 免上游往返 + 免全量改写 (多标签/重载秒开)。
  const cacheable = (req.method === "GET" || !req.method) && isCacheableAsset(targetPath);
  if (cacheable) {
    const hit = _assetCache.get(targetPath);
    if (hit) {
      res.writeHead(hit.status, hit.headers);
      res.end(hit.body);
      return;
    }
    // L2: 内存未命中 → 查磁盘 (重载/重开后秒级恢复, 免上游往返与全量改写)。
    const disk = await _diskGet(targetPath);
    if (disk) {
      const body = _rebaseAsset(disk.body, disk.base, localBase, disk.text);
      _cachePut(targetPath, { status: disk.status, headers: disk.headers, body }); // 提升入内存
      res.writeHead(disk.status, disk.headers);
      res.end(body);
      return;
    }
  }

  let reqBody = Buffer.alloc(0);
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    reqBody = await readBody(req);
  }

  const fwdHeaders = {
    "User-Agent": DEVIN_UA,
    Accept: (req.headers && req.headers["accept"]) || "*/*",
    Host: u.hostname,
    "Accept-Encoding": "gzip",
    Origin: up.base,
    Referer: up.base + "/",
  };
  if (req.headers && req.headers["content-type"] && reqBody.length) {
    fwdHeaders["Content-Type"] = req.headers["content-type"];
    fwdHeaders["Content-Length"] = Buffer.byteLength(reqBody).toString();
  }
  // 客户端拦截器可能已挂 Authorization; 透传之, 否则服务端补该账号 auth1。
  const clientAuth = req.headers && req.headers["authorization"];
  if (clientAuth) fwdHeaders["Authorization"] = clientAuth;
  else if (auth.auth1) fwdHeaders["Authorization"] = "Bearer " + auth.auth1;
  if (auth.orgId) fwdHeaders["x-cog-org-id"] = auth.orgId;

  const proxyReq = https.request(
    {
      hostname: u.hostname,
      port: 443,
      path: targetPath,
      method: req.method || "GET",
      headers: fwdHeaders,
      timeout: 20000,
      rejectUnauthorized: false,
      agent: _httpsAgent,
    },
    (proxyRes) => {
      const status = proxyRes.statusCode || 200;
      const ct = proxyRes.headers["content-type"] || "";
      const enc = (proxyRes.headers["content-encoding"] || "").toLowerCase();

      // 3xx 重定向 → 改写 Location 指回本地代理。
      if (status >= 300 && status < 400) {
        let loc = proxyRes.headers["location"] || "";
        if (loc) {
          loc = loc
            .split(DEVIN_APP).join(localBase)
            .split(DEVIN_WS + "/").join(localBase + "/__ws/")
            .split(DEVIN_REG + "/").join(localBase + "/__reg/")
            .split(DEVIN_CDN + "/").join(localBase + "/__cdn/")
            .split(DEVIN_SS + "/").join(localBase + "/__ss/");
        }
        res.writeHead(status, loc ? { Location: loc } : {});
        res.end();
        proxyRes.resume();
        return;
      }

      // 安全头剥离 — 反代核心: 去 X-Frame-Options/CSP 方可嵌入 IDE iframe。
      const safeHeaders = {};
      for (const k of Object.keys(proxyRes.headers)) {
        const kl = k.toLowerCase();
        if (
          kl === "x-frame-options" ||
          kl === "content-security-policy" ||
          kl === "content-security-policy-report-only" ||
          kl === "strict-transport-security" ||
          kl === "x-content-type-options" ||
          kl === "content-encoding" ||
          kl === "content-length" ||
          kl === "transfer-encoding"
        )
          continue;
        safeHeaders[k] = proxyRes.headers[k];
      }

      // SSE 流式直通 (Devin Cloud 会话实时事件不可缓冲)。
      if (ct.includes("text/event-stream") && !res.headersSent) {
        const sh = {};
        for (const k of Object.keys(safeHeaders)) {
          if (["content-type", "cache-control", "connection"].includes(k.toLowerCase())) continue;
          sh[k] = safeHeaders[k];
        }
        sh["Content-Type"] = ct || "text/event-stream";
        sh["Cache-Control"] = "no-cache, no-transform";
        sh["Connection"] = "keep-alive";
        sh["X-Accel-Buffering"] = "no";
        try { proxyReq.setTimeout(0); } catch {}
        res.writeHead(status, sh);
        let src = proxyRes;
        if (enc === "gzip") src = proxyRes.pipe(zlib.createGunzip());
        else if (enc === "deflate") src = proxyRes.pipe(zlib.createInflate());
        else if (enc === "br") src = proxyRes.pipe(zlib.createBrotliDecompress());
        src.on("data", (c) => { try { res.write(c); } catch {} });
        const endS = () => { try { res.end(); } catch {} };
        src.on("end", endS);
        src.on("error", endS);
        res.on("close", () => { try { proxyReq.destroy(); } catch {} });
        return;
      }

      const chunks = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", async () => {
        const raw = Buffer.concat(chunks);
        const body = await decode(raw, enc);
        const isHtml = ct.includes("text/html");
        const isJs = ct.includes("javascript") || ct.includes("application/x-javascript");

        if (isHtml && isPage) {
          let html = body.toString("utf8");
          // 帛书·「大制不割」: 整源站前缀(任意结尾字符·含单/双引号/反引号/路径)统一改写,
          //   杜绝单引号 'https://app.devin.ai' 这类绝对 URL 漏改 → SPA 硬跳真站致掉登录。
          //   桥接脚本在本段之后再注入, 故其内置的 app.devin.ai 前缀剥离逻辑不受影响。
          html = html
            .split("https://app.devin.ai").join(localBase)
            .split("https://windsurf.com/").join(localBase + "/__ws/")
            .split("https://register.windsurf.com/").join(localBase + "/__reg/")
            .split("https://server.codeium.com/").join(localBase + "/__cdn/")
            .split("https://server.self-serve.windsurf.com/").join(localBase + "/__ss/");
          const bridge = buildAuthBridge(localBase, auth);
          // 认证桥接须先于 SPA 任何引导脚本 → 注入 <head> 起始 (紧随 charset meta)。
          if (/<head[^>]*>/i.test(html)) html = html.replace(/(<head[^>]*>)/i, "$1" + bridge);
          else if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, bridge + "</head>");
          else html = bridge + html;
          safeHeaders["Content-Type"] = "text/html; charset=utf-8";
          res.writeHead(status, safeHeaders);
          res.end(html, "utf8");
          return;
        }
        if (isJs) {
          // 仅当确含上游绝对URL才全量改写 → 多数 bundle 用相对路径, 跳过省大量 split/join。
          const txt = body.toString("utf8");
          let outBuf;
          if (
            txt.indexOf("https://app.devin.ai") >= 0 ||
            txt.indexOf("https://windsurf.com/") >= 0 ||
            txt.indexOf("https://register.windsurf.com/") >= 0 ||
            txt.indexOf("https://server.codeium.com/") >= 0 ||
            txt.indexOf("https://server.self-serve.windsurf.com/") >= 0
          ) {
            const js = txt
              .split("https://app.devin.ai").join(localBase)
              .split("https://windsurf.com/").join(localBase + "/__ws/")
              .split("https://register.windsurf.com/").join(localBase + "/__reg/")
              .split("https://server.codeium.com/").join(localBase + "/__cdn/")
              .split("https://server.self-serve.windsurf.com/").join(localBase + "/__ss/");
            outBuf = Buffer.from(js, "utf8");
          } else {
            outBuf = body; // 无需改写 → 直用原 buffer
          }
          if (cacheable) { delete safeHeaders["cache-control"]; safeHeaders["Cache-Control"] = "public, max-age=31536000, immutable"; }
          res.writeHead(status, safeHeaders);
          res.end(outBuf);
          if (cacheable && status === 200) {
            const entry = { status, headers: { ...safeHeaders }, body: outBuf };
            _cachePut(targetPath, entry);
            _diskPut(targetPath, entry, localBase);
          }
          return;
        }
        if (ct.includes("application/json")) {
          // 帛书·「域中有四大」: SPA 以 webapp_host 校验规范主机 —— location.host!==webapp_host 即
          //   `location.href=https://${webapp_host}/login?...` 硬跳真站(掉登录之真因)。反代下浏览器
          //   所见 host = 本地代理地址, 故把服务端下发的 webapp_host 改写为本次请求 Host, 令校验通过。
          let txt = body.toString("utf8");
          if (txt.indexOf("webapp_host") >= 0) {
            const reqHost = (req.headers && req.headers.host) ? String(req.headers.host) : ("localhost:" + port);
            txt = txt.replace(/("webapp_host"\s*:\s*")[^"]*(")/g, "$1" + reqHost + "$2");
          }
          res.writeHead(status, safeHeaders);
          res.end(Buffer.from(txt, "utf8"));
          return;
        }
        // CSS/字体/图片/wasm 等哈希不可变静态资源: CSS 按需改写, 余直发; 强缓存 + 入缓存。
        if (cacheable) {
          let outBuf = body;
          if (ct.includes("text/css")) {
            const t = body.toString("utf8");
            if (t.indexOf("https://app.devin.ai/") >= 0) {
              outBuf = Buffer.from(t.split("https://app.devin.ai/").join(localBase + "/"), "utf8");
            }
          }
          delete safeHeaders["cache-control"];
          safeHeaders["Cache-Control"] = "public, max-age=31536000, immutable";
          res.writeHead(status, safeHeaders);
          res.end(outBuf);
          if (status === 200) {
            const entry = { status, headers: { ...safeHeaders }, body: outBuf };
            _cachePut(targetPath, entry);
            _diskPut(targetPath, entry, localBase);
          }
          return;
        }
        res.writeHead(status, safeHeaders);
        res.end(body);
      });
    },
  );

  proxyReq.on("error", (e) => {
    if (log) try { log("[proxy] upstream error " + (e && e.message)); } catch {}
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("proxy error: " + (e && e.message));
    }
  });
  proxyReq.on("timeout", () => {
    try { proxyReq.destroy(); } catch {}
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("proxy timeout");
    }
  });
  if (reqBody.length) proxyReq.write(reqBody);
  proxyReq.end();
}

// 帛书·「为之于其未有」— 确保某账号的注入反代在跑, 返回其本地端口。
//   同账号复用同端口 (origin 稳定 → 标签复活态保持); 不同账号各占端口 → localStorage 隔离。
async function ensureProxyForAccount(email, auth, log) {
  if (!auth || !auth.auth1) return { ok: false, error: "no-auth1" };
  const key = String(email || "default").toLowerCase();
  const existing = _servers.get(key);
  if (existing && existing.port) {
    existing.auth = auth; // 刷新令牌 (auth1 可能已轮换)
    return { ok: true, port: existing.port, url: "http://localhost:" + existing.port + "/" };
  }
  const port = await pickFreePort();
  if (!port) return { ok: false, error: "no-port" };
  const entry = { server: null, port, auth };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, entry.auth, port, log).catch((e) => {
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("proxy fail: " + (e && e.message));
        } catch {}
      }
    });
  });
  entry.server = server;
  await new Promise((resolve) => {
    server.on("error", () => resolve());
    server.listen(port, "127.0.0.1", () => resolve());
  });
  _servers.set(key, entry);
  if (log) try { log("[proxy] " + key + " → http://localhost:" + port); } catch {}
  return { ok: true, port, url: "http://localhost:" + port + "/" };
}

function stopProxy(email) {
  const key = String(email || "default").toLowerCase();
  const e = _servers.get(key);
  if (e && e.server) try { e.server.close(); } catch {}
  _servers.delete(key);
}

function stopAll() {
  for (const e of _servers.values()) if (e.server) try { e.server.close(); } catch {}
  _servers.clear();
}

module.exports = {
  ensureProxyForAccount,
  stopProxy,
  stopAll,
  buildAuthBridge,
  // 供单测访问磁盘二级缓存内部 (非对外 API)。
  _diskCache: { _diskCacheDir, _diskKey, _diskPut, _diskGet, _diskEvict, _isTextCt, _rebaseAsset, ASSET_DISK_MAX },
};
