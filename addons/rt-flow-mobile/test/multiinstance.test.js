"use strict";
// 网页多实例单测 (零网络·vm 沙箱 + chrome mock):
//   守约 1: openAccountTab → 新开 Tab + 绑定 + per-tab DNR (id=TAB_RULE_BASE+tabId, priority 2, tabIds:[id])。
//   守约 2: getTabAuth 绑定 Tab 回 bound:true + 该账号鉴权; 未绑定 Tab 回退全局 active。
//   守约 3: broadcastInject 跳过已绑定 Tab (全局切号不污染多实例 Tab)。
//   守约 4: Tab 关闭 → 撤 per-tab DNR + 清绑定。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dnrCalls = [];
let store = {};
let createdTabs = [];
let nextTabId = 100;
const tabsDb = {};
let onRemovedCb = null;
const injects = []; // broadcastInject 下发记录

const chrome = {
  declarativeNetRequest: { updateDynamicRules: (o) => { dnrCalls.push(JSON.parse(JSON.stringify(o))); return Promise.resolve(); } },
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
  tabs: {
    query: (q, cb) => { const r = Object.values(tabsDb); return cb ? cb(r) : Promise.resolve(r); },
    sendMessage: (id, m) => { injects.push({ id, m }); return Promise.resolve(); },
    create: (opts) => { const id = ++nextTabId; tabsDb[id] = { id, url: opts.url, title: "Devin" }; createdTabs.push(id); return Promise.resolve(tabsDb[id]); },
    get: (id) => tabsDb[id] ? Promise.resolve(tabsDb[id]) : Promise.reject(new Error("no tab")),
    remove: (id) => { delete tabsDb[id]; return Promise.resolve(); },
    onRemoved: { addListener: (cb) => { onRemovedCb = cb; } },
  },
  notifications: { create: () => {} },
  alarms: { create: () => Promise.resolve(), onAlarm: { addListener: () => {} } },
  runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} } },
};
const ctx = { chrome, console, setTimeout, clearTimeout, Date, Promise, JSON, Math, Object, String, Boolean, Number, Array, RegExp, AbortController, fetch: () => Promise.resolve({}), WebSocket: function () {} };
ctx.self = ctx; ctx.globalThis = ctx; ctx.importScripts = () => {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "cloud.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "relay.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8"), ctx);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}
const norm = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  // 每个账号登录返回稳定 auth (按 email 派生)
  ctx.DaoCloud.login = async (email) => ({ ok: true, auth1: "a_" + email.replace(/[^a-z]/gi, ""), orgId: "org_" + email[0], userId: "u_" + email[0], orgName: "Org" + email[0], email, ts: Date.now() });

  console.log("openAccountTab (多实例·开账号专属 Tab):");
  store = { accounts: [{ email: "alice@x.com", password: "p" }, { email: "bob@x.com", password: "p" }], authCache: {}, settings: {}, active: "", quota: {}, tabBindings: {} };
  dnrCalls.length = 0; createdTabs = [];
  const ra = norm(await ctx.openAccountTab("alice@x.com"));
  await t("openAccountTab 成功 → 新开 Tab + 返回 tabId", () => {
    assert.strictEqual(ra.ok, true);
    assert.ok(ra.tabId, "应有 tabId");
    assert.strictEqual(ra.email, "alice@x.com");
    assert.strictEqual(createdTabs.length, 1);
  });
  await t("openAccountTab → per-tab DNR (id=TAB_RULE_BASE+tabId, priority 2, tabIds, 该账号 auth)", () => {
    const last = dnrCalls[dnrCalls.length - 1];
    const rule = last.addRules[0];
    assert.strictEqual(rule.id, 1000000 + ra.tabId);
    assert.strictEqual(rule.priority, 2);
    assert.deepStrictEqual(rule.condition.tabIds, [ra.tabId]);
    assert.strictEqual(rule.action.requestHeaders.find((h) => h.header === "Authorization").value, "Bearer a_alicexcom");
  });
  await t("绑定持久化到 tabBindings", () => {
    assert.strictEqual(store.tabBindings[ra.tabId], "alice@x.com");
  });

  // 开第二个账号 Tab
  const rb = norm(await ctx.openAccountTab("bob@x.com"));
  await t("第二账号开独立 Tab (不同 tabId·不同 per-tab DNR·互不干扰)", () => {
    assert.notStrictEqual(rb.tabId, ra.tabId);
    const last = dnrCalls[dnrCalls.length - 1];
    assert.strictEqual(last.addRules[0].id, 1000000 + rb.tabId);
    assert.strictEqual(last.addRules[0].action.requestHeaders.find((h) => h.header === "Authorization").value, "Bearer a_bobxcom");
  });

  console.log("\ngetTabAuth (content script 拉本 Tab 应注入哪个账号):");
  await t("绑定 Tab → bound:true + 该账号 auth", async () => {
    const r = norm(await ctx.getTabAuth({ tab: { id: ra.tabId } }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bound, true);
    assert.strictEqual(r.auth1, "a_alicexcom");
    assert.strictEqual(r.email, "alice@x.com");
  });
  await t("未绑定 Tab → 回退全局 active (bound:false)", async () => {
    store.active = "bob@x.com";
    store.authCache["bob@x.com"] = { auth1: "a_bobxcom", orgId: "org_b", userId: "u_b", ts: Date.now() };
    const r = norm(await ctx.getTabAuth({ tab: { id: 999 } }));
    assert.strictEqual(r.bound, false);
    assert.strictEqual(r.auth1, "a_bobxcom");
  });

  console.log("\nbroadcastInject (全局切号不污染多实例 Tab):");
  await t("broadcastInject 跳过已绑定 Tab, 只发未绑定 Tab", async () => {
    tabsDb[777] = { id: 777, url: "https://app.devin.ai/", title: "plain" }; // 未绑定 Tab
    injects.length = 0;
    await ctx.broadcastInject({ auth1: "global_auth", userId: "ug", orgId: "og" });
    const targets = injects.map((x) => x.id);
    assert.ok(targets.includes(777), "应发给未绑定 Tab 777");
    assert.ok(!targets.includes(ra.tabId), "不应发给绑定 Tab " + ra.tabId);
    assert.ok(!targets.includes(rb.tabId), "不应发给绑定 Tab " + rb.tabId);
  });

  console.log("\nTab 关闭清理:");
  await t("onRemoved → 撤 per-tab DNR + 清绑定", async () => {
    dnrCalls.length = 0;
    assert.ok(onRemovedCb, "应注册 onRemoved 监听");
    await onRemovedCb(ra.tabId);
    const last = dnrCalls[dnrCalls.length - 1];
    assert.deepStrictEqual(last.removeRuleIds, [1000000 + ra.tabId]);
    assert.strictEqual(store.tabBindings[ra.tabId], undefined);
  });
  await t("listTabs 返回仍存活的绑定 Tab", async () => {
    const r = norm(await ctx.listTabs());
    const ids = r.tabs.map((x) => x.tabId);
    assert.ok(ids.includes(rb.tabId));
    assert.ok(!ids.includes(ra.tabId), "已关闭的 Tab 不应在列");
  });

  console.log("\nmultiinstance.test: " + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();
