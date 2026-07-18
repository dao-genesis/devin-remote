"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
 * cf-pool.js · Cloudflare 账号池 · 纯逻辑本源 (万法识号·多号统管·闭环建 Worker)
 *
 * 道法自然 · 正本清源: 内网穿透的「固定公网地址」板块过去只有单账号一次性表单,
 *   无「添加/管理/多账号/统管已建 Token 与 Worker」——违背用户「只需最小化输入账号+
 *   密码即跑通全流程并统管一切资源」的本源。本模块把切号板块 (switch.html) 的账号池
 *   哲学移植到 CF 上: 任意格式粘贴自动识号 → 入池 → 每号一键「登录→建Token→部署Worker」
 *   闭环 → 统一管理所有已建 Worker/Token/账号资源。
 *
 * 本文件只放**纯函数** (无 DOM/无 Native), 经 test/cf-pool.test.js 切片实测。
 *   UI 与编排 (arm cf-auto / 调 /api/cf-provision / 轮询 cf-status) 落在 tunnel.html。
 *
 * 一条池记录 (entry):
 *   { email?, password?, key?, token?,        // 凭证 (任选其一即可建; email+password 为首选本源)
 *     accountId?, workerUrl?, subdomain?,      // 已建资源 (统管)
 *     phase?, step?, msg?, ts? }               // 状态 (idle/running/done/error)
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  var CFP = {};

  // ── 凭证判类 (纯函数): Global API Key = 37 位 hex; API Token = 40 位 [A-Za-z0-9_-]; 其余=密码 ──
  //   Cloudflare Global API Key 恒为 37 位小写十六进制; API Token 恒为 40 位 url-safe base64。
  //   普通登录密码几乎不可能命中这两种精确形态 → 据此把「一行 邮箱 秘密」里的秘密正确归类。
  function classifySecret(s) {
    s = String(s == null ? "" : s).trim();
    if (/^[a-f0-9]{37}$/i.test(s)) return "key";
    if (/^[A-Za-z0-9_-]{40}$/.test(s)) return "token";
    return "password";
  }

  // ── 去空白·转小写 (邮箱归一·大小写/首尾空白不敏感) ──
  function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }

  // ── 万法识号·类型判定 (纯函数) ────────────────────────────────────────────
  //   Cloudflare 登录用邮箱; GitHub 登 CF 用「GitHub 用户名(非邮箱)」。据此自动识别两类账号,
  //   用户只需粘贴, 无需自己声明是哪种 —— 正本清源·用户负担最小化。
  function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s == null ? "" : s).trim()); }
  //   TOTP 种子: base32 大写 (A-Z2-7) 16~32 位。恒大写以与普通密码 (含小写) 区分, 降低误判。
  function isTotpSeed(s) { s = String(s == null ? "" : s).replace(/\s+/g, ""); return /^[A-Z2-7]{16,32}$/.test(s); }
  //   GitHub PAT: ghp_/gho_/ghu_/ghs_/ghr_ 或 github_pat_ 前缀。
  function isGhPat(s) { s = String(s == null ? "" : s).trim(); return /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(s) || /^github_pat_[A-Za-z0-9_]{20,}$/.test(s); }
  //   合法 GitHub 用户名: 字母数字与连字符, 1~39 位, 不以连字符起止 (且不是邮箱)。
  function isGhUser(s) { s = String(s == null ? "" : s).trim(); return !isEmail(s) && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(s); }

  // ── 账号类型 (纯函数·供 UI 徽标/编排分流) ──
  function accountType(e) { return (e && e.provider === "github") ? "github" : "cloudflare"; }

  // ── 单行→GitHub 池记录 (纯函数): 强信号 (含 TOTP 种子 或 ghp_ PAT 或 显式 gh:/github: 前缀) 才判为
  //   GitHub, 避免把「用户名 密码」这类噪声误判。字段以分隔符切分, 按语义归位:
  //   user=首个合法 GitHub 用户名; otp=base32 种子; pat=ghp_*; pass=otp 前一个字段(否则次字段)。
  //   兼容: `user pass totp`、`user:pass:totp`、`user pass totp ghp_`、md 表格 `| user | role | pass | totp | pat |`。
  function parseGithubLines(raw) {
    var out = [];
    String(raw == null ? "" : raw).split(/\r?\n/).forEach(function (line) {
      var ln = String(line || "").trim();
      if (!ln) return;
      var explicit = false;
      var mpre = /^(?:gh|github)\s*[:：]\s*/i;
      if (mpre.test(ln)) { explicit = true; ln = ln.replace(mpre, ""); }
      // md 表格首尾竖线剥离
      ln = ln.replace(/^\|/, "").replace(/\|$/, "");
      var parts = ln.split(/[\s|,;，；\t]+/).map(function (x) { return String(x || "").trim(); }).filter(Boolean);
      if (parts.length < 2) return;
      if (!isGhUser(parts[0])) return;                 // 首字段须是 GitHub 用户名 (非邮箱)
      var user = parts[0], otp = null, pat = null, otpIdx = -1;
      for (var i = 1; i < parts.length; i++) {
        if (!pat && isGhPat(parts[i])) { pat = parts[i]; continue; }
        if (otp == null && isTotpSeed(parts[i])) { otp = parts[i].replace(/\s+/g, ""); otpIdx = i; }
      }
      // 强信号门槛: 无 TOTP / 无 PAT / 无显式前缀 → 不误判为 GitHub
      if (!explicit && otp == null && !pat) return;
      // 密码: TOTP 前一个非 user 字段优先; 否则取第二个字段 (排除 pat/otp)
      var pass = null;
      if (otpIdx > 1 && parts[otpIdx - 1] !== user && !isGhPat(parts[otpIdx - 1])) pass = parts[otpIdx - 1];
      if (pass == null) {
        for (var j = 1; j < parts.length; j++) { if (j === otpIdx) continue; if (isGhPat(parts[j])) continue; pass = parts[j]; break; }
      }
      var e = { provider: "github", ghUser: user };
      if (pass) e.ghPass = pass;
      if (otp) e.ghOtp = otp;
      if (pat) e.ghPat = pat;
      out.push(e);
    });
    return out;
  }

  // ── 池记录去重键: GitHub 按用户名; 有邮箱按邮箱; 否则按 token/key ──
  function keyOf(e) {
    if (!e) return "";
    if (e.provider === "github" && e.ghUser) return "gh:" + String(e.ghUser).trim().toLowerCase();
    if (e.email) return "email:" + normEmail(e.email);
    if (e.token) return "token:" + String(e.token);
    if (e.key) return "key:" + String(e.key);
    return "";
  }

  // ── 万法识号 → CF 池记录 (纯函数): 借用 switch.html 同一个 parseAccountText, 再把
  //   「密码位」按 classifySecret 精确归类为 password / key(Global API Key) / token。
  //   parseAccountText 可注入以便测试; 运行时默认取全局 root.parseAccountText。
  function parsePool(raw, parseAccountText) {
    var out = [];
    raw = String(raw == null ? "" : raw);
    var pfn = parseAccountText || root.parseAccountText;
    if (typeof pfn === "function") {
      var r = pfn(raw) || {};
      (r.accounts || []).forEach(function (a) {
        if (!a || !a.email) return;
        var e = { email: String(a.email).trim() };
        var sec = String(a.password == null ? "" : a.password).trim();
        var kind = classifySecret(sec);
        if (!sec) { /* 只有邮箱·无密码 */ }
        else if (kind === "key") e.key = sec;
        else if (kind === "token") e.token = sec;
        else e.password = sec;
        out.push(e);
      });
      (r.tokens || []).forEach(function (t) {
        t = String(t == null ? "" : t).trim();
        if (/^[A-Za-z0-9_-]{40}$/.test(t)) out.push({ token: t });
      });
    }
    // GitHub 账号 (用户名+密码+TOTP/PAT) —— 与 CF 邮箱账号自动分流·并入同一池
    parseGithubLines(raw).forEach(function (g) { out.push(g); });
    // 池内自去重 (同邮箱/同 token 只保留最后一次·凭证以后者为准)
    var seen = {}, dedup = [];
    out.forEach(function (e) {
      var k = keyOf(e); if (!k) return;
      if (seen[k] != null) { dedup[seen[k]] = mergeEntry(dedup[seen[k]], e); }
      else { seen[k] = dedup.length; dedup.push(e); }
    });
    return dedup;
  }

  // ── 合并两条记录: 新凭证覆盖旧凭证 (非空才覆盖), 已建资源/状态以「有值者」为准保留 ──
  function mergeEntry(a, b) {
    a = a || {}; b = b || {};
    var m = {};
    ["provider", "email", "password", "otp", "key", "token",
     "ghUser", "ghPass", "ghOtp", "ghPat",
     "accountId", "workerUrl", "subdomain", "phase", "step", "msg", "ts"].forEach(function (f) {
      var bv = b[f], av = a[f];
      m[f] = (bv !== undefined && bv !== null && bv !== "") ? bv : av;
    });
    // email 归一保留原大小写显示但按新值优先
    if (!m.email) delete m.email;
    if (!m.provider) delete m.provider;
    return m;
  }

  // ── 把新识别的记录并入现有池 (纯函数): 同键更新凭证 (保留已建资源/状态), 异键新增 ──
  //   返回 { pool, added, updated }。
  function mergePool(existing, incoming) {
    existing = Array.isArray(existing) ? existing.slice() : [];
    incoming = Array.isArray(incoming) ? incoming : [];
    var idx = {};
    existing.forEach(function (e, i) { var k = keyOf(e); if (k) idx[k] = i; });
    var added = 0, updated = 0;
    incoming.forEach(function (e) {
      var k = keyOf(e); if (!k) return;
      if (idx[k] != null) {
        // 只并入凭证, 不清空既有 accountId/workerUrl/状态
        var cur = existing[idx[k]];
        existing[idx[k]] = mergeEntry(cur, {
          provider: e.provider, email: e.email, password: e.password, otp: e.otp,
          key: e.key, token: e.token,
          ghUser: e.ghUser, ghPass: e.ghPass, ghOtp: e.ghOtp, ghPat: e.ghPat
        });
        updated++;
      } else {
        idx[k] = existing.length; existing.push(e); added++;
      }
    });
    return { pool: existing, added: added, updated: updated };
  }

  // ── 该记录可用哪种建法 (纯函数)——决定 tunnel.html 走哪条编排 ──
  //   key   → 纯后端 Global API Key 直建 (零浏览器·零人机验证)
  //   token → 纯后端 API Token 直建
  //   login → 有邮箱+密码 → arm cf-auto 浏览器代登录→同源建Token→部署 (仅登录页过一次人机验证)
  //   none  → 凭证不足
  function buildMethod(e) {
    e = e || {};
    if (e.provider === "github") return (e.ghUser && e.ghPass) ? "github" : "none";
    if (e.key && e.email) return "key";
    if (e.token) return "token";
    if (e.email && e.password) return "login";
    return "none";
  }

  // ── 据 provider 产出 /api/cf-autoprovision 的 body (浏览器编排两法: cloudflare 直登 / github SSO) ──
  //   纯后端 key/token 走 provisionPayload; 此处只管需离屏代登录的两类。返回 null = 无可用编排。
  function autoPayload(e) {
    e = e || {};
    var m = buildMethod(e), body = {};
    if (e.accountId) body.accountId = e.accountId;
    if (m === "github") { body.provider = "github"; body.ghUser = e.ghUser; body.ghPass = e.ghPass || ""; if (e.ghOtp) body.ghOtp = e.ghOtp; return body; }
    if (m === "login") { body.provider = "cloudflare"; body.email = e.email; body.password = e.password || ""; if (e.otp) body.otp = e.otp; return body; }
    return null;
  }

  // ── 该账号「一键打开对应官网」的 URL (纯函数): 两类都进 CF 登录/仪表盘,
  //   GitHub 号在 CF 登录页走 GitHub SSO。永不把密码放进 URL。 ──
  function siteUrl(e) {
    e = e || {};
    if (workerOf(e)) return "https://dash.cloudflare.com/";
    return "https://dash.cloudflare.com/login";
  }

  // ── 账号显示名 (纯函数·UI 用) ──
  function displayName(e) {
    e = e || {};
    if (e.provider === "github") return e.ghUser || "(GitHub)";
    return e.email || "(账号)";
  }

  // ── 据建法产出 /api/cf-provision 的 body (纯后端两法); login/none 返回 null (走浏览器编排) ──
  function provisionPayload(e) {
    var m = buildMethod(e);
    if (m === "key") return { email: e.email, apiKey: e.key };
    if (m === "token") return { token: e.token };
    return null;
  }

  // ── Token/密钥打码 (统管展示·永不明文回显) ──
  function maskSecret(s) {
    s = String(s == null ? "" : s);
    if (!s) return "";
    if (s.length <= 8) return s.slice(0, 2) + "****";
    return s.slice(0, 4) + "…" + s.slice(-4);
  }

  // ── 人类可读状态 (纯函数) ──
  function statusLabel(e) {
    e = e || {};
    var p = e.phase || "idle";
    if (p === "done") return e.healthy === false ? "⚠ 已部署·传播中" : "✅ 已就绪";
    if (p === "error") return "✗ 失败: " + (e.msg || "");
    if (p === "running") return "⏳ " + (e.msg || ("阶段 " + (e.step || "")));
    if (workerOf(e)) return "✅ 已建";
    var m = buildMethod(e);
    if (m === "none") return e.provider === "github" ? "· 凭证不足 (需 GitHub 用户名+密码)" : "· 凭证不足 (需 邮箱+密码)";
    if (m === "github") return "· 待建 (GitHub 登 CF)";
    return "· 待建";
  }

  // ── 该记录已建成的 Worker URL (统管取值) ──
  function workerOf(e) { return (e && e.workerUrl) ? String(e.workerUrl) : ""; }

  // ── 统计池里已建成 Worker 的记录 (纯函数·供「已建资源」区渲染) ──
  function builtResources(pool) {
    return (Array.isArray(pool) ? pool : []).filter(function (e) { return workerOf(e); }).map(function (e) {
      return {
        email: e.email || "", accountId: e.accountId || "", workerUrl: e.workerUrl,
        subdomain: e.subdomain || "", healthy: e.healthy !== false
      };
    });
  }

  CFP.classifySecret = classifySecret;
  CFP.normEmail = normEmail;
  CFP.isEmail = isEmail;
  CFP.isTotpSeed = isTotpSeed;
  CFP.isGhPat = isGhPat;
  CFP.isGhUser = isGhUser;
  CFP.accountType = accountType;
  CFP.parseGithubLines = parseGithubLines;
  CFP.keyOf = keyOf;
  CFP.parsePool = parsePool;
  CFP.mergeEntry = mergeEntry;
  CFP.mergePool = mergePool;
  CFP.buildMethod = buildMethod;
  CFP.provisionPayload = provisionPayload;
  CFP.autoPayload = autoPayload;
  CFP.siteUrl = siteUrl;
  CFP.displayName = displayName;
  CFP.maskSecret = maskSecret;
  CFP.statusLabel = statusLabel;
  CFP.workerOf = workerOf;
  CFP.builtResources = builtResources;

  if (typeof module !== "undefined" && module.exports) module.exports = CFP;
  else root.CFPOOL = CFP;
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
