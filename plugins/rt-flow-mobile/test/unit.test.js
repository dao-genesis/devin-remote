"use strict";
// rt-flow-mobile · 零依赖单测 (node test/unit.test.js) · 无网络 · 无浏览器
// 固化切号决策危辑: 评分 / 候选 / 该不该切 / 余额上限 / 低额预警 / billing 解析。
const assert = require("assert");
const S = require("../core/score.js");
const Cloud = require("../core/devin_cloud.js");

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    failed++;
    failures.push([name, e]);
    console.log("  FAIL " + name + " — " + (e && e.message));
  }
}

const acct = (email, password, extra) => Object.assign({ email, password, skipAutoSwitch: false }, extra || {});
const health = (balance, extra) => Object.assign({ balance, checked: true, staleMin: 10 }, extra || {});

console.log("\n[computeConvCap]");
test("常态 cap = balance - buffer", () => {
  assert.deepStrictEqual(S.computeConvCap(70, 3, false, 1), { cap: 67, drain: false });
  assert.deepStrictEqual(S.computeConvCap(55, 3, false, 1), { cap: 52, drain: false });
});
test("抽干: cap≤0 且 balance>floor → 反抬回余额", () => {
  const r = S.computeConvCap(2, 3, true, 1);
  assert.strictEqual(r.cap, 2);
  assert.strictEqual(r.drain, true);
});
test("见底: balance≤floor → cap=0 不抽干", () => {
  assert.deepStrictEqual(S.computeConvCap(1, 3, true, 1), { cap: 0, drain: false });
});
test("非数 → cap=0", () => {
  assert.deepStrictEqual(S.computeConvCap(null, 3, true, 1), { cap: 0, drain: false });
});

console.log("\n[lowBalanceVerdict]");
test("跌破阈值且上轮未警 → 本轮警", () => {
  assert.deepStrictEqual(S.lowBalanceVerdict(2, 5, false), { alert: true, alerted: true });
});
test("已警则不重复刷屏", () => {
  assert.deepStrictEqual(S.lowBalanceVerdict(2, 5, true), { alert: false, alerted: true });
});
test("回升至阈值上 → 复位", () => {
  assert.deepStrictEqual(S.lowBalanceVerdict(9, 5, true), { alert: false, alerted: false });
});
test("余额无法判定 → 不警 · 保持上轮态", () => {
  assert.deepStrictEqual(S.lowBalanceVerdict(NaN, 5, true), { alert: false, alerted: true });
});

console.log("\n[scoreAccount]");
test("无密码 → -Infinity", () => {
  assert.strictEqual(S.scoreAccount(acct("a@x.com", ""), health(50), { stopThreshold: 3 }), -Infinity);
});
test("用户锁 skipAutoSwitch → -Infinity", () => {
  assert.strictEqual(S.scoreAccount(acct("a@x.com", "p", { skipAutoSwitch: true }), health(50), { stopThreshold: 3 }), -Infinity);
});
test("未验号 → 100", () => {
  assert.strictEqual(S.scoreAccount(acct("a@x.com", "p"), { checked: false }, { stopThreshold: 3 }), 100);
});
test("真耗尽 (余额≤停止阈值) → -Infinity", () => {
  assert.strictEqual(S.scoreAccount(acct("a@x.com", "p"), health(3), { stopThreshold: 3 }), -Infinity);
});
test("余额越高分越高", () => {
  const lo = S.scoreAccount(acct("a@x.com", "p"), health(10), { stopThreshold: 3 });
  const hi = S.scoreAccount(acct("b@x.com", "p"), health(50), { stopThreshold: 3 });
  assert.ok(hi > lo, "hi(" + hi + ") > lo(" + lo + ")");
});
test("inUse 当前号降权 ×0.01 (防来回震荡)", () => {
  const a = acct("a@x.com", "p");
  const free = S.scoreAccount(a, health(50), { stopThreshold: 3 });
  const inuse = S.scoreAccount(a, health(50), { stopThreshold: 3, activeEmail: "a@x.com" });
  assert.ok(inuse < free && inuse >= 1, "inuse(" + inuse + ") < free(" + free + ")");
});

