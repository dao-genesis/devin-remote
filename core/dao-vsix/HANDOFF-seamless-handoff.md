# dao-vsix Seamless Handoff — Status & Agent Handoff

Context for any Agent (Devin Cloud etc.) taking over operation of the user's desktop
(`DESKTOP-MASTER`) dao-vsix fleet. This documents the shipped "seamless handoff"
architecture, how to activate it on the live desktop, and the exact state at handoff time.

## TL;DR

- **All code is merged + released.** `main` is at dao-vsix **3.50.12**; tag `dao-vsix-v3.50.12` published.
- Seamless handoff (restart/switch-proof live-interface resolution) is fully implemented and was
  proven on real fleet data via a faithful standalone harness.
- **Remaining work is *activation + live verification on the desktop*, not code.** It is blocked only
  by an operational detail: the desktop must run 3.50.12, which requires a full Windsurf restart
  (extension version is cached at the app/main-process level — per-window reload and exthost restart
  both reload the *cached* old version; verified empirically).

## What shipped (PRs, all merged + released)

| PR | Version | What |
|----|---------|------|
| #510 | 3.50.9 | Quota-follow loop default-on (`messageLimitAuto` defaults true when no fixed value set) |
| #511 | 3.50.10 | Unified loop-audit log `~/.dao/dao-loops.log` for tunnel + quota self-heal loops |
| #512 | 3.50.11 | Seamless handoff base: dead-pid prune + canonical `dao-conn-current.json` + `GET /api/next` |
| #513 | 3.50.12 | Hardened liveness with `/api/health` probes — kills recycled-pid ghosts |

## Architecture (the three self-heal loops + handoff)

All loops follow the same "identify → compare → act only on drift, else hold" (守柔) pattern:

1. **Account self-heal** (`reconcileAccountPoolInject`): `fs.watch` on the WAM pool files + 15-min
   periodic + 12s-after-activate. Per account: clear stale residue → compare → inject only what's
   missing (3 knowledge / 3 playbooks / secret / GitHub PAT / MCP). Pool-signature dedupe avoids
   re-injecting when unchanged. Audit: `~/.dao/dao-pool-reconcile.log`.
2. **Tunnel self-heal** (`bridgeLivenessTick` + `startNetworkChangeWatch`): 30s probe + 5s IP-change
   detection → if unreachable, restart tunnel + re-inject new address; if reachable, hold. Audit: `dao-loops.log`.
3. **Quota-follow** (`quotaAutoLimitTick`, 60s): recompute `single-convo cap = remaining ACU − offset`
   (default 3 → 70 yields 67, 50 yields 47); write + inject only on change. Audit: `dao-loops.log`.

### Seamless handoff (the new bit)

The real continuity break was: account-API ports change on window restart and
`~/.dao/dao-conn.json` was append-only (accumulated 88+ dead-pid entries), so an external Agent
could not tell which interface is "the live next one." Fix = make "who is alive now" a self-healing
truth on disk:

- `daoPruneConnRegistry()` — prune dead pids + dedupe by pid (keep most-recent), rewrite only on change.
- `daoProbeHealth(port)` — **liveness truth is `/api/health` responding**, not `process.kill(pid,0)`.
  Windows recycles pids, so a dead instance's pid can be reused by an unrelated process and pass
  `process.kill` (false-positive ghost leader). Health-probe eliminates ghosts. (This is the 3.50.12 fix.)
- `daoRefreshCurrent()` — writes canonical `~/.dao/dao-conn-current.json`:
  `{ url, token, port, pid, version, epoch, updated, alive[] }`. Leader = lowest *responding* port
  (deterministic, no thrashing). `epoch` is monotonic: +1 only when leader port/pid/url actually changes.
- `GET /api/next` → `{ current, alive[], epoch, self }` in one call.
- Triggers: every `saveConnection()` + the 30s liveness tick (self-heals even with no saveConnection).

### Agent handoff recipe (works through the persistent bridge)

The whole-machine **DAO Bridge** (a *separate* extension, see Topology) survives across dao-vsix
window restarts within an app session and exposes `/api/exec`. After any restart/switch:

```
POST <bridge>/api/exec {cmd: "type %USERPROFILE%\\.dao\\dao-conn-current.json"}
```

→ read the live port + stable machine token → continue. If `epoch` is greater than last seen,
the interface rotated → re-resolve. The stable machine token lives in `~/.dao/api-token`.

## Topology gotcha learned this session (critical)

