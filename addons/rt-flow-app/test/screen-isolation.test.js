"use strict";
// 两套屏幕·完全隔离 (类 多RDP/虚拟机) 源级护栏:
//   远程/Agent 通道 (engine.html 的 CMDS.*) 结构上不可抢占用户物理前台屏 —— 即
//   browseOpen 忽略 foreground、绝不 appToFront()/browseActivateTab() 把 Agent 页拽上用户屏;
//   appToFront / browseActivateTab 两个命令对远程恒为 no-op。历史病灶: foreground:true 会把
//   Agent 的 CF 登录页提到用户前台, 与用户互斥(打断用户操作)。
//   无框架: node test/screen-isolation.test.js (退出码非 0 即失败)。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "engine.html");
const src = fs.readFileSync(ENGINE, "utf8");

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 抽取 CMDS.<name> 的函数体 (从 "<name>: async function" 起, 括号配平到函数结束)。
function bodyOf(name) {
  const marker = "\n    " + name + ": async function";
  const at = src.indexOf(marker);
  assert(at >= 0, "找不到 CMDS." + name);
  // 从 marker 后第一个 '{' 开始括号配平
  let i = src.indexOf("{", at + marker.length);
  let depth = 0, start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const openBody = bodyOf("browseOpen");
const frontBody = bodyOf("appToFront");
const actBody = bodyOf("browseActivateTab");

// ── browseOpen: 后台影子屏专用, 绝不上前台 ────────────────────────────────
ok(!/N\.appToFront/.test(openBody), "browseOpen 不得调用 N.appToFront (禁止把软件本体拽上用户前台)");
ok(!/N\.browseActivateTab/.test(openBody), "browseOpen 不得调用 N.browseActivateTab (禁止把 Agent 页提为前台活动页)");
ok(/background\s*:\s*true/.test(openBody), "browseOpen 恒返回 background:true (影子屏后台开页)");
ok(/isolated\s*:\s*true/.test(openBody), "browseOpen 标注 isolated:true (两套屏幕隔离契约)");
ok(/N\.browseOpenTab/.test(openBody), "browseOpen 仍经 N.browseOpenTab 建后台标签");

// ── appToFront: 远程恒 no-op ──────────────────────────────────────────────
ok(!/N\.appToFront/.test(frontBody), "远程 appToFront 命令不得真的把软件本体提前台");
ok(/isolated\s*:\s*true/.test(frontBody), "appToFront 命令返回 isolated:true (声明隔离·no-op)");

// ── browseActivateTab: 远程恒 no-op ───────────────────────────────────────
ok(!/N\.browseActivateTab/.test(actBody), "远程 browseActivateTab 命令不得真的把标签提为前台活动页");
ok(/isolated\s*:\s*true/.test(actBody), "browseActivateTab 命令返回 isolated:true (声明隔离·no-op)");

// ── 无 N[cmd] 动态回退 (否则可绕过上面 no-op 直呼原生 appToFront/activateTab) ──
ok(!/CMDS\s*\[\s*cmd\s*\]\s*\|\|\s*N\s*\[/.test(src) && !/N\s*\[\s*cmd\s*\]\s*\(/.test(src),
  "RPC 分发不得回退到 N[cmd] 动态调原生 (choke point 必须是 CMDS)");

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nscreen-isolation: all passed");
