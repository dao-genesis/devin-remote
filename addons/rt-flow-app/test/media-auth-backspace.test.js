// 媒体鉴权代取 + 退格根治 源级护栏:
//   ① <img>/<video> 等媒体元素原生加载不带 Authorization → app.devin.ai/attachments/ 恒 401
//      → 原生层 authMediaResponse 代取(补 Bearer / 转发 Range / 30x 手动跟随且凭据只发 app.devin.ai)
//   ② 三星等输入法一次退格调 deleteSurroundingText(before>0, after>0) 左右同删 → 原生
//      InputConnection 层夹断(after 归 0), 且标签 WebView 实际使用 GuardedWebView
//   ③ 视频全屏 onShowCustomView/onHideCustomView 承接 + 返回键退全屏
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/MainActivity.java"), "utf8");
const tabAct = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/TabActivity.java"), "utf8");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}

// ① 媒体鉴权代取
ok(/private WebResourceResponse authMediaResponse\(Tab tab, WebResourceRequest req\)/.test(main), "authMediaResponse 存在");
ok(/authMediaResponse\(tab, req\)/.test(main), "shouldInterceptRequest 接入 authMediaResponse");
ok(/path\.startsWith\("\/attachments\/"\)/.test(main), "只代取 /attachments/ 路径");
ok(/"Bearer " \+ auth1/.test(main), "代取时补 Authorization Bearer");
ok(/static WebResourceResponse authMediaResponseFor\(String auth1, String orgId, WebResourceRequest req\)/.test(main), "代取抽为静态共用 (主壳/TabActivity 同源)");
ok(/getCookie\("https:\/\/app\.devin\.ai\/"\)/.test(main), "代取转发 CookieManager Cookie (attachments_token 真鉴权)");
ok(/set-attachment-cookie/.test(main), "401 铸造 attachments_token (set-attachment-cookie)");
ok(/mintAttachmentCookie\(auth1, orgId\)\) c = fetchAttachment/.test(main), "401 铸造后重试一次 (自愈)");
ok(/lk\.equals\("cookie"\)/.test(main), "Cookie 不盲转发 (30x 后不外泄给对象存储)");
ok(/warmAttachmentCookie\(tab\.auth1, tab\.orgId, u\)/.test(main), "onPageFinished/SPA 路由预铸附件 Cookie");
ok(/equalsIgnoreCase\("Authorization"\)\) return null/.test(main), "已带鉴权的请求(fetch/XHR)不重复代取");
ok(/"app\.devin\.ai"\.equalsIgnoreCase\(new java\.net\.URL\(url\)\.getHost\(\)\)/.test(main), "凭据只发 app.devin.ai (30x 后不外泄 token)");
ok(/setInstanceFollowRedirects\(false\)/.test(main), "30x 手动跟随");
ok(/setStatusCodeAndReasonPhrase\(code, reason\)/.test(main), "状态码原样回灌 (含 206 Range)");
ok(/lk\.equals\("accept-encoding"\)/.test(main), "Accept-Encoding 不转发 (交由透明 gzip)");
ok(/tab\.auth1 = token; tab\.orgId = org;/.test(main), "makeTab 把账号 auth1/orgId 落到 Tab");

// ①b TabActivity (多实例标签) 与主壳同源同一套 (不分叉)
ok(/MainActivity\.authMediaResponseFor\(fToken, fOrg, req\)/.test(tabAct), "TabActivity 接入同一套媒体鉴权代取");
ok(/new MainActivity\.GuardedWebView\(this\)/.test(tabAct), "TabActivity 使用 GuardedWebView (退格护栏同源)");
ok(/MainActivity\.warmAttachmentCookie\(fToken, fOrg, u\)/.test(tabAct), "TabActivity 预铸附件 Cookie");

// ② 退格根治 (原生 InputConnection 夹断)
ok(/class GuardedWebView extends WebView/.test(main), "GuardedWebView 存在");
ok(/new GuardedWebView\(this\)/.test(main), "makeTab 实际使用 GuardedWebView");
const clamps = main.match(/if \(beforeLength > 0 && afterLength > 0\) afterLength = 0;/g) || [];
ok(clamps.length >= 2, "deleteSurroundingText / InCodePoints 双双夹断 (found " + clamps.length + ")");
ok(/onCreateInputConnection\(EditorInfo outAttrs\)/.test(main), "夹断落在 onCreateInputConnection 包装层");

// 夹断语义 (JS 等价复算): 左右同删 → 只删左; 纯左删/纯右删原样
function clamp(before, after) { if (before > 0 && after > 0) after = 0; return [before, after]; }
ok(String(clamp(1, 1)) === "1,0", "夹断: (1,1) → (1,0) 一次退格只删左侧");
ok(String(clamp(1, 0)) === "1,0", "夹断: (1,0) 原样 (正常退格)");
ok(String(clamp(0, 1)) === "0,1", "夹断: (0,1) 原样 (纯前向删除不受影响)");

// ③ 视频全屏承接
ok(/public void onShowCustomView\(View view, CustomViewCallback callback\)/.test(main), "onShowCustomView 承接");
ok(/public void onHideCustomView\(\)/.test(main), "onHideCustomView 承接");
ok(/if \(fsCustomView != null\) \{ hideFsCustomView\(\); return; \}/.test(main), "返回键先退全屏");

console.log(`\nmedia-auth-backspace: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
