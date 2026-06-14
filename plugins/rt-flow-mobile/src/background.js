"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// background.js · rt-flow 浏览器版 · 切号引擎 (service worker)
//
// 职责 (对应 rt-flow extension.js 的 rotate/评分/看门狗, 浏览器化精简):
//   1. 账号池 CRUD (chrome.storage.local)
//   2. email+password → auth1 登录 (DaoCloud.login), 12h 缓存复用 (无为·不重复登录)
//   3. 额度普查 (billing/status) + 评分 + rotate() 自动切换
//   4. 激活账号 → declarativeNetRequest 动态规则注入 Authorization/x-cog-org-id
//      + 通知 app.devin.ai 标签页重注入 localStorage 登录态
//   5. alarms 周期轮询: 活跃账号余额 ≤ 缓冲 → 自动切到最优账号 (软耗尽轮转)
// ═══════════════════════════════════════════════════════════════════════════
importScripts("cloud.js");

const DNR_RULE_ID = 1001;
const ALARM = "dao-rtflow-poll";

const DEFAULT_SETTINGS = {
  autoSwitch: true, // 软耗尽自动轮转
  buffer: 3, // 余额 ≤ buffer($) 视为软耗尽 → 触发切换 (知止不殆)
  floor: 1, // 余额 ≤ floor 视为硬见底
  pollMin: 2, // 轮询间隔 (分钟)
};

// ── storage helpers ────────────────────────────────────────────────────────
function get(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }
function set(obj) { return new Promise((r) => chrome.storage.local.set(obj, r)); }
const lc = (s) => String(s || "").toLowerCase();

async function getState() {
  const s = await get(["accounts", "authCache", "active", "quota", "settings"]);
  return {
    accounts: s.accounts || [],
    authCache: s.authCache || {},
    active: s.active || "",
    quota: s.quota || {},
    settings: Object.assign({}, DEFAULT_SETTINGS, s.settings || {}),
  };
}

function authValid(a) {
  return a && a.auth1 && a.orgId && Date.now() - (a.ts || 0) < DaoCloud.CFG.authTtlMs;
}

// ── 登录 (缓存优先) ──────────────────────────────────────────────────────────
async function ensureAuth(email, force) {
  const st = await getState();
  const key = lc(email);
  const acct = st.accounts.find((a) => lc(a.email) === key);
  if (!acct) return { ok: false, error: "账号不在池中: " + email };
  const cached = st.authCache[key];
  if (!force && authValid(cached)) return Object.assign({ ok: true, cached: true }, cached);
  const r = await DaoCloud.login(acct.email, acct.password);
  if (r.ok) {
    st.authCache[key] = r;
    await set({ authCache: st.authCache });
  }
  return r;
}

// ── declarativeNetRequest: 给 app.devin.ai 请求注入鉴权头 (代理 fetch override 的浏览器原生等价) ──
async function applyDnr(auth) {
  const removeRuleIds = [DNR_RULE_ID];
  const addRules = [];
  if (auth && auth.auth1 && auth.orgId) {
    addRules.push({
      id: DNR_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Authorization", operation: "set", value: "Bearer " + auth.auth1 },
          { header: "x-cog-org-id", operation: "set", value: auth.orgId },
        ],
      },
      condition: {
        urlFilter: "||app.devin.ai/api/",
        resourceTypes: ["xmlhttprequest", "other", "sub_frame", "main_frame"],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// ── 激活账号: 写 active + DNR + 通知标签页注入并刷新 ─────────────────────────
async function activate(email) {
  const r = await ensureAuth(email);
  if (!r.ok) return r;
  await set({ active: lc(email) });
  await applyDnr(r);
  await broadcastInject(r);
  return { ok: true, auth: r };
}

async function broadcastInject(auth) {
  const tabs = await chrome.tabs.query({ url: "https://app.devin.ai/*" });
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, {
        type: "dao-inject",
        auth1: auth.auth1, userId: auth.userId, orgId: auth.orgId, orgName: auth.orgName, email: auth.email,
        reload: true,
      });
    } catch { /* content script not ready: it will pull from storage on next load */ }
  }
}

// ── 额度普查 + 评分 ──────────────────────────────────────────────────────────
async function refreshQuota(email) {
  const r = await ensureAuth(email);
  if (!r.ok) return { ok: false, error: r.error };
  const b = await DaoCloud.getBilling(r);
  const balance = b.ok ? DaoCloud.billingBalance(b.raw) : null;
  const st = await getState();
  st.quota[lc(email)] = { balance, raw: b.raw || null, ts: Date.now(), status: b.ok ? "ok" : ("HTTP " + b.status) };
  await set({ quota: st.quota });
  return { ok: true, balance };
}

// 评分: 余额越高越优; 无法判定(null)给低分但高于不可用; 不可用(登录失败)=-Infinity
function scoreOf(quota) {
  if (!quota) return -1; // 未知额度
  if (quota.balance == null) return -1;
  return quota.balance;
}

