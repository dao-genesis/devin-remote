"use strict";
// popup.js · rt-flow 浏览器版 · 控制面板 UI (视觉对齐桌面 rt-flow WAM 面板)
// v1.5.0 · 去除自动切号: 切号 = 点击账号「切号」→ 注入登录 app.devin.ai。
const $ = (id) => document.getElementById(id);

// send: 给 service worker 下发动作。MV3 冷启时首条消息回调可能不触发, 故加超时重试。
function sendOnce(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (done) return;
        done = true; clearTimeout(t);
        void chrome.runtime.lastError;
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
// sendLong: 长任务专用 (全量备份等可达数十秒)。先用 ping 唤醒 SW (覆盖 MV3 冷启),
// 再「单次」下发并等待真实完成 — 不做超时重试, 避免把长任务重复下发拖垮。
async function sendLong(msg, warmTries = 8) {
  for (let i = 0; i < warmTries; i++) {
    if ((await sendOnce({ type: "ping" }, 1500)) !== undefined) break;
    await new Promise((s) => setTimeout(s, 150));
  }
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r === undefined ? { ok: false, error: "service worker 无响应" } : r);
      });
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
  });
}
function toast(text, kind) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast " + (kind || "");
  setTimeout(() => el.classList.add("hid"), 2600);
}

// 余额按美分展示 (额度为分数美元)
function fmtMoney(n) { return "$" + (Math.round(Number(n) * 100) / 100).toFixed(2); }
function balQl(q) {
  if (!q) return { cls: "unk", txt: "未查" };
  if (q.status === "登录失败") return { cls: "zero", txt: "登录败" };
  if (q.status && q.status !== "ok") return { cls: "unk", txt: "查失败" };
  if (q.balance == null) return { cls: "unk", txt: "未知" };
  const b = q.balance;
  return { cls: b <= 1 ? "zero" : (b <= 5 ? "low" : "good"), txt: fmtMoney(b) };
}

// 采样计时: 上次普查距今
function fmtAge(ts) {
  if (!ts) return "无快照";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "刚采样";
  if (m < 60) return m + "min前采样";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h前采样";
  return Math.round(h / 24) + "d前采样";
}
// D/W 额度重置倒计时
function fmtReset(ms) {
  if (!ms) return null;
  const left = ms - Date.now();
  if (left <= 0) return "可重置";
  const h = left / 3600000;
  return h >= 24 ? Math.round(h / 24) + "d" : Math.max(1, Math.round(h)) + "h";
}
// 每账号 D/W 重置进度 + 采样计时 (桌面活跃行同源)
function metaExtra(q, isActive) {
  if (!q) return "无额度快照 (点「额度」普查)";
  const bits = [];
  const r = q.reset || {};
  const dr = fmtReset(r.dailyResetMs), wr = fmtReset(r.weeklyResetMs);
  if (r.dailyPct != null || dr) bits.push(`D ${r.dailyPct != null ? Math.round(r.dailyPct) + "%" : "?"}${dr ? "·重置" + dr : ""}`);
  if (r.weeklyPct != null || wr) bits.push(`W ${r.weeklyPct != null ? Math.round(r.weeklyPct) + "%" : "?"}${wr ? "·重置" + wr : ""}`);
  bits.push(fmtAge(q.ts));
  if (isActive && q.tokenShort) bits.push("token " + escapeHtml(q.tokenShort));
  return bits.join(" · ");
}

// 邮箱域 → 域徽 (对照桌面 .dm shop/yh/gm/ms/o)
function domainBadge(email) {
  const d = String(email || "").split("@")[1] || "";
  if (/gmail\./i.test(d)) return { cls: "gm", txt: "GM" };
  if (/(outlook|hotmail|live|msn)\./i.test(d)) return { cls: "ms", txt: "MS" };
  if (/yahoo\./i.test(d)) return { cls: "yh", txt: "YH" };
  if (!d) return { cls: "o", txt: "TK" };
  return { cls: "o", txt: (d[0] || "?").toUpperCase() };
}
// D/W mini-bar (pct 0-100)
function miniBar(pct) {
  if (pct == null) return "";
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const color = p <= 10 ? "#f44" : (p <= 30 ? "#ce9178" : "#4ec9b0");
  return `<span class="mb"><span class="mf" style="width:${p}%;background:${color}"></span></span>`;
}

