"use strict";
// 源级护栏: 网页外壳 console.html 工具栏与手机 APK MainActivity 对齐。
// 手机版: 第一行 [≡ 地址 ▼下拉 →], 第二行(可收起) [🔍 缩放 收藏·译·刷新·下载·备份]。
// 无框架: node test/console-toolbar.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "console.html");
const src = fs.readFileSync(HTML, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// 第一行: 地址栏后是「▼ 下拉开关 toolToggle」, 不再是「译」。
ok(/id="addr"[\s\S]{0,120}id="toolToggle"[\s\S]{0,80}id="go"/.test(src),
   "第一行: 地址栏 → 下拉开关 toolToggle(▼) → 前往(译已迁出第一行)");
ok(/<button id="toolToggle"/.test(src),
   "存在第一行下拉开关 toolToggle(与手机 APK 同款)");

// 第二行: 译 已迁入, 位于 收藏(starBtn) ↔ 刷新(reload) 之间。
ok(/id="starBtn"[\s\S]{0,120}id="trBtn"[\s\S]{0,120}id="reload"/.test(src),
   "第二行: 收藏 → 译 → 刷新(译已迁入第二行·夹在收藏与刷新之间)");
ok(/<button id="trBtn" class="act"/.test(src),
   "译按钮位于第二行动作键组(class=act)");

// 第二行可收起(与 toolToggle 联动)。
ok(/#bar2\.collapsed\{display:none\}/.test(src),
   "第二行 #bar2 支持 collapsed 收起样式");
ok(/rtflow\.console\.bar2Collapsed/.test(src),
   "下拉收起/展开状态持久化(localStorage)");

if (fails) { console.error("\n工具栏对齐护栏: " + fails + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
