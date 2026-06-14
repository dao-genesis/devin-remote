# Test Report — dao-proxy-pro v9.9.288 · Phase 3 · 141 本地 Devin Desktop 实机落地实测

> 道法自然 · 无为而无不为。接 Phase 1 (PR #130) / Phase 2 (PR #133),本轮把 v9.9.288
> 在**用户 141 台式机 (DESKTOP-MASTER) 的真实运行 Devin Desktop** 上落地、补齐、验证到底。

**How tested:** 经 DAO Bridge (Cloudflare 隧道 → `DESKTOP-MASTER`) 远程驱动 141 上**实际运行中的
Devin Desktop**(`E:\Windsurf\Devin.exe`,扩展目录 `~/.devin/extensions`)。dao-proxy-pro
后端 origin 在 `127.0.0.1:8937`。所有断言用后端真实端点 + 真实出站载荷 dump 交叉验证,
非桩、非臆造。

**Result:** Phase 3 全部断言 **PASSED**。三渠道 agentic 路由在 141 实机端到端 200,去名
出站零泄漏(大写身份标记),canon 切换持久化。补齐了 Phase 2 在 141 上缺失的小米 MiMo 渠道。

---

## 0. 起点:141 实机交接前状态(实测发现)

| 项 | 交接前状态 | 处理 |
|---|---|---|
| 激活版本 | `dao-agi.dao-proxy-pro-9.9.288`(9.9.287 已 obsolete) | ✅ 无需升级 |
| origin 后端 | `:8937` 存活(`/origin/ea/*` 正常) | ✅ |
| BYOK 配置文件 | `~/.codeium/dao-byok/配.json` 存在(交接文档误写为 `配置.json`) | ✅ 已校正路径 |
| DeepSeek / GitHub 渠道 | 已配置 | ✅ |
| **小米 MiMo 渠道** | **缺失**(无 provider、无 `swe-1-6-slow` 路由) | ⚠→✅ 本轮补齐 |
| canon (本源 SP) | `laozi+yinfu`(7803 字) | → 切 `yinfu`(597 字,Phase 2 既定) |

> 上一个对话 (session `devin-de32f923`) 在此卡住:升级激活时触发**窗口重载** → quick
> 隧道被杀 → 旧 URL 530,因 `out_of_quota` 挂起。**本轮关键改进:全程改用后端热加载端点
> (`/origin/ea/provider|route|reload`、`/origin/canon`),零窗口重载 → 不再杀隧道。**

---

## 1. Test results

| # | Test | Result |
|---|------|--------|
| 1 | 9.9.288 为 141 实机激活版本,origin `:8937` 健康 | PASS |
| 2 | 热加载补齐小米 MiMo provider + `swe-1-6-slow`/`MODEL_SWE_1_6_SLOW` 路由(无窗口重载) | PASS |
| 3 | 三渠道存活探针(`/origin/ea/probe`)真实 200:github / deepseek / xiaomi alive | PASS |
| 4 | DeepSeek 端到端:`swe-1-6-fast` → deepseek/deepseek-reasoner → 200 · `DAO-OK-DEEPSEEK` | PASS |
| 5 | 小米 MiMo 端到端:`swe-1-6-slow` → xiaomi/mimo-v2.5-pro → 200 · `DAO-OK-XIAOMI` | PASS |
| 6 | GitHub 端到端:`gpt-4.1` → github/openai/gpt-4.1 → 200 · `DAO-OK-GITHUB` | PASS |
| 7 | 去名:真实出站载荷 `Cascade/CascadeProjects/Windsurf/Codeium/Cognition` 泄漏=0 | PASS |
| 8 | canon 切 `yinfu` 并持久化(`_origin_canon.txt`=`yinfu`),`_sysFull` 收缩 | PASS |
| 9 | 配置持久化:小米渠道写入 `配.json`(5555→6307B,JSON 解析 OK),已备份 | PASS |

---

## 2. Evidence

### Test 3 — 三渠道存活探针(`POST /origin/ea/probe`)
```
github        : alive=true  status=200  model openai/gpt-4.1-mini  "pong! How can I assist..."
deepseek      : alive=true  status=200  model deepseek-chat
xiaomi        : alive=true  status=200  model mimo-v2.5-pro
freemodel-test: alive=false status=200  "Access Denied: ... official Claude Code client only"  (占位 key fe_oa_TESTKEY,既知)
```

### Tests 4–6 — 三渠道 agentic 端到端(`POST /origin/ea/test-chat`,经真实路由表 resolveRoute)
```
swe-1-6-fast → deepseek / deepseek-reasoner : 200 · content="DAO-OK-DEEPSEEK" · 1720ms · total_tokens 70
swe-1-6-slow → xiaomi   / mimo-v2.5-pro     : 200 · content="DAO-OK-XIAOMI"    · 1934ms · total_tokens 309
gpt-4.1      → github   / openai/gpt-4.1     : 200 · content="DAO-OK-GITHUB"    · 2462ms · total_tokens 22
```
三家均返回**精确要求的字符串**且 `finish_reason=stop`,证明路由解析 + 渠道鉴权 + 协议适配
(openai-compatible)在 141 实机全链路打通。

### Test 7 — 去名(真实出站载荷 `_upstream_req_dump.json`,123,564 字符,含 80+ 工具定义)
对实际发往渠道的完整请求体做大小写敏感泄漏扫描:
```
Cascade          = 0
CascadeProjects  = 0
Windsurf         = 0
Codeium          = 0
Cognition        = 0
windsurf (小写)  = 3   ← 仅出现在工具 check_deploy_status 的【参数名】windsurf_deployment_id
```
- `_sysFull`(出站系统提示,2306 字):`Cascade`=0、`Windsurf`=0、`windsurf`=0。
- `_deOfficialName` 对工具**描述**正确中性化(`check_deploy_status` 描述里 `Windsurf`→`the editor`)。
- 唯一残留 `windsurf` 是**参数标识符** `windsurf_deployment_id`(描述、required 中各出现)。
  **这是既定设计**(PR #133:去名"不动工具名/参数,机制不破"):参数名是工具调用契约,
  改名会破坏 `deploy_web_app`/`check_deploy_status` 工具链。故**大写身份标记零泄漏达成**,
  参数名残留为功能正确性所必需、可接受。
- 备注(cosmetic):描述里观察到 `The Windsurf deployment` → `The the editor deployment` 的
  双冠词产物("The the editor"),纯语法瑕疵、不影响功能、不泄漏产品名。

### Test 8 — canon 切换 + 持久化
```
POST /origin/canon {"canon":"yinfu"}
 → {"ok":true,"canon":"yinfu","canon_name":"道藏《阴符经》","chars":597,"previous":"laozi+yinfu"}
持久化: vendor/bundled-origin/_origin_canon.txt => 'yinfu'   (跨重启存活)
```

### Test 9 — 配置持久化 + 备份
```
~/.codeium/dao-byok/配.json : 5555B → 6307B · ConvertFrom-Json 解析 OK
providers: github, deepseek, freemodel-test, xiaomi
daoRoutes.routes: + swe-1-6-slow, + MODEL_SWE_1_6_SLOW  (→ xiaomi/mimo-v2.5-pro)
备份: ~/.codeium/dao-byok/dao_cfg.bak-devin-<ts>.json
```

---

## 3. Routes (141 实机,落地后)

| modelUid | → provider / model | 备注 |
|----------|---------------------|------|
| `swe-1-6` / `MODEL_SWE_1_6` | builtin-stub / stub-transport-test | 测试通道 |
| `swe-1-6-fast` / `MODEL_SWE_1_6_FAST` | deepseek / deepseek-reasoner | agentic 主力 |
| `swe-1-6-slow` / `MODEL_SWE_1_6_SLOW` | **xiaomi / mimo-v2.5-pro** | **本轮新增**,agentic 主力 |
| `gpt-4.1` / `gpt-4o` / `gpt-4.1-mini` | github / openai/* | 轻量(8000 tok 硬限) |
| `swe-1-5` | freemodel-test / claude-opus-4-8 | 占位 key,渠道拒绝(既知) |

状态栏等价:`Provider 4 · 路由 10/10 uids · 就绪 是`(github/deepseek/xiaomi 活,freemodel 占位)。

---

## 4. Escalations / caveats（read first）

1. **小写 `windsurf` 残留为参数名 `windsurf_deployment_id`**,系既定设计(不动工具契约),
   非缺陷;大写身份标记(`Cascade/Windsurf/Codeium/Cognition`)出站零泄漏。
2. **github 免费层 8000-token 硬限**不变:完整 agentic Cascade(80+ 工具 ~19k tok)发 github
   必然 413(客观限制),413 可读回传机制见 PR #133;agentic 开发用 DeepSeek/小米。
3. **freemodel-test 渠道**当前为占位 key(`fe_oa_TESTKEY`),探针 200 但渠道层拒绝;若要启用
   需填真实 freemodel key(`fe_oa_...`)。不影响三主力渠道。
4. **Bridge 隧道仍为 quick 临时模式**:窗口重载会换 URL。建议用 Cloudflare named tunnel
   (`POST /api/config {tunnelToken,hostname}` → `/api/bridge/restart`)固定 URL,根治重载丢链。
   本轮全程零重载,未触及;作为后续加固项。

---

*道法自然 · 无为而无不为 · 损之又损,以至于无为。本轮所有断言均在 141 实机真实端点上取得,不臆造成功。*
