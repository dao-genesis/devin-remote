// relay-api.test.js — 标准版 dao-bridge 的持久通道 /api/relay/* 通用接口单测:
//   与 core/dao-vsix 对齐: deep-link 深链 / state 脱敏 / provision-token 校验 / set 登记接管。
//   1. relayTokenDeepLink 生成含全权限集的 CF Token 创建深链
//   2. GET  /api/relay/deep-link  返回 url + perms + howto
//   3. GET  /api/relay/state      无配置时 active=false; 有配置时 apiToken/relayToken 脱敏(不泄密)
//   4. POST /api/relay/provision-token 缺 token → 400
//   5. POST /api/relay/set        非法 url → 400; 合法 https → 落盘(自动派生 session/token) 并接管
//   6. 上述路由均在 DAEMON_ROUTES 白名单内(常驻桥自证, 免反代)
// 运行: node test/relay-api.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// ── 隔离 HOME → 临时目录, daoDir()/workers-relay.json 落到 tmp, 不污染真实 ~/.dao ──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-relay-api-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const cfgStore = { confineToWorkspace: false };
const vscodeStub = {
  workspace: { workspaceFolders: [], name: "test-ws", getConfiguration: () => ({ get: (k) => cfgStore[k], update: async () => {} }) },
  window: { setStatusBarMessage() {}, createWebviewViewProvider() {}, registerWebviewViewProvider() {} },
  commands: { executeCommand() {}, registerCommand() {} },
  env: { appName: "test", machineId: "m", sessionId: "s" },
  version: "1.80.0",
};
const origLoad = Module._load;
Module._load = function (request) { if (request === "vscode") return vscodeStub; return origLoad.apply(this, arguments); };

const ext = require("../extension.js");
const { relayTokenDeepLink, WorkspaceServer } = ext;

let passed = 0;
function ok(name) { console.log("  PASS  " + name); passed++; }

const relayJsonPath = path.join(tmpHome, ".dao", "bridge", "workers-relay.json");

(async () => {
  // T1: 深链生成 — 权限集与 core/dao-vsix 逐项对齐, 指向 CF Token 创建页
  {
    const url = relayTokenDeepLink("dao-relay");
    assert.ok(url.startsWith("https://dash.cloudflare.com/profile/api-tokens?"), "指向 CF Token 创建页");
    const q = new URL(url).searchParams;
    const perms = JSON.parse(q.get("permissionGroupKeys"));
    const keys = perms.map((p) => p.key + ":" + p.type).sort();
    assert.deepStrictEqual(keys, [
      "account_settings:read", "workers_kv_storage:edit", "workers_routes:edit", "workers_scripts:edit", "zone:read",
    ], "权限集完备(与 dao-vsix 对齐)");
    assert.strictEqual(q.get("accountId"), "*", "accountId=*");
    assert.strictEqual(q.get("name"), "dao-relay", "token 名");
    ok("relayTokenDeepLink 生成全权限 CF Token 创建深链");
  }

  const srv = new WorkspaceServer();

  // T2: GET /api/relay/deep-link
  {
    const r = await srv.handleApi("GET", "/api/relay/deep-link", {}, true);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.ok && /dash\.cloudflare\.com/.test(r.body.url), "回 deep-link url");
    assert.ok(Array.isArray(r.body.perms) && r.body.perms.length === 5, "回 perms 列表");
    assert.ok(/provision-token|\/api\/relay\/set/.test(r.body.howto), "回 howto 指引");
    ok("GET /api/relay/deep-link 返回 url + perms + howto");
  }

  // T3a: GET /api/relay/state — 无配置
  {
    try { fs.unlinkSync(relayJsonPath); } catch (e) {}
    const r = await srv.handleApi("GET", "/api/relay/state", {}, true);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.active, false, "无配置 active=false");
    assert.strictEqual(r.body.publicUrl, null, "无配置 publicUrl=null");
    assert.strictEqual(r.body.state, null, "无配置 state=null");
    ok("GET /api/relay/state 无配置 → active=false");
  }

  // T4: POST /api/relay/provision-token 缺 token → 400
  {
    const r = await srv.handleApi("POST", "/api/relay/provision-token", {}, true);
    assert.strictEqual(r.status, 400, "缺 token → 400");
    assert.ok(!r.body.ok, "ok=false");
    ok("POST /api/relay/provision-token 缺 token → 400");
  }

  // T5a: POST /api/relay/set 非法 url → 400
  {
    const r = await srv.handleApi("POST", "/api/relay/set", { url: "ftp://nope" }, true);
    assert.strictEqual(r.status, 400, "非法 url → 400");
    ok("POST /api/relay/set 非法 url → 400");
  }

  // T5b: POST /api/relay/set 合法 https → 落盘并派生 session/token, 回 publicUrl
  {
    const r = await srv.handleApi("POST", "/api/relay/set", { url: "https://dao-relay-do.example.workers.dev/relay/ignored" }, true);
    assert.strictEqual(r.status, 200, "合法 https → 200");
    assert.ok(r.body.ok, "ok=true");
    assert.strictEqual(r.body.relayUrl, "https://dao-relay-do.example.workers.dev", "去掉 /relay/<session> 尾部后缀");
    assert.ok(/\/relay\//.test(r.body.publicUrl), "回 publicUrl(含 /relay/<session>)");
    const saved = JSON.parse(fs.readFileSync(relayJsonPath, "utf8"));
    assert.strictEqual(saved.relayUrl, "https://dao-relay-do.example.workers.dev", "落盘 relayUrl");
    assert.ok(saved.session && /^dao-/.test(saved.session), "落盘自动派生 session");
    assert.ok(saved.relayToken && /^dao-relay-/.test(saved.relayToken), "落盘自动派生 relayToken");
    ok("POST /api/relay/set 合法 https → 落盘 + 派生 session/token");
  }

  // T3b: GET /api/relay/state 有配置 → 敏感字段脱敏
  {
    const r = await srv.handleApi("GET", "/api/relay/state", {}, true);
    assert.strictEqual(r.body.active, true, "有配置 active=true");
    assert.ok(/\/relay\//.test(r.body.publicUrl), "回 publicUrl");
    assert.strictEqual(r.body.state.relayToken, "***", "relayToken 脱敏");
    assert.ok(r.body.state.apiToken === "" || r.body.state.apiToken === "***", "apiToken 不泄明文");
    ok("GET /api/relay/state 有配置 → 敏感字段脱敏(不泄密)");
  }

  // T6: /api/relay/* 均在 DAEMON_ROUTES(常驻桥自证) — 未鉴权时非 relay 只读路由仍拒
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
    for (const rt of ["/api/relay/deep-link", "/api/relay/state", "/api/relay/provision-token", "/api/relay/set"]) {
      assert.ok(src.includes('"' + rt + '"'), rt + " 在 DAEMON_ROUTES 白名单");
    }
    const unauthed = await srv.handleApi("GET", "/api/relay/state", {}, false);
    assert.strictEqual(unauthed.status, 401, "未鉴权 relay/state → 401");
    ok("/api/relay/* 在 DAEMON_ROUTES + 需鉴权");
  }

  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
  console.log("\nrelay-api: " + passed + " passed");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
