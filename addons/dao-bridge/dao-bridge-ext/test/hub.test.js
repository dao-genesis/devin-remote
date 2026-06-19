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

    // ── Linux 被控端（platform=linux）：中枢按目标平台下发 POSIX 指令（不是 PowerShell）──
    const lconn = await srv.handleApi("POST", "/api/connect", { sysinfo: { hostname: "LX-BOX", platform: "linux", os_version: "Linux x", capabilities: ["shell", "run"] } }, false);
    const laid = lconn.body.agent_id, ltok = lconn.body.token;
    const lexecP = srv.handleApi("POST", "/api/exec-sync", { agent_id: "LX-BOX", type: "run", file: "/opt/my app.sh", args: ["a b"], timeout: 10 }, true);
    await sleep(30);
    const lpoll = await srv.handleApi("POST", "/api/poll", { id: laid, token: ltok, timeout: 1 }, false);
    const lcmd = lpoll.body.commands[0];
    assert.strictEqual(lcmd.payload.command, "sh '/opt/my app.sh' 'a b' 2>&1", "Linux 端被下发 POSIX sh-表达式（非 PowerShell）");
    await srv.handleApi("POST", "/api/result", { agent_id: laid, token: ltok, cmd_id: lcmd.cmd_id, result: { stdout: "LX-OK", exit_code: 0 } }, false);
    assert.strictEqual((await lexecP).body.result.stdout, "LX-OK");
    ok("WorkspaceServer 跨平台路由：Linux 被控端下发 POSIX 指令");

    // platformOf + bootstrap.sh
    assert.strictEqual(ext.platformOf({ sysinfo: { platform: "linux" } }), "linux");
    assert.strictEqual(ext.platformOf({ sysinfo: { os_version: "win-test" } }), "win32", "缺省回退 win32（向后兼容）");
    const bootSh = await srv.handleApi("GET", "/api/bootstrap.sh", {}, false);
    assert.ok(String(bootSh.body).includes("/api/connect") && String(bootSh.body).includes("/api/poll") && String(bootSh.body).includes("/bin/sh"), "bootstrap.sh wires connect/poll + /bin/sh");
    assert.ok(String(bootSh.body).includes("'platform': sys.platform"), "bootstrap.sh 登记 platform");
    ok("WorkspaceServer /api/bootstrap.sh (Linux/macOS 一行接入) + platformOf");
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

    // 跨平台路由：Linux 被控端 → POSIX；bootstrap.sh 注入公网 URL
    const lconn = await core.handleRoute(host, "/api/connect", "POST", {}, JSON.stringify({ sysinfo: { hostname: "CL-BOX", platform: "linux", os_version: "Linux y" } }), TOKEN);
    const claid = lconn.body.agent_id, cltok = lconn.body.token;
    const clP = core.handleRoute(host, "/api/exec-sync", "POST", hdr, JSON.stringify({ agent_id: "CL-BOX", type: "run", file: "/opt/a.sh", timeout: 10 }), TOKEN);
    await sleep(30);
    const clpoll = await core.handleRoute(host, "/api/poll", "POST", {}, JSON.stringify({ id: claid, token: cltok, timeout: 1 }), TOKEN);
    assert.strictEqual(clpoll.body.commands[0].payload.command, "sh '/opt/a.sh' 2>&1", "core Linux 端下发 POSIX sh-表达式");
    await core.handleRoute(host, "/api/result", "POST", {}, JSON.stringify({ agent_id: claid, token: cltok, cmd_id: clpoll.body.commands[0].cmd_id, result: { stdout: "CL-OK", exit_code: 0 } }), TOKEN);
    assert.strictEqual((await clP).body.result.stdout, "CL-OK");
    const bootSh = await core.handleRoute(host, "/api/bootstrap.sh", "GET", {}, "", TOKEN);
    assert.ok(bootSh.raw.includes("https://hub.example/relay/s") && bootSh.raw.includes("/bin/sh"), "core bootstrap.sh injects url + /bin/sh");
    assert.strictEqual(core.platformOf({ sysinfo: { os_version: "Windows NT 10" } }), "win32");
    ok("core.handleRoute 跨平台路由（Linux→POSIX）+ bootstrap.sh + platformOf");
  }

  // ── 3. 前端 webview：复制URL/复制Token 已合并为单一"复制"(copyAll)，顶部恒为三按钮 ──
  {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
    assert.ok(/send\('copyAll'\)/.test(src), "顶部含合并复制按钮 copyAll");
    assert.ok(!/send\('copyUrl'\)/.test(src) && !/send\('copyToken'\)/.test(src), "顶部不再有独立 复制URL/复制Token 按钮");
    assert.ok(/send\('restart'\)/.test(src) && /send\('refreshToken'\)/.test(src), "顶部含 重启隧道 + 刷新Token");
    assert.ok(/m\.op === "copyAll"/.test(src) && /Authorization: Bearer/.test(src), "后端含 copyAll 处理(复制 URL+Token+Authorization 头)");
    ok("前端顶部三按钮(复制 copyAll + 重启隧道 + 刷新Token)·后端 copyAll 处理");
  }

  // ── 4. 自愈看门狗：回环自检 + 失败阈值触发自愈 + _publicHealthCheck 端到端 ──
  {
    const http = require("http");
    const wd = new ext.Bridge({ subscriptions: [] });

    // 阈值内累计、达阈值自愈(start 打桩计数、URL 稳定、计数清零)
    let starts = 0;
    wd.start = async function () { starts++; this.url = "https://stable.example/relay/host"; return this.url; };
    wd._wdThreshold = 2;
    wd._publicHealthCheck = async () => false;
    wd.url = "https://x";
    await wd._wdTick();
    assert.strictEqual(wd._healthFails, 1); assert.strictEqual(starts, 0);
    await wd._wdTick();
    assert.strictEqual(starts, 1, "连续失败达阈值触发自愈"); assert.strictEqual(wd._healthFails, 0, "自愈后失败计数清零");
    wd._publicHealthCheck = async () => true;
    wd._healthFails = 5; await wd._wdTick();
    assert.strictEqual(wd._healthFails, 0, "自检成功清零"); assert.ok(wd._lastOkAt > 0, "记录 lastOkAt");
    wd.startWatchdog(); const h1 = wd._wd; wd.startWatchdog();
    assert.strictEqual(wd._wd, h1, "startWatchdog 幂等"); wd.stopWatchdog(); assert.strictEqual(wd._wd, null, "stopWatchdog 停表");
    ok("看门狗：失败累计→达阈值自愈→成功清零·start/stop 幂等");

    // _publicHealthCheck：透明反代 200 ok→true；relay 信封 {error}→false；无 URL→false
    const wd2 = new ext.Bridge({ subscriptions: [] });
    const okSrv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok" })); });
    await new Promise((r) => okSrv.listen(0, r));
    wd2.mode = "quick"; wd2.url = "http://127.0.0.1:" + okSrv.address().port;
    assert.strictEqual(await wd2._publicHealthCheck(), true, "透明反代 /api/health 200→true");
    okSrv.close();
    const errSrv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no_agent" })); }); });
    await new Promise((r) => errSrv.listen(0, r));
    wd2.mode = "relay"; wd2.url = "http://127.0.0.1:" + errSrv.address().port + "/relay/host";
    assert.strictEqual(await wd2._publicHealthCheck(), false, "relay 信封 {error}→false(识破僵尸)");
    errSrv.close();
    wd2.url = ""; assert.strictEqual(await wd2._publicHealthCheck(), false, "无公网 URL→false");
    ok("回环自检 _publicHealthCheck：透明反代/relay 信封/错误识别/空 URL");
  }

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\nTEST FAILED:", e && e.stack || e); process.exit(1); });
