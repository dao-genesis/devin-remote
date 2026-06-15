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
// 余额按美分展示 (额度为分数美元, 否则会显示成 $2.994926623885875 这类长尾浮点)
function fmtMoney(n) { return "$" + (Math.round(Number(n) * 100) / 100).toFixed(2); }
function fmtBal(q) {
  if (!q) return "额度未查";
  if (q.status === "登录失败") return "登录失败";
  if (q.status && q.status !== "ok") return "查询失败(" + q.status + ")";
  if (q.balance == null) return "额度未知";
  return fmtMoney(q.balance);
}

// 采样计时: 上次普查距今 (本体「Nmin前采样」同源)
function fmtAge(ts) {
  if (!ts) return "无快照";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "刚采样";
  if (m < 60) return m + "min前采样";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h前采样";
  return Math.round(h / 24) + "d前采样";
}
// D/W 额度重置倒计时 (剩余天/时)
function fmtReset(ms) {
  if (!ms) return null;
  const left = ms - Date.now();
  if (left <= 0) return "可重置";
  const h = left / 3600000;
  return h >= 24 ? Math.round(h / 24) + "d" : Math.max(1, Math.round(h)) + "h";
}
// 每账号 D/W 重置进度 + 采样计时 + (活跃)token 展示 —— 本体活跃行同源
function metaExtra(q, isActive) {
  if (!q) return "";
  const bits = [];
  const r = q.reset || {};
  const dr = fmtReset(r.dailyResetMs), wr = fmtReset(r.weeklyResetMs);
  if (r.dailyPct != null || dr) bits.push(`D ${r.dailyPct != null ? Math.round(r.dailyPct) + "%" : "?"}${dr ? "·重置" + dr : ""}`);
  if (r.weeklyPct != null || wr) bits.push(`W ${r.weeklyPct != null ? Math.round(r.weeklyPct) + "%" : "?"}${wr ? "·重置" + wr : ""}`);
  bits.push(fmtAge(q.ts));
  if (isActive && q.tokenShort) bits.push("token " + escapeHtml(q.tokenShort));
  return `<div class="meta2">${bits.join(" · ")}</div>`;
}

let STATE = { accounts: [], authCache: {}, active: "", quota: {}, settings: {} };

// 账号有效锁定态 (与 background.js effLocked 同源): 无显式 locked 记录时按 lockByDefault 决定
function effLocked(a, settings) {
  if (!a) return false;
  if (a.locked === true || a.locked === false) return a.locked;
  return (settings || {}).lockByDefault !== false;
}

// 与 background.js DEFAULT_SETTINGS 对齐 (storage-first 渲染时兜底)
const POPUP_DEFAULT_SETTINGS = { autoSwitch: true, buffer: 3, pollMin: 2, lockByDefault: true, notify: true, lowBalance: 5, autoStop: false, stopThreshold: 3 };
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
  $("lockByDefault").checked = settings.lockByDefault !== false;
  $("autoStop").checked = !!settings.autoStop;
  $("buffer").value = settings.buffer != null ? settings.buffer : 3;
  $("pollMin").value = settings.pollMin != null ? settings.pollMin : 2;
  $("lowBalance").value = settings.lowBalance != null ? settings.lowBalance : 5;
  $("stopThreshold").value = settings.stopThreshold != null ? settings.stopThreshold : 3;
  // pool count
  $("poolCount").textContent = accounts.length ? "(" + accounts.length + ")" : "";
  // list
  const ul = $("accountList");
  ul.innerHTML = "";
  $("empty").classList.toggle("hid", accounts.length > 0);
  for (const a of accounts) {
    const key = a.email.toLowerCase();
    const isActive = key === active;
    const q = quota[key];
    const locked = effLocked(a, settings);
    const li = document.createElement("li");
    li.className = "acct" + (isActive ? " active" : "") + (locked ? " locked" : "");
    li.innerHTML = `
      <div class="top">
        <span class="name">${locked ? "🔒 " : ""}${escapeHtml(a.email)}</span>
        ${a.token ? '<span class="badge tok">token</span>' : ""}
        ${isActive ? '<span class="badge">激活中</span>' : ""}
      </div>
      ${a.label && a.label !== "token" ? `<div class="label">${escapeHtml(a.label)}</div>` : ""}
      <div class="meta">
        <span class="bal ${balClass(q && q.balance)}">${fmtBal(q)}</span>
        <span>${authCache[key] && authCache[key].auth1 ? "已登录" : "未登录"}</span>
        <span class="lockstate">${locked ? "🔒 锁定(不自动切)" : "🔓 已解锁(入候选)"}</span>
      </div>
      ${metaExtra(q, isActive)}
      <div class="btns">
        <button data-act="activate" data-email="${escapeAttr(a.email)}">${isActive ? "重注入" : "激活"}</button>
        <button data-act="lock" data-email="${escapeAttr(a.email)}" data-locked="${locked ? "1" : "0"}" class="mini">${locked ? "🔓 解锁" : "🔒 锁定"}</button>
        <button data-act="overview" data-email="${escapeAttr(a.email)}" class="mini">☁ 概览</button>
        <button data-act="refresh" data-email="${escapeAttr(a.email)}" class="mini">额度</button>
        <button data-act="remove" data-email="${escapeAttr(a.email)}" class="mini">删除</button>
      </div>
      <div class="ovw hid" data-ovw="${escapeAttr(key)}"></div>`;
    ul.appendChild(li);
  }
}

