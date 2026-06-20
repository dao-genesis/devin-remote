"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-relay · 纯逻辑模块 (鉴权/定址) —— 与 Cloudflare 运行时解耦
//
// 道法自然: 把「定址 + 配对鉴权」抽成纯函数, 既供 worker.js 引用, 又供 node:test 直接
// import 单测。**不可**把这些从 worker.js 入口再导出 —— Workers 运行时(workerd)会把入口
// 模块的每个具名导出都当作 entrypoint(DO 类 / ExportedHandler)登记, 导出普通值/函数会让
// 运行时启动即报: "Incorrect type for map entry 'VERSION': not of type
// 'function or ExportedHandler'", 连带 `wrangler dev` / `wrangler deploy` 失败。
// 故归一于此独立模块, 入口只导出 default 处理器与 RelayDO 类。
// ═══════════════════════════════════════════════════════════════════════════

export const VERSION = "3.1.0-console"; // (session,token) 配对模型 + WebSocket Hibernation(上量省钱) + GET /console 自托管单网页控制台。重新部署后 /health 报此值即生效。

// DO 命名空间定址: session 与 token 共同决定实例 —— 「知道 session+token」即凭证。
// 用 \u0000 作分隔(token/session 不含 NUL), 避免 "a"+"bc" 与 "ab"+"c" 撞键。
export function relayKey(session, token) {
  return String(session) + "\u0000" + String(token);
}

// 可选私有模式闸门: 仅当部署设置了 env.DAO_TOKEN 才生效(锁定单一密钥); 默认开放配对。
export function sharedTokenOk(env, token) {
  const shared = env && env.DAO_TOKEN ? String(env.DAO_TOKEN) : "";
  if (!shared) return true; // 未设共享密钥 = 零账号开放配对
  return token === shared;
}
