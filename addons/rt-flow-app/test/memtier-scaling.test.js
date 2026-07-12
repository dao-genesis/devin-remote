"use strict";
// 资源档位调度护栏: 大内存机型把「后台重页上限/闲置卸载阈值/后台保洁节奏」按整机 RAM 放宽 —
// 治用户实测「稍微切走一下再回来, 所有页面都得重新加载」(旧保守值把 8~12GB 旗舰当 4GB 小机回收)。断言:
//   1) initMemTier 存在且按 totalMem 分档;
//   2) onCreate 早期调用 initMemTier;
//   3) 关键尺度已从 static final 变为实例字段(可按档位改写);
//   4) ≥8GB 档: 后台重页上限放宽到两位数, 转后台宽限 ≥5 分钟;
//   5) 冷启动错峰常量保持不变(另有测试护栏)。
// 无框架: 直接 node test/memtier-scaling.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main",
  "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

const fn = mainSrc.match(/private void initMemTier\(\) \{[\s\S]*?\n    \}/);
ok(!!fn, "initMemTier 可定位");
const f = fn ? fn[0] : "";
ok(/totalMem/.test(f), "按 ActivityManager totalMem 分档");
ok(/totalMb >= 7500/.test(f) && /totalMb >= 5500/.test(f) && /totalMb >= 3500/.test(f), "四档分层 (≥8G/6-8G/4-6G/<4G)");
ok(/MAX_LIVE_BG_HEAVY = 1[0-9]/.test(f), "≥8GB 档后台重页上限放宽到两位数");
ok(/BG_HYGIENE_DELAY_MS = 300000L/.test(f), "≥8GB 档转后台宽限 5 分钟 (治「稍微切走即全重载」)");
ok(/Log\.i\(FL/.test(f), "档位经 DAO_FLUENCY 可观测");

ok(/initMemTier\(\); \} catch \(Exception ignored\) \{\}/.test(mainSrc), "onCreate 早期调用 initMemTier");

ok(/private int MAX_LIVE_BG_HEAVY = 5/.test(mainSrc), "MAX_LIVE_BG_HEAVY 为实例字段·保守缺省 5");
ok(/private long IDLE_UNLOAD_MS = 900000/.test(mainSrc), "IDLE_UNLOAD_MS 为实例字段·保守缺省 15 分钟");
ok(/private long ACCT_IDLE_UNLOAD_MS = 1800000/.test(mainSrc), "ACCT_IDLE_UNLOAD_MS 为实例字段·保守缺省 30 分钟");
ok(/private long BG_HYGIENE_DELAY_MS = 45000/.test(mainSrc), "BG_HYGIENE_DELAY_MS 为实例字段·保守缺省 45s");
ok(/private long BG_HYGIENE_MS = 120000/.test(mainSrc), "BG_HYGIENE_MS 为实例字段·保守缺省 2 分钟");

ok(/COLD_START_ACCT_LOAD_GAP_MS\s*=\s*\d+/.test(mainSrc), "冷启动错峰常量不受档位影响(另有护栏)");

if (failures) { console.error("memtier-scaling: FAIL=" + failures); process.exit(1); }
console.log("memtier-scaling: all ok");
