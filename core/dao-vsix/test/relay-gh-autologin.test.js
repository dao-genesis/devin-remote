// relay-gh-autologin.test.js · 源级护栏: 持久 Worker「用 GitHub 账号后端代登 Cloudflare」助手。
//
// 本源(AGENTS.md 三): 内网穿透默认走零账号 dao-relay(无需任何账号)。仅当用户要「固定不漂公网
//   域名」时才需登 Cloudflare。此助手替能力有限的用户代操作该可选步骤——隔离档浏览器链式代填
//   (CF 登录页 → Sign in with GitHub → GitHub 填账密/2FA → 建 Token 页按 dao-relay 权限预勾)。
// 边界(与 GitHub 建 PAT 助手一致·守柔): 只代填不代提交登录/2FA/建 Token 终键; 遇验证码/设备验证不绕过;
//   返回与横幅绝不含任何明文(账密/2FA/Token)。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 持久 Worker · GitHub 代登 Cloudflare 助手 · 源级护栏]");

// ① 编排函数存在, 从账号池取存号(账密+2FA), 复用隔离档/指纹/代理机制。
ok(/async function daoRelayGhAutoLogin\(login: string\)/.test(src), "存在 daoRelayGhAutoLogin(login) 编排");
const fnStart = src.indexOf("async function daoRelayGhAutoLogin");
const fn = src.slice(fnStart, src.indexOf("\n}", fnStart) + 2);
ok(/loadInjectProfile\(\)/.test(fn), "从注入档账号池取号");
ok(/该账号无账密存号/.test(fn), "无账密存号则拒(必须先以账密+2FA 添号)");
ok(/ghTotp\(cred\.otp\)/.test(fn), "本地算 TOTP(2FA 不外泄·不打印)");
ok(/daoAcctFingerprint\(safeKey\)/.test(fn) && /daoAcctProxy\(safeKey\)/.test(fn), "复用确定性指纹 + 出口代理(隔离·不串号)");
ok(/daoLaunchChromiumIsolated\(/.test(fn), "隔离档 Chromium 启动(per-号 user-data-dir)");
ok(/daoRelayTokenDeepLink\('dao-relay'\)/.test(fn), "落地 CF 建 Token 预填深链(未登录→触发 CF 登录→GitHub 代登链)");
ok(/cf:gh:/.test(fn), "隔离档 key 前缀 cf:gh:<login>(独立于纯 GitHub 续登档)");

// ② 返回体不含任何明文(账密/2FA/Token 只在本机浏览器, 不回面板)。
ok(!/return\s*\{[^}]*cred\.pass/.test(fn), "返回体不含明文密码");
ok(!/return\s*\{[^}]*cred\.user\b/.test(fn), "返回体不含明文用户名");
ok(/hasOtp: !!otpNow/.test(fn), "只回 2FA 是否已填的布尔(hasOtp), 不回 2FA 明码");

// ③ 助手扩展(MV3·仅本号隔离档)链式代填, 守柔不代提交登录/2FA/建 Token 终键。
ok(/function daoRelayWriteGhCfAssistExt\(/.test(src), "存在 daoRelayWriteGhCfAssistExt 助手扩展生成器");
const extStart = src.indexOf("function daoRelayWriteGhCfAssistExt");
const ext = src.slice(extStart, src.indexOf("\n}", src.indexOf("return extDir;", extStart)) + 2);
ok(/manifest_version: 3/.test(ext), "MV3 manifest");
ok(/'https:\/\/github\.com\/\*'/.test(ext) && /cloudflare\.com/.test(ext), "content_script 匹配 github.com + cloudflare.com");
ok(/Sign in with GitHub|检测到 Cloudflare 登录页/.test(ext), "CF 登录页引导用 GitHub 登录");
ok(/守柔/.test(ext) || /核对后手动登入|不代提交/.test(ext), "GitHub 登录页守柔·不代提交(横幅明示)");
ok(/api-tokens/.test(ext) && /Workers 脚本编辑/.test(ext), "CF 建 Token 页按 dao-relay 所需权限预勾提示");
ok(/手动 Create/.test(ext), "建 Token 终键留给用户手动(不代提交)");
ok(/勿改风控项/.test(ext) || /不绕过/.test(src.slice(extStart - 900, extStart)), "明示不绕过风控/验证项");

// ④ dispatch 挂上, 且在免 Devin 登录白名单(与其它 relay* 命令一致)。
ok(/case 'relayGhAutoLogin':/.test(src), "dispatch 挂 relayGhAutoLogin");
ok(/daoRelayGhAutoLogin\(String\(msg\.login/.test(src), "dispatch 调 daoRelayGhAutoLogin(msg.login)");
ok(/'relayProvisionToken', 'relayGhAutoLogin'/.test(src), "relayGhAutoLogin 在 noAuthNeeded 白名单(与 relay* 一致)");

// ⑤ 前端: bridge 板块代登卡 + 助手 JS(只传 login, 不碰明文)。
ok(/function relayGhAutoLogin\(\)/.test(src), "前端 relayGhAutoLogin() 助手存在");
ok(/relayGhLogin/.test(src), "前端有 GitHub login 输入框 id=relayGhLogin");
ok(/用 GitHub 账号代登 Cloudflare/.test(src), "前端有「用 GitHub 账号代登 Cloudflare」按钮");
const feStart = src.indexOf("function relayGhAutoLogin()");
const fe = src.slice(feStart, feStart + 600);
ok(/cmd\('relayGhAutoLogin',\{login:login\}\)/.test(fe), "前端只上送 login(不碰账密/2FA/Token)");

// ⑥ 深链权限集 = provision.mjs 单一同源, 且覆盖 tryCustomDomain 绑自定义域所需(workers.dev 被墙兜底)。
//   病灶(已修): daoRelayTokenDeepLink 曾只勾 3 权限(workers_scripts/kv/account), 缺 zone:read + workers_routes:edit,
//   代填出的 Token 无权绑 dao-relay.<zone> 自定义域 → GFW 下 workers.dev 挂时兜底入口失效。
function permKeys(fnSrc) {
    const set = new Set();
    const re = /key:\s*['"]([a-z_]+)['"]\s*,\s*type:\s*['"](edit|read)['"]/g;
    let m; while ((m = re.exec(fnSrc))) set.add(m[1] + ':' + m[2]);
    return set;
}
const dlStart = src.indexOf("function daoRelayTokenDeepLink");
const dlFn = src.slice(dlStart, src.indexOf("\n}", dlStart) + 2);
const extPerms = permKeys(dlFn);
ok(extPerms.has("zone:read"), "深链含 zone:read(读 zone 供绑自定义域)");
ok(extPerms.has("workers_routes:edit"), "深链含 workers_routes:edit(绑 Worker 自定义域·workers.dev 被墙兜底)");
ok(extPerms.has("workers_scripts:edit") && extPerms.has("account_settings:read"), "深链保留 workers_scripts:edit + account_settings:read");

const provPath = path.join(__dirname, "..", "..", "..", "addons", "dao-relay", "provision.mjs");
if (fs.existsSync(provPath)) {
    const prov = fs.readFileSync(provPath, "utf8");
    const pStart = prov.indexOf("export function tokenDeepLink");
    const pFn = prov.slice(pStart, prov.indexOf("\n}", pStart) + 2);
    const provPerms = permKeys(pFn);
    const missing = [...provPerms].filter(p => !extPerms.has(p));
    ok(missing.length === 0, "深链权限集 ⊇ provision.mjs tokenDeepLink(单一同源·缺失: " + (missing.join(",") || "无") + ")");
}

console.log("全部通过 (" + pass + " 项)");
