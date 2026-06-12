"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// devin_cloud.js · RT Flow 第五板块 · Devin Cloud 接入底层 (无 vscode 依赖 · 可单测)
//
// 帛书·「执天之行」: 把 dao-export 的「对话提取」与 dao-vsix 的「全功能 CRUD」
// 两套底层合一, 直接服务 rt-flow 账号池 —— 每个账号 email+password → auth1+orgId,
// 之后所有 Devin Cloud 能力(对话列表/导出/备份/追踪/水过无痕清理)皆走后端接口。
//
// 软编码·唯变所适: 所有端点与并发/超时集中在 CFG, configure() 可在不改代码下调整。
// 凭证只在内存与 ~/.wam/devin_cloud 缓存, 绝不写入仓库。
// ═══════════════════════════════════════════════════════════════════════════
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

// ── 路径 (与 rt-flow 共用 ~/.wam 根) ──────────────────────────────────────
const WAM_DIR = path.join(os.homedir(), ".wam");
const DC_DIR = path.join(WAM_DIR, "devin_cloud");
const DC_AUTH_CACHE = path.join(DC_DIR, "auth_cache.json"); // email → {auth1,orgId,...,ts}
const DC_TAGS_FILE = path.join(DC_DIR, "account_tags.json"); // email → 标签(防搞混)
const DC_BACKUP_STATE = path.join(DC_DIR, "backup_state.json"); // devinId → {eventCount, backedUpAt} 增量依据
const DC_BACKUP_DEFAULT = path.join(WAM_DIR, "devin_cloud_backups");

// ── 软编码配置 (唯变所适) ──────────────────────────────────────────────────
const CFG = {
  loginUrl: "https://windsurf.com/_devin-auth/password/login",
  apiBase: "https://app.devin.ai/api",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rt-flow-devin-cloud",
  authTtlMs: 12 * 60 * 60 * 1000, // 登录态缓存 12h
  reqTimeoutMs: 30000,
  streamTimeoutMs: 180000,
  downloadTimeoutMs: 120000,
  downloadConcurrency: 16,
  presignConcurrency: 8,
  presignChunk: 40,
};
function configure(opts) {
  if (opts && typeof opts === "object") Object.assign(CFG, opts);
  return CFG;
}

function ensureDir(d) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch {}
}

// ═══ 低层 HTTP (含 env 代理 CONNECT 隧道 + gzip/br 解码) ═══════════════════
function proxyForUrl(targetUrl) {
  const u = new URL(targetUrl);
  const isHttps = u.protocol === "https:";
  const env = process.env;
  const noProxy = env.NO_PROXY || env.no_proxy || "";
  if (noProxy === "*") return null;
  if (noProxy) {
    const host = u.hostname.toLowerCase();
    for (const part of noProxy.split(",").map((s) => s.trim().toLowerCase())) {
      if (part && (host === part || host.endsWith("." + part.replace(/^\./, "")))) return null;
    }
  }
  const p =
    (isHttps && (env.HTTPS_PROXY || env.https_proxy)) ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    "";
  if (!p) return null;
  try {
    return new URL(p);
  } catch {
    return null;
  }
}

function rawRequest(method, targetUrl, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === "https:";
    const tout = timeoutMs || CFG.reqTimeoutMs;
    const hdrs = Object.assign(
      { "User-Agent": CFG.ua, Accept: "application/json" },
      headers || {},
    );
    const proxy = proxyForUrl(targetUrl);

    const onResponse = (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "deflate") buf = zlib.inflateSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch {}
        resolve({ status: res.statusCode || 0, headers: res.headers, buf });
      });
      res.on("error", reject);
    };

    const fire = (opts, mod) => {
      const req = mod.request(opts, onResponse);
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      if (body) req.write(body);
      req.end();
    };

    if (proxy && isHttps) {
      // CONNECT 隧道 → 目标 TLS
      const c = http.request({
        host: proxy.hostname,
        port: parseInt(proxy.port || "8080", 10),
        method: "CONNECT",
        path: u.hostname + ":" + (u.port || 443),
        timeout: tout,
      });
      c.on("connect", (_res, socket) => {
        fire(
          {
            method,
            host: u.hostname,
            port: u.port ? parseInt(u.port, 10) : 443,
            path: u.pathname + u.search,
            headers: hdrs,
            timeout: tout,
            socket,
            agent: false,
            rejectUnauthorized: false,
          },
          https,
        );
      });
      c.on("error", reject);
      c.on("timeout", () => c.destroy(new Error("proxy connect timeout")));
      c.end();
      return;
    }
    if (proxy && !isHttps) {
      fire(
        {
          host: proxy.hostname,
          port: parseInt(proxy.port || "8080", 10),
          method,
          path: targetUrl,
          headers: Object.assign({ Host: u.hostname }, hdrs),
          timeout: tout,
        },
        http,
      );
      return;
    }
    fire(
      {
        method,
        host: u.hostname,
        port: u.port ? parseInt(u.port, 10) : isHttps ? 443 : 80,
        path: u.pathname + u.search,
        headers: hdrs,
        timeout: tout,
        rejectUnauthorized: false,
      },
      isHttps ? https : http,
    );
  });
}

async function jsonRequest(method, url, headers, body, timeoutMs) {
  const h = Object.assign({}, headers || {});
  let payload;
  if (body != null) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    h["Content-Type"] = h["Content-Type"] || "application/json";
  }
  const r = await rawRequest(method, url, h, payload, timeoutMs);
  const text = r.buf.toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

