---
name: testing-dao-fleet-bridge
description: Operate and verify the dao-vsix account fleet (reverse-injection, pool unification, per-account modules) on the user's desktop remotely via the DAO Bridge tunnel. Use when asked to test/use/verify the desktop's account resources end-to-end from a Devin VM.
---

# Testing the DAO account fleet remotely via DAO Bridge

The user's desktop (`DESKTOP-MASTER`) runs the **dao-vsix** "二合一" plugin (account switching + Devin Cloud
reverse-injection) plus a **DAO Bridge** that exposes the whole machine over a Cloudflare quick tunnel.
From a Devin VM you operate the fleet by tunneling into the desktop and calling its *local* account API.

## Topology (important)
- The user typically sends **two** trycloudflare URLs. One is often **down (CF error 1033 = origin not connected)**.
  Test both; use whichever returns JSON. The live one is the **DAO Bridge** (whole-machine control), NOT the account API.
- DAO Bridge endpoints (token in `Authorization: Bearer <token>`; wrong token → 401; `/api/health` is open):
  `/api/info`, `/api/bridge-state`, `/api/agents`, `/api/exec` + `/api/exec-sync` (run cmd on desktop),
  `/api/ls`, `/api/read` (a.k.a `/api/file`), `/api/write`, `/api/broadcast`.
- The **account API is on the desktop's localhost** (e.g. `http://localhost:9920`), NOT exposed by the bridge.
  Reach it by running PowerShell on the desktop via `/api/exec-sync` that does `Invoke-RestMethod` to localhost.
  Token+port live in `~/.dao/dao-conn.json` (an **array** of many instances/ports — dedupe by port, pick a live one).

## Gotchas (and workarounds)
- `exec-sync` type routing: `type:"shell"` → cmd.exe; **any other type that isn't `run`/`file`/`cmd`/`bat`/`detached`
  runs the cmd as a raw PowerShell expression** (use `type:"ps"`). `type:"run"` treats the string as a FILE to execute — wrong for inline scripts.
- Git Bash mangles `/api/...` args (MSYS path translation) → set `MSYS_NO_PATHCONV=1` or pass paths without a leading slash.
- Windows Python prints cp1252 by default and chokes on Chinese → set `PYTHONUTF8=1 PYTHONIOENCODING=utf-8`.
- `Get-Content dao-conn.json` must use `-Encoding UTF8` or Chinese workspace paths become mojibake and break `ConvertFrom-Json`.
- A reusable client helper (`bridge.py`) with modes `GET/POST/EXEC/PS/DAO` is the fastest way to drive everything;
  the `DAO` mode reads token/port from `dao-conn.json` on the desktop so no secret ends up in the command string.

## Pool unification check (the core thing)
- Switch-board (rt-flow 切号) reads `~/.wam/accounts.md`. Reverse-injection reads `loadAccountPool()` whose priority is
  `wam.accountsFile > ~/.wam/accounts.md > ~/.wam/accounts-backup.json > dao.accountsFile (trailing fallback)` (fixed in 3.50.8).
- Verify they match: `POST /api/devin/batch-inject {all:true}` then `GET /api/devin/batch-inject/status` — the `total`
  must equal the `accounts.md` line count. If `accounts-backup.json` has a different (often larger, stale) count and `total`
  picks it up, the pool has **diverged** — that's the bug 3.50.8 fixes. Note the desktop may run an **older version** than the fix.

## Full-fleet reverse-injection (end-to-end at scale)
- `POST /api/devin/batch-inject {all:true}` is async + idempotent; injection is config-only (knowledge/playbooks/secrets/MCP),
  not credit-consuming. Poll `GET /api/devin/batch-inject/status` (every ~30s) until `running:false`.
  Expect **~1.5–2 accounts/min** (real logins) → 140+ accounts ≈ 80–90 min. Run a background poller; don't block a shell.
- Each ok account should have `knowledge=playbook=secret=bridge=profile=true`. `auth` is `cached` or `login`.
- Some accounts legitimately fail with `HTTP 401: Account unavailable` (suspended) or `Invalid email or password`
  — these are **account-side**, not tool defects. Report them but don't treat as a failure of the system.
- Verify payload identity by reading a real account's modules: knowledge `道法自然准则` + `DAO Bridge MCP 使用文档`,
  secret `DAO_TOKEN`, MCP installation `DAO Bridge MCP`.

## Reporting
- This is shell-only testing → **do not record**; collect command outputs as text evidence.
- Lead with escalations (tunnel down, version lag, stale backup pool), then per-assertion pass/fail, then the final
  `total/ok/failed` tally with the account-side failure list.

## Seamless handoff + activating a new dao-vsix version (3.50.11+)
- "Who is alive now" is self-healed to `~/.dao/dao-conn-current.json` (`{url,token,port,pid,version,epoch,alive[]}`).
  Read it via the bridge: `POST /api/exec {cmd:"type %USERPROFILE%\\.dao\\dao-conn-current.json"}`. `GET /api/next`
  on a dao-vsix port returns `{current,alive,epoch,self}` in one call. Leader = lowest *health-responding* port;
  `epoch` bumps only when leader port/pid/url changes. `dao-conn.json` is the (pruned) registry array.
- **Liveness = `/api/health` responding, NOT `process.kill(pid,0)`.** Windows recycles pids, so an old dead
  instance's pid can be reused and pass `process.kill` → ghost leader. 3.50.12 probes `/api/health` to drop ghosts.
- **`dao-bridge` (v3.4.0, `/api/exec`) and `dao-vsix` (v3.50.x, `/api/connection`,`/api/next`) are different
  extensions**, often in the same window exthost (e.g. one pid owned both 43017 and 9920). Killing that window
  kills the bridge. Other windows are independent exthosts.
- **Extension version is app-main-process cached.** New windows + exthost auto-restart reload the *cached* version;
  only a **full Windsurf restart** loads a freshly installed version. So activating a new VSIX needs an app restart.
- **Restart without the user:** run a watchdog from a Windows **Scheduled Task** (not a child of the Windsurf tree)
  that kills `Devin`+`cloudflared`, relaunches `Devin.exe`, then re-resolves the new tunnel URL. The quick-tunnel
  URL rotates on restart; rediscover it via the auto-injected knowledge note (fetch by name) or a gist the watchdog
  writes. Prefer `bridge-state.url` over `connection.publicUrl` (the latter can be stale → CF 530) and validate the
  candidate returns 200 from outside before trusting it.

## Devin Secrets Needed
- None stored in Devin. The DAO Bridge **URL + bearer token** are provided by the user per session (quick-tunnel URLs
  rotate on restart). The account-API token is read live from `~/.dao/dao-conn.json` on the desktop.
