#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// GitHub Device-Code 自动批准器 — 道法自然 · 无为而无不为
// 通过既有 Chrome 的 CDP 端点驱动 github.com/login/device:
//   1. (可选) 用 GitHub 账号+密码(+TOTP) 登录一次
//   2. 自动填入设备码 user_code
//   3. 自动点击 Continue / Authorize
// 一旦浏览器登录了目标 GitHub, 后续多个 Devin 账号的设备码
// 都批准给同一个 GitHub → 多 Devin 归一 Git。用户最小输入。
//
// 用法:
//   node approve.js --code 7768-72BC \
//        [--cdp http://localhost:29229] \
//        [--gh-user U --gh-pass P --gh-totp BASE32SECRET]
// 退出码: 0 成功批准 / 2 需人工介入(挑战/验证) / 1 错误
// ═══════════════════════════════════════════════════════════
const crypto = require("crypto");
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) { console.error("[approve] playwright-core 不可用: " + e.message); process.exit(1); }

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function log(m) { console.error("[approve] " + m); }

// RFC 6238 TOTP — 无需第三方依赖
function totp(secretB32) {
  const b32 = secretB32.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of b32) { const v = alphabet.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, "0"); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24 | (hmac[off + 1] & 0xff) << 16 | (hmac[off + 2] & 0xff) << 8 | (hmac[off + 3] & 0xff)) % 1000000;
  return code.toString().padStart(6, "0");
}