// ═══ 登录 / 鉴权 ═══════════════════════════════════════════════════════════
function authHeaders(auth, extra) {
  return Object.assign(
    { Authorization: "Bearer " + auth.auth1, "x-cog-org-id": auth.orgId },
    extra || {},
  );
}

async function login(email, password) {
  const resp = await jsonRequest("POST", CFG.loginUrl, {}, { email, password });
  if (resp.status !== 200 || !resp.json) {
    return { ok: false, error: "login HTTP " + resp.status + ": " + resp.text.slice(0, 160) };
  }
  const auth1 = resp.json.token || resp.json.access_token;
  if (!auth1) return { ok: false, error: "登录响应无 token" };
  const orgResp = await jsonRequest(
    "POST",
    CFG.apiBase + "/users/post-auth",
    { Authorization: "Bearer " + auth1 },
    {},
  );
  const od = orgResp.json || {};
  const orgId = od.org_id || od.orgId || "";
  if (!orgId) return { ok: false, error: "post-auth 无 org_id (HTTP " + orgResp.status + ")" };
  return {
    ok: true,
    auth1,
    orgId,
    orgBare: orgId.replace(/^org-/, ""),
    orgName: od.org_name || od.orgName || "",
    email,
  };
}

// 登录态缓存: email → auth. 12h 内复用, 过期或 force 时重登。
async function getAuth(email, password, opts) {
  opts = opts || {};
  const cache = readJson(DC_AUTH_CACHE, {});
  const key = String(email).toLowerCase();
  const hit = cache[key];
  if (!opts.force && hit && hit.auth1 && Date.now() - (hit.ts || 0) < CFG.authTtlMs) {
    return { ok: true, auth1: hit.auth1, orgId: hit.orgId, orgBare: hit.orgBare, orgName: hit.orgName, email, cached: true };
  }
  const r = await login(email, password);
  if (r.ok) {
    cache[key] = { auth1: r.auth1, orgId: r.orgId, orgBare: r.orgBare, orgName: r.orgName, ts: Date.now() };
    writeJson(DC_AUTH_CACHE, cache);
  }
  return r;
}

function clearAuthCache(email) {
  const cache = readJson(DC_AUTH_CACHE, {});
  if (email) delete cache[String(email).toLowerCase()];
  else for (const k of Object.keys(cache)) delete cache[k];
  writeJson(DC_AUTH_CACHE, cache);
}

// 已登录(缓存内且未过期)账号 → 用于轻量轮询运行状态, 不强行登录全部账号 (无为)
function getCachedAuth(email) {
  const hit = readJson(DC_AUTH_CACHE, {})[String(email).toLowerCase()];
  if (hit && hit.auth1 && Date.now() - (hit.ts || 0) < CFG.authTtlMs) {
    return { auth1: hit.auth1, orgId: hit.orgId, orgBare: hit.orgBare, orgName: hit.orgName, email };
  }
  return null;
}
function cachedEmails() {
  const cache = readJson(DC_AUTH_CACHE, {});
  return Object.keys(cache).filter((k) => cache[k] && cache[k].auth1 && Date.now() - (cache[k].ts || 0) < CFG.authTtlMs);
}

// ═══ Cloud 读取 ════════════════════════════════════════════════════════════
function asArray(j, ...keys) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== "object") return [];
  for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return [];
}

async function listSessions(auth, limit) {
  let url = CFG.apiBase + "/org-" + auth.orgBare + "/v2sessions";
  if (limit) url += "?limit=" + limit;
  let r = await jsonRequest("GET", url, authHeaders(auth), null, 60000);
  if (r.status === 200) {
    const arr = asArray(r.json, "result", "sessions", "data");
    if (arr.length || (r.json && (r.json.result || r.json.sessions))) return { ok: true, sessions: arr };
  }
  // 备用端点
  r = await jsonRequest("GET", CFG.apiBase + "/sessions", authHeaders(auth), null, 60000);
  if (r.status === 200) return { ok: true, sessions: asArray(r.json, "result", "sessions", "data") };
  return { ok: false, sessions: [], error: "list sessions HTTP " + r.status };
}

async function getSessionDetail(auth, devinId) {
  const r = await jsonRequest("GET", CFG.apiBase + "/sessions/" + devinId, authHeaders(auth));
  return r.status === 200 ? r.json || {} : {};
}

// ═══ Cloud 写入 (代替用户发起对话) ═══════════════════════════════════════════
// 发起一个新的 Devin Cloud 对话 (session)。prompt 为首条用户消息。
// opts: { title, tags, playbookId, repos, sessionSecrets, idempotencyKey }
async function createSession(auth, prompt, opts) {
  opts = opts || {};
  const payload = { prompt: String(prompt || "") };
  if (opts.title) payload.title = opts.title;
  if (opts.tags) payload.tags = opts.tags;
  if (opts.playbookId) payload.playbook_id = opts.playbookId;
  if (opts.repos) payload.repos = opts.repos;
  if (opts.sessionSecrets) payload.session_secrets = opts.sessionSecrets;
  if (opts.idempotencyKey) payload.idempotency_key = opts.idempotencyKey;
  const r = await jsonRequest("POST", CFG.apiBase + "/sessions", authHeaders(auth), payload);
  if (r.status === 200 || r.status === 201) {
    const j = r.json || {};
    return { ok: true, devinId: j.devin_id || j.session_id || j.id, isNewSession: j.is_new_session, createdAt: j.created_at, raw: j };
  }
  return { ok: false, status: r.status, error: "createSession HTTP " + r.status + ": " + (r.text || "").slice(0, 160) };
}

