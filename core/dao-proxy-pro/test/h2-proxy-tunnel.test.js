"use strict";
// ★ v9.9.362 · 官方 H2 长连经系统/VPN 代理 HTTP CONNECT 隧道 + 鉴权类 RPC 韧性兜底
//   根治「连接不上官方服务器」的源级护栏:
//   ① _h2TunnelConnect 正确发 CONNECT 行 + Host 头, 200 才 TLS, 非 200/坏代理即 error;
//   ② 全链路: 假 CONNECT 代理 → 真 TLS(h2) origin, 经隧道 http2.connect 收到真响应;
//   ③ _isAuthResilientRpc 只认鉴权/状态/配置类, 不误伤补全/流式;
//   ④ _replyAuthResilient 有 last-good 则原样回放(200+trailers), 无则空 gRPC OK。
//
// 说明: 为让真·TLS 叶(_h2TunnelConnect 硬 rejectUnauthorized:true)可信, 首启若未设
//   NODE_EXTRA_CA_CERTS 则生成自签证书并以该 CA 重启本进程一次(道法自然·不改生产码)。

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const http2 = require("http2");
const { execFileSync, spawnSync } = require("child_process");

const CERT_DIR = path.join(os.tmpdir(), "dao-h2tunnel-cert");
const KEY = path.join(CERT_DIR, "k.pem");
const CRT = path.join(CERT_DIR, "c.pem");

function ensureCert() {
  if (fs.existsSync(KEY) && fs.existsSync(CRT)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  // 自签证书: CN=127.0.0.1 + SAN IP:127.0.0.1 (servername 校验通过)
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", KEY, "-out", CRT, "-days", "2", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}

// ── 首启自举: 用自签 CA 重启本进程一次, 令真 TLS 叶可信 ──
ensureCert();
if (process.env.__H2TUNNEL_CA !== CRT) {
  const r = spawnSync(process.execPath, [__filename], {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CRT, __H2TUNNEL_CA: CRT },
  });
  process.exit(r.status == null ? 1 : r.status);
}

const src = require("../vendor/bundled-origin/source.js");
const T = src._test;

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) {
    passed++;
    console.log("  \u2705 " + name);
  } else {
    failed++;
    console.log("  \u274c " + name);
  }
}

// 假 CONNECT 代理: 收 "CONNECT host:port" → (accept ? 连真 origin 并双向管道 : 回 403)
function makeConnectProxy({ accept = true, target } = {}) {
  const captured = { firstLine: null, raw: "" };
  const srv = net.createServer((cli) => {
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("binary");
      if (head.indexOf("\r\n\r\n") === -1) return;
      cli.removeListener("data", onData);
      captured.raw = head;
      captured.firstLine = head.split("\r\n")[0];
      if (!accept) {
        cli.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        cli.end();
        return;
      }
      const up = net.connect(target.port, "127.0.0.1", () => {
        cli.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.pipe(cli);
        cli.pipe(up);
      });
      up.on("error", () => { try { cli.destroy(); } catch {} });
    };
    cli.on("data", onData);
    cli.on("error", () => {});
  });
  return { srv, captured };
}

function listen(srv) {
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
}

