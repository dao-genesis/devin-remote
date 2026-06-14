"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// cloud.js · rt-flow 浏览器版 · Devin Cloud 接入底层 (无 vscode / 无 node 依赖)
//
// 帛书·「执天之行」: 把 rt-flow/devin_cloud.js 的登录链路与额度判定移植到
// 浏览器 service worker 环境 —— 纯 fetch, 可在 Chrome / Kiwi(Android) / Edge 运行。
//
//   email + password
//     → POST windsurf.com/_devin-auth/password/login        ⇒ token (= auth1)
//     → POST app.devin.ai/api/users/post-auth (Bearer auth1) ⇒ org_id / user_id
//   之后所有官网请求带 Authorization: Bearer auth1 + x-cog-org-id: orgId
//   额度: GET app.devin.ai/api/{orgId}/billing/status ⇒ available/overage credits
// ═══════════════════════════════════════════════════════════════════════════

const DaoCloud = (() => {
  const CFG = {
    loginUrl: "https://windsurf.com/_devin-auth/password/login",
    apiBase: "https://app.devin.ai/api",
    authTtlMs: 12 * 60 * 60 * 1000, // 登录态缓存 12h (软耗尽前复用)
    reqTimeoutMs: 30000,
  };

  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms || CFG.reqTimeoutMs);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }

  async function jsonRequest(method, url, headers, body, timeoutMs) {
    const to = withTimeout(timeoutMs);
    try {
      const opts = {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
        signal: to.signal,
      };
      if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
      const resp = await fetch(url, opts);
      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
      return { status: resp.status, json, text };
    } catch (e) {
      return { status: 0, json: null, text: String((e && e.message) || e), error: true };
    } finally {
      to.done();
    }
  }

  // 弱者道之用·反复至成: 瞬态网络错误自动重试 (指数退避)
  async function jsonRequestRetry(method, url, headers, body, timeoutMs, retries) {
    let last = null;
    const n = retries == null ? 2 : retries;
    for (let i = 0; i <= n; i++) {
      last = await jsonRequest(method, url, headers, body, timeoutMs);
      if (last.status !== 0 && last.status !== 429) return last;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
    }
    return last;
  }

  // auth1 是 JWT; userId(user-XXX) 可由 payload.sub/user_id 解出 (post-auth 不一定回传)
  function decodeJwtUserId(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return "";
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64 + "===".slice((b64.length + 3) % 4);
      const json = JSON.parse(decodeURIComponent(escape(atob(pad))));
      const cand = json.user_id || json.userId || json.sub || "";
      return /^user-/.test(cand) ? cand : (cand ? "user-" + String(cand).replace(/^user-/, "") : "");
    } catch { return ""; }
  }

  function authHeaders(auth) {
    return { Authorization: "Bearer " + auth.auth1, "x-cog-org-id": auth.orgId };
  }

  // email+password → auth1 + orgId + userId (五步登录的两步底层换取)
  async function login(email, password) {
    const resp = await jsonRequestRetry("POST", CFG.loginUrl, {}, { email, password });
    if (resp.status !== 200 || !resp.json) {
      return { ok: false, error: "login HTTP " + resp.status + ": " + (resp.text || "").slice(0, 160) };
    }
    const auth1 = resp.json.token || resp.json.access_token;
    if (!auth1) return { ok: false, error: "登录响应无 token" };
    // user_id 的权威真源是 login 响应本体 (auth1 为不透明令牌·非 JWT, post-auth 不回传 user_id)
    const loginUserId = resp.json.user_id || resp.json.userId || "";
    const orgResp = await jsonRequestRetry(
      "POST", CFG.apiBase + "/users/post-auth", { Authorization: "Bearer " + auth1 }, {},
    );
    const od = orgResp.json || {};
    const orgId = od.org_id || od.orgId || "";
    if (!orgId) return { ok: false, error: "post-auth 无 org_id (HTTP " + orgResp.status + ")" };
    const userId = od.user_id || od.userId || loginUserId || decodeJwtUserId(auth1) || "";
    return {
      ok: true,
      auth1, orgId, userId,
      orgBare: orgId.replace(/^org-/, ""),
      orgName: od.org_name || od.orgName || "",
      email,
      ts: Date.now(),
    };
  }

  // 额度: app.devin.ai/api/{orgId}/billing/status
  // balance = available_credits + max(0, overage_credits); 含权威布尔判定
  async function getBilling(auth) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/" + auth.orgId + "/billing/status", authHeaders(auth));
    if (r.status !== 200) return { ok: false, status: r.status, raw: null };
    return { ok: true, raw: r.json || {} };
  }

  function billingBalance(billing) {
    if (!billing) return null;
    const b = billing;
    const num = (...keys) => {
      for (const k of keys) {
        const v = b[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return null;
    };
    const avail = num("available_credits", "availableCredits");
    const overage = num("overage_credits", "overageCredits");
    const dollars = (avail || 0) + Math.max(0, overage || 0);
    if (b.has_subscription_or_credits === true || b.is_subscription_valid === true) {
      return dollars > 0 ? dollars : 9999;
    }
    if (b.has_subscription_or_credits === false) return dollars;
    if (avail !== null || overage !== null) return dollars;
    return null;
  }

  // 轻量校验 auth 是否仍有效 (post-auth 200 即视为可用)
  async function verify(auth) {
    const r = await jsonRequestRetry("POST", CFG.apiBase + "/users/post-auth", { Authorization: "Bearer " + auth.auth1 }, {});
    return r.status === 200;
  }

  // ═══ 对话追踪 / 账号数据查看 (只读 · 移植自 devin_cloud.js) ═══════════════
  function asArray(j, ...keys) {
    if (Array.isArray(j)) return j;
    if (!j || typeof j !== "object") return [];
    for (const k of keys) if (Array.isArray(j[k])) return j[k];
    return [];
  }

  // 会话列表: 主端点 /org-{bare}/v2sessions, 备用 /sessions
  async function listSessions(auth, limit) {
    let url = CFG.apiBase + "/org-" + auth.orgBare + "/v2sessions";
    if (limit) url += "?limit=" + limit;
    let r = await jsonRequestRetry("GET", url, authHeaders(auth), null, 60000);
    if (r.status === 200) {
      const arr = asArray(r.json, "result", "sessions", "data");
      if (arr.length || (r.json && (r.json.result || r.json.sessions))) return { ok: true, sessions: arr };
    }
    r = await jsonRequestRetry("GET", CFG.apiBase + "/sessions", authHeaders(auth), null, 60000);
    if (r.status === 200) return { ok: true, sessions: asArray(r.json, "result", "sessions", "data") };
    return { ok: false, sessions: [], error: "list sessions HTTP " + r.status };
  }

  async function getSessionDetail(auth, devinId) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/sessions/" + devinId, authHeaders(auth));
    return r.status === 200 ? r.json || {} : {};
  }

  // 会话状态五态分类 (与 devin_cloud.js classifySession 逐字一脉):
  //   running / awaiting(需用户输入) / blocked(额度耗尽·出错·卡死) / finished / idle
  function classifySession(s) {
    s = s || {};
    const lsc = s.latest_status_contents || {};
    const enumV = String(lsc.enum || "").toLowerCase();
    const reason = String(lsc.reason || "").toLowerCase();
    const uar = lsc.user_action_required;
    const status = String(s.status || "").toLowerCase();
    const act = String(s.activity_status || "").toLowerCase();
    const cur = String(s.current_activity || "").toLowerCase();
    if (uar != null && uar !== "" && uar !== false) return "awaiting";
    const terminal = enumV === "finished" || /suspended|expired|exited|archived|deleted/.test(status);
    if (terminal) return "finished";
    const blob = enumV + " " + reason + " " + status + " " + act + " " + cur;
    if (/out_of_quota|usage_limit|insufficient|overage|credit|billing|exceeded|quota/.test(blob)) return "blocked";
    if (/error|failed|stuck|crash/.test(blob)) return "blocked";
    if (/await|waiting_for_user|waiting_for_input|needs_input|user_input|ask_user|blocked_on_user/.test(blob)) return "awaiting";
    if (/blocked/.test(blob)) return "blocked";
    if (/running|working|in_progress|streaming|active|started|resumed|busy|thinking|executing|coding|planning|testing|pr\b/.test(blob)) return "running";
    return enumV || status ? "running" : "idle";
  }
  function isActiveClass(cls) { return cls === "running" || cls === "awaiting" || cls === "blocked"; }

  // 活跃·需关注会话 (运行/等待输入/卡住), 各带 statusClass 供前端细分
  async function listRunningSessions(auth) {
    const r = await listSessions(auth, 100);
    return (r.sessions || [])
      .map((s) => {
        const lsc = s.latest_status_contents || {};
        return {
          devinId: s.devin_id || s.session_id || s.id,
          title: s.title || s.name || "(未命名)",
          status: (lsc.enum || s.status || s.activity_status || "") + (lsc.reason ? "(" + lsc.reason + ")" : ""),
          reason: lsc.reason || "",
          statusClass: classifySession(s),
        };
      })
      .filter((s) => isActiveClass(s.statusClass));
  }

  async function listKnowledge(auth) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/org-" + auth.orgBare + "/learning/all", authHeaders(auth));
    return r.status === 200 ? { ok: true, learnings: asArray(r.json, "learnings") } : { ok: false, learnings: [] };
  }
  async function listPlaybooks(auth) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/org-" + auth.orgBare + "/playbooks", authHeaders(auth));
    return r.status === 200 ? { ok: true, playbooks: asArray(r.json, "playbooks") } : { ok: false, playbooks: [] };
  }
  async function listSecrets(auth) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/org-" + auth.orgBare + "/secrets", authHeaders(auth));
    return r.status === 200 ? { ok: true, secrets: asArray(r.json, "secrets") } : { ok: false, secrets: [] };
  }
  async function getGitConnections(auth) {
    const r = await jsonRequestRetry("GET", CFG.apiBase + "/organizations/" + auth.orgId + "/git-connections-metadata", authHeaders(auth));
    if (r.status !== 200) return { ok: false, connections: [] };
    const conns = Array.isArray(r.json) ? r.json : asArray(r.json, "connections");
    return { ok: true, connections: conns };
  }
  function isUserKnowledge(k) {
    return !!k && k.note_type !== "builtin" && k.is_default_note !== true && k.can_write !== false;
  }
  function isUserPlaybook(p) {
    return !!p && p.is_builtin !== true && p.can_write !== false;
  }

  // 账号本源概览 (下拉框用): 对话(着重) + 知识库/剧本/密钥/Git/额度 简要。
  // 大成若缺: 任一子端点失败不毁整份概览 (allSettled 逐个降级)。
  async function accountOverview(auth) {
    const settled = await Promise.allSettled([
      listSessions(auth), listKnowledge(auth), listPlaybooks(auth),
      listSecrets(auth), getGitConnections(auth), getBilling(auth),
    ]);
    const v = (i, fb) => (settled[i].status === "fulfilled" ? settled[i].value : fb);
    const sessions = v(0, { sessions: [] });
    const knowledge = v(1, { learnings: [] });
    const playbooks = v(2, { playbooks: [] });
    const secrets = v(3, { secrets: [] });
    const git = v(4, { connections: [] });
    const billing = v(5, { ok: false, raw: null });
    const ss = sessions.sessions || [];
    return {
      email: auth.email, orgId: auth.orgId,
      sessions: ss.map((s) => ({
        devinId: s.devin_id || s.session_id || s.id,
        title: s.title || s.name || "(未命名)",
        statusClass: classifySession(s),
        createdAt: s.created_at, updatedAt: s.updated_at,
      })),
      counts: {
        sessions: ss.length,
        running: ss.filter((s) => classifySession(s) === "running").length,
        awaiting: ss.filter((s) => classifySession(s) === "awaiting").length,
        blocked: ss.filter((s) => classifySession(s) === "blocked").length,
        knowledge: (knowledge.learnings || []).length,
        playbooks: (playbooks.playbooks || []).length,
        secrets: (secrets.secrets || []).length,
        gitConnections: (git.connections || []).length,
      },
      knowledge: (knowledge.learnings || []).map((k) => ({ id: k.id, name: k.name || k.title || "", deletable: isUserKnowledge(k) })),
      playbooks: (playbooks.playbooks || []).map((p) => ({ id: p.id || p.playbook_id, name: p.name || p.title || "", deletable: isUserPlaybook(p) })),
      secrets: (secrets.secrets || []).map((s) => ({ id: s.id || s.secret_id, name: s.name || s.key || "" })),
      gitConnections: (git.connections || []).map((c) => ({ id: c.id || c.connection_id, name: c.name || c.username || c.account_login || c.org || "", provider: c.provider || c.type || "github" })),
      billing: billing.raw || null,
    };
  }

  return {
    CFG, login, getBilling, billingBalance, authHeaders, verify, decodeJwtUserId,
    asArray, listSessions, getSessionDetail, classifySession, isActiveClass,
    listRunningSessions, listKnowledge, listPlaybooks, listSecrets, getGitConnections,
    isUserKnowledge, isUserPlaybook, accountOverview,
  };
})();

// service worker (importScripts) 与 popup(module-less) 两种加载方式都可取用
if (typeof self !== "undefined") self.DaoCloud = DaoCloud;
if (typeof globalThis !== "undefined") globalThis.DaoCloud = DaoCloud;
