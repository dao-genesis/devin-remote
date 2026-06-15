"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// iso.js · 多实例隔离垫片 (MAIN world · document_start)
//
// 民至于老死不相往来: 同源 localStorage 在所有 Tab 间共享, 故多账号网页会互相覆盖。
// 本垫片在「已绑定专属账号」的 Tab 里, 把 dao 登录态键的 localStorage 读/写改向
//   sessionStorage —— sessionStorage 按浏览上下文(Tab)天然隔离, 于是各 Tab 各登各号、
//   互不干扰。未绑定的 Tab (sessionStorage 无 __dao_tab_isolated__ 标记) 完全无副作用。
//
// 必须运行在 MAIN world 且 document_start: 赶在 SPA 读取 localStorage 之前改写。
// content.js (ISOLATED) 负责把账号种进 sessionStorage 并打标记; 二者同源共享 storage。
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  try {
    if (sessionStorage.getItem("__dao_tab_isolated__") !== "1") return; // 未绑定 → 不动
  } catch (e) { return; }

  // dao 登录态键: 这些键改走 sessionStorage (本 Tab 私有), 其余键照常走 localStorage
  const DAO_KEY = /^(auth1_session$|migrated-to-unscoped-auth0-token|known-org-ids-|last-internal-org-for-external-org|post-auth-v3-)/;

  const proto = Storage.prototype;
  const ls = window.localStorage;
  const ss = window.sessionStorage;
  const origGet = proto.getItem;
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;

  proto.getItem = function (k) {
    if (this === ls && DAO_KEY.test(k)) return origGet.call(ss, k);
    return origGet.call(this, k);
  };
  proto.setItem = function (k, v) {
    if (this === ls && DAO_KEY.test(k)) return origSet.call(ss, k, v);
    return origSet.call(this, k, v);
  };
  proto.removeItem = function (k) {
    if (this === ls && DAO_KEY.test(k)) return origRemove.call(ss, k);
    return origRemove.call(this, k);
  };
})();
