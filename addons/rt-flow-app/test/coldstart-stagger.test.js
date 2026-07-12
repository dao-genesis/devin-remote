"use strict";
// 冷启动错峰加载护栏: 「切杀后台后重开很慢」的修复 —— restoreTabs 不再对每个后台 Devin 账号标签
// 即时 loadUrl(N 张重型 SPA 同时抢网络/内存/渲染进程 → 峰值触发 onRenderProcessGone 强制重载),
// 改为建壳(makeTab+pendingReloadUrl)后按 COLD_START_ACCT_LOAD_GAP_MS 逐张错峰起载。断言:
//   1) 存在错峰间隔常量;
//   2) restoreTabs 对非活动账号标签走 deferredAcct 队列而非 newTabBackground;
//   3) 延迟壳设 pendingReloadUrl → 错峰前被选中时 selectTab 照常即载;
//   4) 错峰 Runnable 消费 pendingReloadUrl(判空跳过·置空再载), 与 selectTab 不重复加载;
//   5) 错峰经 main.postDelayed 以 (k+1) 倍间隔排队。
// 无框架: 直接 node test/coldstart-stagger.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app", "src", "main");
const mainSrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

ok(/COLD_START_ACCT_LOAD_GAP_MS\s*=\s*\d+/.test(mainSrc), "错峰间隔常量 COLD_START_ACCT_LOAD_GAP_MS 存在");

const rt = mainSrc.match(/private boolean restoreTabs\(\)[\s\S]*?\n    \}/);
ok(!!rt, "restoreTabs() 可定位");
const body = rt ? rt[0] : "";

ok(/deferredAcct/.test(body), "restoreTabs 走 deferredAcct 延迟队列");
ok(/!isActive && acc != null && http/.test(body), "非活动·账号·http(s) 标签命中延迟分支");
const deferBranch = body.match(/!isActive && acc != null && http[\s\S]*?deferredUrls\.add\(url\);/);
ok(!!deferBranch && /makeTab\(acc, false\)/.test(deferBranch[0]), "延迟分支建壳用 makeTab(不即时 loadUrl)");
ok(!!deferBranch && /pendingReloadUrl\s*=\s*url/.test(deferBranch[0]), "延迟壳设 pendingReloadUrl → 错峰前选中即载");
ok(!/(!isActive && acc != null && http[\s\S]{0,400}newTabBackground)/.test(body), "延迟分支不再即时 newTabBackground");

const sched = body.match(/for \(int k = 0; k < deferredAcct\.size\(\); k\+\+\)[\s\S]*?COLD_START_ACCT_LOAD_GAP_MS \* \(k \+ 1\)\);/);
ok(!!sched, "错峰调度按 (k+1)*GAP 经 main.postDelayed 排队");
ok(!!sched && /pendingReloadUrl == null\)\s*return/.test(sched[0]), "已被 selectTab 消费的壳跳过(不重复加载)");
ok(!!sched && /pendingReloadUrl = null;[\s\S]*?loadInto\(/.test(sched[0]), "错峰起载前先消费 pendingReloadUrl");

if (failures) { console.error("coldstart-stagger: FAIL=" + failures); process.exit(1); }
console.log("coldstart-stagger: all ok");
