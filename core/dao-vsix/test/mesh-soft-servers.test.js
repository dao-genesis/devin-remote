// mesh-soft-servers.test.js · 源级护栏: 路线C(去中心化 ntfy mesh) broker 清单软编码。
//
// 目标(帛书·「软编码适配一切」): broker 不写死。分发给别人时若其网络把默认公共 ntfy 全墙掉,
//   只需在环境变量 DAO_MESH_SERVERS / DAO_NTFY_SERVERS 或 ~/.dao/dao-config.json 的 daoMeshServers
//   里补一个可达实例即打通路线C, 无需改代码。与手机版 signal.js normServers 同法(去尾斜杠/仅 http(s)/去重),
//   最终恒并默认集兜底(用户自定优先在前) → 去中心化本源不变、单点封锁不致命。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 路线C broker 软编码 · 源级护栏]");

// ① 存在软编码解析器 + 归一器
ok(/function\s+sigResolveServers\s*\(/.test(src), "存在 sigResolveServers() broker 软编码解析器");
ok(/function\s+sigNormServers\s*\(/.test(src), "存在 sigNormServers() 归一器(与手机版 normServers 同法)");

// ② 读环境变量(分发/受限网络首选)
ok(/process\.env\.DAO_MESH_SERVERS/.test(src), "读取环境变量 DAO_MESH_SERVERS");
ok(/process\.env\.DAO_NTFY_SERVERS/.test(src), "兼容环境变量 DAO_NTFY_SERVERS");

// ③ 读配置文件字段(与代理口等软编码项同源)
ok(/daoMeshServers/.test(src), "读取 ~/.dao/dao-config.json 的 daoMeshServers 字段");
ok(/GLOBAL_CONFIG_FILE/.test(src.slice(src.indexOf("function sigResolveServers"), src.indexOf("function sigResolveServers") + 900)),
   "sigResolveServers 从 GLOBAL_CONFIG_FILE 读配置");

// ④ 归一语义: 仅收 http(s) + 去尾斜杠 + 去重
const normFn = src.slice(src.indexOf("function sigNormServers"), src.indexOf("function sigResolveServers"));
ok(/\^https\?:\\\/\\\//.test(normFn) || /\/\^https\?:/.test(normFn), "sigNormServers 仅接受 http(s):// 前缀");
ok(/replace\(\/\\\/\+\$\/,\s*''\)/.test(normFn), "sigNormServers 去尾斜杠");
ok(/new Set/.test(normFn), "sigNormServers 去重");

// ⑤ 恒并默认集兜底(不会因用户填了错的就丢默认)
const resFn = src.slice(src.indexOf("function sigResolveServers"), src.indexOf("interface SigState"));
ok(/concat\(SIG_DEFAULT_SERVERS\)/.test(resFn), "用户自定恒并 SIG_DEFAULT_SERVERS 兜底");
ok(/SIG_DEFAULT_SERVERS\.slice\(\)/.test(resFn), "解析全空时回落默认集(去中心化本源不断)");

// ⑥ sigStart 用软编码解析(不再写死 SIG_DEFAULT_SERVERS.slice())
const startFn = src.slice(src.indexOf("async function sigStart"), src.indexOf("function sigWatchRekey"));
ok(/sigState\.servers\s*=\s*sigResolveServers\(\)/.test(startFn), "sigStart 用 sigResolveServers() 装载 broker");
ok(!/sigState\.servers\s*=\s*SIG_DEFAULT_SERVERS\.slice\(\)/.test(startFn), "sigStart 不再写死 SIG_DEFAULT_SERVERS.slice()");

console.log("全部通过 (" + pass + " 项)");
