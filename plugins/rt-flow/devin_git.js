"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// devin_git.js · RT Flow 第三板块 · Git(GitHub) 接入底层 (无 vscode 依赖 · 可单测)
//
// 帛书·「物无非彼，物无非是」: 把 devin-git-auth 的核心资源模块整合进 rt-flow,
// 与第五板块 Devin Cloud 共用同一底层传输(devin_cloud.rawRequest · 统一代理+TLS 重试),
// 共用同一账号池(~/.dao / ~/.wam)与登录态(auth1)。
//
// 一个 Devin 账号(email+password → auth1+orgId)即可:
//   · 用 GitHub PAT 归一连接到同一个 GitHub 账号与仓库 (injectGitHubPAT + ensureGithubPatSecret)
//   · 显示已绑定身份(@login)、可达仓库数、密钥落库状态 (gitStatus)
//   · 真解绑(连接数归零 + OAuth 用户断开 + 密钥真删) (robustDisconnectGit · 复查扫除)
//
// 软编码·唯变所适: 端点集中于 EP, 凭证只在内存与 ~/.dao 缓存, 绝不写入仓库。
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const os = require("os");
const cloud = require("./devin_cloud");

const API = cloud.CFG.apiBase; // https://app.devin.ai/api
const GH_API = "https://api.github.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function authHeaders(auth, extra) {
  return Object.assign(
    { Authorization: "Bearer " + auth.auth1, "x-cog-org-id": auth.orgId },
    extra || {},
  );
}
function bare(auth) {
  return auth.orgBare || String(auth.orgId || "").replace(/^org-/, "");
}
async function jGet(auth, url, timeoutMs) {
  return cloud.jsonRequest("GET", url, authHeaders(auth), null, timeoutMs);
}
async function jPost(auth, url, body, timeoutMs) {
  return cloud.jsonRequest("POST", url, authHeaders(auth), body || {}, timeoutMs);
}
async function jDelete(auth, url, timeoutMs) {
  return cloud.jsonRequest("DELETE", url, authHeaders(auth), null, timeoutMs);
}

// ═══ Git 连接 / 身份 / 仓库 (读) ════════════════════════════════════════════
async function checkGitConnections(auth) {
  const r = await jGet(auth, API + "/organizations/" + auth.orgId + "/git-connections-metadata");
  if (r.status === 200 && r.json) {
    const conns = Array.isArray(r.json) ? r.json : r.json.git_connections || r.json.connections || [];
    return { ok: true, connections: conns, count: conns.length };
  }
  return { ok: false, connections: [], count: 0, error: (r.text || "").slice(0, 120) };
}

// 已绑定 GitHub 身份 (PAT/OAuth 均会surface @login)
async function getGitHubUser(auth) {
  const r = await jGet(auth, API + "/integrations/github/user");
  if (r.status === 200 && r.json) {
    const d = r.json;
    const login = d.login || d.username || d.user || (d.user && d.user.login) || "";
    return { ok: true, login, data: d };
  }
  return { ok: false, login: "", data: null };
}

async function getGitHubIntegration(auth) {
  const r = await jGet(auth, API + "/org-" + bare(auth) + "/integrations/github");
  if (r.status === 200 && r.json) return { ok: true, data: r.json };
  return { ok: false, data: null };
}

// 仓库可达性核验 · 连接成功的真凭实据 = 该 org 能否列出目标 GitHub 仓库 (摊平 full_name)
async function getAccessibleRepos(auth) {
  const r = await jGet(auth, API + "/org-" + bare(auth) + "/integrations/github/repos");
  if (r.status !== 200 || !r.json) return { ok: false, repos: [], error: "status=" + r.status };
  const groups = Array.isArray(r.json) ? r.json : r.json.repos || r.json.repositories || [];
  const flat = [];
  groups.forEach((g) => {
    if (g && g.gh_repos) g.gh_repos.forEach((rp) => { if (rp && rp.full_name) flat.push(rp.full_name); });
    else if (g && (g.full_name || g.name)) flat.push(g.full_name || g.name);
  });
  return { ok: true, repos: flat };
}

