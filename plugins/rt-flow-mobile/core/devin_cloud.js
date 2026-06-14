// rt-flow-mobile · core/devin_cloud.js — Devin Cloud 浏览器侧底层封装 (零依赖 · fetch)
// ════════════════════════════════════════════════════════════════════════════
// 移植自 plugins/rt-flow/devin_cloud.js 的登录/额度链路, 改用浏览器 fetch。
// 鉴权链路 (与 IDE 版完全一致, 故切号语义等价):
//   ① POST windsurf.com/_devin-auth/password/login {email,password} → {token,user_id}
//      token 即 auth1 (会话登录态)
//   ② POST app.devin.ai/api/users/post-auth (Bearer auth1) → {org_id, org_name}
//   ③ GET  app.devin.ai/api/{org_id}/billing/status (Bearer auth1) → 余额
//   之后 SPA 仅需 localStorage['auth1_session']={token,userId} 即自动登录。
// ════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.RtCloud = api;
  if (typeof globalThis !== "undefined") globalThis.RtCloud = api;
})(this, function () {
  "use strict";

  const CFG = {
    loginUrl: "https://windsurf.com/_devin-auth/password/login",
    apiBase: "https://app.devin.ai/api",
    appOrigin: "https://app.devin.ai",
  };

  // ── 从 billing/status 提取可用余额 (USD) · 移植 billingBalance ──
  //   返回 null = 无法判定 (调用方禁止据此做破坏性自动切号)。
  function billingBalance(billing) {
    if (!billing) return null;
    const b = billing.billing || billing;
    const num = (...keys) => {
      for (const k of keys) {
        const v = b[k];
        if (typeof v === "number" && isFinite(v)) return v;
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

  async function jsonPost(url, headers, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(body || {}),
    });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  }

  async function jsonGet(url, headers) {
    const r = await fetch(url, { method: "GET", headers: headers || {} });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  }

  // ① + ②: email/password → { auth1, userId, orgId, orgName }
  async function login(email, password) {
    const r1 = await jsonPost(CFG.loginUrl, {}, { email, password });
    const j1 = r1.json || {};
    const auth1 = j1.token || j1.auth1_token || j1.access_token;
    if (r1.status !== 200 || !auth1) {
      return { ok: false, error: "login HTTP " + r1.status + " " + (j1.detail || j1.error || "no_token") };
    }
    const userId = j1.user_id || j1.userId || "";
    const r2 = await jsonPost(CFG.apiBase + "/users/post-auth", { Authorization: "Bearer " + auth1 }, {});
    const j2 = r2.json || {};
    const orgId = (j2.org && j2.org.org_id) || j2.org_id || j2.orgId || "";
    const orgName = (j2.org && j2.org.org_name) || j2.org_name || j2.orgName || "";
    if (!orgId) return { ok: false, error: "post-auth no org_id (HTTP " + r2.status + ")" };
    return { ok: true, auth1, userId, orgId, orgName, email };
  }

  // ③: 实时余额 (USD) · null = 无法判定
  async function getBalance(auth) {
    const r = await jsonGet(CFG.apiBase + "/" + auth.orgId + "/billing/status", {
      Authorization: "Bearer " + auth.auth1,
      "x-cog-org-id": auth.orgId,
    });
    if (r.status !== 200 || !r.json) return { ok: false, balance: null };
    return { ok: true, balance: billingBalance(r.json), raw: r.json };
  }

  return { CFG, billingBalance, login, getBalance };
});
