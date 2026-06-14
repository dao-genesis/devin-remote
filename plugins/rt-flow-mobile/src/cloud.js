"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// cloud.js · rt-flow 浏览器版 · Devin Cloud 接入底层 (无 vscode / 无 node 依赖)
//
// 帛书·「执天之行」: 把 rt-flow/devin_cloud.js 的登录链路与额度判定移植到
// 浏览器 service worker 环境 —— 纯 fetch, 可在 Chrome / Kiwi(Android) / Edge 运行。
//
//   email + password
//     → POST windsurf.com/_devin-auth/password/login        ⇒ token (= auth1)
//     → POST app.devin.ai/api/users/post-auth (Bearer auth1) ⇒ org_id / user_id
//   之后所有官网请求带 Authorization: Bearer auth1 + x-cog-org-id: orgId
//   额度: GET app.devin.ai/api/{orgId}/billing/status ⇒ available/overage credits
// ═══════════════════════════════════════════════════════════════════════════

const DaoCloud = (() => {
  const CFG = {
    loginUrl: "https://windsurf.com/_devin-auth/password/login",
    apiBase: "https://app.devin.ai/api",
    authTtlMs: 12 * 60 * 60 * 1000, // 登录态缓存 12h (软耗尽前复用)
    reqTimeoutMs: 30000,
  };

  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms || CFG.reqTimeoutMs);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }

  async function jsonRequest(method, url, headers, body, timeoutMs) {
    const to = withTimeout(timeoutMs);
    try {
      const opts = {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
        signal: to.signal,
      };
      if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
      const resp = await fetch(url, opts);
      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
      return { status: resp.status, json, text };
    } catch (e) {
      return { status: 0, json: null, text: String((e && e.message) || e), error: true };
    } finally {
      to.done();
    }
  }

  // 弱者道之用·反复至成: 瞬态网络错误自动重试 (指数退避)
  async function jsonRequestRetry(method, url, headers, body, timeoutMs, retries) {
    let last = null;
    const n = retries == null ? 2 : retries;
    for (let i = 0; i <= n; i++) {
      last = await jsonRequest(method, url, headers, body, timeoutMs);
      if (last.status !== 0 && last.status !== 429) return last;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
    }
    return last;
  }

  // auth1 是 JWT; userId(user-XXX) 可由 payload.sub/user_id 解出 (post-auth 不一定回传)
  function decodeJwtUserId(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return "";
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64 + "===".slice((b64.length + 3) % 4);
      const json = JSON.parse(decodeURIComponent(escape(atob(pad))));
      const cand = json.user_id || json.userId || json.sub || "";
      return /^user-/.test(cand) ? cand : (cand ? "user-" + String(cand).replace(/^user-/, "") : "");
    } catch { return ""; }
  }

  function authHeaders(auth) {
    return { Authorization: "Bearer " + auth.auth1, "x-cog-org-id": auth.orgId };
  }

  // email+password → auth1 + orgId + userId (五步登录的两步底层换取)
  async function login(email, password) {
    const resp = await jsonRequestRetry("POST", CFG.loginUrl, {}, { email, password });
    if (resp.status !== 200 || !resp.json) {
      return { ok: false, error: "login HTTP " + resp.status + ": " + (resp.text || "").slice(0, 160) };
    }
    const auth1 = resp.json.token || resp.json.access_token;
    if (!auth1) return { ok: false, error: "登录响应无 token" };
    const orgResp = await jsonRequestRetry(
      "POST", CFG.apiBase + "/users/post-auth", { Authorization: "Bearer " + auth1 }, {},
    );
    const od = orgResp.json || {};
    const orgId = od.org_id || od.orgId || "";
    if (!orgId) return { ok: false, error: "post-auth 无 org_id (HTTP " + orgResp.status + ")" };
    const userId = od.user_id || od.userId || decodeJwtUserId(auth1) || "";
    return {
      ok: true,
      auth1, orgId, userId,
      orgBare: orgId.replace(/^org-/, ""),
      orgName: od.org_name || od.orgName || "",
      email,
      ts: Date.now(),
    };
  }

  // 额度: app.devin.ai/api/{orgId}/billing/status
  // balance = available_credits + max(0, overage_credits); 含权威布尔判定
  async function getBilling(auth) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/" + auth.orgId + "/billing/status", authHeaders(auth));
    if (r.status !== 200) return { ok: false, status: r.status, raw: null };
    return { ok: true, raw: r.json || {} };
  }

  function billingBalance(billing) {
    if (!billing) return null;
    const b = billing;
    const num = (...keys) => {
      for (const k of keys) {
        const v = b[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return null;
    };
    const avail = num("available_credits", "availableCredits");
    const overage = num("overage_credits", "overageCredits");
    const dollars = (avail || 0) + Math.max(0, overage || 0);
    if (b.has_subscription_or_credits === true || b.is_subscription_valid === true) {
      return dollars > 0 ? dollars : 9999;
    }
    if (b.has_subscription_or_credits === false) return dollars;
    if (avail !== null || overage !== null) return dollars;
    return null;
  }

  // 轻量校验 auth 是否仍有效 (post-auth 200 即视为可用)
  async function verify(auth) {
    const r = await jsonRequestRetry("POST", CFG.apiBase + "/users/post-auth", { Authorization: "Bearer " + auth.auth1 }, {});
    return r.status === 200;
  }

  return { CFG, login, getBilling, billingBalance, authHeaders, verify, decodeJwtUserId };
})();

// service worker (importScripts) 与 popup(module-less) 两种加载方式都可取用
if (typeof self !== "undefined") self.DaoCloud = DaoCloud;
if (typeof globalThis !== "undefined") globalThis.DaoCloud = DaoCloud;
