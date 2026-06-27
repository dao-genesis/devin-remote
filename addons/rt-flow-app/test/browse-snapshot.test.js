"use strict";
// 实测 engine.html 的「阶段二·顶级浏览器 MCP 对齐」真代码 (可访问性快照 + ref 定位器)。
//   对齐 Playwright(getByRole+aria snapshot) / Chrome-MCP(browser_snapshot):
//   先 __daoSnapshot 取带 [ref=eN] 的结构树并登记 window.__daoRefs, 再 __daoAct 按 ref 稳健操作。
//   本测试从 engine.html 抽出这两个真函数(花括号配平提取), 在 mock DOM 上真执行并断言:
//     ① 快照只收可交互/标题元素、计算 role/name/state、按 DOM 序发 ref;
//     ② 不可见(display:none / 0 尺寸 / aria-hidden)元素被剔除;
//     ③ click/type/select/press 按 ref 命中正确元素并派发正确事件(type 用原生 setter 回退 + input/change);
//     ④ ref 失效(未快照)返回 ref_stale 而非乱点。
// 无框架: 直接 node test/browse-snapshot.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const src = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 花括号配平: 从 `function NAME(` 起截取完整函数体 ──
function extractFn(name) {
  const sig = "function " + name + "(";
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("未找到 " + name);
  let i = src.indexOf("{", at), depth = 0, start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(at, i);
}

// ── 极简 mock DOM (够 __daoSnapshot/__daoAct 真跑) ──
const events = [];
function mkEvent(Ctor) { return function (type, init) { return { __ctor: Ctor, type: type, init: init || {} }; }; }
function el(tag, opts) {
  opts = opts || {};
  const attrs = opts.attrs || {};
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: [],
    childNodes: [],
    _attrs: attrs,
    _vis: opts.vis !== false,
    _rect: opts.rect || { width: 100, height: 20 },
    _style: opts.style || { visibility: "visible", display: "block" },
    value: opts.value !== undefined ? opts.value : "",
    disabled: !!opts.disabled,
    checked: !!opts.checked,
    options: opts.options,
    innerText: opts.text || "",
    textContent: opts.text || "",
    getAttribute(n) { return (n in attrs) ? attrs[n] : null; },
    hasAttribute(n) { return n in attrs; },
    getBoundingClientRect() { return this._rect; },
    dispatchEvent(ev) { events.push({ on: this, ev }); return true; },
    focus() { this.__focused = true; doc.activeElement = this; },
    click() { events.push({ on: this, ev: { type: "click" } }); },
    scrollIntoView() {},
  };
  // 直接文本子节点(供 name 计算)
  if (opts.text) node.childNodes.push({ nodeType: 3, nodeValue: opts.text });
  (opts.children || []).forEach((c) => { node.children.push(c); node.childNodes.push(c); });
  return node;
}

// 构造一棵真实点的页面:
//   body > [ nav>(a登录, a注册), h1标题, form>(input邮箱, textarea备注, select角色, button提交), div(隐藏)>(button不可见) ]
const aLogin = el("a", { text: "登录", attrs: { href: "/login" } });
const aReg = el("a", { text: "注册", attrs: { href: "/reg" } });
const nav = el("nav", { children: [aLogin, aReg] });
const h1 = el("h1", { text: "欢迎" });
const email = el("input", { attrs: { type: "text", "aria-label": "邮箱" } });
const note = el("textarea", { attrs: { placeholder: "备注" } });
const role = el("select", { attrs: {}, options: [
  { value: "admin", text: "管理员", selected: false },
  { value: "user", text: "用户", selected: false },
] });
const submit = el("button", { text: "提交" });
const form = el("form", { children: [email, note, role, submit] });
const hiddenBtn = el("button", { text: "隐藏按钮", style: { visibility: "visible", display: "none" } });
const hiddenWrap = el("div", { children: [hiddenBtn] });
const body = el("body", { children: [nav, h1, form, hiddenWrap] });

const doc = {
  body, documentElement: body, title: "测试页", activeElement: null,
  getElementById() { return null; },
};
const win = {
  __daoRefs: null,
  getComputedStyle(e) { return e._style; },
  HTMLInputElement: { prototype: {} },
  HTMLTextAreaElement: { prototype: {} },
  Event: mkEvent("Event"),
  KeyboardEvent: mkEvent("KeyboardEvent"),
  MouseEvent: mkEvent("MouseEvent"),
};
const sandbox = {
  window: win, document: doc, location: { href: "https://x.test/p" },
  JSON, String, Array, Object, parseInt, Math, Date,
  Event: win.Event, KeyboardEvent: win.KeyboardEvent, MouseEvent: win.MouseEvent,
};
// 让函数体内裸引用 window/document/location 命中 sandbox
const getComputedStyle = (e) => e._style;
const PARAMS = "window,document,location,getComputedStyle,JSON,String,Array,Object,parseInt,Event,KeyboardEvent,MouseEvent";
const snapFn = new Function(PARAMS, extractFn("__daoSnapshot") + "\nreturn __daoSnapshot;");
const actFn = new Function(PARAMS, extractFn("__daoAct") + "\nreturn __daoAct;");
const args = [win, doc, sandbox.location, getComputedStyle, JSON, String, Array, Object, parseInt, win.Event, win.KeyboardEvent, win.MouseEvent];
const __daoSnapshot = snapFn.apply(null, args);
const __daoAct = actFn.apply(null, args);

