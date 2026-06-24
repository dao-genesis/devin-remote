// worker.test.js — 纯逻辑单测(不触碰 Cloudflare 运行时全局):
//   验证 (session,token) 配对定址 + 可选私有共享密钥闸门 —— 即「零账号默认通道」
//   能成立、且 session/token 任一不符都落到不同 DO(→ no_agent) 的根本判据。
// 运行: node --test test/   (或 node --test test/worker.test.js)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { relayKey, sharedTokenOk, VERSION, pxIsImmutableAsset, pxIsHashedCode, pickOpenAgent } from "../keys.js";

// repair.js 经浏览器 importScripts 加载(挂到 self), 这里在沙箱里 eval 出函数做纯逻辑单测。
const repairUvJs = (() => {
  const code = readFileSync(new URL("../public/uv/repair.js", import.meta.url), "utf8");
  const sandbox = {};
  // eslint-disable-next-line no-new-func
  new Function("self", code)(sandbox);
  return sandbox.repairUvJs;
})();

test("VERSION is a non-empty string", () => {
  assert.strictEqual(typeof VERSION, "string");
  assert.ok(VERSION.length > 0);
});

test("relayKey is deterministic for identical (session,token)", () => {
  assert.strictEqual(relayKey("box1", "tokA"), relayKey("box1", "tokA"));
});

test("relayKey differs when session OR token differs", () => {
  const base = relayKey("box1", "tokA");
  assert.notStrictEqual(base, relayKey("box2", "tokA"), "different session → different namespace");
  assert.notStrictEqual(base, relayKey("box1", "tokB"), "different token → different namespace");
});

test("relayKey has no separator collision (a|bc vs ab|c)", () => {
  // 若用裸拼接 'a'+'bc' === 'ab'+'c' 会撞键; NUL 分隔杜绝之。
  assert.notStrictEqual(relayKey("a", "bc"), relayKey("ab", "c"));
});

test("sharedTokenOk: open pairing when no env.DAO_TOKEN (zero-account)", () => {
  assert.strictEqual(sharedTokenOk({}, "anyRandomToken"), true);
  assert.strictEqual(sharedTokenOk({ DAO_TOKEN: "" }, "anyRandomToken"), true);
  assert.strictEqual(sharedTokenOk(undefined, "anyRandomToken"), true);
});

test("sharedTokenOk: locked to shared secret when env.DAO_TOKEN set (private mode)", () => {
  const env = { DAO_TOKEN: "s3cret" };
  assert.strictEqual(sharedTokenOk(env, "s3cret"), true);
  assert.strictEqual(sharedTokenOk(env, "wrong"), false);
  assert.strictEqual(sharedTokenOk(env, ""), false);
});

test("pxIsImmutableAsset: 字体/图片/wasm 等二进制资源 → 可边缘强缓存", () => {
  for (const p of ["/assets/x.woff2", "/a/b.WOFF", "/i.png", "/p.jpg", "/p.jpeg", "/s.svg", "/f.ico", "/m.wasm", "/v.mp4", "/x.png?v=abc"]) {
    assert.strictEqual(pxIsImmutableAsset(p), true, p);
  }
});

test("pxIsImmutableAsset: JS/CSS/HTML/API 不入强缓存(版本敏感/动态)", () => {
  for (const p of ["/assets/x.js", "/assets/y.css", "/index.html", "/api/sessions", "/", "", "/x.js?v=1", "/foo.json"]) {
    assert.strictEqual(pxIsImmutableAsset(p), false, p);
  }
});

test("pxIsHashedCode: 内容哈希过的 JS/CSS/MJS 代码包 → 上游可跨账号边缘缓存", () => {
  for (const p of [
    "/assets/index-Dk3f9a2B.js", "/assets/vendor-a1B2c3D4.css", "/assets/chunk-A1b2C3d4e5.mjs",
    "/i/acc/assets/main-0123abcd.js", "/assets/x-ABCDEFGH12345678.js?v=1",
  ]) {
    assert.strictEqual(pxIsHashedCode(p), true, p);
  }
});

