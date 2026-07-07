// provision.test.js — 顶层持久通道 provisioner 纯逻辑单测(不触网/不部署):
//   验证预填 Token 深链权限齐备、恒定 URL 计算正确。运行: node --test test/
import { test } from "node:test";
import assert from "node:assert";
import { tokenDeepLink, relayUrl, WORKER_NAME } from "../provision.mjs";

test("tokenDeepLink 指向 CF token 创建页且预填最小权限", () => {
  const u = new URL(tokenDeepLink("dao-relay"));
  assert.strictEqual(u.host, "dash.cloudflare.com");
  assert.ok(u.pathname.includes("api-tokens"));
  const perms = JSON.parse(u.searchParams.get("permissionGroupKeys"));
  const keys = perms.map((p) => `${p.key}:${p.type}`);
  assert.ok(keys.includes("workers_scripts:edit"), "须含 Workers 脚本编辑权限(部署 Worker)");
  assert.ok(keys.includes("account_settings:read"), "须含账号读权限(取子域)");
  assert.strictEqual(u.searchParams.get("name"), "dao-relay");
});

test("relayUrl 由子域算出恒定 workers.dev URL", () => {
  assert.strictEqual(relayUrl("acme"), `https://${WORKER_NAME}.acme.workers.dev`);
});

test("relayUrl 无子域即报错(防止漂移到空 URL)", () => {
  assert.throws(() => relayUrl(""), /subdomain/);
});
