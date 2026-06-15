"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// content.js · app.devin.ai 自动登录注入 (document_start · ISOLATED world)
//
// 帛书·「观天之道·执天之行」: 经真机抓取确认 Devin SPA 的登录态唯一真源是
//   localStorage['auth1_session'] = {"token":"auth1_...","userId":"user-..."}
// content script 与页面同源 → 共享 localStorage / sessionStorage, 故可在 SPA 读取前种入。
//
// 两种形态:
//   ① 单账号 (全局 active): 种入 localStorage (跨 Tab 共享) — 传统切号。
//   ② 多实例 (本 Tab 绑定专属账号): 种入 sessionStorage (浏览上下文天然按 Tab 隔离),
//      配合 iso.js (MAIN world) 把 dao 登录键的 localStorage 读取改向 sessionStorage,
//      于是一个浏览器内多账号网页并行、互不干扰 (民至于老死不相往来)。
// 鉴权请求头(Authorization/x-cog-org-id)由 background 的 declarativeNetRequest 注入
//   (多实例为 per-tab 规则, 单账号为全局规则)。
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  // 种入登录态到指定 store (localStorage 或 sessionStorage)。返回是否发生变更。
  function injectStorage(a, store) {
    if (!a || !a.auth1) return false;
    store = store || localStorage;
    let cur = null;
    try { cur = JSON.parse(store.getItem("auth1_session") || "null"); } catch {}
    const needSet = !cur || cur.token !== a.auth1;
    try {
      store.setItem("auth1_session", JSON.stringify({ token: a.auth1, userId: a.userId || "" }));
      store.setItem("migrated-to-unscoped-auth0-token-2025-12-18", "true");
      if (a.userId) store.setItem("known-org-ids-" + a.userId, JSON.stringify([a.orgId]));
      if (a.orgId) store.setItem("last-internal-org-for-external-org-v1-null", a.orgId);
      if (a.orgId && a.userId && a.orgName) {
        const pa = "post-auth-v3-null-" + a.userId + "-org_name-" + a.orgName;
        if (!store.getItem(pa)) {
          store.setItem(pa, JSON.stringify({
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

  // 启动: 问 background 「本 Tab 应注入哪个账号」(绑定优先, 否则全局 active)
  function getTabAuth() {
    return new Promise((res) => {
      try { chrome.runtime.sendMessage({ type: "getTabAuth" }, (r) => { void chrome.runtime.lastError; res(r); }); }
      catch (e) { res(null); }
    });
  }

  async function boot() {
    try {
      const info = await getTabAuth();
      if (!info || !info.ok || !info.auth1) return;
      if (info.bound) {
        // 多实例: 本 Tab 绑定专属账号 → 用 sessionStorage 隔离 (互不干扰)
        const payload = JSON.stringify({ t: info.auth1, u: info.userId, o: info.orgId });
        const had = sessionStorage.getItem("__dao_auth_payload__");
        injectStorage(info, sessionStorage);     // 真源: 本 Tab 的 sessionStorage
        injectStorage(info, localStorage);        // 兜底: 首次未隔离时也能登录
        sessionStorage.setItem("__dao_tab_isolated__", "1");
        sessionStorage.setItem("__dao_auth_payload__", payload);
        // 首次绑定 (或换号) → reload, 让 iso.js 在 document_start 把读取改向 sessionStorage
        if (had !== payload) reloadOnce(info.auth1, true);
      } else {
        const changed = injectStorage(info, localStorage);
        if (changed) reloadOnce(info.auth1, false);
      }
    } catch (e) { /* extension context invalidated etc. */ }
  }
  boot();

  // background 切号通知 → 立即重注入并强制刷新 (绑定 Tab 写 sessionStorage, 否则 localStorage)
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg && msg.type === "dao-inject") {
      const isolated = (function () { try { return sessionStorage.getItem("__dao_tab_isolated__") === "1"; } catch (e) { return false; } })();
      if (isolated) {
        injectStorage(msg, sessionStorage);
        try { sessionStorage.setItem("__dao_auth_payload__", JSON.stringify({ t: msg.auth1, u: msg.userId, o: msg.orgId })); } catch (e) {}
      } else {
        injectStorage(msg, localStorage);
      }
      if (msg.reload) reloadOnce(msg.auth1, true);
      send && send({ ok: true });
    }
    return true;
  });

  // 额度耗尽探测 (轻量·只读 DOM 文本): 命中即上报 background (仅通知, 不自动切号)
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
