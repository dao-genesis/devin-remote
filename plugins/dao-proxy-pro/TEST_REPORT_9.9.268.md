# Test Report — dao-proxy-pro v9.9.268 (三模块面板 ③模型路由 + ②渠道配置)

**How tested:** Live UI testing of the locally-installed v9.9.268 build inside **Devin Desktop 3.1.7**
on this VM, with the dao-proxy-pro backend running on `127.0.0.1:8937`. Backend route state was
cross-checked with `curl /origin/ea/overview` after each connect/disconnect to prove persistence.

**Result:** All 6 planned assertions **PASSED**.

---

## Escalations / caveats (read first)

1. **Recording lost to environment restart.** A full annotated screen recording covering Tests 1–6
   was produced (`proxypro_9_9_267-edited.mp4`), but the process restart wiped `/tmp`
   (OS temp dir, not preserved), so the video file is gone. Evidence below is the per-test
   screenshots, which cover every key state. I can re-record on request (requires restarting the
   backend + Devin Desktop and re-running the flow).
2. **Cosmetic wording.** The builtin channel renders as `测通 · 内置` / `测试通道 · 内置` depending on
   surface; spec wording is "测试通道". Functional, but flagged as a cosmetic finding.
3. **Auto-route to a private/locked slot does not persist.** When the auto-routed family's primary
   model is a `MODEL_PRIVATE_NN` slot (e.g. the Claude Haiku family mapped to `MODEL_PRIVATE_11`),
   the route showed in the UI optimistically but was **not** present in the backend after reload.
   Routing to real official models (e.g. `swe-1-6`) persists correctly. Worth a follow-up: either
   block auto-route on locked slots or surface a clear "需先解锁" message.
4. **Real upstream chat not tested on this VM** (real DeepSeek key only exists on the 141 machine).
   Covered tests are panel/routing behavior, not live third-party completions.

---

## What changed (user-visible)

- **③模型路由** now reads `/origin/ea/overview` (same source as the floating panel) instead of the
  old flat catalog. LEFT = **49 family-normalized** models grouped by provider; RIGHT first item =
  **内置测试通道 (builtin-stub)**.
- **v9.9.268 fix:** `window.confirm()` / `window.alert()` are silently blocked inside VS Code
  webviews, so the dblclick-to-disconnect action used to **silently no-op**. Replaced with an
  in-webview `_daoConfirm` modal (Promise-based overlay + 取消/确认) and `_daoToast` notifications.
- **②渠道配置** gains a cc-switch preset dropdown (11 presets) that fills the add-provider form, plus
  a configured-channel list (builtin read-only at top; deepseek/anthropic/openai with ✎/x).

---

## Test results

| # | Test | Result |
|---|------|--------|
| 1 | ③ LEFT shows 49 families grouped by provider (not flat, no garbage first name) | PASS |
| 2 | ③ RIGHT first item = 测试通道(builtin-stub), then deepseek/anthropic/openai | PASS |
| 3 | Existing route SWE-1.6 Fast → deepseek shown as green wire/target | PASS |
| 4 | Connect new route (SWE-1.6 → builtin-stub) persists to backend | PASS |
| 5 | Disconnect via dblclick shows in-webview `_daoConfirm` modal + deletes route | PASS |
| 6 | ② cc-switch preset fills add-provider form + channel list with edit/delete | PASS |

---

## Evidence

### Tests 1–3 — ③模型路由 LEFT 49 families grouped + RIGHT 测试通道 first + existing route
- LEFT shows provider group headers `Claude (10)`, `GPT (19)`, etc. with clean family labels and
  `×N` tier badges — NOT a flat ~100-row list, NOT a garbage uid first item.
- RIGHT first header = `测试通道 · 内置` with `stub-transport-test`, then `deepseek` / `anthropic` /
  `openai`.
- `curl /origin/ea/overview` → `official_families.length = 49`, providers =
  `[builtin-stub, deepseek, anthropic, openai]`, existing route
  `MODEL_SWE_1_6_FAST → deepseek/deepseek-v4-flash`.

Screenshot: `screenshot_9d5c82df…png`

### Test 4 — Connect new route persists
- Selected base `SWE-1.6` (uid `swe-1-6`) on LEFT, clicked `stub-transport-test` on RIGHT.
- Green wire drawn; LEFT family shows target `builtin-stub/stub-transport-test`.
- Backend after action:
  ```
  MODEL_SWE_1_6_FAST -> deepseek/deepseek-v4-flash
  swe-1-6            -> builtin-stub/stub-transport-test
  MODEL_SWE_1_6      -> builtin-stub/stub-transport-test
  ```
  → route persisted (real model, unlike the private-slot case).

Screenshot: `screenshot_fd787643…png`

### Test 5 — Disconnect via in-webview confirm modal (the v9.9.268 fix)
- Double-clicked the routed `SWE-1.6` family.
- **In-webview modal appeared**: `断开 SWE-1.6 全部 1 条路由?` with 取消/确认 buttons
  (previously this was a silent no-op because `window.confirm` is blocked in webviews).
