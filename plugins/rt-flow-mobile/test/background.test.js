"use strict";
// background.js 关键逻辑单测 (零网络, vm 沙箱 + chrome mock): node test/background.test.js
// 回归 1: applyDnr 的 DNR 规则必须用 initiatorDomains 限定为「app.devin.ai 页面发起」,
//         否则扩展自身 service worker 的 getBilling fetch 会被活跃账号鉴权头覆盖 → 额度串号。
// 回归 2: rotate 必须切到「全局评分最高」的账号; 当前账号已是最优时不切(更不能切到更差者)。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let captured = null;
let store = {}; // 有状态 storage (rotate 测试需要)
const chrome = {
  declarativeNetRequest: { updateDynamicRules: (o) => { captured = o; return Promise.resolve(); } },
  storage: {
    local: {
      get: (keys, cb) => {
        const out = {};
        const ks = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(store));
        for (const k of ks) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (o, cb) => { Object.assign(store, o); cb && cb(); },
      clear: (cb) => { store = {}; cb && cb(); },
    },
    onChanged: { addListener: () => {} },
  },
  tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
  alarms: { clear: () => Promise.resolve(), create: () => {}, onAlarm: { addListener: () => {} } },
  runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} } },
};
const ctx = { chrome, console, setTimeout, clearTimeout, Date, Promise, JSON, Math, Object, String, Boolean, AbortController, fetch: () => Promise.resolve({}) };
ctx.self = ctx;
ctx.globalThis = ctx;
ctx.importScripts = () => {}; // cloud.js 由下方单独注入
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "cloud.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8"), ctx);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
}

