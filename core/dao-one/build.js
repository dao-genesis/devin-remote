// 道 · 归一插件构建 — 从兄弟插件目录组装 vendor-* (gitignored 构建产物)
// 帛书·「大巧若拙」: 不重写逻辑,仅装配。源本仍在 core/{dao-vsix,dao-proxy-pro,
// rt-flow} 与 addons/dao-bridge,此脚本把各自运行期文件拷进 dao-one/vendor-* 并转译 TS。
const fs = require("fs");
const path = require("path");

const root = __dirname;
const plugins = path.dirname(root); // 现为 core/ (dao-vsix/dao-proxy-pro/rt-flow 同级)
const addonsDir = path.join(path.dirname(plugins), "addons"); // 辅助插件 (dao-bridge)
const log = (m) => console.log("[dao-one build] " + m);

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// ── ① dao-vsix: 转译 TS → vendor-vsix/out/extension.js + 拷 media ──────────────
function buildVsix() {
  const srcRoot = path.join(plugins, "dao-vsix");
  const dst = path.join(root, "vendor-vsix");
  rmrf(dst);
  const { transform } = require("sucrase");
  const srcDir = path.join(srcRoot, "src");
  const outDir = path.join(dst, "out");
  fs.mkdirSync(outDir, { recursive: true });
  // 归·② Proxy Pro 叠加: dao-vsix 源回归二合一(无 proxy); 三合一仅由 dao-one
  // 在构建期把 proxy-fold.patch 叠到 extension.ts 副本上再转译 → vendor-vsix 含 Proxy 板。
  // 帛·「巧拙可伏藏」: 源洁, 合于 dao-one 时方现第三板。
  const overlayPatch = path.join(root, "proxy-fold.patch");
  // 归一·③ Windows 总控: 同理另叠 windows-fold.patch (汉堡面板单页 Windows 板块 + 后端 win* 处理器)。
  const winPatch = path.join(root, "windows-fold.patch");
  let patchText = null, applyOverlay = null, winPatchText = null;
  if (fs.existsSync(overlayPatch)) {
    applyOverlay = require("./apply-overlay").applyUnifiedDiff;
    patchText = fs.readFileSync(overlayPatch, "utf8");
  }
  if (fs.existsSync(winPatch)) {
    applyOverlay = applyOverlay || require("./apply-overlay").applyUnifiedDiff;
    winPatchText = fs.readFileSync(winPatch, "utf8");
  }
  let n = 0;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith(".ts")) continue;
    let code = fs.readFileSync(path.join(srcDir, f), "utf8");
    if (patchText && f === "extension.ts") {
      code = applyOverlay(code, patchText);
      // 归一·② noAuthNeeded 是高频改动行(每加一条命令就变长) → 整行 diff 必朽。
      // 改为幂等 token 注入: 确保免登白名单含 'getProxyPanel'(已含则不动), 与行漂移无关。
      code = code.replace(
        /(const\s+noAuthNeeded\s*=\s*\[[^\]]*?)(\s*\]\s*;)/,
        (m, head, tail) =>
          head.includes("'getProxyPanel'") ? m : head + ", 'getProxyPanel'" + tail,
      );
      // 归一·② Proxy Pro 独立子网页(汉堡列表/主页按钮): 把 'proxy' 折入 solo 白名单 →
      //   getDaoCloudMiddlePanelHtml(st,'proxy') 进单板块模式(隐左导航·只渲 Proxy 面板),
      //   与其它六大板块「分而治之·平级并排」完全一致。dao-vsix 源保持纯二合一(无 proxy)。
      code = code.replace(
        /(const\s+_solo\s*=\s*\[)([^\]]*?)(\]\s*\.includes)/,
        (m, head, body, tail) =>
          body.includes("'proxy'") ? m : head + body + ", 'proxy'" + tail,
      );
      // 归一·② Proxy Pro 是面板板块而非数据 tab: reloadActiveDataTab 若对其发
      // loadTabData, 宿主必回 'Unknown tab' 并把三模块面板覆写成错误页(实测·solo 板块
      // init 广播即触发) → 把 'proxy' 折入其面板板块早退清单, 与 bridge/backups 等面板板块同列。
      if (!/reloadActiveDataTab\(\)\{[\s\S]{0,120}?t==='proxy'/.test(code)) {
        code = code.replace(
          /(function reloadActiveDataTab\(\)\{\s*var t=S\.tab;\s*if\()/,
          "$1t==='proxy'||",
        );
      }
      log("vendor-vsix: applied proxy-fold.patch + folded getProxyPanel/noAuthNeeded + 'proxy' into _solo/reloadActiveDataTab (三合一叠加)");
    }
    // 归一·③ Windows 总控叠加 (在 proxy-fold 之后叠, 上下文级匹配抗行漂移)。
    if (winPatchText && f === "extension.ts") {
      code = applyOverlay(code, winPatchText);
      // win* 命令并入免登白名单 (与 bridgeHealth/bridgeExec 同列, 桥面板命令均免登)。
      code = code.replace(
        /(const\s+noAuthNeeded\s*=\s*\[[^\]]*?)(\s*\]\s*;)/,
        (m, head, tail) =>
          head.includes("'winStatus'") ? m : head + ", 'winStatus', 'winExec', 'winScreenshot'" + tail,
      );
      // 'windows' 折入 solo 白名单 (汉堡列表点开即独立子网页·隐左导航)。
      code = code.replace(
        /(const\s+_solo\s*=\s*\[)([^\]]*?)(\]\s*\.includes)/,
        (m, head, body, tail) =>
          body.includes("'windows'") ? m : head + body + ", 'windows'" + tail,
      );
      // 'windows' 是面板板块而非数据 tab → 折入 reloadActiveDataTab / renderCredLimited 早退清单,
      //   与 bridge/backups/github 同列, 避免 init 广播触发 loadTab('windows') 被宿主回 'Unknown tab'。
      code = code.replace(/t==='github'\)return;/g, (m) => m.includes("windows") ? m : "t==='github'||t==='windows')return;");
      log("vendor-vsix: applied windows-fold.patch + folded win*/noAuthNeeded + 'windows' into _solo/reloadActiveDataTab (Windows 总控叠加)");
    }
    const res = transform(code, {
      transforms: ["typescript", "imports"],
      filePath: path.join(srcDir, f),
    });
    fs.writeFileSync(path.join(outDir, f.replace(/\.ts$/, ".js")), res.code);
    n++;
  }
  // media (dao-rules.md 等) — 锚在 vendor-vsix/media (与 out/.. 同级,符合代码 fallback)
  if (fs.existsSync(path.join(srcRoot, "media")))
    copyDir(path.join(srcRoot, "media"), path.join(dst, "media"));
  // package.json (供子模块自身按需读取版本) — 放 vendor-vsix 根,使 __dirname/../package.json 命中
  copyFile(path.join(srcRoot, "package.json"), path.join(dst, "package.json"));
  log("vendor-vsix: transpiled " + n + " ts file(s)");
}

