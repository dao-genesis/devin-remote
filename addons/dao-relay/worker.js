"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-relay · Cloudflare Worker + Durable Object 反向隧道中继
//
// 道法自然: 这是「内网穿透」唯一的外部依赖, 此前是仓外黑盒, 现归一入库。
//
// 协议 (与 addons/dao-bridge/core.js connectRelay + rt-flow-mobile relay 客户端一致):
//   ① 客户端 (Termux agent 或 浏览器扩展 SW) 出站连:
//        GET /connect?session=<id>&token=<t>   → WebSocket upgrade
//        中继校验 token, 把该 socket 登记到 idFromName(session) 的 DO 实例。
//   ② 公网/另一台设备入站驱动:
//        POST /relay/<session>   Authorization: Bearer <t>
//        body = {"path":"/api/...","method":"POST","body":{...}}
//        中继把 {type:'request',id,path,method,body} 经 WSS 发给客户端,
//        等客户端回 {type:'response',id,status,body}, 原样作为 HTTP 响应返回。
//   ③ 心跳: 客户端每 15s 发 {type:'ping'}; 中继回 {type:'pong'}。
//
// 单一共享 token (wrangler secret DAO_TOKEN); session 命名空间隔离多个客户端。
// ═══════════════════════════════════════════════════════════════════════════

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
    const token = env.DAO_TOKEN || "";

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
      return json({ status: "ok", service: "dao-relay", version: "1.0.0" });
    }

    // 客户端出站连 (WSS)
    if (path === "/connect") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      const session = url.searchParams.get("session") || "";
      const t = url.searchParams.get("token") || bearer(req);
      if (!session) return json({ error: "session required" }, 400);
      if (!token || t !== token) return json({ error: "unauthorized" }, 401);
      const id = env.RELAY.idFromName(session);
      return env.RELAY.get(id).fetch(req);
    }

    // 公网入站驱动
    if (path.startsWith("/relay/")) {
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!token || bearer(req) !== token) return json({ error: "unauthorized" }, 401);
      const session = decodeURIComponent(path.slice("/relay/".length));
      if (!session) return json({ error: "session required" }, 400);
      const id = env.RELAY.idFromName(session);
      return env.RELAY.get(id).fetch(req);
    }

    return json({ error: "not_found", path }, 404);
  },
};

// ── Durable Object: 每个 session 一个实例, 持有一条客户端 WSS + 在途请求表 ──
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
      return json({ error: "no_agent", hint: "no connected agent matches this token" }, 502);
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
