"use strict";
// 实测 devin-core.js 金额自愈真代码 (问题①: 金额误显 $0 / 跳成很老的空值)。
//   逆流到底层: 美金余额(Extra Usage)走 billing/status, billing 瞬时失败时 fetchOverageDollars 回 null
//   → 旧逻辑把余额当 0 / 抹空 → 误显 $0 (实际有额度) 或 跳老空值。
//   修复: devinFetchQuota 用 overageKnown 显式标注「本轮是否真取到美金余额」; refreshQuotaFor 在
//   overageKnown!==true 时沿用上次已知 overageDollars (标 stale), 取到才覆盖。
//   切出 refreshQuotaFor 里的「金额自愈」判定块 eval 实跑, 断言三类情形 + 源级护栏。
// 无框架: 直接 node test/quota-carry.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const coreSrc = fs.readFileSync(path.join(ENGINE, "devin-core.js"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 切出「金额自愈」判定块: 从 `if (q.overageKnown !== true` 到其闭合 `}`。
const seg = coreSrc.match(/if \(q\.overageKnown !== true && acc\.quota[\s\S]*?\n      \}/);
if (!seg) { console.error("FAIL: 未找到 refreshQuotaFor 金额自愈块"); process.exit(1); }
// 包装成纯函数 carry(q, acc): 复用真代码块对 q 做自愈改写。
const carry = eval("(function(q, acc){\n" + seg[0] + "\nreturn q;})");

// ── 情形1: billing 瞬时失败 (overageKnown 未标 true) 且有历史额度 → 沿用上次值 + 标 stale, 绝不抹 0 ──
{
  const acc = { quota: { overageDollars: 6.42, overageTs: 1000 } };
  const q = { dPct: 100, overageDollars: 0 };   // 本轮 billing 没取到, 误带 0
  carry(q, acc);
  ok(q.overageDollars === 6.42, "billing 瞬时失败: 沿用上次已知 $6.42 (绝不误显 $0)");
  ok(q.overageStale === true, "billing 瞬时失败: 标记 overageStale (上次值)");
  ok(q.overageTs === 1000, "billing 瞬时失败: 沿用上次时间戳");
}

// ── 情形2: 本轮真取到余额 (overageKnown===true) → 直接用新值, 不沾历史 ──
{
  const acc = { quota: { overageDollars: 6.42, overageTs: 1000 } };
  const q = { dPct: 100, overageKnown: true, overageDollars: 3.10, overageTs: 2000 };
  carry(q, acc);
  ok(q.overageDollars === 3.10, "billing 正常: 用新值 $3.10 (实时跟随)");
  ok(q.overageStale !== true, "billing 正常: 不标 stale");
  ok(q.overageTs === 2000, "billing 正常: 用新时间戳");
}

// ── 情形3: 无历史额度 (首轮) 且本轮没取到 → 不强造, 保持本轮原值 ──
{
  const acc = {};   // 无 quota 历史
  const q = { dPct: 100, overageDollars: 0 };
  carry(q, acc);
  ok(q.overageStale !== true, "首轮无历史: 不标 stale (无可沿用)");
}

// ── 源级护栏: devinFetchQuota 标注 overageKnown; 消费侧区分未知/确零 ──
ok(/od != null.*overageKnown = true/.test(coreSrc) || /overageKnown = true; ps\.overageTs/.test(coreSrc),
   "源级: devinFetchQuota 取到美金余额即标 overageKnown=true");
ok(/else \{ ps\.overageKnown = false; \}/.test(coreSrc),
   "源级: billing 没取到 → overageKnown=false (不当 0)");

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
