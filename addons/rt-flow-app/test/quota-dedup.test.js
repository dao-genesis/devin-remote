"use strict";
// 实测 devin-core.js 额度请求合并 (道法自然·功能/效率全不变·只削冗余移动流量)。
//   额度是全前台最高频的小请求: autoQuotaTick(8s·多号轮转) + autoQuotaLiveTick(2.2s) + 手动刷新
//   常在数秒内对同一号重复取额度 (全量轮与实时快轮撞点 / 手动刷新叠加轮询), 每取 = GetUserStatus +
//   billing/status 两发 → 撞点即白白重穿透。修法: 复用仓内已验证的 listSessions 短 TTL + 在途去重范式。
//   本测在真 devin-core.js 上以计数版原生桥实跑, 断言: 并发去重 / TTL 命中零穿透 / force 绕过 / 克隆隔离,
//   再加源级护栏。无框架: 直接 node test/quota-dedup.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const coreSrc = fs.readFileSync(path.join(ENGINE, "devin-core.js"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 计数版原生 HTTP 桥: 记录真实穿透次数, 据此断言"合并" ──
let reqCount = 0;
const store = Object.create(null);
const sandbox = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Math: Math, Date: Date, JSON: JSON, Promise: Promise,
  localStorage: {
    getItem: function (k) { return (k in store) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  }
};
sandbox.window = sandbox;
sandbox.Native = {
  httpReq: function (id, method, url, headersJson, body) {
    reqCount++;
    setTimeout(function () {
      var text = "{}";
      if (/GetUserStatus/.test(url)) {
        text = JSON.stringify({ userStatus: { planStatus: { planInfo: { planName: "Pro" }, dailyQuotaRemainingPercent: 50, weeklyQuotaRemainingPercent: 80 } } });
      } else if (/billing\/status/.test(url)) {
        text = JSON.stringify({ available_credits: 6.42, has_subscription_or_credits: true });
      }
      sandbox.__httpCb(id, { status: 200, text: text });
    }, 0);
  }
};
vm.createContext(sandbox);
vm.runInContext(coreSrc, sandbox);
const D = sandbox.DaoCore;
ok(!!D && typeof D.devinFetchQuota === "function", "DaoCore.devinFetchQuota 装载");

(async function () {
  const A = ["ak_test", "ws_test", "auth1_test", "org-abc", ""];   // 单号取额度参数 (statusKey=apiKey)
  const RAW = 2;   // 一次真取 = GetUserStatus(1) + billing/status(1)

  // 情形1: 三路并发同号 → 在途去重, 只穿透一发
  reqCount = 0;
  const r = await Promise.all([D.devinFetchQuota.apply(null, A), D.devinFetchQuota.apply(null, A), D.devinFetchQuota.apply(null, A)]);
  ok(reqCount === RAW, "并发同号: 在途去重 → 仅 1 发额度(2 次穿透), 实测=" + reqCount);
  ok(r[0] && r[0].overageDollars === 6.42, "并发同号: 结果正确 ($6.42)");
  ok(r[0] !== r[1] && r[1] !== r[2], "并发同号: 各调用得独立克隆 (互不串改)");

  // 情形2: TTL 内再取 → 命中短缓存, 零新穿透
  reqCount = 0;
  const b = await D.devinFetchQuota.apply(null, A);
  ok(reqCount === 0, "TTL 内再取: 命中缓存零穿透, 实测=" + reqCount);
  ok(b && b.overageDollars === 6.42, "TTL 内再取: 仍得正确额度");

  // 情形3: force=true → 绕过缓存, 真取 (手动刷新语义)
  reqCount = 0;
  await D.devinFetchQuota("ak_test", "ws_test", "auth1_test", "org-abc", "", true);
  ok(reqCount === RAW, "force 绕过缓存: 真取(2 次穿透), 实测=" + reqCount);

  // 情形4: 克隆隔离 — 改写一次返回值不污染后续缓存
  const c1 = await D.devinFetchQuota.apply(null, A);   // 命中缓存(force 刚回填)
  c1.overageDollars = 999;
  const c2 = await D.devinFetchQuota.apply(null, A);
  ok(c2.overageDollars === 6.42, "克隆隔离: 改写一次返回值不污染后续缓存");

  // 情形5: 不同号各自独立缓存, 不串号
  reqCount = 0;
  await D.devinFetchQuota("ak_other", "ws_other", "auth1_other", "org-xyz", "");
  ok(reqCount === RAW, "异号: 独立缓存键, 各自真取(不误命中他号), 实测=" + reqCount);

  // ── 源级护栏 ──
  ok(/_qCache\b/.test(coreSrc) && /_qInflight\b/.test(coreSrc), "源级: 存在 _qCache/_qInflight 去重结构");
  ok(/var _Q_TTL = 2000/.test(coreSrc), "源级: _Q_TTL=2s (短于实时快轮 2.2s → 不减实时性)");
  ok(/function devinFetchQuota\(apiKey, windsurfKey, auth1, orgId, apiServerUrl, force\)/.test(coreSrc), "源级: devinFetchQuota 增 force 绕过参数");
  ok(/仅缓存成功值/.test(coreSrc), "源级: 仅缓存成功值 (null 失败不缓存 → 下轮照常重试自愈)");
  ok(/async function refreshQuotaFor\(id, force\)/.test(coreSrc), "源级: refreshQuotaFor 透传 force");
  ok(/refreshQuotaFor\(a\.id, force\)/.test(switchSrc), "源级: switch.html autoQuotaTick 手动刷新透传 force (绕缓存取真最新)");

  if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
  console.log("\n全部通过 ✓");
})().catch(function (e) { console.error("EXC", e); process.exit(1); });
