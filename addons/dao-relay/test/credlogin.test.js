"use strict";
// credlogin 纯逻辑单测: TOTP(RFC6238 官方向量) + 页面类型判定。副作用(浏览器/部署)不在此测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, base32Decode, isAuthorizePage, isLoginPage } from "../credlogin.mjs";

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
