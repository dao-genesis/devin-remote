#!/usr/bin/env node
// dao-mesh-rpc.mjs · 去中心化路线C 的 Node/Agent 客户端 (道法自然·无为而无不为)
//
// 经多家互不隶属的公共 ntfy mesh 加密直达本机 APK 引擎, 驱动其全部 RPC —— 全程零 Worker、零账号。
// 与浏览器端 p2p-client.html 同源底座: 直接 vm 加载同目录上层的 signal.js (DaoSignal), 不复制其逻辑。
// 载荷以 token 派生的 AES-256-GCM 封装, 公共 broker 全程只见密文。
//
// 用法:
//   node dao-mesh-rpc.mjs <session> <token> '<json-frame>'
//   node dao-mesh-rpc.mjs <session> <token> ping
//
// 例:
//   node dao-mesh-rpc.mjs rtflow-xxxx <TOKEN> '{"path":"/api/rpc","method":"POST","body":{"cmd":"getState"}}'
//   node dao-mesh-rpc.mjs rtflow-xxxx <TOKEN> '{"path":"/api/health","method":"GET","body":{}}'
//   node dao-mesh-rpc.mjs rtflow-xxxx <TOKEN> ping
//
// 退出码: 0 成功; 1 参数/运行错误。RPC 响应以 JSON 打印到 stdout。
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// signal.js 与 p2p-client.html 同源, 位于 ../app/src/main/assets/engine/signal.js
const SIGNAL = path.resolve(HERE, "..", "app", "src", "main", "assets", "engine", "signal.js");

const SESSION = process.argv[2];
const TOKEN = process.argv[3];
const RAW = process.argv[4];

function usage(msg) {
  if (msg) console.error("错误: " + msg);
  console.error("用法: node dao-mesh-rpc.mjs <session> <token> '<json-frame>' | ping");
  process.exit(1);
}
if (!SESSION || !TOKEN || !RAW) usage("缺少参数");
if (!fs.existsSync(SIGNAL)) usage("找不到 signal.js: " + SIGNAL);

const isPing = RAW.trim().toLowerCase() === "ping";
let frame = null;
if (!isPing) {
  try { frame = JSON.parse(RAW); }
  catch (e) { usage("frame 不是合法 JSON: " + e.message); }
  if (!frame || typeof frame !== "object") usage("frame 须为 JSON 对象");
  if (!frame.path) frame.path = "/api/rpc";
  if (!frame.method) frame.method = "POST";
  if (!frame.body) frame.body = {};
}

// 浏览器全局垫片: signal.js 只需 fetch / WebSocket / crypto.subtle / AbortController / performance (node18+ 全有)。
const sandbox = {
  fetch, WebSocket, AbortController, performance, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
  Math, Date, JSON, Promise, Object, Array, String,
};
sandbox.window = sandbox;              // signal.js: root = window
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SIGNAL, "utf8"), ctx, { filename: "signal.js" });
const DaoSignal = sandbox.DaoSignal;
if (!DaoSignal || typeof DaoSignal.connect !== "function") usage("signal.js 未导出 DaoSignal.connect");

(async () => {
  const t0 = Date.now();
  // happy-eyeballs: 默认先抢 P2P 直连, 未通即并行 ntfy 中继 (与浏览器端一致)。控制面恒可用、零 Worker。
  const h = await DaoSignal.connect({ session: SESSION, token: TOKEN });
  console.error(`[mesh] 已直连 ${Date.now() - t0}ms  mode=${h.mode}  topic=${h.topic || "-"}  servers=${(h.servers || []).join(",")}`);

  if (isPing) {
    const ms = await h.ping();
    console.log(JSON.stringify({ ok: true, ping_ms: Math.round(ms), mode: h.mode }));
  } else {
    const res = await h.rpc(frame);
    const out = { ok: true, status: res && res.status, mode: h.mode };
    if (res && typeof res.bodyText === "string") {
      try { out.body = JSON.parse(res.bodyText); } catch (e) { out.bodyText = res.bodyText; }
    } else if (res) {
      out.raw = res;
    }
    console.log(JSON.stringify(out));
  }
  try { h.close(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error("[mesh] FATAL " + (e && e.stack || e)); process.exit(1); });
