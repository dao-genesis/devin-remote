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

    // 客户端出站连 (WSS)
    if (path === "/connect") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      const session = url.searchParams.get("session") || "";
      const t = url.searchParams.get("token") || bearer(req);
      if (!session) return json({ error: "session required" }, 400);
      if (!t) return json({ error: "token required" }, 401);
      if (!sharedTokenOk(env, t)) return json({ error: "unauthorized" }, 401);
      // 按 (session,token) 配对定址 —— 客户端用自己的随机 token 即占用该命名空间。
      const id = env.RELAY.idFromName(relayKey(session, t));
      return env.RELAY.get(id).fetch(req);
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
      const id = env.RELAY.idFromName(relayKey(session, t));
      return env.RELAY.get(id).fetch(req);
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
export class RelayDO {
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

