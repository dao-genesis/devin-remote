"use strict";
// 用 GitHub 账号登录 Devin —— 纯 API 版（不拉浏览器、不下载 Playwright）。
//
// 从 DevinLauncher 的 devin_launcher/github_api_login.py 1:1 移植成 TS：全程只用
// HTTP 请求复刻 Devin 的「Continue with GitHub」OAuth 流程：
//   1) POST /api/auth1/connections                 拿 github client_id
//   2) 本地生成 PKCE + state
//   3) GitHub OAuth（纯 HTTP）：authorize → /login → POST /session →
//      (可能) /sessions/two-factor → (首次) 同意页 → 302 回 /auth/callback?code=
//   4) POST /api/auth1/github/exchange             code 换 Devin Bearer token
//   5) POST /api/users/post-auth                   验真 + 拿 org_id/org_name
//   6) (可选) 装 Devin 的 GitHub App 到组织         绑定组织 / 让 Devin 能访问仓库
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevinAccountNotFoundError = exports.DevinGithubApiError = exports.DEFAULT_DEVIN_URL = void 0;
exports.pageLooksLikeSudo = pageLooksLikeSudo;
exports.pickSudoForm = pickSudoForm;
exports.pickInstallTargetUrl = pickInstallTargetUrl;
exports.pickInstallForTarget = pickInstallForTarget;
exports.findUninstallForm = findUninstallForm;
exports.installationsListPath = installationsListPath;
exports.disconnectGithubFromOrg = disconnectGithubFromOrg;
exports.loginDevinWithGithubApi = loginDevinWithGithubApi;
exports.mintIdeAuthCode = mintIdeAuthCode;
const crypto = __importStar(require("crypto"));
const forms_1 = require("./forms");
const http_1 = require("./http");
const totp_1 = require("./totp");
const types_1 = require("./types");
exports.DEFAULT_DEVIN_URL = "https://app.devin.ai";
const GITHUB_BASE = "https://github.com";
// Devin 的 GitHub OAuth App（抓包得到；connections 接口也会回同一个）。
const FALLBACK_GITHUB_CLIENT_ID = "Iv1.fffb955bc006997f";
const GITHUB_CONNECTION_ID = "github-devin";
const OAUTH_SCOPE = "user:email";
// Devin 的 oauth-callback / installation-callback 在服务端就要做一次 GitHub 授权码兑换，
// 实测常耗 ~30s（偶尔更久）；HttpClient 默认单请求超时正好是 30s，会把「其实成功只是慢」
// 的回调掐成「请求超时」→ 身份没切成 → 后面连组织假失败。给这两类回调单独放宽到 60s。
const SLOW_CALLBACK_TIMEOUT_MS = 90_000; // [1.5] 从 60s 提到 90s，某些慢服务端需要更长
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
    "user-agent": BROWSER_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
};
class DevinGithubApiError extends Error {
}
exports.DevinGithubApiError = DevinGithubApiError;
class DevinAccountNotFoundError extends DevinGithubApiError {
}
exports.DevinAccountNotFoundError = DevinAccountNotFoundError;
function emptyResult() {
    return {
        success: false,
        token: "",
        userId: "",
        email: "",
        isNewUser: false,
        orgId: "",
        orgName: "",
        githubConnected: false,
        githubRepoCount: 0,
        githubConnectedName: "",
        ideAuthCode: "",
        githubCookies: {},
        stage: "",
        error: "",
    };
}
/** 统一的 cookie 索引键：用户名去空白 + 小写。 */
function cookieKey(username) {
    return username.trim().toLowerCase();
}
// ---- URL / 状态判定 ----
function stripTrailingSlash(u) {
    return u.replace(/\/+$/, "");
}
function isDevinCallback(url) {
    try {
        const u = new URL(url);
        return u.hostname.endsWith("devin.ai") && u.pathname.replace(/\/+$/, "") === "/auth/callback";
    }
    catch {
        return false;
    }
}
function extractCode(url) {
    const code = new URL(url).searchParams.get("code") || "";
    if (!code) {
        throw new DevinGithubApiError(`回调 URL 里没有 code：${url}`);
    }
    return code;
}
function isTwoFactor(url, body) {
    if (url.includes("two-factor")) {
        return true;
    }
    const form = (0, forms_1.findForm)(body, { actionContains: "two-factor" });
    return form !== null && (0, forms_1.otpFieldName)(form.inputs) !== null;
}
function looksLikeDeviceVerification(body, url) {
    const low = body.toLowerCase();
    return (low.includes("device verification") ||
        low.includes("verify your device") ||
        url.includes("/sessions/verified-device") ||
        low.includes("verified-device"));
}
function hasLoginForm(html) {
    return ((0, forms_1.findForm)(html, { hasField: "login" }) !== null ||
        (0, forms_1.findForm)(html, { actionContains: "/session" }) !== null);
}
function checkStop(gate) {
    gate?.checkStop();
}
// ---- PKCE ----
function b64url(raw) {
    return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makePkce() {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}
function httpDateTs(dateHeader) {
    if (!dateHeader) {
        return null;
    }
    const ms = Date.parse(dateHeader);
    return Number.isNaN(ms) ? null : ms / 1000;
}
// ---- GitHub OAuth（纯 HTTP）----
async function fetchGithubClientId(devin, devinUrl, log) {
    const url = stripTrailingSlash(devinUrl) + "/api/auth1/connections";
    try {
        const resp = await devin.post(url, { body: "", headers: { "content-type": "application/json" } });
        const data = JSON.parse(resp.text || "{}");
        for (const conn of data.connections || []) {
            if (conn.type === "github" && conn.client_id) {
                return String(conn.client_id);
            }
        }
    }
    catch (exc) {
        log(`   ⚠ 取 GitHub client_id 失败（${String(exc)}），用内置默认值。`);
    }
    return FALLBACK_GITHUB_CLIENT_ID;
}
async function submitTwoFactor(gh, account, resp, log, gate) {
    if (!account.totpSecret) {
        throw new DevinGithubApiError("GitHub 开了 2FA 但没给 TOTP 密钥");
    }
    // 用 GitHub 响应的 Date 头当 TOTP 基准时间，躲开本机时钟漂移；拿不到退回本机时间。
    const serverTs = httpDateTs(resp.headers["date"]);
    const localTs = Date.now() / 1000;
    const baseTs = serverTs ?? localTs;
    if (serverTs !== null) {
        const skew = localTs - serverTs;
        if (Math.abs(skew) >= 10) {
            log(`   ⚠ 本机时钟与 GitHub 相差约 ${skew >= 0 ? "+" : ""}${skew.toFixed(0)}s，已改用 GitHub 服务器时间算 TOTP。`);
        }
    }
    let codes;
    try {
        // [1.2 修复] 如果 totpSecret 已经是 6 位纯数字，直接当验证码用，不做 base32 解码
        if (/^\d{6}$/.test((account.totpSecret || "").trim())) {
            codes = [account.totpSecret.trim()];
        } else {
            codes = (0, totp_1.codesForTime)(account.totpSecret, baseTs);
        }
    }
    catch (exc) {
        throw new DevinGithubApiError(String(exc));
    }
    let cur = resp;
    for (let idx = 0; idx < codes.length; idx++) {
        checkStop(gate);
        // 每次重试重新解析表单：GitHub 失败页会换一个新的 authenticity_token。
        const form = (0, forms_1.findForm)(cur.text, { actionContains: "two-factor" });
        if (!form) {
            if (cur.url.includes("two-factor") && (0, forms_1.findForm)(cur.text, { actionContains: "two-factor" })) {
                throw new DevinGithubApiError(`2FA 页没解析出验证码表单（落在 ${cur.url}）`);
            }
            return cur; // 已离开 2FA 页 = 过了
        }
        const fields = { ...form.inputs };
        const otpField = (0, forms_1.otpFieldName)(fields);
        if (!otpField) {
            throw new DevinGithubApiError(`2FA 表单里没找到验证码字段（${Object.keys(fields).join(",")}）`);
        }
        fields[otpField] = codes[idx];
        const action = new URL(form.action || "/sessions/two-factor", cur.url).toString();
        if (idx > 0) {
            log("→ 2FA 验证码被拒，换相邻时间窗口重试 …");
        }
        cur = await gh.post(action, { form: fields });
        checkStop(gate);
        const stillTwoFactor = cur.url.includes("two-factor") && (0, forms_1.findForm)(cur.text, { actionContains: "two-factor" }) !== null;
        if (!stillTwoFactor) {
            return cur; // 过了
        }
    }
    throw new DevinGithubApiError("2FA 验证码被拒（密钥不对或时间漂移？）");
}
/**
 * 判断一个页面是不是 GitHub 的「sudo 二次确认」页（装 App 这类敏感操作会被要求重新验证身份）。
 * 依据：URL 落在 /sessions/sudo，或页面里存在带 sudo_password / sudo_app_otp / sudo 字段的表单。
 */
function pageLooksLikeSudo(html, url = "") {
    if (url.includes("/sessions/sudo")) {
        return true;
    }
    return (0, forms_1.parseForms)(html).some((f) => "sudo_password" in f.inputs || "sudo_app_otp" in f.inputs || "sudo_otp" in f.inputs || "sudo" in f.inputs);
}
/** 从 sudo 页里挑出「含某个 sudo 凭据字段」的那个表单（otp 或 password）。 */
function pickSudoForm(html, field) {
    const form = (0, forms_1.parseForms)(html).find((f) => field in f.inputs && "authenticity_token" in f.inputs);
    return form ? { action: form.action, inputs: form.inputs } : null;
}
/**
 * 装 App 提交后，GitHub 常常返回 sudo 二次确认页（实测字段：sudo_app_otp / sudo_password / webauthn_response）。
 * 这些 sudo 表单里同时带着安装上下文（install_target / integration_fingerprint / target_id …），
 * 所以「提交 sudo 凭据」这一步会同时完成 sudo 与安装。优先用 TOTP，其次用密码。passkey 走不了，跳过。
 */
async function completeSudo(gh, creds, page, log, gate) {
    if (!pageLooksLikeSudo(page.text, page.url)) {
        return page;
    }
    if (!creds || (!creds.totpSecret && !creds.password)) {
        log("   ⚠ 装 App 触发 GitHub sudo 二次确认，但没有工作区账号的密码/TOTP 可用于确认；跳过（可在网页手动点 Connect 装一次）。");
        return page;
    }
    log("   · 装 App 触发 GitHub sudo 二次确认，用工作区账号凭据自动完成 …");
    let cur = page;
    // 1) 优先 TOTP：拿相邻时间窗口的多个验证码挨个试（躲时钟漂移），每次重解析表单（authenticity_token 会变）。
    if (creds.totpSecret) {
        const baseTs = httpDateTs(cur.headers["date"]) ?? Date.now() / 1000;
        let codes = [];
        try {
            if (/^\d{6}$/.test(creds.totpSecret.trim())) {
                codes = [creds.totpSecret.trim()];
            } else {
                codes = (0, totp_1.codesForTime)(creds.totpSecret, baseTs);
            }
        }
        catch {
            codes = [];
        }
        for (let i = 0; i < codes.length; i++) {
            checkStop(gate);
            const form = pickSudoForm(cur.text, "sudo_app_otp");
            if (!form) {
                break;
            }
            const fields = { ...form.inputs };
            fields["sudo_app_otp"] = codes[i];
            const action = new URL(form.action || "/sessions/sudo", cur.url).toString();
            log(i === 0 ? "→ sudo：提交 TOTP 确认 …" : "→ sudo：TOTP 被拒，换相邻时间窗口重试 …");
            cur = await gh.post(action, { form: fields });
            checkStop(gate);
            if (!pageLooksLikeSudo(cur.text, cur.url)) {
                log("   ✔ sudo 确认通过（TOTP）。");
                return cur;
            }
        }
    }
    // 2) 退回密码确认（部分账号未开 2FA，或 TOTP 不可用时）。
    if (creds.password && pageLooksLikeSudo(cur.text, cur.url)) {
        const form = pickSudoForm(cur.text, "sudo_password");
        if (form) {
            const fields = { ...form.inputs };
            fields["sudo_password"] = creds.password;
            const action = new URL(form.action || "/sessions/sudo", cur.url).toString();
            log("→ sudo：提交密码确认 …");
            cur = await gh.post(action, { form: fields });
            checkStop(gate);
            if (!pageLooksLikeSudo(cur.text, cur.url)) {
                log("   ✔ sudo 确认通过（密码）。");
                return cur;
            }
        }
    }
    if (pageLooksLikeSudo(cur.text, cur.url)) {
        log("   ⚠ sudo 确认仍未通过（密码/TOTP 可能不对，或该账号要求 passkey/邮箱验证，纯 API 过不去）。");
    }
    return cur;
}
async function submitGithubCredentials(gh, account, resp, log, gate) {
    const form = (0, forms_1.findForm)(resp.text, { hasField: "login" }) || (0, forms_1.findForm)(resp.text, { actionContains: "/session" });
    if (!form) {
        throw new DevinGithubApiError(`GitHub 登录页没解析出登录表单（落在 ${resp.url}）`);
    }
    const fields = { ...form.inputs };
    fields["login"] = account.username;
    fields["password"] = account.password;
    const action = new URL(form.action || "/session", resp.url).toString();
    let cur = await gh.post(action, { form: fields });
    checkStop(gate);
    const body = cur.text;
    if (body.toLowerCase().includes("incorrect username or password")) {
        throw new DevinGithubApiError("GitHub 账号或密码不对");
    }
    if (looksLikeDeviceVerification(body, cur.url)) {
        throw new DevinGithubApiError("GitHub 要求设备验证（邮箱验证码），纯 API 过不去，需先用浏览器在本机验证一次该账号");
    }
    if (isTwoFactor(cur.url, body) && account.totpSecret) {
        cur = await submitTwoFactor(gh, account, cur, log, gate);
    }
    return cur;
}
async function githubLogin(gh, account, authorizeUrl, log, gate) {
    // 1) 打开 authorize：未登录会 302 到 /login?return_to=<authorize>
    let resp = await gh.get(authorizeUrl);
    checkStop(gate);
    if (isDevinCallback(resp.url)) {
        return extractCode(resp.url);
    }
    // 2~3) 登录页 → POST /session →（可能的）2FA
    if (hasLoginForm(resp.text)) {
        resp = await submitGithubCredentials(gh, account, resp, log, gate);
    }
    const body = resp.text;
    // 4) 应已回 Devin 回调；否则可能停在首次授权的同意页。
    if (isDevinCallback(resp.url)) {
        return extractCode(resp.url);
    }
    const consent = (0, forms_1.findForm)(body, { actionContains: "/login/oauth/authorize" });
    if (consent) {
        const fields = { ...consent.inputs };
        // 同意页默认带 authorize=0（=拒绝）；必须显式改成 1 才算点了「Authorize」。
        if ("authorize" in fields) {
            fields["authorize"] = "1";
        }
        const action = new URL(consent.action, resp.url).toString();
        resp = await gh.post(action, { form: fields });
        checkStop(gate);
        if (isDevinCallback(resp.url)) {
            return extractCode(resp.url);
        }
    }
    // 仍没回调：重新打一次 authorize（此时已登录，多半直接 302 回调）。
    resp = await gh.get(authorizeUrl);
    if (isDevinCallback(resp.url)) {
        return extractCode(resp.url);
    }
    throw new DevinGithubApiError(`GitHub 授权完成但没拿到回调 code（停在 ${resp.url}）`);
}
/**
 * 让一个全新的 GitHub 客户端登录 github.com（不走 Devin OAuth），用于「工作区账号」
 * 授权安装 Devin App。成功返回 true；停在登录/2FA 页或被设备验证拦住返回 false
 * （连组织这步会据此优雅跳过，不影响已完成的 Devin 登录）。
 */
async function establishGithubSession(gh, account, log, gate) {
    try {
        // [1.3 修复] 先检查 Cookie 是否还有效（避免过期 Cookie 导致后续操作失败）
        let resp = await gh.get(GITHUB_BASE + "/settings/profile");
        checkStop(gate);
        if (!hasLoginForm(resp.text) && !resp.url.includes("/login")) {
            // Cookie 仍有效，已经登录态
            log(`→ 工作区账号 ${account.username}：Cookie 仍有效，已登录 github.com。`);
            return true;
        }
        // Cookie 失效，走正常登录流程
        resp = await gh.get(GITHUB_BASE + "/login");
        checkStop(gate);
        if (hasLoginForm(resp.text)) {
            log(`→ 工作区账号 ${account.username}：Cookie 已过期，重新登录 github.com …`);
            resp = await submitGithubCredentials(gh, account, resp, log, gate);
        }
        checkStop(gate);
        const stuck = resp.url.includes("/login") || resp.url.includes("/sessions/two-factor") || hasLoginForm(resp.text);
        if (stuck) {
            log("   ⚠ 工作区账号仍停在 GitHub 登录/2FA 页，无法用它授权安装（检查密码/2FA）。");
            return false;
        }
        return true;
    }
    catch (exc) {
        if (exc instanceof types_1.StopRequested) {
            throw exc;
        }
        log(`   ⚠ 工作区账号登录 github.com 失败：${String(exc)}`);
        return false;
    }
}
async function exchangeCode(devin, devinUrl, code, codeVerifier, mode) {
    const url = stripTrailingSlash(devinUrl) + "/api/auth1/github/exchange";
    const payload = {
        code,
        code_verifier: codeVerifier,
        connection_id: GITHUB_CONNECTION_ID,
        mode,
        redirect_uri: stripTrailingSlash(devinUrl) + "/auth/callback",
    };
    const resp = await devin.post(url, { json: payload });
    if (resp.status !== 200) {
        const body = resp.text.slice(0, 200);
        if (resp.status === 400 && body.toLowerCase().includes("no account found")) {
            throw new DevinAccountNotFoundError(`exchange 接口返回 ${resp.status}：${body}`);
        }
        throw new DevinGithubApiError(`exchange 接口返回 ${resp.status}：${body}`);
    }
    let data;
    try {
        data = JSON.parse(resp.text);
    }
    catch (exc) {
        throw new DevinGithubApiError(`exchange 返回不是 JSON：${String(exc)}`);
    }
    if (!data.token) {
        throw new DevinGithubApiError(`exchange 没返回 token：${JSON.stringify(data)}`);
    }
    return data;
}
async function verifyToken(devin, devinUrl, token, log) {
    const url = stripTrailingSlash(devinUrl) + "/api/users/post-auth";
    let resp;
    try {
        resp = await devin.post(url, {
            headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
            body: "{}",
        });
    }
    catch (exc) {
        log(`   ⚠ 验证 token 时请求失败（${String(exc)}），仅凭 exchange 结果判成功。`);
        return { ok: true, orgId: "", orgName: "" };
    }
    if (resp.status === 200) {
        let data = {};
        try {
            data = JSON.parse(resp.text);
        }
        catch {
            data = {};
        }
        return { ok: true, orgId: String(data.org_id ?? ""), orgName: String(data.org_name ?? "") };
    }
    log(`   ⚠ /api/users/post-auth 返回 ${resp.status}，token 可能无效。`);
    return { ok: false, orgId: "", orgName: "" };
}
/**
 * 换取 IDE（Windsurf/Devin 客户端）登录用的一次性 auth code。
 *
 * 复刻 app.devin.ai 前端 `/auth/windsurf/success` 页的行为：用已登录的会话
 * （`Authorization: Bearer <token>` + `x-cog-org-id: <orgId>`）POST 一个空体到
 * `/api/auth/windsurf/continue`，拿到 `{code}`。这个 code 就是 IDE 登录凭据——
 * 前端会把它拼成 deep-link `<scheme>://codeium.windsurf?devin_code=<code>` 交回 IDE，
 * 也可在 IDE 命令面板「Provide auth token」里手动粘贴（一次性、约 60s 过期）。
 *
 * best-effort：失败只记日志、返回空串，不影响换登本身已经成功的登录态。
 * 401/403 多半是该账号 / org 没有 Windsurf/Devin 客户端席位（entitlement）。
 */
async function mintWindsurfAuthCode(devin, devinUrl, token, orgId, log) {
    if (!token) {
        log("   ⚠ 缺 token，跳过 mint IDE 登录码。");
        return "";
    }
    const url = stripTrailingSlash(devinUrl) + "/api/auth/windsurf/continue";
    const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
    };
    if (orgId) {
        headers["x-cog-org-id"] = orgId;
    }
    let resp;
    try {
        resp = await devin.post(url, { headers, body: "" });
    }
    catch (exc) {
        log(`   ⚠ mint IDE 登录码请求失败（${String(exc)}），跳过自动登录 IDE。`);
        return "";
    }
    if (resp.status !== 200) {
        const detail = resp.text.slice(0, 200);
        if (resp.status === 401 || resp.status === 403) {
            log(`   ⚠ mint IDE 登录码被拒（${resp.status}）：该账号/组织可能没有 Windsurf/Devin 客户端席位。${detail}`);
        }
        else {
            log(`   ⚠ /api/auth/windsurf/continue 返回 ${resp.status}，拿不到 IDE 登录码。${detail}`);
        }
        return "";
    }
    let data = {};
    try {
        data = JSON.parse(resp.text);
    }
    catch {
        log("   ⚠ /api/auth/windsurf/continue 返回不是 JSON，拿不到 IDE 登录码。");
        return "";
    }
    const code = String(data.code ?? "");
    if (!code) {
        log("   ⚠ /api/auth/windsurf/continue 没返回 code，拿不到 IDE 登录码。");
    }
    return code;
}
// ---- 连 GitHub App 到组织 ----
function installationIdFromUrl(url) {
    let parts;
    try {
        parts = new URL(url);
    }
    catch {
        return "";
    }
    const iid = parts.searchParams.get("installation_id") || "";
    if (/^\d+$/.test(iid)) {
        return iid;
    }
    const segs = parts.pathname.split("/").filter(Boolean);
    const i = segs.indexOf("installations");
    if (i !== -1 && i + 1 < segs.length && /^\d+$/.test(segs[i + 1])) {
        return segs[i + 1];
    }
    return "";
}
/** 日志用：只留 host+path，丢掉可能含签名 state / token 的 query。 */
function safePath(u) {
    try {
        const p = new URL(u);
        return p.host + p.pathname;
    }
    catch {
        return "(无法解析的地址)";
    }
}
function extractInstallationId(resp) {
    const urls = [resp.url];
    for (const h of resp.history) {
        urls.push(h.url);
        if (h.location) {
            urls.push(h.location);
        }
    }
    for (const u of urls) {
        const iid = installationIdFromUrl(u);
        if (iid) {
            return iid;
        }
    }
    return "";
}
/**
 * 诊断用：把页面里所有 <form> 摘成「method action(字段名…)」一行串（只列字段名，绝不带值，安全）。
 * 装 App 提交失败时把它打到日志，就能看清 GitHub 这一页到底给了哪些表单/字段，便于对症。
 */
