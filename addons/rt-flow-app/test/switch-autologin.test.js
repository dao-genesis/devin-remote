"use strict";
// 实测 switch.html 的「添加即自动登录」真代码: 切出 `// ── 添加账号 ──` … `// ── 工具条配置`
//   区段 (含 doAdd / autoActivateAdded) eval, 注入 mock 依赖, 跑 JSON / 邮箱密码 / token 三路,
//   断言每路都触发 DaoCore 自动登录/补全 → 账号落得 auth1+orgId (hasAuth 成立), 用户无需点 🔑。
// 无框架: 直接 node test/switch-autologin.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

// 真解析器 (万法识号) — 与运行时同一份。rtflow-parse.js 末尾 `(typeof window!=='undefined'?window:this)`,
//   故先把 global.window 指向 global, require 后从 global 取导出。
if (typeof global.window === "undefined") global.window = global;
require(path.join(ENGINE, "rtflow-parse.js"));
const parseAccountText = global.parseAccountText || global.window.parseAccountText;

// 切出添加账号区段 (doAdd + autoActivateAdded), 边界为两条稳定段注释。
const seg = switchSrc.match(/\/\/ ── 添加账号 ──[\s\S]*?(?=\/\/ ── 工具条配置)/);
if (!seg) { console.error("FAIL: 未找到「添加账号」区段"); process.exit(1); }

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function makeEl() { return { value: "", textContent: "", className: "", innerHTML: "", classList: { toggle: () => true } }; }

// 构造一个隔离运行域: 注入 doAdd/autoActivateAdded 需要的全部外层依赖。
//   DaoCore mock 记录调用, 并按真 DaoCore 的落库语义把 auth1+orgId 写回 store, 便于断言最终 hasAuth。
function makeModule() {
  let store = [];
  const rec = { login: [], hydrate: [] };
  const toasts = [];
  const els = { addInput: makeEl(), toast: makeEl(), addBody: makeEl(), addArrow: makeEl() };
  function find(idOrEmail) { return store.findIndex(x => x.id === idOrEmail || x.email === idOrEmail); }
  const DaoCore = {
    loginAndStore: async (email, password) => {
      rec.login.push(email);
      const acc = { id: email, email, password, auth1: "auth1_" + email, orgId: "org-" + email, quota: { dPct: 100, overageDollars: 5 } };
      const i = find(email); if (i >= 0) Object.assign(store[i], acc); else store.push(acc);
      return { ok: true, account: acc };
    },
    hydrateAuth1: async (id) => {
      rec.hydrate.push(id);
      const i = find(id); if (i >= 0) { store[i].orgId = "org-" + id; store[i].quota = { dPct: 100, overageDollars: 7 }; }
      return { ok: true, orgId: "org-" + id, quota: { dPct: 100, overageDollars: 7 } };
    },
  };
  const factory = "(function(deps){\n" +
    "var loadAcc=deps.loadAcc, saveAcc=deps.saveAcc, render=deps.render, toast=deps.toast,\n" +
    "    hasAuth=deps.hasAuth, DaoCore=deps.DaoCore, window=deps.window, document=deps.document,\n" +
    "    setTimeout=deps.setTimeout; var _orderIds=null;\n" +
    seg[0] + "\n" +
    "return { doAdd: doAdd, autoActivateAdded: autoActivateAdded };\n" +
    "})";
  const deps = {
    loadAcc: () => store.map(a => Object.assign({}, a)),
    saveAcc: (a) => { store = (a || []).map(x => Object.assign({}, x)); },
    render: () => {},
    toast: (m) => { toasts.push(m); els.toast.textContent = m; },
    hasAuth: (a) => !!(a && a.auth1 && a.orgId),
    DaoCore: DaoCore,
    window: { parseAccountText: parseAccountText },
    document: { getElementById: (id) => els[id] || makeEl() },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  // eslint-disable-next-line no-eval
  const fns = eval(factory)(deps);
  return { fns, els, toasts, rec, seed: (a) => store.push(a), getStore: () => store };
}

(async function run() {
  // ── 场景 1: JSON 粘贴 (旧 bug: !jsonOk 把自动登录排除) ──
  {
    const m = makeModule();
    m.els.addInput.value = JSON.stringify({ email: "a@x.com", password: "pw1" });
    m.fns.doAdd();
    await wait(400);
    ok(m.rec.login.indexOf("a@x.com") >= 0, "JSON 路径: 触发了 loginAndStore (旧版被 !jsonOk 跳过)");
    ok(m.getStore().every(x => x.auth1 && x.orgId), "JSON 路径: 账号最终 hasAuth 成立 (不再卡 🔑)");
  }
  // ── 场景 2: 邮箱密码文本 ──
  {
    const m = makeModule();
    m.els.addInput.value = "b@y.com pw2";
    m.fns.doAdd();
    await wait(400);
    ok(m.rec.login.indexOf("b@y.com") >= 0, "文本路径: 触发了 loginAndStore");
    ok(m.getStore().every(x => x.auth1 && x.orgId), "文本路径: 账号最终 hasAuth 成立");
  }
  // ── 场景 3: 纯 token 粘贴 (旧 bug: 无邮箱密码, doLoginAll 跳过 → 永卡 🔑) ──
  {
    const m = makeModule();
    m.els.addInput.value = "auth1_abcdefghijklmnopqrstuvwxyz012345";
    m.fns.doAdd();
    await wait(400);
    ok(m.rec.hydrate.length === 1, "token 路径: 触发了 hydrateAuth1 (旧版无此能力·永卡 🔑)");
    ok(m.getStore().every(x => x.auth1 && x.orgId), "token 路径: 账号经 auth1 补全 org 后 hasAuth 成立");
  }
  // ── 场景 4: 已 authed 的号重复添加 → 不重复登录 (autoActivateAdded 过滤 !hasAuth) ──
  {
    const m = makeModule();
    m.seed({ id: "c@z.com", email: "c@z.com", password: "pw3", auth1: "auth1_c", orgId: "org-c" });
    m.els.addInput.value = JSON.stringify({ email: "c@z.com", password: "pw3" });
    m.fns.doAdd();
    await wait(400);
    ok(m.rec.login.length === 0, "已 authed 号重复添加: 不重复 loginAndStore");
  }

  // ── 源级护栏 ──
  ok(!/if\(!jsonOk\s*&&\s*\(added\+updated\)>0\)\s*setTimeout\(doLoginAll/.test(switchSrc),
     "源级: 已移除 `!jsonOk` 门控的旧自动登录调用");
  ok(/autoActivateAdded\(touched\)/.test(switchSrc), "源级: doAdd 调用 autoActivateAdded(touched)");

  console.log(failures ? ("\n✗ " + failures + " 项失败") : "\n全部通过 ✓");
  process.exit(failures ? 1 : 0);
})();
