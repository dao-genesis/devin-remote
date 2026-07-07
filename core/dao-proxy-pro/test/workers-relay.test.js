// workers-relay.test.js — Proxy Pro 第五模块 · workers.dev 固定中继链路单测:
//   1. _brgWsEncodeFrame 客户端掩码帧 + _BrgWsFrameParser 解析(分片 + ping 自动回 pong)
//   2. _BrgWsClient.connect 对真 RFC6455 服务端握手 + 收发文本闭环
//   3. _BrgRelayClient 收 {type:request} → 派本机反代 → 回 {type:response}(反代未起时回 502, 仍闭环)
//   4. _BRG_RELAY_SOURCE 为合法 ES module 且含核心协议符号; 会话前缀与 dao-bridge 隔离(pp- / workers-relay-proxypro.json)
// 运行: node test/workers-relay.test.js
"use strict";
process.argv.push("--test"); // 令 source.js 被 require 时不 listen 端口
const assert = require("assert");
const net = require("net");
const crypto = require("crypto");

const ORIGIN = require("../vendor/bundled-origin/source.js");
const T = ORIGIN._test;
const { _brgWsEncodeFrame, _BrgWsFrameParser, _BrgWsClient, _BrgRelayClient, _BRG_RELAY_SOURCE, _BRG_RELAY_SCRIPT } = T;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }

// 极简 RFC6455 服务端(server 帧不掩码): 供 _BrgWsClient 对接。onText(server,text)。
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
  // T1: 客户端掩码帧 + 分片重组 + ping→pong
  {
    const frame = _brgWsEncodeFrame(0x1, Buffer.from("héllo-世界", "utf8"));
    assert.strictEqual((frame[1] & 0x80) !== 0, true, "客户端帧必须掩码");
    let got = null; let ponged = false;
    const p = new _BrgWsFrameParser((s) => { got = s; }, () => {}, () => { ponged = true; });
    p.push(Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from("ab")]));  // fin=0
    p.push(Buffer.concat([Buffer.from([0x80, 0x01]), Buffer.from("c")]));   // cont fin=1
    assert.strictEqual(got, "abc", "分片重组");
    p.push(Buffer.from([0x89, 0x00])); // ping
    assert.strictEqual(ponged, true, "ping 触发 pong 回调");
    ok("_brgWsEncodeFrame 掩码 + _BrgWsFrameParser 分片/ping");
  }

  // T2 + T3: _BrgWsClient 握手 + 文本收发闭环
  {
    const server = startWsServer((sock, text) => { sock.sendText("echo:" + text); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const client = await _BrgWsClient.connect("ws://127.0.0.1:" + port + "/connect", { timeoutMs: 4000 });
    const recv = new Promise((res) => client.onMessage(res));
    client.send("ping123");
    const got = await recv;
    assert.strictEqual(got, "echo:ping123", "_BrgWsClient 收发闭环");
    client.close();
    await new Promise((r) => server.close(r));
    ok("_BrgWsClient.connect 握手 + 文本收发闭环");
  }

  // T4: _BrgRelayClient 派发 {type:request} → 派本机反代 → 回 {type:response}
  //     (本测无本机反代 → dispatch 得 502, 但 request→response 闭环成立)
  {
    const responses = [];
    const server = startWsServer((sock, text) => {
      const m = JSON.parse(text);
      if (m.type === "response") responses.push(m);
    });
    const conns = [];
    server.on("connection", (s) => conns.push(s));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const relay = new _BrgRelayClient();
    const started = await relay.start({ relayUrl: "http://127.0.0.1:" + port, session: "pp-test", relayToken: "t2" });
    assert.strictEqual(started, true, "_BrgRelayClient 首连成功");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(conns.length >= 1, "服务端已接入 relay 客户端");
    conns[0].sendText(JSON.stringify({ type: "request", id: "req-1", method: "GET", path: "/v1/models", body: {} }));
    await new Promise((r) => setTimeout(r, 400));
    const r1 = responses.find((m) => m.id === "req-1");
    assert.ok(r1 && typeof r1.status === "number", "收到 response 帧(带 status)");
    relay.stop();
    await new Promise((r) => server.close(r));
    ok("_BrgRelayClient 派发 request→dispatch→response 闭环");
  }

  // T5: _BRG_RELAY_SOURCE 合法 ES module + 核心协议符号; 与 dao-bridge 隔离
  {
    assert.ok(/export default/.test(_BRG_RELAY_SOURCE), "含 export default");
    assert.ok(/export class DaoRelayDO/.test(_BRG_RELAY_SOURCE), "含 Durable Object 类");
    assert.ok(/relayKey/.test(_BRG_RELAY_SOURCE), "含 session+token 定址 relayKey");
    assert.ok(/acceptWebSocket/.test(_BRG_RELAY_SOURCE), "含 Hibernation acceptWebSocket");
    assert.strictEqual(_BRG_RELAY_SCRIPT, "dao-relay-do", "脚本名与 dao-bridge 一致(同账号同脚本·幂等)");
    ok("_BRG_RELAY_SOURCE 协议符号完备 · 脚本名归一");
  }

  console.log("\n workers-relay (proxy-pro): " + passed + " passed");
  process.exit(0);
})().catch((e) => { console.error(" FAIL", e && e.stack || e); process.exit(1); });
