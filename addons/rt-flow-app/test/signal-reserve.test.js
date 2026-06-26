"use strict";
// 实测 engine.html 的「去中心化信令应答方」生命周期真代码 (切片 //__SIGSERVE_START__…//__SIGSERVE_END__ eval)。
// 本源契约 (彻底打通·持久去中心化):
//   ① 设备身份(session+token)就绪即 DaoSignal.serve() 常驻应答; 身份异步未就绪时重试至就绪。
//   ② token 轮换(rotateToken)/relay 重启会改变派生密钥 H(session+token) → 旧 serve 句柄无法解密
//      新分享链接发来的 offer (浏览器直开「未收到对端应答」=根本没打通)。故周期巡检设备身份,
//      一旦 (session,token) 漂移即关旧句柄、按新身份 re-serve → 分享链接恒可打通。
//   ③ 身份未变时周期巡检不得重复 serve (避免重复订阅/抖动)。
// 无框架: node test/signal-reserve.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "engine.html");
const src = fs.readFileSync(HTML, "utf8");
const m = src.match(/\/\/__SIGSERVE_START__[\s\S]*?\/\/__SIGSERVE_END__/);
if (!m) { console.error("FAIL: 未找到 //__SIGSERVE_START__…//__SIGSERVE_END__ 标记块"); process.exit(1); }
const sliced = m[0];

let fails = 0;
function ok(cond, msg) { if (!cond) { console.error("✗ " + msg); fails++; } else { console.log("✓ " + msg); } }
const realSetTimeout = setTimeout;
const flush = () => new Promise(r => realSetTimeout(r, 0));

// 在隔离作用域跑切片: 提供 window/DaoSignal/N/conn/log/_devSession/_devToken/setTimeout/setInterval 的 mock。
//   serve() 解析为带 .close 的句柄; getConn() 由可变 state 决定 → 模拟 token 轮换。
function harness() {
  const serveCalls = [];     // 每次 serve 的 {session, token}
  const closes = [];         // 每个被关闭的句柄序号
  let handleSeq = 0;
  const connState = { v: { session: "A", token: "t1" } };   // N.getConn() 真源 (可变)
  let intervalFn = null;     // 捕获周期巡检回调, 手动驱动

  const DaoSignal = {
    available: () => true,
    DEFAULT_SERVERS: ["https://ntfy.sh", "https://ntfy.envs.net"],
    serve: (opts) => {
      serveCalls.push({ session: opts.session, token: opts.token });
      const myId = ++handleSeq;
      return Promise.resolve({ ok: true, topic: "topic-" + opts.session, servers: opts.servers, close: () => closes.push(myId) });
    }
  };
  const N = { getConn: () => JSON.stringify(connState.v || {}) };
  const env = {
    window: { DaoSignal },
    DaoSignal,
    N,
    conn: {},                       // 无 signalServers
    log: () => {},
    _devSession: null, _devToken: null,
    setTimeout: () => 0,            // 重试用; happy-path 不触发
    setInterval: (fn) => { intervalFn = fn; return 1; }
  };
  const runner = new Function(
    "window", "DaoSignal", "N", "conn", "log", "_devSession", "_devToken", "setTimeout", "setInterval",
    sliced
  );
  runner(env.window, env.DaoSignal, env.N, env.conn, env.log, env._devSession, env._devToken, env.setTimeout, env.setInterval);
  return { serveCalls, closes, connState, tick: () => intervalFn && intervalFn() };
}

(async function () {
  const h = harness();
  await flush();
  // ① 启动即按当前身份 serve 一次
  ok(h.serveCalls.length === 1 && h.serveCalls[0].token === "t1", "启动即 serve(A/t1) 一次");
  ok(h.closes.length === 0, "首次 serve 不关闭任何句柄");

  // ③ 身份未变 → 周期巡检不重复 serve
  h.tick(); await flush();
  ok(h.serveCalls.length === 1, "身份未变时周期巡检不重复 serve");
  ok(h.closes.length === 0, "身份未变时不关闭句柄");

  // ② token 轮换 → re-serve 新身份 + 关旧句柄
  h.connState.v = { session: "A", token: "t2" };
  h.tick(); await flush();
  ok(h.serveCalls.length === 2 && h.serveCalls[1].token === "t2", "token 轮换后 re-serve(A/t2)");
  ok(h.closes.length === 1 && h.closes[0] === 1, "re-serve 后关闭旧句柄(#1)");

  // 再次巡检(身份仍 t2) → 不再 serve
  h.tick(); await flush();
  ok(h.serveCalls.length === 2, "轮换后身份稳定则不再重复 serve");

  // session 漂移(relay 重启换 session) → 同样 re-serve + 关旧
  h.connState.v = { session: "B", token: "t2" };
  h.tick(); await flush();
  ok(h.serveCalls.length === 3 && h.serveCalls[2].session === "B", "session 漂移后 re-serve(B/t2)");
  ok(h.closes.length === 2 && h.closes[1] === 2, "session 漂移后关闭上一句柄(#2)");

  if (fails) { console.error("\nFAILED: " + fails + " 条断言未过"); process.exit(1); }
  console.log("\nPASS signal-reserve.test.js (应答方身份漂移 re-serve 持久打通)");
})();
