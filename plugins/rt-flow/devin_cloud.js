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
  // 续写消息走官方公开 API (app.devin.ai/api 无此 REST 路由; 实测全部 404)。
  // 实测: api.devin.ai/v1/session/{id}/message 返回 403 (路由存在·凭证不符),
  // 其余 /v1/sessions/{id}/messages 返回 404 → 确证正确端点为单数 /session/{id}/message。
  v1Base: "https://api.devin.ai/v1",
  apiKey: "", // Devin 官方 API Key (apk_...); 续写消息所需, 会话登录态 auth1 不被公开 API 接受。
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rt-flow-devin-cloud",
  authTtlMs: 12 * 60 * 60 * 1000, // 登录态缓存 12h
  reqTimeoutMs: 30000,
  streamTimeoutMs: 180000,
  maxRetries: 3, // 瞬态网络错误(TLS socket 断/ECONNRESET/超时)自动重试次数 (弱者道之用·反复至成)
  retryBaseMs: 500, // 重试退避基数 (指数: 500/1000/2000ms)
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

// 瞬态错误判定: TLS 握手前 socket 断开 / 连接重置 / 超时 / DNS 抖动 等可重试
function _isTransientErr(e) {
  const m = String((e && (e.message || e.code)) || e || "").toLowerCase();
  return (
    m.includes("socket disconnected") || // "Client network socket disconnected before secure TLS connection was established"
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("timeout") ||
    m.includes("eai_again") ||
    m.includes("enotfound") ||
    m.includes("epipe") ||
    m.includes("ehostunreach") ||
    m.includes("enetunreach") ||
    m.includes("socket hang up") ||
    m.includes("tls")
  );
}
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
// 善行无辙迹: 瞬态网络错误指数退避重试, 一次性彻底错误(bad_url 等)立即上抛。
async function rawRequest(method, targetUrl, headers, body, timeoutMs) {
  const max = Math.max(0, CFG.maxRetries | 0);
  let lastErr;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await _rawRequestOnce(method, targetUrl, headers, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt >= max || !_isTransientErr(e)) break;
      await _sleep(CFG.retryBaseMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}
function _rawRequestOnce(method, targetUrl, headers, body, timeoutMs) {
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
  // app.devin.ai 内部 API 的 /sessions 校验字段为 user_message (非 prompt);
  // 两个都带上以兼容内部/公开两套契约 (实跑 422 揭示: body.user_message required)。
  const payload = { user_message: String(prompt || ""), prompt: String(prompt || "") };
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
// 端点经实测确证为官方公开 API: POST {v1Base}/session/{id}/message  {message}
//   - app.devin.ai/api 下所有形态 (/session|/sessions ·/message|/messages) 实测均 404, 即内部 API 无此 REST 路由。
//   - api.devin.ai/v1/sessions/{id}/messages 实测 404 (无此路由); /session/{id}/message 实测 403 (路由存在·凭证不符) → 端点正确。
//   - 鉴权: 公开 API 仅认 Devin API Key (apk_...); 会话登录态 auth1 / cog_ service-user 均被拒 (403)。
//     故 opts.apiKey || CFG.apiKey 缺省时不臆造成功, 直接回报需配置 API Key。
async function sendMessage(auth, devinId, message, opts) {
  opts = opts || {};
  const apiKey = opts.apiKey || CFG.apiKey || "";
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      error: "续写消息需配置 Devin API Key (apk_...); 会话登录态不被公开 API 接受。请在设置 devinCloudApiKey 或 opts.apiKey 后重试。",
    };
  }
  const r = await jsonRequest(
    "POST",
    CFG.v1Base + "/session/" + devinId + "/message",
    { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", "User-Agent": CFG.ua },
    { message: String(message || "") },
  );
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    raw: r.json,
    text: (r.text || "").slice(0, 200),
    error: r.status >= 200 && r.status < 300 ? undefined : "sendMessage HTTP " + r.status + ": " + (r.text || "").slice(0, 160),
  };
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
  // 大成若缺: 任一子端点瞬态失败不应毁整份概览。allSettled 逐个降级,
  // rejected 项返回空结果(同各 list 的 ok:false 形态), 只要有一个成功即有概览。
  const settled = await Promise.allSettled([
    listSessions(auth),
    listKnowledge(auth),
    listPlaybooks(auth),
    listSecrets(auth),
    getGitConnections(auth),
    getBilling(auth),
  ]);
  const v = (i, fallback) => (settled[i].status === "fulfilled" ? settled[i].value : fallback);
  const sessions = v(0, { sessions: [] });
  const knowledge = v(1, { learnings: [] });
  const playbooks = v(2, { playbooks: [] });
  const secrets = v(3, { secrets: [] });
  const git = v(4, { connections: [] });
  const billing = v(5, { billing: null });
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
    playbooks: (playbooks.playbooks || []).map((p) => ({ id: p.id || p.playbook_id, name: p.name || p.title || "" })),
    secrets: (secrets.secrets || []).map((s) => ({ id: s.id || s.secret_id, name: s.name || s.key || "" })),
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
  // 实跑确证: 正确端点为 DELETE /api/playbooks/{id} (返 200·真删)。
  // 旧端点 /api/org-{bare}/playbooks/{id} 恒返 404, 被 okDelete 误判为"已删"→ 臆造成功。
  let r = await jsonRequest("DELETE", CFG.apiBase + "/playbooks/" + id, authHeaders(auth));
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
  // 兜底: 旧 org 作用域端点 (唯变所适)
  const r2 = await jsonRequest("DELETE", CFG.apiBase + "/org-" + auth.orgBare + "/playbooks/" + id, authHeaders(auth));
  if (r2.status >= 200 && r2.status < 300) return { ok: true, status: r2.status };
  // 两端点均 404 视为"已不存在"(幂等)
  if (r.status === 404 && r2.status === 404) return { ok: true, status: 404 };
  return { ok: false, status: r.status };
}
async function deleteSecret(auth, idOrName) {
  let id = idOrName;
  if (!/^[a-z]+-/.test(String(idOrName))) {
    const list = await listSecrets(auth);
    const hit = (list.secrets || []).find((s) => s.name === idOrName || s.id === idOrName);
    if (!hit) return { ok: true, status: 404 };
    id = hit.id;
  }
  // 实跑确证: 正确端点为 DELETE /api/secrets/{id} (返 200·真删)。
  // 旧端点 /api/org-{bare}/secrets/{id} 恒返 404, 被 okDelete 误判为"已删"→ 臆造成功。
  let r = await jsonRequest("DELETE", CFG.apiBase + "/secrets/" + id, authHeaders(auth));
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
  const r2 = await jsonRequest("DELETE", CFG.apiBase + "/org-" + auth.orgBare + "/secrets/" + id, authHeaders(auth));
  if (r2.status >= 200 && r2.status < 300) return { ok: true, status: r2.status };
  if (r.status === 404 && r2.status === 404) return { ok: true, status: 404 };
  return { ok: false, status: r.status };
}
// 某连接的仓库授权(git-permissions)列举/删除 —— 端点取自前端 useQuery bundle 实证。
async function listGitPermissions(auth, connectionId) {
  const r = await jsonRequest("GET", CFG.apiBase + "/" + auth.orgId + "/integrations/git-permissions?connection_id=" + encodeURIComponent(connectionId), authHeaders(auth));
  return r.status === 200 ? asArray(r.json, "data", "permissions") : [];
}
async function deleteGitPermission(auth, permId) {
  const r = await jsonRequest("DELETE", CFG.apiBase + "/" + auth.orgId + "/integrations/git-permissions/" + permId, authHeaders(auth));
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}
// 实跑确证(前端 bundle 逐函数审 + 真号 lhfsrb 验证): Devin 无"按 id 删 git 连接"端点。
//   旧码三个 /git-connections/{id} 形态恒 404/405 → 实为臆造(根本啥也没删, 却记成功)。
//   真实可用端点(取自前端 useQuery-*.js):
//     · 列仓库授权: GET    /{orgId}/integrations/git-permissions?connection_id={cid}
//     · 删仓库授权: DELETE /{orgId}/integrations/git-permissions/{permId}  (返 {success:true}·真删)
//     · OAuth 断开: DELETE /integrations/github/user · /integrations/gitlab/user
//   但连接"元数据记录"本身平台不提供删除端点(PAT 与 github_app 均复查仍在)。
//   故能做且该做的: 真删其全部仓库授权(实移除访问权), 复查连接元数据是否消失:
//     消失→真断开(removed); 残留(PAT 典型)→如实回报已清授权数, 不臆造成功。
async function disconnectGit(auth, conn) {
  const cid = (conn && (conn.id || conn.connection_id)) || conn;
  const type = String((conn && (conn.type || conn.provider)) || "").toLowerCase();
  const host = String((conn && conn.host) || "").toLowerCase();
  // 1) 清空该连接全部仓库授权 (真实移除访问权)
  let permsRemoved = 0;
  try {
    const perms = await listGitPermissions(auth, cid);
    for (const p of perms) {
      const pid = p.git_permission_id || p.id;
      if (!pid) continue;
      if ((await deleteGitPermission(auth, pid)).ok) permsRemoved++;
    }
  } catch (_) { /* 授权列举失败不阻断后续 */ }
  // 2) provider 级断开 (OAuth 类真断开; PAT 类幂等无害)
  let provStatus = 0;
  const provUrl = (type.indexOf("gitlab") >= 0 || host.indexOf("gitlab") >= 0)
    ? CFG.apiBase + "/integrations/gitlab/user"
    : CFG.apiBase + "/integrations/github/user";
  try { provStatus = (await jsonRequest("DELETE", provUrl, authHeaders(auth))).status; } catch (_) {}
  // 3) 复查连接元数据是否真消失 (不臆造)
  let gone = false;
  try {
    const after = (await getGitConnections(auth)).connections || [];
    gone = !after.some((c2) => (c2.id || c2.connection_id) === cid);
  } catch (_) {}
  if (gone) return { ok: true, status: 200, removed: true, permissionsRemoved: permsRemoved };
  return {
    ok: false,
    status: provStatus || 0,
    removed: false,
    permissionsRemoved: permsRemoved,
    note: "连接(" + (type || "unknown") + ")元数据平台未开放删除端点; 已清除其仓库授权 " + permsRemoved + " 条(访问权已撤)" + (type.indexOf("individual_token") >= 0 ? "; PAT 本体须在 GitHub 端撤销" : ""),
  };
}
// 清理会话: 实跑确证 Devin 平台不支持硬删除对话
//   (OPTIONS /api/sessions/{id} → Allow: GET; DELETE → 405)。
//   平台支持的"移出仪表盘"机制是归档: POST /api/sessions/{id}/archive (返 200)。
//   对话正文已在清空前本地留底, 故归档即"水过无痕"。archived:true 如实标注。
async function deleteSession(auth, devinId) {
  const r = await jsonRequest("POST", CFG.apiBase + "/sessions/" + devinId + "/archive", authHeaders(auth), {});
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, archived: true };
  // 兜底: 旧硬删除端点形态 (平台若日后开放硬删除则命中)
  const candidates = [
    CFG.apiBase + "/sessions/" + devinId,
    CFG.apiBase + "/org-" + auth.orgBare + "/sessions/" + devinId,
  ];
  let last = r.status;
  for (const url of candidates) {
    const d = await jsonRequest("DELETE", url, authHeaders(auth));
    last = d.status;
    if (d.status >= 200 && d.status < 300) return { ok: true, status: d.status };
  }
  return { ok: false, status: last };
}

