// rt-flow-mobile · background.js — service worker · 切号引擎 (无为而无不为)
// ════════════════════════════════════════════════════════════════════════════
// 账号池管理 + 登录拿 auth1 + 余额监控 + 自动切到下一健康号。
// 切号语义与 plugins/rt-flow/extension.js 等价, 决策逻辑收束于 core/score.js。
// ════════════════════════════════════════════════════════════════════════════
importScripts("core/score.js", "core/devin_cloud.js");

const S = self.RtScore;
const Cloud = self.RtCloud;

const DEFAULTS = {
  autoSwitch: true,
  stopThreshold: 3, // 余额 ≤ $3 视为耗尽 → 切走
  buffer: 3, // 每对话上限缓冲
  pollActiveSec: 30, // 有运行/余额下降时的轮询间隔
  pollIdleMin: 30, // 空闲轮询间隔
  drainOn: true,
  floor: 1,
  lowBalanceWarn: 5,
};

const K = {
  accounts: "rtflow.accounts", // [{email,password,skipAutoSwitch,label}]
  healths: "rtflow.healths", // {email: {balance,checked,staleMin,ts}}
  active: "rtflow.active", // {email,auth1,userId,orgId,orgName,ts}
  settings: "rtflow.settings",
  alerted: "rtflow.alerted", // {email: bool}
};

async function get(key, fallback) {
  const r = await chrome.storage.local.get([key]);
  return r[key] === undefined ? fallback : r[key];
}
async function set(obj) {
  await chrome.storage.local.set(obj);
}
async function settings() {
  return Object.assign({}, DEFAULTS, await get(K.settings, {}));
}

// ── 账号池解析 (任意格式粘贴 · 每行 email + password) ──
function parseAccounts(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/([^\s:,;|]+@[^\s:,;|]+)[\s:,;|]+(\S+)/);
    if (!m) continue;
    const email = m[1].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, password: m[2], skipAutoSwitch: false, label: "" });
  }
  return out;
}

async function addAccounts(text) {
  const parsed = parseAccounts(text);
  const accounts = await get(K.accounts, []);
  const byEmail = new Map(accounts.map((a) => [a.email, a]));
  for (const a of parsed) byEmail.set(a.email, Object.assign(byEmail.get(a.email) || {}, a));
  const merged = Array.from(byEmail.values());
  await set({ [K.accounts]: merged });
  return merged;
}

// ── 验证单账号: 登录 + 取余额 → 写 health ──
async function verifyAccount(account) {
  const healths = await get(K.healths, {});
  const r = await Cloud.login(account.email, account.password);
  if (!r.ok) {
    healths[account.email] = { balance: null, checked: true, error: r.error, staleMin: 0, ts: Date.now() };
    await set({ [K.healths]: healths });
    return { ok: false, error: r.error };
  }
  const bal = await Cloud.getBalance(r);
  healths[account.email] = { balance: bal.balance, checked: true, staleMin: 0, ts: Date.now() };
  await set({ [K.healths]: healths });
  return { ok: true, auth: r, balance: bal.balance };
}

async function verifyAll() {
  const accounts = await get(K.accounts, []);
  for (const a of accounts) {
    if (!a.password) continue;
    try { await verifyAccount(a); } catch (e) { /* 单号失败不毁全局 */ }
  }
  return await snapshot();
}

// ── 切到指定账号: 确保登录态 → 写 active → 通知标签页重载 ──
async function switchTo(email) {
  const accounts = await get(K.accounts, []);
  const account = accounts.find((a) => a.email === email);
  if (!account) return { ok: false, error: "account not found" };
  const v = await verifyAccount(account);
  if (!v.ok) return { ok: false, error: v.error };
  const active = {
    email: account.email,
    auth1: v.auth.auth1,
    userId: v.auth.userId,
    orgId: v.auth.orgId,
    orgName: v.auth.orgName,
    ts: Date.now(),
  };
  await set({ [K.active]: active });
  // 通知所有 app.devin.ai 标签页以新账号重注入并重载
  const tabs = await chrome.tabs.query({ url: "https://app.devin.ai/*" });
  for (const t of tabs) {
    try { await chrome.tabs.sendMessage(t.id, { type: "rtflow:switched", active }); } catch {}
  }
  await schedulePoll();
  return { ok: true, active };
}

