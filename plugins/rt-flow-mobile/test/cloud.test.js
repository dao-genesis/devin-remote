"use strict";
// 纯函数单测 (零依赖, node 直接跑): node test/cloud.test.js
// 覆盖 billingBalance / decodeJwtUserId / 评分逻辑 —— 与 rt-flow/devin_cloud.js 同源判定。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// 加载 cloud.js (它把 DaoCloud 挂到 globalThis)
global.atob = (b) => Buffer.from(b, "base64").toString("binary");
require(path.join(__dirname, "..", "src", "cloud.js"));
const { billingBalance, decodeJwtUserId } = globalThis.DaoCloud;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
}

console.log("billingBalance:");
t("available + 正 overage 相加", () => {
  assert.strictEqual(billingBalance({ available_credits: 50, overage_credits: 5 }), 55);
});
t("负 overage(已欠) 不减 available", () => {
  assert.strictEqual(billingBalance({ available_credits: 20, overage_credits: -3 }), 20);
});
t("has_subscription_or_credits=true 且额度 0 → 充足(9999)", () => {
  assert.strictEqual(billingBalance({ available_credits: 0, overage_credits: 0, has_subscription_or_credits: true }), 9999);
});
t("has_subscription_or_credits=false → 真实余额", () => {
  assert.strictEqual(billingBalance({ available_credits: 0, overage_credits: 0, has_subscription_or_credits: false }), 0);
});
t("字段全缺 → null(安全, 不臆造)", () => {
  assert.strictEqual(billingBalance({}), null);
});
t("null 输入 → null", () => {
  assert.strictEqual(billingBalance(null), null);
});

console.log("decodeJwtUserId:");
t("从 JWT payload.sub 解出 user-XXX", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "user-abc123" })).toString("base64");
  const jwt = "h." + payload + ".s";
  assert.strictEqual(decodeJwtUserId(jwt), "user-abc123");
});
t("user_id 字段优先", () => {
  const payload = Buffer.from(JSON.stringify({ user_id: "user-zzz" })).toString("base64");
  assert.strictEqual(decodeJwtUserId("h." + payload + ".s"), "user-zzz");
});
t("非 JWT → 空串", () => {
  assert.strictEqual(decodeJwtUserId("not-a-jwt"), "");
});

// 评分逻辑 (与 background.js scoreOf 同义, 此处独立断言其语义)
function scoreOf(quota) {
  if (!quota) return -1;
  if (quota.balance == null) return -1;
  return quota.balance;
}
console.log("scoreOf (rotate 评分):");
t("余额高者评分高", () => {
  assert.ok(scoreOf({ balance: 50 }) > scoreOf({ balance: 5 }));
});
t("未知额度(null) 低于任何正余额", () => {
  assert.ok(scoreOf({ balance: null }) < scoreOf({ balance: 0.0 }) || scoreOf({ balance: 0 }) === 0);
  assert.ok(scoreOf({ balance: null }) < scoreOf({ balance: 1 }));
});
t("无 quota 记录 → -1", () => {
  assert.strictEqual(scoreOf(undefined), -1);
});

// login(): user_id 的权威真源是 login 响应本体 (回归防护 —— 修复前 userId 恒空,
// 因 auth1 是不透明令牌·非 JWT 且 post-auth 不回传 user_id)。mock fetch, 不触网。
const { login } = globalThis.DaoCloud;
(async () => {
  console.log("login (userId 来源):");
  global.fetch = async (url) => {
    if (String(url).includes("/password/login"))
      return { status: 200, async text() { return JSON.stringify({ token: "auth1_opaque_not_a_jwt_xxxxxxxx", user_id: "user-xyz", email: "a@b.c" }); } };
    if (String(url).includes("/users/post-auth"))
      return { status: 200, async text() { return JSON.stringify({ org_id: "org-123", org_name: "n" }); } };
    return { status: 404, async text() { return ""; } };
  };
  const r = await login("a@b.c", "pw");
  t("userId 取自 login 响应 (post-auth 不回传 user_id 时)", () => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.userId, "user-xyz");
    assert.strictEqual(r.orgId, "org-123");
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