// 向已有对话追加一条用户消息 (继续对话 → 触发新事件/更新)。
// 采用 Devin 官方公开 API 端点形态: POST /session/{id}/message  {message}
// 注: 在已用尽额度/已结束的会话上无法实跑验证 (会返回 404/403)。
async function sendMessage(auth, devinId, message) {
  const r = await jsonRequest(
    "POST",
    CFG.apiBase + "/session/" + devinId + "/message",
    authHeaders(auth),
    { message: String(message || "") },
  );
  return { ok: r.status >= 200 && r.status < 300, status: r.status, raw: r.json, text: (r.text || "").slice(0, 200) };
}

// 事件流 (SSE/ndjson/json 混合) → 去重排序后的事件数组
async function getEventStream(auth, devinId) {
  const url = CFG.apiBase + "/events/" + devinId + "/stream";
  let resp;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await rawRequest(
        "GET",
        url,
        authHeaders(auth, { Accept: "text/event-stream" }),
        null,
        CFG.streamTimeoutMs,
      );
      if (r.status === 200) {
        resp = r.buf.toString("utf8");
        break;
      }
    } catch {}
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (resp == null) {
    // first-load 兜底
    const r = await jsonRequest("GET", CFG.apiBase + "/events/first-load/" + devinId, authHeaders(auth));
    return asArray(r.json, "result", "events");
  }
  const merged = new Map();
  const add = (ev) => {
    if (!ev || !ev.type) return;
    const eid = ev.event_id || ev.type + "-" + ev.timestamp + "-" + ev.created_at_ms;
    if (!merged.has(eid)) merged.set(eid, ev);
  };
  const raw = resp;
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && " \r\n\t".includes(raw[i])) i++;
    if (i >= raw.length) break;
    if (raw[i] === "{") {
      let depth = 0, j = i, inStr = false, esc = false;
      for (; j < raw.length; j++) {
        const ch = raw[j];
        if (esc) { esc = false; continue; }
        if (ch === "\\" && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depth++;
        if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
      }
      try {
        const obj = JSON.parse(raw.slice(i, j));
        if (obj.result && Array.isArray(obj.result)) obj.result.forEach(add);
        else add(obj);
      } catch {}
      i = j;
    } else {
      const lineEnd = raw.indexOf("\n", i);
      const end = lineEnd === -1 ? raw.length : lineEnd;
      const line = raw.slice(i, end).trim();
      i = end + 1;
      if (line.startsWith("data:")) {
        const ds = line.slice(5).trim();
        if (ds && ds !== "[DONE]") {
          try {
            const obj = JSON.parse(ds);
            if (obj.result && Array.isArray(obj.result)) obj.result.forEach(add);
            else add(obj);
          } catch {}
        }
      }
    }
  }
  const events = Array.from(merged.values());
  events.sort((a, b) => (a.created_at_ms || 0) - (b.created_at_ms || 0));
  return events;
}

async function listKnowledge(auth) {
  const r = await jsonRequest("GET", CFG.apiBase + "/org-" + auth.orgBare + "/learning/all", authHeaders(auth));
  return r.status === 200 ? { ok: true, learnings: asArray(r.json, "learnings") } : { ok: false, learnings: [] };
}
async function listPlaybooks(auth) {
  const r = await jsonRequest("GET", CFG.apiBase + "/org-" + auth.orgBare + "/playbooks", authHeaders(auth));
  return r.status === 200 ? { ok: true, playbooks: asArray(r.json, "playbooks") } : { ok: false, playbooks: [] };
}
async function listSecrets(auth) {
  const r = await jsonRequest("GET", CFG.apiBase + "/org-" + auth.orgBare + "/secrets", authHeaders(auth));
  return r.status === 200 ? { ok: true, secrets: asArray(r.json, "secrets") } : { ok: false, secrets: [] };
}
async function getGitConnections(auth) {
  const r = await jsonRequest("GET", CFG.apiBase + "/organizations/" + auth.orgId + "/git-connections-metadata", authHeaders(auth));
  if (r.status !== 200) return { ok: false, connections: [] };
  const conns = Array.isArray(r.json) ? r.json : asArray(r.json, "connections");
  return { ok: true, connections: conns };
}
// 额度: app.devin.ai/api/{orgId}/billing/status → {overage_credits, billing_error}
async function getBilling(auth) {
  const r = await jsonRequest("GET", CFG.apiBase + "/" + auth.orgId + "/billing/status", authHeaders(auth));
  if (r.status === 200 && r.json) return { ok: true, billing: r.json };
  return { ok: false, billing: null };
}

