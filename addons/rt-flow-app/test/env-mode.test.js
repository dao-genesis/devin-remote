"use strict";
// 源级护栏(反向): 自制「新对话虚拟机环境」三态切换/前端注入子系统已整体撤除 —— 环境选择归一官方原生入口。
//   ① 官方页零注入: 无 installEnvModeBadge / installComposerUpload, 无 __rtEnv*/__rtNewUp/data-rtenv/data-rtup 钩子;
//   ② 原生层零残留: 无 envModePref*/envModeGet/envModeSet 桥 (MainActivity/TabActivity/RelayService);
//   ③ 引擎层零残留: devin-cloud.js 无 getEnvMode/setEnvMode/nextEnvMode/envModeLabel, createSession 不注入 platform 字段;
//   ④ 切号面板零残留: switch.html 无 dvEnvCycle/dvEnv 按钮, dvCreate 不传 platform;
//   ⑤ 官方环境 UI 显形保留 (buildInjection · document_start UA 去 Mobile) —— 官方原生入口全权接管。
// 无框架: 直接 node test/env-mode.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow");
const cloudSrc = fs.readFileSync(path.join(ENGINE, "devin-cloud.js"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");
const mainSrc = fs.readFileSync(path.join(JAVA, "MainActivity.java"), "utf8");
const tabSrc = fs.readFileSync(path.join(JAVA, "TabActivity.java"), "utf8");
const relaySrc = fs.readFileSync(path.join(JAVA, "RelayService.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── ① 官方页零注入 ──
ok(!/installEnvModeBadge/.test(mainSrc) && !/installEnvModeBadge/.test(tabSrc), "无 installEnvModeBadge (官方页环境钩子已撤)");
ok(!/installComposerUpload/.test(mainSrc) && !/installComposerUpload/.test(tabSrc), "无 installComposerUpload (＋菜单注入已撤)");
ok(!/__rtEnv/.test(mainSrc) && !/__rtNewUp/.test(mainSrc), "无 __rtEnv*/__rtNewUp 注入守卫残留");
ok(!/data-rtenv/.test(mainSrc) && !/data-rtup/.test(mainSrc), "无 data-rtenv/data-rtup 菜单项残留");
ok(!/上传到网页端/.test(mainSrc.match(/static void install[\s\S]*?\n    \}/g)?.join("") || ""), "install* 注入子不再含「上传到网页端」");

// ── ② 原生层零残留 ──
ok(!/envModePrefGet|envModePrefSet|envModeNorm/.test(mainSrc), "MainActivity 无 envModePref* 存储");
ok(!/envModeGet|envModeSet/.test(mainSrc + tabSrc + relaySrc), "MainActivity/TabActivity/RelayService 无 envModeGet/Set 桥");
ok(!/pickUpload\(\)\s*\{\s*main\.post/.test(mainSrc), "RTDL 桥无 pickUpload (＋菜单直传入口已撤)");
ok(/private void pickUploadToPage\(\)/.test(mainSrc), "下载面板自身「⬆ 上传」入口保留 (非官方页注入)");

// ── ③ 引擎层零残留: createSession 不再自造/注入平台字段 ──
const csSeg = cloudSrc.match(/async function createSession\(acc, prompt, opts\)\s*\{[\s\S]*?\n  \}/);
ok(!!csSeg, "devin-cloud.js 含 createSession");
ok(!/platform/.test(csSeg[0]), "createSession 不携带任何 platform 字段 (环境归一官方)");
ok(!/getEnvMode|setEnvMode|nextEnvMode|envModeLabel|ENVMODE_KEY|_emBridge|normPlatform|ENV_PLATFORMS/.test(cloudSrc), "devin-cloud.js 无环境模式子系统残留");
ok(!/platform_explicitly_set|additional_args\.platform/.test(cloudSrc.replace(/\/\/[^\n]*/g, "")), "不注入官方新建请求平台字段");

// ── ④ 切号面板零残留 ──
ok(!/dvEnvCycle|dvEnv'|getEnvMode|envModeLabel/.test(switchSrc), "switch.html 无 dvEnv 三态循环 UI");
ok(/DaoCloud\.createSession\(a,p\)/.test(switchSrc), "dvCreate 直发 createSession(a,p) 不传 platform");

// ── ⑤ 官方环境 UI 显形保留 (buildInjection · document_start UA 去 Mobile · 源级护栏) ──
//   官方 SPA 按移动 UA (Android + Mobile) 隐藏 Configuration(⚙ Virtual environment/MCP)入口。
//   根修 = document_start 覆写 navigator.userAgent 去 'Mobile' 标记 (仅 JS 层·保留 Android·不动 HTTP 头)。
{
  const inj = tabSrc.match(/static String buildInjection[\s\S]*?\n    \}/)[0];
  ok(/navigator\.userAgent\|\|''/.test(inj), "buildInjection 读 navigator.userAgent");
  ok(/replace\(' Mobile Safari',' Safari'\)/.test(inj) && /replace\(' Mobile',''\)/.test(inj), "去 'Mobile' 标记 (Mobile Safari→Safari)");
  ok(/Object\.defineProperty\(Navigator\.prototype,'userAgent'/.test(inj), "JS 层 defineProperty 覆写 (不动原生 WebView UA/HTTP 头)");
  ok(/NavigatorUAData\.prototype,'mobile'/.test(inj), "UA-CH: navigator.userAgentData.mobile → false");
  ok(/if\(dua!==ua\)/.test(inj), "非移动 UA 环境不覆写 (幂等/无副作用)");
  ok(!/setUserAgentString\(DESKTOP_UA\)/.test(inj), "不整体换桌面 UA (保 Android 输入法路径)");
  ok(/addDocumentStartJavaScript\(web, script, Collections\.singleton\("https:\/\/app\.devin\.ai"\)\)/.test(tabSrc), "document_start 注入仅限 app.devin.ai");
}

process.exit(failures ? 1 : 0);
