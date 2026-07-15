"use strict";
// 通知去重根治 (用户实测: 很久以前的对话「已挂起/额度已耗尽」删了立马又提示一大串, 反反复复):
//   根因: ① engine.html 卡住/终态通知无「已提示账本」— 引擎重载(prev 变动/会话被重采样)即重报;
//         ② quotaWatch 30min 超窗定时重推 — 同一耗尽状态到时必再刷一遍;
//         ③ switch.html _stateAlertTs/_quotaAlertTs 只存内存 + 短节流(2min/5min) — 切号板每轮轮询
//            都把仍处于旧状态的对话再报一遍, 页面重载账本清零又全量重报。
//   现: 三处统一「持久账本·仅状态跃迁提示一次·状态解除后再入才重报·30天自然过期」。
// 无框架: 直接 node test/notify-dedup.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const engineSrc = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── engine.html 源级护栏: 已提示账本(持久化) ──
ok(/var ALERTED_KEY = "rtflow\.convwatch\.alerted"/.test(engineSrc),
   "源级: engine 持久已提示账本 rtflow.convwatch.alerted");
ok(/if \(!alertedOnce\(led, sid, "stuck-" \+ \(c\.reason\|\|""\), now\)\) return;/.test(engineSrc),
   "源级: 卡住/待处理通知经 alertedOnce 去重(同一卡住状态只报一次)");
ok((engineSrc.match(/if \(!alertedOnce\(led, sid, "end", now\)\) return;/g)||[]).length === 2,
   "源级: 终态(已挂起/已完成等)与兜底已结束均经 alertedOnce(sid|end) 去重");
ok(/if \(c\.phase === "active"\) \{ if \(alertedClear\(led, sid, ""\)\) ledCh = true; return; \}/.test(engineSrc),
   "源级: 会话重新活跃 → 剪账本(未来真再次卡住/终态才重新提示一次)");
ok(/function alertedPrune\(led, now\)/.test(engineSrc) && /30\*864e5/.test(engineSrc),
   "源级: 账本 30 天自然过期防无限增长");
ok(!/QUOTA_THROTTLE/.test(engineSrc),
   "源级: quotaWatch 已无 30min 超窗定时重推(同一耗尽状态绝不重刷)");

// ── switch.html 源级护栏: 状态/额度账本持久化 + 状态解除剪枝 ──
ok(/var SA_KEY="rtflow\.alert\.state", QA_KEY="rtflow\.alert\.quota"/.test(switchSrc),
   "源级: 切号板 状态/额度 已提示账本各持久化(localStorage)");
ok(/var _stateAlertTs = _alPrune\(_alLoad\(SA_KEY\)\)/.test(switchSrc) && /var _quotaAlertTs = _alPrune\(_alLoad\(QA_KEY\)\)/.test(switchSrc),
   "源级: 账本跨页面重载恒存(载入即 30 天剪枝)");
ok(/if\(_stateAlertTs\[key\]\) return;/.test(switchSrc),
   "源级: _stateChangeAlert 同一对话同一状态只提示一次(无时间窗重报)");
ok(/if\(p && \(p\.cnt\|0\)>=cnt\) return;/.test(switchSrc),
   "源级: _quotaAlert 仅跃迁(首现/耗尽数增加)推送, 同状态绝不重推");
ok(/function _alertLedgerPrune\(aid, items, exhausted\)/.test(switchSrc) &&
   (switchSrc.match(/_alertLedgerPrune\(/g)||[]).length >= 3,
   "源级: 两条轮询路径(_pollOneAcc/网页镜像)均先剪已解除状态的账本");

// ── 功能实测: 抽出 switch.html 账本区段, mock localStorage 跑行为 ──
const seg = switchSrc.match(/var SA_KEY="rtflow\.alert\.state"[\s\S]*?function _alertLedgerPrune\(aid, items, exhausted\)\{[\s\S]*?\n\}/);
if (!seg) { console.error("FAIL: 未找到 switch.html 通知账本区段"); process.exit(1); }
function makeSwitchHarness(store) {
  store = store || {};
  const alerts = [];
  const localStorage = {
    getItem(k){ return k in store ? store[k] : null; },
    setItem(k,v){ store[k] = String(v); }
  };
  const factory = new Function("localStorage", "N", "_bigAlert", "_vib",
    seg[0] + "\n return { state:_stateChangeAlert, quota:_quotaAlert, prune:_alertLedgerPrune };");
  const api = factory(localStorage, { notify(t, x){ alerts.push(t); } }, function(m){}, function(){});
  api.alerts = alerts; api.store = store;
  return api;
}
{
  const store = {};
  let h = makeSwitchHarness(store);
  const a = { id: "acc1", email: "alice@x.com" };
  const it = { cls: "blocked", uuid: "u1", title: "手机APK", _stuck: "error" };
  h.state(a, it); h.state(a, it); h.state(a, it);
  ok(h.alerts.length === 1, "同一对话同一卡住状态连报三轮 → 仅通知一次");
  // 页面重载(内存清零·账本从 localStorage 复活) → 仍不重报
  h = makeSwitchHarness(store);
  h.state(a, it);
  ok(h.alerts.length === 0, "页面重载后同状态 → 账本持久·绝不重报(删了不再回来)");
  // 状态解除(本轮该 uuid 不再 blocked) → 剪账本; 再次进入 → 重新提示一次
  h.prune("acc1", [], 0);
  h.state(a, it);
  ok(h.alerts.length === 1, "状态解除后再次进入 → 重新提示一次(真新事件不漏报)");

  // 额度: 首现推一次, 同状态不重推(含重载), 恢复后再耗尽重报
  const store2 = {};
  let h2 = makeSwitchHarness(store2);
  h2.quota(a, 2, "手机APK"); h2.quota(a, 2, "手机APK");
  ok(h2.alerts.length === 1, "额度耗尽首现 → 推一次, 同状态不重推");
  h2.quota(a, 3, "手机APK");
  ok(h2.alerts.length === 2, "耗尽对话数增加 → 跃迁再推一次");
  h2 = makeSwitchHarness(store2);
  h2.quota(a, 3, "手机APK");
  ok(h2.alerts.length === 0, "页面重载后同耗尽状态 → 绝不重报");
  h2.prune("acc1", [], 0);
  h2.quota(a, 1, "手机APK");
  ok(h2.alerts.length === 1, "额度恢复后再耗尽 → 重新提示(该报必报)");
}

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
