// oauth.mjs — 顶层持久通道 · 一次登录零手搓 Token 自动打通(道法自然·无为而无不为)
//
// 上一代(provision.mjs)仍要用户去 CF 后台点 Create Token 再贴回。本模块把「造 Token」
// 这一步也自动化: 复用 wrangler 官方公开 OAuth 应用(PKCE 授权码流), 用户只需**打开登录
// 链接、登录 Cloudflare 点授权**, 本机回调端口(localhost:8976, CF 唯一接受的回调)即收到
// 授权码 → 换取 access_token + refresh_token → 直接 wrangler deploy 打通持久通道 → 落盘。
// refresh_token 常驻, 之后自愈重部署自动续期; 删除/切号只需 revoke + 清态, 无为而无不为。
//
// 纯逻辑(PKCE/授权 URL/令牌态计算)导出供单测; 副作用(起回调服务/换令牌/部署/撤销)独立。
// CLI: node oauth.mjs login | refresh | logout
"use strict";
import { webcrypto as crypto } from "node:crypto";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { provision, loadState, firstAccountId, stateFile } from "./provision.mjs";

// ── 常量: wrangler 官方公开 OAuth 应用(与 @cloudflare/workers-auth 同源)──────────────
export const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7"; // wrangler 公开 client_id
export const AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
export const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
export const CALLBACK_URL = "http://localhost:8976/oauth/callback"; // CF 仅接受此固定回调
export const CALLBACK_PORT = 8976;
// 部署持久通道所需最小 scope(读账号+子域、写 Worker); offline_access 换 refresh_token 自动追加。
//   zone:read + workers_routes:write 用于 provision.tryCustomDomain 绑自定义域(workers.dev 被墙
//   网络的可达入口) —— 与贴 Token 深链(provision.tokenDeepLink)的 zone:read + workers_routes:edit
//   同源对齐; 缺则 OAuth 打通的 token 只能部署 workers.dev、绑不了自定义域, GFW 下拿不到可达通道。
//   scope 名取自 wrangler 官方 OAuth 应用支持集, 授权页方可接受。
export const SCOPES = ["account:read", "user:read", "workers:write", "workers_scripts:write", "workers_routes:write", "zone:read"];

// ── PKCE 纯逻辑(与 workers-auth/pkce.ts 等价, 便于单测)──────────────────────────────
const PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const VERIFIER_LEN = 96;

// base64url(RFC4648 §5, 无填充): 入参为二进制字符串(每字符一字节)。
export function base64urlEncode(binary) {
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// S256: code_challenge = base64url(sha256(code_verifier))。
export async function pkceChallenge(codeVerifier) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const hash = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < hash.length; i++) binary += String.fromCharCode(hash[i]);
  return base64urlEncode(binary);
}