// 账号本源概览 (下拉框用): 对话(着重) + 知识库/剧本/密钥/Git/额度 简要
async function accountOverview(auth) {
  const [sessions, knowledge, playbooks, secrets, git, billing] = await Promise.all([
    listSessions(auth),
    listKnowledge(auth),
    listPlaybooks(auth),
    listSecrets(auth),
    getGitConnections(auth),
    getBilling(auth),
  ]);
  const ss = sessions.sessions || [];
  return {
    email: auth.email,
    orgId: auth.orgId,
    sessions: ss.map((s) => ({
      devinId: s.devin_id || s.session_id || s.id,
      title: s.title || s.name || "(未命名)",
      status: s.status || s.activity_status || "",
      statusClass: classifySession(s),
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      tags: s.tags || [],
    })),
    counts: {
      sessions: ss.length,
      running: ss.filter((s) => classifySession(s) === "running").length,
      knowledge: (knowledge.learnings || []).length,
      playbooks: (playbooks.playbooks || []).length,
      secrets: (secrets.secrets || []).length,
      gitConnections: (git.connections || []).length,
    },
    knowledge: (knowledge.learnings || []).map((k) => ({ id: k.id, name: k.name || k.title || "" })),
    gitConnections: (git.connections || []).map((c) => ({
      id: c.id || c.connection_id,
      name: c.name || c.username || c.account_login || c.org || "",
      provider: c.provider || c.type || "github",
    })),
    billing: billing.billing || null,
  };
}

// ═══ 会话状态分类 (对话追踪用) ════════════════════════════════════════════
// running: 运行中(streaming/working/blocked-waiting) · blocked: 额度超限/出错卡住
// finished: 已完成 · idle: 空闲/其它
function classifySession(s) {
  const raw = String(s.status || s.activity_status || s.current_activity || "").toLowerCase();
  if (/(quota|credit|overage|insufficient|exceeded|billing)/.test(raw)) return "blocked";
  if (/(error|failed|stuck)/.test(raw)) return "blocked";
  if (/(running|working|in_progress|streaming|active|started|resumed|busy)/.test(raw)) return "running";
  if (/(finished|completed|done|stopped|suspended|expired|exited|blocked|awaiting_input|waiting_for_user|sleeping|idle)/.test(raw)) {
    return /(blocked|awaiting_input|waiting_for_user)/.test(raw) ? "running" : "finished";
  }
  return "idle";
}

async function listRunningSessions(auth) {
  const r = await listSessions(auth, 100);
  const running = (r.sessions || []).filter((s) => classifySession(s) === "running");
  return running.map((s) => ({
    devinId: s.devin_id || s.session_id || s.id,
    title: s.title || s.name || "(未命名)",
    status: s.status || s.activity_status || "",
    statusClass: classifySession(s),
  }));
}

// ═══ 删除接口全集 (水过无痕底层) ══════════════════════════════════════════
function okDelete(status) {
  return status === 200 || status === 202 || status === 204 || status === 404;
}
async function deleteKnowledge(auth, id) {
  const r = await jsonRequest("DELETE", CFG.apiBase + "/org-" + auth.orgBare + "/learning/" + id, authHeaders(auth));
  return { ok: okDelete(r.status), status: r.status };
}
async function deletePlaybook(auth, id) {
  const r = await jsonRequest("DELETE", CFG.apiBase + "/org-" + auth.orgBare + "/playbooks/" + id, authHeaders(auth));
  return { ok: okDelete(r.status), status: r.status };
}
async function deleteSecret(auth, idOrName) {
  let id = idOrName;
  if (!/^[a-z]+-/.test(String(idOrName))) {
    const list = await listSecrets(auth);
    const hit = (list.secrets || []).find((s) => s.name === idOrName || s.id === idOrName);
    if (!hit) return { ok: true, status: 404 };
    id = hit.id;
  }
  const r = await jsonRequest("DELETE", CFG.apiBase + "/org-" + auth.orgBare + "/secrets/" + id, authHeaders(auth));
  return { ok: okDelete(r.status), status: r.status };
}
async function disconnectGit(auth, connectionId) {
  const r = await jsonRequest("DELETE", CFG.apiBase + "/organizations/" + auth.orgId + "/git-connections/" + connectionId, authHeaders(auth));
  return { ok: okDelete(r.status), status: r.status };
}
// 删除会话: 尝试多种已知端点形态 (唯变所适 · 端点变动时仍能命中其一)
async function deleteSession(auth, devinId) {
  const candidates = [
    CFG.apiBase + "/sessions/" + devinId,
    CFG.apiBase + "/org-" + auth.orgBare + "/sessions/" + devinId,
    CFG.apiBase + "/devin/" + devinId,
  ];
  let last = 0;
  for (const url of candidates) {
    const r = await jsonRequest("DELETE", url, authHeaders(auth));
    last = r.status;
    if (okDelete(r.status)) return { ok: true, status: r.status };
  }
  // 删不掉则尝试归档 (软删除)
  for (const url of candidates) {
    const r = await jsonRequest("PATCH", url, authHeaders(auth), { archived: true, status: "archived" });
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, archived: true };
  }
  return { ok: false, status: last };
}

