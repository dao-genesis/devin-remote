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
//        addons/rt-flow-mobile/src/relay.js 一致):
//   ① 客户端 (Termux/桌面 agent 或 浏览器扩展 SW) 出站连:
//        GET /connect?session=<id>&token=<t>   → WebSocket upgrade
//   ② 公网/另一台设备入站驱动:
//        POST /relay/<session>   Authorization: Bearer <t>
//        body = {"path":"/api/...","method":"POST","body":{...}}
//        中继把 {type:'request',id,path,method,body} 经 WSS 发给客户端,
//        等客户端回 {type:'response',id,status,body}, 原样作为 HTTP 响应返回。
//   ③ 心跳: 客户端每 15s 发 {type:'ping'}; 中继回 {type:'pong'}。
// ═══════════════════════════════════════════════════════════════════════════

const VERSION = "2.0.0"; // 对齐线上部署的 (session,token) 配对模型(health 报 v10)

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

// DO 命名空间定址: session 与 token 共同决定实例 —— 「知道 session+token」即凭证。
// 用 \u0000 作分隔(token/session 不含 NUL), 避免 "a"+"bc" 与 "ab"+"c" 撞键。
function relayKey(session, token) {
  return String(session) + "\u0000" + String(token);
}

// 可选私有模式闸门: 仅当部署设置了 env.DAO_TOKEN 才生效(锁定单一密钥); 默认开放配对。
function sharedTokenOk(env, token) {
  const shared = env && env.DAO_TOKEN ? String(env.DAO_TOKEN) : "";
  if (!shared) return true; // 未设共享密钥 = 零账号开放配对
  return token === shared;
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
export class RelayDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.agent = null; // 已连接的客户端 socket (server 端)
    this.pending = new Map(); // id -> { resolve, timer }
    this.seq = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);

    // 客户端 WSS 接入
    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      // 新连接顶替旧连接 (断线重连即覆盖)
      if (this.agent) { try { this.agent.close(1000, "replaced"); } catch (e) {} }
      this.agent = server;
      server.addEventListener("message", (ev) => this.onAgentMessage(ev));
      server.addEventListener("close", () => { if (this.agent === server) this.agent = null; });
      server.addEventListener("error", () => { if (this.agent === server) this.agent = null; });
      return new Response(null, { status: 101, webSocket: client });
    }

    // 公网入站 → 转发给客户端
    if (!this.agent) {
      return json({ error: "no_agent", hint: "no connected agent matches this session+token" }, 502);
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
        this.agent.send(JSON.stringify({ type: "request", id, path: reqPath, method, body }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ status: 502, body: { error: "send_failed", detail: String((e && e.message) || e) } });
      }
    });
    return json(out.body, out.status || 200);
  }

  onAgentMessage(ev) {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    if (m.type === "ping") { try { this.agent.send(JSON.stringify({ type: "pong" })); } catch (e) {} return; }
    if (m.type === "pong") return;
    if (m.type === "response" && m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve({ status: m.status || 200, body: m.body });
    }
  }
}

// 纯函数导出供单测(Node 可直接 import, 不触碰 Cloudflare 运行时全局)。
export { relayKey, sharedTokenOk, VERSION };
