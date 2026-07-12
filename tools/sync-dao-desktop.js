// 道 · 同步 dao-desktop (Devin Desktop 插件版) 快照 → addons/dao-desktop
// ─────────────────────────────────────────────────────────────────────────────
// 本源在兄弟仓 windsurf-assistant/plugins/dao-desktop (Cascade 三模式面板 + 官方
// LS 桥 + windsurf-shim)。本脚本把其运行期文件快照进本仓 addons/dao-desktop/,
// 供 dao-one 构建期折入 vendor-desktop(归一版内的 Cascade 引擎)。
// 用法: node tools/sync-dao-desktop.js [源仓路径]
//   默认源: ../windsurf-assistant/plugins/dao-desktop (相对本仓根)
const fs = require("fs");
const path = require("path");

const repoRoot = path.dirname(__dirname);
const src =
  process.argv[2] ||
  path.join(path.dirname(repoRoot), "windsurf-assistant", "plugins", "dao-desktop");
const dst = path.join(repoRoot, "addons", "dao-desktop");
const log = (m) => console.log("[sync-dao-desktop] " + m);

if (!fs.existsSync(path.join(src, "extension.js"))) {
  console.error("[sync-dao-desktop] 源缺失: " + src);
  process.exit(1);
}

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name);
    const dp = path.join(d, e.name);
    if (e.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

// 只快照运行期必需件 (不带 vsix 产物 / test / scripts / build.js)
const FILES = ["extension.js", "windsurf-shim.js", "package.json", "README.md"];
const DIRS = ["dao-cascade", "media"];

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of FILES)
  if (fs.existsSync(path.join(src, f)))
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
for (const d of DIRS)
  if (fs.existsSync(path.join(src, d))) copyDir(path.join(src, d), path.join(dst, d));

fs.writeFileSync(
  path.join(dst, "SOURCE.md"),
  "# 快照说明\n\n本目录是 dao-genesis/windsurf-assistant `plugins/dao-desktop` 的运行期快照,\n供 `core/dao-one` 构建期折入 vendor-desktop。**不要在此直接改业务代码** —\n改本源仓后重跑 `node tools/sync-dao-desktop.js` 重新快照。\n\n- 快照时间: " +
    new Date().toISOString() +
    "\n- 源版本: " +
    (JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version || "?") +
    "\n",
);
log("done → " + dst);
