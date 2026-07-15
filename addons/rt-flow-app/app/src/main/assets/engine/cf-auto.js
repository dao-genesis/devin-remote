"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
 * cf-auto.js · Cloudflare 固定域名「全自动建 Worker」编排器 (手机版·代替用户一切负担)
 *
 * 由 MainActivity 在「已武装(armed)」且页面 host 命中 github.com / cloudflare.com 时,
 * 于 document-start/document-end 注入 (先注入 window.__CFAUTO 配置 + userscript.js 运行时).
 * 无为而无不为: 用户点一次「全自动」后, 本脚本跨页面自动完成:
 *   GitHub 登录页  → 填账密并提交
 *   GitHub 2FA 页  → 用 TOTP 密钥本地算 6 位码并提交
 *   OAuth 授权页   → 点 Authorize
 *   CF 建 Token 页 → 逐步点 Continue → Create Token
 *   CF 结果页      → 抓取新 Token → 经本机中继灌入 /api/cf-provision (既有全自动部署)
 *
 * 守一条不可代之界: 提供商人机验证/硬件密钥/新设备验证 (CAPTCHA/WebAuthn) 命中即停手,
 *   置状态交用户点一下, 随后自动续跑 —— 不静默绕过任何安全控制。
 *
 * 纯函数 (base32Decode/totp/classifyPage/scrapeToken/feedToken) 经 test/cf-auto.test.js
 *   切片实测 (RFC6238 官方向量 + 分类/抓取夹具), 勿删标记。DOM 驱动 run() 仅浏览器内执行。
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  var CFAUTO = {};

  // ── Base32 解码 (RFC4648, 忽略空白与大小写与 = 填充) → Uint8Array ──
  var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32Decode(s) {
    s = String(s || "").toUpperCase().replace(/[\s=]/g, "");
    var bits = 0, val = 0, out = [];
    for (var i = 0; i < s.length; i++) {
      var idx = B32.indexOf(s[i]);
      if (idx < 0) continue;
      val = (val << 5) | idx; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
    }
    return new Uint8Array(out);
  }

  // ── TOTP (RFC6238, HMAC-SHA1, 6 位, 30s 步长); subtle 可注入以便测试 ──
  async function totp(secretBase32, timeMs, opts) {
    opts = opts || {};
    var subtle = opts.subtle || (root.crypto && root.crypto.subtle);
    if (!subtle) throw new Error("no_subtle_crypto");
    var step = opts.step || 30, digits = opts.digits || 6;
    var counter = Math.floor((typeof timeMs === "number" ? timeMs : Date.now()) / 1000 / step);
    var msg = new Uint8Array(8);
    for (var i = 7; i >= 0; i--) { msg[i] = counter & 0xff; counter = Math.floor(counter / 256); }
    var keyBytes = base32Decode(secretBase32);
    var key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    var sig = new Uint8Array(await subtle.sign("HMAC", key, msg));
    var off = sig[sig.length - 1] & 0x0f;
    var bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
    var code = (bin % Math.pow(10, digits)).toString();
    while (code.length < digits) code = "0" + code;
    return code;
  }

  // ── 页面分类 (纯函数·据 url + facts 判定当前阶段) ──
  //   facts: { ghLogin, gh2fa, ghSso, ghOauth, cfContinue, cfCreate, cfTokenText, captcha, webauthn }
  function classifyPage(url, facts) {
    facts = facts || {};
    url = String(url || "");
    if (facts.captcha) return "captcha";
    if (facts.webauthn) return "webauthn";
    var isGh = /(^|\.)github\.com/i.test(hostOf(url));
    var isCf = /(^|\.)cloudflare\.com/i.test(hostOf(url));
    if (isGh) {
      if (facts.gh2fa) return "gh_2fa";
      if (facts.ghSso) return "gh_sso";
      if (facts.ghOauth) return "gh_oauth";
      if (facts.ghLogin) return "gh_login";
    }
    if (isCf) {
      if (facts.cfTokenText) return "cf_token_result";
      if (facts.cfCreate) return "cf_create";
      if (facts.cfContinue) return "cf_continue";
    }
    return "unknown";
  }
  function hostOf(u) { try { return new (root.URL || URL)(u).host; } catch (e) { var m = /^https?:\/\/([^\/?#]+)/i.exec(u); return m ? m[1] : ""; } }

  // ── 从结果页文本/值中抓 Cloudflare API Token (40 位 [A-Za-z0-9_-]) ──
  //   优先 readonly input / code 块里被单独展示的值, 排除 URL/句中噪声。
  function scrapeToken(candidates) {
    var arr = Array.isArray(candidates) ? candidates : [String(candidates || "")];
    var re = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{40})([^A-Za-z0-9_-]|$)/;
    for (var i = 0; i < arr.length; i++) {
      var s = String(arr[i] || "").trim();
      if (/^[A-Za-z0-9_-]{40}$/.test(s)) return s;         // 独占一个元素的值 = 最可信
      var m = re.exec(s);
      if (m && !/https?:\/\//i.test(s)) return m[2];
    }
    return null;
  }

  // ── 把抓到的 Token 经本机中继灌入既有全自动部署 (/api/cf-provision) ──
  //   bases: [loopback/tunnel base...]; xhrFn(opts) 兼容 GM_xmlhttpRequest 形态 (返回 Promise)。
  function feedToken(bases, session, relayToken, token, xhrFn) {
    bases = (bases || []).filter(Boolean);
    var body = JSON.stringify({ path: "/api/cf-provision", method: "POST", body: { token: token } });
    var idx = 0;
    function tryNext() {
      if (idx >= bases.length) return Promise.reject(new Error("all_bases_failed"));
      var base = String(bases[idx++]).replace(/\/$/, "");
      return xhrFn({
        method: "POST",
        url: base + "/relay/" + encodeURIComponent(session || "local"),
        headers: { "Authorization": "Bearer " + (relayToken || ""), "Content-Type": "application/json" },
        data: body
      }).then(function (res) {
        var st = res && res.status;
        if (st >= 200 && st < 400) return { ok: true, base: base, status: st, response: res.responseText || res.response };
        return tryNext();
      }, function () { return tryNext(); });
    }
    return tryNext();
  }

  CFAUTO.base32Decode = base32Decode;
  CFAUTO.totp = totp;
  CFAUTO.classifyPage = classifyPage;
  CFAUTO.scrapeToken = scrapeToken;
  CFAUTO.feedToken = feedToken;
  CFAUTO.hostOf = hostOf;

  // ═══ DOM 驱动 (仅浏览器·测试环境不跑) ═══════════════════════════════════
  //__CFAUTO_RUN_START__
  function inBrowser() { return typeof document !== "undefined" && typeof window !== "undefined"; }
  if (inBrowser()) {
    var CFG = root.__CFAUTO || {};
    try { delete root.__CFAUTO; } catch (e) { root.__CFAUTO = undefined; }  // 读后即删·减少页面 JS 触及凭证
    if (CFG && CFG.active && !root.__cfAutoRan) {
      root.__cfAutoRan = 1;
      var status = function (phase, msg) { try { root.__dcus && root.__dcus.log && root.__dcus.log("[cf-auto] " + phase + ": " + msg); } catch (e) {} try { root.__dcus && root.__dcus.notify && root.__dcus.notify("CF全自动: " + msg); } catch (e) {} };

      // GM 式跨域 xhr (经原生桥·绕 CORS/混合内容), Promise 化
      var xhr = function (opt) {
        return new Promise(function (resolve, reject) {
          try {
            var reg = (root.__dcusXhrReg = root.__dcusXhrReg || {});
            var id = "cf" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
            reg[id] = function (st, body, hdrs) { resolve({ status: st, responseText: body, headers: hdrs }); };
            root.__dcus.xhr(id, JSON.stringify({ method: opt.method || "GET", url: opt.url, headers: opt.headers || {}, data: opt.data || "" }));
            setTimeout(function () { if (reg[id]) { delete reg[id]; reject(new Error("timeout")); } }, 30000);
          } catch (e) { reject(e); }
        });
      };

      var text = function (el) { return (el && (el.value || el.textContent || el.innerText) || "").trim(); };
      var q = function (sel) { try { return document.querySelector(sel); } catch (e) { return null; } };
      var qa = function (sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } };
      var btnByText = function (re) {
        var els = qa("button, a[role=button], input[type=submit], summary");
        for (var i = 0; i < els.length; i++) { if (re.test(text(els[i]) || els[i].value || "")) return els[i]; }
        return null;
      };
      var setVal = function (el, val) {
        if (!el) return false;
        try {
          var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value");
          if (setter && setter.set) setter.set.call(el, val); else el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        } catch (e) { el.value = val; return true; }
      };

      var facts = function () {
        var body = (document.body && (document.body.innerText || "")) || "";
        return {
          captcha: !!(q("iframe[src*='captcha']") || q("iframe[src*='hcaptcha']") || q("iframe[src*='recaptcha']") || q("iframe[title*='challenge']") || /verify you are human|请完成人机验证/i.test(body)),
          webauthn: !!(q("input[name=otp][data-webauthn], [data-target*='webauthn']") || /security key|passkey|硬件密钥|安全密钥/i.test(body) && !q("#app_totp")),
          ghLogin: !!(q("#login_field") && q("#password")),
          gh2fa: !!(q("#app_totp") || q("input[name=otp]") || q("#totp")),
          ghSso: !!btnByText(/单点登录|use your.*sso|continue with.*sso/i),
          ghOauth: !!(q("button[name=authorize][value='1'], #js-oauth-authorize-btn") || btnByText(/^authorize\b|授权/i)),
          cfContinue: !!btnByText(/continue to summary|继续.*(摘要|以显示)/i),
          cfCreate: !!btnByText(/create token|创建令牌|创建.*token/i),
          cfTokenText: (function () {
            var ro = qa("input[readonly], textarea[readonly], code, pre");
            for (var i = 0; i < ro.length; i++) { var t = text(ro[i]); if (/^[A-Za-z0-9_-]{40}$/.test(t)) return t; }
            return null;
          })()
        };
      };

      var act = async function () {
        var f = facts();
        var cat = classifyPage(location.href, f);
        status("stage", cat);
        if (cat === "captcha" || cat === "webauthn") { status("pause", "需你完成人机验证/硬件密钥, 完成后自动续跑"); return; }
        if (cat === "gh_login") {
          if (CFG.gh && CFG.gh.user) { setVal(q("#login_field"), CFG.gh.user); setVal(q("#password"), CFG.gh.pass || ""); var fm = q("#login_field"); var form = fm && fm.form; if (form) { var sb = form.querySelector("input[type=submit], button[type=submit]"); (sb || {}).click ? sb.click() : form.submit(); } }
          else status("wait", "登录页·未提供账密, 等你手动登录");
          return;
        }
        if (cat === "gh_2fa") {
          if (CFG.gh && CFG.gh.otp) { var code = await totp(CFG.gh.otp, Date.now()); var inp = q("#app_totp") || q("input[name=otp]") || q("#totp"); setVal(inp, code); var form2 = inp && inp.form; if (form2) { var sb2 = form2.querySelector("input[type=submit], button[type=submit]"); (sb2 || {}).click ? sb2.click() : form2.submit(); } }
          else status("wait", "2FA·未提供 TOTP 密钥, 等你手动输入");
          return;
        }
        if (cat === "gh_oauth") { var b = q("#js-oauth-authorize-btn") || q("button[name=authorize][value='1']") || btnByText(/^authorize\b|授权/i); if (b) b.click(); return; }
        if (cat === "cf_continue") { var c = btnByText(/continue to summary|继续.*(摘要|以显示)/i); if (c) c.click(); return; }
        if (cat === "cf_create") { var cr = btnByText(/create token|创建令牌|创建.*token/i); if (cr) cr.click(); return; }
        if (cat === "cf_token_result") {
          var tok = scrapeToken(qa("input[readonly], textarea[readonly], code, pre").map(text));
          if (tok) {
            status("token", "已抓取 Token, 灌入部署…");
            try { var r = await feedToken(CFG.bases || [], CFG.session, CFG.relayToken, tok, xhr); status("done", r.ok ? "已灌入·全自动部署 Worker 中" : "灌入失败"); }
            catch (e) { status("error", "灌入失败: " + (e && e.message || e)); }
          }
          return;
        }
      };

      var ticks = 0;
      var loop = function () { act().catch(function () {}); if (++ticks < 40) setTimeout(loop, 1500); };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loop); else loop();
    }
  }
  //__CFAUTO_RUN_END__

  if (typeof module !== "undefined" && module.exports) module.exports = CFAUTO;
  else root.CFAUTO = CFAUTO;
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
