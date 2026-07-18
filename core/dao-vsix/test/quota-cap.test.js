"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-vsix · 反向注入「单会话上限 = 当前余额 − 预留」回归自测 (node test/quota-cap.test.js)
//   根治「$4 上限凭空冒出」: 旧法 cap = max(floor(余额−off), off+1) — 余额 <7 时一律回写 4,
//   与真实余额无关且可高于实际余额。现法: 余额足 → floor(余额−off); 不足留预留 → floor(余额)(≥1)。
//   每条新消息按「当前余额−预留」封顶 (70→67, 40→37), 不沿用会话起始配置。
//   种子: extension.ts 尾部 DAO_SELFTEST=1 守卫暴露的 __selftest.quotaCapFromAvail。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dao-quotacap-"));
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
assert.ok(S && typeof S.quotaCapFromAvail === "function", "__selftest.quotaCapFromAvail 未暴露");
const cap = S.quotaCapFromAvail;

let passed = 0, failed = 0; const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; fails.push([name, e]); console.log("  FAIL " + name + " — " + (e && e.message)); }
}

console.log("\n[quotaCapFromAvail · 余额充裕: cap = floor(余额 − 预留)]");
test("70 → 67 (默认预留 3 · 用户示例一)", () => assert.strictEqual(cap(70, 3), 67));
test("40 → 37 (第二条消息按当前余额重算 · 用户示例二)", () => assert.strictEqual(cap(40, 3), 37));
test("69.9 → 66 (向下取整·不越预留)", () => assert.strictEqual(cap(69.9, 3), 66));
test("预留可调: 67 · off=5 → 62", () => assert.strictEqual(cap(67, 5), 62));

console.log("\n[quotaCapFromAvail · 低余额: 绝不凭空冒出 off+1(旧「$4」病灶), cap ≤ 真实余额]");
test("余额 6.5 · off=3 → 3 (旧法误回 4)", () => assert.strictEqual(cap(6.5, 3), 3));
test("余额 4 · off=3 → 3 (残额仍可花 · 不再钉 off+1=4)", () => assert.strictEqual(cap(4, 3), 3));
test("余额 2 · off=3 → 2 (≤真实余额 · 旧法回 4 反而超余额)", () => assert.strictEqual(cap(2, 3), 2));
test("余额 0.5 · off=3 → 1 (服务端 max_credits 下限)", () => assert.strictEqual(cap(0.5, 3), 1));
test("余额 0 → 1 (下限)", () => assert.strictEqual(cap(0, 3), 1));
test("负余额(欠费) → 1 (下限 · 不发无效值)", () => assert.strictEqual(cap(-5, 3), 1));

console.log("\n[quotaCapFromAvail · 单调性与边界]");
test("边界: 4.9 · off=3 → 3; 7 → 4 (余额−预留接管)", () => { assert.strictEqual(cap(4.9, 3), 3); assert.strictEqual(cap(7, 3), 4); });
test("单调不减: 0..100 步进 0.5 恒 cap(x+0.5) ≥ cap(x)", () => {
  for (let x = 0; x < 100; x += 0.5) assert.ok(cap(x + 0.5, 3) >= cap(x, 3), "x=" + x);
});
test("恒 ≥1 且 余额≥1 时恒 ≤ ceil(余额)", () => {
  for (let x = 0; x < 100; x += 0.7) {
    const c = cap(x, 3);
    assert.ok(c >= 1, "x=" + x);
    if (x >= 1) assert.ok(c <= Math.ceil(x), "x=" + x + " cap=" + c);
  }
});

// ── overageBalance · overage_credits 双符号实证归一 (根治「有 $60-70 余额却被限 $4」) ──
//   病灶: 负值账态(-67 = Remaining balance $67·v3.0 实证)被旧法直接进 max() 当最小值丢弃,
//   残余小额字段(如 available_acus≈7)接管 → cap=7−3=4 在满额账号上诡异复现。
assert.ok(typeof S.overageBalance === "function", "__selftest.overageBalance 未暴露");
const ob = S.overageBalance;
console.log("\n[overageBalance · 幅值即余额]");
test("正值账态: +33.27 → 33.27 (rioskolton 实测)", () => assert.strictEqual(ob(33.27, null), 33.27));
test("负值账态: -67 且无 billing_error → 67 (Remaining balance)", () => assert.strictEqual(ob(-67, null), 67));
test("负值+billing_error(真欠费) → 0", () => assert.strictEqual(ob(-67, "payment_failed"), 0));
test("非数/NaN → 0", () => { assert.strictEqual(ob(undefined, null), 0); assert.strictEqual(ob(NaN, null), 0); });
console.log("\n[端到端: 满额号(-67)+残余 acus 7 · 旧法 cap=4 → 现法 cap=64]");
test("max(7, overageBalance(-67)) = 67 → cap 64 (「$4」根治)", () => {
  const best = Math.max(7, ob(-67, null));
  assert.strictEqual(best, 67);
  assert.strictEqual(cap(best, 3), 64);
});
test("旧病灶复现路径: 丢弃 -67 后 best=7 → cap=4 (对照·说明 $4 从何而来)", () => {
  assert.strictEqual(cap(7, 3), 4);
});

console.log("\n" + (failed ? "FAIL" : "PASS") + " " + passed + "  FAIL " + failed);
if (failed) { for (const [n, e] of fails) console.error("  ✗ " + n + "\n    " + (e && e.stack || e)); }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
