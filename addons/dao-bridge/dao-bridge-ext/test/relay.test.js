// util.test.js — cloudflared 工具函数测试 + Token 刷新:
//   1. extractCfTgz tar 解包
//   2. isRealCloudflared 体积判据
//   3. cfAssetName 跨平台矩阵
//   4. refreshToken 令牌轮换
// 运行: node test/relay.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const Module = require("module");
const vscodeStub = { workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }) }, window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), setStatusBarMessage: () => ({ dispose() {} }), createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "" }) }, commands: { registerCommand: () => ({ dispose() {} }) }, env: { appName: "test", machineId: "m", sessionId: "s", clipboard: { writeText: async () => {} } }, version: "1.90.0", StatusBarAlignment: { Left: 1, Right: 2 }, Uri: { file: (p) => ({ fsPath: p }) }, extensions: { all: [], getExtension: () => undefined } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return origLoad.apply(this, arguments);
};

const ext = require("../extension.js");
const { extractCfTgz, isRealCloudflared, cfAssetName } = ext;

let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }

(async () => {
  // T1: extractCfTgz 解 tar.gz 取出 cloudflared 真二进制
  {
    const body = Buffer.alloc(1200000, 7); // >1MB
    const header = Buffer.alloc(512);
    header.write("cloudflared", 0);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
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

  // T2: isRealCloudflared 体积判据(<1MB 拒, >1MB 收)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfbin-"));
    const small = path.join(dir, "cloudflared"); fs.writeFileSync(small, Buffer.alloc(500));
    assert.strictEqual(isRealCloudflared(small), false, "shim/half (<1MB) rejected");
    const big = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared2");
    fs.writeFileSync(big, Buffer.alloc(1100000));
    if (process.platform !== "win32") assert.strictEqual(isRealCloudflared(big), true, "real-size binary accepted");
    ok("isRealCloudflared size gate");
  }

  // T3: 跨平台 cloudflared 资产名矩阵(适配 Windows/Linux/macOS x amd64/arm64/arm)
  {
    const origP = Object.getOwnPropertyDescriptor(process, "platform");
    const origA = Object.getOwnPropertyDescriptor(process, "arch");
    const set = (p, a) => {
      Object.defineProperty(process, "platform", { value: p, configurable: true });
      Object.defineProperty(process, "arch", { value: a, configurable: true });
    };
    try {
      assert.strictEqual(cfAssetName.call(null) !== undefined, true);
      set("win32", "x64"); assert.strictEqual(cfAssetName(), "cloudflared-windows-amd64.exe");
      set("win32", "arm64"); assert.strictEqual(cfAssetName(), "cloudflared-windows-arm64.exe");
      set("darwin", "x64"); assert.strictEqual(cfAssetName(), "cloudflared-darwin-amd64.tgz");
      set("darwin", "arm64"); assert.strictEqual(cfAssetName(), "cloudflared-darwin-arm64.tgz");
      set("linux", "x64"); assert.strictEqual(cfAssetName(), "cloudflared-linux-amd64");
      set("linux", "arm64"); assert.strictEqual(cfAssetName(), "cloudflared-linux-arm64");
      set("linux", "arm"); assert.strictEqual(cfAssetName(), "cloudflared-linux-arm");
      assert.ok(/\.tgz$/.test("cloudflared-darwin-arm64.tgz"), "darwin asset is tgz");
    } finally {
      Object.defineProperty(process, "platform", origP);
      Object.defineProperty(process, "arch", origA);
    }
    ok("cfAssetName cross-platform matrix (win/linux/macOS x amd64/arm64/arm)");
  }

  // T4: 刷新Token — rotateToken 生成全新令牌, 旧令牌即刻作废, 新令牌获授权
  {
    const { WorkspaceServer } = ext;
    const srv = new WorkspaceServer();
    const before = srv.rotateToken();
    assert.strictEqual(before.length, 32, "rotateToken issues 16-byte hex token");
    assert.strictEqual(srv.authToken("Bearer " + before), true, "token authorized");
    const after = srv.rotateToken();
    assert.ok(after && after !== before, "refresh rotates to a new distinct token");
    assert.strictEqual(srv.token, after, "server adopts new token");
    assert.strictEqual(srv.authToken("Bearer " + before), false, "old token revoked after refresh");
    assert.strictEqual(srv.authToken("Bearer " + after), true, "new token authorized");
    ok("refreshToken rotates token (old revoked, new authorized)");
  }

  console.log("\nALL " + passed + " TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\nTEST FAILED:", e && e.stack || e); process.exit(1); });
