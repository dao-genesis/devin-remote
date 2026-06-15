"use strict";
// panel.js · 独立控制台面板 (与 popup.js 同页运行, 复用其 send/toast/$ 等全局)。
//   板 1「切号」由 popup.js 驱动 (DOM 同构); 本文件负责 板2「内网穿透」+ 板3「多实例」
//   + 顶部分板切换。道法自然: 一个面板三合一, 亦可各开独立网页 (chrome-extension://…/panel.html)。

(function () {
  // 复用 popup.js 的全局; 若缺失则降级 (理论上 popup.js 必先加载)
  const Q = (id) => document.getElementById(id);
  const send = (m, t) => (typeof window.send === "function" ? window.send(m, t) : sendFallback(m));
  function sendFallback(m) {
    return new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }); } catch (e) { res(undefined); } });
  }
  const note = (txt, kind) => { if (typeof window.toast === "function") return window.toast(txt, kind); const el = Q("toast"); if (!el) return; el.textContent = txt; el.className = "toast " + (kind || ""); setTimeout(() => el.classList.add("hid"), 2600); };

  // ── 分板切换 ──────────────────────────────────────────────────────────────
  let relayTimer = null;
  function showBoard(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.board === name));
    document.querySelectorAll(".board").forEach((b) => b.classList.toggle("hid", b.id !== "board-" + name));
    if (relayTimer) { clearInterval(relayTimer); relayTimer = null; }
    if (name === "relay") { refreshRelay(); relayTimer = setInterval(refreshRelay, 3000); }
    if (name === "multi") refreshMulti();
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showBoard(t.dataset.board)));

  // ── 板 2 · 内网穿透 ─────────────────────────────────────────────────────────
  async function loadRelayCfg() {
    const r = await send({ type: "relayConfig" });
    if (r && r.ok && r.relay) {
      if (!Q("rlUrl").value) Q("rlUrl").value = r.relay.url || "";
      if (!Q("rlSession").value) Q("rlSession").value = r.relay.session || "";
      if (!Q("rlToken").value) Q("rlToken").value = r.relay.token || "";
    }
  }
  function curlExample(url, session, token) {
    const base = (url || "<relay>").replace(/\/$/, "");
    const t = token ? token : "<DAO_TOKEN>";
    return "curl -X POST " + base + "/relay/" + (session || "<session>") + " \\\n" +
      "  -H 'Authorization: Bearer " + t + "' \\\n" +
      "  -H 'Content-Type: application/json' \\\n" +
      "  -d '{\"path\":\"/api/rpc\",\"method\":\"POST\",\"body\":{\"cmd\":\"runningSessions\"}}'";
  }
  async function refreshRelay() {
    const r = await send({ type: "relayStatus" });
    const box = Q("rlStatus");
    if (r && r.ok && r.status) {
      const s = r.status;
      const on = s.connected ? "🟢 已连接" : (s.stopped ? "⚪ 已停止" : "🟡 连接中/重试");
      box.className = "rl-status " + (s.connected ? "ok" : (s.stopped ? "" : "warn"));
      box.innerHTML = on + (s.session ? " · session <b>" + esc(s.session) + "</b>" : "") +
        (s.lastError ? '<div class="rl-err">最近错误: ' + esc(s.lastError) + "</div>" : "");
      Q("rlPub").innerHTML = s.publicEndpoint ? "公网入口: <code>" + esc(s.publicEndpoint) + "</code>" : "";
    } else { box.className = "rl-status"; box.textContent = "状态未知 (service worker 未响应)"; }
    Q("rlCurl").textContent = curlExample(Q("rlUrl").value, Q("rlSession").value, Q("rlToken").value);
  }
  Q("rlStart").addEventListener("click", async () => {
    const set = { url: Q("rlUrl").value.trim(), session: Q("rlSession").value.trim(), token: Q("rlToken").value.trim() };
    if (!set.url || !set.session || !set.token) { note("请填写 中继地址 / 会话 ID / Token", "err"); return; }
    const r = await send({ type: "relayStart", set });
    note(r && r.ok ? "穿透已启动 (出站连中继)" : "启动失败: " + ((r && r.error) || ""), r && r.ok ? "ok" : "err");
    refreshRelay();
  });
  Q("rlStop").addEventListener("click", async () => { await send({ type: "relayStop" }); note("穿透已停止", "ok"); refreshRelay(); });
  Q("rlRefresh").addEventListener("click", refreshRelay);
  ["rlUrl", "rlSession", "rlToken"].forEach((id) => Q(id).addEventListener("input", () => { Q("rlCurl").textContent = curlExample(Q("rlUrl").value, Q("rlSession").value, Q("rlToken").value); }));
  Q("rlCopyCurl").addEventListener("click", async () => { try { await navigator.clipboard.writeText(Q("rlCurl").textContent); note("已复制 curl", "ok"); } catch (e) { note("复制失败", "err"); } });

  // ── 板 3 · 多实例 ───────────────────────────────────────────────────────────
  async function refreshMulti() {
    const st = await send({ type: "getState" });
    const wrap = Q("miAccounts"); wrap.innerHTML = "";
    const accounts = (st && st.accounts) || [];
    const authCache = (st && st.authCache) || {};
    accounts.forEach((a, i) => {
      const key = String(a.email).toLowerCase();
      const loggedIn = authCache[key] && authCache[key].auth1;
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        '<div class="row-main"><span class="acc-no">' + (i + 1) + "</span>" +
        '<span class="em">' + esc(a.email) + "</span>" +
        '<span class="login-tag ' + (loggedIn ? "" : "no") + '">' + (loggedIn ? "已登录" : "未登录") + "</span>" +
        '<span class="acts"><button class="b sw" data-act="opentab" data-email="' + escAttr(a.email) + '" title="新标签打开此账号 (多实例)">⧉ 新标签打开</button></span></div>';
      wrap.appendChild(row);
    });
    // opentab 由 popup.js 的全局 click 委托处理 (data-act=opentab); 这里只负责刷新列表
    const r = await send({ type: "listTabs" });
    const tabs = (r && r.tabs) || [];
    const list = Q("miTabs"); list.innerHTML = "";
    Q("miTabsEmpty").classList.toggle("hid", tabs.length > 0);
    tabs.forEach((t) => {
      const li = document.createElement("li");
      li.className = "sess";
      li.innerHTML = '<span class="dot run"></span><span class="stitle">' + esc(t.email) + '</span><span class="sstat">tab#' + t.tabId + "</span>" +
        '<button class="sstop" data-close-tab="' + t.tabId + '" title="关闭此账号网页">✕</button>';
      list.appendChild(li);
    });
  }
  document.addEventListener("click", async (e) => {
    const close = e.target.closest("button[data-close-tab]");
    if (close) { await send({ type: "closeAccountTab", tabId: Number(close.dataset.closeTab) }); note("已关闭", "ok"); refreshMulti(); return; }
    // opentab 在多实例板点击后, 顺手刷新该板列表 (popup.js 已发 openAccountTab)
    const ot = e.target.closest('button[data-act="opentab"]');
    if (ot && !document.getElementById("board-multi").classList.contains("hid")) { setTimeout(refreshMulti, 600); }
  });
  Q("miRefresh").addEventListener("click", refreshMulti);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  loadRelayCfg();
})();
