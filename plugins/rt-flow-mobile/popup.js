// rt-flow-mobile · popup.js — 面板 (水善利万物而有静)
// 渲染与增删锁直接读写 chrome.storage (母), 不依赖 service worker 是否唤醒;
// 仅「验证 / 切号」等需登录+注入的动作下发给 service worker 引擎执行。
"use strict";

const Store = self.RtStore;

// 单次发送; 冷启动竞态下回调可能永不触发, 故加超时兜底
function sendOnce(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError; // 读取以静默 "port closed" 告警
        clearTimeout(timer);
        finish(r);
      });
    } catch (e) {
      clearTimeout(timer);
      finish(undefined);
    }
  });
}

// 下发动作给 service worker; 冷启动首条消息可能被丢 → 超时+重试, 自举唤醒。
// 无论回执是否到达, 调用方都会随后从 storage 重渲染, 故动作不会丢。
async function send(msg, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await sendOnce(msg, 1500);
    if (r !== undefined) return r;
    await new Promise((s) => setTimeout(s, 150));
  }
  return undefined;
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

// 渲染直接读 storage —— 永远成功, 与 service worker 生死无关
async function refresh() {
  try {
    render(await Store.buildSnapshot());
  } catch (e) {
    render({ error: String((e && e.message) || e) });
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const email = btn.getAttribute("data-email");
  const act = btn.getAttribute("data-act");
  btn.disabled = true;
  if (act === "lock") {
    await Store.toggleLock(email); // 纯 storage 改, 无需 service worker
    await refresh();
  } else if (act === "remove") {
    await Store.removeAccount(email);
    await refresh();
  } else if (act === "switch") {
    btn.textContent = "登录中…";
    await send({ type: "rtflow:switch", email }); // 需登录+注入 → 引擎
    await refresh();
  }
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
  await Store.addAccounts(text); // 纯 storage 改, 无需 service worker
  await refresh();
});
document.getElementById("btnVerify").addEventListener("click", async (e) => {
  e.target.textContent = "验证中…";
  await send({ type: "rtflow:verifyAll" }); // 需登录+取余额 → 引擎
  await refresh(); // 无论回执是否到达, 从 storage 读最新健康度
  e.target.textContent = "↻ 验证全部";
});
document.getElementById("btnNext").addEventListener("click", async (e) => {
  e.target.disabled = true;
  await send({ type: "rtflow:switchNext" }); // 需登录+注入 → 引擎
  await refresh();
  e.target.disabled = false;
});

refresh();