function renderCounts(c) {
  if (!c) return "";
  return [
    `<span class="pill run">运行 ${c.running}</span>`,
    `<span class="pill wait">待输入 ${c.awaiting}</span>`,
    `<span class="pill blk">卡住 ${c.blocked}</span>`,
    `<span class="pill">对话 ${c.sessions}</span>`,
    `<span class="pill">知识库 ${c.knowledge}</span>`,
    `<span class="pill">剧本 ${c.playbooks}</span>`,
    `<span class="pill">密钥 ${c.secrets}</span>`,
    `<span class="pill">Git ${c.gitConnections}</span>`,
  ].join("");
}
const SCLS = { running: "run", awaiting: "wait", blocked: "blk" };
const SLABEL = { running: "运行", awaiting: "待输入", blocked: "卡住", finished: "完成", idle: "空闲" };
const ACTIVE_CLS = { running: 1, awaiting: 1, blocked: 1 };
function sessionLi(s, email) {
  const cls = SCLS[s.statusClass] || "";
  const dl = email ? `<button class="sdl" data-dl-sid="${escapeAttr(s.devinId || "")}" data-dl-email="${escapeAttr(email)}" data-dl-title="${escapeAttr(s.title || "")}" title="下载对话">⭳</button>` : "";
  // 运行中(运行/待输入/卡住)才给「停止」: archive 即中停+归档 (自动停止·手动触发·对照本体 stopSession)
  const stop = (email && ACTIVE_CLS[s.statusClass]) ? `<button class="sstop" data-stop-sid="${escapeAttr(s.devinId || "")}" data-stop-email="${escapeAttr(email)}" data-stop-title="${escapeAttr(s.title || "")}" title="停止(归档)对话">⏹</button>` : "";
  return `<li class="sess"><span class="dot ${cls}"></span><span class="stitle">${escapeHtml(s.title)}</span><span class="sstat ${cls}">${escapeHtml(SLABEL[s.statusClass] || s.statusClass)}</span>${stop}${dl}</li>`;
}

