// hub.test.js — 验证三明治中枢分发模型（operator→hub→agent）
//   1. WorkspaceServer: connect/poll/result/heartbeat + exec-sync 远程路由 + broadcast + token 校验 + bootstrap.ps1
//   2. core.handleRoute: connect/poll/result 分发闭环
// 运行: node test/hub.test.js
"use strict";
const assert = require("assert");
const Module = require("module");

const cfgStore = { confineToWorkspace: false, accessToken: "" };
const vscodeStub = {
  workspace: { workspaceFolders: [], name: "test-ws", getConfiguration: () => ({ get: (k) => cfgStore[k], update: async () => {} }) },
  window: { setStatusBarMessage() {}, createWebviewViewProvider() {}, registerWebviewViewProvider() {} },
  commands: { executeCommand() {}, registerCommand() {} },
  env: { appName: "test", machineId: "m", sessionId: "s" },
  version: "1.80.0",
};
const origLoad = Module._load;
Module._load = function (request) { if (request === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };

const ext = require("../extension.js");
const core = require("../../core.js");

let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── 1. WorkspaceServer 被控端接入 + 远程 exec-sync 分发 ──
  {
    const srv = new ext.WorkspaceServer();

    // connect → 返回 agent_id + per-agent token
    const conn = await srv.handleApi("POST", "/api/connect", { sysinfo: { hostname: "BOX-A", username: "u", capabilities: ["shell", "run"] } }, false);
    assert.strictEqual(conn.status, 200);
    const aid = conn.body.agent_id, tok = conn.body.token;
    assert.strictEqual(aid, "BOX-A");
    assert.ok(tok && tok.length >= 16, "per-agent token issued");

    // 出现在 /api/agents
    const list = await srv.handleApi("GET", "/api/agents", {}, true);
    assert.ok(list.body.agents.some((a) => a.id === "BOX-A" && a.status === "online"), "agent listed online");

    // 远程 exec-sync：先发(不 await) → 被控端 poll 取命令 → 提交结果 → exec-sync 解析
    const execP = srv.handleApi("POST", "/api/exec-sync", { agent_id: "BOX-A", type: "run", file: "C:\\x\\y.bat", args: ["Z"], timeout: 10 }, true);
    await sleep(30);
    const poll = await srv.handleApi("POST", "/api/poll", { id: aid, token: tok, timeout: 1 }, false);
    assert.strictEqual(poll.body.commands.length, 1, "one queued command polled");
    const cmd = poll.body.commands[0];
    assert.ok(cmd.payload.command.startsWith("& 'C:\\x\\y.bat'"), "command normalized via buildExecCommand");
    await srv.handleApi("POST", "/api/result", { agent_id: aid, token: tok, cmd_id: cmd.cmd_id, result: { stdout: "REMOTE-OK", exit_code: 7 } }, false);
    const execR = await execP;
    assert.strictEqual(execR.status, 200);
    assert.strictEqual(execR.body.result.stdout, "REMOTE-OK", "exec-sync got remote result");
    assert.strictEqual(execR.body.result.exit_code, 7, "remote native exit code passed through");
    ok("WorkspaceServer connect→poll→exec-sync→result 三明治分发");

    // token 校验：错误 token 的 poll / result 必 401
    const badPoll = await srv.handleApi("POST", "/api/poll", { id: aid, token: "WRONG", timeout: 1 }, false);
    assert.strictEqual(badPoll.status, 401, "poll rejects wrong token");
    const badRes = await srv.handleApi("POST", "/api/result", { agent_id: aid, token: "WRONG", cmd_id: "x", result: {} }, false);
    assert.strictEqual(badRes.status, 401, "result rejects wrong token");
    ok("WorkspaceServer per-agent token 校验 (poll/result 拒错 token)");

    // 异步 exec → cmd_id → result-fetch
    const asy = await srv.handleApi("POST", "/api/exec", { agent_id: "BOX-A", cmd: "hostname", timeout: 10 }, true);
    assert.ok(asy.body.cmd_id, "async exec returns cmd_id");
    const pending = await srv.handleApi("POST", "/api/result-fetch", { agent_id: "BOX-A", cmd_id: asy.body.cmd_id }, true);
    assert.strictEqual(pending.body.status, "pending", "result-fetch pending before submit");
    ok("WorkspaceServer 异步 exec → cmd_id → result-fetch");

    // broadcast：注册第二台，广播下发到两台
    await srv.handleApi("POST", "/api/connect", { sysinfo: { hostname: "BOX-B" } }, false);
    const bc = await srv.handleApi("POST", "/api/broadcast", { cmd: "echo hi" }, true);
    assert.strictEqual(bc.body.delivered.length, 2, "broadcast delivered to 2 agents");
    ok("WorkspaceServer broadcast 入队到所有被控端");

    // SELF 路由仍本机执行（agent_id 空）
    const self = await srv.handleApi("POST", "/api/exec-sync", { cmd: "noop" }, true);
    assert.ok(self.body.result && self.body.result.exit_code !== undefined, "self exec runs locally");
    ok("WorkspaceServer SELF(空 agent_id) 仍本机执行");

    // bootstrap.ps1（免鉴权）含 connect/poll 协议
    const boot = await srv.handleApi("GET", "/api/bootstrap.ps1", {}, false);
    assert.ok(String(boot.body).includes("/api/connect") && String(boot.body).includes("/api/poll"), "bootstrap script wires connect+poll");
    ok("WorkspaceServer /api/bootstrap.ps1 一行接入脚本");
  }

  // ── 2. core.handleRoute 被控端分发闭环 ──
  {
    const host = { workspaceRoot: () => process.cwd(), info: () => ({ host: "hub" }), publicUrl: () => "https://hub.example/relay/s", log: () => {} };
    const TOKEN = "master";
    const hdr = { authorization: "Bearer " + TOKEN };

    const conn = await core.handleRoute(host, "/api/connect", "POST", {}, JSON.stringify({ sysinfo: { hostname: "C-BOX" } }), TOKEN);
    const aid = conn.body.agent_id, tok = conn.body.token;
    assert.strictEqual(aid, "C-BOX");

    const execP = core.handleRoute(host, "/api/exec-sync", "POST", hdr, JSON.stringify({ agent_id: "C-BOX", cmd: "whoami", timeout: 10 }), TOKEN);
    await sleep(30);
    const poll = await core.handleRoute(host, "/api/poll", "POST", {}, JSON.stringify({ id: aid, token: tok, timeout: 1 }), TOKEN);
    assert.strictEqual(poll.body.commands.length, 1, "core poll returns queued cmd");
    const cmd = poll.body.commands[0];
    await core.handleRoute(host, "/api/result", "POST", {}, JSON.stringify({ agent_id: aid, token: tok, cmd_id: cmd.cmd_id, result: { stdout: "C-REMOTE", exit_code: 0 } }), TOKEN);
    const execR = await execP;
    assert.strictEqual(execR.body.result.stdout, "C-REMOTE", "core exec-sync got remote result");
    ok("core.handleRoute connect→poll→exec-sync→result 分发");

    const boot = await core.handleRoute(host, "/api/bootstrap.ps1", "GET", {}, "", TOKEN);
    assert.ok(boot.raw.includes("https://hub.example/relay/s"), "core bootstrap injects public url");
    ok("core.handleRoute /api/bootstrap.ps1 注入公网 URL");
  }

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\nTEST FAILED:", e && e.stack || e); process.exit(1); });
