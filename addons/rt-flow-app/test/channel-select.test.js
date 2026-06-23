"use strict";
// 实测 tunnel.html 的「公网入口选取」真代码 (切片 //__CHANSEL_START__…//__CHANSEL_END__ eval)。
// 关键回归: 浏览器直开入口(_bestWeb) 只要有 Worker 基址就永远优先 /console, 不再因 WSS 暂掉/被限流
// 而退回「在本网络注定 530/1033 的 cloudflared」(用户「复制的链接打不开」根因)。
// 无框架: node test/channel-select.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "tunnel.html");
const src = fs.readFileSync(HTML, "utf8");
const m = src.match(/\/\/__CHANSEL_START__[\s\S]*?\/\/__CHANSEL_END__/);
if (!m) { console.error("FAIL: 未找到 //__CHANSEL_START__…//__CHANSEL_END__ 标记块"); process.exit(1); }
const sliced = m[0];

// 注入 mock 的 _conn/_relay/_tunnel/_lan/_webConsoleUrl, 让切片在隔离环境跑。
function build(state) {
  const factorySrc = "(function(env){\n" +
    "function _conn(){ return env.conn||{}; }\n" +
    "function _relay(){ return env.relay||{}; }\n" +
    "function _tunnel(){ return env.tunnel||{}; }\n" +
    "function _lan(){ return env.lan||{}; }\n" +
    "function _webConsoleUrl(base, withTok){ var c=_conn(); var isRelay=/\\.workers\\.dev/.test(base); return base+(isRelay?'/console':'/')+'?session='+(c.session||''); }\n" +
    sliced + "\n" +
    "return { bestWeb: _bestWeb, bestPublic: _bestPublic };\n" +
    "})";
  // eslint-disable-next-line no-eval
  return eval(factorySrc)(state);
}

let failures = 0;
function ok(c, msg) { if (c) console.log("  ok  - " + msg); else { failures++; console.error("  FAIL- " + msg); } }

const WORKER = "https://dao-relay-do.zhouyoukang.workers.dev";
const CF = "https://spots-vegetable-warehouse-vast.trycloudflare.com";

// 场景1: Worker 连通 + cloudflared 也在 → 浏览器入口 = Worker /console。
{
  const mod = build({ conn: { url: WORKER, session: "s1" }, relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "worker", "1 Worker 连通: _bestWeb = worker");
  ok(w.url.indexOf("/console") >= 0, "1 入口走 /console");
}

// 场景2(核心回归): Worker WSS 掉线(connected:false) 但 cloudflared 在 → 仍优先 Worker /console (不退回死隧道)。
{
  const mod = build({ conn: { url: WORKER, session: "s2" }, relay: { connected: false, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "worker", "2 Worker 掉线仍优先 Worker /console (核心: 不把死 cloudflared 当网页直开)");
  ok(/自愈重连中/.test(w.label), "2 标注「自愈重连中」而非谎称在线");
  // 对照: _bestPublic(状态/RPC 用) 此时仍如实反映 cloudflared 为当前生效隧道。
  ok(mod.bestPublic().kind === "cloudflared", "2 _bestPublic 仍如实显示 cloudflared (面板状态不被掩盖)");
}

// 场景3: 无 Worker 基址, 只有 cloudflared → 退求隧道根。
{
  const mod = build({ conn: { url: "", session: "s3" }, relay: { connected: false },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "cloudflared", "3 无 Worker: 退求 cloudflared 隧道");
}

// 场景4: 无 Worker、无隧道, 仅局域网 → 退求 LAN。
{
  const mod = build({ conn: { url: "", session: "s4" }, relay: {}, tunnel: { tunnels: [] }, lan: { urls: ["http://192.168.1.9:9920"] } });
  const w = mod.bestWeb();
  ok(w.kind === "lan", "4 仅局域网: 退求 LAN 直连");
}

// 场景5: 全空 → none。
{
  const mod = build({ conn: { url: "", session: "s5" }, relay: {}, tunnel: { tunnels: [] }, lan: { urls: [] } });
  ok(mod.bestWeb().kind === "none", "5 全无: kind=none");
}

if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
console.log("\n全部通过 ✓");
