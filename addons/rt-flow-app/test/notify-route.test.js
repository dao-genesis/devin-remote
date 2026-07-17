"use strict";
// 通知序号 + 精准跳转 (PR #196 交接目标落地):
//   ① 通知标题冠稳定永久序号【N】(a.no·账号终身身份·与切号板/页签同源), 无需猜对话名即可定位账号;
//   ② 每条通知携带精准跳转目标 {email, sid, no} — 绝不用数组下标作身份;
//   ③ 原生 PendingIntent 按 tag 独立 (requestCode=convNotifyId(tag) + data 按 tag 区分),
//      FLAG_UPDATE_CURRENT 只刷新同 tag 自身, 不同通知绝不互相覆盖跳转参数;
//   ④ MainActivity singleTask + onNewIntent 消费目标: 点按不重建 Activity/不重载 APK,
//      已开该对话页 → 直接切过去(零重载); 该号有页签 → 复用鉴权开精确对话页; 无页签 → 经切号板账号库解出账号开页。
// 无框架: 直接 node test/notify-route.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow");
const engineSrc = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");
const relaySrc = fs.readFileSync(path.join(JAVA, "RelayService.java"), "utf8");
const mainSrc = fs.readFileSync(path.join(JAVA, "MainActivity.java"), "utf8");
const manifest = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main", "AndroidManifest.xml"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 源级护栏: engine.html 通知统一出口 ──
ok(/function notify\(tag, title, text, target\)/.test(engineSrc),
   "源级: notify 具第 4 参 target (精准跳转目标)");
ok(/function _accNoOf\(email\)/.test(engineSrc) && /return \(x\.no\|0\) \|\| \(i\+1\)/.test(engineSrc),
   "源级: 序号取稳定永久编号 a.no (数组下标仅兜底)");
ok(/N\.notifyGlobalT\(String\(tag\), t, String\(text\), tgt \? JSON\.stringify\(tgt\) : ""\)/.test(engineSrc),
   "源级: 有 notifyGlobalT 桥即携带 target JSON");
ok(/else if \(N\.notifyGlobal\) N\.notifyGlobal\(String\(tag\), t, String\(text\)\)/.test(engineSrc),
   "源级: 无新桥回退旧 notifyGlobal (向后兼容)");
// 会话级通知全部携带 {email, sid}; 账号级 (额度/清理) 携带 {email}
ok(/\{email:c\.email, sid:sid\}/.test(engineSrc), "源级: 卡住/新消息通知携带 {email, sid}");
ok(/\{email:\(ev\.email\|\|p\.email\), sid:sid\}/.test(engineSrc) && /\{email:p\.email, sid:sid\}/.test(engineSrc),
   "源级: 结束闭环通知携带 {email, sid}");
ok(/\{email:email\}/.test(engineSrc) && /\{email:a\.email\}/.test(engineSrc),
   "源级: 额度耗尽/即将耗尽通知携带 {email}");

// ── 源级护栏: RelayService 精准 PendingIntent ──
ok(/@JavascriptInterface public void notifyGlobalT\(String tag, String title, String text, String target\)/.test(relaySrc),
   "源级: RelayService 具 notifyGlobalT 桥");
ok(/public void postConvNotification\(String tag, String title, String text\) \{ postConvNotification\(tag, title, text, null\); \}/.test(relaySrc),
   "源级: 3 参 postConvNotification 委托 4 参 (兼容旧调用)");
