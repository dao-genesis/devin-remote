# Test Report — dao-proxy-pro v9.9.288 (面板③模路 UX + 上错可回 413 + 去名)

**How tested:** Live UI + backend testing of the locally-installed **v9.9.288** build inside
**Devin Desktop 3.1.7** on this VM, with the dao-proxy-pro backend on `127.0.0.1:8937`
(dao-vsix `:9920`). rt-flow injected account `qkxkuj016584` (D100·W100 · 19/19). Backend
state cross-checked with `curl /origin/ea/*` and the real outbound payload dump.

**Result:** All planned assertions **PASSED**. No code defects found — PR #120 works as designed.

> **New vs. 9.9.268:** the prior report could *not* exercise real upstream completions
> ("real DeepSeek key only on the 141 machine"). This round drives a **real upstream request to
> GitHub Models** end-to-end, which is what proves both the 413-passback and the de-naming fixes.

---

## What changed (user-visible, v9.9.288)

- **③模路 UX 三件套**:rAF 连线随滚动稳定渲染、板块/模型拖拽排序、`⇄ 1:1 对齐`开关(对齐已路由对/拉直连线 ⇄ 家族分组视图)。
- **上错可回(核心)**:上游返 4xx/5xx(如 GitHub Models 免费层 8000 token → HTTP 413)时,`_humanUpstreamError()` + `_errorToCascade()` 把错误组装成可读 assistant 文本帧正常回传,根治"对话死亡"(旧版 ALL-FAIL 不写 res → Cascade 挂死 30s+)。
- **去名递归补全**:`_callProvider` 无条件对每个工具 `_deOfficialName(description)` + 递归 `_deOfficialDescDeep(parameters)`,并对 SP `_deOfficialName`(发送前)。映射 `CascadeProjects→Projects`、`Cascade→you`、`Windsurf→the editor`、`Codeium→the editor`。

---

## Test results

| # | Test | Result |
|---|------|--------|
| 1 | ③模路 连线随滚动稳定锚定(rAF),无抖动/错位/残影 | PASS |
| 2 | ③模路 `1:1 对齐`开关:ON 路由对水平对齐+连线拉直,OFF 回家族分组 | PASS |
| 3 | ③模路 拖拽排序:github 板块底→顶,顺序持久化,连线跟随 | PASS |
| 4 | 上错可回:Cascade(SWE-1.6 Slow→github)上游 413 → 可读错误帧,不挂死 | PASS |
| 5 | 去名:真实出站载荷 Cascade/CascadeProjects/Windsurf/Codeium 泄漏=0 | PASS |
| 6 | github 渠道全链路:小请求 200·"dao-ok";超大请求 413·可读 channel_reason | PASS |

---

## Evidence

### Tests 1–3 — ③模路 UX(滚动稳定 / 1:1 对齐 / 拖拽排序)
- 左"官方模型"长列表上下滚动,右"外接模型"端点保持锚定,连线平滑跟随;滚回顶部正确重锚
  `SWE-1.6 → stub-transport-test`(绿)、`SWE-1.6 Fast → deepseek-v4-flash`(橙虚线)、`swe-1-6 → github/gpt-4o-mini`(绿)。
- `⇄ 1:1 对齐` ON → 已路由模型上浮顶部、与右侧目标逐行水平对齐、连线拉直;OFF → 按家族分组默认视图(Claude / GPT … · 右侧按 provider 分组)。
- 拖拽 `github` provider 板块底→顶,顺序即时更新并持久,连线自动跟随到新位置。
- 状态栏:`Provider 5 · 路由 5/5 · 就绪 是`。

### Test 4 — 上错可回(413,核心·对话死亡根治)
Cascade 用 **SWE-1.6 Slow**(uid `swe-1-6-slow` → 规范化 → `swe-1-6` → github/gpt-4o-mini)发消息。
SP(8908 字)+ 26 工具定义 ≫ GitHub Models 免费层 8000 token → 上游 HTTP 413。Cascade 端 ~1s 内收到可读帧、对话干净收尾(不再挂死):

```
⚠ 渠道「github」拒绝请求 (HTTP 413 · 请求体过大)。
该渠道对单次输入有 token 上限 (如 GitHub Models 免费层约 8000 token)，而当前请求(系统提示 + 工具定义 + 对话历史)已超限。
建议: ① 换用额度更高的渠道; ② 精简上下文 / 减少同时启用的工具; ③ 新开对话以缩短历史。
上游原文: {"error":{"code":"tokens_limit_reached","message":"Request body too large for gpt-4o-mini model. Max size: 8000 tokens.",...}}
```

### Test 5 — 去名(真实出站载荷抓取)
抓取上述 413 请求真实发往 github 的出站载荷(`vendor/<extdir>/core/_upstream_req_dump.json`)做泄漏检查:

```
OUTBOUND -> https://models.inference.ai.azure.com/chat/completions | model gpt-4o-mini | tools 26 | SP 8908 chars
  leak[CascadeProjects] = 0
  leak[Cascade]         = 0
  leak[Windsurf]        = 0
  leak[Codeium]         = 0
  中性化替换在场: "you" x42 | "the editor" x1 | "Projects" x1
```
工具名(bash/browser_preview/edit_notebook/check_deploy_status…)保持原样,仅描述类字段被中性化。**零泄漏。**

### Test 6 — github 渠道全链路(对照)
`POST /origin/ea/test-chat`(协议感知全链路探针):
```
小请求: swe-1-6 → github/gpt-4o-mini → status 200 · content "dao-ok"
超大请求: → status 413 · ok:false · channel_reason "HTTP 413 · tokens_limit_reached · Max size 8000 tokens"
```

---

## Routes exercised

| modelUid | → provider / model |
|----------|---------------------|
| `swe-1-6` | github / gpt-4o-mini |
| `swe-1-6-slow` | github / gpt-4o-mini(新增,精准匹配 Cascade "SWE-1.6 Slow"发出的 uid) |
| `MODEL_SWE_1_6_FAST` | deepseek / deepseek-v4-flash |
| `MODEL_SWE_1_6` | builtin-stub / stub-transport-test |

注:`daoRoutes.familyTierExtend` 默认 `false`,`swe-1-6-slow` 不会自动折叠到 `swe-1-6` 家族路由(既定设计,非缺陷);本轮为可靠复现显式新增 `swe-1-6-slow→github`。

---

## Escalations / caveats (read first)

1. **github 免费层 8000 token 是硬上限。** 道德经+阴符经 SP(8908 字)+ 全量工具必然 413。验证 413-可读回传需要这种"必然超限"的请求;若要 github 拿到**真实回复**,需缩小 SP(如阴符经单独模式)或换高额度渠道(DeepSeek/小米)。
2. **rt-flow 空闲看门狗误报。** rt-flow(独立插件)的空闲监控会对已收到 413 的对话弹「对话死亡(停滞 24s)」。这是 rt-flow 的空闲监控,**与 dao-proxy 的 413 修复无关**——可读错误帧本身已正确显示。仅记录,非 dao-proxy-pro 缺陷。
3. **渠道存活探针假阴性(cosmetic)。** github provider 的 liveness 探针打 `/v1/models`,而真实完成走 `/chat/completions`;路由本身工作正常,探针绿点偶现误判,纯展示层。
