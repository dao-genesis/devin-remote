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
  let patchText = null, applyOverlay = null;
  if (fs.existsSync(overlayPatch)) {
    applyOverlay = require("./apply-overlay").applyUnifiedDiff;
    patchText = fs.readFileSync(overlayPatch, "utf8");
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
      log("vendor-vsix: applied proxy-fold.patch + folded getProxyPanel into noAuthNeeded (三合一叠加)");
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

buildVsix();
buildProxy();
buildFlow();
buildBridge();
log("done · vendor-vsix / vendor-proxy / vendor-flow / vendor-bridge assembled");
