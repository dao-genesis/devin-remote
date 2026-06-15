// worker.test.js — 纯逻辑单测(不触碰 Cloudflare 运行时全局):
//   验证 (session,token) 配对定址 + 可选私有共享密钥闸门 —— 即「零账号默认通道」
//   能成立、且 session/token 任一不符都落到不同 DO(→ no_agent) 的根本判据。
// 运行: node --test test/   (或 node --test test/worker.test.js)
import { test } from "node:test";
import assert from "node:assert";
import { relayKey, sharedTokenOk, VERSION } from "../keys.js";

test("VERSION is a non-empty string", () => {
  assert.strictEqual(typeof VERSION, "string");
  assert.ok(VERSION.length > 0);
});

test("relayKey is deterministic for identical (session,token)", () => {
  assert.strictEqual(relayKey("box1", "tokA"), relayKey("box1", "tokA"));
});

test("relayKey differs when session OR token differs", () => {
  const base = relayKey("box1", "tokA");
  assert.notStrictEqual(base, relayKey("box2", "tokA"), "different session → different namespace");
  assert.notStrictEqual(base, relayKey("box1", "tokB"), "different token → different namespace");
});

test("relayKey has no separator collision (a|bc vs ab|c)", () => {
  // 若用裸拼接 'a'+'bc' === 'ab'+'c' 会撞键; NUL 分隔杜绝之。
  assert.notStrictEqual(relayKey("a", "bc"), relayKey("ab", "c"));
});

test("sharedTokenOk: open pairing when no env.DAO_TOKEN (zero-account)", () => {
  assert.strictEqual(sharedTokenOk({}, "anyRandomToken"), true);
  assert.strictEqual(sharedTokenOk({ DAO_TOKEN: "" }, "anyRandomToken"), true);
  assert.strictEqual(sharedTokenOk(undefined, "anyRandomToken"), true);
});

test("sharedTokenOk: locked to shared secret when env.DAO_TOKEN set (private mode)", () => {
  const env = { DAO_TOKEN: "s3cret" };
  assert.strictEqual(sharedTokenOk(env, "s3cret"), true);
  assert.strictEqual(sharedTokenOk(env, "wrong"), false);
  assert.strictEqual(sharedTokenOk(env, ""), false);
});
