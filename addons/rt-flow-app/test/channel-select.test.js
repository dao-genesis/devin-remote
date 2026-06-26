"use strict";
// 实测 tunnel.html 的「公网入口选取」真代码 (切片 //__CHANSEL_START__…//__CHANSEL_END__ eval)。
// 本源契约 (道法自然·去中心化为本·设备自托管为根, 第三方宿主/账号/Worker 皆仅可选兜底):
//   ① 网页直开入口(_bestWeb) 首选「设备自带零账号隧道」(cloudflared 主 > SSH 备) 直供本机 console.html ——
//      网页与控制同源、同走设备自己的隧道, 不经任何第三方静态宿主/账号/Worker。这是根方案·默认。
//   ② 次选局域网直连; ③ 再次「去中心化 P2P 网控台」(公共静态宿主 + 公共 ntfy mesh + WebRTC·零 Worker·
//      可选兜底·URL 稳定兼顾持久); ④ 末位才回落中继 Worker /console。
//   ⑤ RPC/状态公网入口(_bestPublic) 同理: 去中心化隧道(cloudflared 主 > SSH 备)优先, Worker 末位兜底。
// 无框架: node test/channel-select.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "tunnel.html");
const src = fs.readFileSync(HTML, "utf8");
const m = src.match(/\/\/__CHANSEL_START__[\s\S]*?\/\/__CHANSEL_END__/);
if (!m) { console.error("FAIL: 未找到 //__CHANSEL_START__…//__CHANSEL_END__ 标记块"); process.exit(1); }
const sliced = m[0];

// 注入 mock 的 _conn/_relay/_tunnel/_lan/_webConsoleUrl, 让切片在隔离环境跑。
// _webConsoleUrl mock 镜像真码: 设备隧道/局域网入口取 origin+"/"(LocalServer 在 / 与 /console.html 皆服务
//   console.html), Worker 入口取 /console; withTok 时附 token+auto=1 (一开即自动直连)。
function build(state) {
  const factorySrc = "(function(env){\n" +
    "function _conn(){ return env.conn||{}; }\n" +
    "function _relay(){ return env.relay||{}; }\n" +
    "function _tunnel(){ return env.tunnel||{}; }\n" +
    "function _lan(){ return env.lan||{}; }\n" +
    "function _webConsoleUrl(base, withTok){ var c=_conn(); var isRelay=/\\.workers\\.dev/.test(base); var qs='?session='+(c.session||''); if(withTok){ qs+='&token='+(c.token||'')+'&auto=1'; } return base+(isRelay?'/console':'/')+qs; }\n" +
    sliced + "\n" +
    "return { bestWeb: _bestWeb, bestPublic: _bestPublic, p2pWebUrl: _p2pWebUrl, P2P_WEB_DEFAULT: P2P_WEB_DEFAULT, meshReady: _meshReady, activeChannel: _activeChannel };\n" +
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

// 场景1: 设备身份就绪 + Worker 连通 + cloudflared 也在 → 网页直开 = 设备自带隧道·自托管 console.html(根方案首选)。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "cloudflared", "1 身份就绪+隧道在: _bestWeb = cloudflared (设备自带隧道·自托管·根方案首选)");
  ok(w.url.indexOf("trycloudflare.com") >= 0, "1 入口走设备自带零账号隧道域 (本机自托管 console.html·不经任何第三方宿主)");
  ok(w.url.indexOf("github.io") < 0, "1 首选不再走 GitHub Pages (第三方账号宿主降为可选兜底·非默认根)");
  ok(w.url.indexOf("surge.sh") < 0, "1 不用 surge.sh (已被永久下架·HTTP 451·返回 Unavailable)");
  ok(w.url.indexOf(".workers.dev") < 0, "1 入口完全不含 Worker 域名 (彻底脱离 Worker 依赖)");
  ok(/auto=1/.test(w.url) && /session=s1/.test(w.url) && /token=tok1/.test(w.url), "1 链接自带 session+token+auto=1 (一开即直连)");
  ok(/不经任何第三方宿主/.test(w.label), "1 标签注明「不经任何第三方宿主」(设备自托管)");
  // RPC/状态入口: 去中心化隧道优先于 Worker, 即便 Worker 在线。
  ok(mod.bestPublic().kind === "cloudflared", "1 _bestPublic = cloudflared (去中心化隧道优先于在线 Worker)");
  // 当前生效通道: 身份就绪即路线C(ntfy mesh)恒为主路, 不经任何 Worker。
  const ac1 = mod.activeChannel();
  ok(mod.meshReady() === true, "1 _meshReady = true (session+token 就绪)");
  ok(ac1.kind === "mesh", "1 _activeChannel = mesh (去中心化为本·真·主路)");
  ok(ac1.decentralized === true && ac1.worker === false, "1 mesh 通道: decentralized 且非 Worker");
  ok(/不经任何 Worker/.test(ac1.label), "1 mesh 标签注明「不经任何 Worker」");
}

