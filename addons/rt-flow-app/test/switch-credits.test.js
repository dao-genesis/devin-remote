"use strict";
// 实测 switch.html 「Free/积分号额度归一」修复 (与美金解耦·一处归一):
//   背景: 批量加进来的 Free 套餐号 overageDollars≈0, 真实可用资源是 prompt+flow 额度积分。
//   旧逻辑全链只看美金 → 满额度 Free 号被显示成「$0·额度已用完」、头部漏算「激活」,
//   更被自动清理/归零判定当作低额号(删旧对话, 勾选归零移出库时移出账号库) → 用户感知「识别不了/用不了」。
//   本测试断言:
//   1) _euaText: Free 号(美金0·积分2500/500) → 显示积分 "2.5k" (非 "$0 额度已用完");
//   2) _euaText: 付费/超额号(美金8.47) → 仍显 "$8.47";
//   3) _euaText: 真·耗尽(美金0·积分0) → 仍 "$0 额度已用完";
//   4) _quotaTabLabel: Free → "2.5k"; 付费 → "$8"; 未刷新 → null;
//   5) 源级护栏: autoCleanFor/dvRunAutoCleanNow/applyConvCapFor/_balAlert/paintDollars 均经积分口径,
//      不再把 Free 满积分号当低额/归零处理。
// 无框架: 直接 node test/switch-credits.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 切出 ovDollars 起、到 paintDollars 之前 (含 _acctCredits/_creditFloor/_fmtCr/_quotaTabLabel/_pushTabDol/_euaText)。
const seg = switchSrc.match(/function ovDollars\(q\)\{[\s\S]*?(?=function paintDollars)/);
if (!seg) { console.error("FAIL: 未找到 ovDollars..paintDollars 区段"); process.exit(1); }

function makeModule() {
  const N = { setTabDollars: () => {} };
  const factory = "(function(deps){\n" +
    "var N=deps.N; var _lastTabDol={}; function _cfg(k,d){return d;}\n" +
    seg[0] + "\n" +
    "return { euaText:_euaText, quotaTabLabel:_quotaTabLabel, acctCredits:_acctCredits, creditFloor:_creditFloor };\n" +
    "})";
  // eslint-disable-next-line no-eval
  return eval(factory)({ N });
}
const M = makeModule();

const free = { quota: { dPct: 100, overageDollars: 0, availablePromptCredits: 2500, availableFlowCredits: 500 } };
const paid = { quota: { dPct: 100, overageDollars: 8.47 } };
const empty = { quota: { dPct: 100, overageDollars: 0, availablePromptCredits: 0, availableFlowCredits: 0 } };
const unrefreshed = { quota: {} };

// 1) Free 号显示积分, 非「额度已用完」
const ef = M.euaText(free);
ok(ef.t === "2.5k", "Free 号显示可用积分 2.5k (非 $0), 实=" + ef.t);
ok(/可用积分/.test(ef.ti) && !/已用完/.test(ef.ti), "Free 号 tooltip 标注可用积分·非已用完");
ok(ef.c !== "#777", "Free 号不用「已用完」灰色 (" + ef.c + ")");

// 2) 付费/超额号仍按美金
const ep = M.euaText(paid);
ok(ep.t === "$8.47", "付费号显示 $8.47, 实=" + ep.t);

// 3) 真·耗尽 (无美金无积分) 仍标已用完
const ee = M.euaText(empty);
ok(ee.t === "$0" && /已用完/.test(ee.ti), "真耗尽号仍显 $0·额度已用完, 实=" + ee.t);

// 4) 页签标签
ok(M.quotaTabLabel(free) === "2.5k", "页签: Free → 2.5k, 实=" + M.quotaTabLabel(free));
ok(M.quotaTabLabel(paid) === "$8", "页签: 付费 → $8 (四舍五入), 实=" + M.quotaTabLabel(paid));
ok(M.quotaTabLabel(unrefreshed) === null, "页签: 未刷新额度 → null (不推·不抹)");

// acctCredits / creditFloor
ok(M.acctCredits(free.quota).total === 3000, "_acctCredits 合计 prompt+flow = 3000");
ok(M.creditFloor() === 1000, "_creditFloor 默认 1000 (镜像桌面 creditsThreshold)");

// 5) 源级护栏 (行为链不再误判 Free 号为低额/归零)
ok(/_cr\.total>=_crFloor\) return \{state:"skip"/.test(switchSrc) || /bal>=th \|\| _cr\.total>=_crFloor/.test(switchSrc),
   "源级: autoCleanFor 积分充裕即跳过清理 (不当低额)");
ok(/var zero=\(bal<=0 && _cr\.total<=0\)/.test(switchSrc), "源级: 归零判定需 美金与积分皆尽");
ok(/ovDollars\(q\)<th && _acctCredits\(q\)\.total<_creditFloor\(\)/.test(switchSrc),
   "源级: dvRunAutoCleanNow 清理候选需 美金<阈值且积分<门槛");
ok(/bal<=0 && _acctCredits\(q\)\.total>0\)\{[\s\S]*?setMessageLimit\(a,99999\)/.test(switchSrc),
   "源级: applyConvCapFor 对积分号放开上限 (不卡成 $0)");
ok(/if\(_acctCredits\(q\)\.total>0\) return;\s*\/\/[^\n]*积分号/.test(switchSrc),
   "源级: _balAlert 对积分号不误报「额度仅 $0」");
ok(/if\(dd>0\|\|cc\.total>0\) usableCnt\+\+/.test(switchSrc),
   "源级: paintDollars 头部汇总把积分号计入「有额度」");

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
