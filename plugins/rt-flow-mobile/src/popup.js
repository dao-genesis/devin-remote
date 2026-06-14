"use strict";
// popup.js · rt-flow 浏览器版 · 控制面板 UI
const $ = (id) => document.getElementById(id);

// send: 给 service worker 下发动作 (登录/激活/切号等)。
// MV3 冷启时首条消息的回调可能不触发, 故加超时重试 — SW 唤醒后即返回,
// 仍无响应则降级为错误对象, 不让 UI 卡死。
function sendOnce(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (done) return;
        done = true; clearTimeout(t);
        void chrome.runtime.lastError; // SW 未醒时避免未捕获告警
        resolve(r);
      });
    } catch { if (!done) { done = true; clearTimeout(t); resolve(undefined); } }
  });
}
async function send(msg, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await sendOnce(msg, 1500);
    if (r !== undefined) return r;
    await new Promise((s) => setTimeout(s, 150));
  }
  return { ok: false, error: "service worker 未响应(冷启超时)" };
}
function toast(text, kind) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast " + (kind || "");
  setTimeout(() => el.classList.add("hid"), 2600);
}
function balClass(b) {
  if (b == null) return "";
  if (b <= 1) return "zero";
  if (b <= 5) return "low";
  return "good";
}
function fmtBal(q) {
  if (!q) return "额度未查";
  if (q.status && q.status !== "ok") return "查询失败(" + q.status + ")";
  if (q.balance == null) return "额度未知";
  return "$" + q.balance;
}

let STATE = { accounts: [], authCache: {}, active: "", quota: {}, settings: {} };

// 与 background.js DEFAULT_SETTINGS 对齐 (storage-first 渲染时兜底)
const POPUP_DEFAULT_SETTINGS = { autoSwitch: true, buffer: 3, floor: 1, pollMin: 2 };
function getLocal(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }

// 渲染直读 chrome.storage (母/真源), 不依赖 service worker 是否唤醒,
// 从根上杜绝 MV3 冷启竞态导致面板卡死不渲染。
async function load() {
  const s = await getLocal(["accounts", "authCache", "active", "quota", "settings"]);
  STATE = {
    accounts: s.accounts || [],
    authCache: s.authCache || {},
    active: s.active || "",
    quota: s.quota || {},
    settings: Object.assign({}, POPUP_DEFAULT_SETTINGS, s.settings || {}),
  };
  render();
}

// 后台 rotate/额度刷新写入 storage 时, 面板自动跟随 (storage 即真源)。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") load();
});

function render() {
  const { accounts, authCache, active, quota, settings } = STATE;
  // active line
  const al = $("activeLine");
  if (active) { al.textContent = "激活: " + active; al.classList.add("on"); }
  else { al.textContent = "未激活账号"; al.classList.remove("on"); }
  // settings
  $("autoSwitch").checked = !!settings.autoSwitch;
  $("buffer").value = settings.buffer != null ? settings.buffer : 3;
  $("pollMin").value = settings.pollMin != null ? settings.pollMin : 2;
  // list
  const ul = $("accountList");
  ul.innerHTML = "";
  $("empty").classList.toggle("hid", accounts.length > 0);
  for (const a of accounts) {
    const key = a.email.toLowerCase();
    const isActive = key === active;
    const q = quota[key];
    const li = document.createElement("li");
    li.className = "acct" + (isActive ? " active" : "");
    li.innerHTML = `
      <div class="top">
        <span class="name">${escapeHtml(a.email)}</span>
        ${isActive ? '<span class="badge">激活中</span>' : ""}
      </div>
      ${a.label ? `<div class="label">${escapeHtml(a.label)}</div>` : ""}
      <div class="meta">
        <span class="bal ${balClass(q && q.balance)}">${fmtBal(q)}</span>
        <span>${authCache[key] && authCache[key].auth1 ? "已登录" : "未登录"}</span>
      </div>
      <div class="btns">
        <button data-act="activate" data-email="${escapeAttr(a.email)}">${isActive ? "重注入" : "激活"}</button>
        <button data-act="refresh" data-email="${escapeAttr(a.email)}" class="mini">额度</button>
        <button data-act="remove" data-email="${escapeAttr(a.email)}" class="mini">删除</button>
      </div>`;
    ul.appendChild(li);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const email = btn.dataset.email;
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === "activate") {
      const r = await send({ type: "activate", email });
      toast(r.ok ? "已激活: " + email : "激活失败: " + (r.error || ""), r.ok ? "ok" : "err");
    } else if (act === "refresh") {
      const r = await send({ type: "refreshQuota", email });
      toast(r.ok ? "额度: $" + (r.balance == null ? "?" : r.balance) : "失败: " + (r.error || ""), r.ok ? "ok" : "err");
    } else if (act === "remove") {
      await send({ type: "removeAccount", email });
      toast("已删除: " + email, "ok");
    }
  } finally { await load(); }
});

$("addBtn").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  const label = $("label").value.trim();
  if (!email || !password) { toast("邮箱/密码必填", "err"); return; }
  const r = await send({ type: "addAccount", email, password, label });
  if (r.ok) { $("email").value = ""; $("password").value = ""; $("label").value = ""; toast("已添加 (共 " + r.count + ")", "ok"); await load(); }
  else toast("添加失败: " + (r.error || ""), "err");
});

$("rotateBtn").addEventListener("click", async () => {
  toast("普查额度并切换中…");
  const r = await send({ type: "rotate" });
  toast(r.ok ? "已切到: " + r.switchedTo : "切换失败: " + (r.error || ""), r.ok ? "ok" : "err");
  await load();
});

$("refreshAll").addEventListener("click", async () => {
  toast("全部刷新额度中…");
  await send({ type: "refreshAllQuota" });
  toast("额度已刷新", "ok");
  await load();
});

$("saveSettings").addEventListener("click", async () => {
  const settings = {
    autoSwitch: $("autoSwitch").checked,
    buffer: Number($("buffer").value) || 0,
    pollMin: Math.max(1, Number($("pollMin").value) || 2),
  };
  const r = await send({ type: "saveSettings", settings });
  toast(r.ok ? "设置已保存" : "保存失败", r.ok ? "ok" : "err");
});
$("autoSwitch").addEventListener("change", () => $("saveSettings").click());

load();