// ── ① 快照 ──
const snap = JSON.parse(__daoSnapshot(400));
ok(snap.ok === true, "快照成功返回 ok:true");
ok(snap.url === "https://x.test/p" && snap.title === "测试页", "快照带 url/title");
const tree = snap.tree;
ok(/- link "登录" \[ref=e0\]/.test(tree), "a→role=link、name=登录、ref=e0(DOM 序首个)");
ok(/- link "注册" \[ref=e1\]/.test(tree), "第二个链接 ref=e1");
ok(/- heading "欢迎" \[ref=e2\]/.test(tree), "h1→role=heading");
ok(/- textbox "邮箱" \[ref=e3\]/.test(tree), "input→role=textbox、aria-label 作 name");
ok(/- textbox "备注"/.test(tree), "textarea→role=textbox、placeholder 作 name");
ok(/- combobox/.test(tree), "select→role=combobox");
ok(/- button "提交"/.test(tree), "button→role=button、可见文本作 name");
ok(snap.count === 7, "仅 7 个可交互/标题元素入册(隐藏 button 被剔除), 实得 " + snap.count);
ok(!/隐藏按钮/.test(tree), "display:none 的元素不出现在快照");
ok(win.__daoRefs && win.__daoRefs.length === 7, "window.__daoRefs 登记 7 个元素供 ref 操作");
ok(win.__daoRefs[6] === submit, "ref e6 指向真实 submit 元素");

// ── ② 按 ref 点击 ──
events.length = 0;
const rClick = JSON.parse(__daoAct(0, "click", null)); // e0 = 登录链接
ok(rClick.ok === true, "browseClickRef e0 成功");
ok(events.some((x) => x.on === aLogin && x.ev.type === "click"), "click 派发到 e0(登录链接)真实元素");

// ── ③ 按 ref 真实输入(原生 setter 回退 + input/change) ──
events.length = 0;
const rType = JSON.parse(__daoAct(3, "type", { text: "a@b.com", clear: true, submit: true })); // e3 = 邮箱
ok(rType.ok === true && email.value === "a@b.com", "browseTypeRef 写入 e3.value=a@b.com");
ok(events.some((x) => x.on === email && x.ev.type === "input"), "type 派发 input 事件(触发框架 onChange)");
ok(events.some((x) => x.on === email && x.ev.type === "change"), "type 派发 change 事件");
ok(events.some((x) => x.on === email && x.ev.__ctor === "KeyboardEvent" && x.ev.init.key === "Enter"), "submit:true 追发 Enter 键(回车提交)");

// ── ④ 按 ref 选择 <select> ──
const rSel = JSON.parse(__daoAct(5, "select", { values: ["user"] })); // e5 = select
ok(rSel.ok === true && rSel.selected === 1, "browseSelectRef 选中 1 项");
ok(role.options[1].selected === true && role.options[0].selected === false, "select 命中 value=user、互斥取消其他项");

// ── ⑤ press 作用于焦点元素(ref=-1) ──
events.length = 0;
doc.activeElement = note;
const rPress = JSON.parse(__daoAct(-1, "press", { key: "Tab" }));
ok(rPress.ok === true && rPress.key === "Tab", "browsePressKey 无 ref → 作用于 activeElement");
ok(events.some((x) => x.on === note && x.ev.init.key === "Tab"), "press 派发 Tab 键到焦点元素");

// ── ⑥ ref 失效护栏 ──
const rStale = JSON.parse(__daoAct(999, "click", null));
ok(rStale.ok === false && /ref_stale/.test(rStale.error), "失效 ref → ref_stale(不乱点), 提示重新快照");

// ── 源级护栏: 9 条新命令 + cdp 域齐备 ──
[
  "browseSnapshot", "browseClickRef", "browseTypeRef", "browseHoverRef",
  "browseSelectRef", "browsePressKey", "browseGetText", "browseConsoleEnable", "browseConsole",
].forEach((c) => ok(new RegExp(c + ":\\s*async function").test(src), "源级: CMDS 含命令 " + c));
ok(/Accessibility\.getFullAXTree/.test(src), "源级: cdp facade 映射 Accessibility.getFullAXTree→快照");
ok(/Input\.dispatchKeyEvent/.test(src), "源级: cdp facade 含 Input.dispatchKeyEvent");
ok(/命令列表 \(29\)/.test(src), "源级: 浏览器模块文档命令数升至 29");

console.log(failures === 0 ? "\nbrowse-snapshot: ALL PASS" : "\nbrowse-snapshot: " + failures + " FAIL");
process.exit(failures === 0 ? 0 : 1);