// 水过无痕: 删除某账号在 Devin Cloud 的全部使用痕迹 → 回到未使用原始态
// dryRun=true 只统计不删除 (先把所有东西找出来) · onProgress(msg) 实时回报
async function wipeAccount(auth, opts) {
  opts = opts || {};
  const dry = !!opts.dryRun;
  const prog = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const report = {
    email: auth.email,
    dryRun: dry,
    sessions: { found: 0, deleted: 0, failed: 0 },
    knowledge: { found: 0, deleted: 0, failed: 0 },
    playbooks: { found: 0, deleted: 0, failed: 0 },
    secrets: { found: 0, deleted: 0, failed: 0 },
    gitConnections: { found: 0, deleted: 0, failed: 0 },
    errors: [],
  };

  prog("扫描账号痕迹...");
  const [sess, kn, pb, sec, git] = await Promise.all([
    listSessions(auth, 1000),
    listKnowledge(auth),
    listPlaybooks(auth),
    listSecrets(auth),
    getGitConnections(auth),
  ]);
  const sessions = sess.sessions || [];
  const learnings = kn.learnings || [];
  const playbooks = pb.playbooks || [];
  const secrets = sec.secrets || [];
  const conns = git.connections || [];
  report.sessions.found = sessions.length;
  report.knowledge.found = learnings.length;
  report.playbooks.found = playbooks.length;
  report.secrets.found = secrets.length;
  report.gitConnections.found = conns.length;

  if (dry) {
    prog(
      "扫描完成: 对话" + sessions.length + " 知识库" + learnings.length +
      " 剧本" + playbooks.length + " 密钥" + secrets.length + " Git" + conns.length,
    );
    return report;
  }

  // 删除顺序: git连接 → 密钥 → 剧本 → 知识库 → 对话 (先外围后核心)
  for (const c of conns) {
    const id = c.id || c.connection_id;
    if (!id) { report.gitConnections.failed++; continue; }
    const r = await disconnectGit(auth, id);
    r.ok ? report.gitConnections.deleted++ : (report.gitConnections.failed++, report.errors.push("git:" + id + ":" + r.status));
    prog("断开 Git 连接 " + report.gitConnections.deleted + "/" + conns.length);
  }
  for (const s of secrets) {
    const r = await deleteSecret(auth, s.id || s.name);
    r.ok ? report.secrets.deleted++ : (report.secrets.failed++, report.errors.push("secret:" + (s.name || s.id) + ":" + r.status));
    prog("删除密钥 " + report.secrets.deleted + "/" + secrets.length);
  }
  for (const p of playbooks) {
    if (!p.id) { report.playbooks.failed++; continue; }
    const r = await deletePlaybook(auth, p.id);
    r.ok ? report.playbooks.deleted++ : (report.playbooks.failed++, report.errors.push("playbook:" + p.id + ":" + r.status));
    prog("删除剧本 " + report.playbooks.deleted + "/" + playbooks.length);
  }
  for (const k of learnings) {
    if (!k.id) { report.knowledge.failed++; continue; }
    const r = await deleteKnowledge(auth, String(k.id));
    r.ok ? report.knowledge.deleted++ : (report.knowledge.failed++, report.errors.push("knowledge:" + k.id + ":" + r.status));
    prog("删除知识库 " + report.knowledge.deleted + "/" + learnings.length);
  }
  for (const s of sessions) {
    const id = s.devin_id || s.session_id || s.id;
    if (!id) { report.sessions.failed++; continue; }
    const r = await deleteSession(auth, id);
    r.ok ? report.sessions.deleted++ : (report.sessions.failed++, report.errors.push("session:" + id + ":" + r.status));
    prog("清理对话 " + report.sessions.deleted + "/" + sessions.length);
  }
  prog("水过无痕完成");
  return report;
}

// ═══ 并发池 ════════════════════════════════════════════════════════════════
async function runPool(items, concurrency, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) || 0 }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

// ═══ 事件 → 文档 (人看的 MD + Agent 看的 JSON) ════════════════════════════
function extractMessageText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(extractMessageText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.message === "string") return v.message;
    if (v.content != null) return extractMessageText(v.content);
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}
function evTs(ev) {
  const ms = ev.created_at_ms || (ev.timestamp ? Date.parse(ev.timestamp) : 0);
  return ms ? new Date(ms).toISOString() : "";
}
function userAnswerText(ev) {
  const answers = ev.answers || [];
  return answers
    .map((a) => {
      if (!a) return "";
      if (a.other_text) return a.other_text;
      if (Array.isArray(a.selected)) return a.selected.join("; ");
      if (typeof a.text === "string") return a.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
// 对话转录 (人看的)
function buildConversationMd(title, devinId, events) {
  const lines = ["# 对话: " + title, "", "- Session: `" + devinId + "`", "- 事件数: " + events.length, ""];
  for (const ev of events) {
    const t = ev.type;
    if (t === "initial_user_message" || t === "user_message") {
      lines.push("## 👤 用户  " + evTs(ev), "", extractMessageText(ev.message), "");
    } else if (t === "user_question_answered") {
      const txt = userAnswerText(ev);
      if (txt) lines.push("## 👤 用户(回答)  " + evTs(ev), "", txt, "");
    } else if (t === "devin_message") {
      lines.push("## 🤖 Devin  " + evTs(ev), "", extractMessageText(ev.message), "");
    }
  }
  return lines.join("\n");
}
// Agent 看的: 全事件 + 产出文件索引 (机器可读)
function buildAgentDoc(title, devinId, detail, events, fileIndex) {
  return JSON.stringify(
    {
      schema: "rt-flow.devin-cloud.conversation/1",
      title,
      devinId,
      sessionInfo: detail || {},
      eventCount: events.length,
      events,
      producedFiles: fileIndex || [],
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}
function extractAllKeys(events) {
  const keys = new Set();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    for (const [k, v] of Object.entries(o)) {
      if (k === "contents_key" && typeof v === "string" && v) keys.add(v);
      else walk(v);
    }
  })(events);
  return Array.from(keys).sort();
}
function mapKeysToPaths(events) {
  const m = new Map();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.contents_key && o.file_path) m.set(o.contents_key, o.file_path);
    for (const v of Object.values(o)) walk(v);
  })(events);
  return m;
}
function safeName(s, maxLen) {
  maxLen = maxLen || 60;
  return String(s || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen) || "untitled";
}

