// board-solo.test.js · 源级护栏: dao-vsix 才是六大板块的**权威生产者**(_solo 白名单)。
//
// 病灶(已修): 7e8fc874「六大板块前端归位」把「电脑本体(computer)」板块从 dao-vsix 移出
//   (_solo 白名单/导航/渲染器全删), 但当时只在 rt-flow /shell 侧留了残菜单 board:computer
//   (由 PR #1090 补删 + rt-flow test 源级护栏拦回)。然而**权威侧 dao-vsix 的 _solo 白名单
//   本身一直没有源级护栏** —— 谁再往 _solo 里塞回 'computer'(或任何越界键)都无人拦。
// 正法(与 AGENTS.md 二、六大板块 对齐): _solo 白名单 ≡ 恰好六大板块, 且 solo 机制(body.solo
//   + tab 锁定)完好。本护栏钉死该契约, 防死板块从本源重新长回。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// AGENTS §二 六大板块 + 独立 GitHub 纵向板块(第七板块·纯 GitHub 账号/组织/舰队·与 Devin 分离)。
const BOARDS = ["overview", "switch", "bridge", "backups", "inject", "mcp", "github"];
const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 板块 _solo 白名单 · 源级护栏]");

// 1) 提取 getDaoCloudMiddlePanelHtml 顶部的 _solo 白名单数组字面量
const m = src.match(/const\s+_solo\s*=\s*\[([^\]]*)\]\s*\.includes\s*\(\s*soloBoard/);
ok(!!m, "找到 _solo 白名单声明 (const _solo = [...].includes(soloBoard ...))");
const keys = m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);

// 2) 白名单 ≡ 恰好 六大板块 + github (顺序无关·不多不少)
assert.deepStrictEqual([...keys].sort(), [...BOARDS].sort(),
  "_solo 白名单必须恰好为 六大板块+github, 实为: [" + keys.join(", ") + "]");
console.log("  ✓ _solo ≡ {" + BOARDS.join(", ") + "}");
pass++;

// 3) 严禁死板块 computer 复活 (无论在 _solo 还是别处的 solo 键位)
ok(!keys.includes("computer"), "_solo 严禁含死板块 'computer' (7e8fc874 已删)");
ok(!/soloBoard\s*===?\s*['"]computer['"]/.test(src), "严禁残留 soloBoard==='computer' 分支");

// 4) solo 机制完好: body.solo class 由 _solo 驱动 + 初始 tab 锁定到该板块
ok(/<body class="\$\{_solo \? 'solo' : ''\}">/.test(src), "solo 单板块模式: <body class=solo> 由 _solo 驱动");
ok(/tab:\s*'\$\{_solo \|\| 'overview'\}'/.test(src), "solo 初始 tab 锁定到 _solo (回落 overview)");

console.log("[board-solo] " + pass + " assertion(s) passed\n");
