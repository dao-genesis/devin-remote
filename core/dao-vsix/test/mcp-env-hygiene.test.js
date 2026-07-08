// mcp-env-hygiene.test.js · 源级护栏: 本机 IDE MCP 对外呈现/注入时剥离宿主管路环境变量(非密钥)。
//
// 病灶(已修): scanIdeMcps 扫到的 env 含 NODE_PATH/NO_PROXY/DAO_MCP_PROXY 等**宿主本地管路**,
//   经 env_variables 原样送到 MCP 面板 → 无密钥的 MCP(如 Playwright)被显示成「要配一堆密钥」。
// 正法(帛书·「少则得·多则惑」): 对外 env_variables 走 mcpStripHostEnv 只留真·配置/密钥;
//   本机接测(daoVerifyMcpStdio)仍用未过滤原始 e.env(NODE_PATH 本机运行必需)。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix MCP 环境变量卫生 · 源级护栏]");

ok(/function\s+mcpStripHostEnv\s*\(/.test(src), "存在剥离函数 mcpStripHostEnv()");

// 管路名单必须覆盖用户实测的三类噪声
const setBlock = src.slice(src.indexOf("MCP_HOST_PLUMBING_ENV"), src.indexOf("function mcpStripHostEnv"));
for (const k of ["node_path", "no_proxy", "dao_mcp_proxy", "http_proxy", "https_proxy"]) {
    ok(setBlock.includes("'" + k + "'"), "管路名单含 " + k);
}

// 对外呈现的 ide mcpObj.env_variables 必须经 mcpStripHostEnv(不再原样 e.env)
ok(/env_variables:\s*mcpStripHostEnv\(e\.env\)/.test(src), "ide mcpObj.env_variables = mcpStripHostEnv(e.env)");
ok(!/env_variables:\s*e\.env\b/.test(src), "不再存在裸 env_variables: e.env(原样泄露管路)");

// 本机接测仍用原始 e.env(不被过滤 — 否则本机起进程缺 NODE_PATH 会失败)
const verifyCall = src.slice(src.indexOf("case 'verifyLocalMcp'"), src.indexOf("case 'verifyLocalMcp'") + 900);
ok(/env:\s*e\.env\b/.test(verifyCall), "verifyLocalMcp 本机接测仍用原始 e.env");

console.log("全部通过 (" + pass + " 项)");