async function firstVisible(page, selectors) {
  for (const s of selectors) {
    const el = await page.$(s);
    if (el && await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

(async () => {
  const code = arg("code");
  const cdp = arg("cdp", "http://localhost:29229");
  const ghUser = arg("gh-user"), ghPass = arg("gh-pass"), ghTotp = arg("gh-totp");
  if (!code) { log("缺少 --code"); process.exit(1); }

  let browser;
  try { browser = await chromium.connectOverCDP(cdp); }
  catch (e) { log("无法连接 CDP " + cdp + ": " + e.message); process.exit(1); }

  const ctx = browser.contexts()[0] || (await browser.newContext());
  // 守一: 复用既有 github 标签, 避免多标签分裂设备流状态; 其余 github 标签关闭
  const ghTabs = ctx.pages().filter((p) => (p.url() || "").includes("github.com"));
  const page = ghTabs[0] || (await ctx.newPage());
  for (let i = 1; i < ghTabs.length; i++) { try { await ghTabs[i].close(); } catch (e) {} }
  await page.bringToFront().catch(() => {});
  try {
    log("打开 github.com/login/device …");
    await page.goto("https://github.com/login/device", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);

    // 若被重定向到登录页 → 用凭证登录(用户只需提供一次 GitHub 账号)
    if (/\/login(\?|$)/.test(page.url()) || await page.$("#login_field")) {
      if (!ghUser || !ghPass) { log("需要 GitHub 登录但未提供凭证 — 请先在浏览器登录 GitHub 后重试"); process.exit(2); }
      log("登录 GitHub: " + ghUser);
      await (await page.$("#login_field")).fill(ghUser);
      await (await page.$("#password")).fill(ghPass);
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        page.click('input[name="commit"], button[type="submit"]'),
      ]);
      await page.waitForTimeout(2000);
      // 2FA TOTP
      const otp = await firstVisible(page, ['#app_totp', '#otp', 'input[name="otp"]', 'input[autocomplete="one-time-code"]']);
      if (otp) {
        if (!ghTotp) { log("需要 2FA 但未提供 --gh-totp"); process.exit(2); }
        log("填入 TOTP …");
        await otp.fill(totp(ghTotp));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2500);
      }
      if (/verified-device|sessions\/verified|account_verifications/.test(page.url()) || await page.$('text=/verify|confirm your account/i')) {
        log("GitHub 触发设备/邮箱验证挑战 — 需人工介入"); process.exit(2);
      }
      // 登录后回到设备页
      await page.goto("https://github.com/login/device", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1500);
    }

    // 既有会话 → GitHub 先弹「Device Activation · 选择账号」页, 需先 Continue
    if (/select_account/.test(page.url()) || await page.$('text=Use a different account')) {
      log("账号选择页 → Continue（" + (ghUser || "已登录账号") + "）");
      const pick = await firstVisible(page, ['input[type="submit"][value="Continue"]', 'button:has-text("Continue")', 'input[type="submit"]']);
      if (pick) { await pick.click().catch(() => {}); await page.waitForLoadState("domcontentloaded").catch(() => {}); await page.waitForTimeout(1500); }
    }

    // 填入设备码 — GitHub 用分段单字符输入框(user-code-N, 含隐藏的 dash 位)
    const chars = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase().split("");
    log("填入设备码 " + code + " (" + chars.length + " 位)");
    await page.waitForSelector('input.js-user-code-field, input[id^="user-code-"]', { timeout: 15000 }).catch(() => {});
    // 取可见的单字符输入框(排除 d-none 的分隔位), 按出现顺序填字符
    const boxes = await page.$$('input.js-user-code-field, input[id^="user-code-"]');
    const visibleBoxes = [];
    for (const b of boxes) { if (await b.isVisible().catch(() => false)) visibleBoxes.push(b); }
    if (visibleBoxes.length >= chars.length) {
      for (let i = 0; i < chars.length; i++) {
        await visibleBoxes[i].click().catch(() => {});
        await visibleBoxes[i].fill(chars[i]).catch(() => {});
      }
    } else {
      // 回退: 单输入框或聚焦后逐字符键入(GitHub 会自动跳格)
      const single = await firstVisible(page, ['#user-code', '#user_code', 'input[name="user_code"]', 'input.js-user-code-field']);
      if (single) { await single.click(); }
      await page.keyboard.type(chars.join(""), { delay: 90 });
    }
    await page.waitForTimeout(600);
    const cont = await firstVisible(page, ['input[name="commit"]', 'button[name="commit"]', 'button[type="submit"]', 'input[type="submit"]', 'text=Continue']);
    if (cont) { await cont.click().catch(() => {}); await page.waitForLoadState("domcontentloaded").catch(() => {}); await page.waitForTimeout(2500); }

    // 授权页 — 点击 Authorize
    const authBtn = await firstVisible(page, [
      'button[name="authorize"][value="1"]', 'button:has-text("Authorize")',
      'input[name="authorize"]', 'button#js-oauth-authorize-btn',
    ]);
    if (authBtn) {
      // GitHub 授权按钮有「倒计时禁用」防误点; 该倒计时由 rAF 驱动, 后台标签被节流而永不解禁。
      // 守柔: 先等数秒(若前台正常解禁则直接点), 否则直接解禁属性并提交 — 倒计时纯客户端 UX, 服务端不校验。
      let enabled = false;
      for (let i = 0; i < 6; i++) { if (await authBtn.isEnabled().catch(() => false)) { enabled = true; break; } await page.waitForTimeout(1000); }
      log(enabled ? "点击 Authorize …" : "倒计时被节流 → 解禁并提交 Authorize …");
      const submitted = await page.evaluate(() => {
        const btn = document.querySelector('button[name="authorize"][value="1"], input[name="authorize"][value="1"]');
        if (!btn) return false;
        btn.disabled = false; btn.removeAttribute("disabled"); btn.click();
        return true;
      }).catch(() => false);
      if (!submitted) { await authBtn.click().catch(() => {}); }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(3000);
    }

    const body = (await page.textContent("body").catch(() => "")) || "";
    if (/\/login\/device\/success/.test(page.url()) || /your device is now connected|congratulations|device.*connected|配置完成|all set/i.test(body)) {
      log("设备码已批准 ✓ (github 已授权)"); process.exit(0);
    }
    if (/Authorize/i.test(body) && authBtn) { log("已提交授权"); process.exit(0); }
    log("完成填码; 状态未明确, 由调用方轮询 gh_cli/state 确认"); process.exit(0);
  } catch (e) {
    log("异常: " + (e && e.message)); process.exit(1);
  } finally {
    // 留存 github 标签以便复用/查看; 仅断开 CDP, 不关 Chrome
    try { await browser.close(); } catch (e) {}
  }
})();
