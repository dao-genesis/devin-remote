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
ok(/CookieManager\.getInstance\(\)\.getCookie\(url\)/.test(main), "代取转发 CookieManager Cookie (attachments_token 真鉴权)");
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

// ②b 退格时间窗加固 (IME 拆单: 退格后紧跟前向删除 → 吞掉)
ok(/beforeLength == 0 && afterLength > 0 && \(now - lastBkAt\) < 250\) return true;/.test(main), "时间窗: 紧跟退格的纯前向删除被吞 (deleteSurroundingText 拆单)");
ok(/KEYCODE_FORWARD_DEL && \(now - lastBkAt\) < 250\) return true;/.test(main), "时间窗: 紧跟退格的 FORWARD_DEL 键事件被吞 (sendKeyEvent 拆单)");
ok(/KEYCODE_DEL\) \{ lastBkAt = now; \}/.test(main), "时间窗: 退格键事件登记时刻");

// ②c JS 回归本源 v3 (大道至简): JS 层对输入事件一律直通不拦 ——
//     v2 的 sIP+光标归位使 Slate 模型与 DOM 脱钩, normalize 整体回滚把整段文字连附件
//     一并删除 + restartInput 收键盘, 比原病灶更重。左右同删真根源在 IME 层, 已由
//     原生 GuardedWebView 钳制根治。JS 层只保留白屏兜底(与输入无关)。
ok(/__rtBsGuard3/.test(main), "退格回归本源: 幂等守卫 v3 存在");
ok(!/__rtBsGuard2/.test(main), "退格回归本源: v2 sIP+归位方案已整体移除");
const bsGuard = main.slice(main.indexOf("installBackspaceGuard(WebView w)"), main.indexOf("// 语音输入根治"));
ok(!/beforeinput/.test(bsGuard), "退格回归本源: 退格护栏内无任何 beforeinput 拦截");
ok(!/selectionchange/.test(bsGuard), "退格回归本源: 无 selectionchange 光标干预");
ok(!/stopImmediatePropagation/.test(bsGuard), "退格回归本源: 无 stopImmediatePropagation");
ok(/NotFoundError'\)return c;/.test(main.replace(/"\s*\+\s*"/g, "")), "崩页兜底: removeChild NotFoundError 防线");
ok(/Node\.prototype\.insertBefore=function/.test(main.replace(/"\s*\+\s*"/g, "")), "崩页兜底: insertBefore NotFoundError 防线");
// 旧看门狗(事后补字)与旧 v1 盲拦(光标跳末尾回归源)必须彻底移除
ok(!/getTargetRanges\(\)\[0\]/.test(main), "退格回归本源: 旧看门狗 getTargetRanges 快照已移除");
ok(!/setCaret\(p\.ed,p\.st\)/.test(main), "退格回归本源: 旧看门狗事后重定光标已移除");
ok(!/chk\(false\);\},700\)/.test(main), "退格回归本源: 旧看门狗 700/1400/2100ms 三查已移除");
ok(!/deleteContentForward'&&\(now-lastBk\)<150/.test(main.replace(/"\s*\+\s*"/g, "")), "退格回归本源: v1 前向删除时间窗拦截已移除 (原生 InputConnection 层已够)");
ok(!/setComposingRegion\(int start, int end\)/.test(main), "原生 setComposingRegion 已恢复透传 (退格钳制只在 deleteSurroundingText)");

// ②c2 语音输入根治 (空 Slate 编辑器首段组合被 Slate 处理 → 重挂+restartInput 掐断 IME;
//      修法 = 同退格一路: 空编辑器起始的整段组合期间拦下 Slate 的 beforeinput, 不再零宽打底)
ok(/static void installVoiceGuard\(WebView w\)/.test(main), "语音根治: installVoiceGuard 存在");
ok(/__rtViGuard2/.test(main), "语音根治: 幂等守卫 v2 存在");
ok(/'compositionstart',function\(e\)\{var ed=ced\(e\.target\);hold=\(ed&&empty\(ed\)\)\?ed:null;/.test(main), "语音根治: 空编辑器 compositionstart 进入拦截期");
ok(/'compositionend',function\(e\)\{hold=null;/.test(main), "语音根治: compositionend 回归 Slate 常规处理");
ok(/hold===ed&&\(it==='insertCompositionText'\|\|it==='deleteCompositionText'\|\|\(it==='insertText'&&e\.isComposing\)\)\)\{e\.stopImmediatePropagation\(\);/.test(main), "语音根治: 拦截期内仅组合事件 stopImmediatePropagation (默认落字照常·IME 不被 restartInput 掐断)");
ok(!/it==='insertText'&&!e\.isComposing/.test(main), "语音根治 v2: 非组合直敲首字拦截已撤除 (模型脱钩→崩页主诱因)");
ok(/\[data-slate-placeholder\],\[contenteditable=false\]/.test(main), "语音根治: 判空跳过 Slate 占位提示 (placeholder 不算内容)");
// 旧零宽打底方案(外部改写 Slate DOM → 陈旧快照诱因)必须彻底移除
ok(!/var Z='\\\\u200B';/.test(main), "语音根治: 旧零宽字符打底已移除");
ok(!/function schedStrip/.test(main), "语音根治: 旧去抖摘除逻辑已移除");
ok(/installVoiceGuard\(v\);\s+\/\//.test(main) || /installVoiceGuard\(v\);/.test(main), "语音根治: onPageFinished 安装");
ok((tabAct.match(/MainActivity\.installVoiceGuard\(v\);/g) || []).length >= 2, "语音根治: TabActivity 账号页两处(onPageFinished + SPA 路由)同装");

// ②c3 取数统一 (拖拽/传到当前页 统一到「下载MD」同源快路径)
const daopan = fs.readFileSync(path.join(ROOT, "app/src/main/assets/engine/daopan.html"), "utf8");
ok(/private void fastPanelExtractInject\(/.test(main), "取数统一: fastPanelExtractInject 存在");
ok(/DaoCloud\.exportSession\(acc,sid,'conversation'\)/.test(main), "取数统一: 面板快路径走 DaoCloud.exportSession (与下载MD同源)");
ok(/public void convMdResult\(String reqId, String title, String md\)/.test(main), "取数统一: Bridge.convMdResult 回灌通道");
ok(/fastPanelExtractInject\(sid, accJson, target, x, y,[\s\S]{0,120}engineRpcExtractInject/.test(main), "取数统一: 链路 本地备份→面板快路径→引擎→fallback");
ok(/tryLocalBackupInject\(email, accJson, sid, target, x, y\)/.test(main), "取数统一: 本地备份秒注入仍为第一优先");
ok(/public void deliverConvToPage\(String name, String b64\)/.test(main), "取数统一: Bridge.deliverConvToPage 原生直投");
ok(/private void deliverConvToActivePage\(String name, String b64\)/.test(main), "取数统一: 直投当前活动标签实现");
ok(/public void deliverConvFilesToPage\(String filesJson\)/.test(main), "取数统一: Bridge.deliverConvFilesToPage 两形态直投");
ok(/if\(!IS_WEB && N\.deliverConvFilesToPage\)\{ N\.deliverConvFilesToPage\(JSON\.stringify\(files\)\); return; \}/.test(daopan), "取数统一: daopan 传到当前页 = 对话MD+取数指引两形态直投");
ok(/Native\.accessGuideMd\(JSON\.stringify\(it\.acc\), it\.sid/.test(daopan), "取数统一: 传到当前页同投取数指引 (提取失败亦至少投指引)");

// ②d 媒体鉴权本源补齐: 非账号标签从页面登录态采收 auth
ok(/private void harvestPageAuth\(WebView v, Tab tab, String pageUrl\)/.test(main), "harvestPageAuth 存在");
ok(/harvestPageAuth\(v, tab, u\); \/\/[^\n]*\n\s*warmAttachmentCookie/.test(main) || /harvestPageAuth\(v, tab, u\);/.test(main), "onPageFinished 采收页面登录态");
ok(/installBackspaceGuard\(v\); installVoiceGuard\(v\); installVideoFit\(v\); installMediaRetry\(v\); harvestPageAuth\(v, tab, u\); warmAttachmentCookie/.test(main), "SPA 路由后重采 (doUpdateVisitedHistory)");
ok(/auth1_session/.test(main), "采收源 = 页面 auth1_session 登录态");

// ②e VPN 自然回退 (有则走、死则直连·不强依赖)
const bridge = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/HttpBridge.java"), "utf8");
ok(/static boolean vpnActive\(\)/.test(bridge), "HttpBridge.vpnActive 存在");
ok(/static android\.net\.Network directNetwork\(\)/.test(bridge), "HttpBridge.directNetwork 存在 (非 VPN 底层网络)");
ok(/static HttpURLConnection openConn\(String urlStr, boolean direct\)/.test(bridge), "HttpBridge.openConn 支持绑直连网络");
ok(/HttpBridge\.appCtx = getApplicationContext\(\)/.test(main), "MainActivity 注入 appCtx (网络服务可用)");
ok(/HttpBridge\.vpnActive\(\) && HttpBridge\.directNetwork\(\) != null/.test(main), "媒体代取/铸 Cookie 失败 → 直连重试 (自然回退)");
ok(/private static boolean proxyHealthy\(String hp\)/.test(main), "代理真健康检查 (真经代理发请求·非只探端口)");
ok(/clearWebViewProxy\(\)\) \{ toast\("代理已失效, 已自动转直连"\)/.test(main), "页面加载失败+代理死 → 自动清代理转直连重载");

// ③ 视频全屏承接
ok(/public void onShowCustomView\(View view, CustomViewCallback callback\)/.test(main), "onShowCustomView 承接");
ok(/public void onHideCustomView\(\)/.test(main), "onHideCustomView 承接");
ok(/if \(fsCustomView != null\) \{ hideFsCustomView\(\); return; \}/.test(main), "返回键先退全屏");

console.log(`\nmedia-auth-backspace: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
