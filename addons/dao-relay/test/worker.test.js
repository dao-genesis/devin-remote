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

// —— /i/ 反代 WebSocket 升级代理(根治网页内 Devin「一直连接中/Reconnecting」) ——
const workerSrc = readFileSync(new URL("../worker.js", import.meta.url), "utf8");

test("/shell 恒定地址落地页: 探活 dao_alt 备用源并跳转 (公网单页双重兜底不 404)", () => {
  assert.ok(/if \(path === "\/shell"\)/.test(workerSrc), "worker 必有 /shell 落地路由 (恒定地址不 404)");
  assert.ok(/url\.searchParams\.get\("dao_alt"\)/.test(workerSrc), "落地页须解析 dao_alt 备用源");
  assert.ok(/\/api\/health/.test(workerSrc), "须逐源探活 /api/health");
  assert.ok(/location\.replace\(b\+'\/shell\?dao_alt='/.test(workerSrc), "探活成功须整页跳备用源 /shell 并回携 dao_alt");
  assert.ok(/setTimeout\(go,10000\)/.test(workerSrc), "全部不可达须 10s 周期重探·永不死链");
});

test("pxWsProxy: 存在且解 /__wsx/<b64> 与 pxResolveUpstream 两路上游", () => {
  assert.ok(/async function pxWsProxy\(req, opts\)/.test(workerSrc), "pxWsProxy 函数存在");
  assert.ok(/pathOnly\.indexOf\("\/__wsx\/"\) === 0/.test(workerSrc), "异源 wss → /__wsx/<b64> 解码路径");
  assert.ok(/pxResolveUpstream\(pathOnly\)/.test(workerSrc), "同源路径 → pxResolveUpstream 解析上游");
});

test("pxWsProxy: 出站注入 Authorization(浏览器原生 WS 无法带鉴权头) + 返回 101 webSocket", () => {
  assert.ok(/fwd\.set\("Upgrade", "websocket"\)/.test(workerSrc), "出站带 Upgrade: websocket");
  assert.ok(/if \(auth\.auth1\) fwd\.set\("Authorization", "Bearer " \+ auth\.auth1\)/.test(workerSrc), "注入 Bearer 鉴权");
  assert.ok(/new WebSocketPair\(\)/.test(workerSrc) && /status: 101, webSocket: client/.test(workerSrc), "WebSocketPair + 101 升级返回");
  assert.ok(/upWs\.send\(e\.data\)/.test(workerSrc) && /server\.send\(e\.data\)/.test(workerSrc), "双向逐帧转发");
});

test("/i/ 处理器: Upgrade:websocket 请求路由到 pxWsProxy", () => {
  assert.ok(/String\(req\.headers\.get\("Upgrade"\) \|\| ""\)\.toLowerCase\(\) === "websocket"/.test(workerSrc), "检测 WS 升级头");
  assert.ok(/return pxWsProxy\(req, \{ prefix: prefix, restPath: restPath, auth: auth \}\);/.test(workerSrc), "升级请求转 pxWsProxy");
});

test("pxAuthBridge: override window.WebSocket 同源化(同源补前缀·异源经 /__wsx/)", () => {
  assert.ok(/var _OWS=window\.WebSocket/.test(workerSrc), "保存原生 WebSocket");
  assert.ok(/window\.WebSocket=__WS/.test(workerSrc), "替换 window.WebSocket");
  assert.ok(/__pfx\+'\/__wsx\/'\+b/.test(workerSrc), "异源 wss → 本前缀 /__wsx/<b64> 代理");
});

test("VERSION 体现当前头部能力(部署后 /health 可核)", () => {
  assert.ok(/bridge-passthrough/.test(VERSION) || /i-ws-proxy/.test(VERSION) || /ws/i.test(VERSION), "VERSION 体现透明桥/WS 代理能力");
});

test("透明桥: 恒定地址 /api/* 与 /mcp* 经 Bearer 直透传给已连 agent (真·drop-in)", () => {
  assert.ok(/\/\^\\\/\(api\|mcp\)\(\\\/\|\$\)\//.test(workerSrc), "存在 /api|/mcp 机控路径匹配分支");
  // 解析 session 的三条来源: X-Dao-Session 头 / ?s= / token→session 目录
  assert.ok(/req\.headers\.get\("X-Dao-Session"\)/.test(workerSrc), "支持 X-Dao-Session 头显式指定 session");
  assert.ok(/url\.searchParams\.get\("s"\)/.test(workerSrc), "支持 ?s= 显式指定 session");
  assert.ok(/bridgeDirGet\(env, await _tokHash\(t\)\)/.test(workerSrc), "无显式 session 时按 token 哈希查目录");
  // 无 agent 时明确 502 no_agent, 不静默 404
  assert.ok(/"no_agent"[\s\S]{0,120}502/.test(workerSrc), "无匹配 agent → 502 no_agent");
  // GET/HEAD 不读体, 其余读 JSON 体, 合成框架帧转 DO
  assert.ok(/method !== "GET" && req\.method !== "HEAD"/.test(workerSrc), "GET/HEAD 不读请求体");
  assert.ok(/const frame = \{ path: path \+ \(url\.search \|\| ""\), method: req\.method, body: body \}/.test(workerSrc), "合成 {path,method,body} 框架帧");
  assert.ok(/"https:\/\/do\/relay\/" \+ encodeURIComponent\(session\)/.test(workerSrc), "帧化 POST 到配对 DO 的 /relay/<session>");
});

test("透明桥目录: /connect 登记 token→session, DO 持久化 dir-store/dir-fetch", () => {
  assert.ok(/ctx\.waitUntil\(\(async \(\) => \{ await bridgeDirPut\(env, await _tokHash\(t\), session\); \}\)\(\)\)/.test(workerSrc), "connect 时 waitUntil 登记目录(不阻塞握手)");
  assert.ok(/url\.pathname === "\/dir-store"/.test(workerSrc) && /this\.state\.storage\.put\("bt:" \+ tk/.test(workerSrc), "DO 持久化 dir-store (bt:<tokenHash>)");
  assert.ok(/url\.pathname === "\/dir-fetch"/.test(workerSrc) && /rec\.exp && rec\.exp < Date\.now\(\)/.test(workerSrc), "DO dir-fetch 带 TTL 过期清理");
  assert.ok(/crypto\.subtle\.digest\("SHA-256"/.test(workerSrc), "目录键用 token 的 SHA-256 哈希, 不落明文凭据");
});

test("透明桥: /connect 与 /relay/<session> 框架驱动保持向后兼容(未改协议)", () => {
  assert.ok(/if \(path\.startsWith\("\/relay\/"\)\)/.test(workerSrc), "/relay/<session> 帧驱动路由仍在");
  assert.ok(/if \(path === "\/connect"\)/.test(workerSrc), "/connect 出站握手路由仍在");
});
