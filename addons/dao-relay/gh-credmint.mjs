// gh-credmint.mjs · GitHub 账密+TOTP 隔离档自动登录 → 官网建经典 PAT → 回吐 token
// ─────────────────────────────────────────────────────────────────────────────
// 本源: 用户自有账号 + 自有 TOTP 种子, 在【该号专属隔离 profile】里走 GitHub 官方登录流程
//   (每号独立指纹/代理/cookie → 规避同环境批量风控封号), 登入后在官网 /settings/tokens/new
//   建经典 PAT 并回吐。TOTP 是用户自己的第二因子(RFC6238 本地计算), 非绕过安全挑战。
// 守柔边界: 只处理 GitHub 官方 2FA(TOTP)/复核(two_factor_checkup·sudo) 与可跳过的信任设备提示;
//   一旦命中真·CAPTCHA / 硬件密钥(WebAuthn/Passkey) / 邮箱设备验证等本号主自身才能完成的挑战,
//   立即 { ok:false, needUser:true } 交回用户, 绝不尝试绕过。
import crypto from 'node:crypto';

const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totp(seedB32, t = Date.now()) {
  const b32 = String(seedB32 || '').replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = '';
  for (const c of b32) { const v = ALPH.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes); const counter = Math.floor(t / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeBigInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest(); const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

const SCOPES_ADMIN = ['repo', 'workflow', 'write:packages', 'delete:packages', 'admin:org', 'admin:org_hook', 'gist', 'notifications', 'user', 'delete_repo', 'write:discussion', 'admin:public_key', 'admin:repo_hook'];
const SCOPES_MEMBER = ['repo', 'workflow', 'gist', 'notifications', 'user'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 真·安全挑战特征(本号主自身才能完成 → 守柔交回)
const CHALLENGE_RE = /\/sessions\/verified-device|verify.*device|verification code was sent|check your email|passkey|security key|webauthn|are you a robot|captcha|unusual|suspicious/i;

async function loadChromium() {
  const mod = await import('playwright').catch(() => null);
  if (mod && mod.chromium) return mod.chromium;
  const cmod = await import('playwright-core').catch(() => null);
  if (cmod && cmod.chromium) return cmod.chromium;
  throw new Error('playwright 未安装(dao-relay/node_modules)');
}

// 主入口: 返回 { ok, token?, via?, scopes?, error?, needUser? }
export async function mintPat(opts = {}) {
  const login = String(opts.login || '').trim().replace(/^@/, '');
  const pass = String(opts.pass || '');
  const seed = String(opts.otp || opts.seed || '');
  const role = opts.role === 'admin' ? 'admin' : 'member';
  const scopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : (role === 'admin' ? SCOPES_ADMIN : SCOPES_MEMBER);
  const headless = opts.headless !== false;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!login || !pass) return { ok: false, error: '缺账号或密码' };

  const chromium = await loadChromium();
  const launchOpts = { headless, channel: opts.channel || 'chrome', args: ['--disable-blink-features=AutomationControlled'] };
  if (opts.proxy) launchOpts.proxy = typeof opts.proxy === 'string' ? { server: opts.proxy } : opts.proxy;
  const profileDir = opts.profileDir || '';
  let ctx;
  try {
    ctx = profileDir
      ? await chromium.launchPersistentContext(profileDir, launchOpts)
      : await chromium.launchPersistentContext('', launchOpts);
  } catch (e) { return { ok: false, error: 'browser 启动失败: ' + (e && e.message || e) }; }

  const page = ctx.pages()[0] || await ctx.newPage();
  let lastCode = '';
  const freshTotp = async () => {
    if (!seed) return '';
    let code = totp(seed);
    if (code === lastCode) { const w = (30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 1200; log('等待新 TOTP 窗口 ' + Math.round(w / 1000) + 's'); await sleep(w); code = totp(seed); }
    lastCode = code; return code;
  };
  const otpSel = '#app_totp, #otp, input[name=otp], input[autocomplete=one-time-code], input[name="sudo[otp]"]';
  const hitChallenge = async () => {
    const u = page.url();
    if (CHALLENGE_RE.test(u)) return true;
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
    return CHALLENGE_RE.test(body);
  };
  const handleCheckup = async () => {
    for (let i = 0; i < 3; i++) {
      const u = page.url();
      const onCk = /two_factor_checkup|sessions\/two-factor|\/sudo/.test(u);
      const vis = await page.locator(otpSel).first().isVisible({ timeout: 1500 }).catch(() => false);
      if (!onCk && !vis) return false;
      if (await hitChallenge()) return 'challenge';
      const c = await freshTotp(); if (!c) return false;
      log('复核页填 TOTP ' + c.slice(0, 2) + '****');
      await page.locator(otpSel).first().fill(c).catch(() => {});
      await sleep(400);
      await page.click('button[type=submit], input[name=commit], button:has-text("Verify"), button:has-text("Confirm")').catch(() => {});
      await sleep(3000);
    }
    return true;
  };

  let token = '';
  try {
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (await hitChallenge()) { await ctx.close().catch(()=>{}); return { ok: false, needUser: true, error: '登录页命中安全挑战(交回用户)' }; }
    await page.fill('#login_field', login).catch(() => {});
    await page.fill('#password', pass).catch(() => {});
    await page.click('input[name=commit], [type=submit]').catch(() => {});
    await sleep(3500);
    if (await hitChallenge()) { await ctx.close().catch(()=>{}); return { ok: false, needUser: true, error: '密码后命中安全挑战/设备验证(交回用户)' }; }
    if (/two-factor/.test(page.url()) || await page.locator(otpSel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
      const c = await freshTotp();
      await page.locator(otpSel).first().fill(c).catch(() => {});
      await sleep(400);
      await page.click('button[type=submit], input[name=commit]').catch(() => {});
      await sleep(3500);
    }
    log('post-login url=' + page.url());
    if ((await handleCheckup()) === 'challenge') { await ctx.close().catch(()=>{}); return { ok: false, needUser: true, error: '2FA 复核命中安全挑战(交回用户)' }; }

    const DESC = 'dao-' + login + '-' + Date.now().toString(36).slice(-4); // 唯一名 · 避免与已存 PAT「Note has already been taken」
    const url = 'https://github.com/settings/tokens/new?description=' + encodeURIComponent(DESC) + '&scopes=' + encodeURIComponent(scopes.join(','));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    if ((await handleCheckup()) === 'challenge') { await ctx.close().catch(()=>{}); return { ok: false, needUser: true, error: 'tokens 页复核命中安全挑战(交回用户)' }; }
    if (/\/login/.test(page.url())) { await ctx.close().catch(()=>{}); return { ok: false, error: '登录态未建立(tokens 页被弹回登录)' }; }
    if (!/settings\/tokens\/new/.test(page.url())) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}); await sleep(1200); }
    log('tokens/new url=' + page.url());

    // 有效期设「无期限」(存在该控件时)
    try {
      const sel = page.locator('select#token_expiration, select[name="personal_access_token[expires_at_option]"]').first();
      if (await sel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await sel.selectOption({ label: /No expiration|无期限|永不/i }).catch(async () => { await sel.selectOption('none').catch(() => {}); });
        await sleep(400);
      }
    } catch { /* 守柔 */ }
    const nameInp = page.locator('#token_description, input[name="personal_access_token[description]"], input[name="oauth_access[description]"]').first();
    if (await nameInp.isVisible({ timeout: 2000 }).catch(() => false)) { await nameInp.fill(DESC).catch(() => {}); }
    for (const sc of scopes) {
      const cb = page.locator(`input[type=checkbox][value="${sc}"]`).first();
      if (await cb.isVisible({ timeout: 400 }).catch(() => false)) { if (!(await cb.isChecked().catch(() => true))) await cb.check().catch(() => {}); }
    }
    const gen = page.locator('button:has-text("Generate token"), input[value*="Generate"], button[type=submit]').first();
    await gen.scrollIntoViewIfNeeded().catch(() => {});
    await gen.click().catch(() => {});
    await sleep(3500);
    const cf = page.locator('button:has-text("I understand"), button:has-text("Generate token")').first();
    if (await cf.isVisible({ timeout: 1500 }).catch(() => false)) { await cf.click().catch(() => {}); await sleep(2500); }
    log('after generate url=' + page.url());
    if (/two_factor_checkup|\/sudo|sessions\/two-factor/.test(page.url())) {
      if ((await handleCheckup()) === 'challenge') { await ctx.close().catch(()=>{}); return { ok: false, needUser: true, error: '建 PAT sudo 复核命中安全挑战(交回用户)' }; }
      await sleep(1500);
      if (!/tokens?($|\/)/.test(page.url()) || !(await page.locator('#new-oauth-token, code.token').first().isVisible({ timeout: 1500 }).catch(() => false))) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(1200); await handleCheckup();
        const g2 = page.locator('button:has-text("Generate token"), input[value*="Generate"], button[type=submit]').first();
        await g2.scrollIntoViewIfNeeded().catch(() => {}); await g2.click().catch(() => {}); await sleep(3500);
        const cf2 = page.locator('button:has-text("I understand"), button:has-text("Generate token")').first();
        if (await cf2.isVisible({ timeout: 1500 }).catch(() => false)) { await cf2.click().catch(() => {}); await sleep(2500); }
      }
    }
    const tokEl = page.locator('#new-oauth-token, [id^="new-oauth-token"], code.token, .token, input#new-oauth-token').first();
    token = await tokEl.getAttribute('value').catch(() => null);
    if (!token) token = (await tokEl.innerText().catch(() => '')).trim();
    if (!token) { const body = await page.content(); const m = body.match(/ghp_[A-Za-z0-9]{36,}/); if (m) token = m[0]; }
  } catch (e) {
    await ctx.close().catch(() => {});
    return { ok: false, error: String(e && e.message || e) };
  }
  await ctx.close().catch(() => {});
  if (token && /^ghp_[A-Za-z0-9]{36,}$/.test(token)) return { ok: true, token, via: 'cred-mint', scopes, role, login };
  return { ok: false, needUser: true, error: '未取到 PAT(可能命中人机/设备验证 → 交回用户手动建)' };
}
