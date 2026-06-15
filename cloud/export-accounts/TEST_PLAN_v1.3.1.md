# Test Plan — dao-export VSIX v1.3.1 fetch-robustness fix

Account: lqaqne8728759@gmail.com (org shorwitz-eileeng, 73 sessions). Extension 1.3.1 installed in VS Code on the VM.

UI path (from code): DAO Devin activity-bar icon → Sessions webview (sidebar.ts login form) → click a session → detail webview (detailPanel.ts) with tabs 概览/对话/Worklog/Changes/原始数据. Settings apply live via onDidChangeConfiguration (extension.ts:39-40), so changing `daoDevin.apiBase` takes effect without reload.

## Test 1 — Happy path still works end-to-end (regression)
Steps:
1. In Sessions sidebar, enter email + password, click 登录.
2. Observe the session list.
3. Click session "推进 devin-remote#51 ProXy Pro插件进展".
4. Wait for 概览 to load, then click 对话 tab.
5. Click "导出 ZIP (一切底层数据)".

Pass/fail:
- After login, header shows "73 / 73 sessions" (NOT 0, NOT an error).  
- 概览 shows 总事件数 = 2991 (NOT 0).  
- 对话 tab renders at least one 👤 USER and one DEVIN message bubble (NOT "无对话事件", NOT a ⚠️ error).  
- Export writes a .zip to Downloads with size > 50 KB (verified via shell `ls -la`).

A broken implementation (silent empty) would show 0 sessions / 0 events / blank conversation.

## Test 2 — THE FIX: fetch failure is surfaced, not silently blank
Reproduces the user's "login OK but no conversation records" condition by pointing the API at a dead base AFTER login (login uses windsurf.com + real base; sessions/events use `daoDevin.apiBase`).

Steps:
1. While logged in (Test 1 state), open VS Code Settings (Ctrl+,), search `daoDevin.apiBase`, set it to `https://app.devin.ai/api-DEAD-xyz`.
2. Back in the Sessions sidebar, click the ⟳ refresh button.
3. Open any session detail and view the 对话 tab.

Pass/fail:
- After ⟳, the sidebar shows a RED/visible error status containing "获取会话失败" (NOT a silently empty list, NOT the misleading "登录失败").  
- The 对话 tab shows a ⚠️ notice containing "事件流获取失败" and a proxy hint (NOT blank, NOT "无对话事件").  

A broken (pre-fix) implementation would show an empty session list and a blank conversation with no error at all — indistinguishable from "account has no data". The presence of the explicit error text is what proves the fix.

## Cleanup
- Reset `daoDevin.apiBase` back to empty.
