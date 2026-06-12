"use strict";
// ═══════════════════════════════════════════════════════════
// dao-auth.js · 认证链与注入 API — 道生一 · 弱者道之用
// 独立 Node 模块, 零 VSCode 依赖。供 dao-git-auth-cli.js 复用。
// 与 extension.js 内联实现同源, 抽出为可复用核心(此前缺失, 致 CLI 无法加载)。
// 直连 https(无代理); 需代理时由调用方经 DAO_PROXY 环境变量注入。
// ═══════════════════════════════════════════════════════════
const https = require("https");
const http = require("http");
const urlmod = require("url");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const WINDSURF = "https://windsurf.com";
const DEVIN = "https://app.devin.ai";
const HTTP_TIMEOUT = 15000;

// 可选代理: DAO_PROXY=127.0.0.1:7890
function envProxy() {
  const p = process.env.DAO_PROXY;
  if (!p) return null;
  const m = p.split(":");
  if (m.length === 2) return { host: m[0], port: parseInt(m[1], 10) };
  return null;
}

function rawRequest(method, targetUrl, headers, body, opts) {
  opts = opts || {};
  const timeout = opts.timeoutMs || HTTP_TIMEOUT;
  return new Promise(function (resolve) {
    let u; try { u = new urlmod.URL(targetUrl); } catch (e) { return resolve({ status: 0, json: null, text: "bad_url" }); }
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const reqHeaders = Object.assign({
      "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "User-Agent": UA,
    }, headers || {});
    if (data) reqHeaders["Content-Length"] = data.length;

    const proxy = opts.forceDirect ? null : envProxy();
    if (proxy) {
      const proxyHeaders = Object.assign({}, reqHeaders, { "Host": u.hostname });
      const preq = http.request({ hostname: proxy.host, port: proxy.port, path: targetUrl, method: method, headers: proxyHeaders, timeout: timeout }, function (res) {
        const chunks = []; res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () { const text = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {} resolve({ status: res.statusCode || 0, json: j, text: text }); });
      });
      preq.on("error", function (e) { resolve({ status: 0, json: null, text: "proxy_err: " + e.message }); });
      preq.on("timeout", function () { preq.destroy(); resolve({ status: 0, json: null, text: "proxy_timeout" }); });
      if (data) preq.write(data); preq.end(); return;
    }

    const req = https.request({ method: method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: reqHeaders, timeout: timeout }, function (res) {
      const chunks = []; res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { const text = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {} resolve({ status: res.statusCode || 0, json: j, text: text }); });
    });
    req.on("error", function (e) { resolve({ status: 0, json: null, text: "err: " + e.message }); });
    req.on("timeout", function () { req.destroy(); resolve({ status: 0, json: null, text: "timeout" }); });
    if (data) req.write(data); req.end();
  });
}

function jsonPost(t, h, b, o) { return rawRequest("POST", t, h, b, o); }
function jsonGet(t, h, o) { return rawRequest("GET", t, h, null, o); }
function jsonDelete(t, h, o) { return rawRequest("DELETE", t, h, null, o); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ═══ 认证链 · 天得一以清 ═══
async function devinLogin(email, password) {
  let retry = 0;
  while (retry < 3) {
    const r = await jsonPost(WINDSURF + "/_devin-auth/password/login",
      { Origin: WINDSURF, Referer: WINDSURF + "/account/login" },
      { email: email, password: password });
    if (r.status === 429 && retry < 2) { await sleep(Math.pow(2, retry) * 2000); retry++; continue; }
    const j = r.json || {};
    if (j.token && j.user_id) return { auth1: j.token, userId: j.user_id };
    throw new Error((j.detail || j.error || j.message || "no_token") + " code=" + r.status);
  }
  throw new Error("devinLogin: rate-limited");
}

async function devinPostAuth(auth1) {
  const r = await jsonPost(DEVIN + "/api/users/post-auth", { Authorization: "Bearer " + auth1 }, {});
  const j = r.json || {};
  const orgId = (j.org && j.org.org_id) || j.org_id || "";
  const orgName = (j.org && j.org.org_name) || j.org_name || "";
  if (!orgId) throw new Error("no orgId code=" + r.status);
  return { orgId: orgId, orgName: orgName };
}

// ═══ Git 连接 API ═══
async function checkGitConnections(orgId, auth1) {
  const r = await jsonGet(DEVIN + "/api/organizations/" + orgId + "/git-connections-metadata", {
    Authorization: "Bearer " + auth1, "x-cog-org-id": orgId,
  });
  if (r.status === 200 && r.json) {
    const conns = Array.isArray(r.json) ? r.json : (r.json.git_connections || []);
    return { ok: true, connections: conns, count: conns.length };
  }
  return { ok: false, connections: [], count: 0, error: r.text ? r.text.slice(0, 100) : String(r.status) };
}

async function listSecrets(orgId, auth1) {
  const bareOrgId = orgId.replace(/^org-/, "");
  const r = await jsonGet(DEVIN + "/api/org-" + bareOrgId + "/secrets",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId });
  if (r.status === 200 && r.json) {
    const secrets = Array.isArray(r.json) ? r.json : (r.json.secrets || []);
    return { ok: true, secrets: secrets };
  }
  return { ok: false, secrets: [], error: r.text ? r.text.slice(0, 100) : String(r.status) };
}

async function injectGitHubPAT(orgId, pat, auth1) {
  const r = await jsonPost(DEVIN + "/api/" + orgId + "/integrations/github/pat",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId },
    { pat: pat }, { timeoutMs: 60000 });
  if (r.status === 200 || r.status === 201) return { ok: true };
  if (r.status === 400 && r.text && r.text.includes("already registered")) {
    return { ok: false, existed: true, alreadyRegistered: true, error: "该组织已有GitHub连接" };
  }
  if (r.status === 400 && r.text && r.text.toLowerCase().includes("invalid pat")) {
    return { ok: false, invalidPat: true, error: "PAT 无效或已过期" };
  }
  return { ok: false, error: r.text ? r.text.slice(0, 200) : "status=" + r.status };
}

async function injectSecret(orgId, name, value, auth1) {
  const bareOrgId = orgId.replace(/^org-/, "");
  const r = await jsonPost(DEVIN + "/api/org-" + bareOrgId + "/secrets",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId },
    { key: name, value: value, type: "key-value", sensitive: true, note: name });
  if (r.status === 200 || r.status === 201 || r.status === 409) return { ok: true, existed: r.status === 409 };
  return { ok: false, error: r.text ? r.text.slice(0, 100) : String(r.status) };
}

// 删除组织 Secret · 彻底解绑(删后零关联)。端点: DELETE /api/secrets/{id}
async function deleteSecret(orgId, name, auth1) {
  const l = await listSecrets(orgId, auth1);
  if (!l.ok) return { ok: false, error: l.error || "list_failed" };
  const hit = (l.secrets || []).find(function (s) { return s.key === name || s.name === name; });
  if (!hit) return { ok: true, missing: true };
  const sid = hit.id || hit.secret_id;
  if (!sid) return { ok: false, error: "no_secret_id" };
  const r = await jsonDelete(DEVIN + "/api/secrets/" + encodeURIComponent(sid),
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId });
  if (r.status === 200 || r.status === 204 || r.status === 404) return { ok: true };
  return { ok: false, error: r.text ? r.text.slice(0, 100) : String(r.status) };
}

module.exports = {
  WINDSURF, DEVIN,
  rawRequest, jsonGet, jsonPost, jsonDelete, sleep,
  devinLogin, devinPostAuth,
  checkGitConnections, listSecrets,
  injectGitHubPAT, injectSecret, deleteSecret,
};
