"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// background.js · rt-flow 浏览器版 · 账号引擎 (service worker)
//
// v1.5.0 · 正本清源: 去除「自动切号」模块 —— 不再有 autoRotate / 看门狗 /
//   alarms 周期轮询 / 软耗尽自动轮转 / 紧急切换 / 账号锁候选门。
//   切号 = 用户在面板手动点击账号 → 注入登录 (与桌面 rt-flow「点击切号」同源,
//   只是落到手机浏览器: 写 DNR 鉴权头 + 通知 app.devin.ai 页面重注入 localStorage)。
//
// 保留职责 (与桌面 rt-flow 一脉, 浏览器化):
//   1. 账号池 CRUD (chrome.storage.local) · 万法识别批量添加 · 一键导出
//   2. email+password / 裸 token → auth1 登录 (DaoCloud), 12h 缓存复用
//   3. 额度普查 (billing/status) + 低余额浏览器通知 (纯监测·与切号无关)
//   4. 激活账号 → declarativeNetRequest 注入 Authorization/x-cog-org-id
//      + 通知 app.devin.ai 标签页重注入 localStorage 登录态 (手动切号即登录)
//   5. Devin Cloud: 对话追踪 / 概览 / 导出(MD+JSON 落手机) / 水过无痕 / Git 批量归一
// ═══════════════════════════════════════════════════════════════════════════
importScripts("cloud.js", "parse.js", "git.js", "relay.js");

const DNR_RULE_ID = 1001;

// 去除自动切号后, 设置仅保留「低余额浏览器通知」(纯监测, 不触发任何自动切换)。
const DEFAULT_SETTINGS = {
  notify: true, // 低余额浏览器通知
  lowBalance: 5, // 活跃账号余额 ≤ 此值($) 触发一次通知 (回升复位·复用 lowBalanceVerdict)
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
  // token 账号 (万法识别裸 token 入池) 走 loginViaToken; email+password 账号走常规登录
  const r = acct.token ? await DaoCloud.loginViaToken(acct.token) : await DaoCloud.login(acct.email, acct.password);
  if (r.ok) {
    st.authCache[key] = r;
    await set({ authCache: st.authCache });
    // 活跃账号令牌刷新后, 同步刷新 DNR 注入头与页面 localStorage 注入 —— 否则普查
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
        // 导致额度串号 (每个账号都读成活跃账号余额)。
        initiatorDomains: ["app.devin.ai"],
        resourceTypes: ["xmlhttprequest", "other", "sub_frame", "main_frame"],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// ── 手动激活账号 (= 桌面「点击切号」的手机浏览器形态): 写 active + DNR + 通知页面注入并刷新 ──
async function activate(email) {
  const r = await ensureAuth(email);
  if (!r.ok) return r;
  await set({ active: lc(email) });
  await applyDnr(r);
  await broadcastInject(r);
  return { ok: true, auth: r };
}

async function broadcastInject(auth) {
  const b = await getTabBindings();
  const tabs = await chrome.tabs.query({ url: "https://app.devin.ai/*" });
  for (const t of tabs) {
    if (b[t.id]) continue; // 绑定专属账号的 Tab 不受全局切号影响 (网页多实例·互不干扰)
    try {
      await chrome.tabs.sendMessage(t.id, {
        type: "dao-inject",
        auth1: auth.auth1, userId: auth.userId, orgId: auth.orgId, orgName: auth.orgName, email: auth.email,
        reload: true,
      });
    } catch { /* content script not ready: it will pull from storage on next load */ }
  }
}

// ── 额度普查 (低余额通知·纯监测) ──────────────────────────────────────────────
async function refreshQuota(email) {
  const r = await ensureAuth(email);
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

// 低余额浏览器通知 (一次跌破一次·守护式·chrome.notifications 缺失则静默)
function notifyLowBalance(email, balance, threshold) {
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    chrome.notifications.create("dao-lowbal-" + lc(email), {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "rt-flow · 低余额预警",
      message: email + " 余额 $" + balance + " ≤ 阈值 $" + threshold + "，建议切到其他账号。",
    });
  } catch (e) { /* 通知不可用·不阻断主流程 */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 网页多实例: per-tab 账号绑定 (一个浏览器多账号网页并行·互不干扰·民至老死不相往来)
//   每个 app.devin.ai Tab 绑定一个账号: per-tab DNR 注入该账号鉴权头 (API 隔离) +
//   content script 在该 Tab 用 sessionStorage 隔离登录态 (浏览上下文天然按 Tab 隔离)。
// ═══════════════════════════════════════════════════════════════════════════
const TAB_RULE_BASE = 1000000; // per-tab DNR 规则号基址 (避开全局 1001)

async function getTabBindings() { const s = await get(["tabBindings"]); return s.tabBindings || {}; }
async function setTabBindings(b) { await set({ tabBindings: b }); }

async function applyTabDnr(tabId, auth) {
  if (tabId == null || !auth || !auth.auth1 || !auth.orgId) return;
  // per-tab 规则必须走 session-scoped rules: «tabIds» 仅 updateSessionRules 支持
  // (updateDynamicRules 不允许 tabIds)。session 规则随浏览器会话存活·正合 Tab 生命周期。
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [TAB_RULE_BASE + tabId],
    addRules: [{
      id: TAB_RULE_BASE + tabId,
      priority: 2, // 高于全局 1001: 该 Tab 用「绑定账号」的鉴权头, 与其他 Tab 互不干扰
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "Authorization", operation: "set", value: "Bearer " + auth.auth1 },
        { header: "x-cog-org-id", operation: "set", value: auth.orgId },
      ] },
      condition: { urlFilter: "||app.devin.ai/api/", tabIds: [tabId], resourceTypes: ["xmlhttprequest", "other", "sub_frame", "main_frame"] },
    }],
  });
}
async function removeTabDnr(tabId) {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_RULE_BASE + tabId], addRules: [] }); } catch (e) {}
}

