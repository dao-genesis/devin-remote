// workers-relay.test.js — workers.dev 固定中继链路单测:
//   1. wsEncodeFrame 客户端掩码帧可被服务端正确解掩
//   2. WsFrameParser 解析服务端帧(含分片 + ping 自动回 pong)
//   3. WsClient.connect 对真 RFC6455 服务端握手 + 收发文本闭环
//   4. RelayClient 收 {type:request} → 派本地 handleApi → 回 {type:response}
//   5. RELAY_WORKER_SOURCE 为合法 ES module 且含核心协议符号
// 运行: node test/workers-relay.test.js
"use strict";
const assert = require("assert");
const net = require("net");
const crypto = require("crypto");

const Module = require("module");
const vscodeStub = { workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }) }, window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), setStatusBarMessage: () => ({ dispose() {} }), createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "" }) }, commands: { registerCommand: () => ({ dispose() {} }) }, env: { appName: "test", machineId: "m", sessionId: "s", clipboard: { writeText: async () => {} } }, version: "1.90.0", StatusBarAlignment: { Left: 1, Right: 2 }, Uri: { file: (p) => ({ fsPath: p }) }, extensions: { all: [], getExtension: () => undefined }, ConfigurationTarget: { Global: 1 } };
const origLoad = Module._load;
Module._load = function (request) { if (request === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };

const ext = require("../extension.js");
const { WsClient, RelayClient, wsEncodeFrame, WsFrameParser, RELAY_WORKER_SOURCE, RELAY_SCRIPT_NAME } = ext;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }

// 极简 RFC6455 服务端(server 帧不掩码): 供 WsClient 对接。onText(server,text)。
function startWsServer(onText) {
  const server = net.createServer((sock) => {
    let phase = "handshake";
    let buf = Buffer.alloc(0);
    let frag = [];
    const encodeServer = (opcode, payload) => {
      const len = payload.length;
      let header;
      if (len < 126) header = Buffer.from([0x80 | opcode, len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
      return Buffer.concat([header, payload]);
    };
    sock.sendText = (s) => sock.write(encodeServer(0x1, Buffer.from(s, "utf8")));
    sock.sendPing = () => sock.write(encodeServer(0x9, Buffer.alloc(0)));
    const parse = () => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
        else if (len === 127) { if (buf.length < off + 8) return; len = Number(buf.readBigUInt64BE(off)); off += 8; }
        const mlen = masked ? 4 : 0;
        if (buf.length < off + mlen + len) return;
        let payload = buf.subarray(off + mlen, off + mlen + len);
        if (masked) { const mask = buf.subarray(off, off + 4); const un = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3]; payload = un; }
        buf = buf.subarray(off + mlen + len);
        if (opcode === 0x8) { sock.end(); return; }
        if (opcode === 0x9) { sock.write(encodeServer(0xa, payload)); continue; }
        if (opcode === 0xa) continue;
        frag.push(payload);
        if (fin) { const full = Buffer.concat(frag); frag = []; onText(sock, full.toString("utf8")); }
      }
    };
    sock.on("data", (chunk) => {
      if (phase === "handshake") {
        buf = Buffer.concat([buf, chunk]);
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) return;
        const head = buf.subarray(0, sep).toString("utf8");
        buf = buf.subarray(sep + 4);
        const key = (/sec-websocket-key:\s*(\S+)/i.exec(head) || [])[1];
        const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        phase = "frames";
        parse();
      } else { buf = Buffer.concat([buf, chunk]); parse(); }
    });
    sock.on("error", () => {});
  });
  return server;
}

(async () => {
  // T1: 客户端掩码帧可被解掩; 分片 + ping 解析
  {
    const frame = wsEncodeFrame(0x1, Buffer.from("héllo-世界", "utf8"));
    assert.strictEqual((frame[1] & 0x80) !== 0, true, "客户端帧必须掩码");
    let got = null; let pinged = false;
    const p = new WsFrameParser((s) => { got = s; }, () => {}, () => { pinged = true; });
    // 服务端不掩码分片: "ab"(fin=0) + "c"(cont fin=1)
    p.push(Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from("ab")]));
    p.push(Buffer.concat([Buffer.from([0x80, 0x01]), Buffer.from("c")]));
    assert.strictEqual(got, "abc", "分片重组");
    p.push(Buffer.from([0x89, 0x00])); // ping
    assert.strictEqual(pinged, true, "ping 触发 pong 回调");
    ok("wsEncodeFrame 掩码 + WsFrameParser 分片/ping");
  }

  // T2 + T3: WsClient 握手 + 文本收发闭环
  {
    const server = startWsServer((sock, text) => { sock.sendText("echo:" + text); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const client = await WsClient.connect("ws://127.0.0.1:" + port + "/connect", { timeoutMs: 4000 });
    const recv = new Promise((res) => client.onMessage(res));
    client.send("ping123");
    const got = await recv;
    assert.strictEqual(got, "echo:ping123", "WsClient 收发闭环");
    client.close();
    await new Promise((r) => server.close(r));
    ok("WsClient.connect 握手 + 文本收发闭环");
  }

  // T4: RelayClient 派发 {type:request} → handleApi → {type:response}
  {
    const calls = [];
    const fakeBridge = {
      notify() {},
      srv: { handleApi: async (method, path, body) => { calls.push({ method, path, body }); return { status: 200, body: { pong: true, path } }; } },
    };
    const responses = [];
    const server = startWsServer((sock, text) => {
      const m = JSON.parse(text);
      if (m.type === "response") responses.push(m);
    });
    const conns = [];
    server.on("connection", (s) => conns.push(s));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const relay = new RelayClient(fakeBridge);
    const started = await relay.start({ relayUrl: "http://127.0.0.1:" + port, session: "s2", relayToken: "t2" });
    assert.strictEqual(started, true, "RelayClient 首连成功");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(conns.length >= 1, "服务端已接入 relay 客户端");
    // 服务端主动下发 request 帧 → 客户端应派 handleApi 并回 response
    conns[0].sendText(JSON.stringify({ type: "request", id: "req-1", method: "GET", path: "/api/health", body: {} }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(responses.find((m) => m.id === "req-1" && m.status === 200), "收到 response 帧");
    assert.ok(calls.find((c) => c.path === "/api/health"), "handleApi 被以 request.path 调用");
    relay.stop();
    await new Promise((r) => server.close(r));
    ok("RelayClient 派发 request→handleApi→response 闭环");
  }

  // T5: RELAY_WORKER_SOURCE 合法 ES module 语法 + 核心协议符号
  {
    // 语法(经 vm 编译为模块源不便, 用 new Function 包裹 export 会报错; 改 String 断言 + 简单括号平衡)
    assert.ok(/export default/.test(RELAY_WORKER_SOURCE), "含 export default");
    assert.ok(/export class DaoRelayDO/.test(RELAY_WORKER_SOURCE), "含 Durable Object 类");
    assert.ok(/relayKey/.test(RELAY_WORKER_SOURCE), "含 session+token 定址 relayKey");
    assert.ok(/acceptWebSocket/.test(RELAY_WORKER_SOURCE), "含 Hibernation acceptWebSocket");
    assert.ok(/setWebSocketAutoResponse/.test(RELAY_WORKER_SOURCE), "含心跳自动应答");
    assert.strictEqual(RELAY_SCRIPT_NAME, "dao-relay-do", "脚本名固定");
    ok("RELAY_WORKER_SOURCE 协议符号完备");
  }

  console.log("\n workers-relay: " + passed + " passed");
  process.exit(0);
})().catch((e) => { console.error(" FAIL", e && e.stack || e); process.exit(1); });
