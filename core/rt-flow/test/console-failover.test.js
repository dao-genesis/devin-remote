"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// console-failover.test.js · 切片 eval 实测 (node test/console-failover.test.js)
//
//   兑现 console.html 内 //__FAILOVER_START__ / //__P2P_START__ 两块旁标注的
//   「经 test/console-failover.test.js 切片 eval 实测, 勿删标记」承诺 —— 此前该
//   文件缺失、去中心化数据面(P2P 优先 + HTTP 自愈 failover)零回归护栏。
//
//   反者道之动: 把这两块运行逻辑从 console.html 原样切出、注入受控 mock 后 eval,
//   验证不变量: ① 通道「已死」判定 ② 候选清单去重 ③ HTTP 自愈切活通道 ④ P2P 优先
//   且失败零代价无缝回退 HTTP ⑤ 中继 FIFO 单飞。并连带验证 signal.js 去中心化信令
//   的加密/分片纯函数不变量 (seal/unseal 往返·错钥即拒·topic 确定性·broker 规范化)。
//   纯 node assert, 无网络无 vscode, 直接进 CI。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "..", "..", "addons", "rt-flow-app", "app", "src", "main", "assets", "engine");
const CONSOLE_HTML = fs.readFileSync(path.join(ENGINE, "console.html"), "utf8");
const SIGNAL_JS = fs.readFileSync(path.join(ENGINE, "signal.js"), "utf8");

let passed = 0, failed = 0;
const failures = [];
// 串行执行: 每个 test 都 await, 保证异步断言在汇总前完成。
async function test(name, fn) {
  try {
    await fn();
    passed++; console.log("  ok   " + name);
  } catch (e) { failed++; failures.push([name, e]); console.log("  FAIL " + name + " — " + (e && e.message)); }
}

// ── 按标记切出源块 (标记缺失即测试失败, 即「勿删标记」的护栏作用) ──────────────
function slice(src, startMark, endMark) {
  const i = src.indexOf(startMark), j = src.indexOf(endMark);
  assert.ok(i >= 0, "console.html 缺标记 " + startMark + " (勿删)");
  assert.ok(j > i, "console.html 缺标记 " + endMark + " (勿删)");
  return src.slice(i, j + endMark.length);
}
const FAILOVER = slice(CONSOLE_HTML, "//__FAILOVER_START__", "//__FAILOVER_END__");
const P2P = slice(CONSOLE_HTML, "//__P2P_START__", "//__P2P_END__");

// ── 把两块切片注入受控环境 eval, 暴露内部函数供断言 ──────────────────────────
function makeConsole(opts) {
  opts = opts || {};
  const store = Object.create(null);
  const localStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
  };
  if (opts.lsGood) store["rtflow.rn.endpoint.good"] = opts.lsGood;
  const body = FAILOVER + "\n" + P2P + "\n" +
    "return { relay, _relayDirect, _relayHttp, _dead, _candBases, _resolveLive, _p2pAlive, " +
    "STABLE_RELAY, RQ_MAX:_RQ_MAX, setP2P:function(p){_p2p=p;}, getP2P:function(){return _p2p;}, " +
    "getEndpoint:function(){return ENDPOINT;} };";
  // AbortController 故意传 undefined → 切片内 typeof 守卫走「无 signal」分支, fetch mock 免处理 signal。
  const f = new Function("SESSION", "TOKEN", "ENDPOINT", "CFG", "qp", "fetch", "AbortController", "localStorage", "persist", "location", "window", body);
  return f(
    opts.session || "rtflow-test",
    opts.token || "tok123",
    opts.endpoint || "https://ep.example",
    opts.cfg || {},
    opts.qp || function () { return ""; },
    opts.fetch || function () { return Promise.reject(new Error("no fetch mock")); },
    undefined,
    localStorage,
    opts.persist || function () {},
    opts.location || { origin: "https://origin.example" },
    opts.window || { DaoSignal: undefined }
  );
}
// fetch mock: 按 url 子串决定 status/body, 计数调用; 返回 {status,text()} 同真 fetch 形态。
function fakeFetch(routes, counter) {
  return function (url) {
    if (counter) counter.n = (counter.n || 0) + 1;
    let status = 200, bodyObj = { ok: true };
    for (const key in routes) { if (url.indexOf(key) >= 0) { status = routes[key].status; bodyObj = routes[key].body; break; } }
    return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(bodyObj)) });
  };
}
// signal.js 纯函数测试面: 注入 window mock 后 eval, Node 全局已有 crypto/TextEncoder/btoa。
function loadSignal() {
  const f = new Function("window", SIGNAL_JS + "\nreturn window.DaoSignal;");
  return f({});
}

