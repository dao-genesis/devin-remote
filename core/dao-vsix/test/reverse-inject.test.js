"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-vsix · 反向注入「得一·单一权威」回归自测 (node test/reverse-inject.test.js)
//   无 vscode · 无网络 · 纯文件系统模拟。复现「多实例·多令牌·他者桥污染」这一根病:
//   一台机器上并存多个插件实例(9920/9921/9923 各持私牌)+ 一个独立 dao-bridge(写共享文件·url=""),
//   验证 checkAuth / bridgeEffective* / daoResolveMcpEndpoint / bridgeCurrentSig / cfLogHasRateLimit
//   在此污染场景下是否恒守「本实例可达隧道 + 机器级权威令牌」同源一对(得一), 绝不放行/发布他者令牌。
//
//   种子: extension.ts 尾部 DAO_SELFTEST=1 守卫暴露的 __selftest。生产 activate 路径永不触及。
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// ── 沙盒: 独立 HOME(→ ~/.dao 全部改道) 与 ProgramData(→ mcp_public.json) ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dao-selftest-"));
const FAKE_HOME = path.join(SANDBOX, "home");
const FAKE_PROGRAMDATA = path.join(SANDBOX, "ProgramData");
fs.mkdirSync(path.join(FAKE_HOME, ".dao", "bridge"), { recursive: true });
fs.mkdirSync(path.join(FAKE_PROGRAMDATA, "dao_vm"), { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.ProgramData = FAKE_PROGRAMDATA;
process.env.DAO_SELFTEST = "1";

// ── vscode 桩: 递归 Proxy, 任意属性/调用/构造/原始值强转皆安全(仅供 module load 期解析) ──
function makeVscodeStub() {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined; // 防被误当 thenable
      if (prop === "workspaceFolders") return undefined; // 让 sig 里 wsName/root 取空串
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  };
  const target = function () {};
  const proxy = new Proxy(target, handler);
  return proxy;
}
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return makeVscodeStub();
  return _origLoad.call(this, request, parent, isMain);
};

// ── 载入被测(编译产物) ──
const ext = require("../out/extension.js");
const S = ext.__selftest;
assert.ok(S, "__selftest seam 未暴露 (DAO_SELFTEST 未生效?)");

// ── 令牌样本 (≥16 字符方被 machineToken/publishedToken 采纳) ──
const OWN_URL = "https://own-tunnel-abc.trycloudflare.com";
const MACHINE_TOKEN = "dao-vsix-REDACTED"; // leader·机器权威(dao-conn-current)
const WINDOW_TOKEN = "dao-vsix-REDACTED"; // 本窗口私牌(ws.token)
const BRIDGE_TUNNEL_TOKEN = "dao-vsix-REDACTED"; // 内穿刷新令牌(bridgeToken)
const FOREIGN_TOKEN = "dao-vsix-REDACTED"; // 他者进程(独立 dao-bridge)写共享文件的令牌
const FOREIGN_URL = "https://foreign-bridge-xyz.trycloudflare.com";

const P = S.paths;
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), "utf8"); }

// ── 布景: 复现污染现场 ──
// 1) leader 真相文件 dao-conn-current.json: 机器权威令牌 e40b6 · leader 端口 9920 · 多实例 alive[]
writeJson(P.DAO_CONN_CURRENT, {
  url: OWN_URL, token: MACHINE_TOKEN, port: 9920, host: "DESKTOP-MASTER", pid: 1111, epoch: 7,
  alive: [
    { port: 9920, pid: 1111, url: OWN_URL, token: MACHINE_TOKEN },
    { port: 9921, pid: 2222, url: "", token: WINDOW_TOKEN },
    { port: 9923, pid: 3333, url: "", token: "dao-vsix-REDACTED" },
  ],
});
// 2) 他者进程(独立 dao-bridge)写的共享 conn.json: url 恒空, 却带自己的令牌 4092e0 (跨域污染源)
writeJson(path.join(P.BRIDGE_DIR, "conn.json"), { url: "", token: FOREIGN_TOKEN, port: 9100 });
// 3) 旧综合 MCP 网关文件 mcp_public.json: 9100 py 网关地址 + 其令牌(旧法会注入它 → 跨域 401 + 仅 26 工具)
writeJson(P.DAO_MCP_PUBLIC_FILE, { url: "http://127.0.0.1:9100/mcp", token: FOREIGN_TOKEN });

// ── 注入进程内状态: 本实例是 leader(port 9920), 自有隧道 OWN_URL, ws.token 是窗口私牌 ──
S.setState({
  ws: { token: WINDOW_TOKEN, port: 9920, devinAuth1: "", devinOrgId: "" },
  bridgeUrl: OWN_URL,
  bridgeToken: BRIDGE_TUNNEL_TOKEN,
});

// ── 断言助手 ──
let passed = 0, failed = 0; const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; fails.push([name, e]); console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function req(method, url, token) {
  return { method, url, headers: token ? { authorization: "Bearer " + token } : {}, socket: { remoteAddress: "203.0.113.9" } };
}