async function resolvePresignedUrls(auth, devinId, keys) {
  const result = new Map();
  const batches = [];
  for (let i = 0; i < keys.length; i += CFG.presignChunk) batches.push(keys.slice(i, i + CFG.presignChunk));
  const url = CFG.apiBase + "/presigned-url/batch/" + devinId;
  await runPool(batches, CFG.presignConcurrency, async (batch) => {
    const r = await jsonRequest("POST", url, authHeaders(auth), { s3_key_list: batch }, 30000);
    if (r.json) {
      const urls = r.json.urls_list || [];
      const hdrs = r.json.headers_list || [];
      for (let j = 0; j < batch.length; j++) if (urls[j]) result.set(batch[j], { url: urls[j], headers: hdrs[j] || {} });
    }
  });
  return result;
}
async function downloadFile(url, headers) {
  const r = await rawRequest("GET", url, headers || {}, null, CFG.downloadTimeoutMs);
  if (r.status < 200 || r.status >= 300) throw new Error("download HTTP " + r.status);
  return r.buf;
}

// ═══ 备份 (Devin Cloud 目录结构 · 增量) ═══════════════════════════════════
// 结构: <root>/<账号名>/<devinId 末8位>_<对话名>.zip
//   zip 内: 对话_人类可读.md · 对话_agent.json · files/<产出文件>
// 增量: backup_state[devinId].eventCount 与本次事件数相同则跳过 (同源不重复)。
function backupStateKey(auth, devinId) {
  return auth.orgBare + ":" + devinId;
}
async function backupOneConversation(auth, sess, accountDir, opts) {
  opts = opts || {};
  const devinId = sess.devin_id || sess.devinId || sess.session_id || sess.id;
  const title = sess.title || sess.name || "未命名";
  const events = await getEventStream(auth, devinId);

  // 增量判断
  const state = readJson(DC_BACKUP_STATE, {});
  const sk = backupStateKey(auth, devinId);
  if (opts.incremental !== false && state[sk] && state[sk].eventCount === events.length) {
    return { devinId, title, skipped: true, reason: "no-new-events", eventCount: events.length };
  }

  const detail = await getSessionDetail(auth, devinId);
  const zip = new ZipWriter();
  const fileIndex = [];

  // 产出文件: 取每个 contents_key 最终态
  const finalState = new Map();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.file_path && o.contents_key) finalState.set(o.file_path, o.contents_key);
    for (const v of Object.values(o)) walk(v);
  })(events);
  const changes = Array.from(finalState.entries()).map(([p, k]) => ({ path: p, key: k }));
  const allKeys = Array.from(new Set(changes.map((c) => c.key)));
  if (allKeys.length) {
    const urlMap = await resolvePresignedUrls(auth, devinId, allKeys);
    const cache = new Map();
    await runPool(allKeys, CFG.downloadConcurrency, async (key) => {
      const info = urlMap.get(key);
      if (!info) return;
      try {
        cache.set(key, await downloadFile(info.url, info.headers));
      } catch (e) {
        fileIndex.push({ key, error: String(e && e.message ? e.message : e) });
      }
    });
    for (const ch of changes) {
      const data = cache.get(ch.key);
      if (!data) continue;
      const rel = ch.path
        .replace(/^[A-Za-z]:[\\/]/, "")
        .replace(/^[\\/]+/, "")
        .replace(/\\/g, "/")
        .split("/")
        .map((p) => safeName(p, 60))
        .join("/");
      zip.addFile("files/" + rel, data);
      fileIndex.push({ path: ch.path, file: "files/" + rel, size: data.length });
    }
  }

  zip.addFile("对话_人类可读.md", buildConversationMd(title, devinId, events));
  zip.addFile("对话_agent.json", buildAgentDoc(title, devinId, detail, events, fileIndex));
  zip.addFile(
    "_meta.json",
    JSON.stringify(
      { devinId, title, account: auth.email, orgId: auth.orgId, eventCount: events.length, producedFiles: fileIndex.length, backedUpAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  const shortId = String(devinId).replace(/^devin-/, "").slice(0, 8);
  const zipName = shortId + "_" + safeName(title, 50) + ".zip";
  ensureDir(accountDir);
  const zipPath = path.join(accountDir, zipName);
  fs.writeFileSync(zipPath, zip.toBuffer());

  state[sk] = { eventCount: events.length, backedUpAt: Date.now(), zip: zipName };
  writeJson(DC_BACKUP_STATE, state);
  return { devinId, title, skipped: false, eventCount: events.length, producedFiles: fileIndex.length, zip: zipPath };
}

// 备份某账号全部对话 (增量) → <root>/<账号名>/
async function backupAccount(auth, opts) {
  opts = opts || {};
  const root = opts.targetDir || DC_BACKUP_DEFAULT;
  const prog = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const accountDir = path.join(root, safeName(auth.email, 80));
  ensureDir(accountDir);
  const r = await listSessions(auth, 1000);
  const sessions = r.sessions || [];
  const result = { ok: true, account: auth.email, dir: accountDir, total: sessions.length, backedUp: 0, skipped: 0, failed: 0, items: [] };
  for (let i = 0; i < sessions.length; i++) {
    prog("备份 " + (i + 1) + "/" + sessions.length + " ...");
    try {
      const one = await backupOneConversation(auth, sessions[i], accountDir, opts);
      result.items.push(one);
      one.skipped ? result.skipped++ : result.backedUp++;
    } catch (e) {
      result.failed++;
      result.items.push({ error: String(e && e.message ? e.message : e) });
    }
  }
  prog("账号备份完成: 新备份" + result.backedUp + " 跳过" + result.skipped + " 失败" + result.failed);
  return result;
}

// ═══ 备份浏览 + 快速解锁(解压) ════════════════════════════════════════════
// 列出备份根下「账号 → 对话 ZIP」树, 供前端浏览。
function listBackups(root) {
  root = root || DC_BACKUP_DEFAULT;
  const out = { root, accounts: [] };
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const accDir = path.join(root, d.name);
    let files = [];
    try { files = fs.readdirSync(accDir).filter((f) => f.toLowerCase().endsWith(".zip")); } catch {}
    const convs = files.map((f) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(accDir, f)); size = st.size; mtime = st.mtimeMs; } catch {}
      return { name: f, path: path.join(accDir, f), size, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    out.accounts.push({ account: d.name, dir: accDir, count: convs.length, conversations: convs });
  }
  out.accounts.sort((a, b) => b.count - a.count);
  return out;
}

// 解锁(解压)一个对话 ZIP → 同名文件夹, 返回解压目录。用本地 zlib inflate, 零外部依赖。
function unlockBackup(zipPath, opts) {
  opts = opts || {};
  if (!fs.existsSync(zipPath)) return { ok: false, error: "ZIP 不存在: " + zipPath };
  const outDir = opts.outDir || zipPath.replace(/\.zip$/i, "");
  ensureDir(outDir);
  const buf = fs.readFileSync(zipPath);
  const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // central directory header
  let i = 0, count = 0;
  while ((i = buf.indexOf(sig, i)) !== -1) {
    const method = buf.readUInt16LE(i + 10);
    const compSize = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const lho = buf.readUInt32LE(i + 42); // local header offset
    const name = buf.slice(i + 46, i + 46 + nameLen).toString("utf8");
    // local header: 30 + nameLen + extraLen → data
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(comp) : comp; } catch { data = comp; }
    const dest = path.join(outDir, name);
    if (name.endsWith("/")) { ensureDir(dest); }
    else { ensureDir(path.dirname(dest)); fs.writeFileSync(dest, data); count++; }
    i += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, outDir, files: count };
}

