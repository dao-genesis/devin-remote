"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// signal.js · 路线C —— 0 账号 · 去中心化 WebRTC 信令 (道法自然·无为而无不为)
//
//   目标: 内网穿透「底层」彻底不依赖任何账号、也不依赖用户自建的 dao-relay Worker。
//   做法: 借公共 pub/sub 基础设施 (ntfy 协议: 公开实例多家、可自托管 → 去中心化、零注册)
//         只做一次性 SDP 交换信令; 之后数据走 WebRTC DataChannel (公共 STUN 打洞) P2P 直连,
//         全程不经任何中转。用户的 Worker 仅作最后兜底 (见 p2p-client.html / console.html)。
//
//   安全 (帛书·无名之朴 · 与中继同等级零账号配对):
//     · 会话定址: topic = H("topic\n"+session) → 不公开 session 本身, 等同共享秘密。
//     · 鉴权即加密: 信令载荷用 H(session+"\n"+token) 派生的 AES-GCM 密钥封装。应答方只有
//       成功解密(=对端确实知道 token) 才会 P2P.connect → token 充当准入门禁, 杜绝「只知 topic
//       即可驱动设备」。公共 broker 全程只见密文。要素同中继: 知道 session+token 即凭证。
//     · 防自激: 帧标 role(o=offer 客户端 / a=answer 应答方), 应答方只认 o、客户端只认 a。
//
//   依赖: WebCrypto (Chromium WebView file:// 亦 isSecureContext=true → crypto.subtle 可用)。
//         不可用时 serve() 拒绝去中心化信令(不降级安全), Worker 兜底仍在。
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  // 默认公共 ntfy 实例 (多家互不隶属 → 去中心化, 任一可达即通; 可自托管私有实例进一步去中心)。
  //   单一 broker 会被限流/封锁(实测 Cloudflare 免费 Worker 触发 1015 限流、GFW 拦 SNI),
  //   故默认就铺开多家**独立运营**的公共 ntfy 实例; 应答方对每家各持一条 WS 订阅、客户端向每家
  //   各发一份信令, 只要有一家可达握手即成 —— 任何单点限流/封锁都不致命。各实例均已实测
  //   支持匿名 POST 发布 + /<topic>/ws 订阅往返。
  var DEFAULT_SERVERS = ["https://ntfy.sh", "https://ntfy.envs.net", "https://ntfy.adminforge.de", "https://ntfy.mzte.de"];
  var CHUNK = 1200;          // 单条信令分片上限 (规避公共 broker 4KB 报文限制)
  var ANSWER_TIMEOUT = 25000;
  var RELAY_MAX_B64 = 48000; // 中继兜底单响应上限(~40 片); 控制面够用, 超出改走 P2P/Worker 防灌爆公共 broker
  var hasSubtle = (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function");
  // 多家公共 STUN (互不隶属 → 单点不可达不致命; 仅用于 NAT 反射地址发现, 不中转数据 → 仍 P2P 直连)。
  var STUN = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ];

  var TE = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;
  var TD = (typeof TextDecoder !== "undefined") ? new TextDecoder() : null;
  function b64(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function ub64(str) { var s = atob(str), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function sha256(str) { return crypto.subtle.digest("SHA-256", TE.encode(str)); }
  async function deriveKey(session, token) {
    var raw = await sha256(String(session) + "\n" + String(token) + "\ndao-sig");
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  async function topicFor(session) {
    var h = await sha256("topic\n" + String(session));
    var b = new Uint8Array(h), s = "";
    for (var i = 0; i < 12; i++) s += ("0" + b[i].toString(16)).slice(-2);
    return "dao" + s;   // 27 字符纯 alnum, 合法 ntfy topic
  }
  async function seal(key, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, TE.encode(JSON.stringify(obj)));
    var out = new Uint8Array(iv.length + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
    return b64(out.buffer);
  }
  async function unseal(key, b64str) {
    try {
      var raw = ub64(b64str), iv = raw.slice(0, 12), ct = raw.slice(12);
      var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
      return JSON.parse(TD.decode(pt));
    } catch (e) { return null; }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function normServers(s) {
    var list = Array.isArray(s) ? s.slice() : (typeof s === "string" && s ? s.split(/[\s,]+/) : []);
    var out = [], seen = Object.create(null);
    for (var i = 0; i < list.length; i++) { var u = (list[i] || "").trim().replace(/\/$/, ""); if (u && /^https?:\/\//i.test(u) && !seen[u]) { seen[u] = 1; out.push(u); } }
    return out.length ? out : DEFAULT_SERVERS.slice();
  }
  function frameChunks(corr, role, payloadB64) {
    var n = Math.ceil(payloadB64.length / CHUNK) || 1, out = [];
    for (var i = 0; i < n; i++) out.push(JSON.stringify({ v: 1, c: corr, r: role, i: i, n: n, p: payloadB64.slice(i * CHUNK, (i + 1) * CHUNK) }));
    return out;
  }
  function publish(servers, topic, frames) {
    for (var s = 0; s < servers.length; s++) {
      for (var f = 0; f < frames.length; f++) {
        try { fetch(servers[s] + "/" + topic, { method: "POST", body: frames[f] }); } catch (e) {}
      }
    }
  }
  function makeReasm() {
    var buf = Object.create(null);
    return function (msg, onComplete) {
      var m; try { m = JSON.parse(msg); } catch (e) { return; }
      if (!m || m.v !== 1 || !m.c || typeof m.p !== "string") return;
      var e = buf[m.c]; if (!e) e = buf[m.c] = { n: m.n, parts: new Array(m.n), got: 0, role: m.r, ts: Date.now() };
      if (e.parts[m.i] === undefined) { e.parts[m.i] = m.p; e.got++; }
      if (e.got >= e.n) { var full = e.parts.join(""); delete buf[m.c]; onComplete(m.c, m.r, full); }
      var now = Date.now(); for (var k in buf) if (now - buf[k].ts > 120000) delete buf[k];
    };
  }
  // 多服务器 WS 订阅 + 断线自动重连 (去中心化: 任一实例活着即收得到)。
  function subscribe(servers, topic, onMessage) {
    var socks = [], stopped = false;
    function dial(base) {
      if (stopped) return;
      var ws;
      try { ws = new WebSocket(base.replace(/^http/i, "ws") + "/" + topic + "/ws"); }
      catch (e) { setTimeout(function () { dial(base); }, 5000); return; }
      ws.onmessage = function (ev) {
        var d; try { d = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
        if (d && d.event === "message" && typeof d.message === "string") onMessage(d.message);
      };
      ws.onclose = function () { if (!stopped) setTimeout(function () { dial(base); }, 4000); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
      socks.push(ws);
    }
    servers.forEach(dial);
    return { close: function () { stopped = true; socks.forEach(function (w) { try { w.close(); } catch (e) {} }); } };
  }

  // ── 应答方 (手机引擎): 监听 topic, 解密 offer→P2P.connect→回 answer。零账号、不经 Worker。──
  //   connectFn(args) 返回 {ok, answer, ...} (即 window.P2P.connect)。
  async function serve(opts) {
    opts = opts || {};
    if (!hasSubtle) return { ok: false, error: "webcrypto_unavailable", hint: "该 WebView 无 crypto.subtle, 去中心化信令禁用(Worker 兜底仍可用)" };
    var session = opts.session, token = opts.token;
    var connectFn = opts.connect || (root.P2P && root.P2P.connect);
    if (!session || !token) return { ok: false, error: "need session+token" };
    if (typeof connectFn !== "function") return { ok: false, error: "need P2P.connect" };
    var servers = normServers(opts.servers);
    var key = await deriveKey(session, token);
    var topic = await topicFor(session);
    var handled = Object.create(null);   // nonce → ts (去重已处理 offer)
    var dhandled = Object.create(null);  // id → ts (去重已处理的中继 RPC)
    var reasm = makeReasm();
    var sub = subscribe(servers, topic, function (raw) {
      reasm(raw, async function (corr, role, full) {
        if (role === "o") {                       // 客户端 offer → P2P 握手
          var obj = await unseal(key, full);          // 解密失败=对端不知 token → 拒(门禁)
          if (!obj || obj.t !== "offer" || !obj.sdp) return;
          var nonce = obj.nonce || corr;
          if (handled[nonce]) return; handled[nonce] = Date.now();
          var res;
          try { res = await connectFn({ offer: obj.sdp, ice: obj.ice }); } catch (e) { res = { ok: false, error: String(e) }; }
          if (!res || !res.ok || !res.answer) return;
          var payload = await seal(key, { t: "answer", nonce: nonce, sdp: res.answer });
          publish(servers, topic, frameChunks(nonce, "a", payload));
          var now = Date.now(); for (var k in handled) if (now - handled[k] > 180000) delete handled[k];
          return;
        }
        if (role === "q") {                       // 路线 C-2 · 去中心化中继兜底
          // P2P ICE 打洞失败(对称/CGNAT)且 Worker 被封(GFW)时, 把**已加密**的控制面 RPC/ping
          //   帧经同一公共 ntfy mesh 转发应答 —— 仍零账号、零中心、任一 broker 活即通。门禁同握手:
          //   解密成功(=对端确实知 token)才应答; 公共 broker 全程只见密文。
          var q = await unseal(key, full);
          if (!q || !q.id) return;
          if (dhandled[q.id]) return; dhandled[q.id] = Date.now();
          var rnow = Date.now(); for (var dk in dhandled) if (rnow - dhandled[dk] > 180000) delete dhandled[dk];
          if (q.t === "ping") {
            publish(servers, topic, frameChunks(q.id, "s", await seal(key, { t: "pong", id: q.id, ts: Date.now() })));
            return;
          }
          if (q.t === "rpc") {
            // DaoRelayApp 在 relay-app.js 里是 `const`(词法全局, 非 window 属性) → 同 p2p.js 以
            //   裸名引用; typeof 守卫避免未定义环境(如单测 mock 改挂 window.DaoRelayApp)报 ReferenceError。
            var app = (typeof DaoRelayApp !== "undefined") ? DaoRelayApp : (root && root.DaoRelayApp), result;
            // 与 p2p.js wireChannel 同契约: serveLocal 收 JSON 字符串帧 (E2E 解密→命令→重封)。
            var frameJson = (typeof q.frame === "string") ? q.frame : JSON.stringify(q.frame);
            try { result = (app && typeof app.serveLocal === "function") ? await app.serveLocal(frameJson) : { status: 503, bodyText: "serveLocal unavailable" }; }
            catch (e) { result = { status: 500, bodyText: String(e && e.message || e) }; }
            var rpl = await seal(key, { t: "res", id: q.id, result: result });
            // 控制面兜底: 大响应不宜灌公共 broker(触发限流) → 超阈值改回提示, 让调用方走 P2P/Worker。
            if (rpl.length > RELAY_MAX_B64) rpl = await seal(key, { t: "res", id: q.id, result: { status: 413, bodyText: "relay payload too large; prefer P2P/Worker for bulk transfer" } });
            publish(servers, topic, frameChunks(q.id, "s", rpl));
            return;
          }
        }
      });
    });
    return { ok: true, topic: topic, servers: servers, close: sub.close };
  }

  // ── 客户端 (浏览器/任意公网设备): 发 offer → 收 answer → P2P DataChannel 直连。──
  //   返回 {pc, dc, rpc(frame), ping(), close()}. rpc/ping 与 p2p.js wireChannel 协议一致。
  async function connect(opts) {
    opts = opts || {};
    if (!hasSubtle) throw new Error("webcrypto_unavailable");
    var session = opts.session, token = opts.token;
    if (!session || !token) throw new Error("need session+token");
    var servers = normServers(opts.servers);
    var ice = STUN.slice();
    if (Array.isArray(opts.ice)) opts.ice.forEach(function (s) { if (s && s.urls) ice.push(s); });
    var key = await deriveKey(session, token);
    var topic = await topicFor(session);
    var nonce = uid();
    var pc = new RTCPeerConnection({ iceServers: ice });
    var dc = pc.createDataChannel("rpc"); dc.binaryType = "arraybuffer";
    var seq = 0, waiters = Object.create(null), relayWaiters = Object.create(null);
    dc.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m) return;
      var w = waiters[m.id]; if (!w) return; delete waiters[m.id];
      if (m.t === "pong") w.resolve({ pong: true, ts: m.ts });
      else if (m.t === "res") w.resolve(m.result);
    };
    function rpc(frame) {
      return new Promise(function (resolve, reject) {
        if (!dc || dc.readyState !== "open") return reject(new Error("datachannel not open"));
        var id = String(++seq); waiters[id] = { resolve: resolve, reject: reject };
        dc.send(JSON.stringify({ t: "rpc", id: id, frame: frame }));
        setTimeout(function () { if (waiters[id]) { delete waiters[id]; reject(new Error("timeout")); } }, 30000);
      });
    }
    function ping() {
      return new Promise(function (resolve, reject) {
        var id = "p" + (++seq), t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        waiters[id] = { resolve: function () { resolve((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0); }, reject: reject };
        try { dc.send(JSON.stringify({ t: "ping", id: id })); } catch (e) { reject(e); }
        setTimeout(function () { if (waiters[id]) { delete waiters[id]; reject(new Error("timeout")); } }, 5000);
      });
    }
    function waitIce() {
      return new Promise(function (res) {
        if (pc.iceGatheringState === "complete") return res();
        var done = false; function fin() { if (!done) { done = true; res(); } }
        pc.addEventListener("icegatheringstatechange", function () { if (pc.iceGatheringState === "complete") fin(); });
        // host+srflx 候选通常 <1s 到齐(本端未配 TURN, 无需久等); 2.5s 封顶即发 offer, 缩短对端收到 offer 的等待。
        setTimeout(fin, 2500);
      });
    }
    var opened = false, answered = false, settle = null;
    var ready = new Promise(function (resolve, reject) {
      settle = { resolve: resolve, reject: reject };
      dc.onopen = function () { opened = true; resolve({ pc: pc, dc: dc, rpc: rpc, ping: ping, topic: topic, close: close }); };
      // 对端已应答(收到 answer)却仍 failed ⇒ 是 ICE 打洞失败(NAT/防火墙), 与「压根没应答」区分开。
      pc.onconnectionstatechange = function () { if (pc.connectionState === "failed" && !opened) reject(new Error(answered ? "ice_failed" : "p2p_failed")); };
    });
    var reasm = makeReasm();
    var sub = subscribe(servers, topic, function (raw) {
      reasm(raw, async function (corr, role, full) {
        if (role === "s") {                               // 中继兜底响应 (pong/res), 按 id 对号
          var r = await unseal(key, full);
          if (!r || !r.id) return;
          var rw = relayWaiters[r.id]; if (!rw) return; delete relayWaiters[r.id];
          if (r.t === "pong") rw.resolve({ pong: true, ts: r.ts });
          else if (r.t === "res") rw.resolve(r.result);
          return;
        }
        if (role !== "a" || corr !== nonce || opened) return;   // 只认本次 offer 对应的 answer
        var obj = await unseal(key, full);
        if (!obj || obj.t !== "answer" || !obj.sdp) return;
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: obj.sdp }); answered = true;
          // 已收到应答 ⇒ 对端在线且信令通; 给 P2P 打洞一个较短宽限, 到点仍没开就判 ice_failed 提前降级,
          //   不空等 WebRTC ~20s 的 connectionState=failed (能通常 <3s 就 open; 高效之中还有高效)。
          setTimeout(function () { if (!opened && settle) settle.reject(new Error("ice_failed")); }, opts.p2pGraceMs || 4000);
        } catch (e) {}
      });
    });
    function close() { try { sub.close(); } catch (e) {} try { if (dc) dc.close(); } catch (e) {} try { if (pc) pc.close(); } catch (e) {} }
    // 路线 C-2 客户端: P2P 失败时复用同一 topic/订阅, 把 RPC/ping 经公共 ntfy mesh 中继往返。
    function buildRelayHandle() {
      var rseq = 0;
      function relaySend(t, frame, timeoutMs) {
        return new Promise(function (resolve, reject) {
          var id = "r" + (++rseq) + "-" + uid();
          relayWaiters[id] = { resolve: resolve, reject: reject };
          (async function () {
            try { publish(servers, topic, frameChunks(id, "q", await seal(key, frame ? { t: t, id: id, frame: frame } : { t: t, id: id }))); }
            catch (e) { if (relayWaiters[id]) { delete relayWaiters[id]; reject(e); } }
          })();
          setTimeout(function () { if (relayWaiters[id]) { delete relayWaiters[id]; reject(new Error("relay_timeout")); } }, timeoutMs || 30000);
        });
      }
      return {
        mode: "relay-ntfy", pc: null, dc: null, topic: topic, servers: servers, close: close,
        rpc: function (frame) { return relaySend("rpc", frame, 30000); },
        ping: function () { var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now()); return relaySend("ping", null, 8000).then(function () { return (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0; }); }
      };
    }
    // forceRelay: 已知 P2P 必不可达(对称 NAT/防火墙)时直接走去中心化中继, 省去 ICE 等待。
    if (opts.forceRelay) {
      try { if (dc) dc.close(); } catch (_) {}
      try { if (pc) pc.close(); } catch (_) {}
      var hr = buildRelayHandle();
      await hr.ping();   // 探活: 中继不通则抛 relay_timeout
      hr.forced = true; return hr;
    }
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce();
    var turn = ice.filter(function (s) { return /^turns?:/i.test(s.urls); });
    var payload = await seal(key, { t: "offer", nonce: nonce, sdp: pc.localDescription.sdp, ice: turn });
    publish(servers, topic, frameChunks(nonce, "o", payload));
    // 稍后补发一次 (公共 broker 偶发丢首包 / 应答方刚上线)
    setTimeout(function () { if (!opened) publish(servers, topic, frameChunks(nonce, "o", payload)); }, 2500);
    // 等答超时只从「发出 offer」起算 —— 此前 ICE 收集已占去数秒, 不该吃进等答窗口。
    //   answered=true(已收到对端 answer)但仍超时 ⇒ ice_failed(建议填 TURN/隧道兜底); 否则 signal_timeout(对端离线/token 不符)。
    setTimeout(function () { if (!opened && settle) settle.reject(new Error(answered ? "ice_failed" : "signal_timeout")); }, opts.timeout || ANSWER_TIMEOUT);
    try {
      return await ready;
    } catch (e) {
      // P2P 直连失败(对称 NAT 打洞失败/对端在线却连不上)。relayFallback!==false 时自动降级到
      //   去中心化 ntfy 中继兜底(控制面): 关掉没用上的 DC/PC, 复用同一订阅探活一次, 通则返回中继句柄。
      if (opts.relayFallback === false) { close(); throw e; }
      try { if (dc) dc.close(); } catch (_) {}
      try { if (pc) pc.close(); } catch (_) {}
      var h = buildRelayHandle();
      try { await h.ping(); h.fellBackFrom = String(e && e.message || e); return h; }
      catch (e2) { close(); throw e; }
    }
  }

  root.DaoSignal = {
    serve: serve, connect: connect, topicFor: topicFor,
    available: function () { return !!hasSubtle; },
    DEFAULT_SERVERS: DEFAULT_SERVERS.slice()
  };
})(typeof window !== "undefined" ? window : this);
