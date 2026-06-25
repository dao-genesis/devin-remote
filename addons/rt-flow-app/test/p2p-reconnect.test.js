"use strict";
// 实测 p2p-client.html 的「自愈监督决策」真代码 (切片 //__SUPERVISOR_START__…//__SUPERVISOR_END__ eval)。
// 关键回归: 网页端要对标甚至超越 APK 的持久/稳定, 必须像 relay-app.js 一样自愈 ——
//   心跳判死(连续未回 pong)→ 指数退避(翻倍·封顶)重连; 用户主动「断开」后永不自动重连; 重连中不重入。
// 无框架: node test/p2p-reconnect.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "p2p-client.html");
const src = fs.readFileSync(HTML, "utf8");
const m = src.match(/\/\/__SUPERVISOR_START__[\s\S]*?\/\/__SUPERVISOR_END__/);
if (!m) { console.error("FAIL: 未找到 //__SUPERVISOR_START__…//__SUPERVISOR_END__ 标记块"); process.exit(1); }

// eslint-disable-next-line no-eval
const S = eval("(function(){\n" + m[0] + "\nreturn { nextBackoff, shouldAutoReconnect, isChannelDead, shouldUpgrade, RECONN_MIN, RECONN_MAX, MAX_MISSED, HEARTBEAT_MS, FAST_RELAY_MS }; })()");

let failures = 0;
function ok(c, msg) { if (c) console.log("  ok  - " + msg); else { failures++; console.error("  FAIL- " + msg); } }

// ── 退避: 指数翻倍 + 封顶, 不越界 (与 APK BACKOFF_MIN/MAX 同构) ──
ok(S.RECONN_MIN === 1000, "退避下限 1s");
ok(S.RECONN_MAX === 30000, "退避上限 30s");
ok(S.nextBackoff(0) === 2000, "0→2s (空值起步即翻倍)");
ok(S.nextBackoff(1000) === 2000, "1s→2s");
ok(S.nextBackoff(2000) === 4000, "2s→4s");
ok(S.nextBackoff(8000) === 16000, "8s→16s");
ok(S.nextBackoff(16000) === 30000, "16s→32s 但封顶 30s");
ok(S.nextBackoff(30000) === 30000, "30s→仍封顶 30s (不无限增长)");
// 收敛性: 反复退避终归稳定在上限, 不溢出。
let b = S.RECONN_MIN; for (let i = 0; i < 50; i++) b = S.nextBackoff(b);
ok(b === S.RECONN_MAX, "连退 50 次稳定收敛于上限 30s");

// ── 是否应自愈: 用户主动断开后永不自动重连; 已在重连中不重入 ──
ok(S.shouldAutoReconnect(false, false) === true, "未断开·未在重连: 应自愈");
ok(S.shouldAutoReconnect(true, false) === false, "用户已断开: 绝不自动重连");
ok(S.shouldAutoReconnect(false, true) === false, "已在重连中: 不重入(避免并发多条握手)");
ok(S.shouldAutoReconnect(true, true) === false, "已断开且重连中: 不重连");

// ── 心跳判死: 连续未回 pong 达阈值才判死 (偶发单次丢包不误杀) ──
ok(S.MAX_MISSED === 2, "判死阈值 = 2 次连续无回应");
ok(S.isChannelDead(0, S.MAX_MISSED) === false, "0 次未回: 不判死");
ok(S.isChannelDead(1, S.MAX_MISSED) === false, "1 次未回(偶发丢包): 不误判死");
ok(S.isChannelDead(2, S.MAX_MISSED) === true, "2 次连续未回: 判通道死 → 触发自愈");
ok(S.isChannelDead(5, S.MAX_MISSED) === true, "5 次未回: 判死");
// 心跳间隔须 >0 且不超过判死时窗内合理探测 (HEARTBEAT_MS × MAX_MISSED ≈ 检出时延)。
ok(S.HEARTBEAT_MS > 0 && S.HEARTBEAT_MS <= 20000, "心跳间隔在 (0,20s] 合理区间");

// ── 抢通(happy-eyeballs): P2P 抢跑窗口须 >0 且足够短 (体感秒开, 不让用户久等) ──
const slice = m[0];
ok(/FAST_RELAY_MS\s*=\s*\d+/.test(slice), "切片内声明 FAST_RELAY_MS (抢跑窗口可调)");
ok(S.FAST_RELAY_MS > 0 && S.FAST_RELAY_MS <= 6000, "抢跑窗口在 (0,6s]: P2P 未及时通即并行起中继, 体感秒开");
ok(S.FAST_RELAY_MS < S.RECONN_MAX, "抢跑窗口 < 退避上限 (中继兜底远早于放弃重连)");

// ── 抢通升级判定: 仅「中继→真P2P直连」才值得无缝升级, 其余维持现状不折腾 ──
ok(S.shouldUpgrade(true, false) === true, "当前中继·后到真P2P直连: 升级 (低延迟·满速·无48KB限)");
ok(S.shouldUpgrade(true, true) === false, "当前中继·后到也是中继: 不折腾(同等链路)");
ok(S.shouldUpgrade(false, false) === false, "当前已是直连·后到直连: 不折腾(已最优)");
ok(S.shouldUpgrade(false, true) === false, "当前直连·后到中继: 绝不降级");

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nALL PASS (p2p-client 自愈监督决策)");
