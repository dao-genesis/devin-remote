"use strict";
// 官方环境模式(Linux/Windows/macOS) · 只对「新建对话」生效 (逆向自 app.devin.ai SPA):
//   新建请求 = additional_args.platform ∈ {linux,windows,macos} + 顶层 platform_explicitly_set=true。
//   1) devin-cloud.js: normPlatform 三态归一化 + createSession 注入官方字段 (功能实测·真代码 eval);
//   2) 每账号 getEnvMode/setEnvMode/nextEnvMode 本地持久化 · 每号隔离互不相干 (功能实测);
//   3) switch.html: dvEnvCycle 三态循环 UI + dvCreate 传 {platform:em} (源级护栏);
//   4) 只作用于新建对话: sendMessage/updateSession 等不得携带 platform (源级护栏)。
// 无框架: 直接 node test/env-mode.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const cloudSrc = fs.readFileSync(path.join(ENGINE, "devin-cloud.js"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 1) normPlatform 三态归一化 (真代码 eval) ──
const npSeg = cloudSrc.match(/function normPlatform\(m\)\s*\{[\s\S]*?\n  \}/);
ok(!!npSeg, "devin-cloud.js 含 normPlatform");
const normPlatform = eval("(function(){" + npSeg[0] + " return normPlatform;})()");
ok(normPlatform("windows") === "windows" && normPlatform("win") === "windows", "windows/win → windows");
ok(normPlatform("macos") === "macos" && normPlatform("mac") === "macos" && normPlatform("darwin") === "macos", "macos/mac/darwin → macos");
ok(normPlatform("linux") === "linux" && normPlatform("") === "linux" && normPlatform(null) === "linux", "linux/空/null → linux (缺省)");
ok(normPlatform("WINDOWS") === "windows", "大小写不敏感");

// ── 2) createSession 注入官方字段 (源级) ──
const csSeg = cloudSrc.match(/async function createSession\(acc, prompt, opts\)\s*\{[\s\S]*?\n  \}/);
ok(!!csSeg, "devin-cloud.js 含 createSession");
ok(/if \(opts\.platform\)/.test(csSeg[0]), "createSession 仅在 opts.platform 显式给时注入 (缺省不注入·尊重官方默认)");
ok(/payload\.additional_args\.platform = pf/.test(csSeg[0]), "注入 additional_args.platform (官方字段)");
ok(/payload\.platform_explicitly_set = true/.test(csSeg[0]), "注入顶层 platform_explicitly_set=true (官方字段)");
ok(/normPlatform\(opts\.platform\)/.test(csSeg[0]), "platform 经 normPlatform 归一化 (只出 linux/windows/macos)");

// ── 3) 每账号环境模式持久化 · 每号隔离 (功能实测·mock localStorage) ──
{
  const emSeg = cloudSrc.match(/var ENVMODE_KEY[\s\S]*?function envModeLabel\(m\)[^\n]*\n/);
  ok(!!emSeg, "devin-cloud.js 含 ENVMODE_KEY..envModeLabel 区段");
  const store = {};
  const root = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  const api = eval("(function(root){ var ENV_PLATFORMS=[\"linux\",\"windows\",\"macos\"];" + npSeg[0] + emSeg[0] +
    " return {getEnvMode:getEnvMode,setEnvMode:setEnvMode,nextEnvMode:nextEnvMode,envModeLabel:envModeLabel};})")(root);
  const a1 = { email: "A@x.com" }, a2 = { email: "b@x.com" };
  ok(api.getEnvMode(a1) === "linux", "无记录缺省 linux");
  ok(api.nextEnvMode(a1) === "windows" && api.getEnvMode(a1) === "windows", "步进 linux→windows 且持久");
  ok(api.nextEnvMode(a1) === "macos" && api.nextEnvMode(a1) === "linux", "三态循环 windows→macos→linux");
  api.setEnvMode(a1, "macos");
  ok(api.getEnvMode(a2) === "linux", "每号隔离: 改 a1 不波及 a2 (a2 仍缺省 linux)");
  ok(api.getEnvMode({ email: "a@X.COM" }) === "macos", "email 大小写归一 (同号同模式)");
  ok(api.envModeLabel("windows").indexOf("Windows") >= 0 && api.envModeLabel("macos").indexOf("macOS") >= 0, "envModeLabel 三态文案");
}