let STATE = { accounts: [], authCache: {}, active: "", quota: {}, settings: {} };
const DEFAULT_SETTINGS = { notify: true, lowBalance: 5 };
function getLocal(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }

// 渲染直读 chrome.storage (母/真源), 不依赖 service worker 是否唤醒。
async function load() {
  const s = await getLocal(["accounts", "authCache", "active", "quota", "settings"]);
  STATE = {
    accounts: s.accounts || [],
    authCache: s.authCache || {},
    active: s.active || "",
    quota: s.quota || {},
    settings: Object.assign({}, DEFAULT_SETTINGS, s.settings || {}),
  };
  render();
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") load(); });

function render() {
  const { accounts, authCache, active, quota } = STATE;

  // ── 聚合统计 + 余额池条 ──
  let avail = 0, exh = 0;
  for (const a of accounts) {
    const q = quota[a.email.toLowerCase()];
    if (q && q.status === "ok" && q.balance != null) { if (q.balance > 1) avail++; else exh++; }
  }
  const unk = accounts.length - avail - exh;
  $("stTotal").textContent = accounts.length;
  $("stAvail").textContent = avail;
  $("stExh").textContent = exh;
  $("stUnk").textContent = unk;
  $("poolFill").style.width = (accounts.length ? Math.round((avail / accounts.length) * 100) : 0) + "%";
  $("poolCount").textContent = accounts.length ? "(" + accounts.length + ")" : "";

  // ── 活跃账号卡 ──
  const al = $("activeLine");
  if (active) {
    const q = quota[active];
    const ql = balQl(q);
    al.classList.remove("empty");
    al.innerHTML = `激活: <b>${escapeHtml(active)}</b><span class="tag">${ql.txt}</span>`;
  } else {
    al.classList.add("empty");
    al.textContent = "未激活账号 · 点击下方账号「切号」即注入登录 devin.ai";
  }

  // ── 账号行 ──
  const wrap = $("accountList");
  wrap.innerHTML = "";
  $("empty").classList.toggle("hid", accounts.length > 0);
  accounts.forEach((a, i) => {
    const key = a.email.toLowerCase();
    const isActive = key === active;
    const q = quota[key];
    const r = (q && q.reset) || {};
    const ql = balQl(q);
    const dm = domainBadge(a.email);
    const loggedIn = authCache[key] && authCache[key].auth1;
    const row = document.createElement("div");
    row.className = "row" + (isActive ? " act" : "");
    row.innerHTML = `
      <div class="row-main">
        <span class="acc-no">${i + 1}</span>
        <span class="dm ${dm.cls}">${dm.txt}</span>
        <span class="em" title="${escapeAttr(a.email)}">${escapeHtml(a.email)}</span>
        ${a.token ? '<span class="tok-tag">token</span>' : ""}
        ${a.label && a.label !== "token" ? `<span class="plan-tag">${escapeHtml(a.label)}</span>` : ""}
        <span class="login-tag ${loggedIn ? "" : "no"}">${loggedIn ? "已登录" : "未登录"}</span>
        <span class="qt">${miniBar(r.dailyPct)}${miniBar(r.weeklyPct)}<span class="ql ${ql.cls}">${ql.txt}</span></span>
        <span class="acts">
          <button class="b sw" data-act="activate" data-email="${escapeAttr(a.email)}">${isActive ? "重注入" : "切号"}</button>
          <button class="b dv" data-act="opentab" data-email="${escapeAttr(a.email)}" title="新标签页打开此账号 (多实例·与其他账号网页并行·互不干扰)">⧉新页</button>
          <button class="b dv" data-act="overview" data-email="${escapeAttr(a.email)}">☁</button>
          <button class="b dv" data-act="refresh" data-email="${escapeAttr(a.email)}">额度</button>
          <button class="b danger" data-act="remove" data-email="${escapeAttr(a.email)}">✕</button>
        </span>
      </div>
      <div class="row-meta">${metaExtra(q, isActive)}</div>
      <div class="ovw hid" data-ovw="${escapeAttr(key)}"></div>`;
    wrap.appendChild(row);
  });
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
  const stop = (email && ACTIVE_CLS[s.statusClass]) ? `<button class="sstop" data-stop-sid="${escapeAttr(s.devinId || "")}" data-stop-email="${escapeAttr(email)}" data-stop-title="${escapeAttr(s.title || "")}" title="停止(归档)对话">⏹</button>` : "";
  return `<li class="sess"><span class="dot ${cls}"></span><span class="stitle">${escapeHtml(s.title)}</span><span class="sstat ${cls}">${escapeHtml(SLABEL[s.statusClass] || s.statusClass)}</span>${stop}${dl}</li>`;
}

// 浏览器端「下载」: Blob → a[download] 触发 → 落手机浏览器 Download 文件夹
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}
function downloadText(filename, text, mime) {
  downloadBlob(filename, new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" }));
}

// CRC32 (ZIP 校验用)
function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// 纯前端·无依赖 ZIP 打包 (store 法·不压缩)。把"一个文件夹的备份"凝成单个 zip,
// 规避 Chrome/Kiwi 对「连续多文件下载」的静默拦截 (>~10 个会被丢弃)，落手机 Download 只需一个文件。
function makeZip(files) {
  const enc = new TextEncoder();
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text == null ? "" : String(f.text));
    const crc = crc32(data);
    const lfh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
    parts.push(Uint8Array.from(lfh), nameBytes, data);
    central.push({ crc, size: data.length, nameBytes, offset });
    offset += lfh.length + nameBytes.length + data.length;
  }
  let cdSize = 0; const cd = [];
  for (const c of central) {
    const cdh = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21),
      u32(c.crc), u32(c.size), u32(c.size), u16(c.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset));
    cd.push(Uint8Array.from(cdh), c.nameBytes);
    cdSize += cdh.length + c.nameBytes.length;
  }
  const eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(offset), u16(0));
  return new Blob(parts.concat(cd, [Uint8Array.from(eocd)]), { type: "application/zip" });
}
// 安全文件名 (zip 内条目)
function safeName(s) { return String(s || "x").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80); }
function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

