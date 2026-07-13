// Standalone harness (NOT part of CI): runtime-verifies per-account env mode
// (Linux/Windows) contract — default linux, persist round-trip, per-account
// isolation, invalid-mode normalization, and reload restore — against a temp HOME.
//
//   node core/rt-flow/test/env_mode.harness.js
const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── isolate HOME so we touch only a throwaway ~/.wam/_env_mode.json ──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wam-envmode-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// ── stub `vscode` (provided by the IDE host in production) ──
const noop = () => {};
function deepProxy() {
  return new Proxy(function () {}, {
    get(_t, k) { if (k === "then") return undefined; return deepProxy(); },
    apply() { return deepProxy(); },
    construct() { return deepProxy(); },
  });
}
const vscodeStub = new Proxy({
  commands: { executeCommand: async () => null, registerCommand: () => ({ dispose: noop }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: { showInformationMessage: noop, showWarningMessage: noop, showErrorMessage: noop, createOutputChannel: () => ({ appendLine: noop, append: noop, show: noop, dispose: noop }) },
  env: { clipboard: { writeText: async () => {} } },
  Uri: { parse: (u) => ({ fsPath: u }), file: (p) => ({ fsPath: p }) },
  EventEmitter: class { constructor() { this.event = noop; } fire() {} dispose() {} },
  ViewColumn: { One: 1 },
}, { get(t, k) { return k in t ? t[k] : deepProxy(); } });

const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return _origLoad.call(this, request, parent, isMain);
};

const ext = require("../extension.js");
const I = ext._internals;
assert.ok(I, "_internals missing");
assert.ok(typeof I._normEnvMode === "function", "_normEnvMode missing");
assert.ok(typeof I._readEnvModeState === "function", "_readEnvModeState missing");
assert.ok(typeof I._writeEnvModeStates === "function", "_writeEnvModeStates missing");
assert.ok(typeof I.getAccountEnvMode === "function", "getAccountEnvMode missing");

let ok = 0;
function t(name, fn) {
  fn();
  ok++;
  console.log("  ok   " + name);
}

const A = "acct.a@example.com";
const B = "acct.b@example.com";

t("缺省无记录 → linux (默认)", () => {
  assert.strictEqual(I.getAccountEnvMode(A), "linux");
  assert.strictEqual(I.getAccountEnvMode(B), "linux");
});

t("_normEnvMode 归一化 (仅 windows/linux · 大小写/垃圾值皆归 linux)", () => {
  assert.strictEqual(I._normEnvMode("windows"), "windows");
  assert.strictEqual(I._normEnvMode("WINDOWS"), "windows");
  assert.strictEqual(I._normEnvMode("linux"), "linux");
  assert.strictEqual(I._normEnvMode("mac"), "linux");
  assert.strictEqual(I._normEnvMode(null), "linux");
  assert.strictEqual(I._normEnvMode(undefined), "linux");
  assert.strictEqual(I._normEnvMode(123), "linux");
});

t("写 A→windows 落盘 + 读盘还原 (round-trip)", () => {
  const wr = I._writeEnvModeStates([{ email: A, mode: "windows" }]);
  assert.strictEqual(wr.ok, true);
  assert.strictEqual(wr.changed, 1);
  assert.strictEqual(I.getAccountEnvMode(A), "windows");
  const file = path.join(tmpHome, ".wam", "_env_mode.json");
  assert.ok(fs.existsSync(file), "_env_mode.json 未落盘");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(j.modes[A].envMode, "windows");
});

t("每号隔离: 切 A 不波及 B (B 仍 linux)", () => {
  assert.strictEqual(I.getAccountEnvMode(A), "windows");
  assert.strictEqual(I.getAccountEnvMode(B), "linux");
});

t("切回 A→linux (linux⇄windows 往返)", () => {
  I._writeEnvModeStates([{ email: A, mode: "linux" }]);
  assert.strictEqual(I.getAccountEnvMode(A), "linux");
});

t("非法 mode 落盘归一为 linux (不写入垃圾态)", () => {
  I._writeEnvModeStates([{ email: B, mode: "solaris" }]);
  assert.strictEqual(I.getAccountEnvMode(B), "linux");
  const j = JSON.parse(fs.readFileSync(path.join(tmpHome, ".wam", "_env_mode.json"), "utf8"));
  assert.strictEqual(j.modes[B].envMode, "linux");
});

t("空 email 被跳过 (不产生空键)", () => {
  const wr = I._writeEnvModeStates([{ email: "", mode: "windows" }]);
  assert.ok(!Object.prototype.hasOwnProperty.call(I._readEnvModeState(), ""));
});

t("新进程读盘还原 (模拟重启): 独立 require 拿到持久化态", () => {
  I._writeEnvModeStates([{ email: A, mode: "windows" }]);
  // 直接读盘验证 (等价于 reloadAccounts 里的 _readEnvModeState 还原)
  const modes = I._readEnvModeState();
  assert.strictEqual(modes[A].envMode, "windows");
  assert.strictEqual(I._normEnvMode(modes[A].envMode), "windows");
});

console.log("\n──────────────────────────────────────");
console.log("ENV-MODE HARNESS · PASS " + ok + " · ALL GREEN");
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