// 浏览器端「下载」: 文本 → Blob → a[download] 触发 (popup 是扩展页, 可直接下载)
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
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
      toast(r.ok ? "额度: " + (r.balance == null ? "$?" : fmtMoney(r.balance)) : "失败: " + (r.error || ""), r.ok ? "ok" : "err");
    } else if (act === "overview") {
      const box = document.querySelector(`[data-ovw="${CSS.escape(email.toLowerCase())}"]`);
      if (box && !box.classList.contains("hid")) { box.classList.add("hid"); btn.disabled = false; return; }
      if (box) { box.classList.remove("hid"); box.innerHTML = '<div class="loading">概览加载中…</div>'; }
      const r = await send({ type: "accountOverview", email });
      if (box) {
        if (r && r.ok) {
          const o = r.overview;
          const kn = o.counts && o.counts.knowledge ? `<button class="mini ghost kndl" data-kn-email="${escapeAttr(email)}">⭳ 知识库下载 (${o.counts.knowledge})</button>` : "";
          const pb = o.counts && o.counts.playbooks ? `<button class="mini ghost pbdl" data-pb-email="${escapeAttr(email)}">⭳ 剧本下载 (${o.counts.playbooks})</button>` : "";
          box.innerHTML = `<div class="track-counts">${renderCounts(o.counts)}</div>` +
            `<ul class="sessions">${(o.sessions || []).slice(0, 20).map((s) => sessionLi(s, email)).join("") || '<li class="sess muted">无对话</li>'}</ul>` +
            `<div class="ovw-actions">` +
              (kn || "") +
              (pb || "") +
              `<button class="mini ghost gitst" data-git-email="${escapeAttr(email)}">🔗 Git 状态</button>` +
              `<button class="mini ghost gitdc" data-gitdc-email="${escapeAttr(email)}">⛓ 断开 Git</button>` +
              `<button class="mini danger wipe" data-wipe-email="${escapeAttr(email)}">🧹 水过无痕</button>` +
            `</div>` +
            `<div class="git-line" data-git-line="${escapeAttr(email)}"></div>`;
        } else box.innerHTML = `<div class="err-line">概览失败: ${escapeHtml((r && r.error) || "?")}</div>`;
      }
      btn.disabled = false;
      return; // 不触发 load() 重渲染 (会清空已展开概览)
    } else if (act === "lock") {
      const locked = btn.dataset.locked === "1";
      const r = await send({ type: "lockAccount", email, locked: !locked });
      toast(r.ok ? (r.locked ? "已🔒锁定: " + email : "已🔓解锁: " + email) : "操作失败: " + (r.error || ""), r.ok ? "ok" : "err");
    } else if (act === "remove") {
      await send({ type: "removeAccount", email });
      toast("已删除: " + email, "ok");
    }
  } finally { if (act !== "overview") await load(); }
});

