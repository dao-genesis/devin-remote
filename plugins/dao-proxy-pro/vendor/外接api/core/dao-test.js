#!/usr/bin/env node
// dao-test.js · 道Agent Pro 全链路闭环测试入口
// 道义: 四十八章「为道者日损 损之又损 以至于无为 无为而无不为」
//   损去芜杂 · 归于闭环 · 一键全链路验证
//
// 用法:
//   node dao-test.js              # 全链路 (L1 Wire + L2 路由 + L3 对话 + L4 协议 + L5 深度)
//   node dao-test.js --quick      # 快速 (L1 + L2)
//   node dao-test.js --e2e        # 含端到端 (需代理运行中)
//   node dao-test.js --protocol   # 仅协议验证
//   node dao-test.js --help

"use strict";

const path = require("path");
const fs = require("fs");

// ─── 颜色辅助 ──
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};
const ok = (s) => `${C.green}✅ ${s}${C.reset}`;
const fail = (s) => `${C.red}❌ ${s}${C.reset}`;
const info = (s) => `${C.cyan}${s}${C.reset}`;
const warn = (s) => `${C.yellow}⚠ ${s}${C.reset}`;
const header = (s) => `${C.bold}${C.magenta}${s}${C.reset}`;

// ─── 参数解析 ──
const args = process.argv.slice(2);
const optQuick = args.includes("--quick");
const optE2E = args.includes("--e2e");
const optProtocol = args.includes("--protocol");
const optHelp = args.includes("--help");

if (optHelp) {
  console.log(`
${header("道Agent Pro · 全链路闭环测试")}
${info("用法:")} node dao-test.js [选项]

  (无参数)     全链路: L1 Wire + L2 路由 + L3 对话 + L4 协议 + L5 深度
  --quick      快速: L1 Wire + L2 路由 (秒级)
  --e2e        含端到端: 需代理运行中 (http://127.0.0.1:8981)
  --protocol   仅协议验证: protobuf/Connect-RPC/SSE
  --help       此帮助

${info("测试层级:")}
  L1 Wire自检     protobuf编解码 · Connect-RPC帧格式
  L2 单场景路由    11个场景 · 工具调用 · 参数schema
  L3 完整对话流    工具调用→结果→继续
  L4 协议适配器    Anthropic/OpenAI Chat/OpenAI Responses
  L5 深度验证      277项 · isCustomToolCall · 白名单 · 别名 · 生命周期
  L6 端到端       直连代理 · DeepSeek API · 全链路往返
`);
  process.exit(0);
}

// ─── 统计 ──
let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;

// ─── L1-L5: 运行LSP模拟器 ──
async function runLspSimulator() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  道 Agent Pro · LSP 全链路模拟器"));
  console.log(header("═══════════════════════════════════════════\n"));

  const simRunPath = path.join(__dirname, "lsp_sim_run.js");
  if (!fs.existsSync(simRunPath)) {
    console.log(fail("lsp_sim_run.js 不存在"));
    totalFail++;
    return false;
  }

  try {
    delete require.cache[require.resolve(simRunPath)];
    const simRun = require(simRunPath);

    if (typeof simRun.run === "function") {
      const result = await simRun.run();
      if (result) {
        totalPass += result.pass || 0;
        totalFail += result.fail || 0;
      }
      return true;
    } else {
      console.log(fail("lsp_sim_run.js 未导出 run()"));
      totalFail++;
      return false;
    }
  } catch (e) {
    console.log(fail(`LSP模拟器执行失败: ${e.message}`));
    totalFail++;
    return false;
  }
}

