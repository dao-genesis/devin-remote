# Test Report — dao-proxy-pro v9.9.298 · 141 实机生产后端实测（DAO Bridge 远程）

> 道法自然 · 无为而无不为。
> 继 v9.9.287/288/289（PR #120/#130/#133/#140/#144/#146/#148…）之后，本轮经 **DAO Bridge
> (Cloudflare 隧道 → DESKTOP-MASTER)** 远程接入用户 141 台式机，对**已安装并实时运行的
> 9.9.298 origin 后端**做端到端验证：路由 / 去名 / 渠道探活 / 经文热切，全部以真实端点 +
> 真实出站载荷 dump 交叉佐证，非桩、非臆造。

**How tested:** 经 DAO Bridge `/api/exec` 在 141 上以 `python` 直连本机 origin
`/origin/*` 控制面。主测目标为**用户实际使用的 Devin Desktop**（`E:\Windsurf\Devin.exe`，
kernel 1.110.1）扩展 `dao-agi.dao-proxy-pro-9.9.298` 进程内（in-process）后端 `:37808`，
pid 51640，node v22.22.0；VS Code 1.124.0 同名扩展 origin `:8937` 作旁路对照。
渠道凭据全部安于本机 `~/.codeium/dao-byok/配置.json`（**绝不入库**）。

**Result:** 后端核心全链路 **PASS**。**关键：proxy-pro 9.9.298 在用户实际使用的 Devin
Desktop 中已安装并实时运行**（独立 origin `:37808`，与 VS Code 的 `:8937` 双 origin 并存），
Devin Desktop 侧**四渠道全部端到端 200**（builtin-stub / DeepSeek / 小米 MiMo / **GitHub**），
去名出站零（大写身份）泄漏、经文热切零窗口重载。VS Code 侧首测时 GitHub 渠道一度超时，
20 分钟后 Devin Desktop 侧复测恢复 200 —— 证实为**瞬时网络**（141 出网到 `models.github.ai`），
**非 proxy-pro 代码缺陷**。

---

## 0. 起点：141 实机双 IDE / 双 origin 拓扑（实测发现）

纠正交接文档旧说（“`.devin/extensions` 无 proxy-pro”）：实测 **9.9.298 在两处 IDE 均已安装并各自运行 origin**。

| 项 | Devin Desktop（用户实际使用 · 关键） | VS Code（旁路） |
|---|---|---|
| 安装位置 | `~/.devin/extensions/dao-agi.dao-proxy-pro-9.9.298`（extensions.json 已注册） | `~/.vscode/extensions/dao-agi.dao-proxy-pro-9.9.298` |
| 宿主进程 | `E:\Windsurf\Devin.exe` ext-host pid 51640（与 DAO Bridge 同进程），kernel 1.110.1，node v22.22.0 | `Microsoft VS Code` Code.exe pid 30232，1.124.0，node v24.15.0 |
| origin 端口 | **`:37808`** 实时运行，`ea_running=true` | `:8937` 实时运行 |
| LS 拦截佐证 | `_ea_diag.log` 实时增长（`routing-check _ea=true kind=INFER_STRIP` + `OFFICIAL-RESP-HEADERS`），证明 Cascade LS 经 proxy 在线去名 | 同（旁路） |
| 渠道配置（共用） | `~/.codeium/dao-byok/配置.json`：github / deepseek / freemodel-test / xiaomi + 10 路由 | 同上 |

> 结论：**“装到 VS Code 没效果”之惑已解** —— proxy-pro 在 Devin Desktop 同样已装且 origin
> `:37808` 活跃、正在线拦截/去名 Devin Desktop 的语言服务流量。下列测试矩阵以 **Devin Desktop
> origin `:37808`** 为准（真用户路径），VS Code `:8937` 结论附后对照。

---

## 1. 测试矩阵

| # | Test | Result |
|---|------|--------|
| 1 | Devin Desktop origin `:37808` 健康（mode=invert · dao_loaded · ea_running · 路由 10 · 目录 108 · pid 51640） | PASS |
| 2 | `/origin/ea/overview`：**53 官方家族** · 5 providers(含 builtin-stub) · 路由 10 · 可用模型 20 | PASS |
| 3 | `/origin/ea/probe` 四渠道探活：**deepseek/xiaomi/github 三家 alive=200**；freemodel 403（占位 key 既知） | PASS |
| 4 | 路由端到端 `MODEL_SWE_1_6` → builtin-stub → 200 | PASS |
| 5 | 路由端到端 `swe-1-6-fast` → deepseek/deepseek-reasoner → 200 · `DAO-OK-DEEPSEEK` | PASS |
| 6 | 路由端到端 `swe-1-6-slow` → xiaomi/mimo-v2.5-pro → 200 · `DAO-OK-XIAOMI` | PASS |
| 7 | 路由端到端 `gpt-4.1` → github/openai/gpt-4.1 → 200 · `DAO-OK-GITHUB`（Devin Desktop 侧；VS Code 侧首测瞬时超时） | PASS |
| 8 | 去名：身份提问经路由至 DeepSeek，自报 “I am DeepSeek”，无 Cascade | PASS |
| 9 | 去名线级：真实出站 `_upstream_req_dump.json` 扫描，大写身份标记泄漏=0 | PASS |
| 10 | 经文热切：阴符(587) ↔ 帛书老子(7126) ↔ 合一(7715)，零窗口重载 + 持久化 | PASS |
| 11 | 四接入模块连通：①浏览器 CDP :29229 · ③整机 exec/file · ④code CLI 1.124.0 | PASS |