function formsSummary(html) {
    const forms = (0, forms_1.parseForms)(html);
    if (forms.length === 0) {
        return "(无表单)";
    }
    return forms
        .map((f) => {
        const names = Object.keys(f.inputs).join(",") || "(无字段)";
        return `[${f.method} ${safePath(f.action || "(空action)")} {${names}}]`;
    })
        .join(" ");
}
/** 从 HTML 里抠出所有 <a> 的 href（已反转义）+ 锚文本（去标签），便于按目标名精确匹配。 */
function collectAnchors(html) {
    const out = [];
    const re = /<a\b[^>]*?href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const text = (0, forms_1.htmlUnescape)(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        out.push({ href: (0, forms_1.htmlUnescape)(m[1]), text });
    }
    return out;
}
/**
 * select_target 页：每个可装目标是一个 `…/installations/new/permissions?target_id=…` 链接。
 * 多个目标时按目标名（org / 工作区用户名）在链接周围文本里匹配，匹配不到取第一个。
 */
function pickInstallTargetUrl(html, baseUrl, target) {
    const links = collectAnchors(html).filter((a) => a.href.includes("installations/new/permissions"));
    if (links.length === 0) {
        return "";
    }
    let chosen = links[0];
    const t = (target || "").trim().toLowerCase();
    if (t && links.length > 1) {
        const hit = links.find((a) => a.text.toLowerCase().includes(t) || a.href.toLowerCase().includes(t));
        if (hit) {
            chosen = hit;
        }
    }
    try {
        return new URL(chosen.href, baseUrl).toString();
    }
    catch {
        return "";
    }
}
async function githubConnectionStatus(devin, devinUrl, headers, orgId) {
    const base = stripTrailingSlash(devinUrl);
    let installs = [];
    try {
        const r = await devin.get(base + `/api/${orgId}/integrations/github`, { headers });
        installs = r.status === 200 ? JSON.parse(r.text) : [];
    }
    catch {
        installs = [];
    }
    if (!Array.isArray(installs) || installs.length === 0) {
        return { connected: false, count: 0, name: "" };
    }
    const name = String(installs[0]?.account_name ?? "");
    let count = 0;
    try {
        const rr = await devin.get(base + `/api/${orgId}/integrations/github/repos`, { headers });
        if (rr.status === 200) {
            for (const grp of JSON.parse(rr.text)) {
                count += (grp.gh_repos || []).length;
            }
        }
    }
    catch {
        /* 忽略 */
    }
    return { connected: true, count, name };
}
async function githubSelfAccount(devin, devinUrl, headers) {
    const base = stripTrailingSlash(devinUrl);
    try {
        const r = await devin.get(base + "/api/integrations/github/user", { headers });
        if (r.status === 200) {
            return String(JSON.parse(r.text).github_username || "");
        }
    }
    catch {
        /* 忽略 */
    }
    return "";
}
async function getInstallationUrl(devin, devinUrl, headers, orgId, returnTo) {
    const base = stripTrailingSlash(devinUrl);
    let url = "";
    try {
        const r = await devin.get(base + `/api/${orgId}/integrations/github/installation-url?return_to=${encodeURIComponent(returnTo)}`, { headers });
        url = r.status === 200 ? String(JSON.parse(r.text).url || "") : "";
    }
    catch {
        url = "";
    }
    const state = url ? new URL(url).searchParams.get("state") || "" : "";
    return { url, state };
}
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Devin 的 API 主机（关联回调在 api 主机、无 /api/ 前缀）。 */
function apiBaseFor(devinUrl) {
    try {
        const h = new URL(devinUrl).hostname;
        if (h.endsWith(".devinenterprise.com")) {
            return "https://api.devinenterprise.com";
        }
    }
    catch {
        /* 忽略 */
    }
    return "https://api.devin.ai";
}
/** 精确断开一条 GitHub 连接：DELETE /api/{org}/integrations/github?name=..&host=..（来自真实抓包）。 */
async function deleteConnection(devin, devinUrl, headers, orgId, name, host, log) {
    if (!name) {
        return;
    }
    const url = stripTrailingSlash(devinUrl) +
        `/api/${orgId}/integrations/github?name=${encodeURIComponent(name)}&host=${encodeURIComponent(host)}`;
    try {
        const r = await devin.request("DELETE", url, { headers });
        log(`   · 已断开旧连接「${name}」（HTTP ${r.status}）。`);
    }
    catch (exc) {
        log(`   ⚠ 断开旧连接「${name}」失败（${String(exc)}）。`);
    }
}
// 参考 devin-automation-batch/server.py: protocol_disconnect_github_app
async function disconnectGithubAppAll(devin, devinUrl, headers, orgId, log) {
    const url = stripTrailingSlash(devinUrl) + `/api/${orgId}/integrations/github`;
    try {
        const r = await devin.request("DELETE", url, { headers });
        log(`   · 已调用完整 GitHub App 解绑接口（HTTP ${r.status}）。`);
        return r.status >= 200 && r.status < 300;
    }
    catch (exc) {
        log(`   ⚠ 完整 GitHub App 解绑接口失败（${String(exc)}）。`);
        return false;
    }
}
// 参考 devin-automation-batch/server.py: protocol_disconnect_github_oauth_user
async function disconnectGithubOAuthUser(devin, devinUrl, headers, log) {
    const url = stripTrailingSlash(devinUrl) + "/api/integrations/github/user";
    try {
        const r = await devin.request("DELETE", url, { headers });
        log(`   · 已断开 GitHub OAuth 用户身份（HTTP ${r.status}）。`);
        return r.status >= 200 && r.status < 300;
    }
    catch (exc) {
        log(`   ⚠ 断开 GitHub OAuth 用户身份失败（${String(exc)}）。`);
        return false;
    }
}
async function availableInstallations(devin, devinUrl, headers) {
    const base = stripTrailingSlash(devinUrl);
    let data;
    try {
        const r = await devin.get(base + `/api/integrations/github/available-installations`, { headers });
        if (r.status !== 200) {
            return [];
        }
        data = JSON.parse(r.text);
    }
    catch {
        return [];
    }
    const arr = Array.isArray(data)
        ? data
        : (data?.installations ||
            data?.available_installations ||
            []);
    const out = [];
    for (const it of arr) {
        const o = (it || {});
        const acc = (o.account || o.target || {});
        const id = String(o.id ?? o.installation_id ?? o.app_installation_id ?? "");
        const login = String(o.account_name ?? o.login ?? acc.login ?? acc.account_name ?? acc.name ?? "");
        const alreadyConnected = o.already_connected === true || o.alreadyConnected === true;
        if (id && /^\d+$/.test(id)) {
            out.push({ id, login, alreadyConnected });
        }
    }
    return out;
}
/**
 * 从 available-installations 里挑「目标账号、且还没被别的 Devin 账号占用」的那个安装 id。
 *  优先：account_name==target 且 already_connected==false（空闲可连，正是我们要的）。
 *  次选：account_name==target（即使 already_connected——可能就是连到本 org 的，关联会幂等）。
 *  返回 {id, occupied}：occupied=true 表示目标安装已被占用（already_connected），需先在占用它的账号断开。
 *
 *  ⚠ 只按「登录名==目标名 / ==工作区用户名」匹配。**绝不**因为「列表里只有一条」就拿它顶替——
 *    那条很可能是工作区账号作为成员能看到的【别的 org / 别人】的安装（如 LandT001），
 *    连上去就是连错账号。匹配不到宁可返回 undefined（提示去装目标账号自己的 App）。
 */