// ── ② dao-proxy-pro: 整目录拷贝(extension.js + vendor/ + media + acp 代理) ───────
function buildProxy() {
  const srcRoot = path.join(plugins, "dao-proxy-pro");
  const dst = path.join(root, "vendor-proxy");
  rmrf(dst);
  const files = [
    "extension.js",
    "dao-acp-stdio-proxy.js",
    "package.json",
  ];
  for (const f of files)
    if (fs.existsSync(path.join(srcRoot, f)))
      copyFile(path.join(srcRoot, f), path.join(dst, f));
  for (const d of ["media", "vendor"])
    if (fs.existsSync(path.join(srcRoot, d)))
      copyDir(path.join(srcRoot, d), path.join(dst, d));
  log("vendor-proxy: copied extension.js + vendor/ + media");
}

// ── ③ rt-flow: 拷 extension.js + 底层 js + python helper + media ───────────────
function buildFlow() {
  const srcRoot = path.join(plugins, "rt-flow");
  const dst = path.join(root, "vendor-flow");
  rmrf(dst);
  const files = [
    "extension.js",
    "devin_cloud.js",
    "devin_proxy.js",
    "devin_web.js",
    "devin_git.js",
    "dao_stuck.js",
    "_vscdb_helper.py",
    "_vscdb_inject_helper.py",
    "package.json",
  ];
  for (const f of files)
    if (fs.existsSync(path.join(srcRoot, f)))
      copyFile(path.join(srcRoot, f), path.join(dst, f));
  if (fs.existsSync(path.join(srcRoot, "media")))
    copyDir(path.join(srcRoot, "media"), path.join(dst, "media"));
  // 归一·② Proxy Pro 折入统一外壳 (rt-flow 源保持纯净·仅 dao-one 构建期幂等注入):
  //   ① 汉堡菜单 PAGES 增一条「Proxy Pro」→ board:proxy (与六大板块同级·点开即独立子网页)。
  //   ② BOARD_META 补 proxy 标签, 使该 solo 子网页标题/图标与其它板块一致。
  //   二合一独立版(纯 rt-flow)永不出现此入口 → 「为变所适·完全整合」。
  const flowExt = path.join(dst, "extension.js");
  if (fs.existsSync(flowExt)) {
    let flow = fs.readFileSync(flowExt, "utf8");
    let touched = false;
    if (!/proxy:\[/.test(flow)) {
      flow = flow.replace(
        /(var BOARD_META=\{[^}]*?)(\};)/,
        (m, head, tail) => head.includes("proxy:") ? m : (touched = true, head + ",proxy:['🔀','Proxy Pro']" + tail),
      );
    }
    if (!flow.includes("board:proxy")) {
      flow = flow.replace(
        /(\['🧩','MCP 服务器','board:mcp'\],)/,
        (m) => (touched = true, m + "['🔀','Proxy Pro · 本源观照 / 渠道配置 / 模型路由','board:proxy'],"),
      );
    }
    // 归一·③ Windows 总控: 同法折入汉堡 PAGES + BOARD_META (源纯净·仅 dao-one 构建期幂等注入)。
    if (!/windows:\[/.test(flow)) {
      flow = flow.replace(
        /(var BOARD_META=\{[^}]*?)(\};)/,
        (m, head, tail) => head.includes("windows:") ? m : (touched = true, head + ",windows:['🪟','Windows 总控']" + tail),
      );
    }
    if (!flow.includes("board:windows")) {
      flow = flow.replace(
        /(\['🌐','公网穿透 · DAO Bridge','board:bridge'\],)/,
        (m) => (touched = true, m + "['🪟','Windows 总控 · 整机信息/工具清单/桥·MCP/密钥·资源/截屏·执行','board:windows'],"),
      );
    }
    if (touched) fs.writeFileSync(flowExt, flow);
    log("vendor-flow: folded Proxy Pro + Windows 总控 into PAGES(汉堡)+BOARD_META (叠加·源纯净)" + (touched ? "" : " · 已存在跳过"));
  }
  log("vendor-flow: copied extension.js + devin_cloud/proxy/web/git/stuck + py helpers + media");
}

