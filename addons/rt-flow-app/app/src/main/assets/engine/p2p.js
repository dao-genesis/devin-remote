"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// p2p.js · 路线B 加法式 WebRTC P2P 真打洞 (curl/HTTP 本源零改动)
//
//  手机 WebView 端作为 P2P「应答方」。信令复用已打通的公网隧道 —— 一次普通的
//  p2pConnect RPC(走与 curl 完全相同的 /api/rpc 路径)交换 SDP, 之后数据走 P2P
//  DataChannel (公共 STUN 打洞), 不再经任何边缘中转, 延迟更低、更去中心化。
//
//  价值: curl/HTTP 控制端照常无感可用 (本源不动); 愿升级者用 p2p-client.html
//  获得真直连低延迟通道。两者复用同一 serveLocal → 同一鉴权/加密/命令集。
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  // 与 signal.js 对齐的多家公共 STUN (互不隶属 → 单点不可达不致命; 仅反射地址发现, 不中转数据)。
  //   GFW 友好: Google STUN 境内常被墙 → 并铺 cloudflare/小米/腾讯境内 STUN + nextcloud:443。
  //   优先复用 signal.js 的同一份清单(单点维护), 缺失时回落本地内置。
  var STUN = (typeof window !== "undefined" && window.DaoSignal && window.DaoSignal.STUN) ? window.DaoSignal.STUN.slice() : [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.miwifi.com:3478" },
    { urls: "stun:stun.qq.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.nextcloud.com:443" }
  ];
  var conns = Object.create(null);   // id -> {pc, dc, ts}
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ICE 候选收集: answer 仍内嵌「封顶时已有的候选」(向后兼容老客户端), 首个 srflx 反射候选即提前发
  //   answer(缩短客户端等答), 其余候选(尤其慢到的 TURN relay)经 onLocalCandidate 走 trickle 补发回客户端。
  function waitIce(pc, capMs) {
    return new Promise(function (res) {
      if (pc.iceGatheringState === "complete") return res();
      var done = false;
      function fin() { if (!done) { done = true; try { pc.removeEventListener("icegatheringstatechange", chk); } catch (e) {} try { pc.removeEventListener("icecandidate", onc); } catch (e) {} res(); } }
      function chk() { if (pc.iceGatheringState === "complete") fin(); }
      function onc(ev) { if (ev && ev.candidate && /typ srflx/.test(ev.candidate.candidate || "")) fin(); }   // 首个反射地址即可发 answer
      pc.addEventListener("icegatheringstatechange", chk);
      pc.addEventListener("icecandidate", onc);
      // 兜底: 到点仍未 complete 也照发已有候选。仅 STUN 时 host+srflx 通常 <1s 到齐, 2.5s 封顶; 有 TURN 时保留 4s。
      setTimeout(fin, capMs || 4000);
    });
  }

  // DataChannel 上的 RPC: 客户端发 {t:"rpc", id, frame}, 经与 HTTP 完全相同的
  // serveLocal(E2E 解密→命令→重封) 处理后回 {t:"res", id, result}。
  //   大响应(如 downloadFetch 的 base64 文件内容)经 DaoSignal.dcWire 透明分片+背压, 不再受
  //   SCTP 单消息上限制约 → 大文件 P2P 直连可靠满速 (信令缺席时回落原逐条直发, 向后兼容)。
  function wireChannel(dc) {
    try { dc.binaryType = "arraybuffer"; } catch (e) {}
    var wire = (typeof window !== "undefined" && window.DaoSignal && window.DaoSignal.dcWire) ? window.DaoSignal.dcWire : null;
    function handle(send, msg) {
      if (!msg) return;
      if (msg.t === "ping") { try { send({ t: "pong", id: msg.id, ts: Date.now() }); } catch (e) {} return; }
      if (msg.t !== "rpc" || !msg.frame) return;
      var frameJson = (typeof msg.frame === "string") ? msg.frame : JSON.stringify(msg.frame);
      DaoRelayApp.serveLocal(frameJson).then(function (r) {
        try { send({ t: "res", id: msg.id, result: r }); } catch (e) {}
      }, function (err) {
        try { send({ t: "res", id: msg.id, result: JSON.stringify({ status: 500, bodyText: JSON.stringify({ error: String(err) }) }) }); } catch (e) {}
      });
    }
    if (wire) {
      var send = wire(dc, function (msg) { handle(send, msg); });
    } else {
      dc.onmessage = function (ev) {
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        handle(function (o) { try { dc.send(JSON.stringify(o)); } catch (e) {} }, msg);
      };
    }
  }

  function sweep() {
    var now = Date.now();
    for (var k in conns) {
      var c = conns[k];
      var st = c.pc && c.pc.connectionState;
      if ((now - c.ts > 120000 && st !== "connected") || st === "failed" || st === "closed") {
        try { c.pc.close(); } catch (e) {}
        delete conns[k];
      }
    }
  }

  // 应答方建连: 收到客户端 offer → 建 pc → setRemote → answer → 收 ICE → 返回 answer。
  //   默认零依赖(仅公共 STUN)。对称 NAT 等直连不通时, 客户端可在 args.ice 传入自有 TURN
  //   (双方对称配置), 仍不引入任何强制中心依赖 —— 要不要 TURN 由用户自己决定。
  async function connect(args) {
    var offer = args && (args.offer || args.sdp);
    if (!offer || typeof offer !== "string") return { ok: false, error: "need args.offer (client SDP)" };
    if (typeof RTCPeerConnection === "undefined") return { ok: false, error: "webrtc_unavailable", hint: "该 WebView 不支持 RTCPeerConnection" };
    sweep();
    var ice = STUN.slice();
    if (args && Array.isArray(args.ice)) {
      for (var i = 0; i < args.ice.length; i++) { var s = args.ice[i]; if (s && s.urls) ice.push(s); }
    }
    var id = uid();
    var pc = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 2 });
    var rec = { pc: pc, dc: null, ts: Date.now() };
    conns[id] = rec;
    pc.ondatachannel = function (ev) { rec.dc = ev.channel; wireChannel(ev.channel); };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") { try { pc.close(); } catch (e) {} delete conns[id]; }
    };
    // Trickle ICE: answer 之后才到的候选(尤其慢到的 TURN relay)经 onLocalCandidate 回传客户端; 此前的已内嵌 answer SDP。
    var onLocalCand = (args && typeof args.onLocalCandidate === "function") ? args.onLocalCandidate : null;
    var answerSent = false;
    if (onLocalCand) pc.onicecandidate = function (ev) { var c = ev && ev.candidate; if (c && answerSent) { try { onLocalCand(c.toJSON ? c.toJSON() : c); } catch (e) {} } };
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      var hasTurn = ice.some(function (s) { return /^turns?:/i.test(s.urls); });
      await waitIce(pc, hasTurn ? 4000 : 2500);
    } catch (e) {
      try { pc.close(); } catch (_) {} delete conns[id];
      return { ok: false, error: "sdp_negotiation_failed", detail: String((e && e.message) || e) };
    }
    answerSent = true;   // 此后到达的候选 trickle 回客户端(此前的已内嵌 answer SDP → 向后兼容)
    // 客户端 trickle 来的候选经 signal.serve 路由到此; pc 未就绪时由 serve 暂存回灌。
    return { ok: true, id: id, answer: pc.localDescription.sdp, stun: STUN.map(function (s) { return s.urls; }), addRemoteCandidate: onLocalCand ? function (c) { try { pc.addIceCandidate(c); } catch (e) {} } : undefined };
  }

  window.P2P = {
    connect: connect,
    count: function () { return Object.keys(conns).length; },
    // 暴露为可注册命令表; engine 合并进 CMDS → 经 /api/rpc 触发 (curl 同源)。
    commands: function () {
      return {
        p2pConnect: function (args) { return connect(args || {}); },
        p2pStatus: async function () { return { ok: true, active: Object.keys(conns).length, webrtc: (typeof RTCPeerConnection !== "undefined") }; }
      };
    }
  };
})();
