"use strict";
// cf-auto.js 纯函数切片实测: base32/TOTP(RFC6238 官方向量)/页面分类/Token 抓取/灌入回退。
const assert = require("assert");
const path = require("path");
const CFAUTO = require(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"));

let pass = 0;
function t(name, fn) { return fn().then(() => { pass++; console.log("  ok -", name); }, e => { console.error("  FAIL -", name, "\n   ", e && e.message || e); process.exitCode = 1; }); }
function ts(name, fn) { return t(name, async () => fn()); }

(async () => {
  // ── base32 ──
  await ts("base32Decode 空白/填充/小写归一", () => {
    const a = CFAUTO.base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    // "12345678901234567890" (RFC6238 SHA1 seed) 的 base32
    assert.strictEqual(Buffer.from(a).toString(), "12345678901234567890");
    assert.deepStrictEqual(Array.from(CFAUTO.base32Decode("mzxw6===")), Array.from(Buffer.from("foo")));
  });

  // ── TOTP RFC6238 官方测试向量 (SHA1, 8 位, seed=12345678901234567890) ──
  const seed32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const vecs = [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]];
  for (const [sec, expect] of vecs) {
    await t("TOTP RFC6238 @" + sec + " => " + expect, async () => {
      const code = await CFAUTO.totp(seed32, sec * 1000, { digits: 8, step: 30 });
      assert.strictEqual(code, expect);
    });
  }
  await t("TOTP 默认 6 位", async () => {
    const c = await CFAUTO.totp(seed32, 59 * 1000);
    assert.strictEqual(c, "287082");  // 8 位向量取后 6 位
  });

  // ── classifyPage ──
  await ts("classify github 登录/2FA/oauth", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login", { ghLogin: true }), "gh_login");
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/sessions/two-factor/app", { gh2fa: true }), "gh_2fa");
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login/oauth/authorize", { ghOauth: true }), "gh_oauth");
  });
  await ts("classify cloudflare 建token/结果", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/profile/api-tokens", { cfContinue: true }), "cf_continue");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/profile/api-tokens", { cfCreate: true }), "cf_create");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/x", { cfTokenText: "a".repeat(40) }), "cf_token_result");
  });
  await ts("classify cloudflare 直登/2FA (GitHub 之外的另一路)", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login", { cfLogin: true }), "cf_login");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login", { cf2fa: true }), "cf_2fa");
    // 2FA 优先于登录 (登录表单可能已消失)
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login", { cfLogin: true, cf2fa: true }), "cf_2fa");
    // 建 Token 页阶段优先于登录态判定
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/profile/api-tokens", { cfCreate: true, cfLogin: true }), "cf_create");
    // GitHub 页即便有 email/password 也不误判为 cf_login
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login", { ghLogin: true, cfLogin: true }), "gh_login");
    // 人机验证仍优先于 CF 直登
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login", { cfLogin: true, captcha: true }), "captcha");
  });
  await ts("classify CF 已登录 dash → cf_authed (首选·内部接口建 Token)", () => {
    // 已登录 dash 且无登录/2FA/建token 表单 → 走内部接口
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/", {}), "cf_authed");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/profile/api-tokens", {}), "cf_authed");
    // 登录/2FA/建token 表单在场时不误判为 cf_authed
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login", { cfLogin: true }), "cf_login");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/x", { cf2fa: true }), "cf_2fa");
    // 非 dash 的 cloudflare.com 页不触发 cf_authed
    assert.strictEqual(CFAUTO.classifyPage("https://www.cloudflare.com/", {}), "unknown");
    // 登录/注册路由即便表单未渲染 (facts 空·SPA 加载中) 也绝不误判为 cf_authed —— 否则表单出现前
    //   抢先建 Token 命中未登录态 403 提前终结登录流 (真机实测·登录页约需 ~10s 才渲染出账密框)。
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login", {}), "unknown");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/sign-in", {}), "unknown");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/login?foo=1", {}), "unknown");
  });

  // ── pickGroups / buildTokenPayload (内部接口建 Token 请求体·纯函数) ──
  const PG = [
    { id: "gW", name: "Workers Scripts Write" },
    { id: "gA", name: "Account Settings Read" },
    { id: "gU", name: "User Details Read" },
    { id: "gM", name: "Memberships Read" },
    { id: "gX", name: "Unrelated Group" }
  ];
  await ts("pickGroups 按名精确挑出并去 name 只留 id", () => {
    assert.deepStrictEqual(CFAUTO.pickGroups(PG, ["Workers Scripts Write", "Account Settings Read"]), [{ id: "gW" }, { id: "gA" }]);
    assert.deepStrictEqual(CFAUTO.pickGroups(PG, ["Nope"]), []);
    assert.deepStrictEqual(CFAUTO.pickGroups(null, ["x"]), []);
  });
  await ts("buildTokenPayload 生成账号+用户两条 policy·作用域正确", () => {
    const p = CFAUTO.buildTokenPayload({ name: "t1", accountId: "ACC", userId: "USR", groups: PG });
    assert.strictEqual(p.name, "t1");
    assert.strictEqual(p.policies.length, 2);
    const acc = p.policies[0], usr = p.policies[1];
    assert.strictEqual(acc.effect, "allow");
    assert.deepStrictEqual(acc.resources, { "com.cloudflare.api.account.ACC": "*" });
    assert.deepStrictEqual(acc.permission_groups, [{ id: "gW" }, { id: "gA" }]);
    assert.deepStrictEqual(usr.resources, { "com.cloudflare.api.user.USR": "*" });
    assert.deepStrictEqual(usr.permission_groups, [{ id: "gU" }, { id: "gM" }]);
  });
  await ts("buildTokenPayload 权限组缺失/缺 id 时不产出空作用域 policy", () => {
    const p = CFAUTO.buildTokenPayload({ name: "t2", accountId: "ACC", userId: "USR", groups: [] });
    assert.strictEqual(p.policies.length, 0);
    const p2 = CFAUTO.buildTokenPayload({ groups: PG });   // 无 accountId/userId
    assert.strictEqual(p2.policies.length, 0);
    assert.ok(/^dao-relay /.test(p2.name));   // 默认名
  });
  // 任意用户健壮性: CF 不同账号/语言环境回传的组名大小写/首尾空白可能不同 → 语义名一致即命中
  await ts("pickGroups 大小写/空白不敏感回退命中 (任意用户可复现)", () => {
    const PG2 = [{ id: "gW", name: " workers scripts WRITE " }, { id: "gA", name: "Account Settings Read" }];
    assert.deepStrictEqual(CFAUTO.pickGroups(PG2, ["Workers Scripts Write", "Account Settings Read"]), [{ id: "gW" }, { id: "gA" }]);
  });
  await ts("missingGroups 找出缺失的必需组名 (缺权即明确诊断·非静默铸欠权 Token)", () => {
    assert.deepStrictEqual(CFAUTO.missingGroups(PG, CFAUTO.ACCT_GROUPS), []);              // 全在
    const partial = [{ id: "gW", name: "Workers Scripts Write" }];
    assert.deepStrictEqual(CFAUTO.missingGroups(partial, CFAUTO.ACCT_GROUPS), ["Account Settings Read"]);
    assert.deepStrictEqual(CFAUTO.missingGroups([], CFAUTO.ACCT_GROUPS), CFAUTO.ACCT_GROUPS.slice());
    assert.deepStrictEqual(CFAUTO.missingGroups(null, ["x"]), ["x"]);
  });

  await ts("classify 人机验证/硬件密钥优先停手", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login", { ghLogin: true, captcha: true }), "captcha");
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/x", { webauthn: true }), "webauthn");
    assert.strictEqual(CFAUTO.classifyPage("https://example.com", {}), "unknown");
  });

  // ── loginMode: 两种模式完全分离·二选一 ──
  await ts("loginMode 二选一: CF 直登 / GitHub 登 CF / 手动", () => {
    assert.strictEqual(CFAUTO.loginMode({ cf: { user: "a@b.c", pass: "x" } }), "cloudflare");
    assert.strictEqual(CFAUTO.loginMode({ gh: { user: "u", pass: "x", otp: "K" } }), "github");
    assert.strictEqual(CFAUTO.loginMode({ gh: { otp: "K" } }), "github");        // 仅种子也算 github
    assert.strictEqual(CFAUTO.loginMode({ cf: { otp: "K" } }), "cloudflare");
    assert.strictEqual(CFAUTO.loginMode({}), "manual");
    assert.strictEqual(CFAUTO.loginMode(null), "manual");
    assert.strictEqual(CFAUTO.loginMode({ gh: {}, cf: {} }), "manual");          // 空对象不算填
    assert.strictEqual(CFAUTO.loginMode({ gh: { user: "u" }, cf: { user: "a" } }), "github"); // 都填以 GitHub 优先
  });

  // ── scrapeToken ──
  await ts("scrapeToken 独占值/句中/排除URL", () => {
    const tk = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    assert.strictEqual(CFAUTO.scrapeToken([tk]), tk);
    assert.strictEqual(CFAUTO.scrapeToken(["your token: " + tk + " keep it safe"]), tk);
    assert.strictEqual(CFAUTO.scrapeToken(["https://x/" + tk]), null);   // URL 噪声排除
    assert.strictEqual(CFAUTO.scrapeToken(["nothing here"]), null);
  });

  // ── feedToken 回退到下一个 base ──
  await t("feedToken 首 base 失败自动回退且带鉴权头", async () => {
    const seen = [];
    const xhr = (opt) => { seen.push(opt); return Promise.resolve({ status: seen.length === 1 ? 502 : 200, responseText: "{\"started\":true}" }); };
    const r = await CFAUTO.feedToken(["http://127.0.0.1:9/", "https://t.example/"], "sess-1", "relaytok", "TOK", xhr);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1].url, "https://t.example/relay/sess-1");
    assert.strictEqual(seen[0].headers.Authorization, "Bearer relaytok");
    assert.ok(JSON.parse(seen[0].data).body.token === "TOK" && JSON.parse(seen[0].data).path === "/api/cf-provision");
  });
  await t("feedToken 全失败抛错", async () => {
    const xhr = () => Promise.resolve({ status: 500 });
    let threw = false;
    try { await CFAUTO.feedToken(["http://a/"], "s", "t", "K", xhr); } catch (e) { threw = true; }
    assert.strictEqual(threw, true);
  });

  // ── X-Cross-Site-Security 源码护栏 (真机同源 fetch 实测 2026-07: 带该头的 POST /api/v4/user/tokens
  //    被 403, 不带则 200 建成; GET 两态皆 200。故同源默认不带, 仅首次 403 翻转该头重试一次·两态皆通) ──
  await ts("cf-auto.js cfMintToken: 同源默认不带 X-Cross-Site-Security·403 时翻转重试", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"), "utf-8");
    assert.ok(src.includes("X-Cross-Site-Security"), "cf-auto.js 缺少 X-Cross-Site-Security 头 (403 回退分支)");
    assert.ok(/xssToggled/.test(src) && /r\.status === 403/.test(src), "cf-auto.js 缺少 403 翻转 X-Cross-Site-Security 的回退重试");
    assert.ok(!/Accept: "application\/json", "X-Cross-Site-Security": "dash"/.test(src), "cf-auto.js 不应把 X-Cross-Site-Security 硬写进默认头 (同源 POST 会被 403)");
  });
  await ts("RelayService.java cfMintJs: 同源默认不带 X-Cross-Site-Security·403 时翻转重试", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/java/ai/devin/rtflow/RelayService.java"), "utf-8");
    assert.ok(src.includes("X-Cross-Site-Security") && src.includes("dash"), "RelayService.java cfMintJs 缺少 X-Cross-Site-Security 回退头");
    assert.ok(/r\.status===403&&!xss/.test(src), "RelayService.java cfMintJs 缺少 403 翻转 X-Cross-Site-Security 的回退重试");
  });

  // ── 自包含·离屏「代登录→建 Token」源码护栏 (本源: 用户只提供账号·零可见页·零点击) ──
  await ts("cf-auto.js 支持 deliver 模式 (离屏回灌 __CFM) + 尊重 accountId 隔离", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"), "utf-8");
    assert.ok(/CFG\.deliver/.test(src), "cf-auto.js 缺少 deliver 模式分支");
    assert.ok(src.includes("__CFM") && src.includes("cf_challenge"), "cf-auto.js deliver 模式缺少 __CFM 回灌 / cf_challenge 挑战信号");
    assert.ok(src.includes("CFG.accountId") && /account_not_found|multi_account/.test(src), "cfMintToken 未按 accountId 精确隔离 (防多账号串号)");
  });
  await ts("RelayService.java cfStartWebAuto 离屏代登录 (注入 cf-auto.js·deliver·loadUrl /login)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/java/ai/devin/rtflow/RelayService.java"), "utf-8");
    assert.ok(src.includes("cfStartWebAuto") && src.includes("cfWebAuto"), "RelayService.java 缺少 cfStartWebAuto/cfWebAuto");
    assert.ok(src.includes("engine/cf-auto.js") && src.includes("deliver:true"), "cfStartWebAuto 未注入 cf-auto.js / 未开 deliver 模式");
    assert.ok(src.includes("dash.cloudflare.com/login"), "cfStartWebAuto 未从登录页起步 (自包含代登录)");
  });
  await ts("RelayService.java 凭证代登录前清 CF/GitHub 会话 (多号隔离·钉本次账号·不复用他号登录态)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/java/ai/devin/rtflow/RelayService.java"), "utf-8");
    assert.ok(src.includes("cfClearAuthCookies"), "RelayService.java 缺少 cfClearAuthCookies (多号隔离清会话)");
    assert.ok(src.includes('cfClearAuthCookies(cm, cfg.contains("\\"gh\\""))'), "cfStartWebAuto 未在代登录前清会话 (含 GitHub SSO 时并清 GitHub)");
    assert.ok(src.includes("expires=Thu, 01 Jan 1970") && src.includes("dash.cloudflare.com"), "cfClearAuthCookies 未按域写过期覆盖 CF 会话 cookie");
    assert.ok(/includeGithub[\s\S]{0,120}github\.com/.test(src), "cfClearAuthCookies 未在 GitHub SSO 时并清 github.com 会话");
  });
  await ts("relay-app.js /api/cf-autoprovision 支持账密 web-auto (用户只提供账号)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/relay-app.js"), "utf-8");
    assert.ok(src.includes("cfWebAuto") && src.includes("web-auto"), "relay-app.js 缺少 cfWebAuto / web-auto 模式");
    assert.ok(/opts\.cf\s*&&\s*opts\.cf\.user/.test(src), "autoProvisionRun 未按账密分流到离屏 web-auto");
  });
  await ts("tunnel.html 池行 login 建 Worker 走后端离屏 (无 openTab·无 cfAutoArm·零点击)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/tunnel.html"), "utf-8");
    const build = src.slice(src.indexOf("async function cfPoolBuild("), src.indexOf("async function cfPoolBuildAll("));
    assert.ok(build.includes("/api/cf-autoprovision"), "cfPoolBuild login 分支未改走 /api/cf-autoprovision");
    assert.ok(!build.includes("cfAutoArm") && !build.includes("_cfTokenDeepLink") && !build.includes("openTab"), "cfPoolBuild login 分支仍在开可见页/武装 (未做到零点击)");
  });
  await ts("cf-auto.js cfMintToken 403+HTML → cf_challenge (bot-management 拦截降级到 UI 流)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"), "utf-8");
    assert.ok(src.includes("text/html") && src.includes("cf_challenge"), "cfMintToken 缺少 403+HTML → cf_challenge 检测");
    assert.ok(src.includes("emsg === \"cf_challenge\"") || src.includes('emsg === "cf_challenge"'), "cf_authed 分支缺少 cf_challenge 降级到 UI 建 Token 流");
    assert.ok(src.includes("dash.cloudflare.com/profile/api-tokens"), "cf_challenge 降级未导航到 api-tokens 页");
  });
  await ts("tunnel.html Token 统管 (列出/撤销) UI 与 API 路由", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/tunnel.html"), "utf-8");
    assert.ok(src.includes("cfListTokens") && src.includes("cfRevokeTokenPrompt"), "tunnel.html 缺少 Token 列出/撤销函数");
    assert.ok(src.includes("/api/cf-list-tokens") && src.includes("/api/cf-revoke-token"), "tunnel.html 缺少 Token 统管 API 调用");
  });
  await ts("relay-app.js Token/Worker 统管路由 (list/revoke/delete)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/relay-app.js"), "utf-8");
    assert.ok(src.includes("/api/cf-list-tokens") && src.includes("/api/cf-revoke-token") && src.includes("/api/cf-delete-worker"), "relay-app.js 缺少 Token/Worker 统管路由");
  });
  // ── Turnstile 离屏突破 (道法自然·用户只输账密·零人机验证参与) ──
  await ts("cf-auto.js visibilityState 覆写 (Turnstile 离屏自动过·突破 hidden 不启动)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"), "utf-8");
    assert.ok(/defineProperty\(document,\s*'visibilityState'/.test(src), "缺少 visibilityState 覆写 → Turnstile 离屏不启动");
    assert.ok(/defineProperty\(document,\s*'hidden'/.test(src), "缺少 document.hidden 覆写");
    assert.ok(src.includes("visibilitychange"), "覆写后未派发 visibilitychange 事件");
  });
  await ts("cf-auto.js typeReal 经 execCommand 原生管线输入 (React/CF 反自动化突破)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"), "utf-8");
    assert.ok(src.includes("var typeReal"), "缺少 typeReal 函数");
    assert.ok(src.includes("execCommand('insertText'"), "typeReal 未用 execCommand('insertText') 原生编辑管线");
    // CF 登录/GitHub 登录/2FA 均须改用 typeReal (不再用会被 CF React 忽略的 setVal)
    const loginSlice = src.slice(src.indexOf('cat === "cf_login"'), src.indexOf('cat === "cf_2fa"'));
    assert.ok(loginSlice.includes("typeReal(cem") && loginSlice.includes("typeReal(cpw"), "CF 登录未改用 typeReal");
    assert.ok(/typeReal\(q\("#login_field"\)/.test(src), "GitHub 登录未改用 typeReal");
  });
  await ts("cf-auto.js Turnstile 不当硬 captcha·等按钮 enable 再提交 (非阻断式验证)", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"), "utf-8");
    // captcha 仅 hCaptcha/reCAPTCHA·排除 Turnstile(challenges.cloudflare.com)
    assert.ok(src.includes("hasTurnstile") && src.includes("challenges.cloudflare.com"), "captcha 检测未区分出 Turnstile");
    assert.ok(src.includes("hasHardCaptcha"), "captcha 检测未单列 hCaptcha/reCAPTCHA 硬阻断");
    // 提交前检查按钮是否 enable (Turnstile 完成前恒 disabled·此时应等而非误报失败)
    assert.ok(/!csb\.disabled/.test(src), "CF 登录提交未检查按钮 disabled 态 (未等 Turnstile 完成)");
  });

  console.log("\ncf-auto.test.js: " + pass + " assertions passed");
})();
