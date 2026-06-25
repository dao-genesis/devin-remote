"use strict";
// 实测 switch.html 顶部页签「金额一直显示」修复的真代码: 切出 ovDollars + _pushTabDol 函数体 eval,
//   注入 mock 原生桥 N, 断言:
//   1) 有额度 → 推 id 与 小写 email 双键 "$X";
//   2) 无额度(quota.dPct 非数) → 绝不推空 (永不抹掉已显金额);
//   3) 变化才推 (省桥调用), force=true 绕过变化缓存强推 (自愈原生侧保洁/标签重建致的缺失);
//   4) 源级护栏: paintDollars 不再向原生推空串; _pollOneAcc/refreshOpenAccts/setOpenAccts 均调 _pushTabDol。
// 无框架: 直接 node test/tab-dollars.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 切出 ovDollars 与 _pushTabDol 两个函数 (从 `function ovDollars` 到 `function _euaText` 之前)。
const seg = switchSrc.match(/function ovDollars\(q\)\{[\s\S]*?(?=function _euaText)/);
if (!seg) { console.error("FAIL: 未找到 ovDollars/_pushTabDol 区段"); process.exit(1); }

function makeModule() {
  const calls = [];   // 记录每次 N.setTabDollars(key, lbl)
  const N = { setTabDollars: (key, lbl) => calls.push([key, lbl]) };
  const factory = "(function(deps){\n" +
    "var N=deps.N; var _lastTabDol={};\n" +
    seg[0] + "\n" +
    "return { pushTabDol: _pushTabDol, lastTabDol: function(){return _lastTabDol;} };\n" +
    "})";
  // eslint-disable-next-line no-eval
  const fns = eval(factory)({ N });
  return { fns, calls, N };
}

// ── 场景 1: 有额度 → 推 id + 小写 email 双键 "$X" ──
{
  const m = makeModule();
  m.fns.pushTabDol({ id: "A@X.com", email: "A@X.com", quota: { dPct: 100, overageDollars: 17.27 } });
  ok(m.calls.length === 2, "有额度: 推送两次 (id + 小写 email)");
  ok(m.calls.some(c => c[0] === "A@X.com" && c[1] === "$17"), "有额度: 以 id 键推送 $17 (四舍五入)");
  ok(m.calls.some(c => c[0] === "a@x.com" && c[1] === "$17"), "有额度: 以小写 email 键推送 $17");
}

// ── 场景 2: 无额度 (quota.dPct 非数值) → 绝不推空, 保留上次显示 ──
{
  const m = makeModule();
  m.fns.pushTabDol({ id: "b@y.com", email: "b@y.com", quota: {} });
  m.fns.pushTabDol({ id: "c@z.com", email: "c@z.com" });   // 无 quota
  ok(m.calls.length === 0, "无额度: 一次也不推 (绝不把页签金额抹空 → 一直显示上次值)");
}

// ── 场景 3: 变化才推; 同值再调不重复推 ──
{
  const m = makeModule();
  const a = { id: "d@d.com", email: "d@d.com", quota: { dPct: 50, overageDollars: 8 } };
  m.fns.pushTabDol(a);
  const after1 = m.calls.length;
  m.fns.pushTabDol(a);                      // 同值 → 不应再推
  ok(m.calls.length === after1, "变化检测: 金额未变则不重复调原生桥");
  a.quota.overageDollars = 3;               // 变了
  m.fns.pushTabDol(a);
  ok(m.calls.some(c => c[1] === "$3"), "变化检测: 金额变化后推送新值 $3");
}

// ── 场景 4: force=true 绕过变化缓存强推 (自愈原生侧保洁) ──
{
  const m = makeModule();
  const a = { id: "e@e.com", email: "e@e.com", quota: { dPct: 50, overageDollars: 12 } };
  m.fns.pushTabDol(a);
  const after1 = m.calls.length;
  m.fns.pushTabDol(a);                      // 非 force 同值 → 不推
  ok(m.calls.length === after1, "force 前提: 同值非强推不推");
  m.fns.pushTabDol(a, true);               // force → 必推
  ok(m.calls.length > after1, "force=true: 同值亦强推 (钉回原生·自愈保洁/重建缺失)");
}

// ── 源级护栏 ──
ok(/accs\.forEach\(function\(a\)\{\s*_pushTabDol\(a\);\s*\}\)/.test(switchSrc),
   "源级: paintDollars 改为统一经 _pushTabDol (不再内联推空串)");
ok(!/_lastTabDol\[key\]!==lbl/.test(switchSrc),
   "源级: 已移除旧的「推空抹掉」内联逻辑 (_lastTabDol[key]!==lbl)");
ok(/_pushTabDol\(DaoCore\.findAcc\(a\.id\)\|\|a\);\s*\/\/ 金额与状态同推/.test(switchSrc),
   "源级: _pollOneAcc 金额与状态同推 (杜绝有状态无金额)");
ok(/loadAcc\(\)\.filter\(_isDvOpen\)\.forEach\(function\(a\)\{ _pushTabDol\(a, true\); \}\)/.test(switchSrc),
   "源级: setOpenAccts 立即强推已开账号缓存金额");
ok(/accs\.forEach\(function\(a\)\{ _pushTabDol\(DaoCore\.findAcc\(a\.id\)\|\|a, true\); \}\)/.test(switchSrc),
   "源级: refreshOpenAccts 刷新后强推已开账号最新金额");

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
