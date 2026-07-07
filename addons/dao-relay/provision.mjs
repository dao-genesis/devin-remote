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
import { fileURLToPath } from "node:url";

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

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: process.platform === "win32", ...opts });
    let out = "", err = "";
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ code: null, out, err: err + String(e) }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
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

// token: Cloudflare API Token(经预填深链创建·贴回)。
// 返回 { url, subdomain, accountId, savedTo }。副作用: wrangler deploy + 落盘。
export async function provision(token, { log = console.log } = {}) {
  if (!token || token.length < 20) throw new Error("需要有效的 Cloudflare API Token(经预填深链创建)");
  log("① 校验 token…");
  await verifyToken(token);
  const accountId = await firstAccountId(token);
  log(`② 账号 ${accountId}`);
  const subdomain = await ensureSubdomain(token, accountId);
  const url = relayUrl(subdomain);
  log(`③ workers.dev 子域=${subdomain} → 恒定通道 ${url}`);

  const cwd = dirname(fileURLToPath(import.meta.url));
  log("④ wrangler deploy(后端全自动·免用户参与)…");
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false" };
  const dep = await run("npx", ["--yes", "wrangler@^3", "deploy"], { cwd, env });
  if (dep.code !== 0) throw new Error(`wrangler deploy 失败(code=${dep.code}): ${(dep.err || dep.out).slice(-800)}`);
  log("⑤ 部署完成, 等边缘传播并健康检查…");
  const ok = await healthOk(url);
  const state = { url, subdomain, accountId, token, deployedAt: new Date().toISOString(), healthy: ok };
  const savedTo = saveState(state);
  log(ok ? `✅ 持久通道就绪: ${url}` : `⚠ 已部署但健康检查暂未通过(边缘传播中): ${url}`);
  return { ...state, savedTo };
}

// CLI: node provision.mjs [--deep-link | <token>]
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg || arg === "--deep-link") {
    console.log(tokenDeepLink());
  } else {
    provision(arg).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error("ERR", e.message); process.exit(1); });
  }
}
