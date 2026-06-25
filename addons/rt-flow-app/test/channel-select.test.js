"use strict";
// 实测 tunnel.html 的「公网入口选取」真代码 (切片 //__CHANSEL_START__…//__CHANSEL_END__ eval)。
// 新本源契约 (道法自然·下放中继 Worker → 去中心化为本, Worker 仅末位兜底):
//   ① 设备身份就绪(session+token)时, 浏览器直开入口(_bestWeb) 恒为「去中心化 P2P 网控台」
//      (CDN 托管 p2p-client.html + 公共 ntfy 信令 + WebRTC), 完全不经任何 Worker。
//   ② RPC/状态公网入口(_bestPublic) 首选已建立的去中心化隧道(cloudflared 主 > SSH 备),
//      仅当二者皆无时才以中继 Worker 末位兜底 (即便其在线也不再抢首位)。
//   ③ 身份未就绪(缺 token)时, 去中心化直连无法定址, _bestWeb 顺次回落隧道 > 局域网 > Worker。
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
    "return { bestWeb: _bestWeb, bestPublic: _bestPublic, p2pWebUrl: _p2pWebUrl, P2P_WEB_DEFAULT: P2P_WEB_DEFAULT };\n" +
    "})";
  // eslint-disable-next-line no-eval
  return eval(factorySrc)(state);
}

let failures = 0;
function ok(c, msg) { if (c) console.log("  ok  - " + msg); else { failures++; console.error("  FAIL- " + msg); } }

const WORKER = "https://dao-relay-do.zhouyoukang.workers.dev";
const CF = "https://spots-vegetable-warehouse-vast.trycloudflare.com";
const SSH = "https://ssh-tunnel.example.net";
const ID = { session: "s1", token: "tok1" };   // 真实设备恒自带 session+token

// 场景1: 设备身份就绪 + Worker 连通 + cloudflared 也在 → 浏览器入口 = 去中心化 P2P 网控台(不经 Worker)。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web", "1 身份就绪: _bestWeb = p2p-web (去中心化首选)");
  ok(w.url.indexOf("cdn.jsdelivr.net") >= 0, "1 入口走 CDN 托管 p2p-client.html");
  ok(w.url.indexOf(".workers.dev") < 0, "1 入口完全不含 Worker 域名 (脱离 Worker 依赖)");
  ok(/auto=1/.test(w.url) && /session=s1/.test(w.url) && /token=tok1/.test(w.url), "1 链接自带 session+token+auto=1 (一开即直连)");
  // RPC/状态入口: 去中心化隧道优先于 Worker, 即便 Worker 在线。
  ok(mod.bestPublic().kind === "cloudflared", "1 _bestPublic = cloudflared (去中心化隧道优先于在线 Worker)");
}

// 场景2: 身份就绪 + Worker 掉线(connected:false) + cloudflared 在 → 网页直开仍恒去中心化 P2P。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: false, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  ok(mod.bestWeb().kind === "p2p-web", "2 Worker 掉线无影响: _bestWeb 恒 p2p-web (不依赖 Worker 在线)");
  ok(mod.bestPublic().kind === "cloudflared", "2 _bestPublic = cloudflared");
}

// 场景3: 身份就绪 + 只有 Worker (无隧道无局域网) → 网页直开仍走去中心化 CDN, 但 RPC 入口才兜底 Worker。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [] } });
  ok(mod.bestWeb().kind === "p2p-web", "3 只有 Worker: 网页直开仍 p2p-web (不经 Worker)");
  ok(mod.bestPublic().kind === "worker", "3 _bestPublic 才末位兜底 Worker (无去中心化隧道时)");
  ok(/末位兜底/.test(mod.bestPublic().label), "3 Worker 标注「末位兜底」(已下放)");
}

// 场景4: 自托管覆写 webConsoleBase → 直开走自有源 (更彻底去中心)。
{
  const SELF = "https://pages.example.dev/p2p.html";
  const mod = build({ conn: Object.assign({ url: WORKER, webConsoleBase: SELF }, ID), relay: { connected: true } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web" && w.url.indexOf(SELF) === 0, "4 webConsoleBase 覆写生效: 直开走自托管源");
}

// 场景5: 身份未就绪(缺 token) + cloudflared → p2p 无法定址, 回落 cloudflared 隧道根。
{
  const mod = build({ conn: { url: "", session: "s5" }, relay: { connected: false },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "cloudflared", "5 缺 token: 去中心化无法定址 → 回落 cloudflared");
  ok(mod.p2pWebUrl() === "", "5 _p2pWebUrl 缺 token 返回空 (不可定址)");
}

// 场景6: 缺 token + 无隧道, 仅 Worker → 末位兜底 Worker /console。
{
  const mod = build({ conn: { url: WORKER, session: "s6" }, relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [] } });
  const w = mod.bestWeb();
  ok(w.kind === "worker", "6 缺 token 且仅 Worker: 末位兜底 Worker /console");
  ok(w.url.indexOf("/console") >= 0, "6 兜底入口走 /console");
}

// 场景7: 缺 token + 无 Worker + 仅 SSH 隧道 → 退求 SSH (独立于 Cloudflare)。
{
  const mod = build({ conn: { url: "", session: "s7" }, relay: {},
    tunnel: { tunnels: [{ name: "ssh", url: SSH }] } });
  ok(mod.bestPublic().kind === "ssh", "7 仅 SSH: _bestPublic = ssh");
  ok(mod.bestWeb().kind === "ssh", "7 仅 SSH: _bestWeb 退求 ssh 隧道根");
}

// 场景8: 缺 token + 无 Worker + 无隧道, 仅局域网 → 退求 LAN。
{
  const mod = build({ conn: { url: "", session: "s8" }, relay: {}, tunnel: { tunnels: [] }, lan: { urls: ["http://192.168.1.9:9920"] } });
  ok(mod.bestWeb().kind === "lan", "8 仅局域网: 退求 LAN 直连");
}

// 场景9: 全空 → none。
{
  const mod = build({ conn: { url: "", session: "s9" }, relay: {}, tunnel: { tunnels: [] }, lan: { urls: [] } });
  ok(mod.bestWeb().kind === "none", "9 全无: kind=none");
}

if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
console.log("\n全部通过 ✓");