// ── ④ dao-bridge (dao-bridge/dao-bridge-ext): 内网穿透独立大块 ──────────────────
//   复用「内穿插件最初始本体」(daoBridgeView 完整前端·cloudflared 管理·云/本 MD),
//   零前端重写, 作为归一容器第 ④ 入口。共享 ~/.dao/bin/cloudflared。
function buildBridge() {
  const srcRoot = path.join(addonsDir, "dao-bridge", "dao-bridge-ext");
  const dst = path.join(root, "vendor-bridge");
  rmrf(dst);
  if (!fs.existsSync(path.join(srcRoot, "extension.js"))) {
    log("vendor-bridge: SKIP (源缺失 " + srcRoot + ")");
    return;
  }
  for (const f of ["extension.js", "package.json"])
    if (fs.existsSync(path.join(srcRoot, f)))
      copyFile(path.join(srcRoot, f), path.join(dst, f));
  for (const d of ["media", "bin"])
    if (fs.existsSync(path.join(srcRoot, d)))
      copyDir(path.join(srcRoot, d), path.join(dst, d));
  log("vendor-bridge: copied extension.js + media (内网穿透本体)");
}

// 注: Devin Desktop 插件版(dao-desktop/Cascade)归 WinSurf System 仓统一插件处理,
// dao-one 只装配 dao-vsix(二合一) + Proxy Pro —— 不再 vendor dao-desktop。

