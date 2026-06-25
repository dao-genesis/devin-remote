"use strict";
// 实测 console.html 的「通道自愈 failover」真代码 (切片 //__FAILOVER_START__…//__FAILOVER_END__ eval)。
// 无框架: 直接 node test/console-failover.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "console.html");
const src = fs.readFileSync(HTML, "utf8");
const mFail = src.match(/\/\/__FAILOVER_START__[\s\S]*?\/\/__FAILOVER_END__/);
if (!mFail) { console.error("FAIL: 未找到 //__FAILOVER_START__…//__FAILOVER_END__ 标记块"); process.exit(1); }
const mP2P = src.match(/\/\/__P2P_START__[\s\S]*?\/\/__P2P_END__/);
if (!mP2P) { console.error("FAIL: 未找到 //__P2P_START__…//__P2P_END__ 标记块"); process.exit(1); }
// relay() 现位于 P2P 块(P2P 优先, 不通回退 _relayHttp); 两块同处一个 IIFE 闭包, 一并 eval 实测。
const sliced = mFail[0] + "\n" + mP2P[0];

// 把切片包进工厂函数, 以闭包局部变量提供 console.html 同名外层依赖 (ENDPOINT 可被内部重赋值)。
function makeModule(deps) {
  const factorySrc = "(function(deps){\n" +
    "var CFG=deps.CFG, SESSION=deps.SESSION, TOKEN=deps.TOKEN, ENDPOINT=deps.ENDPOINT;\n" +
    "var qp=deps.qp, persist=deps.persist, localStorage=deps.localStorage, location=deps.location, fetch=deps.fetch, window=deps.window;\n" +
    sliced + "\n" +
    "return { relay: relay, relayHttp: _relayHttp, getEndpoint: function(){ return ENDPOINT; }, candBases: _candBases,\n" +
    "         p2pTry: _p2pTry, p2pAlive: _p2pAlive, setP2P: function(p){ _p2p=p; },\n" +
    "         learnDirect: _learnDirect, preferDirect: _preferDirect, directUrls: _directUrls };\n" +
    "})";
  // eslint-disable-next-line no-eval
  return eval(factorySrc)(deps);
}

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

function makeLocalStorage() {
  const store = Object.create(null);
  return { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, _store: store };
}
// mock fetch: 按 base(剥掉 /relay/...) 决定响应。alive 集合中的 base 回 200, reject 集合 reject, 其余按 status。
function makeFetch(routes, counter) {
  return function (url, opts) {
    const base = String(url).replace(/\/relay\/.*$/, "");
    counter.byBase[base] = (counter.byBase[base] || 0) + 1;
    counter.total++;
    const r = routes[base];
    if (!r) return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true, state: "default" })) });
    if (r.reject) return Promise.reject(new Error(r.reject === true ? "network" : r.reject));
    return Promise.resolve({ status: r.status, ok: r.status < 400, text: () => Promise.resolve(typeof r.body === "string" ? r.body : JSON.stringify(r.body || {})) });
  };
}
const baseDeps = (over) => Object.assign({
  CFG: {}, SESSION: "sess1", TOKEN: "tok1",
  qp: () => "", persist: () => {}, location: { origin: "https://opened-origin.example" },
  localStorage: makeLocalStorage(),
  window: {},   // 默认无 DaoSignal → _p2pAlive()=false → relay 等价 _relayHttp (A–E 行为与旧版一致)
}, over);
// 假 P2P 句柄: dc.readyState=open + rpc 返回 serveLocal 同构串 {status, bodyText}。
function fakeSig(rpcImpl) {
  return { dc: { readyState: "open", addEventListener: () => {} }, rpc: rpcImpl, close: () => {} };
}

const WORKER = "https://dao-relay-do.zhouyoukang.workers.dev";