function pickInstallForTarget(avail, target, ident) {
    const want = (s) => s && s.toLowerCase();
    const t = want(target);
    const id2 = want(ident);
    const free = avail.find((a) => t && want(a.login) === t && !a.alreadyConnected) ||
        avail.find((a) => id2 && want(a.login) === id2 && !a.alreadyConnected);
    if (free) {
        return { id: free.id, occupied: false };
    }
    const taken = avail.find((a) => t && want(a.login) === t) ||
        avail.find((a) => id2 && want(a.login) === id2);
    if (taken) {
        return { id: taken.id, occupied: true };
    }
    return undefined;
}
/**
 * 用 gh（工作区账号的 github.com 会话）走 GitHub 的 OAuth authorize，在 github.com 内部
 * 跟随跳转、必要时提交首次同意页（authorize=1），直到拿到那条【跨站跳去 api.devin.ai 的
 * oauth-callback?code=…】URL 为止——【不让 gh 跟进 api 主机】，要把这条带一次性 code 的
 * URL 交给 Devin 会话去打（抓包显示这条回调是带 devin.ai 会话发的）。返回 callback URL；
 * 走不到（停在登录/设备验证/同意页）则返回 ""。
 */
async function followGithubAuthToCallback(gh, startUrl, log, gate) {
    let url = startUrl;
    for (let i = 0; i < 10; i++) {
        checkStop(gate);
        let resp;
        try {
            resp = await gh.get(url, { followRedirects: false });
        }
        catch (exc) {
            log(`   ⚠ 打开 GitHub 授权页失败（${String(exc)}）。`);
            return "";
        }
        // 只认【真正的登录页】：path 恰好是 /login 或 /session*。注意 authorize 地址本身就是
        //  github.com/login/oauth/authorize（路径天生带 /login），绝不能拿 includes("/login") 判，
        //  否则一上来就误判「要求重登」——这正是之前身份切换一直失败的根因。
        let curPath = "";
        try {
            curPath = new URL(resp.url).pathname;
        }
        catch {
            curPath = "";
        }
        const isLoginPage = curPath === "/login" || curPath.startsWith("/session");
        if (isLoginPage || hasLoginForm(resp.text) || looksLikeDeviceVerification(resp.text, resp.url)) {
            log("   ⚠ 连身份时 GitHub 要求重新登录/设备验证，纯 API 过不去。");
            log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
            return "";
        }
        const loc = resp.headers["location"] || "";
        if (resp.status >= 300 && resp.status < 400 && loc) {
            const next = new URL(loc, resp.url).toString();
            if (!new URL(next).hostname.endsWith("github.com")) {
                return next; // 跨到 api.devin.ai 的 oauth-callback（含 code）
            }
            url = next;
            continue;
        }
        // 200：可能是首次授权同意页（authorize 默认 0，要显式改 1 才算点了「Authorize」）。
        const consent = (0, forms_1.findForm)(resp.text, { actionContains: "/login/oauth/authorize" });
        if (consent && "authorize" in consent.inputs) {
            const fields = { ...consent.inputs };
            fields["authorize"] = "1";
            const action = new URL(consent.action, resp.url).toString();
            let pr;
            try {
                pr = await gh.post(action, { form: fields, followRedirects: false });
            }
            catch (exc) {
                log(`   ⚠ 提交连身份同意页失败（${String(exc)}）。`);
                return "";
            }
            const loc2 = pr.headers["location"] || "";
            if (loc2) {
                const next = new URL(loc2, action).toString();
                if (!new URL(next).hostname.endsWith("github.com")) {
                    return next;
                }
                url = next;
                continue;
            }
            if (!new URL(pr.url).hostname.endsWith("github.com")) {
                return pr.url;
            }
            url = pr.url;
            continue;
        }
        // 既不是跳转、也不是同意页——走不动了。
        return "";
    }
    return "";
}
async function connectUserIdentity(devin, gh, devinUrl, headers, log, gate) {
    const base = stripTrailingSlash(devinUrl);
    // 先读一次「当前连接身份」，用于判断有没有切成、以及重试时对照。
    const before = await githubSelfAccount(devin, devinUrl, headers).catch(() => "");
    // [1.5] oauth-callback 服务端偶发慢 → 最多试 3 次（从 2 次增加），每次换新 code。
    const MAX_ATTEMPTS = 3;
    let after = before;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
        checkStop(gate);
        const oauthRes = await devin
            .get(base + `/api/integrations/github/start-user-oauth?return_to=${encodeURIComponent("/")}`, { headers })
            .catch(() => null);
        let authorizeUrl = "";
        try {
            authorizeUrl = oauthRes && oauthRes.status === 200 ? String(JSON.parse(oauthRes.text).url || "") : "";
        }
        catch {
            authorizeUrl = "";
        }
        if (!authorizeUrl) {
            log("   ⚠ 没拿到 start-user-oauth 授权地址，跳过连身份。");
            break;
        }
        if (attempt === 1) {
            log(`→ 连 GitHub 身份：用工作区会话走 start-user-oauth（当前连的是 ${before || "(无)"}）…`);
        }
        else {
            log(`   · 连身份重试（第 ${attempt} 次）：重新取一次性 code 再打一次 oauth-callback …`);
        }
        // 用工作区账号的 github.com 会话走 authorize（必要时点同意页），但【不让 gh 跟进到
        //  api.devin.ai】——截下那条带一次性 code 的 oauth-callback URL。
        const cbUrl = await followGithubAuthToCallback(gh, authorizeUrl, log, gate);
        if (!cbUrl) {
            log("   ⚠ 没走到 GitHub→Devin 的 oauth-callback（身份未切换）。");
            continue;
        }
        // ★关键：用【Devin 客户端】（带当前账号会话 + Bearer + 签名 state）去打 oauth-callback，
        //   而不是 gh 客户端。这条服务端就慢，单独放宽超时，避免「其实成功只是慢」被 30s 掐成超时。
        try {
            const cb = await devin.get(cbUrl, { headers, timeoutMs: SLOW_CALLBACK_TIMEOUT_MS });
            ok = cb.status >= 200 && cb.status < 400;
        }
        catch (exc) {
            log(`   ⚠ 用 Devin 会话打 oauth-callback 失败（${String(exc)}）。`);
            ok = false;
        }
        after = await githubSelfAccount(devin, devinUrl, headers).catch(() => after);
    }
    if (ok && after && after.toLowerCase() !== (before || "").toLowerCase()) {
        log(`   ✔ 已把连接身份切换为：${after}`);
    }
    else if (ok && after) {
        log(`   · 连身份完成，当前身份：${after}`);
    }
    else if (after) {
        log(`   ⚠ 连身份未成功（oauth-callback 失败/超时），当前身份仍是：${after}`);
    }
    else {
        log("   ⚠ 连身份后没读到 GitHub 身份。");
    }
    return { identity: after, ok };
}
/**
 * github.com 的「Installed GitHub Apps」配置页里那个「Uninstall」表单：POST + 隐藏字段
 * `_method=delete`，action 形如 `/settings/installations/<id>`。挑出它用来卸载。
 */