// 区分"用户自有数据" vs "Devin 本源默认"(社区剧本 / 内置知识)。
// 实跑确证: 新账号本源自带 3 条 builtin 知识(note_type=builtin·can_write=false·删返 403)
//   + 32 个 community 剧本(access=community·org_id=Cognition clerk-org·删返 404)。
// 这些本源默认删不掉, 也不该删 —— "回归本源"即保留它们。只清用户自建数据。
function isUserKnowledge(k) {
  return !!k && k.note_type !== "builtin" && k.is_default_note !== true && k.can_write !== false;
}
function isUserPlaybook(p, auth) {
  if (!p) return false;
  if (p.access === "community") return false; // Cognition 社区共享剧本
  if (p.org_id && auth && auth.orgId && p.org_id !== auth.orgId) return false; // 非本组织
  return true;
}

// 水过无痕: 删除某账号在 Devin Cloud 的全部"用户自建"使用痕迹 → 回到本源(默认)态。
// dryRun=true 只统计不删除 (先把所有东西找出来) · onProgress(msg) 实时回报。
// found 仅计可删的用户数据; 本源默认(社区剧本/内置知识)记入 native.* 不删不臆造。
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
    gitConnections: { found: 0, deleted: 0, failed: 0, permissionsRemoved: 0 },
    native: { knowledge: 0, playbooks: 0 }, // 本源默认(保留·不删)
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
  const allLearnings = kn.learnings || [];
  const allPlaybooks = pb.playbooks || [];
  const secrets = sec.secrets || [];
  const conns = git.connections || [];
  // 仅清用户自建; 本源默认单独计数保留
  const learnings = allLearnings.filter(isUserKnowledge);
  const playbooks = allPlaybooks.filter((p) => isUserPlaybook(p, auth));
  report.native.knowledge = allLearnings.length - learnings.length;
  report.native.playbooks = allPlaybooks.length - playbooks.length;
  report.sessions.found = sessions.length;
  report.knowledge.found = learnings.length;
  report.playbooks.found = playbooks.length;
  report.secrets.found = secrets.length;
  report.gitConnections.found = conns.length;

  if (dry) {
    prog(
      "扫描完成(可清理): 对话" + sessions.length + " 知识库" + learnings.length +
      " 剧本" + playbooks.length + " 密钥" + secrets.length + " Git" + conns.length +
      " · 本源默认保留: 知识" + report.native.knowledge + " 剧本" + report.native.playbooks,
    );
    return report;
  }

  // 删除顺序: git连接 → 密钥 → 剧本 → 知识库 → 对话 (先外围后核心)
  for (const c of conns) {
    const id = c.id || c.connection_id;
    if (!id) { report.gitConnections.failed++; continue; }
    const r = await disconnectGit(auth, c);
    report.gitConnections.permissionsRemoved += r.permissionsRemoved || 0;
    if (r.ok) report.gitConnections.deleted++;
    else { report.gitConnections.failed++; report.errors.push("git:" + id + ":" + (r.note || r.status)); }
    prog("断开 Git 连接 " + report.gitConnections.deleted + "/" + conns.length + (r.permissionsRemoved ? "(清授权" + r.permissionsRemoved + ")" : ""));
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

// ═══ 账号数据全量快照 (知识库/剧本/密钥/Git/额度/会话清单) ════════════════════
// 对话正文走 backupAccount 的 ZIP; 此处补齐"各方面的数据" —— 知识库正文、剧本正文、
// 密钥元数据(含加密值·不解密)、Git 连接、额度、会话清单 —— 全部留底本地。
// 供「水过无痕」前一键留底, 使账号可在清空后仍可回溯。
// 写入: <root>/<账号名>/_账号快照_<YYYYMMDDHHmmss>/
function _snapStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
async function snapshotAccountData(auth, opts) {
  opts = opts || {};
  const root = opts.targetDir || DC_BACKUP_DEFAULT;
  const prog = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const accountDir = path.join(root, safeName(auth.email, 80));
  const snapDir = path.join(accountDir, "_账号快照_" + _snapStamp());
  ensureDir(snapDir);

  prog("快照: 拉取账号数据…");
  // 单条失败不毁全局: 每条带重试·失败如实记录, 有几条存几条 (allSettled 语义·不臆造)。
  // 旧码用 Promise.all → 任一端点瞬时失败(批量并发 429/抖动)即抛错, 整份快照丢失留下空目录。
  const snapErrors = [];
  const _settle = async (label, fn) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (attempt === 2) { snapErrors.push(label + ": " + String((e && e.message) || e)); return null; }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    return null;
  };
  const [kn, pb, sec, git, billing, sess] = await Promise.all([
    _settle("知识库", () => listKnowledge(auth)),
    _settle("剧本", () => listPlaybooks(auth)),
    _settle("密钥", () => listSecrets(auth)),
    _settle("Git连接", () => getGitConnections(auth)),
    _settle("额度", () => getBilling(auth)),
    _settle("会话清单", () => listSessions(auth, 1000)),
  ]);
  const learnings = (kn && kn.learnings) || [];
  const playbooks = (pb && pb.playbooks) || [];
  const secrets = (sec && sec.secrets) || [];
  const conns = (git && git.connections) || [];
  const sessions = (sess && sess.sessions) || [];
  const billingObj = (billing && billing.billing) || {};

  // 知识库: 每条一份正文 MD + 汇总 index (机器可读)
  if (learnings.length) {
    const knDir = path.join(snapDir, "知识库");
    ensureDir(knDir);
    learnings.forEach((k, i) => {
      const nm = safeName(k.name || k.title || "note", 60);
      const md = [
        "# " + (k.name || k.title || "(未命名)"),
        "",
        "- id: " + (k.id || ""),
        "- 触发: " + (k.trigger_description || ""),
        "- 类型: " + (k.note_type || ""),
        "- 创建: " + (k.created_at || ""),
        "",
        "---",
        "",
        String(k.body || ""),
      ].join("\n");
      try { fs.writeFileSync(path.join(knDir, (i + 1) + "_" + nm + ".md"), md); } catch {}
    });
  }
  writeJson(path.join(snapDir, "知识库_index.json"), learnings);

  // 剧本: 每条一份正文 MD (含 examples) + 汇总 index
  if (playbooks.length) {
    const pbDir = path.join(snapDir, "剧本");
    ensureDir(pbDir);
    playbooks.forEach((p, i) => {
      const nm = safeName(p.title || "playbook", 60);
      const md = [
        "# " + (p.title || "(未命名)"),
        "",
        "- id: " + (p.id || ""),
        "- 状态: " + (p.status || ""),
        "- 更新: " + (p.updated_at || ""),
        "",
        "---",
        "",
        String(p.body || ""),
        Array.isArray(p.examples) && p.examples.length
          ? "\n\n## examples\n\n```json\n" + JSON.stringify(p.examples, null, 2) + "\n```"
          : "",
      ].join("\n");
      try { fs.writeFileSync(path.join(pbDir, (i + 1) + "_" + nm + ".md"), md); } catch {}
    });
  }
  writeJson(path.join(snapDir, "剧本_index.json"), playbooks);

  // 密钥(含加密值/元数据·不解密) · Git 连接 · 会话清单 · 额度
  writeJson(path.join(snapDir, "密钥.json"), secrets);
  writeJson(path.join(snapDir, "git连接.json"), conns);
  writeJson(path.join(snapDir, "会话清单.json"), sessions);
  writeJson(path.join(snapDir, "额度.json"), billingObj);

  const counts = {
    sessions: sessions.length,
    knowledge: learnings.length,
    playbooks: playbooks.length,
    secrets: secrets.length,
    gitConnections: conns.length,
  };
  const partial = snapErrors.length > 0;
  writeJson(path.join(snapDir, "_manifest.json"), {
    schema: "rt-flow.devin-cloud.account-snapshot/1",
    account: auth.email,
    orgId: auth.orgId,
    snapshotAt: new Date().toISOString(),
    counts,
    billing: billingObj,
    partial,
    errors: snapErrors,
  });
  const summaryMd = [
    "# 账号本源快照 · " + auth.email,
    "",
    "- 快照时间: " + new Date().toISOString(),
    "- orgId: " + auth.orgId,
    "",
    "## 数据统计",
    "",
    "| 类别 | 数量 |",
    "|------|------|",
    "| 对话 | " + counts.sessions + " |",
    "| 知识库 | " + counts.knowledge + " |",
    "| 剧本 | " + counts.playbooks + " |",
    "| 密钥 | " + counts.secrets + " |",
    "| Git 连接 | " + counts.gitConnections + " |",
    "",
    partial ? "> ⚠ 部分留底: 以下条目拉取失败(已记录, 其余如实留底):\n>\n" + snapErrors.map((e) => ">  - " + e).join("\n") + "\n" : "",
    "> 对话正文 ZIP 见同级目录 `<ID末8位>_<标题>.zip`; 知识库/剧本正文见本快照 `知识库/` `剧本/` 子目录。",
  ].join("\n");
  try { fs.writeFileSync(path.join(snapDir, "账号快照.md"), summaryMd); } catch {}

  prog("快照" + (partial ? "(部分)" : "完成") + ": 知识" + counts.knowledge + " 剧本" + counts.playbooks + " 密钥" + counts.secrets + " Git" + counts.gitConnections);
  return { ok: true, account: auth.email, dir: snapDir, counts, partial, errors: snapErrors };
}