// ── 引擎一拍: 检查当前号健康度 → 该切则切 ──
async function tick() {
  const cfg = await settings();
  if (!cfg.autoSwitch) return;
  const accounts = await get(K.accounts, []);
  const healths = await get(K.healths, {});
  const active = await get(K.active, null);
  if (!accounts.length) return;
  const activeIdx = active ? accounts.findIndex((a) => a.email === active.email) : -1;

  // 刷新当前号余额 (轻量)
  if (active && active.auth1) {
    try {
      const bal = await Cloud.getBalance(active);
      if (bal.balance !== null) {
        healths[active.email] = Object.assign(healths[active.email] || {}, { balance: bal.balance, checked: true, staleMin: 0, ts: Date.now() });
        await set({ [K.healths]: healths });
        await maybeWarn(active.email, bal.balance, cfg);
      }
    } catch {}
  }

  const scoreCfg = { stopThreshold: cfg.stopThreshold, activeEmail: active ? active.email : "" };
  const verdict = S.shouldSwitch(accounts, healths, scoreCfg, activeIdx);
  if (verdict.switch && verdict.nextIdx >= 0) {
    const next = accounts[verdict.nextIdx];
    notify("自动切号", "当前号 " + (active ? active.email : "-") + " (" + verdict.reason + ") → " + next.email);
    await switchTo(next.email);
  }
}

async function maybeWarn(email, balance, cfg) {
  const alerted = await get(K.alerted, {});
  const v = S.lowBalanceVerdict(balance, cfg.lowBalanceWarn, !!alerted[email]);
  alerted[email] = v.alerted;
  await set({ [K.alerted]: alerted });
  if (v.alert) notify("低余额预警", email + " 余额 $" + Number(balance).toFixed(2));
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "RT Flow · " + title, message });
  } catch {}
}

// ── 轮询调度 (alarms) ──
async function schedulePoll() {
  const cfg = await settings();
  const healths = await get(K.healths, {});
  const active = await get(K.active, null);
  const h = active ? healths[active.email] : null;
  // 确认使用中 (余额低于预警线) → 提速; 否则空闲降速
  const activeMode = h && typeof h.balance === "number" && h.balance <= cfg.lowBalanceWarn * 2;
  const periodMin = activeMode ? Math.max(0.5, cfg.pollActiveSec / 60) : Math.max(1, cfg.pollIdleMin);
  await chrome.alarms.clear("rtflow.poll");
  chrome.alarms.create("rtflow.poll", { periodInMinutes: periodMin });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "rtflow.poll") tick().then(schedulePoll).catch(() => {});
});

// ── 状态快照 (popup 用) ──
async function snapshot() {
  const accounts = await get(K.accounts, []);
  const healths = await get(K.healths, {});
  const active = await get(K.active, null);
  const cfg = await settings();
  const scoreCfg = { stopThreshold: cfg.stopThreshold, activeEmail: active ? active.email : "" };
  const rows = accounts.map((a) => {
    const h = healths[a.email] || {};
    const cap = S.computeConvCap(h.balance, cfg.buffer, cfg.drainOn, cfg.floor);
    return {
      email: a.email,
      label: a.label || "",
      locked: !!a.skipAutoSwitch,
      balance: h.balance === undefined ? null : h.balance,
      checked: !!h.checked,
      error: h.error || "",
      score: S.scoreAccount(a, h, scoreCfg),
      convCap: cap.cap,
      drain: cap.drain,
      active: !!(active && active.email === a.email),
    };
  });
  rows.sort((x, y) => y.score - x.score);
  return { accounts: rows, active: active ? active.email : null, settings: cfg };
}

// ── popup ↔ background 消息 ──
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "rtflow:state": reply(await snapshot()); break;
        case "rtflow:add": await addAccounts(msg.text); reply(await snapshot()); break;
        case "rtflow:remove": {
          const accounts = (await get(K.accounts, [])).filter((a) => a.email !== msg.email);
          await set({ [K.accounts]: accounts });
          reply(await snapshot());
          break;
        }
        case "rtflow:lock": {
          const accounts = await get(K.accounts, []);
          const a = accounts.find((x) => x.email === msg.email);
          if (a) a.skipAutoSwitch = !a.skipAutoSwitch;
          await set({ [K.accounts]: accounts });
          reply(await snapshot());
          break;
        }
        case "rtflow:verifyAll": reply(await verifyAll()); break;
        case "rtflow:switch": { await switchTo(msg.email); reply(await snapshot()); break; }
        case "rtflow:switchNext": {
          const accounts = await get(K.accounts, []);
          const healths = await get(K.healths, {});
          const active = await get(K.active, null);
          const cfg = await settings();
          const activeIdx = active ? accounts.findIndex((a) => a.email === active.email) : -1;
          const next = S.pickBestIndex(accounts, healths, { stopThreshold: cfg.stopThreshold, activeEmail: active ? active.email : "" }, activeIdx);
          if (next >= 0) await switchTo(accounts[next].email);
          reply(await snapshot());
          break;
        }
        case "rtflow:setSettings": {
          await set({ [K.settings]: Object.assign(await get(K.settings, {}), msg.patch || {}) });
          await schedulePoll();
          reply(await snapshot());
          break;
        }
        default: reply({ error: "unknown" });
      }
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
    }
  })();
  return true; // async reply
});

chrome.runtime.onInstalled.addListener(() => { schedulePoll(); });
chrome.runtime.onStartup.addListener(() => { schedulePoll(); });
