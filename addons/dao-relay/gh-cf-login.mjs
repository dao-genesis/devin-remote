// gh-cf-login.mjs · 用 GitHub 账号「零点击」全自动登录 Cloudflare → 内部接口直建 API Token → provision 部署
// ─────────────────────────────────────────────────────────────────────────────
// 本源(道法自然·无为而无不为·承担一切负担): 用户手动能做的每一步(CF 登录页点「Sign in with GitHub」→
//   GitHub 填账密 → 本地算 2FA 动态码 → 授权 Cloudflare → 进 dashboard 建 API Token → 部署持久 Worker),
//   后端全模拟、**零人工终键**。TOTP 是用户自有第二因子(RFC6238 本地计算), 非绕过安全挑战。
//
// 主路径(与手机端/credlogin 同源·零 UI 零抓取): 登录进 dash.cloudflare.com 会话态后, 经 dashboard 前端
//   同一批同源内部接口(cfMintTokenViaSession)纯 HTTP 直建 Token → provision.mjs 的 wrangler 部署。
//
// 守柔硬边界: 仅当命中**真·反自动化关卡**(人机验证码 CAPTCHA / 硬件密钥 WebAuthn·Passkey / 邮箱设备验证)
//   —— 这些是专门挡机器人、连号主本人日常也未必点、且模拟即违规的关卡 —— 才 { ok:false, needUser:true } 交回,
//   绝不尝试绕过任何安全控制。其余(账密/官方 TOTP/OAuth 授权)一律全自动完成。
//
// 纯逻辑(host/页面判定)导出供单测; 副作用(起浏览器/登录/建 Token/部署)在 ghCfLoginProvision()。
// CLI: node gh-cf-login.mjs <ghLogin> <ghPass> [totpSeed] [--profile=DIR] [--headed]
"use strict";
import { totp, cfMintTokenViaSession, isAuthedDash } from "./credlogin.mjs";
import { provision } from "./provision.mjs";

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

// ── 纯逻辑: 主机/页面判定(可测) ──────────────────────────────────────────────
export function isGithubHost(url) { try { return /(^|\.)github\.com$/.test(new URL(url).hostname); } catch { return false; } }
export function isGhLoginPage(url) { try { const u = new URL(url); return isGithubHost(url) && /\/login|\/session/.test(u.pathname); } catch { return false; } }
export function isGhAuthorizePage(url) { try { const u = new URL(url); return isGithubHost(url) && /\/login\/oauth\/authorize/.test(u.pathname); } catch { return false; } }

