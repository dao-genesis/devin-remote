"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// relay-app.js · APP 版「内网穿透客户端」(WebView 页内出站 WSS 连中继)
//
// 与 addons/dao-bridge/core.js 同协议、同安全边界, 区别:
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
  const COMMANDS = Object.create(null); // cmd -> async fn(args)
  let sock = null, connected = false, stopped = true;
  let cfg = { url: "", token: "", session: "" };
  let backoff = 1500, pingTimer = null, reTimer = null, connectTimer = null;
  let lastError = null, lastConnectTs = 0, lastFrameTs = 0;
  let onStatus = null;
  // ── 多中继端点·自动故障转移 (国内无感: workers.dev 常被运营商 SNI 拦截,
  //    可在 url 里用逗号/空格/换行分隔多个端点, 例如自有域名镜像; 客户端逐个轮询直到连通) ──
  let candidates = [];      // [baseUrl, ...] 去尾斜杠
  let candIdx = 0;          // 当前尝试的端点下标
  let activeUrl = null;     // 当前连通的端点
  let attempts = 0;         // 累计连接尝试次数
  const BACKOFF_MIN = 1500, BACKOFF_MAX = 20000, CONNECT_TIMEOUT = 10000;

  function parseCandidates(c) {
    let list = [];
    if (Array.isArray(c.urls)) list = c.urls.slice();
    const u = (c.url || "");
    if (Array.isArray(u)) list = list.concat(u);
    else if (typeof u === "string") list = list.concat(u.split(/[\s,]+/));
    const seen = Object.create(null), out = [];
    for (let s of list) {
      s = (s || "").trim().replace(/\/$/, "");
      if (!s || !/^https?:\/\//i.test(s) || seen[s]) continue;
      seen[s] = 1; out.push(s);
    }
    return out;
  }

  function emitStatus() {
    if (typeof onStatus === "function") {
      try { onStatus({ connected, session: cfg.session, lastError, lastConnectTs, lastFrameTs, activeUrl, attempts, candidates: candidates.slice() }); } catch (e) {}
    }
  }

  // 失败时探测当前端点可达性, 把模糊的 "websocket error" 细化为可操作的诊断。
  function probeHealth(base) {
    try {
      const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      if (ctrl) setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 5000);
      fetch(base + "/health", { method: "GET", signal: ctrl ? ctrl.signal : undefined })
        .then((r) => { if (!connected) { lastError = r && r.ok ? "⚠️ 中继可达但 WSS 握手被拦截 → 请开启 VPN/科学上网后重连 (国内网络常拦截 WebSocket 升级)" : ("中继返回 " + (r && r.status) + " (请检查 token/session 是否正确)"); emitStatus(); } })
        .catch(() => { if (!connected) { lastError = "⚠️ 连不上中继 (" + shortHost(base) + ") → 请开启 VPN/科学上网后重连。国内网络会屏蔽 workers.dev, 无 VPN 时无法连通。"; emitStatus(); } });
    } catch (e) {}
  }
  function shortHost(u) { try { return new URL(u).host; } catch (e) { return u; } }

  async function handleFrame(m) {
    const path = (m && m.path) || "/api/health";
    if (path === "/api/health") {
      return { status: 200, body: { status: "ok", service: "devin-cloud-mobile", role: "browser-tunnel", session: cfg.session, ts: Date.now(), cmds: Object.keys(COMMANDS) } };
    }
    // v0.6.0 · 最大化暴露 · 不害怕方能成其大
    if (path === "/api/info" || path === "/api/device") {
      const N = typeof Native !== "undefined" ? Native : {};
      return { status: 200, body: {
        ua: navigator.userAgent, platform: navigator.platform, lang: navigator.language,
        screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio, orient: (screen.orientation||{}).type },
        engine: { cmds: Object.keys(COMMANDS), count: Object.keys(COMMANDS).length },
        relay: { connected, session: cfg.session, lastConnectTs, lastFrameTs, lastError },
        tabs: N.listTabs ? (function(){ try{ return JSON.parse(N.listTabs()||"[]"); }catch(e){ return []; } })() : [],
        ts: Date.now()
      }};
    }
    if (path === "/api/read" || path === "/api/file") {
      const name = (m.body && m.body.name) || "";
      if (!name) return { status: 400, body: { error: "need body.name" } };
      const N = typeof Native !== "undefined" ? Native : {};
      if (!N.readFile) return { status: 501, body: { error: "readFile bridge unavailable" } };
      return { status: 200, body: { name, content: N.readFile(name) } };
    }
    if (path === "/api/write") {
      const name = (m.body && m.body.name) || "";
      const content = (m.body && typeof m.body.content === "string") ? m.body.content : "";
      if (!name) return { status: 400, body: { error: "need body.name + body.content" } };
      const N = typeof Native !== "undefined" ? Native : {};
      if (!N.writeFile) return { status: 501, body: { error: "writeFile bridge unavailable" } };
      N.writeFile(name, content);
      return { status: 200, body: { ok: true, name, bytes: content.length } };
    }
    if (path === "/api/tabs" || path === "/api/ls") {
      const N = typeof Native !== "undefined" ? Native : {};
      return { status: 200, body: N.listTabs ? (function(){ try{ return JSON.parse(N.listTabs()||"[]"); }catch(e){ return []; } })() : [] };
    }
    if (path === "/api/exec" || path === "/api/exec-sync" || path === "/api/command") {
      return { status: 501, body: { error: "shell_unavailable", hint: "Android 应用无 shell 能力 (非 403; 物理上不可用)。用 /api/rpc 调用 " + Object.keys(COMMANDS).length + " 条 RPC 命令代替。" } };
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
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }
  function schedule() {
    if (stopped || reTimer) return;
    // 已尝试一整轮端点后再退避; 轮内快速切换下一个端点
    const oneRound = candidates.length <= 1 || (attempts % candidates.length === 0);
    const delay = oneRound ? backoff : 600;
    reTimer = setTimeout(() => { reTimer = null; if (!connected) open(); }, delay);
    if (oneRound) backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }
  function open() {
    if (stopped) return;
    if (!candidates.length) candidates = parseCandidates(cfg);
    if (!candidates.length || !cfg.token || !cfg.session) { lastError = "未配置 relay (url/token/session)"; emitStatus(); return; }
    const base = candidates[candIdx % candidates.length];
    attempts++;
    const wsUrl = base.replace(/^http/, "ws") + "/connect?session=" + encodeURIComponent(cfg.session) + "&token=" + encodeURIComponent(cfg.token);
    let mySock;
    try { mySock = new WebSocket(wsUrl); sock = mySock; } catch (e) { lastError = String((e && e.message) || e); candIdx++; probeHealth(base); schedule(); return; }
    // 连接看门狗: CONNECT_TIMEOUT 内未 open 视为该端点卡死 (GFW 常致 CONNECTING 长挂) → 关闭+切端点+重连
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (!connected && sock === mySock) {
        lastError = "连接超时 (" + shortHost(base) + " 无响应)"; probeHealth(base);
        try { mySock.close(); } catch (e) {}
        candIdx++; emitStatus(); schedule();
      }
    }, CONNECT_TIMEOUT);
    mySock.onopen = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      connected = true; backoff = BACKOFF_MIN; lastConnectTs = Date.now(); lastError = null; activeUrl = base; emitStatus();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { mySock.send(JSON.stringify({ type: "ping" })); } catch (e) {} }, 15000);
    };
    mySock.onmessage = async (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
      if (!m || m.type === "pong") return;
      if (m.type === "request" && m.id) {
        lastFrameTs = Date.now();
        // 端到端加密: 入站 body 为密文信封 {__e2e__:1,c} → 经原生桥解密后再分发 (中继全程只见密文)
        var enc = false;
        var N = (typeof Native !== "undefined") ? Native : null;
        if (m.body && m.body.__e2e__ && N && N.e2eOpen) {
          try { var dec = N.e2eOpen(m.body.c); if (dec) { m.body = JSON.parse(dec); enc = true; } else { m.body = {}; } }
          catch (e) { m.body = {}; }
        }
        const out = await handleFrame(m);
        var sendBody = out.body;
        // 仅对加密入站做加密出站 → 明文驱动仍得明文响应 (向后兼容)
        if (enc && N && N.e2eSeal) {
          try { var sealed = N.e2eSeal(JSON.stringify(out.body)); if (sealed) sendBody = { __e2e__: 1, c: sealed }; } catch (e) {}
        }
        try { mySock.send(JSON.stringify({ type: "response", id: m.id, status: out.status, body: sendBody })); } catch (e) {}
      }
    };
    mySock.onclose = () => {
      if (sock !== mySock) return;
      const wasConnected = connected; connected = false;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (!wasConnected) candIdx++;   // 没连上就掉线 → 换下一个端点
      emitStatus(); schedule();
    };
    mySock.onerror = () => { if (!connected) { lastError = "WSS 握手失败 (" + shortHost(base) + ")"; } try { mySock.close(); } catch (e) {} };
  }

  return {
    register(map) { Object.assign(COMMANDS, map || {}); },
    setStatusCb(fn) { onStatus = fn; },
    start(config) {
      cfg = Object.assign({}, config);
      stopped = false; backoff = BACKOFF_MIN; candIdx = 0; attempts = 0; activeUrl = null;
      candidates = parseCandidates(cfg);
      clearTimers();
      try { if (sock) sock.close(); } catch (e) {}
      open();
      return this.status();
    },
    stop() { stopped = true; clearTimers(); try { if (sock) sock.close(); } catch (e) {} connected = false; emitStatus(); },
    ensure() { if (!stopped && !connected && !reTimer && !connectTimer) open(); },
    status() {
      const primary = activeUrl || candidates[0] || (typeof cfg.url === "string" ? cfg.url.replace(/\/$/, "") : "");
      return { connected, session: cfg.session, url: primary, activeUrl, candidates: candidates.slice(), attempts,
        publicEndpoint: primary ? primary + "/relay/" + cfg.session : "", lastError, lastConnectTs, lastFrameTs, cmds: Object.keys(COMMANDS) };
    },
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = { DaoRelayApp };
