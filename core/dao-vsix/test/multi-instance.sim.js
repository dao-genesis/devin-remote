"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-vsix · 多窗口/多IDE 实景模拟 (node test/multi-instance.sim.js)
//   起 3 个真 HTTP server 模拟 9920/9921/9923 三个 IDE 实例(各持私牌), 全部用被测的真
//   checkAuth 逐请求鉴权; 再以「云端读知识库那一对 (leaderUrl, 机器权威牌)」的视角实打各实例,
//   证明得一不变式: **一枚机器权威令牌贯通全部实例的 /api 面**, 而他者令牌/异实例私牌恒 401。
//   这是「反向注入闭环」在多实例污染现场的端到端可达性验证(无需用户物理机)。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dao-multi-"));
const FAKE_HOME = path.join(SANDBOX, "home");
fs.mkdirSync(path.join(FAKE_HOME, ".dao", "bridge"), { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.ProgramData = path.join(SANDBOX, "ProgramData");
fs.mkdirSync(path.join(process.env.ProgramData, "dao_vm"), { recursive: true });
process.env.DAO_SELFTEST = "1";

const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    const h = { get(_t, p) { if (p === Symbol.toPrimitive) return () => ""; if (p === "workspaceFolders") return undefined; if (p === "then") return undefined; return proxy; }, apply() { return proxy; }, construct() { return proxy; } };
    var proxy = new Proxy(function () {}, h); return proxy;
  }
  return _origLoad.call(this, request, parent, isMain);
};
const S = require("../out/extension.js").__selftest;
assert.ok(S, "__selftest seam missing");

const MACHINE_TOKEN = "dao-vsix-REDACTED"; // leader 机器权威
const FOREIGN_TOKEN = "dao-vsix-REDACTED"; // 他者进程令牌
// 3 个实例, 各有自己的窗口私牌; leader = 实例0
const INSTANCES = [
  { name: "IDE#0 (leader)", wsToken: "dao-vsix-REDACTED" },
  { name: "IDE#1", wsToken: "dao-vsix-REDACTED" },
  { name: "IDE#2", wsToken: "dao-vsix-REDACTED" },
];

function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), "utf8"); }

let passed = 0, failed = 0; const fails = [];
function test(name, cond, extra) { if (cond) { passed++; console.log("  ok   " + name); } else { failed++; fails.push(name); console.log("  FAIL " + name + (extra ? " — " + extra : "")); } }

function get(port, tokenHeader) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/exec", method: "POST", headers: tokenHeader ? { authorization: "Bearer " + tokenHeader } : {} }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end("{}");
  });
}

(async () => {
  const servers = [];
  const ports = [];
  for (let i = 0; i < INSTANCES.length; i++) {
    const inst = INSTANCES[i];
    const srv = http.createServer((req, res) => {
      // 每请求切到本实例的窗口态, 再走真 checkAuth (单进程串行, 天然隔离)
      S.setState({ ws: { token: inst.wsToken, port: 9920 + i }, bridgeUrl: "https://own.example", bridgeToken: "" });
      const ok = S.checkAuth(req);
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ instance: inst.name, port: 9920 + i, authorized: ok }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    ports.push(srv.address().port);
    servers.push(srv);
  }
  // leader 真相文件: 机器权威牌 e40b6, leader 端口=实例0 的模拟端口
  writeJson(S.paths.DAO_CONN_CURRENT, {
    url: "https://own.example", token: MACHINE_TOKEN, port: 9920, host: "SIM", pid: 1, epoch: 1,
    alive: INSTANCES.map((x, i) => ({ port: 9920 + i, pid: i + 1, url: "", token: x.wsToken })),
  });
  // 他者桥污染共享文件
  writeJson(path.join(S.paths.BRIDGE_DIR, "conn.json"), { url: "", token: FOREIGN_TOKEN, port: 9100 });

  console.log("\n[得一·跨实例可达: 机器权威令牌 e40b6 打全部 IDE 实例]");
  for (let i = 0; i < ports.length; i++) {
    const r = await get(ports[i], MACHINE_TOKEN);
    test(INSTANCES[i].name + " ← 机器权威牌 ⇒ 200", r.status === 200, "got " + r.status);
  }

  console.log("\n[得一·排他: 他者进程令牌 4092e0 打任何实例恒 401]");
  for (let i = 0; i < ports.length; i++) {
    const r = await get(ports[i], FOREIGN_TOKEN);
    test(INSTANCES[i].name + " ← 他者令牌 ⇒ 401", r.status === 401, "got " + r.status);
  }

  console.log("\n[窗口私牌: 只在自己实例放行, 打异实例则 401(正是旧法多实例配对错位之源)]");
  for (let i = 0; i < ports.length; i++) {
    const self = await get(ports[i], INSTANCES[i].wsToken);
    test(INSTANCES[i].name + " ← 自身私牌 ⇒ 200", self.status === 200, "got " + self.status);
    const other = (i + 1) % ports.length;
    const cross = await get(ports[i], INSTANCES[other].wsToken);
    test(INSTANCES[i].name + " ← " + INSTANCES[other].name + " 私牌 ⇒ 401", cross.status === 401, "got " + cross.status);
  }

  console.log("\n[云端视角: 读知识库 (leaderUrl, e40b6) → 命中 leader 实例 200]");
  const cloud = await get(ports[0], MACHINE_TOKEN);
  test("云端持库中令牌打 leader ⇒ 200 (闭环成立)", cloud.status === 200, "got " + cloud.status);

  for (const s of servers) { try { s.close(); } catch {} }
  console.log("\n" + (failed ? "FAIL" : "PASS") + " " + passed + "  FAIL " + failed);
  if (failed) console.error("fails: " + fails.join("; "));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
