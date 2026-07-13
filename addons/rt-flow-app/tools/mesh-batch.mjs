#!/usr/bin/env node
// mesh-batch.mjs · 复用一条 route-C 连接, 顺序执行多个 RPC frame (stdin: 每行一个 JSON frame 或 "cmd:<名字>")
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = (await import("ws")).WebSocket;
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIGNAL = path.resolve(HERE, "..", "app", "src", "main", "assets", "engine", "signal.js");
const SESSION = process.argv[2], TOKEN = process.argv[3];
if (!SESSION || !TOKEN) { console.error("用法: node mesh-batch.mjs <session> <token> < frames.jsonl"); process.exit(1); }

class _NoRTC { constructor() { throw new Error("ice_failed"); } }
const sandbox = {
  fetch, WebSocket, AbortController, performance, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
  Math, Date, JSON, Promise, Object, Array, String,
  RTCPeerConnection: _NoRTC, RTCSessionDescription: _NoRTC,
};
sandbox.window = sandbox;
vm.runInContext(fs.readFileSync(SIGNAL, "utf8"), vm.createContext(sandbox), { filename: "signal.js" });
const DaoSignal = sandbox.DaoSignal;

const lines = [];
const rl = readline.createInterface({ input: process.stdin });
for await (const l of rl) { const t = l.trim(); if (t) lines.push(t); }

const t0 = Date.now();
let h = null;
for (let i = 0; i < 4 && !h; i++) {
  try { h = await DaoSignal.connect({ session: SESSION, token: TOKEN }); }
  catch (e) { console.error(`[mesh] connect try${i + 1} failed: ${e && e.message}`); if (i === 3) process.exit(1); }
}
console.error(`[mesh] connected ${Date.now() - t0}ms mode=${h.mode}`);
for (const t of lines) {
  let frame;
  if (t.startsWith("cmd:")) frame = { path: "/api/rpc", method: "POST", body: { cmd: t.slice(4) } };
  else frame = JSON.parse(t);
  const ts = Date.now();
  try {
    let res = await h.rpc(frame);
    if (typeof res === "string") { try { res = JSON.parse(res); } catch (e) {} }
    let body = res && res.bodyText;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) {} }
    console.log(JSON.stringify({ cmd: frame.body && frame.body.cmd, status: res && res.status, ms: Date.now() - ts, body }));
  } catch (e) {
    console.log(JSON.stringify({ cmd: frame.body && frame.body.cmd, error: String(e && e.message || e), ms: Date.now() - ts }));
  }
}
try { h.close(); } catch (e) {}
process.exit(0);
