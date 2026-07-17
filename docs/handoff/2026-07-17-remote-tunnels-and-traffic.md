# Remote tunnels and traffic optimization handoff

Date: 2026-07-17

This document records the verified state, the limits of the verification, and the
remaining work. It intentionally contains no passwords, PATs, TOTP seeds, API
tokens, session tokens, relay tokens, or device-specific URLs.

## Verified and merged

- PR #181: billing `overage_credits` sign normalization and quota-cap regression
  coverage. A positive balance and the historical negative bookkeeping form are
  normalized before calculating the dynamic cap.
- PR #183: first-pass global traffic accounting and savings:
  - Android UID cumulative counters continue while the traffic panel is closed.
  - Upload and download counters are tracked separately.
  - Counter resets are detected.
  - Metered-network polling is reduced automatically; manual refresh remains
    immediate and full-sized.
  - Stable large GET endpoints use short-lived, account-safe request coalescing
    and caching.
- PR #185 / this branch: physical-screen isolation:
  - Remote `browseOpen` always uses the background shadow host.
  - Remote automation cannot call native `appToFront`.
  - Remote automation cannot activate a user-visible tab.
  - Screenshots and mirror frames observe the shadow page without foregrounding.
  - Static source-level guards reject dynamic native-command fallbacks.
  - Mobile version is `0.37.244` (`versionCode 349`).

## Real-device evidence

- The Android device was reached through the ntfy mesh fallback without a Worker.
- Background browser RPC, JavaScript execution, tab close, device information,
  and battery queries worked through `relay-ntfy`.
- A closed traffic panel later caught up approximately 60.9 MB of background
  activity from the Android UID counter.
- Cloudflare login and Worker provisioning were completed from the device's
  residential network while the page stayed in the shadow host:
  - Turnstile produced a valid response.
  - A minimally scoped temporary Workers token was minted and then revoked.
  - Worker provisioning reached `done` with a healthy result.
  - `/health` was independently checked with HTTP 200 after revocation.
- ntfy relay has a payload ceiling; large state/screenshot responses can return
  HTTP 413 and must use P2P or the Worker path.

## GitHub OAuth result and safety boundary

The GitHub OAuth experiment was run through the background shadow host. The
login form was reached without a CAPTCHA, but the selected GitHub account
redirected to GitHub's `suspended` page immediately after submission. No
2FA, OAuth authorization, or Cloudflare account association was claimed.
The flow must stop on this result; it must not attempt to bypass the suspension
or any future CAPTCHA, WebAuthn/passkey, device approval, or email confirmation.

Valid PAT candidates from the user-provided offline document were checked
against GitHub's `/user` endpoint without printing or persisting their values.
The credentials remain external secrets and are not part of this repository.

## Current tunnel observations

- ntfy mesh: working as a fallback and suitable for small control frames.
- LAN: the phone-local service port responded during the previous real-device
  check; a complete health/RPC matrix is still required.
- Persistent Worker: `/health` and authentication gates were verified, but the
  current upstream agent registration can expire; `upstream_online=false` was
  observed for a stale desktop registration.
- Quick tunnel: repeated Cloudflare edge failures were observed on the
  tested domestic network. The fallback decision path needs broader testing;
  this is not evidence that every network or every tunnel implementation fails.
- Worker health alone is not proof of end-to-end relay operation. Upstream
  registration and a real RPC response must be checked separately.

## Remaining work for the next agent

1. Run the complete tunnel matrix:
   - mesh small and large payloads;
   - Worker upstream registration, expiry, renewal, and real HTTP/browser RPC;
   - quick-tunnel rotation and stale URL recovery;
   - LAN health and RPC;
   - public console and `/shell`;
   - browser RPC versus HTTP RPC;
   - multi-user `sid` isolation and account/session isolation;
   - failure recovery and channel priority.
2. Finish global traffic optimization without changing user-visible behavior:
   - event-history delta/incremental loading;
   - idle, account switch, navigation, tunnel, upload, and download baselines;
   - Wi-Fi versus metered-network measurements;
   - verify dynamic endpoints are never incorrectly cached;
   - preserve an explicit full refresh path.
3. Build and install the mobile artifact:
   - run lint, typecheck, tests, and release build;
   - install on the real device;
   - confirm `0.37.244` and the isolation behavior after installation.
4. Perform the physical isolation regression:
   - leave the user's visible page untouched;
   - open and drive a remote page in the shadow host;
   - execute background JS/fetch;
   - capture screenshot/mirror frames;
   - confirm the user can continue interacting with the foreground page.
5. Verify `latest.json` only after the referenced release artifact exists.
6. Re-check all PR states through the authoritative GitHub API; do not infer
   merge state from old conversation text.

## Operational rules

- Never print or commit credentials, tokens, cookies, or runtime session data.
- Never use `foreground:true`, `appToFront`, or remote tab activation.
- Never bypass third-party security controls.
- Changes to `core/rt-flow` must be vendored to `core/dao-vsix/rtflow`.
- Module code changes require the corresponding package version bump.
- Preserve `/shell` `sid` isolation and same-origin proxying.
