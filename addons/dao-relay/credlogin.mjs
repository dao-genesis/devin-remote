// credlogin.mjs — 顶层持久通道 · 纯凭证「零点击」全自动打通(道法自然·无为而无不为·承担一切负担)
//
// 用户只在内网穿透板块填 Cloudflare 账号密码(+可选 TOTP), 后端全链路自动打通**永不漂**的
// 持久化 Worker 通道, 全程无需用户任何点击。手机端(rt-flow-app cf-auto.js)与电脑端**同一套逻辑**。
//
// 道·主路径(与手机端一致·零 UI 零抓取): 登录一次(含其 Turnstile 人机验证·用户本来手动也要
//   过的同一道关)进入 dash.cloudflare.com 会话态后, **经 dashboard 前端调的同一批同源内部接口**
//   (`GET /api/v4/user` `GET /api/v4/accounts` `GET /api/v4/user/tokens/permission_groups`
//    → `POST /api/v4/user/tokens`)**纯 HTTP 直建 API Token**(同源带 cookie·零点击·零抓取),
//   随后复用 provision.mjs 的 wrangler 部署打通持久通道。这才是「前端能做→后端也能做」的正解,
//   摒弃了「点授权按钮 / 抓结果页文本」这类脆弱的浏览器 UI 自动化。
//
// 反者道之动·守柔回退: 内部接口不可用(CF 改版/权限组缺失)→ 退回 OAuth PKCE 一键授权链接
//   (oauth.loginProvision); 无头/被 Turnstile 挡住登录 → 返回 { fallback:true, url } 让上层退回
//   一键授权链接。绝不空手而归、绝不静默绕过任何安全控制(CAPTCHA/WebAuthn 命中即交回用户)。
//
// 纯逻辑(TOTP/页面判定/权限组挑选/建 Token 请求体)导出供单测; 副作用(起浏览器/驱动/部署)
//   在 credLoginProvision()。
// CLI: node credlogin.mjs <email> <password> [totpSecret] [--cdp=ws://…]
"use strict";
import { createHmac } from "node:crypto";
import { generatePkce, randomState, buildAuthUrl, waitForCallback, exchangeCode, tokenState } from "./oauth.mjs";
import { provision } from "./provision.mjs";

