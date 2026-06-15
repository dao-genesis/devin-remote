"use strict";
// 一键换登编排 + RunHandle runner —— 纯 API（不拉浏览器、不下载 Playwright）。
//
// 顺序做三件事（沿用原 Python vwdevin.switch 的语义，只是改成纯 HTTP）：
//   1. 退出/断连「当前账号」：API 模式下每次换登都是一条全新、互不串味的 HTTP 会话
//      （独立 cookie jar），所以没有需要清理的常驻登录态——这步是天然的 no-op。
//   2. 用所选 GitHub 账号登录 Devin（必须成功）：纯 HTTP 跑完 OAuth 换到 Bearer token。
//   3. 绑定指定组织（best-effort，组织留空默认用户名）：把 Devin 的 GitHub App 装到组织上。
//
// 登录拿到的 {token, userId} 即 Devin Web 端 localStorage['auth1_session'] 的内容，
// 通过 result 事件抛给 panel.ts 持久化，供用户「换登」后直接使用。
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DEVIN_URL = void 0;
exports.buildConfig = buildConfig;
exports.applyOrgDefault = applyOrgDefault;
exports.resolveWorkspaceBinding = resolveWorkspaceBinding;
exports.runSwitchFlow = runSwitchFlow;
exports.runSwitch = runSwitch;
const apiLogin_1 = require("./apiLogin");
Object.defineProperty(exports, "DEFAULT_DEVIN_URL", { enumerable: true, get: function () { return apiLogin_1.DEFAULT_DEVIN_URL; } });
const types_1 = require("./types");
function buildConfig(params) {
    return {
        devinUrl: (params.devinUrl || "").trim() || apiLogin_1.DEFAULT_DEVIN_URL,
        githubUsername: params.username,
        githubPassword: params.password,
        githubTotpSecret: params.totp,
        githubOrg: params.org,
    };
}
/** 组织留空时默认用 GitHub 用户名。 */
function applyOrgDefault(cfg, log) {
    if (!cfg.githubOrg.trim()) {
        cfg.githubOrg = cfg.githubUsername.trim();
        if (cfg.githubOrg) {
            log(`ℹ 没填组织，默认用 GitHub 用户名作为组织：${cfg.githubOrg}`);
        }
    }
}
function orgHomeUrl(devinUrl, orgName) {
    const base = devinUrl.replace(/\/+$/, "");
    return orgName ? `${base}/org/${orgName}` : base;
}
/**
 * 解析 GitHub App 的安装目标：
 * - 工作区账号填了用户名且与登录账号不同 → 两账号流程：bindOrg = 工作区 org（留空退回工作区用户名），
 *   并返回工作区账号作为 connectAsAccount（用它的 GitHub 凭据授权安装）。
 * - 否则 → 单账号旧行为：bindOrg = 登录账号的组织（已经过 applyOrgDefault 填好用户名）。
 */
