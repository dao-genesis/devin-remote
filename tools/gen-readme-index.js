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

// APK 模块(gradle)的版本取自 app/build.gradle 的 versionName，其余取自 package.json。
function moduleVersion(m) {
  if (m.kind === "apk") {
    const gradle = fs.readFileSync(path.join(repoRoot, m.dir, "app", "build.gradle"), "utf8");
    const mt = gradle.match(/versionName\s+["']([^"']+)["']/);
    if (!mt) throw new Error(`无法从 ${m.dir}/app/build.gradle 解析 versionName`);
    return mt[1];
  }
  return JSON.parse(fs.readFileSync(path.join(repoRoot, m.dir, "package.json"), "utf8")).version;
}

function row(m) {
  const ver = moduleVersion(m);
  if (m.kind === "vsix") {
    const tag = `${m.key}-v${ver}`;
    const vsixName = `${m.name}-${ver}.vsix`;
    const rel = `https://github.com/${REPO}/releases/tag/${tag}`;
    const asset = `https://github.com/${REPO}/releases/download/${tag}/${vsixName}`;
    return `| **${m.key}** | \`${ver}\` | \`${m.extId}\` | ${m.desc} | [Release](${rel}) · [⬇ VSIX](${asset}) |`;
  }
  if (m.kind === "apk") {
    const tag = `${m.releaseTagPrefix}-v${ver}`;
    const assetName = (m.assetName || `${m.name}-${ver}.apk`).replace("{version}", ver);
    const rel = `https://github.com/${REPO}/releases/tag/${tag}`;
    const asset = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`;
    return `| **${m.key}** | \`${ver}\` | \`${m.extId}\` _(APK)_ | ${m.desc} | [Release](${rel}) · [⬇ APK](${asset}) |`;
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

// 主页置顶「直接下载 APK」链接 —— 随手机版版本自动保持最新。
const APK_START = "<!-- DAO-APK-LINK:START -->";
const APK_END = "<!-- DAO-APK-LINK:END -->";
function apkLinkLine() {
  const m = reg.modules.find((x) => x.kind === "apk");
  if (!m) return "";
  const ver = moduleVersion(m);
  const tag = `${m.releaseTagPrefix}-v${ver}`;
  const assetName = (m.assetName || `${m.name}-${ver}.apk`).replace("{version}", ver);
  const asset = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`;
  return `**📱 Devin Cloud 手机版 · 直接下载 APK**（安卓本体，辅助 ②）：[⬇ DevinCloud-mobile-v${ver}.apk](${asset}) · 下载后允许「安装未知应用」即可装。`;
}

function replaceBlock(txt, start, end, inner, label) {
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(txt)) {
    console.error(`README 缺少${label}标记 ${start} ... ${end}`);
    process.exit(2);
  }
  return txt.replace(re, `${start}\n${inner}\n${end}`);
}

function main() {
  let txt = fs.readFileSync(README, "utf8");
  const orig = txt;
  txt = replaceBlock(txt, START, END, build(), "索引");
  txt = replaceBlock(txt, APK_START, APK_END, apkLinkLine(), "APK 直链");
  if (txt === orig) { console.log("nochange"); return; }
  fs.writeFileSync(README, txt);
  console.log("changed");
}

main();
