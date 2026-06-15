"use strict";
// 纯函数单测 (零依赖, node 直接跑): node test/cloud.test.js
// 覆盖 billingBalance / decodeJwtUserId / 评分逻辑 —— 与 rt-flow/devin_cloud.js 同源判定。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// 加载 cloud.js (它把 DaoCloud 挂到 globalThis)
global.atob = (b) => Buffer.from(b, "base64").toString("binary");
require(path.join(__dirname, "..", "src", "cloud.js"));
const { billingBalance, decodeJwtUserId } = globalThis.DaoCloud;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
}

console.log("billingBalance:");
t("available + 正 overage 相加", () => {
  assert.strictEqual(billingBalance({ available_credits: 50, overage_credits: 5 }), 55);
});
t("负 overage(已欠) 不减 available", () => {
  assert.strictEqual(billingBalance({ available_credits: 20, overage_credits: -3 }), 20);
});
t("has_subscription_or_credits=true 且额度 0 → 充足(9999)", () => {
  assert.strictEqual(billingBalance({ available_credits: 0, overage_credits: 0, has_subscription_or_credits: true }), 9999);
});
t("has_subscription_or_credits=false → 真实余额", () => {
  assert.strictEqual(billingBalance({ available_credits: 0, overage_credits: 0, has_subscription_or_credits: false }), 0);
});
t("字段全缺 → null(安全, 不臆造)", () => {
  assert.strictEqual(billingBalance({}), null);
});
t("null 输入 → null", () => {
  assert.strictEqual(billingBalance(null), null);
});

console.log("decodeJwtUserId:");
t("从 JWT payload.sub 解出 user-XXX", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "user-abc123" })).toString("base64");
  const jwt = "h." + payload + ".s";
  assert.strictEqual(decodeJwtUserId(jwt), "user-abc123");
});
t("user_id 字段优先", () => {
  const payload = Buffer.from(JSON.stringify({ user_id: "user-zzz" })).toString("base64");
  assert.strictEqual(decodeJwtUserId("h." + payload + ".s"), "user-zzz");
});
t("非 JWT → 空串", () => {
  assert.strictEqual(decodeJwtUserId("not-a-jwt"), "");
});

// 评分逻辑 (与 background.js scoreOf 同义, 此处独立断言其语义)
function scoreOf(quota) {
  if (!quota) return -1;
  if (quota.balance == null) return -1;
  return quota.balance;
}
console.log("scoreOf (rotate 评分):");
t("余额高者评分高", () => {
  assert.ok(scoreOf({ balance: 50 }) > scoreOf({ balance: 5 }));
});
t("未知额度(null) 低于任何正余额", () => {
  assert.ok(scoreOf({ balance: null }) < scoreOf({ balance: 0.0 }) || scoreOf({ balance: 0 }) === 0);
  assert.ok(scoreOf({ balance: null }) < scoreOf({ balance: 1 }));
});
t("无 quota 记录 → -1", () => {
  assert.strictEqual(scoreOf(undefined), -1);
});

// classifySession (对话追踪五态 · 与 devin_cloud.js 同源)
const { classifySession, isActiveClass } = globalThis.DaoCloud;
console.log("classifySession (对话追踪):");
t("user_action_required 非空 → awaiting (最高优先)", () => {
  assert.strictEqual(classifySession({ status: "suspended", latest_status_contents: { user_action_required: { q: 1 } } }), "awaiting");
});
t("enum=finished → finished", () => {
  assert.strictEqual(classifySession({ latest_status_contents: { enum: "finished" } }), "finished");
});
t("out_of_quota (非终态) → blocked", () => {
  assert.strictEqual(classifySession({ status: "running", latest_status_contents: { reason: "out_of_quota" } }), "blocked");
});
t("coding/working → running", () => {
  assert.strictEqual(classifySession({ status: "running", activity_status: "coding" }), "running");
});
t("isActiveClass: running/awaiting/blocked 为活跃, finished 非", () => {
  assert.ok(isActiveClass("running") && isActiveClass("awaiting") && isActiveClass("blocked"));
  assert.ok(!isActiveClass("finished") && !isActiveClass("idle"));
});

