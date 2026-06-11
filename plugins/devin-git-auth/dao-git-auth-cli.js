#!/usr/bin/env node
/**
 * dao-git-auth-cli.js · 反者道之动 · 纯Devin体系CLI
 * ═══════════════════════════════════════════════════════════════
 *
 *   帛书·四十「反者道之动也 · 弱者道之用也」
 *   帛书·四十三「天下之至柔 · 驰骋于天下之致坚 · 无有入于无间」
 *
 *   纯Node.js CLI · 零VSCode依赖 · 直接接入dao-auth.js认证链
 *   三命令: read-status | disconnect-git | connect-git
 *
 *   用法:
 *     node dao-git-auth-cli.js read-status --email a@b.com --password xxx
 *     node dao-git-auth-cli.js disconnect-git --email a@b.com --password xxx
 *     node dao-git-auth-cli.js connect-git --email a@b.com --password xxx --pat ghp_xxx
 *     node dao-git-auth-cli.js connect-git --email a@b.com --password xxx  (用已保存PAT)
 *     node dao-git-auth-cli.js full-auto --email a@b.com --password xxx --pat ghp_xxx
 *
 *   无为而无不为 — 输入凭据，后端自动推进到底
 * ═══════════════════════════════════════════════════════════════
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");

// ═══ 核心依赖 — dao-auth.js 提供认证链和注入API ═══
// 既得其母, 以知其子: 优先同目录(自洽随包), 回退历史路径/环境变量。
var DAO_AUTH_CANDIDATES = [
  process.env.DAO_AUTH_PATH,
  path.join(__dirname, "dao-auth.js"),
  path.join(__dirname, "..", "网页端", "core", "dao-auth.js"),
].filter(Boolean);
var dao = null, _daoErr = "";
for (var _ci = 0; _ci < DAO_AUTH_CANDIDATES.length; _ci++) {
  try { dao = require(DAO_AUTH_CANDIDATES[_ci]); break; }
  catch (e) { _daoErr = e.message; }
}
if (!dao) {
  console.error("✗ 无法加载 dao-auth.js: " + _daoErr);
  console.error("  尝试路径: " + DAO_AUTH_CANDIDATES.join(", "));
  process.exit(1);
}

// ═══ 换登引擎 — engine/runSwitch.js 提供纯API的「断旧→登录→装App移绑」闭环 ═══
// 道法自然·取之尽珠玉: 复刻 Devin 官网「Continue with GitHub」OAuth + GitHub App
// installation-callback 的规范路径。它走的是官网同一条链路, 故天然不撞「already
// registered」后端幽灵态——这正是设备码/PAT 注入路径此前无法突破的根因。
var engine = null, _engErr = "";
try { engine = require(path.join(__dirname, "engine", "runSwitch.js")); }
catch (e) { _engErr = e.message; }

// ═══ 状态持久化 ═══
var STATE_FILE = path.join(os.homedir(), ".devin-git-auth.json");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) {}
  return { accounts: {}, pat: null, meta: { created: new Date().toISOString() } };
}
function saveState(state) {
  if (!state.meta) state.meta = {};
  state.meta.lastRun = new Date().toISOString();
  var safe = JSON.parse(JSON.stringify(state));
  if (safe.accounts) Object.keys(safe.accounts).forEach(function (k) {
    delete safe.accounts[k]._auth1;
    delete safe.accounts[k]._connectionId;
  });
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2), "utf8"); } catch (e) {}
}

// ═══ 参数解析 ═══
function parseArgs() {
  var args = process.argv.slice(2);
  var opts = { command: args[0] || "help" };
  for (var i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      var k = args[i].slice(2);
      var next = args[i + 1];
      if (next && !next.startsWith("--")) { opts[k] = next; i++; }
      else opts[k] = true;
    }
  }
  return opts;
}

// ═══ 工具 ═══
function log(msg, type) {
  var ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  var prefix = type === "ok" ? "✓" : type === "err" ? "✗" : type === "warn" ? "⚠" : "→";
  console.log("[" + ts + "] " + prefix + " " + msg);
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ═══ 设备码自动批准 — 取之尽珠玉 · 经既有 Chrome CDP 自动填码授权 ═══
// 凭证优先级: 显式 --gh-user/--gh-pass/--gh-totp > ~/.dao/github-creds.json 首个账号。
// 若浏览器已登录目标 GitHub, 则无需凭证(多 Devin 归一 Git 时仅首次登录一次)。
function loadGithubCreds(opts) {
  if (opts["gh-user"] && opts["gh-pass"]) {
    return { user: opts["gh-user"], pass: opts["gh-pass"], totp: opts["gh-totp"] || "" };
  }
  try {
    var p = path.join(os.homedir(), ".dao", "github-creds.json");
    var j = JSON.parse(fs.readFileSync(p, "utf8"));
    var arr = Array.isArray(j) ? j : (j.accounts || Object.values(j));
    var a = arr && arr[0];
    if (a) return { user: a.username || a.user || a.login || a.email, pass: a.password || a.pass, totp: a.totp || a.totpSecret || a.otp_secret || "" };
  } catch (e) {}
  return null;
}
function autoApproveDevice(userCode, opts) {
  return new Promise(function (resolve) {
    var cp = require("child_process");
    var approver = path.join(__dirname, "..", "..", "tools", "gh-approve", "approve.js");
    if (!fs.existsSync(approver)) { log("自动批准器缺失: " + approver, "warn"); return resolve(false); }
    var args = [approver, "--code", userCode];
    var cdp = opts.cdp || process.env.DAO_CDP || "http://localhost:29229";
    args.push("--cdp", cdp);
    var creds = loadGithubCreds(opts);
    if (creds) { args.push("--gh-user", creds.user, "--gh-pass", creds.pass); if (creds.totp) args.push("--gh-totp", creds.totp); }
    log("自动批准设备码(CDP " + cdp + ")...");
    var child = cp.spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", function (code) { resolve(code === 0); });
    child.on("error", function (e) { log("批准器异常: " + e.message, "warn"); resolve(false); });
  });
}

// ═══ 认证 — 两步得一 ═══
async function getCredentials(email, password) {
  log("认证: " + email);
  var s1 = await dao.devinLogin(email, password);
  log("Step1 devinLogin OK — userId=" + s1.userId, "ok");
  var s3 = await dao.devinPostAuth(s1.auth1);
  log("Step3 devinPostAuth OK — orgId=" + s3.orgId + " orgName=" + s3.orgName, "ok");
  return { auth1: s1.auth1, orgId: s3.orgId, orgName: s3.orgName };
}

// ═══ 命令1: read-status · 读取状态 ═══
async function cmdReadStatus(opts) {
  var email = opts.email;
  var password = opts.password;
  if (!email || !password) {
    log("需要 --email 和 --password", "err");
    process.exit(1);
  }

  var cred = await getCredentials(email, password);

  // 1. Git连接
  log("查询Git连接...");
  var gc = await dao.checkGitConnections(cred.orgId, cred.auth1);
  if (gc.ok) {
    log("Git连接: " + gc.count + "个", gc.count > 0 ? "ok" : "warn");
    (gc.connections || []).forEach(function (c, i) {
      var t = c.type || "?";
      var label = t === "github_app" ? "App(组织级)" : t === "github_individual_token" ? "PAT(个人)" : "OAuth";
      log("  连接[" + i + "]: " + label + " — " + (c.name || c.installation_name || "-") +
        (c.github_username ? " @" + c.github_username : "") + " host=" + (c.host || "github.com"));
    });
  } else {
    log("Git连接查询失败: " + (gc.error || "").slice(0, 80), "err");
  }

  // 2. Secret
  log("查询Secret...");
  var secR = await dao.listSecrets(cred.orgId, cred.auth1);
  if (secR.ok) {
    var hasPat = (secR.secrets || []).find(function (s) {
      return s.name === "GITHUB_PAT" || s.key === "GITHUB_PAT";
    });
    log("Secret GITHUB_PAT: " + (hasPat ? "✓ 存在" : "✗ 无"), hasPat ? "ok" : "warn");
  } else {
    log("Secret查询失败: " + (secR.error || "").slice(0, 80), "err");
  }

  // 3. 保存状态
  var state = loadState();
  if (!state.accounts) state.accounts = {};
  state.accounts[email] = {
    email: email, orgId: cred.orgId, orgName: cred.orgName,
    git: gc.ok && gc.count > 0, gitCount: gc.count || 0,
    gitType: gc.ok && gc.count > 0 ? (gc.connections[0].type || null) : null,
    gitName: gc.ok && gc.count > 0 ? (gc.connections[0].name || null) : null,
    secret: secR.ok && !!(secR.secrets || []).find(function (s) { return s.name === "GITHUB_PAT" || s.key === "GITHUB_PAT"; }),
    lastCheck: new Date().toISOString(),
  };
  saveState(state);
  log("状态已保存到 " + STATE_FILE, "ok");

  return { auth1: cred.auth1, orgId: cred.orgId, gitConnections: gc, secrets: secR };
}

// ═══ 命令2: disconnect-git · 健壮断开 ═══
async function cmdDisconnectGit(opts) {
  var email = opts.email;
  var password = opts.password;
  if (!email || !password) {
    log("需要 --email 和 --password", "err");
    process.exit(1);
  }

  var cred = await getCredentials(email, password);

  // 1. 实时查当前Git连接
  log("查询当前Git连接...");
  var gc = await dao.checkGitConnections(cred.orgId, cred.auth1);

  if (gc.ok && gc.count > 0) {
    // 逐个断开
    for (var i = 0; i < gc.connections.length; i++) {
      var c = gc.connections[i];
      var cName = c.name || c.installation_name || "github";
      var cHost = c.host || "github.com";
      var cId = c.id || c.git_connection_id || null;
      log("断开连接[" + i + "]: " + cName + " @ " + cHost + " type=" + (c.type || "?"));

      // 断开 name+host
      var disR = await disconnectGitHubConnection(cred.orgId, cName, cHost, cred.auth1);
      log("  断开name+host: " + (disR.ok ? "OK" : "FAIL " + (disR.error || "").slice(0, 60)),
        disR.ok ? "ok" : "err");

      // 断开PAT连接
      if (cId) {
        var patDisR = await disconnectGitHubPAT(cred.orgId, cId, cred.auth1);
        log("  断开PAT连接: " + (patDisR.ok ? "OK" : "SKIP"), patDisR.ok ? "ok" : "warn");
      }
    }
  } else {
    log("当前无Git连接, 尝试通用断开...", "warn");
    var disR2 = await disconnectGitHubConnection(cred.orgId, "github", "github.com", cred.auth1);
    log("通用断开: " + (disR2.ok ? "OK" : "FAIL " + (disR2.error || "").slice(0, 60)),
      disR2.ok ? "ok" : "err");
  }

  // 2. 断开OAuth用户
  log("断开GitHub OAuth用户...");
  var userDisR = await disconnectGitHubUser(cred.auth1, cred.orgId);
  log("断开OAuth: " + (userDisR.ok ? "OK" : "FAIL " + (userDisR.error || "").slice(0, 60)),
    userDisR.ok ? "ok" : "err");

  // 3. 等待生效
  log("等待2秒让服务端生效...");
  await sleep(2000);

  // 4. 更新本地状态
  var state = loadState();
  if (state.accounts && state.accounts[email]) {
    state.accounts[email].git = false;
    state.accounts[email].gitType = null;
    state.accounts[email].gitName = null;
    state.accounts[email].gitCount = 0;
    state.accounts[email]._connectionId = null;
    state.accounts[email].secret = false;
    saveState(state);
    log("本地状态已更新", "ok");
  }

  log("断开完成!", "ok");
}

// ═══ 命令3: connect-git · gh_cli设备码认证 ═══
async function cmdConnectGit(opts) {
  var email = opts.email;
  var password = opts.password;
  var pat = opts.pat;
  if (!email || !password) {
    log("需要 --email 和 --password", "err");
    process.exit(1);
  }

  var cred = await getCredentials(email, password);

  // 优先用已保存PAT
  if (!pat) {
    var state = loadState();
    pat = state.pat || null;
    if (pat) log("使用已保存PAT", "ok");
  }

  // ═══ 策略1: PAT注入 (快速尝试, 仅全新组织有效) ═══
  if (pat) {
    log("策略1: PAT注入(快速尝试)...");
    var patR = await dao.injectGitHubPAT(cred.orgId, pat, cred.auth1);
    if (patR.ok && !patR.existed) {
      log("PAT注入成功!", "ok");
      var secR = await dao.injectSecret(cred.orgId, "GITHUB_PAT", pat, cred.auth1);
      log("Secret注入: " + (secR.ok ? "OK" : "SKIP"), secR.ok ? "ok" : "warn");
      updateConnectState(email, cred, true, "github_individual_token", !!pat);
      log("连接完成! Git已通过PAT连接", "ok");
      return;
    }
    if (patR.existed) {
      log("PAT已存在(幂等), 连接仍有效", "ok");
      var secR2 = await dao.injectSecret(cred.orgId, "GITHUB_PAT", pat, cred.auth1);
      updateConnectState(email, cred, true, "github_individual_token", !!pat);
      log("连接完成! PAT连接已存在", "ok");
      return;
    }
    log("PAT注入失败(旧组织服务端bug), 切换gh_cli", "warn");
  }

  // ═══ 策略2: gh_cli设备码认证 (对所有账号有效 · Devin官方方式) ═══
  log("策略2: gh_cli设备码认证...");
  var codeR = await dao.jsonPost(
    "https://app.devin.ai/api/integrations/gh_cli/code",
    { Authorization: "Bearer " + cred.auth1, "x-cog-org-id": cred.orgId },
    {}, { timeoutMs: 30000 }
  );
  if (codeR.status === 200 && codeR.json) {
    var device = codeR.json.device || codeR.json;
    var userCode = device.user_code;
    var verifyUri = device.verification_uri;
    var interval = device.interval || 5;
    log("设备码: " + userCode, "ok");
    log("请在浏览器中打开: " + verifyUri, "warn");
    log("输入设备码: " + userCode, "warn");
    // 无为而无不为: --auto-approve 经既有 Chrome 自动填码授权(多 Devin 归一 Git)
    if (opts["auto-approve"]) {
      try { await autoApproveDevice(userCode, opts); } catch (e) { log("自动批准失败, 转人工: " + e.message, "warn"); }
    }
    log("等待验证(每" + interval + "秒轮询, 最多3分钟)...");

    var maxPolls = Math.floor(180 / interval);
    for (var pi = 0; pi < maxPolls; pi++) {
      await sleep(interval * 1000);
      try {
        var stR = await dao.jsonGet(
          "https://app.devin.ai/api/integrations/gh_cli/state",
          { Authorization: "Bearer " + cred.auth1, "x-cog-org-id": cred.orgId }
        );
        if (stR.status === 200 && stR.json) {
          if (stR.json.oauth && stR.json.oauth !== null) {
            log("gh_cli验证成功!", "ok");
            if (pat) { try { await dao.injectSecret(cred.orgId, "GITHUB_PAT", pat, cred.auth1); } catch (e) {} }
            updateConnectState(email, cred, true, "github_app", !!pat);
            log("连接完成! Git已通过gh_cli设备码认证连接", "ok");
            return;
          }
          if (stR.json.error && stR.json.error !== null) {
            var errStr = String(stR.json.error);
            if (errStr.indexOf("expired") >= 0) {
              log("gh_cli错误: " + errStr, "err");
              log("设备码过期, 请重新运行", "warn");
              return;
            }
            // 守柔·知止: "already registered" 为 Devin 后端 org 级幽灵记录,
            // 经实测 OAuth断开/连接删除/PAT删除/GitHub App卸载/各DELETE端点均无法清除。
            // 不再空轮3分钟刷屏, 即时如实降级并给出可行建议。
            if (errStr.toLowerCase().indexOf("already registered") >= 0) {
              log("gh_cli错误: " + errStr, "err");
              log("该 org 后端存在不可经API清除的 GitHub 集成幽灵态(git-connections 为空但仍判定已注册)。", "warn");
              log("浏览器侧授权已成功, 但 Devin 后端拒绝二次注册。建议: 改用全新 Devin org, 或联系 Devin 后端清除该 org 的 github 集成记录。", "warn");
              return;
            }
            // 其它错误: 仅首次打印, 避免刷屏
            if (pi === 0 || pi % 6 === 0) log("gh_cli错误: " + errStr, "err");
          }
        }
      } catch (e) {}
      // 每30秒也检查Git连接(双保险)
      if (pi > 0 && pi % 6 === 0) {
        var gc = await dao.checkGitConnections(cred.orgId, cred.auth1);
        if (gc.ok && gc.count > 0) {
          log("检测到Git连接!", "ok");
          if (pat) { try { await dao.injectSecret(cred.orgId, "GITHUB_PAT", pat, cred.auth1); } catch (e) {} }
          updateConnectState(email, cred, true, gc.connections[0].type || "github_app", !!pat);
          log("连接完成!", "ok");
          return;
        }
      }
      process.stdout.write(".");
    }
    log("", "");
    log("验证超时, 请重新运行", "warn");
    return;
  }

  // ═══ 策略3: OAuth回退 ═══
  log("策略3: OAuth回退...");
  var oauthR = await dao.jsonGet(
    "https://app.devin.ai/api/integrations/github/start-user-oauth?return_to=" + encodeURIComponent("/org/_/settings/integrations"),
    { Authorization: "Bearer " + cred.auth1, "x-cog-org-id": cred.orgId }
  );
  var oauthUrl = null;
  if (oauthR.status === 200 && oauthR.json) { oauthUrl = oauthR.json.url || null; }
  if (oauthUrl) {
    log("请在浏览器中打开以下URL完成授权:", "warn");
    log(oauthUrl);
  } else {
    log("请手动访问 https://github.com/apps/devin-ai-integration/installations/new 安装Devin App", "warn");
  }
}

// ═══ 命令4: full-auto · 全自动 ═══
async function cmdFullAuto(opts) {
  log("═══ 全自动模式 · 道法自然 ═══");
  // 1. 读取状态
  var statusResult = await cmdReadStatus(opts);
  // 2. 如果有连接, 先断开
  if (statusResult.gitConnections.ok && statusResult.gitConnections.count > 0) {
    log("当前有Git连接, 先断开...", "warn");
    await cmdDisconnectGit(opts);
    await sleep(2000);
  }
  // 3. 连接
  if (opts.pat) {
    await cmdConnectGit(opts);
  } else {
    log("未提供PAT, 跳过连接步骤", "warn");
  }
  log("═══ 全自动完成 ═══", "ok");
}

// ═══ 辅助: 断开GitHub连接 ═══
async function disconnectGitHubConnection(orgId, connectionName, host, auth1) {
  var bareOrgId = orgId.replace(/^org-/, "");
  var h = host || "github.com";
  var name = connectionName || "github";
  var r = await dao.jsonDelete(
    "https://app.devin.ai/api/org-" + bareOrgId + "/integrations/github?name=" +
    encodeURIComponent(name) + "&host=" + encodeURIComponent(h),
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId }
  );
  if (r.status === 200 || r.status === 204) return { ok: true };
  if (r.status === 404) {
    r = await dao.jsonDelete(
      "https://app.devin.ai/api/" + orgId + "/integrations/github?name=" +
      encodeURIComponent(name) + "&host=" + encodeURIComponent(h),
      { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId }
    );
    if (r.status === 200 || r.status === 204) return { ok: true };
  }
  return { ok: false, status: r.status, error: r.text ? r.text.slice(0, 200) : "unknown" };
}

async function disconnectGitHubUser(auth1, orgId) {
  var r = await dao.jsonDelete(
    "https://app.devin.ai/api/integrations/github/user",
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId }
  );
  if (r.status === 200 || r.status === 204) return { ok: true };
  return { ok: false, status: r.status, error: r.text ? r.text.slice(0, 200) : "unknown" };
}

async function disconnectGitHubPAT(orgId, connectionId, auth1) {
  var r = await dao.jsonDelete(
    "https://app.devin.ai/api/" + orgId + "/integrations/github/pat?connection_id=" + connectionId,
    { Authorization: "Bearer " + auth1, "x-cog-org-id": orgId }
  );
  if (r.status === 200 || r.status === 204) return { ok: true };
  return { ok: false, status: r.status, error: r.text ? r.text.slice(0, 200) : "unknown" };
}

// ═══ 辅助: 更新连接状态 ═══
function updateConnectState(email, cred, git, gitType, secret) {
  var state = loadState();
  if (!state.accounts) state.accounts = {};
  if (!state.accounts[email]) {
    state.accounts[email] = { email: email, orgId: cred.orgId, orgName: cred.orgName };
  }
  state.accounts[email].git = git;
  state.accounts[email].gitType = gitType;
  state.accounts[email].secret = secret;
  state.accounts[email].gitCount = (state.accounts[email].gitCount || 0) + 1;
  if (git) state.accounts[email].lastCheck = new Date().toISOString();
  saveState(state);
}

// ═══ 命令5: switch-git · 反者道之动 · 纯API换登闭环(突破 already registered 幽灵态) ═══
// 既得其母以知其子: Devin 账号定 org, GitHub 工作区账号定要归一连接的那一个 Git。
// 引擎顺序: 并行[断开上次会话旧连接] + [登录 Devin] → 装 GitHub App 到 org(可移动抢绑)。
async function cmdSwitchGit(opts) {
  if (!engine || !engine.runSwitch) {
    log("换登引擎不可用: " + (_engErr || "engine/runSwitch.js 缺失"), "err");
    log("回退建议: 改用 connect-git --auto-approve(设备码路径)。", "warn");
    process.exit(1);
  }
  // Devin 登录账号: 显式 --email/--password, 否则取 ~/.dao/accounts.json 首个。
  var email = opts.email, password = opts.password;
  if (!email || !password) {
    try {
      var aj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dao", "accounts.json"), "utf8"));
      var a0 = (aj.accounts || aj)[0];
      if (a0) { email = email || a0.email; password = password || a0.password; }
    } catch (e) {}
  }
  if (!email || !password) { log("缺少 Devin 登录凭证(--email/--password 或 ~/.dao/accounts.json)", "err"); process.exit(1); }

  // GitHub 工作区账号(要归一连接的那一个 Git): --gh-user/... 或 ~/.dao/github-creds.json。
  var gh = loadGithubCreds(opts);
  var workspace = gh ? { username: gh.user, password: gh.pass, totp: gh.totp } : undefined;
  if (!workspace) log("未提供 GitHub 工作区账号, 仅登录 Devin(不连 Git)。如需连接请给 --gh-user/--gh-pass/--gh-totp", "warn");

  // prevSession: 上次换登落盘的会话, 用于「先断旧连接」。
  var st = loadState();
  var prevSession = st.lastSession && st.lastSession.token ? st.lastSession : undefined;
  if (prevSession) log("检测到上次会话(org=" + prevSession.orgId + "), 将先断开其旧 GitHub 连接");

  var proxy = "";
  if (opts.proxy) proxy = opts.proxy.indexOf("://") >= 0 ? opts.proxy : "http://" + opts.proxy;

  log("switch-git 启动 — Devin=" + email + (workspace ? " · GitHub工作区=" + workspace.username : "") + (opts.org ? " · org=" + opts.org : ""));

  var params = {
    devinUrl: opts["devin-url"] || "https://app.devin.ai",
    username: email,
    password: password,
    totp: opts["devin-totp"] || "",
    org: opts.org || "",
    proxy: proxy,
    insecureTLS: !!(opts.insecure || opts["insecure-tls"]),
    prevSession: prevSession,
    workspace: workspace,
    githubCookies: (st.lastSession && st.lastSession.github_cookies) || {},
  };

  var result = await new Promise(function (resolve) {
    var handle = engine.runSwitch(params, function (ev) {
      if (ev.type === "log") { console.log("   " + ev.msg); }
      else if (ev.type === "result") { resolve(ev); }
    });
    handle.done.then(function (r) { if (r) resolve(r); }).catch(function (e) { resolve({ success: false, error: String(e) }); });
  });

  if (result.success) {
    log("换登成功 — user_id=" + result.user_id + " org=" + (result.org_name || result.org_id), "ok");
    if (result.github_connected) {
      log("GitHub 已连接: " + result.github_connected_name + " (可见 " + result.github_repo_count + " 个仓库)", "ok");
    } else if (workspace) {
      log("Devin 登录成功但 GitHub 未连接: " + (result.error || "(无详情)"), "warn");
    }
    // 落盘本次会话, 供下次 switch-git 先断旧连接(闭环·自循环)。
    st.lastSession = {
      token: result.token, orgId: result.org_id, orgName: result.org_name,
      workspaceGithub: result.github_connected_name || (workspace && workspace.username) || "",
      github_cookies: result.github_cookies || {},
    };
    saveState(st);
  } else {
    log("换登失败: " + (result.error || "未知"), "err");
    process.exitCode = 2;
  }
}

// ═══ 帮助 ═══
function showHelp() {
  console.log([
    "",
    "═══════════════════════════════════════════",
    "  dao-git-auth-cli.js · 反者道之动 · v2.0.0",
    "  纯Devin体系 · 零VSCode依赖",
    "═══════════════════════════════════════════",
    "",
    "用法: node dao-git-auth-cli.js <command> [options]",
    "",
    "命令:",
    "  read-status      读取当前Git连接+Secret状态",
    "  disconnect-git   健壮断开所有Git连接+OAuth",
    "  connect-git      多层策略连接Git (PAT→App→URL)",
    "  switch-git       纯API换登闭环: 断旧→登录Devin→装GitHub App(移动抢绑, 突破 already-registered 幽灵态) ★推荐",
    "  full-auto        全自动: 读状态→断开→连接",
    "",
    "选项:",
    "  --email EMAIL    Devin登录邮箱",
    "  --password PWD   Devin登录密码",
    "  --pat GHP_PAT    GitHub PAT (connect-git用)",
    "  --proxy H:P      代理地址 (默认读DAO_PROXY_HOST/PORT)",
    "  --no-proxy       禁用代理",
    "  --auto-approve   经既有 Chrome(CDP) 自动填设备码并授权",
    "  --cdp URL        Chrome CDP 端点 (默认 http://localhost:29229)",
    "  --gh-user/--gh-pass/--gh-totp  GitHub 登录凭证(留空则读 ~/.dao/github-creds.json 或用浏览器既有登录)",
    "  --org NAME       switch-git: 绑定目标 org(留空默认用 GitHub 工作区账号名)",
    "  --devin-totp S   switch-git: Devin 账号若开启 2FA 的 TOTP 密钥",
    "  --insecure       switch-git: 关闭 TLS 校验(自签/拦截代理兜底)",
    "",
    "示例:",
    "  node dao-git-auth-cli.js switch-git --email a@b.com --password xxx --gh-user u --gh-pass p --gh-totp SECRET",
    "  node dao-git-auth-cli.js read-status --email a@b.com --password xxx",
    "  node dao-git-auth-cli.js connect-git --email a@b.com --password xxx --pat ghp_xxx",
    "  node dao-git-auth-cli.js connect-git --email a@b.com --password xxx --auto-approve",
    "  node dao-git-auth-cli.js full-auto --email a@b.com --password xxx --pat ghp_xxx",
    "",
  ].join("\n"));
}

// ═══ 主入口 ═══
async function main() {
  var opts = parseArgs();

  // 代理配置
  if (opts.proxy) {
    var parts = opts.proxy.split(":");
    process.env.DAO_PROXY_HOST = parts[0];
    process.env.DAO_PROXY_PORT = parts[1] || "7890";
    process.env.DAO_PROXY_ENABLED = "1";
  }
  if (opts.noProxy || opts["no-proxy"]) {
    process.env.DAO_PROXY_ENABLED = "0";
  }

  // 保存PAT
  if (opts.pat) {
    var state = loadState();
    state.pat = opts.pat;
    saveState(state);
  }

  switch (opts.command) {
    case "read-status":
      await cmdReadStatus(opts);
      break;
    case "disconnect-git":
      await cmdDisconnectGit(opts);
      break;
    case "connect-git":
      await cmdConnectGit(opts);
      break;
    case "switch-git":
      await cmdSwitchGit(opts);
      break;
    case "full-auto":
      await cmdFullAuto(opts);
      break;
    case "help":
    case "--help":
    case "-h":
    default:
      showHelp();
      break;
  }
}

main().catch(function (e) {
  log("异常: " + e.message, "err");
  console.error(e.stack);
  process.exit(1);
});
