/*global UVServiceWorker, __uv$config */
// dao-relay · 注册到 scope=/uv/ 的 Service Worker 入口 (取自 UV 标准 sw.js)。
//   仅代理 /uv/service/ 前缀的请求 (uv.route); 其余 (frame.html / 资产) 直接放行。
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts("/uv/repair.js");
importScripts(__uv$config.sw || "/uv/uv.sw.js");

// === dao-relay: Service Worker 内无 SharedWorker/localStorage → 直连 /bare/v3/ 传输 ===
// UV 的 UVServiceWorker 构造里 `new Ultraviolet.BareClient` (= bare-mux) 会读
// `new SharedWorker(...)` 与 `localStorage['bare-mux-path']`。但 ServiceWorkerGlobalScope
// 规范【既不暴露 SharedWorker 也不暴露 localStorage】→ 构造即抛 → SW 顶层脚本报错 →
// install 失败 → SW 永不激活 → frame.html 永远卡在「注册 Service Worker」
// (这正是线上「网页内容基本用不了」的总根因: 引擎根本没在浏览器里跑起来)。
// 本设计的传输本就是 bare-as-module3 (纯 HTTP → 本源 /bare/v3/), 与 bare-mux 无关。
// 故: 构造前把 Ultraviolet.BareClient 换成惰性占位(构造不触碰任何 SW 不可用的全局),
//     构造后再把 uv.bareClient 换成直连 /bare/v3/ 的纯 HTTP 适配器
//     (同源带 uv_auth Cookie → Devin 登录态注入)。
self.Ultraviolet.BareClient = function () {};

// bare v3 头部 split/join (与 baremod / worker.js bareJoinHeaders 同协议)。
const DAO_BARE_MAX_HEADER = 3072;
function daoSplitBareHeaders(headers) {
  const v = headers.get("x-bare-headers");
  if (v && v.length > DAO_BARE_MAX_HEADER) {
    headers.delete("x-bare-headers");
    let split = 0;
    for (let i = 0; i < v.length; i += DAO_BARE_MAX_HEADER) {
      headers.set("x-bare-headers-" + (split++), ";" + v.slice(i, i + DAO_BARE_MAX_HEADER));
    }
  }
  return headers;
}
function daoJoinBareHeaders(headers) {
  if (headers.has("x-bare-headers-0")) {
    const parts = [];
    headers.forEach(function (value, key) {
      const m = /^x-bare-headers-(\d+)$/.exec(key.toLowerCase());
      if (m && value.charAt(0) === ";") parts[parseInt(m[1], 10)] = value.slice(1);
    });
    return parts.join("");
  }
  return headers.get("x-bare-headers") || "{}";
}

const uv = new UVServiceWorker();

// 用直连本源 /bare/v3/ 的纯 HTTP 适配器替换 bare-mux(SharedWorker)客户端。
// UV 的响应包装类按 .rawHeaders/.status/.statusText/.body 读取, 改写分支另用 .text() ——
// 故返回对象须同时提供这些 (body=上游字节流, text/arrayBuffer 透传)。
uv.bareClient = {
  async fetch(url, opts) {
    opts = opts || {};
    const remote = new URL(url);
    const reqHeaders = Object.assign({}, opts.headers || {});
    if ("host" in reqHeaders) reqHeaders.host = remote.host; else reqHeaders.Host = remote.host;
    const bh = new Headers();
    bh.set("x-bare-url", remote.toString());
    bh.set("x-bare-headers", JSON.stringify(reqHeaders));
    daoSplitBareHeaders(bh);
    const fopts = {
      method: opts.method || "GET",
      credentials: "same-origin", // 携 uv_auth Cookie 至本源 /bare/v3/ → 登录态注入
      headers: bh,
      redirect: "manual",
      signal: opts.signal,
      duplex: "half"
    };
    if (opts.body !== undefined && opts.body !== null) fopts.body = opts.body;
    const resp = await fetch("/bare/v3/?cache=" + encodeURIComponent(remote.toString()), fopts);
    if (!resp.ok) {
      let eb; try { eb = await resp.json(); } catch (e) { eb = { message: "bare error " + resp.status }; }
      throw new Error((eb && (eb.message || eb.code)) || ("bare error " + resp.status));
    }
    const rawHeaders = JSON.parse(daoJoinBareHeaders(resp.headers) || "{}");
    return {
      body: resp.body,
      finalURL: remote.toString(),
      rawHeaders: rawHeaders,
      status: parseInt(resp.headers.get("x-bare-status") || String(resp.status), 10),
      statusText: resp.headers.get("x-bare-status-text") || resp.statusText,
      text: function () { return resp.text(); },
      arrayBuffer: function () { return resp.arrayBuffer(); },
      json: function () { return resp.json(); },
      blob: function () { return resp.blob(); }
    };
  },
  connect: function () { throw new Error("dao-relay SW transport: ws connect handled in page"); }
};

