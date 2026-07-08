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
const clamps = main.match(/if \(afterLength > 0\) \{\s*\n\s*icAltered = true;\s*\n\s*if \(beforeLength <= 0\) \{ resyncIme\(\); return true; \}\s*\n\s*afterLength = 0;/g) || [];
ok(clamps.length >= 2, "deleteSurroundingText / InCodePoints 双双夹断 (found " + clamps.length + ")");
ok(/onCreateInputConnection\(EditorInfo outAttrs\)/.test(main), "夹断落在 onCreateInputConnection 包装层");

// 夹断语义 (JS 等价复算): 左右同删 → 只删左; 纯前向删除 → 整体吞掉(手机软键盘无 Del 键);
// 纯左删原样。不再用 250ms 时间窗: 拆单可能「先前向后退格」, 时间窗对倒序无效。
function clamp(before, after) { if (after > 0) { if (before <= 0) return null; after = 0; } return [before, after]; }
ok(String(clamp(1, 1)) === "1,0", "夹断: (1,1) → (1,0) 一次退格只删左侧");
ok(String(clamp(1, 0)) === "1,0", "夹断: (1,0) 原样 (正常退格)");
ok(clamp(0, 1) === null, "夹断: (0,1) 纯前向删除整体吞掉 (IME 拆单无论顺序皆被拦)");

// ②b 前向删除无条件拦断 (旧 250ms 时间窗对「先前向后退格」倒序拆单无效 → 已整体撤除改无条件)
ok(/if \(beforeLength <= 0\) \{ resyncIme\(\); return true; \}/.test(main), "纯前向 deleteSurroundingText 无条件吞掉(吞后对账)");
ok(/KEYCODE_FORWARD_DEL\) \{ icAltered = true; resyncIme\(\); return true; \}/.test(main), "IME 模拟的 FORWARD_DEL 键事件无条件吞掉(吞后对账)");
// ②b2 持久化对账 (v8.1): 每次吞/改写 IME 操作后在组合安全点 restartInput 让 IME 重读编辑器真相,
//      IME 账本不再随时间脱钩 → 钳制永续(根治「几分钟后左右同删复发」)。
ok(/boolean icAltered = false;/.test(main), "持久化: icAltered 脱钩标记存在");
ok(/void resyncIme\(\)/.test(main) && /imm\.restartInput\(GuardedWebView\.this\)/.test(main), "持久化: resyncIme 经 IMM.restartInput 对账(不收键盘)");
ok(/if \(activeComp != null && !activeComp\.isEmpty\(\)\) return;/.test(main), "持久化: 仅组合安全点对账(绝不掠断进行中的语音/拼音会话)");
ok(!/lastBkAt/.test(main), "旧 250ms 时间窗机制已整体移除 (倒序拆单之漏根除)");

// ②c JS 回归本源 v3 (大道至简): JS 层对输入事件一律直通不拦 ——
//     v2 的 sIP+光标归位使 Slate 模型与 DOM 脱钩, normalize 整体回滚把整段文字连附件
//     一并删除 + restartInput 收键盘, 比原病灶更重。左右同删真根源在 IME 层, 已由
//     原生 GuardedWebView 钳制根治。JS 层只保留白屏兜底(与输入无关)。
ok(/__rtBsGuard3/.test(main), "退格回归本源: 幂等守卫 v3 存在");
ok(!/__rtBsGuard2/.test(main), "退格回归本源: v2 sIP+归位方案已整体移除");
const bsGuard = main.slice(main.indexOf("installBackspaceGuard(WebView w)"), main.indexOf("// 语音守卫已整体撤除"));
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

