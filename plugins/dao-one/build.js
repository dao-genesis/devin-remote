// 道 · 归一插件构建 — 从三个兄弟插件目录组装 vendor-* (gitignored 构建产物)
// 帛书·「大巧若拙」: 不重写逻辑,仅装配。三子模块正本仍在 plugins/{dao-vsix,
// dao-proxy-pro,rt-flow},此脚本把各自运行期文件拷进 dao-one/vendor-* 并转译 TS。
const fs = require("fs");
const path = require("path");

const root = __dirname;
const plugins = path.dirname(root); // plugins/
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
  let n = 0;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith(".ts")) continue;
    const code = fs.readFileSync(path.join(srcDir, f), "utf8");
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
  log("vendor-flow: copied extension.js + devin_cloud/web/git/stuck + py helpers + media");
}

// ── ④ dao-bridge (cf-daohub/dao-bridge-ext): 内网穿透独立大块 ──────────────────
//   复用「内穿插件最初始本体」(daoBridgeView 完整前端·cloudflared 管理·云/本 MD),
//   零前端重写, 作为归一容器第 ④ 入口。共享 ~/.dao/bin/cloudflared。
function buildBridge() {
  const srcRoot = path.join(plugins, "cf-daohub", "dao-bridge-ext");
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