// ═══ 密钥 GITHUB_PAT (写后复制延迟 · 双读确认落库) ═══════════════════════════
async function listSecrets(auth) {
  const r = await jGet(auth, API + "/org-" + bare(auth) + "/secrets");
  if (r.status !== 200 || !r.json) return [];
  return Array.isArray(r.json) ? r.json : r.json.secrets || [];
}
async function hasGithubPatSecret(auth) {
  const secrets = await listSecrets(auth);
  return !!secrets.find((s) => s.key === "GITHUB_PAT" || s.name === "GITHUB_PAT");
}
async function injectSecret(auth, name, value) {
  const r = await jPost(auth, API + "/org-" + bare(auth) + "/secrets", {
    key: name, value, type: "key-value", sensitive: true, note: name,
  });
  if (r.status === 200 || r.status === 201 || r.status === 409)
    return { ok: true, existed: r.status === 409 };
  return { ok: false, error: (r.text || "").slice(0, 120) };
}
// 注入并校验落库: settle 后「连续两次」读到才算稳态(排除尚未持久化的瞬态副本), 最多 3 轮。
async function ensureGithubPatSecret(auth, pat) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await injectSecret(auth, "GITHUB_PAT", pat); } catch (e) {}
    await sleep(1200);
    try {
      if (await hasGithubPatSecret(auth)) { await sleep(600); if (await hasGithubPatSecret(auth)) return true; }
    } catch (e) {}
    await sleep(800);
  }
  return false;
}
// 删除组织 Secret · 彻底解绑(删后零关联): 正确端点 DELETE /api/secrets/{id} (id 全局唯一·路径不含 org)
async function deleteSecret(auth, name) {
  const secrets = await listSecrets(auth);
  const hit = secrets.find((s) => s.key === name || s.name === name);
  if (!hit) return { ok: true, missing: true };
  const sid = hit.id || hit.secret_id;
  if (!sid) return { ok: false, error: "no_secret_id" };
  const r = await jDelete(auth, API + "/secrets/" + encodeURIComponent(sid));
  if (r.status === 200 || r.status === 204 || r.status === 404) return { ok: true };
  return { ok: false, error: "status=" + r.status };
}

// ═══ PAT 注入 / OAuth ════════════════════════════════════════════════════════
async function injectGitHubPAT(auth, pat) {
  const r = await jPost(auth, API + "/" + auth.orgId + "/integrations/github/pat", { pat }, 60000);
  if (r.status === 200 || r.status === 201) return { ok: true };
  const t = (r.text || "").toLowerCase();
  if (r.status === 400 && t.includes("already registered"))
    return { ok: false, alreadyRegistered: true, error: "该组织已有 GitHub App 安装, 将尝试连接现有安装" };
  if (r.status === 400 && t.includes("invalid pat"))
    return { ok: false, invalidPat: true, error: "PAT 无效或已过期" };
  return { ok: false, error: (r.text || "").slice(0, 200) || "status=" + r.status };
}

// ═══ 断开族 ════════════════════════════════════════════════════════════════
async function disconnectGitHubConnection(auth, connectionName, host) {
  const h = host || "github.com";
  const name = connectionName || "github";
  const q = "?name=" + encodeURIComponent(name) + "&host=" + encodeURIComponent(h);
  let r = await jDelete(auth, API + "/org-" + bare(auth) + "/integrations/github" + q);
  if (r.status === 200 || r.status === 204) return { ok: true };
  if (r.status === 404) {
    r = await jDelete(auth, API + "/" + auth.orgId + "/integrations/github" + q);
    if (r.status === 200 || r.status === 204) return { ok: true };
  }
  return { ok: false, status: r.status, error: (r.text || "").slice(0, 200) };
}
async function disconnectGitHubUser(auth) {
  const r = await jDelete(auth, API + "/integrations/github/user");
  if (r.status === 200 || r.status === 204) return { ok: true };
  return { ok: false, status: r.status, error: (r.text || "").slice(0, 200) };
}
async function disconnectGitHubPAT(auth, connectionId) {
  const r = await jDelete(auth, API + "/" + auth.orgId + "/integrations/github/pat?connection_id=" + connectionId);
  if (r.status === 200 || r.status === 204) return { ok: true };
  return { ok: false, status: r.status, error: (r.text || "").slice(0, 200) };
}