// 完整本源备份 = 会话 ZIP(增量) + 账号数据全量快照. 供「备份并清空」一步到位。
async function backupAccountFull(auth, opts) {
  opts = opts || {};
  // 对话备份失败(瞬时抖动/超时)不应连累数据快照 —— 两段相互独立, 各自尽力留底。
  let conversations = null, convError = null;
  try { conversations = await backupAccount(auth, opts); }
  catch (e) { convError = String((e && e.message) || e); }
  const snapshot = await snapshotAccountData(auth, opts);
  return { ok: true, account: auth.email, conversations, convError, snapshot };
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
  L.push("## 3. 水过无痕 (一键清理 → 账号回到本源默认态)");
  L.push("先列出再逐个删除 (顺序: Git→密钥→剧本→知识库→对话)。只清用户自建; 本源默认(社区剧本/内置知识)删不掉也不删:");
  L.push("- 密钥: `DELETE /api/secrets/{secretId}` (实跑确证·返 200; 旧 `/api/org-{bare}/secrets/{id}` 恒 404)");
  L.push("- 剧本: `DELETE /api/playbooks/{playbookId}` (实跑确证·返 200; 旧 `/api/org-{bare}/playbooks/{id}` 恒 404)");
  L.push("- 知识库: `DELETE /api/org-{bare}/learning/{knowledgeId}` (返 200; builtin 内置知识返 403 不可删)");
  L.push("- 对话: `POST /api/sessions/{devinId}/archive` (平台不支持硬删除·DELETE 返 405; 归档=移出仪表盘)");
  L.push("- Git 连接: 元数据 `GET /api/organizations/{org_id}/git-connections-metadata` 只读(Allow:GET); 断开端点待实测");
  L.push("- 用户/本源区分: 剧本 `org_id===本组织 && access!=='community'`; 知识 `note_type==='user'`");
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
  listGitPermissions,
  deleteGitPermission,
  deleteSession,
  wipeAccount,
  // backup
  backupAccount,
  backupOneConversation,
  snapshotAccountData,
  backupAccountFull,
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
  // 低层传输(供 devin_git 等同源复用 · 统一代理/TLS 重试于一处)
  rawRequest,
  jsonRequest,
  proxyForUrl,
};
