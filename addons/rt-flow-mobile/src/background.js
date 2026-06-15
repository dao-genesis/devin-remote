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
importScripts("cloud.js", "parse.js", "git.js");

const DNR_RULE_ID = 1001;
const ALARM = "dao-rtflow-poll";

const DEFAULT_SETTINGS = {
  autoSwitch: true, // 软耗尽自动轮转
  buffer: 3, // 余额 ≤ buffer($) 视为软耗尽 → 触发切换 (知止不殆)
  pollMin: 2, // 轮询间隔 (分钟)
  lockByDefault: true, // 反者道之动·默锁: 新号缺省🔒锁定(禁自动切到), 用户🔓解锁后才入候选 (防误切·与本体 wam.lockByDefault 一脉)
  notify: true, // 低余额浏览器通知
  lowBalance: 5, // 余额 ≤ 此值($) 触发一次低余额通知 (回升复位·复用 lowBalanceVerdict)
  autoStop: false, // 自动停止: 软耗尽弃号前中停旧号运行中对话 (默关·避免误停, 与本体 ConvQuotaCap 一脉)
  stopThreshold: 3, // 余额 ≤ 此值($) 才自动停止旧号运行中对话 (知止不殆)
};

// 账号有效锁定态: 无显式 locked 记录时按 lockByDefault 决定 (与本体 v4.6.0 反转语义同源)
function effLocked(a, settings) {
  if (!a) return false;
  if (a.locked === true || a.locked === false) return a.locked;
  return !!(settings && settings.lockByDefault);
}

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
  // token 账号 (万法识别裸 token 入池) 走 loginViaToken; email+password 账号走常规登录
  const r = acct.token ? await DaoCloud.loginViaToken(acct.token) : await DaoCloud.login(acct.email, acct.password);
  if (r.ok) {
    st.authCache[key] = r;
    await set({ authCache: st.authCache });
    // 活跃账号令牌刷新后, 同步刷新 DNR 注入头与页面 localStorage 注入 —— 否则普查/轮询
    // 触发的重登只更新了 authCache, 页面仍用过期 auth1, 自动登录会静默 401 失效。
    if (key === lc(st.active)) { await applyDnr(r); await broadcastInject(r); }
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
        // 只改写「由 app.devin.ai 页面发起」的请求; 扩展自身 service worker 的 fetch
        // (getBilling 等) 不在此列 —— 否则各账号额度普查会被活跃账号的鉴权头覆盖,
        // 导致额度串号 (每个账号都读成活跃账号余额), 令 rotate 评分失真。
        initiatorDomains: ["app.devin.ai"],
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
  // 登录失败也要落账 (status: 登录失败) —— 否则该号无 quota 记录, 评分按"未普查"给 -1
  // 而非排除, rotate 仍可能切到登不上的号。如实记录失败态 → scoreOf 给 -Infinity 真排除。
  if (!r.ok) {
    const st = await getState();
    st.quota[lc(email)] = { balance: null, raw: null, ts: Date.now(), status: "登录失败" };
    await set({ quota: st.quota });
    return { ok: false, error: r.error };
  }
  const b = await DaoCloud.getBilling(r);
  const balance = b.ok ? DaoCloud.billingBalance(b.raw) : null;
  const reset = b.ok ? DaoCloud.quotaResetInfo(b.raw) : null;
  const tokenShort = r.auth1 ? String(r.auth1).slice(0, 14) + "…" : "";
  const st = await getState();
  const key = lc(email);
  // 低余额预警 (复用 cloud 纯函数 lowBalanceVerdict·一次跌破一次·回升复位)
  const prevAlerted = !!(st.quota[key] && st.quota[key].alerted);
  const verdict = DaoCloud.lowBalanceVerdict(balance, st.settings.lowBalance, prevAlerted);
  st.quota[key] = { balance, raw: b.raw || null, ts: Date.now(), status: b.ok ? "ok" : ("HTTP " + b.status), reset, tokenShort, alerted: verdict.alerted };
  await set({ quota: st.quota });
  if (verdict.alert && st.settings.notify) notifyLowBalance(email, balance, st.settings.lowBalance);
  return { ok: true, balance };
}

// 评分 (与 rt-flow 本体「不可用号不入候选」一脉): 余额越高越优;
//   · 普查失败/登录失败 (status 非 "ok") → -Infinity, 真排除 — rotate 绝不切到登不上的号;
//   · 已普查但余额无法判定 (balance==null) → -1, 低分兜底但仍可选;
//   · 从未普查 (无 quota) → -1, 同上。
function scoreOf(quota) {
  if (!quota) return -1; // 未普查
  if (quota.status && quota.status !== "ok") return -Infinity; // 登录/普查失败 → 排除
  if (quota.balance == null) return -1; // 已普查但额度未知
  return quota.balance;
}

