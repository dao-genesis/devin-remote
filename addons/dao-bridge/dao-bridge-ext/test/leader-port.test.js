// leader-port.test.js — 验证桥反代落点以 dao-conn-current.json(leader 权威·epoch 选举)为准,
//   而非 race-prone 的 plugin-api.json(被任一 follower/次账号窗口 last-writer-wins 覆写)。
//   根治: follower(如 9922·次账号)末尾落笔即劫持桥反代离开真 leader(9920) → 公网 /shell 401、/mcp 502。
// 运行: node test/leader-port.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const vscodeStub = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
  window: { setStatusBarMessage() {}, createWebviewViewProvider() {}, registerWebviewViewProvider() {} },
  commands: { executeCommand() {}, registerCommand() {} },
  env: { appName: "test", machineId: "m", sessionId: "s" },
  version: "1.80.0",
};
const origLoad = Module._load;
Module._load = function (request) { if (request === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };

const ext = require("../extension.js");

let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }

// 隔离 HOME: 用临时目录充当 os.homedir(), 布置 .dao 下的两份权威文件。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daoleader-"));
const origHome = os.homedir;
os.homedir = () => tmp;
const daoDir = path.join(tmp, ".dao");
const bridgeDir = path.join(daoDir, "bridge");
fs.mkdirSync(bridgeDir, { recursive: true });
const writeCurrent = (o) => fs.writeFileSync(path.join(daoDir, "dao-conn-current.json"), JSON.stringify(o), "utf8");
const writePluginApi = (o) => fs.writeFileSync(path.join(bridgeDir, "plugin-api.json"), JSON.stringify(o), "utf8");
const rm = (p) => { try { fs.unlinkSync(p); } catch (e) {} };

try {
  // ① 无任何权威文件 → 缺省 9920
  rm(path.join(daoDir, "dao-conn-current.json")); rm(path.join(bridgeDir, "plugin-api.json"));
  assert.strictEqual(ext.readLeaderPluginPort(), 9920, "无权威文件回落 9920");
  ok("无权威文件 → 缺省 9920");

  // ② follower 覆写 plugin-api.json=9922, 但 leader 权威 current=9920 → 必取 9920(不被劫持)
  writePluginApi({ port: 9922, pid: 60420, version: "3.50.102" });
  writeCurrent({ port: 9920, pid: 36960, epoch: 20, version: "3.50.102", alive: [{ port: 9920 }, { port: 9921 }, { port: 9922 }] });
  assert.strictEqual(ext.readLeaderPluginPort(), 9920, "leader 权威 9920 压过 race-prone plugin-api 9922");
  ok("follower 劫持 plugin-api=9922 时仍取 leader current=9920");

  // ③ leader 权威缺失(旧本体未维护 current) → 兼容回落到 plugin-api.json
  rm(path.join(daoDir, "dao-conn-current.json"));
  assert.strictEqual(ext.readLeaderPluginPort(), 9922, "无 leader 权威时兼容回落 plugin-api.json");
  ok("旧本体无 current → 兼容回落 plugin-api.json");

  // ④ current 端口非法 → 回落 plugin-api.json
  writeCurrent({ port: 0, epoch: 1 });
  assert.strictEqual(ext.readLeaderPluginPort(), 9922, "current 端口非法回落 plugin-api");
  ok("current 端口非法 → 回落 plugin-api.json");

  // ⑤ leader 端口随 epoch 迁移(9920 死·9921 接任) → 桥即时跟随新 leader
  writeCurrent({ port: 9921, pid: 57892, epoch: 21, version: "3.50.102", alive: [{ port: 9921 }, { port: 9922 }] });
  assert.strictEqual(ext.readLeaderPluginPort(), 9921, "leader 迁移到 9921 后桥跟随");
  ok("epoch 迁移 leader→9921 桥即时跟随");

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
} catch (e) {
  console.error("\nTEST FAILED:", (e && e.stack) || e);
  process.exit(1);
} finally {
  os.homedir = origHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
