// ═══════════════════════════════════════════════════════════════
//   devin-git-auth · VSX Extension v2
//   反者道之动 · 弱者道之用 · 无为而无不为
//   道法自然 · 三按钮并排 · 读取状态 | 断开Git | 连接Git
// ═══════════════════════════════════════════════════════════════
"use strict";

const vscode = require("vscode");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const url = require("url");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ═══ 常量 ═══
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const WINDSURF = "https://windsurf.com";
const DEVIN = "https://app.devin.ai";
const HTTP_TIMEOUT = 15000;
const PAT_TIMEOUT = 30000;

// ═══ 代理自适应 ═══
var PROXY_HOST = null, PROXY_PORT = null, _proxyTested = false;
var PROXY_DOMAINS = ["app.devin.ai","windsurf.com","register.windsurf.com","server.codeium.com"];

function domainNeedsProxy(h) {
  for (var i = 0; i < PROXY_DOMAINS.length; i++) {
    if (h === PROXY_DOMAINS[i] || h.endsWith("." + PROXY_DOMAINS[i])) return true;
  }
  return false;
}
function currentProxy() {
  if (_proxyTested) return PROXY_HOST ? { host: PROXY_HOST, port: PROXY_PORT } : null;
  return null;
}

// ═══ HTTP · 善行者无辙迹 ═══
function rawRequest(method, targetUrl, headers, body, opts) {
  opts = opts || {};
  var timeout = opts.timeoutMs || HTTP_TIMEOUT;
  var forceDirect = opts.forceDirect;
  var forceProxy = opts.forceProxy;
  return new Promise(function (resolve) {
    var u; try { u = new url.URL(targetUrl); } catch (e) { return resolve({ status: 0, json: null, text: "bad_url" }); }
    var data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    var reqHeaders = Object.assign({
      "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "User-Agent": UA,
    }, headers || {});
    if (data) reqHeaders["Content-Length"] = data.length;

    var useProxy = false, proxyInfo = null;
    if (forceDirect) { useProxy = false; }
    else if (forceProxy) { useProxy = true; proxyInfo = forceProxy; }
    else { var p = currentProxy(); if (p && domainNeedsProxy(u.hostname)) { useProxy = true; proxyInfo = p; } }

    if (useProxy && proxyInfo) {
      var proxyHeaders = Object.assign({}, reqHeaders, { "Host": u.hostname });
      var proxyReq = http.request({
        hostname: proxyInfo.host, port: proxyInfo.port, path: targetUrl,
        method: method, headers: proxyHeaders, timeout: timeout,
      }, function (res) {
        var chunks = []; res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          var text = Buffer.concat(chunks).toString("utf8"); var j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {}
          resolve({ status: res.statusCode || 0, json: j, text: text });
        });
      });
      proxyReq.on("error", function (e) { resolve({ status: 0, json: null, text: "proxy_err: " + e.message }); });
      proxyReq.on("timeout", function () { proxyReq.destroy(); resolve({ status: 0, json: null, text: "proxy_timeout" }); });
      if (data) proxyReq.write(data); proxyReq.end(); return;
    }

    var req = https.request({
      method: method, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, headers: reqHeaders, timeout: timeout,
    }, function (res) {
      var chunks = []; res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8"); var j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode || 0, json: j, text: text });
      });
    });
    req.on("error", function (e) { resolve({ status: 0, json: null, text: "err: " + e.message }); });
    req.on("timeout", function () { req.destroy(); resolve({ status: 0, json: null, text: "timeout" }); });
    if (data) req.write(data); req.end();
  });
}

function jsonPost(t, h, b, o) { return rawRequest("POST", t, h, b, o); }
function jsonGet(t, h, o) { return rawRequest("GET", t, h, null, o); }
function jsonDelete(t, h, o) { return rawRequest("DELETE", t, h, null, o); }

// ═══ 代理检测 ═══
async function autoDetectProxy() {
  if (_proxyTested) return currentProxy();
  var direct = await rawRequest("GET", DEVIN + "/api/health", null, null, { timeoutMs: 5000, forceDirect: true });
  if (direct.status > 0 && direct.text !== "timeout" && direct.text !== "proxy_timeout") {
    _proxyTested = true; PROXY_HOST = null; return null;
  }
  var candidates = [
    { host: "127.0.0.1", port: 7890 }, { host: "127.0.0.1", port: 1080 },
    { host: "127.0.0.1", port: 10809 }, { host: "127.0.0.1", port: 10808 },
    { host: "127.0.0.1", port: 7897 },
  ];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var test = await rawRequest("GET", DEVIN + "/api/health", null, null, { timeoutMs: 4000, forceProxy: c });
    if (test.status > 0 && test.text !== "timeout" && test.text !== "proxy_timeout" && test.text !== "proxy_err") {
      PROXY_HOST = c.host; PROXY_PORT = c.port; _proxyTested = true; return { host: PROXY_HOST, port: PROXY_PORT };
    }
  }
  _proxyTested = true; PROXY_HOST = null; return null;
}

// ═══ 认证链 · 天得一以清 ═══
async function devinLogin(email, password) {
  var retry = 0;
  while (retry < 3) {
    var r = await jsonPost(WINDSURF + "/_devin-auth/password/login",
      { Origin: WINDSURF, Referer: WINDSURF + "/account/login" },
      { email: email, password: password });
    if (r.status === 429 && retry < 2) { await sleep(Math.pow(2, retry) * 2000); retry++; continue; }
    var j = r.json || {};
    if (j.token && j.user_id) return { auth1: j.token, userId: j.user_id };
    throw new Error((j.detail || j.error || j.message || "no_token") + " code=" + r.status);
  }
}

async function devinPostAuth(auth1) {
  var r = await jsonPost(DEVIN + "/api/users/post-auth", { Authorization: "Bearer " + auth1 }, {});
  var j = r.json || {};
  var orgId = (j.org && j.org.org_id) || j.org_id || "";
  var orgName = (j.org && j.org.org_name) || j.org_name || "";
  if (!orgId) throw new Error("no orgId code=" + r.status);
  return { orgId: orgId, orgName: orgName };
}

// ═══ Git 连接 API · 道生一 ═══

async function checkGitConnections(orgId, auth1) {
  var r = await jsonGet(DEVIN + "/api/organizations/" + orgId + "/git-connections-metadata", {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status === 200 && r.json) {
    var conns = Array.isArray(r.json) ? r.json : (r.json.git_connections || []);
    return { ok: true, connections: conns, count: conns.length };
  }
  return { ok: false, connections: [], count: 0, error: r.text ? r.text.slice(0, 100) : String(r.status) };
}

async function getGitHubIntegration(orgId, auth1) {
  var bareOrgId = orgId.replace(/^org-/, "");
  var r = await jsonGet(DEVIN + "/api/org-" + bareOrgId + "/integrations/github", {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status === 200 && r.json) return { ok: true, data: r.json };
  return { ok: false, data: null };
}

async function getGitHubUser(auth1, orgId) {
  var r = await jsonGet(DEVIN + "/api/integrations/github/user", {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId || "",
  });
  if (r.status === 200 && r.json) return { ok: true, data: r.json };
  return { ok: false, data: null };
}

// ═══ GitHub CLI 设备码认证 · 弱者道之用 ═══
// Devin官方前端使用的认证方式 — 对所有账号有效(包括旧账号)
async function ghCliRequestCode(orgId, auth1) {
  var r = await jsonPost(DEVIN + "/api/integrations/gh_cli/code",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId }, {},
    { timeoutMs: 30000 });
  if (r.status === 200 && r.json) {
    var d = r.json.device || r.json;
    return { ok: true, userCode: d.user_code, verificationUri: d.verification_uri, interval: d.interval || 5, expiresAt: d.expires_at };
  }
  return { ok: false, error: r.text ? r.text.slice(0, 200) : "status=" + r.status };
}

async function ghCliPollState(orgId, auth1) {
  var r = await jsonGet(DEVIN + "/api/integrations/gh_cli/state",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId });
  if (r.status === 200 && r.json) {
    return { ok: true, error: r.json.error, oauth: r.json.oauth, device: r.json.device, lastPoll: r.json.last_poll };
  }
  return { ok: false, error: r.text ? r.text.slice(0, 200) : "status=" + r.status };
}

