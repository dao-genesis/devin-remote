---
name: provisioning-cf-worker-via-phone
description: Provision the persistent dao-relay Cloudflare Worker end-to-end through the user's phone (rt-flow-app) over the ntfy mesh, when the VM cannot reach dash.cloudflare.com because of Turnstile. Use when asked to build/refresh the persistent Worker tunnel or run the "CF provision full flow" and you only have a CF dashboard login (not a ready API token).
---

# Provisioning the persistent CF Worker through the phone

The persistent internet-penetration channel is a Cloudflare Worker (`dao-relay-do`, a Durable Object)
deployed into the user's own CF account. The user's master credential doc (title like
`dao-genesis …`, attached most sessions) carries the **CF dashboard login** (email + password, under
"## 二、Cloudflare 账号") and the GitHub accounts (password + TOTP + PAT). It usually does **not** carry a
ready-to-use CF **API Token / Global API Key** — and that is fine, you can mint one yourself.

## Why not do it from the VM
`dash.cloudflare.com` and the CF dashboard internal API (`/api/v4/*`) are **Turnstile-walled from the VM's
datacenter IP** — even the real desktop Chrome over CDP just loops on "Performing security verification"
and `/api/v4/user` returns 403. Do **not** burn time fighting Turnstile on the VM.

The phone is a real residential device: Turnstile passes there, and **the user is usually already logged
into Cloudflare in the phone's in-app browser**. So mint the token *on the phone* via the same internal
API the dashboard front-end uses (same-origin cookies, zero UI, zero CAPTCHA), then hand it to the phone's
own `/api/cf-provision` which deploys the Worker over pure CF REST (no wrangler needed).

This is exactly what `addons/rt-flow-app/app/src/main/assets/engine/cf-auto.js` automates in-app
(`cfMintToken` → `feedToken` → `/api/cf-provision`). This skill is how you drive that same flow **remotely
from the VM** over the mesh.

## Preferred path: engine-native cookie mint (zero browser, freeze-immune) — v0.37.252+
The background-tab throttling gotcha below is **structurally solved** by moving the token mint out of a
throttled browser tab into the **persistent engine WebView** (runs inside `RelayService`'s foreground
service — never frozen) using the CF dashboard cookies already in Android's global `CookieManager`.

- Native bridge `Native.cookiesFor(url)` (`RelayService.java`, **Cloudflare-domain-gated only**) reads the
  session cookie for `https://dash.cloudflare.com` from the process-wide `CookieManager` — works in the
  background, no foreground tab, no `browseExecJs` kick+read.
- Engine (`relay-app.js`) then uses the **native HTTP bridge** (`DaoCore.httpReq`, no CORS, freeze-immune)
  to call the same dashboard internal APIs (`GET /api/v4/user` → `/api/v4/accounts?per_page=50` →
  `/api/v4/user/tokens/permission_groups` → `POST /api/v4/user/tokens`) with `Cookie`+`Origin`+`Referer`+
  `X-Requested-With`, mints a least-privilege token in memory, and hands it to `cfProvisionRun`.
- **Route**: `{"path":"/api/cf-autoprovision","body":{}}` (optional `{"accountId":"<id>"}`). Returns
  `{"started":true,"poll":"/api/cf-status","mode":"cookie-session"}`; poll `/api/cf-status` to `done` exactly
  as the token path. UI button: 「⚡ 会话态直建 Worker」 in `tunnel.html` (`cfCookieAuto`).
- **Multi-account safe**: single visible account auto-selected; multiple → `multi_account: <ids>` error (pass
  `accountId`); unknown id → `account_not_found`; none → `no_account`. Never silently picks `accounts[0]`.
- **Diagnostics**: no session cookie → `no_cf_session` (log into CF once in the in-app browser — clear a
  human/Turnstile challenge that one time — then this button is fully automatic); missing account-scope
  groups → `missing_perm_groups: <names>` before any token is created. Token value never appears in
  status/error.
- **Precondition**: the user must have logged into Cloudflare once in the in-app browser (GitHub-SSO to CF
  counts). No credentials, cookies, passwords, or TOTP are accepted from remote callers — the route only
  takes an optional `accountId`.
- Tests: `addons/rt-flow-app/test/cf-cookie-mint.test.js` (pure helpers + injected cookie/dash mint flow +
  route contract). Prefer this path; fall back to the mesh RPC procedure below only for old APKs (<0.37.252).

## Procedure (mesh RPC from the VM)
Tool: `addons/rt-flow-app/tools/dao-mesh-rpc.mjs <session> <token> <frame>` (needs `ws`; `npm i ws --no-save`).
Session/token come from the user's share block (`Session:` / `Token:`). The `browseExecJs` bridge does **not**
return async values directly — write the result to a `window.__X` global in one call, then read it back in a
second call (`JSON.stringify(window.__X)`), sleeping ~5-6s between.