function resolveWorkspaceBinding(loginUsername, loginOrg, workspace) {
    const wsUser = (workspace?.username || "").trim();
    const useWorkspace = wsUser !== "" && wsUser !== loginUsername.trim();
    if (!useWorkspace) {
        return { useWorkspace: false, bindOrg: loginOrg };
    }
    return {
        useWorkspace: true,
        bindOrg: (workspace?.org || "").trim() || wsUser,
        connectAsAccount: { username: wsUser, password: workspace?.password || "", totpSecret: workspace?.totp || "" },
    };
}
/** 一键换登（纯 API）：登录所选账号 → 跳引导 → 绑定组织。 */
async function runSwitchFlow(cfg, log, gate, opts = {}) {
    applyOrgDefault(cfg, log);
    // 工作区账号：填了且与登录账号不同时，绑定目标改为它名下的 org（用它的 GitHub 凭据授权安装）。
    const binding = resolveWorkspaceBinding(cfg.githubUsername, cfg.githubOrg, opts.workspace);
    const { useWorkspace, bindOrg } = binding;
    const wsUser = (opts.workspace?.username || "").trim();
    // 第 1 步「断连旧组织的 Devin GitHub App」用的是【上一个账号】的会话，和「新账号登录 + 连组织」
    // 完全互不依赖 → 并行跑，别让登录干等这条断连往返。
    log("=== 一键换登 · 第 1 步（并行）：断连当前账号绑定的 GitHub 组织 ===");
    const prev = opts.prevSession;
    let disconnectPromise;
    if (prev && prev.token && prev.orgId) {
        if (prev.workspaceGithub) {
            log(`   · 用上次保存的会话，只卸掉上次工作区账号「${prev.workspaceGithub}」那条 Devin GitHub App 连接 …`);
        }
        else {
            log(`   · 用上次保存的会话，卸掉旧组织${prev.orgName ? `（${prev.orgName}）` : ""}上 Devin 的 GitHub App …`);
        }
        disconnectPromise = (0, apiLogin_1.disconnectGithubFromOrg)({
            devinUrl: cfg.devinUrl,
            token: prev.token,
            orgId: prev.orgId,
            onlyName: prev.workspaceGithub,
            log,
            proxy: opts.proxy,
            verify: !opts.insecureTLS,
        }).catch((exc) => ({ removed: 0, ok: false, error: String(exc) }));
    }
    else {
        log("   · 没有「上一个已登录账号」记录（首次换登 / 没落盘），无需断连，跳过。");
        disconnectPromise = Promise.resolve({ removed: 0, ok: true, error: "" });
    }
    log(`=== 一键换登 · 第 2 步：用 GitHub=${cfg.githubUsername} 登录 Devin ===`);
    if (useWorkspace) {
        log(`=== 一键换登 · 第 3 步：把 Devin GitHub App 装到「工作区账号」${wsUser} 的 org → ${bindOrg} ===`);
    }
    else {
        log(`=== 一键换登 · 第 3 步：绑定 GitHub 组织 → ${bindOrg || "(无)"} ===`);
    }
    const result = await (0, apiLogin_1.loginDevinWithGithubApi)({
        username: cfg.githubUsername,
        password: cfg.githubPassword,
        totpSecret: cfg.githubTotpSecret,
    }, {
        devinUrl: cfg.devinUrl,
        orgName: bindOrg,
        connectAsAccount: binding.connectAsAccount,
        seedGithubCookies: opts.githubCookies,
        log,
        gate,
        proxy: opts.proxy,
        verify: !opts.insecureTLS,
    });
    // 收口并行的「断连旧组织」（不阻断登录结果）。
    const d = await disconnectPromise;
    if (d.removed > 0) {
        log(`   ✔ 已从旧组织卸掉 ${d.removed} 个 GitHub 连接。`);
    }
    else if (!d.ok) {
        log("   ⚠ 断连旧组织未完全成功（详见上面），不影响本次登录。");
    }
    if (result.success) {
        const orgPart = `已登录 Devin（user_id=${result.userId}，Devin 账户 org=${result.orgName || "?"}）`;
        let ghPart = "";
        if (result.githubConnected) {
            const where = useWorkspace ? `工作区账号 ${wsUser} 的 org（${bindOrg}）` : `org（${bindOrg || result.orgName || "?"}）`;
            ghPart = `，已把 Devin GitHub App 连到 ${where}，可见 ${result.githubRepoCount} 个仓库`;
        }
        log(`✔ 一键换登完成。${orgPart}${ghPart}`);
    }
    return result;
}
/**
 * 跑一遍 runSwitchFlow，把日志 / 结果以事件回调推出去。返回的 RunHandle 跟原接口
 * 一致（done/cancel），panel.ts 可平替。
 */
function runSwitch(params, onEvent) {
    const gate = new types_1.PauseGate();
    const log = (msg) => onEvent({ type: "log", msg });
    const cfg = buildConfig(params);
    const done = (async () => {
        let resultEvent = null;
        try {
            const r = await runSwitchFlow(cfg, log, gate, {
                proxy: params.proxy,
                insecureTLS: params.insecureTLS,
                prevSession: params.prevSession,
                workspace: params.workspace,
                githubCookies: params.githubCookies,
            });
            resultEvent = {
                type: "result",
                success: r.success,
                error: r.error || "",
                github_username: params.username,
                token: r.token,
                user_id: r.userId,
                email: r.email,
                org_id: r.orgId,
                org_name: r.orgName,
                is_new_user: r.isNewUser,
                github_connected: r.githubConnected,
                github_repo_count: r.githubRepoCount,
                github_connected_name: r.githubConnectedName || "",
                ide_auth_code: r.ideAuthCode || "",
                final_url: orgHomeUrl(cfg.devinUrl, r.orgName),
                github_cookies: r.githubCookies || {},
            };
            onEvent(resultEvent);
        }
        catch (exc) {
            log(`✘ 换登进程出错：${String(exc)}`);
            resultEvent = {
                type: "result",
                success: false,
                error: String(exc),
                github_username: params.username,
                token: "",
                user_id: "",
                email: "",
                org_id: "",
                org_name: "",
                is_new_user: false,
                github_connected: false,
                github_repo_count: 0,
                github_connected_name: "",
                ide_auth_code: "",
                final_url: "",
                github_cookies: {},
            };
            onEvent(resultEvent);
        }
        return resultEvent;
    })();
    return {
        done,
        cancel: () => gate.stop(),
    };
}
//# sourceMappingURL=runSwitch.js.map