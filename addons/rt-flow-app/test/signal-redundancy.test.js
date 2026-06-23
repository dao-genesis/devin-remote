"use strict";
// 实测 signal.js (路线C·去中心化 WebRTC 信令) 的「多 broker 冗余 + 会话定址/鉴权」不变量。
// 无框架: 直接 node test/signal-redundancy.test.js, 退出码非 0 即失败。
//   守护点: 任何单点 broker 限流/封锁都不致命 (默认就铺开多家独立公共 ntfy);
//            topic 由 session 派生且不泄露 session 本身 (等同共享秘密定址)。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SIG = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "signal.js");
const src = fs.readFileSync(SIG, "utf8");

// signal.js 的 IIFE 以 (typeof window!=="undefined"?window:this) 选 root 并挂 window.DaoSignal。
// 提供一个假 window 即可加载 (crypto/TextEncoder/btoa/atob 均为 Node 内置全局; WebSocket/
// RTCPeerConnection 仅在 serve/connect 内部用到, 加载期不触发 → 加载本身也是语法校验)。
global.window = {};
vm.runInThisContext(src, { filename: "signal.js" });
const S = global.window.DaoSignal;

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

(async function () {
  ok(S && typeof S.serve === "function" && typeof S.connect === "function" && typeof S.topicFor === "function",
    "signal.js 加载并导出 serve/connect/topicFor (语法/结构 OK)");

  // A) 多 broker 冗余: 默认至少 3 家、全 https、互不重复 (单点不致命的前提)。
  const def = S.DEFAULT_SERVERS || [];
  ok(Array.isArray(def) && def.length >= 3, "A1 DEFAULT_SERVERS 默认铺开 >=3 家公共 broker (实=" + def.length + ")");
  ok(def.every(function (u) { return /^https:\/\//.test(u); }), "A2 DEFAULT_SERVERS 全为 https 端点");
  ok(new Set(def).size === def.length, "A3 DEFAULT_SERVERS 无重复");
  ok(def.indexOf("https://ntfy.sh") >= 0, "A4 含已实测可达的 ntfy.sh");

  // B) available(): Node 有 crypto.subtle → 应为 true (与真机 Chromium WebView 同)。
  ok(S.available() === true, "B available() 在有 WebCrypto 环境返回 true");

  // C) 会话定址: topicFor 确定性 + 合法 ntfy topic + 不泄露 session 本身。
  const t1 = await S.topicFor("rtflow-abc123");
  const t1b = await S.topicFor("rtflow-abc123");
  const t2 = await S.topicFor("rtflow-different");
  ok(t1 === t1b, "C1 topicFor 对同一 session 确定性 (同进同出)");
  ok(t1 !== t2, "C2 topicFor 不同 session → 不同 topic");
  ok(/^dao[0-9a-f]{24}$/.test(t1), "C3 topic 为 'dao'+24 hex = 27 字符纯 alnum (合法 ntfy topic)");
  ok(t1.indexOf("rtflow-abc123") < 0, "C4 topic 不含原始 session 明文 (等同共享秘密定址)");

  // D) 鉴权门禁: 缺 session/token 时 serve/connect 直接拒绝 (不开任何 socket)。
  const r1 = await S.serve({ token: "t" });
  ok(r1 && r1.ok === false, "D1 serve 缺 session → {ok:false} (不启动信令)");
  const r2 = await S.serve({ session: "s", token: "t" });   // 缺 P2P.connect
  ok(r2 && r2.ok === false && /P2P\.connect/.test(r2.error || ""), "D2 serve 缺 connect 句柄 → 拒绝");
  let threw = false;
  try { await S.connect({ session: "s" }); } catch (e) { threw = /need session\+token/.test(String(e.message)); }
  ok(threw, "D3 connect 缺 token → throw need session+token (建连前即拒)");

  // E) 路线 C-2 去中心化中继兜底: 离线 mock broker 跑通 serve↔connect(forceRelay) 的 ping+rpc。
  //    守护点: P2P 打洞失败(对称 NAT)且 Worker 被封(GFW)时, 控制面 RPC 仍可经公共 ntfy mesh
  //            中继往返; 且中继路径与握手同享 token 加密门禁 (错 token 即不应答)。
  const SERVER = "https://mock.local";
  const topics = Object.create(null);                       // topic → Set(deliver callback)
  global.WebSocket = function (url) {
    const m = String(url).match(/\/([^/]+)\/ws$/); const topic = m ? m[1] : "";
    const self = this; this.readyState = 1;
    const cb = function (body) { if (self.onmessage) self.onmessage({ data: JSON.stringify({ event: "message", message: body }) }); };
    (topics[topic] = topics[topic] || new Set()).add(cb);
    this.close = function () { try { topics[topic].delete(cb); } catch (e) {} };
    setTimeout(function () { if (self.onopen) self.onopen(); }, 0);
  };
  global.fetch = function (url, opts) {                     // POST = 向该 topic 全体订阅者投递报文
    const m = String(url).match(/\/([^/]+)$/); const topic = m ? m[1] : "";
    const subs = topics[topic]; const body = opts && opts.body;
    if (subs) subs.forEach(function (cb) { setTimeout(function () { cb(body); }, 0); });
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(""); } });
  };
  global.RTCPeerConnection = function () {                  // forceRelay 路径会即刻 close 掉它, 仅需可构造
    this.iceGatheringState = "complete"; this.connectionState = "new"; this.localDescription = { sdp: "x" };
    this.createDataChannel = function () { return { binaryType: "", send: function () {}, close: function () {}, readyState: "connecting" }; };
    this.createOffer = function () { return Promise.resolve({ type: "offer", sdp: "x" }); };
    this.setLocalDescription = function () { return Promise.resolve(); };
    this.setRemoteDescription = function () { return Promise.resolve(); };
    this.createAnswer = function () { return Promise.resolve({ type: "answer", sdp: "y" }); };
    this.addEventListener = function () {}; this.close = function () {};
  };
  global.window.DaoRelayApp = { serveLocal: function (frameJson) { var f = {}; try { f = JSON.parse(frameJson); } catch (e) {} return Promise.resolve(JSON.stringify({ status: 200, bodyText: JSON.stringify({ ok: true, echoPath: f.path || null }) })); } };

  const served = await S.serve({ session: "sessE", token: "tokE", servers: [SERVER], connect: function () { return Promise.resolve({ ok: false }); } });
  ok(served && served.ok === true, "E0 serve 启动 (mock broker)");
  const sig = await S.connect({ session: "sessE", token: "tokE", servers: [SERVER], forceRelay: true });
  ok(sig && sig.mode === "relay-ntfy", "E1 forceRelay → 返回去中心化中继句柄 (不依赖 ICE/WebRTC)");
  const pong = await sig.ping();
  ok(typeof pong === "number" && pong >= 0, "E2 中继 ping 往返成功 (经 ntfy mesh, 全程无 WebRTC)");
  const r = await sig.rpc({ path: "/api/health", method: "GET" });
  const robj = (typeof r === "string") ? JSON.parse(r) : r;
  ok(robj && robj.status === 200, "E3 中继 rpc 往返: serveLocal 200 (控制面经 ntfy 中继可达)");
  ok(robj && JSON.parse(robj.bodyText).echoPath === "/api/health", "E4 中继 rpc 帧完整投递 (path 原样回显)");
  if (sig.close) sig.close();
  let denied = false;
  try { await S.connect({ session: "sessE", token: "WRONG", servers: [SERVER], forceRelay: true }); }
  catch (e) { denied = /relay_timeout/.test(String(e.message)); }
  ok(denied, "E5 token 不符 → 中继亦拒应答 (relay_timeout; 与握手同享加密门禁)");

  console.log(failures ? ("\n失败 " + failures + " 项 ✗") : "\n全通 ✓");
  process.exit(failures ? 1 : 0);
})().catch(function (e) { console.error("测试异常:", e); process.exit(1); });
