// relay-gh-autologin.test.js · 源级护栏: 持久 Worker「用 GitHub 账号全自动代登 Cloudflare」。
//
// 本源(AGENTS.md 三 + 用户本源哲学): 内网穿透默认走零账号 dao-relay(无需任何账号)。仅当用户要
//   「固定不漂公网域名」时才需登 Cloudflare。此编排替用户**零点击全自动**完成该可选步骤——
//   无头隔离档登 CF(Sign in with GitHub → GitHub 填账密 + 本地算 TOTP 过 2FA → 授权)→ 会话态
//   经内部接口直建 API Token → provision 部署持久 Worker, **无需任何人工终键**。
// 边界(守柔硬边界): 仅命中真·反自动化关卡(人机验证码/硬件密钥/邮箱设备验证)才 needUser 回退到
//   有头隔离档 + 代填助手, 交号主本人过最后一关; 返回与横幅绝不含任何明文(账密/2FA/Token)。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

// 从某函数声明起, 截到下一个顶层声明/注释块前(足够覆盖整函数体, 且不被返回类型 Promise<{}> 干扰).
function sliceFn(s, decl) {
    const start = s.indexOf(decl);
    if (start < 0) return "";
    const rest = s.slice(start + decl.length);
    const nexts = [/\n(async function |function |case ')/, /\n\/\/ [^\n]*\n(async function|function)/]
        .map(re => { const m = re.exec(rest); return m ? m.index : -1; })
        .filter(x => x > 0);
    const end = nexts.length ? Math.min(...nexts) : rest.length;
    return s.slice(start, start + decl.length + end);
}

console.log("[dao-vsix 持久 Worker · GitHub 全自动代登 Cloudflare · 源级护栏]");

// ① 编排函数存在, 从账号池取存号(账密+2FA), 走全自动主路径。
ok(/async function daoRelayGhAutoLogin\(login: string\)/.test(src), "存在 daoRelayGhAutoLogin(login) 编排");
const fn = sliceFn(src, "async function daoRelayGhAutoLogin");
ok(/loadInjectProfile\(\)/.test(fn), "从注入档账号池取号");
ok(/无完整账密存号/.test(fn), "无完整账密(user+pass)则拒(必须先以账密+2FA 添号)");
ok(/!cred\.user \|\| !cred\.pass/.test(fn), "要求完整账密(user 且 pass)方可全自动代登");
ok(/cf:gh:/.test(fn), "隔离档 key 前缀 cf:gh:<login>(独立于纯 GitHub 续登档)");
ok(/daoAcctProxy\(safeKey\)/.test(fn), "复用出口代理(隔离·不串号)");

// ② 主路径: 动态载 gh-cf-login 模块, 调 ghCfLoginProvision 全自动(无人工终键)。
ok(/daoRelayLoadMod\('gh-cf-login\.mjs'\)/.test(fn), "动态载 gh-cf-login.mjs 全自动模块");
ok(/ghCfLoginProvision\(/.test(fn), "调 ghCfLoginProvision 全自动登 CF→建 Token→部署");
ok(/headless: true/.test(fn), "主路径无头隔离档(零点击·无需人工终键)");
ok(/daoRelaySetPersistent\(st\.url\)/.test(fn), "成功后落盘置顶持久通道");

// ③ 优雅回退: 命中真·反自动化关卡/失败 → 有头隔离档 + 代填助手, 交号主过最后一关。
ok(/daoRelayGhAssistLaunch\(/.test(fn), "失败/挑战回退到有头代填助手");
ok(/needUser/.test(fn), "回传 needUser(真·安全挑战交回用户)");
const assist = sliceFn(src, "function daoRelayGhAssistLaunch");
ok(/ghTotp\(cred\.otp\)/.test(assist), "回退助手本地算 TOTP(2FA 不外泄·不打印)");
ok(/daoAcctFingerprint\(safeKey\)/.test(assist), "回退助手复用确定性指纹(隔离)");
ok(/daoLaunchChromiumIsolated\(/.test(assist), "回退助手隔离档 Chromium 启动(per-号 user-data-dir)");
ok(/daoRelayTokenDeepLink\('dao-relay'\)/.test(assist), "回退助手落 CF 建 Token 预填深链");
ok(/daoRelayWriteGhCfAssistExt\(/.test(assist), "回退助手写代填扩展");

// ④ 返回体不含任何明文(账密/2FA/Token 只在本机浏览器, 不回面板)。
ok(!/return\s*\{[^}]*cred\.pass/.test(fn), "返回体不含明文密码");
ok(!/return\s*\{[^}]*:\s*cred\.user\b/.test(fn), "返回体不含明文用户名");

// ⑤ 全自动模块(addons/dao-relay/gh-cf-login.mjs)存在且守柔硬边界明确。
const modPath = path.join(__dirname, "..", "..", "..", "addons", "dao-relay", "gh-cf-login.mjs");
ok(fs.existsSync(modPath), "存在 addons/dao-relay/gh-cf-login.mjs");
const mod = fs.readFileSync(modPath, "utf8");
ok(/export async function ghCfLoginProvision/.test(mod), "导出 ghCfLoginProvision");
ok(/cfMintTokenViaSession/.test(mod) && /provision/.test(mod), "复用 credlogin 内部接口建 Token + provision 部署");
ok(/needUser: true/.test(mod), "命中真·反自动化关卡 → needUser 交回(不绕过)");
ok(/CHALLENGE_RE/.test(mod) && /captcha|webauthn|passkey/i.test(mod), "识别人机验证码/硬件密钥/设备验证等硬边界");

// ⑥ dispatch 挂上, 且在免 Devin 登录白名单(与其它 relay* 命令一致)。
ok(/case 'relayGhAutoLogin':/.test(src), "dispatch 挂 relayGhAutoLogin");
ok(/daoRelayGhAutoLogin\(String\(msg\.login/.test(src), "dispatch 调 daoRelayGhAutoLogin(msg.login)");
ok(/'relayProvisionToken', 'relayGhAutoLogin'/.test(src), "relayGhAutoLogin 在 noAuthNeeded 白名单(与 relay* 一致)");

// ⑦ 前端: 代登卡 + 助手 JS(只传 login, 不碰明文)。
ok(/function relayGhAutoLogin\(\)/.test(src), "前端 relayGhAutoLogin() 助手存在");
ok(/relayGhLogin/.test(src), "前端有 GitHub login 输入/下拉框 id=relayGhLogin");
ok(/全自动代登 Cloudflare/.test(src), "前端有「用 GitHub 账号全自动代登 Cloudflare」按钮");
const fe = sliceFn(src, "function relayGhAutoLogin()") || src.slice(src.indexOf("function relayGhAutoLogin()"), src.indexOf("function relayGhAutoLogin()") + 600);
ok(/cmd\('relayGhAutoLogin',\{login:login\}\)/.test(fe), "前端只上送 login(不碰账密/2FA/Token)");

// ⑧ 深链权限集 = provision.mjs 单一同源, 且覆盖 tryCustomDomain 绑自定义域所需(workers.dev 被墙兜底)。
function permKeys(fnSrc) {
    const set = new Set();
    const re = /key:\s*['"]([a-z_]+)['"]\s*,\s*type:\s*['"](edit|read)['"]/g;
    let m; while ((m = re.exec(fnSrc))) set.add(m[1] + ':' + m[2]);
    return set;
}
const dlFn = sliceFn(src, "function daoRelayTokenDeepLink");
const extPerms = permKeys(dlFn);
ok(extPerms.has("zone:read"), "深链含 zone:read(读 zone 供绑自定义域)");
ok(extPerms.has("workers_routes:edit"), "深链含 workers_routes:edit(绑 Worker 自定义域·workers.dev 被墙兜底)");
ok(extPerms.has("workers_scripts:edit") && extPerms.has("account_settings:read"), "深链保留 workers_scripts:edit + account_settings:read");

const provPath = path.join(__dirname, "..", "..", "..", "addons", "dao-relay", "provision.mjs");
if (fs.existsSync(provPath)) {
    const prov = fs.readFileSync(provPath, "utf8");
    const pFn = sliceFn(prov, "export function tokenDeepLink");
    const provPerms = permKeys(pFn);
    const missing = [...provPerms].filter(p => !extPerms.has(p));
    ok(missing.length === 0, "深链权限集 ⊇ provision.mjs tokenDeepLink(单一同源·缺失: " + (missing.join(",") || "无") + ")");
}

console.log("全部通过 (" + pass + " 项)");