// ═══ 健壮断开 · 真解绑须连接数归零(复查扫除·反复至成) ═══════════════════════
async function robustDisconnectGit(auth) {
  const logs = [];
  const gc = await checkGitConnections(auth);
  if (gc.ok && gc.count > 0) {
    for (let i = 0; i < gc.connections.length; i++) {
      const c = gc.connections[i];
      const cName = c.name || c.installation_name || "github";
      const cHost = c.host || "github.com";
      const cId = c.id || c.git_connection_id || c.connection_id || null;
      logs.push("连接[" + i + "]: " + cName + " @ " + cHost + " type=" + (c.type || "?"));
      const disR = await disconnectGitHubConnection(auth, cName, cHost);
      logs.push("断开name+host: " + (disR.ok ? "OK" : "FAIL " + (disR.error || "").slice(0, 60)));
      if (cId) {
        const patDisR = await disconnectGitHubPAT(auth, cId);
        logs.push("断开PAT连接: " + (patDisR.ok ? "OK" : "SKIP"));
      }
    }
  } else {
    logs.push("当前无Git连接, 尝试通用断开");
    const disR2 = await disconnectGitHubConnection(auth, "github", "github.com");
    logs.push("通用断开: " + (disR2.ok ? "OK" : "FAIL " + (disR2.error || "").slice(0, 60)));
  }
  const userDisR = await disconnectGitHubUser(auth);
  logs.push("断开OAuth用户: " + (userDisR.ok ? "OK" : "FAIL " + (userDisR.error || "").slice(0, 60)));
  const secDelR = await deleteSecret(auth, "GITHUB_PAT");
  logs.push("删除GITHUB_PAT密钥: " + (secDelR.ok ? (secDelR.missing ? "无需(不存在)" : "OK") : "FAIL " + (secDelR.error || "").slice(0, 60)));
  // 复查并扫除残留: 刚建连接首次断开可能尚未可删(瞬态), settle 后按 id 逐个强删, 最多 3 轮。
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(800);
    const vc = await checkGitConnections(auth);
    if (!vc.ok) { logs.push("复查连接失败: " + (vc.error || "")); break; }
    if (vc.count === 0) { logs.push("复查: 连接已归零"); break; }
    logs.push("复查[轮" + (attempt + 1) + "]: 残留 " + vc.count + " 个, 强删");
    for (let j = 0; j < vc.connections.length; j++) {
      const rc = vc.connections[j];
      const rcName = rc.name || rc.installation_name || "github";
      const rcId = rc.id || rc.git_connection_id || rc.connection_id || null;
      try { await disconnectGitHubConnection(auth, rcName, rc.host || "github.com"); } catch (e) {}
      if (rcId) {
        const rr = await disconnectGitHubPAT(auth, rcId);
        logs.push("  强删 " + rcName + "(" + (rc.type || "?") + "): " + (rr.ok ? "OK" : "FAIL"));
      }
    }
  }
  return logs;
}

// 切换后清理残留 · 自由切换须干净(A→B 后不留 A), 只保留 keepName
async function cleanupStaleConnections(auth, keepName) {
  const logs = [];
  try {
    const gc = await checkGitConnections(auth);
    if (!gc.ok || !gc.connections) return logs;
    for (let i = 0; i < gc.connections.length; i++) {
      const c = gc.connections[i];
      const cName = c.name || c.installation_name || "";
      const cId = c.id || c.git_connection_id || c.connection_id || null;
      if (keepName && cName === keepName) continue;
      try { await disconnectGitHubConnection(auth, cName, c.host || "github.com"); } catch (e) {}
      if (cId) {
        const r = await disconnectGitHubPAT(auth, cId);
        logs.push("清理残留 " + cName + "(" + (c.type || "?") + "): " + (r.ok ? "OK" : "FAIL"));
      }
    }
  } catch (e) { logs.push("cleanup异常 " + (e && e.message)); }
  return logs;
}