function findUninstallForm(html) {
    const form = (0, forms_1.parseForms)(html).find((f) => "authenticity_token" in f.inputs &&
        String(f.inputs["_method"] ?? "").toLowerCase() === "delete" &&
        /\/settings\/installations\/\d+/.test(f.action));
    return form ? { action: form.action, inputs: form.inputs } : null;
}
/**
 * 选 github.com「已安装 App」列表页路径。组织名留空、或恰好等于工作区账号用户名时，
 * 它其实是【个人账号】而不是真实组织（GitHub 用户名与组织名共用同一命名空间，不会重名）——
 * 个人账号的安装在 `/settings/installations`，根本没有 `/organizations/<user>/...` 这个页面。
 * 之前组织留空会被默认成用户名，导致卸载误查 org 路径、找不到、把个人账号下的 Devin App 漏卸掉。
 */
function installationsListPath(org, wsUsername) {
    const orgSlug = (org || "").trim();
    const user = (wsUsername || "").trim();
    const isPersonal = orgSlug === "" || orgSlug.toLowerCase() === user.toLowerCase();
    return isPersonal ? "/settings/installations" : `/organizations/${encodeURIComponent(orgSlug)}/settings/installations`;
}
/**
 * 换登「第 1 步」：把「工作区账号」github.com 上已安装的 Devin GitHub App 卸掉，
 * 保证后面是一次干净重装——避免「安装被另一个 Devin 账号占用 / 旧的死安装」导致连组织失败
 * （这正是用户之前要手动到 GitHub→Settings→Applications 卸「Devin.ai Integrate」的那一步）。
 *
 * 要求 gh 已是该工作区账号【已登录】的 github.com 会话。best-effort：失败只记日志，不抛、不阻断换登。
 * 返回成功卸掉的安装条数。
 */
