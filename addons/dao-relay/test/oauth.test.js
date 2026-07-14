// oauth.test.js — CF OAuth PKCE 自动打通 provisioner 纯逻辑单测(不触 CF/不部署):
//   验证 PKCE(RFC7636 向量)、授权 URL 格式与 wrangler 同源、令牌态计算、回调服务收码。
//   运行: node --test test/
import { test } from "node:test";
import assert from "node:assert";
import {
  base64urlEncode, pkceChallenge, generatePkce, buildAuthUrl, tokenState,
  waitForCallback, CLIENT_ID, AUTH_URL, CALLBACK_URL, SCOPES,
} from "../oauth.mjs";

test("pkceChallenge 命中 RFC7636 官方测试向量(S256)", async () => {
  const c = await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.strictEqual(c, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("base64urlEncode 无 +/= 填充(RFC4648 §5)", () => {
  const s = base64urlEncode("\xff\xfe\xfd\xfc");
  assert.ok(!/[+/=]/.test(s), "不应含 + / = 字符");
});

test("generatePkce 产出合规长度的 verifier/challenge", async () => {
  const { codeVerifier, codeChallenge } = await generatePkce();
  assert.strictEqual(codeVerifier.length, 128); // 96 字节 base64url
  assert.strictEqual(codeChallenge.length, 43); // 32 字节 sha256 base64url
});

test("buildAuthUrl 与 wrangler 官方 OAuth 应用/端点同源", () => {
  const u = new URL(buildAuthUrl({ state: "st123", codeChallenge: "ch456" }));
  assert.strictEqual(u.origin + u.pathname, AUTH_URL);
  assert.strictEqual(u.searchParams.get("client_id"), CLIENT_ID);
  assert.strictEqual(u.searchParams.get("redirect_uri"), CALLBACK_URL);
  assert.strictEqual(u.searchParams.get("response_type"), "code");
  assert.strictEqual(u.searchParams.get("code_challenge_method"), "S256");
  assert.strictEqual(u.searchParams.get("state"), "st123");
  assert.strictEqual(u.searchParams.get("code_challenge"), "ch456");
});

test("授权 scope 含部署 Worker 最小权限且追加 offline_access(换 refresh)", () => {
  const scope = new URL(buildAuthUrl({ state: "s", codeChallenge: "c" })).searchParams.get("scope").split(" ");
  for (const s of SCOPES) assert.ok(scope.includes(s), `缺少 scope ${s}`);
  assert.ok(scope.includes("offline_access"), "须追加 offline_access 才能拿到 refresh_token");
  assert.ok(scope.includes("workers:write"), "须含 Worker 写权限(部署持久通道)");
});

test("授权 scope 含绑自定义域权限(zone:read + workers_routes:write)——与贴 Token 深链对齐", () => {
  // provision.tryCustomDomain 读 /zones 并写 /accounts/*/workers/domains: OAuth token 也须具此权,
  // 否则 workers.dev 被墙网络下 OAuth 一条龙只能部署 workers.dev、绑不了可达自定义域(与 #74 同源缺陷)。
  assert.ok(SCOPES.includes("zone:read"), "SCOPES 须含 zone:read(读候选 zone)");
  assert.ok(SCOPES.includes("workers_routes:write"), "SCOPES 须含 workers_routes:write(绑 Worker 自定义域)");
});

test("buildAuthUrl 缺 state/challenge 即报错(防生成不可用链接)", () => {
  assert.throws(() => buildAuthUrl({ codeChallenge: "c" }), /state/);
  assert.throws(() => buildAuthUrl({ state: "s" }), /codeChallenge/);
});

test("tokenState 折算 refresh/access/expiry/scopes; refresh 缺省时保留旧值", () => {
  const s = tokenState({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "account:read user:read" });
  assert.strictEqual(s.refreshToken, "r");
  assert.strictEqual(s.accessToken, "a");
  assert.deepStrictEqual(s.scopes, ["account:read", "user:read"]);
  assert.ok(new Date(s.expiry).getTime() > Date.now());
  const s2 = tokenState({ access_token: "a2", expires_in: 3600 }, "keptRefresh");
  assert.strictEqual(s2.refreshToken, "keptRefresh", "刷新响应省略 refresh_token 时须保留旧值(RFC6749 §6)");
});

// 等回调服务 listening 再发请求, 免 ECONNREFUSED 竞态。
function callbackReady(expectedState, opts) {
  let onReady;
  const ready = new Promise((r) => { onReady = r; });
  const done = waitForCallback(expectedState, { timeoutMs: 5000, onReady, ...opts });
  return { ready, done };
}

test("waitForCallback 收到匹配 state 的授权码即 resolve", async () => {
  const port = 8988; // 避开 wrangler 默认 8976, 免撞占用
  const { ready, done } = callbackReady("STATE_OK", { port });
  await ready;
  const res = await fetch(`http://localhost:${port}/oauth/callback?code=THECODE&state=STATE_OK`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await done, "THECODE");
});

test("waitForCallback 对 state 不匹配(CSRF)即 reject", async () => {
  const port = 8989;
  const { ready, done } = callbackReady("EXPECTED", { port });
  const rejected = assert.rejects(done, /state/); // 先挂 handler 再触发, 免 unhandledRejection
  await ready;
  await fetch(`http://localhost:${port}/oauth/callback?code=X&state=EVIL`);
  await rejected;
});

test("waitForCallback 对 error 回调即 reject", async () => {
  const port = 8990;
  const { ready, done } = callbackReady("S", { port });
  const rejected = assert.rejects(done, /access_denied/);
  await ready;
  await fetch(`http://localhost:${port}/oauth/callback?error=access_denied&state=S`);
  await rejected;
});
