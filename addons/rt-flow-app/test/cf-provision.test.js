"use strict";
// 实测 relay-app.js 的「Cloudflare 一键建 Worker」(可选·唯一需用户配置项): 用户粘贴 API Token →
// 本地中继帧管线 /api/cf-provision 启动 → /api/cf-status 轮询进度。全程纯 fetch (无 Node/wrangler),
// 走 CF REST 多模块上传, worker 源取自公开仓 raw。此测试注入 mock fetch, 不触真实网络。
// 无框架: node test/cf-provision.test.js (退出码非 0 即失败)。
const assert = require("assert");
const path = require("path");
const { DaoRelayApp } = require(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "relay-app.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(p, method, body) {
  const raw = await DaoRelayApp.serveLocal(JSON.stringify({ path: p, method: method || "POST", body: body || {} }));
  const outer = JSON.parse(raw);
  return { status: outer.status, body: JSON.parse(outer.bodyText) };
}

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 记录被调用的 CF/GitHub 端点, 断言编排顺序与形态。
const calls = [];
function jsonResp(obj, status) {
  return Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(obj), text: () => Promise.resolve(JSON.stringify(obj)) });
}
function textResp(s, status) {
  return Promise.resolve({ ok: (status || 200) < 400, status: status || 200, text: () => Promise.resolve(s), json: () => Promise.resolve({}) });
}
function mockFetch(url, init) {
  const hdrs = (init && init.headers) || {};
  calls.push({ url: String(url), method: (init && init.method) || "GET", hasForm: !!(init && init.body && typeof FormData !== "undefined" && init.body instanceof FormData), headers: hdrs });
  const u = String(url);
  if (u.endsWith("/user")) return jsonResp({ success: true, result: { id: "usr1", email: "fib@example.com" } });
  if (u.endsWith("/user/tokens/verify")) return jsonResp({ success: true, result: { status: "active" } });
  if (u.indexOf("/accounts?per_page") >= 0) return jsonResp({ success: true, result: [{ id: "acc123456789" }] });
  if (/\/accounts\/[^/]+\/workers\/subdomain$/.test(u)) return jsonResp({ success: true, result: { subdomain: "myzone" } });
  if (u.indexOf("raw.githubusercontent.com") >= 0) return textResp("// worker/keys source stub\n");
  if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(u)) return jsonResp({ success: true, result: { enabled: true } });
  if (/\/workers\/scripts\/[^/]+$/.test(u)) return jsonResp({ success: true, result: { id: "dao-relay-do" } });
  if (u.indexOf(".workers.dev/health") >= 0) return jsonResp({ status: "ok" });
  return jsonResp({ success: false, errors: [{ message: "unexpected " + u }] }, 500);
}

(async () => {
  ok(typeof FormData !== "undefined" && typeof Blob !== "undefined", "运行环境含 FormData/Blob (Node18+; WebView 天然具备)");
  DaoRelayApp.setNetFn(mockFetch);

  // 0) 初始 cf-status = idle (未配置·零账号内置中继)
  const s0 = await rpc("/api/cf-status", "GET");
  ok(s0.status === 200 && s0.body.phase === "idle", "cf-status 初始 idle (零账号内置中继)");

  // 1) 短 token 被拒
  const bad = await rpc("/api/cf-provision", "POST", { token: "short" });
  ok(bad.status === 400, "过短 token → 400");

  // 2) 合法 token 启动 provision (异步), 立即返回 started
  const start = await rpc("/api/cf-provision", "POST", { token: "cf_valid_token_abcdefghijklmnop" });
  ok(start.status === 200 && start.body.started === true, "cf-provision 启动 → started=true");

  // 3) 轮询 cf-status 直到 done/error
  let st = null;
  for (let i = 0; i < 50; i++) { st = await rpc("/api/cf-status", "GET"); if (st.body.phase === "done" || st.body.phase === "error") break; await sleep(20); }
  ok(st.body.phase === "done", "provision 编排完成 → done (mock 全绿)");
  ok(/dao-relay-do\.myzone\.workers\.dev/.test(st.body.url), "得到 workers.dev 恒定 URL (子域=myzone)");
  ok(st.body.healthy === true, "健康探测通过");

  // 4) 编排顺序: verify → accounts → subdomain → 取源 → PUT script(multipart) → enable subdomain → health
  const seq = calls.map((c) => c.url);
  ok(seq.some((u) => u.endsWith("/user/tokens/verify")), "调用了 token verify");
  ok(seq.some((u) => u.indexOf("/accounts?per_page") >= 0), "调用了 accounts 列举");
  ok(calls.some((c) => /\/workers\/scripts\/dao-relay-do$/.test(c.url) && c.method === "PUT" && c.hasForm), "以 multipart FormData PUT 上传 worker 脚本");
  ok(seq.filter((u) => u.indexOf("raw.githubusercontent.com") >= 0).length === 2, "取了 worker.js + keys.js 两个模块源");

  // 4b) Global API Key (email+key) 路: 纯后端·零浏览器 —— 走 /user 校验 + X-Auth-* 头
  calls.length = 0;
  DaoRelayApp.setNetFn(mockFetch);
  const badGk = await rpc("/api/cf-provision", "POST", { email: "fib@example.com", apiKey: "short" });
  ok(badGk.status === 400, "Global API Key 过短 → 400");
  const startGk = await rpc("/api/cf-provision", "POST", { email: "fib@example.com", apiKey: "globalkey_abcdefghijklmnopqrstuvwxyz" });
  ok(startGk.status === 200 && startGk.body.started === true, "Global API Key 启动 → started=true");
  let sg = null;
  for (let i = 0; i < 50; i++) { sg = await rpc("/api/cf-status", "GET"); if (sg.body.phase === "done" || sg.body.phase === "error") break; await sleep(20); }
  ok(sg.body.phase === "done", "Global API Key 编排完成 → done");
  ok(calls.some((c) => c.url.endsWith("/user") && c.headers["X-Auth-Email"] === "fib@example.com"), "Global API Key 走 /user 校验且带 X-Auth-Email 头");
  ok(calls.some((c) => c.headers["X-Auth-Key"] === "globalkey_abcdefghijklmnopqrstuvwxyz") && !calls.some((c) => (c.headers.Authorization || "").indexOf("globalkey_") >= 0), "全程走 X-Auth-Key 头·不降级成 Bearer");
  ok(!calls.some((c) => c.url.endsWith("/user/tokens/verify")), "Global API Key 路不调 token verify");

  // 5) verify 失败 → error 且不泄 token
  calls.length = 0;
  DaoRelayApp.setNetFn(function (url) { if (String(url).endsWith("/user/tokens/verify")) return jsonResp({ success: false, errors: [{ message: "invalid token" }] }, 401); return mockFetch(url); });
  await rpc("/api/cf-provision", "POST", { token: "cf_bad_token_abcdefghijklmnop" });
  let se = null;
  for (let i = 0; i < 50; i++) { se = await rpc("/api/cf-status", "GET"); if (se.body.phase === "error") break; await sleep(20); }
  ok(se.body.phase === "error", "verify 失败 → phase=error");
  ok(se.body.error.indexOf("cf_bad_token") < 0 && se.body.msg.indexOf("cf_bad_token") < 0, "错误信息不含 token 明文");

  console.log(failures ? ("\nFAIL " + failures) : "\nALL GREEN (cf-provision)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THROW", e); process.exit(1); });