// 事件流 → 文档 (对话数据下载 · 与 devin_cloud.js 同源)
const { buildConversationMd, buildAgentDoc, classifyEvent, safeName, knowledgeToMd } = globalThis.DaoCloud;
console.log("buildConversationMd / 下载文档:");
t("用户/Devin/思考/工具四类气泡按序渲染", () => {
  const ev = [
    { type: "initial_user_message", message: "修个bug", created_at_ms: 1 },
    { type: "devin_thoughts", message: "先看代码", created_at_ms: 2 },
    { type: "shell_process_started", command: "npm test", created_at_ms: 3 },
    { type: "devin_message", message: "已修复", created_at_ms: 4 },
  ];
  const md = buildConversationMd("标题", "devin-x", ev);
  assert.ok(md.includes("# 对话: 标题"));
  assert.ok(md.includes("👤") && md.includes("修个bug"));
  assert.ok(md.includes("🤖 Devin") && md.includes("已修复"));
  assert.ok(md.includes("💭") && md.includes("> 先看代码"));
  assert.ok(md.includes("npm test"));
});
t("classifyEvent: 成功 shell 完成事件不单列 (null)", () => {
  assert.strictEqual(classifyEvent({ type: "shell_process_completed", exit_code: 0 }), null);
  assert.ok(classifyEvent({ type: "shell_process_completed", exit_code: 1, output_trunc: "err" }));
});
t("buildAgentDoc 为合法 JSON 且含 schema/events", () => {
  const doc = JSON.parse(buildAgentDoc("t", "devin-y", { a: 1 }, [{ type: "x" }]));
  assert.strictEqual(doc.schema, "rt-flow.devin-cloud.conversation/1");
  assert.strictEqual(doc.eventCount, 1);
});
t("safeName 清洗非法文件名字符", () => {
  assert.strictEqual(safeName('a/b:c*?"d'), "a_b_c___d");
  assert.strictEqual(safeName(""), "untitled");
});
t("knowledgeToMd 渲染标题/触发/正文", () => {
  const md = knowledgeToMd({ name: "K1", trigger: "when X", body: "正文内容" });
  assert.ok(md.includes("# K1") && md.includes("触发: when X") && md.includes("正文内容"));
});

// 水过无痕/额度 纯函数
const { okDelete, computeConvCap, lowBalanceVerdict, sessionSignature, quotaResetInfo } = globalThis.DaoCloud;
console.log("纯函数 (清理/额度):");
t("okDelete: 200/202/204/404 皆视为已删 (幂等)", () => {
  assert.ok(okDelete(200) && okDelete(202) && okDelete(204) && okDelete(404));
  assert.ok(!okDelete(403) && !okDelete(500));
});
t("computeConvCap: 常态 cap=余额-缓冲", () => {
  assert.deepStrictEqual(computeConvCap(10, 3, false, 0), { cap: 7, drain: false });
});
t("computeConvCap: 抽干模式 cap≤0 且 >floor → 反抬回全余额", () => {
  const r = computeConvCap(2, 3, true, 0.5);
  assert.ok(r.drain === true && r.cap === 2);
});
t("computeConvCap: 见底(≤floor) → cap=0 不抽干", () => {
  assert.deepStrictEqual(computeConvCap(0.3, 3, true, 0.5), { cap: 0, drain: false });
});
t("lowBalanceVerdict: 跌破只警一次, 回升复位", () => {
  assert.deepStrictEqual(lowBalanceVerdict(2, 5, false), { alert: true, alerted: true });
  assert.deepStrictEqual(lowBalanceVerdict(2, 5, true), { alert: false, alerted: true });
  assert.deepStrictEqual(lowBalanceVerdict(9, 5, true), { alert: false, alerted: false });
});
t("sessionSignature: 状态字段拼指纹 (无推进则相同)", () => {
  const a = sessionSignature({ statusClass: "running", status: "x", reason: "r", title: "改名前" });
  const b = sessionSignature({ statusClass: "running", status: "x", reason: "r", title: "改名后" });
  assert.strictEqual(a, b);
});
t("quotaResetInfo: 抽取 D/W 重置时间与剩余% (秒级 unix → ms)", () => {
  const r = quotaResetInfo({ daily_quota_reset_at_unix: 1700000000, weekly_quota_remaining_percent: 42, daily_quota_remaining_percent: 88 });
  assert.strictEqual(r.dailyResetMs, 1700000000000);
  assert.strictEqual(r.dailyPct, 88);
  assert.strictEqual(r.weeklyPct, 42);
  assert.strictEqual(r.weeklyResetMs, null);
});
t("quotaResetInfo: 缺字段/非对象 优雅降级为 null", () => {
  assert.deepStrictEqual(quotaResetInfo(null), { dailyPct: null, weeklyPct: null, dailyResetMs: null, weeklyResetMs: null });
  assert.deepStrictEqual(quotaResetInfo({}), { dailyPct: null, weeklyPct: null, dailyResetMs: null, weeklyResetMs: null });
});

