// exec.test.js — 验证 .bat/.cmd/.exe/任意程序远程执行的规范化与实跑
//   1. buildExecCommand 规范化（extension.js 与 headless core.js 一致）
//   2. 中枢本机真实 .bat 实跑（仅 win32）— core.handleRoute 与 WorkspaceServer.handleApi 两条路径
// 运行: node test/exec.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// ── 注入 vscode 桩 ──
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

(async () => {
  // ── 1. buildExecCommand 规范化（两处实现一致）──
  for (const [label, build] of [["ext", ext.buildExecCommand], ["core", core.buildExecCommand]]) {
    assert.strictEqual(build({ cmd: "Get-Date" }), "Get-Date");
    const run = build({ type: "run", file: "C:\\to ol\\my app.bat", args: ["x y", "1"] });
    assert.ok(run.startsWith("& 'C:\\to ol\\my app.bat'") && run.includes("'x y'") && run.includes("'1'"), label + " run quoting");
    assert.ok(build({ file: "C:\\a\\b.exe" }).startsWith("& 'C:\\a\\b.exe'"), label + " bare file=>run");
    const c = build({ type: "cmd", cmd: "dir & echo hi" });
    assert.ok(c.includes("cmd.exe /d /c") && c.includes("chcp 65001>nul & dir & echo hi"), label + " cmd chcp");
    const d = build({ type: "detached", file: "notepad.exe" });
    assert.ok(d.includes("Start-Process -FilePath 'notepad.exe'") && d.includes("-PassThru") && d.includes("-WindowStyle Hidden"), label + " detached");
    assert.ok(build({ type: "detached", file: "x.exe", elevate: true }).includes("-Verb RunAs"), label + " elevate");
    assert.ok(build({ cmd: "pwd", cwd: "C:\\tmp" }).startsWith("Set-Location -LiteralPath 'C:\\tmp';"), label + " cwd");
    // ── POSIX 分支（Linux/macOS 本机执行；targetPlatform 非 win32）──
    assert.strictEqual(build({ cmd: "uname -a" }, "linux"), "uname -a", label + " posix shell");
    assert.strictEqual(build({ type: "cmd", cmd: "echo a && echo b" }, "linux"), "echo a && echo b", label + " posix cmd=>shell");
    const pr = build({ type: "run", file: "/opt/my app.sh", args: ["x y", "1"] }, "linux");
    assert.ok(pr.startsWith("sh '/opt/my app.sh'") && pr.includes("'x y'") && pr.includes("'1'") && pr.endsWith(" 2>&1"), label + " posix run .sh quoting");
    assert.ok(build({ type: "run", file: "/usr/bin/node" }, "linux").startsWith("'/usr/bin/node'"), label + " posix run bin");
    const pd = build({ type: "detached", cmd: "sleep 5" }, "linux");
    assert.ok(pd.startsWith("nohup sleep 5 ") && pd.includes(">/dev/null 2>&1 &") && pd.includes("started pid=$!"), label + " posix detached");
    assert.ok(build({ cmd: "pwd", cwd: "/tmp/x y" }, "linux").startsWith("cd '/tmp/x y' && "), label + " posix cwd");
    ok("buildExecCommand 规范化一致·Win+POSIX 双平台 (" + label + ")");
  }

  // ── 1b. 被控端 bootstrap 轮询器 · 用户命令与回传闭环变量隔离 ──
  //   曾有 bug: Invoke-Expression 在循环作用域直跑,用户命令若定义 $c(或 $aid/$out 等)
  //   即覆写回传所需的命令对象 → cmd_id 变 null → 结果永不回传 → 操控端超时。
  for (const [label, build] of [["ext", ext.buildBootstrap], ["core", core.buildBootstrap]]) {
    const bs = build("https://hub.example/");
    assert.ok(bs.includes("$__daoCid"), label + " bootstrap 固化 cmd_id 到独名变量 $__daoCid");
    assert.ok(/cmd_id\s*=\s*\$__daoCid/.test(bs), label + " 回传用 $__daoCid 而非 $c.cmd_id");
    assert.ok(!/cmd_id\s*=\s*\$c\.cmd_id/.test(bs), label + " 不得再用易被污染的 $c.cmd_id 回传");
    assert.ok(/&\s*\{\s*Invoke-Expression/.test(bs), label + " 用户命令在子作用域 & { Invoke-Expression } 内执行,隔离变量污染");
    assert.ok(!/foreach\(\$c in @\(\$poll\.commands\)\)/.test(bs), label + " 循环变量改用独名 $__daoCmd,避与用户 $c 冲突");
    ok("buildBootstrap 被控端轮询器变量隔离·用户命令不污染回传闭环 (" + label + ")");
  }

  // ── 2. 中枢本机真实执行（仅 win32）──
  if (process.platform === "win32") {
    const tmp = os.tmpdir();
    const batPath = path.join(tmp, "dao_src_exec_" + Date.now() + ".bat");
    fs.writeFileSync(batPath, "@echo off\r\necho DAO-SRC-BAT %1\r\nexit /b 7\r\n");

    // 2a. headless core.handleRoute 跑 .bat（type:run）
    const host = { workspaceRoot: () => tmp, info: () => ({ host: os.hostname() }), log: () => {} };
    const TOKEN = "t0ken";
    const hdr = { authorization: "Bearer " + TOKEN };
    const cr = await core.handleRoute(host, "/api/exec", "POST", hdr, JSON.stringify({ type: "run", file: batPath, args: ["CORE42"], timeout: 25 }), TOKEN);
    assert.strictEqual(cr.status, 200);
    assert.ok(cr.body.stdout.includes("DAO-SRC-BAT CORE42"), "core stdout: " + cr.body.stdout);
    assert.strictEqual(cr.body.exit_code, 7, "core exit code");
    ok("core.handleRoute 实跑 .bat (type:run, stdout + 原生退出码 7)");

    // 2b. extension WorkspaceServer.handleApi 跑 .bat（type:run）
    const srv = new ext.WorkspaceServer();
    const er = await srv.handleApi("POST", "/api/exec-sync", { type: "run", file: batPath, args: ["EXT42"], cwd: tmp, timeout: 25 }, true);
    assert.strictEqual(er.status, 200);
    assert.ok(er.body.result.stdout.includes("DAO-SRC-BAT EXT42"), "ext stdout: " + er.body.result.stdout);
    assert.strictEqual(er.body.result.exit_code, 7, "ext exit code");
    ok("WorkspaceServer.handleApi 实跑 .bat (type:run, 退出码 7)");

    // 2c. cmd 类型经 cmd.exe（UTF-8）
    const cmr = await srv.handleApi("POST", "/api/exec-sync", { type: "cmd", cmd: "echo cmd-type-ok", cwd: tmp, timeout: 20 }, true);
    assert.ok(cmr.body.result.stdout.includes("cmd-type-ok"), "ext cmd stdout: " + cmr.body.result.stdout);
    ok("WorkspaceServer cmd 类型经 cmd.exe 执行");

    // 2d. shell 默认（cp.exec / cmd.exe）向后兼容
    const sh = await srv.handleApi("POST", "/api/exec-sync", { cmd: "echo back-compat", cwd: tmp, timeout: 20 }, true);
    assert.ok(sh.body.result.stdout.includes("back-compat"), "ext shell stdout: " + sh.body.result.stdout);
    ok("WorkspaceServer shell 默认 cp.exec 向后兼容");

    try { fs.unlinkSync(batPath); } catch {}
  } else {
    // ── POSIX(Linux/macOS) 中枢本机真实执行 ──
    const tmp = os.tmpdir();
    const shPath = path.join(tmp, "dao_src_exec_" + Date.now() + ".sh");
    fs.writeFileSync(shPath, "#!/bin/sh\necho DAO-SRC-SH $1\nexit 7\n");
    const host = { workspaceRoot: () => tmp, info: () => ({ host: os.hostname() }), log: () => {} };
    const TOKEN = "t0ken"; const hdr = { authorization: "Bearer " + TOKEN };

    const cr = await core.handleRoute(host, "/api/exec", "POST", hdr, JSON.stringify({ type: "run", file: shPath, args: ["CORE42"], timeout: 25 }), TOKEN);
    assert.strictEqual(cr.status, 200);
    assert.ok(cr.body.stdout.includes("DAO-SRC-SH CORE42"), "core posix stdout: " + cr.body.stdout);
    assert.strictEqual(cr.body.exit_code, 7, "core posix exit code");
    ok("core.handleRoute 实跑 .sh (type:run, stdout + 退出码 7)·POSIX");

    const srv = new ext.WorkspaceServer();
    const cmr = await srv.handleApi("POST", "/api/exec-sync", { type: "cmd", cmd: "echo cmd-type-ok && echo two", cwd: tmp, timeout: 20 }, true);
    assert.ok(cmr.body.result.stdout.includes("cmd-type-ok") && cmr.body.result.stdout.includes("two"), "ext posix cmd stdout: " + cmr.body.result.stdout);
    ok("WorkspaceServer cmd 类型经 /bin/sh 执行·POSIX");

    const dt = await srv.handleApi("POST", "/api/exec-sync", { type: "detached", cmd: "sleep 1", cwd: tmp, timeout: 20 }, true);
    assert.ok(dt.body.result.stdout.includes("started pid="), "ext posix detached: " + dt.body.result.stdout);
    ok("WorkspaceServer detached 经 nohup 后台启动·POSIX");

    const si = await srv.handleApi("POST", "/api/exec-sync", { type: "sysinfo", cwd: tmp, timeout: 25 }, true);
    assert.ok(si.body.result.stdout.includes("=== SYSTEM ==="), "ext posix sysinfo: " + si.body.result.stdout.slice(0, 80));
    ok("WorkspaceServer sysinfo 经 uname/os-release 采集·POSIX");

    const sh = await srv.handleApi("POST", "/api/exec-sync", { cmd: "echo back-compat", cwd: tmp, timeout: 20 }, true);
    assert.ok(sh.body.result.stdout.includes("back-compat"), "ext posix shell stdout: " + sh.body.result.stdout);
    ok("WorkspaceServer shell 默认向后兼容·POSIX");

    try { fs.unlinkSync(shPath); } catch {}
  }

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
