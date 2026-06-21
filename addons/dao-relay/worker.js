"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-relay · Cloudflare Worker + Durable Object 反向隧道中继
//
// 道法自然: 这是「内网穿透」唯一的外部依赖, 此前是仓外黑盒, 现归一入库。
//
// 鉴权模型 —— 帛书·「无名之朴」: 零账号配对, 而非单一共享密钥。
//   线上部署的 Worker(health 报 v10) 实测行为: 每个 (session, token) 组合是
//   一个独立命名空间(DO 由 session+token 共同定址)。客户端用**自己随机生成**的
//   token 出站连 /connect?session&token 即占用该命名空间; 公网侧必须同时知道
//   **相同的 session 与 token** 才能 POST /relay/<session> 驱动它(任一不符 →
//   no_agent)。也就是说「知道 session+token」本身就是凭证 —— 用户无需在 Worker
//   预置任何共享密钥, 插件每台机器随机一个 token 即可, 真正零配置零账号。
//
//   旧版本(本文件 v1)用单一共享 env.DAO_TOKEN 且 DO 仅按 session 定址, 与线上
//   部署及 dao-bridge 扩展的实际 UX 不符 —— 按旧版自建中继会让「零账号默认通道」
//   直接 401 失效。本次对齐线上配对模型。
//
//   可选私有模式: 若部署时设置了 env.DAO_TOKEN(wrangler secret), 则额外要求
//   连接/驱动所用 token 必须等于它 —— 把整个中继锁给一个固定密钥(企业自托管)。
//   不设 env.DAO_TOKEN(默认) = 开放配对, 零账号即用。
//
// 协议 (与 addons/dao-bridge/{core.js,dao-bridge-ext/extension.js}、
//        addons/rt-flow-app/app/src/main/assets/engine/relay-app.js 一致):
//   ① 客户端 (Termux/桌面 agent 或 浏览器扩展 SW) 出站连:
//        GET /connect?session=<id>&token=<t>   → WebSocket upgrade
//   ② 公网/另一台设备入站驱动:
//        POST /relay/<session>   Authorization: Bearer <t>
//        body = {"path":"/api/...","method":"POST","body":{...}}
//        中继把 {type:'request',id,path,method,body} 经 WSS 发给客户端,
//        等客户端回 {type:'response',id,status,body}, 原样作为 HTTP 响应返回。
//   ③ 心跳: 客户端每 15s 发 {type:'ping'}; 中继回 {type:'pong'}。
// ═══════════════════════════════════════════════════════════════════════════

// 鉴权/定址纯逻辑见 ./keys.js —— 不可从本入口再导出普通值/函数, 否则 workerd 启动即报错。
import { VERSION, relayKey, sharedTokenOk } from "./keys.js";