ok(/it\.setData\(android\.net\.Uri\.parse\("rtflow:\/\/notif\/" \+ android\.net\.Uri\.encode\(tag/.test(relaySrc),
   "源级: Intent data 按 tag 区分 (filterEquals 不同 → 各存各的)");
ok(/it\.putExtra\("notif_email"/.test(relaySrc) && /it\.putExtra\("notif_sid"/.test(relaySrc),
   "源级: Intent 携带 notif_email/notif_sid 跳转目标");
ok(/PendingIntent\.getActivity\(this, convNotifyId\(tag\), it,\s*\n\s*PendingIntent\.FLAG_IMMUTABLE \| PendingIntent\.FLAG_UPDATE_CURRENT\)/.test(relaySrc),
   "源级: requestCode=convNotifyId(tag) → 不同通知的 PendingIntent 绝不互相覆盖");
ok(/Intent\.FLAG_ACTIVITY_NEW_TASK \| Intent\.FLAG_ACTIVITY_SINGLE_TOP/.test(relaySrc),
   "源级: SINGLE_TOP → 复用现有实例经 onNewIntent 消费");

// ── 源级护栏: MainActivity 路由 (不重载 APK) ──
ok(/android:launchMode="singleTask"/.test(manifest),
   "源级: MainActivity singleTask → 点通知不重建 Activity/不重载");
ok(/protected void onNewIntent\(Intent intent\) \{[\s\S]{0,200}handleNotifTarget\(intent\);/.test(mainSrc),
   "源级: onNewIntent 消费跳转目标");
ok(/handleNotifTarget\(getIntent\(\)\)/.test(mainSrc),
   "源级: 冷启动路径亦消费跳转目标");
ok(/i\.removeExtra\("notif_email"\); i\.removeExtra\("notif_sid"\);/.test(mainSrc),
   "源级: 目标消费即清 (防旋转/恢复重复路由)");
ok(/if \(!sid\.isEmpty\(\) && t\.url != null && t\.url\.contains\(sid\)\) \{ selectTab\(idx\); return; \}/.test(mainSrc),
   "源级: 该对话页已开 → 直接切过去 (零重载)");
ok(/newTab\("https:\/\/app\.devin\.ai\/sessions\/" \+ sid, tabs\.get\(acctIdx\)\.accountJson\)/.test(mainSrc),
   "源级: 该号有页签 → 复用其鉴权开精确对话页");
ok(/private void openAccountViaSwitch\(String email, String sid\)/.test(mainSrc) &&
   /Native\.openAccountSession\(JSON\.stringify\(a\),s\)/.test(mainSrc),
   "源级: 无页签兜底 → 经切号板账号库解出账号开精确对话页");

// ── 功能实测: 抽出 engine.html 的 _accNoOf + notify, mock loadAcc/N ──
function extract(fn, endRe) {
  const m = engineSrc.match(new RegExp("(function " + fn + "\\([\\s\\S]*?" + endRe + ")"));
  if (!m) throw new Error("extract " + fn + " failed");
  return m[1];
}
const calls = [];
const sandbox = {
  loadAcc: () => [
    { email: "a@x.com", no: 1 },
    { email: "kicad@jlc.com", no: 4 },   // 稳定编号: 中间号已移出, 4 不平移
    { email: "new@x.com", no: 7 }
  ],
  N: { notifyGlobalT: (tag, title, text, target) => calls.push({ tag, title, text, target: target ? JSON.parse(target) : null }) }
};
const src = extract("_accNoOf", "\\n      return 0;\\n    \\}") + "\n" +
            extract("notify", "\\} catch\\(e\\)\\{\\} \\}").replace(/function notify/, "function notifyFn");
const make = new Function("loadAcc", "N", src + "\nreturn {notifyFn:notifyFn,_accNoOf:_accNoOf};");
const api = make(sandbox.loadAcc, sandbox.N);

ok(api._accNoOf("KICAD@jlc.com") === 4, "功能: 序号按稳定 a.no 命中 (大小写不敏感)");
ok(api._accNoOf("ghost@x.com") === 0, "功能: 未知账号序号 0 (不冠序号)");

api.notifyFn("conv-s1", "💬 对话A", "kicad@jlc.com · 有新消息", { email: "kicad@jlc.com", sid: "s1" });
ok(calls[0].title === "【4】💬 对话A", "功能: 标题冠稳定序号【4】");
ok(calls[0].target && calls[0].target.email === "kicad@jlc.com" && calls[0].target.sid === "s1" && calls[0].target.no === 4,
   "功能: target 携带 {email, sid, no}");

api.notifyFn("conv-s2", "⚠️ 待你处理: 对话B", "x", { email: "new@x.com", sid: "s2" });
ok(calls[1].title === "【7】⚠️ 待你处理: 对话B" && calls[1].target.sid === "s2",
   "功能: 不同通知各携各的目标 (互不覆盖)");

api.notifyFn("quota-ghost", "🛑 额度已耗尽", "x", { email: "ghost@x.com" });
ok(calls[2].title === "🛑 额度已耗尽" && calls[2].target.email === "ghost@x.com",
   "功能: 未知序号不冠前缀, 目标照带");

api.notifyFn("t", "无目标", "x");
ok(calls[3].target === null, "功能: 无 target 亦兼容 (维护类通知)");

if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
console.log("notify-route: all passed");