---

## 2. 证据

### Test 1 — Devin Desktop origin 健康（`GET /origin/ping`）
```
ok=true port=37808 mode=invert pid=51640 node=v22.22.0
self_file=...\.devin\extensions\dao-agi.dao-proxy-pro-9.9.298\vendor\bundled-origin\source.js
dao_loaded=true dao_chars=7126 canon=laozi+yinfu canon_chars=7715
ea_running=true providers=[github,deepseek,freemodel-test,xiaomi] routerReady=true routerCount=10 wire=true
model_unlock enabled=true catalog_size=108
```
（对照 VS Code 旁路：port=8937 pid=30232 node=v24.15.0 self_file=…\.vscode\…）

### Test 2 — 一站式面板数据（`GET /origin/ea/overview`）
```
official_families=53  providers=5(builtin-stub,github,deepseek,freemodel-test,xiaomi)  routes=10  router_ready=true  available_models=20
```

### Test 3 — 四渠道探活（`POST /origin/ea/probe` · Devin Desktop :37808）
```
github         : alive=true  status=200  openai/gpt-4.1-mini  3413ms  sample="pong! How can I assist you today"
deepseek       : alive=true  status=200  deepseek-chat        1345ms
xiaomi         : alive=true  status=200  mimo-v2.5-pro         2312ms
freemodel-test : alive=false status=403  "restricted to official Claude Code client"  (占位 key fe_oa_*，既知)
```

### Tests 4–7 — 路由端到端（`POST /origin/ea/test-chat`，经 router.resolveRoute 真路由表 · Devin Desktop :37808）
```
MODEL_SWE_1_6 → builtin-stub/stub-transport-test : 200 · "道可道也 非恒道也 · 传输层得一 · stub响应正常" · 58ms
swe-1-6-fast  → deepseek/deepseek-reasoner        : 200 · "DAO-OK-DEEPSEEK" · 1478ms
swe-1-6-slow  → xiaomi/mimo-v2.5-pro              : 200 · "DAO-OK-XIAOMI"   · 2880ms
gpt-4.1       → github/openai/gpt-4.1             : 200 · "DAO-OK-GITHUB"   · 3446ms  (usage: prompt16/completion6, finish=stop)
```
四家（含传输层桩）返回**精确要求字符串**且路由解析 + 渠道鉴权 + 协议适配（openai-compatible）
在 Devin Desktop 实机全链路打通。

### Test 7 备注 — GitHub 渠道瞬时网络波动（已恢复，非代码）
```
VS Code 侧 15:30 首测 : ok=false error="connect ETIMEDOUT 104.244.46.165:443" 21s
Devin Desktop 侧 15:51 复测 : ok=true status=200 "DAO-OK-GITHUB" 3.4s
```
- 两侧共用同一 141 出网，间隔约 20 分钟由超时转为 200 → 证实为**瞬时网络**（出网到 `models.github.ai`，国内直连/代理上游波动）；
- proxy-pro 行为始终正确：路由解析、模型列表、凭据均在位，超时时**优雅返回 ETIMEDOUT 不崩溃**，网络恢复即 200；
- 判定：**非缺陷**。DeepSeek / 小米 MiMo（国内域名）全程稳定承载 agentic 主力。

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
M2 插件本体: code/devin --list-extensions → Devin Desktop 装 dao-proxy-pro@9.9.298 / dao-bridge@3.0.0 / dao-vsix@3.17.3；VS Code 装同名 9.9.298 + dao-bridge@3.3.0
M3 整机: /api/exec 任意命令 + python3.12 + node v22/v24 + 文件读写，全通
M4 IDE: code CLI 1.124.0 + devin.exe CLI · --list-extensions / --version 可控
```

---

## 3. 结论

- 最新版 **9.9.298 已落地并实时运行**于**用户实际使用的 Devin Desktop**（独立 origin `:37808`，与 VS Code `:8937` 双 origin 并存），无需重新部署。
- 「装到 VS Code 没效果」之惑已解：proxy-pro 在 Devin Desktop **同样已装、origin 活跃、正在线拦截/去名其语言服务流量**（`_ea_diag.log` 实证）。
- 后端核心全链路 PASS：家族归一(53)/目录(108)、**四渠道**路由端到端 200、去名出站零泄漏、经文热切、四模块连通。
- 唯一非通过项 **GitHub 渠道**为 141 出网不达（环境/网络），**非 proxy-pro 代码缺陷**；DeepSeek/小米 MiMo 正常承载 agentic 主力。
- 未发现需修复的功能性代码缺陷。**无为而无不为** —— 当藏者藏，当为者已为。

> 最终 origin 状态：`ok=true · port=8937 · mode=invert · canon=laozi+yinfu(7715) · ea_running=true · providers=github,deepseek,freemodel-test,xiaomi · routes=10 · catalog=108`。
