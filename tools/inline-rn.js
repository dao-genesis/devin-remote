#!/usr/bin/env node
/* 把 engine/__rn.js 内联进 engine/console.html 的 <script type="text/plain" id="__rnsrc"> 块。
 * 缘由: 控台经中继 Worker 取自 GitHub main(worker.js 的 /console), 内联后 __rn.js 随控台一并下发,
 *       用户无需安装新 APK 即可获得最新 remote-native 垫片。__rn.js 仍是唯一真源, 本块为其生成副本。
 * 用法: node tools/inline-rn.js        # 写入
 *       node tools/inline-rn.js --check # 仅校验是否同步(CI/自检用), 不一致则退出码 1
 */
const fs = require("fs");
const path = require("path");
const ENG = path.join(__dirname, "..", "addons", "rt-flow-app", "app", "src", "main", "assets", "engine");
const RN = path.join(ENG, "__rn.js");
const CONSOLE = path.join(ENG, "console.html");
const OPEN = '<script type="text/plain" id="__rnsrc">';
const CLOSE = "</script>";

function build() {
  const rn = fs.readFileSync(RN, "utf8");
  if (rn.indexOf("</script") !== -1) { console.error("[inline-rn] __rn.js contains </script — cannot inline safely"); process.exit(2); }
  let html = fs.readFileSync(CONSOLE, "utf8");
  const i = html.indexOf(OPEN);
  if (i < 0) { console.error("[inline-rn] placeholder block not found in console.html"); process.exit(2); }
  const j = html.indexOf(CLOSE, i + OPEN.length);
  if (j < 0) { console.error("[inline-rn] unterminated placeholder block"); process.exit(2); }
  const next = html.slice(0, i + OPEN.length) + "\n" + rn.trimEnd() + "\n" + html.slice(j);
  return { html, next, current: html.slice(i + OPEN.length, j), rn };
}

const { html, next } = build();
if (process.argv.indexOf("--check") !== -1) {
  if (html !== next) { console.error("[inline-rn] console.html __rnsrc is STALE — run: node tools/inline-rn.js"); process.exit(1); }
  console.log("[inline-rn] in sync"); process.exit(0);
}
if (html === next) { console.log("[inline-rn] already up to date"); process.exit(0); }
fs.writeFileSync(CONSOLE, next);
console.log("[inline-rn] inlined __rn.js into console.html (" + Buffer.byteLength(next) + " bytes)");