// ═══ 高层组合 · 归一连接 / 状态 ═══════════════════════════════════════════════
// connectWithPat: 注入 PAT → 落库 GITHUB_PAT 密钥 → 核验已绑身份+可达仓库 → 返回真凭实据
async function connectWithPat(auth, pat) {
  if (!pat) return { ok: false, error: "无 PAT (请输入或在 ~/.dao/git-pats.json 配置)" };
  const inj = await injectGitHubPAT(auth, pat);
  // alreadyRegistered: 组织已有 App 安装, 仍尝试落库密钥并核验现有连接(归一不重复装 App)
  const secOk = await ensureGithubPatSecret(auth, pat);
  await sleep(600);
  const [user, repos, conns] = await Promise.all([
    getGitHubUser(auth).catch(() => ({ ok: false, login: "" })),
    getAccessibleRepos(auth).catch(() => ({ ok: false, repos: [] })),
    checkGitConnections(auth).catch(() => ({ ok: false, count: 0 })),
  ]);
  const repoCount = (repos.repos || []).length;
  const connCount = conns.count || 0;
  // PAT 连接下 /integrations/github/user 常空, 连接元数据的 name 即已绑 GitHub 身份, 作兜底。
  const connName = ((conns.connections || [])[0] || {});
  const login = user.login || connName.name || connName.installation_name || "";
  const ok = (inj.ok || inj.alreadyRegistered || connCount > 0 || repoCount > 0);
  return {
    ok,
    login,
    repoCount,
    repos: (repos.repos || []).slice(0, 50),
    connections: connCount,
    secret: secOk,
    alreadyRegistered: !!inj.alreadyRegistered,
    invalidPat: !!inj.invalidPat,
    error: ok ? "" : inj.error || "连接未生效(0 连接·0 仓库)",
  };
}

// gitStatus: 当前账号的 Git 绑定快照 (下拉框/概览用) — 不写, 只读
async function gitStatus(auth) {
  const [user, conns, secret, repos] = await Promise.all([
    getGitHubUser(auth).catch(() => ({ ok: false, login: "" })),
    checkGitConnections(auth).catch(() => ({ ok: false, count: 0, connections: [] })),
    hasGithubPatSecret(auth).catch(() => false),
    getAccessibleRepos(auth).catch(() => ({ ok: false, repos: [] })),
  ]);
  const connNames = (conns.connections || []).map((c) => c.name || c.installation_name || c.type || "github");
  return {
    login: user.login || connNames[0] || "",
    connections: conns.count || 0,
    connNames,
    secret: !!secret,
    repoCount: (repos.repos || []).length,
  };
}

// ═══ PAT 账号池 (~/.dao/git-pats.json) · 与 devin-git-auth 同源 ════════════════
// 形态: { "default": "ghp_...", "overrides": { "email@x": "ghp_..." } }
//   或  { "email@x": "ghp_...", "_default": "ghp_..." }
function loadPatPool() {
  const out = { default: "", overrides: {} };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dao", "git-pats.json"), "utf8"));
    if (j && typeof j === "object") {
      out.default = j.defaultPat || j.default || j._default || j.pat || "";
      const ov = j.overrides || {};
      for (const k of Object.keys(j)) {
        if (/@/.test(k)) out.overrides[k.toLowerCase()] = j[k];
      }
      for (const k of Object.keys(ov)) out.overrides[k.toLowerCase()] = ov[k];
    }
  } catch (e) {}
  return out;
}
function patFor(email) {
  const pool = loadPatPool();
  return (email && pool.overrides[String(email).toLowerCase()]) || pool.default || "";
}

module.exports = {
  API,
  GH_API,
  // reads
  checkGitConnections,
  getGitHubUser,
  getGitHubIntegration,
  getAccessibleRepos,
  hasGithubPatSecret,
  listSecrets,
  gitStatus,
  // writes
  injectGitHubPAT,
  injectSecret,
  ensureGithubPatSecret,
  deleteSecret,
  connectWithPat,
  // disconnect
  disconnectGitHubConnection,
  disconnectGitHubUser,
  disconnectGitHubPAT,
  robustDisconnectGit,
  cleanupStaleConnections,
  // pat pool
  loadPatPool,
  patFor,
};