- **Two distinct extensions, often in the same window/exthost:**
  - `dao-bridge` (v3.4.0) → whole-machine control: `/api/exec`, `/api/ls`, `/api/file`, `/api/write`,
    `/api/bridge-state`, `/api/agents`. Its public quick-tunnel URL is the one auto-injected into the
    knowledge note "DAO Bridge 内网穿透远程操作文档". **Version-stable (3.4.0), independent of dao-vsix.**
  - `dao-vsix` (v3.50.x) → account API + the 3 loops + handoff: `/api/connection`, `/api/next`,
    `/api/state`, on ports 99xx.
- Both can run in the **same extension-host process** (e.g. the main window's exthost owned both
  port 43017 (bridge) and 9920 (account API)). **Killing/reloading that window kills the bridge.**
  Other windows (9921/9922/…) are separate exthosts — safe to restart independently.
- **Extension version is cached at the app main-process level.** New windows and exthost auto-restart
  both reload the *cached* version. Only a **full Windsurf app restart** loads a freshly installed
  version (e.g. 3.50.12). `extensions.json` on disk pointing at 3.50.12 is necessary but not sufficient
  until the app restarts.

## Restart-with-self-recovery procedure (used this session)

Because the bridge shares the main exthost, a full restart drops the bridge and **rotates the
quick-tunnel URL**. To restart without depending on the user:

1. Independent **watchdog** (`C:\Users\Administrator\watchdog.ps1`) launched via a **Windows Scheduled
   Task** (`dao_watchdog`, interactive, highest) so it is *not* a child of the Windsurf process tree.
2. Watchdog: record old URL → kill `Devin` + `cloudflared` → relaunch `E:\Windsurf\Devin.exe`
   (restore windows) → poll local dao ports for a *new* tunnel URL → publish it.
3. **Rediscovery channels** (user-independent):
   - Primary: the plugin re-injects the new public URL into the knowledge note on reconcile;
     fetch it on-demand by name ("DAO Bridge 内网穿透远程操作文档").
   - Backup: a private **gist** the watchdog PATCHes with `{url, old, ts}`.

### Known watchdog bug to fix (next Agent)

The watchdog fell back to `/api/connection.publicUrl`, which returned a **stale** URL
(`videos-commands-...`, CF 530). It must prefer `/api/bridge-state.url` and **validate the candidate
URL actually returns 200 from outside** before publishing. Also poll longer — cold-starting 6 windows
+ per-window tunnels + login can take several minutes before any tunnel is connected.

## State at handoff (pending)

- A guarded restart **was triggered** (scheduled task `dao_watchdog` ran; Windsurf relaunched; local
  dao instances responded). The three old tunnels are now dead (CF 530); the new live URL had not yet
  surfaced via the note/gist when control was handed off. **Next step: obtain the current public URL**
  (from the desktop status-bar Dao tooltip "Relay:", or the knowledge note), reconnect, then verify:
  - all dao-vsix windows now report `version 3.50.12`,
  - `GET /api/next` returns a `current` whose `alive[]` has **no recycled-pid ghosts** (health-probed),
  - leader = lowest responding port; `epoch` increments only on real leader change and holds when idle,
  - the three loops tick (fresh lines in `dao-pool-reconcile.log` + `dao-loops.log`).
- **Before-state evidence of the ghost bug (captured pre-restart):** `dao-conn-current.json` had
  leader **pid 10132 @ port 9920, epoch 7** — pid 10132 is a recycled ghost from a prior session
  (real 9920 exthost was pid 8172). 3.50.12's health-probe should resolve a real leader and drop the ghost.

## Operational artifacts (this session, on the desktop / VM)

- Scheduled task: `dao_watchdog` (delete with `schtasks /Delete /TN dao_watchdog /F` once done).
- `C:\Users\Administrator\watchdog.ps1`, `bridge-url-latest.txt`, `dao_watchdog.log` (watchdog log).
- Helper client `bridge.py` (modes GET/POST/EXEC/PS/DAO) on the VM.
- Secrets are **not** committed: the DAO bearer token is the stable machine token; the GitHub PAT is
  provided by the user per session.

## Do-not-touch (explicit user constraints)

- Do NOT modify the reverse-injection UI or rt-flow switching.
- Do NOT change the pool-unification fix or the injection payload.
- Do NOT break backward compatibility with `/api/connection`.
- Deploy only via the Bridge remote-exec + VSIX (no cloud/GUI deploy).