function bearer(req) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 网页内原生直渲 (Path A·中继 Worker 边缘反代) —— 道法自然·取之尽锱铢:
//   该网络下手机一切公网 HTTP 隧道(cloudflared/SSH)全 530/503 不可达, 唯出站 WSS 中继通。
//   故把仓库内早已验证的反代(core/rt-flow/devin_proxy.js 前缀模式: 剥 CSP/X-Frame-Options +
//   按号注 auth1 + localStorage 按账号命名空间隔离多实例不串号)直接搬到 Worker 边缘运行:
//     · POST /i-init {s,tk,acc,u} — 经唯一通的 WSS 中继向手机 vaultLoad 取该号 auth1/org,
//                                   存进 HttpOnly Cookie(auth1 不经页面 JS·不上 URL), 回 /i/<acc>/<u>
//     · /i/<accKey>/...           — 同源前缀代 app.devin.ai(+windsurf/codeium 辅源); 字节由
//                                   Worker 边缘**直取上游**(非经手机·无 WS 1MB 限·与手机隧道死活无关)
//                                   + 剥框限 + HTML 注入登录态/前缀化根绝对资源 + JS/CSS/JSON 改写。
//     · /e/<b64origin>/...        — 任意第三方站同源前缀代(剥框限·前缀化·无账号注入)。
//   控台 iframe 它即原生操作(不投屏); 不同账号落不同前缀命名空间 → 多实例并行互不串号。
// ═══════════════════════════════════════════════════════════════════════════
const PX_APP = "https://app.devin.ai";
const PX_WS = "https://windsurf.com";
const PX_REG = "https://register.windsurf.com";
const PX_CDN = "https://server.codeium.com";
const PX_SS = "https://server.self-serve.windsurf.com";
const PX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function pxCookies(req) {
  const h = req.headers.get("cookie") || "";
  const o = {};
  h.split(/;\s*/).forEach(function (p) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); });
  return o;
}
function pxSafeKey(s) { return String(s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48); }
function pxB64Enc(o) {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function pxB64Dec(s) {
  try { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return JSON.parse(new TextDecoder().decode(a)); }
  catch (e) { return null; }
}

// relay → 手机 vaultLoad accounts (isolate 内 60s 缓存, 免每次往返)
const _pxAcctCache = new Map(); // session -> {ts, arr}
async function pxLoadAccounts(env, session, token) {
  const hit = _pxAcctCache.get(session);
  if (hit && Date.now() - hit.ts < 60000) return hit.arr;
  const id = env.DAO_RELAY.idFromName(relayKey(session, token));
  const r = new Request("https://do/relay/" + encodeURIComponent(session), {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + token },
    body: JSON.stringify({ path: "/api/native", method: "POST", body: { m: "vaultLoad", a: ["accounts"] } }),
  });
  let arr = [];
  try {
    const resp = await env.DAO_RELAY.get(id).fetch(r);
    const j = await resp.json();
    let s = (j && j.r !== undefined) ? j.r : j;
    if (typeof s === "string") s = JSON.parse(s);
    arr = Array.isArray(s) ? s : ((s && (s.accounts || s.list)) || []);
  } catch (e) { arr = []; }
  if (arr.length) _pxAcctCache.set(session, { ts: Date.now(), arr: arr });
  return arr;
}
function pxFindAcct(arr, acc) {
  acc = String(acc || "");
  for (const a of arr) { if (a && (a.email === acc || a.id === acc || String(a.no) === acc)) return a; }
  const lc = acc.toLowerCase();
  for (const a of arr) { if (a && String(a.email || "").toLowerCase() === lc) return a; }
  return null;
}

function pxResolveUpstream(pathname) {
  if (pathname.startsWith("/__ws/")) return { base: PX_WS, path: pathname.slice(5) };
  if (pathname.startsWith("/__reg/")) return { base: PX_REG, path: pathname.slice(6) };
  if (pathname.startsWith("/__cdn/")) return { base: PX_CDN, path: pathname.slice(6) };
  if (pathname.startsWith("/__ss/")) return { base: PX_SS, path: pathname.slice(5) };
  return { base: PX_APP, path: pathname };
}

