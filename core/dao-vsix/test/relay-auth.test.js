// relay-auth.test.js · 源级护栏: 持久通道(dao-relay Worker)请求注入权威 Bearer。
//
// 病灶(已修): Worker 转发帧只含 {path,method,body} 不带 headers → handleRelayRequest 的
//   fakeReq 无 Authorization, checkAuth 必判 unauthorized → 持久通道仅能打免鉴权 /api/health,
//   /api/exec、/api/file 等需鉴权端点全部 401, 形同半残 — 只能退到 ntfy mesh 兜底(慢·易丢片)。
// 正法(帛书·「解之即得·不疑其门」): DO 按 relayKey(session, token) 定址, 驱动方必须持有相同
//   (session, token) 才可达本 agent → 请求送达本身即等同鉴权, 与路线C sig 通道同法注入权威 Bearer。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 持久通道鉴权注入 · 源级护栏]");

const fnStart = src.indexOf("async function handleRelayRequest");
ok(fnStart > 0, "存在 handleRelayRequest");
const fn = src.slice(fnStart, src.indexOf("function stopRelay"));

// 必须注入权威 Bearer(与 sig 通道同法), 不再裸传 msg.headers
ok(/bridgeAuthoritativeToken\(\)/.test(fn), "handleRelayRequest 取权威令牌 bridgeAuthoritativeToken()");
ok(/authorization'\]\s*=\s*'Bearer '/.test(fn), "handleRelayRequest 注入 Authorization: Bearer");
ok(!/headers:\s*msg\.headers\s*\|\|\s*\{\}\s*,/.test(fn), "不再裸用 headers: msg.headers || {}(无鉴权半残旧法)");

// 客户端自带 headers 仍取并集(向后兼容), 且权威 Bearer 强置(不可被伪造覆盖)
ok(/Object\.assign\([^)]*msg\.headers/.test(fn), "保留 msg.headers 并集(向后兼容)");
ok(/delete\s+relayHeaders\['Authorization'\]/.test(fn), "去重大小写 Authorization(强置权威 Bearer)");

// 路线C sig 通道的同源修法仍在(两通道对齐, 不允许只修一边)
ok(/sigAuthTok\s*=\s*bridgeAuthoritativeToken\(\)/.test(src), "路线C sig 通道权威 Bearer 注入仍在(双通道对齐)");

console.log("全部通过 (" + pass + " 项)");
