"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-vsix · GitHub 账号状态判定 ghAcctStateDecide 回归自测
//   纯函数: 给定 /users/{login} HTTP 状态码 + 是否有 PAT, 判定账号状态。
//   用于舰队面板实时标注封号/凭证失效/正常, 根治「7 个已封号无标出」。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dao-acctstate-"));
const FAKE_HOME = path.join(SANDBOX, "home");
fs.mkdirSync(path.join(FAKE_HOME, ".dao"), { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.DAO_SELFTEST = "1";

function makeVscodeStub() {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      if (prop === "workspaceFolders") return undefined;
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  };
  const target = function () {};
  const proxy = new Proxy(target, handler);
  return proxy;
}
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return makeVscodeStub();
  return _origLoad.call(this, request, parent, isMain);
};

const ext = require("../out/extension.js");
const S = ext.__selftest;
assert.ok(S && typeof S.ghAcctStateDecide === "function", "__selftest.ghAcctStateDecide not exported");
const decide = S.ghAcctStateDecide;

let passed = 0, failed = 0; const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; fails.push([name, e]); console.log("  FAIL " + name + " \u2014 " + (e && e.message)); }
}

console.log("\n[ghAcctStateDecide \u00b7 no PAT]");
test("no PAT \u2192 no_pat regardless of status", () => {
  assert.strictEqual(decide(200, false), "no_pat");
  assert.strictEqual(decide(404, false), "no_pat");
  assert.strictEqual(decide(0, false), "no_pat");
});

console.log("\n[ghAcctStateDecide \u00b7 active account]");
test("200 + hasPat \u2192 active", () => assert.strictEqual(decide(200, true), "active"));

console.log("\n[ghAcctStateDecide \u00b7 suspended account]");
test("404 + hasPat \u2192 suspended", () => assert.strictEqual(decide(404, true), "suspended"));

console.log("\n[ghAcctStateDecide \u00b7 bad credentials]");
test("401 + hasPat \u2192 bad_pat", () => assert.strictEqual(decide(401, true), "bad_pat"));
test("403 + hasPat \u2192 bad_pat", () => assert.strictEqual(decide(403, true), "bad_pat"));

console.log("\n[ghAcctStateDecide \u00b7 offline / network error]");
test("0 + hasPat \u2192 offline (network error)", () => assert.strictEqual(decide(0, true), "offline"));
test("500 + hasPat \u2192 offline (server error fallback)", () => assert.strictEqual(decide(500, true), "offline"));
test("502 + hasPat \u2192 offline", () => assert.strictEqual(decide(502, true), "offline"));

console.log("\n" + (failed ? "\u274c" : "\u2705") + " ghAcctStateDecide: " + passed + " passed, " + failed + " failed");
if (fails.length) { fails.forEach(([n, e]) => console.error("  FAIL " + n + ":", e.message)); process.exit(1); }