// ── 账号行操作: 切号(注入登录) / 概览 / 额度 / 删除 ──
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const email = btn.dataset.email;
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === "activate") {
      const r = await send({ type: "activate", email });
      toast(r.ok ? "已切号·注入登录: " + email : "切号失败: " + (r.error || ""), r.ok ? "ok" : "err");
    } else if (act === "opentab") {
      const r = await send({ type: "openAccountTab", email });
      toast(r && r.ok ? "已新标签打开·多实例注入: " + email : "打开失败: " + ((r && r.error) || ""), r && r.ok ? "ok" : "err");
      btn.disabled = false; return;
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
          const kn = o.counts && o.counts.knowledge ? `<button class="ghost kndl" data-kn-email="${escapeAttr(email)}">⭳ 知识库 (${o.counts.knowledge})</button>` : "";
          const pb = o.counts && o.counts.playbooks ? `<button class="ghost pbdl" data-pb-email="${escapeAttr(email)}">⭳ 剧本 (${o.counts.playbooks})</button>` : "";
          box.innerHTML = `<div class="track-counts">${renderCounts(o.counts)}</div>` +
            `<ul class="sessions">${(o.sessions || []).slice(0, 20).map((s) => sessionLi(s, email)).join("") || '<li class="sess muted">无对话</li>'}</ul>` +
            `<div class="ovw-actions">` +
              (kn || "") + (pb || "") +
              `<button class="ghost gitst" data-git-email="${escapeAttr(email)}">🔗 Git 状态</button>` +
              `<button class="ghost gitdc" data-gitdc-email="${escapeAttr(email)}">⛓ 断开 Git</button>` +
              `<button class="danger wipe" data-wipe-email="${escapeAttr(email)}">🧹 水过无痕</button>` +
            `</div>` +
            `<div class="git-line" data-git-line="${escapeAttr(email)}"></div>`;
        } else box.innerHTML = `<div class="err-line">概览失败: ${escapeHtml((r && r.error) || "?")}</div>`;
      }
      btn.disabled = false;
      return; // 不触发 load() 重渲染 (会清空已展开概览)
    } else if (act === "remove") {
      await send({ type: "removeAccount", email });
      toast("已删除: " + email, "ok");
    }
  } finally { if (act !== "overview") await load(); }
});

