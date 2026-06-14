"use strict";
// background.js 关键逻辑单测 (零网络, vm 沙箱 + chrome mock): node test/background.test.js
// 重点回归: applyDnr 的 DNR 规则必须用 initiatorDomains 限定为「app.devin.ai 页面发起」,
// 否则扩展自身 service worker 的 getBilling fetch 会被活跃账号鉴权头覆盖 → 额度串号。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let captured = null;
const chrome = {
  declarativeNetRequest: { updateDynamicRules: (o) => { captured = o; return Promise.resolve(); } },
  storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } },
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
  console.log("applyDnr (DNR 注入·防额度串号):");

  // captured 来自 vm 沙箱 (Array 原型异于宿主域), JSON 归一化后再断言
  const norm = (x) => JSON.parse(JSON.stringify(x));

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

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
