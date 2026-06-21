/*global UVServiceWorker, __uv$config */
// dao-relay · 注册到 scope=/uv/ 的 Service Worker 入口 (取自 UV 标准 sw.js)。
//   仅代理 /uv/service/ 前缀的请求 (uv.route); 其余 (frame.html / 资产) 直接放行。
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts("/uv/repair.js");
importScripts(__uv$config.sw || "/uv/uv.sw.js");

const uv = new UVServiceWorker();

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
