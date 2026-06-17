# Test Report — dao-proxy-pro v9.9.298 · 141 实机生产后端实测（DAO Bridge 远程）

> 道法自然 · 无为而无不为。
> 继 v9.9.287/288/289（PR #120/#130/#133/#140/#144/#146/#148…）之后，本轮经 **DAO Bridge
> (Cloudflare 隧道 → DESKTOP-MASTER)** 远程接入用户 141 台式机，对**已安装并实时运行的
> 9.9.298 origin 后端**做端到端验证：路由 / 去名 / 渠道探活 / 经文热切，全部以真实端点 +
> 真实出站载荷 dump 交叉佐证，非桩、非臆造。

**How tested:** 经 DAO Bridge `/api/exec` 在 141 上以 `python` 直连本机 origin
`http://127.0.0.1:8937` 的 `/origin/*` 控制面。origin 为 VS Code 1.124.0 扩展
`dao-agi.dao-proxy-pro-9.9.298` 进程内（in-process）后端，pid 53044，node v24.15.0。
渠道凭据全部安于本机 `~/.codeium/dao-byok/配置.json`（**绝不入库**）。

**Result:** 后端核心全链路 **PASS**。路由（builtin-stub / DeepSeek / 小米 MiMo）端到端
200、去名出站零（大写身份）泄漏、经文热切零窗口重载。唯一非通过项 **gpt-4.1 → GitHub
Models 渠道**，根因为 **141 网络无法出网到 `models.github.ai`（直连与 127.0.0.1:7890
代理均超时）**，属环境/网络条件，**非 proxy-pro 代码缺陷**。

---

## 0. 起点：141 实机交接前状态（实测发现）

| 项 | 状态 |
|---|---|
| 安装位置 | `~/.vscode/extensions/dao-agi.dao-proxy-pro-9.9.298`（**非** `~/.devin/extensions`；后者只有 dao-vsix） |
| 宿主 | Microsoft VS Code 1.124.0（`code --list-extensions`：dao-proxy-pro@9.9.298 / dao-bridge@3.3.0 / dao-vsix@3.16.0 …） |
| origin 后端 | `:8937` 实时运行，pid 53044，`ea_running=true` |
| 渠道配置 | `~/.codeium/dao-byok/配置.json`（6307B）：github / deepseek / freemodel-test / xiaomi 四渠道 + 10 条路由 |
| 仓库 9.9.298 | 与实机一致（最新已落地，无需重新部署） |

---

## 1. 测试矩阵

| # | Test | Result |
|---|------|--------|
| 1 | origin `:8937` 健康（mode=invert · dao_loaded · ea_running · 路由 10 · 目录 108） | PASS |
| 2 | `/origin/ea/overview`：**49 官方家族** · 5 providers(含 builtin-stub) · 路由 10 · 可用模型 20 | PASS |
| 3 | `/origin/ea/probe` 四渠道探活：deepseek/xiaomi alive；github 超时；freemodel 403（占位 key 既知） | PASS（结论真实） |
| 4 | 路由端到端 `MODEL_SWE_1_6` → builtin-stub → 200 | PASS |
| 5 | 路由端到端 `swe-1-6-fast` → deepseek/deepseek-reasoner → 200 · `DAO-OK-DEEPSEEK` | PASS |
| 6 | 路由端到端 `swe-1-6-slow` → xiaomi/mimo-v2.5-pro → 200 · `DAO-OK-XIAOMI` | PASS |
| 7 | 路由端到端 `gpt-4.1` → github/openai/gpt-4.1 | **FAIL（环境/网络）** |
| 8 | 去名：身份提问经路由至 DeepSeek，自报 “I am DeepSeek”，无 Cascade | PASS |
| 9 | 去名线级：真实出站 `_upstream_req_dump.json` 扫描，大写身份标记泄漏=0 | PASS |
| 10 | 经文热切：阴符(587) ↔ 帛书老子(7126) ↔ 合一(7715)，零窗口重载 + 持久化 | PASS |
| 11 | 四接入模块连通：①浏览器 CDP :29229 · ③整机 exec/file · ④code CLI 1.124.0 | PASS |

---

## 2. 证据

### Test 1 — origin 健康（`GET /origin/ping`）
```
ok=true port=8937 mode=invert pid=53044 node=v24.15.0
self_file=...\.vscode\extensions\dao-agi.dao-proxy-pro-9.9.298\vendor\bundled-origin\source.js
dao_loaded=true dao_chars=7126 canon=laozi+yinfu canon_chars=7715
ea_running=true providers=[github,deepseek,freemodel-test,xiaomi] routerReady=true routerCount=10 wire=true
model_unlock enabled=true catalog_size=108
```

### Test 2 — 一站式面板数据（`GET /origin/ea/overview`）
```
official_families=49  providers=5(builtin-stub,github,deepseek,freemodel-test,xiaomi)  routes=10  router_ready=true  available_models=20
```

