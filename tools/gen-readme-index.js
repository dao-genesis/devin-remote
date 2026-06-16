#!/usr/bin/env node
// 依据 modules.json + 各模块当前版本, 重新生成 README.md 里的「模块下载索引」表
// (位于 <!-- DAO-MODULE-INDEX:START --> 与 <!-- DAO-MODULE-INDEX:END --> 之间)。
// 每个 vsix 模块链接到它自己的 Release tag <key>-v<version> 与直链资产 —— 去中心化, 按模块发版。
// 环境: GITHUB_REPOSITORY=owner/repo (默认 zhouyoukang1234-spec/devin-remote)
// 退出码: 0=已写入(有/无变化都0); 打印 "changed" 或 "nochange"。
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "modules.json"), "utf8"));
const REPO = process.env.GITHUB_REPOSITORY || "zhouyoukang1234-spec/devin-remote";
const README = path.join(repoRoot, "README.md");
const START = "<!-- DAO-MODULE-INDEX:START -->";
const END = "<!-- DAO-MODULE-INDEX:END -->";

function row(m) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, m.dir, "package.json"), "utf8"));
  const ver = pkg.version;
  if (m.kind === "vsix") {
    const tag = `${m.key}-v${ver}`;
    const vsixName = `${m.name}-${ver}.vsix`;
    const rel = `https://github.com/${REPO}/releases/tag/${tag}`;
    const asset = `https://github.com/${REPO}/releases/download/${tag}/${vsixName}`;
    return `| **${m.key}** | \`${ver}\` | \`${m.extId}\` | ${m.desc} | [Release](${rel}) · [⬇ VSIX](${asset}) |`;
  }
  const dir = `https://github.com/${REPO}/tree/main/${m.dir}`;
  return `| **${m.key}** | \`${ver}\` | _(Worker)_ | ${m.desc} | [源码](${dir}) |`;
}

function build() {
  const lines = [];
  lines.push("| 模块 | 版本 | 扩展 id | 说明 | Release / 下载 |");
  lines.push("|---|---|---|---|---|");
  for (const m of reg.modules) lines.push(row(m));
  return lines.join("\n");
}

function main() {
  let txt = fs.readFileSync(README, "utf8");
  const table = build();
  const block = `${START}\n${table}\n${END}`;
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (!re.test(txt)) {
    console.error(`README 缺少索引标记 ${START} ... ${END}`);
    process.exit(2);
  }
  const next = txt.replace(re, block);
  if (next === txt) { console.log("nochange"); return; }
  fs.writeFileSync(README, next);
  console.log("changed");
}

main();
