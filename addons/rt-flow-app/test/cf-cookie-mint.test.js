"use strict";
// 实测 relay-app.js 的「会话态·零浏览器·冻结免疫」建 Token 路 (恒定内网穿透通道之本源):
//   用户在 App 内浏览器登录过 CF 后, 引擎经 CookieManager 会话 cookie + 原生 HTTP 桥直调 dashboard
//   内部接口建最小权限 Token → 转 cfProvisionRun 部署 Worker。全程零可见标签·零前台·后台标签冻结免疫。
// 覆盖: 纯函数 (权限组匹配/多账号选择/Token 载荷) + 会话态 mint 编排 (注入 cookie/dash 替身·不触真实网络)。
// 无框架: node test/cf-cookie-mint.test.js (退出码非 0 即失败)。
const assert = require("assert");
const path = require("path");
const { DaoRelayApp } = require(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "relay-app.js"));
const CF = DaoRelayApp._cf;

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// CF 权限组全集 (含大小写/空白差异·成员/无关组·验证容错匹配)
const GROUPS = [
  { id: "g_ws", name: "Workers Scripts Write" },
  { id: "g_as", name: "  account settings read " },   // 大小写+空白差异
  { id: "g_ud", name: "User Details Read" },
  { id: "g_mr", name: "Memberships Read" },
  { id: "g_dns", name: "DNS Write" },                  // 无关组
];