// rotate: 切到评分最高的「未锁定」账号 (择优轮转)。当前账号已是最优(或并列最优)则不切 ——
// 不能像旧逻辑那样"排除当前账号取次高", 否则当前已最优时反会切到更差的账号。
//   锁定账号(🔒)不入自动切候选 (反者道之动·防误切到主用号); 全锁定时返回 noop 而非红错。
async function rotate(reason) {
  const st = await getState();
  if (st.accounts.length === 0) return { ok: false, error: "账号池为空" };
  // 先刷新所有账号额度 (轻量·已缓存登录态者不重登)
  for (const a of st.accounts) await refreshQuota(a.email).catch(() => {});
  const fresh = await getState();
  const ranked = fresh.accounts
    .filter((a) => !effLocked(a, fresh.settings)) // 锁定号不入自动切候选
    .map((a) => ({ email: lc(a.email), score: scoreOf(fresh.quota[lc(a.email)]) }))
    .sort((x, y) => y.score - x.score);
  const activeKey = lc(fresh.active || "");
  const activeScore = activeKey ? scoreOf(fresh.quota[activeKey]) : -Infinity;
  const best = ranked[0];
  // v4.6.1 一脉: 无未锁定候选 = 预期(均🔒锁定), 非错误; 面板🔓解锁后启用自动切号
  if (!best) {
    return { ok: true, switchedTo: activeKey, reason: reason || "manual", ranked, noop: true, allLocked: true };
  }
  // 仅当存在「严格更优」的账号时才切, 避免在并列最优间反复横跳
  if (best.score <= activeScore) {
    return { ok: true, switchedTo: activeKey, reason: reason || "manual", ranked, noop: true };
  }
  // 自动停止 (知止不殆): 弃旧号前, 若旧号余额 ≤ stopThreshold 则中停其运行中对话, 防弃号后仍在烧额度。
  let stopped = null;
  if (fresh.settings.autoStop && activeKey && activeScore !== -Infinity && activeScore <= fresh.settings.stopThreshold) {
    try { const ra = await ensureAuth(activeKey); if (ra.ok) stopped = await DaoCloud.stopRunningSessions(ra); } catch (e) { /* 停止失败不阻断切号 */ }
  }
  const res = await activate(best.email);
  return { ok: res.ok, switchedTo: best.email, reason: reason || "manual", ranked, stopped };
}

// 紧急切换 (与本体 panicSwitch/rotateNext 一脉): 立即弃用当前号, 切到「其他·未锁定·可登录」中
// 评分最高者 (忽略缓冲阈值·不要求严格更优) —— 当前号被卡死/异常时人工应急逃生。
async function panicSwitch() {
  const st = await getState();
  if (st.accounts.length === 0) return { ok: false, error: "账号池为空" };
  for (const a of st.accounts) await refreshQuota(a.email).catch(() => {});
  const fresh = await getState();
  const activeKey = lc(fresh.active || "");
  const cands = fresh.accounts
    .filter((a) => lc(a.email) !== activeKey && !effLocked(a, fresh.settings) && scoreOf(fresh.quota[lc(a.email)]) > -Infinity)
    .map((a) => ({ email: lc(a.email), score: scoreOf(fresh.quota[lc(a.email)]) }))
    .sort((x, y) => y.score - x.score);
  if (!cands.length) return { ok: false, error: "无其他可切换账号 (可能均🔒锁定或登录失败)" };
  const res = await activate(cands[0].email);
  return { ok: res.ok, switchedTo: cands[0].email, reason: "紧急切换", ranked: cands };
}

