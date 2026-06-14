// rt-flow-mobile · content.js — 帛书·五十二「见小曰明·守柔曰强」
// ════════════════════════════════════════════════════════════════════════════
// 在 app.devin.ai 页面 document_start 注入当前账号登录态。
// 经真机抓取确认 (见 dao-vsix extension.ts:5766): Devin SPA 的登录态唯一真源是
// localStorage['auth1_session'] = {token, userId}; 据此自动登录, 否则跳 /auth/login。
// 内容脚本与页面同源, window.localStorage 即页面 localStorage → 直接写入即生效。
// 切号 = background 更新 active 后重载本标签页 → 此脚本以新 auth1 重注入 → 换号。
// ════════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";
  const KEY = "rtflow.active";

  function injectAuth(active) {
    if (!active || !active.auth1) return false;
    try {
      const a1 = active.auth1;
      const uid = active.userId || "";
      const org = active.orgId || "";
      const orgName = active.orgName || "";
      // 1. 登录态真源
      localStorage.setItem("auth1_session", JSON.stringify({ token: a1, userId: uid }));
      localStorage.setItem("migrated-to-unscoped-auth0-token-2025-12-18", "true");
      if (uid && org) localStorage.setItem("known-org-ids-" + uid, JSON.stringify([org]));
      if (org) localStorage.setItem("last-internal-org-for-external-org-v1-null", org);
      // 2. post-auth 守卫键 — 缺失会致深层 /settings 路由反复跳登录
      if (org && uid && orgName) {
        const paKey = "post-auth-v3-null-" + uid + "-org_name-" + orgName;
        if (!localStorage.getItem(paKey)) {
          localStorage.setItem(
            paKey,
            JSON.stringify({
              externalOrgId: null,
              userId: uid,
              internalOrgId: org,
              orgName: orgName,
              result: { resolved_external_org_id: null, org_id: org, org_name: orgName, is_valid_resource: true },
            }),
          );
        }
      }
      // 3. cookie 标记 — SPA 检查 webapp_logged_in 决定是否显示登录页
      document.cookie = "webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax";
      // 4. 记录当前已注入的 email, 供切号后判定是否需要重载
      localStorage.setItem("rtflow.injected-email", active.email || "");
      return true;
    } catch (e) {
      return false;
    }
  }

  function applied(active) {
    try {
      const cur = JSON.parse(localStorage.getItem("auth1_session") || "{}");
      return cur && cur.token === (active && active.auth1);
    } catch {
      return false;
    }
  }

  // document_start: 尽早注入, 抢在 SPA 读取 localStorage 之前
  chrome.storage.local.get([KEY], (res) => {
    const active = res && res[KEY];
    if (!active || !active.auth1) return;
    injectAuth(active);
    // 若 SPA 已在我们注入前跳到 /auth/login, 而我们持有有效 token → 重载一次回正轨
    const onReady = () => {
      if (location.pathname.startsWith("/auth/login") && applied(active)) {
        location.replace("/");
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
    } else {
      onReady();
    }
  });

  // background 切号后广播 → 立即以新账号重注入 + 重载
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "rtflow:switched" && msg.active) {
      injectAuth(msg.active);
      location.replace("/");
    }
  });
})();
