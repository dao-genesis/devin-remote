"use strict";
// 实测 relay-app.js 的「半开死链判定」真代码 (切片 //__LIVENESS_START__…//__LIVENESS_END__ eval)。
// 关键回归: 移动网/NAT 重绑/Doze 致出站 WSS 静默失效(无 onclose)时, 客户端据「连续无入站」自检半开 → 主动重连,
//   不再让中继侧 socket 早死、公网侧 no_agent/超时长达数分钟。lastRxTs===0(刚连未收帧) 绝不误杀。
// 无框架: node test/relay-liveness.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const JS = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "relay-app.js");
const src = fs.readFileSync(JS, "utf8");
const m = src.match(/\/\/__LIVENESS_START__[\s\S]*?\/\/__LIVENESS_END__/);
if (!m) { console.error("FAIL: 未找到 //__LIVENESS_START__…//__LIVENESS_END__ 标记块"); process.exit(1); }

// eslint-disable-next-line no-eval
const isHalfOpen = eval("(function(){\n" + m[0] + "\nreturn isHalfOpen; })()");

let failures = 0;
function ok(c, msg) { if (c) console.log("  ok  - " + msg); else { failures++; console.error("  FAIL- " + msg); } }

const STALE = 45000, now = 1000000;

// 健康连接: 刚收到 pong/帧 → 不判半开。
ok(isHalfOpen(true, now - 5000, now, STALE) === false, "健康(5s 前有入站): 不判半开");
ok(isHalfOpen(true, now - 30000, now, STALE) === false, "30s 前有入站(<45s 阈值): 仍不判半开");

// 半开: 已连接却久无任何入站(连中继自动回的 pong 都没) → 判半开, 触发重连。
ok(isHalfOpen(true, now - 46000, now, STALE) === true, "46s 无入站(>45s 阈值): 判半开死链");
ok(isHalfOpen(true, now - 600000, now, STALE) === true, "10min 无入站: 判半开死链");

// 边界与不误杀:
ok(isHalfOpen(true, 0, now, STALE) === false, "lastRxTs===0(刚 open 未收帧): 不误杀");
ok(isHalfOpen(false, now - 600000, now, STALE) === false, "未连接(connected=false): 不判(由重连逻辑接管)");
ok(isHalfOpen(true, now - STALE, now, STALE) === false, "恰好等于阈值(非严格大于): 不判, 留一拍余量");

if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
console.log("\n全部通过 ✓");
