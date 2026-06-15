// relay.test.js — 纯数测(零真 Worker / 零 vscode 宿主):
//   1. DaoWsClient 握手 + 帧编解码(掩码/分片/ping-pong) 对一个手写 mock WS server
//   2. connectRelayWs 的 request→handleApi→response 闭环 + 断线重连
//   3. extractCfTgz tar 解包
//   4. isRealCloudflared 体积判据
// 运行: node test/relay.test.js
"use strict";
const assert = require("assert");
const net = require("net");
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// ── 注入 vscode 桩, 让 extension.js 可在纯 Node 下被 require ──────────────
const cfgStore = { confineToWorkspace: false, accessToken: "" };
const vscodeStub = {
  workspace: {
    workspaceFolders: [],
    name: "test-ws",
    getConfiguration: () => ({ get: (k) => cfgStore[k], update: async () => {} }),
  },
  window: { setStatusBarMessage() {}, createWebviewViewProvider() {}, registerWebviewViewProvider() {} },
  commands: { executeCommand() {}, registerCommand() {} },
  env: { appName: "test", machineId: "m", sessionId: "s" },
  version: "1.80.0",
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return origLoad.apply(this, arguments);
};

const ext = require("../extension.js");
const { DaoWsClient, connectRelayWs, extractCfTgz, isRealCloudflared } = ext;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }

// ── 手写 mock WS server(server→client 不掩码, 解析 client→server 掩码帧)──────
function startMockServer(onClient) {
  const server = net.createServer((sock) => {
    let hs = false; let buf = Buffer.alloc(0);
    const api = {
      sendText(str) { sock.write(encodeFrame(0x1, Buffer.from(str, "utf8"))); },
      ping() { sock.write(encodeFrame(0x9, Buffer.alloc(0))); },
      sock,
      onmessage: null, onping: null,
    };
    sock.on("data", (d) => {
      if (!hs) {
        hs = true;
        const txt = d.toString("utf8");
        const key = (txt.match(/sec-websocket-key:\s*(.+)\r\n/i) || [])[1].trim();
        const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        onClient(api);
        return;
      }
      buf = Buffer.concat([buf, d]);
      buf = drainFrames(buf, api);
    });
    sock.on("error", () => {});
  });
  return server;
}
function encodeFrame(opcode, payload) {
  const len = payload.length; let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  header[0] = 0x80 | opcode; // FIN
  return Buffer.concat([header, payload]); // server→client: 不掩码
}
function drainFrames(buf, api) {
  while (buf.length >= 2) {
    const b1 = buf[1];
    const opcode = buf[0] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f; let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) break; mask = buf.slice(off, off + 4); off += 4; }
    if (buf.length < off + len) break;
    let payload = buf.slice(off, off + len);
    if (masked) { const o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i & 3]; payload = o; }
    buf = buf.slice(off + len);
    if (opcode === 0x9) { api.sock.write(encodeFrame(0xA, payload)); if (api.onping) api.onping(); }
    else if (opcode === 0x1) { if (api.onmessage) api.onmessage(payload.toString("utf8")); }
  }
  return buf;
}

function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }

