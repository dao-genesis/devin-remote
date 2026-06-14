// rt-flow-mobile · popup.js — 面板 (水善利万物而有静)
"use strict";

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function fmtBal(b) {
  if (b === null || b === undefined) return "—";
  if (b >= 9999) return "∞";
  return "$" + Number(b).toFixed(2);
}

function render(state) {
  const list = document.getElementById("list");
  const sub = document.getElementById("sub");
  if (!state || state.error) {
    list.innerHTML = '<div class="empty">出错: ' + (state && state.error || "未知") + "</div>";
    return;
  }
  const cfg = state.settings || {};
  sub.textContent = "停止阈值 $" + cfg.stopThreshold + " · 缓冲 $" + cfg.buffer + " · 自动切号 " + (cfg.autoSwitch ? "开" : "关");
  const rows = state.accounts || [];
  if (!rows.length) {
    list.innerHTML = '<div class="empty">还没有账号。点「＋ 添加账号」粘贴 email password。</div>';
    return;
  }
  list.innerHTML = "";
  for (const a of rows) {
    const div = document.createElement("div");
    div.className = "acct" + (a.active ? " active" : "");
    const low = a.balance !== null && a.balance <= cfg.stopThreshold;
    const exhausted = a.checked && low;
    const pills = [];
    if (a.active) pills.push('<span class="pill" style="background:#143a1f;color:#7fdca0">当前</span>');
    if (a.locked) pills.push('<span class="pill lock">🔒锁</span>');
    if (exhausted) pills.push('<span class="pill exh">耗尽</span>');
    const meta = a.checked
      ? '余额 <span class="bal ' + (low ? "low" : "ok") + '">' + fmtBal(a.balance) + "</span> · 对话上限 $" + Number(a.convCap).toFixed(2) + (a.drain ? " (抽干)" : "") + (a.error ? " · ⚠" + a.error : "")
      : "未验证";
    div.innerHTML =
      '<div class="main">' +
      '<div class="email">' + a.email + "</div>" +
      '<div class="meta">' + meta + " " + pills.join(" ") + "</div>" +
      "</div>" +
      '<div class="acts">' +
      '<button data-act="switch" data-email="' + a.email + '">用此号</button>' +
      '<button class="sec" data-act="lock" data-email="' + a.email + '">' + (a.locked ? "解锁" : "锁") + "</button>" +
      '<button class="sec" data-act="remove" data-email="' + a.email + '">删</button>' +
      "</div>";
    list.appendChild(div);
  }
}

async function refresh() {
  render(await send({ type: "rtflow:state" }));
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const email = btn.getAttribute("data-email");
  const act = btn.getAttribute("data-act");
  btn.disabled = true;
  if (act === "switch") render(await send({ type: "rtflow:switch", email }));
  else if (act === "lock") render(await send({ type: "rtflow:lock", email }));
  else if (act === "remove") render(await send({ type: "rtflow:remove", email }));
});

document.getElementById("btnAdd").addEventListener("click", () => {
  document.getElementById("addbox").classList.toggle("show");
});
document.getElementById("btnCancel").addEventListener("click", () => {
  document.getElementById("addbox").classList.remove("show");
});
document.getElementById("btnSave").addEventListener("click", async () => {
  const ta = document.getElementById("ta");
  const text = ta.value;
  ta.value = "";
  document.getElementById("addbox").classList.remove("show");
  render(await send({ type: "rtflow:add", text }));
});
document.getElementById("btnVerify").addEventListener("click", async (e) => {
  e.target.textContent = "验证中…";
  render(await send({ type: "rtflow:verifyAll" }));
  e.target.textContent = "↻ 验证全部";
});
document.getElementById("btnNext").addEventListener("click", async (e) => {
  e.target.disabled = true;
  render(await send({ type: "rtflow:switchNext" }));
  e.target.disabled = false;
});

refresh();
