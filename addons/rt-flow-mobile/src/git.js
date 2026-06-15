"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// git.js · rt-flow 浏览器版 · Git 连接/PAT 模块 (移植自 rt-flow/devin_git.js)
//
// 纯 fetch · 复用 DaoCloud.jsonRequest/authHeaders。手机端可做的 Git 操作:
//   · 状态快照 (gitStatus)        — 只读: 已绑身份 / 连接数 / PAT 密钥 / 可达仓库
//   · PAT 注入并连接 (connectWithPat) — 写: 注 PAT → 落 GITHUB_PAT 密钥 → 轮询仓库落库
//   · 健壮断开 (robustDisconnectGit) — 写: 断净 name+host / PAT 连接 / OAuth 身份
//   · 批量归一 (batchConnectPat)   — 对多账号套用同一 PAT (留 space 给各账号覆盖)
// 桌面专属 (~/.dao/git-pats.json 池文件) 不移植 —— PAT 由 UI 输入。
// ═══════════════════════════════════════════════════════════════════════════

const DaoGit = (() => {
  const cloud = (typeof self !== "undefined" && self.DaoCloud) || (typeof globalThis !== "undefined" && globalThis.DaoCloud);
  const API = cloud.CFG.apiBase;
  const GH_API = "https://api.github.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bare = (auth) => auth.orgBare || String(auth.orgId || "").replace(/^org-/, "");
  const authHeaders = (auth, extra) => Object.assign(cloud.authHeaders(auth), extra || {});

  const jGet = (auth, url, t) => cloud.jsonRequest("GET", url, authHeaders(auth), null, t);
  const jPost = (auth, url, body, t) => cloud.jsonRequest("POST", url, authHeaders(auth), body || {}, t);
  const jDelete = (auth, url, t) => cloud.jsonRequest("DELETE", url, authHeaders(auth), null, t);

  // 已注册态归一判据 (纯函数·可单测): 由 PAT 主身份 / 现有连接 / 是否有仓库 决定动作。
  function classifyRegisteredState({ ownerLogin, connections, hasRepos } = {}) {
    const list = connections || [];
    if (!list.length) return "ghost"; // 已注册却无连接 → 平台孤儿态
    const first = list[0] || {};
    const type = String(first.type || "").toLowerCase();
    if (type.indexOf("app") >= 0 && type.indexOf("individual_token") < 0) return "app"; // OAuth App: 不主动断
    const name = String(first.name || first.installation_name || "").toLowerCase();
    if (ownerLogin && name && name.indexOf(String(ownerLogin).toLowerCase()) >= 0 && hasRepos) return "existing";
    return "reinject"; // individual_token: 连到别身份 / 0 仓库陈旧 → 断净重注
  }

  // ─── 读 ───────────────────────────────────────────────────────────────────
  async function checkGitConnections(auth) {
    const r = await jGet(auth, API + "/organizations/" + auth.orgId + "/git-connections-metadata");
    if (r.status === 200 && r.json) {
      const conns = Array.isArray(r.json) ? r.json : r.json.git_connections || r.json.connections || [];
      return { ok: true, connections: conns, count: conns.length };
    }
    return { ok: false, connections: [], count: 0, error: (r.text || "").slice(0, 120) };
  }
  async function getGitHubUser(auth) {
    const r = await jGet(auth, API + "/integrations/github/user");
    if (r.status === 200 && r.json) {
      const d = r.json;
      const login = d.login || d.username || d.user || (d.user && d.user.login) || "";
      return { ok: true, login, data: d };
    }
    return { ok: false, login: "", data: null };
  }
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

  // ─── 密钥 GITHUB_PAT (写后双读确认落库) ─────────────────────────────────────
  async function listSecrets(auth) {
    const r = await jGet(auth, API + "/org-" + bare(auth) + "/secrets");
    if (r.status !== 200 || !r.json) return [];
    return Array.isArray(r.json) ? r.json : r.json.secrets || [];
  }
  async function hasGithubPatSecret(auth) {
    return !!(await listSecrets(auth)).find((s) => s.key === "GITHUB_PAT" || s.name === "GITHUB_PAT");
  }
  async function injectSecret(auth, name, value) {
    const r = await jPost(auth, API + "/org-" + bare(auth) + "/secrets", { key: name, value, type: "key-value", sensitive: true, note: name });
    if (r.status === 200 || r.status === 201 || r.status === 409) return { ok: true, existed: r.status === 409 };
    return { ok: false, error: (r.text || "").slice(0, 120) };
  }
  async function ensureGithubPatSecret(auth, pat) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await injectSecret(auth, "GITHUB_PAT", pat); } catch (e) {}
      await sleep(1200);
      try { if (await hasGithubPatSecret(auth)) { await sleep(600); if (await hasGithubPatSecret(auth)) return true; } } catch (e) {}
      await sleep(800);
    }
    return false;
  }
  async function deleteSecret(auth, name) {
    const hit = (await listSecrets(auth)).find((s) => s.key === name || s.name === name);
    if (!hit) return { ok: true, missing: true };
    const sid = hit.id || hit.secret_id;
    if (!sid) return { ok: false, error: "no_secret_id" };
    const r = await jDelete(auth, API + "/secrets/" + encodeURIComponent(sid));
    if (r.status === 200 || r.status === 204 || r.status === 404) return { ok: true };
    return { ok: false, error: "status=" + r.status };
  }

  // ─── PAT 注入 / OAuth ───────────────────────────────────────────────────────
  async function injectGitHubPAT(auth, pat) {
    const url = API + "/" + auth.orgId + "/integrations/github/pat";
    let r;
    try { r = await jPost(auth, url, { pat }, 60000); }
    catch (e) { return { ok: false, error: (e && e.message) || "post err" }; }
    if (r.status === 200 || r.status === 201) return { ok: true, via: url };
    const t = (r.text || "").toLowerCase();
    if (r.status === 400 && t.includes("already registered")) return { ok: false, alreadyRegistered: true, error: "该组织已注册 GitHub 集成" };
    if ((r.status === 400 || r.status === 401 || r.status === 403) && /(invalid|bad credentials|unauthorized|forbidden|expired|permission|scope)/.test(t))
      return { ok: false, invalidPat: true, error: "PAT 无效/过期/权限不足 (需 repo 权限): " + (r.text || "").slice(0, 120) };
    return { ok: false, error: (r.text || "").slice(0, 160) || "status=" + r.status };
  }
  const _patOwnerCache = {};
  async function _patOwnerLogin(pat) {
    if (pat in _patOwnerCache) return _patOwnerCache[pat];
    let login = "";
    try {
      const r = await cloud.jsonRequest("GET", GH_API + "/user", { Authorization: "Bearer " + pat, "User-Agent": "rt-flow-git", Accept: "application/vnd.github+json" }, null, 20000);
      if (r.status === 200 && r.json) login = r.json.login || "";
    } catch (e) {}
    _patOwnerCache[pat] = login;
    return login;
  }
  async function _disconnectAllConnections(auth) {
    const gc = await checkGitConnections(auth);
    for (const c of gc.connections || []) {
      const cid = c.id || c.git_connection_id || c.connection_id;
      try { await disconnectGitHubConnection(auth, c.name || c.installation_name || "github", c.host || "github.com"); } catch (e) {}
      if (cid) { try { await disconnectGitHubPAT(auth, cid); } catch (e) {} }
    }
    return (gc.connections || []).length;
  }

  // ─── 断开族 ───────────────────────────────────────────────────────────────
  async function disconnectGitHubConnection(auth, connectionName, host) {
    const q = "?name=" + encodeURIComponent(connectionName || "github") + "&host=" + encodeURIComponent(host || "github.com");
    let r = await jDelete(auth, API + "/org-" + bare(auth) + "/integrations/github" + q);
    if (r.status === 200 || r.status === 204) return { ok: true };
    if (r.status === 404) {
      r = await jDelete(auth, API + "/" + auth.orgId + "/integrations/github" + q);
      if (r.status === 200 || r.status === 204) return { ok: true };
    }
    return { ok: false, status: r.status, error: (r.text || "").slice(0, 200) };
  }
  async function disconnectGitHubUser(auth) {
    const eps = [
      API + "/integrations/github/user", API + "/integrations/github",
      API + "/org-" + bare(auth) + "/integrations/github/user", API + "/org-" + bare(auth) + "/integrations/github",
      API + "/" + auth.orgId + "/integrations/github/user", API + "/" + auth.orgId + "/integrations/github",
    ];
    let any = false, lastStatus = 0, lastErr = "";
    for (const url of eps) {
      let r;
      try { r = await jDelete(auth, url); } catch (e) { lastErr = (e && e.message) || "del err"; continue; }
      lastStatus = r.status;
      if (r.status === 200 || r.status === 204) { any = true; continue; }
      if (r.status !== 404 && r.status !== 405) lastErr = (r.text || "").slice(0, 160) || "status=" + r.status;
    }
    return any ? { ok: true } : { ok: false, status: lastStatus, error: lastErr };
  }
  async function disconnectGitHubPAT(auth, connectionId) {
    const r = await jDelete(auth, API + "/" + auth.orgId + "/integrations/github/pat?connection_id=" + connectionId);
    if (r.status === 200 || r.status === 204) return { ok: true };
    return { ok: false, status: r.status, error: (r.text || "").slice(0, 200) };
  }
  async function robustDisconnectGit(auth) {
    const logs = [];
    const gc = await checkGitConnections(auth);
    if (gc.ok && gc.count > 0) {
      for (let i = 0; i < gc.connections.length; i++) {
        const c = gc.connections[i];
        const cId = c.id || c.git_connection_id || c.connection_id || null;
        logs.push("连接[" + i + "]: " + (c.name || c.installation_name || "github") + " @ " + (c.host || "github.com") + " type=" + (c.type || "?"));
        const disR = await disconnectGitHubConnection(auth, c.name || c.installation_name || "github", c.host || "github.com");
        logs.push("断开name+host: " + (disR.ok ? "OK" : "FAIL"));
        if (cId) { const p = await disconnectGitHubPAT(auth, cId); logs.push("断开PAT连接: " + (p.ok ? "OK" : "SKIP")); }
      }
    } else {
      logs.push("当前无Git连接, 尝试通用断开");
      await disconnectGitHubConnection(auth, "github", "github.com");
    }
    try { await disconnectGitHubUser(auth); } catch (e) {}
    await sleep(1200);
    const after = await checkGitConnections(auth);
    return { ok: (after.count || 0) === 0, remaining: after.count || 0, logs };
  }

  // ─── PAT 连接 (注入→落密钥→轮询仓库落库) ───────────────────────────────────
  async function connectWithPat(auth, pat) {
    if (!pat) return { ok: false, error: "无 PAT (请在输入框粘贴 ghp_…)" };
    let inj = await injectGitHubPAT(auth, pat);
    let ghost = false, appConn = null;
    if (inj.alreadyRegistered) {
      const owner = await _patOwnerLogin(pat);
      const conns0 = await checkGitConnections(auth).catch(() => ({ connections: [] }));
      const repos0 = await getAccessibleRepos(auth).catch(() => ({ repos: [] }));
      const list0 = conns0.connections || [];
      const action = classifyRegisteredState({ ownerLogin: owner, connections: list0, hasRepos: (repos0.repos || []).length > 0 });
      if (action === "existing") inj = { ok: true, via: "existing" };
      else if (action === "ghost") ghost = true;
      else if (action === "reinject") {
        await _disconnectAllConnections(auth);
        try { await disconnectGitHubUser(auth); } catch (e) {}
        await sleep(1500);
        inj = await injectGitHubPAT(auth, pat);
      } else {
        const first = list0[0] || {};
        appConn = { name: first.name || "?", type: first.type || "github_app", repos: (repos0.repos || []).length };
        inj = { ok: false, appConn: true, error: "该账号经 GitHub App 连到 @" + appConn.name + "。App 连接断开后无法再用 PAT 重连(平台限制)。如需归一请在 app.devin.ai 该组织 Settings→Integrations 手动移除 App 后再连。" };
      }
    }
    const secOk = await ensureGithubPatSecret(auth, pat);
    let user = { login: "" }, repos = { repos: [] }, conns = { count: 0 };
    for (let i = 0; i < 6; i++) {
      await sleep(i === 0 ? 800 : 2200);
      [user, repos, conns] = await Promise.all([
        getGitHubUser(auth).catch(() => ({ ok: false, login: "" })),
        getAccessibleRepos(auth).catch(() => ({ ok: false, repos: [] })),
        checkGitConnections(auth).catch(() => ({ ok: false, count: 0 })),
      ]);
      if ((repos.repos || []).length > 0) break;
    }
    const repoCount = (repos.repos || []).length;
    const connCount = conns.count || 0;
    const connName = (conns.connections || [])[0] || {};
    const login = user.login || connName.name || connName.installation_name || "";
    const ok = repoCount > 0 || connCount > 0 || inj.ok;
    return {
      ok, login, repoCount, repos: (repos.repos || []).slice(0, 50), connections: connCount, secret: secOk,
      alreadyRegistered: !!inj.alreadyRegistered, invalidPat: !!inj.invalidPat, ghost, appConn: appConn || null,
      error: ok ? "" : (ghost ? "平台侧孤儿注册(已注册但无连接·API 不可清) — 需在 app.devin.ai 手动移除 GitHub 后重连" : (inj.error || "连接未生效(0 连接·0 仓库)")),
    };
  }

  // gitStatus: 当前账号 Git 绑定快照 (只读)
  async function gitStatus(auth) {
    const [user, conns, secret, repos] = await Promise.all([
      getGitHubUser(auth).catch(() => ({ ok: false, login: "" })),
      checkGitConnections(auth).catch(() => ({ ok: false, count: 0, connections: [] })),
      hasGithubPatSecret(auth).catch(() => false),
      getAccessibleRepos(auth).catch(() => ({ ok: false, repos: [] })),
    ]);
    const connNames = (conns.connections || []).map((c) => c.name || c.installation_name || c.type || "github");
    return { login: user.login || connNames[0] || "", connections: conns.count || 0, connNames, secret: !!secret, repoCount: (repos.repos || []).length };
  }

  return {
    classifyRegisteredState, checkGitConnections, getGitHubUser, getAccessibleRepos,
    listSecrets, hasGithubPatSecret, injectSecret, ensureGithubPatSecret, deleteSecret,
    injectGitHubPAT, disconnectGitHubConnection, disconnectGitHubUser, disconnectGitHubPAT,
    robustDisconnectGit, connectWithPat, gitStatus,
  };
})();

if (typeof self !== "undefined") self.DaoGit = DaoGit;
if (typeof globalThis !== "undefined") globalThis.DaoGit = DaoGit;