// 低余额浏览器通知 (一次跌破一次·守护式·chrome.notifications 缺失则静默)
function notifyLowBalance(email, balance, threshold) {
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    chrome.notifications.create("dao-lowbal-" + lc(email), {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "rt-flow · 低余额预警",
      message: email + " 余额 $" + balance + " ≤ 阈值 $" + threshold + "，建议补充或切号。",
    });
  } catch (e) { /* 通知不可用·不阻断主流程 */ }
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
          if (idx >= 0) {
            // 更新: 保留既有锁定态
            st.accounts[idx] = Object.assign({}, st.accounts[idx], { email: msg.email, password: msg.password, label: msg.label || "" });
          } else {
            st.accounts.push({ email: msg.email, password: msg.password, label: msg.label || "", locked: !!st.settings.lockByDefault });
          }
          await set({ accounts: st.accounts });
          sendResponse({ ok: true, count: st.accounts.length });
          break;
        }
        // 万法识别批量添加: 任意格式文本 → 解析 → 入池 (去重·已存在则更新密码)
        case "parseAndAdd": {
          const parsed = DaoParse.parseAccountText(msg.text || "");
          const st = await getState();
          const lockDefault = !!st.settings.lockByDefault;
          let added = 0, updated = 0, tokensAdded = 0;
          for (const p of parsed.accounts) {
            const key = lc(p.email);
            const idx = st.accounts.findIndex((a) => lc(a.email) === key);
            if (idx >= 0) { st.accounts[idx] = Object.assign({}, st.accounts[idx], { email: p.email, password: p.password }); updated++; }
            else { st.accounts.push({ email: p.email, password: p.password, label: "", locked: lockDefault }); added++; }
          }
          // 万法识别·裸 token 入池 (与本体 loginViaToken 一脉): 去重 by token, 合成稳定别名
          for (const tk of parsed.tokens) {
            if (st.accounts.find((a) => a.token === tk)) continue;
            st.accounts.push({ token: tk, email: "token-" + String(tk).slice(0, 10), label: "token", locked: lockDefault });
            tokensAdded++;
          }
          await set({ accounts: st.accounts });
          sendResponse({ ok: true, added, updated, total: st.accounts.length, parsed: parsed.accounts.length, tokens: tokensAdded });
          break;
        }
        // 一键导出: 账号池 → 可再粘贴文本
        case "exportAccounts": {
          const st = await getState();
          sendResponse({ ok: true, text: DaoParse.exportAccountsText(st.accounts) });
          break;
        }
        // 账号本源概览 (对话/知识库/剧本/密钥/Git/额度)
        case "accountOverview": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse({ ok: true, overview: await DaoCloud.accountOverview(r) }); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 对话追踪: 当前激活账号的活跃会话 (运行/待输入/卡住)
        case "runningSessions": {
          const email = msg.email || (await getState()).active;
          if (!email) { sendResponse({ ok: false, error: "无激活账号" }); break; }
          const r = await ensureAuth(email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse({ ok: true, sessions: await DaoCloud.listRunningSessions(r) }); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 对话数据下载: 拉事件流 → MD(人看)+JSON(agent看)
        case "exportConversation": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoCloud.exportConversation(r, msg.devinId, msg.title)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 知识库下载: 全部学习资源 → JSON 汇总 + 逐条 MD
        case "exportKnowledge": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoCloud.exportKnowledge(r)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 剧本下载: 用户自建剧本 → JSON 汇总 + 逐条 MD (对照本体 board·剧本)
        case "exportPlaybooks": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoCloud.exportPlaybooks(r)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 中停单个运行中对话 (自动停止·手动触发·对照本体 stopSession)
        case "stopSession": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoCloud.stopSession(r, msg.devinId)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // Git 状态快照 (只读)
        case "gitStatus": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse({ ok: true, git: await DaoGit.gitStatus(r) }); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // PAT 连接/归一 (单账号)
        case "gitConnectPat": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoGit.connectWithPat(r, (msg.pat || "").trim())); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 批量归一: 同一 PAT 套用到全部(或指定)账号
        case "gitBatchConnectPat": {
          const pat = (msg.pat || "").trim();
          if (!pat) { sendResponse({ ok: false, error: "无 PAT" }); break; }
          const st = await getState();
          const emails = (msg.emails && msg.emails.length) ? msg.emails : st.accounts.map((a) => a.email);
          const results = [];
          for (const email of emails) {
            const r = await ensureAuth(email);
            if (!r.ok) { results.push({ email, ok: false, error: r.error }); continue; }
            try { const g = await DaoGit.connectWithPat(r, pat); results.push({ email, ok: g.ok, login: g.login, repoCount: g.repoCount, error: g.error }); }
            catch (e) { results.push({ email, ok: false, error: String((e && e.message) || e) }); }
          }
          sendResponse({ ok: true, results, total: emails.length, succeeded: results.filter((x) => x.ok).length });
          break;
        }
        // 断开 Git
        case "gitDisconnect": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoGit.robustDisconnectGit(r)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 水过无痕: 扫描 (dryRun) / 执行清理
        case "wipeAccount": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try {
            const report = await DaoCloud.wipeAccount(r, { dryRun: !!msg.dryRun });
            if (!msg.dryRun) { try { await DaoGit.robustDisconnectGit(r); } catch (e) {} }
            sendResponse({ ok: true, report });
          } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
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
        // 紧急切换: 立即弃用当前号, 切到其他未锁定最优号
        case "panicSwitch": {
          sendResponse(await panicSwitch());
          break;
        }
        // 账号锁: 🔒锁定/🔓解锁 (locked=true/false 显式两态·缺省由 lockByDefault 决定)
        case "lockAccount": {
          const st = await getState();
          const key = lc(msg.email);
          const idx = st.accounts.findIndex((a) => lc(a.email) === key);
          if (idx < 0) { sendResponse({ ok: false, error: "账号不在池中" }); break; }
          st.accounts[idx] = Object.assign({}, st.accounts[idx], { locked: !!msg.locked });
          await set({ accounts: st.accounts });
          sendResponse({ ok: true, locked: !!msg.locked });
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