console.log("\n[checkAuth · 得一: 只认 本窗口私牌 ∪ 内穿刷新牌 ∪ 机器权威牌]");
test("放行 机器权威令牌 (e40b6·dao-conn-current)", () => assert.strictEqual(S.checkAuth(req("POST", "/api/exec", MACHINE_TOKEN)), true));
test("放行 本窗口私牌 (ws.token)", () => assert.strictEqual(S.checkAuth(req("POST", "/api/exec", WINDOW_TOKEN)), true));
test("放行 内穿刷新令牌 (bridgeToken)", () => assert.strictEqual(S.checkAuth(req("POST", "/api/exec", BRIDGE_TUNNEL_TOKEN)), true));
test("拒绝 他者进程令牌 (4092e0·独立 dao-bridge 共享文件) → 根病修复核心", () => assert.strictEqual(S.checkAuth(req("POST", "/api/exec", FOREIGN_TOKEN)), false));
test("拒绝 无令牌 非环回请求", () => assert.strictEqual(S.checkAuth(req("POST", "/api/exec", "")), false));
test("拒绝 随机错误令牌", () => assert.strictEqual(S.checkAuth(req("POST", "/api/exec", "dao-vsix-REDACTED")), false));
test("master_token query 亦只认机器权威牌", () => assert.strictEqual(S.checkAuth(req("GET", "/api/exec?master_token=" + MACHINE_TOKEN, "")), true));
test("master_token query 拒绝他者令牌", () => assert.strictEqual(S.checkAuth(req("GET", "/api/exec?master_token=" + FOREIGN_TOKEN, "")), false));

console.log("\n[bridgeEffective* · URL 与 Token 恒同源一对]");
test("bridgeEffectiveUrl = 本实例自有隧道 (非他者 conn.json)", () => assert.strictEqual(S.bridgeEffectiveUrl(), OWN_URL));
test("bridgeEffectiveToken = 机器权威牌 e40b6 (非他者 4092e0)", () => assert.strictEqual(S.bridgeEffectiveToken(), MACHINE_TOKEN));
test("bridgeMachineToken 取 dao-conn-current.token", () => assert.strictEqual(S.bridgeMachineToken(), MACHINE_TOKEN));
test("bridgeAuthoritativeToken 优先机器权威牌", () => assert.strictEqual(S.bridgeAuthoritativeToken(), MACHINE_TOKEN));

console.log("\n[bridgeReadPublishedToken · 他者桥令牌仍可读取(供诊断)但不入 effective/checkAuth]");
test("能从共享 conn.json 读出他者令牌(证明污染确实存在)", () => assert.strictEqual(S.bridgeReadPublishedToken(), FOREIGN_TOKEN));
test("但 effectiveToken 绝不等于该他者令牌(得一隔离)", () => assert.notStrictEqual(S.bridgeEffectiveToken(), S.bridgeReadPublishedToken()));

console.log("\n[daoResolveMcpEndpoint · 归一为本体 /mcp: 同隧道·同机器令牌]");
const ep = S.daoResolveMcpEndpoint();
test("MCP 端点 = 本实例自有隧道 + /mcp", () => assert.strictEqual(ep && ep.url, OWN_URL + "/mcp"));
test("MCP 令牌 = 机器权威牌 (非 9100 网关的 4092e0)", () => assert.strictEqual(ep && ep.token, MACHINE_TOKEN));
test("MCP 端点绝不指向旧 9100 py 网关", () => assert.ok(ep && !/127\.0\.0\.1:9100/.test(ep.url)));

console.log("\n[bridgeCurrentSig · 签名映实际注入对(得一), 不含他者令牌/地址]");
const sig = S.bridgeCurrentSig();
test("签名含 本实例自有隧道 URL", () => assert.ok(sig.indexOf(OWN_URL) >= 0, "sig=" + sig));
test("签名含 机器权威令牌", () => assert.ok(sig.indexOf(MACHINE_TOKEN) >= 0, "sig=" + sig));
test("签名不含 他者令牌 4092e0", () => assert.ok(sig.indexOf(FOREIGN_TOKEN) < 0, "sig=" + sig));
test("签名不含 他者桥地址", () => assert.ok(sig.indexOf(FOREIGN_URL) < 0, "sig=" + sig));

console.log("\n[bridgeIsLeaderInstance / bridgeMachinePort]");
test("bridgeMachinePort = dao-conn-current.port (9920)", () => assert.strictEqual(S.bridgeMachinePort(), 9920));
test("本实例(port 9920)= leader", () => assert.strictEqual(S.bridgeIsLeaderInstance(), true));
test("切到非 leader 端口(9921)则非 leader", () => {
  S.setState({ ws: { token: WINDOW_TOKEN, port: 9921 } });
  const r = S.bridgeIsLeaderInstance();
  S.setState({ ws: { token: WINDOW_TOKEN, port: 9920 } }); // 复原
  assert.strictEqual(r, false);
});

console.log("\n[cfLogHasRateLimit · Cloudflare 1015/429 限流签名探测 → 长冷却]");
function withLog(content, fn) { fs.writeFileSync(P.CF_LOG, content, "utf8"); try { return fn(); } finally { try { fs.unlinkSync(P.CF_LOG); } catch {} } }
test("命中 error code: 1015", () => withLog("2026/07/03 ERR error code: 1015 ...", () => assert.strictEqual(S.cfLogHasRateLimit(), true)));
test("命中 429 Too Many Requests", () => withLog("HTTP 429 Too Many Requests", () => assert.strictEqual(S.cfLogHasRateLimit(), true)));
test("命中 rate limit 字样", () => withLog("failed: rate-limited by edge", () => assert.strictEqual(S.cfLogHasRateLimit(), true)));
test("正常日志(含 trycloudflare URL)不误判为限流", () => withLog("your quick tunnel https://foo.trycloudflare.com is ready", () => assert.strictEqual(S.cfLogHasRateLimit(), false)));
test("空/无日志 → false", () => { try { fs.unlinkSync(P.CF_LOG); } catch {} assert.strictEqual(S.cfLogHasRateLimit(), false); });

// ── 收尾 ──
console.log("\n" + (failed ? "FAIL" : "PASS") + " " + passed + "  FAIL " + failed);
if (failed) { for (const [n, e] of fails) console.error("  ✗ " + n + "\n    " + (e && e.stack || e)); }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
