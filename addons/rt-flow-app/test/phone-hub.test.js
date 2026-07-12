"use strict";
// 实测 relay-app.js 的「手机中枢」(三明治 operator→hub→agent): 任意 PC 一行 PowerShell 经手机
// 中转接入 —— connect 领 per-agent token, poll 取命令, result 回传, exec-sync 阻塞至结果返回。
// 与 addons/dao-bridge/dao-bridge-ext/test/hub.test.js 同语义, 但驱动的是 APK 引擎的 serveLocal 帧管线。
// 无框架: node test/phone-hub.test.js (退出码非 0 即失败), 亦兼容 node --test。
const assert = require("assert");
const path = require("path");
const { DaoRelayApp } = require(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "relay-app.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 经中继帧管线投递一个 HTTP 语义请求, 解出手机侧响应 {status, body}。
async function rpc(p, method, body) {
  const raw = await DaoRelayApp.serveLocal(JSON.stringify({ path: p, method: method || "POST", body: body || {} }));
  const outer = JSON.parse(raw);
  return { status: outer.status, body: JSON.parse(outer.bodyText) };
}

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

(async () => {
  // 0) health 暴露中枢计数
  const h = await rpc("/api/health", "GET");
  ok(h.status === 200 && h.body.hub && h.body.hub.agents === 0, "health 暴露 hub.agents=0 (初始无被控端)");

  // 1) connect → 返回 agent_id + per-agent token
  const conn = await rpc("/api/connect", "POST", { sysinfo: { hostname: "BOX-A", username: "u", platform: "win32", capabilities: ["shell", "run"] } });
  ok(conn.status === 200, "connect 200");
  const aid = conn.body.agent_id, tok = conn.body.token;
  ok(aid === "BOX-A", "agent_id == hostname (BOX-A)");
  ok(tok && tok.length >= 16, "签发 per-agent token");

  // 2) 出现在 /api/agents 且 online
  const list = await rpc("/api/agents", "GET");
  ok(list.body.agents.some((a) => a.id === "BOX-A" && a.status === "online"), "agents 列出 BOX-A online");

  // 3) 远程 exec-sync: 先发(不 await) → 被控端 poll 取命令 → 提交结果 → exec-sync 解析
  const execP = rpc("/api/exec-sync", "POST", { agent_id: "BOX-A", type: "run", file: "C:\\x\\y.bat", args: ["Z"], timeout: 10 });
  await sleep(30);
  const poll = await rpc("/api/poll", "POST", { id: aid, token: tok, timeout: 1 });
  ok(poll.body.commands.length === 1, "poll 取到 1 条排队命令");
  const cmd = poll.body.commands[0];
  ok(cmd.payload.command.startsWith("& 'C:\\x\\y.bat'"), "命令经 buildExec 规范化 (Win PowerShell & 调用)");
  await rpc("/api/result", "POST", { agent_id: aid, token: tok, cmd_id: cmd.cmd_id, result: { stdout: "REMOTE-OK", exit_code: 7 } });
  const execR = await execP;
  ok(execR.status === 200 && execR.body.result.stdout === "REMOTE-OK" && execR.body.result.exit_code === 7, "exec-sync 解析到被控端结果");

  // 4) 错误 per-agent token 被拒 401
  const bad = await rpc("/api/poll", "POST", { id: aid, token: "wrong", timeout: 1 });
  ok(bad.status === 401, "错误 token → 401");

  // 5) 异步 exec 返回 cmd_id; result-fetch 报 pending → completed
  const ex = await rpc("/api/exec", "POST", { agent_id: "BOX-A", cmd: "echo hi" });
  ok(ex.status === 200 && ex.body.cmd_id, "异步 exec 返回 cmd_id");
  const pf1 = await rpc("/api/result-fetch", "POST", { agent_id: "BOX-A", cmd_id: ex.body.cmd_id });
  ok(pf1.body.status === "pending", "result-fetch 未回传前 pending");
  const poll2 = await rpc("/api/poll", "POST", { id: aid, token: tok, timeout: 1 });
  await rpc("/api/result", "POST", { agent_id: aid, token: tok, cmd_id: poll2.body.commands[0].cmd_id, result: { stdout: "async-done", exit_code: 0 } });
  const pf2 = await rpc("/api/result-fetch", "POST", { agent_id: "BOX-A", cmd_id: ex.body.cmd_id });
  ok(pf2.body.status === "completed" && pf2.body.result.stdout === "async-done", "result-fetch 回传后 completed");

  // 6) 未知 agent 的 exec → 404
  const nf = await rpc("/api/exec", "POST", { agent_id: "GHOST", cmd: "x" });
  ok(nf.status === 404, "未知 agent → 404");

  // 7) POSIX 被控端命令按平台规范化 (sh 引用, 非 PowerShell)
  const connL = await rpc("/api/connect", "POST", { sysinfo: { hostname: "BOX-L", platform: "linux", capabilities: ["shell"] } });
  const lp = rpc("/api/exec-sync", "POST", { agent_id: "BOX-L", type: "run", file: "/opt/run.sh", args: ["a b"], timeout: 10 });
  await sleep(30);
  const pollL = await rpc("/api/poll", "POST", { id: connL.body.agent_id, token: connL.body.token, timeout: 1 });
  const cl = pollL.body.commands[0];
  ok(cl.payload.command.indexOf("sh '/opt/run.sh' 'a b'") >= 0, "Linux 被控端 → /bin/sh 规范化");
  await rpc("/api/result", "POST", { agent_id: connL.body.agent_id, token: connL.body.token, cmd_id: cl.cmd_id, result: { stdout: "lx", exit_code: 0 } });
  await lp;

  // 8) broadcast 向所有在线被控端各入队一条
  const bc = await rpc("/api/broadcast", "POST", { cmd: "whoami" });
  ok(bc.body.dispatched === 2, "broadcast 派发到 2 个被控端");

  // 9) bootstrap.ps1 生成含帧封装 + connect/poll/result 循环 (无明文密钥泄露到脚本外)
  const bs = await rpc("/api/bootstrap.ps1", "POST", { endpoint: "https://ex/relay/S", token: "T" });
  ok(bs.status === 200 && /Dao-Rpc '\/api\/connect'/.test(bs.body.script) && /Dao-Rpc '\/api\/poll'/.test(bs.body.script) && /Dao-Rpc '\/api\/result'/.test(bs.body.script), "bootstrap.ps1 含 connect/poll/result 帧循环");

  // 10) 空 agent_id 仍走本机手机 shell (未注入 phoneShell 桥 → 501, 证明未被中枢劫持)
  const self = await rpc("/api/exec", "POST", { command: "echo local" });
  ok(self.status === 501 && self.body && self.body.error === "shell_bridge_unavailable", "空 agent_id → 本机 shell 路径 (SELF 路由未被中枢劫持)");

  console.log(failures ? ("\nFAIL " + failures) : "\nALL GREEN (phone-hub)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THROW", e); process.exit(1); });
