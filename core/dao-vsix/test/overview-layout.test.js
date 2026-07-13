// overview-layout.test.js · 源级护栏: 主页(overview)响应式多列布局。
//
// 需求(用户·2026-07): 主页此前是「不管多宽都单列串下来」, 横向空间浪费。改为宽屏左右分块的
//   响应式多列(CSS columns), 窄边栏(IDE 侧栏 <340px)自动回落单列·观感不变。
// 实现: (1) #v-overview.active 用 CSS columns 分栏; (2) _ovGroup(v) 把扁平 (.st+卡片) 序列按标题
//   切分裹入 .ovb 原子块 → break-inside:avoid 使标题永不与其卡片跨列分离; (3) rO() 调用 _ovGroup。
// 本护栏钉死该契约, 防布局回退成单列串联。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 主页响应式多列 · 源级护栏]");

// 1) CSS: #v-overview.active 使用多列(columns)——宽屏分栏, 窄栏回落单列
ok(/#v-overview\.active\{[^}]*columns:\s*340px\s+4/.test(src),
  "#v-overview.active 声明 columns:340px 4 (响应式多列·最多4列·窄栏自动单列)");

// 2) CSS: .ovb 原子块 break-inside:avoid, 防标题与卡片跨列撕裂
ok(/#v-overview\s+\.ovb\{[^}]*break-inside:\s*avoid/.test(src),
  ".ovb 原子块 break-inside:avoid (标题+卡片不跨列分离)");

// 3) JS: _ovGroup 分组器存在, 按 .st 切段裹 .ovb, 保留 id(纯重parent)
ok(/function\s+_ovGroup\(v\)\{/.test(src), "存在 _ovGroup(v) 分组器");
ok(/classList\.contains\(['"]st['"]\)/.test(src) && /className\s*=\s*['"]ovb['"]/.test(src),
  "_ovGroup 按 .st 标题切段并裹入 .ovb");

// 4) rO() 渲染主页后调用 _ovGroup(分组生效)
ok(/v\.innerHTML\+=daoOverviewManualHtml\(\);\s*_ovGroup\(v\);/.test(src),
  "rO() 在拼完主页 HTML 后调用 _ovGroup(v)");

console.log("\nPASS " + pass + " · overview 响应式多列护栏全绿");