// ═══ 账号标签 (防搞混) ════════════════════════════════════════════════════
function getTag(email) {
  return (readJson(DC_TAGS_FILE, {})[String(email).toLowerCase()] || "");
}
function setTag(email, tag) {
  const t = readJson(DC_TAGS_FILE, {});
  const k = String(email).toLowerCase();
  if (tag) t[k] = String(tag).slice(0, 40);
  else delete t[k];
  writeJson(DC_TAGS_FILE, t);
  return t[k] || "";
}
function allTags() {
  return readJson(DC_TAGS_FILE, {});
}

// ═══ 导出 MD (给本地/其它 Agent 的操作指令文档) ═══════════════════════════
// 前端只需一个「导出 MD」按钮: 用户复制此文档给本地 Agent, Agent 据此后端驱动全部能力。
function buildAgentMd(ctx) {
  ctx = ctx || {};
  const accounts = ctx.accounts || [];
  const backupRoot = ctx.backupRoot || DC_BACKUP_DEFAULT;
  const L = [];
  L.push("# RT Flow · Devin Cloud 后端操作指令 (Agent 用)");
  L.push("");
  L.push("> 本文档由 RT Flow 第五板块「导出 MD」生成。把它交给本地 Agent，");
  L.push("> Agent 即可代替用户、经后端接口完成对话导出/备份/水过无痕清理等全部操作。");
  L.push("> 一切软编码、唯变所适：端点若变动，以 rt-flow 配置 (CFG) 为准。");
  L.push("");
  L.push("## 0. 鉴权");
  L.push("- 登录: `POST " + CFG.loginUrl + "` body `{email,password}` → `token` (=auth1)");
  L.push("- 组织: `POST " + CFG.apiBase + "/users/post-auth` (Bearer auth1) → `org_id`");
  L.push("- 之后所有请求带 `Authorization: Bearer <auth1>` 与 `x-cog-org-id: <org_id>`");
  L.push("- bare = org_id 去掉 `org-` 前缀");
  L.push("");
  L.push("## 1. 读取 (对话/知识库/剧本/密钥/Git/额度)");
  L.push("- 对话列表: `GET /api/org-{bare}/v2sessions` (备用 `/api/sessions`)");
  L.push("- 对话详情: `GET /api/sessions/{devinId}`");
  L.push("- 事件流: `GET /api/events/{devinId}/stream` (兜底 `/api/events/first-load/{devinId}`)");
  L.push("- 文件下载: `POST /api/presigned-url/batch/{devinId}` body `{s3_key_list:[...]}` → 逐个 GET 预签 URL");
  L.push("- 知识库: `GET /api/org-{bare}/learning/all`");
  L.push("- 剧本: `GET /api/org-{bare}/playbooks`");
  L.push("- 密钥: `GET /api/org-{bare}/secrets`");
  L.push("- Git 连接: `GET /api/organizations/{org_id}/git-connections-metadata`");
  L.push("- 额度: `GET /api/{org_id}/billing/status`");
  L.push("");
  L.push("## 1b. 写入 (代替用户发起/续写对话)");
  L.push("- 发起对话: `POST /api/sessions` body `{prompt, title?, tags?, playbook_id?, repos?}` → `{devin_id, is_new_session, created_at}`");
  L.push("- 续写对话: `POST /api/session/{devinId}/message` body `{message}` (官方公开 API 形态)");
  L.push("- 发起后用 §1 的对话详情/事件流轮询即可实时观测运行状态、事件增长。");
  L.push("");
  L.push("## 2. 备份 (Devin Cloud 结构 · 增量)");
  L.push("- 目录: `" + backupRoot + "/<账号名>/<devinId末8位>_<对话名>.zip`");
  L.push("- 每个 zip: `对话_人类可读.md` + `对话_agent.json` + `files/<产出文件>` + `_meta.json`");
  L.push("- 增量: 比较本次事件数与上次 `eventCount`，相同则跳过；事件增长则重备(追加新事件)。");
  L.push("- 浏览/解锁: 列出 `<root>/<账号>/*.zip`；解锁=本地 inflate 解压到同名文件夹 (零依赖)。");
  L.push("");
  L.push("## 3. 水过无痕 (一键清理 → 账号回到未使用态)");
  L.push("先列出再逐个删除 (顺序: Git→密钥→剧本→知识库→对话):");
  L.push("- `DELETE /api/organizations/{org_id}/git-connections/{connectionId}`");
  L.push("- `DELETE /api/org-{bare}/secrets/{secretId}`");
  L.push("- `DELETE /api/org-{bare}/playbooks/{playbookId}`");
  L.push("- `DELETE /api/org-{bare}/learning/{knowledgeId}`");
  L.push("- `DELETE /api/sessions/{devinId}` (备 `/api/org-{bare}/sessions/{devinId}`；删不掉则 PATCH archived)");
  L.push("");
  if (accounts.length) {
    L.push("## 4. 目标账号");
    for (const a of accounts) {
      const tag = getTag(a.email);
      L.push("- " + a.email + (tag ? "  [标签: " + tag + "]" : ""));
    }
    L.push("");
  }
  L.push("## 5. RT Flow 命令 (在 Devin Desktop 内可直接调用)");
  L.push("- `wam.devinBackupAccount` 备份指定账号全部对话 (增量)");
  L.push("- `wam.devinWipeAccount` 水过无痕清理指定账号");
  L.push("- `wam.devinExportMd` 导出本文档");
  L.push("");
  L.push("_生成时间: " + new Date().toISOString() + "_");
  return L.join("\n");
}