// 下载/Git/水过无痕 (概览内按钮·与桌面同源)
document.addEventListener("click", async (e) => {
  const sdl = e.target.closest("button.sdl");
  if (sdl) {
    sdl.disabled = true;
    toast("拉取对话事件流…");
    const r = await send({ type: "exportConversation", email: sdl.dataset.dlEmail, devinId: sdl.dataset.dlSid, title: sdl.dataset.dlTitle });
    if (r && r.ok) {
      // 单条对话 → 单个 zip (MD+JSON+HTML), 规避手机浏览器多文件下载拦截
      const files = [{ name: r.mdName, text: r.md }, { name: r.jsonName, text: r.json }];
      if (r.html) files.push({ name: r.htmlName, text: r.html });
      downloadBlob(`${safeName((r.title || r.devinId))}_${String(r.devinId).slice(0, 8)}.zip`, makeZip(files));
      toast(`已下载对话 (${r.eventCount} 事件): MD + JSON + HTML → 手机 (单个 zip)`, "ok");
    } else toast("下载失败: " + ((r && r.error) || ""), "err");
    sdl.disabled = false;
    return;
  }
  const kndl = e.target.closest("button.kndl");
  if (kndl) {
    kndl.disabled = true;
    toast("拉取知识库…");
    const r = await sendLong({ type: "exportKnowledge", email: kndl.dataset.knEmail });
    if (r && r.ok) {
      const files = [{ name: r.jsonName, text: r.json }];
      for (const it of (r.items || [])) files.push({ name: it.mdName, text: it.md });
      downloadBlob(`devin-knowledge-${safeName((kndl.dataset.knEmail || "").split("@")[0])}-${stamp()}.zip`, makeZip(files));
      toast(`已下载知识库 (${r.count} 条) → 手机 (单个 zip)`, "ok");
    } else toast("知识库下载失败: " + ((r && r.error) || ""), "err");
    kndl.disabled = false;
    return;
  }
  const pbdl = e.target.closest("button.pbdl");
  if (pbdl) {
    pbdl.disabled = true;
    toast("拉取剧本…");
    const r = await sendLong({ type: "exportPlaybooks", email: pbdl.dataset.pbEmail });
    if (r && r.ok) {
      if (!r.count) { toast("无用户自建剧本可下载", "ok"); }
      else {
        const files = [{ name: r.jsonName, text: r.json }];
        for (const it of (r.items || [])) files.push({ name: it.mdName, text: it.md });
        downloadBlob(`devin-playbooks-${safeName((pbdl.dataset.pbEmail || "").split("@")[0])}-${stamp()}.zip`, makeZip(files));
        toast(`已下载剧本 (${r.count} 条) → 手机 (单个 zip)`, "ok");
      }
    } else toast("剧本下载失败: " + ((r && r.error) || ""), "err");
    pbdl.disabled = false;
    return;
  }
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
  const wipe = e.target.closest("button.wipe");
  if (wipe) {
    const email = wipe.dataset.wipeEmail;
    wipe.disabled = true;
    toast("扫描可清理痕迹…");
    const scan = await sendLong({ type: "wipeAccount", email, dryRun: true });
    if (!scan || !scan.ok) { toast("扫描失败: " + ((scan && scan.error) || ""), "err"); wipe.disabled = false; return; }
    const rp = scan.report;
    const msg = `水过无痕将清理 ${email}:\n对话 ${rp.sessions.found} · 知识库 ${rp.knowledge.found} · 剧本 ${rp.playbooks.found} · 密钥 ${rp.secrets.found}\n(本源默认保留: 知识 ${rp.native.knowledge} 剧本 ${rp.native.playbooks})\n并断开全部 Git 连接。不可恢复，确认执行？`;
    if (!confirm(msg)) { wipe.disabled = false; return; }
    toast("执行水过无痕…");
    const r = await sendLong({ type: "wipeAccount", email, dryRun: false });
    if (r && r.ok) { const x = r.report; toast(`已清: 对话${x.sessions.deleted} 知识${x.knowledge.deleted} 剧本${x.playbooks.deleted} 密钥${x.secrets.deleted}`, "ok"); }
    else toast("清理失败: " + ((r && r.error) || ""), "err");
    wipe.disabled = false;
    return;
  }
});