(async () => {
  // ── 1. _dead: 通道「已死」五态判定 ────────────────────────────────────────
  console.log("\n[_dead 通道已死判定]");
  const C = makeConsole({});
  await test("无响应(网络层失败) → 死", () => assert.strictEqual(C._dead(null), true));
  await test("status 0 → 死", () => assert.strictEqual(C._dead({ status: 0 }), true));
  await test("502/503 (隧道530/中继503) → 死", () => {
    assert.strictEqual(C._dead({ status: 502 }), true);
    assert.strictEqual(C._dead({ status: 503 }), true);
  });
  await test("500/501 < 502 → 不算死 (不误切个别 5xx)", () => {
    assert.strictEqual(C._dead({ status: 500 }), false);
    assert.strictEqual(C._dead({ status: 501 }), false);
  });
  await test("200 正常 body → 不死", () => assert.strictEqual(C._dead({ status: 200, body: {} }), false));
  await test("200 但 no_agent/no_tunnel → 死 (agent 不在线)", () => {
    assert.strictEqual(C._dead({ status: 200, body: { error: "no_agent" } }), true);
    assert.strictEqual(C._dead({ status: 200, body: { error: "no_tunnel" } }), true);
  });
  await test("200 bad_json → 不死 (避免对非JSON正常响应误切)", () => assert.strictEqual(C._dead({ status: 200, body: { error: "bad_json" } }), false));

  // ── 2. _candBases: 候选清单去重 + 含稳定锚点 + 顺序 ────────────────────────
  console.log("\n[_candBases 候选清单]");
  await test("去重 + 含 STABLE_RELAY + location.origin, ENDPOINT 居首", () => {
    const c = makeConsole({ endpoint: "https://ep", lsGood: "https://good",
      cfg: { worker: "https://stable", endpoints: ["https://c1", "https://ep"] },
      location: { origin: "https://origin" } });
    const bases = c._candBases();
    assert.deepStrictEqual(bases, ["https://ep", "https://good", "https://c1", "https://stable", "https://origin"]);
  });
  await test("末尾斜杠归一化后去重", () => {
    const c = makeConsole({ endpoint: "https://ep/", cfg: { worker: "https://ep", endpoints: ["https://ep"] }, location: { origin: "https://ep///" } });
    assert.deepStrictEqual(c._candBases(), ["https://ep"]);
  });

  // ── 3. 中继 FIFO 单飞 (并发上限 1) ────────────────────────────────────────
  console.log("\n[relay FIFO 单飞]");
  await test("_RQ_MAX === 1", () => assert.strictEqual(C.RQ_MAX, 1));
  await test("并发 relay() 串行执行 (峰值在飞 ≤ 1)", async () => {
    let cur = 0, max = 0;
    const c = makeConsole({ fetch: function () {
      cur++; max = Math.max(max, cur);
      return new Promise((res) => setTimeout(() => res({ status: 200, text: () => { cur--; return Promise.resolve("{\"ok\":true}"); } }), 5));
    } });
    await Promise.all([c.relay("/api/rpc", {}), c.relay("/api/rpc", {}), c.relay("/api/rpc", {})]);
    assert.strictEqual(max, 1, "三路并发应串行, 峰值在飞=1");
  });

  // ── 4. _relayDirect: P2P 优先 + 失败零代价回退 HTTP ───────────────────────
  console.log("\n[_relayDirect P2P 优先/回退]");
  await test("P2P 在线 → 走 P2P, 完全不碰 HTTP", async () => {
    const counter = { n: 0 };
    const c = makeConsole({ fetch: fakeFetch({ "/relay/": { status: 200, body: { via: "http" } } }, counter) });
    c.setP2P({ dc: { readyState: "open" }, rpc: () => Promise.resolve(JSON.stringify({ status: 200, bodyText: JSON.stringify({ via: "p2p" }) })) });
    const res = await c._relayDirect("/api/rpc", {});
    assert.strictEqual(res.body.via, "p2p");
    assert.strictEqual(counter.n, 0, "P2P 命中时不应发 HTTP");
  });
  await test("无 P2P → 回退 HTTP", async () => {
    const counter = { n: 0 };
    const c = makeConsole({ fetch: fakeFetch({ "/relay/": { status: 200, body: { via: "http" } } }, counter) });
    c.setP2P(null);
    const res = await c._relayDirect("/api/rpc", {});
    assert.strictEqual(res.body.via, "http");
    assert.strictEqual(counter.n, 1);
  });
  await test("P2P 链路异常 → 失效并本次无缝回退 HTTP", async () => {
    const counter = { n: 0 };
    const c = makeConsole({ fetch: fakeFetch({ "/relay/": { status: 200, body: { via: "http" } } }, counter) });
    c.setP2P({ dc: { readyState: "open" }, rpc: () => Promise.reject(new Error("boom")) });
    const res = await c._relayDirect("/api/rpc", {});
    assert.strictEqual(res.body.via, "http");
    assert.strictEqual(c.getP2P(), null, "异常后应置 _p2p=null 触发后台重连");
    assert.ok(counter.n >= 1);
  });

  // ── 5. _relayHttp: 死通道自愈, 切到候选活通道 ─────────────────────────────
  console.log("\n[_relayHttp 通道自愈]");
  await test("ENDPOINT 死(502) → 探活切到 STABLE 活通道并复跑", async () => {
    const c = makeConsole({ endpoint: "https://dead", cfg: { worker: "https://live" }, location: { origin: "https://dead" },
      fetch: fakeFetch({ "dead/relay/": { status: 502, body: {} }, "live/relay/": { status: 200, body: { via: "live" } } }) });
    const res = await c._relayHttp("/api/rpc", {});
    assert.strictEqual(res.body.via, "live");
    assert.strictEqual(c.getEndpoint(), "https://live", "应持久化切换到活通道");
  });
  await test("全部候选皆死 → 原样返回原结果 (行为与旧版一致, 不破坏)", async () => {
    const c = makeConsole({ endpoint: "https://dead", cfg: { worker: "https://dead2" }, location: { origin: "https://dead3" },
      fetch: fakeFetch({ "/relay/": { status: 502, body: { error: "no_agent" } } }) });
    const res = await c._relayHttp("/api/rpc", {});
    assert.strictEqual(res.status, 502, "无活通道时原样返回原结果");
  });

  // ── 6. signal.js 去中心化信令纯函数不变量 ─────────────────────────────────
  console.log("\n[signal.js 去中心化信令]");
  const DS = loadSignal();
  const SI = DS && DS._internals;
  await test("DaoSignal 暴露 serve/connect/available/_internals", () => {
    assert.strictEqual(typeof DS.serve, "function");
    assert.strictEqual(typeof DS.connect, "function");
    assert.strictEqual(typeof DS.available, "function");
    assert.ok(SI && typeof SI.deriveKey === "function", "_internals 缺测试面");
  });
  await test("available() === true (Node 有 crypto.subtle)", () => assert.strictEqual(DS.available(), true));
  await test("topicFor 确定性 + 27 字符 dao+24hex + 不公开 session", async () => {
    const t1 = await DS.topicFor("sess-A"), t2 = await DS.topicFor("sess-A"), t3 = await DS.topicFor("sess-B");
    assert.strictEqual(t1, t2);
    assert.ok(/^dao[0-9a-f]{24}$/.test(t1), "topic 须 dao + 24 hex (=27 字符纯 alnum)");
    assert.notStrictEqual(t1, t3);
    assert.ok(t1.indexOf("sess-A") < 0, "topic 不得含 session 明文");
  });
  await test("seal/unseal 往返还原 (正确钥)", async () => {
    const key = await SI.deriveKey("sess", "tok");
    const obj = { a: 1, b: "héllo·道", arr: [1, 2, 3] };
    const sealed = await SI.seal(key, obj);
    assert.strictEqual(typeof sealed, "string");
    assert.deepStrictEqual(await SI.unseal(key, sealed), obj);
  });
  await test("错钥(token 不符)解封 → null (token 即准入门禁)", async () => {
    const k1 = await SI.deriveKey("sess", "tok"), k2 = await SI.deriveKey("sess", "WRONG");
    const sealed = await SI.seal(k1, { x: 1 });
    assert.strictEqual(await SI.unseal(k2, sealed), null);
    assert.strictEqual(await SI.unseal(k1, "not-base64-cipher!!"), null);
  });
  await test("normServers 去重/过滤非http/缺省回落公共 mesh", () => {
    assert.deepStrictEqual(SI.normServers(["https://a", "https://a/", "http://b", "ftp://x", "nope", ""]), ["https://a", "http://b"]);
    assert.deepStrictEqual(SI.normServers("https://x, https://y"), ["https://x", "https://y"]);
    const def = SI.normServers([]);
    assert.ok(Array.isArray(def) && def.length >= 3 && def.every((u) => /^https?:\/\//.test(u)), "空入参须回落多家公共实例");
  });
  await test("frameChunks 分片可解析且可无损重组", () => {
    const payload = "x".repeat(2500);   // > CHUNK(1200) → 多片
    const frames = SI.frameChunks("corr1", "o", payload);
    assert.ok(frames.length >= 2, "超长载荷须分片");
    let reassembled = "";
    frames.forEach((fr, i) => {
      const o = JSON.parse(fr);
      assert.strictEqual(o.c, "corr1");
      assert.strictEqual(o.r, "o");
      assert.strictEqual(o.i, i);
      assert.strictEqual(o.n, frames.length);
      reassembled += o.p;
    });
    assert.strictEqual(reassembled, payload, "重组须逐字节还原");
  });

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────");
  console.log("PASS " + passed + "  FAIL " + failed);
  if (failed) {
    failures.forEach(([n, e]) => console.log("  ✗ " + n + "\n     " + (e && e.stack || e)));
    process.exit(1);
  }
  console.log("ALL GREEN");
})();