// ═══ 零依赖 ZIP 写出器 (STORE + DEFLATE) ══════════════════════════════════
let _crcTable;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
class ZipWriter {
  constructor() {
    this.entries = [];
    this.chunks = [];
    this.offset = 0;
  }
  addFile(name, data) {
    const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    const nameBuf = Buffer.from(String(name).replace(/\\/g, "/"), "utf-8");
    const crc = crc32(buf);
    let compressed = Buffer.from(zlib.deflateRawSync(buf, { level: 6 }));
    let method = 8;
    if (compressed.length >= buf.length) {
      compressed = buf;
      method = 0;
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    const entryOffset = this.offset;
    this.chunks.push(header, nameBuf, compressed);
    this.offset += header.length + nameBuf.length + compressed.length;
    this.entries.push({ name: nameBuf, dataLen: buf.length, compressed, crc, offset: entryOffset, method });
  }
  toBuffer() {
    const centralStart = this.offset;
    const central = [];
    let centralSize = 0;
    for (const e of this.entries) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0);
      rec.writeUInt16LE(20, 4);
      rec.writeUInt16LE(20, 6);
      rec.writeUInt16LE(0x0800, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(0, 12);
      rec.writeUInt16LE(0x21, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compressed.length, 20);
      rec.writeUInt32LE(e.dataLen, 24);
      rec.writeUInt16LE(e.name.length, 28);
      rec.writeUInt16LE(0, 30);
      rec.writeUInt16LE(0, 32);
      rec.writeUInt16LE(0, 34);
      rec.writeUInt16LE(0, 36);
      rec.writeUInt32LE(0, 38);
      rec.writeUInt32LE(e.offset, 42);
      central.push(rec, e.name);
      centralSize += rec.length + e.name.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...this.chunks, ...central, eocd]);
  }
}

module.exports = {
  CFG,
  configure,
  paths: { WAM_DIR, DC_DIR, DC_AUTH_CACHE, DC_TAGS_FILE, DC_BACKUP_STATE, DC_BACKUP_DEFAULT },
  // auth
  login,
  getAuth,
  clearAuthCache,
  getCachedAuth,
  cachedEmails,
  authHeaders,
  // reads
  listSessions,
  getSessionDetail,
  getEventStream,
  // writes (代替用户发起/续写对话)
  createSession,
  sendMessage,
  listKnowledge,
  listPlaybooks,
  listSecrets,
  getGitConnections,
  getBilling,
  accountOverview,
  classifySession,
  listRunningSessions,
  // deletes / wipe
  deleteKnowledge,
  deletePlaybook,
  deleteSecret,
  disconnectGit,
  deleteSession,
  wipeAccount,
  // backup
  backupAccount,
  backupOneConversation,
  listBackups,
  unlockBackup,
  // tags
  getTag,
  setTag,
  allTags,
  // export md
  buildAgentMd,
  // utils
  ZipWriter,
  safeName,
  runPool,
};