console.log("\n[pickBestIndex / sortedIndices]");
test("选出余额最高的可用号", () => {
  const accts = [acct("a@x.com", "p"), acct("b@x.com", "p"), acct("c@x.com", "p")];
  const healths = { "a@x.com": health(10), "b@x.com": health(80), "c@x.com": health(40) };
  assert.strictEqual(S.pickBestIndex(accts, healths, { stopThreshold: 3 }, -1), 1);
});
test("排除当前号后选次优", () => {
  const accts = [acct("a@x.com", "p"), acct("b@x.com", "p"), acct("c@x.com", "p")];
  const healths = { "a@x.com": health(10), "b@x.com": health(80), "c@x.com": health(40) };
  assert.strictEqual(S.pickBestIndex(accts, healths, { stopThreshold: 3 }, 1), 2);
});
test("耗尽号不进候选 (sortedIndices)", () => {
  const accts = [acct("a@x.com", "p"), acct("b@x.com", "p")];
  const healths = { "a@x.com": health(2), "b@x.com": health(40) };
  assert.deepStrictEqual(S.sortedIndices(accts, healths, { stopThreshold: 3 }, -1), [1]);
});

console.log("\n[shouldSwitch]");
test("当前号健康 → 不切", () => {
  const accts = [acct("a@x.com", "p"), acct("b@x.com", "p")];
  const healths = { "a@x.com": health(40), "b@x.com": health(80) };
  const v = S.shouldSwitch(accts, healths, { stopThreshold: 3, activeEmail: "a@x.com" }, 0);
  assert.strictEqual(v.switch, false);
});
test("当前号耗尽 + 有候选 → 切到最佳", () => {
  const accts = [acct("a@x.com", "p"), acct("b@x.com", "p")];
  const healths = { "a@x.com": health(2), "b@x.com": health(80) };
  const v = S.shouldSwitch(accts, healths, { stopThreshold: 3, activeEmail: "a@x.com" }, 0);
  assert.strictEqual(v.switch, true);
  assert.strictEqual(v.nextIdx, 1);
});
test("当前号耗尽但无健康候选 → 不切 (不臆造)", () => {
  const accts = [acct("a@x.com", "p"), acct("b@x.com", "p")];
  const healths = { "a@x.com": health(2), "b@x.com": health(1) };
  const v = S.shouldSwitch(accts, healths, { stopThreshold: 3, activeEmail: "a@x.com" }, 0);
  assert.strictEqual(v.switch, false);
});
test("当前号被锁 + 有候选 → 切走", () => {
  const accts = [acct("a@x.com", "p", { skipAutoSwitch: true }), acct("b@x.com", "p")];
  const healths = { "a@x.com": health(40), "b@x.com": health(80) };
  const v = S.shouldSwitch(accts, healths, { stopThreshold: 3, activeEmail: "a@x.com" }, 0);
  assert.strictEqual(v.switch, true);
  assert.strictEqual(v.reason, "locked");
});

console.log("\n[billingBalance]");
test("available + 正 overage 求和", () => {
  assert.strictEqual(Cloud.billingBalance({ available_credits: 30, overage_credits: 5 }), 35);
});
test("有订阅/有额度权威布尔 → 充足 (>0 或 9999)", () => {
  assert.strictEqual(Cloud.billingBalance({ has_subscription_or_credits: true, available_credits: 0 }), 9999);
  assert.strictEqual(Cloud.billingBalance({ is_subscription_valid: true, available_credits: 12 }), 12);
});
test("明确无订阅无额度 → 真实余额 0", () => {
  assert.strictEqual(Cloud.billingBalance({ has_subscription_or_credits: false }), 0);
});
test("字段全无 → null (安全·不臆断)", () => {
  assert.strictEqual(Cloud.billingBalance({ something_else: 1 }), null);
  assert.strictEqual(Cloud.billingBalance(null), null);
});
test("负 overage (已欠) 不抬高余额", () => {
  assert.strictEqual(Cloud.billingBalance({ available_credits: 10, overage_credits: -4 }), 10);
});

(function summary() {
  console.log("\n" + "=".repeat(48));
  console.log("rt-flow-mobile 单测: " + passed + " 通过, " + failed + " 失败");
  if (failed) {
    for (const [n, e] of failures) console.log("  ✗ " + n + ": " + (e && e.message));
    process.exit(1);
  }
})();