1. **Reach the phone**: `ping` → expect `{"ok":true,...,"mode":"relay-ntfy"}`.
2. **Open the CF dashboard tab (background)**:
   `{"path":"/api/rpc","body":{"cmd":"browseOpen","url":"https://dash.cloudflare.com/","foreground":false}}`
   → note the returned `tabIndex`.
3. **Confirm the phone is logged into CF** (kick+read on that tab): `fetch('/api/v4/user',{credentials:'include'})`;
   expect `status 200` and an `email`. If not logged in, the doc's CF email/password (and, for the GitHub-SSO
   path, the GitHub account's TOTP) let `cf-auto.js` log in on the phone — or ask the user to tap "全自动" once.
4. **Mint an API token via the internal API** (kick+read on the same tab). Replicate `cfMintToken` /
   `buildTokenPayload`: `GET /api/v4/user`, `GET /api/v4/accounts?per_page=50`,
   `GET /api/v4/user/tokens/permission_groups`, then `POST /api/v4/user/tokens` with policies:
   - account resource `com.cloudflare.api.account.<accountId>` → groups **Workers Scripts Write** +
     **Account Settings Read** (this is sufficient — the Worker is a Durable Object with an ASSETS binding
     and **no KV namespace**, so KV-storage permission is not required);
   - user resource `com.cloudflare.api.user.<userId>` → **User Details Read** + **Memberships Read**.
   Read back `result.value` (the token, ~53 chars). Save it `chmod 600` off-repo (never print/commit it).
5. **Provision through the phone**: POST the token to the phone —
   `{"path":"/api/cf-provision","body":{"token":"<minted>"}}` → `{"started":true,"poll":"/api/cf-status"}`.
6. **Poll** `{"path":"/api/cf-status"}` every ~8s until `phase=done` →
   `✅ 恒定通道就绪: https://dao-relay-do.dao-<accountId8>.workers.dev`.
7. **Verify independently from the VM**: `curl .../health` → `{"status":"ok","service":"dao-relay",...}`;
   and `curl -H "Authorization: Bearer <token>" https://api.cloudflare.com/client/v4/user/tokens/verify`
   → `success:true, status:"active"`.

## Gotchas
- The account id for this user is `d318ce25a90ee64dd0bfe5cd0245866b`; the resulting constant URL is
  `https://dao-relay-do.dao-d318ce25.workers.dev`. It is also recorded (and auto-refreshed) in the user's
  "DAO Bridge 内网穿透远程操作文档" knowledge note as the persistent channel.
- `getState` over the relay returns `413 relay payload too large` — use small RPCs
  (`ping` / `browseOpen` / `browseExecJs` / `browseListTabs`), never bulk state.
- **Background-tab timer throttling blocks the remote kick+read mint.** A CF dashboard tab opened
  with `foreground:false` gets its JS event loop suspended by the OS when the app is backgrounded —
  `fetch('/api/v4/user')` (and even `setTimeout`) never progress, so `window.__R` stays `pending`/`start`
  forever no matter how long you poll. `browseActivateTab` is a deliberate no-op (isolation contract in
  `engine.html`), so you cannot foreground it remotely. Practical consequence: the **remote** VM-driven
  mint only works when the user's phone screen is on and the app is foregrounded during the run. The
  **in-app** path (`cf-auto.js`, user taps 全自动) is not affected — it runs in the active page. When
  remote-driving, confirm the tab's JS actually advances (kick a trivial `window.__R=Date.now()` and
  read it back changes) before assuming the mint hung on the network. `tools/cf-drive.mjs` wraps the
  kick+read pattern.
- Permission-group matching is now locale/case tolerant (`pickGroups` in `cf-auto.js` falls back to a
  trimmed case-insensitive match), and `cfMintToken` fails loudly with `missing_perm_groups: <names>`
  if a CF account doesn't expose the two account-scope groups (Workers Scripts Write + Account Settings
  Read) — instead of silently minting an under-scoped token that later dies at "can't read accounts".
- Per AGENTS.md §三: a persistent CF Worker is an **optional** "fixed domain" enhancement, not a
  prerequisite — the zero-account ntfy mesh + `cloudflared` quick-tunnel fallback already work without any
  CF account. Only run this when the user explicitly wants the constant Worker address.
- Never store the CF password / minted token / PATs in the repo or in a plaintext knowledge note; treat any
  credential seen in chat as already-exposed and rotate-worthy (doc §note at the end).