// 下载: 对话数据 (.sdl) / 知识库 (.kndl)
document.addEventListener("click", async (e) => {
  const sdl = e.target.closest("button.sdl");
  if (sdl) {
    sdl.disabled = true;
    toast("拉取对话事件流…");
    const r = await send({ type: "exportConversation", email: sdl.dataset.dlEmail, devinId: sdl.dataset.dlSid, title: sdl.dataset.dlTitle });
    if (r && r.ok) {
      downloadText(r.mdName, r.md, "text/markdown");
      downloadText(r.jsonName, r.json, "application/json");
      toast(`已下载对话 (${r.eventCount} 事件): MD + JSON`, "ok");
    } else toast("下载失败: " + ((r && r.error) || ""), "err");
    sdl.disabled = false;
    return;
  }
  const kndl = e.target.closest("button.kndl");
  if (kndl) {
    kndl.disabled = true;
    toast("拉取知识库…");
    const r = await send({ type: "exportKnowledge", email: kndl.dataset.knEmail });
    if (r && r.ok) {
      downloadText(r.jsonName, r.json, "application/json");
      for (const it of (r.items || [])) downloadText(it.mdName, it.md, "text/markdown");
      toast(`已下载知识库 (${r.count} 条): JSON + 逐条 MD`, "ok");
    } else toast("知识库下载失败: " + ((r && r.error) || ""), "err");
    kndl.disabled = false;
    return;
  }
  // 剧本下载 (用户自建剧本 → JSON + 逐条 MD)
  const pbdl = e.target.closest("button.pbdl");
  if (pbdl) {
    pbdl.disabled = true;
    toast("拉取剧本…");
    const r = await send({ type: "exportPlaybooks", email: pbdl.dataset.pbEmail });
    if (r && r.ok) {
      if (!r.count) { toast("无用户自建剧本可下载 (社区/内置剧本不导出)", "ok"); }
      else {
        downloadText(r.jsonName, r.json, "application/json");
        for (const it of (r.items || [])) downloadText(it.mdName, it.md, "text/markdown");
        toast(`已下载剧本 (${r.count} 条): JSON + 逐条 MD`, "ok");
      }
    } else toast("剧本下载失败: " + ((r && r.error) || ""), "err");
    pbdl.disabled = false;
    return;
  }
  // 停止(归档)运行中对话: archive = 中停+移出列表 (对照本体 stopSession)
  const sstop = e.target.closest("button.sstop");
  if (sstop) {
    const title = sstop.dataset.stopTitle || sstop.dataset.stopSid;
    if (!confirm(`停止(归档)该对话？\n\n${title}\n\nDevin Cloud 无暂停接口·唯归档可中停 (running→suspended·移出列表)。建议先「⭳」下载留底。`)) return;
    sstop.disabled = true;
    toast("停止对话中…");
    const r = await send({ type: "stopSession", email: sstop.dataset.stopEmail, devinId: sstop.dataset.stopSid });
    toast(r && r.ok ? "已停止(归档): " + String(title).slice(0, 24) : "停止失败 HTTP " + ((r && r.status) || "?"), r && r.ok ? "ok" : "err");
    if (r && r.ok) { const li = sstop.closest("li.sess"); if (li) li.remove(); }
    else sstop.disabled = false;
    return;
  }
  // Git 状态
  const gitst = e.target.closest("button.gitst");
  if (gitst) {
    const email = gitst.dataset.gitEmail;
    const line = document.querySelector(`[data-git-line="${CSS.escape(email.toLowerCase())}"]`) || document.querySelector(`[data-git-line="${CSS.escape(email)}"]`);
    gitst.disabled = true;
    if (line) line.innerHTML = '<span class="muted">查询 Git 状态…</span>';
    const r = await send({ type: "gitStatus", email });
    if (line) {
      if (r && r.ok) { const g = r.git; line.innerHTML = `<span class="muted">身份 <b>${escapeHtml(g.login || "无")}</b> · 连接 ${g.connections} · 仓库 ${g.repoCount} · PAT密钥 ${g.secret ? "✓" : "✗"}</span>`; }
      else line.innerHTML = `<span class="err-line">${escapeHtml((r && r.error) || "失败")}</span>`;
    }
    gitst.disabled = false;
    return;
  }
  // 断开 Git
  const gitdc = e.target.closest("button.gitdc");
  if (gitdc) {
    const email = gitdc.dataset.gitdcEmail;
    if (!confirm(`断开 ${email} 的全部 Git 连接？(清仓库授权 + 断身份)`)) return;
    gitdc.disabled = true;
    toast("断开 Git…");
    const r = await send({ type: "gitDisconnect", email });
    toast(r && r.ok ? "已断开 Git (剩余连接 0)" : `断开未净: 剩 ${(r && r.remaining) != null ? r.remaining : "?"}`, r && r.ok ? "ok" : "err");
    gitdc.disabled = false;
    return;
  }
  // 水过无痕: 先 dryRun 扫描 → 确认 → 执行
  const wipe = e.target.closest("button.wipe");
  if (wipe) {
    const email = wipe.dataset.wipeEmail;
    wipe.disabled = true;
    toast("扫描可清理痕迹…");
    const scan = await send({ type: "wipeAccount", email, dryRun: true });
    if (!scan || !scan.ok) { toast("扫描失败: " + ((scan && scan.error) || ""), "err"); wipe.disabled = false; return; }
    const rp = scan.report;
    const msg = `水过无痕将清理 ${email}:\n对话 ${rp.sessions.found} · 知识库 ${rp.knowledge.found} · 剧本 ${rp.playbooks.found} · 密钥 ${rp.secrets.found}\n(本源默认保留: 知识 ${rp.native.knowledge} 剧本 ${rp.native.playbooks})\n并断开全部 Git 连接。不可恢复，确认执行？`;
    if (!confirm(msg)) { wipe.disabled = false; return; }
    toast("执行水过无痕…");
    const r = await send({ type: "wipeAccount", email, dryRun: false });
    if (r && r.ok) { const x = r.report; toast(`已清: 对话${x.sessions.deleted} 知识${x.knowledge.deleted} 剧本${x.playbooks.deleted} 密钥${x.secrets.deleted}`, "ok"); }
    else toast("清理失败: " + ((r && r.error) || ""), "err");
    wipe.disabled = false;
    return;
  }
});

