"use strict";
// 源级护栏: 页面侧「单观察者 + 输入让行」(installDomWatch) —— 打字/语音一卡一卡之根治。
//   三份全文档 MutationObserver (videoFit / attachmentPrefetch / composerUpload) 归一为
//   window.__rtWatch 共享观察者: DOM 变更仅置脏, requestIdleCallback 空闲期单次冲刷,
//   用户打字/组合输入期间顺延 (page-side 对齐原生 INPUT_QUIET_MS 输入让行之则)。
// 无框架: 直接 node test/dom-watch-perf.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/MainActivity.java"), "utf8");
const tab = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/TabActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── ① installDomWatch 本体 ──
ok(/static void installDomWatch\(WebView w\)/.test(main), "installDomWatch 存在");
const body = (main.match(/static void installDomWatch[\s\S]{0,3000}/) || [""])[0];
ok(/window\.__rtWatch/.test(body), "暴露 window.__rtWatch 注册口 (幂等守卫)");
ok(/requestIdleCallback/.test(body), "空闲期冲刷 (requestIdleCallback)");
ok(/compositionstart/.test(body), "监听组合输入 (语音/拼音上屏)");
ok(/typing\(\)/.test(body), "打字期间顺延冲刷 (输入让行)");
ok(/attributeFilter:\['src','href','poster','role','data-radix-menu-content'\]/.test(body),
    "共享观察者 attributeFilter 为各子并集 (不监听全量属性噪声)");
// 实机回归 (AVD 实证): document 被替换后 window.__rtWatch 仍存而旧观察器已死 (僵尸态,
// ＋菜单/预热/videoFit 全哑)。每次重装必经 __rtWatchArm 重校/重挂当前 documentElement。
ok(/if\(window\.__rtWatch\)\{if\(window\.__rtWatchArm\)window\.__rtWatchArm\(\);return;\}/.test(body),
    "幂等重入时经 __rtWatchArm 重校观察目标 (防 document 替换后成僵尸观察器)");
ok(/window\.__rtWatchArm=function\(\)\{var de=document\.documentElement;if\(!de\|\|de===seen\)return;/.test(body),
    "__rtWatchArm 仅在 documentElement 变化时重挂 (disconnect→observe)");
ok(/requestIdleCallback\(f,\{timeout:500\}\)/.test(body),
    "ric 封顶 500ms (页面持续繁忙也不饿死冲刷)");

// ── ② 三份扫描子改经 __rtWatch, 自建观察者仅作兜底 ──
const vf = (main.match(/static void installVideoFit[\s\S]{0,6000}/) || [""])[0];
ok(/if\(window\.__rtWatch\)\{window\.__rtWatch\(deb\);\}/.test(vf), "videoFit 经 __rtWatch (兜底自建)");
const pf = (main.match(/static void installAttachmentPrefetch[\s\S]{0,2500}/) || [""])[0];
ok(/if\(window\.__rtWatch\)\{window\.__rtWatch\(later\);\}/.test(pf), "attachmentPrefetch 经 __rtWatch (兜底自建)");
const cu = (main.match(/static void installComposerUpload[\s\S]{0,3000}/) || [""])[0];
ok(/if\(window\.__rtWatch\)\{window\.__rtWatch\(scan\);\}/.test(cu), "composerUpload 经 __rtWatch (兜底自建)");

// ── ③ 安装链: 主壳两处 + 全屏号页两处, installDomWatch 先于各扫描子 ──
ok(/installDomWatch\(v\);\s*\/\/[^\n]*\n\s*installKbHelper\(v\);/.test(main), "主壳 onPageFinished 先装 installDomWatch");
ok(/\{ installDomWatch\(v\); installDownloadHook\(v\);/.test(main), "主壳 doUpdateVisitedHistory 先装 installDomWatch");
ok(/MainActivity\.installDomWatch\(v\);/.test(tab), "全屏号页安装 installDomWatch");

// ── ④ 全屏号页资源钩子对齐主壳: 附件预热 + ＋菜单上传入口 ──
ok(/MainActivity\.installAttachmentPrefetch\(v\);/.test(tab), "全屏号页装附件预热 (与主壳一致)");
ok(/MainActivity\.installComposerUpload\(v\);/.test(tab), "全屏号页装 ＋菜单上传入口 (与主壳一致)");

if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
console.log("dom-watch-perf: all ok");