(async function run() {
  // 场景 A: 主端点存活 → 成功路径零额外探活 (只 1 次 fetch, ENDPOINT 不变)。
  {
    const counter = { total: 0, byBase: {} };
    const routes = { "https://live-tunnel.example": { status: 200, body: { ok: true } } };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://live-tunnel.example", fetch: makeFetch(routes, counter) }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200, "A 主端点存活: 返回 200");
    ok(counter.total === 1, "A 成功路径仅 1 次 fetch(无探活), 实际 " + counter.total);
    ok(mod.getEndpoint() === "https://live-tunnel.example", "A ENDPOINT 不变");
  }

  // 场景 B: 主隧道 530 死 + Worker 存活 → 探活切到 Worker, 重试成功, 持久化 good。
  {
    const counter = { total: 0, byBase: {} };
    const routes = {
      "https://dead.trycloudflare.com": { status: 530, body: "<h1>Error 1033</h1>" },
      [WORKER]: { status: 200, body: { ok: true, state: "default" } },
    };
    const ls = makeLocalStorage();
    let persisted = 0;
    const mod = makeModule(baseDeps({ ENDPOINT: "https://dead.trycloudflare.com", fetch: makeFetch(routes, counter), localStorage: ls, persist: () => { persisted++; } }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200, "B 死隧道→自愈后返回 200");
    ok(mod.getEndpoint() === WORKER, "B ENDPOINT 已切到稳定 Worker");
    ok(ls.getItem("rtflow.rn.endpoint.good") === WORKER, "B 已持久化 endpoint.good=Worker");
    ok(persisted >= 1, "B 切换时调用了 persist()");
  }

  // 场景 C: 主端点网络层 reject + 全部候选皆死 → 抛原错误 (绝不静默吞)。
  {
    const counter = { total: 0, byBase: {} };
    const routes = {
      "https://gone.lhr.life": { reject: true },
      [WORKER]: { status: 503, body: "no tunnel here" },
    };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://gone.lhr.life", fetch: makeFetch(routes, counter), location: { origin: "https://gone.lhr.life" } }));
    let threw = false;
    try { await mod.relay("/api/rpc", { cmd: "getState" }, 5000); } catch (e) { threw = true; }
    ok(threw, "C 全候选皆死: relay() 抛错 (与旧版一致, 不伪装成功)");
  }

  // 场景 D: 主端点 200 但 no_agent(该路径手机不在线) → 视为死 → 探活切到 Worker。
  {
    const counter = { total: 0, byBase: {} };
    const routes = {
      "https://stale.example": { status: 200, body: { error: "no_agent" } },
      [WORKER]: { status: 200, body: { ok: true } },
    };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://stale.example", fetch: makeFetch(routes, counter) }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && (!res.body || res.body.error !== "no_agent"), "D no_agent→自愈切到在线 Worker");
    ok(mod.getEndpoint() === WORKER, "D ENDPOINT 切到 Worker");
  }

  // 场景 E: 候选清单去重且含 Worker + location.origin。
  {
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch({}, { total: 0, byBase: {} }), location: { origin: WORKER } }));
    const bases = mod.candBases();
    const uniq = new Set(bases);
    ok(uniq.size === bases.length, "E 候选清单无重复 (ENDPOINT 与 location.origin 同为 Worker 时去重)");
    ok(bases.indexOf(WORKER) >= 0, "E 候选含稳定 Worker 锚点");
  }

  // 场景 F: P2P 已建连 → relay 全程走 DataChannel, 完全不碰 HTTP(fetch 0 次), 回包归一为 {status,body}。
  {
    const counter = { total: 0, byBase: {} };
    let rpcCalls = 0;
    const mod = makeModule(baseDeps({ ENDPOINT: "https://live-tunnel.example", fetch: makeFetch({}, counter) }));
    mod.setP2P(fakeSig(function () { rpcCalls++; return Promise.resolve(JSON.stringify({ status: 200, bodyText: JSON.stringify({ ok: true, via: "p2p" }) })); }));
    ok(mod.p2pAlive(), "F P2P 句柄判活");
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && res.body && res.body.via === "p2p", "F relay 经 P2P 返回归一 {status,body}");
    ok(rpcCalls === 1, "F 走了 DataChannel rpc 一次");
    ok(counter.total === 0, "F 重活点对点: 完全不碰 HTTP 中继 (fetch 0 次), 实际 " + counter.total);
  }

  // 场景 G: P2P 链路异常(rpc reject) → 无缝回退 HTTP, 且失效 _p2p (本次仍成功返回)。
  {
    const counter = { total: 0, byBase: {} };
    const routes = { "https://live-tunnel.example": { status: 200, body: { ok: true, via: "http" } } };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://live-tunnel.example", fetch: makeFetch(routes, counter) }));
    mod.setP2P(fakeSig(function () { return Promise.reject(new Error("dc broken")); }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && res.body && res.body.via === "http", "G P2P 异常→无缝回退 HTTP 成功");
    ok(counter.total === 1, "G 回退确实打了一次 HTTP");
    ok(!mod.p2pAlive(), "G 异常后 _p2p 已失效 (待后台重连)");
  }

  // 场景 H: P2P 通但应答异常(回 502 死) → 回退 HTTP 自愈, 不把坏 P2P 应答当结果。
  {
    const counter = { total: 0, byBase: {} };
    const routes = { "https://live-tunnel.example": { status: 200, body: { ok: true, via: "http" } } };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://live-tunnel.example", fetch: makeFetch(routes, counter) }));
    mod.setP2P(fakeSig(function () { return Promise.resolve(JSON.stringify({ status: 502, bodyText: JSON.stringify({ error: "bad gateway" }) })); }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && res.body && res.body.via === "http", "H P2P 应答死(502)→回退 HTTP");
  }

  // 场景 I: _p2pTry 经 DaoSignal.connect 建连后, relay 自动接管走 P2P。
  {
    const counter = { total: 0, byBase: {} };
    let connected = 0;
    const win = { DaoSignal: { available: () => true, connect: function () { connected++; return Promise.resolve(fakeSig(function () { return Promise.resolve(JSON.stringify({ status: 200, bodyText: JSON.stringify({ ok: true, via: "p2p" }) })); })); } } };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://x.example", fetch: makeFetch({}, counter), window: win }));
    ok(!mod.p2pAlive(), "I 起初无 P2P");
    mod.p2pTry();
    await new Promise(r => setTimeout(r, 0));   // 等 connect Promise 落地
    ok(connected === 1 && mod.p2pAlive(), "I _p2pTry 经 DaoSignal 建连成功, P2P 接管");
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.body && res.body.via === "p2p" && counter.total === 0, "I 建连后 relay 自动走 P2P");
  }

  // 场景 K: 候选清单把「手机自带直连隧道」排在 Worker 之前 (Worker 仅兜底)。
  {
    const ls = makeLocalStorage();
    ls.setItem("rtflow.rn.endpoints.direct", JSON.stringify(["https://phone-cf.trycloudflare.com"]));
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch({}, { total: 0, byBase: {} }), localStorage: ls, location: { origin: WORKER, protocol: "https:" } }));
    const bases = mod.candBases();
    const di = bases.indexOf("https://phone-cf.trycloudflare.com"), wi = bases.indexOf(WORKER);
    ok(di >= 0, "K 候选清单含手机直连隧道");
    ok(di >= 0 && wi >= 0 && di < wi, "K 直连隧道优先级高于 Worker (排在前)");
  }

  // 场景 L: learnDirect 仅保留 https 直连隧道 (滤除 http 局域网 → 防 HTTPS 控台混合内容拦截)。
  {
    const ls = makeLocalStorage();
    const routes = { [WORKER]: { status: 200, body: { r: JSON.stringify({ publicUrls: ["https://ad8.lhr.life", "http://10.0.0.5:43379", "https://cf.trycloudflare.com"] }) } } };
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, { total: 0, byBase: {} }), localStorage: ls, location: { origin: WORKER, protocol: "https:" } }));
    const urls = await mod.learnDirect();
    ok(urls.length === 2 && urls.indexOf("http://10.0.0.5:43379") < 0, "L learnDirect 仅留 https (滤除 http 局域网)");
    ok((JSON.parse(ls.getItem("rtflow.rn.endpoints.direct")) || []).length === 2, "L 直连清单已持久化 (仅 https)");
  }

  // 场景 M (核心): 经 Worker 打开 + 手机有可达直连隧道 → preferDirect 升级 ENDPOINT 到直连, Worker 退为兜底。
  {
    const direct = "https://ad8.lhr.life";
    const routes = {
      [WORKER]: { status: 200, body: { r: JSON.stringify({ publicUrls: [direct] }) } },
      [direct]: { status: 200, body: { ok: true, state: "phone" } },
    };
    let persisted = 0; const ls = makeLocalStorage();
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, { total: 0, byBase: {} }), localStorage: ls, persist: () => { persisted++; }, location: { origin: WORKER, protocol: "https:" } }));
    const live = await mod.preferDirect();
    ok(live === direct, "M preferDirect 探到手机直连隧道可达");
    ok(mod.getEndpoint() === direct, "M ENDPOINT 从 Worker 升级到手机直连隧道 (Worker 退为最后兜底)");
    ok(persisted >= 1, "M 升级时持久化");
  }

  // 场景 N: 直连隧道探活不通 → 绝不升级, ENDPOINT 仍为 Worker (兜底不破)。
  {
    const direct = "https://dead.lhr.life";
    const routes = {
      [WORKER]: { status: 200, body: { r: JSON.stringify({ publicUrls: [direct] }) } },
      [direct]: { status: 530, body: "<h1>1033</h1>" },
    };
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, { total: 0, byBase: {} }), location: { origin: WORKER, protocol: "https:" } }));
    const live = await mod.preferDirect();
    ok(!live, "N 直连隧道探活不通 → 不升级");
    ok(mod.getEndpoint() === WORKER, "N ENDPOINT 仍为 Worker (直连死则不动, 兜底不破)");
  }

  // 场景 O: 当前已非 Worker 端点 → preferDirect 直接 no-op (无需升级, 不空打探活)。
  {
    const counter = { total: 0, byBase: {} };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://already.lhr.life", fetch: makeFetch({}, counter), location: { origin: "https://already.lhr.life", protocol: "https:" } }));
    await mod.preferDirect();
    ok(mod.getEndpoint() === "https://already.lhr.life", "O 已非 Worker 端点 → preferDirect 不动");
    ok(counter.total === 0, "O no-op: 零额外 fetch");
  }

  // 场景 P: _p2pTry 只求真 P2P (relayFallback:false 不常驻泄漏 ntfy 中继句柄) + 失败退避冷却 (防 30s 轮询风暴重握手)。
  {
    let calls = 0, lastOpts = null;
    const win = { DaoSignal: { available: () => true, connect: function (o) { calls++; lastOpts = o; return Promise.reject(new Error("p2p_failed")); } } };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://x.example", fetch: makeFetch({}, { total: 0, byBase: {} }), window: win }));
    mod.p2pTry();
    await new Promise(r => setTimeout(r, 0));   // 等 connect reject 落地
    ok(calls === 1 && lastOpts && lastOpts.relayFallback === false, "P _p2pTry 请求真 P2P(relayFallback:false), 不建 dc===null 的常驻 ntfy 中继兜底句柄(防泄漏)");
    ok(!mod.p2pAlive(), "P 真 P2P 失败 → 无 _p2p 句柄留存");
    mod.p2pTry();   // 紧接再试: 应被退避冷却挡住
    await new Promise(r => setTimeout(r, 0));
    ok(calls === 1, "P 失败后退避冷却生效: 紧接的 _p2pTry 不立即重握手 (防 30s 轮询风暴/刷爆公共 broker)");
  }

  // 场景 Q: P2P DataChannel 断开时, _p2pTry 注册的 close 监听会先 sig.close() 释放死连接的 pc+残余订阅, 再置空重连(防重连周期泄漏)。
  {
    let closeListener = null, closeCalls = 0;
    const sig = { dc: { readyState: "open", addEventListener: (ev, fn) => { if (ev === "close") closeListener = fn; } }, rpc: () => Promise.resolve(JSON.stringify({ status: 200, bodyText: "{}" })), close: () => { closeCalls++; } };
    const win = { DaoSignal: { available: () => true, connect: () => Promise.resolve(sig) } };
    const mod = makeModule(baseDeps({ ENDPOINT: "https://x.example", fetch: makeFetch({}, { total: 0, byBase: {} }), window: win }));
    mod.p2pTry();
    await new Promise(r => setTimeout(r, 0));
    ok(mod.p2pAlive() && typeof closeListener === "function", "Q P2P 建连成功且注册了 dc close 监听");
    sig.dc.readyState = "closed"; closeListener();   // 模拟移动网切换致 DataChannel 断开
    ok(closeCalls === 1, "Q dc 断开 → 调 sig.close() 释放死连接 pc + 残余 ntfy 订阅(不漏)");
    ok(!mod.p2pAlive(), "Q 断开后 _p2p 置空, 等退避后重连");
  }

  // 场景 R (核心·去中心化兜底): Worker 全候选皆死(503) + DaoSignal 可用 → 用尽去中心化 ntfy 中继档(forceRelay), relay 经中继返回。
  {
    const counter = { total: 0, byBase: {} };
    let connectCalls = 0, connectOpts = null, rtRpc = 0;
    const win = { DaoSignal: { available: () => true, connect: function (o) {
      connectCalls++; connectOpts = o;
      return Promise.resolve({ dc: null, close: () => {}, rpc: function () { rtRpc++; return Promise.resolve(JSON.stringify({ status: 200, bodyText: JSON.stringify({ ok: true, via: "relay-ntfy" }) })); } });
    } } };
    const routes = { [WORKER]: { status: 503, body: "no tunnel here" } };
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, counter), window: win, location: { origin: WORKER, protocol: "https:" } }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && res.body && res.body.via === "relay-ntfy", "R Worker 全死→去中心化 ntfy 中继档兜底返回 {status,body}");
    ok(connectCalls === 1 && connectOpts && connectOpts.forceRelay === true, "R 中继档经 forceRelay 建持久句柄(跳过 ICE 等待)");
    ok(rtRpc === 1, "R 经中继句柄发了一次 RPC");
  }

  // 场景 S (不抢快路): Worker 健康(200) → 直接经 Worker 返回, 绝不建中继档(connect 0 次), 不让慢中继拖累健康快路。
  {
    let connectCalls = 0;
    const win = { DaoSignal: { available: () => true, connect: function () { connectCalls++; return Promise.resolve({ dc: null, close: () => {}, rpc: () => Promise.resolve(JSON.stringify({ status: 200, bodyText: "{}" })) }); } } };
    const routes = { [WORKER]: { status: 200, body: { ok: true, via: "worker" } } };
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, { total: 0, byBase: {} }), window: win, location: { origin: WORKER, protocol: "https:" } }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && res.body && res.body.via === "worker", "S Worker 健康→经 Worker 返回");
    ok(connectCalls === 0, "S Worker 健康时绝不建去中心化中继档 (不抢健康快路·实际 connect " + connectCalls + " 次)");
  }

  // 场景 T (用户之痛·限流): Worker 回 429(被限流, 不在 _dead 内) → 仍引去中心化 ntfy 中继档兜底(0账号), 而非把 429 直接抛给板块。
  {
    let connectCalls = 0, rtRpc = 0;
    const win = { DaoSignal: { available: () => true, connect: function (o) { connectCalls++; return Promise.resolve({ dc: null, close: () => {}, rpc: function () { rtRpc++; return Promise.resolve(JSON.stringify({ status: 200, bodyText: JSON.stringify({ ok: true, via: "relay-ntfy" }) })); } }); } } };
    const routes = { [WORKER]: { status: 429, body: { error: "rate_limited" } } };
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, { total: 0, byBase: {} }), window: win, location: { origin: WORKER, protocol: "https:" } }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res.status === 200 && res.body && res.body.via === "relay-ntfy", "T Worker 429 限流→去中心化中继档兜底(不把 429 抛给上层)");
    ok(connectCalls === 1 && rtRpc === 1, "T 429 触发了中继档建连 + 一次中继 RPC");
  }

  // 场景 U (中继回包二态): 中继档 role"q" 超限/出错路径回**对象** {status,bodyText}(非 JSON 字符串) → _normHandleRes 须兼容, 不可 JSON.parse 对象抛错。
  {
    const win = { DaoSignal: { available: () => true, connect: function () { return Promise.resolve({ dc: null, close: () => {}, rpc: function () {
      return Promise.resolve({ status: 413, bodyText: "relay payload too large; prefer P2P/Worker for bulk transfer" });   // role"q" 超限: 直接回对象
    } }); } } };
    const routes = { [WORKER]: { status: 503, body: "dead" } };
    const mod = makeModule(baseDeps({ ENDPOINT: WORKER, fetch: makeFetch(routes, { total: 0, byBase: {} }), window: win, location: { origin: WORKER, protocol: "https:" } }));
    const res = await mod.relay("/api/rpc", { cmd: "getState" }, 5000);
    ok(res && res.status === 413, "U 中继档回对象(413 超限)被正确归一为 {status:413}, 不因 JSON.parse 对象而抛错");
  }

  // 场景 J (回归护栏): 主 IIFE 必须在使用前声明 CFG —— 防 PR#547 式 strict ReferenceError 崩整页。
  {
    const fIdx = src.indexOf("__FAILOVER_START__");
    const iifeStart = src.lastIndexOf("<script>", fIdx);
    const seg = src.slice(iifeStart, fIdx);
    ok(/var\s+CFG\s*=/.test(seg), "J 主 IIFE 在引用前声明了 CFG (防整段脚本 ReferenceError 中止)");
  }

  if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
  console.log("\n全部通过 ✓");
  process.exit(0);   // _p2pTry 失败路径会挂 setTimeout 退避重试(产品行为正确), 测试断言完即显式退出, 不让该定时器吊住 node
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
