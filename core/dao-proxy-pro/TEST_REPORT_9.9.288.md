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

---

## Phase 2 — 三渠道真实交互开发实测(阴符经单独 SP + DeepSeek + 小米 MiMo)

**目标:** 把面板①经藏 SP 从「帛书老子+阴符经」切到**阴符经单独**以缩小载荷,接入真实可用的 DeepSeek / 小米 MiMo key,在 Cascade 里发真实复杂开发提示词,实测三家渠道的**开发能力 / 工具调用 / 规则遵守**,并核对去名。

### SP 经藏切换(`POST /origin/canon {"canon":"yinfu"}`)

| | canon | 经藏文本 chars | 出站 `_sysFull` chars(含身份前言+user_information) |
|---|---|---|---|
| 切换前 | `laozi+yinfu` | 7803 | 8908 |
| 切换后 | `yinfu` | 597 | **1774**(~443 tok) |

### 三渠道路由(面板③ `Provider 6 · 路由 6/6 · 就绪 是`)

| Cascade 档位 | modelUid | → provider / model | 上下文上限 |
|---|---|---|---|
| SWE-1.6 | `swe-1-6` | github / gpt-4o-mini | 8000(免费层硬限) |
| SWE-1.6 Fast | `swe-1-6-fast` | deepseek / deepseek-v4-flash | 131072 |
| SWE-1.6 Slow | `swe-1-6-slow` | xiaomi / mimo-v2.5-pro | 大窗 |

### 实测结果

| # | 渠道 / 档位 | 提示词 | 结果 |
|---|---|---|---|
| P1 | 小米 MiMo · SWE-1.6 Slow | "实现 merge_intervals 合并重叠区间…" | **PASS** · 全自主多步循环:`mkdir`→写 `merge_intervals.py`(+69)→`python` 跑测试,Test1 `[[1,3],[2,6],[8,10],[15,18]]`→`[[1,6],[8,10],[15,18]]` ✅ 通过 |
| P2 | DeepSeek · SWE-1.6 Fast | "从零实现 Python LRU cache 装饰器(不用 functools)+3点说明" | **PASS** · 返回正确的 from-scratch 实现(含 `Lock` 线程安全)+ 3 点说明,~6s |
| P3 | github · SWE-1.6 | "写个 flatten list-of-lists 的一行式" | **PASS(可读 413)** · 即便 SP 已降到 1774 字,仍返可读 413 帧(不挂死)— 见根因 |
| P4 | 去名(三渠道出站) | 抓 `_upstream_req_dump.json` | **PASS** · payload 全文 + 26 工具描述里 Cascade/CascadeProjects/Windsurf/Codeium 泄漏=0;SP 内为 `C:\Users\Administrator\Projects`(非 CascadeProjects) |

### 关键根因(github 仍 413 — 量化)

切阴符经后 github 后端 `test-chat`(不带 Cascade 全量工具)**已能 200 拿到真实回复**(测"求 1..n 平方和"→正确返回 `lambda n: sum(i**2 for i in range(1,n+1))`)。但**真实 agentic Cascade 仍 413**,实测出站载荷量化:

```
SP(_sysFull)      = 1774 chars  (~443 tok)      ← 阴符经单独,已极小
26 工具定义 JSON   = 34162 chars (~8540 tok)     ← 单独已 > 8000 硬限
```

**结论:github 免费层 8000 token 的瓶颈是 Cascade 的 26 个工具定义(~8540 tok),而非 SP。** 缩 SP 只够让"轻量/非 agentic"请求通过;完整 agentic Cascade(必带全量工具)在 github 免费层下必然 413。**真正可用于 agentic 开发的是 DeepSeek(128k)/ 小米(大窗)** —— 两者本轮均交付了正确、可运行的真实开发结果。413 可读回传在该场景下仍正确工作(可读帧、不挂死)。

> 实践印证用户判断:阴符经单独模式确实让 github "能正常请求"——对**轻量请求**成立(后端 200);但 agentic 全量工具场景受限于工具体积,需用 DeepSeek/小米。这是 GitHub Models 免费层的客观限制,非 dao-proxy-pro 缺陷。