// 认证桥接 (前缀模式·源自 devin_proxy.js buildAuthBridge): nsShim 按 accKey 命名空间隔离 localStorage
//   → 同源多实例不串号; 注入 auth1/org 登录态种子; 拦 fetch/XHR/EventSource 归一前缀 + 挂 Authorization。
function pxAuthBridge(prefix, auth) {
  const J = JSON.stringify;
  const a1 = String(auth.auth1 || ""), uid = String(auth.userId || ""), org = String(auth.orgId || "");
  const on = String(auth.orgName || "").replace(/['"\\<>]/g, "");
  const P = prefix + "::";
  return "<script>(function(){try{" +
    "try{(function(){var L=window.localStorage;var P=" + J(P) + ";" +
    "var og=L.getItem.bind(L),os=L.setItem.bind(L),orm=L.removeItem.bind(L);" +
    "L.getItem=function(k){return og(P+k);};L.setItem=function(k,v){return os(P+k,v);};L.removeItem=function(k){return orm(P+k);};" +
    "L.clear=function(){try{var ks=[],i;for(i=0;i<L.length;i++){var kk=L.key(i);if(kk&&kk.indexOf(P)===0)ks.push(kk);}for(i=0;i<ks.length;i++)orm(ks[i]);}catch(e){}};" +
    "})();}catch(e){}" +
    "var __a1=" + J(a1) + ";var __uid=" + J(uid) + ";var __org=" + J(org) + ";var __orgName=" + J(on) + ";" +
    "if(__a1){localStorage.setItem('auth1_session',JSON.stringify({token:__a1,userId:__uid}));" +
    "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');" +
    "if(__uid)localStorage.setItem('known-org-ids-'+__uid,JSON.stringify([__org]));" +
    "if(__org)localStorage.setItem('last-internal-org-for-external-org-v1-null',__org);" +
    "if(__org&&__uid&&__orgName){var __k='post-auth-v3-null-'+__uid+'-org_name-'+__orgName;" +
    "if(!localStorage.getItem(__k))localStorage.setItem(__k,JSON.stringify({externalOrgId:null,userId:__uid,internalOrgId:__org,orgName:__orgName,result:{resolved_external_org_id:null,org_id:__org,org_name:__orgName,is_valid_resource:true}}));}}" +
    "document.cookie='webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';" +
    "var __base=" + J(prefix) + ";var __pfx=" + J(prefix) + ";var __abs='https://app.devin.ai';var __O=location.origin;window.__PXFX=__pfx;" +
    "var __pf=function(u){if(typeof u!=='string')return u;u=u.split(__abs).join(__O+__pfx);" +
    "if(u.indexOf(__O)===0){var p=u.slice(__O.length);if(p.charAt(0)==='/'&&p!==__pfx&&p.indexOf(__pfx+'/')!==0&&p.indexOf(__pfx)!==0){u=__O+__pfx+p;}return u;}" +
    "if(__pfx&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u!==__pfx&&u.indexOf(__pfx+'/')!==0){u=__pfx+u;}return u;};" +
    // 路由前缀虚拟化: SPA 路由器读 location.pathname 匹配路由; 故把地址栏前缀剥成根级
    //   → 路由器按根路由匹配渲染; 而 fetch/资源仍由 __pf 补 __pfx 前缀打到本账号 → 路由与取数解耦。
    "var __strip=function(u){if(typeof u!=='string')return u;u=u.split(__abs).join(__O);" +
    "if(__pfx){if(u.indexOf(__O+__pfx)===0){var r=u.slice((__O+__pfx).length)||'/';u=__O+(r.charAt(0)==='/'?r:'/'+r);}" +
    "else if(u.charAt(0)==='/'&&(u===__pfx||u.indexOf(__pfx+'/')===0)){var r2=u.slice(__pfx.length)||'/';u=r2.charAt(0)==='/'?r2:'/'+r2;}}return u;};" +
    "var _ps=history.pushState,_rs=history.replaceState;" +
    "try{var _la=window.location.assign.bind(window.location);window.location.assign=function(u){return _la(__strip(u));};}catch(e){}" +
    "try{var _lr=window.location.replace.bind(window.location);window.location.replace=function(u){return _lr(__strip(u));};}catch(e){}" +
    "try{history.pushState=function(s,t,u){return _ps.call(history,s,t,__strip(u));};}catch(e){}" +
    "try{history.replaceState=function(s,t,u){return _rs.call(history,s,t,__strip(u));};}catch(e){}" +
    "try{if(__pfx&&location.pathname.indexOf(__pfx)===0){var __sp=location.pathname.slice(__pfx.length)||'/';if(__sp.charAt(0)!=='/')__sp='/'+__sp;_rs.call(history,history.state,'',__sp+location.search+location.hash);}}catch(e){}" +
    "var needAuth=function(u){return typeof u==='string'&&(u.charAt(0)==='/'||u.indexOf(__base)===0);};" +
    "var oF=window.fetch;window.fetch=function(u,o){var nu=u;try{if(typeof u==='string'){nu=__pf(u);}else if(u&&u.url){var ru=__pf(u.url);nu=(ru!==u.url)?new Request(ru,u):u;}}catch(e){nu=u;}o=o||{};" +
    "if(typeof nu==='string'&&needAuth(nu)&&typeof o.headers==='object'&&o.headers&&!Array.isArray(o.headers)){if(!o.headers['Authorization'])o.headers['Authorization']='Bearer '+__a1;if(!o.headers['x-cog-org-id'])o.headers['x-cog-org-id']=__org;}" +
    "return oF.call(this,nu,o);};" +
    "var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var nu=(typeof u==='string')?__pf(u):u;" +
    "var r=oX.apply(this,[m,nu].concat([].slice.call(arguments,2)));if(needAuth(nu)){try{this.setRequestHeader('Authorization','Bearer '+__a1);this.setRequestHeader('x-cog-org-id',__org);}catch(e){}}return r;};" +
    "try{var _ES=window.EventSource;if(_ES){var nES=function(u,o){return new _ES(__pf(u),o);};nES.prototype=_ES.prototype;try{nES.CONNECTING=_ES.CONNECTING;nES.OPEN=_ES.OPEN;nES.CLOSED=_ES.CLOSED;}catch(e){}window.EventSource=nES;}}catch(e){}" +
    "}catch(e){}})();</script>";
}
// 第三方站轻量桥接: 仅运行时前缀化动态构造的根绝对/绝对 URL (无账号注入)。
function pxGenericBridge(prefix, origin) {
  const J = JSON.stringify;
  return "<script>(function(){try{var __pfx=" + J(prefix) + ";var __abs=" + J(origin) + ";var __O=location.origin;" +
    "var __pf=function(u){if(typeof u!=='string')return u;u=u.split(__abs).join(__O+__pfx);if(u.indexOf(__O)===0){var p=u.slice(__O.length);if(p.charAt(0)==='/'&&p!==__pfx&&p.indexOf(__pfx+'/')!==0&&p.indexOf(__pfx)!==0){u=__O+__pfx+p;}return u;}if(u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u!==__pfx&&u.indexOf(__pfx+'/')!==0){u=__pfx+u;}return u;};" +
    "var oF=window.fetch;window.fetch=function(u,o){var nu=u;try{if(typeof u==='string'){nu=__pf(u);}else if(u&&u.url){var ru=__pf(u.url);nu=(ru!==u.url)?new Request(ru,u):u;}}catch(e){nu=u;}return oF.call(this,nu,o);};" +
    "var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string')u=__pf(u);return oX.apply(this,[m,u].concat([].slice.call(arguments,2)));};" +
    "}catch(e){}})();</script>";
}

// 单请求边缘反代: Worker 直取上游 → 剥安全头 → HTML 注桥/前缀化 / JS·CSS·JSON 改写 / SSE 直通 / 余透传。
async function pxProxy(req, opts) {
  const prefix = opts.prefix;
  const isDevin = !opts.genericOrigin;
  const auth = opts.auth || {};
  let base, upath;
  if (isDevin) { const up = pxResolveUpstream(opts.restPath); base = up.base; upath = up.path; }
  else { base = opts.genericOrigin; upath = opts.restPath; }
  if (!upath || upath.charAt(0) !== "/") upath = "/" + (upath || "");
  let u;
  try { u = new URL(base + upath); } catch (e) { return new Response("bad_target", { status: 400 }); }

  const method = req.method || "GET";
  const fwd = new Headers();
  fwd.set("User-Agent", PX_UA);
  fwd.set("Accept", req.headers.get("accept") || "*/*");
  fwd.set("Origin", base);
  fwd.set("Referer", base + "/");
  let body;
  const ct = req.headers.get("content-type");
  if (method !== "GET" && method !== "HEAD") { body = await req.arrayBuffer(); if (ct) fwd.set("Content-Type", ct); }
  if (isDevin) {
    const clientAuth = req.headers.get("authorization");
    if (clientAuth) fwd.set("Authorization", clientAuth);
    else if (auth.auth1) fwd.set("Authorization", "Bearer " + auth.auth1);
    if (auth.orgId) fwd.set("x-cog-org-id", auth.orgId);
  }
  let up;
  try { up = await fetch(u.toString(), { method: method, headers: fwd, body: body, redirect: "manual" }); }
  catch (e) { return new Response("upstream_fetch_failed: " + String((e && e.message) || e), { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }); }

  const status = up.status;
  const rct = up.headers.get("content-type") || "";

  if (status >= 300 && status < 400) {
    let loc = up.headers.get("location") || "";
    if (loc) {
      if (isDevin) {
        loc = loc.split(PX_APP).join(prefix).split(PX_WS + "/").join(prefix + "/__ws/").split(PX_REG + "/").join(prefix + "/__reg/").split(PX_CDN + "/").join(prefix + "/__cdn/").split(PX_SS + "/").join(prefix + "/__ss/");
      } else {
        loc = loc.split(opts.genericOrigin).join(prefix);
      }
      if (loc.charAt(0) === "/" && loc.charAt(1) !== "/" && loc.indexOf(prefix + "/") !== 0 && loc !== prefix) loc = prefix + loc;
    }
    const h = new Headers(); if (loc) h.set("Location", loc); h.set("access-control-allow-origin", "*");
    return new Response(null, { status: status, headers: h });
  }

  const out = new Headers();
  up.headers.forEach(function (v, k) {
    const kl = k.toLowerCase();
    if (kl === "x-frame-options" || kl === "content-security-policy" || kl === "content-security-policy-report-only" ||
      kl === "strict-transport-security" || kl === "x-content-type-options" || kl === "content-encoding" ||
      kl === "content-length" || kl === "transfer-encoding") return;
    out.set(k, v);
  });
  out.set("access-control-allow-origin", "*");

  if (rct.includes("text/event-stream")) {
    out.set("content-type", rct || "text/event-stream");
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
    return new Response(up.body, { status: status, headers: out });
  }

  const isHtml = rct.includes("text/html");
  const isJs = rct.includes("javascript");
  // Connect-RPC 用 application/(connect+)json; 泛匹配 json → 必抓 webapp_host(否则 SPA host 校验失败硬跳真站)。
  const isJson = rct.includes("json");
  const isCss = rct.includes("text/css");

  if (isHtml) {
    let html = await up.text();
    if (isDevin) {
      html = html.split("https://app.devin.ai").join(prefix)
        .split("https://windsurf.com/").join(prefix + "/__ws/")
        .split("https://register.windsurf.com/").join(prefix + "/__reg/")
        .split("https://server.codeium.com/").join(prefix + "/__cdn/")
        .split("https://server.self-serve.windsurf.com/").join(prefix + "/__ss/");
    } else {
      html = html.split(opts.genericOrigin).join(prefix);
    }
    html = html.replace(/(\s(?:href|src|action)\s*=\s*)(["'])\/(?!\/)/gi, "$1$2" + prefix + "/");
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/ig, "");
    const bridge = isDevin ? pxAuthBridge(prefix, auth) : pxGenericBridge(prefix, opts.genericOrigin);
    if (/<head[^>]*>/i.test(html)) html = html.replace(/(<head[^>]*>)/i, "$1" + bridge);
    else if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, bridge + "</head>");
    else html = bridge + html;
    out.set("content-type", "text/html; charset=utf-8");
    return new Response(html, { status: status, headers: out });
  }
  if (isJs) {
    let txt = await up.text();
    if (isDevin && (txt.indexOf("https://app.devin.ai") >= 0 || txt.indexOf("https://windsurf.com/") >= 0 || txt.indexOf("https://register.windsurf.com/") >= 0 || txt.indexOf("https://server.codeium.com/") >= 0 || txt.indexOf("https://server.self-serve.windsurf.com/") >= 0)) {
      txt = txt.split("https://app.devin.ai").join(prefix).split("https://windsurf.com/").join(prefix + "/__ws/").split("https://register.windsurf.com/").join(prefix + "/__reg/").split("https://server.codeium.com/").join(prefix + "/__cdn/").split("https://server.self-serve.windsurf.com/").join(prefix + "/__ss/");
    }
    // Vite assetsURL(base="/") 不带前缀 → __vitePreload 的 CSS/模块预加载打到根区无账号路径失败。
    //   改写为读运行时 window.__PXFX(本账号前缀) → 预加载资源走 /i/<acc>/assets/...。
    let assetFix = false;
    if (isDevin) { const before = txt; txt = txt.replace(/function\(([A-Za-z_$][\w$]*)\)\{return`\/`\+\1\}/g, function (m, p) { return "function(" + p + "){return(window.__PXFX||\"\")+\"/\"+" + p + "}"; }); assetFix = (txt !== before); }
    if (!isDevin && txt.indexOf(opts.genericOrigin) >= 0) {
      txt = txt.split(opts.genericOrigin).join(prefix);
    }
    // 预加载助手被改写过 → 必随 Worker 版本更新 (体积极小); 防 immutable 缓存吃旧版导致 CSS 预加载失败。
    if (assetFix) out.set("cache-control", "no-cache");
    return new Response(txt, { status: status, headers: out });
  }
  if (isJson && isDevin) {
    let txt = await up.text();
    // host 校验真源: webapp_host 常下发为 null → SPA 回退到内置常量 app.devin.ai 硬跳真站。
    //   故把 null / 字符串值 一律改写成本 Worker host → e===location.host → 校验通过, 不跳。
    if (txt.indexOf("webapp_host") >= 0) txt = txt.replace(/("webapp_host"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|null)/g, '$1"' + opts.host + '"');
    return new Response(txt, { status: status, headers: out });
  }
  if (isCss) {
    let txt = await up.text();
    if (isDevin && txt.indexOf("https://app.devin.ai/") >= 0) txt = txt.split("https://app.devin.ai/").join(prefix + "/");
    else if (!isDevin && txt.indexOf(opts.genericOrigin) >= 0) txt = txt.split(opts.genericOrigin).join(prefix);
    return new Response(txt, { status: status, headers: out });
  }
  return new Response(up.body, { status: status, headers: out });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
        },
      });
    }

    // 健康检查 (免鉴权·便于探活)
    if (path === "/" || path === "/health") {
      return json({ status: "ok", service: "dao-relay", version: VERSION });
    }

    // 单网页控制台 (中继自托管) —— 道法自然·归一:
    //   任意公网设备打开 /console?session=<id>&token=<t> 即得整机:所有标签 + 网页内切换 +
    //   单页多实例 Devin + 实时投屏 + 反向点按/滚动/输入。即使设备侧 cloudflared/SSH/局域网
    //   全被拦截, 仅凭本中继的 /relay RPC 即可驱动(页面 endpoint 默认 location.origin → 同源
    //   走本 Worker 的 /relay/<session>, 无 CORS)。内容取自仓库内 console.html(单一真源,
    //   不在此重复), 5 分钟边缘缓存; 改 console.html 合并 main 后重新部署即生效。
    if (path === "/console" || path === "/app" || path === "/console.html") {
      const RAW = "https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/addons/rt-flow-app/app/src/main/assets/engine/console.html";
      try {
        const r = await fetch(RAW, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) return json({ error: "console_fetch_failed", status: r.status }, 502);
        const html = await r.text();
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=300",
          },
        });
      } catch (e) {
        return json({ error: "console_unavailable", detail: String((e && e.message) || e) }, 502);
      }
    }

    // 去中心化 P2P 客户端 (路线C): 任意公网设备打开 /p2p 即得 0账号直连页;
    //   仅填 session+token 即经公共 ntfy 信令 P2P 直连手机, 全程不经本 Worker。
    //   p2p-client.html 内相对引用 signal.js → 一并经 /signal.js 代理 raw。
    if (path === "/p2p" || path === "/p2p-client.html" || path === "/signal.js") {
      const file = (path === "/signal.js") ? "signal.js" : "p2p-client.html";
      const RAW = "https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/addons/rt-flow-app/app/src/main/assets/engine/" + file;
      try {
        const r = await fetch(RAW, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) return json({ error: "p2p_fetch_failed", status: r.status }, 502);
        const body = await r.text();
        return new Response(body, {
          headers: {
            "content-type": (file === "signal.js" ? "application/javascript" : "text/html") + "; charset=utf-8",
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=300",
          },
        });
      } catch (e) {
        return json({ error: "p2p_unavailable", detail: String((e && e.message) || e) }, 502);
      }
    }

    // 客户端出站连 (WSS)
    if (path === "/connect") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      const session = url.searchParams.get("session") || "";
      const t = url.searchParams.get("token") || bearer(req);
      if (!session) return json({ error: "session required" }, 400);
      if (!t) return json({ error: "token required" }, 401);
      if (!sharedTokenOk(env, t)) return json({ error: "unauthorized" }, 401);
      // 按 (session,token) 配对定址 —— 客户端用自己的随机 token 即占用该命名空间。
      const id = env.DAO_RELAY.idFromName(relayKey(session, t));
      return env.DAO_RELAY.get(id).fetch(req);
    }

    // 公网入站驱动
    if (path.startsWith("/relay/")) {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const t = bearer(req);
      if (!t) return json({ error: "token required" }, 401);
      if (!sharedTokenOk(env, t)) return json({ error: "unauthorized" }, 401);
      const session = decodeURIComponent(path.slice("/relay/".length));
      if (!session) return json({ error: "session required" }, 400);
      // 必须 session+token 都与已连接客户端一致才命中其 DO; 否则落到空实例 → no_agent。
      const id = env.DAO_RELAY.idFromName(relayKey(session, t));
      return env.DAO_RELAY.get(id).fetch(req);
    }

    // 网页内原生直渲: 账号初始化 — 经 WSS 取该号 auth → HttpOnly Cookie → 回 /i/<acc>/<u>
    if (path === "/i-init") {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      let b = {}; try { b = await req.json(); } catch (e) {}
      const session = String(b.s || ""), token = String(b.tk || ""), acc = String(b.acc || "");
      let u = String(b.u || "/");
      if (!session || !token || !acc) return json({ error: "i_init_params" }, 400);
      if (!sharedTokenOk(env, token)) return json({ error: "unauthorized" }, 401);
      const arr = await pxLoadAccounts(env, session, token);
      const a = pxFindAcct(arr, acc);
      if (!a || !a.auth1) return json({ error: "acct_not_found_or_no_auth", acc: acc }, 404);
      if (!u.startsWith("/")) u = "/" + u;
      const encAcc = encodeURIComponent(acc);
      const prefix = "/i/" + encAcc;
      const bundle = pxB64Enc({ auth1: a.auth1, userId: a.userId, orgId: a.orgId, orgName: a.orgName, email: a.email });
      const h = new Headers();
      h.set("content-type", "application/json");
      h.set("access-control-allow-origin", "*");
      h.append("Set-Cookie", "da_" + pxSafeKey(acc) + "=" + bundle + "; Path=" + prefix + "; Max-Age=7200; HttpOnly; Secure; SameSite=Lax");
      h.append("Set-Cookie", "ds=" + encodeURIComponent(session) + "; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax");
      h.append("Set-Cookie", "dt=" + encodeURIComponent(token) + "; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax");
      return new Response(JSON.stringify({ ok: true, redirect: prefix + u }), { headers: h });
    }

    // 网页内原生直渲: Devin 同源前缀代理 /i/<accKey>/...
    if (path.startsWith("/i/")) {
      const after = path.slice(3);
      const sl = after.indexOf("/");
      const encAcc = sl >= 0 ? after.slice(0, sl) : after;
      const acc = decodeURIComponent(encAcc);
      const prefix = "/i/" + encAcc;
      const restPath = (sl >= 0 ? after.slice(sl) : "/") + (url.search || "");
      const ck = pxCookies(req);
      let auth = ck["da_" + pxSafeKey(acc)] ? pxB64Dec(ck["da_" + pxSafeKey(acc)]) : null;
      if (!auth || !auth.auth1) {
        const s = ck.ds ? decodeURIComponent(ck.ds) : "", t = ck.dt ? decodeURIComponent(ck.dt) : "";
        if (s && t) { const arr = await pxLoadAccounts(env, s, t); const a = pxFindAcct(arr, acc); if (a && a.auth1) auth = { auth1: a.auth1, userId: a.userId, orgId: a.orgId, orgName: a.orgName }; }
      }
      if (!auth || !auth.auth1) {
        return new Response("<!doctype html><meta charset=utf-8><body style='font:15px system-ui;padding:24px;color:#c9d1d9;background:#0d1117'><h3>会话已过期</h3><p>请回控台重新打开此 Devin 实例。</p>", { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return pxProxy(req, { prefix: prefix, restPath: restPath, auth: auth, host: url.host });
    }

    // 任意第三方站同源前缀代理 /e/<b64origin>/...
    if (path.startsWith("/e/")) {
      const after = path.slice(3);
      const sl = after.indexOf("/");
      const encOrigin = sl >= 0 ? after.slice(0, sl) : after;
      let origin = "";
      try { origin = atob(encOrigin.replace(/-/g, "+").replace(/_/g, "/")); } catch (e) { origin = ""; }
      if (!/^https?:\/\//i.test(origin)) return json({ error: "bad_origin" }, 400);
      const prefix = "/e/" + encOrigin;
      const restPath = (sl >= 0 ? after.slice(sl) : "/") + (url.search || "");
      return pxProxy(req, { prefix: prefix, restPath: restPath, genericOrigin: origin.replace(/\/+$/, ""), host: url.host });
    }

    return json({ error: "not_found", path }, 404);
  },
};

// ── Durable Object: 每个 (session,token) 一个实例, 持有一条客户端 WSS + 在途请求表 ──
//
// 道法自然·上量必修(规模化第一杀手是「钱」而非架构): 本类用 WebSocket Hibernation API
//   (state.acceptWebSocket + webSocket* 回调 + setWebSocketAutoResponse 心跳自动应答) 替代
//   旧的 server.accept()+addEventListener 常驻监听。后果差异:
//     · 旧版: N 台手机常连 = N 个 DO **全天候按 wall-clock 计费**(即使没说话), 成本随在线设备线性烧。
//     · 新版: 连接空闲(无在途请求)时 DO 可被运行时驱逐出内存, **WSS 仍保活**; 15s 心跳由运行时
//             自动回 pong(DO 不必唤醒)→ 常连场景计费可降一个数量级。这是「用户量增多」后最该有的形态。
//   协议对外**完全不变**: /connect 出站、/relay/<session> POST 驱动、{type:request|response|ping|pong}
//   帧格式与旧版逐字节一致 → 现网手机/驱动方无需任何改动, 仅需重新部署本 Worker。
//
//   注: this.pending/this.seq 仍是内存态, 但每个公网请求在 fetch() 里 `await` 直到回包/60s 超时,
//   该 await 会把实例**钉在内存**直到本请求完结 → 配对的 pending 项必在同一活跃期创建并 resolve,
//   不受 hibernation 驱逐影响(驱逐只发生在「无在途请求」的空闲期)。
export class DaoRelayDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map(); // id -> { resolve, timer }
    this.seq = 0;
    this.rl = { windowStart: 0, count: 0 }; // 基础限流滑动窗口(内存·活跃期有效)
  }

  // 当前已连接的 agent socket: hibernation 下不持 this.agent, 而从运行时取活跃 WSS。
  // 一个 DO 对应一台设备(一条连接); 顶替后只剩最新一条, 取末位即当前 agent。
  agentSocket() {
    let list = [];
    try { list = this.state.getWebSockets() || []; } catch (e) { list = []; }
    return list.length ? list[list.length - 1] : null;
  }

  async fetch(req) {
    const url = new URL(req.url);

    // 客户端 WSS 接入 (Hibernation: 用 state.acceptWebSocket, 空闲可驱逐、WSS 保活)
    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      // 新连接顶替旧连接 (断线重连即覆盖); 关闭所有既有 hibernatable 连接。
      try {
        for (const ws of (this.state.getWebSockets() || [])) {
          try { ws.close(1000, "replaced"); } catch (e) {}
        }
      } catch (e) {}
      this.state.acceptWebSocket(server);
      // 心跳自动应答: 客户端每 15s 发 {"type":"ping"} → 运行时直接回 {"type":"pong"},
      // DO 无需从 hibernation 唤醒 → 常连不烧 CPU 时长。请求串必须与客户端逐字节一致。
      try {
        this.state.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair(JSON.stringify({ type: "ping" }), JSON.stringify({ type: "pong" }))
        );
      } catch (e) {}
      return new Response(null, { status: 101, webSocket: client });
    }

    // 公网入站 → 转发给客户端
    const agent = this.agentSocket();
    if (!agent) {
      return json({ error: "no_agent", hint: "no connected agent matches this session+token" }, 502);
    }
    // 基础限流: 单实例(=单设备)滑动 10s 窗口上限, 防失控/被滥用驱动; 正常手动操作远不及此。
    if (!this.rateOk()) {
      return json({ error: "rate_limited", hint: "too many requests for this session+token; slow down" }, 429);
    }
    let frame = {};
    try { frame = await req.json(); } catch (e) { frame = {}; }
    const reqPath = frame.path || "/api/health";
    const method = frame.method || "GET";
    const body = frame.body !== undefined ? frame.body : {};
    const id = "r" + (++this.seq) + "-" + Date.now();

    const out = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 504, body: { error: "agent_timeout" } });
      }, 60000);
      this.pending.set(id, { resolve, timer });
      try {
        agent.send(JSON.stringify({ type: "request", id, path: reqPath, method, body }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ status: 502, body: { error: "send_failed", detail: String((e && e.message) || e) } });
      }
    });
    return json(out.body, out.status || 200);
  }

  rateOk() {
    const WIN = 10000, MAX = 120; // 10s 内 ≤120 次驱动 (单设备手动操作绰绰有余, 失控/暴力则截断)
    const now = Date.now();
    if (now - this.rl.windowStart > WIN) { this.rl.windowStart = now; this.rl.count = 0; }
    this.rl.count++;
    return this.rl.count <= MAX;
  }

  // ── Hibernation 回调 (替代 addEventListener; 运行时在有消息/关闭/错误时唤醒并调用) ──
  webSocketMessage(ws, message) {
    let m;
    try {
      const s = (typeof message === "string") ? message : new TextDecoder().decode(message);
      m = JSON.parse(s);
    } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    if (m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch (e) {} return; } // 兜底(正常由 auto-response 处理)
    if (m.type === "pong") return;
    if (m.type === "response" && m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve({ status: m.status || 200, body: m.body });
    }
  }
  webSocketClose(ws, code, reason, wasClean) { try { ws.close(code, reason); } catch (e) {} }
  webSocketError(ws, err) { /* 运行时会随后回调 close; 无需额外处理 */ }
}

