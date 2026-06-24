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
  //   GFW 友好: Google STUN 在中国大陆常被墙, 故并铺 cloudflare(境内可达) + 小米/腾讯境内 STUN +
  //   nextcloud:443(受限网络下走 443 更易出网) → 反射地址发现成功率显著抬高, 直连率随之提升。
  var STUN = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.miwifi.com:3478" },
    { urls: "stun:stun.qq.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.nextcloud.com:443" }
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

  // ── DataChannel 大载荷透明分片 + 背压 (路线B/C 直连数据面提速·超越 Worker 的关键) ──
  //   病灶: 旧实现把整条 RPC 响应(含 downloadFetch 的 base64 文件内容, 可达数 MB)塞进**单次**
  //     dc.send → 超 SCTP 单消息上限(部分 WebView ~256KB)直接失败, 且无背压时连发会撑爆发送缓冲。
  //   解法: 应用层透明分片。> DC_FRAME 的消息切成 {t:"frag", m, i, n, p} 多帧顺序发, 接收端按 m
  //     重组还原原始对象再交给 onObj; 小消息原样直发(零开销·全向后兼容)。发送侧遵循 bufferedAmount
  //     背压(高水位暂停, onbufferedamountlow 续传) → 大文件 P2P 直连可靠满速, 不再受中继 413 上限制约。
  var DC_FRAME = 49152;        // 单帧 48KB: 远低于 SCTP 256KB 上限, 兼容各 WebView; 留足 JSON 封装余量
  var DC_HIWAT = 8388608;      // 发送缓冲高水位 8MB: 超过即暂停灌入, 等排空
  var DC_LOWAT = 4194304;      // 低水位 4MB: 排空到此续传 (兼顾吞吐与内存)
  function dcWire(dc, onObj) {
    try { dc.binaryType = "arraybuffer"; } catch (e) {}
    var rx = Object.create(null);   // mid -> {n, parts, got, ts}  分片重组缓冲
    dc.onmessage = function (ev) {
      var data = (typeof ev.data === "string") ? ev.data : (ev.data && ev.data.toString ? ev.data.toString() : "");
      var m; try { m = JSON.parse(data); } catch (e) { return; }
      if (!m) return;
      if (m.t !== "frag") { onObj(m); return; }
      var e = rx[m.m]; if (!e) e = rx[m.m] = { n: m.n, parts: new Array(m.n), got: 0, ts: Date.now() };
      if (e.parts[m.i] === undefined) { e.parts[m.i] = m.p; e.got++; }
      if (e.got >= e.n) {
        var full = e.parts.join(""); delete rx[m.m];
        var obj; try { obj = JSON.parse(full); } catch (_) { return; }
        onObj(obj);
      }
      var now = Date.now(); for (var k in rx) if (now - rx[k].ts > 120000) delete rx[k];
    };
    try { dc.bufferedAmountLowThreshold = DC_LOWAT; } catch (e) {}
    function send(obj) {
      var s; try { s = JSON.stringify(obj); } catch (e) { return; }
      if (s.length <= DC_FRAME) { try { dc.send(s); } catch (e) {} return; }
      var mid = uid(), n = Math.ceil(s.length / DC_FRAME), i = 0;
      function pump() {
        while (i < n) {
          if (typeof dc.bufferedAmount === "number" && dc.bufferedAmount > DC_HIWAT) {
            dc.onbufferedamountlow = function () { dc.onbufferedamountlow = null; pump(); };
            return;   // 背压: 等缓冲排空到低水位再续, 不撑爆发送队列
          }
          try { dc.send(JSON.stringify({ t: "frag", m: mid, i: i, n: n, p: s.slice(i * DC_FRAME, (i + 1) * DC_FRAME) })); }
          catch (e) { return; }
          i++;
        }
      }
      pump();
    }
    return send;
  }

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
  // 带超时的 fetch: 被限流/封锁/黑洞的 broker(如本机 IP 被 ntfy.sh 限流后连接挂起)不能拖死
  //   整条故障转移链 → 单家封顶 4s 即中止, 立刻试下一家。
  function fetchT(url, opts, ms) {
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms) : null;
    var o = ctl ? Object.assign({}, opts, { signal: ctl.signal }) : opts;
    return fetch(url, o).finally(function () { if (to) clearTimeout(to); });
  }
  var _pubStart = 0;   // 粘滞: 上次成功投递的 broker 下标。死 broker 只拖慢一次, 之后从可用家起手。
  // 单帧投递: **顺序故障转移**(命中第一家 2xx 即止), 而非扇出到所有 broker。订阅方在所有 broker
  //   同时在线, 任一家收下即送达; 故 happy-path 只发 1 个 POST(而非 N 家×N 倍), 大幅降低对单一
  //   出口 IP 的 POST 速率 → 显著抬高公共 broker 的并发上限、少触发 429。全家失败才退避重试(带
  //   jitter, 上限 3 次)。
  async function publishFrame(servers, topic, frame, attempt) {
    var n = servers.length; if (!n) return false;
    var base = (_pubStart + (attempt || 0)) % n;
    for (var k = 0; k < n; k++) {
      var idx = (base + k) % n, url = servers[idx];
      try { var r = await fetchT(url + "/" + topic, { method: "POST", body: frame }, 4000); if (r && r.ok) { _pubStart = idx; return true; } }
      catch (e) {}
    }
    if ((attempt || 0) < 3) { await new Promise(function (res) { setTimeout(res, 700 + 600 * (attempt || 0) + Math.random() * 400); }); return publishFrame(servers, topic, frame, (attempt || 0) + 1); }
    return false;
  }
  function publish(servers, topic, frames) {
    for (var f = 0; f < frames.length; f++) publishFrame(servers, topic, frames[f], 0);
  }
  // 启动预热: 并发探各 broker /v1/health, 把粘滞起点 _pubStart 指向**首个健康**的家, 这样首批
  //   真实投递不必先在死/被限流的 broker(如本机被 ntfy.sh 限流)上白白超时 → 消除冷启动停顿。
  //   带 TTL(30s) + in-flight 去重: 并发/连发的 connect 共用一次预热, 不重复刷探测。
  var _warmTs = 0, _warmP = null;
  function warmBrokers(servers, capMs) {
    if (!servers || servers.length < 2) return Promise.resolve();
    if (Date.now() - _warmTs < 30000) return Promise.resolve();
    if (_warmP) return _warmP;
    _warmP = new Promise(function (resolve) {
      var done = false, pending = servers.length;
      function finish() { if (done) return; done = true; _warmTs = Date.now(); _warmP = null; resolve(); }
      // 探的是**可投递性**而非可达性: 某些被限流的 broker(如本机被 ntfy.sh 限)GET 仍 200 但 POST 挂起,
      //   故用一个微小 POST(发到惰性探测 topic)实测能否发布, 命中健康家即设 _pubStart。
      servers.forEach(function (u, i) {
        fetchT(u + "/daowarm", { method: "POST", body: "w" }, capMs || 3000)
          .then(function (r) { if (r && r.ok && !done) { _pubStart = i; finish(); } })
          .catch(function () {})
          .finally(function () { if (--pending === 0) finish(); });
      });
      setTimeout(finish, (capMs || 3000) + 200);
    });
    return _warmP;
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
    await warmBrokers(servers);          // 应答方预热: 响应投递从健康 broker 起手, 不在死家上超时
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
          // 幂等去重 + 响应缓存重发: 客户端在突发/限流下会幂等重传同一 id。若**请求**先前丢失,
          //   重传现在才到 → 照常处理; 若**响应**丢失(已处理过), 重发缓存的密文响应帧, 不重复执行命令。
          var prev = dhandled[q.id];
          if (prev) { if (prev.frames) publish(servers, topic, prev.frames); return; }
          var slot = dhandled[q.id] = { ts: Date.now() };
          var rnow = Date.now(); for (var dk in dhandled) if (rnow - dhandled[dk].ts > 180000) delete dhandled[dk];
          if (q.t === "ping") {
            slot.frames = frameChunks(q.id, "s", await seal(key, { t: "pong", id: q.id, ts: Date.now() }));
            publish(servers, topic, slot.frames);
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
            slot.frames = frameChunks(q.id, "s", rpl);
            publish(servers, topic, slot.frames);
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
    await warmBrokers(servers);          // 客户端预热: 首发 offer/ping 从健康 broker 起手, 消除冷启停顿
    var nonce = uid();
    var pc = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 2 });
    var dc = pc.createDataChannel("rpc");
    var seq = 0, waiters = Object.create(null), relayWaiters = Object.create(null);
    // dcWire: 收到的(可能分片重组后的)应用消息按 id 对号回调; 发送侧自动对大载荷分片+背压。
    var dcSend = dcWire(dc, function (m) {
      if (!m) return;
      var w = waiters[m.id]; if (!w) return; delete waiters[m.id];
      if (m.t === "pong") w.resolve({ pong: true, ts: m.ts });
      else if (m.t === "res") w.resolve(m.result);
    });
    function rpc(frame) {
      return new Promise(function (resolve, reject) {
        if (!dc || dc.readyState !== "open") return reject(new Error("datachannel not open"));
        var id = String(++seq); waiters[id] = { resolve: resolve, reject: reject };
        dcSend({ t: "rpc", id: id, frame: frame });
        setTimeout(function () { if (waiters[id]) { delete waiters[id]; reject(new Error("timeout")); } }, 30000);
      });
    }
    function ping() {
      return new Promise(function (resolve, reject) {
        var id = "p" + (++seq), t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        waiters[id] = { resolve: function () { resolve((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0); }, reject: reject };
        try { dcSend({ t: "ping", id: id }); } catch (e) { reject(e); }
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
        var TO = timeoutMs || 30000;
        return new Promise(function (resolve, reject) {
          var id = "r" + (++rseq) + "-" + uid();
          var timers = [];
          function clear() { for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]); }
          relayWaiters[id] = { resolve: function (v) { clear(); resolve(v); }, reject: function (e) { clear(); reject(e); } };
          (async function () {
            var chunks;
            try { chunks = frameChunks(id, "q", await seal(key, frame ? { t: t, id: id, frame: frame } : { t: t, id: id })); }
            catch (e) { if (relayWaiters[id]) { delete relayWaiters[id]; clear(); reject(e); } return; }
            publish(servers, topic, chunks);
            // 突发/限流致单次投递丢失时, 幂等重传 (应答方按 id 去重 dhandled, 不会重复执行) → 提升并发可靠性。
            //   带 jitter 错开并发客户端的重传, 避免再次形成同步突发又触发限流。
            [1800, 5000].forEach(function (base) { var d = base + Math.random() * 1200; if (d < TO) timers.push(setTimeout(function () { if (relayWaiters[id]) publish(servers, topic, chunks); }, d)); });
          })();
          timers.push(setTimeout(function () { if (relayWaiters[id]) { delete relayWaiters[id]; clear(); reject(new Error("relay_timeout")); } }, TO));
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
    DEFAULT_SERVERS: DEFAULT_SERVERS.slice(),
    STUN: STUN.slice(),
    dcWire: dcWire,   // DataChannel 大载荷透明分片+背压 (供 p2p.js 应答方 / p2p-client.html 客户端复用)
    // 纯函数测试面 (经 test/console-failover.test.js 验证去中心化信令的加密/分片不变量; 不改运行行为)
    _internals: { deriveKey: deriveKey, seal: seal, unseal: unseal, normServers: normServers, frameChunks: frameChunks, dcWire: dcWire, DC_FRAME: DC_FRAME }
  };
})(typeof window !== "undefined" ? window : this);
