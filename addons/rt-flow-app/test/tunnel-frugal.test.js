"use strict";
// 节俭化穿透面板 (tunnel.html) 源级护栏: 主界面只保留真正需用户参与/常用的动作
//  (总状态 + 渠道 + 复制接入 + 网页版 + 接入电脑 PowerShell + Cloudflare 一键建 Worker),
//  底层自动化细节 (P2P/SSH/LAN/E2E/动态中继配置/能力自测) 一律折进 <details class="adv"> 高级区。
//  并断言前端确实接线到 relay-app 的中枢/CF 路由, 且不在明文状态区直出 token。
//  无框架: node test/tunnel-frugal.test.js (退出码非 0 即失败)。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "tunnel.html"), "utf8");

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 取脚本主体 (最后一个 <script> 块) 供函数级断言
const scriptBodies = (HTML.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []).join("\n");

// 1) 前端已接线到中枢/CF 后端路由 (不是空壳)
["/api/bootstrap.ps1", "/api/agents", "/api/revoke", "/api/cf-provision", "/api/cf-status"].forEach(function (p) {
  ok(scriptBodies.indexOf(p) >= 0, "前端调用了后端路由 " + p);
});
ok(/function\s+_hubRpc\s*\(/.test(scriptBodies), "存在本机回环 RPC helper _hubRpc()");
ok(/function\s+copyHubPs1\s*\(/.test(scriptBodies), "存在 复制 PowerShell 接入指令 copyHubPs1()");
ok(/function\s+hubRevokeUi\s*\(/.test(scriptBodies), "存在 吊销电脑 hubRevokeUi()");
ok(/function\s+refreshHub\s*\(/.test(scriptBodies), "存在 电脑列表刷新 refreshHub()");
ok(/function\s+cfProvision\s*\(/.test(scriptBodies) && /function\s+cfPollStatus\s*\(/.test(scriptBodies), "存在 Cloudflare 一键部署+状态轮询");
ok(/function\s+cfProvReset\s*\(/.test(scriptBodies), "存在 Cloudflare 重置·回零账号通道 cfProvReset()");

// 2) 主界面 (第一个 <details class="adv"> 之前) 含关键卡片
const advIdx = HTML.indexOf('<details class="adv"');
ok(advIdx > 0, "存在高级折叠区 <details class=\"adv\">");
const mainUi = HTML.slice(0, advIdx);
ok(/接入电脑/.test(mainUi), "主界面含「接入电脑」卡片");
ok(/复制 PowerShell/.test(mainUi) && /copyHubPs1\(\)/.test(mainUi), "主界面含 复制 PowerShell 接入指令按钮");
ok(/id="hubList"/.test(mainUi), "主界面含 已接入电脑列表 #hubList");
ok(/Cloudflare/.test(mainUi) && /cfProvision\(\)/.test(mainUi), "主界面含 可选 Cloudflare 一键建 Worker");
ok(/id="cfProvTok"/.test(mainUi) && /type="password"/.test(HTML.match(/id="cfProvTok"[^>]*/)[0]), "Cloudflare token 输入为 password 型");
ok(/copyWebConsole\(\)/.test(mainUi), "主界面含 复制网页控制台网址");
ok(/copyAccess/.test(mainUi), "主界面含 复制接入信息");

// 3) 底层自动化细节已折进高级区 (不出现在主界面), 减少普通用户认知负担
const advBlock = HTML.slice(advIdx);
ok(/穿透配置|cfgUrl/.test(advBlock) && !/id="cfgUrl"/.test(mainUi), "动态中继配置(URL/Token/Session) 已折进高级区, 不在主界面");
ok(/E2E|e2eKey/.test(advBlock) && !/id="e2eKey"/.test(mainUi), "E2E Key 已折进高级区, 不在主界面");
ok(/局域网直连|isLanDirect/.test(advBlock), "局域网直连 已折进高级区");
ok(/能力自测/.test(advBlock) && !/能力自测/.test(mainUi), "能力自测 已折进高级区");
ok(!/RPC 自测/.test(mainUi), "RPC 自测 不在主界面");

// 4) 旧 email/key 命名隧道表单已彻底移除 (不再收集 GitHub 原始密码/2FA/CF email)
ok(HTML.indexOf('id="cfEmail"') < 0 && HTML.indexOf('id="cfKey"') < 0, "旧 Cloudflare email/key 表单已移除");
ok(HTML.indexOf("cfBrowserLogin") < 0 || !/onclick="send\('cfBrowserLogin'\)"/.test(mainUi), "主界面无旧浏览器登录 CF 按钮");

// 5) token 不在普通状态区明文渲染: agentCount 反映真实 /api/agents, 非 on?1:0 硬编码残留
ok(/agentCount:\s*on\?1:0/.test(scriptBodies) === false || /filter\(function\(a\)\{return a\.status==='online'/.test(scriptBodies), "在线电脑数取真实 /api/agents 计数");

console.log(failures ? ("\nFAIL " + failures) : "\nALL GREEN (tunnel-frugal)");
process.exit(failures ? 1 : 0);
