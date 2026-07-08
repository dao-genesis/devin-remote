"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-relay · 顶层「一次登录 → 后端全自动持久通道」provisioner
//
// 道法自然·为道日损: 用户此前要自己一步步登 Cloudflare、手搓 Token、装 wrangler、
//   点网页部署 —— 成本太高。反者道之动: 把这条长链压成**一次动作** ——
//   用户只在官网点一次「Create」复制一个预填好权限的 API Token 贴回插件, 之后
//   后端全链路自动: 校验 token → 取账号 → 保证 workers.dev 子域 → wrangler deploy
//   → 拿到**永不漂**的 https://dao-relay-do.<子域>.workers.dev → 落盘持久化。
//
//   顶层持久通道成型后, 既有回退链(cloudflared 快速隧道 → ntfy mesh 零中心)保持不变,
//   两者取长补短: 有持久通道走它(URL 恒定·org MCP 配一次永久), 挂了自动落回退。
//
// 纯逻辑(deep-link/URL 计算)导出以便单测; 副作用(网络/部署/落盘)在 provision()。
// ═══════════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CF_API = "https://api.cloudflare.com/client/v4";
export const WORKER_NAME = "dao-relay-do"; // 与 wrangler.toml 的 name 一致

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────

// 预填 Token 创建深链: 打开即已勾好本通道所需最小权限(Workers 脚本编辑 + 账号读),
// 用户只需点「Continue → Create」复制 token。免手搓权限, 免读文档。
export function tokenDeepLink(name = "dao-relay") {
  const perms = [
    { key: "workers_scripts", type: "edit" },     // 部署 Worker 脚本
    { key: "workers_kv_storage", type: "edit" },  // (可选)KV/DO 相关
    { key: "account_settings", type: "read" },    // 读账号/子域
    { key: "zone", type: "read" },                // 读 zone(自定义域候选)
    { key: "workers_routes", type: "edit" },      // 绑 Worker 自定义域(workers.dev 被墙时的可达入口)
  ];
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(perms),
    name,
    accountId: "*",
    zoneId: "all",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${q.toString()}`;
}

// 由 workers.dev 子域计算本通道的**恒定** URL。子域是账号级、注册一次永不变。
export function relayUrl(subdomain) {
  if (!subdomain) throw new Error("subdomain required");
  return `https://${WORKER_NAME}.${subdomain}.workers.dev`;
}

// ── 网络辅助 ────────────────────────────────────────────────────────────────

async function cf(path, token, init = {}) {
  const r = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors && j.errors.map((e) => e.message).join("; ")) || `HTTP ${r.status}`;
    throw new Error(`CF ${path}: ${msg}`);
  }
  return j.result;
}

async function verifyToken(token) {
  const r = await cf("/user/tokens/verify", token);
  if (r.status !== "active") throw new Error(`token status=${r.status}`);
  return true;
}

async function firstAccountId(token) {
  const list = await cf("/accounts?per_page=50", token);
  if (!Array.isArray(list) || !list.length) throw new Error("no account on this token");
  return list[0].id;
}

// 取账号 workers.dev 子域; 若未注册则登记一个(账号级, 一次永久)。
async function ensureSubdomain(token, accountId) {
  try {
    const r = await cf(`/accounts/${accountId}/workers/subdomain`, token);
    if (r && r.subdomain) return r.subdomain;
  } catch { /* 守柔: 未注册时 CF 报错, 落到下方登记 */ }
  const cand = `dao-${accountId.slice(0, 8)}`;
  const r = await cf(`/accounts/${accountId}/workers/subdomain`, token, {
    method: "PUT",
    body: JSON.stringify({ subdomain: cand }),
  });
  return (r && r.subdomain) || cand;
}

// 宿主可能是 IDE 扩展宿主(Electron): 继承其 ELECTRON_RUN_AS_NODE / NODE_OPTIONS / NODE_CHANNEL_FD /
// npm_* 等会把子进程 node/npx 变成「Electron 假 node」或注入损坏参数, 实测 wrangler 在其中静默悬挂。
// 洗净后子进程即回到系统纯净 node —— 与用户手动在终端跑 wrangler 完全同构。
export function cleanChildEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) {
    if (/^(ELECTRON_|npm_|VSCODE_)/i.test(k) || k === "NODE_OPTIONS" || k === "NODE_CHANNEL_FD" || k === "NODE_ENV") delete env[k];
  }
  return env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: process.platform === "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "", done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(tm); resolve(r); } };
    // 部署有界: 10 分钟未归即杀(防僵尸悬挂拖死上层 provision 流程)。
    const tm = setTimeout(() => { try { p.kill(); } catch { /* 守柔 */ } fin({ code: null, out, err: err + "\n[timeout] 子进程超时(600s)被终止" }); }, 600000);
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => fin({ code: null, out, err: err + String(e) }));
    p.on("close", (code) => fin({ code, out, err }));
  });
}

