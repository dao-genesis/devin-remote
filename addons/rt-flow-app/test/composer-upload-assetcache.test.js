"use strict";
// 源级护栏: ①「新创作/＋」弹出菜单点击直传; ② app.devin.ai /assets/* 静态资产磁盘缓存。
// ① RTDL 桥新增 pickUpload → pickUploadToPage (与下载悬浮窗同一注入链, 点击不依赖拖拽);
//    installComposerUpload 注入 Radix menu 观察器, 语义门 (附件/上传/文件…) 命中才追加菜单项;
//    onPageFinished 与 doUpdateVisitedHistory (SPA 路由) 都装 (幂等)。
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

// ①「新创作/＋」弹出菜单点击直传
ok(/public void pickUpload\(\) \{ main\.post\(\(\) -> pickUploadToPage\(\)\); \}/.test(java), "RTDL 桥含 pickUpload → pickUploadToPage");
ok(/static void installComposerUpload\(WebView w\)/.test(java), "存在 installComposerUpload");
ok(/window\.__rtNewUp/.test(java), "注入幂等守卫 __rtNewUp");
ok(/attach\|upload\|file\|photo\|screenshot\|camera\|附件\|上传\|文件\|图片\|截图\|拍照/.test(java), "语义门: 附件/上传类弹出菜单才追加");
ok(/\[role=\\"menu\\"\],\[data-radix-menu-content\]/.test(java), "观察 Radix menu 弹出");
ok(/function scan\(\)\{T=0;try\{document\.querySelectorAll/.test(java), "全文档防抖重扫(Radix portal 先挂节点后置属性也不漏)");
ok(/attributes:true,attributeFilter:\['role','data-radix-menu-content'\]/.test(java), "同时观察 role 属性变化");
ok(/RTDL&&RTDL\.pickUpload&&RTDL\.pickUpload\(\)/.test(java), "菜单项点击 → RTDL.pickUpload");
ok(/installAttachmentPrefetch\(v\); \/\/[^\n]*\n\s*installComposerUpload\(v\);/.test(java), "onPageFinished 装 installComposerUpload");
ok(/installAttachmentPrefetch\(v\); installComposerUpload\(v\); installEnvModeBadge\(v, tab\.acctEmail\); harvestPageAuth/.test(java), "SPA 路由(doUpdateVisitedHistory)重装");

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