(async () => {
  // ── 1) 纯函数: 权限组匹配 (精确 + trim/不分大小写回退) ──
  const acct = CF.pickGroups(GROUPS, ["Workers Scripts Write", "Account Settings Read"]);
  ok(acct.length === 2 && acct[0].id === "g_ws" && acct[1].id === "g_as", "pickGroups: 精确+大小写/空白容错命中账号级两组");
  const miss = CF.missingGroups(GROUPS, ["Workers Scripts Write", "Account Settings Read"]);
  ok(miss.length === 0, "missingGroups: 账号级两组齐备 → 无缺");
  const miss2 = CF.missingGroups([{ id: "x", name: "DNS Write" }], ["Workers Scripts Write"]);
  ok(miss2.length === 1 && miss2[0] === "Workers Scripts Write", "missingGroups: 缺组精确列出");

  // ── 2) 纯函数: Token 载荷 = 最小权限双策略 (账号级 + 用户级·资源精确钉 id) ──
  const payload = CF.buildTokenPayload({ name: "t", accountId: "ACC1", userId: "USR1", groups: GROUPS });
  ok(payload.policies.length === 2, "buildTokenPayload: 账号级+用户级 两条策略");
  const ap = payload.policies.find((p) => p.resources["com.cloudflare.api.account.ACC1"] === "*");
  const up = payload.policies.find((p) => p.resources["com.cloudflare.api.user.USR1"] === "*");
  ok(ap && ap.permission_groups.length === 2, "账号策略钉 account.ACC1 + Workers写/账号设置读");
  ok(up && up.permission_groups.length === 2, "用户策略钉 user.USR1 + 用户详情读/成员读 (非误用 acctG)");

  // ── 3) 纯函数: 多账号选择 ──
  ok(CF.pickAccount([{ id: "a1" }], "").id === "a1", "pickAccount: 单账号自动选");
  ok(CF.pickAccount([{ id: "a1" }, { id: "a2" }], "a2").id === "a2", "pickAccount: 指定命中");
  assert.throws(() => CF.pickAccount([{ id: "a1" }, { id: "a2" }], ""), /multi_account/, "pickAccount: 多账号未指定 → multi_account 报错");
  assert.throws(() => CF.pickAccount([{ id: "a1" }], "zzz"), /account_not_found/, "pickAccount: 指定不存在 → account_not_found");
  assert.throws(() => CF.pickAccount([], ""), /no_account/, "pickAccount: 空 → no_account");
  ok(true, "pickAccount 三类错误分支均如期抛出");

  // ── 4) 会话态 mint 编排: 注入 cookie + dash HTTP 替身, 断言端点顺序/头/无 token 泄漏 ──
  const dashCalls = [];
  function dashResp(obj, status) { return Promise.resolve({ status: status || 200, text: JSON.stringify(obj) }); }
  DaoRelayApp.setCfCookieFn((url) => (String(url).indexOf("cloudflare.com") >= 0 ? "cf_clearance=xyz; __cfruid=abc" : ""));
  DaoRelayApp.setCfDashFn(function (method, url, headers, body) {
    dashCalls.push({ method, url, headers, body });
    if (url.endsWith("/api/v4/user")) return dashResp({ success: true, result: { id: "USR1", email: "z@e.com" } });
    if (url.indexOf("/api/v4/accounts") >= 0) return dashResp({ success: true, result: [{ id: "ACC1" }] });
    if (url.endsWith("/permission_groups")) return dashResp({ success: true, result: GROUPS });
    if (url.endsWith("/api/v4/user/tokens") && method === "POST") return dashResp({ success: true, result: { id: "tok1", value: "SECRET_TOKEN_VALUE_9876543210" } });
    return dashResp({ success: false, errors: [{ message: "unexpected " + url }] }, 500);
  });

  const minted = await CF.mintViaCookie({ accountId: "ACC1" });
  ok(minted.token === "SECRET_TOKEN_VALUE_9876543210" && minted.accountId === "ACC1", "mintViaCookie: 返回 token+accountId");
  const order = dashCalls.map((c) => c.url.replace("https://dash.cloudflare.com", ""));
  ok(order[0] === "/api/v4/user" && order[1].indexOf("/api/v4/accounts") === 0 && order[2].endsWith("/permission_groups") && order[3] === "/api/v4/user/tokens", "端点顺序: user → accounts → permission_groups → POST tokens");
  const post = dashCalls.find((c) => c.method === "POST");
  ok(post.headers.Cookie && post.headers.Cookie.indexOf("cf_clearance") >= 0, "POST 带会话 Cookie 头");
  ok(post.headers.Origin === "https://dash.cloudflare.com" && post.headers.Referer === "https://dash.cloudflare.com/", "POST 带 Origin/Referer 同源头 (绕过 CSRF)");
  ok(post.headers["X-Requested-With"] === "XMLHttpRequest", "POST 带 X-Requested-With (dashboard 内部接口约定)");
  ok(post.headers["X-Cross-Site-Security"] === "dash", "POST 带 X-Cross-Site-Security:dash (CF 现要求·缺则 403·实测验证)");

  // ── 5) 无登录态 → no_cf_session (明确区分未登录 vs 过期) ──
  DaoRelayApp.setCfCookieFn(() => "");
  let e5 = null; try { await CF.mintViaCookie({}); } catch (e) { e5 = e; }
  ok(e5 && /no_cf_session/.test(e5.message), "无 cookie → no_cf_session 明确报错");

  // ── 6) 缺权限组 → missing_perm_groups (建 Token 前拦截·不静默铸欠权 Token) ──
  DaoRelayApp.setCfCookieFn(() => "cf_clearance=xyz");
  DaoRelayApp.setCfDashFn(function (method, url) {
    if (url.endsWith("/api/v4/user")) return dashResp({ success: true, result: { id: "USR1" } });
    if (url.indexOf("/api/v4/accounts") >= 0) return dashResp({ success: true, result: [{ id: "ACC1" }] });
    if (url.endsWith("/permission_groups")) return dashResp({ success: true, result: [{ id: "g_dns", name: "DNS Write" }] });
    return dashResp({ success: false }, 500);
  });
  let e6 = null; try { await CF.mintViaCookie({ accountId: "ACC1" }); } catch (e) { e6 = e; }
  ok(e6 && /missing_perm_groups/.test(e6.message), "缺账号级权限组 → missing_perm_groups (POST tokens 未被调用)");

  // ── 7) token 秘密性: 任何抛错信息都不含 token 明文 ──
  const allErrs = [e5, e6].map((e) => (e && e.message) || "").join(" | ");
  ok(allErrs.indexOf("SECRET_TOKEN_VALUE") < 0, "错误信息不含 token 明文");

  // ── 8) /api/cf-autoprovision 路由: 只收 accountId·启动异步·回 poll 契约 ──
  const rpc = async (p, body) => { const raw = await DaoRelayApp.serveLocal(JSON.stringify({ path: p, method: "POST", body: body || {} })); const o = JSON.parse(raw); return { status: o.status, body: JSON.parse(o.bodyText) }; };
  DaoRelayApp.setCfCookieFn(() => "");   // 无登录态 → 会异步走进 no_cf_session, 但路由本身应立即 started
  const r8 = await rpc("/api/cf-autoprovision", { accountId: "ACC1" });
  ok(r8.status === 200 && r8.body.started === true && r8.body.mode === "cookie-session", "cf-autoprovision → started + mode=cookie-session");
  ok(r8.body.poll === "/api/cf-status", "cf-autoprovision 回 poll=/api/cf-status");

  // ── 9) 离屏真 Chromium 同源建 Token 为首选: 注入 cfWebMintFn → 走 web mint, 原生 dash HTTP 不被触碰 ──
  //   (CF 机管把 dash /api/v4 与浏览器指纹+cf_clearance+SameSite cookie 强绑·原生 HTTP 会 403;
  //    离屏真 Chromium 导航 dash 同源 fetch 带齐全部 cookie 过机管, 又冻结免疫 → 本源正解为首选。)
  const dashHit9 = [];
  DaoRelayApp.setCfCookieFn(() => "cf_clearance=xyz");
  DaoRelayApp.setCfDashFn(function (method, url) { dashHit9.push(url); return dashResp({ success: false }, 403); });
  DaoRelayApp.setCfWebMintFn(function (id, a) { setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ token: "WEB_TOKEN_5555", accountId: a || "ACCW" }))); });
  const m9 = await CF.mintViaCookie({ accountId: "ACCW" });
  ok(m9.token === "WEB_TOKEN_5555" && m9.accountId === "ACCW", "mintViaCookie: 首选离屏真 Chromium 同源建 Token 返回 token+accountId");
  ok(dashHit9.length === 0, "web mint 成功 → 原生 dash HTTP 完全不被触碰 (不重蹈 403 老路)");

  // ── 10) web mint 语义错误 (no_cf_session) 直接上抛, 不静默落原生兜底 (避免同一错误被 403 掩盖) ──
  DaoRelayApp.setCfWebMintFn(function (id) { setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ error: "no_cf_session" }))); });
  let e10 = null; try { await CF.mintViaCookie({ accountId: "ACCW" }); } catch (e) { e10 = e; }
  ok(e10 && /no_cf_session/.test(e10.message), "web mint 语义错误 → 直接上抛 no_cf_session");
  ok(dashHit9.length === 0, "web mint 语义错误 → 未落原生兜底");

  // ── 11) web mint 非语义错误 (桥超时/坏结果) → 落原生 HTTP 兜底成功 (双路互补·不空手而归) ──
  DaoRelayApp.setCfDashFn(function (method, url) {
    if (url.endsWith("/api/v4/user")) return dashResp({ success: true, result: { id: "USR1" } });
    if (url.indexOf("/api/v4/accounts") >= 0) return dashResp({ success: true, result: [{ id: "ACC1" }] });
    if (url.endsWith("/permission_groups")) return dashResp({ success: true, result: GROUPS });
    if (url.endsWith("/api/v4/user/tokens") && method === "POST") return dashResp({ success: true, result: { value: "NATIVE_FALLBACK_TOK" } });
    return dashResp({ success: false }, 500);
  });
  DaoRelayApp.setCfWebMintFn(function (id) { setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ error: "cf_webmint_bad_result" }))); });
  const m11 = await CF.mintViaCookie({ accountId: "ACC1" });
  ok(m11.token === "NATIVE_FALLBACK_TOK", "web mint 非语义错误 → 落原生 HTTP 兜底建 Token 成功");

  // 待 cfProv 单例状态从 running 落定 (前面异步 mint 会把 phase 置 running·避免后续路由被判 already)。
  async function settle() { for (let i = 0; i < 200; i++) { const s = await rpc("/api/cf-status"); if (!s.body || s.body.phase !== "running") return; await new Promise((r) => setTimeout(r, 5)); } }

  // ── 12) 自包含离屏「代登录→建 Token」桥 (cfWebAuto·本源: 用户只提供账号·离屏真 Chromium 自己登录) ──
  let waCfg = null;
  DaoRelayApp.setCfWebAutoFn(function (id, c) { waCfg = JSON.parse(c); setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ token: "WEBAUTO_TOK_7777", accountId: "ACCA" }))); });
  const m12 = await CF.webAuto({ cf: { user: "u@e.com", pass: "pw", otp: "" }, accountId: "ACCA" });
  ok(m12.token === "WEBAUTO_TOK_7777" && m12.accountId === "ACCA", "cfWebAuto: 返回 token+accountId");
  ok(waCfg && waCfg.cf && waCfg.cf.user === "u@e.com" && waCfg.accountId === "ACCA", "cfWebAuto: 账密+accountId 原样透传给离屏桥 (凭证不过中继)");

  // ── 13) 命中人机验证/硬件密钥 → cf_challenge 语义错误上抛 (不代按·由 UI 提示前台过一次) ──
  DaoRelayApp.setCfWebAutoFn(function (id) { setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ error: "cf_challenge" }))); });
  let e13 = null; try { await CF.webAuto({ cf: { user: "u@e.com", pass: "pw" } }); } catch (e) { e13 = e; }
  ok(e13 && /cf_challenge/.test(e13.message), "cfWebAuto 命中人机验证 → cf_challenge 上抛");

  // ── 14) /api/cf-autoprovision 路由: 带 email+password → mode=web-auto (用户只提供账号即启动) ──
  //   (先于「直调 autoProvisionRun」测·后者会把 cfProv 单例状态留在 running·避免污染本路由判定。)
  await settle();
  DaoRelayApp.setCfWebAutoFn(function (id) { setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ error: "test_stop" }))); });
  const r14 = await rpc("/api/cf-autoprovision", { email: "u@e.com", password: "pw" });
  ok(r14.status === 200 && r14.body.started === true && r14.body.mode === "web-auto", "cf-autoprovision 带账密 → started + mode=web-auto");
  await settle();

  // ── 15) autoProvisionRun 路由: 有账密走离屏 web-auto (不读会话 cookie); token 秘密性不泄漏到错误 ──
  let waUsed = false, ckRead = false;
  DaoRelayApp.setCfWebAutoFn(function (id) { waUsed = true; setImmediate(() => global.__cfWebMintCb(id, JSON.stringify({ error: "test_stop_after_mint" }))); });
  DaoRelayApp.setCfCookieFn(() => { ckRead = true; return "cf_clearance=x"; });
  let e15 = null; try { await CF.autoProvisionRun({ cf: { user: "u@e.com", pass: "pw" } }); } catch (e) { e15 = e; }
  ok(waUsed && !ckRead, "autoProvisionRun 有账密 → 走离屏 web-auto·完全不读会话 cookie");
  ok(e15 && e15.message.indexOf("WEBAUTO_TOK") < 0 && e15.message.indexOf("pw") < 0, "错误信息不含 token/密码明文");

  // 复位注入, 不污染同进程其它测试
  DaoRelayApp.setCfWebMintFn(null);
  DaoRelayApp.setCfWebAutoFn(null);
  DaoRelayApp.setCfCookieFn(null);
  DaoRelayApp.setCfDashFn(null);

  console.log(failures ? ("\nFAIL " + failures) : "\nALL GREEN (cf-cookie-mint)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THROW", e); process.exit(1); });