async function injectGitHubPAT(orgId, pat, auth1) {
  var r = await jsonPost(DEVIN + "/api/" + orgId + "/integrations/github/pat",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId },
    { pat: pat }, { timeoutMs: 60000 });
  if (r.status === 200 || r.status === 201) return { ok: true };
  if (r.status === 400 && r.text && r.text.includes("already registered")) {
    return { ok: false, alreadyRegistered: true, error: "该组织已有GitHub App安装, 将尝试连接现有安装" };
  }
  if (r.status === 400 && r.text && r.text.toLowerCase().includes("invalid pat")) {
    return { ok: false, invalidPat: true, error: "PAT 无效或已过期" };
  }
  return { ok: false, error: r.text ? r.text.slice(0, 200) : "status=" + r.status };
}

// ═══ 仓库可达性核验 · 见其本 ═══
// 连接成功的真凭实据 = 该 org 能否列出目标 GitHub 仓库。
// 返回扁平化 full_name 列表 (后端按 gh_org 分组, 此处摊平)。
async function getAccessibleRepos(orgId, auth1) {
  var bareOrgId = orgId.replace(/^org-/, "");
  var r = await jsonGet(DEVIN + "/api/org-" + bareOrgId + "/integrations/github/repos", {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status !== 200 || !r.json) return { ok: false, repos: [], error: "status=" + r.status };
  var groups = Array.isArray(r.json) ? r.json : (r.json.repos || r.json.repositories || []);
  var flat = [];
  groups.forEach(function (g) {
    if (g && g.gh_repos) { g.gh_repos.forEach(function (rp) { if (rp && rp.full_name) flat.push(rp.full_name); }); }
    else if (g && (g.full_name || g.name)) { flat.push(g.full_name || g.name); }
  });
  return { ok: true, repos: flat };
}

// 断开GitHub连接 — 先用name+host, 回退到orgId前缀
async function disconnectGitHubConnection(orgId, connectionName, host, auth1) {
  var bareOrgId = orgId.replace(/^org-/, "");
  var h = host || "github.com";
  var name = connectionName || "github";
  var r = await jsonDelete(DEVIN + "/api/org-" + bareOrgId + "/integrations/github?name=" + encodeURIComponent(name) + "&host=" + encodeURIComponent(h), {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status === 200 || r.status === 204) return { ok: true };
  if (r.status === 404) {
    r = await jsonDelete(DEVIN + "/api/" + orgId + "/integrations/github?name=" + encodeURIComponent(name) + "&host=" + encodeURIComponent(h), {
      Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
    });
    if (r.status === 200 || r.status === 204) return { ok: true };
  }
  return { ok: false, status: r.status, error: r.text ? r.text.slice(0, 200) : "unknown" };
}

async function disconnectGitHubUser(auth1, orgId) {
  var r = await jsonDelete(DEVIN + "/api/integrations/github/user", {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status === 200 || r.status === 204) return { ok: true };
  return { ok: false, status: r.status, error: r.text ? r.text.slice(0, 200) : "unknown" };
}

async function disconnectGitHubPAT(orgId, connectionId, auth1) {
  var r = await jsonDelete(DEVIN + "/api/" + orgId + "/integrations/github/pat?connection_id=" + connectionId, {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status === 200 || r.status === 204) return { ok: true };
  return { ok: false, status: r.status, error: r.text ? r.text.slice(0, 200) : "unknown" };
}

async function injectSecret(orgId, name, value, auth1) {
  var bareOrgId = orgId.replace(/^org-/, "");
  var r = await jsonPost(DEVIN + "/api/org-" + bareOrgId + "/secrets",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId },
    { key: name, value: value, type: "key-value", sensitive: true, note: name });
  if (r.status === 200 || r.status === 201 || r.status === 409) return { ok: true, existed: r.status === 409 };
  return { ok: false, error: r.text ? r.text.slice(0, 100) : String(r.status) };
}

// ═══ GitHub API · 用PAT直接查App安装 ═══
async function getGitHubAppInstallations(pat) {
  var r = await rawRequest("GET", "https://api.github.com/user/installations",
    { "Authorization": "token " + pat, "Accept": "application/vnd.github.v3+json" },
    null, { timeoutMs: 10000, forceDirect: true });
  if (r.status === 200 && r.json) {
    var insts = r.json.installations || (Array.isArray(r.json) ? r.json : []);
    return { ok: true, installations: insts };
  }
  return { ok: false, installations: [], error: r.text ? r.text.slice(0, 100) : "status=" + r.status };
}

// ═══ 健壮断开 · 先实时查状态再断 · 不依赖缓存 ═══
async function robustDisconnectGit(email, auth1, orgId) {
  var logs = [];

  // 1. 实时查当前Git连接
  var gc = await checkGitConnections(orgId, auth1);
  if (gc.ok && gc.count > 0) {
    for (var i = 0; i < gc.connections.length; i++) {
      var c = gc.connections[i];
      var cName = c.name || c.installation_name || "github";
      var cHost = c.host || "github.com";
      var cId = c.id || c.git_connection_id || null;
      logs.push("连接[" + i + "]: " + cName + " @ " + cHost + " type=" + (c.type || "?"));

      // 断开 name+host
      var disR = await disconnectGitHubConnection(orgId, cName, cHost, auth1);
      logs.push("断开name+host: " + (disR.ok ? "OK" : "FAIL " + (disR.error || "").slice(0, 60)));

      // 断开PAT连接
      if (cId) {
        var patDisR = await disconnectGitHubPAT(orgId, cId, auth1);
        logs.push("断开PAT连接: " + (patDisR.ok ? "OK" : "SKIP"));
      }
    }
  } else {
    logs.push("当前无Git连接, 尝试通用断开");
    // 通用断开: 用默认name
    var disR2 = await disconnectGitHubConnection(orgId, "github", "github.com", auth1);
    logs.push("通用断开: " + (disR2.ok ? "OK" : "FAIL " + (disR2.error || "").slice(0, 60)));
  }

  // 2. 断开GitHub OAuth用户
  var userDisR = await disconnectGitHubUser(auth1, orgId);
  logs.push("断开OAuth用户: " + (userDisR.ok ? "OK" : "FAIL " + (userDisR.error || "").slice(0, 60)));

  return logs;
}

// ═══ 工具 ═══
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ═══ 状态持久化 ═══
var STATE_FILE = path.join(os.homedir(), ".devin-git-auth.json");

// ═══ 共享凭据池 · 道生一 · 与 dao-vsix 同源 ═══
// ~/.dao/accounts.json  (email->password) 与 ~/.dao/git-pats.json (PAT) 由 dao 全家桶共用。
// 密码仅驻内存(_daoPasswords), 永不写入 STATE_FILE。用户无需手动输入任何账号/PAT。
var DAO_DIR = path.join(os.homedir(), ".dao");
var DAO_ACCOUNTS_FILE = path.join(DAO_DIR, "accounts.json");
var DAO_PATS_FILE = path.join(DAO_DIR, "git-pats.json");
var _daoPasswords = {};   // email -> password (内存)
var _daoDefaultPat = null;
var _daoPatOverrides = {}; // email -> pat

function loadDaoPool() {
  // 账号池
  var pooled = [];
  try {
    var raw = JSON.parse(fs.readFileSync(DAO_ACCOUNTS_FILE, "utf8"));
    var list = Array.isArray(raw) ? raw : (raw.accounts || []);
    list.forEach(function (a) {
      if (a && a.email && a.password) { _daoPasswords[a.email] = a.password; pooled.push(a.email); }
    });
  } catch (e) {}
  // PAT池
  try {
    var pj = JSON.parse(fs.readFileSync(DAO_PATS_FILE, "utf8"));
    _daoDefaultPat = pj.defaultPat || pj.pat || null;
    _daoPatOverrides = pj.overrides || {};
  } catch (e) {}
  return pooled;
}

// 解析某账号应使用的 PAT: 优先 email 覆盖, 回退默认池 PAT
function patFor(email) { return _daoPatOverrides[email] || _daoDefaultPat || null; }
// 解析某账号密码: state 内不存密码, 故统一从内存池取
function passwordFor(email, acct) { return (acct && acct.password) || _daoPasswords[email] || null; }

function loadState() {
  var st;
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) {}
  if (!st) st = { accounts: {}, pat: null, meta: { created: new Date().toISOString() } };
  if (!st.accounts) st.accounts = {};
  // 合并 dao 账号池: 池中每个账号自动登记(密码不入盘), 用户零输入即可批量连接。
  var pooled = loadDaoPool();
  pooled.forEach(function (email) {
    if (!st.accounts[email]) st.accounts[email] = { email: email, fromPool: true };
  });
  if (!st.pat && _daoDefaultPat) st.pat = _daoDefaultPat;
  return st;
}
function saveState(state) {
  if (!state.meta) state.meta = {};
  state.meta.lastRun = new Date().toISOString();
  var safe = JSON.parse(JSON.stringify(state));
  if (safe.accounts) Object.keys(safe.accounts).forEach(function (k) { delete safe.accounts[k]._auth1; delete safe.accounts[k]._connectionId; delete safe.accounts[k].password; });
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2), "utf8"); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// Webview HTML v2 · 道法自然 · 三按钮并排
// 读取状态 | 断开Git | 连接Git — 永远可见，无为而无不为
// ═══════════════════════════════════════════════════════════════

function getWebviewHtml(webview, extensionUri) {
  const nonce = crypto.randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Devin Git Auth</title>
<style nonce="${nonce}">
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#1e1e2e;--sf:#2a2a3e;--bd:#3a3a5e;
  --tx:#cdd6f4;--tx2:#7f849c;--ac:#89b4fa;
  --gn:#a6e3a1;--rd:#f38ba8;--yl:#f9e2af;--r:8px;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--tx);padding:12px;font-size:13px;line-height:1.5}
.sec{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:12px;margin-bottom:10px}
.stit{font-size:13px;font-weight:600;margin-bottom:10px;color:var(--ac);display:flex;align-items:center;gap:6px}
.stit::before{content:'';width:3px;height:13px;background:var(--ac);border-radius:2px}
label{display:block;font-size:11px;color:var(--tx2);margin-bottom:3px}
input{width:100%;padding:7px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);color:var(--tx);font-size:13px;outline:none;transition:border-color .2s}
input:focus{border-color:var(--ac)}
input::placeholder{color:var(--tx2)}
.ig{margin-bottom:8px}
.row{display:flex;gap:8px}.row>*{flex:1}
button{padding:7px 14px;border:none;border-radius:var(--r);font-size:12px;font-weight:500;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
button:disabled{opacity:.4;cursor:not-allowed}
.bp{background:var(--ac);color:#1e1e2e}.bp:hover:not(:disabled){background:#74c7ec}
.bd{background:var(--rd);color:#1e1e2e}.bd:hover:not(:disabled){background:#eba0ac}
.bg{background:transparent;border:1px solid var(--bd);color:var(--tx)}.bg:hover:not(:disabled){border-color:var(--ac);color:var(--ac)}
.brow{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
/* 三按钮并排 — 核心操作区 */
.core-btns{display:flex;gap:6px;margin-top:10px}
.core-btns button{flex:1;padding:8px 6px;font-size:11px;font-weight:600;justify-content:center}
.badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:500}
.b-ok{background:rgba(166,227,161,.15);color:var(--gn)}
.b-err{background:rgba(243,139,168,.15);color:var(--rd)}
.b-warn{background:rgba(249,226,175,.15);color:var(--yl)}
.b-idle{background:rgba(127,132,156,.15);color:var(--tx2)}
.card{background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);padding:8px;margin-top:6px}
.card .ct{font-weight:600;color:var(--ac);font-size:11px}
.card .cd{color:var(--tx2);font-size:11px;margin-top:2px}
.log{background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);padding:8px;margin-top:6px;max-height:180px;overflow-y:auto;font-family:'Cascadia Code',monospace;font-size:10px;line-height:1.5}
.ll{white-space:pre-wrap;word-break:break-all}
.lo{color:var(--gn)}.le{color:var(--rd)}.li{color:var(--tx2)}.lw{color:var(--yl)}
.alist{margin-top:6px}
.ai{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);margin-bottom:5px;cursor:pointer;transition:border-color .2s}
.ai:hover{border-color:var(--ac)}
.ai.active{border-color:var(--ac);background:rgba(137,180,250,.08)}
.ae{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.as{display:flex;gap:3px;align-items:center;flex-shrink:0}
.spin{width:12px;height:12px;border:2px solid var(--bd);border-top-color:var(--ac);border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.hidden{display:none}
.ps{font-size:10px;color:var(--tx2);margin-top:3px}
.divider{height:1px;background:var(--bd);margin:8px 0}
/* 状态信息区 */
.status-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px;margin-top:6px}
.status-grid .sk{color:var(--tx2);text-align:right}
.status-grid .sv{color:var(--tx);word-break:break-all}
</style>
</head>
<body>

<!-- ═══ PAT ═══ -->
<div class="sec">
  <div class="stit">GitHub PAT</div>
  <div class="ig">
    <label>Personal Access Token</label>
    <input type="password" id="patInput" placeholder="ghp_xxxxxxxxxxxx">
  </div>
  <div class="brow">
    <button class="bg" id="btnSavePAT">保存</button>
    <button class="bg" id="btnToggleVis">显示/隐藏</button>
  </div>
  <div class="ps" id="proxyStatus">代理: 检测中...</div>
</div>

<!-- ═══ 账号认证 ═══ -->
<div class="sec">
  <div class="stit">账号认证</div>
  <div class="row">
    <div class="ig"><label>邮箱</label><input type="email" id="emailInput" placeholder="user@example.com"></div>
    <div class="ig"><label>密码</label><input type="password" id="passwordInput" placeholder="密码"></div>
  </div>
  <div class="brow">
    <button class="bp" id="btnLogin">登录认证</button>
    <button class="bg" id="btnClear">清空</button>
  </div>
</div>

<!-- ═══ Git操作 · 三按钮始终可见 ═══ -->
<div class="sec" id="statusSection">
  <div class="stit">Git 操作</div>
  <div id="accountInfo" style="color:var(--tx2);font-size:11px">请先登录账号</div>
  <div class="divider"></div>
  <div id="gitStatus"></div>
  <!-- 三按钮并排 · 道法自然 · 始终可见 -->
  <div class="core-btns">
    <button class="bp" id="btnRead" disabled>读取状态</button>
    <button class="bd" id="btnDisconnect" disabled>断开Git</button>
    <button class="bg" id="btnConnect" disabled>连接Git</button>
  </div>
</div>

<!-- ═══ 批量操作 · 突破一切阻碍 ═══ -->
<div class="sec">
  <div class="stit">批量操作 · 多账号→单仓库</div>
  <div style="color:var(--tx2);font-size:11px;margin-bottom:6px">一键将所有已登录账号连接到同一GitHub仓库(使用上方PAT)</div>
  <div class="brow">
    <button class="bp" id="btnBatchConnect">⚡ 批量连接Git</button>
    <button class="bg" id="btnBatchLogin">📋 批量导入</button>
  </div>
  <div id="batchStatus" style="margin-top:6px;font-size:11px;color:var(--tx2)"></div>
</div>

<!-- ═══ 已保存账号 ═══ -->
<div class="sec">
  <div class="stit">已认证账号</div>
  <div class="alist" id="accountList">
    <div style="color:var(--tx2);font-size:11px;">暂无账号</div>
  </div>
</div>

<!-- ═══ 日志 ═══ -->
<div class="sec">
  <div class="stit" id="btnClearLog" style="cursor:pointer">操作日志 <span style="font-size:10px;color:var(--tx2)">(点击清空)</span></div>
  <div class="log" id="logArea"></div>
</div>

<script nonce="${nonce}">
// ═══════════════════════════════════════════════════════════
// 前端 · 道法自然 · 三按钮并排 · 无为而无不为
// ═══════════════════════════════════════════════════════════

const vscode = acquireVsCodeApi();

let cur = null;   // 当前账号完整信息
let saved = {};   // email -> { email, orgId, orgName, git, gitType, gitName, gitOwner, secret, lastCheck }

// ─── 日志 ───
function log(msg, type) {
  const area = document.getElementById('logArea');
  const ts = new Date().toLocaleTimeString('zh-CN',{hour12:false});
  const cls = type==='ok'?'lo':type==='err'?'le':type==='warn'?'lw':'li';
  area.innerHTML += '<div class="ll '+cls+'">['+ts+'] '+msg+'</div>';
  area.scrollTop = area.scrollHeight;
}

// ─── 禁用/启用三按钮 ───
function setCoreBtns(disabled) {
  document.getElementById('btnRead').disabled = disabled;
  document.getElementById('btnDisconnect').disabled = disabled;
  document.getElementById('btnConnect').disabled = disabled;
}

// ─── PAT ───
function savePAT() {
  const pat = document.getElementById('patInput').value.trim();
  if (!pat) { log('PAT不能为空','err'); return; }
  vscode.postMessage({command:'savePAT',pat:pat});
  log('PAT已保存','ok');
}
function toggleVis() {
  const inp = document.getElementById('patInput');
  inp.type = inp.type==='password'?'text':'password';
}

// ─── 登录 ───
function doLogin() {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value.trim();
  if (!email||!password) { log('请输入邮箱和密码','err'); return; }
  document.getElementById('btnLogin').disabled = true;
  document.getElementById('btnLogin').innerHTML = '<span class="spin"></span> 认证中...';
  log('认证: '+email,'info');
  vscode.postMessage({command:'login',email:email,password:password});
}
function clearInputs() {
  document.getElementById('emailInput').value = '';
  document.getElementById('passwordInput').value = '';
}

// ─── 核心1: 读取状态 ───
function readStatus() {
  if (!cur) { log('请先登录账号','err'); return; }
  setCoreBtns(true);
  document.getElementById('btnRead').innerHTML = '<span class="spin"></span> 读取中';
  log('读取当前账号状态...','info');
  vscode.postMessage({command:'readStatus',email:cur.email});
}

// ─── 核心2: 断开Git ───
function disconnectGit() {
  if (!cur) { log('请先登录账号','err'); return; }
  setCoreBtns(true);
  document.getElementById('btnDisconnect').innerHTML = '<span class="spin"></span> 断开中';
  log('断开当前Git连接...','warn');
  vscode.postMessage({command:'disconnectGit',email:cur.email});
}

// ─── 核心3: 连接Git ───
function connectGit() {
  if (!cur) { log('请先登录账号','err'); return; }
  const pat = document.getElementById('patInput').value.trim();
  if (!pat) { log('请先填写PAT','err'); setCoreBtns(false); return; }
  setCoreBtns(true);
  document.getElementById('btnConnect').innerHTML = '<span class="spin"></span> 连接中';
  log('用当前PAT连接GitHub...','info');
  vscode.postMessage({command:'connectGit',email:cur.email,pat:pat});
}

// ─── 选中账号 ───
function selectAcct(email) {
  log('选中: '+email,'info');
  vscode.postMessage({command:'selectAccount',email:email});
}

// ─── 移除账号 ───
function removeAcct(email) {
  log('移除: '+email,'warn');
  vscode.postMessage({command:'removeAccount',email:email});
}

// ─── 渲染 ───
function render() {
  renderStatus();
  renderList();
}

function renderStatus() {
  const sec = document.getElementById('statusSection');
  const info = document.getElementById('accountInfo');
  const gs = document.getElementById('gitStatus');

  if (!cur) {
    info.innerHTML = '<div style="color:var(--tx2);font-size:11px">请先登录账号</div>';
    gs.innerHTML = '';
    setCoreBtns(true);
    return;
  }
  setCoreBtns(false);

  // 账号信息
  let h = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
  h += '<span style="font-weight:600;font-size:12px">' + esc(cur.email) + '</span>';
  if (cur.orgName) h += '<span class="badge b-idle">' + esc(cur.orgName) + '</span>';
  if (cur.orgId) h += '<span class="badge b-idle" style="font-size:9px">' + esc(cur.orgId.slice(0,12)) + '...</span>';
  h += '</div>';
  info.innerHTML = h;

  // Git状态 — 用grid清晰展示
  h = '';
  if (!cur.gitChecked) {
    h += '<div style="color:var(--tx2);font-size:11px">点击「读取状态」查看详情</div>';
  } else {
    h += '<div class="status-grid">';
    // Git连接
    h += '<span class="sk">Git连接:</span>';
    if (cur.git && cur.gitCount > 0) {
      h += '<span class="sv" style="color:var(--gn)">已连接 (' + cur.gitCount + '个)</span>';
    } else {
      h += '<span class="sv" style="color:var(--yl)">未连接</span>';
    }
    // 连接详情
    if (cur.gitDetails && cur.gitDetails.length > 0) {
      cur.gitDetails.forEach(function(c, i) {
        var t = c.type || '';
        var label = t==='github_app'?'App(组织级)':t==='github_individual_token'?'PAT(个人)':'OAuth';
        h += '<span class="sk">连接['+i+"]:</span>";
        h += '<span class="sv">' + esc(label) + ' — ' + esc(c.name||c.installation_name||'-') + (c.github_username ? ' @'+esc(c.github_username) : '') + '</span>';
      });
    }
    // PAT叠加
    if (cur.hasPAT !== undefined) {
      h += '<span class="sk">PAT叠加:</span>';
      h += '<span class="sv">' + (cur.hasPAT ? '<span style="color:var(--gn)">✓ 有</span>' : '<span style="color:var(--tx2)">✗ 无</span>') + '</span>';
    }
    // 个人PAT
    if (cur.isIndividualPAT !== undefined) {
      h += '<span class="sk">个人PAT:</span>';
      h += '<span class="sv">' + (cur.isIndividualPAT ? '<span style="color:var(--gn)">✓</span>' : '<span style="color:var(--tx2)">✗</span>') + '</span>';
    }
    // App安装
    if (cur.appInstallationId) {
      h += '<span class="sk">App安装:</span>';
      h += '<span class="sv" style="color:var(--yl)">#' + esc(String(cur.appInstallationId)) + ' (组织级共享)</span>';
    }
    // OAuth
    if (cur.isOAuthConnected !== undefined) {
      h += '<span class="sk">OAuth:</span>';
      h += '<span class="sv">' + (cur.isOAuthConnected ? '<span style="color:var(--gn)">已连接</span>' : '<span style="color:var(--tx2)">未连接</span>') + '</span>';
    }
    // GitHub用户
    if (cur.githubUsername) {
      h += '<span class="sk">GitHub:</span>';
      h += '<span class="sv">' + esc(cur.githubUsername) + '</span>';
    }
    // 提交邮箱
    if (cur.commitEmail) {
      h += '<span class="sk">提交邮箱:</span>';
      h += '<span class="sv">' + esc(cur.commitEmail) + '</span>';
    }
    // Secret
    h += '<span class="sk">Secret:</span>';
    h += '<span class="sv">' + (cur.secret ? '<span style="color:var(--gn)">✓ GITHUB_PAT</span>' : '<span style="color:var(--tx2)">✗ 无</span>') + '</span>';
    h += '</div>';
  }
  gs.innerHTML = h;
}

function renderList() {
  const list = document.getElementById('accountList');
  const emails = Object.keys(saved);
  if (emails.length === 0) {
    list.innerHTML = '<div style="color:var(--tx2);font-size:11px">暂无账号</div>';
    return;
  }
  let h = '';
  emails.forEach(function(email) {
    const a = saved[email];
    const isActive = cur && cur.email === email;
    h += '<div class="ai'+(isActive?' active':'')+'" data-email="'+escA(email)+'">';
    h += '<div class="ae">'+esc(email)+'</div>';
    h += '<div class="as">';
    if (a.git) h += '<span class="badge b-ok">Git</span>';
    else h += '<span class="badge b-warn">无Git</span>';
    if (a.secret) h += '<span class="badge b-ok">Sec</span>';
    h += '<button class="bd" style="padding:1px 5px;font-size:9px" data-remove-email="'+escA(email)+'">x</button>';
    h += '</div></div>';
  });
  list.innerHTML = h;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escA(s) { return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── 恢复三按钮文字 ───
function resetCoreBtns() {
  setCoreBtns(false);
  document.getElementById('btnRead').innerHTML = '读取状态';
  document.getElementById('btnDisconnect').innerHTML = '断开Git';
  document.getElementById('btnConnect').innerHTML = '连接Git';
}

// ─── 消息处理 ───
window.addEventListener('message', function(event) {
  const msg = event.data;
  switch (msg.command) {

    case 'loginResult':
      document.getElementById('btnLogin').disabled = false;
      document.getElementById('btnLogin').innerHTML = '登录认证';
      if (msg.ok) {
        cur = msg.account;
        log('认证成功: '+msg.account.email,'ok');
        saved[msg.account.email] = {
          email: msg.account.email, orgId: msg.account.orgId, orgName: msg.account.orgName,
          git: msg.account.git||false, gitType: msg.account.gitType||null, gitName: msg.account.gitName||null,
          gitOwner: msg.account.gitOwner||null, secret: msg.account.secret||false,
          gitCount: msg.account.gitCount||0,
          lastCheck: new Date().toISOString(),
        };
        render();
      } else {
        log('认证失败: '+msg.error,'err');
      }
      break;

    case 'error':
      log('内部错误: '+msg.error,'err');
      resetCoreBtns();
      var loginBtn = document.getElementById('btnLogin');
      if (loginBtn) { loginBtn.disabled = false; loginBtn.innerHTML = '登录认证'; }
      break;

    case 'statusResult':
      if (cur && msg.email === cur.email) {
        Object.assign(cur, msg.status);
        if (saved[msg.email]) {
          Object.assign(saved[msg.email], {
            git: cur.git, gitType: cur.gitType, gitName: cur.gitName,
            gitOwner: cur.gitOwner, secret: cur.secret,
            gitCount: cur.gitCount||0,
            isOAuthConnected: cur.isOAuthConnected,
            lastCheck: new Date().toISOString(),
          });
        }
        render();
        log('状态已刷新','ok');
      }
      resetCoreBtns();
      break;

    case 'disconnectResult':
      resetCoreBtns();
      if (msg.ok) {
        log('Git已断开!','ok');
        if (cur) { cur.git = false; cur.gitCount = 0; cur.gitDetails = []; cur.gitType = null; cur.gitName = null; cur.secret = false; }
        // 自动刷新确认
        setTimeout(function(){ readStatus(); }, 2000);
      } else {
        log('断开失败: '+msg.error,'err');
      }
      break;

    case 'connectResult':
      resetCoreBtns();
      if (msg.ok) {
        log('Git连接成功!','ok');
        if (cur) { cur.git = true; cur.gitType = 'github_app'; cur.secret = true; }
        setTimeout(function(){ readStatus(); }, 2000);
      } else {
        // 设备码等待 — 显示为醒目提示而非错误
        if (msg.error && msg.error.indexOf('设备码') >= 0) {
          log(msg.error, 'warn');
        } else {
          log('连接失败: '+msg.error,'err');
        }
      }
      break;

    case 'selectAccountResult':
      if (msg.ok) {
        cur = msg.account;
        log('已选中: '+msg.account.email,'info');
        render();
      } else {
        log('选中失败: '+msg.error,'err');
      }
      break;

    case 'removeAccountResult':
      if (msg.ok) {
        delete saved[msg.email];
        if (cur && cur.email === msg.email) cur = null;
        log('已移除: '+msg.email,'info');
        render();
      }
      break;

    case 'proxyStatus':
      document.getElementById('proxyStatus').textContent = '代理: '+msg.text;
      break;

    case 'initState':
      saved = msg.accounts || {};
      if (msg.pat) document.getElementById('patInput').value = msg.pat;
      renderList();
      break;

    case 'batchProgress':
      document.getElementById('batchStatus').textContent = '['+msg.index+'/'+msg.total+'] '+msg.email+' '+msg.status;
      log('批量['+msg.index+'/'+msg.total+'] '+msg.email+' → '+msg.status,'info');
      break;

    case 'batchResult':
      document.getElementById('btnBatchConnect').disabled = false;
      if (msg.ok && msg.results) {
        var okCount = msg.results.filter(function(r){return r.ok;}).length;
        var stuckCount = msg.results.filter(function(r){return r.stuck;}).length;
        var failCount = msg.results.length - okCount;
        document.getElementById('batchStatus').textContent = '完成: '+okCount+'连通 / '+failCount+'失败'+(stuckCount?(' (其中'+stuckCount+'幽灵态)'):'');
        msg.results.forEach(function(r) {
          if (r.ok) { log('批量 '+r.email+': 连通 ['+(r.method||'already')+']'+(r.repoCount!==undefined?(' 可达仓库 '+r.repoCount):''),'ok'); }
          else if (r.stuck) { log('批量 '+r.email+': 幽灵态 — '+(r.error||''),'warn'); }
          else { log('批量 '+r.email+': 失败 — '+(r.error||''),'err'); }
        });
        // 刷新列表
        Object.keys(saved).forEach(function(em) {
          var match = msg.results.find(function(r){return r.email===em;});
          if (match && match.ok) saved[em].git = true;
        });
        renderList();
      } else {
        document.getElementById('batchStatus').textContent = '批量失败: '+(msg.error||'');
        log('批量连接失败: '+(msg.error||''),'err');
      }
      break;

    case 'batchLoginResult':
      document.getElementById('btnBatchLogin').disabled = false;
      if (msg.ok && msg.results) {
        var okCount2 = msg.results.filter(function(r){return r.ok;}).length;
        document.getElementById('batchStatus').textContent = '批量登录: '+okCount2+'/'+msg.results.length+'成功';
        msg.results.forEach(function(r) {
          if (r.ok) {
            log('登录 '+r.email+': 成功 [orgId='+r.orgId+' git='+r.git+']','ok');
            saved[r.email] = { email:r.email, orgId:r.orgId, git:r.git };
          } else {
            log('登录 '+r.email+': 失败 — '+r.error,'err');
          }
        });
        renderList();
      } else {
        document.getElementById('batchStatus').textContent = '批量登录失败: '+(msg.error||'');
        log('批量登录失败: '+(msg.error||''),'err');
      }
      break;
  }
});

// ─── 事件绑定 · CSP合规 · 不用onclick ───
document.getElementById('btnSavePAT').addEventListener('click', savePAT);
document.getElementById('btnToggleVis').addEventListener('click', toggleVis);
document.getElementById('btnLogin').addEventListener('click', doLogin);
document.getElementById('btnClear').addEventListener('click', clearInputs);
document.getElementById('btnRead').addEventListener('click', readStatus);
document.getElementById('btnDisconnect').addEventListener('click', disconnectGit);
document.getElementById('btnConnect').addEventListener('click', connectGit);
document.getElementById('btnClearLog').addEventListener('click', function() {
  document.getElementById('logArea').innerHTML = '';
});
// 批量操作
document.getElementById('btnBatchConnect').addEventListener('click', function() {
  const pat = document.getElementById('patInput').value.trim();
  if (!pat) { log('请先填写 PAT','err'); return; }
  log('批量连接: 将所有已登录账号连接到GitHub...','info');
  document.getElementById('batchStatus').textContent = '批量连接中...';
  document.getElementById('btnBatchConnect').disabled = true;
  vscode.postMessage({command:'batchConnect',pat:pat});
});
document.getElementById('btnBatchLogin').addEventListener('click', function() {
  // 弹出输入框让用户粘贴批量账号
  var inputStr = prompt('请粘贴账号列表(格式: email:password 每行一个)');
  if (!inputStr) return;
  var lines = inputStr.split('\\n').filter(function(l){return l.trim();});
  var accounts = [];
  lines.forEach(function(l) {
    var parts = l.trim().split(':');
    if (parts.length >= 2) {
      accounts.push({ email: parts[0].trim(), password: parts.slice(1).join(':').trim() });
    }
  });
  if (accounts.length === 0) { log('无有效账号','err'); return; }
  log('批量登录: '+accounts.length+' 个账号','info');
  document.getElementById('batchStatus').textContent = '批量登录 '+accounts.length+' 个账号...';
  document.getElementById('btnBatchLogin').disabled = true;
  vscode.postMessage({command:'batchLogin',accounts:accounts});
});

// 账号列表事件委托
document.getElementById('accountList').addEventListener('click', function(e) {
  var removeBtn = e.target.closest('[data-remove-email]');
  if (removeBtn) {
    e.stopPropagation();
    removeAcct(removeBtn.dataset.removeEmail);
    return;
  }
  var item = e.target.closest('.ai');
  if (item && item.dataset.email) {
    selectAcct(item.dataset.email);
  }
});

vscode.postMessage({command:'init'});
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// 后端消息处理 · 言有君 · 事有宗
// ═══════════════════════════════════════════════════════════════

var _state = loadState();
var _authCache = {};  // email -> auth1 (内存)
var _webview = null;
var _outputChannel = null;

function _log(msg) {
  var ts = new Date().toLocaleTimeString('zh-CN', {hour12: false});
  var line = '[' + ts + '] ' + msg;
  if (_outputChannel) _outputChannel.appendLine(line);
  console.error('[devin-git-auth] ' + line);
}

function postMsg(msg) {
  _log('postMsg -> ' + msg.command + (msg.ok !== undefined ? ' ok=' + msg.ok : '') + (msg.error ? ' err=' + msg.error.slice(0, 80) : ''));
  if (_webview) { try { _webview.postMessage(msg); } catch (e) { _log('postMsg FAIL: ' + e.message); } }
}

// 完整查状态
async function fetchFullStatus(email, auth1, orgId) {
  var result = {
    email: email, orgId: orgId, gitChecked: true,
    git: false, gitCount: 0, gitDetails: [],
    gitType: null, gitName: null, gitOwner: null,
    hasPAT: false, isIndividualPAT: false, appInstallationId: null,
    githubUsername: null, commitEmail: null, isOAuthConnected: false, secret: false,
  };

  try {
    var gc = await checkGitConnections(orgId, auth1);
    if (gc.ok) {
      result.gitCount = gc.count;
      result.gitDetails = gc.connections;
      if (gc.count > 0) {
        result.git = true;
        var c = gc.connections[0];
        result.gitType = c.type || c.connection_type || null;
        result.gitName = c.name || c.installation_name || null;
        result.gitOwner = c.github_username || c.login || null;
      }
    }
  } catch (e) {}

  try {
    var ghInt = await getGitHubIntegration(orgId, auth1);
    if (ghInt.ok && ghInt.data) {
      var ghArr = Array.isArray(ghInt.data) ? ghInt.data : [ghInt.data];
      if (ghArr.length > 0 && ghArr[0]) {
        result.hasPAT = ghArr[0].has_pat || false;
        result.isIndividualPAT = ghArr[0].is_individual_pat || false;
        result.appInstallationId = ghArr[0].app_installation_id || null;
      }
    }
  } catch (e) {}

  try {
    var ghUser = await getGitHubUser(auth1, orgId);
    if (ghUser.ok && ghUser.data) {
      result.githubUsername = ghUser.data.github_username || null;
      result.commitEmail = ghUser.data.commit_email || null;
      result.isOAuthConnected = ghUser.data.is_github_oauth_connected || false;
    }
  } catch (e) {}

  try {
    var bareOrgId2 = orgId.replace(/^org-/, "");
    var secR = await jsonGet(DEVIN + "/api/org-" + bareOrgId2 + "/secrets",
      { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId });
    if (secR.status === 200 && secR.json) {
      var secrets = Array.isArray(secR.json) ? secR.json : (secR.json.secrets || []);
      if (secrets.find(function (s) { return s.key === "GITHUB_PAT" || s.name === "GITHUB_PAT"; })) {
        result.secret = true;
      }
    }
  } catch (e) {}

  return result;
}

async function handleMessage(msg) {
  try {
  _log('handleMessage <- ' + msg.command + (msg.email ? ' email=' + msg.email : ''));
  switch (msg.command) {

    case "init":
      postMsg({ command: "initState", accounts: _state.accounts || {}, pat: _state.pat || null });
      autoDetectProxy().then(function () {
        var p = currentProxy();
        postMsg({ command: "proxyStatus", text: p ? p.host + ":" + p.port : "直连" });
      });
      break;

    case "savePAT":
      _state.pat = msg.pat;
      saveState(_state);
      break;

    case "login":
      try {
        await autoDetectProxy();
        var s1 = await devinLogin(msg.email, msg.password);
        var s3 = await devinPostAuth(s1.auth1);
        _authCache[msg.email] = s1.auth1;

        var status = await fetchFullStatus(msg.email, s1.auth1, s3.orgId);
        status.orgName = s3.orgName;
        status.auth1 = s1.auth1;

        if (!_state.accounts) _state.accounts = {};
        _state.accounts[msg.email] = {
          email: msg.email, orgId: s3.orgId, orgName: s3.orgName,
          password: msg.password,
          git: status.git, gitType: status.gitType, gitName: status.gitName,
          gitOwner: status.gitOwner, secret: status.secret,
          gitCount: status.gitCount || 0,
          lastCheck: new Date().toISOString(),
        };
        saveState(_state);
        postMsg({ command: "loginResult", ok: true, account: status });
      } catch (e) {
        _log('login FAILED: ' + e.message);
        postMsg({ command: "loginResult", ok: false, error: e.message });
      }
      break;

    case "readStatus":
      // 读取状态 — 独立操作，不依赖缓存
      try {
        var auth1 = _authCache[msg.email];
        var acct = _state.accounts[msg.email];
        if (!auth1 || !acct || !acct.orgId) {
          postMsg({ command: "statusResult", email: msg.email, status: { gitChecked: true, git: false, error: "需要重新登录" } });
          break;
        }
        var status = await fetchFullStatus(msg.email, auth1, acct.orgId);
        status.orgName = acct.orgName;
        status.auth1 = auth1;

        // 更新state
        Object.assign(_state.accounts[msg.email], {
          git: status.git, gitType: status.gitType, gitName: status.gitName,
          gitOwner: status.gitOwner, secret: status.secret,
          gitCount: status.gitCount || 0,
          lastCheck: new Date().toISOString(),
        });
        if (status.gitDetails && status.gitDetails.length > 0) {
          _state.accounts[msg.email]._connectionId = status.gitDetails[0].id || status.gitDetails[0].git_connection_id || null;
        }
        saveState(_state);
        postMsg({ command: "statusResult", email: msg.email, status: status });
      } catch (e) {
        postMsg({ command: "statusResult", email: msg.email, status: { gitChecked: true, git: false, error: e.message } });
      }
      break;

    case "disconnectGit":
      // 断开Git — 健壮断开，先实时查状态再断，不依赖缓存
      try {
        var auth1 = _authCache[msg.email];
        var acct = _state.accounts[msg.email];
        if (!auth1 || !acct || !acct.orgId) {
          postMsg({ command: "disconnectResult", ok: false, error: "需要重新登录" });
          break;
        }
        var logs = await robustDisconnectGit(msg.email, auth1, acct.orgId);
        logs.forEach(function(l) { _log('disconnect: ' + l); });

        // 等待1秒让服务端生效
        await sleep(1000);

        // 更新本地状态
        _state.accounts[msg.email].git = false;
        _state.accounts[msg.email].gitType = null;
        _state.accounts[msg.email].gitName = null;
        _state.accounts[msg.email].gitCount = 0;
        _state.accounts[msg.email]._connectionId = null;
        _state.accounts[msg.email].secret = false;
        saveState(_state);

        postMsg({ command: "disconnectResult", ok: true });
      } catch (e) {
        _log('disconnectGit FAILED: ' + e.message);
        postMsg({ command: "disconnectResult", ok: false, error: e.message });
      }
      break;

    case "connectGit":
      // ═══ 连接Git · 弱者道之用 · 道法自然 ═══
      // gh_cli设备码认证 — Devin官方前端方式, 对所有账号有效
      try {
        var pat = msg.pat || patFor(msg.email);
        var acct = _state.accounts[msg.email];
        // auth1过期时自动重新登录
        var auth1 = _authCache[msg.email];
        if (!auth1 && passwordFor(msg.email, acct)) {
          _log('connectGit: auth1过期, 自动重新登录...');
          try {
            var lr = await devinLogin(msg.email, passwordFor(msg.email, acct));
            auth1 = lr.auth1;
            _authCache[msg.email] = auth1;
            var pr = await devinPostAuth(auth1);
            acct.orgId = pr.orgId;
            acct.orgName = pr.orgName;
            _log('connectGit: 重新登录成功');
          } catch (e) {
            postMsg({ command: "connectResult", ok: false, error: "登录失败: " + e.message });
            break;
          }
        }
        if (!acct || !acct.orgId) {
          postMsg({ command: "connectResult", ok: false, error: "账号数据缺失, 请重新登录" });
          break;
        }

        // ═══ Step1: PAT注入 (快速尝试, 仅全新组织有效) ═══
        if (pat) {
          _log('connectGit: Step1 PAT注入(快速尝试)...');
          var patR = await injectGitHubPAT(acct.orgId, pat, auth1);
          if (patR.ok) {
            try { await injectSecret(acct.orgId, "GITHUB_PAT", pat, auth1); } catch (e) {}
            _state.accounts[msg.email].git = true;
            _state.accounts[msg.email].gitType = "github_individual_token";
            _state.accounts[msg.email].secret = true;
            _state.accounts[msg.email].gitCount = (_state.accounts[msg.email].gitCount || 0) + 1;
            saveState(_state);
            var repoR0 = await getAccessibleRepos(acct.orgId, auth1);
            postMsg({ command: "connectResult", ok: true, repoCount: repoR0.ok ? repoR0.repos.length : undefined });
            break;
          }
          if (patR.invalidPat) {
            postMsg({ command: "connectResult", ok: false, error: "PAT 无效或已过期, 请更新 ~/.dao/git-pats.json" });
            break;
          }
          // "已注册" — 多半是该 org 已绑定同一 GitHub 账号。先核实现有连接, 若已连通即成功。
          if (patR.alreadyRegistered) {
            var gcChk = await checkGitConnections(acct.orgId, auth1);
            if (gcChk.ok && gcChk.count > 0) {
              var repoR1 = await getAccessibleRepos(acct.orgId, auth1);
              _state.accounts[msg.email].git = true;
              _state.accounts[msg.email].gitType = (gcChk.connections[0] || {}).type || "github_individual_token";
              _state.accounts[msg.email].gitCount = gcChk.count;
              saveState(_state);
              postMsg({ command: "connectResult", ok: true, already: true, repoCount: repoR1.ok ? repoR1.repos.length : undefined });
              break;
            }
            // 注册标记存在但无任何连接 = 后端幽灵态, PAT 通道无法清除 → 转 gh_cli 设备码兜底。
            _log('connectGit: 已注册但0连接(幽灵态), 转 gh_cli 设备码');
          }
          _log('connectGit: PAT注入失败, 切换gh_cli设备码认证');
        }

        // ═══ Step2: gh_cli设备码认证 (对所有账号有效 · Devin官方方式) ═══
        // POST /api/integrations/gh_cli/code → 获取设备码
        // 用户在 https://github.com/login/device 输入设备码
        // GET /api/integrations/gh_cli/state → 轮询等待验证完成
        _log('connectGit: Step2 gh_cli设备码认证...');
        var codeR = await ghCliRequestCode(acct.orgId, auth1);
        if (codeR.ok) {
          _log('connectGit: 设备码=' + codeR.userCode + ' 验证URL=' + codeR.verificationUri);
          // 打开GitHub设备验证页面
          vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(codeR.verificationUri));
          // 通知用户输入设备码
          postMsg({ command: "connectResult", ok: false, error: "设备码: " + codeR.userCode + " — 请在浏览器中输入此代码, 完成后自动连接" });

          // 后台轮询: 每5秒检查gh_cli/state, 最多3分钟
          _log('connectGit: 开始轮询gh_cli/state...');
          var pollInterval = (codeR.interval || 5) * 1000;
          var maxPolls = Math.floor(180000 / pollInterval);
          for (var pi = 0; pi < maxPolls; pi++) {
            await sleep(pollInterval);
            try {
              var stR = await ghCliPollState(acct.orgId, auth1);
              if (stR.ok) {
                // 检查oauth是否完成
                if (stR.oauth && stR.oauth !== null && stR.oauth !== "null") {
                  _log('connectGit: gh_cli验证成功! oauth=' + JSON.stringify(stR.oauth).slice(0,80));
                  // 注入Secret
                  if (pat) { try { await injectSecret(acct.orgId, "GITHUB_PAT", pat, auth1); } catch (e) {} }
                  // 更新状态
                  _state.accounts[msg.email].git = true;
                  _state.accounts[msg.email].gitType = "github_app";
                  _state.accounts[msg.email].secret = !!pat;
                  _state.accounts[msg.email].gitCount = (_state.accounts[msg.email].gitCount || 0) + 1;
                  saveState(_state);
                  postMsg({ command: "connectResult", ok: true });
                  break;
                }
                // 检查错误
                if (stR.error && stR.error !== null && stR.error !== "null") {
                  _log('connectGit: gh_cli错误: ' + stR.error);
                  // 设备码过期 → 重新获取
                  if (String(stR.error).indexOf("expired") >= 0) {
                    _log('connectGit: 设备码过期, 重新获取...');
                    var codeR2 = await ghCliRequestCode(acct.orgId, auth1);
                    if (codeR2.ok) {
                      vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(codeR2.verificationUri));
                      postMsg({ command: "connectResult", ok: false, error: "设备码已更新: " + codeR2.userCode + " — 请在浏览器中输入新代码" });
                    }
                  }
                }
              }
              // 也检查Git连接(双保险)
              if (pi > 0 && pi % 6 === 0) {
                var pollGc = await checkGitConnections(acct.orgId, auth1);
                if (pollGc.ok && pollGc.count > 0) {
                  _log('connectGit: 检测到Git连接! connections=' + pollGc.count);
                  if (pat) { try { await injectSecret(acct.orgId, "GITHUB_PAT", pat, auth1); } catch (e) {} }
                  _state.accounts[msg.email].git = true;
                  _state.accounts[msg.email].gitType = pollGc.connections[0].type || "github_app";
                  _state.accounts[msg.email].secret = !!pat;
                  _state.accounts[msg.email].gitCount = (_state.accounts[msg.email].gitCount || 0) + 1;
                  saveState(_state);
                  postMsg({ command: "connectResult", ok: true });
                  break;
                }
              }
              _log('connectGit: 轮询[' + (pi+1) + '/' + maxPolls + '] 等待设备验证...');
            } catch (e) { _log('connectGit: 轮询错误: ' + e.message); }
          }
        } else {
          // gh_cli失败 → 回退到OAuth
          _log('connectGit: gh_cli失败, 回退OAuth: ' + (codeR.error||"").slice(0,80));
          var oauthUrl = null;
          try {
            var oauthR = await jsonGet(DEVIN + "/api/integrations/github/start-user-oauth?return_to=" + encodeURIComponent("/org/_/settings/integrations"),
              { Authorization: "Bearer " + auth1, "x-cog-org-id": acct.orgId });
            if (oauthR.status === 200 && oauthR.json) { oauthUrl = oauthR.json.url || null; }
          } catch (e) {}
          if (oauthUrl) {
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(oauthUrl));
          } else {
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse("https://github.com/apps/devin-ai-integration/installations/new"));
          }
          postMsg({ command: "connectResult", ok: false, error: "已打开GitHub授权页面 — 请在浏览器中完成授权" });
          // 轮询等待连接
          for (var pi2 = 0; pi2 < 36; pi2++) {
            await sleep(5000);
            try {
              var pollGc2 = await checkGitConnections(acct.orgId, auth1);
              if (pollGc2.ok && pollGc2.count > 0) {
                if (pat) { try { await injectSecret(acct.orgId, "GITHUB_PAT", pat, auth1); } catch (e) {} }
                _state.accounts[msg.email].git = true;
                _state.accounts[msg.email].gitType = pollGc2.connections[0].type || "github_app";
                _state.accounts[msg.email].secret = !!pat;
                _state.accounts[msg.email].gitCount = (_state.accounts[msg.email].gitCount || 0) + 1;
                saveState(_state);
                postMsg({ command: "connectResult", ok: true });
                break;
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        _log('connectGit FAILED: ' + e.message);
        postMsg({ command: "connectResult", ok: false, error: e.message });
      }
      break;

    case "selectAccount":
      try {
        var acct = _state.accounts[msg.email];
        if (!acct) {
          postMsg({ command: "selectAccountResult", ok: false, error: "账号不存在" });
          break;
        }
        var auth1 = _authCache[msg.email];
        var account = {
          email: acct.email, auth1: auth1 || null, orgId: acct.orgId, orgName: acct.orgName,
          git: acct.git, gitType: acct.gitType, gitName: acct.gitName, gitOwner: acct.gitOwner,
          secret: acct.secret, gitChecked: false, gitCount: acct.gitCount || 0,
        };
        // 如果有auth1, 自动读取最新状态
        if (auth1 && acct.orgId) {
          var status = await fetchFullStatus(msg.email, auth1, acct.orgId);
          Object.assign(account, status);
          account.orgName = acct.orgName;
        }
        postMsg({ command: "selectAccountResult", ok: true, account: account });
      } catch (e) {
        postMsg({ command: "selectAccountResult", ok: false, error: e.message });
      }
      break;

    case "removeAccount":
      delete _state.accounts[msg.email];
      delete _authCache[msg.email];
      saveState(_state);
      postMsg({ command: "removeAccountResult", ok: true, email: msg.email });
      break;

    // ═══ 批量连接 · 突破一切阻碍 · 帛书·「取之尽锱铢·用之如泥沙」═══
    // 多个Devin AI账号 → 一个GitHub仓库: PAT注入 + 断开重连 + 强制覆盖
    case "batchConnect":
      try {
        var pat = msg.pat || _state.pat || _daoDefaultPat;
        if (!pat) {
          postMsg({ command: "batchResult", ok: false, error: "需要 GitHub PAT (ghp_...)" });
          break;
        }
        var accounts = _state.accounts || {};
        var emails = Object.keys(accounts);
        if (emails.length === 0) {
          postMsg({ command: "batchResult", ok: false, error: "无已登录账号" });
          break;
        }
        var results = [];
        for (var bi = 0; bi < emails.length; bi++) {
          var bEmail = emails[bi];
          var bAcct = accounts[bEmail];
          _log('batchConnect [' + (bi+1) + '/' + emails.length + '] ' + bEmail);
          postMsg({ command: "batchProgress", index: bi, total: emails.length, email: bEmail, status: "processing" });

          try {
            // 确保有auth1
            var bAuth1 = _authCache[bEmail];
            if (!bAuth1 && passwordFor(bEmail, bAcct)) {
              var bLr = await devinLogin(bEmail, passwordFor(bEmail, bAcct));
              bAuth1 = bLr.auth1;
              _authCache[bEmail] = bAuth1;
              var bPr = await devinPostAuth(bAuth1);
              bAcct.orgId = bPr.orgId;
              bAcct.orgName = bPr.orgName;
            }
            if (!bAuth1 || !bAcct.orgId) {
              results.push({ email: bEmail, ok: false, error: "无法登录" });
              continue;
            }

            // 检查当前状态 — 已连接则核验仓库可达性后直接记成功
            var bGc = await checkGitConnections(bAcct.orgId, bAuth1);
            if (bGc.ok && bGc.count > 0) {
              var bRepo0 = await getAccessibleRepos(bAcct.orgId, bAuth1);
              results.push({ email: bEmail, ok: true, already: true, connections: bGc.count, repoCount: bRepo0.ok ? bRepo0.repos.length : undefined });
              bAcct.git = true;
              bAcct.gitCount = bGc.count;
              bAcct.gitType = (bGc.connections[0] || {}).type || bAcct.gitType;
              saveState(_state);
              continue;
            }

            // 未连接 — 尝试PAT注入(个人令牌通道, 对全新 org 即时生效)
            _log('batchConnect: PAT注入 ' + bEmail);
            var bPatR = await injectGitHubPAT(bAcct.orgId, pat, bAuth1);
            if (bPatR.ok) {
              try { await injectSecret(bAcct.orgId, "GITHUB_PAT", pat, bAuth1); } catch (e) {}
              var bRepo1 = await getAccessibleRepos(bAcct.orgId, bAuth1);
              bAcct.git = true;
              bAcct.gitType = "github_individual_token";
              bAcct.secret = true;
              bAcct.gitCount = (bAcct.gitCount || 0) + 1;
              saveState(_state);
              results.push({ email: bEmail, ok: true, method: "pat", repoCount: bRepo1.ok ? bRepo1.repos.length : undefined });
              continue;
            }

            if (bPatR.invalidPat) {
              results.push({ email: bEmail, ok: false, error: "PAT 无效或已过期" });
              continue;
            }

            // PAT注入返回"已注册" — 先断开残留连接再重注入一次
            if (bPatR.alreadyRegistered) {
              _log('batchConnect: 已注册, 断开后重注入 ' + bEmail);
              await robustDisconnectGit(bEmail, bAuth1, bAcct.orgId);
              await sleep(2000);
              var bPatR2 = await injectGitHubPAT(bAcct.orgId, pat, bAuth1);
              if (bPatR2.ok) {
                try { await injectSecret(bAcct.orgId, "GITHUB_PAT", pat, bAuth1); } catch (e) {}
                var bRepo2 = await getAccessibleRepos(bAcct.orgId, bAuth1);
                bAcct.git = true;
                bAcct.gitType = "github_individual_token";
                bAcct.secret = true;
                bAcct.gitCount = (bAcct.gitCount || 0) + 1;
                saveState(_state);
                results.push({ email: bEmail, ok: true, method: "disconnect+pat", repoCount: bRepo2.ok ? bRepo2.repos.length : undefined });
                continue;
              }
              // 断开后仍"已注册" — 再核验是否其实已有连接(最终一致性延迟)
              var bGc2 = await checkGitConnections(bAcct.orgId, bAuth1);
              if (bGc2.ok && bGc2.count > 0) {
                var bRepo3 = await getAccessibleRepos(bAcct.orgId, bAuth1);
                bAcct.git = true; bAcct.gitCount = bGc2.count; saveState(_state);
                results.push({ email: bEmail, ok: true, already: true, connections: bGc2.count, repoCount: bRepo3.ok ? bRepo3.repos.length : undefined });
                continue;
              }
              // 注册标记存在 + 0连接 + 断开无效 = 后端幽灵态, 任何 API 通道均无法清除。
              // 如实上报, 不以设备码 GUI 兜底(用户要求零 GUI, 且无法自动完成)。
              results.push({ email: bEmail, ok: false, stuck: true, error: "后端幽灵态(已注册但0连接, API不可清除)" });
            } else {
              results.push({ email: bEmail, ok: false, error: "PAT注入失败: " + (bPatR.error || "").slice(0, 60) });
            }
          } catch (e) {
            results.push({ email: bEmail, ok: false, error: e.message });
          }
        }
        postMsg({ command: "batchResult", ok: true, results: results });
        _log('batchConnect 完成: ' + JSON.stringify(results.map(function(r) { return r.email + ':' + (r.ok ? 'OK' : 'FAIL'); })));
      } catch (e) {
        _log('batchConnect FAILED: ' + e.message);
        postMsg({ command: "batchResult", ok: false, error: e.message });
      }
      break;

    // ═══ 批量登录 · 帛书·「道生一·一生二·二生三·三生万物」═══
    case "batchLogin":
      try {
        var loginList = msg.accounts || [];
        var loginResults = [];
        for (var li = 0; li < loginList.length; li++) {
          var la = loginList[li];
          postMsg({ command: "batchProgress", index: li, total: loginList.length, email: la.email, status: "logging_in" });
          try {
            await autoDetectProxy();
            var lrs = await devinLogin(la.email, la.password);
            var lps = await devinPostAuth(lrs.auth1);
            _authCache[la.email] = lrs.auth1;
            var lstatus = await fetchFullStatus(la.email, lrs.auth1, lps.orgId);
            if (!_state.accounts) _state.accounts = {};
            _state.accounts[la.email] = {
              email: la.email, orgId: lps.orgId, orgName: lps.orgName,
              password: la.password,
              git: lstatus.git, gitType: lstatus.gitType, gitName: lstatus.gitName,
              gitOwner: lstatus.gitOwner, secret: lstatus.secret,
              gitCount: lstatus.gitCount || 0,
              lastCheck: new Date().toISOString(),
            };
            saveState(_state);
            loginResults.push({ email: la.email, ok: true, orgId: lps.orgId, git: lstatus.git });
          } catch (e) {
            loginResults.push({ email: la.email, ok: false, error: e.message });
          }
          // 避免429限流
          if (li < loginList.length - 1) await sleep(2000);
        }
        postMsg({ command: "batchLoginResult", ok: true, results: loginResults });
      } catch (e) {
        postMsg({ command: "batchLoginResult", ok: false, error: e.message });
      }
      break;

    case "removeAccount":
      delete _state.accounts[msg.email];
      delete _authCache[msg.email];
      saveState(_state);
      postMsg({ command: "removeAccountResult", ok: true, email: msg.email });
      break;
  }
  } catch (e) {
    console.error('[devin-git-auth] handleMessage error:', e);
    postMsg({ command: "error", error: e.message || String(e) });
  }
}

// ═══ Extension 激活 · 道恒无名 ═══
function activate(context) {
  _outputChannel = vscode.window.createOutputChannel('Devin Git Auth');
  context.subscriptions.push(_outputChannel);
  _log('═══ activate ═══ extension loaded');
  _log('state file: ' + STATE_FILE);
  _log('accounts: ' + Object.keys(_state.accounts || {}).length);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "devin-git.panel",
      {
        resolveWebviewView: function (webviewView) {
          _log('resolveWebviewView called');
          webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
          };
          webviewView.webview.html = getWebviewHtml(webviewView.webview, context.extensionUri);
          _webview = webviewView.webview;
          _log('webview html set, length=' + webviewView.webview.html.length);
          webviewView.webview.onDidReceiveMessage(function(msg) {
            _log('onDidReceiveMessage raw: ' + JSON.stringify(msg).slice(0, 200));
            handleMessage(msg);
          }, undefined, context.subscriptions);
          _log('onDidReceiveMessage handler registered');
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("devin-git.openPanel", function () {
      vscode.commands.executeCommand("workbench.view.extension.devin-git-container");
    })
  );
}

function deactivate() {}
module.exports = { activate, deactivate };
