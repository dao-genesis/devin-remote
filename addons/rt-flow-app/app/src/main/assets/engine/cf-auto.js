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
 *   CF 登录页      → 填 Cloudflare 邮箱/密码并提交 (直登 CF 账号·GitHub 之外的另一路)
 *   CF 2FA 页      → 用 TOTP 密钥本地算 6 位码并提交
 *   CF 已登录(dash) → ★内部接口直建 Token (POST /api/v4/user/tokens·同 dashboard 前端调的
 *                      同一 HTTP 接口·同源带 cookie·零 UI 点击·零抓取)→ 灌入 /api/cf-provision
 *   [兜底] CF 建 Token 页 → 逐步点 Continue → Create Token → 结果页抓 Token (内部接口不可用时)
 *
 * 两种登录模式·完全分离·用户二选一 (底层归一):
 *   模式A · Cloudflare 直登  = 只填 Cloudflare 邮箱+密码(+2FA) → CF 登录页直接填表提交。
 *   模式B · GitHub 登 CF     = 只填 GitHub 账号+密码+2FA 种子 → CF 登录页点「用 GitHub 登录」
 *                              → GitHub 登录/2FA/OAuth 授权 → 落回 CF dash。
 *   两条各自独立(CF 就是 CF·GitHub 就是 GitHub·互不混), 登进 CF 之后完全一模一样:
 *   都收敛到「登 CF → (会话态)内部接口建 Token → 部署 Worker」同一条链。登录一次(含其
 *   Turnstile 人机验证·用户本来手动也要过的同一道关)之后, 建 Token+部署全程纯接口自动化。
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
  //   facts: { ghLogin, gh2fa, ghSso, ghOauth, cfLogin, cf2fa, cfContinue, cfCreate, cfTokenText, captcha, webauthn }
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
      if (facts.cf2fa) return "cf_2fa";
      if (facts.cfLogin) return "cf_login";
      // 已登录 dash 且无登录/2FA/建token 表单 → 直接走内部接口建 Token (首选·零 UI)
      if (/(^|\.)dash\.cloudflare\.com$/i.test(hostOf(url))) return "cf_authed";
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

  // ── 判定用户选定的登录模式 (纯函数·可测): 两种模式完全分离·二选一 ──
  //   github     = 只给了 GitHub 账号 → 经 CF 登录页的「用 GitHub 登录」入口
  //   cloudflare = 只给了 Cloudflare 账号 → CF 登录页直接填邮箱密码
  //   manual     = 都没给 → 命中登录页时等用户手动登一次
  function loginMode(cfg) {
    cfg = cfg || {};
    var gh = !!(cfg.gh && (cfg.gh.user || cfg.gh.otp));
    var cf = !!(cfg.cf && (cfg.cf.user || cfg.cf.otp));
    if (gh && !cf) return "github";
    if (cf && !gh) return "cloudflare";
    if (gh && cf) return "github";   // 都填则以 GitHub 优先(两链仍各自独立)
    return "manual";
  }

  // ── 本通道所需最小权限组 (账号级为部署/读账号硬需求; 用户级供 verify/accounts) ──
  var ACCT_GROUPS = ["Workers Scripts Write", "Account Settings Read"];
  var USER_GROUPS = ["User Details Read", "Memberships Read"];

  // ── 从 CF 内部接口的权限组全集里按名挑出所需组 (纯函数·可测) ──
  //   先精确匹配, 再退到「去空白·不分大小写」匹配 —— 容忍不同账号/语言环境下 CF 回传的
  //   权限组名大小写或首尾空白差异, 提升「任意用户」可复现性 (语义名不变即命中)。
  function pickGroups(all, names) {
    all = Array.isArray(all) ? all : [];
    var norm = function (s) { return String(s == null ? "" : s).trim().toLowerCase(); };
    return (names || []).map(function (n) {
      for (var i = 0; i < all.length; i++) { if (all[i] && all[i].name === n) return { id: all[i].id }; }
      for (var j = 0; j < all.length; j++) { if (all[j] && norm(all[j].name) === norm(n)) return { id: all[j].id }; }
      return null;
    }).filter(Boolean);
  }

  // ── 诊断: 从权限组全集里找出「缺失的必需组名」(纯函数·可测) ──
  //   返回给定 names 中在 all 里匹配不到 id 的那些名字。cfMintToken 用它在铸 Token 前
  //   就明确报错(而非静默铸出欠权 Token 到后续「读不到账号」才炸·难排查)。
  function missingGroups(all, names) {
    all = Array.isArray(all) ? all : [];
    return (names || []).filter(function (n) { return pickGroups(all, [n]).length === 0; });
  }

  // ── 构造 POST /api/v4/user/tokens 的请求体 (纯函数·可测) ──
  //   最小权限: 账号级 Workers 脚本写 + 账号设置读; 用户级 用户详情读 + 成员读 (供 verify/accounts)。
  function buildTokenPayload(o) {
    o = o || {};
    var acctG = pickGroups(o.groups, ACCT_GROUPS);
    var userG = pickGroups(o.groups, USER_GROUPS);
    var policies = [];
    if (acctG.length && o.accountId) {
      var ar = {}; ar["com.cloudflare.api.account." + o.accountId] = "*";
      policies.push({ effect: "allow", resources: ar, permission_groups: acctG });
    }
    if (userG.length && o.userId) {
      var ur = {}; ur["com.cloudflare.api.user." + o.userId] = "*";
      policies.push({ effect: "allow", resources: ur, permission_groups: userG });
    }
    return { name: o.name || ("dao-relay " + Date.now()), policies: policies };
  }

  CFAUTO.base32Decode = base32Decode;
  CFAUTO.totp = totp;
  CFAUTO.classifyPage = classifyPage;
  CFAUTO.scrapeToken = scrapeToken;
  CFAUTO.feedToken = feedToken;
  CFAUTO.hostOf = hostOf;
  CFAUTO.pickGroups = pickGroups;
  CFAUTO.missingGroups = missingGroups;
  CFAUTO.buildTokenPayload = buildTokenPayload;
  CFAUTO.loginMode = loginMode;
  CFAUTO.ACCT_GROUPS = ACCT_GROUPS;
  CFAUTO.USER_GROUPS = USER_GROUPS;

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
          cf2fa: !!((q("input[name=totp]") || q("input[autocomplete=one-time-code]") || q("#totp-input") || q("input[name='2fa_code']")) && /two.?factor|verification code|authentication code|身份验证|两步验证|验证码|一次性/i.test(body)),
          cfLogin: !!((q("input[type=email]") || q("input[name=email]") || q("input[name=identity]")) && (q("input[type=password]") || q("input[name=password]"))),
          cfTokenText: (function () {
            var ro = qa("input[readonly], textarea[readonly], code, pre");
            for (var i = 0; i < ro.length; i++) { var t = text(ro[i]); if (/^[A-Za-z0-9_-]{40}$/.test(t)) return t; }
            return null;
          })()
        };
      };

      // ── ★会话态·经 CF 内部接口纯 HTTP 直建 Token (同源带 cookie·零 UI·零抓取) ──
      //   与 dashboard 前端调的同一批 /api/v4 接口: 读用户/账号/权限组 → POST 建 Token → 取 value。
      var cfMintToken = async function () {
        var api = async function (path, init) {
          init = init || {};
          var r = await fetch(path, {
            method: init.method || "GET",
            credentials: "include",
            headers: Object.assign({ Accept: "application/json", "X-Cross-Site-Security": "dash" }, init.headers || {}),
            body: init.body
          });
          var t = null; try { t = await r.json(); } catch (e) { t = {}; }
          if (!r.ok || t.success === false) throw new Error("cf " + path + " HTTP " + r.status);
          return t.result;
        };
        var user = await api("/api/v4/user");
        var accts = await api("/api/v4/accounts?per_page=50");
        if (!accts || !accts.length) throw new Error("no_account");
        var groups = await api("/api/v4/user/tokens/permission_groups");
        // 部署/读账号硬需求账号级两组; 缺任一即明确报错(列出 CF 实际回传的组名·便于任意用户排查),
        // 不静默铸出欠权 Token 拖到后续「读不到账号」才炸。
        var acctMiss = missingGroups(groups, ACCT_GROUPS);
        if (acctMiss.length) {
          var names = (Array.isArray(groups) ? groups : []).map(function (g) { return g && g.name; }).filter(Boolean);
          throw new Error("missing_perm_groups: " + acctMiss.join(", ") + " (CF 回传 " + names.length + " 组·此账号权限组名与预期不符)");
        }
        var payload = buildTokenPayload({ name: "dao-relay " + Date.now(), accountId: accts[0].id, userId: user.id, groups: groups });
        if (!payload.policies.length) throw new Error("no_permission_groups_matched");
        var res = await api("/api/v4/user/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        return res && res.value;
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
        if (cat === "cf_login") {
          var mode = loginMode(CFG);
          if (mode === "github") {
            // 模式B: 在 CF 登录页点「用 GitHub 登录」入口 → 跳 github.com 走 gh_login/gh_2fa/gh_oauth
            var ghBtn = q("a[href*='github'], a[data-provider='github'], button[data-provider='github']") || btnByText(/github/i);
            if (ghBtn) { status("oauth", "CF 登录页·点「用 GitHub 登录」"); ghBtn.click(); }
            else status("wait", "CF 登录页·未见 GitHub 登录入口, 等你手动点一次");
            return;
          }
          if (mode === "cloudflare" && CFG.cf && CFG.cf.user) {
            var cem = q("input[type=email]") || q("input[name=email]") || q("input[name=identity]");
            var cpw = q("input[type=password]") || q("input[name=password]");
            if (cem) setVal(cem, CFG.cf.user);
            if (cpw) setVal(cpw, CFG.cf.pass || "");
            var csb = (cpw && cpw.form && cpw.form.querySelector("button[type=submit], input[type=submit]")) || btnByText(/log ?in|sign ?in|登录|登入|continue|next|下一步/i);
            if (csb) csb.click();
          } else status("wait", "Cloudflare 登录页·未提供账密, 等你手动登录");
          return;
        }
        if (cat === "cf_2fa") {
          if (CFG.cf && CFG.cf.otp) {
            var ccode = await totp(CFG.cf.otp, Date.now());
            var cinp = q("input[name=totp]") || q("input[autocomplete=one-time-code]") || q("#totp-input") || q("input[name='2fa_code']");
            setVal(cinp, ccode);
            var cf2 = cinp && cinp.form; var csb2 = (cf2 && cf2.querySelector("button[type=submit], input[type=submit]")) || btnByText(/verify|confirm|验证|确认/i);
            if (csb2) csb2.click();
          } else status("wait", "Cloudflare 2FA·未提供 TOTP 密钥, 等你手动输入");
          return;
        }
        if (cat === "cf_authed") {
          if (root.__cfMinted) return;
          root.__cfMinted = 1;
          status("mint", "已登录 CF·经内部接口直建 Token…");
          try {
            var mtk = await cfMintToken();
            if (mtk) {
              status("token", "内部接口已建 Token, 灌入部署…");
              var mr = await feedToken(CFG.bases || [], CFG.session, CFG.relayToken, mtk, xhr);
              status("done", mr.ok ? "Token 已建·全自动部署 Worker 中" : "灌入失败");
            } else { root.__cfMinted = 0; status("wait", "未取到 Token, 重试中"); }
          } catch (e) { root.__cfMinted = 0; status("error", "建 Token 失败: " + (e && e.message || e)); }
          return;
        }
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