// ── 纯逻辑: TOTP(RFC6238·HMAC-SHA1·30s·6 位) ────────────────────────────────────────
// CF 两步验证的验证器种子即 Base32; 与手机验证器同源, 后端本地算码免用户读手机。
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(s) {
  const clean = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, { at = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  if (!key.length) throw new Error("无效的 TOTP 种子(Base32)");
  let counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const hmac = createHmac("sha1", key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

// 授权页判定: URL 落在 /oauth2/auth 且含 client 描述即认为是授权同意页(非登录页)。
export function isAuthorizePage(url) {
  try { const u = new URL(url); return /dash\.cloudflare\.com$/.test(u.hostname) && /\/oauth2\/auth/.test(u.pathname); }
  catch { return false; }
}
// 登录页判定: /login 或含 email 输入。
export function isLoginPage(url) {
  try { const u = new URL(url); return /dash\.cloudflare\.com$/.test(u.hostname) && /\/login|\/sign-?in/.test(u.pathname); }
  catch { return false; }
}
// 已登录 dashboard 判定: host=dash.cloudflare.com 且不在登录/OAuth 授权路径 → 可走内部接口建 Token。
export function isAuthedDash(url) {
  try { const u = new URL(url); return /dash\.cloudflare\.com$/.test(u.hostname) && !/\/login|\/sign-?in|\/oauth2\/auth/.test(u.pathname); }
  catch { return false; }
}

// ── 纯逻辑: 从 CF 内部接口的权限组全集里按名挑出所需组(与手机端 cf-auto.js 同源·可测) ──
export function pickGroups(all, names) {
  all = Array.isArray(all) ? all : [];
  return (names || []).map((n) => {
    for (const g of all) { if (g && g.name === n) return { id: g.id }; }
    return null;
  }).filter(Boolean);
}

// ── 纯逻辑: 按 scope 归类权限组(账号级 / 用户级 / zone 级) ──
//   CF /user/tokens/permission_groups 每组带 scopes(如 ["com.cloudflare.api.account"]);
//   缺 scopes 时按名兜底归类(仅用于测试/老形态), 默认落账号级。
export function partitionGroupsByScope(groups) {
  const account = [], user = [], zone = [];
  for (const g of (groups || [])) {
    if (!g || !g.id) continue;
    const scopes = Array.isArray(g.scopes) ? g.scopes : [];
    const s = scopes[0] || "";
    let bucket;
    if (s === "com.cloudflare.api.user") bucket = user;
    else if (s === "com.cloudflare.api.account.zone") bucket = zone;
    else if (s === "com.cloudflare.api.account") bucket = account;
    else {
      // 无 scopes: 按名兜底(用户级/zone 级关键词, 其余归账号级)。
      const n = String(g.name || "");
      if (/^(User|Memberships|API Tokens)\b/.test(n)) bucket = user;
      else if (/^(Zone|DNS|SSL|Firewall|Page Rules|Cache|Load Balanc|Logs|Analytics)\b/.test(n)) bucket = zone;
      else bucket = account;
    }
    bucket.push({ id: g.id });
  }
  return { account, user, zone };
}

// ── 纯逻辑: 构造 POST /api/v4/user/tokens 的请求体(与手机端 cf-auto.js 同源·可测) ──
//   本源(用户「Token 权限全部拉满」): 默认把该账号可授予的**全部**权限组按 scope 一次拉满 ——
//   账号级(含 Workers 脚本读写 / 账号设置读写)、用户级(含 API Tokens 读写→令牌可自管理)、zone 级
//   (含 Zone 读 / DNS·供绑自定义域)。这样常驻 token 既能部署 Worker, 又能自列/自撤 Token、列/删 Worker,
//   并承接后续一切需求。缺 accountId/userId 或对应组为空时不产该策略。
//   min:true 时回退最小权限集(仅供 CF 拒绝全量策略时的兜底)。
export function buildTokenPayload(o) {
  o = o || {};
  const policies = [];
  if (o.min) {
    const acctG = pickGroups(o.groups, ["Workers Scripts Write", "Account Settings Read"]);
    const userG = pickGroups(o.groups, ["User Details Read", "Memberships Read"]);
    if (acctG.length && o.accountId) { const ar = {}; ar["com.cloudflare.api.account." + o.accountId] = "*"; policies.push({ effect: "allow", resources: ar, permission_groups: acctG }); }
    if (userG.length && o.userId) { const ur = {}; ur["com.cloudflare.api.user." + o.userId] = "*"; policies.push({ effect: "allow", resources: ur, permission_groups: userG }); }
    return { name: o.name || ("dao-relay " + Date.now()), policies };
  }
  const part = partitionGroupsByScope(o.groups);
  if (part.account.length && o.accountId) { const ar = {}; ar["com.cloudflare.api.account." + o.accountId] = "*"; policies.push({ effect: "allow", resources: ar, permission_groups: part.account }); }
  if (part.user.length && o.userId) { const ur = {}; ur["com.cloudflare.api.user." + o.userId] = "*"; policies.push({ effect: "allow", resources: ur, permission_groups: part.user }); }
  if (part.zone.length && o.accountId) { const zr = {}; zr["com.cloudflare.api.account.zone.*"] = "*"; policies.push({ effect: "allow", resources: zr, permission_groups: part.zone }); }
  return { name: o.name || ("dao-relay " + Date.now()), policies };
}

// ── 浏览器驱动(副作用)──────────────────────────────────────────────────────────────
// 优先连已有 Chrome(CDP·更不易被风控·可复用常驻登录态); 无则 launch playwright chromium。
async function getBrowser({ cdpEndpoint, log }) {
  let pw;
  try { pw = (await import("playwright")).chromium; }
  catch { throw new Error("playwright 未安装(纯凭证自动化需要它·或改用一键授权链接回退)"); }
  if (cdpEndpoint) {
    log(`连接已有浏览器(CDP): ${cdpEndpoint}`);
    const b = await pw.connectOverCDP(cdpEndpoint);
    return { browser: b, connected: true };
  }
  log("启动内置 Chromium(无头)…");
  const b = await pw.launch({ headless: true, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
  return { browser: b, connected: false };
}

async function firstText(page, texts, timeout = 4000) {
  for (const t of texts) {
    const loc = page.getByRole("button", { name: t, exact: false });
    try { if (await loc.first().isVisible({ timeout: timeout / texts.length })) return loc.first(); } catch { /* 下一个候选 */ }
  }
  return null;
}

// 尽力填一个输入框(多选择器容错)。
async function fillFirst(page, selectors, value, log, label) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) { await el.fill(value); log(`已填${label}`); return true; }
    } catch { /* 下一个候选 */ }
  }
  return false;
}

// 检测硬边界(人机验证/硬件密钥): 命中即不可后端代过, 交回用户。
async function hitsHardWall(page) {
  try {
    return await page.evaluate(() => {
      const body = (document.body && document.body.innerText) || "";
      const captcha = !!(document.querySelector("iframe[src*='captcha'],iframe[src*='hcaptcha'],iframe[src*='turnstile'],iframe[title*='challenge']") || /verify you are human|请完成人机验证/i.test(body));
      const webauthn = /security key|passkey|硬件密钥|安全密钥/i.test(body) && !document.querySelector("input[name=totp],input[autocomplete=one-time-code]");
      return captcha || webauthn;
    });
  } catch { return false; }
}

// ── ★主路径: 会话态经内部接口纯 HTTP 直建 Token(同源带 cookie·零 UI·零抓取·与手机端一致)──
//   在已登录的 dash.cloudflare.com 页面上下文里执行, 与 dashboard 前端调的同一批 /api/v4 接口:
//   读用户/账号/权限组 → POST 建 Token → 取 value。失败(改版/权限组缺失/未登录)返回 null。
export async function cfMintTokenViaSession(page, { log = console.log, name } = {}) {
  const tokenName = name || ("dao-relay " + Date.now());
  try {
    const tk = await page.evaluate(async (nm) => {
      const api = async (path, init) => {
        init = init || {};
        const r = await fetch(path, {
          method: init.method || "GET",
          credentials: "include",
          headers: Object.assign({ Accept: "application/json" }, init.headers || {}),
          body: init.body,
        });
        let t = null; try { t = await r.json(); } catch (e) { t = {}; }
        if (!r.ok || t.success === false) throw new Error("cf " + path + " HTTP " + r.status);
        return t.result;
      };
      // 与手机端 buildTokenPayload 同构(浏览器上下文内无法引入 Node 模块, 就地内联同一逻辑)。
      const pick = (all, names) => (names || []).map((n) => {
        for (const g of (all || [])) { if (g && g.name === n) return { id: g.id }; }
        return null;
      }).filter(Boolean);
      const user = await api("/api/v4/user");
      const accts = await api("/api/v4/accounts?per_page=50");
      if (!accts || !accts.length) throw new Error("no_account");
      const groups = await api("/api/v4/user/tokens/permission_groups");
      // ★拉满: 按 scope 归类全部权限组, 账号级/用户级/zone 级各建一条 allow=* 策略。
      const buildFull = () => {
        const acct = [], usr = [], zone = [];
        for (const g of (groups || [])) {
          if (!g || !g.id) continue;
          const s = (Array.isArray(g.scopes) && g.scopes[0]) || "";
          if (s === "com.cloudflare.api.user") usr.push({ id: g.id });
          else if (s === "com.cloudflare.api.account.zone") zone.push({ id: g.id });
          else acct.push({ id: g.id }); // 账号级 + 无 scopes 兜底
        }
        const pol = [];
        if (acct.length && accts[0].id) { const ar = {}; ar["com.cloudflare.api.account." + accts[0].id] = "*"; pol.push({ effect: "allow", resources: ar, permission_groups: acct }); }
        if (usr.length && user.id) { const ur = {}; ur["com.cloudflare.api.user." + user.id] = "*"; pol.push({ effect: "allow", resources: ur, permission_groups: usr }); }
        if (zone.length && accts[0].id) { const zr = {}; zr["com.cloudflare.api.account.zone.*"] = "*"; pol.push({ effect: "allow", resources: zr, permission_groups: zone }); }
        return pol;
      };
      // 兜底最小集(CF 拒绝全量策略时): 仅够部署 + 基础读。
      const buildMin = () => {
        const acctG = pick(groups, ["Workers Scripts Write", "Account Settings Read"]);
        const userG = pick(groups, ["User Details Read", "Memberships Read"]);
        const pol = [];
        if (acctG.length && accts[0].id) { const ar = {}; ar["com.cloudflare.api.account." + accts[0].id] = "*"; pol.push({ effect: "allow", resources: ar, permission_groups: acctG }); }
        if (userG.length && user.id) { const ur = {}; ur["com.cloudflare.api.user." + user.id] = "*"; pol.push({ effect: "allow", resources: ur, permission_groups: userG }); }
        return pol;
      };
      const post = async (policies) => {
        if (!policies.length) throw new Error("no_permission_groups_matched");
        const res = await api("/api/v4/user/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nm, policies }) });
        return res && res.value;
      };
      try { return await post(buildFull()); }
      catch (e) { return await post(buildMin()); } // 全量被拒 → 最小集兜底(至少能部署)
    }, tokenName);
    return tk || null;
  } catch (e) {
    log("内部接口建 Token 未成: " + (e && e.message || e));
    return null;
  }
}

// 主流程: 凭证 → 驱动登录(填账密/2FA) → 进 dash 会话态 → **内部接口直建 Token** → 部署。
//   内部接口不可用时回退 OAuth 授权码流(同一浏览器点一次授权)。返回 provision 结果。
export async function credLoginProvision({ email, password, totpSecret, cdpEndpoint, log = console.log, timeoutMs = 300000 } = {}) {
  if (!email || !password) throw new Error("需要 Cloudflare 账号与密码");

  let browser, connected, page;
  try {
    ({ browser, connected } = await getBrowser({ cdpEndpoint, log }));
    const ctx = connected ? (browser.contexts()[0] || await browser.newContext()) : await browser.newContext();
    page = await ctx.newPage();

    // ① 直奔 dashboard: 已有常驻登录态(CDP)则直接进会话态; 否则会被重定向到登录页。
    log("① 打开 Cloudflare dashboard…");
    await page.goto("https://dash.cloudflare.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);

    // ② 登录页: 自动填账号密码 + (可选)两步验证。
    const needLogin = isLoginPage(page.url()) || await page.locator('input[type="email"],input[name="email"],input[autocomplete="username"]').first().isVisible({ timeout: 3000 }).catch(() => false);
    if (needLogin) {
      if (await hitsHardWall(page)) throw new Error("登录页命中人机验证/硬件密钥, 后端不代过 —— 请改用一键授权, 或先在插件浏览器手动登录一次");
      log("② 登录页: 自动填账号密码…");
      await fillFirst(page, ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]', 'input#email'], email, log, "账号");
      await fillFirst(page, ['input[name="password"]', 'input[type="password"]', 'input#password'], password, log, "密码");
      const loginBtn = await firstText(page, ["Sign in", "Log in", "登录", "Login"]) || page.locator('button[type="submit"]').first();
      await loginBtn.click().catch(() => {});
      await page.waitForTimeout(4000);

      const otpVisible = await page.locator('input[name="otp"],input[autocomplete="one-time-code"],input[name="totp"]').first().isVisible({ timeout: 3000 }).catch(() => false);
      if (otpVisible) {
        if (!totpSecret) throw new Error("账号开了两步验证, 但未提供 TOTP 种子 —— 请在板块填入验证器种子, 或改用一键授权");
        log("③ 两步验证: 本地算码自动填…");
        const code6 = totp(totpSecret);
        await fillFirst(page, ['input[name="otp"]', 'input[autocomplete="one-time-code"]', 'input[name="totp"]'], code6, log, "动态码");
        const verifyBtn = await firstText(page, ["Verify", "Continue", "验证", "继续"]) || page.locator('button[type="submit"]').first();
        await verifyBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
      if (await hitsHardWall(page)) throw new Error("登录后命中人机验证/硬件密钥, 后端不代过 —— 请改用一键授权");
    }

    // ③ 等进入已登录 dashboard 会话态(直连或登录后)。现代 CF 统一登录重定向可能耗时十余秒, 给足 ~45s。
    for (let i = 0; i < 45 && !isAuthedDash(page.url()); i++) { await page.waitForTimeout(1000); }
    if (isAuthedDash(page.url())) {
      // ④ ★内部接口纯 HTTP 直建 Token(主路径·零点击零抓取)。
      log("④ 已进 dashboard 会话态, 经内部接口直建 API Token…");
      const minted = await cfMintTokenViaSession(page, { log, name: "dao-relay " + Date.now() });
      if (minted) {
        log("⑤ 内部接口已建 Token, 后端全自动部署持久通道…");
        const result = await provision(minted, { log, extraState: { auth: "credlogin-mint" } });
        return { ok: true, via: "session-mint", ...result };
      }
      log("   内部接口未取到 Token, 回退 OAuth 一键授权码流…");
    } else {
      log("   未能进入 dashboard 会话态, 回退 OAuth 一键授权码流…");
    }

    // ⑥ 守柔回退: OAuth PKCE 授权码流(同一浏览器点一次授权)→ 换令牌 → 部署。
    const { codeVerifier, codeChallenge } = await generatePkce();
    const state = randomState();
    const authUrl = buildAuthUrl({ state, codeChallenge });
    const codeP = waitForCallback(state, { timeoutMs, onReady: () => log("⑥ 回调服务就绪, 走 OAuth 授权…") });
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    log("⑦ 授权页: 自动点授权…");
    const authorizeBtn = await firstText(page, ["Authorize", "Allow", "Approve", "授权", "允许", "同意"], 8000);
    if (authorizeBtn) { await authorizeBtn.click().catch(() => {}); }
    else log("   未见授权按钮(可能已自动授权或页面结构变化), 等回调…");
    const code = await codeP;
    log("⑧ 已拿到授权码, 交换令牌并部署持久通道…");
    const tok = await exchangeCode(code, codeVerifier);
    const oauth = tokenState(tok);
    const result = await provision(tok.access_token, { log, skipVerify: true, extraState: { auth: "credlogin", oauth } });
    return { ok: true, via: "oauth", ...result };
  } finally {
    try { if (page) await page.close(); } catch { /* 守柔 */ }
    try { if (browser) { connected ? await browser.close() : await browser.close(); } } catch { /* 守柔 */ }
  }
}

// CLI ------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [email, password, totpSecret] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cdpArg = process.argv.find((a) => a.startsWith("--cdp="));
  const cdpEndpoint = cdpArg ? cdpArg.slice(6) : undefined;
  if (!email || !password) { console.error("用法: node credlogin.mjs <email> <password> [totpSecret] [--cdp=ws://…]"); process.exit(2); }
  credLoginProvision({ email, password, totpSecret, cdpEndpoint })
    .then((r) => { console.log("DONE " + JSON.stringify(r || {})); process.exit(0); })
    .catch((e) => { console.error("ERR " + (e && e.message || e)); process.exit(1); });
}
