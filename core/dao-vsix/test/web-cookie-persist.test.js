// web-cookie-persist.test.js · 源级护栏: 站内网页反代 per-origin Cookie 罐必须**落盘持久化**。
//
// 病灶(已修): webProxyCookieJar 纯内存 Map, 窗口/插件一重载即全丢 → 浏览站登录态每次都掉
//   (用户所述「搜索引擎账号登录凭证不保存·一刷新就掉登录」)。
// 正法(帛书·「善抱者不脱」): 收到 Set-Cookie 变更即 debounce 落盘 ~/.dao/web-cookies.json;
//   首次读/写前 webProxyLoadCookies() 从盘回灌 → 跨重载登录态自动续接。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 站内网页 Cookie 罐落盘持久化 · 源级护栏]");

ok(/const\s+WEB_COOKIE_FILE\s*=\s*path\.join\(DAO_DIR,\s*['"]web-cookies\.json['"]\)/.test(src),
  "Cookie 落盘路径 WEB_COOKIE_FILE = ~/.dao/web-cookies.json");
ok(/function\s+webProxyLoadCookies\s*\(\)/.test(src), "存在回灌函数 webProxyLoadCookies()");
ok(/function\s+webProxyPersistCookies\s*\(\)/.test(src), "存在落盘函数 webProxyPersistCookies()");

// 读/写路径都必须先回灌(否则重载后首个请求读到空罐)
const hdr = src.slice(src.indexOf("function webProxyCookieHeader"), src.indexOf("function webProxyStoreCookies"));
ok(/webProxyLoadCookies\(\)/.test(hdr), "webProxyCookieHeader 先 webProxyLoadCookies() 回灌");
const store = src.slice(src.indexOf("function webProxyStoreCookies"), src.indexOf("执今之道见小曰明"));
ok(/webProxyLoadCookies\(\)/.test(store), "webProxyStoreCookies 先 webProxyLoadCookies() 回灌");
ok(/if\s*\(\s*changed\s*\)\s*webProxyPersistCookies\(\)/.test(store), "仅在真有变更时落盘(省 IO)");

// 落盘为 debounce(定时器合并写), 且写前建目录
const persist = src.slice(src.indexOf("function webProxyPersistCookies"), src.indexOf("function webProxyCookieHeader"));
ok(/setTimeout\(/.test(persist) && /_webCookieSaveTimer/.test(persist), "落盘 debounce 合并写(_webCookieSaveTimer)");
ok(/writeSecretFile\(WEB_COOKIE_FILE/.test(persist), "经 writeSecretFile 落盘(内建目录 0700·文件 0600)");

console.log("全部通过 (" + pass + " 项)");
