"use strict";
// 四象限优先级调度 (前台已开页 × 对话活跃) 单测 — 切出 switch.html 真代码段 eval:
//   ① 前台+活跃 → 每轮必扫 (重中之重, ≤7~8 个)
//   ② 后台+活跃 → 每 2 轮错峰
//   ③ 前台+空闲 → 每 4 轮错峰
//   ④ 无页+空闲 → 每 8 轮错峰
//   ⑤ 专线(refreshOpenAccts) 5s 内刚扫过 → 去重跳过; force → 全量
//   另: lite 外驱不再冒充「板块可见」(_extLite 门控) + 输入让行 + 源级护栏。
// 无框架: node test/switch-priority.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 功能测试 1: _extLite 门控 (lite 外驱 ≠ 板块可见) ──
{
  const seg = src.match(/var _extDriveTs = 0;[\s\S]*?function _notVisible\(\)\{[^\n]*\n/);
  ok(!!seg, "找到 _extDriven/_notVisible 区段");
  const documentMock = { hidden: true, documentElement: { clientWidth: 0 } };
  const f = new Function("document", seg[0] +
    "return { drive:function(lite,ts){_extLite=!!lite;_extDriveTs=ts;}, notVisible:_notVisible, extDriven:_extDriven };");
  const m = f(documentMock);
  m.drive(false, Date.now());
  ok(m.notVisible() === false, "非 lite 外驱 30s 窗内 → 视为可见 (照常刷新)");
  m.drive(true, Date.now());
  ok(m.notVisible() === true, "lite 外驱 (板块不可见) → 不再冒充可见, 自身 8s/2.2s 计时器全部让路");
}

// ── 功能测试 2: _tierDue 四象限矩阵 ──
{
  const seg = src.match(/function _tierDue\(a, no, force, now\)\{[\s\S]*?\n\}/);
  ok(!!seg, "找到 _tierDue 区段");
  function mk(opts) {
    const f = new Function("_accScanTs", "_trk", "_isDvOpen", "_sweepN", seg[0] + "\nreturn _tierDue;");
    return f(opts.scan || {}, opts.trk || {}, opts.isOpen || (() => false), opts.sweep | 0);
  }
  const now = Date.now();
  const acc = (email) => ({ id: email, email: email });
  // ① 前台+活跃: 每一轮都 due
  for (let s = 0; s < 8; s++) {
    const due = mk({ trk: { "a@x.com": { total: 2 } }, isOpen: () => true, sweep: s })(acc("a@x.com"), 3, false, now);
    if (!due) { ok(false, "① 前台+活跃 sweep=" + s + " 应每轮必扫"); break; }
    if (s === 7) ok(true, "① 前台+活跃 → 8/8 轮全扫 (重中之重)");
  }
  // ② 后台+活跃: 8 轮里恰 4 轮
  {
    let n = 0;
    for (let s = 0; s < 8; s++) n += mk({ trk: { "b@x.com": { total: 1 } }, sweep: s })(acc("b@x.com"), 3, false, now) ? 1 : 0;
    ok(n === 4, "② 后台+活跃 → 8 轮中 4 轮 (每 2 轮错峰), 实得 " + n);
  }
  // ③ 前台+空闲: 8 轮里恰 2 轮
  {
    let n = 0;
    for (let s = 0; s < 8; s++) n += mk({ trk: { "c@x.com": { total: 0 } }, isOpen: () => true, sweep: s })(acc("c@x.com"), 5, false, now) ? 1 : 0;
    ok(n === 2, "③ 前台+空闲 → 8 轮中 2 轮 (每 4 轮错峰), 实得 " + n);
  }
  // ④ 无页+空闲: 8 轮里恰 1 轮
  {
    let n = 0;
    for (let s = 0; s < 8; s++) n += mk({ trk: { "d@x.com": { total: 0 } }, sweep: s })(acc("d@x.com"), 6, false, now) ? 1 : 0;
    ok(n === 1, "④ 无页+空闲 → 8 轮中 1 轮 (每 8 轮错峰), 实得 " + n);
  }
  // ⑤ 从未观测过 → 按活跃处理 (先建立基线)
  ok(mk({ isOpen: () => true, sweep: 0 })(acc("e@x.com"), 1, false, now) === true, "⑤ 从未观测过+前台 → 每轮 (先建立基线)");
  // ⑥ 专线 5s 内刚扫过 → 去重跳过 (即便前台+活跃)
  ok(mk({ scan: { "f@x.com": now - 2000 }, trk: { "f@x.com": { total: 3 } }, isOpen: () => true, sweep: 0 })(acc("f@x.com"), 1, false, now) === false,
    "⑥ 专线 5s 内刚扫过 → 去重跳过");
  // ⑦ force → 全量 (去重也不拦)
  ok(mk({ scan: { "g@x.com": now - 1000 }, sweep: 0 })(acc("g@x.com"), 6, true, now) === true, "⑦ force → 全量扫 (不分层不去重)");
}

// ── 源级护栏 ──
ok(/engineHeartbeat\(lite\)\{\s*\n\s*_extLite = !!lite;/.test(src), "engineHeartbeat 记录 _extLite (lite 外驱不再冒充可见)");
ok(/pollTrk\(lite\?"lite":false\)/.test(src), "心跳把 lite 透传给 pollTrk (降档驱动)");
ok(/autoQuotaTick\(lite\?"lite":false\)/.test(src), "心跳把 lite 透传给 autoQuotaTick");
ok(/autoQuotaLiveTick\(lite\?"lite":false\)/.test(src), "心跳把 lite 透传给 autoQuotaLiveTick");
ok(/_probeBudget=liteRound\?8:24/.test(src), "lite 轮事件流探测配额降档 (8), 可见轮 24");
ok(/var live=auth\.filter\(_isDvOpen\);/.test(src), "近实时额度轮只服务前台已开页的号 (后台在跑号走 30s 全量轮)");
ok(/if\(!live\.length && !Object\.keys\(_dvOpenAccts\)\.length\) live=auth\.filter\(_hasLiveConv\);/.test(src),
  "无已开页广播时回退旧口径 (纯网页控制台不失功能)");
ok(/function _inputBusy\(\)/.test(src) && /if\(!force && _inputBusy\(\)\) return;/.test(src),
  "pollTrk 输入让行 (打字/触摸 1.5s 内不启动重扫描)");
ok(/if\(_inputBusy\(\)\) return;\s*\/\/ 输入让行: 打字\/触摸期间连「已开号专线」也顺延一轮/.test(src),
  "refreshOpenAccts 输入让行");
ok(/_accScanTs\[a\.id\|\|a\.email\|\|""\]=Date\.now\(\);/.test(src), "_pollOneAcc 记录扫描时刻 (双线去重之源)");

process.exit(failures ? 1 : 0);