test("pxIsHashedCode: 无哈希入口/动态文件 → 不缓存(每次重写照旧·避免陈旧)", () => {
  for (const p of [
    "/main.js", "/index.css", "/assets/app.js", "/assets/short-abc.js", // hash 不足 8 位
    "/api/sessions", "/index.html", "/x.png", "", "/assets/nohyphen12345678.js",
  ]) {
    assert.strictEqual(pxIsHashedCode(p), false, p);
  }
});

// —— pickOpenAgent: 转发只选「确实 OPEN」的 agent socket(根治断线重连窗口的首发 send_failed) ——
const OPEN = 1, CONNECTING = 0, CLOSING = 2, CLOSED = 3;
const sock = (readyState) => ({ readyState, id: Symbol() });

test("pickOpenAgent: 空/非数组 → null", () => {
  assert.strictEqual(pickOpenAgent([]), null);
  assert.strictEqual(pickOpenAgent(null), null);
  assert.strictEqual(pickOpenAgent(undefined), null);
});

test("pickOpenAgent: 全部 CLOSING/CLOSED → null(绝不返回不可写 socket)", () => {
  assert.strictEqual(pickOpenAgent([sock(CLOSED), sock(CLOSING)]), null);
});

test("pickOpenAgent: 末位 OPEN → 取末位(最新接入优先)", () => {
  const a = sock(OPEN), b = sock(OPEN);
  assert.strictEqual(pickOpenAgent([a, b]), b);
});

test("pickOpenAgent: 末位是重连中陈旧 socket(CLOSING/CLOSED), 跳过取更早的 OPEN", () => {
  const live = sock(OPEN), stale = sock(CLOSED);
  assert.strictEqual(pickOpenAgent([live, stale]), live, "末位 CLOSED 被跳过, 回更早的 OPEN");
  const live2 = sock(OPEN);
  assert.strictEqual(pickOpenAgent([live2, sock(CLOSING), sock(CONNECTING)]), live2);
});

test("pickOpenAgent: 运行时不暴露 readyState(全 undefined) → 退化取末位(向后兼容)", () => {
  const a = { id: 1 }, b = { id: 2 };
  assert.strictEqual(pickOpenAgent([a, b]), b);
});

// —— repairUvJs: UV 把语句标签误当全局名重写 → 修复 ——
test("repairUvJs: continue/break 后的 __uv.$get(label) 还原为裸标签", () => {
  assert.strictEqual(repairUvJs("continue __uv.$get(top)"), "continue top");
  assert.strictEqual(repairUvJs("break __uv.$get(loop)"), "break loop");
});

test("repairUvJs: 语句边界后的标签声明还原 (do/for/while/switch)", () => {
  assert.strictEqual(repairUvJs(";__uv.$get(top):do{}while(0)"), ";top:do{}while(0)");
  assert.strictEqual(repairUvJs("}__uv.$get(t):for(;;){}"), "}t:for(;;){}");
});

test("repairUvJs: alien-signals 整段 (毁坏→修复后是合法语法)", () => {
  const broken = "function f(){let n;__uv.$get(top):do{if(x)continue __uv.$get(top);break __uv.$get(top)}while(!0)}";
  const fixed = repairUvJs(broken);
  assert.ok(!/__uv\.\$get\([A-Za-z_$][\w$]*\):(do|for|while|switch|\{)/.test(fixed), "无残留标签声明误伤");
  assert.ok(!/(continue|break) __uv\.\$get\(/.test(fixed), "无残留 continue/break 误伤");
  assert.doesNotThrow(() => new Function(fixed), "修复后可被 JS 解析");
});

test("repairUvJs: 不误伤真实 window.top 访问 (三元/表达式)", () => {
  // 三元 a?__uv.$get(top):b 的 ':' 前驱是 '?', 不在语句边界集 → 保持原样。
  const expr = "var z=a?__uv.$get(top):b;";
  assert.strictEqual(repairUvJs(expr), expr);
  const get = "var p=__uv.$get(top).location;";
  assert.strictEqual(repairUvJs(get), get);
});

test("repairUvJs: 无 __uv.$get 的源码原样返回 (快路径)", () => {
  const s = "export const a=1; for(;;){continue;}";
  assert.strictEqual(repairUvJs(s), s);
});