async function uninstallDevinAppOnGithub(gh, creds, org, log, gate) {
    let removed = 0;
    // 真实组织 → 卸该 org 的 Devin App（org 级安装页）；组织留空或等于工作区账号用户名
    // → 其实是个人账号，卸个人名下的 applications（否则会查到不存在的 org 页而漏卸）。
    const orgSlug = (org || "").trim();
    const wsUser = (creds?.username || "").trim();
    const listPath = installationsListPath(orgSlug, wsUser);
    const isPersonal = listPath === "/settings/installations";
    const listPathNorm = listPath.replace(/\/+$/, "");
    const where = isPersonal ? `个人账号${wsUser ? `「${wsUser}」` : ""}` : `组织「${orgSlug}」`;
    try {
        checkStop(gate);
        const list = await gh.get(GITHUB_BASE + listPath);
        if (list.url.includes("/login") || hasLoginForm(list.text)) {
            log("   ⚠ 卸载 Devin App：github.com 未登录，跳过（不阻断后续）。");
            return 0;
        }
        // 每个已装 App 一条「Configure」链接（个人：/settings/installations/<id>；
        // 组织：/organizations/<org>/settings/installations/<id>）。收集完整 href，
        // 配置页与卸载表单的真实 action 都按页面实际返回的链接走，不写死路径。
        const configHrefs = new Map();
        for (const a of collectAnchors(list.text)) {
            const mm = a.href.match(/\/settings\/installations\/(\d+)(?:[/?#]|$)/);
            if (mm) {
                configHrefs.set(mm[1], a.href);
            }
        }
        if (configHrefs.size === 0) {
            log(`   · 卸载 Devin App：${where}没有已安装的 GitHub App，跳过。`);
            return 0;
        }
        for (const [id, href] of configHrefs) {
            checkStop(gate);
            let pg;
            try {
                pg = await gh.get(new URL(href, GITHUB_BASE).toString());
            }
            catch (exc) {
                log(`   ⚠ 打开安装配置页 #${id} 失败（${String(exc)}），跳过该条。`);
                continue;
            }
            // 只卸 Devin：配置页正文里必须出现 devin（应用名 / slug），避免误卸其它 App。
            if (!/devin/i.test(pg.text)) {
                continue;
            }
            const form = findUninstallForm(pg.text);
            if (!form) {
                log(`   · 安装 #${id} 像是 Devin 但没解析到卸载表单：${formsSummary(pg.text)}`);
                continue;
            }
            log(`→ 卸载${where}的 Devin GitHub App（installation #${id}）…`);
            let posted;
            try {
                posted = await gh.post(new URL(form.action, pg.url).toString(), { form: { ...form.inputs } });
            }
            catch (exc) {
                log(`   ⚠ 提交卸载 #${id} 失败（${String(exc)}），跳过该条。`);
                continue;
            }
            // 卸载常要 GitHub sudo 二次确认：用工作区凭据自动过，过后若还在卸载页则再提交一次。
            if (pageLooksLikeSudo(posted.text, posted.url)) {
                posted = await completeSudo(gh, creds, posted, log, gate);
                const again = findUninstallForm(posted.text);
                if (again && !pageLooksLikeSudo(posted.text, posted.url)) {
                    try {
                        posted = await gh.post(new URL(again.action, posted.url).toString(), { form: { ...again.inputs } });
                    }
                    catch {
                        /* 忽略，下面统一校验 */
                    }
                }
            }
            // 成功标志（已对真实 github.com 实测）：卸载是「异步排队」——提交后 302 回
            // 安装列表页并带「A job has been queued to uninstall …」的 flash，但此刻列表里
            // 往往仍显示该 App。所以不能靠「列表里没了」判断，而是看是否跳回列表页（个人或
            // 组织级，且不再停在 sudo 页）。
            let landedBack = false;
            try {
                landedBack = new URL(posted.url).pathname.replace(/\/+$/, "") === listPathNorm;
            }
            catch {
                landedBack = false;
            }
            const queued = /queued to uninstall|uninstalled/i.test(posted.text);
            if (!pageLooksLikeSudo(posted.text, posted.url) && (landedBack || queued)) {
                removed += 1;
                log(`   ✔ 已提交卸载${where}的 Devin GitHub App（installation #${id}，GitHub 异步处理）。`);
                // [1.3 修复] 等待 GitHub 异步卸载生效（实测 2-5 秒）
                await sleep(3000);
            }
            else {
                log(`   ⚠ 卸载 Devin App #${id} 未确认成功（可能要手动到 github.com→Settings→Applications 卸载）：${formsSummary(posted.text)}`);
            }
        }
    }
    catch (exc) {
        if (exc instanceof types_1.StopRequested) {
            throw exc;
        }
        log(`   ⚠ 卸载${where}的 Devin App 异常（${String(exc)}），继续换登（不阻断）。`);
    }
    return removed;
}
async function connectGithubApp(devin, gh, devinUrl, token, orgId, orgName, log, gate, 
// 装 App 提交后 GitHub 可能要 sudo 二次确认；用「当前 github.com 会话所属账号」的凭据来完成。
connectCreds) {
    if (!token || !orgId) {
        log("   ⚠ 缺 token/org_id，跳过连 GitHub 组织这步。");
        return { connected: false, count: 0, name: "" };
    }
    const headers = {
        authorization: `Bearer ${token}`,
        "x-cog-org-id": orgId,
        accept: "application/json",
    };
    // 连组织这步的细分耗时打点：定位 18s 到底花在「切身份 OAuth / 查可用安装 / 装 App 页面 / 关联回调」哪一段。
    let tcPrev = Date.now();
    const markC = (label) => {
        const now = Date.now();
        log(`     ⏱ [连组织] ${label}：${now - tcPrev}ms`);
        tcPrev = now;
    };
    // 连接目标：组织名为空 / "-" 时退回「GitHub 用户名对应的账号」。
    let target = (orgName || "").trim();
    if (target === "" || target === "-") {
        target = (await githubSelfAccount(devin, devinUrl, headers)) || target;
    }
    const ret = target ? `/org/${target}/settings/integrations/github` : "/settings";
    let { connected, count, name } = await githubConnectionStatus(devin, devinUrl, headers, orgId);
    let currentOauthUser = await githubSelfAccount(devin, devinUrl, headers).catch(() => "");
    if (connected) {
        if (target && name && name.toLowerCase() === target.toLowerCase()) {
            if (currentOauthUser && target && currentOauthUser.toLowerCase() !== target.toLowerCase()) {
                log(`   · GitHub App 已是目标「${name}」，但 OAuth 身份还是「${currentOauthUser}」，先断 OAuth 后重新连身份。`);
                await disconnectGithubOAuthUser(devin, devinUrl, headers, log);
            }
            else {
                log(`   ✔ 已连的就是目标「${name}」，可见 ${count} 个仓库，跳过。`);
                return { connected, count, name };
            }
        }
        else {
            // 新账号登录后自带的旧连接（≠ 目标工作区账号）：先断开释放，再连工作区账号。
            log(`   · 新账号当前连着「${name || "?"}」，不是工作区 GitHub「${target || "?"}」，先解绑再重绑 …`);
            await deleteConnection(devin, devinUrl, headers, orgId, name, "github.com", log);
            // 参考原源码的完整解绑接口，兜底清掉 metadata / app association。
            await disconnectGithubAppAll(devin, devinUrl, headers, orgId, log);
            if (currentOauthUser && target && currentOauthUser.toLowerCase() !== target.toLowerCase()) {
                await disconnectGithubOAuthUser(devin, devinUrl, headers, log);
            }
            connected = false;
            count = 0;
            name = "";
        }
    }
    else if (currentOauthUser && target && currentOauthUser.toLowerCase() !== target.toLowerCase()) {
        log(`   · 当前 GitHub OAuth 身份「${currentOauthUser}」不是工作区 GitHub「${target}」，先断 OAuth 后重新连身份。`);
        await disconnectGithubOAuthUser(devin, devinUrl, headers, log);
    }
    // 「安装地址 + 签名 state」只按 org 取、不依赖「当前连接身份」→ 提前发出去，与下面耗时最久的
    //   「切连接身份 OAuth」重叠跑（getInstallationUrl 内部已 try/catch 不会抛），省一个串行往返。
    const installInfoP = getInstallationUrl(devin, devinUrl, headers, orgId, ret);
    // ★关键：先把「当前 Devin 账号连接的 GitHub 身份」切成工作区账号，否则后面装的 App
    //   不属于当前连接身份，会被判「无权访问」（之前一直卡在这）。
    const { identity: ident, ok: identOk } = await connectUserIdentity(devin, gh, devinUrl, headers, log, gate);
    if (ident && target && ident.toLowerCase() !== target.toLowerCase()) {
        log(`   · 注意：连上的身份是「${ident}」，与目标名「${target}」不同（以工作区账号实际登录的 GitHub 为准）。`);
    }
    markC("切连接身份 OAuth");
    // 优先用 Devin 自己的「可用安装」列表拿当前有效的 installation_id（webapp 就是这么做的）。
    //   复用从 GitHub 页面抠的旧 id 会拿到「死」安装，被判「无权访问」——这是之前的根因之一。
    const fmtAvail = (xs) => xs.length ? xs.map((a) => `${a.login || "?"}#${a.id}${a.alreadyConnected ? "(已占用)" : ""}`).join(", ") : "(空)";
    let instId = "";
    // 「可用安装」取决于刚切好的连接身份，必须切完再查；「安装地址」已在切身份时并行预取，这里收口。
    const [availFirst, installInfo] = await Promise.all([
        availableInstallations(devin, devinUrl, headers),
        installInfoP,
    ]);
    {
        log(`   · 可用安装（available-installations）：${fmtAvail(availFirst)}`);
        const pick = pickInstallForTarget(availFirst, target, ident);
        if (pick && !pick.occupied) {
            instId = pick.id;
            log(`   · 选用 installation_id=${instId}（来自 available-installations，账号「${target || ident}」，空闲可连）。`);
        }
        else if (pick && pick.occupied) {
            // [1.3 修复] 直接用 installation-callback "抢绑"，不走网页重装
            // connectMoveProbe.js 已验证：occupied 的安装可被新组织的 callback 直接抢走
            instId = pick.id;
            log(`   · [移动绑定] 目标账号「${target || ident}」的安装(#${pick.id})被另一个 Devin 组织占用，` +
                `直接用 installation-callback 抢绑（不卸载、不走 GitHub 网页）。`);
        }
    }
    // 安装地址 + 签名 state（拿不到现成 id 时，要用工作区会话走 GitHub 真装一遍来创建/拿 id）。
    const { url: installUrl, state } = installInfo;
    markC("查可用安装 + 取安装地址（并行）");
    // ★身份没真正切成（oauth-callback 失败/超时）且没有现成可用安装时：若硬走 GitHub 真装一遍，
    //   会在工作区账号留下一个【当前错误身份读不回来】的「垃圾」安装（之前那个 #139105008 就是这么来的），
    //   还会误报「连组织成功/失败」。这里直接不装、明确报错让用户重试（多为服务端临时慢，重试即好）。
    if (!instId && !identOk) {
        log("   ⚠ 连身份没成功（oauth-callback 失败/超时），且可用安装里没有现成的目标安装。");
            log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
        return { connected: false, count: 0, name: "" };
    }
    // 用已登录的 GitHub 会话打开安装页（仅当还没有现成 installation_id 时）。
    if (!instId && installUrl) {
        let pg;
        try {
            pg = await gh.get(installUrl);
        }
        catch (exc) {
            log(`   ⚠ 打开 GitHub App 安装页失败（${String(exc)}）。`);
            log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
            return { connected: false, count: 0, name: "" };
        }
        if (pg.url.includes("/login") || looksLikeDeviceVerification(pg.text, pg.url)) {
            log("   ⚠ 连组织时 GitHub 要求重新登录/设备验证，纯 API 过不去。");
            log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
            return { connected: false, count: 0, name: "" };
        }
        if (pageLooksLikeSudo(pg.text, pg.url)) {
            // 进安装页就被要 sudo：先用工作区凭据确认一次，过了再继续装；过不去才放弃。
            pg = await completeSudo(gh, connectCreds, pg, log, gate);
            if (pageLooksLikeSudo(pg.text, pg.url)) {
                log("   ⚠ 连组织时 GitHub 要求 sudo 二次确认且自动确认未通过。");
            log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
                return { connected: false, count: 0, name: "" };
            }
        }
        // 全新工作区账号首次连 Devin：安装页前可能先要一步 OAuth 授权（Authorize Devin）。先把它点掉。
        const authForm = (0, forms_1.findForm)(pg.text, { actionContains: "/login/oauth/authorize" });
        if (authForm && "authenticity_token" in authForm.inputs) {
            const action = new URL(authForm.action, pg.url).toString();
            try {
                pg = await gh.post(action, { form: { ...authForm.inputs } });
            }
            catch (exc) {
                log(`   ⚠ 提交 GitHub OAuth 授权失败（${String(exc)}），继续尝试安装。`);
            }
        }
        // 选目标页（select_target）：GitHub 先问「把 App 装到哪个账号」，这页上没有安装表单。
        //  ★不再复用页面里抠的旧 installation_id——旧 id 是「死」的，拿去关联必被判「无权访问」。
        //   有效 id 一律来自 available-installations（身份切对后会有）或这次真装产生的新 id。
        if (!(0, forms_1.findForm)(pg.text, { actionContains: "/installations" })) {
            const permUrl = pickInstallTargetUrl(pg.text, pg.url, target);
            if (permUrl) {
                try {
                    pg = await gh.get(permUrl);
                }
                catch (exc) {
                    log(`   ⚠ 打开权限确认页失败（${String(exc)}），跳过连组织。`);
                    return { connected: false, count: 0, name: "" };
                }
            }
            else {
                log("   · 选目标页没有「新装」目标链接（该账号可能已装过 App）；有效 installation 应由 available-installations 提供，不复用页面旧 id。");
            }
        }
        // 提交安装/配置表单（装到全部仓库），并从「提交后的跳转链」里抓 installation_id。
        if (!instId) {
            const form = (0, forms_1.findForm)(pg.text, { actionContains: "/installations" });
            if (form && "authenticity_token" in form.inputs) {
                const fields = { ...form.inputs };
                fields["install_target"] = "all";
                delete fields["repository_ids[]"];
                const action = new URL(form.action, pg.url).toString();
                try {
                    let posted = await gh.post(action, { form: fields });
                    instId = extractInstallationId(posted);
                    // ★实测根因：提交安装后 GitHub 返回「sudo 二次确认」页（sudo_app_otp / sudo_password），
                    //   安装并未真正创建。这些 sudo 表单带着安装上下文，确认通过即同时完成安装。
                    if (!instId && pageLooksLikeSudo(posted.text, posted.url)) {
                        posted = await completeSudo(gh, connectCreds, posted, log, gate);
                        instId = extractInstallationId(posted);
                        log(`   · sudo 确认后落到：${safePath(posted.url)}${instId ? `（installation_id=${instId}）` : "（未见 installation_id，下面会重查 available）"}`);
                    }
                }
                catch (exc) {
                    log(`   ⚠ 提交 GitHub App 安装失败（${String(exc)}），跳过连组织。`);
                    return { connected: false, count: 0, name: "" };
                }
            }
            else {
                log(`   · 安装页未匹配到安装表单（${form ? "表单缺 authenticity_token" : "没有 action 含 /installations 的表单"}）；可在 github.com 手动点「Install」。`);
            }
        }
        // 兜底（不发网络）：从当前安装页里直接抠 installation_id（已装过时会落到 /settings/installations/{id}）。
        //   抠不到也无妨——下面会统一用 available-installations 重查（更可靠，且 webapp 就这么做）。
        if (!instId) {
            instId = extractInstallationId(pg);
        }
    } // ← 结束「没有现成 installation_id 时才走 GitHub 安装」分支
    markC("装 App 页面（含取安装地址）");
    // ★关键修复：真装一遍后，GitHub 那条提交跳转里常常抠不到 installation_id（落到 /installations
    //   又跳回 select_target）。但此刻 Devin 的 available-installations 里已经多出这个【新鲜】安装了
    //   ——webapp 正是靠它拿 id。所以装完一律【重查 available】，挑「目标账号且未占用」的新 id。
    if (!instId) {
        // GitHub 刚装完，Devin 的 available-installations 可能有几百毫秒延迟才出现新安装 ——
        // 重查最多 3 次（短退避），避免「装上了但立刻查不到 → 误判没装」。
        for (let attempt = 0; attempt < 3 && !instId; attempt++) {
            if (attempt > 0) {
                await sleep(700);
            }
            const avail2 = await availableInstallations(devin, devinUrl, headers);
            const pick2 = pickInstallForTarget(avail2, target, ident);
            if (pick2) {
                instId = pick2.id;
                log(`   · 装完从 available 选用 installation_id=${instId}（账号「${target || ident}」${pick2.occupied ? "，注意 already_connected" : "，空闲可连"}）。`);
            }
        }
    }
    markC("装完重查可用安装");
    if (!instId) {
        log("   ⚠ 没能确认 GitHub 安装 ID，跳过关联。登录不受影响。");
        log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
        return { connected: false, count: 0, name: "" };
    }
    // 3) 把这次安装挂到当前 Devin 组织：用 Bearer + 签名 state 打 installation-callback。
    //   step2 实测一次即成（307→已连）。所以先复用前面已取的 state 打一次、命中即停；
    //   没中再补取新鲜 state 重试两次（短间隔），不再做 8 次长轮询。
    connected = false;
    count = 0;
    for (let attempt = 0; attempt < 3 && !connected; attempt++) {
        const cbState = attempt === 0 && state ? state : (await getInstallationUrl(devin, devinUrl, headers, orgId, ret)).state;
        if (cbState) {
            try {
                // 关联在 api 主机、无 /api/ 前缀、参数 state+installation_id（来自真实抓包）。
                //   这条回调服务端也偏慢，单独放宽超时，避免「其实关联成功只是慢」被 30s 掐断。
                await devin.get(apiBaseFor(devinUrl) +
                    `/integrations/github/installation-callback?state=${encodeURIComponent(cbState)}` +
                    `&installation_id=${encodeURIComponent(instId)}`, { headers, timeoutMs: SLOW_CALLBACK_TIMEOUT_MS });
            }
            catch (exc) {
                log(`   ⚠ 关联 GitHub 安装到组织时请求失败（${String(exc)}）。`);
            }
        }
        const status = await githubConnectionStatus(devin, devinUrl, headers, orgId);
        connected = status.connected;
        count = status.count;
        name = status.name || name;
        if (!connected && attempt < 2) {
            await sleep(400);
        }
    }
    markC("关联回调到组织");
    if (connected) {
        log(`   ✔ 已连 GitHub 组织（装好 Devin App），可访问 ${count} 个仓库。`);
    }
    else {
        log("   ⚠ 连 GitHub 组织没完全成功，登录本身不受影响。");
        log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
    }
    return { connected, count, name };
}
async function oauthAndExchange(devin, gh, account, devinUrl, clientId, mode, log, gate) {
    const { verifier, challenge } = makePkce();
    const state = "auth1-" + crypto.randomUUID();
    const authorizeUrl = `${GITHUB_BASE}/login/oauth/authorize?client_id=${clientId}` +
        `&redirect_uri=${devinUrl}/auth/callback&scope=${OAUTH_SCOPE}` +
        `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
    const code = await githubLogin(gh, account, authorizeUrl, log, gate);
    return exchangeCode(devin, devinUrl, code, verifier, mode);
}
/**
 * 把 Devin 的 GitHub App 从指定 org 卸掉（断连）。换登第 1 步用：拿上次换登落盘的
 * 旧号会话（token + orgId）做两件事——
 *   1) GET    /api/{org}/integrations/github                       列出该 org 的 GitHub 连接
 *   2) 逐条   DELETE /api/{org}/integrations/github?name=..&host=..   卸掉 Devin 的 GitHub App
 * （接口/参数来自真实抓包：name = 连接的 account_name，host 一般是 github.com。）
 * 不抛异常；任何失败收进 error，调用方按 best-effort 处理、不阻断后续登录。
 */
async function disconnectGithubFromOrg(options) {
    const log = options.log || (() => { });
    const devinUrl = stripTrailingSlash(options.devinUrl || exports.DEFAULT_DEVIN_URL);
    const token = (options.token || "").trim();
    const orgId = (options.orgId || "").trim();
    const res = { removed: 0, ok: true, error: "" };
    if (!token || !orgId) {
        log("   · 没有上一个会话（token/org 为空），无需断连，跳过。");
        return res;
    }
    const devin = new http_1.HttpClient({
        proxy: options.proxy,
        verify: options.verify,
        timeoutMs: options.timeoutMs,
        headers: { "user-agent": BROWSER_UA, origin: devinUrl },
    });
    const headers = {
        authorization: `Bearer ${token}`,
        "x-cog-org-id": orgId,
        accept: "*/*",
    };
    // 1) 列出旧 org 的 GitHub 连接。
    let installs = [];
    try {
        const r = await devin.get(devinUrl + `/api/${orgId}/integrations/github`, { headers });
        if (r.status !== 200) {
            log(`   ⚠ 读取旧组织的 GitHub 连接返回 ${r.status}，跳过断连（不影响后续登录）。`);
            res.ok = false;
            res.error = `list ${r.status}`;
            devin.dispose();
            return res;
        }
        const parsed = JSON.parse(r.text);
        if (Array.isArray(parsed)) {
            installs = parsed;
        }
    }
    catch (exc) {
        log(`   ⚠ 读取旧组织的 GitHub 连接失败（${String(exc)}），跳过断连。`);
        res.ok = false;
        res.error = String(exc);
        devin.dispose();
        return res;
    }
    if (installs.length === 0) {
        log("   · 旧组织当前没有 GitHub 连接，无需断连。");
        devin.dispose();
        return res;
    }
    // 只断「上一次工作区账号」那一条：按 account_name 精确（大小写不敏感）筛。
    const only = (options.onlyName || "").trim().toLowerCase();
    if (only) {
        const before = installs.length;
        installs = installs.filter((inst) => String(inst.account_name ?? "").trim().toLowerCase() === only);
        if (installs.length === 0) {
            log(`   · 没找到上一次工作区账号「${options.onlyName}」的连接（共 ${before} 条，均不匹配），无需断连。`);
            devin.dispose();
            return res;
        }
    }
    // 2) 逐条卸载。
    for (const inst of installs) {
        const name = String(inst.account_name ?? "");
        const host = String(inst.host ?? "github.com") || "github.com";
        if (!name) {
            continue;
        }
        const url = devinUrl +
            `/api/${orgId}/integrations/github?name=${encodeURIComponent(name)}&host=${encodeURIComponent(host)}`;
        try {
            const r = await devin.request("DELETE", url, { headers });
            if (r.status >= 200 && r.status < 300) {
                res.removed += 1;
                log(`   ✔ 已卸掉旧组织的 Devin GitHub App：${name}@${host}`);
            }
            else {
                log(`   ⚠ 卸载 ${name}@${host} 返回 ${r.status}：${r.text.slice(0, 160)}`);
                res.ok = false;
                res.error = `delete ${r.status}`;
            }
        }
        catch (exc) {
            log(`   ⚠ 卸载 ${name}@${host} 失败：${String(exc)}`);
            res.ok = false;
            res.error = String(exc);
        }
    }
    devin.dispose();
    return res;
}
/**
 * 纯 API 用一个 GitHub 账号登录 Devin。不抛异常（被 stop 时 error="stopped"）：
 * 任何失败收进 result.error + result.stage，success=false。
 */
async function loginDevinWithGithubApi(account, options = {}) {
    const log = options.log || (() => { });
    const devinUrl = stripTrailingSlash(options.devinUrl || exports.DEFAULT_DEVIN_URL);
    const allowSignup = options.allowSignup !== false;
    const connectGithub = options.connectGithub !== false;
    const gate = options.gate;
    const result = emptyResult();
    // 每步耗时打点：定位换登慢在哪（OAuth 往返 / 装 App / 关联回调）。只记日志，不改逻辑。
    const t0 = Date.now();
    let tPrev = t0;
    const mark = (label) => {
        const now = Date.now();
        log(`   ⏱ ${label}：${now - tPrev}ms（累计 ${now - t0}ms）`);
        tPrev = now;
    };
    if (!account.username || !account.password) {
        result.stage = "校验";
        result.error = "GitHub 用户名或密码为空";
        return result;
    }
    // Devin 与 GitHub 各用一个 client：cookie / 默认头互不干扰。
    const clientOpts = { proxy: options.proxy, verify: options.verify, timeoutMs: options.timeoutMs };
    const devin = new http_1.HttpClient({
        ...clientOpts,
        headers: { "user-agent": BROWSER_UA, origin: devinUrl, referer: devinUrl + "/auth/login" },
    });
    const gh = new http_1.HttpClient({ ...clientOpts, headers: BROWSER_HEADERS });
    let gh2;
    let workspaceUsername;
    // 「工作区账号 github.com 登录 + 卸掉其上 Devin App」的并行预处理（换登第 1 步）。
    let wsPrep = null;
    // 登录账号：登录前灌入上次落盘的 github.com cookie，命中则免账密+2FA。
    const seedCookies = options.seedGithubCookies || {};
    const loginSeed = seedCookies[cookieKey(account.username)];
    if (loginSeed && loginSeed.length > 0) {
        gh.jar.setCookies(GITHUB_BASE + "/", loginSeed);
    }
    // 工作区账号（要把 App 装到它名下 org 的 GitHub 账号）：与登录账号不同时启用两账号流程。
    const ws = options.connectAsAccount;
    const useWorkspace = !!(ws && ws.username && ws.username.trim() && ws.username.trim() !== account.username.trim());
    try {
        checkStop(gate);
        // ★换登第 1 步（与下面的 Devin 登录【并行】跑，不再干等）：用工作区账号登录 github.com，
        //   并把它上面已装的 Devin GitHub App 先卸掉，保证后面是一次干净重装。
        result.stage = "connections";
        let data;
        let loginOk = false;
        try {
            log(`→ 尝试使用 Devin 邮箱账密登录 Devin: ${account.username} …`);
            const connUrl = stripTrailingSlash(devinUrl) + "/api/auth1/connections";
            const connResp = await devin.post(connUrl, {
                headers: { "content-type": "application/json" },
                json: { product: "devin", email: account.username }
            });
            if (connResp.status === 200) {
                const authUrl = stripTrailingSlash(devinUrl) + "/api/auth1/password/login";
                const loginResp = await devin.post(authUrl, {
                    headers: { "content-type": "application/json" },
                    json: { email: account.username, password: account.password }
                });
                if (loginResp.status === 200) {
                    const loginData = JSON.parse(loginResp.text);
                    if (loginData.token) {
                        data = {
                            token: loginData.token,
                            user_id: loginData.user_id || "",
                            email: account.username,
                            is_new_user: false
                        };
                        loginOk = true;
                        log(`✔ Devin 邮箱账密登录成功！`);
                    }
                } else {
                    log(`   · Devin 邮箱账密登录返回 ${loginResp.status}，将尝试通过 GitHub OAuth 登录方式 …`);
                }
            } else {
                log(`   · Devin connections 接口返回 ${connResp.status}，将尝试通过 GitHub OAuth 登录方式 …`);
            }
        }
        catch (exc) {
            log(`   · Devin 邮箱账密登录遇到异常（${String(exc)}），将尝试通过 GitHub OAuth 登录方式 …`);
        }

        if (!loginOk) {
            const clientId = await fetchGithubClientId(devin, devinUrl, log);
            mark("取 client_id");
            result.stage = "github-oauth";
            try {
                data = await oauthAndExchange(devin, gh, account, devinUrl, clientId, "login", log, gate);
            }
            catch (exc) {
                if (!(exc instanceof DevinAccountNotFoundError) || !allowSignup) {
                    throw exc;
                }
                log("→ 该 GitHub 号在 Devin 还没账号，自动改用注册(signup)流程重试 …");
                result.stage = "signup";
                data = await oauthAndExchange(devin, gh, account, devinUrl, clientId, "signup", log, gate);
                result.isNewUser = true;
            }
            mark("GitHub OAuth + 换 token");
        }
        result.stage = "exchange";
        result.token = String(data.token ?? "");
        result.userId = String(data.user_id ?? "");
        result.email = String(data.email ?? "");
        result.isNewUser = result.isNewUser || Boolean(data.is_new_user);
        result.stage = "verify";
        const v = await verifyToken(devin, devinUrl, result.token, log);
        result.orgId = v.orgId;
        result.orgName = v.orgName;
        if (!v.ok) {
            result.error = "拿到了 token 但验证登录态失败";
            return result;
        }
        mark("验证 token");
        if (connectGithub) {
            result.stage = "connect-github";
            // 连接目标 org：显式组织名 > 工作区账号用户名 > 登录账号落地的 org。
            let targetOrg = (options.orgName || "").trim() || (useWorkspace ? ws.username.trim() : "") || result.orgName;
            if (useWorkspace && ws && ws.username && result.orgName && targetOrg &&
                targetOrg.toLowerCase() === result.orgName.toLowerCase() &&
                targetOrg.toLowerCase() !== ws.username.trim().toLowerCase()) {
                log(`   ⚠ 绑定目标被传成 Devin org「${targetOrg}」，已改用工作区 GitHub 账号「${ws.username.trim()}」。`);
                targetOrg = ws.username.trim();
            }
            
            // 🌟 [优化]：检查是否已经绑定了目标工作区账号 🌟
            const devinHeaders = {
                authorization: `Bearer ${result.token}`,
                "x-cog-org-id": result.orgId,
                accept: "application/json",
            };
            const currentConn = await githubConnectionStatus(devin, devinUrl, devinHeaders, result.orgId);
            if (currentConn.connected && targetOrg && currentConn.name && currentConn.name.toLowerCase() === targetOrg.toLowerCase()) {
                log(`⚡ [极致优化] 检测到当前 Devin 账号已绑定目标工作区账号「${currentConn.name}」，可见 ${currentConn.count} 个仓库，无须解绑与重装，直接跳过所有 GitHub 流程！`);
                result.githubConnected = true;
                result.githubRepoCount = currentConn.count;
                result.githubConnectedName = currentConn.name;
                result.stage = "done";
                result.success = true;
                result.ideAuthCode = await mintWindsurfAuthCode(devin, devinUrl, result.token, result.orgId, log);
                log(`✔ GitHub=${account.username} 登录 Devin 成功（user_id=${result.userId}）；登录耗时 ${Date.now() - t0}ms`);
                return result;
            }

            let connectClient = gh;
            // sudo 二次确认要用「connectClient 这条 github.com 会话所属账号」的凭据：用工作区账号就用 ws，否则用登录账号。
            const connectCreds = useWorkspace && ws
                ? { username: ws.username, password: ws.password, totpSecret: ws.totpSecret }
                : { username: account.username, password: account.password, totpSecret: account.totpSecret };
            let c = { connected: false, count: 0, name: "" };
            if (useWorkspace) {
                workspaceUsername = ws.username;
                const maxBindAttempts = Math.max(1, Number(options.bindRetries || 3)); // [1.4] 内网移动绑定只需 3 次（纯 API 几乎一次即成） // [1.3] 移动绑定方案下，5次足矣
                const retryDelay = (attempt) => Math.min(8000, 1000 * attempt); // [1.3] 移动绑定更快，缩短等待
                for (let bindAttempt = 1; bindAttempt <= maxBindAttempts; bindAttempt++) {
                    checkStop(gate);
                    if (gh2) {
                        try { gh2.dispose(); } catch { }
                    }
                    log(`=== GitHub绑定重试 · 第 ${bindAttempt}/${maxBindAttempts} 次：登录工作区账号 github.com 并绑定 Devin App ===`);
                    gh2 = new http_1.HttpClient({ ...clientOpts, headers: BROWSER_HEADERS });
                    const wsSeed = seedCookies[cookieKey(workspaceUsername)];
                    if (wsSeed && wsSeed.length > 0) {
                        gh2.jar.setCookies(GITHUB_BASE + "/", wsSeed);
                    }
                    const wsClient = gh2;
                    // [1.3 修复] 先检查是否有可用安装（available-installations），如果有则跳过 GitHub 网页流程
                    let skipWebFlow = false;
                    try {
                        const devinHeaders13 = { authorization: `Bearer ${result.token}`, "x-cog-org-id": result.orgId, accept: "application/json" };
                        const avail13 = await availableInstallations(devin, devinUrl, devinHeaders13);
                        const pick13 = pickInstallForTarget(avail13, targetOrg, ws.username);
                        if (pick13 && pick13.id) {
                            log(`   · [内网移动绑定] 第 ${bindAttempt} 次：available-installations 中找到目标安装 #${pick13.id}${pick13.occupied ? "（占用中，将强制抢绑）" : "（空闲）"}，跳过 GitHub 网页流程，纯 API 秒完。`);
                            skipWebFlow = true;
                        }
                    } catch (e13) {
                        log(`   · [移动绑定] 检查 available 异常（${String(e13)}），回退到网页流程。`);
                    }

                    const prepOk = skipWebFlow ? true : await (async () => {
                        const ok = await establishGithubSession(wsClient, ws, log, gate);
                        if (!ok) {
                            return false;
                        }
                        await uninstallDevinAppOnGithub(wsClient, ws, targetOrg, log, gate);
                        // [1.5] 卸载是 GitHub 异步队列处理，等 2.5s 让它生效，否则立刻装新的会拿到「死」安装
                        log("   · 等待 GitHub 异步处理卸载（2.5s）…");
                        await sleep(2500);
                        return true;
                    })().catch((exc) => {
                        log(`   ⚠ 第 ${bindAttempt}/${maxBindAttempts} 次工作区账号预处理（登录+卸载 Devin App）异常：${String(exc)}`);
                        return false;
                    });
                    if (!prepOk) {
                        if (bindAttempt < maxBindAttempts) {
                            const waitMs = retryDelay(bindAttempt);
                            log(`   ⚠ 第 ${bindAttempt}/${maxBindAttempts} 次失败：工作区账号「${ws.username}」登录 github.com 未成功，${Math.round(waitMs / 1000)} 秒后重试 ...`);
                            await sleep(waitMs);
                            continue;
                        }
                        log(`   ✘ 已重试 ${maxBindAttempts} 次，工作区账号仍未能登录 github.com，停止本次 GitHub 绑定（不回退，避免连错账号）。`);
                        result.githubConnected = false;
                        result.githubRepoCount = 0;
                        result.githubConnectedName = "";
                        result.error = `工作区账号「${ws.username}」登录 github.com 多次失败，未连 GitHub 组织（Devin 登录本身已成功）。先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。`;
                        return result;
                    }
                    connectClient = gh2;
                    mark(`工作区账号登 github.com + 卸旧 App（第 ${bindAttempt} 次完成）`);
                    c = await connectGithubApp(devin, connectClient, devinUrl, result.token, result.orgId, targetOrg, log, gate, connectCreds);
                    mark(`连 GitHub 组织（第 ${bindAttempt} 次装 App + 关联）`);
                    if (c.connected && (!targetOrg || !c.name || c.name.toLowerCase() === targetOrg.toLowerCase())) {
                        log(`   ✔ 第 ${bindAttempt}/${maxBindAttempts} 次绑定成功：GitHub App 已连到「${c.name || targetOrg}」，可见 ${c.count} 个仓库。`);
                        break;
                    }
                    if (bindAttempt < maxBindAttempts) {
                        const waitMs = retryDelay(bindAttempt);
                        log(`   ⚠ 第 ${bindAttempt}/${maxBindAttempts} 次绑定未成功（当前连接：${c.name || "无"}，仓库数：${c.count || 0}），${Math.round(waitMs / 1000)} 秒后继续重试 ...`);
                        await sleep(waitMs);
                    }
                    else {
                        log(`   ✘ 已重试 ${maxBindAttempts} 次仍未绑定成功（最后连接：${c.name || "无"}，仓库数：${c.count || 0}）。`);
                        log("   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。");
                    }
                }
            }
            else {
                // [1.5 修复] 单账号模式也加重试（之前只试 1 次，超时/网络波动就放弃了）
                const singleMaxRetries = 3;
                for (let singleAttempt = 1; singleAttempt <= singleMaxRetries; singleAttempt++) {
                    checkStop(gate);
                    if (singleAttempt > 1) {
                        const waitSingle = Math.min(8000, 2000 * singleAttempt);
                        log(`   · 单账号 GitHub 绑定第 ${singleAttempt}/${singleMaxRetries} 次重试（等 ${Math.round(waitSingle/1000)}s）…`);
                        await sleep(waitSingle);
                    }
                    c = await connectGithubApp(devin, connectClient, devinUrl, result.token, result.orgId, targetOrg, log, gate, connectCreds);
                    if (c.connected) {
                        if (singleAttempt > 1) {
                            log(`   ✔ 单账号第 ${singleAttempt} 次重试绑定成功！`);
                        }
                        break;
                    }
                    if (singleAttempt < singleMaxRetries) {
                        log(`   ⚠ 单账号 GitHub 绑定第 ${singleAttempt}/${singleMaxRetries} 次未成功，将重试 …`);
                    } else {
                        log(`   ⚠ 单账号 GitHub 绑定重试 ${singleMaxRetries} 次仍未成功。`);
                        log(`   💡 解决方法：先用浏览器（同一台电脑、同一个梯子 IP）登录一次这个 GitHub 账号，GitHub 发的设备验证邮件点一下确认。之后这个 IP 就被信任了，切号时就不会再触发设备验证，GitHub 就能自动绑上了。`);
                    }
                }
                mark("连 GitHub 组织（装 App + 关联，含重试）");
            }
            result.githubConnected = c.connected;
            result.githubRepoCount = c.count;
            result.githubConnectedName = c.name;
        }
        // 导出本次 github.com 会话 cookie（登录账号 + 可能的工作区账号），供调用方落盘下次复用。
        result.githubCookies[cookieKey(account.username)] = gh.jar.list(GITHUB_BASE + "/");
        if (gh2 && workspaceUsername) {
            result.githubCookies[cookieKey(workspaceUsername)] = gh2.jar.list(GITHUB_BASE + "/");
        }
        // 最后再 mint IDE 登录码：它一次性、约 60s 过期，越晚拿越新鲜，方便随后立刻投递给 IDE。
        result.stage = "ide-code";
        result.ideAuthCode = await mintWindsurfAuthCode(devin, devinUrl, result.token, result.orgId, log);
        mark("mint IDE 登录码");
        result.stage = "done";
        result.success = true;
        log(`✔ GitHub=${account.username} 登录 Devin 成功（user_id=${result.userId}）；登录耗时 ${Date.now() - t0}ms`);
        return result;
    }
    catch (exc) {
        if (exc instanceof types_1.StopRequested) {
            result.error = "stopped";
            log("■ 已被用户停止。");
            return result;
        }
        if (exc instanceof DevinGithubApiError) {
            result.error = exc.message;
            log(`✘ GitHub=${account.username} 登录失败（${result.stage}）：${exc.message}`);
            return result;
        }
        result.error = `${exc?.name || "Error"}: ${String(exc)}`;
        log(`✘ GitHub=${account.username} 崩了（${result.stage}）：${String(exc)}`);
        return result;
    }
    finally {
        // 提前 return（如登录失败）时并行的工作区预处理可能还在跑——先等它收口，避免把 gh2 提前 dispose 掉。
        if (wsPrep) {
            try {
                await wsPrep;
            }
            catch {
                /* 已在内部 catch，这里只为收口 */
            }
        }
        // 释放 keep-alive 连接池，避免换登结束后 socket 常驻堆积。
        devin.dispose();
        gh.dispose();
        gh2?.dispose();
    }
}
/**
 * 用一个已保存的 Devin 会话（token + org_id）单独换一张新的 IDE 登录码，
 * 不重跑整套 GitHub OAuth。供「手动登录 IDE / 重新生成登录码」用——拿到的 code
 * 一次性、约 60s 过期，调用方应立刻投递给 IDE。
 */
async function mintIdeAuthCode(options) {
    const log = options.log || (() => { });
    const devinUrl = stripTrailingSlash(options.devinUrl || exports.DEFAULT_DEVIN_URL);
    const devin = new http_1.HttpClient({
        proxy: options.proxy,
        verify: options.verify,
        timeoutMs: options.timeoutMs,
        headers: { "user-agent": BROWSER_UA, origin: devinUrl, referer: devinUrl + "/auth/windsurf/success" },
    });
    try {
        return await mintWindsurfAuthCode(devin, devinUrl, options.token, options.orgId || "", log);
    }
    finally {
        devin.dispose();
    }
}
//# sourceMappingURL=apiLogin.js.map
// v0.6.6 exports for panel GitHub repo operations
try {
    exports.BROWSER_HEADERS = BROWSER_HEADERS;
    exports.GITHUB_BASE = GITHUB_BASE;
    exports.cookieKey = cookieKey;
    exports.establishGithubSession = establishGithubSession;
    exports.completeSudo = completeSudo;
    exports.pageLooksLikeSudo = pageLooksLikeSudo;
} catch (_) {}