// login(): user_id 的权威真源是 login 响应本体 (回归防护 —— 修复前 userId 恒空,
// 因 auth1 是不透明令牌·非 JWT 且 post-auth 不回传 user_id)。mock fetch, 不触网。
const { login } = globalThis.DaoCloud;
(async () => {
  console.log("login (userId 来源):");
  global.fetch = async (url) => {
    if (String(url).includes("/password/login"))
      return { status: 200, async text() { return JSON.stringify({ token: "auth1_opaque_not_a_jwt_xxxxxxxx", user_id: "user-xyz", email: "a@b.c" }); } };
    if (String(url).includes("/users/post-auth"))
      return { status: 200, async text() { return JSON.stringify({ org_id: "org-123", org_name: "n" }); } };
    return { status: 404, async text() { return ""; } };
  };
  const r = await login("a@b.c", "pw");
  t("userId 取自 login 响应 (post-auth 不回传 user_id 时)", () => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.userId, "user-xyz");
    assert.strictEqual(r.orgId, "org-123");
  });

  // loginViaToken(): 裸 auth1 → post-auth 换 org_id; email 取回传或合成稳定别名 (万法识别 token 入池)
  const { loginViaToken } = globalThis.DaoCloud;
  console.log("\nloginViaToken (裸 token 入池):");
  global.fetch = async (url) => {
    if (String(url).includes("/users/post-auth"))
      return { status: 200, async text() { return JSON.stringify({ org_id: "org-tok", email: "real@b.c" }); } };
    return { status: 404, async text() { return ""; } };
  };
  const tr = await loginViaToken("auth1_bare_token_xyz");
  t("有效 token → ok, 取 org_id 与回传 email, viaToken=true", () => {
    assert.strictEqual(tr.ok, true);
    assert.strictEqual(tr.orgId, "org-tok");
    assert.strictEqual(tr.orgBare, "tok");
    assert.strictEqual(tr.email, "real@b.c");
    assert.strictEqual(tr.viaToken, true);
  });
  const empty = await loginViaToken("   ");
  t("空 token → ok=false", () => {
    assert.strictEqual(empty.ok, false);
  });
  // post-auth 无 org_id (token 失效) → ok=false; email 缺时合成稳定别名
  global.fetch = async () => ({ status: 401, async text() { return "{}"; } });
  const bad = await loginViaToken("bad_token_zzz");
  t("post-auth 无 org_id → ok=false (token 无效)", () => {
    assert.strictEqual(bad.ok, false);
  });
  global.fetch = async (url) => String(url).includes("/users/post-auth")
    ? { status: 200, async text() { return JSON.stringify({ org_id: "org-q" }); } }
    : { status: 404, async text() { return ""; } };
  const syn = await loginViaToken("abcdefghij_klmnop");
  t("post-auth 无 email → 合成稳定别名 token-<前10>", () => {
    assert.strictEqual(syn.ok, true);
    assert.strictEqual(syn.email, "token-abcdefghij");
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