export async function generatePkce() {
  const out = new Uint32Array(VERIFIER_LEN);
  crypto.getRandomValues(out);
  const codeVerifier = base64urlEncode(Array.from(out).map((n) => PKCE_CHARSET[n % PKCE_CHARSET.length]).join(""));
  const codeChallenge = await pkceChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function randomState(len = 32) {
  const out = new Uint32Array(len);
  crypto.getRandomValues(out);
  return Array.from(out).map((n) => PKCE_CHARSET[n % PKCE_CHARSET.length]).join("");
}

// 构造 CF 授权 URL(格式与 workers-auth/generate-auth-url.ts 字节等价)。
export function buildAuthUrl({ clientId = CLIENT_ID, scopes = SCOPES, state, codeChallenge, redirectUri = CALLBACK_URL }) {
  if (!state || !codeChallenge) throw new Error("buildAuthUrl 需要 state 与 codeChallenge");
  return (
    AUTH_URL +
    `?response_type=code&` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent([...scopes, "offline_access"].join(" "))}&` +
    `state=${state}&` +
    `code_challenge=${encodeURIComponent(codeChallenge)}&` +
    `code_challenge_method=S256`
  );
}

// 把令牌响应折算成落盘用的精简 oauth 态(不含一次性 access 也可, 但存下便于即时复用)。
export function tokenState(tok, prevRefresh) {
  const expires = Number(tok.expires_in) || 0;
  return {
    refreshToken: tok.refresh_token || prevRefresh || "",
    accessToken: tok.access_token || "",
    expiry: new Date(Date.now() + expires * 1000).toISOString(),
    scopes: (tok.scope || "").split(" ").filter(Boolean),
  };
}

// ── 令牌端点(纯网络, 无本地状态)────────────────────────────────────────────────────
async function postToken(params) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  let j = {};
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || j.error) throw new Error(`令牌交换失败(${r.status}): ${j.error || r.statusText}`);
  return j; // { access_token, expires_in, refresh_token, scope }
}

export function exchangeCode(code, codeVerifier, { clientId = CLIENT_ID, redirectUri = CALLBACK_URL } = {}) {
  return postToken(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier }));
}

export function refreshAccessToken(refreshToken, { clientId = CLIENT_ID } = {}) {
  return postToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }));
}

export async function revokeToken(token) {
  try {
    await fetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString() });
  } catch { /* 撤销尽力而为·失败不阻塞清态 */ }
}

// ── 本机回调服务: 收授权码(localhost:8976)──────────────────────────────────────────
function successPage(msg, ok) {
  return `<!doctype html><meta charset=utf-8><title>DAO 持久通道</title>` +
    `<body style="font-family:system-ui;background:#0b0f17;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><div style="font-size:42px">${ok ? "☯" : "⚠"}</div>` +
    `<h2>${ok ? "已授权 · 正在后端自动打通持久通道" : "授权未完成"}</h2>` +
    `<p style="opacity:.7">${msg}</p><p style="opacity:.5">可关闭本页, 返回插件查看进度。</p></div></body>`;
}

let _activeCallbackSrv = null; // 重复登录: 先关上一轮回调服务, 免 EADDRINUSE
export function waitForCallback(expectedState, { host = "localhost", port = CALLBACK_PORT, timeoutMs = 300000, onReady } = {}) {
  if (_activeCallbackSrv) { try { _activeCallbackSrv.close(); } catch { /* noop */ } _activeCallbackSrv = null; }
  return new Promise((resolve, reject) => {
    let done = false;
    // settle 只结算 promise(不关服务), 关服务交给连接关闭事件 —— 否则同步 close() 会截断
    // 正在外发的响应体, 浏览器/fetch 端得到 "fetch failed"。
    const settle = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const shutdown = () => { try { srv.close(); } catch { /* noop */ } };
    const srv = createServer((req, res) => {
      let u;
      try { u = new URL(req.url, `http://${host}:${port}`); } catch { res.writeHead(400); return res.end(); }
      if (u.pathname !== "/oauth/callback") { res.writeHead(404); return res.end(); }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      const bad = err ? `error=${err}` : (st !== expectedState ? "state 不匹配(可能的 CSRF)" : (!code ? "未返回授权码" : ""));
      res.setHeader("Connection", "close"); // 单次回调即用完·不做 keep-alive, 免客户端复用已关闭 socket
      res.on("close", shutdown); // 响应连接彻底关闭后再停服务, 保证响应体完整送达
      res.end(successPage(bad || "令牌交换中…", !bad), () => {
        if (bad) settle(reject, new Error(`OAuth 回调: ${bad}`));
        else settle(resolve, code);
      });
    });
    const timer = setTimeout(() => { settle(reject, new Error("OAuth 登录超时(5分钟未完成授权)")); shutdown(); }, timeoutMs);
    srv.on("error", (e) => { settle(reject, e); shutdown(); });
    srv.on("close", () => { if (_activeCallbackSrv === srv) _activeCallbackSrv = null; });
    _activeCallbackSrv = srv;
    srv.listen(port, host, () => { try { onReady && onReady(); } catch { /* noop */ } });
  });
}

// ── 编排: 一次登录 → 自动部署持久通道 ────────────────────────────────────────────────
// onUrl(url): 拿到授权 URL 后的回调(插件用它 openExternal / UI 展示; CLI 打印)。
export async function loginProvision({ onUrl, log = console.log, port = CALLBACK_PORT, timeoutMs = 300000 } = {}) {
  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = randomState();
  const url = buildAuthUrl({ state, codeChallenge });
  // 回调服务 listening 后才抛出登录链接 —— 杜绝「用户已授权、回调却先于监听到达」的竞态。
  const onReady = async () => {
    log("① 打开登录链接, 登录 Cloudflare 并点授权即可(无需手搓 Token):");
    log(url);
    if (typeof onUrl === "function") { try { await onUrl(url); } catch { /* 打开失败不阻塞·用户可手动点 */ } }
  };
  const code = await waitForCallback(state, { port, timeoutMs, onReady });
  log("② 已授权, 交换令牌…");
  const tok = await exchangeCode(code, codeVerifier);
  const oauth = tokenState(tok);
  log("③ 令牌到手(含 refresh·自动续期), 后端自动部署持久通道…");
  return provision(tok.access_token, { log, skipVerify: true, extraState: { auth: "oauth", oauth } });
}

// 自愈/续期: 用落盘的 refresh_token 换新 access → 重部署(账号复用)。
export async function refreshAndRedeploy({ log = console.log } = {}) {
  const st = loadState();
  if (!st || !st.oauth || !st.oauth.refreshToken) throw new Error("无 OAuth refresh_token(未经登录打通, 或为贴 Token 模式)");
  const tok = await refreshAccessToken(st.oauth.refreshToken);
  const oauth = tokenState(tok, st.oauth.refreshToken);
  const accountId = st.accountId || (await firstAccountId(tok.access_token));
  log("↻ 已续期 access_token, 重部署持久通道…");
  return provision(tok.access_token, { log, skipVerify: true, accountId, extraState: { auth: "oauth", oauth } });
}

// 删除/切号: 撤销 refresh_token + 清态 → 回退快速隧道/mesh。切号即撤销后再 login 一次。
export async function deprovision({ log = console.log } = {}) {
  const st = loadState();
  if (st && st.oauth && st.oauth.refreshToken) { await revokeToken(st.oauth.refreshToken); log("已撤销 Cloudflare 授权。"); }
  try { const f = stateFile(); rmSync(f); log(`已清除持久通道状态(${f}), 回退至快速隧道/mesh。`); } catch { /* 本无状态 */ }
  return { ok: true };
}

// CLI ------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] || "login";
  const open = async (u) => { try { const { default: o } = await import("node:child_process"); o.exec(process.platform === "win32" ? `start "" "${u}"` : process.platform === "darwin" ? `open "${u}"` : `xdg-open "${u}"`); } catch { /* 手动点 */ } };
  const run = { login: () => loginProvision({ onUrl: open }), refresh: () => refreshAndRedeploy(), logout: () => deprovision() }[cmd];
  if (!run) { console.error("用法: node oauth.mjs [login|refresh|logout]"); process.exit(2); }
  run().then((r) => { console.log("DONE " + JSON.stringify(r || {})); process.exit(0); }).catch((e) => { console.error("ERR " + (e && e.message || e)); process.exit(1); });
}