$("gitBatchBtn").addEventListener("click", async () => {
  const pat = $("gitPat").value.trim();
  if (!pat) { toast("先粘贴 GitHub PAT", "err"); return; }
  if (!STATE.accounts.length) { toast("账号池为空", "err"); return; }
  if (!confirm(`将该 PAT 连接到全部 ${STATE.accounts.length} 个账号？`)) return;
  const btn = $("gitBatchBtn");
  btn.disabled = true; btn.textContent = "连接中…";
  const r = await send({ type: "gitBatchConnectPat", pat }, 40);
  const box = $("gitBatchResult");
  if (r && r.ok) {
    box.innerHTML = r.results.map((x) => `<div class="gitres-row ${x.ok ? "ok" : "err"}">${x.ok ? "✓" : "✗"} ${escapeHtml(x.email)}${x.ok ? ` · @${escapeHtml(x.login || "?")} · 仓库 ${x.repoCount}` : " · " + escapeHtml((x.error || "").slice(0, 60))}</div>`).join("");
    toast(`批量归一: ${r.succeeded}/${r.total} 成功`, r.succeeded ? "ok" : "err");
  } else { box.innerHTML = `<div class="gitres-row err">批量连接失败: ${escapeHtml((r && r.error) || "?")}</div>`; toast("批量连接失败", "err"); }
  btn.disabled = false; btn.textContent = "🔗 批量连接全部账号";
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
    lockByDefault: $("lockByDefault").checked,
    autoStop: $("autoStop").checked,
    buffer: Number($("buffer").value) || 0,
    pollMin: Math.max(1, Number($("pollMin").value) || 2),
    lowBalance: Math.max(0, Number($("lowBalance").value) || 0),
    stopThreshold: Math.max(0, Number($("stopThreshold").value) || 0),
  };
  const r = await send({ type: "saveSettings", settings });
  toast(r.ok ? "设置已保存" : "保存失败", r.ok ? "ok" : "err");
});
$("autoSwitch").addEventListener("change", () => $("saveSettings").click());
$("lockByDefault").addEventListener("change", () => $("saveSettings").click());
$("autoStop").addEventListener("change", () => $("saveSettings").click());

// 紧急切换: 立即弃用当前号, 切到其他未锁定最优号
$("panicBtn").addEventListener("click", async () => {
  if (!confirm("紧急切换：立即弃用当前账号，切到其他未锁定的最优账号？")) return;
  toast("紧急切换中…");
  const r = await send({ type: "panicSwitch" });
  toast(r.ok ? "已紧急切到: " + r.switchedTo : "切换失败: " + (r.error || ""), r.ok ? "ok" : "err");
  await load();
});

// 万法识别·批量添加: 任意格式文本 → 解析入池
$("bulkAddBtn").addEventListener("click", async () => {
  const text = $("bulk").value;
  if (!text.trim()) { toast("先粘贴账号文本", "err"); return; }
  const r = await send({ type: "parseAndAdd", text });
  if (r && r.ok) {
    $("bulk").value = "";
    toast(`识别 ${r.parsed} 个 · 新增 ${r.added} · 更新 ${r.updated}` + (r.tokens ? ` · token ${r.tokens}` : ""), r.parsed ? "ok" : "err");
    await load();
  } else toast("识别失败: " + ((r && r.error) || ""), "err");
});

// 一键导出: 账号池 → 剪贴板 (可再粘贴回收)
$("exportBtn").addEventListener("click", async () => {
  const r = await send({ type: "exportAccounts" });
  if (!r || !r.ok || !r.text) { toast("无可导出账号", "err"); return; }
  try { await navigator.clipboard.writeText(r.text); toast("已复制到剪贴板 (" + r.text.split("\n").length + " 个)", "ok"); }
  catch { $("bulk").value = r.text; toast("已填入下方文本框 (剪贴板不可用)", "ok"); }
});

// 对话追踪: 拉取当前激活账号的活跃会话
$("trackRefresh").addEventListener("click", async () => {
  const list = $("trackList"), counts = $("trackCounts"), empty = $("trackEmpty");
  if (!STATE.active) { toast("先激活一个账号", "err"); return; }
  empty.classList.add("hid"); counts.innerHTML = ""; list.innerHTML = '<li class="sess muted">追踪中…</li>';
  const r = await send({ type: "runningSessions" });
  if (r && r.ok) {
    const ss = r.sessions || [];
    const c = { running: 0, awaiting: 0, blocked: 0 };
    for (const s of ss) if (c[s.statusClass] != null) c[s.statusClass]++;
    counts.innerHTML = `<span class="pill run">运行 ${c.running}</span><span class="pill wait">待输入 ${c.awaiting}</span><span class="pill blk">卡住 ${c.blocked}</span>`;
    list.innerHTML = ss.length ? ss.map((s) => sessionLi(s, STATE.active)).join("") : '<li class="sess muted">无活跃对话 (运行/待输入/卡住)</li>';
  } else { list.innerHTML = ""; empty.classList.remove("hid"); toast("追踪失败: " + ((r && r.error) || ""), "err"); }
});

load();
