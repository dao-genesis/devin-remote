// worker.test.js — 纯逻辑单测(不触碰 Cloudflare 运行时全局):
//   验证 (session,token) 配对定址 + 可选私有共享密钥闸门 —— 即「零账号默认通道」
//   能成立、且 session/token 任一不符都落到不同 DO(→ no_agent) 的根本判据。
// 运行: node --test test/   (或 node --test test/worker.test.js)
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { relayKey, sharedTokenOk, VERSION } from "../keys.js";

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
