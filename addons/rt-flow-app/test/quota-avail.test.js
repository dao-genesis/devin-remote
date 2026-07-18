"use strict";
// 实测 devin-core.js 余额双端点归一 (根治「KiCad/嘉立创号余额 $68 却被单话上限钉 $1」):
//   病灶: 部分 org 的真实余额挂在 billing/usage/stats 的 available_acus/balance(≈$68),
//   而 billing/status 只见小残值(≈$4) —— 旧 fetchOverageDollars 只读 status → 余额误读 $4
//   → applyConvCapFor 上限 = 4−3(缓冲) = $1。
//   修法(与桌面 devinFetchAvailDetail 同源): status 与 usage/stats 并取、各处观测取最大;
//   双双失败/无数值才回 null(上游沿用上次已知值·绝不抹 0)。
//   断言: ① overageBalance 双符号归一; ② billingDollars 求和; ③ fetchOverageDollars 双端点取最大 /
//   单端点缺失 / 双失败回 null; ④ 上限公式 bal=68 → $65 绝不塌成 $1。
// 无框架: 直接 node test/quota-avail.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const coreSrc = fs.readFileSync(path.join(ENGINE, "devin-core.js"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

function extract(src, fn, endRe) {
  const m = src.match(new RegExp("((?:async )?function " + fn + "\\([\\s\\S]*?" + endRe + ")"));
  if (!m) { console.error("FAIL: 未切出 " + fn); process.exit(1); }
  return m[1];
}

// ── 切出真代码: overageBalance + billingDollars + fetchOverageDollars ──
const body =
  extract(coreSrc, "overageBalance", "return oc;\\n  \\}") + "\n" +
  extract(coreSrc, "billingDollars", "Math\\.round\\(d \\* 100\\) / 100\\);\\n  \\}") + "\n" +
  extract(coreSrc, "fetchOverageDollars", "Math\\.round\\(best \\* 100\\) / 100\\);\\n  \\}");
const make = new Function("APP", "devinJsonGet", body +
  "\nreturn {overageBalance:overageBalance, billingDollars:billingDollars, fetchOverageDollars:fetchOverageDollars};");

function apiOf(routes) {
  return make("https://app.devin.ai", async function (url) {
    for (const k of Object.keys(routes)) if (url.indexOf(k) >= 0) return routes[k];
    return { status: 404, json: null };
  });
}

(async function () {
  const api = apiOf({});

  // ── overageBalance 双符号归一 ──
  ok(api.overageBalance(5.5, null) === 5.5, "正 overage: 直取 $5.5");
  ok(api.overageBalance(-68.2, null) === 68.2, "负 overage 无 billing_error: 幅值即余额 $68.2");
  ok(api.overageBalance(-68.2, "card_declined") === 0, "负 overage 伴 billing_error(真欠费): 计 0");
  ok(api.overageBalance(undefined, null) === 0 && api.overageBalance(NaN, null) === 0, "非数值: 计 0");

  // ── billingDollars 求和 ──
  ok(api.billingDollars({ available_credits: 4, overage_credits: 0 }) === 4, "status 求和: $4");
  ok(api.billingDollars({ available_credits: 10, overage_credits: -58 }) === 68, "负 overage 归一后求和: $68");

  // ── 病灶复现→根治: status $4 / usage-stats $68 → 取最大 $68 ──
  {
    const a = apiOf({
      "billing/status": { status: 200, json: { available_credits: 4, overage_credits: 0 } },
      "billing/usage/stats": { status: 200, json: { available_acus: 68.4, balance: 61.2 } }
    });
    const d = await a.fetchOverageDollars("auth", "org-x");
    ok(d === 68.4, "双端点取最大: status $4 vs stats $68.4 → $68.4 (不再误读 $4)");
    // 上限公式 (与 switch.html applyConvCapFor 同式): bal>buffer → bal-buffer
    const buffer = 3;
    const target = Math.round((d - buffer) * 100) / 100;
    ok(target === 65.4, "单话上限 = 68.4−3 = $65.4 (绝不塌成 $1)");
  }
  // ── stats 缺失 → 退回 status 值 ──
  {
    const a = apiOf({ "billing/status": { status: 200, json: { available_credits: 6.42, overage_credits: 0 } } });
    ok((await a.fetchOverageDollars("auth", "org-x")) === 6.42, "stats 端点缺失: 退回 status $6.42");
  }
  // ── status 失败但 stats 有值 → 取 stats ──
  {
    const a = apiOf({ "billing/usage/stats": { status: 200, json: { balance: 12.5 } } });
    ok((await a.fetchOverageDollars("auth", "org-x")) === 12.5, "status 失败: 取 stats balance $12.5");
  }
  // ── 双双失败 → null (上游沿用上次已知值·绝不抹 0) ──
  {
    const a = apiOf({});
    ok((await a.fetchOverageDollars("auth", "org-x")) === null, "双端点失败: 回 null (不抹 0)");
    ok((await a.fetchOverageDollars(null, "org-x")) === null && (await a.fetchOverageDollars("auth", null)) === null,
       "缺 auth/org: 回 null");
  }
  // ── 上限封顶 $1000 ──
  {
    const a = apiOf({ "billing/usage/stats": { status: 200, json: { available_acus: 5000 } } });
    ok((await a.fetchOverageDollars("auth", "org-x")) === 1000, "异常大值封顶 $1000");
  }

  // ── 源级护栏 ──
  ok(/billing\/usage\/stats/.test(coreSrc), "源级: devin-core 读 billing/usage/stats (与桌面同源)");
  ok(/take\(sr\.json\.available_acus\); take\(sr\.json\.balance\);/.test(coreSrc), "源级: 取 available_acus/balance 计入最大值");
  ok(/if \(best === null\) return null;/.test(coreSrc), "源级: 无任何数值回 null (绝不把未知当 0)");
  ok(/if\(bal<=buffer\)\{ target = drain \? 99999/.test(switchSrc), "源级: 余额抵缓冲时抬高解除 (不钉死小值)");

  if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
  console.log("quota-avail: all passed");
})().catch(function (e) { console.error(e); process.exit(1); });
