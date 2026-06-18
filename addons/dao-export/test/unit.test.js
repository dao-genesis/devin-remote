"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-devin-export · 零依赖单元测试 (node --test) · 无网络 · 无 vscode
//
// 锁死插件的根本逻辑，防后续改动悄悄回退：
//   - 万法识号 parseAccountText（任意格式账号解析）
//   - AccountStore 多账号管理（加号/去重/切号/验号/迁移，api 用桩替换）
//   - worklog/markdown 构建（对话流、最终变更去重、安全文件名、统计）
//   - ZipWriter 产出可被标准 unzip 解开的合法 ZIP
//   - exporter 单对话 MD（事件流取空时回退 first-load）
//   - AgentBridge 本地 HTTP 接口（鉴权 + 端点，真起 127.0.0.1 服务）
//
// 运行：先 `tsc -p ./` 生成 out/，再 `node --test test/`（npm test 已串好）。
// 用 node:test + node:assert，零第三方框架，直接进 CI / 任意机器。
// 道法自然 · 无为而无不为
// ═══════════════════════════════════════════════════════════════════════════
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const accounts = require("../out/accounts.js");
const worklog = require("../out/worklog.js");
const zipmod = require("../out/zip.js");
const exporter = require("../out/exporter.js");
const api = require("../out/api.js");
const { AccountStore } = require("../out/accountStore.js");
const { AgentBridge, selectLoginAccountId } = require("../out/bridge.js");

// ── helpers ────────────────────────────────────────────────────────────────
function memStorage() {
  const m = new Map();
  return {
    get(k) { return m.has(k) ? JSON.parse(m.get(k)) : undefined; },
    update(k, v) { m.set(k, JSON.stringify(v)); return Promise.resolve(); },
    _raw: m,
  };
}

/** Swap api.* functions for the duration of fn(), always restoring. */
async function withApiStubs(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = api[k]; api[k] = stubs[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(stubs)) { api[k] = saved[k]; } }
}

