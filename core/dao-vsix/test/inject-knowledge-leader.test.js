// inject-knowledge-leader.test.js · 源级护栏: 机器级内穿/MCP 知识文档的**单一维护者 = leader**。
//
// 病灶(已修): reinjectBridgeToAllAccounts(整池扩散)早有 leader 闸, 但 bridgeInjectKnowledge
//   (autoPersist 等自动路径写「当前账号」) 一直无闸。同 org 的多窗口(leader 9920·v3.50.102 与
//   follower 9921·v3.50.92)会 upsert **同一条 org 知识条目**, follower 照写即把「版本/工具数/URL」
//   戳成自身旧值 → 云端读到的文档在两值间抖动(实测 65↔64 工具、3.50.102↔3.50.92 版本翻动)。
// 正法(帛书·「得一」单一权威, 与 PR #1094 桥 leader 权威同律): 自动路径非 leader 守柔不写;
//   手动点按(bridgeInjectKnowledge/injectDiagnose/bridgeRefreshToken) authoritative 放行(manual=true)。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 知识文档 leader 单一维护者 · 源级护栏]");

// 1) bridgeInjectKnowledge 必须带 manual 参数(默认 false = 自动路径)
const sig = src.match(/async function bridgeInjectKnowledge\(\s*manual\s*=\s*false\s*\)/);
ok(!!sig, "bridgeInjectKnowledge 声明为 (manual = false)");

// 2) 函数体内必须有「非 manual 且非 leader → 守柔不写」闸门, 且位于任何 upsert 之前
const fnStart = src.indexOf("async function bridgeInjectKnowledge");
const body = src.slice(fnStart, fnStart + 2500);
const gate = body.match(/if\s*\(\s*!manual\s*&&\s*!bridgeIsLeaderInstance\(\)\s*\)/);
ok(!!gate, "闸门存在: if (!manual && !bridgeIsLeaderInstance()) → return false");
const gateIdx = body.search(/!bridgeIsLeaderInstance\(\)/);
const upsertIdx = body.indexOf("devinUpsertKnowledge");
ok(gateIdx > -1 && (upsertIdx === -1 || gateIdx < upsertIdx), "闸门先于任何 upsert 写入");

// 3) 自动路径(bridgeAutoPersist)不得绕闸(不传 true)
const apStart = src.indexOf("async function bridgeAutoPersist");
const apBody = src.slice(apStart, src.indexOf("\n}", apStart));
ok(apStart > -1 && !/bridgeInjectKnowledge\(\s*true\s*\)/.test(apBody),
  "自动路径 bridgeAutoPersist 不传 manual=true (受闸约束)");
ok(/bridgeInjectKnowledge\(\s*\)/.test(apBody), "自动路径 bridgeAutoPersist 仍调用 bridgeInjectKnowledge()");

// 4) 手动命令(bridgeInjectKnowledge / injectDiagnose / bridgeRefreshToken) authoritative 放行
const manualCalls = (src.match(/bridgeInjectKnowledge\(\s*true\s*\)/g) || []).length;
ok(manualCalls >= 3, "手动路径 ≥3 处以 manual=true 放行 (实为 " + manualCalls + ")");

// 5) 整池扩散路径的既有 leader 闸不被移除(双保险)
const reinjStart = src.indexOf("async function reinjectBridgeToAllAccounts");
const reinjBody = src.slice(reinjStart, reinjStart + 1200);
ok(reinjStart > -1 && /!bridgeIsLeaderInstance\(\)/.test(reinjBody),
  "reinjectBridgeToAllAccounts 的 leader 闸仍在");

console.log("全部通过 (" + pass + " 项)");
