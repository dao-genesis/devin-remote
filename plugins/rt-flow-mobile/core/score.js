// rt-flow-mobile · core/score.js — 道法自然 · 纯函数评分核心 (零依赖 · 可单测)
// ════════════════════════════════════════════════════════════════════════════
// 本文件不引用任何浏览器 / Node API, 同时被扩展 service worker (importScripts)
// 与 test/unit.test.js (require) 复用。所有「该切哪个号」的决策逻辑收束于此,
// 与 plugins/rt-flow/extension.js 的 _scoreOf / devin_cloud.js 的纯函数同源同理。
//
// 浏览器版与 IDE 版的差别: Cascade 计费看 D%/W% 配额, 而 app.devin.ai 浏览器版
// 真实可用度的唯一权威是账号 USD 余额 (GET /api/{orgId}/billing/status)。
// 故评分以余额为主轴, 复用 rt-flow 的「存量优先 / 锁中降权 / 真耗尽排除」之道。
// ════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.RtScore = api;
  if (typeof globalThis !== "undefined") globalThis.RtScore = api;
})(this, function () {
  "use strict";

  // ── 每对话使用额度上限 (移植自 rt-flow devin_cloud.js · computeConvCap) ──
  //   常态 cap = balance - buffer; 抽干模式让最后一笔钱真正用尽; 见底回 0。
  function computeConvCap(balance, buffer, drainOn, floor) {
    const b = Number(balance);
    if (!Number.isFinite(b)) return { cap: 0, drain: false };
    const buf = Math.max(0, Number(buffer) || 0);
    const flr = Math.max(0, Number(floor) || 0);
    let cap = +(b - buf).toFixed(2);
    let drain = false;
    if (drainOn && cap <= 0 && b > flr) {
      cap = +b.toFixed(2);
      drain = true;
    }
    return { cap: Math.max(0, cap), drain };
  }

  // ── 低余额预警 (移植自 rt-flow devin_cloud.js · lowBalanceVerdict) ──
  //   一次跌破只警一次, 回升后才允许再警; 余额无法判定则不警 (安全)。
  function lowBalanceVerdict(balance, threshold, prevAlerted) {
    const b = Number(balance);
    const t = Math.max(0, Number(threshold) || 0);
    if (!Number.isFinite(b)) return { alert: false, alerted: !!prevAlerted };
    if (b <= t) return { alert: !prevAlerted, alerted: true };
    return { alert: false, alerted: false };
  }

  // ── 账号是否「已彻底耗尽」: 余额 ≤ 停止阈值 → 该中停 / 切走 ──
  function isExhausted(health, stopThreshold) {
    if (!health || !health.checked) return false;
    const b = Number(health.balance);
    if (!Number.isFinite(b)) return false; // 无法判定 → 不臆断耗尽
    return b <= Math.max(0, Number(stopThreshold) || 0);
  }

  // ── 单账号评分 (移植 rt-flow _scoreOf 之道 · 余额主轴) ──
  //   返回 -Infinity = 真不可用 (不进候选池); 否则正分, 越高越优。
  //   层级:  无密码/锁 → -∞ ; 未验号 → 100 ; 已验且 balance>stop → 余额分 ;
  //          已验但 balance≤stop (真耗尽) → -∞ 。
  //   inUse (当前正登录使用中) → ×0.01 降权但保留兜底资格 (防来回震荡)。
  function scoreAccount(account, health, cfg) {
    cfg = cfg || {};
    const stop = Math.max(0, Number(cfg.stopThreshold) || 0);
    if (!account || !account.password) return -Infinity; // 无密码真无法登录
    if (account.skipAutoSwitch) return -Infinity; // 用户主动锁 · 尊重意愿
    const inUse = !!(account.email && cfg.activeEmail && account.email === cfg.activeEmail);
    const applyInUse = (s) => (inUse ? Math.max(1, Math.round(s * 0.01)) : s);
    const h = health || {};
    if (!h.checked) return inUse ? 1 : 100; // 未验号中等分 · 锁中降至 1
    const b = Number(h.balance);
    if (!Number.isFinite(b)) return inUse ? 1 : 100; // 余额未知 → 当未验
    if (b <= stop) return -Infinity; // 真耗尽 · 清出候选池
    // 余额分: 美元 ×100 (精确到分级别区分), 封顶 999900; staleMin 微调。
    let s = Math.min(999900, Math.round(b * 100));
    const stale = Number(h.staleMin);
    if (Number.isFinite(stale)) {
      if (stale >= 0 && stale < 5) s += 80;
      else if (stale >= 0 && stale < 30) s += 40;
      else if (stale < 0 || stale > 120) s -= 50;
    }
    return applyInUse(Math.max(1, s));
  }

  // ── 选出最佳下一号的索引 (移植 rt-flow getBestIndex) ──
  function pickBestIndex(accounts, healths, cfg, excludeIdx) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < accounts.length; i++) {
      if (i === excludeIdx) continue;
      const s = scoreAccount(accounts[i], healths[accounts[i].email], cfg);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  }

  // ── 按分降序返回所有可用号索引 (移植 rt-flow getSortedIndices) ──
  function sortedIndices(accounts, healths, cfg, excludeIdx) {
    const arr = [];
    for (let i = 0; i < accounts.length; i++) {
      if (i === excludeIdx) continue;
      const s = scoreAccount(accounts[i], healths[accounts[i].email], cfg);
      if (s > -Infinity) arr.push({ i, s });
    }
    arr.sort((a, b) => b.s - a.s);
    return arr.map((x) => x.i);
  }

  // ── 是否该自动切号 (汇总触发条件) ──
  //   当前号真耗尽 (余额≤停止阈值) 或 被锁 → 需要切; 且存在更优候选才真正切。
  function shouldSwitch(accounts, healths, cfg, activeIdx) {
    const active = accounts[activeIdx];
    if (!active) return { switch: false, reason: "no-active" };
    const h = healths[active.email] || {};
    const stop = Math.max(0, Number(cfg.stopThreshold) || 0);
    const exhausted = isExhausted(h, stop);
    const locked = !!active.skipAutoSwitch;
    if (!exhausted && !locked) return { switch: false, reason: "active-healthy" };
    const next = pickBestIndex(accounts, healths, cfg, activeIdx);
    if (next < 0) return { switch: false, reason: "no-candidate" };
    return { switch: true, reason: locked ? "locked" : "exhausted", nextIdx: next };
  }

  return {
    computeConvCap,
    lowBalanceVerdict,
    isExhausted,
    scoreAccount,
    pickBestIndex,
    sortedIndices,
    shouldSwitch,
  };
});
