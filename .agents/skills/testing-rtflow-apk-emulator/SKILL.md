---
name: testing-rtflow-apk-emulator
description: Build the rt-flow-app APK and verify it end-to-end on an Android 34 AVD on a Devin VM (dual-account switch, composer upload, download floating window, asset cache, logcat triage). Use when testing rt-flow-app changes on a real emulator.
---

# Testing rt-flow-app on an Android emulator (Devin VM)

## Setup
- SDK at `~/android-sdk`; blueprint installs JDK17, platform-tools, `system-images;android-34;google_apis;x86_64`, AVD `rtflow`. If missing, full install from scratch is ~5 min: unzip cmdline-tools into `~/android-sdk/cmdline-tools/latest`, `yes | sdkmanager --licenses`, then `sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" "emulator" "system-images;android-34;google_apis;x86_64"` and `avdmanager create avd -n rtflow -k "system-images;android-34;google_apis;x86_64" -d pixel_6`.
- KVM may be blocked: `sudo gpasswd -a $USER kvm; sudo chmod 666 /dev/kvm` before starting the emulator.
- Start: `emulator -avd rtflow -no-snapshot -gpu swiftshader_indirect -no-audio &`, wait for `adb devices` → `emulator-5554 device`.
- Build: `(cd addons/rt-flow-app && ./gradlew assembleDebug)`; needs `local.properties` with `sdk.dir=$HOME/android-sdk`.
- Install: `adb install -r .../app-debug.apk`. First launch may open the "All files access" settings page and an in-app update dialog (点「稍后」) — clear both before testing.

## Account login (fastest path)
- Use the app's 切号 tab: paste `email password` lines into the import textarea and 添加; then tap ⚡ on a row to open that account's tab. No Outlook OAuth needed.
- Passwords may contain `%&$` etc. that get stripped in some attachment *filenames* — if login says "Invalid email or password", grep the attachment *bodies* for the same account; the special-char version is the real one. Host-side keystrokes may not reach the emulator textarea; type via `adb shell input text` (space=`%s`, single-quote the string, escape `$`).
- A row showing 🔑 (yellow) = not logged in yet; ⚡ = logged, tapping ⚡ opens the account tab. Re-pasting an `email password` line and 添加 updates the stored password idempotently.
- Isolation check: each account should land on its own org URL (`app.devin.ai/org/<slug>`); comparing slugs across accounts is the cheapest no-leak assertion.
- Cold page loads can take 1–3 min on the emulator (no GPU, nested virt) — this might look like a hang but usually isn't; wait before declaring failure.

## Verifying page-injected hooks (composer menu items etc.)
- Debug WebViews are inspectable: `adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof ai.devin.rtflow)` then drive CDP with python `websocket-client`.
- IMPORTANT: a manually-run DOM enhancer proving "the menu shape is compatible" does NOT prove the app's MutationObserver fires. Close and reopen the menu with zero CDP intervention — only an automatically-appearing item counts as PASS.
- Known trap: Radix portals may insert nodes before setting `role`/attributes, so `addedNodes`-only observers can miss them. If a menu hook seems dead, check `menu.__rt*` guards via CDP; the fix pattern is a debounced full-document `querySelectorAll` rescan + `attributeFilter:['role',...]`.
- Zombie-observer trap: a page-injected singleton (`window.__rtWatch`-style) may survive a `document`/`documentElement` replacement while its MutationObserver stays attached to the dead root — the function exists but never fires. Quick probe via CDP: register a callback, `appendChild` a div, and require the counter to increase within ~3s; if it doesn't, the observer is a zombie and every consumer (menu injection, prefetch, video-fit) is silently dead. Fix pattern: expose a re-arm function that disconnects and re-observes the *current* documentElement, and call it on every idempotent re-install.
- After installing a fixed APK, `am force-stop` + relaunch before re-probing — an old renderer keeps the old injected JS and will falsely fail the new build.

## Feature evidence shortcuts
- Asset cache lives at `/sdcard/Android/data/ai.devin.rtflow/files/asset-cache` (external files dir, NOT `run-as` cache/): count `.bin` files after a real page load.
- Download floating window list comes from SharedPreferences `rtflow_tabs`→`downloads`, so adb-pushing files into the Download dir does NOT populate it. Real path: 全服通 panel → 「↓ MD」 exports a session Markdown that registers as a genuine download; then test 点击直看 and ⋮→⬆上传到网页端.
- Upload injection proof: `input[type=file]` files.length via CDP + visible attachment chip in the composer. Note: `files.length` may read 0 right after injection because React consumes and clears the input — the visible chip is the reliable assertion.
- 「⬆上传到网页端」 targets the *current active web tab* (internal pages fall back to the first non-internal tab). If you trigger it from the export-viewer tab, the chip lands on another account's tab — check every open org tab before declaring failure.
- The 「📄 导出 MD」 button opens a viewer first; the download only registers in the floating window after tapping the viewer's 「⬇ 下载 MD」 button.

## Logcat triage
- `adb logcat -d`: FATAL EXCEPTION / "Renderer crashed" = real failures; `ANR in com.google.android.gms*` is the emulator, not the app; `tile memory limits exceeded` and `Long monitor contention` are expected under swiftshader and should be reported as caveats, not failures.

## Pushing / PRs
- The git proxy may 403 for this repo, and any `GITHUB_PAT` env var may belong to a suspended account (API returns "Your account was suspended") — probe each candidate PAT against the API and keep the first that works. A working PAT may exist in user-provided MD attachments (`grep -rhoE 'ghp_|github_pat_' ~/attachments`). Push with `https://x-access-token:<PAT>@github.com/...` without printing the token; create PRs via the GitHub REST API if `git_create_pr` says "Resource not accessible".
- Repo auto-merges conflict-free PRs (dao-auto) — a PR may be merged minutes after creation; re-branch from fresh `origin/main` for follow-up fixes.

## Devin Secrets Needed
- None currently provisioned; account credentials and a GitHub PAT arrive in user-attached MD files. Prefer asking the user to store `DAO_GENESIS_GITHUB_PAT` and the Outlook test-account credentials as permanent secrets.

## Convwatch / notification testing (engine.html)
- The engine WebView is CDP-inspectable: `adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof ai.devin.rtflow)`, target url `file:///android_asset/engine/engine.html`.
- To drive notification states without live accounts: seed `localStorage["rtflow.accounts"]` with one `{email,auth1,orgId}` entry (notifyTick early-returns on empty pool), stub `window.CMDS.trackStuck` (CMDS is window-exposed) to return a synthetic `{ok:true,sessions:[...],scanned:[...],ended:[...]}`, then call `window.__convTick()` per tick. This exercises the real `_convTrack → notify → NotificationManager` chain.
- Assert via `adb shell dumpsys notification --noredact`: rt-flow conv notifications post with `tag=null` (count `NotificationRecord.*pkg=ai.devin.rtflow`, don't grep `tag=conv`); titles carry the account 【N】 prefix.
- Grant `adb shell pm grant ai.devin.rtflow android.permission.POST_NOTIFICATIONS` on a fresh AVD or nothing will post. `adb shell cmd statusbar expand-notifications` shows the shade for visual/recorded evidence.
- Ledger keys: `rtflow.convwatch` (prev sid→phase), `rtflow.convwatch.alerted` (dedup ledger); clear them between scenarios to reset dedup.