// 场景2: 身份就绪 + Worker 掉线(connected:false) + cloudflared 在 → 网页直开仍恒走设备自带隧道。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: false, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  ok(mod.bestWeb().kind === "cloudflared", "2 Worker 掉线无影响: _bestWeb 恒走设备自带隧道 (不依赖 Worker 在线)");
  ok(mod.bestPublic().kind === "cloudflared", "2 _bestPublic = cloudflared");
}

// 场景3: 身份就绪 + 只有 Worker (无隧道无局域网) → 网页直开回落「去中心化 P2P 网控台」(公共静态宿主·零 Worker),
//        而非中继 Worker; RPC 入口才末位兜底 Worker。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web", "3 无隧道无局域网: 网页直开回落 p2p-web (去中心化·零 Worker 兜底·非中继 Worker)");
  ok(w.url.indexOf(".workers.dev") < 0, "3 兜底入口仍完全不含 Worker 域名");
  ok(/可选兜底/.test(w.label), "3 p2p-web 标注「可选兜底」(非默认根)");
  ok(mod.bestPublic().kind === "worker", "3 _bestPublic 才末位兜底 Worker (无去中心化隧道时)");
  ok(/末位兜底/.test(mod.bestPublic().label), "3 Worker 标注「末位兜底」(已下放)");
  // 当前生效通道仍是 mesh (设备 serve 常驻·不经 Worker); httpBase 不落 Worker。
  const ac3 = mod.activeChannel();
  ok(ac3.kind === "mesh", "3 _activeChannel 仍 mesh (身份就绪·HTTP 仅剩 Worker 不影响主路)");
  ok(ac3.worker === false && ac3.httpBase === "", "3 mesh 主路 worker:false 且 httpBase 不回落 Worker");
}

// 场景4: 自托管覆写 webConsoleBase + 无隧道 → 直开走自有源 (更彻底去中心)。
{
  const SELF = "https://pages.example.dev/p2p.html";
  const mod = build({ conn: Object.assign({ url: WORKER, webConsoleBase: SELF }, ID), relay: { connected: true },
    tunnel: { tunnels: [] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web" && w.url.indexOf(SELF) === 0, "4 无隧道时 webConsoleBase 覆写生效: 直开走自托管源");
}

// 场景5: 身份未就绪(缺 token) + cloudflared → 仍首选设备自带隧道根 (隧道为根·不依赖身份定址)。
{
  const mod = build({ conn: { url: "", session: "s5" }, relay: { connected: false },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "cloudflared", "5 缺 token: _bestWeb 仍首选 cloudflared (设备自带隧道为根)");
  ok(mod.p2pWebUrl() === "", "5 _p2pWebUrl 缺 token 返回空 (去中心化 P2P 兜底需 token 定址)");
  ok(mod.meshReady() === false, "5 _meshReady = false (缺 token)");
  const ac5 = mod.activeChannel();
  ok(ac5.kind === "cloudflared" && ac5.decentralized === true, "5 _activeChannel = cloudflared (去中心化·非 Worker)");
}

// 场景6: 缺 token + 无隧道, 仅 Worker → 网页直开末位兜底 Worker /console (p2p 缺 token 不可定址)。
{
  const mod = build({ conn: { url: WORKER, session: "s6" }, relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [] } });
  const w = mod.bestWeb();
  ok(w.kind === "worker", "6 缺 token 且仅 Worker: 末位兜底 Worker /console");
  ok(w.url.indexOf("/console") >= 0, "6 兜底入口走 /console");
}

// 场景7: 缺 token + 无 Worker + 仅 SSH 隧道 → 设备自带 SSH 隧道 (独立于 Cloudflare)。
{
  const mod = build({ conn: { url: "", session: "s7" }, relay: {},
    tunnel: { tunnels: [{ name: "ssh", url: SSH }] } });
  ok(mod.bestPublic().kind === "ssh", "7 仅 SSH: _bestPublic = ssh");
  ok(mod.bestWeb().kind === "ssh", "7 仅 SSH: _bestWeb 走设备自带 SSH 隧道根");
}

// 场景8: 缺 token + 无 Worker + 无隧道, 仅局域网 → 退求 LAN (亦本机自托管)。
{
  const mod = build({ conn: { url: "", session: "s8" }, relay: {}, tunnel: { tunnels: [] }, lan: { urls: ["http://192.168.1.9:9920"] } });
  ok(mod.bestWeb().kind === "lan", "8 仅局域网: 退求 LAN 直连(本机自托管)");
}

// 场景9: 全空 → none。
{
  const mod = build({ conn: { url: "", session: "s9" }, relay: {}, tunnel: { tunnels: [] }, lan: { urls: [] } });
  ok(mod.bestWeb().kind === "none", "9 全无: kind=none");
}

if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
console.log("\n全部通过 ✓");
