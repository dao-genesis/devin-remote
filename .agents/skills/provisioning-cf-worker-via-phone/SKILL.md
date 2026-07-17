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
- Per AGENTS.md §三: a persistent CF Worker is an **optional** "fixed domain" enhancement, not a
  prerequisite — the zero-account ntfy mesh + `cloudflared` quick-tunnel fallback already work without any
  CF account. Only run this when the user explicitly wants the constant Worker address.
- Never store the CF password / minted token / PATs in the repo or in a plaintext knowledge note; treat any
  credential seen in chat as already-exposed and rotate-worthy (doc §note at the end).