- Clicked 确认 → backend after action:
  ```
  routes after disconnect:
     MODEL_SWE_1_6_FAST -> deepseek/deepseek-v4-flash
  ```
  → both `swe-1-6` and the `MODEL_SWE_1_6` alias removed; LEFT target/wire gone; original route intact.

Screenshots: `screenshot_4991a8b1…png` (modal), `screenshot_3e11fb99…png` (after disconnect)

### Test 6 — ②渠道配置 cc-switch preset fills form + channel list
- Preset dropdown lists: DeepSeek, Zhipu GLM, Kimi, Bailian, SiliconFlow, MiniMax, ModelScope,
  OpenRouter, AiHubMix, OpenAI, Anthropic.
- Selected **DeepSeek** → 填入预设 → form auto-filled: 名称 `deepseek`,
  Base URL `https://api.deepseek.com/v1`, 模型 `deepseek-chat, deepseek-…`, API Key empty.
- Channel list: `测试通道 · 内置` (read-only, no delete) at top, then `deepseek` / `anthropic` /
  `openai` each with ✎/x buttons.

Screenshots: `screenshot_2c513394…png` (preset dropdown), `screenshot_498eeab7…png` (form filled)

---

## Backend evidence log (curl /origin/ea/overview)

```
# precondition
route keys: [ MODEL_SWE_1_6_FAST ] ; official_families.length = 49 ;
providers = [ builtin-stub, deepseek, anthropic, openai ]

# after Test 4 connect (SWE-1.6 -> builtin-stub)
MODEL_SWE_1_6_FAST -> deepseek/deepseek-v4-flash
swe-1-6            -> builtin-stub/stub-transport-test
MODEL_SWE_1_6      -> builtin-stub/stub-transport-test

# after Test 5 disconnect (confirm modal)
MODEL_SWE_1_6_FAST -> deepseek/deepseek-v4-flash
```

---

## v9.9.269 — 悬浮面板（本源观照 / getEssenceHtml）confirm/alert 修复

v9.9.268 只修了**三模块面板**(getEaConfigHtml)的 `window.confirm/alert` 屏蔽问题。
v9.9.269 把同样的 `_daoConfirm`/`_daoToast` 自带弹层补到**悬浮面板**(getEssenceHtml)，
并把该面板里 7 处裸 `confirm()` 全部改为 `_daoConfirm(...).then(...)`（断开已连家族 / 解锁受保护
模型 / 断开档位家族 / 断开右侧已连 / 删除 provider / 清空全部路由 / 回退热切官方）。

**校验：**

| 校验项 | 方法 | 结果 |
|--------|------|------|
| 外层 + 内嵌 webview JS 语法 | `node --check extension.js` | PASS |
| 渲染后脚本仍是合法 JS（防模板正则折叠） | `node tools/render_check.js`（3 段脚本全过） | PASS |
| 悬浮面板在 Devin Desktop 3.1.7 实开渲染 | 实测：⬡ 切换打开 | PASS |
| LEFT 49 家族按厂商分组 | 实测：`Claude (10)` 等分组、`×N` 档位徽标 | PASS |
| RIGHT 首项=测试通道 | 实测：`stub-transp… 测试直连` 居首，再 deepseek/anthropic/openai（9 条） | PASS |
| 路由连线 + provider 列表 | 实测：绿色虚线连线到 deepseek；底部 deepseek/anthropic/openai + URL | PASS |
| 面板可交互 | 实测：单击家族项→高亮选中 | PASS |
| 断开弹层 `_daoConfirm` | **代码与三模块面板逐字节相同**（Test 5 已实测弹层出现+确认删路由+后端核对）；悬浮面板单击「已连家族」走同一 `_daoConfirm(...).then()` 分支 | 代码等价已验证 |

**实测确认：** 悬浮面板在 v9.9.269 下能正常打开并完整渲染（49 家族归一 + 测试直连首项 +
deepseek/anthropic/openai + 路由连线 + provider 列表），证明新增的 `_daoConfirm/_daoToast`
辅助函数与 7 处 `confirm→_daoConfirm` 改动**没有破坏 getEssenceHtml 这段 IIFE**（这是本次改动的
主要回归风险，已排除）。断开弹层本体的代码与三模块面板逐字节一致，后者的弹层在 Test 5 已实测通过。

**附带发现（非本次改动引入，pre-existing）：** 悬浮面板的连线区 `.ea-wire-wrap` 存在布局时序
小瑕疵——某些 `eaRender()` 之后连线列会以 ~0 高度渲染（仅显示列头），需一次外部 relayout/周期刷新
才重新撑开。这与 confirm/alert 修复无关（`eaRender`/CSS 未被本次改动触及；`_daoConfirm` 弹层是
`position:fixed` 覆盖层，不受此影响）。建议后续打磨：在 `eaRender` 末尾对连线层做一次
`requestAnimationFrame` 重排。