function fakeAuth(email, over = {}) {
  return { token: "tok-" + email, orgId: "org-x", orgBare: "x", orgName: "Org", email, ...over };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 万法识号 · parseAccountText
// ═══════════════════════════════════════════════════════════════════════════
test("isValidEmail: 严判，非 includes('@')", () => {
  assert.ok(accounts.isValidEmail("a@b.com"));
  assert.ok(accounts.isValidEmail("first.last+tag@sub.domain.co"));
  assert.ok(!accounts.isValidEmail("@b.com"));
  assert.ok(!accounts.isValidEmail("a@b"));
  assert.ok(!accounts.isValidEmail("a b@c.com"));
  assert.ok(!accounts.isValidEmail("not-an-email"));
  assert.ok(!accounts.isValidEmail(""));
  assert.ok(!accounts.isValidEmail(null));
});

const FORMAT_CASES = [
  ["space",       "a@b.com pass1",        "a@b.com", "pass1"],
  ["colon",       "a@b.com:pass2",        "a@b.com", "pass2"],
  ["fullwidth :", "a@b.com：pass2b",       "a@b.com", "pass2b"],
  ["dashes",      "a@b.com----pass3",     "a@b.com", "pass3"],
  ["pipe",        "a@b.com|pass4",        "a@b.com", "pass4"],
  ["comma",       "a@b.com,pass5",        "a@b.com", "pass5"],
  ["semicolon",   "a@b.com;pass5b",       "a@b.com", "pass5b"],
  ["tab",         "a@b.com\tpass5c",      "a@b.com", "pass5c"],
  ["pass first",  "pass6 a@b.com",        "a@b.com", "pass6"],
];
for (const [name, input, email, pw] of FORMAT_CASES) {
  test(`parse format · ${name}`, () => {
    const r = accounts.parseAccountText(input);
    assert.strictEqual(r.accounts.length, 1, `expected 1 account from ${JSON.stringify(input)}`);
    assert.strictEqual(r.accounts[0].email, email);
    assert.strictEqual(r.accounts[0].password, pw);
  });
}

test("parse · 中英标签 + 数字序号 (卡号1/卡密1)", () => {
  const r = accounts.parseAccountText("卡号1: u1@v.com\n卡密1: p1\n卡号2: u2@v.com\n卡密2: p2");
  assert.deepStrictEqual(r.accounts, [
    { email: "u1@v.com", password: "p1" },
    { email: "u2@v.com", password: "p2" },
  ]);
});

test("parse · 双标签同行任意顺序 (邮箱：x 密码：y / 反序)", () => {
  const a = accounts.parseAccountText("邮箱：x@y.com 密码：secret");
  assert.deepStrictEqual(a.accounts, [{ email: "x@y.com", password: "secret" }]);
  const b = accounts.parseAccountText("密码：secret2 邮箱：x@y.com");
  assert.deepStrictEqual(b.accounts, [{ email: "x@y.com", password: "secret2" }]);
});

test("parse · 微信发货噪声/订单模板行被静默剥离", () => {
  const r = accounts.parseAccountText(
    "自动发货\n订单编号: 20240101\n尊敬的用户您好\na@b.com hunter2\n感谢惠顾");
  assert.deepStrictEqual(r.accounts, [{ email: "a@b.com", password: "hunter2" }]);
});

test("parse · JSON 单行与数组", () => {
  const arr = accounts.parseAccountText('[{"email":"j@k.com","password":"jp"},{"email":"m@n.com","password":"mp"}]');
  assert.deepStrictEqual(arr.accounts, [
    { email: "j@k.com", password: "jp" }, { email: "m@n.com", password: "mp" }]);
  const one = accounts.parseAccountText('{"email":"o@p.com","password":"op"}');
  assert.deepStrictEqual(one.accounts, [{ email: "o@p.com", password: "op" }]);
});

test("parse · token 直登 (devin-session-token$ / auth1_ / JWT / 长 base64)", () => {
  assert.deepStrictEqual(
    accounts.parseAccountText("devin-session-token$ABC123def456").tokens,
    ["devin-session-token$ABC123def456"]);
  assert.deepStrictEqual(
    accounts.parseAccountText("auth1_abcDEF0123456789abcDEF0123456789abcDEF").tokens.length, 1);
  assert.deepStrictEqual(
    accounts.parseAccountText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4").tokens.length, 1);
  const long = "A".repeat(72);
  assert.deepStrictEqual(accounts.parseAccountText(long).tokens, [long]);
});

test("parse · email----pass 的副码段被去除，真密码保留", () => {
  const r = accounts.parseAccountText("a@b.com:realpw----2fa-backup-code");
  assert.deepStrictEqual(r.accounts, [{ email: "a@b.com", password: "realpw" }]);
});

test("parse · 注释行与空行被忽略", () => {
  const r = accounts.parseAccountText("# comment\n// also comment\n\na@b.com p\n");
  assert.deepStrictEqual(r.accounts, [{ email: "a@b.com", password: "p" }]);
});

test("parse · 一文混万法（邮密 + token 混排）", () => {
  const r = accounts.parseAccountText(
    "a@b.com pass1\nc@d.com:pass2\ndevin-session-token$XYZ789abc123\n邮箱：e@f.com 密码：pass3");
  assert.strictEqual(r.accounts.length, 3);
  assert.strictEqual(r.tokens.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. AccountStore · 多账号管理 (api 桩替换，无网络)
// ═══════════════════════════════════════════════════════════════════════════
test("store · addFromText 计数 + 去重 + 改密重置验证态", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  let r = await s.addFromText("a@b.com p1\nb@c.com p2\ndevin-session-token$TOKTOKTOK123456");
  assert.strictEqual(r.added, 3);
  assert.strictEqual(r.dupes, 0);
  assert.strictEqual(r.emails, 2);
  assert.strictEqual(r.tokens, 1);

  // 同邮箱重复 → dupe，且改密后状态回 unverified
  const acc = s.list().find((a) => a.email === "a@b.com");
  acc.status = "ok";
  acc.auth = fakeAuth("a@b.com");
  r = await s.addFromText("a@b.com newpass");
  assert.strictEqual(r.dupes, 1);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(acc.password, "newpass");
  assert.strictEqual(acc.status, "unverified");
  assert.strictEqual(acc.auth, undefined);
});

test("store · views() 脱敏（不含 password/token）", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  await s.addFromText("a@b.com secret\ndevin-session-token$ABCDEFGHIJ123456");
  for (const v of s.views()) {
    assert.ok(!("password" in v), "view leaked password");
    assert.ok(!("token" in v), "view leaked token");
    assert.ok(v.id && v.kind && typeof v.active === "boolean");
  }
});

test("store · setActive 懒验证并缓存 auth（password 账号）", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  await s.addFromText("a@b.com p1\nb@c.com p2");
  let loginCalls = 0;
  await withApiStubs({
    login: async (email, pw) => { loginCalls++; assert.ok(email && pw); return fakeAuth(email); },
  }, async () => {
    const id = s.list().find((a) => a.email === "b@c.com").id;
    const auth = await s.setActive(id);
    assert.strictEqual(auth.email, "b@c.com");
    assert.strictEqual(s.activeAuth().email, "b@c.com");
    assert.strictEqual(s.getActive().status, "ok");
    // ensureAuth 复用缓存，不再 login
    await s.ensureAuth(id);
    assert.strictEqual(loginCalls, 1);
  });
});

test("store · token 账号用 loginWithToken，回填真实邮箱", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  await s.addFromText("devin-session-token$TOKENVALUE0001");
  await withApiStubs({
    loginWithToken: async (tok) => { assert.ok(tok.startsWith("devin-session-token$")); return fakeAuth("real@user.com"); },
  }, async () => {
    const id = s.list()[0].id;
    const auth = await s.verify(id);
    assert.strictEqual(auth.email, "real@user.com");
    assert.strictEqual(s.get(id).email, "real@user.com");
  });
});

test("store · verify 失败记录 lastError + status=fail，不抛吞", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  await s.addFromText("bad@acct.com wrongpw");
  await withApiStubs({
    login: async () => { throw new Error("Login failed (401)"); },
  }, async () => {
    const id = s.list()[0].id;
    await assert.rejects(() => s.verify(id));
    assert.strictEqual(s.get(id).status, "fail");
    assert.match(s.get(id).lastError, /401/);
  });
});