### Test 3 — 四渠道探活（`POST /origin/ea/probe`）
```
deepseek       : alive=true  status=200  deepseek-chat        1256ms
xiaomi         : alive=true  status=200  mimo-v2.5-pro         3893ms
github         : alive=false reason="超 (12s)"  openai/gpt-4.1-mini   ← 出网不达
freemodel-test : alive=false status=403  "restricted to official Claude Code client"  (占位 key fe_oa_*，既知)
```

### Tests 4–7 — 路由端到端（`POST /origin/ea/test-chat`，经 router.resolveRoute 真路由表）
```
MODEL_SWE_1_6 → builtin-stub/stub-transport-test : 200 · "道可道也 非恒道也 · 传输层得一 · stub响应正常" · 12ms
swe-1-6-fast  → deepseek/deepseek-reasoner        : 200 · "DAO-OK-DEEPSEEK" · 1755ms
swe-1-6-slow  → xiaomi/mimo-v2.5-pro              : 200 · "DAO-OK-XIAOMI"   · 3261ms
gpt-4.1       → github/openai/gpt-4.1             : ok=false · error="connect ETIMEDOUT 104.244.46.165:443" · 21011ms
```
三家（含传输层桩）返回**精确要求字符串**且路由解析 + 渠道鉴权 + 协议适配（openai-compatible）
在 141 实机全链路打通。

### Test 7 根因 — GitHub Models 出网不达（环境，非代码）
```
node 直连 models.github.ai:443                : DIRECT_TIMEOUT
经 127.0.0.1:7890 代理 (Invoke-WebRequest)    : 连接被关闭/超时
渠道模型列表 GET /origin/ea/models/github     : ok=true（7 模型，来自 config）
```
- 路由解析正确（gpt-4.1 → github/openai/gpt-4.1）、模型列表与凭据均在位；
- 唯一失败是 **TCP connect 超时**（`104.244.46.165:443`）——DeepSeek/小米（国内域名）直连皆通，
  仅 GitHub 端不达，且本机 7890 代理当前亦无法到达该端；
- 同一网络条件下 `git clone github.com` 亦 TLS 握手失败 → **同源网络问题**；
- proxy-pro 行为正确：解析路由、加载模型列表、发起上游、**优雅返回 ETIMEDOUT 而不崩溃**。
- 判定：**非缺陷**。待 141 出网（VPN/代理上游恢复）或改用国内可达渠道即恢复（参 v9.9.288 报告 github alive 之时）。

### Tests 8–9 — 去名（核心保证：出站零泄漏）
身份提问（`swe-1-6-fast` → deepseek）回答：
```
My name is DeepSeek! I'm an AI assistant created by the company DeepSeek (深度求索)...
```
真实出站载荷 `vendor/外接api/core/_upstream_req_dump.json`（13140B）大小写敏感扫描：
```
Cascade=0  CascadeProjects=0  Codeium=0  Cognition=0  Windsurf=0
windsurf(小写)=2  ← 仅工具参数名 windsurf_deployment_id（工具契约，既定不动）
```
→ **去名在线级（出站到第三方）零泄漏**，与 v9.9.288/289 报告一致。

### Test 10 — 经文热切（`POST /origin/canon`）
```
set yinfu       → ok=true canon=yinfu        chars=587   prev=laozi+yinfu
set laozi       → ok=true canon=laozi        chars=7126  prev=yinfu
set laozi+yinfu → ok=true canon=laozi+yinfu  chars=7715  prev=laozi
```
零窗口重载，持久化生效。

### Test 11 — 四接入模块连通（DAO Bridge）
```
M1 浏览器: 隔离 Chrome --remote-debugging-port=29229 → /json/version = Chrome/149.0.7827.103 (CDP 可控)
M2 插件本体: code --list-extensions → dao-proxy-pro@9.9.298 / dao-bridge@3.3.0 / dao-vsix@3.16.0 / dao-unified@1.0.0 …
M3 整机: /api/exec 任意命令 + python3.12 + node v24 + 文件读写，全通
M4 VSCode: code CLI 1.124.0 · --list-extensions / --version 可控
```

---

## 3. 结论

- 最新版 **9.9.298 已落地并实时运行**（VS Code 扩展 + origin :8937），无需重新部署。
- 后端核心全链路 PASS：家族归一(49)/目录(108)、三渠道路由端到端 200、去名出站零泄漏、经文热切、四模块连通。
- 唯一非通过项 **GitHub 渠道**为 141 出网不达（环境/网络），**非 proxy-pro 代码缺陷**；DeepSeek/小米 MiMo 正常承载 agentic 主力。
- 未发现需修复的功能性代码缺陷。**无为而无不为** —— 当藏者藏，当为者已为。

> 最终 origin 状态：`ok=true · port=8937 · mode=invert · canon=laozi+yinfu(7715) · ea_running=true · providers=github,deepseek,freemodel-test,xiaomi · routes=10 · catalog=108`。