// ── 4) switch.html: 环境模式 UI + dvCreate 传 platform (源级护栏) ──
ok(/function dvEnvCycle\(i\)\{/.test(switchSrc), "switch.html 含 dvEnvCycle 三态循环");
ok(/DaoCloud\.nextEnvMode\(a\)/.test(switchSrc), "dvEnvCycle 经 DaoCloud.nextEnvMode (每号各自步进)");
ok(/id="dvEnv'\+i\+'"/.test(switchSrc), "账号详情含 dvEnv 环境模式按钮 (可查看当前环境)");
ok(/仅对新建对话生效|只对新建对话生效/.test(switchSrc), "UI 明示只对新建对话生效");
ok(/DaoCloud\.createSession\(a,p,\{platform:em\}\)/.test(switchSrc), "dvCreate 把该号环境模式传入 createSession");
ok(/var em=DaoCloud\.getEnvMode\(a\)/.test(switchSrc), "dvCreate 读该号(卡内账号)的模式 — 不跨号");

// ── 5) 只作用于新建对话: 其它请求不得携带 platform ──
{
  const others = cloudSrc.replace(csSeg[0], "");
  ok(!/platform_explicitly_set/.test(others.replace(/\/\/[^\n]*/g, "")), "platform_explicitly_set 只出现在 createSession (不动已有对话)");
  ok(!/additional_args\.platform/.test(others.replace(/\/\/[^\n]*/g, "")), "additional_args.platform 只出现在 createSession");
}

// ── 6) 官方页零注入 (无为而治 · 源级护栏): 旧注入的「⬆上传到网页端」＋菜单项与
//      「新对话虚拟机环境」切换/请求钩子已整体撤除 —— 上传/环境选择全走官方原生入口。
{
  const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow");
  const mainSrc = fs.readFileSync(path.join(JAVA, "MainActivity.java"), "utf8");
  const tabSrc = fs.readFileSync(path.join(JAVA, "TabActivity.java"), "utf8");
  const relaySrc = fs.readFileSync(path.join(JAVA, "RelayService.java"), "utf8");
  ok(!/installEnvModeBadge/.test(mainSrc) && !/installEnvModeBadge/.test(tabSrc), "installEnvModeBadge 已整体撤除 (环境选择全走官方 Configuration)");
  ok(!/installComposerUpload/.test(tabSrc) && !/static void installComposerUpload/.test(mainSrc), "installComposerUpload 已整体撤除 (上传走官方附件入口)");
  ok(!/data-rtenv/.test(mainSrc) && !/data-rtup/.test(mainSrc), "官方 ＋ 菜单零注入菜单项 (data-rtup/data-rtenv 绝迹)");
  ok(!/__rtEnvMode/.test(mainSrc) && !/__rtNewUp/.test(mainSrc), "官方页 fetch/XHR 环境钩子与菜单观察器绝迹");
  ok(!/上传到网页端/.test(mainSrc.match(/private class DlBridge[\s\S]*?\n    \}/)[0] || ""), "RTDL 桥不再暴露 pickUpload (菜单注入链已断)");
  ok(/private void pickUploadToPage\(\)/.test(mainSrc), "下载悬浮窗「⬆ 上传」原生入口保留 (pickUploadToPage)");
  // 引擎切号面板(自家页面·非官方页注入)的环境模式能力保留:
  ok(/envModePrefGet/.test(mainSrc) && /envModePrefSet/.test(mainSrc), "SharedPreferences 单一真源读写保留 (引擎面板用)");
  ok(/envModeGet/.test(relaySrc) && /envModeSet/.test(relaySrc), "RelayService 引擎桥同一真源");
  ok(/_emBridge/.test(cloudSrc), "devin-cloud.js getEnvMode/setEnvMode 优先原生桥");
}

// ── 7) 官方环境 UI 显形 (buildInjection · document_start UA 去 Mobile · 源级护栏) ──
//   官方 SPA 按移动 UA (Android + Mobile) 隐藏 Configuration(⚙ Virtual environment/MCP)入口。
//   根修 = document_start 覆写 navigator.userAgent 去 'Mobile' 标记 (仅 JS 层·保留 Android·不动 HTTP 头)。
{
  const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow");
  const tabSrc = fs.readFileSync(path.join(JAVA, "TabActivity.java"), "utf8");
  const inj = tabSrc.match(/static String buildInjection[\s\S]*?\n    \}/)[0];
  ok(/navigator\.userAgent\|\|''/.test(inj), "buildInjection 读 navigator.userAgent");
  ok(/replace\(' Mobile Safari',' Safari'\)/.test(inj) && /replace\(' Mobile',''\)/.test(inj), "去 'Mobile' 标记 (Mobile Safari→Safari)");
  ok(/Object\.defineProperty\(Navigator\.prototype,'userAgent'/.test(inj), "JS 层 defineProperty 覆写 (不动原生 WebView UA/HTTP 头)");
  ok(/NavigatorUAData\.prototype,'mobile'/.test(inj), "UA-CH: navigator.userAgentData.mobile → false");
  ok(/if\(dua!==ua\)/.test(inj), "非移动 UA 环境不覆写 (幂等/无副作用)");
  ok(!/setUserAgentString\(DESKTOP_UA\)/.test(inj), "不整体换桌面 UA (保 Android 输入法路径)");
  // 注入仍限定 app.devin.ai (document_start allowlist)
  ok(/addDocumentStartJavaScript\(web, script, Collections\.singleton\("https:\/\/app\.devin\.ai"\)\)/.test(tabSrc), "document_start 注入仅限 app.devin.ai");
}

process.exit(failures ? 1 : 0);
