"use strict";
// 源级护栏: 附件预热 (installAttachmentPrefetch) + 整取下载有界并发 + RPC 添加号后台自动解锁 (_bgUnlock)。
// 无框架: 直接 node test/attachment-prefetch.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/MainActivity.java"), "utf8");
const engine = fs.readFileSync(path.join(ROOT, "app/src/main/assets/engine/engine.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── ① 附件预热: DOM 一出现附件即触发后台整取 → 首次点开命中磁盘缓存 ──
ok(/static void installAttachmentPrefetch\(WebView w\)/.test(main), "installAttachmentPrefetch 存在");
ok(/installMediaRetry\(v\);\s*\/\/[^\n]*\n\s*installAttachmentPrefetch\(v\);/.test(main), "onPageFinished 安装附件预热");
ok(/installMediaRetry\(v\); installAttachmentPrefetch\(v\); harvestPageAuth/.test(main), "SPA 路由后重装 (doUpdateVisitedHistory)");
ok(/window\.__daoPf/.test(main), "幂等守卫 __daoPf");
ok(/location\.host!=='app\.devin\.ai'/.test(main), "只在 app.devin.ai 生效");
ok(/'Range':'bytes=0-0'/.test(main), "1 字节 Range 探测触发原生预热 (零重复下载)");
ok(/MutationObserver/.test(main.match(/static void installAttachmentPrefetch[\s\S]{0,2500}/)[0]), "MutationObserver 捕捉后到附件");
ok(/act<2/.test(main), "页面侧限并发 2");
ok(/total>=300/.test(main), "每页预热上限 300 (防失控)");

// ── ② 整取下载有界并发: 固定 3 线程池, 不再每附件裸开线程 ──
ok(/sMediaPfPool\s*=\s*\n?\s*java\.util\.concurrent\.Executors\.newFixedThreadPool\(3/.test(main), "整取走固定 3 线程池");
ok(/sMediaPfPool\.execute\(/.test(main), "mediaCachePrefetch 提交线程池");
ok(!/}, "media-cache"\)\.start\(\);/.test(main), "旧裸线程路径已移除");

// ── ③ RPC 添加/导入账号 → 后台自动登录解锁 (与面板 doAdd autoActivateAdded 同律) ──
ok(/function _bgUnlock\(list\)/.test(engine), "_bgUnlock 存在");
ok(/_bgUnlock\(\[saved\]\)/.test(engine), "addAccount 添加即后台解锁");
ok(/_bgUnlock\(list\)/.test(engine.match(/importAccounts:[\s\S]{0,800}/)[0]), "importAccounts 批量导入即后台解锁");
ok(/!a\.auth1 && a\.email && a\.password/.test(engine), "只补登未解锁且有密码的号");
ok(/_bgUnlockBusy/.test(engine), "在途去重 (不重复登同一号)");
ok(/DaoCore\.loginAndStore\(a\.email,a\.password\)\.catch/.test(engine), "登录失败不抛 (不阻 RPC 回包)");

if (failures) { console.error("attachment-prefetch: " + failures + " failed"); process.exit(1); }
console.log("# attachment-prefetch: all passed");