test("store · verifyAll 统计 ok/fail", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  await s.addFromText("ok1@x.com p\nok2@x.com p\nbad@x.com p");
  await withApiStubs({
    login: async (email) => { if (email.startsWith("bad")) { throw new Error("nope"); } return fakeAuth(email); },
  }, async () => {
    const r = await s.verifyAll(2);
    assert.strictEqual(r.ok, 2);
    assert.strictEqual(r.fail, 1);
  });
});

test("store · remove 重选 active，clear 清空", async () => {
  const s = new AccountStore(memStorage());
  s.load();
  await s.addFromText("a@b.com p\nb@c.com p");
  const first = s.getActive().id;
  await s.remove(first);
  assert.ok(s.getActive() && s.getActive().id !== first);
  await s.clear();
  assert.ok(s.isEmpty());
  assert.strictEqual(s.activeAuth(), undefined);
});

test("store · 旧版单账号登录态迁移为首个账号", async () => {
  const storage = memStorage();
  await storage.update("daoDevinAuth", fakeAuth("legacy@old.com"));
  const s = new AccountStore(storage);
  s.load();
  const v = s.views();
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].email, "legacy@old.com");
  assert.strictEqual(v[0].active, true);
  assert.strictEqual(s.getActive().status, "ok");
});

test("store · 持久化往返（load 复原 accounts + activeId）", async () => {
  const storage = memStorage();
  const s1 = new AccountStore(storage);
  s1.load();
  await s1.addFromText("a@b.com p\nb@c.com p");
  const activeId = s1.getActive().id;
  const s2 = new AccountStore(storage);
  s2.load();
  assert.strictEqual(s2.list().length, 2);
  assert.strictEqual(s2.getActive().id, activeId);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. worklog / markdown 构建
// ═══════════════════════════════════════════════════════════════════════════
const SAMPLE_EVENTS = [
  { type: "initial_user_message", message: "请实现一个功能", created_at_ms: 1 },
  { type: "devin_thoughts", message: "thinking", created_at_ms: 2, thinking_duration_ms: 3000 },
  { type: "shell_process_started", command: "npm test", created_at_ms: 3 },
  { type: "shell_process_completed", output: "all pass", exit_code: 0, created_at_ms: 4 },
  { type: "multi_edit_result", file_updates: [{ file_path: "src/x.ts", contents_key: "k1" }], created_at_ms: 5 },
  { type: "multi_edit_result", file_updates: [{ file_path: "src/x.ts", contents_key: "k2" }], created_at_ms: 6 },
  { type: "is_typing", created_at_ms: 6.5 },
  { type: "devin_message", message: "已完成", created_at_ms: 7 },
  { type: "user_question_answered", answers: [{ selected: ["选项A"] }], created_at_ms: 8 },
];

test("worklog · extractConversation 含首条消息与问答回答", () => {
  const turns = worklog.extractConversation(SAMPLE_EVENTS);
  assert.deepStrictEqual(turns.map((t) => t.role), ["user", "devin", "user"]);
  assert.strictEqual(turns[0].text, "请实现一个功能");
  assert.strictEqual(turns[2].text, "选项A");
});

test("worklog · extractChanges 同文件最后 contents_key 胜出", () => {
  const ch = worklog.extractChanges(SAMPLE_EVENTS);
  assert.deepStrictEqual(ch, [{ path: "src/x.ts", contentsKey: "k2" }]);
});

test("worklog · summarize 统计正确", () => {
  const s = worklog.summarize(SAMPLE_EVENTS);
  assert.strictEqual(s.userMessages, 1);
  assert.strictEqual(s.devinMessages, 1);
  assert.strictEqual(s.commands, 1);
  assert.strictEqual(s.edits, 1);
});

test("worklog · buildWorklog 跳过噪声事件 (is_typing)", () => {
  const md = worklog.buildWorklog("T", "devin-abc", SAMPLE_EVENTS);
  assert.ok(!md.includes("is_typing"));
  assert.ok(md.includes("npm test"));
  assert.ok(md.includes("USER"));
});

test("worklog · buildSessionMarkdown 单文件自洽（含对话与变更）", () => {
  const md = worklog.buildSessionMarkdown(
    { title: "标题", status: "finished" }, "标题", "devin-abc123", SAMPLE_EVENTS);
  assert.ok(md.includes("# 标题"));
  assert.ok(md.includes("对话记录"));
  assert.ok(md.includes("src/x.ts"));
  assert.ok(md.includes("app.devin.ai/sessions/abc123"));
});

test("worklog · safeName 清洗非法字符且非空兜底", () => {
  assert.strictEqual(worklog.safeName("a/b:c*?<>|.txt", 40), "a_b_c_____.txt");
  assert.strictEqual(worklog.safeName("", 40), "untitled");
  assert.strictEqual(worklog.safeName("x".repeat(100), 10).length, 10);
});

test("worklog · extractMessageText 兼容结构化消息", () => {
  assert.strictEqual(worklog.extractMessageText("plain"), "plain");
  assert.strictEqual(worklog.extractMessageText({ text: "t" }), "t");
  assert.strictEqual(worklog.extractMessageText([{ type: "text", text: "a" }, { text: "b" }]), "a\nb");
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ZipWriter · 产出可被标准 unzip 解开的合法 ZIP
// ═══════════════════════════════════════════════════════════════════════════
test("zip · 产出合法 ZIP，unzip -t 通过且内容/UTF-8 往返一致", () => {
  const z = new zipmod.ZipWriter();
  const big = "Hello 世界 world ".repeat(200); // 触发 deflate 分支
  z.addFile("dir/hello.txt", big);
  z.addFile("dir/data.json", JSON.stringify({ k: "v", 中: "文" }));
  z.addFile("empty.txt", ""); // 边界：空文件
  const buf = z.toBuffer();

  const tmp = path.join(os.tmpdir(), `daoztest-${process.pid}-${Date.now()}.zip`);
  fs.writeFileSync(tmp, buf);
  try {
    // 完整性校验（CRC + 结构）
    execFileSync("unzip", ["-t", tmp], { stdio: "pipe" });
    // 内容往返
    const got = execFileSync("unzip", ["-p", tmp, "dir/hello.txt"]).toString("utf-8");
    assert.strictEqual(got, big);
    const j = JSON.parse(execFileSync("unzip", ["-p", tmp, "dir/data.json"]).toString("utf-8"));
    assert.strictEqual(j["中"], "文");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. exporter · 单对话 MD（api 桩替换）
// ═══════════════════════════════════════════════════════════════════════════
test("exporter · exportSessionToMarkdown 用事件流构建", async () => {
  await withApiStubs({
    getSessionInfo: async () => ({ title: "标题", status: "finished" }),
    getEventStream: async () => SAMPLE_EVENTS,
    getFirstLoad: async () => { throw new Error("should not be called"); },
  }, async () => {
    const md = await exporter.exportSessionToMarkdown(fakeAuth("a@b.com"), "devin-abc123", "标题");
    assert.ok(md.includes("对话记录"));
    assert.ok(md.includes("请实现一个功能"));
  });
});

test("exporter · 事件流为空时回退 first-load", async () => {
  let firstLoadUsed = false;
  await withApiStubs({
    getSessionInfo: async () => ({ title: "T" }),
    getEventStream: async () => [],
    getFirstLoad: async () => { firstLoadUsed = true; return SAMPLE_EVENTS; },
  }, async () => {
    const md = await exporter.exportSessionToMarkdown(fakeAuth("a@b.com"), "devin-abc", "T");
    assert.ok(firstLoadUsed, "first-load fallback not used");
    assert.ok(md.includes("请实现一个功能"));
  });
});

test("exporter · 事件流抛错也回退 first-load（不冒泡）", async () => {
  await withApiStubs({
    getSessionInfo: async () => ({ title: "T" }),
    getEventStream: async () => { throw new Error("stream 500"); },
    getFirstLoad: async () => SAMPLE_EVENTS,
  }, async () => {
    const evts = await exporter.loadSessionEvents(fakeAuth("a@b.com"), "devin-abc");
    assert.strictEqual(evts.length, SAMPLE_EVENTS.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. AgentBridge · 本地 HTTP 接口（真起 127.0.0.1 服务，鉴权 + 端点）
// ═══════════════════════════════════════════════════════════════════════════
function reqJson(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({
      host: "127.0.0.1", port, method, path: p,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on("error", reject);
    if (data) { r.write(data); }
    r.end();
  });
}

test("bridge · ping 免鉴权，其它端点缺 token → 401", async () => {
  const store = new AccountStore(memStorage());
  store.load();
  const host = {
    store,
    getAuth: () => store.activeAuth(),
    getSessions: () => [],
    refreshSessions: async () => [],
    onChanged: () => {},
    version: "test",
  };
  const bridge = new AgentBridge(host);
  const { port, token } = await bridge.start(0);
  try {
    const ping = await reqJson(port, "GET", "/api/ping");
    assert.strictEqual(ping.status, 200);
    assert.strictEqual(ping.body.ok, true);

    const noAuth = await reqJson(port, "GET", "/api/accounts");
    assert.strictEqual(noAuth.status, 401);

    // 万法识号批量加号（经 bridge）
    const add = await reqJson(port, "POST", "/api/accounts", token, { text: "a@b.com p1\nc@d.com:p2" });
    assert.strictEqual(add.status, 200);
    assert.strictEqual(add.body.added, 2);

    const list = await reqJson(port, "GET", "/api/accounts", token);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.length, 2);
    for (const v of list.body) { assert.ok(!("password" in v)); }

    const status = await reqJson(port, "GET", "/api/status", token);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.version, "test");
    assert.ok(Array.isArray(status.body.endpoints));
  } finally {
    bridge.stop();
  }
});

test("bridge · selectLoginAccountId: 邮箱登录不被无关 token 账号劫持", () => {
  // 复现并锁死 bug：当 store 里已存在某个 token 账号时，email+password 登录
  // 曾因 `|| v.kind === 'token'` 而错选到那个 token 账号，导致 post-auth 401。
  const views = [
    { id: "t:old", kind: "token", email: "(token)" },
    { id: "p:a@x.com", kind: "password", email: "a@x.com" },
    { id: "p:b@x.com", kind: "password", email: "b@x.com" },
  ];
  // 邮箱登录 → 命中对应邮箱账号，绝不命中 token 账号
  assert.strictEqual(selectLoginAccountId(views, "a@x.com", undefined), "p:a@x.com");
  assert.strictEqual(selectLoginAccountId(views, "B@X.COM", undefined), "p:b@x.com");
  // token 登录 → 命中（最近的）token 账号
  assert.strictEqual(selectLoginAccountId(views, undefined, "sometoken"), "t:old");
  // 邮箱未找到时回退到最后新增的账号（即刚加进去的那个）
  assert.strictEqual(selectLoginAccountId(views, "missing@x.com", undefined), "p:b@x.com");
  assert.strictEqual(selectLoginAccountId([], "a@x.com", undefined), undefined);
});

test("bridge · 无活动账号时业务端点返回 401 引导加号", async () => {
  const store = new AccountStore(memStorage());
  store.load();
  const bridge = new AgentBridge({
    store, getAuth: () => store.activeAuth(), getSessions: () => [],
    refreshSessions: async () => [], onChanged: () => {}, version: "test",
  });
  const { port, token } = await bridge.start(0);
  try {
    const r = await reqJson(port, "GET", "/api/sessions", token);
    assert.strictEqual(r.status, 401);
    assert.match(JSON.stringify(r.body), /login|accounts/);
  } finally {
    bridge.stop();
  }
});
