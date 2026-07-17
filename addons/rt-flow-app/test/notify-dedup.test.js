"use strict";
// 通知归一·只报一遍·状态解除即撤 (用户实测: 额度耗尽反复提示; 切号板与手机通知双份刷屏; 老对话早已结束/耗尽,
//   通知却残留栏中反复弹):
//   根治三条:
//     ① 通知只走一条路 — 手机原生通知(engine.html·notifyGlobal); 切号板只展示状态, 不再自行发页面横幅/震动/toast。
//     ② 同一事件只通知一遍 — 额度耗尽/即将耗尽仅「首次进入该态」推一次, 数目增加也绝不重推; 恢复后再进入才重报。
//     ③ 状态解除即撤 — 会话重新活跃 / 额度恢复时, 引擎按同一 tag 调 N.cancelConv 主动抹掉通知栏旧条目(不残留)。
// 无框架: 直接 node test/notify-dedup.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow");
const engineSrc = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");
const relaySrc = fs.readFileSync(path.join(JAVA, "RelayService.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── engine.html 源级护栏: 已提示账本(持久化) + 状态解除主动撤通知 ──
ok(/var ALERTED_KEY = "rtflow\.convwatch\.alerted"/.test(engineSrc),
   "源级: engine 持久已提示账本 rtflow.convwatch.alerted");
ok(/&& alertedOnce\(led, sid, "stuck-" \+ \(c\.reason\|\|""\), now\)\) \{/.test(engineSrc),
   "源级: 卡住/待处理通知经 alertedOnce 去重(同一卡住状态只报一次)");
ok((engineSrc.match(/if \(!alertedOnce\(led, sid, "end", now\)\) return;/g)||[]).length === 2,
   "源级: 终态(已挂起/已完成等)与兜底已结束均经 alertedOnce(sid|end) 去重");
ok(/function cancelNotify\(tag\)\{ try \{ if \(N\.cancelConv\) N\.cancelConv\(String\(tag\)\); \} catch\(e\)\{\} \}/.test(engineSrc),
   "源级: engine 具 cancelNotify → 原生 N.cancelConv(状态解除撤通知)");
ok(/if \(!c\.unread && \(hadStuck \|\| \(p && p\.unread\)\)\) cancelNotify\("conv-" \+ sid\);/.test(engineSrc),
   "源级: 会话重新活跃且已读 → 剪账本 + 主动撤通知; 未读新消息的横幅保留待用户处理");
ok(/if \(ma\.fire\) notify\("conv-" \+ sid, "\ud83d\udcac " \+ c\.title/.test(engineSrc),
   "源级: 微信式新消息横幅 — unread+msgId 跃迁才弹, 走原生 HIGH 渠道(heads-up+震动)");
ok(/next\[sid\]\.notifiedMsgId = c\.msgId;   \/\/ 本条卡住通知已覆盖此消息/.test(engineSrc),
   "源级: 卡住通知与消息横幅同条消息不双发(卡住已报即记账)");
ok(/function alertedPrune\(led, now\)/.test(engineSrc) && /30\*864e5/.test(engineSrc),
   "源级: 账本 30 天自然过期防无限增长");
ok(!/QUOTA_THROTTLE/.test(engineSrc),
   "源级: quotaWatch 已无 30min 超窗定时重推(同一耗尽状态绝不重刷)");

// ── 功能实测: msgAlertDecide (微信式新消息判定·纯函数) ──
{
  const mseg = engineSrc.match(/function msgAlertDecide\(c, p, coldStart\)\{[\s\S]*?\n    \}/);
  ok(!!mseg, "源级: engine 具 msgAlertDecide 纯函数");
  const dec = new Function(mseg[0] + "\n return msgAlertDecide;")();
  // 新未读消息 → 弹一次
  let r = dec({ phase:"active", msgId:"m1", unread:true }, { notifiedMsgId:"m0" }, false);
  ok(r.fire === true && r.mid === "m1", "新未读消息(msgId 跃迁) → 弹一次并记账");
  // 同一条消息再次轮询 → 绝不重弹
  r = dec({ phase:"active", msgId:"m1", unread:true }, { notifiedMsgId:"m1" }, false);
  ok(r.fire === false && r.mid === "m1", "同一条消息再轮询/重连/重载 → 绝不重弹");
  // 又来一条新消息 → 再弹一次
  r = dec({ phase:"stuck", msgId:"m2", unread:true }, { notifiedMsgId:"m1" }, false);
  ok(r.fire === true && r.mid === "m2", "同会话又来新消息 → 再弹一次(该提必提)");
  // 冷启只播种不刷屏
  r = dec({ phase:"active", msgId:"m9", unread:true }, undefined, true);
  ok(r.fire === false && r.mid === "m9", "冷启(prev 空) → 只播种不刷屏");
  // 已读 → 不弹且播种为已提示
  r = dec({ phase:"active", msgId:"m3", unread:false }, { notifiedMsgId:"m1" }, false);
  ok(r.fire === false && r.mid === "m3", "已读(unread=false) → 静默播种(视为已消费)");
  // quota 会话不走消息横幅
  r = dec({ phase:"quota", msgId:"m4", unread:true }, { notifiedMsgId:"m1" }, false);
  ok(r.fire === false && r.mid === "m1", "quota 会话 → 不走消息横幅(额度轨专管)");
  // 无 msgId → 不弹
  r = dec({ phase:"active", msgId:"", unread:true }, { notifiedMsgId:"m1" }, false);
  ok(r.fire === false && r.mid === "m1", "无稳定消息 id → 不弹(宁静勿误)");
}

// ── switch.html 源级护栏: 切号板只展示状态·不再自行发通知 ──
ok(/var SA_KEY="rtflow\.alert\.state", QA_KEY="rtflow\.alert\.quota"/.test(switchSrc),
   "源级: 切号板 状态/额度 账本仍持久化(供状态解除剪枝)");
// 抽出 _stateChangeAlert / _quotaAlert 两函数体, 断言不再含任何页面通知副作用
const stFn = switchSrc.match(/function _stateChangeAlert\(a, item\)\{[\s\S]*?\n\}/);
const qFn = switchSrc.match(/function _quotaAlert\(a, cnt, convName\)\{[\s\S]*?\n\}/);
ok(stFn && !/_bigAlert\(|_vib\(|N\.notify\(/.test(stFn[0]),
   "源级: _stateChangeAlert 不再弹页面横幅/震动/toast(切号板静默)");
ok(qFn && !/_bigAlert\(|_vib\(|N\.notify\(/.test(qFn[0]),
   "源级: _quotaAlert 不再弹页面横幅/震动/toast(额度耗尽只走手机原生通知)");

// ── RelayService 源级护栏: cancelConv 桥 + 稳定 id 撤销 ──
ok(/@JavascriptInterface public void cancelConv\(String tag\) \{\s*\n\s*main\.post\(\(\) -> cancelConvNotification\(tag\)\);/.test(relaySrc),
   "源级: RelayService 具 cancelConv 桥 → cancelConvNotification");
ok(/private static int convNotifyId\(String tag\)/.test(relaySrc) &&
   /int id = convNotifyId\(tag\);/.test(relaySrc) &&
   /nm\.cancel\(convNotifyId\(tag\)\);/.test(relaySrc),
   "源级: 推送与撤销共用同一稳定 id(convNotifyId) → 撤销精确命中");

// ── 功能实测: 抽出 engine.html 额度轨(quotaWatch/quotaLowWatch), mock localStorage/notify/cancelNotify ──
const qseg = engineSrc.match(/var QKEY = "rtflow\.convwatch\.quota";[\s\S]*?function quotaLowWatch\(accs, titleByAcct, now\)\{[\s\S]*?\n    \}/);
if (!qseg) { console.error("FAIL: 未找到 engine.html 额度轨区段"); process.exit(1); }
function makeQuotaHarness(store) {
  store = store || {};
  store["rtflow.notify.quota"] = "1";   // 额度类通知默认全关(quota-notify.test 另测默认静默), 此处显式开启以测去重/撤销行为
  const notifs = [], cancels = [];
  const localStorage = {
    getItem(k){ return k in store ? store[k] : null; },
    setItem(k,v){ store[k] = String(v); }
  };
  const notify = (tag, title, text) => notifs.push(tag);
  const cancelNotify = (tag) => cancels.push(tag);
  const factory = new Function("localStorage", "notify", "cancelNotify",
    qseg[0] + "\n return { quotaWatch:quotaWatch, quotaLowWatch:quotaLowWatch };");
  const api = factory(localStorage, notify, cancelNotify);
  api.notifs = notifs; api.cancels = cancels; api.store = store;
  return api;
}
{
  const store = {};
  const scanned = { "a@x.com": 1 };
  let h = makeQuotaHarness(store);
  const now = Date.now();
  // 首次耗尽 → 推一次
  h.quotaWatch({ "a@x.com": 2 }, { "a@x.com": "手机APK" }, now, scanned);
  ok(h.notifs.length === 1 && h.notifs[0] === "quota-a@x.com", "额度耗尽首现 → 推一次");
  // 同状态再扫 → 不重推
  h.quotaWatch({ "a@x.com": 2 }, {}, now, scanned);
  ok(h.notifs.length === 1, "同一耗尽状态再扫 → 绝不重推");
  // 耗尽对话数增加 → 仍不重推(用户要求: 只报一遍)
  h.quotaWatch({ "a@x.com": 5 }, {}, now, scanned);
  ok(h.notifs.length === 1, "耗尽对话数增加 → 仍不重推(只报一遍)");
  // 页面重载(内存清零·账本从 store 复活) → 仍不重报
  h = makeQuotaHarness(store);
  h.quotaWatch({ "a@x.com": 5 }, {}, now, scanned);
  ok(h.notifs.length === 0, "重载后同耗尽状态 → 绝不重报");
  // 恢复(本轮扫到且无耗尽)→ 主动撤旧通知
  h.quotaWatch({}, {}, now, scanned);
  ok(h.cancels.length === 1 && h.cancels[0] === "quota-a@x.com", "额度恢复 → 主动撤掉栏中旧通知");
  // 恢复后再耗尽 → 重新提示一次
  h.quotaWatch({ "a@x.com": 1 }, {}, now, scanned);
  ok(h.notifs.length === 1, "恢复后再耗尽 → 重新提示一次(该报必报)");
}
{
  // 即将耗尽: 首现推一次, 同态不重推, 恢复撤旧通知
  const store = {};
  let h = makeQuotaHarness(store);
  const now = Date.now();
  const lowAcc = { email: "b@x.com", quota: { dPct: 5, overageDollars: 0 } };
  h.quotaLowWatch([lowAcc], {}, now);
  ok(h.notifs.length === 1 && h.notifs[0] === "qlow-b@x.com", "即将耗尽首现 → 推一次");
  h.quotaLowWatch([lowAcc], {}, now + 7*3600*1000);
  ok(h.notifs.length === 1, "同一即将耗尽态 → 不到时重推(只报一遍)");
  // 恢复(不再即将耗尽)→ 撤旧通知
  h.quotaLowWatch([{ email: "b@x.com", quota: { dPct: 80, overageDollars: 0 } }], {}, now);
  ok(h.cancels.length === 1 && h.cancels[0] === "qlow-b@x.com", "即将耗尽恢复 → 主动撤旧通知");
}

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
