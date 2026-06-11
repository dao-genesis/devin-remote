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
var DAO_AUTH_PATH = process.env.DAO_AUTH_PATH ||
  path.join(__dirname, "..", "网页端", "core", "dao-auth.js");
var dao;
try {
  dao = require(DAO_AUTH_PATH);
} catch (e) {
  console.error("✗ 无法加载 dao-auth.js: " + e.message);
  console.error("  请确保路径正确: " + DAO_AUTH_PATH);
  console.error("  或设置环境变量 DAO_AUTH_PATH");
  process.exit(1);
}

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
            log("gh_cli错误: " + stR.json.error, "err");
            if (String(stR.json.error).indexOf("expired") >= 0) {
              log("设备码过期, 请重新运行", "warn");
              return;
            }
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
    "  full-auto        全自动: 读状态→断开→连接",
    "",
    "选项:",
    "  --email EMAIL    Devin登录邮箱",
    "  --password PWD   Devin登录密码",
    "  --pat GHP_PAT    GitHub PAT (connect-git用)",
    "  --proxy H:P      代理地址 (默认读DAO_PROXY_HOST/PORT)",
    "  --no-proxy       禁用代理",
    "",
    "示例:",
    "  node dao-git-auth-cli.js read-status --email a@b.com --password xxx",
    "  node dao-git-auth-cli.js connect-git --email a@b.com --password xxx --pat ghp_xxx",
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
