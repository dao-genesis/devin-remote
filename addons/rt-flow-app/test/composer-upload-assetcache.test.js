"use strict";
// 源级护栏: ① 官方页 composer 零注入 (「＋」菜单注入已整体撤除·官方原生上传入口全权接管);
//           ② app.devin.ai /assets/* 静态资产磁盘缓存。
// ① installComposerUpload / RTDL.pickUpload 已撤 (官方本有上传入口, 不再注入官方页菜单);
//    下载悬浮窗自身的「⬆ 上传」(pickUploadToPage) 保留 (app 自有面板, 非官方页注入)。
// ② assetCacheResponse: 只缓存内容哈希命名的不可变资产; 命中本地供给 immutable;
//    未命中后台整取 (identity 传输校验 Content-Length, 取不全不落盘), LRU 限容;
//    页内标签与 TabActivity 全屏号页两处 shouldInterceptRequest 都接入。
// 无框架: node test/composer-upload-assetcache.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "MainActivity.java");
const TABJ = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "TabActivity.java");
const java = fs.readFileSync(JAVA, "utf8");
const tabj = fs.readFileSync(TABJ, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// ① 官方页 composer 零注入 (反向护栏)
ok(!/installComposerUpload/.test(java) && !/installComposerUpload/.test(tabj), "无 installComposerUpload (＋菜单注入已撤)");
ok(!/window\.__rtNewUp/.test(java), "无 __rtNewUp 注入守卫残留");
ok(!/RTDL\.pickUpload/.test(java), "无 RTDL.pickUpload 桥调用残留");
ok(/private void pickUploadToPage\(\)/.test(java), "下载悬浮窗「⬆ 上传」(pickUploadToPage) 保留");

// ② 静态资产磁盘缓存
ok(/static WebResourceResponse assetCacheResponse\(WebResourceRequest req\)/.test(java), "存在 assetCacheResponse");
ok(/static boolean cacheableAssetPath\(String host, String path\)/.test(java)
   && /path\.startsWith\("\/assets\/"\)/.test(java)
   && /\[-\.\]\[A-Za-z0-9_\]\{8,\}/.test(java), "只缓存 /assets/ 内容哈希命名资产");
ok(/Cache-Control", "public, max-age=31536000, immutable"/.test(java), "命中供给 immutable");
ok(/static void assetCachePrefetch\(final String url, final String path\)/.test(java), "未命中后台整取 assetCachePrefetch");
ok(/sAssetFetching\.add\(key\)/.test(java), "单飞去重 sAssetFetching");
ok(/Accept-Encoding", "identity"/.test(java) && /clen > 0 && w != clen/.test(java), "identity 传输 + Content-Length 完整性校验");
ok(/static void assetCacheTrim\(File dir\)/.test(java) && /ASSET_CACHE_MAX_TOTAL/.test(java), "LRU 限容 assetCacheTrim");
ok(/WebResourceResponse ac = assetCacheResponse\(req\);\s*\n\s*if \(ac != null\) return ac;/.test(java), "页内标签 shouldInterceptRequest 接入");
ok(/MainActivity\.assetCacheResponse\(req\)/.test(tabj), "TabActivity 全屏号页接入");

if (fails) { console.error(fails + " failure(s)"); process.exit(1); }
console.log("all pass");