(async () => {
  // T1: DaoWsClient 握手 + 收发文本(掩码) + 大帧(>125B, 16-bit 长度)
  {
    let serverGot = null; let serverApi = null;
    const server = startMockServer((api) => { serverApi = api; api.onmessage = (m) => { serverGot = m; }; });
    const port = await listen(server);
    const big = "x".repeat(500);
    await new Promise((resolve, reject) => {
      const ws = new DaoWsClient("ws://127.0.0.1:" + port + "/connect");
      ws.onopen = () => { ws.send("hello"); ws.send(big); };
      ws.onmessage = (m) => { if (m === "srv-reply") { ws.close(); resolve(); } };
      ws.onerror = (e) => reject(e);
      ws.connect();
      setTimeout(() => {
        try {
          assert.strictEqual(serverGot, big, "server should receive 500B masked frame intact");
          serverApi.sendText("srv-reply");
        } catch (e) { reject(e); }
      }, 800);
      setTimeout(() => reject(new Error("T1 timeout")), 4000);
    });
    server.close();
    ok("DaoWsClient handshake + masked send (incl. 500B frame) + server→client text");
  }

  // T2: connectRelayWs request→handleApi→response 闭环 + ping
  {
    let gotPing = false;
    const responses = [];
    const server = startMockServer((api) => {
      api.onping = () => { gotPing = true; };
      api.onmessage = (m) => { const j = JSON.parse(m); if (j.type === "response") responses.push(j); };
      // Worker 主动下发一个 request
      setTimeout(() => api.sendText(JSON.stringify({ type: "request", id: "r1", method: "GET", path: "/api/health" })), 150);
      setTimeout(() => api.ping(), 200);
    });
    const port = await listen(server);
    const ctrl = connectRelayWs({
      relayUrl: "http://127.0.0.1:" + port,
      session: "sess1", token: "tok",
      handle: async (method, p, bodyStr) => {
        assert.strictEqual(method, "GET"); assert.strictEqual(p, "/api/health");
        return { status: 200, body: { ok: true, echo: bodyStr } };
      },
      onStatus: () => {},
    });
    await new Promise((r) => setTimeout(r, 700));
    ctrl.stop(); server.close();
    assert.strictEqual(ctrl.publicUrl(), null, "publicUrl null after stop");
    assert.strictEqual(responses.length, 1, "exactly one response frame");
    assert.strictEqual(responses[0].id, "r1");
    assert.strictEqual(responses[0].status, 200);
    assert.strictEqual(responses[0].body.ok, true);
    ok("connectRelayWs request→handle→response loop + client→server ping");
  }

  // T3: connectRelayWs 断线 5s 重连(缩短验证: 杀连接后应再次发起握手)
  {
    let connects = 0;
    const server = startMockServer((api) => {
      connects++;
      if (connects === 1) setTimeout(() => api.sock.destroy(), 100); // first connection drops
    });
    const port = await listen(server);
    const ctrl = connectRelayWs({ relayUrl: "http://127.0.0.1:" + port, session: "s", token: "t", handle: async () => ({ status: 200, body: {} }), onStatus: () => {} });
    await new Promise((r) => setTimeout(r, 6000));
    ctrl.stop(); server.close();
    assert.ok(connects >= 2, "should reconnect after drop (got " + connects + " connects)");
    ok("connectRelayWs auto-reconnect after disconnect");
  }

  // T4: extractCfTgz 解 tar.gz 取出 cloudflared 真二进制
  {
    const body = Buffer.alloc(1200000, 7); // >1MB
    const header = Buffer.alloc(512);
    header.write("cloudflared", 0);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    // tar checksum
    header.write("        ", 148);
    let sum = 0; for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const pad = (512 - (body.length % 512)) % 512;
    const tar = Buffer.concat([header, body, Buffer.alloc(pad), Buffer.alloc(1024)]);
    const tgz = zlib.gzipSync(tar);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-"));
    const tgzPath = path.join(dir, "cloudflared.tgz");
    const outBin = path.join(dir, "cloudflared");
    fs.writeFileSync(tgzPath, tgz);
    const r = extractCfTgz(tgzPath, outBin);
    assert.strictEqual(r, outBin, "extractCfTgz returns out path");
    assert.strictEqual(fs.statSync(outBin).size, body.length, "extracted size matches");
    assert.ok(!fs.existsSync(tgzPath), "tgz removed after extract");
    ok("extractCfTgz unpacks cloudflared from tar.gz");
  }

  // T5: isRealCloudflared 体积判据(<1MB 拒, >1MB 收)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfbin-"));
    const small = path.join(dir, "cloudflared"); fs.writeFileSync(small, Buffer.alloc(500));
    assert.strictEqual(isRealCloudflared(small), false, "shim/half (<1MB) rejected");
    const big = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared2");
    fs.writeFileSync(big, Buffer.alloc(1100000));
    if (process.platform !== "win32") assert.strictEqual(isRealCloudflared(big), true, "real-size binary accepted");
    ok("isRealCloudflared size gate");
  }

  // T6: generateCloudAgentMd 在 relay 模式必须文档化信封契约(否则云端 Agent 按透明反代调用必失败)
  {
    const b = new ext.Bridge();
    b.srv.token = "TT";
    b.mode = "relay"; b.protocol = "wss";
    b.url = "https://dao-relay-do.example.workers.dev/relay/mybox";
    const md = b.generateCloudAgentMd();
    const WARN = "URL 不是透明反代";
    assert.ok(md.includes(WARN), "relay MD warns about envelope endpoint");
    assert.ok(/RELAY=\('\/relay\/' in URL\)/.test(md), "relay MD SDK auto-detects relay");
    assert.ok(md.includes("'path':p,'method':m,'body':body or {}"), "relay MD SDK wraps envelope");
    // 直连模式不应出现信封告警(SDK 注释里的'信封'恒在, 但告警块不应出现)
    b.mode = "quick"; b.url = "https://x.trycloudflare.com";
    assert.ok(!b.generateCloudAgentMd().includes(WARN), "direct MD has no envelope warning");
    ok("generateCloudAgentMd relay envelope contract");
  }

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\nTEST FAILED:", e && e.stack || e); process.exit(1); });
