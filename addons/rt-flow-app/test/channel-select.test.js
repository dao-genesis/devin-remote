"use strict";
// 实测 tunnel.html 的「公网入口选取」真代码 (切片 //__CHANSEL_START__…//__CHANSEL_END__ eval)。
// 本源契约 (道法自然·反则道之动也·分层收敛三难·永不 1033 死链):
//   物理边界: 设备本机无法既零账号又持久地当公网 HTTP 首字节宿主 (零账号快速隧道 trycloudflare 先天临时·
//     重启即换 URL → 卡片发出时活·对方打开时已死 = 1033 死链)。
//   收敛架构 (各取所长·分层):
//   ① 身份(session+token)就绪 → 网页直开(_bestWeb) 默认 = 持久去中心化引导宿主(Pages/IPFS·恒在线·永不
//      1033)开页, 链接只带稳定 session+token; 设备此刻活隧道作 &direct= 可选「直连提速」提示(活则提速·死也
//      不影响开页), 通信全程走 ntfy mesh。kind='p2p-web'。
//   ② 缺身份(无 session/token·无法 mesh 定址)时退化: 设备活隧道直供 console.html(cloudflared 主 > SSH 备)>
//      局域网 > Worker /console 末位。
//   ③ RPC/状态公网入口(_bestPublic) 不变: 去中心化隧道(cloudflared 主 > SSH 备)优先, Worker 末位兜底。
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

// 死宿主护栏: 默认首字节宿主必须是活的项目方 Pages, 绝不是已 404 的 hdougle (用户实测网页直开 404 之根因·防回归)。
{
  const mod0 = build({ conn: ID });
  ok(/zhouyoukang1234-spec\.github\.io/.test(mod0.P2P_WEB_DEFAULT), "0 默认首字节宿主 = 活的项目方 Pages (实测 200 text/html)");
  ok(mod0.P2P_WEB_DEFAULT.indexOf("hdougle.github.io") < 0, "0 默认首字节宿主绝不指向已 404 的 hdougle (网页直开报错之根因·防回归)");
}

// 场景1: 设备身份就绪 + Worker 连通 + cloudflared 也在 → 网页直开 = 持久去中心化引导宿主开页(永不 1033),
//        附设备活隧道作 &direct= 提速提示, 通信走 mesh。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web", "1 身份就绪+隧道在: _bestWeb = p2p-web (持久去中心化引导宿主开页·永不 1033)");
  ok(w.url.indexOf(mod.P2P_WEB_DEFAULT) === 0, "1 开页首字节走持久宿主 (恒在线·非临时隧道·永不 1033)");
  ok(w.url.indexOf("surge.sh") < 0, "1 不用 surge.sh (已被永久下架·HTTP 451)");
  ok(w.url.indexOf(".workers.dev") < 0, "1 开页入口完全不含 Worker 域名 (彻底脱离 Worker 依赖)");
  ok(/auto=1/.test(w.url) && /session=s1/.test(w.url) && /token=tok1/.test(w.url), "1 链接只带稳定 session+token+auto=1 (永不僵死)");
  ok(/[?&]direct=/.test(w.url), "1 附 &direct= 设备活隧道提速提示 (③ 加速层)");
  ok(decodeURIComponent(w.url).indexOf("trycloudflare.com") >= 0, "1 &direct 指向设备此刻活隧道 (活则直连提速)");
  ok(w.direct === CF, "1 web.direct = 设备活隧道 base");
  ok(/永不 1033/.test(w.label), "1 标签注明「永不 1033」(首字节来自持久宿主)");
  // RPC/状态入口: 去中心化隧道优先于 Worker, 即便 Worker 在线。
  ok(mod.bestPublic().kind === "cloudflared", "1 _bestPublic = cloudflared (去中心化隧道优先于在线 Worker)");
  // 当前生效通道: 身份就绪即路线C(ntfy mesh)恒为主路, 不经任何 Worker。
  const ac1 = mod.activeChannel();
  ok(mod.meshReady() === true, "1 _meshReady = true (session+token 就绪)");
  ok(ac1.kind === "mesh", "1 _activeChannel = mesh (去中心化为本·真·主路)");
  ok(ac1.decentralized === true && ac1.worker === false, "1 mesh 通道: decentralized 且非 Worker");
  ok(/不经任何 Worker/.test(ac1.label), "1 mesh 标签注明「不经任何 Worker」");
}

// 场景2: 身份就绪 + Worker 掉线(connected:false) + cloudflared 在 → 网页直开仍走持久宿主, &direct 仍指活隧道。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: false, activeUrl: WORKER },
    tunnel: { tunnels: [{ name: "cloudflared", url: CF }] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web", "2 Worker 掉线无影响: _bestWeb 恒走持久宿主开页 (不依赖 Worker 在线)");
  ok(/[?&]direct=/.test(w.url) && w.direct === CF, "2 仍附 &direct= 设备活隧道提速提示");
  ok(mod.bestPublic().kind === "cloudflared", "2 _bestPublic = cloudflared");
}

// 场景3: 身份就绪 + 只有 Worker (无隧道无局域网) → 网页直开走持久宿主开页(零 &direct·永不 1033), 不经 Worker。
{
  const mod = build({ conn: Object.assign({ url: WORKER }, ID), relay: { connected: true, activeUrl: WORKER },
    tunnel: { tunnels: [] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web", "3 无隧道无局域网: 网页直开走持久宿主开页 (去中心化·零 Worker·永不 1033)");
  ok(w.url.indexOf(".workers.dev") < 0, "3 开页入口仍完全不含 Worker 域名");
  ok(!/[?&]direct=/.test(w.url) && w.direct === "", "3 无活隧道 → 不附 &direct (仅 mesh 通信·照样开页连通)");
  ok(/永不 1033/.test(w.label), "3 标签注明「永不 1033」");
  ok(mod.bestPublic().kind === "worker", "3 _bestPublic 才末位兜底 Worker (无去中心化隧道时)");
  ok(/末位兜底/.test(mod.bestPublic().label), "3 Worker 标注「末位兜底」(已下放)");
  // 当前生效通道仍是 mesh (设备 serve 常驻·不经 Worker); httpBase 不落 Worker。
  const ac3 = mod.activeChannel();
  ok(ac3.kind === "mesh", "3 _activeChannel 仍 mesh (身份就绪·HTTP 仅剩 Worker 不影响主路)");
  ok(ac3.worker === false && ac3.httpBase === "", "3 mesh 主路 worker:false 且 httpBase 不回落 Worker");
}

// 场景4: 自托管覆写 webConsoleBase + 无隧道 → 开页走自有持久源 (更彻底去中心·永不 1033)。
{
  const SELF = "https://pages.example.dev/p2p.html";
  const mod = build({ conn: Object.assign({ url: WORKER, webConsoleBase: SELF }, ID), relay: { connected: true },
    tunnel: { tunnels: [] } });
  const w = mod.bestWeb();
  ok(w.kind === "p2p-web" && w.url.indexOf(SELF) === 0, "4 无隧道时 webConsoleBase 覆写生效: 开页走自托管持久源");
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