async function run() {
  console.log("\n=== v9.9.362 · H2-over-CONNECT 隧道 + 鉴权韧性兜底 ===\n");

  // 真 TLS h2 origin: 对任意请求回 :status 200 + body "OK-VIA-TUNNEL" + grpc trailer
  const h2srv = http2.createSecureServer({
    key: fs.readFileSync(KEY),
    cert: fs.readFileSync(CRT),
  });
  h2srv.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    stream.end("OK-VIA-TUNNEL");
  });
  const originPort = await listen(h2srv);

  // ── ① CONNECT 行格式 + 全链路真响应 ──
  {
    const { srv, captured } = makeConnectProxy({ accept: true, target: { port: originPort } });
    const proxyPort = await listen(srv);
    const purl = `http://127.0.0.1:${proxyPort}`;

    const result = await new Promise((resolve) => {
      T._h2TunnelConnect("127.0.0.1", originPort, purl, (err, tlsSock) => {
        if (err) return resolve({ err });
        try {
          const session = http2.connect(`https://127.0.0.1:${originPort}`, {
            createConnection: () => tlsSock,
          });
          session.on("error", (e) => resolve({ err: e }));
          const rq = session.request({ ":method": "POST", ":path": "/x" });
          let body = "";
          rq.setEncoding("utf8");
          rq.on("data", (c) => (body += c));
          rq.on("end", () => {
            try { session.close(); } catch {}
            resolve({ body });
          });
          rq.end();
        } catch (e) {
          resolve({ err: e });
        }
      });
    });

    ok(
      "CONNECT 行 = 'CONNECT 127.0.0.1:PORT HTTP/1.1'",
      captured.firstLine === `CONNECT 127.0.0.1:${originPort} HTTP/1.1`,
    );
    ok("CONNECT 携带 Host 头", /\r\nHost: 127\.0\.0\.1:/.test(captured.raw));
    ok("经隧道 http2 收到真 origin 响应体", result.body === "OK-VIA-TUNNEL");
    srv.close();
  }

  // ── ② 代理回 403(非 200) → error 'CONNECT rejected' ──
  {
    const { srv } = makeConnectProxy({ accept: false, target: { port: originPort } });
    const proxyPort = await listen(srv);
    const e = await new Promise((resolve) =>
      T._h2TunnelConnect("127.0.0.1", originPort, `http://127.0.0.1:${proxyPort}`, (err) => resolve(err)),
    );
    ok("非 200 CONNECT → error", !!e && /CONNECT rejected/.test(e.message));
    srv.close();
  }

  // ── ③ 代理不可达 → error ──
  {
    const e = await new Promise((resolve) =>
      T._h2TunnelConnect("127.0.0.1", originPort, "http://127.0.0.1:1", (err) => resolve(err)),
    );
    ok("代理拒连 → error", !!e);
  }

  h2srv.close();

  // ── ④ 鉴权类 RPC 识别 ──
  ok("GetUserStatus 属鉴权类", T._isAuthResilientRpc("/x.Svc/GetUserStatus"));
  ok("GetCommandModelConfigs 属鉴权类", T._isAuthResilientRpc("/a/GetCommandModelConfigs"));
  ok("RegisterUser(登录) 属鉴权类", T._isAuthResilientRpc("/a/RegisterUser"));
  ok("GetCompletions 不属鉴权类", !T._isAuthResilientRpc("/a/GetCompletions"));
  ok("GetChatMessage 不属鉴权类", !T._isAuthResilientRpc("/a/GetChatMessageStreaming"));

  // ── ⑤ _replyAuthResilient: 有 last-good 原样回放 ──
  function fakeRes() {
    return {
      headersSent: false,
      _status: null, _headers: null, _body: null, _trailers: null, _ended: false,
      writeHead(s, h) { this._status = s; this._headers = h; this.headersSent = true; },
      write(b) { this._body = b; },
      addTrailers(t) { this._trailers = t; },
      end(b) { if (b !== undefined) this._body = b; this._ended = true; },
    };
  }
  function fakeReq(url) {
    return { url, resume() { this._resumed = true; } };
  }

  {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6]);
    T._setLastGoodUserStatusForTest({ buf, ct: "application/proto", ce: "", at: Date.now() });
    const res = fakeRes();
    const req = fakeReq("/exa/GetUserStatus");
    T._replyAuthResilient(req, res, "t1");
    ok("回放: 排空入站体(req.resume)", req._resumed === true);
    ok("回放: 200", res._status === 200);
    ok("回放: 原样 body", Buffer.isBuffer(res._body) && res._body.equals(buf));
    ok("回放: grpc-status=0 trailer", res._trailers && res._trailers["grpc-status"] === "0");
    ok("回放: content-length 正确", res._headers["content-length"] === String(buf.length));
  }

  // ── ⑥ 无 last-good → 空 gRPC OK (grpc-status=0·不登出) ──
  {
    T._setLastGoodUserStatusForTest(null);
    const res = fakeRes();
    T._replyAuthResilient(fakeReq("/exa/GetUserStatus"), res, "t2");
    ok("无 last-good: 200", res._status === 200);
    ok("无 last-good: application/grpc", /grpc/.test((res._headers || {})["content-type"] || ""));
    ok("无 last-good: grpc-status=0", res._trailers && res._trailers["grpc-status"] === "0");
  }

  // ── ⑦ last-good 过期(>30min) 不回放 → 空 OK ──
  {
    T._setLastGoodUserStatusForTest({ buf: Buffer.from([9]), ct: "application/proto", ce: "", at: Date.now() - 31 * 60 * 1000 });
    const res = fakeRes();
    T._replyAuthResilient(fakeReq("/exa/GetUserStatus"), res, "t3");
    ok("过期 last-good 不回放 → 空 gRPC OK(5B)", Buffer.isBuffer(res._body) && res._body.length === 5);
    T._setLastGoodUserStatusForTest(null);
  }

  console.log(`\n  ${failed === 0 ? "\u2705" : "\u274c"} 通过: ${passed}  失败: ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