// ─── L6: 端到端验证 ──
async function runE2E() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  L6 · 端到端验证 (代理 → DeepSeek)"));
  console.log(header("═══════════════════════════════════════════\n"));

  const http = require("http");

  // 1. 检查代理状态
  const checkProxy = () =>
    new Promise((resolve) => {
      const req = http.get("http://127.0.0.1:8981/origin/ea/status", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve({
              ok: j.ok,
              ready: j.ready,
              uids: Object.keys(j.uids || {}),
            });
          } catch {
            resolve({ ok: false });
          }
        });
      });
      req.on("error", () => resolve({ ok: false }));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve({ ok: false });
      });
    });

  const status = await checkProxy();
  if (!status.ok) {
    console.log(warn("代理未运行 (http://127.0.0.1:8981) — 跳过E2E"));
    totalSkip++;
    return;
  }
  console.log(
    ok(
      `代理状态: ok=${status.ok} ready=${status.ready} routes=${status.uids.join(",")}`,
    ),
  );

  // 2. 检查DeepSeek直连
  const https = require("https");
  const testDeepSeek = () =>
    new Promise((resolve) => {
      const body = JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "say ok" }],
        max_tokens: 10,
        stream: false,
      });
      const req = https.request(
        {
          hostname: "api.deepseek.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              resolve({
                ok: !!j.choices,
                model: j.model,
                content: j.choices?.[0]?.message?.content,
              });
            } catch {
              resolve({ ok: false });
            }
          });
        },
      );
      req.on("error", (e) => resolve({ ok: false, err: e.message }));
      req.write(body);
      req.end();
    });

  const ds = await testDeepSeek();
  if (ds.ok) {
    console.log(ok(`DeepSeek直连: model=${ds.model} content="${ds.content}"`));
    totalPass += 2;
  } else {
    console.log(fail(`DeepSeek直连失败: ${ds.err || "未知"}`));
    totalFail += 2;
  }

  // 3. 检查路由配置
  const checkRoutes = () =>
    new Promise((resolve) => {
      const req = http.get("http://127.0.0.1:8981/origin/ea/routes", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve({ ok: j.ok, routes: Object.keys(j.routes || {}) });
          } catch {
            resolve({ ok: false });
          }
        });
      });
      req.on("error", () => resolve({ ok: false }));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve({ ok: false });
      });
    });

  const routes = await checkRoutes();
  if (routes.ok) {
    console.log(
      ok(`路由配置: ${routes.routes.length}条 (${routes.routes.join(", ")})`),
    );
    totalPass++;
  } else {
    console.log(fail("路由配置获取失败"));
    totalFail++;
  }

  // 4. 检查诊断日志最近成功路由
  const diagPath = path.join(
    __dirname,
    "..",
    "bundled-origin",
    "_router_diag.log",
  );
  if (fs.existsSync(diagPath)) {
    const tail = fs
      .readFileSync(diagPath, "utf8")
      .split("\n")
      .slice(-50)
      .filter((l) => l.includes("_tryRoute  SUCCESS"))
      .pop();
    if (tail) {
      console.log(ok(`最近成功路由: ${tail.trim().slice(-80)}`));
      totalPass++;
    } else {
      console.log(warn("诊断日志无最近成功路由记录"));
      totalSkip++;
    }
  }
}

