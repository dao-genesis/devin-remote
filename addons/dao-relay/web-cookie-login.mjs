// web-cookie-login.mjs · 账密(+TOTP)隔离档官方登录 → 回吐会话 Cookie(供站内反代罐 /__web 用)
// ─────────────────────────────────────────────────────────────────────────────
// 本源(道法自然·无为而无不为): 用户在 GitHub/Cloudflare 板块以「账密+2FA」存的号, 在【该号专属隔离
//   profile】里走**官方登录流程**(每号独立指纹/cookie·多号并行不串), 登入后把该站会话 Cookie 原样
//   回吐。上层(extension.ts)把它灌进站内反代 per-origin Cookie 罐 → /__web 反代的官网 iframe 即以
//   登录态运行, 与手机端/直登官网 1:1 同步。TOTP 是号主自有第二因子(RFC6238 本地计算), 非绕过安全挑战。
//
// 守柔硬边界: 命中真·反自动化关卡(人机验证码 CAPTCHA / 硬件密钥 WebAuthn·Passkey / 邮箱设备验证 /
//   Cloudflare Turnstile) —— 号主本人才能过、模拟即违规 —— 立即 { ok:false, needUser:true } 交回,
//   绝不尝试绕过任何安全控制。返回不含明文账密/2FA, 只回 Cookie 名值对(会话凭据·由上层落密罐)。
"use strict";
import { totp } from "./credlogin.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 真·反自动化关卡特征(号主本人才能过 → 守柔交回, 绝不模拟绕过)
const CHALLENGE_RE = /verify.*device|verification code was sent|check your email|passkey|security key|webauthn|are you a robot|captcha|unusual sign|suspicious|人机验证|请完成人机|安全密钥|硬件密钥/i;

async function loadChromium() {
  const mod = await import("playwright").catch(() => null);
  if (mod && mod.chromium) return mod.chromium;
  const cmod = await import("playwright-core").catch(() => null);
  if (cmod && cmod.chromium) return cmod.chromium;
  throw new Error("playwright 未安装(dao-relay/node_modules)");
}

// 起隔离持久档(每号独立指纹/cookie): 先试系统 Chrome(复用常驻态·更不易被风控), 失败回退自带 chromium。
async function launchCtx(chromium, { profileDir, proxy, headless, channel, log }) {
  const baseOpts = { headless: headless !== false, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] };
  if (proxy) baseOpts.proxy = typeof proxy === "string" ? { server: proxy } : proxy;
  const channels = channel ? [channel] : ["chrome", null];
  let lastErr = null;
  for (const ch of channels) {
    const opts = ch ? { ...baseOpts, channel: ch } : { ...baseOpts };
    try { return await chromium.launchPersistentContext(profileDir || "", opts); }
    catch (e) { lastErr = e; log("浏览器启动失败(channel=" + (ch || "bundled") + "): " + String(e && e.message || e).slice(0, 120)); }
  }
  throw new Error("browser 启动失败: " + (lastErr && lastErr.message || lastErr));
}

// Playwright cookie → 上层反代罐需要的最小形态(名/值/域/路径)。剔除空值(登出态)。
function pluckCookies(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && c.name && typeof c.value === "string" && c.value !== "")
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain || "", path: c.path || "/" }));
}

