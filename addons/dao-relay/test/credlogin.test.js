"use strict";
// credlogin 纯逻辑单测: TOTP(RFC6238 官方向量) + 页面类型判定。副作用(浏览器/部署)不在此测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, base32Decode, isAuthorizePage, isLoginPage, isAuthedDash, pickGroups, buildTokenPayload, partitionGroupsByScope } from "../credlogin.mjs";

// RFC6238 附录 B: SHA1 种子 = ASCII "12345678901234567890" = Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32Decode 还原 ASCII 种子", () => {
  assert.equal(base32Decode(SEED).toString("ascii"), "12345678901234567890");
});

test("totp 对齐 RFC6238 官方测试向量(6位)", () => {
  assert.equal(totp(SEED, { at: 59000 }), "287082");
  assert.equal(totp(SEED, { at: 1111111109000 }), "081804");
  assert.equal(totp(SEED, { at: 1234567890000 }), "005924");
  assert.equal(totp(SEED, { at: 2000000000000 }), "279037");
});

test("totp 容错含空格/小写的种子", () => {
  assert.equal(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", { at: 59000 }), "287082");
});

test("totp 拒绝空种子", () => {
  assert.throws(() => totp(""), /TOTP/);
});

test("isAuthorizePage / isLoginPage 判定", () => {
  assert.equal(isAuthorizePage("https://dash.cloudflare.com/oauth2/auth?client_id=x"), true);
  assert.equal(isAuthorizePage("https://dash.cloudflare.com/login"), false);
  assert.equal(isAuthorizePage("https://evil.com/oauth2/auth"), false);
  assert.equal(isLoginPage("https://dash.cloudflare.com/login?next=/oauth2/auth"), true);
  assert.equal(isLoginPage("https://dash.cloudflare.com/sign-in"), true);
  assert.equal(isLoginPage("https://dash.cloudflare.com/oauth2/auth"), false);
});

test("isAuthedDash 只认已登录 dashboard 会话态", () => {
  assert.equal(isAuthedDash("https://dash.cloudflare.com/"), true);
  assert.equal(isAuthedDash("https://dash.cloudflare.com/abc123/workers"), true);
  assert.equal(isAuthedDash("https://dash.cloudflare.com/login"), false);
  assert.equal(isAuthedDash("https://dash.cloudflare.com/sign-in"), false);
  assert.equal(isAuthedDash("https://dash.cloudflare.com/oauth2/auth?client_id=x"), false);
  assert.equal(isAuthedDash("https://evil.com/"), false);
});

// 权限组全集(仿 CF /user/tokens/permission_groups 返回), 带 scopes(真实形态)。
const GROUPS = [
  { id: "g-ws-write", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
  { id: "g-ws-read", name: "Workers Scripts Read", scopes: ["com.cloudflare.api.account"] },
  { id: "g-acct-read", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
  { id: "g-user-read", name: "User Details Read", scopes: ["com.cloudflare.api.user"] },
  { id: "g-memb-read", name: "Memberships Read", scopes: ["com.cloudflare.api.user"] },
  { id: "g-apitok-w", name: "API Tokens Write", scopes: ["com.cloudflare.api.user"] },
  { id: "g-apitok-r", name: "API Tokens Read", scopes: ["com.cloudflare.api.user"] },
  { id: "g-zone-read", name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "g-dns-write", name: "DNS Write", scopes: ["com.cloudflare.api.account.zone"] },
];

test("pickGroups 按名挑出 id·忽略缺失与噪声", () => {
  assert.deepEqual(pickGroups(GROUPS, ["Workers Scripts Write", "Account Settings Read"]), [{ id: "g-ws-write" }, { id: "g-acct-read" }]);
  assert.deepEqual(pickGroups(GROUPS, ["Nonexistent"]), []);
  assert.deepEqual(pickGroups(null, ["Workers Scripts Write"]), []);
});

test("partitionGroupsByScope 按 scope 归类(账号/用户/zone)", () => {
  const part = partitionGroupsByScope(GROUPS);
  assert.deepEqual(part.account.map((x) => x.id).sort(), ["g-acct-read", "g-ws-read", "g-ws-write"]);
  assert.deepEqual(part.user.map((x) => x.id).sort(), ["g-apitok-r", "g-apitok-w", "g-memb-read", "g-user-read"]);
  assert.deepEqual(part.zone.map((x) => x.id).sort(), ["g-dns-write", "g-zone-read"]);
});

test("partitionGroupsByScope 缺 scopes 时按名兜底归类", () => {
  const part = partitionGroupsByScope([
    { id: "a", name: "Workers Scripts Write" },  // → 账号级
    { id: "u", name: "API Tokens Write" },       // → 用户级
    { id: "z", name: "Zone Read" },              // → zone 级
  ]);
  assert.deepEqual(part.account.map((x) => x.id), ["a"]);
  assert.deepEqual(part.user.map((x) => x.id), ["u"]);
  assert.deepEqual(part.zone.map((x) => x.id), ["z"]);
});

test("buildTokenPayload 默认拉满: 账号级+用户级+zone 级三条 allow=* 策略·覆盖全部权限组", () => {
  const p = buildTokenPayload({ name: "t1", accountId: "acc1", userId: "usr1", groups: GROUPS });
  assert.equal(p.name, "t1");
  assert.equal(p.policies.length, 3);
  const acct = p.policies.find((x) => x.resources["com.cloudflare.api.account.acc1"] === "*");
  const user = p.policies.find((x) => x.resources["com.cloudflare.api.user.usr1"] === "*");
  const zone = p.policies.find((x) => x.resources["com.cloudflare.api.account.zone.*"] === "*");
  assert.ok(acct && acct.permission_groups.length === 3 && acct.effect === "allow");
  assert.ok(user && user.permission_groups.length === 4 && user.effect === "allow"); // 含 API Tokens 读+写 → 令牌可自管理
  assert.ok(zone && zone.permission_groups.length === 2 && zone.effect === "allow");
  // 拉满关键: 用户级含 API Tokens 写(可自撤 Token)。
  assert.ok(user.permission_groups.some((g) => g.id === "g-apitok-w") && user.permission_groups.some((g) => g.id === "g-apitok-r"));
});

test("buildTokenPayload min:true 回退最小集(账号级+用户级各 2 组)", () => {
  const p = buildTokenPayload({ name: "t1", accountId: "acc1", userId: "usr1", groups: GROUPS, min: true });
  assert.equal(p.policies.length, 2);
  const acct = p.policies.find((x) => x.resources["com.cloudflare.api.account.acc1"] === "*");
  const user = p.policies.find((x) => x.resources["com.cloudflare.api.user.usr1"] === "*");
  assert.ok(acct && acct.permission_groups.length === 2);
  assert.ok(user && user.permission_groups.length === 2);
});

test("buildTokenPayload 缺 accountId/权限组时不产该策略", () => {
  const p = buildTokenPayload({ userId: "usr1", groups: GROUPS });
  // 无 accountId → 账号级/zone 级都不产, 只剩用户级
  assert.equal(p.policies.length, 1);
  assert.ok(p.policies[0].resources["com.cloudflare.api.user.usr1"]);
  const empty = buildTokenPayload({ accountId: "a", userId: "u", groups: [] });
  assert.equal(empty.policies.length, 0);
});
