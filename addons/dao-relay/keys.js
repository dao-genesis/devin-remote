"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-relay · 纯逻辑模块 (鉴权/定址) —— 与 Cloudflare 运行时解耦
//
// 道法自然: 把「定址 + 配对鉴权」抽成纯函数, 既供 worker.js 引用, 又供 node:test 直接
// import 单测。**不可**把这些从 worker.js 入口再导出 —— Workers 运行时(workerd)会把入口
// 模块的每个具名导出都当作 entrypoint(DO 类 / ExportedHandler)登记, 导出普通值/函数会让
// 运行时启动即报: "Incorrect type for map entry 'VERSION': not of type
// 'function or ExportedHandler'", 连带 `wrangler dev` / `wrangler deploy` 失败。
// 故归一于此独立模块, 入口只导出 default 处理器与 RelayDO 类。
// ═══════════════════════════════════════════════════════════════════════════

export const VERSION = "3.7.0-i-ws-proxy"; // (session,token) 配对模型 + WebSocket Hibernation(上量省钱) + GET /console 自托管单网页控制台 + 转发只选「活」socket + /i/ 反代补全 WebSocket 升级代理(注入鉴权·根治网页内 Devin「一直连接中」)。重新部署后 /health 报此值即生效。

// 从 hibernation 运行时回来的 WSS 列表里挑一个「确实 OPEN」的 agent socket。
//   病灶(真机实测): 旧逻辑直接取 getWebSockets() 末位 → 客户端断线重连的窗口里, 末位可能是
//   正在 CLOSING/CLOSED 的陈旧 socket, 对它 send() 抛 "Can't call WebSocket send() after close()"
//   → 公网侧「首发失败·重试才通」。此处据 readyState 过滤, 只回真正可写的连接。
//   readyState: 0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED (WebSocket.READY_STATE_OPEN===1)。
//   兼容性: 若运行时根本不暴露 readyState(全 undefined), 退化为旧行为(取末位), 绝不弄坏现状。
export function pickOpenAgent(sockets) {
  if (!Array.isArray(sockets) || sockets.length === 0) return null;
  const OPEN = 1;
  let sawReadyState = false;
  for (let i = sockets.length - 1; i >= 0; i--) {
    const ws = sockets[i];
    if (!ws) continue;
    const rs = ws.readyState;
    if (rs === OPEN) return ws;          // 最近接入的 OPEN 连接优先
    if (rs !== undefined && rs !== null) sawReadyState = true;
  }
  if (!sawReadyState) {                   // 运行时未报 readyState → 退化取末位(向后兼容)
    for (let i = sockets.length - 1; i >= 0; i--) if (sockets[i]) return sockets[i];
  }
  return null;
}

// DO 命名空间定址: session 与 token 共同决定实例 —— 「知道 session+token」即凭证。
// 用 \u0000 作分隔(token/session 不含 NUL), 避免 "a"+"bc" 与 "ab"+"c" 撞键。
export function relayKey(session, token) {
  return String(session) + "\u0000" + String(token);
}

// 可选私有模式闸门: 仅当部署设置了 env.DAO_TOKEN 才生效(锁定单一密钥); 默认开放配对。
export function sharedTokenOk(env, token) {
  const shared = env && env.DAO_TOKEN ? String(env.DAO_TOKEN) : "";
  if (!shared) return true; // 未设共享密钥 = 零账号开放配对
  return token === shared;
}

// 哈希不可变静态资源(字体/图片/wasm 等二进制): 内容与账号/前缀无关, 边缘反代不改写之 →
//   可在 caches.default + Cloudflare 缓存层强缓存。JS/CSS 不入此列(JS 含 __PXFX 预载补丁版本
//   敏感, CSS 烘焙前缀), 由上游 cache-control 自管, 避免历史踩坑(旧预载补丁被永缓 → 改版后
//   CSS 预载错位)。纯逻辑置此 → worker.js 引用且 node:test 可直测。
export function pxIsImmutableAsset(restPath) {
  const p = String(restPath || "").split("?")[0].toLowerCase();
  return /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp|wasm|mp3|mp4|webm|ogg)$/.test(p);
}

// 内容哈希过的代码包 (Vite `name-[hash].js|css|mjs`, hash≥8 位 base62) —— 上游字节不可变。
//   ⚠️ 与 pxIsImmutableAsset 不同: 这类文件 worker 仍需「每次重写」(注前缀/__PXFX 预载补丁版本敏感),
//   故**不**入 caches.default 缓存重写后的产物(避免历史踩坑: 旧预载补丁被永缓 → 改版后预载错位)。
//   仅用于给上游 fetch 挂 Cloudflare `cf.cacheEverything` 缓存层 —— 缓存的是 **app.devin.ai 原始字节**
//   (键为真实上游 URL, 全公网跨账号/用户共享), 重写照常每次跑 → 既省回源慢跳, 又无陈旧重写之虞。
//   严格要求 `-<8+位字母数字>.ext` 收尾, 不误匹配 main.js / index.css 等无哈希入口文件。
export function pxIsHashedCode(restPath) {
  const p = String(restPath || "").split("?")[0];
  return /-[A-Za-z0-9_]{8,}\.(?:js|mjs|css)$/.test(p);
}