// 某些网络环境(GFW 等)整体屏蔽 *.workers.dev; 若账号有活跃 zone(经 CF 反代通常可达),
// 尽力绑定 Workers 自定义域 dao-relay.<zone> 作首选入口, workers.dev 恒作回退。缺权限即静默跳过。
async function tryCustomDomain(token, accountId, log) {
  try {
    const zones = await cf("/zones?status=active&per_page=10", token);
    if (!Array.isArray(zones) || !zones.length) return null;
    const z = zones[0];
    const hostname = `dao-relay.${z.name}`;
    await cf(`/accounts/${accountId}/workers/domains`, token, {
      method: "PUT",
      body: JSON.stringify({ zone_id: z.id, hostname, service: WORKER_NAME, environment: "production" }),
    });
    return `https://${hostname}`;
  } catch (e) { log(`自定义域绑定跳过: ${e.message}`); return null; }
}

async function healthOk(url, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json().catch(() => ({})); if (j.status === "ok") return true; }
    } catch { /* 部署后边缘传播需几秒, 重试 */ }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return false;
}

function stateFile() {
  const dir = join(homedir(), ".dao");
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  return join(dir, "relay.json");
}

export function loadState() {
  try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return null; }
}

function saveState(s) {
  writeFileSync(stateFile(), JSON.stringify(s, null, 2));
  return stateFile();
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

// token: 可部署 Worker 的 Cloudflare Bearer 凭据 —— 既可是「预填深链创建·贴回」的 API Token,
//   也可是 OAuth 登录(oauth.mjs)拿到的 access_token(两者对 api.cloudflare.com 皆是 Bearer)。
// opts.skipVerify: OAuth access_token 不走 /user/tokens/verify(那是 API Token 专用), 传 true 跳过。
// opts.accountId : 自愈重部署时复用已知账号, 省一次 /accounts 拉取。
// opts.extraState: 合并进落盘状态(如 { auth:"oauth", oauth:{ refreshToken,... } })。
// 返回 { url, subdomain, accountId, savedTo, ... }。副作用: wrangler deploy + 落盘。
export async function provision(token, { log = console.log, skipVerify = false, accountId: accId, extraState = {} } = {}) {
  if (!token || token.length < 20) throw new Error("需要有效的 Cloudflare Bearer 凭据(API Token 或 OAuth access_token)");
  log("① 校验凭据…");
  if (!skipVerify) await verifyToken(token);
  const accountId = accId || await firstAccountId(token);
  log(`② 账号 ${accountId}`);
  const subdomain = await ensureSubdomain(token, accountId);
  const url = relayUrl(subdomain);
  log(`③ workers.dev 子域=${subdomain} → 恒定通道 ${url}`);

  const cwd = dirname(fileURLToPath(import.meta.url));
  log("④ wrangler deploy(后端全自动·免用户参与)…");
  const env = { ...cleanChildEnv(), CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false", CI: "true" };
  const dep = await run("npx", ["--yes", "wrangler@^3", "deploy"], { cwd, env });
  if (dep.code !== 0) throw new Error(`wrangler deploy 失败(code=${dep.code}): ${(dep.err || dep.out).slice(-800)}`);
  log("⑤ 部署完成, 尽力绑定自定义域(workers.dev 被墙网络的可达入口)…");
  const customUrl = await tryCustomDomain(token, accountId, log);
  if (customUrl) log(`   自定义域: ${customUrl}`);
  log("⑥ 等边缘传播并健康检查…");
  const customOk = customUrl ? await healthOk(customUrl, 6) : false;
  const ok = customOk || await healthOk(url, customUrl ? 4 : 10);
  // 本机可达者优先(customOk 说明本网络能直达自定义域); 否则退 workers.dev。
  const finalUrl = customOk ? customUrl : url;
  const state = { url: finalUrl, workersDevUrl: url, customUrl: customUrl || undefined, subdomain, accountId, token, deployedAt: new Date().toISOString(), healthy: ok, ...extraState };
  const savedTo = saveState(state);
  log(ok ? `✅ 持久通道就绪: ${finalUrl}` : `⚠ 已部署但健康检查暂未通过(边缘传播中): ${finalUrl}`);
  return { ...state, savedTo };
}

// 供 oauth.mjs / 自愈流程复用的落盘器与子域登记器。
export { saveState, ensureSubdomain, firstAccountId, stateFile };

// CLI: node provision.mjs [--deep-link | <token>]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (!arg || arg === "--deep-link") {
    console.log(tokenDeepLink());
  } else {
    provision(arg).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error("ERR", e.message); process.exit(1); });
  }
}
