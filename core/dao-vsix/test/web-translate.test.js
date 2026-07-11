// web-translate.test.js · 源级护栏: 整页翻译板块 (对齐手机 APK TranslateBridge/translate.js)。
//
// 契约: ① 服务端 /__translate (POST texts→translations) 与 /__translate.js (引擎) 两路由存在;
//   ② 服务端代调 Edge 翻译 API (令牌 edge.microsoft.com/translate/auth + api-edge 翻译端点,
//      401 令牌过期重取, 直连+代理 CONNECT 双赛道);
//   ③ 引擎与手机 APK assets/engine/translate.js 同构 (核心 API 面: __dcTrans/__dcTrCb/
//      __dcTransRestore/__dcOrig · 跳过 CODE/PRE 等 · Shadow DOM · 分批 64/7000 · 增量观察);
//   ④ 站内代理页注入 __dcTr 桥 + 悬浮「译」按钮, 且桥走原生 fetch(__daoNF) 免被拦截器改写。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[整页翻译 · 服务端路由]");
ok(/route === '\/__translate'/.test(src), "/__translate 路由存在");
ok(/route === '\/__translate\.js'/.test(src), "/__translate.js 引擎路由存在");
ok(/daoTranslateTexts\(_texts/.test(src), "/__translate 调 daoTranslateTexts");
ok(/'缺少 texts 数组'/.test(src), "缺 texts 时 400 守柔");

console.log("[整页翻译 · Edge 翻译服务端代调]");
ok(/edge\.microsoft\.com\/translate\/auth/.test(src), "令牌端点 edge.microsoft.com/translate/auth");
ok(/api-edge\.cognitive\.microsofttranslator\.com\/translate\?api-version=3\.0&to=/.test(src), "翻译端点 api-edge…/translate?api-version=3.0&to=");
ok(/if \(r\.status === 401\) _transToken = ''/.test(src), "401 令牌过期 → 清空重取");
ok(/8 \* 60 \* 1000\) return _transToken/.test(src), "令牌缓存 8 分钟复用 (对齐手机 ensureTransToken)");
ok(/function _transHttpsReq\(/.test(src) && /createProxyTunnel\(u\.hostname\)/.test(src.slice(src.indexOf("function _transHttpsReq"))), "直连+本机代理 CONNECT 双赛道");

console.log("[整页翻译 · 引擎与手机 APK 同构]");
const engStart = src.indexOf("function daoTransEngineJs");
ok(engStart > 0, "daoTransEngineJs 引擎函数存在");
const eng = src.slice(engStart, src.indexOf("})();`;", engStart));
["window.__dcTrans", "window.__dcTrCb", "window.__dcTransRestore", "__dcOrig",
  "NodeFilter.SHOW_TEXT", "shadowRoot", "MutationObserver", "isContentEditable",
  "notranslate"].forEach((k) => ok(eng.indexOf(k) >= 0, "引擎含 " + k));
ok(/cur\.length >= 64 \|\| chars \+ len > 7000/.test(eng), "分批 ≤64 段且 ≤7000 字符 (对齐手机)");
["SCRIPT", "TEXTAREA", "CODE", "PRE", "CANVAS"].forEach((t) =>
  ok(new RegExp(t + ":\\s*1").test(eng), "跳过 " + t + " 标签"));

console.log("[整页翻译 · 站内代理页注入桥]");
ok(/window\.__daoNF=_F\.bind\(window\)/.test(src), "拦截器改写前先存原生 fetch → __daoNF");
ok(/window\.__dcTr=\{translate:function/.test(src), "注入 __dcTr 桥 (与手机原生桥同 API 面)");
ok(/O\+"\/__translate"/.test(src), "桥经同源 /__translate 代调");
ok(/O\+"\/__translate\.js"/.test(src), "引擎懒加载自 /__translate.js");
ok(/__daoTransBtn/.test(src), "悬浮「译」按钮注入");
ok(/window\.__daoTransToggle/.test(src), "翻译/还原切换 __daoTransToggle");
ok(/window\.__dcTransRestore&&window\.__dcTransRestore\(\)/.test(src), "还原走 __dcTransRestore (对齐手机)");

console.log("[web-translate] " + pass + " assertion(s) passed\n");