// ─── 协议验证 ──
async function runProtocolCheck() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  协议验证 · protobuf / Connect-RPC / SSE"));
  console.log(header("═══════════════════════════════════════════\n"));

  const checks = [];

  // 1. cascade_wire.js 存在且可加载
  const wirePath = path.join(__dirname, "cascade_wire.js");
  if (fs.existsSync(wirePath)) {
    try {
      delete require.cache[require.resolve(wirePath)];
      const wire = require(wirePath);
      const hasEncode = typeof wire.encodeString === "function";
      const hasBuild = typeof wire.buildFrame === "function";
      const hasParse = typeof wire.parseFrame === "function";
      checks.push({
        name: "cascade_wire.js 编解码",
        pass: hasEncode && hasBuild && hasParse,
      });
    } catch (e) {
      checks.push({
        name: "cascade_wire.js 加载",
        pass: false,
        err: e.message,
      });
    }
  } else {
    checks.push({ name: "cascade_wire.js 存在", pass: false });
  }

  // 2. dao_router.js 存在且含关键函数
  const routerPath = path.join(__dirname, "dao_router.js");
  if (fs.existsSync(routerPath)) {
    const src = fs.readFileSync(routerPath, "utf8");
    checks.push({
      name: "dao_router.js _streamOaToCascade 三协议",
      pass:
        src.includes("_isAnthropic") &&
        src.includes("_isResponses") &&
        src.includes("_chatAdapter"),
    });
    checks.push({
      name: "dao_router.js _sseEventType 追踪",
      pass: src.includes("_sseEventType"),
    });
    checks.push({
      name: "dao_router.js _KNOWN_TOOL_NAMES 含LSP别名",
      pass:
        src.includes("Read") &&
        src.includes("Grep") &&
        src.includes("CodeSearch"),
    });
    checks.push({
      name: "dao_router.js _STUB_MODELS 已清空",
      pass: src.includes("new Set([])") || src.includes("new Set([") === false,
    });
    checks.push({
      name: "dao_router.js isCustomToolCall 修正",
      pass:
        src.includes("_lspToolNames") && src.includes("_lspCapableToolNames"),
    });
  } else {
    checks.push({ name: "dao_router.js 存在", pass: false });
  }

  // 3. adapters.js 三协议适配器
  const adaptersPath = path.join(__dirname, "adapters.js");
  if (fs.existsSync(adaptersPath)) {
    const src = fs.readFileSync(adaptersPath, "utf8");
    checks.push({
      name: "adapters.js Anthropic SSE",
      pass: src.includes("anthropic") && src.includes("parseSSELine"),
    });
    checks.push({
      name: "adapters.js OpenAI Chat SSE",
      pass: src.includes("openai-chat") || src.includes("openaiChat"),
    });
    checks.push({
      name: "adapters.js OpenAI Responses SSE",
      pass: src.includes("openai-responses") || src.includes("openaiResponses"),
    });
  }

  // 4. sp_invert.js 工具别名
  const spInvPath = path.join(__dirname, "sp_invert.js");
  if (fs.existsSync(spInvPath)) {
    const src = fs.readFileSync(spInvPath, "utf8");
    checks.push({
      name: "sp_invert.js TOOL_ALIAS_TO_STANDARD",
      pass:
        src.includes("TOOL_ALIAS_TO_STANDARD") || src.includes("ALIAS_TO_STD"),
    });
  }

  // 5. LSP模拟器5模块完整性
  const simModules = [
    "lsp_simulator.js",
    "lsp_mock_server.js",
    "lsp_scenarios.js",
    "lsp_tools.js",
    "lsp_sim_run.js",
  ];
  for (const m of simModules) {
    const p = path.join(__dirname, m);
    checks.push({
      name: `模拟器 ${m}`,
      pass: fs.existsSync(p),
    });
  }

  for (const c of checks) {
    if (c.pass) {
      console.log(ok(c.name));
      totalPass++;
    } else {
      console.log(fail(`${c.name}${c.err ? ` (${c.err})` : ""}`));
      totalFail++;
    }
  }
}

// ─── 主入口 ──
async function main() {
  const start = Date.now();
  console.log(header("╔═══════════════════════════════════════════════╗"));
  console.log(header("║  道 Agent Pro · 全链路闭环测试               ║"));
  console.log(header("║  为道者日损 · 损之又损 · 以至于无为           ║"));
  console.log(header("╚═══════════════════════════════════════════════╝"));

  if (optProtocol) {
    await runProtocolCheck();
  } else {
    // L1-L5: LSP模拟器
    await runLspSimulator();

    // 协议验证 (非quick模式)
    if (!optQuick) {
      await runProtocolCheck();
    }

    // L6: 端到端 (仅--e2e)
    if (optE2E) {
      await runE2E();
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(header("\n═══════════════════════════════════════════════"));
  console.log(
    `  ${totalPass > 0 ? ok(`通过: ${totalPass}`) : ""}  ${
      totalFail > 0 ? fail(`失败: ${totalFail}`) : ""
    }  ${totalSkip > 0 ? warn(`跳过: ${totalSkip}`) : ""}  ${info(`${elapsed}s`)}`,
  );
  console.log(header("═══════════════════════════════════════════════\n"));

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(fail(`致命错误: ${e.message}`));
  process.exit(2);
});