// 打开账号专属 Tab (多实例): 登录该账号 → 新开 app.devin.ai Tab → 绑定 + per-tab DNR
async function openAccountTab(email) {
  const r = await ensureAuth(email);
  if (!r.ok) return r;
  const tab = await chrome.tabs.create({ url: "https://app.devin.ai/", active: true });
  const b = await getTabBindings();
  b[tab.id] = lc(email);
  await setTabBindings(b);
  await applyTabDnr(tab.id, r);
  return { ok: true, tabId: tab.id, email: lc(email) };
}

// content script 拉「本 Tab 应注入哪个账号」: 绑定优先, 否则回退全局 active (向后兼容单账号)
async function getTabAuth(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  const st = await getState();
  const b = await getTabBindings();
  const bound = !!(tabId != null && b[tabId]);
  const email = bound ? b[tabId] : st.active;
  if (!email) return { ok: false };
  const a = st.authCache[lc(email)];
  if (authValid(a)) {
    if (bound) await applyTabDnr(tabId, a); // Tab 重载补一手 per-tab DNR, 防 SW 回收后规则缺失
    return { ok: true, bound, auth1: a.auth1, userId: a.userId, orgId: a.orgId, orgName: a.orgName, email: a.email || email };
  }
  return { ok: false, needLogin: true, bound };
}

async function closeAccountTab(tabId) {
  const b = await getTabBindings();
  delete b[tabId]; await setTabBindings(b);
  await removeTabDnr(tabId);
  try { await chrome.tabs.remove(Number(tabId)); } catch (e) {}
  return { ok: true };
}

async function listTabs() {
  const b = await getTabBindings();
  const out = [];
  for (const tabId of Object.keys(b)) {
    try { const t = await chrome.tabs.get(Number(tabId)); out.push({ tabId: Number(tabId), email: b[tabId], title: t.title || "", url: t.url || "" }); }
    catch (e) { /* Tab 已不存在: 顺手清绑定 */ delete b[tabId]; }
  }
  await setTabBindings(b);
  return { ok: true, tabs: out };
}

// Tab 关闭 → 清绑定 + 撤 per-tab DNR
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const b = await getTabBindings();
    if (b[tabId] != null) { delete b[tabId]; await setTabBindings(b); }
    await removeTabDnr(tabId);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 内网穿透: 扩展内 relay 客户端 (二合一·把穿透融入切号插件·砍掉 Termux 这条腿)
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_RELAY = { url: "", token: "", session: "", enabled: false };
async function getRelayCfg() { const s = await get(["relay"]); return Object.assign({}, DEFAULT_RELAY, s.relay || {}); }

