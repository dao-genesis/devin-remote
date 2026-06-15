"use strict";
// relay.js 关键逻辑单测 (零网络): 内网穿透客户端的「入站帧 → 浏览器 RPC 白名单」映射。
//   守约 1: /api/health 免鉴权返回隧道状态。
//   守约 2: shell 类路由 (exec/read/write/ls/...) 一律 403 — 此扩展天然无 shell 能力。
//   守约 3: /api/rpc 只放白名单内的浏览器 RPC, 经 dispatch 执行; 非白名单一律 400。
const assert = require("assert");
const { DaoRelay } = require("../src/relay.js");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}

(async () => {
  DaoRelay._setCfg({ url: "https://relay.example.dev", token: "tok", session: "sess-1" });

  console.log("白名单 (义 B·浏览器能力) vs shell (义 A) 边界:");
  await t("/api/health 免鉴权返回隧道状态", async () => {
    const r = await DaoRelay._handleFrame({ path: "/api/health" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.role, "browser-tunnel");
    assert.strictEqual(r.body.session, "sess-1");
  });

  for (const sh of ["/api/exec", "/api/command", "/api/read", "/api/write", "/api/ls", "/api/info", "/api/device"]) {
    await t("shell 路由被拒: " + sh + " → 403 shell_disabled", async () => {
      const r = await DaoRelay._handleFrame({ path: sh, method: "POST", body: { cmd: "rm -rf /" } });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.error, "shell_disabled");
    });
  }

  console.log("\n/api/rpc → dispatch (白名单内放行·外拒绝):");
  let lastDispatched = null;
  DaoRelay._setDispatch(async (m) => { lastDispatched = m; return { ok: true, echo: m.type, email: m.email }; });

  await t("白名单 cmd=activate 经 dispatch 执行", async () => {
    const r = await DaoRelay._handleFrame({ path: "/api/rpc", method: "POST", body: { cmd: "activate", email: "a@x.com" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(lastDispatched.type, "activate");
    assert.strictEqual(lastDispatched.email, "a@x.com");
  });

  await t("白名单 cmd=openAccountTab (多实例) 经 dispatch 执行", async () => {
    const r = await DaoRelay._handleFrame({ path: "/api/rpc", method: "POST", body: { cmd: "openAccountTab", email: "b@x.com" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(lastDispatched.type, "openAccountTab");
  });

  await t("非白名单 cmd (eval) → 400, 不进 dispatch", async () => {
    lastDispatched = null;
    const r = await DaoRelay._handleFrame({ path: "/api/rpc", method: "POST", body: { cmd: "eval" } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "unknown_or_forbidden_cmd");
    assert.strictEqual(lastDispatched, null);
  });

  await t("缺 cmd → 400", async () => {
    const r = await DaoRelay._handleFrame({ path: "/api/rpc", method: "POST", body: {} });
    assert.strictEqual(r.status, 400);
  });

  await t("未知 path → 404", async () => {
    const r = await DaoRelay._handleFrame({ path: "/api/whatever" });
    assert.strictEqual(r.status, 404);
  });

  console.log("\nstatus / 白名单覆盖 25 条浏览器 RPC:");
  await t("status() 暴露公网入口 = url + /relay/<session>", async () => {
    const s = DaoRelay.status();
    assert.strictEqual(s.publicEndpoint, "https://relay.example.dev/relay/sess-1");
  });
  await t("白名单含 25 条且全无 shell 词", async () => {
    const wl = Array.from(DaoRelay._whitelist);
    assert.strictEqual(wl.length, 25);
    for (const c of wl) assert.ok(!/exec|shell|read|write|spawn/i.test(c), "白名单不应含 shell 类: " + c);
  });

  await new Promise((r) => setTimeout(r, 100));
  console.log("\nrelay.test: " + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();
