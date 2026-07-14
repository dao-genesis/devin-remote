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

process.exit(failures ? 1 : 0);
