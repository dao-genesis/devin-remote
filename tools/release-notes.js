#!/usr/bin/env node
// 单模块 Release 说明生成。用法: node tools/release-notes.js <key>
// 环境: GITHUB_REPOSITORY=owner/repo (默认 zhouyoukang1234-spec/devin-remote)
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "modules.json"), "utf8"));
const REPO = process.env.GITHUB_REPOSITORY || "zhouyoukang1234-spec/devin-remote";

const key = process.argv[2];
const m = reg.modules.find((x) => x.key === key);
if (!m) { console.error(`unknown module key: ${key}`); process.exit(1); }

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, m.dir, "package.json"), "utf8"));
const ver = pkg.version;
const tag = `${m.key}-v${ver}`;
const vsixName = `${m.name}-${ver}.vsix`;
const assetUrl = `https://github.com/${REPO}/releases/download/${tag}/${vsixName}`;

const out = [];
out.push(`# ${m.title} — v${ver}`);
out.push("");
out.push(m.desc);
out.push("");
out.push(`> 去中心化发版：本 Release 仅含 **${m.key}** 一个模块，独立于其它插件。开发此模块才会刷新本 Release，互不干扰。`);
out.push("");
if (m.kind === "vsix") {
  out.push("## 安装");
  out.push("");
  out.push("```bash");
  out.push(`# 下载 ${vsixName} 后:`);
  out.push(`devin-desktop --install-extension ${vsixName} --force   # 或 code --install-extension ...`);
  out.push("```");
  out.push("");
  out.push(`**下载**：[\`${vsixName}\`](${assetUrl}) · **扩展 id**：\`${m.extId}\``);
  out.push("");
}
// changelog 摘要(若有)
const cl = path.join(repoRoot, m.dir, "changelog.md");
if (fs.existsSync(cl)) {
  const txt = fs.readFileSync(cl, "utf8").split(/\r?\n/);
  const seg = [];
  let c = 0;
  for (const line of txt) {
    if (/^##\s/.test(line)) { c++; if (c === 2) break; }
    if (c >= 1) seg.push(line);
  }
  if (seg.length) {
    out.push("---");
    out.push("");
    out.push("## 最新变更");
    out.push("");
    out.push(seg.join("\n").trim());
    out.push("");
  }
}
process.stdout.write(out.join("\n") + "\n");