// ②c2 语音守卫整体撤除 (v8·反者道之动·回归干净基线):
//      v5(吞首记)/v6(合成 beforeinput 种子)/v7(execCommand 心跳播摘种)全部证伪 ——
//      任何 JS 层对编辑器的主动写入(含 execCommand)都触发 restartInput 掐断 IME 会话,
//      心跳补种持续打断键盘(真机 v0.37.177: 键盘频繁自动收回·打字/退格/语音全面损坏)。
//      JS 层零干预; 输入问题只在原生 InputConnection 层最小处理。
ok(!/installVoiceGuard/.test(main), "语音守卫 v8: installVoiceGuard 已从 MainActivity 整体移除");
ok(!/installVoiceGuard/.test(tabAct), "语音守卫 v8: TabActivity 调用已同步移除");
ok(!/__rtViGuard/.test(main), "语音守卫 v8: 一切 __rtViGuard 方案(v3-v7)已整体移除");
ok(!/seedTry|lazySeed/.test(main), "语音守卫 v8: 心跳/事件补种(restartInput 掐键盘之根)已根除 (远控 browseType 的按需 execCommand 不在此列)");
ok(!/u200B/.test(main), "语音守卫 v8: 零宽种子机制已根除");
ok(!/new InputEvent\('beforeinput'/.test(main.replace(/"\s*\+\s*"/g, "")), "语音守卫 v8: 无合成 beforeinput");
ok(!/it==='insertText'&&!e\.isComposing/.test(main), "语音根治 v2: 非组合直敲首字拦截已撤除 (模型脱钩→崩页主诱因)");
ok(!/function schedStrip/.test(main), "语音根治: 旧去抖摘除逻辑已移除");

// ②c4 孤儿组合修复 (v8 原生层·测试输入法闭环实证的最底层根因):
//      空 Slate 编辑器首记 setComposingText → Slate 重挂节点 → restartInput 把起步组合
//      就地提交成孤儿; IME 继续以全量累积串组合 → 首字重复/被删。修法 = InputConnection
//      层记孤儿前缀、对后续全量串只透传余量; 绝不删已落文字(删空会再触发重挂 → 死循环)。
ok(/String orphanPrefix = ""/.test(main), "孤儿修复: orphanPrefix 账本存在");
ok(/orphanPrefix = orphanPrefix \+ activeComp/.test(main), "孤儿修复: IC 重建时累计被就地提交的组合");
ok(/if \(fresh && s\.startsWith\(orphanPrefix\)\) \{ s = s\.substring\(orphanPrefix\.length\(\)\); icAltered = true; \}/.test(main), "孤儿修复: 全量累积串只透传余量(时效窗内·剥后对账)");
ok(/else orphanPrefix = "";/.test(main), "孤儿修复: 过期/非前缀即弃账(不误剥用户新输入)");
const gwv = main.slice(main.indexOf("class GuardedWebView"), main.indexOf("void applyImmersive"));
ok(!/deleteSurroundingText\(orphanPrefix/.test(gwv) && !/super\.deleteSurroundingText\(p\.length/.test(gwv), "孤儿修复: 不删已落文字(防空/非空重挂死循环·实测验证)");
ok(/activeComp = null; orphanPrefix = "";\s*\n\s*boolean r = super\.finishComposingText/.test(main), "孤儿修复: finishComposingText 清账(随后对账)");

// ②c3 取数统一 (拖拽/传到当前页 统一到「下载MD」同源快路径)
const daopan = fs.readFileSync(path.join(ROOT, "app/src/main/assets/engine/daopan.html"), "utf8");
ok(/private void fastPanelExtractInject\(/.test(main), "取数统一: fastPanelExtractInject 存在");
ok(/DaoCloud\.exportSession\(acc,sid,'conversation'\)/.test(main), "取数统一: 面板快路径走 DaoCloud.exportSession (与下载MD同源)");
ok(/public void convMdResult\(String reqId, String title, String md\)/.test(main), "取数统一: Bridge.convMdResult 回灌通道");
ok(/fastPanelExtractInject\(sid, accJson, target, x, y, fallback\)/.test(main), "取数统一: 链路 本地备份→面板快路径→fallback(旧引擎 RPC/源页 fetch 降级腿已移除)");
ok(!/engineRpcExtractInject/.test(main), "取数统一: 旧引擎 RPC 取数腿已整体移除(降级产物乱数据根源)");
ok(/tryLocalBackupInject\(email, accJson, sid, target, x, y\)/.test(main), "取数统一: 本地备份秒注入仍为第一优先");
ok(/public void deliverConvToPage\(String name, String b64\)/.test(main), "取数统一: Bridge.deliverConvToPage 原生直投");
ok(/private void deliverConvToActivePage\(String name, String b64\)/.test(main), "取数统一: 直投当前活动标签实现");
ok(/public void deliverConvFilesToPage\(String filesJson\)/.test(main), "取数统一: Bridge.deliverConvFilesToPage 两形态直投");
ok(/if\(!IS_WEB && N\.deliverConvFilesToPage\)\{ N\.deliverConvFilesToPage\(JSON\.stringify\(files\)\); return; \}/.test(daopan), "取数统一: daopan 传到当前页 = 对话MD+取数指引两形态直投");
ok(/Native\.accessGuideMd\(JSON\.stringify\(it\.acc\), it\.sid/.test(daopan), "取数统一: 传到当前页同投取数指引 (提取失败亦至少投指引)");

// ②d 媒体鉴权本源补齐: 非账号标签从页面登录态采收 auth
ok(/private void harvestPageAuth\(WebView v, Tab tab, String pageUrl\)/.test(main), "harvestPageAuth 存在");
ok(/harvestPageAuth\(v, tab, u\); \/\/[^\n]*\n\s*warmAttachmentCookie/.test(main) || /harvestPageAuth\(v, tab, u\);/.test(main), "onPageFinished 采收页面登录态");
ok(/installBackspaceGuard\(v\); installVideoFit\(v\); installMediaRetry\(v\); harvestPageAuth\(v, tab, u\); warmAttachmentCookie/.test(main), "SPA 路由后重采 (doUpdateVisitedHistory)");
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
