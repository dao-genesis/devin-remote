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
    "         p2pTry: _p2pTry, p2pAlive: _p2pAlive, setP2P: function(p){ _p2p=p; } };\n" +
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

  // 场景 J (回归护栏): 主 IIFE 必须在使用前声明 CFG —— 防 PR#547 式 strict ReferenceError 崩整页。
  {
    const fIdx = src.indexOf("__FAILOVER_START__");
    const iifeStart = src.lastIndexOf("<script>", fIdx);
    const seg = src.slice(iifeStart, fIdx);
    ok(/var\s+CFG\s*=/.test(seg), "J 主 IIFE 在引用前声明了 CFG (防整段脚本 ReferenceError 中止)");
  }

  if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
  console.log("\n全部通过 ✓");
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