// 可选「开箱即连」: 包内放 conn.json (中继地址/token/session) 则首次安装自动 seed 并启用穿透。
// conn.json 只随私有发行 ZIP 分发·不入仓库 (token 运行时加载·不进 manifest/源码)。
async function seedRelayFromConnJson() {
  try {
    const cur = await getRelayCfg();
    if (cur.url && cur.token && cur.session) return; // 用户已配置·绝不覆盖
    const res = await fetch(chrome.runtime.getURL("conn.json"));
    if (!res.ok) return;
    const c = await res.json();
    if (!c || !c.url || !c.token || !c.session) return;
    await set({ relay: Object.assign({}, cur, { url: c.url, token: c.token, session: c.session, enabled: c.enabled !== false }) });
  } catch (e) { /* 无 conn.json 即普通安装·静默 */ }
}

async function startRelayFromCfg() {
  if (typeof DaoRelay === "undefined") return { ok: false, error: "relay 模块未加载" };
  const cfg = await getRelayCfg();
  if (!cfg.enabled || !cfg.url || !cfg.token || !cfg.session) return { ok: false, error: "relay 未启用或配置不全 (url/token/session)" };
  DaoRelay.start({ url: cfg.url, token: cfg.token, session: cfg.session }, dispatch);
  return { ok: true, status: DaoRelay.status() };
}

