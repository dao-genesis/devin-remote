// rt-flow-mobile · core/store.js — 共享存储层 (天下有始, 以为天下母)
// ════════════════════════════════════════════════════════════════════════════
// chrome.storage.local 是账号池 / 健康度 / 当前号的唯一真源 (母)。
// service worker 引擎与 popup 面板皆从此读写 (子守母), 故面板渲染与简单增删
// 不依赖 service worker 是否唤醒 —— 无为而状态自现。
// 依赖 core/score.js (self.RtScore) 计算展示快照。
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  "use strict";
  const S = root.RtScore;

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

  async function removeAccount(email) {
    const accounts = (await get(K.accounts, [])).filter((a) => a.email !== email);
    await set({ [K.accounts]: accounts });
    return accounts;
  }

  async function toggleLock(email) {
    const accounts = await get(K.accounts, []);
    const a = accounts.find((x) => x.email === email);
    if (a) a.skipAutoSwitch = !a.skipAutoSwitch;
    await set({ [K.accounts]: accounts });
    return accounts;
  }

  // ── 状态快照 (面板渲染用 · 纯读 storage, 不经 service worker) ──
  async function buildSnapshot() {
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

  const api = { K, DEFAULTS, get, set, settings, parseAccounts, addAccounts, removeAccount, toggleLock, buildSnapshot };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.RtStore = api;
})(typeof self !== "undefined" ? self : this);
