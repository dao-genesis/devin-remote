"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// relay.js · 扩展内「内网穿透客户端」(service worker 出站 WSS 连中继)
//
// 二合一之骨: 把 dao-bridge 的「出站 WSS 连中继」这条腿从 Termux 搬进扩展 SW。
//   MV3 service worker 本就能开出站 WebSocket → 直连 Cloudflare Worker 中继,
//   把 25 条浏览器 RPC 暴给公网入站驱动。Termux 整条腿砍掉, 零部署。
//
// 协议 (与 addons/dao-relay/worker.js + dao-bridge/core.js 完全一致):
//   出站: wss://<relay>/connect?session=<id>&token=<t>
//   入站帧: {type:'request', id, path, method, body}
//   回帧:   {type:'response', id, status, body}
//   心跳:   每 15s 发 {type:'ping'}, 收 {type:'pong'} 忽略。
//
// 安全边界 (道法自然·能边界要诚实): 此扩展天然无 shell/文件系统能力,
//   relay 入站只接「义 B · 浏览器 RPC 白名单」, 显式拒绝任何 shell 类路由。
// ═══════════════════════════════════════════════════════════════════════════

const DaoRelay = (function () {
  // 浏览器 RPC 白名单 (= popup 同源的能力, 绝不含 shell)
  const WHITELIST = new Set([
    "getState", "addAccount", "parseAndAdd", "exportAccounts", "accountOverview",
    "runningSessions", "exportConversation", "backupAllSessions", "exportKnowledge",
    "exportPlaybooks", "stopSession", "gitStatus", "gitConnectPat", "gitBatchConnectPat",
    "gitDisconnect", "wipeAccount", "removeAccount", "login", "activate", "refreshQuota",
    "refreshAllQuota", "saveSettings", "openAccountTab", "closeAccountTab", "listTabs",
  ]);
  // 显式拒绝的 shell 类路由 (dao-bridge 的 6 条) — 即便有人尝试也明确回 403
  const SHELL_ROUTES = new Set([
    "/api/exec", "/api/command", "/api/read", "/api/file", "/api/write", "/api/ls", "/api/info", "/api/device",
  ]);

  let sock = null, connected = false, stopped = true, dispatchFn = null;
  let cfg = { url: "", token: "", session: "" };
  let backoff = 2000, pingTimer = null, reTimer = null;
  let lastError = null, lastConnectTs = 0, lastFrameTs = 0;

  // 纯函数: 把一帧入站请求映射成响应 (单测直接调)
  async function handleFrame(m) {
    const path = (m && m.path) || "/api/health";
    if (path === "/api/health") {
      return { status: 200, body: { status: "ok", service: "rt-flow-mobile", role: "browser-tunnel", session: cfg.session, ts: Date.now() } };
    }
    if (SHELL_ROUTES.has(path)) {
      return { status: 403, body: { error: "shell_disabled", hint: "此扩展只暴露浏览器 RPC (义 B)·天然无 shell 能力" } };
    }
    if (path === "/api/rpc") {
      const body = (m && m.body && typeof m.body === "object") ? m.body : {};
      const cmd = body.cmd || body.type;
      if (!cmd || !WHITELIST.has(cmd)) {
        return { status: 400, body: { error: "unknown_or_forbidden_cmd", cmd: cmd || null, allowed: Array.from(WHITELIST) } };
      }
      if (typeof dispatchFn !== "function") return { status: 503, body: { error: "dispatch_unavailable" } };
      try {
        const args = Object.assign({}, body); delete args.cmd; delete args.type;
        const res = await dispatchFn(Object.assign({ type: cmd }, args));
        return { status: 200, body: res };
      } catch (e) {
        return { status: 500, body: { error: String((e && e.message) || e) } };
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
    if (!base || !cfg.token || !cfg.session) { lastError = "未配置 relay (url/token/session)"; return; }
    const wsUrl = base.replace(/^http/, "ws") + "/connect?session=" + encodeURIComponent(cfg.session) + "&token=" + encodeURIComponent(cfg.token);
    try { sock = new WebSocket(wsUrl); } catch (e) { lastError = String((e && e.message) || e); schedule(); return; }
    sock.onopen = () => {
      connected = true; backoff = 2000; lastConnectTs = Date.now(); lastError = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { sock.send(JSON.stringify({ type: "ping" })); } catch (e) {} }, 15000);
    };
    sock.onmessage = async (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
      if (!m) return;
      if (m.type === "pong") return;
      if (m.type === "request" && m.id) {
        lastFrameTs = Date.now();
        const out = await handleFrame(m);
        try { sock.send(JSON.stringify({ type: "response", id: m.id, status: out.status, body: out.body })); } catch (e) {}
      }
    };
    sock.onclose = () => { connected = false; if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } schedule(); };
    sock.onerror = () => { lastError = "websocket error"; try { sock.close(); } catch (e) {} };
  }

  return {
    // start: 配置 + 注入 dispatch (background.js 的纯函数), 立即出站连
    start(config, dispatch) {
      cfg = Object.assign({}, config);
      if (typeof dispatch === "function") dispatchFn = dispatch;
      stopped = false; backoff = 2000;
      if (sock) { try { sock.close(); } catch (e) {} sock = null; }
      connected = false;
      open();
    },
    stop() {
      stopped = true; connected = false; clearTimers();
      try { sock && sock.close(); } catch (e) {}
      sock = null;
    },
    // 保活心跳: chrome.alarms 唤醒 SW 后调用, 确保连接在 (MV3 SW 会被回收)
    ensure() {
      if (stopped) return;
      if (!connected && !reTimer) open();
    },
    status() {
      return {
        connected, stopped, session: cfg.session, url: cfg.url,
        lastError, lastConnectTs, lastFrameTs,
        publicEndpoint: cfg.url ? (cfg.url.replace(/\/$/, "") + "/relay/" + cfg.session) : "",
      };
    },
    // 单测钩子
    _handleFrame: handleFrame,
    _whitelist: WHITELIST,
    _shellRoutes: SHELL_ROUTES,
    _setDispatch(fn) { dispatchFn = fn; },
    _setCfg(c) { cfg = Object.assign({}, c); },
  };
})();

if (typeof self !== "undefined") self.DaoRelay = DaoRelay;
if (typeof module !== "undefined" && module.exports) module.exports = { DaoRelay };
