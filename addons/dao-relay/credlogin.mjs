// credlogin.mjs — 顶层持久通道 · 纯凭证「零点击」全自动打通(道法自然·无为而无不为·承担一切负担)
//
// 上一代(oauth.mjs)已把「造 Token」自动化, 但仍要用户**打开浏览器、登录 Cloudflare、点授权**。
// 本模块把最后这一步人工也承担掉: 用户只在内网穿透板块填 Cloudflare 账号密码(+可选 TOTP),
// 后端用 CDP 浏览器自动化驱动 CF 登录页与 OAuth 授权页 —— 自动填账号密码、过两步验证、点授权,
// 回调端口(localhost:8976)收到授权码后复用 oauth.mjs 的换令牌 + provision.mjs 的 wrangler 部署,
// 打通**永不漂**的持久化 Worker 通道。全程无需用户任何点击。
//
// 反者道之动: 无头/被 Turnstile 挡住时**优雅回退** —— 返回 { fallback:true, url } 让上层退回
// 一键授权链接(oauth.loginProvision), 绝不空手而归。
//
// 纯逻辑(TOTP/选择器判定)导出供单测; 副作用(起浏览器/驱动/部署)在 credLoginProvision()。
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

// ── 浏览器驱动(副作用)──────────────────────────────────────────────────────────────
// 优先连已有 Chrome(CDP·更不易被风控); 无则 launch playwright chromium。
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

// 主流程: 凭证 → 驱动登录+授权 → 回调码 → 换令牌 → 部署。
// 返回 provision 结果; 无头被挡时抛错(上层据此回退一键授权)。
export async function credLoginProvision({ email, password, totpSecret, cdpEndpoint, log = console.log, timeoutMs = 300000 } = {}) {
  if (!email || !password) throw new Error("需要 Cloudflare 账号与密码");
  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = randomState();
  const authUrl = buildAuthUrl({ state, codeChallenge });

  let browser, connected, page;
  const codeP = waitForCallback(state, { timeoutMs, onReady: () => log("① 回调服务就绪, 驱动浏览器登录+授权…") });
  // 回调 promise 已挂起; 现在开浏览器走登录授权, 授权成功 → 回调 resolve(code)。
  try {
    ({ browser, connected } = await getBrowser({ cdpEndpoint, log }));
    const ctx = connected ? (browser.contexts()[0] || await browser.newContext()) : await browser.newContext();
    page = await ctx.newPage();
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);

    // 若被重定向到登录页 → 填账号密码。
    if (isLoginPage(page.url()) || await page.locator('input[type="email"],input[name="email"]').first().isVisible({ timeout: 3000 }).catch(() => false)) {
      log("② 登录页: 自动填账号密码…");
      await fillFirst(page, ['input[name="email"]', 'input[type="email"]', 'input#email'], email, log, "账号");
      await fillFirst(page, ['input[name="password"]', 'input[type="password"]', 'input#password'], password, log, "密码");
      const loginBtn = await firstText(page, ["Log in", "Sign in", "登录", "Login"]) || page.locator('button[type="submit"]').first();
      await loginBtn.click().catch(() => {});
      await page.waitForTimeout(3000);

      // 两步验证页?
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
    }

    // 授权同意页: 点 Authorize/Allow。
    log("④ 授权页: 自动点授权…");
    const authorizeBtn = await firstText(page, ["Authorize", "Allow", "Approve", "授权", "允许", "同意"], 8000);
    if (authorizeBtn) { await authorizeBtn.click().catch(() => {}); }
    else log("   未见授权按钮(可能已自动授权或页面结构变化), 等回调…");

    // 等回调码(授权成功即 resolve)。
    const code = await codeP;
    log("⑤ 已拿到授权码, 交换令牌并部署持久通道…");
    const tok = await exchangeCode(code, codeVerifier);
    const oauth = tokenState(tok);
    const result = await provision(tok.access_token, { log, skipVerify: true, extraState: { auth: "credlogin", oauth } });
    return { ok: true, ...result };
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
