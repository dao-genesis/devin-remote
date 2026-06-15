"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// relay-app.js · APP 版「内网穿透客户端」(WebView 页内出站 WSS 连中继)
//
// 与 addons/rt-flow-mobile/src/relay.js 同协议、同安全边界, 区别:
//   · 命令注册表由 engine 注入 (DaoRelayApp.register), 含切号 25 RPC + 管理命令
//   · 多一条管理通道 hotpatch/persistModule → 隔隧道热修 (用户私有 token 已门禁)
//   · 跑在 WebView 页, 非 service worker; WebSocket/timer 原生可用
//
// 协议 (与 dao-relay/worker.js 完全一致):
//   出站: wss://<relay>/connect?session=<id>&token=<t>
//   入站帧: {type:'request', id, path, method, body}
//   回帧:   {type:'response', id, status, body}
// ═══════════════════════════════════════════════════════════════════════════

const DaoRelayApp = (function () {
  // 显式拒绝的 shell 类路由 — 即便有人尝试也明确回 403 (APP 同样天然无 shell)
  const SHELL_ROUTES = new Set([
    "/api/exec", "/api/exec-sync", "/api/command", "/api/read", "/api/file",
    "/api/write", "/api/ls", "/api/info", "/api/device",
  ]);

  const COMMANDS = Object.create(null); // cmd -> async fn(args)
  let sock = null, connected = false, stopped = true;
  let cfg = { url: "", token: "", session: "" };
  let backoff = 2000, pingTimer = null, reTimer = null;
  let lastError = null, lastConnectTs = 0, lastFrameTs = 0;
  let onStatus = null;

  function emitStatus() {
    if (typeof onStatus === "function") {
      try { onStatus({ connected, session: cfg.session, lastError, lastConnectTs, lastFrameTs }); } catch (e) {}
    }
  }

  async function handleFrame(m) {
    const path = (m && m.path) || "/api/health";
    if (path === "/api/health") {
      return { status: 200, body: { status: "ok", service: "rt-flow-app", role: "browser-tunnel", session: cfg.session, ts: Date.now(), cmds: Object.keys(COMMANDS) } };
    }
    if (SHELL_ROUTES.has(path)) {
      return { status: 403, body: { error: "shell_disabled", hint: "此 APP 只暴露浏览器 RPC·天然无 shell 能力" } };
    }
    if (path === "/api/rpc") {
      const body = (m && m.body && typeof m.body === "object") ? m.body : {};
      const cmd = body.cmd || body.type;
      if (!cmd || !COMMANDS[cmd]) {
        return { status: 400, body: { error: "unknown_or_forbidden_cmd", cmd: cmd || null, allowed: Object.keys(COMMANDS) } };
      }
      try {
        const args = Object.assign({}, body); delete args.cmd; delete args.type;
        const res = await COMMANDS[cmd](args);
        return { status: 200, body: res };
      } catch (e) {
        return { status: 500, body: { error: String((e && e.message) || e), stack: e && e.stack } };
      }
    }
    return { status: 404, body: { error: "not_found", path } };
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reTimer) { clearTimeout(reTimer); reTimer = null; }
  }
  function schedule() {
    if (stopped || reTimer) return;
    reTimer = setTimeout(() => { reTimer = null; if (!connected) open(); }, backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
  function open() {
    if (stopped) return;
    const base = (cfg.url || "").replace(/\/$/, "");
    if (!base || !cfg.token || !cfg.session) { lastError = "未配置 relay (url/token/session)"; emitStatus(); return; }
    const wsUrl = base.replace(/^http/, "ws") + "/connect?session=" + encodeURIComponent(cfg.session) + "&token=" + encodeURIComponent(cfg.token);
    try { sock = new WebSocket(wsUrl); } catch (e) { lastError = String((e && e.message) || e); schedule(); return; }
    sock.onopen = () => {
      connected = true; backoff = 2000; lastConnectTs = Date.now(); lastError = null; emitStatus();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { sock.send(JSON.stringify({ type: "ping" })); } catch (e) {} }, 15000);
    };
    sock.onmessage = async (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
      if (!m || m.type === "pong") return;
      if (m.type === "request" && m.id) {
        lastFrameTs = Date.now();
        const out = await handleFrame(m);
        try { sock.send(JSON.stringify({ type: "response", id: m.id, status: out.status, body: out.body })); } catch (e) {}
      }
    };
    sock.onclose = () => { connected = false; emitStatus(); if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } schedule(); };
    sock.onerror = () => { lastError = "websocket error"; try { sock.close(); } catch (e) {} };
  }

  return {
    register(map) { Object.assign(COMMANDS, map || {}); },
    setStatusCb(fn) { onStatus = fn; },
    start(config) {
      cfg = Object.assign({}, config);
      stopped = false; backoff = 2000; clearTimers();
      try { if (sock) sock.close(); } catch (e) {}
      open();
      return this.status();
    },
    stop() { stopped = true; clearTimers(); try { if (sock) sock.close(); } catch (e) {} connected = false; emitStatus(); },
    ensure() { if (!stopped && !connected && !reTimer) open(); },
    status() { return { connected, session: cfg.session, url: cfg.url, publicEndpoint: cfg.url ? cfg.url.replace(/\/$/, "") + "/relay/" + cfg.session : "", lastError, lastConnectTs, lastFrameTs, cmds: Object.keys(COMMANDS) }; },
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = { DaoRelayApp };
