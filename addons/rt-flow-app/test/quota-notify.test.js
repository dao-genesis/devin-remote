"use strict";
// 实测 engine.html 的「额度·真·系统通知」真代码 (与对话卡座同款 notifyGlobal, 锁屏/切后台亦达)。
//   根治: 旧版额度耗尽只在切号页弹 toast(前台瞬时·切后台/锁屏不可见·形同无效)。
//   现: 引擎后台轮询识别额度耗尽 → 聚合按账号 → notifyGlobal 真系统推送; 并主动预警「即将耗尽」。
//   断言: ① trackStuck 逆流 QUOTA_RE 识别额度信号为 reason="quota";
//         ② quotaWatch 跃迁/节流: 首现即推, 节流窗内不刷屏, 超窗再提醒, 恢复后清零下次立报;
//         ③ quotaLowWatch 仅在 dPct∈(0,阈值]且无 extra usage 缓冲时预警(杜绝 stale/未知误报)。
// 无框架: 直接 node test/quota-notify.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const engineSrc = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 源级护栏: trackStuck 必须逆流额度信号并单列 reason=quota (最高优先) ──
ok(/var QUOTA_RE=\/out_of_quota\|usage_limit/.test(engineSrc),
   "源级: trackStuck 内含 QUOTA_RE 额度信号正则 (与 switch.html 同源)");
ok(/if\(QUOTA_RE\.test\(qsig\)\) reason="quota";\s*\n\s*else if\(actionReq\)/.test(engineSrc),
   "源级: trackStuck 额度信号最高优先于 action_required/blocked/...");
ok(/qsig=String\(\(o&&o\.reason\)\|\|""\)\+" "\+String\(s\.status/.test(engineSrc),
   "源级: qsig 汇各底层字段(reason/status/enum/activity/current) 核额度 (反者道之动)");

// ── 源级护栏: convwatch 真·系统通知通道 + 节流键 ──
ok(/if \(N\.notifyGlobal\) N\.notifyGlobal\(/.test(engineSrc),
   "源级: 通知走原生 notifyGlobal (真系统通知·非 toast)");
ok(/var QKEY = "rtflow\.convwatch\.quota"/.test(engineSrc) && /var QLKEY = "rtflow\.convwatch\.qlow"/.test(engineSrc),
   "源级: 额度耗尽/即将耗尽各持独立按账号节流存储");
ok(/s\.reason === "quota"\) \{ cur\[sid\] = \{ phase: "quota"/.test(engineSrc),
   "源级: 额度耗尽 sid 仍登记 cur(phase=quota) → 不被误判「已结束」");
ok(/try \{ quotaWatch\(quotaByAcct, now\); \} catch/.test(engineSrc) && /try \{ quotaLowWatch\(accs, now\); \} catch/.test(engineSrc),
   "源级: tick 每轮触发 quotaWatch + quotaLowWatch");

// ── 功能实测: 抽出 quotaWatch / quotaLowWatch 真函数体, mock localStorage+notify 跑行为 ──
// 抽出从 `var QKEY` 到 quotaLowWatch 结束的整段 (含 _ls/_ss/常量/两函数)。
const seg = engineSrc.match(/var QKEY = "rtflow\.convwatch\.quota";[\s\S]*?function quotaLowWatch\(accs, now\)\{[\s\S]*?\n    \}/);
if (!seg) { console.error("FAIL: 未找到 quotaWatch/quotaLowWatch 区段"); process.exit(1); }

function makeHarness() {
  const store = {};
  const notes = [];
  const localStorage = {
    getItem(k){ return k in store ? store[k] : null; },
    setItem(k,v){ store[k] = String(v); }
  };
  function notify(tag, title, text){ notes.push({ tag, title, text }); }
  const factory = new Function("localStorage", "notify",
    seg[0] + "\n return { quotaWatch: quotaWatch, quotaLowWatch: quotaLowWatch, _store: arguments[0] };");
  const api = factory(localStorage, notify);
  api.notes = notes;
  return api;
}

// ① 额度耗尽: 首现即推一次
{
  const h = makeHarness();
  const t0 = 1_000_000_000_000;
  h.quotaWatch({ "alice@x.com": 2 }, t0);
  ok(h.notes.length === 1 && /额度已耗尽/.test(h.notes[0].title) && /2 个对话/.test(h.notes[0].text),
     "额度耗尽首现 → 推送一次(含账号名+休眠数)");
  ok(h.notes[0].tag === "quota-alice@x.com", "通知 tag 按账号(同账号更新而非刷屏)");

  // 节流窗内(+5min)同数目 → 不再推
  h.quotaWatch({ "alice@x.com": 2 }, t0 + 5*60*1000);
  ok(h.notes.length === 1, "节流窗内(<30min)同状态 → 不刷屏");

  // 数目增加(2→3) → 跃迁再推
  h.quotaWatch({ "alice@x.com": 3 }, t0 + 6*60*1000);
  ok(h.notes.length === 2 && /3 个对话/.test(h.notes[1].text), "休眠数增加 → 跃迁再推送");

  // 超节流窗(+31min from last notify) 仍耗尽 → 定时提醒一次
  h.quotaWatch({ "alice@x.com": 3 }, t0 + 6*60*1000 + 31*60*1000);
  ok(h.notes.length === 3, "超节流窗仍耗尽 → 定时提醒一次(必达)");

  // 恢复(本轮无该号) → 清零; 再次耗尽 → 立即(跃迁)推送, 不受旧节流时间戳压制
  h.quotaWatch({}, t0 + 6*60*1000 + 32*60*1000);
  h.quotaWatch({ "alice@x.com": 1 }, t0 + 6*60*1000 + 33*60*1000);
  ok(h.notes.length === 4, "恢复后再耗尽 → 立即推送(下次该报必报)");
}

// ② 额度即将耗尽: 仅在低剩余且无 extra usage 缓冲时预警
{
  const h = makeHarness();
  const t0 = 2_000_000_000_000;
  // dPct 未知(非数值) → 不预警 (杜绝 stale/未知误报)
  h.quotaLowWatch([{ email: "a@x.com", quota: { dPct: "??" } }], t0);
  ok(h.notes.length === 0, "dPct 非数值 → 不预警(防误报)");

  // 有 extra usage 美金缓冲 → 不预警
  h.quotaLowWatch([{ email: "a@x.com", quota: { dPct: 5, overageDollars: 3.2 } }], t0);
  ok(h.notes.length === 0, "低剩余但有 extra usage 缓冲 → 不预警");

  // 低剩余(5%)且无缓冲 → 预警一次
  h.quotaLowWatch([{ email: "b@x.com", quota: { dPct: 5, overageDollars: 0 } }], t0);
  ok(h.notes.length === 1 && /即将耗尽/.test(h.notes[0].title) && /仅剩 5%/.test(h.notes[0].text),
     "低剩余且无缓冲 → 预警一次");

  // 6h 内不重复
  h.quotaLowWatch([{ email: "b@x.com", quota: { dPct: 5, overageDollars: 0 } }], t0 + 3*3600*1000);
  ok(h.notes.length === 1, "预警 6h 内不重复(不扰民)");

  // 剩余=0 不在此预警(归「已耗尽」处理) → 不预警
  h.quotaLowWatch([{ email: "c@x.com", quota: { dPct: 0, overageDollars: 0 } }], t0);
  ok(h.notes.length === 1, "dPct=0 不走预警(归已耗尽通道)");
}

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
