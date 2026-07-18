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

  // ── 池记录去重键: 有邮箱按邮箱, 否则按 token ──
  function keyOf(e) {
    if (!e) return "";
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
    ["email", "password", "key", "token", "accountId", "workerUrl", "subdomain", "phase", "step", "msg", "ts"].forEach(function (f) {
      var bv = b[f], av = a[f];
      m[f] = (bv !== undefined && bv !== null && bv !== "") ? bv : av;
    });
    // email 归一保留原大小写显示但按新值优先
    if (!m.email) delete m.email;
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
          email: e.email, password: e.password, key: e.key, token: e.token
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
    if (e.key && e.email) return "key";
    if (e.token) return "token";
    if (e.email && e.password) return "login";
    return "none";
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
    if (m === "none") return "· 凭证不足 (需 邮箱+密码)";
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
  CFP.keyOf = keyOf;
  CFP.parsePool = parsePool;
  CFP.mergeEntry = mergeEntry;
  CFP.mergePool = mergePool;
  CFP.buildMethod = buildMethod;
  CFP.provisionPayload = provisionPayload;
  CFP.maskSecret = maskSecret;
  CFP.statusLabel = statusLabel;
  CFP.workerOf = workerOf;
  CFP.builtResources = builtResources;

  if (typeof module !== "undefined" && module.exports) module.exports = CFP;
  else root.CFPOOL = CFP;
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