// ── GitHub: 账密+TOTP 官方登录 → 回吐 github.com 会话 Cookie ──────────────────────
export async function harvestGithub(opts = {}) {
  const login = String(opts.login || opts.user || "").trim().replace(/^@/, "");
  const pass = String(opts.pass || opts.password || "");
  const seed = String(opts.otp || opts.seed || opts.totpSecret || "");
  const log = typeof opts.log === "function" ? opts.log : () => {};
  if (!login || !pass) return { ok: false, error: "缺 GitHub 账号或密码" };

  const chromium = await loadChromium();
  let ctx;
  try { ctx = await launchCtx(chromium, { ...opts, log }); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  const page = ctx.pages()[0] || await ctx.newPage();

  let lastCode = "";
  const freshTotp = async () => {
    if (!seed) return "";
    let c = totp(seed);
    if (c === lastCode) { const w = (30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 1200; log("等待新 TOTP 窗口 " + Math.round(w / 1000) + "s"); await sleep(w); c = totp(seed); }
    lastCode = c; return c;
  };
  const otpSel = '#app_totp, #otp, input[name=otp], input[autocomplete=one-time-code], input[name="sudo[otp]"]';
  const hitChallenge = async () => {
    if (/\/sessions\/verified-device/.test(page.url()) || CHALLENGE_RE.test(page.url())) return true;
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 800);
    return CHALLENGE_RE.test(body);
  };

  try {
    await page.goto("https://github.com/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    // 已有常驻登录态(隔离档复用)→ 直接收 cookie。
    if (!/\/login/.test(page.url())) { log("已是登录态, 直接收 Cookie"); }
    else {
      if (await hitChallenge()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, error: "登录页命中安全挑战(交回用户)" }; }
      await page.fill("#login_field", login).catch(() => {});
      await page.fill("#password", pass).catch(() => {});
      await page.click("input[name=commit], [type=submit]").catch(() => {});
      await sleep(3500);
      if (await hitChallenge()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, error: "密码后命中安全挑战/设备验证(交回用户)" }; }
      if (/two-factor/.test(page.url()) || await page.locator(otpSel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
        const c = await freshTotp();
        if (!c) { await ctx.close().catch(() => {}); return { ok: false, error: "该号开了两步验证, 但未提供 TOTP 种子" }; }
        log("两步验证: 本地算码自动填…");
        await page.locator(otpSel).first().fill(c).catch(() => {});
        await sleep(400);
        await page.click("button[type=submit], input[name=commit]").catch(() => {});
        await sleep(3500);
      }
      if (await hitChallenge()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, error: "两步验证后命中安全挑战(交回用户)" }; }
    }
    // 落定登录态: 访问首页, 读 cookie。github 登录后置 logged_in=yes。
    await page.goto("https://github.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(1200);
    const cookies = await ctx.cookies().catch(() => []);
    const loggedIn = cookies.some((c) => c.name === "logged_in" && c.value === "yes") || cookies.some((c) => c.name === "user_session" && c.value);
    await ctx.close().catch(() => {});
    if (!loggedIn) return { ok: false, needUser: true, error: "未建立 GitHub 登录态(可能命中人机/设备验证)" };
    return { ok: true, site: "github", login, cookies: pluckCookies(cookies) };
  } catch (e) {
    await ctx.close().catch(() => {});
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ── Cloudflare: 邮箱+密码(+可选 TOTP)官方登录 → 回吐 cloudflare 会话 Cookie ─────────
export async function harvestCloudflare(opts = {}) {
  const email = String(opts.email || opts.user || opts.login || "").trim();
  const pass = String(opts.pass || opts.password || "");
  const seed = String(opts.otp || opts.seed || opts.totpSecret || "");
  const log = typeof opts.log === "function" ? opts.log : () => {};
  if (!email || !pass) return { ok: false, error: "缺 Cloudflare 账号或密码" };

  const chromium = await loadChromium();
  let ctx;
  try { ctx = await launchCtx(chromium, { ...opts, log }); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  const page = ctx.pages()[0] || await ctx.newPage();

  const isAuthed = () => { try { const u = new URL(page.url()); return /dash\.cloudflare\.com$/.test(u.hostname) && !/\/login|\/sign-?in|\/oauth2\/auth/.test(u.pathname); } catch { return false; } };
  const cfInterstitial = async () => {
    const title = (await page.title().catch(() => "")) || "";
    if (/just a moment|attention required|checking your browser/i.test(title)) return true;
    if (/\/cdn-cgi\/challenge/.test(page.url())) return true;
    return await page.locator('[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').first().count().then((n) => n > 0).catch(() => false);
  };
  const fillFirst = async (sels, val) => { for (const s of sels) { try { const el = page.locator(s).first(); if (await el.isVisible({ timeout: 2000 })) { await el.fill(val); return true; } } catch { /* next */ } } return false; };

  try {
    await page.goto("https://dash.cloudflare.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1500);
    if (!isAuthed()) {
      for (let i = 0; i < 8 && await cfInterstitial(); i++) await sleep(1500); // 给 Turnstile 自动放行留窗口
      if (await cfInterstitial()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, error: "Cloudflare 登录页命中 Turnstile 人机验证(专挡机器人·守柔不绕过, 交你在有头隔离档过一次即会话常驻)" }; }
      log("登录页: 自动填账号密码…");
      await fillFirst(['input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]', "input#email"], email);
      await fillFirst(['input[name="password"]', 'input[type="password"]', "input#password"], pass);
      const loginBtn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("登录")').first();
      await loginBtn.click().catch(() => {});
      await sleep(4000);
      const otpVisible = await page.locator('input[name="otp"],input[autocomplete="one-time-code"],input[name="totp"]').first().isVisible({ timeout: 3000 }).catch(() => false);
      if (otpVisible) {
        if (!seed) { await ctx.close().catch(() => {}); return { ok: false, error: "该号开了两步验证, 但未提供 TOTP 种子" }; }
        log("两步验证: 本地算码自动填…");
        await fillFirst(['input[name="otp"]', 'input[autocomplete="one-time-code"]', 'input[name="totp"]'], totp(seed));
        await page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Continue"), button:has-text("验证")').first().click().catch(() => {});
        await sleep(3500);
      }
      if (await cfInterstitial()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, error: "登录后命中 Turnstile/人机验证(守柔不绕过, 交你在有头隔离档过一次)" }; }
    } else { log("已是 Cloudflare 登录态, 直接收 Cookie"); }

    for (let i = 0; i < 45 && !isAuthed(); i++) await sleep(1000);
    if (!isAuthed()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, error: "未进入 Cloudflare 会话态(url=" + page.url() + ")" }; }
    const cookies = await ctx.cookies().catch(() => []);
    await ctx.close().catch(() => {});
    return { ok: true, site: "cloudflare", email, cookies: pluckCookies(cookies) };
  } catch (e) {
    await ctx.close().catch(() => {});
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 统一入口: site=github|cloudflare。
export async function harvest(opts = {}) {
  const site = String(opts.site || "").toLowerCase();
  if (site === "github" || site === "gh") return await harvestGithub(opts);
  if (site === "cloudflare" || site === "cf") return await harvestCloudflare(opts);
  return { ok: false, error: "未知 site(需 github|cloudflare)" };
}

// CLI: node web-cookie-login.mjs <github|cloudflare> <user/email> <pass> [totpSeed] [--profile=DIR] [--headed]
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith("--"));
  const [site, user, pass, seed] = pos;
  const pd = (args.find((a) => a.startsWith("--profile=")) || "").slice(10) || "";
  const headless = !args.includes("--headed");
  if (!site || !user || !pass) { console.error("用法: node web-cookie-login.mjs <github|cloudflare> <user/email> <pass> [totpSeed] [--profile=DIR] [--headed]"); process.exit(2); }
  harvest({ site, login: user, email: user, pass, otp: seed, profileDir: pd, headless, log: (m) => console.error("[web-cookie] " + m) })
    .then((r) => { console.log(JSON.stringify({ ok: r.ok, site: r.site, needUser: r.needUser, error: r.error, cookieCount: (r.cookies || []).length })); process.exit(r && r.ok ? 0 : 1); })
    .catch((e) => { console.error("ERR " + (e && e.message || e)); process.exit(1); });
}