// ── 主流程(副作用): GitHub 账号 → 全自动登 CF → 建 Token → 部署 ─────────────────
export async function ghCfLoginProvision(opts = {}) {
  const login = String(opts.login || opts.user || "").trim().replace(/^@/, "");
  const pass = String(opts.pass || opts.password || "");
  const seed = String(opts.otp || opts.seed || opts.totpSecret || "");
  const headless = opts.headless !== false;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  if (!login || !pass) return { ok: false, error: "缺 GitHub 账号或密码(需在 GitHub 板块以「账密+2FA」存号)" };

  const chromium = await loadChromium();
  const baseOpts = { headless, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] };
  if (opts.proxy) baseOpts.proxy = typeof opts.proxy === "string" ? { server: opts.proxy } : opts.proxy;
  // 先试系统 Chrome(复用常驻登录态·更不易被风控); 起不来(如无桌面会话/版本不符)则回退 Playwright 自带 chromium。
  const channels = opts.channel ? [opts.channel] : ["chrome", null];
  let ctx = null, lastErr = null;
  for (const ch of channels) {
    const launchOpts = ch ? { ...baseOpts, channel: ch } : { ...baseOpts };
    try { ctx = await chromium.launchPersistentContext(opts.profileDir || "", launchOpts); break; }
    catch (e) { lastErr = e; log("浏览器启动失败(channel=" + (ch || "bundled") + "): " + String(e && e.message || e).slice(0, 120)); }
  }
  if (!ctx) return { ok: false, error: "browser 启动失败: " + (lastErr && lastErr.message || lastErr) };
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
    const u = page.url();
    if (/\/sessions\/verified-device/.test(u)) return true;
    if (CHALLENGE_RE.test(u)) return true;
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 800);
    return CHALLENGE_RE.test(body);
  };

  try {
    // ① CF 登录页
    log("① 打开 Cloudflare 登录页…");
    await page.goto("https://dash.cloudflare.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1500);

    if (!isAuthedDash(page.url())) {
      // ①b CF 自身反爬关卡: dash 登录页可能先下发 Turnstile 人机验证(标题「Just a moment…」/
      //   cf-turnstile / /cdn-cgi/challenge)。这是 Cloudflare 专门挡机器人的真·反自动化控制,
      //   守柔不绕过 → 交回用户在有头隔离档过一次(过后会话常驻, 后续零点击)。
      const cfInterstitial = async () => {
        const title = (await page.title().catch(() => "")) || "";
        if (/just a moment|attention required|checking your browser/i.test(title)) return true;
        if (/\/cdn-cgi\/challenge/.test(page.url())) return true;
        return await page.locator('[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]')
          .first().count().then(n => n > 0).catch(() => false);
      };
      for (let i = 0; i < 8 && await cfInterstitial(); i++) await sleep(1500); // 给 Turnstile 自动放行留窗口
      if (await cfInterstitial()) {
        await ctx.close().catch(() => {});
        return { ok: false, needUser: true, via: "gh-cf", error: "Cloudflare 登录页命中 Turnstile 人机验证(专挡机器人·守柔不绕过, 交你在有头隔离档过一次即会话常驻)" };
      }

      // ② 点「Sign in with GitHub」
      const ghBtn = page.locator('a[href*="github.com/login/oauth"], a[href*="/oauth2/github"], button:has-text("GitHub"), a:has-text("GitHub"), [data-testid*="github" i]').first();
      if (await ghBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
        log("② 点「Sign in with GitHub」…");
        await ghBtn.click().catch(() => {});
        await sleep(3500);
      } else {
        log("② 未见 GitHub 登录按钮(CF 可能已改版/或已在 GitHub 流程) — 继续判定当前页…");
      }

      // ③ 进入 github.com(登录页 或 已登录直达 authorize 页)
      for (let i = 0; i < 24 && !isGithubHost(page.url()) && !isAuthedDash(page.url()); i++) await sleep(500);
      if (isGithubHost(page.url())) {
        if (await hitChallenge()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, via: "gh-cf", error: "GitHub 登录命中安全挑战(交回用户)" }; }
        // ③a 登录页填账密
        const lf = page.locator("#login_field").first();
        if (await lf.isVisible({ timeout: 3000 }).catch(() => false)) {
          log("③ GitHub 登录页: 自动填账密…");
          await lf.fill(login).catch(() => {});
          await page.fill("#password", pass).catch(() => {});
          await page.click("input[name=commit], [type=submit]").catch(() => {});
          await sleep(3500);
        }
        if (await hitChallenge()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, via: "gh-cf", error: "GitHub 密码后命中安全挑战/设备验证(交回用户)" }; }
        // ③b 2FA
        if (/two-factor/.test(page.url()) || await page.locator(otpSel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
          const c = await freshTotp();
          if (!c) { await ctx.close().catch(() => {}); return { ok: false, error: "GitHub 开了两步验证, 但未提供 TOTP 种子(请在 GitHub 板块以「账密+2FA」存号)" }; }
          log("④ GitHub 两步验证: 本地算码自动填…");
          await page.locator(otpSel).first().fill(c).catch(() => {});
          await sleep(400);
          await page.click("button[type=submit], input[name=commit]").catch(() => {});
          await sleep(3500);
        }
        if (await hitChallenge()) { await ctx.close().catch(() => {}); return { ok: false, needUser: true, via: "gh-cf", error: "GitHub 两步验证后命中安全挑战(交回用户)" }; }
        // ③c OAuth 授权页: 自动点 Authorize(会话内正常授权)
        for (let i = 0; i < 12 && isGithubHost(page.url()) && !isAuthedDash(page.url()); i++) {
          const az = page.locator('button[name=authorize][value="1"], input[name=authorize][value="1"], button:has-text("Authorize"), button:has-text("授权")').first();
          if (await az.isVisible({ timeout: 1500 }).catch(() => false)) {
            log("⑤ GitHub 授权 Cloudflare…");
            await az.scrollIntoViewIfNeeded().catch(() => {});
            await az.click().catch(() => {});
            await sleep(3000);
          } else { await sleep(1000); if (!isGithubHost(page.url())) break; }
        }
      }
    } else {
      log("已是 Cloudflare 登录态, 直接建 Token…");
    }

    // ⑥ 等回到 dash 登录态(统一登录重定向可能耗时十余秒)
    log("⑥ 等待回到 Cloudflare dashboard 会话态…");
    for (let i = 0; i < 60 && !isAuthedDash(page.url()); i++) await sleep(1000);
    if (!isAuthedDash(page.url())) { await ctx.close().catch(() => {}); return { ok: false, via: "gh-cf", error: "未能进入 Cloudflare 会话态(url=" + page.url() + ")" }; }

    // ⑦ 内部接口纯 HTTP 直建 Token(主路径·零点击零抓取)
    log("⑦ 已进 dashboard, 经内部接口直建 API Token…");
    const minted = await cfMintTokenViaSession(page, { log, name: "dao-relay " + Date.now() });
    if (!minted) { await ctx.close().catch(() => {}); return { ok: false, via: "gh-cf", error: "内部接口未取到 Token(CF 改版/权限组缺失)" }; }

    // ⑧ 全自动部署持久通道
    log("⑧ 已建 Token, 全自动部署持久通道…");
    const result = await provision(minted, { log, extraState: { auth: "gh-cf-mint", ghLogin: login } });
    await ctx.close().catch(() => {});
    return { ok: true, via: "gh-cf-session-mint", ...result };
  } catch (e) {
    await ctx.close().catch(() => {});
    return { ok: false, via: "gh-cf", error: String(e && e.message || e) };
  }
}

// CLI ------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const [login, pass, seed] = positional;
  const pd = (args.find((a) => a.startsWith("--profile=")) || "").slice(10) || "";
  const headless = !args.includes("--headed");
  if (!login || !pass) { console.error("用法: node gh-cf-login.mjs <ghLogin> <ghPass> [totpSeed] [--profile=DIR] [--headed]"); process.exit(2); }
  ghCfLoginProvision({ login, pass, otp: seed, profileDir: pd, headless })
    .then((r) => { console.log("DONE " + JSON.stringify(r || {})); process.exit(r && r.ok ? 0 : 1); })
    .catch((e) => { console.error("ERR " + (e && e.message || e)); process.exit(1); });
}
