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

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────");
  console.log("PASS " + passed + "  FAIL " + failed);
  if (failed) {
    failures.forEach(([n, e]) => console.log("  ✗ " + n + "\n     " + (e && e.stack || e)));
    process.exit(1);
  }
  console.log("ALL GREEN");
})();