// 添加区折叠
$("addHeader").addEventListener("click", () => {
  $("addHeader").parentElement.classList.toggle("open");
});

$("gitBatchBtn").addEventListener("click", async () => {
  const pat = $("gitPat").value.trim();
  if (!pat) { toast("先粘贴 GitHub PAT", "err"); return; }
  if (!STATE.accounts.length) { toast("账号池为空", "err"); return; }
  if (!confirm(`将该 PAT 连接到全部 ${STATE.accounts.length} 个账号？`)) return;
  const btn = $("gitBatchBtn");
  btn.disabled = true; btn.textContent = "连接中…";
  const r = await sendLong({ type: "gitBatchConnectPat", pat });
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

$("refreshAll").addEventListener("click", async () => {
  toast("全部刷新额度中…");
  await sendLong({ type: "refreshAllQuota" });
  toast("额度已刷新", "ok");
  await load();
});

// 打开独立控制台 (panel.html · 三合一·亦可常驻为独立网页)。panel 自身无此按钮, 故守空。
(function () {
  const op = $("openPanel");
  if (op) op.addEventListener("click", () => { try { chrome.tabs.create({ url: chrome.runtime.getURL("src/panel.html") }); } catch (e) {} });
})();

// Devin Cloud 全量备份 → 手机: 当前激活账号所有对话 → 单个 zip (内含逐条 MD+JSON) 落 Download
$("backupAllBtn").addEventListener("click", async () => {
  if (!STATE.active) { toast("先激活一个账号", "err"); return; }
  const btn = $("backupAllBtn");
  btn.disabled = true; btn.textContent = "备份中…";
  toast("拉取并备份全部对话…(对话多时需数十秒)");
  const r = await sendLong({ type: "backupAllSessions" });
  if (r && r.ok) {
    const items = r.items || [];
    if (!items.length) { toast("无对话可备份", "err"); }
    else {
      const files = [];
      for (const it of items) {
        files.push({ name: it.mdName, text: it.md });
        files.push({ name: it.jsonName, text: it.json });
        if (it.html) files.push({ name: it.htmlName, text: it.html });
      }
      const who = safeName(STATE.active.split("@")[0]);
      downloadBlob(`devin-cloud-backup-${who}-${stamp()}.zip`, makeZip(files));
      toast(`已备份 ${items.length}/${r.total} 个对话 → 手机 Download (单个 zip·${files.length} 文件)`, "ok");
    }
  } else toast("备份失败: " + ((r && r.error) || ""), "err");
  btn.disabled = false; btn.textContent = "⭳ Devin Cloud 全量备份→手机";
});

// 万法识别·批量添加
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

// 一键导出: 账号池 → 剪贴板
$("exportBtn").addEventListener("click", async () => {
  const r = await send({ type: "exportAccounts" });
  if (!r || !r.ok || !r.text) { toast("无可导出账号", "err"); return; }
  try { await navigator.clipboard.writeText(r.text); toast("已复制到剪贴板 (" + r.text.split("\n").length + " 个)", "ok"); }
  catch { $("bulk").value = r.text; $("addHeader").parentElement.classList.add("open"); toast("已填入添加框 (剪贴板不可用)", "ok"); }
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
    // 健康度徽 (与桌面 v4.7.7 同源·绿/黄/红)
    const h = r.health;
    const hb = h ? `<span class="pill health-${h.tier}" title="综合健康度 (余额/卡住/待输入)">健康 ${h.score}</span>` : "";
    counts.innerHTML = `${hb}<span class="pill run">运行 ${c.running}</span><span class="pill wait">待输入 ${c.awaiting}</span><span class="pill blk">卡住 ${c.blocked}</span>`;
    list.innerHTML = ss.length ? ss.map((s) => sessionLi(s, STATE.active)).join("") : '<li class="sess muted">无活跃对话 (运行/待输入/卡住)</li>';
  } else { list.innerHTML = ""; empty.classList.remove("hid"); toast("追踪失败: " + ((r && r.error) || ""), "err"); }
});

load();
