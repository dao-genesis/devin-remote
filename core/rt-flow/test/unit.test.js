"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// rt-flow · 零依赖单测 (node test/unit.test.js) · 无网络 · 无 vscode
//
// 反者道之动: 把实测中揪出的高危逻辑(限流重试 / 五态分类 / 余额判定 / Git 已注册态分流)
// 固化为回归护栏, 防止后续改动悄然回退。纯 node assert, 不引第三方框架, 直接进 CI。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const http = require("http");
const cloud = require("../devin_cloud.js");
const git = require("../devin_git.js");
const proxy = require("../devin_proxy.js");

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { passed++; console.log("  ok   " + name); },
        (e) => { failed++; failures.push([name, e]); console.log("  FAIL " + name + " — " + (e && e.message)); },
      );
    }
    passed++; console.log("  ok   " + name);
  } catch (e) {
    failed++; failures.push([name, e]); console.log("  FAIL " + name + " — " + (e && e.message));
  }
}

(async () => {
  // ── 1. 限流/暂时性故障 可重试判定 (_isRetryableStatus) ────────────────────
  console.log("\n[_isRetryableStatus]");
  test("429 任意方法皆可重试 (POST 登录被拒·未处理·安全)", () => {
    assert.strictEqual(cloud._isRetryableStatus(429, "POST"), true);
    assert.strictEqual(cloud._isRetryableStatus(429, "GET"), true);
  });
  test("502/503/504 仅幂等方法 (GET/HEAD) 可重试", () => {
    assert.strictEqual(cloud._isRetryableStatus(503, "GET"), true);
    assert.strictEqual(cloud._isRetryableStatus(502, "HEAD"), true);
    assert.strictEqual(cloud._isRetryableStatus(504, "POST"), false); // 非幂等不重试·防重复变更
    assert.strictEqual(cloud._isRetryableStatus(503, "DELETE"), false);
  });
  test("2xx/4xx(非429) 不重试", () => {
    [200, 201, 400, 401, 403, 404, 422].forEach((s) => {
      assert.strictEqual(cloud._isRetryableStatus(s, "GET"), false, "status " + s);
    });
  });

  // ── 2. 退避时长 (_retryDelayMs) · Retry-After 优先 ───────────────────────
  console.log("\n[_retryDelayMs]");
  test("遵从 Retry-After 秒数", () => {
    assert.strictEqual(cloud._retryDelayMs({ "retry-after": "2" }, 0), 2000);
  });
  test("Retry-After 过大被 retryMaxDelayMs 封顶", () => {
    const cap = cloud.CFG.retryMaxDelayMs;
    assert.strictEqual(cloud._retryDelayMs({ "retry-after": "99999" }, 0), cap);
  });
  test("无 Retry-After → 指数退避(随 attempt 增大) + 抖动不超基数", () => {
    const base = cloud.CFG.retryBaseMs;
    const d0 = cloud._retryDelayMs({}, 0);
    const d2 = cloud._retryDelayMs({}, 2);
    assert.ok(d0 >= base && d0 < base * 2, "attempt0 in [base, 2base): " + d0);
    // attempt2 基数 = base*4, 抖动 < base ⇒ 必 >= 4*base > attempt0
    assert.ok(d2 >= base * 4, "attempt2 >= 4*base: " + d2);
  });

  // ── 3. rawRequest 真重试 429 → 200 (本地 http 服务·无外网) ────────────────
  console.log("\n[rawRequest live retry on 429]");
  await test("429×2 后 200: rawRequest 自动退避重试至成功", async () => {
    const prev = { base: cloud.CFG.retryBaseMs, rl: cloud.CFG.rateLimitMaxRetries };
    cloud.configure({ retryBaseMs: 5, rateLimitMaxRetries: 6 }); // 快测
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      if (hits <= 2) { res.statusCode = 429; res.setHeader("retry-after", "0"); res.end('{"detail":"Rate limit exceeded"}'); }
      else { res.statusCode = 200; res.end('{"ok":true}'); }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const resp = await cloud.rawRequest("GET", "http://127.0.0.1:" + port + "/", {}, null, 5000);
      assert.strictEqual(resp.status, 200, "final status 200");
      assert.strictEqual(hits, 3, "server hit 3 times (2×429 + 1×200), got " + hits);
    } finally {
      server.close();
      cloud.configure({ retryBaseMs: prev.base, rateLimitMaxRetries: prev.rl });
    }
  });

  // ── 4. classifySession 五态分类 ──────────────────────────────────────────
  console.log("\n[classifySession]");
  test("user_action_required 非空 → awaiting (最高优先·即便已挂起)", () => {
    assert.strictEqual(cloud.classifySession({ status: "suspended", latest_status_contents: { enum: "finished", user_action_required: { q: "?" } } }), "awaiting");
  });
  test("enum=finished / status=suspended → finished", () => {
    assert.strictEqual(cloud.classifySession({ latest_status_contents: { enum: "finished" } }), "finished");
    assert.strictEqual(cloud.classifySession({ status: "suspended" }), "finished");
  });
  test("非终态 + 额度耗尽 reason → blocked", () => {
    assert.strictEqual(cloud.classifySession({ status: "running", latest_status_contents: { reason: "out_of_quota" } }), "blocked");
    assert.strictEqual(cloud.classifySession({ activity_status: "usage_limit_exceeded" }), "blocked");
  });
  test("非终态 + 运行关键词 → running", () => {
    assert.strictEqual(cloud.classifySession({ activity_status: "coding" }), "running");
    assert.strictEqual(cloud.classifySession({ status: "running" }), "running");
  });
  test("空会话 → idle", () => {
    assert.strictEqual(cloud.classifySession({}), "idle");
  });
  test("标题含 error 不污染分类 (blob 只取状态字段·非 title)", () => {
    // 运行中、标题里有 'error' 字样的正常会话不应被误判 blocked
    assert.strictEqual(cloud.classifySession({ title: "fix error handling", activity_status: "coding" }), "running");
  });

  // ── 5. billingBalance ────────────────────────────────────────────────────
  console.log("\n[billingBalance]");
  test("has_subscription_or_credits=true → 充足 (>0 返真余额, =0 返 9999)", () => {
    assert.strictEqual(cloud.billingBalance({ has_subscription_or_credits: true, available_credits: 0, overage_credits: 0 }), 9999);
    assert.strictEqual(cloud.billingBalance({ is_subscription_valid: true, available_credits: 12.5 }), 12.5);
  });
  test("无订阅无额度 → 返真实余额(可触发清理)", () => {
    assert.strictEqual(cloud.billingBalance({ has_subscription_or_credits: false, available_credits: 0, overage_credits: 0 }), 0);
  });
  test("字段缺失 → null (安全·绝不当 0 误删)", () => {
    assert.strictEqual(cloud.billingBalance({}), null);
    assert.strictEqual(cloud.billingBalance(null), null);
  });
  test("overage 负值不减 avail (max(0,overage))", () => {
    assert.strictEqual(cloud.billingBalance({ available_credits: 10, overage_credits: -5 }), 10);
  });

  // ── 6. Git 已注册态分流 (classifyRegisteredState) ─────────────────────────
  console.log("\n[classifyRegisteredState]");
  test("已连本 PAT 主 + 有仓库 → existing (幂等·不动)", () => {
    assert.strictEqual(git.classifyRegisteredState({ ownerLogin: "zhouyoukang1234-spec", connections: [{ name: "zhouyoukang1234-spec", type: "github_individual_token" }], hasRepos: true }), "existing");
  });
  test("已注册但 0 连接 → ghost (平台孤儿·API 不可清)", () => {
    assert.strictEqual(git.classifyRegisteredState({ ownerLogin: "x", connections: [], hasRepos: false }), "ghost");
  });
  test("individual_token 连别身份 → reinject (可断净重注入)", () => {
    assert.strictEqual(git.classifyRegisteredState({ ownerLogin: "zhouyoukang1234-spec", connections: [{ name: "someone-else", type: "github_individual_token" }], hasRepos: true }), "reinject");
  });
  test("individual_token 连本主但 0 仓库(陈旧) → reinject", () => {
    assert.strictEqual(git.classifyRegisteredState({ ownerLogin: "zhouyoukang1234-spec", connections: [{ name: "zhouyoukang1234-spec", type: "github_individual_token" }], hasRepos: false }), "reinject");
  });
  test("github_app(OAuth) 连接 → app (绝不主动断)", () => {
    assert.strictEqual(git.classifyRegisteredState({ ownerLogin: "zhouyoukang1234-spec", connections: [{ name: "hdougle", type: "github_app" }], hasRepos: false }), "app");
  });
  test("混合含 app 连接 → app (保守·不断 app)", () => {
    assert.strictEqual(git.classifyRegisteredState({ ownerLogin: "z", connections: [{ name: "a", type: "github_individual_token" }, { name: "b", type: "github_app" }], hasRepos: false }), "app");
  });

  // ── 7. 对话上限 + 耗尽自动重置 (computeConvCap · v4.7.3) ────────────────────
  console.log("\n[computeConvCap]");
  test("常态: cap = 余额 - 缓冲 (余额$70 缓冲$3 → $67)", () => {
    const r = cloud.computeConvCap(70, 3, true, 0.1);
    assert.strictEqual(r.cap, 67); assert.strictEqual(r.drain, false);
  });
  test("随余额下降实时下调 (余额$55 缓冲$3 → $52)", () => {
    assert.strictEqual(cloud.computeConvCap(55, 3, true, 0.1).cap, 52);
  });
  test("反向重置: 余额抵缓冲(余额$3 缓冲$3 → cap本应0)→ 抽干抬回$3 让美金用尽", () => {
    const r = cloud.computeConvCap(3, 3, true, 0.1);
    assert.strictEqual(r.cap, 3); assert.strictEqual(r.drain, true);
  });
  test("反向重置: 余额低于缓冲(余额$2 缓冲$3)→ 抽干抬回$2", () => {
    const r = cloud.computeConvCap(2, 3, true, 0.1);
    assert.strictEqual(r.cap, 2); assert.strictEqual(r.drain, true);
  });
  test("见底(余额≤地板$0.1)→ cap=0 不抽干 (交由调用方中停)", () => {
    const r = cloud.computeConvCap(0.05, 3, true, 0.1);
    assert.strictEqual(r.cap, 0); assert.strictEqual(r.drain, false);
  });
  test("抽干关闭: 余额抵缓冲 → cap=0 (沿用旧中停语义·不抬回)", () => {
    const r = cloud.computeConvCap(3, 3, false, 0.1);
    assert.strictEqual(r.cap, 0); assert.strictEqual(r.drain, false);
  });
  test("非法余额(null/NaN)→ 安全回 {cap:0,drain:false}", () => {
    assert.deepStrictEqual(cloud.computeConvCap(null, 3, true, 0.1), { cap: 0, drain: false });
    assert.deepStrictEqual(cloud.computeConvCap(NaN, 3, true, 0.1), { cap: 0, drain: false });
  });

  // ── 8. 低余额预警 (lowBalanceVerdict · v4.7.5) ───────────────────────────
  console.log("\n[lowBalanceVerdict]");
  test("余额≤阈值且上轮未警 → 本轮发警·置已警", () => {
    assert.deepStrictEqual(cloud.lowBalanceVerdict(2.5, 3, false), { alert: true, alerted: true });
    assert.deepStrictEqual(cloud.lowBalanceVerdict(3, 3, false), { alert: true, alerted: true }); // 边界 = 阈值
  });
  test("余额≤阈值但上轮已警 → 不重复刷屏 (仍保持已警)", () => {
    assert.deepStrictEqual(cloud.lowBalanceVerdict(1, 3, true), { alert: false, alerted: true });
  });
  test("余额回升至阈值之上 → 复位已警 (下次跌破再警)", () => {
    assert.deepStrictEqual(cloud.lowBalanceVerdict(5, 3, true), { alert: false, alerted: false });
  });
  test("余额无法判定(null/NaN) → 不发警·保持上轮态", () => {
    assert.deepStrictEqual(cloud.lowBalanceVerdict(null, 3, true), { alert: false, alerted: true });
    assert.deepStrictEqual(cloud.lowBalanceVerdict(NaN, 3, false), { alert: false, alerted: false });
  });

  // ── 9. 卡死监测 (sessionSignature / stallVerdict · v4.7.5) ─────────────────
  console.log("\n[sessionSignature / stallVerdict]");
  test("签名取状态字段(非标题): 状态相同→指纹相同 (标题变不算进展)", () => {
    const a = cloud.sessionSignature({ statusClass: "running", status: "coding", reason: "", title: "X" });
    const b = cloud.sessionSignature({ statusClass: "running", status: "coding", reason: "", title: "Y 改名了" });
    assert.strictEqual(a, b);
  });
  test("状态推进 → 指纹不同 (有进展)", () => {
    const a = cloud.sessionSignature({ statusClass: "running", status: "coding" });
    const b = cloud.sessionSignature({ statusClass: "running", status: "testing" });
    assert.notStrictEqual(a, b);
  });
  test("无进展时长 ≥ 阈值 → 判卡死", () => {
    assert.strictEqual(cloud.stallVerdict(16 * 60000, 15 * 60000), true);
    assert.strictEqual(cloud.stallVerdict(15 * 60000, 15 * 60000), true); // 边界
  });
  test("无进展时长 < 阈值 → 不判卡死", () => {
    assert.strictEqual(cloud.stallVerdict(5 * 60000, 15 * 60000), false);
  });
  test("阈值≤0(关闭) 或 非法入参 → 永不判卡 (安全)", () => {
    assert.strictEqual(cloud.stallVerdict(99 * 60000, 0), false);
    assert.strictEqual(cloud.stallVerdict(NaN, 15 * 60000), false);
  });

  // ── 10. 对话最终报告 (conversationFinalReport · v4.7.7) ──────────────────────
  console.log("\n[conversationFinalReport]");
  test("finished 对话 → outcome=success + 时长计算正确", () => {
    const now = 1718400000000; // 固定时刻
    const created = new Date(now - 30 * 60000).toISOString(); // 30 分钟前
    const r = cloud.conversationFinalReport(
      { devinId: "dv-123", statusClass: "finished", title: "Fix bug", created_at: created },
      { now }
    );
    assert.strictEqual(r.outcome, "success");
    assert.strictEqual(r.durationMin, 30);
    assert.strictEqual(r.devinId, "dv-123");
    assert.strictEqual(r.title, "Fix bug");
    assert.strictEqual(r.stalled, false);
  });
  test("suspended 对话 → outcome=archived", () => {
    const r = cloud.conversationFinalReport({ statusClass: "suspended" }, {});
    assert.strictEqual(r.outcome, "archived");
  });
  test("blocked + usage reason → outcome=cap_exceeded", () => {
    const r = cloud.conversationFinalReport({ statusClass: "blocked", reason: "Usage limit reached" }, {});
    assert.strictEqual(r.outcome, "cap_exceeded");
  });
  test("blocked + 其他 reason → outcome=blocked", () => {
    const r = cloud.conversationFinalReport({ statusClass: "blocked", reason: "needs input" }, {});
    assert.strictEqual(r.outcome, "blocked");
  });
  test("running + opts.stalled=true → outcome=stalled", () => {
    const r = cloud.conversationFinalReport({ statusClass: "running" }, { stalled: true });
    assert.strictEqual(r.outcome, "stalled");
  });
  test("空输入 → outcome=unknown, 各字段 null (安全·不臆造)", () => {
    const r = cloud.conversationFinalReport(null, {});
    assert.strictEqual(r.outcome, "unknown");
    assert.strictEqual(r.devinId, null);
    assert.strictEqual(r.durationMs, null);
    assert.strictEqual(r.cost, null);
  });
  test("cost 优先级: opts.cost > session.total_cost > session.usage_credits", () => {
    assert.strictEqual(cloud.conversationFinalReport({ total_cost: 5 }, { cost: 3 }).cost, 3);
    assert.strictEqual(cloud.conversationFinalReport({ total_cost: 5, usage_credits: 8 }, {}).cost, 5);
    assert.strictEqual(cloud.conversationFinalReport({ usage_credits: 8 }, {}).cost, 8);
  });

  // ── 11. 综合健康度 (healthScore · v4.7.7) ────────────────────────────────────
  console.log("\n[healthScore]");
  test("全正常(充裕余额·无卡死·无阻塞) → score=100, tier=green", () => {
    const r = cloud.healthScore({ balance: 50, balanceThreshold: 3, stalledCount: 0, blockedCount: 0 });
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.tier, "green");
  });
  test("余额见底(余额=0) → 扣满余额权重 40", () => {
    const r = cloud.healthScore({ balance: 0, balanceThreshold: 3, stalledCount: 0, blockedCount: 0 });
    assert.strictEqual(r.score, 60);
    assert.strictEqual(r.tier, "amber");
  });
  test("一个卡死 → 扣 15, tier=green (score=85)", () => {
    const r = cloud.healthScore({ balance: 50, balanceThreshold: 3, stalledCount: 1, blockedCount: 0 });
    assert.strictEqual(r.score, 85);
    assert.strictEqual(r.tier, "green");
  });
  test("两个卡死 → 扣 30(封顶), tier=amber (score=70)", () => {
    const r = cloud.healthScore({ balance: 50, balanceThreshold: 3, stalledCount: 2, blockedCount: 0 });
    assert.strictEqual(r.score, 70);
    assert.strictEqual(r.tier, "amber");
  });
  test("阻塞+卡死+低余额 → 三维度叠加, tier=red", () => {
    const r = cloud.healthScore({ balance: 1, balanceThreshold: 3, stalledCount: 2, blockedCount: 2 });
    assert.ok(r.score < 50, "score should be < 50: " + r.score);
    assert.strictEqual(r.tier, "red");
  });
  test("空输入 → score=100 (无异常 = 安全)", () => {
    const r = cloud.healthScore({});
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.tier, "green");
  });

  // ── 11. devin_proxy · IDE 内置浏览器自足注入反代 (v4.8.2) ──────────────────
  console.log("\n[devin_proxy.buildAuthBridge]");
  const _bridge = proxy.buildAuthBridge("http://localhost:54321", {
    auth1: "auth1_abc123", userId: "user-xyz", orgId: "org-777", orgName: "Acme",
  });
  test("注入 auth1_session 真源登录态 (token+userId)", () => {
    assert.ok(_bridge.includes("setItem('auth1_session'"), "含 auth1_session 写入");
    assert.ok(_bridge.includes("auth1_abc123"), "含 token");
    assert.ok(_bridge.includes("user-xyz"), "含 userId");
  });
  test("注入 org 键 + post-auth 守卫键", () => {
    assert.ok(_bridge.includes("known-org-ids-"), "含 known-org-ids");
    assert.ok(_bridge.includes("last-internal-org-for-external-org-v1-null"), "含 last-internal-org");
    assert.ok(_bridge.includes("post-auth-v3-null-"), "含 post-auth 守卫键");
    assert.ok(_bridge.includes("org-777"), "含 orgId");
  });
  test("拦截 fetch/XHR 挂 Authorization Bearer", () => {
    assert.ok(_bridge.includes("window.fetch=function"), "覆写 fetch");
    assert.ok(_bridge.includes("XMLHttpRequest.prototype.open"), "覆写 XHR.open");
    assert.ok(_bridge.includes("'Bearer '+__a1"), "挂 Bearer 头");
  });
  test("注入值经 JSON 转义·防破坏脚本闭合", () => {
    const b = proxy.buildAuthBridge("http://localhost:1", {
      auth1: "a", userId: "u", orgId: "o", orgName: "x'</script><b>",
    });
    assert.ok(!b.includes("</script><b>"), "恶意 orgName 不得原样落入脚本体");
  });
  console.log("\n[devin_proxy.ensureProxyForAccount]");
  await test("无 auth1 → ok:false (不起反代)", async () => {
    const r = await proxy.ensureProxyForAccount("x@x.com", { auth1: "" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "no-auth1");
  });
  await test("持 auth1 → 起本地反代返回端口·同号复用·stop 收束", async () => {
    const a = { auth1: "auth1_t", userId: "user-1", orgId: "org-1", orgName: "O" };
    const r1 = await proxy.ensureProxyForAccount("dup@x.com", a);
    assert.strictEqual(r1.ok, true);
    assert.ok(r1.port > 0, "分得本地端口");
    const r2 = await proxy.ensureProxyForAccount("dup@x.com", a);
    assert.strictEqual(r2.port, r1.port, "同账号复用同端口 (origin 稳定)");
    proxy.stopProxy("dup@x.com");
    const r3 = await proxy.ensureProxyForAccount("dup@x.com", a);
    assert.ok(r3.ok, "收束后可重启");
    proxy.stopAll();
  });

  // ── 11b. devin_proxy · 磁盘二级缓存 L2 (v4.14.0 · 重载秒恢复 · 跨端口重定基) ──
  console.log("\n[devin_proxy._diskCache · L2]");
  {
    const _fs = require("fs"), _os = require("os"), _path = require("path");
    const dc = proxy._diskCache;
    test("_diskKey 同路同键·异路异键 (sha1 稳定)", () => {
      assert.strictEqual(dc._diskKey("/a.js"), dc._diskKey("/a.js"));
      assert.notStrictEqual(dc._diskKey("/a.js"), dc._diskKey("/b.js"));
    });
    test("_isTextCt: js/css 为文本·字体/图片非文本", () => {
      assert.strictEqual(dc._isTextCt({ "Content-Type": "application/javascript" }), true);
      assert.strictEqual(dc._isTextCt({ "Content-Type": "text/css; charset=utf-8" }), true);
      assert.strictEqual(dc._isTextCt({ "Content-Type": "font/woff2" }), false);
      assert.strictEqual(dc._isTextCt({ "Content-Type": "image/png" }), false);
    });
    test("_rebaseAsset: 文本体端口变则重定基·二进制/同端口不动", () => {
      const from = "http://localhost:1111", to = "http://localhost:2222";
      const js = Buffer.from("fetch('" + from + "/api/x')", "utf8");
      assert.strictEqual(dc._rebaseAsset(js, from, to, true).toString("utf8"), "fetch('" + to + "/api/x')");
      assert.strictEqual(dc._rebaseAsset(js, from, from, true).toString("utf8"), js.toString("utf8"));
      const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      assert.deepStrictEqual(dc._rebaseAsset(bin, from, to, false), bin);
    });
    await test("_diskPut → _diskGet 往返: status/headers/body/base/text 完整", async () => {
      const tmp = _fs.mkdtempSync(_path.join(_os.tmpdir(), "wamcache-"));
      process.env.WAM_PROXY_CACHE_DIR = tmp;
      assert.strictEqual(dc._diskCacheDir(), tmp);
      const headers = { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=31536000, immutable" };
      const body = Buffer.from("console.log('http://localhost:1234/x')", "utf8");
      dc._diskPut("/assets/app.hash.js", { status: 200, headers, body }, "http://localhost:1234");
      let got = null;
      for (let i = 0; i < 50 && !got; i++) { got = await dc._diskGet("/assets/app.hash.js"); if (!got) await new Promise((r) => setTimeout(r, 20)); }
      assert.ok(got, "磁盘命中");
      assert.strictEqual(got.status, 200);
      assert.strictEqual(got.text, true, "js 标记为文本");
      assert.strictEqual(got.base, "http://localhost:1234");
      assert.strictEqual(got.headers["Content-Type"], "application/javascript");
      assert.strictEqual(got.body.toString("utf8"), body.toString("utf8"));
      const bin = Buffer.from([0, 1, 2, 253, 254, 255]);
      dc._diskPut("/f/font.woff2", { status: 200, headers: { "Content-Type": "font/woff2" }, body: bin }, "http://localhost:1234");
      let g2 = null;
      for (let i = 0; i < 50 && !g2; i++) { g2 = await dc._diskGet("/f/font.woff2"); if (!g2) await new Promise((r) => setTimeout(r, 20)); }
      assert.ok(g2, "二进制磁盘命中");
      assert.strictEqual(g2.text, false);
      assert.deepStrictEqual(g2.body, bin, "二进制字节零损坏");
      delete process.env.WAM_PROXY_CACHE_DIR;
      try { _fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    });
    await test("_diskGet 未落盘的键 → null", async () => {
      const tmp = _fs.mkdtempSync(_path.join(_os.tmpdir(), "wamcache2-"));
      process.env.WAM_PROXY_CACHE_DIR = tmp;
      const got = await dc._diskGet("/never/written.js");
      assert.strictEqual(got, null);
      delete process.env.WAM_PROXY_CACHE_DIR;
      try { _fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    });
  }

  // ── 11. 备份命名/结构 + listBackups (v4.8.3 编号·账号+密码表层·对话/账号信息分明) ──
  console.log("\n[备份命名/结构 · v4.8.3]");
  const fs = require("fs"), os = require("os"), path = require("path");
  test("accountFolderName = 编号_邮箱本地名_密码 (账号+密码写在表层)", () => {
    assert.strictEqual(cloud.accountFolderName({ email: "foo@bar.com" }, { accountNo: 7, password: "Pa ss/w" }), "07_foo_Pass_w");
    assert.strictEqual(cloud.accountFolderName({ email: "x@y.z" }, {}), "x"); // 无编号无密码
  });
  test("cleanTitle 去掉开头的下划线/井号/标点 (不再像系统目录)", () => {
    assert.strictEqual(cloud.cleanTitle("___# Summary"), "Summary");
    assert.strictEqual(cloud.cleanTitle("  ·, 标题"), "标题");
    assert.strictEqual(cloud.cleanTitle(""), "未命名");
  });
  test("convFolderName = NNN_标题_ID末8位 (带编号·三位补零)", () => {
    assert.strictEqual(cloud.convFolderName(3, "_hello_", "devin-abcd1234 effff"), "003_hello__abcd1234");
    assert.ok(cloud.convFolderName(0, "t", "devin-zzzzzzzz").startsWith("t_"));
  });
  test("listBackups 新结构: 读 对话/ + 账号信息 + .account.json 编号·按 convNo 排序", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtbk-"));
    const acc = path.join(root, "02_foo_pwd");
    const convDir = path.join(acc, "对话");
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(acc, ".account.json"), JSON.stringify({ email: "foo@bar.com", accountNo: 2 }));
    fs.mkdirSync(path.join(acc, "账号信息"), { recursive: true });
    // 两条对话, 故意乱序写盘, 期望按 convNo 升序
    const c2 = path.join(convDir, "002_b_id2"); fs.mkdirSync(c2);
    fs.writeFileSync(path.join(c2, "_meta.json"), JSON.stringify({ title: "B", eventCount: 5, convNo: 2 }));
    fs.writeFileSync(path.join(c2, "对话.html"), "<html></html>");
    const c1 = path.join(convDir, "001_a_id1"); fs.mkdirSync(c1);
    fs.writeFileSync(path.join(c1, "_meta.json"), JSON.stringify({ title: "A", eventCount: 3, convNo: 1 }));
    const tree = cloud.listBackups(root);
    assert.strictEqual(tree.accounts.length, 1);
    const a = tree.accounts[0];
    assert.strictEqual(a.email, "foo@bar.com");
    assert.strictEqual(a.accountNo, 2);
    assert.strictEqual(a.hasAccountInfo, true);
    assert.strictEqual(a.count, 2);
    assert.strictEqual(a.conversations[0].num, 1, "按 convNo 升序");
    assert.strictEqual(a.conversations[0].title, "A");
    assert.strictEqual(a.conversations[1].hasHtml, true, "B 有 对话.html");
    fs.rmSync(root, { recursive: true, force: true });
  });
  test("listBackups 兼容旧结构: 对话文件夹直接在账号目录下 (无 对话/ 子目录)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtbk-"));
    const acc = path.join(root, "old@x.com");
    const c = path.join(acc, "旧标题_deadbeef"); fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(c, "_meta.json"), JSON.stringify({ title: "旧标题", eventCount: 9 }));
    const tree = cloud.listBackups(root);
    assert.strictEqual(tree.accounts.length, 1);
    assert.strictEqual(tree.accounts[0].count, 1);
    assert.strictEqual(tree.accounts[0].conversations[0].title, "旧标题");
    fs.rmSync(root, { recursive: true, force: true });
  });
  test("findAccountDir 经 .account.json 标记定位 (改号不丢已有目录)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtbk-"));
    const acc = path.join(root, "05_who_pw"); fs.mkdirSync(acc, { recursive: true });
    fs.writeFileSync(path.join(acc, ".account.json"), JSON.stringify({ email: "who@a.com", accountNo: 5 }));
    assert.strictEqual(cloud.findAccountDir(root, "who@a.com"), acc);
    assert.strictEqual(cloud.findAccountDir(root, "nobody@a.com"), null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── 对话详情视图 · 思考折叠/可搜索 + 用户消息定位索引 (v4.8.6) ──────────────
  console.log("\n[buildConversationHtml · 详情视图]");
  const _convEvents = [
    { type: "initial_user_message", message: "User: 第一条问题ALPHA" },
    { type: "devin_thoughts", message: "我在思考SECRET方案" },
    { type: "devin_message", message: "这是回复BETA" },
    { type: "user_message", message: "User: 第二条追问GAMMA" },
    { type: "devin_message", message: "再次回复DELTA" },
  ];
  test("思考块默认折叠: CSS 隐藏 .msg-think .body, 点展开/搜索才显", () => {
    const html = cloud.buildConversationHtml("T", "devin-abc", _convEvents, {});
    assert.ok(html.includes(".msg-think .body{display:none}"), "思考默认折叠 CSS");
    assert.ok(html.includes("展开思考"), "有展开思考触发");
    assert.ok(html.includes("body.think-open .msg-think .body{display:block}"), "全局展开开关");
  });
  test("思考内容仍留 DOM (可被搜索命中)", () => {
    const html = cloud.buildConversationHtml("T", "devin-abc", _convEvents, {});
    assert.ok(html.includes("SECRET"), "思考正文在 HTML 中(折叠不删除→可搜索)");
    assert.ok(html.includes("__doSearch") || html.includes("__search"), "内置搜索脚本");
  });
  test("左上角用户消息定位索引: 每条用户消息一行+锚点", () => {
    const html = cloud.buildConversationHtml("T", "devin-abc", _convEvents, {});
    assert.ok(html.includes('id="u1"') && html.includes('id="u2"'), "用户消息锚点 u1/u2");
    assert.ok(html.includes("__jump(1)") && html.includes("__jump(2)"), "索引行可点击跳转");
    assert.ok(html.includes("ni-list"), "索引列表容器");
    assert.ok(!html.includes("__jump(3)"), "仅 2 条用户消息(不含 devin/think)");
  });
  test("摘要取自用户消息前若干字 (去 'User:' 前缀)", () => {
    const html = cloud.buildConversationHtml("T", "devin-abc", _convEvents, {});
    assert.ok(html.includes("第一条问题ALPHA"), "首条用户消息摘要");
    assert.ok(html.includes("第二条追问GAMMA"), "次条用户消息摘要");
  });

  // ── 前台「极速」下载档 (v4.8.6) ───────────────────────────────────────────
  console.log("\n[turbo 前台极速下载档]");
  test("CFG 含 turbo 档且并发高于 lean 档", () => {
    assert.ok(cloud.CFG.turboDownloadConcurrency > cloud.CFG.downloadConcurrency, "turbo 下载并发 > lean");
    assert.ok(cloud.CFG.turboConvConcurrency > cloud.CFG.convConcurrency, "turbo 对话并发 > lean");
    assert.ok(cloud.CFG.turboMaxSocketsPerHost >= cloud.CFG.turboDownloadConcurrency, "turbo socket 上限覆盖并发");
  });
  test("configure 可调 turbo 档 (软配置)", () => {
    const before = cloud.CFG.turboDownloadConcurrency;
    cloud.configure({ turboDownloadConcurrency: 30 });
    assert.strictEqual(cloud.CFG.turboDownloadConcurrency, 30);
    cloud.configure({ turboDownloadConcurrency: before });
  });

  // ── app 侧 httpsReq 有界 Agent (釜底抽薪根治 conntrack 风暴 v4.8.7) ──
  console.log("\n[httpsReq 有界 Agent · 防 socket 风暴]");
  test("extension.js httpsReq 绑有界 keep-alive Agent (非 globalAgent)", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "extension.js"), "utf8");
    assert.ok(/new https\.Agent\(/.test(src), "extension.js 必建有界 https.Agent");
    assert.ok(/maxSockets:\s*HTTP_MAX_SOCKETS_PER_HOST/.test(src), "Agent 必设单 host socket 上限");
    assert.ok(/keepAlive:\s*true/.test(src), "Agent 必 keepAlive 复用");
    assert.ok(/agent:\s*_httpsAgent/.test(src), "httpsReq 必把请求挂到有界 Agent");
  });

  // ── v4.9.0 · 归零移除 + 备份严格校验 (源级护栏 · 防破坏性误删回归) ──
  console.log("\n[v4.9.0 自动清理/归零移除护栏]");
  test("billingBalance: 无订阅且额度0 → 0 (允许归零判定); 有订阅 → 9999 (永不归零); 未知 → null", () => {
    assert.strictEqual(cloud.billingBalance({ has_subscription_or_credits: false, available_credits: 0, overage_credits: 0 }), 0);
    assert.strictEqual(cloud.billingBalance({ has_subscription_or_credits: true, available_credits: 0 }), 9999);
    assert.strictEqual(cloud.billingBalance({ unknown: 1 }), null);
    assert.ok(cloud.billingBalance({ has_subscription_or_credits: false, available_credits: 0, overage_credits: 5 }) > 0);
  });
  test("extension.js: 自动清理须先通过全量备份完整性校验 (未备份不删)", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "extension.js"), "utf8");
    assert.ok(/function _dvBackupVerifiedFull\(/.test(src), "须有 _dvBackupVerifiedFull 严格校验");
    assert.ok(/backupOk = _dvBackupVerifiedFull\(backupRes\)/.test(src), "清理前 backupOk 须由校验函数赋值");
    assert.ok(/if \(autoCleanup && backupOk && totalCredits <= cleanupThreshold\)/.test(src), "清理须同时满足 autoCleanup+backupOk+阈值");
    assert.ok(/if \(res\.convError\) return false;/.test(src) && /\(c\.failed \|\| 0\) > 0\) return false/.test(src) && /if \(!s \|\| s\.partial\) return false;/.test(src), "校验须覆盖对话异常/失败/快照部分");
  });
  test("extension.js: 归零移除仅在权威归零+清理无残留时触发, 且循环外统一 removeBatch", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "extension.js"), "utf8");
    assert.ok(/if \(autoRemoveZero && wipeClean && totalCredits <= removeThreshold\)/.test(src), "移除须 autoRemoveZero+wipeClean+归零阈值三重闸");
    assert.ok(/const wipeClean = .*rep\.sessions\.failed === 0 && rep\.knowledge\.failed === 0 && rep\.playbooks\.failed === 0 && rep\.secrets\.failed === 0/.test(src), "wipeClean 须确认四类痕迹全清无失败");
    assert.ok(/_store\.removeBatch\(idx\)/.test(src), "出库须走 removeBatch (单次IO+持久化)");
    assert.ok(/removeEmails\.push\(acc\.email\)/.test(src), "归零账号先入 removeEmails, 循环外再删");
  });
  test("package.json: 自动清理默认开; 归零移除默认关(v4.9.6 手动)", () => {
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(require("path").join(__dirname, "..", "package.json"), "utf8"));
    const props = pkg.contributes.configuration.properties;
    assert.strictEqual(props["wam.devinCloudAutoCleanup"].default, true, "自动清理默认开");
    // v4.9.6 · 用户要求: 归零移除改为手动(默认关) — 自动清理只清痕迹+本地留底, 出库由用户手动决定
    assert.strictEqual(props["wam.devinCloudAutoRemoveZeroQuota"].default, false, "归零移除默认关(手动)");
    assert.strictEqual(props["wam.devinCloudAutoRemoveThreshold"].default, 0, "归零阈值默认0(完全归零)");
  });

  // ── 账号 1:1 同步 (dao-vsix 全能板以 RT Flow 活跃号为唯一权威源 · 源级护栏) ──
  console.log("\n[账号 1:1 同步护栏]");
  test("dao-vsix: 全能板以 RT Flow 活跃号(wam-state.activeEmail)为权威键, 而非 IDE vscdb", () => {
    const fs = require("fs");
    const p = require("path").join(__dirname, "..", "..", "dao-vsix", "src", "extension.js");
    const alt = require("path").join(__dirname, "..", "..", "dao-vsix", "src", "extension.ts");
    const src = fs.readFileSync(fs.existsSync(p) ? p : alt, "utf8");
    assert.ok(/function getRtFlowActiveEmail\(/.test(src), "须有 getRtFlowActiveEmail 读 wam-state.activeEmail");
    assert.ok(/wam-state\.json/.test(src) && /activeEmail/.test(src), "权威源须为 wam-state.activeEmail");
    assert.ok(/const rtEmail = getRtFlowActiveEmail\(\);[\s\S]{0,160}currentIdeEmail = rtEmail/.test(src), "devinAutoChain 须以 RT Flow 活跃号覆盖 IDE 邮箱(auto)");
    assert.ok(/onRtFlowAccountSwitch\(payload/.test(src), "切号广播须把 payload 透传给 onRtFlowAccountSwitch");
    assert.ok(/pEmail && pAuth1 && payload && payload\.orgId/.test(src), "切号须直采广播携带的真 auth1 (免 vscdb 竞态)");
  });
  test("dao-vsix: 1:1 同步守 manual 模式(用户单号粘贴不被 RT Flow 覆盖)", () => {
    const fs = require("fs");
    const p = require("path").join(__dirname, "..", "..", "dao-vsix", "src", "extension.js");
    const alt = require("path").join(__dirname, "..", "..", "dao-vsix", "src", "extension.ts");
    const src = fs.readFileSync(fs.existsSync(p) ? p : alt, "utf8");
    assert.ok(/getAccountSyncMode\(\) !== 'manual'[\s\S]{0,200}getRtFlowActiveEmail/.test(src), "auto 模式才以 RT Flow 活跃号覆盖; manual 保留用户自控");
  });

  // ── F1-F4 切号面板回归 (双副本 rt-flow + dao-vsix 同步) ──
  console.log("\n[F1-F4 切号面板回归]");
  test("F1: 取消追踪叉号 + dvUntrackConv 永久持久 + 过滤", () => {
    const fs = require("fs"), path = require("path");
    for (const rel of [["..", "extension.js"], ["..", "..", "dao-vsix", "rtflow", "extension.js"]]) {
      const src = fs.readFileSync(path.join(__dirname, ...rel), "utf8");
      assert.ok(/class="dv-trk-x"/.test(src), rel.join("/") + ": 须 dv-trk-x 叉号");
      assert.ok(/case "dvUntrackConv"/.test(src), rel.join("/") + ": 须 dvUntrackConv host 处理");
      assert.ok(/_untrackedConvUuids\.add/.test(src) && /_saveUntrackedToDisk\(\)/.test(src), rel.join("/") + ": 须入永久集+持久化");
      assert.ok(/_untrackedConvUuids\.has\(s\.devinId\)/.test(src), rel.join("/") + ": 活跃集须过滤永久取消的对话");
    }
  });
  test("F2/F3: 去抖签名 _lastRunKey + 易变装饰剔除签名 _convSig + 滚动保持", () => {
    const fs = require("fs"), path = require("path");
    for (const rel of [["..", "extension.js"], ["..", "..", "dao-vsix", "rtflow", "extension.js"]]) {
      const src = fs.readFileSync(path.join(__dirname, ...rel), "utf8");
      assert.ok(/_lastRunKey/.test(src) && /_lastConvSig/.test(src), rel.join("/") + ": 须去抖签名变量(状态+对话签名)");
      assert.ok(/if\(_rk===_lastRunKey\)return/.test(src), rel.join("/") + ": 状态未变须早返不动 DOM");
      // v4.9.9 真根因: html 串里"· 分隔符+陈旧图标"随 staleSec 0↔>0 出现/消失, 屏蔽数值仍每秒不同 →
      //   签名只取结构性数据(uuid集+硬状态+计数+灯色), 排除一切 staleSec/sizeKB/age/陈旧切换
      assert.ok(/let _convStructSig =/.test(src), rel.join("/") + ": 须结构签名模块变量");
      assert.ok(/_convStructSig = JSON\.stringify\(\{/.test(src), rel.join("/") + ": 须从结构性数据算签名");
      assert.ok(/sig: _convStructSig \|\| _convSig\(html\)/.test(src), rel.join("/") + ": convUpdate 须优先携带结构签名");
      assert.ok(/if\(_sig===_lastConvSig\)return/.test(src), rel.join("/") + ": 签名未变须早返·不换 DOM·根治每秒整段重建");
      // 结构签名 must NOT 含 staleSec/sizeKB/age (否则又被时间滴答击穿)
      const sigBlock = (src.match(/_convStructSig = JSON\.stringify\(\{[\s\S]*?\}\);/) || [""])[0];
      assert.ok(sigBlock && !/staleSec|sizeKB|\bage\b/.test(sigBlock), rel.join("/") + ": 结构签名严禁含 staleSec/sizeKB/age");
    }
  });
  test("F2 根因自证: _convSig 对仅时间/大小变动的对话区返回同签名", () => {
    // 直接验证签名算法本身: 同结构、仅 staleSec/sizeKB/age tooltip 不同 → 签名相等 (否则 DOM 会每秒重建)
    const _convSig = (html) => String(html)
      .replace(/title="[^"]*"/g, "")
      .replace(/\d+(?:\.\d+)?\s*KB/g, "#KB")
      .replace(/\d+\s*min前/g, "#T").replace(/\d+\s*s前/g, "#T")
      .replace(/<span class="cv-stale">[^<]*<\/span>/g, '<span class="cv-stale"></span>')
      .replace(/\s+/g, " ").trim();
    const a = '<div class="conv-section"><span class="cv-dot ok" title="引擎运行中 (pid 123)"></span><div class="cv-current"><b>修Bug</b> · 12KB · 3s前</div><div class="cv-stuck-item"><span class="cv-stale">5s</span></div></div>';
    const b = '<div class="conv-section"><span class="cv-dot ok" title="引擎运行中 (pid 123)"></span><div class="cv-current"><b>修Bug</b> · 48KB · 41s前</div><div class="cv-stuck-item"><span class="cv-stale">2min</span></div></div>';
    assert.strictEqual(_convSig(a), _convSig(b), "仅时间/大小变动 → 签名须相等(不重建)");
    const c = a.replace("修Bug", "改文档"); // 结构性变化(标题文本)
    assert.notStrictEqual(_convSig(a), _convSig(c), "标题文本变化 → 签名须不同(应更新)");
    const d = a.replace('cv-dot ok', 'cv-dot stuck'); // 状态灯变化
    assert.notStrictEqual(_convSig(a), _convSig(d), "状态变化 → 签名须不同(应更新)");
  });
  test("F4: 运行账号顶置 _wamDisplayOrder + 对齐分隔栏 run-sep", () => {
    const fs = require("fs"), path = require("path");
    for (const rel of [["..", "extension.js"], ["..", "..", "dao-vsix", "rtflow", "extension.js"]]) {
      const src = fs.readFileSync(path.join(__dirname, ...rel), "utf8");
      assert.ok(/function _wamDisplayOrder\(/.test(src) && /function _hasLiveConv\(/.test(src), rel.join("/") + ": 须顶置排序函数");
      assert.ok(/_oi === _liveCount && _liveCount > 0 && _liveCount < _dispOrder\.length/.test(src), rel.join("/") + ": 分隔栏须仅两组非空时插入边界");
      assert.ok(/\.run-sep\{/.test(src), rel.join("/") + ": 须 run-sep 对齐样式");
    }
  });

  test("v4.16.0: 切号多选批量 rt/sb + 对话追踪每行直达", () => {
    const fs = require("fs"), path = require("path");
    for (const rel of [["..", "extension.js"], ["..", "..", "dao-vsix", "rtflow", "extension.js"]]) {
      const src = fs.readFileSync(path.join(__dirname, ...rel), "utf8");
      const r = rel.join("/");
      // 前端: rt/sb 多选时发批量消息, 否则单账号
      assert.ok(/function rt\(i\)\{[\s\S]*?_selectedFor\(i\)[\s\S]*?routeToIdeBatch/.test(src) && /type:'routeToIde',index:i/.test(src), r + ": rt(i) 须多选发 routeToIdeBatch·单账号回退 routeToIde");
      assert.ok(/function sb\(i\)\{[\s\S]*?_selectedFor\(i\)[\s\S]*?openSysBrowserBatch/.test(src) && /type:'openSysBrowser',index:i/.test(src), r + ": sb(i) 须多选发 openSysBrowserBatch·单账号回退 openSysBrowser");
      // 宿主: 抽出可复用单账号实现 + 四个新 case
      assert.ok(/async function _routeAccountToIde\(i\)/.test(src), r + ": 须抽出 _routeAccountToIde");
      assert.ok(/async function _openAccountSysBrowser\(i\)/.test(src), r + ": 须抽出 _openAccountSysBrowser");
      assert.ok(/case "routeToIdeBatch":/.test(src) && /case "openSysBrowserBatch":/.test(src), r + ": 须有批量 case");
      assert.ok(/case "convRouteToIde":/.test(src) && /case "convOpenSysBrowser":/.test(src), r + ": 须有对话级直达 case");
      // 对话级浏览器须带 pagePath=sessions/<id>
      assert.ok(/pagePath = _sid \? \("sessions\/" \+ _sid\)/.test(src), r + ": convOpenSysBrowser 须导航至该对话 sessions/<id>");
      // 对话追踪每行两按钮
      assert.ok(/data-act="convRt"/.test(src) && /data-act="convSb"/.test(src) && /class="dv-trk-go"/.test(src), r + ": 对话追踪行须有 convRt/convSb 直达按钮");
      assert.ok(/\.dv-trk-go\{/.test(src), r + ": 须 dv-trk-go 样式");
    }
  });

  // ── 归一外壳 /shell 公网多用户隔离 (道并行而不相悖 · 双副本 rt-flow + dao-vsix) ──
  console.log("\n[/shell 多用户会话隔离]");
  test("/shell: 六大板块宿主回推按 sid 隔离, 不再无脑广播 (道并行而不相悖)", () => {
    const fs = require("fs"), path = require("path");
    for (const rel of [["..", "extension.js"], ["..", "..", "dao-vsix", "rtflow", "extension.js"]]) {
      const src = fs.readFileSync(path.join(__dirname, ...rel), "utf8");
      const r = rel.join("/");
      // 必备: 按会话路由的派发器 + 串行化执行器 + 活跃 sid 锁
      assert.ok(/function _shellCloudDispatch\(/.test(src), r + ": 须 _shellCloudDispatch 按 sid 派发");
      assert.ok(/function _shellCloudRun\(sid, fn\)/.test(src), r + ": 须 _shellCloudRun 串行化执行器");
      assert.ok(/_shellCloudActiveSid/.test(src), r + ": 须活跃 sid 锁");
      // 派发器: 有活跃 sid → 只发该 sid; 无 → 广播 (后台只读刷新)
      assert.ok(/if \(_shellCloudActiveSid\) _shellSend\(_shellCloudActiveSid, \{ type: 'cloudHost'/.test(src), r + ": 有活跃 sid 须仅 _shellSend 给该 sid");
      assert.ok(/else _shellBroadcast\(\{ type: 'cloudHost'/.test(src), r + ": 无活跃 sid(任务间)才广播");
      // cloudInit/cloudRelay/cloudReady 三入口须经 _shellCloudRun 路由
      assert.ok(/case 'cloudInit':[\s\S]{0,260}_shellCloudRun\(sid,/.test(src), r + ": cloudInit 须经 _shellCloudRun(sid,...)");
      assert.ok(/case 'cloudRelay':[\s\S]{0,160}_shellCloudRun\(sid,[\s\S]{0,120}_cloudProvider\.handleMessage/.test(src), r + ": cloudRelay 须经 _shellCloudRun(sid,...) await handleMessage");
      assert.ok(/case 'cloudReady':[\s\S]{0,140}_shellCloudRun\(sid,/.test(src), r + ": cloudReady 须经 _shellCloudRun(sid,...)");
      // 严禁旧病灶: cloudInit 内直接 setHostPost(()=>_shellBroadcast(cloudHost))
      assert.ok(!/setHostPost\(\(mm\) => \{ _shellBroadcast\(\{ type: 'cloudHost'/.test(src), r + ": 严禁 cloudInit 内直接广播式 setHostPost (旧病灶)");
    }
  });

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────");
  console.log("PASS " + passed + "  FAIL " + failed);
  if (failed) {
    failures.forEach(([n, e]) => console.log("  ✗ " + n + "\n     " + (e && e.stack || e)));
    process.exit(1);
  }
  console.log("ALL GREEN");
})();