// 把 repair.js 的「标签误伤」修复挂进 UV 自身的 JS 重写管线(无需二次读响应体)。
try {
  const probe = new self.Ultraviolet(self.__uv$config);
  const jsproto = probe.js && probe.js.constructor && probe.js.constructor.prototype;
  if (jsproto && typeof jsproto.rewrite === "function" && !jsproto.__daoPatched) {
    const orig = jsproto.rewrite;
    jsproto.rewrite = function (t, r) {
      const out = orig.call(this, t, r);
      return typeof out === "string" ? repairUvJs(out) : out;
    };
    jsproto.__daoPatched = true;
  }
} catch (e) { /* 探测失败不致命: handleRequest 仍可继续 */ }

// 新 SW 立即接管(skipWaiting)并控制已存在的客户端(clients.claim) ——
//   否则首屏 frame.html 刚注册时 SW 尚未 controlling, 嵌套 iframe 的 /uv/service 请求会漏到网络。
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

// 相对裸路径自愈: 现代 Vite SPA 的动态 chunk 用 import.meta.url 在运行时拼 URL,
//   UV 把 import.meta.url 模拟成【已编码的代理 URL】, 于是 `new URL('cron-xxx.js', meta)`
//   解析成 /uv/service/cron-xxx.js (未经 XOR 编码) → UV 解码失败抛 500。
//   这里在交给 UV 前拦截: 若 /uv/service/ 后缀解不出合法 http(s) URL, 就用 Referer(其后缀
//   解码出 importer 真 URL) 把这个相对裸路径解析成真 URL, 再 XOR 编码后 302 跳到规范代理路径。
function uvSelfHealEncoded(req) {
  try {
    const prefix = self.__uv$config.prefix;            // "/uv/service/"
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return null;
    if (url.pathname.indexOf(prefix) !== 0) return null;
    const raw = url.pathname.slice(prefix.length);
    let decoded = "";
    try { decoded = self.__uv$config.decodeUrl(raw); } catch (e) { decoded = ""; }
    if (/^https?:\/\//i.test(decoded)) return null;    // 已是合法编码 → 交给 UV
    const ref = req.referrer || "";
    const ri = ref.indexOf(prefix);
    if (ri < 0) return null;
    let refReal = "";
    try { refReal = self.__uv$config.decodeUrl(new URL(ref).pathname.slice(prefix.length)); } catch (e) { refReal = ""; }
    if (!/^https?:\/\//i.test(refReal)) return null;
    const real = new URL(raw + (url.search || ""), refReal).href;
    return self.location.origin + prefix + self.__uv$config.encodeUrl(real);
  } catch (e) { return null; }
}

async function handleRequest(event) {
  const healed = uvSelfHealEncoded(event.request);
  if (healed) return Response.redirect(healed, 302);
  if (uv.route(event)) {
    return await uv.fetch(event);
  }
  return await fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
