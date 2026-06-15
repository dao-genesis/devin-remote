"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// content.js · app.devin.ai 自动登录注入 (document_start · ISOLATED world)
//
// 帛书·「观天之道·执天之行」: 经真机抓取确认 Devin SPA 的登录态唯一真源是
//   localStorage['auth1_session'] = {"token":"auth1_...","userId":"user-..."}
// content script 与页面同源 → 共享 localStorage, 故可在 SPA 读取前种入登录态。
// 首次种入若晚于 SPA 启动 → reload 一次 (有 guard 防循环), 第二次加载即已登录。
// 鉴权请求头(Authorization/x-cog-org-id)由 background 的 declarativeNetRequest 注入。
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  function injectStorage(a) {
    if (!a || !a.auth1) return false;
    let cur = null;
    try { cur = JSON.parse(localStorage.getItem("auth1_session") || "null"); } catch {}
    const needSet = !cur || cur.token !== a.auth1;
    try {
      localStorage.setItem("auth1_session", JSON.stringify({ token: a.auth1, userId: a.userId || "" }));
      localStorage.setItem("migrated-to-unscoped-auth0-token-2025-12-18", "true");
      if (a.userId) localStorage.setItem("known-org-ids-" + a.userId, JSON.stringify([a.orgId]));
      if (a.orgId) localStorage.setItem("last-internal-org-for-external-org-v1-null", a.orgId);
      if (a.orgId && a.userId && a.orgName) {
        const pa = "post-auth-v3-null-" + a.userId + "-org_name-" + a.orgName;
        if (!localStorage.getItem(pa)) {
          localStorage.setItem(pa, JSON.stringify({
            externalOrgId: null, userId: a.userId, internalOrgId: a.orgId, orgName: a.orgName,
            result: { resolved_external_org_id: null, org_id: a.orgId, org_name: a.orgName, is_valid_resource: true },
          }));
        }
      }
      document.cookie = "webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax";
    } catch (e) { return false; }
    return needSet;
  }

  function reloadOnce(token, force) {
    const guard = "dao_rtflow_reloaded_" + String(token).slice(-12);
    if (force) { try { sessionStorage.removeItem(guard); } catch {} }
    try {
      if (!sessionStorage.getItem(guard)) {
        sessionStorage.setItem(guard, "1");
        location.reload();
      }
    } catch { location.reload(); }
  }

  // 启动: 从 storage 直接拉激活账号 (content script 可直接访问 chrome.storage)
  async function boot() {
    try {
      const s = await chrome.storage.local.get(["active", "authCache"]);
      if (!s.active) return;
      const a = (s.authCache || {})[s.active];
      if (!a || !a.auth1) return;
      const changed = injectStorage(a);
      if (changed) reloadOnce(a.auth1, false);
    } catch (e) { /* extension context invalidated etc. */ }
  }
  boot();

  // background 切号通知 → 立即重注入并强制刷新
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg && msg.type === "dao-inject") {
      injectStorage(msg);
      if (msg.reload) reloadOnce(msg.auth1, true);
      send && send({ ok: true });
    }
    return true;
  });

  // 额度耗尽探测 (轻量·只读 DOM 文本): 命中即上报 background 触发自动轮转
  function watchExhaustion() {
    let reported = false;
    const rx = /(out of (credits|quota|usage)|usage limit|额度.*(耗尽|不足|用尽)|insufficient credits|no remaining)/i;
    const scan = () => {
      if (reported) return;
      const t = (document.body && document.body.innerText) || "";
      if (rx.test(t)) {
        reported = true;
        try { chrome.runtime.sendMessage({ type: "reportExhausted" }); } catch {}
      }
    };
    try {
      const mo = new MutationObserver(() => scan());
      const start = () => { if (document.body) { mo.observe(document.body, { childList: true, subtree: true, characterData: true }); scan(); } else setTimeout(start, 500); };
      start();
    } catch {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchExhaustion);
  else watchExhaustion();
})();
