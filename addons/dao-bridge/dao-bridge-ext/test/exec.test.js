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
    ok("buildExecCommand 规范化一致 (" + label + ")");
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
    ok("中枢本机实跑 (skipped: non-win)");
  }

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
