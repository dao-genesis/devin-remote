"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// devin-core.js · 手机版 Devin Cloud 核心 (引擎页 + 切号页共用同一份)
//   严格复刻桌面 core/dao-vsix/src/extension.ts 的 devinLogin / devinFetchQuota 等。
//   所有 HTTP 经原生桥 Native.httpReq (绕 CORS, 可设 Origin/Referer) → window.__httpCb 回灌。
//   账号存储用 localStorage(两 WebView 同源共享) → 引擎与切号页见同一份账号。
//   业务逻辑全在 JS → 可隔隧道热修。道法自然, 无为而无不为。
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  var N = root.Native || {};

  // ── 原生 HTTP 桥 (Promise 封装) ──────────────────────────────────────────
  var __seq = 0, __cbs = Object.create(null);
  root.__httpCb = function (id, res) { var cb = __cbs[id]; if (cb) { delete __cbs[id]; cb(res); } };

  // ── 出站并发调度器 (道法自然·彻底解决多账号并发+自动备份卡顿) ──────────────
  //   两条独立通道, 各自限流并按优先级排队:
  //     · 文本通道  (登录/额度/会话列表/状态轮询/远程RPC) — 高优先, 并发上限较大;
  //     · 二进制通道 (备份下载 ZIP/产出文件)            — 低优先, 并发上限小;
  //   高优先请求永远排在低优先(后台备份)之前出队 → 备份再多也不卡交互。
  //   配合原生 HttpBridge 的双线程池 (INTERACTIVE / BULK), 双层隔离, 卡顿根除。
  function _mkGate(max) {
    var active = 0, hi = [], lo = [];
    function pump() {
      while (active < max && (hi.length || lo.length)) {
        var t = hi.length ? hi.shift() : lo.shift();
        active++;
        Promise.resolve().then(t.fn).then(function (v) { t.res(v); }, function (e) { t.res({ status: 0, error: String(e) }); })
          .then(function () { active--; pump(); });
      }
    }
    return function (fn, low) {
      return new Promise(function (res) { (low ? lo : hi).push({ fn: fn, res: res }); pump(); });
    };
  }
  var _txtGate = _mkGate(6);   // 文本: 6 路并发 (pollTrk 6 路 + 额度/登录排队), 平滑突发
  var _binGate = _mkGate(2);   // 二进制下载: 2 路 (与原生 BULK 池对齐), 备份不抢网络

  function _rawHttpReq(method, url, headers, body) {
    return new Promise(function (resolve) {
      if (!N.httpReq) { resolve({ status: 0, error: "no native httpReq" }); return; }
      var id = "h" + (++__seq) + "_" + Date.now();
      var done = false;
      __cbs[id] = function (res) { if (done) return; done = true; resolve(res || { status: 0, error: "empty" }); };
      var b = (body == null) ? "" : (typeof body === "string" ? body : JSON.stringify(body));
      try { N.httpReq(id, method || "GET", url, JSON.stringify(headers || {}), b); }
      catch (e) { delete __cbs[id]; resolve({ status: 0, error: String(e) }); return; }
      setTimeout(function () { if (__cbs[id]) { delete __cbs[id]; if (!done) { done = true; resolve({ status: 0, error: "timeout" }); } } }, 40000);
    });
  }
  // method 可选第 5 参 low=true → 低优先 (供后台备份/导出的文本读取让路给交互请求)。
  function httpReq(method, url, headers, body, low) {
    return _txtGate(function () { return _rawHttpReq(method, url, headers, body); }, !!low);
  }
  function _rawHttpReqB64(method, url, headers, body) {
    return new Promise(function (resolve) {
      if (!N.httpReqB64) { resolve({ status: 0, error: "no native httpReqB64" }); return; }
      var id = "b" + (++__seq) + "_" + Date.now();
      var done = false;
      __cbs[id] = function (res) { if (done) return; done = true; resolve(res || { status: 0, error: "empty" }); };
      var b = (body == null) ? "" : (typeof body === "string" ? body : JSON.stringify(body));
      try { N.httpReqB64(id, method || "GET", url, JSON.stringify(headers || {}), b); }
      catch (e) { delete __cbs[id]; resolve({ status: 0, error: String(e) }); return; }
      setTimeout(function () { if (__cbs[id]) { delete __cbs[id]; if (!done) { done = true; resolve({ status: 0, error: "timeout" }); } } }, 90000);
    });
  }
  // 二进制 HTTP (响应体 base64) → {status, b64, size} · 供下载会话产出文件 (二进制无损)。始终走低优先二进制通道。
  function httpReqB64(method, url, headers, body) {
    return _binGate(function () { return _rawHttpReqB64(method, url, headers, body); }, true);
  }
  function _parse(res) {
    var j = null; try { j = JSON.parse(res && res.text != null ? res.text : ""); } catch (e) {}
    return { status: (res && res.status) || 0, json: j, text: (res && res.text) || "", error: res && res.error };
  }
  async function devinJsonPost(url, headers, body, low) {
    var h = Object.assign({ "Content-Type": "application/json" }, headers || {});
    return _parse(await httpReq("POST", url, h, JSON.stringify(body || {}), low));
  }
  async function devinJsonGet(url, headers, low) {
    return _parse(await httpReq("GET", url, headers || {}, "", low));
  }

  // ── 端点常量 (与桌面同源) ─────────────────────────────────────────────────
  var WINDSURF = "https://windsurf.com";
  var APP = "https://app.devin.ai";
  var URL_LOGIN = WINDSURF + "/_devin-auth/password/login";
  var URL_POSTAUTH = WINDSURF + "/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth";
  var URL_DEVIN_POST_AUTH = APP + "/api/users/post-auth";
  var URL_REGISTER = "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser";
  var URL_GET_USER_STATUS = [
    "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    "https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    "https://windsurf.com/_route/api_server/exa.seat_management_pb.SeatManagementService/GetUserStatus",
  ];

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16);
    });
  }

  // ── 登录链 (5步, 复刻 devinLogin) ─────────────────────────────────────────
  // email+password → auth1 → sessionToken → orgId/orgName → apiKey → quota
  async function devinLogin(email, password, retry) {
    retry = retry || 0;
    if (!email || !password) return { ok: false, error: "email and password required" };
    // Step1: windsurf 密码登录 → auth1
    var r1 = await devinJsonPost(URL_LOGIN, { Origin: WINDSURF, Referer: WINDSURF + "/account/login" }, { email: email, password: password });
    if (r1.status === 429 && retry < 3) { await new Promise(function (k) { setTimeout(k, Math.pow(2, retry) * 2000); }); return devinLogin(email, password, retry + 1); }
    var j1 = r1.json || {};
    if (r1.status !== 200 || (!j1.token && !j1.auth1_token)) {
      return { ok: false, error: "登录失败: " + (j1.detail || j1.error || j1.message || (r1.error || ("HTTP " + r1.status))) };
    }
    var auth1 = j1.token || j1.auth1_token;
    var userId = j1.user_id || "";

    // Step2: PostAuth → sessionToken (+accountId)
    var r2 = await devinJsonPost(URL_POSTAUTH, { Origin: WINDSURF, Referer: WINDSURF + "/profile", "Connect-Protocol-Version": "1", "X-Devin-Auth1-Token": auth1 }, { auth1_token: auth1 });
    var j2 = r2.json || {};
    var sessionToken = j2.sessionToken || j2.session_token || "";
    if (r2.status !== 200 || !sessionToken) return { ok: false, error: "PostAuth 失败: " + (j2.error || j2.code || j2.message || "no_session") };

    // Step3: Devin post-auth → orgId/orgName/orgSlug
    var r3 = await devinJsonPost(URL_DEVIN_POST_AUTH, { Authorization: "Bearer " + auth1 }, {});
    var j3 = r3.json || {};
    var org = j3.org || {};
    var orgId = org.org_id || j3.org_id || j3.orgId || "";
    var orgName = org.org_name || j3.org_name || j3.orgName || "";
    var orgSlug = org.org_slug || j3.org_slug || j3.orgSlug || "";
    if (!orgId && org && typeof org === "object") { for (var k in org) { if (/org.?id/i.test(k)) { orgId = String(org[k]); break; } } }
    if (!orgId) return { ok: false, error: "Devin PostAuth: 无 orgId" };

    // Step4: RegisterUser → apiKey/apiServerUrl
    var r4 = await devinJsonPost(URL_REGISTER, { "Connect-Protocol-Version": "1" }, { firebase_id_token: sessionToken });
    var j4 = r4.json || {};
    var apiKey = j4.api_key || j4.apiKey || sessionToken;
    var apiServerUrl = j4.api_server_url || j4.apiServerUrl || "";
    var windsurfKey = (apiKey && apiKey.indexOf("cog_") !== 0) ? apiKey : "";

    // Step5: 额度 (非阻断)
    var quota = null;
    try { quota = await devinFetchQuota(apiKey, windsurfKey, auth1, orgId, apiServerUrl); } catch (e) {}

    return { ok: true, auth1: auth1, userId: userId, orgId: orgId, orgName: orgName, orgSlug: orgSlug,
      sessionToken: sessionToken, apiKey: apiKey, windsurfKey: windsurfKey, apiServerUrl: apiServerUrl,
      accountId: j2.accountId || "", quota: quota };
  }

  // ── 额度 (复刻 devinFetchQuota + devinParsePlanStatus + overage) ───────────
  async function devinFetchQuota(apiKey, windsurfKey, auth1, orgId, apiServerUrl) {
    var statusKey = (apiKey && apiKey.indexOf("cog_") !== 0) ? apiKey : (windsurfKey || "");
    if (statusKey) {
      var tries = [];
      if (apiServerUrl) tries.push(apiServerUrl.replace(/\/+$/, "") + "/exa.seat_management_pb.SeatManagementService/GetUserStatus");
      URL_GET_USER_STATUS.forEach(function (u) { if (tries.indexOf(u) < 0) tries.push(u); });
      var metadata = { ideName: "windsurf", ideVersion: "1.99.0", extensionName: "windsurf", extensionVersion: "1.99.0", apiKey: statusKey, sessionId: uuid(), requestId: "1", locale: "en", os: "windows" };
      for (var i = 0; i < tries.length; i++) {
        try {
          var r = await devinJsonPost(tries[i], { "Connect-Protocol-Version": "1", "X-Api-Key": statusKey }, { metadata: metadata });
          if (r.status >= 200 && r.status < 300 && r.json) {
            var ps = parsePlanStatus(r.json);
            var od = await fetchOverageDollars(auth1, orgId);
            if (od != null) ps.overageDollars = od;
            return ps;
          }
          if (r.status === 401 || r.status === 400) break;
        } catch (e) {}
      }
    }
    // Fallback: Devin billing
    if (auth1 && orgId) {
      try {
        var bare = orgId.replace(/^org-/, "");
        var br = await devinJsonGet(APP + "/api/org-" + bare + "/billing/status", { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId });
        if (br.status === 200 && br.json) {
          var d = billingDollars(br.json);
          var has = br.json.has_subscription_or_credits === true || br.json.is_subscription_valid === true || d > 0;
          return { planName: "Trial", dPct: has ? 100 : 0, wPct: has ? 100 : 0, overageActive: d > 0, overageDollars: d, _source: "devin_billing" };
        }
      } catch (e) {}
    }
    return null;
  }

  // 美金额度 (复刻桌面 billingBalance · devin_cloud.js): 可用余额 = available_credits + max(0, overage_credits)
  //   overage_credits 正值=可用 Extra Usage 余额; 负值=已欠/耗尽(计 0)。
  function billingDollars(b) {
    if (!b) return 0;
    var avail = (typeof b.available_credits === "number" && isFinite(b.available_credits)) ? b.available_credits : 0;
    var ovg = (typeof b.overage_credits === "number" && isFinite(b.overage_credits)) ? b.overage_credits : 0;
    var d = Math.max(0, avail) + Math.max(0, ovg);
    return Math.min(1000, Math.round(d * 100) / 100);
  }

  function parsePlanStatus(j) {
    var us = j.userStatus || j.user_status || {};
    var ps = us.planStatus || us.plan_status || j.planStatus || j.plan_status || j;
    var pi = ps.planInfo || ps.plan_info || us.planInfo || us.plan_info || {};
    function gi(d) { for (var i = 1; i < arguments.length; i++) { var v = d && d[arguments[i]]; if (v != null) { var n = parseInt(v, 10); if (!isNaN(n)) return n; } } return 0; }
    function gs(d) { for (var i = 1; i < arguments.length; i++) { var v = d && d[arguments[i]]; if (v != null) return String(v); } return ""; }
    var weekly = gi(ps, "weeklyQuotaRemainingPercent", "weekly_quota_remaining_percent");
    var daily = gi(ps, "dailyQuotaRemainingPercent", "daily_quota_remaining_percent");
    if (!ps.dailyQuotaRemainingPercent && !ps.daily_quota_remaining_percent && weekly > 0) daily = weekly;
    return {
      planName: gs(pi, "planName", "plan_name"), teamsTier: gs(pi, "teamsTier", "teams_tier"),
      planStart: gs(ps, "planStart", "plan_start"), planEnd: gs(ps, "planEnd", "plan_end"),
      wPct: weekly, dPct: daily,
      availablePromptCredits: gi(ps, "availablePromptCredits", "available_prompt_credits"),
      availableFlowCredits: gi(ps, "availableFlowCredits", "available_flow_credits"),
      _source: "GetUserStatus"
    };
  }

  async function fetchOverageDollars(auth1, orgId) {
    if (!auth1 || !orgId) return null;
    try {
      var bare = orgId.replace(/^org-/, "");
      var br = await devinJsonGet(APP + "/api/org-" + bare + "/billing/status", { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId });
      if (br.status === 200 && br.json) return billingDollars(br.json);
    } catch (e) {}
    return null;
  }

  // ── 账号存储 (localStorage, 两 WebView 同源共享) ──────────────────────────
  function loadAcc() { try { return JSON.parse(localStorage.getItem("rtflow.accounts") || "[]"); } catch (e) { return []; } }
  function saveAcc(a) {
    var s = JSON.stringify(a || []);
    localStorage.setItem("rtflow.accounts", s);
    // 镜像到共享保险箱(Documents/DevinCloud) → 中继远程改账(登录/加号)也卸载不丢
    try { var N = (typeof window !== "undefined" && window.Native) || {}; if (a && a.length && N.vaultSave) N.vaultSave("accounts", s); } catch (e) {}
  }
  // 引擎冷启: 本地账号为空但保险箱有 → 回读 (与 switch.html 同策略, 远程/UI 任一路径都能恢复)
  function restoreAccFromVault() {
    try {
      var N = (typeof window !== "undefined" && window.Native) || {};
      if (!N.vaultLoad) return;
      var cur = loadAcc(); if (cur.length) return;
      var raw = N.vaultLoad("accounts"); if (!raw) return;
      var arr = JSON.parse(raw); if (arr && arr.length) localStorage.setItem("rtflow.accounts", raw);
    } catch (e) {}
  }
  try { restoreAccFromVault(); } catch (e) {}
  function getActive() { return localStorage.getItem("rtflow.active") || ""; }
  function setActive(id) { localStorage.setItem("rtflow.active", id || ""); }
  function findAcc(id) { var a = loadAcc(); for (var i = 0; i < a.length; i++) if (a[i].id === id || a[i].email === id) return a[i]; return null; }
  function upsertAcc(acc) {
    var accs = loadAcc();
    acc.id = acc.id || acc.email || ("acc" + Date.now());
    var i = accs.findIndex(function (x) { return x.id === acc.id || (acc.email && x.email === acc.email); });
    if (i >= 0) accs[i] = Object.assign({}, accs[i], acc); else accs.push(acc);
    saveAcc(accs); return acc;
  }

  // 登录并把结果落到账号 (合并保存) — 返回更新后的账号
  async function loginAndStore(email, password) {
    var r = await devinLogin(email, password);
    if (!r.ok) { var bad = findAcc(email) || {}; bad.email = email; bad.password = password; bad.lastError = r.error; upsertAcc(bad); return r; }
    var acc = {
      id: email, email: email, password: password,
      auth1: r.auth1, userId: r.userId, orgId: r.orgId, orgName: r.orgName, orgSlug: r.orgSlug,
      sessionToken: r.sessionToken, apiKey: r.apiKey, windsurfKey: r.windsurfKey, apiServerUrl: r.apiServerUrl,
      accountId: r.accountId, quota: r.quota, plan: (r.quota && r.quota.planName) || "", lastError: "", verifiedAt: Date.now()
    };
    upsertAcc(acc);
    return Object.assign({ ok: true }, r, { account: acc });
  }

  // 校验 auth1 是否仍有效 (额度/billing 接口对死令牌回 401「No organizations found for auth1 user」)。
  async function auth1Alive(acc) {
    if (!acc || !acc.auth1 || !acc.orgId) return false;
    try {
      var bare = acc.orgId.replace(/^org-/, "");
      var br = await devinJsonGet(APP + "/api/org-" + bare + "/billing/status", { Authorization: "Bearer " + acc.auth1, "x-cog-org-id": acc.orgId });
      return br.status === 200;
    } catch (e) { return false; }
  }

  // 刷新单号额度 (用已存的 key) — 写回账号。
  //   自愈: 先用现有 auth1 取额度; 取不到(令牌过期回 401/null) 且存有邮箱密码 → 自动重登换新 auth1 再取。
  //   这样「额度刷新」不再因令牌过期而僵死, 后台心跳每轮都会让死号自己活过来 —— 无为而无不为。
  //   健康路径(令牌有效)只发一次额度请求, 不额外探活, 无性能损耗。
  async function refreshQuotaFor(id) {
    var acc = findAcc(id);
    if (!acc) return { ok: false, error: "无此账号" };
    var q = null;
    if (acc.auth1) { try { q = await devinFetchQuota(acc.apiKey, acc.windsurfKey, acc.auth1, acc.orgId, acc.apiServerUrl); } catch (e) {} }
    if (!q && acc.email && acc.password) {
      var lr = await loginAndStore(acc.email, acc.password);
      if (lr.ok) { acc = findAcc(id) || acc; return { ok: !!(acc.quota), quota: acc.quota, relogin: true }; }
      return { ok: false, error: "auth1 过期且重登失败: " + (lr.error || ""), relogin: true };
    }
    if (!q && !acc.auth1) return { ok: false, error: "无 auth1, 需先登录" };
    if (q) { acc.quota = q; acc.plan = q.planName || acc.plan; upsertAcc(acc); }
    return { ok: !!q, quota: q || acc.quota };
  }

  // 刷新全部账号额度 (自愈式): 逐号 refreshQuotaFor (死令牌自动重登)。串行让路给交互, 失败不阻断后续。
  async function refreshAllQuota(force) {
    var accs = loadAcc(), ok = 0, relogin = 0, fail = 0;
    for (var i = 0; i < accs.length; i++) {
      var a = accs[i]; if (!a || (!a.auth1 && !(a.email && a.password))) continue;
      try { var r = await refreshQuotaFor(a.id || a.email); if (r.ok) ok++; else fail++; if (r.relogin) relogin++; }
      catch (e) { fail++; }
    }
    return { ok: true, refreshed: ok, relogin: relogin, fail: fail, count: accs.length };
  }

  root.DaoCore = {
    httpReq: httpReq, httpReqB64: httpReqB64, devinJsonPost: devinJsonPost, devinJsonGet: devinJsonGet,
    devinLogin: devinLogin, devinFetchQuota: devinFetchQuota,
    loadAcc: loadAcc, saveAcc: saveAcc, getActive: getActive, setActive: setActive, findAcc: findAcc, upsertAcc: upsertAcc,
    loginAndStore: loginAndStore, refreshQuotaFor: refreshQuotaFor, refreshAllQuota: refreshAllQuota, auth1Alive: auth1Alive,
    APP: APP, WINDSURF: WINDSURF
  };
})(window);