(async () => {
  // captured 来自 vm 沙箱 (Array 原型异于宿主域), JSON 归一化后再断言
  const norm = (x) => JSON.parse(JSON.stringify(x));

  console.log("applyDnr (DNR 注入·防额度串号):");
  await ctx.applyDnr({ auth1: "auth1_opaque_token", orgId: "org-abc" });
  const rule = captured && captured.addRules && norm(captured.addRules[0]);

  t("生成 1001 号规则, 注入 Authorization + x-cog-org-id", () => {
    assert.ok(rule, "应生成规则");
    assert.strictEqual(rule.id, 1001);
    const hs = rule.action.requestHeaders.map((h) => h.header).sort();
    assert.deepStrictEqual(hs, ["Authorization", "x-cog-org-id"]);
    assert.strictEqual(rule.action.requestHeaders.find((h) => h.header === "Authorization").value, "Bearer auth1_opaque_token");
  });

  t("规则用 initiatorDomains 限定为 app.devin.ai 页面发起 (扩展自身 fetch 不被改写)", () => {
    assert.deepStrictEqual(rule.condition.initiatorDomains, ["app.devin.ai"]);
  });

  captured = null;
  await ctx.applyDnr(null);
  const cleared = norm(captured);
  t("无 auth 时清除规则 (不残留旧账号鉴权头)", () => {
    assert.deepStrictEqual(cleared.removeRuleIds, [1001]);
    assert.deepStrictEqual(cleared.addRules, []);
  });

  console.log("\nrotate (择优轮转·防切到更差账号):");
  // 用受控桩替掉网络: refreshQuota 不动(直接用预置 quota), activate 仅记录并写 active
  let activated = [];
  const lc = (s) => String(s || "").toLowerCase();
  ctx.refreshQuota = async () => ({ ok: true });
  ctx.activate = async (email) => { activated.push(lc(email)); store.active = lc(email); return { ok: true }; };
  const seed = (active) => {
    store = {
      accounts: [{ email: "low@x.com", locked: false }, { email: "high@x.com", locked: false }],
      authCache: {}, settings: {},
      active,
      quota: { "low@x.com": { balance: 0, status: "ok" }, "high@x.com": { balance: 2.99, status: "ok" } },
    };
    activated = [];
  };

  // 关键回归: 活跃账号已是最高余额时, 不能切到更差的账号 (旧逻辑会切到 low@x.com)
  seed("high@x.com");
  let r = norm(await ctx.rotate("test"));
  t("当前已是最优 → 不切 (noop), 不会切到更差账号", () => {
    assert.strictEqual(r.switchedTo, "high@x.com");
    assert.strictEqual(r.noop, true);
    assert.deepStrictEqual(activated, []);
  });

  // 活跃账号是低余额时, 切到全局最优 high@x.com
  seed("low@x.com");
  r = norm(await ctx.rotate("test"));
  t("活跃账号余额更低 → 切到全局最优账号", () => {
    assert.strictEqual(r.switchedTo, "high@x.com");
    assert.deepStrictEqual(activated, ["high@x.com"]);
    assert.strictEqual(r.ranked[0].email, "high@x.com");
  });

  // 回归 4: 登录失败的号 (status 非 ok) 必须排除出候选 —— 即便余额更高的号登不上,
  //   也绝不切过去 (rotate 切过去 activate 必失败 · 形同把活跃号换成废号)。
  store = {
    accounts: [{ email: "ok@x.com", locked: false }, { email: "broken@x.com", locked: false }],
    authCache: {}, settings: {},
    active: "ok@x.com",
    // broken 余额虚高但登录失败; 旧逻辑 balance==null 给 -1, 此处 status 失败 → -Infinity 真排除
    quota: { "ok@x.com": { balance: 1.5, status: "ok" }, "broken@x.com": { balance: null, status: "登录失败" } },
  };
  activated = [];
  r = norm(await ctx.rotate("test"));
  t("登录失败的号被排除, 不切到登不上的账号", () => {
    assert.strictEqual(r.switchedTo, "ok@x.com");
    assert.deepStrictEqual(activated, []);
  });

  console.log("\n账号锁 effLocked / rotate 过滤 / panicSwitch (反者道之动·默锁防误切):");
  // effLocked: 显式 locked 优先, 缺省由 lockByDefault 决定 (与本体 v4.6.0 反转语义同源)
  t("effLocked: 显式 locked=false → 不锁 (即便 lockByDefault=true)", () => {
    assert.strictEqual(ctx.effLocked({ email: "a", locked: false }, { lockByDefault: true }), false);
  });
  t("effLocked: 显式 locked=true → 锁", () => {
    assert.strictEqual(ctx.effLocked({ email: "a", locked: true }, { lockByDefault: false }), true);
  });
  t("effLocked: 无 locked 记录 → 跟随 lockByDefault", () => {
    assert.strictEqual(ctx.effLocked({ email: "a" }, { lockByDefault: true }), true);
    assert.strictEqual(ctx.effLocked({ email: "a" }, { lockByDefault: false }), false);
  });

  // rotate: 锁定账号不入自动切候选; 仅 high 解锁时切 high
  store = {
    accounts: [{ email: "low@x.com", locked: false }, { email: "high@x.com", locked: true }],
    authCache: {}, settings: { lockByDefault: false },
    active: "low@x.com",
    quota: { "low@x.com": { balance: 0, status: "ok" }, "high@x.com": { balance: 9, status: "ok" } },
  };
  activated = [];
  r = norm(await ctx.rotate("test"));
  t("rotate: 余额最高账号被🔒锁定 → 不切过去 (noop·防误切)", () => {
    assert.strictEqual(r.noop, true);
    assert.deepStrictEqual(activated, []);
  });

  // 全锁定 → allLocked noop (非红错)
  store = {
    accounts: [{ email: "a@x.com", locked: true }, { email: "b@x.com", locked: true }],
    authCache: {}, settings: { lockByDefault: false }, active: "a@x.com",
    quota: { "a@x.com": { balance: 1, status: "ok" }, "b@x.com": { balance: 9, status: "ok" } },
  };
  activated = [];
  r = norm(await ctx.rotate("test"));
  t("rotate: 全部🔒锁定 → allLocked noop (预期·非错误)", () => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.allLocked, true);
    assert.deepStrictEqual(activated, []);
  });

  // panicSwitch: 立即切到其他·未锁定·可登录最优号 (不要求严格更优)
  store = {
    accounts: [{ email: "cur@x.com", locked: false }, { email: "esc@x.com", locked: false }, { email: "lck@x.com", locked: true }],
    authCache: {}, settings: { lockByDefault: false }, active: "cur@x.com",
    quota: { "cur@x.com": { balance: 5, status: "ok" }, "esc@x.com": { balance: 1, status: "ok" }, "lck@x.com": { balance: 9, status: "ok" } },
  };
  activated = [];
  r = norm(await ctx.panicSwitch());
  t("panicSwitch: 弃用当前号, 切到其他未锁定号 (忽略缓冲·锁定号排除)", () => {
    assert.strictEqual(r.switchedTo, "esc@x.com");
    assert.deepStrictEqual(activated, ["esc@x.com"]);
  });

  // panicSwitch: 无其他可切号 → 报错
  store = {
    accounts: [{ email: "only@x.com", locked: false }],
    authCache: {}, settings: { lockByDefault: false }, active: "only@x.com",
    quota: { "only@x.com": { balance: 5, status: "ok" } },
  };
  activated = [];
  r = norm(await ctx.panicSwitch());
  t("panicSwitch: 无其他可切号 → ok=false 报错", () => {
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(activated, []);
  });

  console.log("\nensureAuth (活跃账号令牌刷新 → 同步刷新 DNR):");
  // 回归 3: 活跃账号缓存过期重登后, 必须用新 auth1 重刷 DNR; 非活跃账号重登则不动 DNR。
  ctx.DaoCloud.login = async (email) => ({
    ok: true, auth1: "fresh_" + lc(email).replace(/[^a-z]/g, ""), orgId: "org-z", userId: "user-z", email,
  });
  store = {
    accounts: [{ email: "active@x.com", password: "p" }, { email: "other@x.com", password: "p" }],
    authCache: {}, settings: {}, active: "active@x.com", quota: {},
  };

  captured = null;
  await ctx.ensureAuth("active@x.com");
  t("活跃账号重登 → 用新 auth1 重刷 DNR", () => {
    const rule = captured && captured.addRules && norm(captured.addRules[0]);
    assert.ok(rule, "应重刷 DNR 规则");
    const authH = rule.action.requestHeaders.find((h) => h.header === "Authorization");
    assert.strictEqual(authH.value, "Bearer fresh_activexcom");
  });

  captured = null;
  await ctx.ensureAuth("other@x.com");
  t("非活跃账号重登 → 不动 DNR (不抢占活跃账号的注入头)", () => {
    assert.strictEqual(captured, null);
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