// ── 统一 RPC dispatch (纯函数·popup / content / relay 客户端共用同一套 25 条 RPC) ──
// sendResponse 即 promise 的 resolve; relay.js 收到入站帧后也调本 dispatch。
function dispatch(msg) {
  return new Promise((sendResponse) => {
    (async () => {
    try {
      switch (msg && msg.type) {
        // 轻量唤醒: 长任务(全量备份等)前用它确保 SW 已就绪, 避免 MV3 冷启首条回调丢失。
        case "ping": {
          sendResponse({ ok: true, pong: true });
          break;
        }
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
            st.accounts[idx] = Object.assign({}, st.accounts[idx], { email: msg.email, password: msg.password, label: msg.label || "" });
          } else {
            st.accounts.push({ email: msg.email, password: msg.password, label: msg.label || "" });
          }
          await set({ accounts: st.accounts });
          sendResponse({ ok: true, count: st.accounts.length });
          break;
        }
        // 万法识别批量添加: 任意格式文本 → 解析 → 入池 (去重·已存在则更新密码)
        case "parseAndAdd": {
          const parsed = DaoParse.parseAccountText(msg.text || "");
          const st = await getState();
          let added = 0, updated = 0, tokensAdded = 0;
          for (const p of parsed.accounts) {
            const key = lc(p.email);
            const idx = st.accounts.findIndex((a) => lc(a.email) === key);
            if (idx >= 0) { st.accounts[idx] = Object.assign({}, st.accounts[idx], { email: p.email, password: p.password }); updated++; }
            else { st.accounts.push({ email: p.email, password: p.password, label: "" }); added++; }
          }
          // 万法识别·裸 token 入池 (与桌面 loginViaToken 一脉): 去重 by token, 合成稳定别名
          for (const tk of parsed.tokens) {
            if (st.accounts.find((a) => a.token === tk)) continue;
            st.accounts.push({ token: tk, email: "token-" + String(tk).slice(0, 10), label: "token" });
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
          try {
            const sessions = await DaoCloud.listRunningSessions(r);
            // 健康度: 复用 cloud 纯函数 healthScore (与桌面 v4.7.7 同源)·余额+卡住+待输入三维
            const st = await getState();
            const q = (st.quota || {})[email.toLowerCase()] || {};
            const blocked = sessions.filter((s) => s.statusClass === "blocked").length;
            const awaiting = sessions.filter((s) => s.statusClass === "awaiting").length;
            const health = DaoCloud.healthScore({
              balance: q.balance, balanceThreshold: (st.settings || {}).lowBalance || 5,
              stalledCount: blocked, blockedCount: awaiting,
            });
            sendResponse({ ok: true, sessions, health });
          } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 对话数据下载: 拉事件流 → MD(人看)+JSON(agent看)+HTML(直开看) — 落手机 Download
        case "exportConversation": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoCloud.exportConversation(r, msg.devinId, msg.title)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // Devin Cloud 全量备份: 当前激活账号所有会话 → 逐条 MD+JSON (落手机 Download)
        case "backupAllSessions": {
          const email = msg.email || (await getState()).active;
          if (!email) { sendResponse({ ok: false, error: "无激活账号" }); break; }
          const r = await ensureAuth(email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try {
            const ov = await DaoCloud.accountOverview(r);
            const sessions = (ov.sessions || []).filter((s) => s.devinId);
            const items = [];
            for (const s of sessions) {
              try {
                const ex = await DaoCloud.exportConversation(r, s.devinId, s.title);
                if (ex && ex.ok) items.push({ title: s.title, mdName: ex.mdName, md: ex.md, jsonName: ex.jsonName, json: ex.json, htmlName: ex.htmlName, html: ex.html, eventCount: ex.eventCount });
              } catch (e) { /* 单条失败不阻断整体 */ }
            }
            sendResponse({ ok: true, email, count: items.length, total: sessions.length, items });
          } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
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
        // 剧本下载: 用户自建剧本 → JSON 汇总 + 逐条 MD
        case "exportPlaybooks": {
          const r = await ensureAuth(msg.email);
          if (!r.ok) { sendResponse({ ok: false, error: r.error }); break; }
          try { sendResponse(await DaoCloud.exportPlaybooks(r)); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        // 中停单个运行中对话 (手动触发·对照桌面 stopSession)
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
        // 手动切号 = 激活 (注入登录 app.devin.ai)
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
        case "saveSettings": {
          const st = await getState();
          const settings = Object.assign({}, st.settings, msg.settings || {});
          await set({ settings });
          sendResponse({ ok: true, settings });
          break;
        }
        // content script 上报: 页面检测到 out_of_quota → 仅通知, 不自动切号 (手动切号原则)
        case "reportExhausted": {
          const st = await getState();
          if (st.active && st.settings.notify) {
            try {
              const q = st.quota[lc(st.active)];
              notifyLowBalance(st.active, (q && q.balance != null) ? q.balance : 0, st.settings.lowBalance);
            } catch (e) {}
          }
          sendResponse({ ok: true, notified: true, autoRotate: false });
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
        // ── 内网穿透: 扩展内 relay 客户端配置/启停/状态 (二合一) ──
        case "relayConfig": {
          if (msg.set) { const cfg = Object.assign({}, await getRelayCfg(), msg.set); await set({ relay: cfg }); sendResponse({ ok: true, relay: cfg }); }
          else sendResponse({ ok: true, relay: await getRelayCfg() });
          break;
        }
        case "relayStart": {
          const cur = await getRelayCfg();
          const cfg = Object.assign({}, cur, msg.set || {}, { enabled: true });
          await set({ relay: cfg });
          sendResponse(await startRelayFromCfg());
          break;
        }
        case "relayStop": {
          const cfg = Object.assign({}, await getRelayCfg(), { enabled: false });
          await set({ relay: cfg });
          if (typeof DaoRelay !== "undefined") DaoRelay.stop();
          sendResponse({ ok: true, status: (typeof DaoRelay !== "undefined") ? DaoRelay.status() : null });
          break;
        }
        case "relayStatus": {
          sendResponse({ ok: true, status: (typeof DaoRelay !== "undefined") ? DaoRelay.status() : null, cfg: await getRelayCfg() });
          break;
        }
        // ── 网页多实例: 打开/关闭账号专属 Tab · 列举已绑定 Tab ──
        case "openAccountTab": { sendResponse(await openAccountTab(msg.email)); break; }
        case "closeAccountTab": { sendResponse(await closeAccountTab(msg.tabId)); break; }
        case "listTabs": { sendResponse(await listTabs()); break; }
        default:
          sendResponse({ ok: false, error: "unknown message: " + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    })();
  });
}

// ── 消息监听: popup / content / panel → dispatch ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // getTabAuth 需 sender.tab.id (多实例 per-tab 注入), dispatch 拿不到 sender → 单独处理
  if (msg && msg.type === "getTabAuth") { getTabAuth(sender).then(sendResponse, () => sendResponse({ ok: false })); return true; }
  dispatch(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async
});

// 启动/安装: 恢复活跃账号 DNR + 启动 relay (若已启用) + 建保活 alarm
async function bootRestore() {
  try {
    const st = await getState();
    if (st.active) { const a = st.authCache[st.active]; if (authValid(a)) await applyDnr(a); }
  } catch (e) {}
  try { await seedRelayFromConnJson(); } catch (e) {}
  try { await startRelayFromCfg(); } catch (e) {}
  try { if (chrome.alarms && chrome.alarms.create) await chrome.alarms.create("dao-relay-keepalive", { periodInMinutes: 0.5 }); } catch (e) {}
}
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(bootRestore);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(bootRestore);
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((al) => {
    if (al && al.name === "dao-relay-keepalive") {
      getRelayCfg().then((c) => { if (c.enabled && typeof DaoRelay !== "undefined") DaoRelay.ensure(); });
    }
  });
}
bootRestore(); // SW 顶层: 被事件唤醒即恢复 (relay 重连·DNR 复原)
