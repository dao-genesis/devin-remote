"use strict";
// 标签条渲染热路径护栏: ANR 现场实证 (emulator /data/anr 主线程栈:
//   chipTitle → new JSONObject(accountJson) → tabStripSig → renderTabStrip)
// chipTitle 被 tabStripSig 对每标签每次渲染调用, 每次都重新 JSON 解析 accountJson 属主线程反复热开销。
// 修法: accountJson 解析结果 (id/email/no) 在 makeTab 一次性缓存到 Tab 字段, chipTitle 只读缓存。断言:
//   1) Tab 具 acctId/acctEmail/acctNoSnap 缓存字段;
//   2) makeTab 的既有解析块顺手填充缓存;
//   3) chipTitle 不再 new JSONObject(t.accountJson);
//   4) restoreTabs 错峰 Runnable 用 scheduleRenderTabStrip (防抖) 而非每张即时整渲。
// 无框架: 直接 node test/chiptitle-cache.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app", "src", "main");
const mainSrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

const tab = mainSrc.match(/static class Tab \{[\s\S]*?\n    \}/);
ok(!!tab, "Tab 类可定位");
const tb = tab ? tab[0] : "";
ok(/String acctId/.test(tb), "Tab.acctId 缓存字段存在");
ok(/String acctEmail/.test(tb), "Tab.acctEmail 缓存字段存在");
ok(/int acctNoSnap/.test(tb), "Tab.acctNoSnap 缓存字段存在");

const mk = mainSrc.match(/private Tab makeTab\(String accountJson, boolean internal\) \{[\s\S]*?injectScript0 = TabActivity/);
ok(!!mk, "makeTab 可定位");
ok(!!mk && /tab\.acctId = a\.optString\("id", a\.optString\("email", ""\)\)/.test(mk[0]), "makeTab 缓存 acctId");
ok(!!mk && /tab\.acctEmail = a\.optString\("email", tab\.acctId\)/.test(mk[0]), "makeTab 缓存 acctEmail");
ok(!!mk && /tab\.acctNoSnap = a\.optInt\("no", 0\)/.test(mk[0]), "makeTab 缓存 acctNoSnap");

const ct = mainSrc.match(/private String chipTitle\(Tab t\) \{[\s\S]*?\n    \}/);
ok(!!ct, "chipTitle 可定位");
ok(!!ct && !/new JSONObject\(/.test(ct[0]), "chipTitle 不再每次渲染重新 JSON 解析 accountJson");
ok(!!ct && /t\.acctId/.test(ct[0]) && /t\.acctEmail/.test(ct[0]), "chipTitle 读 Tab 缓存字段");
ok(!!ct && /t\.acctNoSnap > 0/.test(ct[0]), "chipTitle 序号兜底走 acctNoSnap 快照");

const rt = mainSrc.match(/private boolean restoreTabs\(\)[\s\S]*?\n    \}/);
ok(!!rt && /loadInto\(dt, du\); \} catch \(Exception ignored\) \{\}\s*\n\s*scheduleRenderTabStrip\(\);/.test(rt[0]),
   "错峰 Runnable 用 scheduleRenderTabStrip 防抖 (不逐张即时整渲)");

if (failures) { console.error("chiptitle-cache: FAIL=" + failures); process.exit(1); }
console.log("chiptitle-cache: all ok");