// rotate: 选出当前账号之外评分最高者 (强者道之用·择优轮转)
async function rotate(reason) {
  const st = await getState();
  if (st.accounts.length === 0) return { ok: false, error: "账号池为空" };
  // 先刷新所有账号额度 (轻量·已缓存登录态者不重登)
  for (const a of st.accounts) await refreshQuota(a.email).catch(() => {});
  const fresh = await getState();
  const ranked = fresh.accounts
    .map((a) => ({ email: lc(a.email), score: scoreOf(fresh.quota[lc(a.email)]) }))
    .sort((x, y) => y.score - x.score);
  const best = ranked.find((r) => r.email !== fresh.active) || ranked[0];
  if (!best) return { ok: false, error: "无可切换账号" };
  const res = await activate(best.email);
  return { ok: res.ok, switchedTo: best.email, reason: reason || "manual", ranked };
}

// 软耗尽检查: 活跃账号余额 ≤ buffer → 自动 rotate
async function autoSwitchTick() {
  const st = await getState();
  if (!st.settings.autoSwitch || !st.active) return;
  const q = await refreshQuota(st.active);
  if (!q.ok) return;
  const bal = q.balance;
  if (bal != null && bal <= st.settings.buffer) {
    await rotate("软耗尽(余额 $" + bal + " ≤ 缓冲 $" + st.settings.buffer + ")");
  }
}

// ── 消息路由 (popup / content 调用) ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "getState": {
          const st = await getState();
          sendResponse({ ok: true, ...st });
          break;
        }
        case "addAccount": {
          const st = await getState();
          const key = lc(msg.email);
          if (!msg.email || !msg.password) { sendResponse({ ok: false, error: "邮箱/密码必填" }); break; }
          const idx = st.accounts.findIndex((a) => lc(a.email) === key);
          const entry = { email: msg.email, password: msg.password, label: msg.label || "" };
          if (idx >= 0) st.accounts[idx] = entry; else st.accounts.push(entry);
          await set({ accounts: st.accounts });
          sendResponse({ ok: true, count: st.accounts.length });
          break;
        }
        case "removeAccount": {
          const st = await getState();
          const key = lc(msg.email);
          st.accounts = st.accounts.filter((a) => lc(a.email) !== key);
          delete st.authCache[key]; delete st.quota[key];
          if (st.active === key) st.active = "";
          await set({ accounts: st.accounts, authCache: st.authCache, quota: st.quota, active: st.active });
          if (!st.active) await applyDnr(null);
          sendResponse({ ok: true });
          break;
        }
        case "login": {
          const r = await ensureAuth(msg.email, msg.force);
          sendResponse(r.ok ? { ok: true, email: r.email, orgId: r.orgId, userId: r.userId } : r);
          break;
        }
        case "activate": {
          sendResponse(await activate(msg.email));
          break;
        }
        case "refreshQuota": {
          sendResponse(await refreshQuota(msg.email));
          break;
        }
        case "refreshAllQuota": {
          const st = await getState();
          for (const a of st.accounts) await refreshQuota(a.email).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case "rotate": {
          sendResponse(await rotate("manual"));
          break;
        }
        case "saveSettings": {
          const st = await getState();
          const settings = Object.assign({}, st.settings, msg.settings || {});
          await set({ settings });
          await scheduleAlarm(settings);
          sendResponse({ ok: true, settings });
          break;
        }
        // content script 主动上报: 页面检测到 out_of_quota → 立即轮转
        case "reportExhausted": {
          const st = await getState();
          if (st.settings.autoSwitch) {
            const r = await rotate("页面上报额度耗尽");
            sendResponse(r);
          } else sendResponse({ ok: false, error: "autoSwitch off" });
          break;
        }
        // content script 拉取当前激活账号注入数据 (document_start 时)
        case "getActiveAuth": {
          const st = await getState();
          if (!st.active) { sendResponse({ ok: false }); break; }
          const a = st.authCache[st.active];
          if (authValid(a)) sendResponse({ ok: true, auth1: a.auth1, userId: a.userId, orgId: a.orgId, orgName: a.orgName, email: a.email });
          else sendResponse({ ok: false, needLogin: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message: " + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async
});

// ── alarms ───────────────────────────────────────────────────────────────────
async function scheduleAlarm(settings) {
  const s = settings || (await getState()).settings;
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, s.pollMin || 2) });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) autoSwitchTick(); });

chrome.runtime.onInstalled.addListener(async () => {
  const st = await getState();
  await scheduleAlarm(st.settings);
  if (st.active) { const a = st.authCache[st.active]; if (authValid(a)) await applyDnr(a); }
});
chrome.runtime.onStartup.addListener(async () => {
  const st = await getState();
  await scheduleAlarm(st.settings);
  if (st.active) { const a = st.authCache[st.active]; if (authValid(a)) await applyDnr(a); }
});
