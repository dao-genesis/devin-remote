"use strict";
// background.js 关键逻辑单测 (零网络, vm 沙箱 + chrome mock): node test/background.test.js
// 回归 1: applyDnr 的 DNR 规则必须用 initiatorDomains 限定为「app.devin.ai 页面发起」,
//         否则扩展自身 service worker 的 getBilling fetch 会被活跃账号鉴权头覆盖 → 额度串号。
// 回归 2 (v1.5.0): 去除「自动切号」—— rotate/panicSwitch/autoSwitchTick/alarms 已移除;
//         切号 = 手动 activate (写 active + 刷 DNR + 注入页面)。本测试守护此契约。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let captured = null;
let store = {}; // 有状态 storage
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
  notifications: { create: () => {} },
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
  const norm = (x) => JSON.parse(JSON.stringify(x));
  const lc = (s) => String(s || "").toLowerCase();

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

  console.log("\n去除自动切号 (v1.5.0·正本清源): rotate/panic/看门狗已移除:");
  t("rotate 函数已移除 (无自动轮转)", () => { assert.strictEqual(typeof ctx.rotate, "undefined"); });
  t("panicSwitch 函数已移除 (无紧急切换)", () => { assert.strictEqual(typeof ctx.panicSwitch, "undefined"); });
  t("autoSwitchTick 函数已移除 (无软耗尽轮询)", () => { assert.strictEqual(typeof ctx.autoSwitchTick, "undefined"); });
  t("scheduleAlarm 函数已移除 (无 alarms 看门狗)", () => { assert.strictEqual(typeof ctx.scheduleAlarm, "undefined"); });
  t("保留手动引擎: activate / ensureAuth / applyDnr / refreshQuota 均在", () => {
    assert.strictEqual(typeof ctx.activate, "function");
    assert.strictEqual(typeof ctx.ensureAuth, "function");
    assert.strictEqual(typeof ctx.applyDnr, "function");
    assert.strictEqual(typeof ctx.refreshQuota, "function");
  });

  console.log("\nactivate (手动切号 = 注入登录·桌面「点击切号」的浏览器形态):");
  ctx.DaoCloud.login = async (email) => ({
    ok: true, auth1: "auth_" + lc(email).replace(/[^a-z]/g, ""), orgId: "org-m", userId: "user-m", email,
  });
  let injected = [];
  chrome.tabs.query = () => Promise.resolve([{ id: 1 }]);
  chrome.tabs.sendMessage = (id, m) => { injected.push(m); return Promise.resolve(); };
  store = { accounts: [{ email: "pick@x.com", password: "p" }], authCache: {}, settings: {}, active: "", quota: {} };
  captured = null; injected = [];
  const ra = norm(await ctx.activate("pick@x.com"));
  t("activate 成功 → 写 active + 刷 DNR 注入头 (新 auth1)", () => {
    assert.strictEqual(ra.ok, true);
    assert.strictEqual(store.active, "pick@x.com");
    const r = captured && captured.addRules && norm(captured.addRules[0]);
    assert.ok(r, "应刷 DNR");
    assert.strictEqual(r.action.requestHeaders.find((h) => h.header === "Authorization").value, "Bearer auth_pickxcom");
  });
  t("activate 成功 → 通知 app.devin.ai 标签页重注入 localStorage (reload)", () => {
    const msg = injected.find((m) => m.type === "dao-inject");
    assert.ok(msg, "应发 dao-inject");
    assert.strictEqual(msg.reload, true);
    assert.strictEqual(msg.auth1, "auth_pickxcom");
  });

  console.log("\nensureAuth (活跃账号令牌刷新 → 同步刷新 DNR):");
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
    const r = captured && captured.addRules && norm(captured.addRules[0]);
    assert.ok(r, "应重刷 DNR 规则");
    assert.strictEqual(r.action.requestHeaders.find((h) => h.header === "Authorization").value, "Bearer fresh_activexcom");
  });

  captured = null;
  await ctx.ensureAuth("other@x.com");
  t("非活跃账号重登 → 不动 DNR (不抢占活跃账号的注入头)", () => {
    assert.strictEqual(captured, null);
  });

  console.log("\nrefreshQuota (额度普查·登录失败如实落账):");
  ctx.DaoCloud.login = async () => ({ ok: false, error: "bad creds" });
  store = { accounts: [{ email: "dead@x.com", password: "p" }], authCache: {}, settings: {}, active: "", quota: {} };
  const rq = norm(await ctx.refreshQuota("dead@x.com"));
  t("登录失败 → quota 记 status=登录失败 (供面板显示·非静默)", () => {
    assert.strictEqual(rq.ok, false);
    assert.strictEqual(store.quota["dead@x.com"].status, "登录失败");
    assert.strictEqual(store.quota["dead@x.com"].balance, null);
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
