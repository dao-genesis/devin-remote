---
name: testing-rtflow-web-console-host
description: Verify the rt-flow APK web-direct-open share link (console.html) end-to-end entirely on a Devin VM — public static host renders + connects to a local emulator over zero-Worker route-C (ntfy mesh). Use when testing the share-link host, the P2P_WEB_DEFAULT / P2P_CLIENT_CDN host change, or any "网页直开" connectivity claim.
---

# Testing the rt-flow web console share link (VM-local, zero external machine)

Everything runs on the Devin VM: build/boot the APK in an Android emulator, open the public
`console.html` in the VM's Chrome, and connect the two over the decentralized route-C mesh. The
user's own phone/PC is NOT involved — never depend on it (it is often offline; that is expected,
not a failure).

## What the feature is
- Share link opens `console.html` (full APK-equivalent UI) from a **public static host** with
  `?session=…&token=…&auto=1`, then auto-connects to the device.
- Default host lives in two consts: `tunnel.html` `P2P_WEB_DEFAULT` and `console.html`
  `P2P_CLIENT_CDN` fallback. The host must serve **`text/html`** (jsDelivr serves `.html` as
  `text/plain` → only shows source → unusable; surge.sh was permanently 451'd → "Unavailable"
  walrus page). GitHub Pages works (`200 text/html`, auto-rebuilds from `main`) and may be the
  current default — but any of these could change, so always `curl -I` the live host first.
- Connection failover: P2P WebRTC → HTTP/Worker relay → public **ntfy mesh (route-C, zero Worker)**.

## Get the live responder identity from the running emulator (no login needed)
The device generates its own `session`/`token` even with **0 logged-in Devin accounts** — read them
live over CDP from the WebView, do NOT reuse the user's card values (those are their offline device):
```
# find the engine WebView target, then eval:
(function(){var N=window.Native||{};return N.getConn();})()
# → {session:"rtflow-…", token:"…", e2eKey:"…", url:"…workers.dev", …}
```
`cdp_eval.py <ws-url> '<js>'` is a handy helper. The CDP socket is exposed by the emulator
(forward the abstract `webview_devtools_remote_*` socket to a localhost port).

## Prove zero-Worker route-C (the adversarial bit)
`console.html` reads the relay endpoint from `qp("worker")` (see `STABLE_RELAY` around
`console.html:465`). Append **`&worker=https://nonexistent.invalid`** so the Worker relay is
unreachable — then ANY successful connection MUST be via the public ntfy mesh. Without this, a
"connected" result could be a Worker fallback and proves nothing about route-C.

## Verify the connection (UI shows little without accounts)
With 0 Devin accounts the 切号/备份 panels are legitimately empty, and the online badge may not
surface — empty panels are *data*, not a connection failure. Drive the page's own route-C client to
get authoritative proof of a live round-trip (run in the page console, stash to a global, poll it —
ntfy mesh connect can take ~30s):
```
var c = await DaoSignal.connect({session, token});
await c.ping();                                   // ~300–400ms once connected
await c.rpc({path:"/api/rpc", body:{cmd:"getEngineInfo"}});  // → {status:200, body:{version, ua, cmds[…]}}
```
PASS = `getEngineInfo` returns HTTP 200 with the emulator's real Android UA + version. Then inject a
visible on-page banner with the numbers so the recording captures concrete evidence.

## Independent cross-check (no browser)
`routec.py <session> <token>` is a standalone Node/Python ntfy-mesh client: `health` + `exec` → 200
proves the device is mesh-reachable independent of the browser. Broker reachability varies
(`ntfy.sh` is often unreachable from the VM; `ntfy.envs.net` / `adminforge.de` / `mzte.de` work) —
retry once or twice before concluding the device is down; the protocol derives the topic/key from
`session`+`token`.

## Recording
Browser-based → DO record. Maximize first (`wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`).
Annotate: host renders (not surge "Unavailable") → connect over route-C (worker forced invalid) →
live RPC round-trip. The static page's footer version (e.g. `v0.15.1`) is independent of the
device/APK version returned by RPC (e.g. `0.37.74`) — not a discrepancy.

## Gotchas
- `git push` as the Devin bot may 403 (App lacks write). The user may hand a PAT in chat — warn them
  to revoke it after; never persist it. Prefer asking them to grant the GitHub App write access.
- After merging a host change, `curl -I` the live public host to confirm it actually rebuilt and
  serves `200 text/html` before claiming the share link is fixed.

## Devin Secrets Needed
- None required for VM-local testing. (A GitHub PAT may be needed only to push/PR if the Devin
  GitHub App lacks write access — request via the secrets UI, don't accept it in plaintext chat.)
