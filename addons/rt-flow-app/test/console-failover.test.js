"use strict";
// 实测 console.html 的「通道自愈 failover」真代码 (切片 //__FAILOVER_START__…//__FAILOVER_END__ eval)。
// 无框架: 直接 node test/console-failover.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "console.html");
const src = fs.readFileSync(HTML, "utf8");
const m = src.match(/\/\/__FAILOVER_START__[\s\S]*?\/\/__FAILOVER_END__/);
if (!m) { console.error("FAIL: 未找到 //__FAILOVER_START__…//__FAILOVER_END__ 标记块"); process.exit(1); }
const sliced = m[0];

// 把切片包进工厂函数, 以闭包局部变量提供 console.html 同名外层依赖 (ENDPOINT 可被内部重赋值)。
function makeModule(deps) {
  const factorySrc = "(function(deps){\n" +
    "var CFG=deps.CFG, SESSION=deps.SESSION, TOKEN=deps.TOKEN, ENDPOINT=deps.ENDPOINT;\n" +
    "var qp=deps.qp, persist=deps.persist, localStorage=deps.localStorage, location=deps.location, fetch=deps.fetch;\n" +
    sliced + "\n" +
    "return { relay: relay, getEndpoint: function(){ return ENDPOINT; }, candBases: _candBases };\n" +
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
}, over);

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

  if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
  console.log("\n全部通过 ✓");
})().catch(e => { console.error("测试异常:", e); process.exit(1); });