// ── ⑤ 折叠自验 (通用适配体系·防上游漂移): 上游任一插件更新后, 仅需重跑
//   node build.js — 所有折叠锚点逐一断言, 缺一即构建失败并指名道姓,
//   使 dao-vsix / rt-flow / dao-proxy-pro 的更新可以「拿来即折·折错即报」。
function verifyFolds() {
  const must = (file, tokens) => {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) throw new Error("[fold-verify] missing " + file);
    const c = fs.readFileSync(p, "utf8");
    for (const t of tokens)
      if (!c.includes(t))
        throw new Error("[fold-verify] " + file + " 缺折叠锚点: " + t);
  };
  must("vendor-vsix/out/extension.js", [
    "data-tab=\"proxy\"",          // 主页全能面板左栏 · Proxy Pro 第7板块入口
    "id=\"v-proxy\"",              // 主页内嵌容器
    "function rProxyFull",          // 主页内嵌渲染
    "function rProxyResult",
    "__proxyFetchReq",              // 子帧 fetch 桥
    "'getProxyPanel'",              // 免登白名单
    "'proxy'",                      // _solo 白名单 (独立子网页模式)
    "t==='proxy'||",                // reloadActiveDataTab 面板板块早退
  ]);
  must("vendor-vsix/out/extension.js", [
    "data-tab=\"windows\"",        // 归一·③ Windows 总控 · 左栏第8板块入口
    "id=\"v-windows\"",            // Windows 单页容器
    "function rWindowsFull",        // Windows 单页渲染
    "function rWindowsResult",
    "function winBridgeApi",        // 后端 · 桥直连(cf-hub-conn.json 端口/令牌)
    "case 'winStatus'",             // 后端 · 整机信息(桥 /api/health + sysinfo)
    "case 'winExec'",               // 后端 · 整机执行
    "case 'winScreenshot'",         // 后端 · 整机截屏
    "'winStatus'",                  // 免登白名单
    "'windows'",                    // _solo 白名单 / 早退清单
    "t==='windows')return;",        // reloadActiveDataTab/renderCredLimited 面板板块早退
  ]);
  must("vendor-flow/extension.js", [
    "board:proxy",                  // 汉堡菜单 PAGES 入口
    "proxy:['🔀','Proxy Pro']",     // BOARD_META 标签
    "board:windows",                // 归一·③ Windows 汉堡菜单入口
    "windows:['🪟','Windows 总控']", // BOARD_META 标签
  ]);
  must("vendor-proxy/extension.js", ["getEaConfigHtml"]);
  log("fold-verify: 全部折叠锚点在位 ✓ (vendor-vsix ×19 · vendor-flow ×4 · vendor-proxy ×1)");
}

buildVsix();
buildProxy();
buildFlow();
buildBridge();
verifyFolds();
log("done · vendor-vsix / vendor-proxy / vendor-flow / vendor-bridge assembled");
