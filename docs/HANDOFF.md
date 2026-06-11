# 交接文档 · DAO 四插件 (下一个 Agent 必读)

> 道法自然 · 无为而无不为。本文让下一个 agent **冷启动**（Devin Desktop 安装/配置/环境）
> 与**继续开发**（核心流程/踩坑/解法）都能无缝接力。
> 最后更新：2026-06-11 · 基线：Devin Desktop **3.1.7** (productVersion 1.110.1)

---

## 0. TL;DR — 当前状态

| 插件 | 版本 | 状态 | 一句话 |
|---|---|---|---|
| **dao-proxy-pro** | 9.9.261 | ✅ 完成+验证 | 底层隔离替换提示词(帛书SP) + 外接第三方模型路由进 Cascade；#4 真实 DeepSeek 3 层 E2E 全过 |
| **dao-vsix** | 1.0.9 | ✅ 完成+live | Hub 面板(Sessions/Knowledge/Playbook/Secret/Git) + 帛书规则板块 + **内网穿透板块** + 官网路由 |
| **devin-git-auth** | 2.0.0 | ⏸ 本轮跳过 | 多 Devin 账号绑一个 GitHub(16 账号已绑同一 App)；用户指令暂不推进 |
| **dao-bridge** | 2.0.0 | ✅ 完成+live | **专穿当前工作区**(非整机) + 随窗口启停 + 实时 MD 文档 |

详细验证见 `docs/LIVE_TEST_2026-06-11.md` 与 `docs/REARCH_2026-06-10.md`。

---

## 1. 冷启动：Devin Desktop 3.1.7 安装与环境

### 1.1 下载与安装
- 官网 `https://devin.ai/download` → 实际安装包托管在 codeiumdata.com，文件名形如 `DevinUserSetup-x64-3.1.7.exe`。
- **务必用 3.1.7**：它的 VS Code 内核 = productVersion 1.110.1，正好是本项目基线。早前误装 Windsurf 1.13.3(内核 1.106.0) 导致 rt-flow token 注入/登录全程不对劲 —— 版本不匹配是大坑。
- 安装后关键路径（Windows）：
  - 主程序：`%LOCALAPPDATA%\Programs\Devin\Devin.exe`
  - **CLI**（装扩展用）：`%LOCALAPPDATA%\Programs\Devin\bin\devin-desktop.cmd`
  - 扩展目录：`%USERPROFILE%\.devin\extensions\`

### 1.2 启动 / 打开工作区
```powershell
& "$env:LOCALAPPDATA\Programs\Devin\Devin.exe" "C:\path\to\workspace"
```
首次会弹「Do you trust the authors of this folder?」→ Yes。
> dao-bridge 穿透的「工作区」= 这里打开的文件夹。要演示穿透必须**带工作区**启动。

### 1.3 账号登录（关键，坑最多）
- 用 **rt-flow 3.16.0** 插件登录/轮换账号（账号库在 `.wam\accounts.md` / rt-flow 自带池）。它注入 `devin-session-token$`。
- **3.1.7 新增 Auth0 全屏登录闸门**（"Welcome to Devin"），旧版没有。rt-flow 的 session-token 满足 Codeium/AI 后端但**不一定**满足这道闸门。
  - 兜底：浏览器登录账号 → `app.devin.ai/auth/windsurf/show-auth-code` 拿 `ott$` token → IDE 里 "Having trouble?" 手动粘贴。比 OAuth 回跳可靠（OAuth 回跳常报 "Sign in failed: No token"）。
- **三种 token，别混淆**（这是 dao-vsix 401/403 的根因）：
  | token 前缀 | 用途 | 能打的 API |
  |---|---|---|
  | `devin-session-token$` (windsurf) | rt-flow 注入 | **仅 Codeium API**；打 `app.devin.ai/v2sessions` → **403** |
  | `auth1`(会话级) | dao-vsix 五步登录链产出 | Devin 网页 API（sessions/knowledge/playbook）→ 200 |
  | `cog_...` | Service User API Key (app.devin.ai/settings) | Devin v1 API → 200 |
  - **规则**：只有 `cog_` 前缀走 v1 API，否则用 `auth1`。绝不能用 windsurf session-token 去打 Devin 网页 API。

---

## 2. 四插件：源码位置 / 构建 / 安装

### 2.1 源码位置（本 VM）
```
C:\Users\Administrator\plugins\dao-vsix\            ← dao-vsix (TS 源码, build.js)
C:\Users\Administrator\plugins\cf-daohub\dao-bridge-ext\  ← dao-bridge (JS extension.js)
C:\Users\Administrator\.devin\extensions\dao-agi.dao-proxy-pro-9.9.261\  ← proxy-pro (已装, vendored)
C:\Users\Administrator\repos\devin-remote\          ← GitHub 仓库本地 clone (plugins/ + docs/)
```
> proxy-pro 我们手上只有**打包混淆后的 extension.js**(~200KB)，无原始 TS 工程。改动靠 patch + 镜像脚本(`dao\mirror_*.js`)。core 逻辑在 `vendor\外接api\core\`(dao_router.js / adapters.js / cascade_wire.js)。

### 2.2 构建
```powershell
# dao-vsix (TypeScript → bundle → vsix)
cd C:\Users\Administrator\plugins\dao-vsix
node build.js                 # tsc + bundle → out\extension.js (~255KB)
& "C:\Users\Administrator\plugins\dao-vsix\node_modules\.bin\vsce.cmd" package --allow-missing-repository --skip-license

# dao-bridge (纯 JS，无需 tsc)
cd C:\Users\Administrator\plugins\cf-daohub\dao-bridge-ext
& "C:\Users\Administrator\plugins\dao-vsix\node_modules\.bin\vsce.cmd" package --allow-missing-repository --skip-license
```
> **坑**：在 dao-bridge 目录直接 `npx vsce` 会拉到老的 `vsce@2.15.0`（不支持 `--skip-license`，且会交互式提示）。**复用 dao-vsix 的 `node_modules\.bin\vsce.cmd`**（= `@vscode/vsce`）最稳。

### 2.3 安装到 Devin Desktop
```powershell
$cli = "$env:LOCALAPPDATA\Programs\Devin\bin\devin-desktop.cmd"
& $cli --install-extension "C:\...\dao-vsix-1.0.9.vsix" --force
& $cli --install-extension "C:\...\dao-bridge-2.0.0.vsix" --force
# 然后重启/重载 Devin Desktop 窗口生效
```

---

## 3. 各插件内核与关键文件

### 3.1 dao-proxy-pro 9.9.261
- **机制**：`extension.js`(shell/webview) ──spawn hook──▶ `source.js`(本地反代 :8937) ──▶ `vendor\外接api\core\dao_router.js`。
- **#1 全模型显示**：`source.js` `MODEL_UNLOCK` 拦截 `GetUserSettings`/`GetCascadeModelConfigs` 响应，注入全量模型目录(`_full_model_catalog.json`)。仅显示层、与账号 tier 无关 → 免费/Pro 一致。未路由模型 `shouldRoute=false` 原路走官方 Cascade。
- **#2 面板**：`_EA_PRESETS`(14 家 cc-switch 预设) + Provider CRUD；连线面板 `$eaRight` + `eaDrawWires()` + `/origin/ea/discover-models`。
- **#3 默认路由**：`dao_router.hotAddProvider` 首个 provider 自动建 `MODEL_SWE_1_6_FAST→{渠道,首模型}`，不覆盖已有。
- **#4 工具透传(最深的一块，已验证)**：`OpenAIChatAdapter.buildRequest` 把官方 **25 个 Cascade 工具**(含 `trajectory_search`=引用历史对话 / `create_memory` / `skill`=子代理) + system 原样发给第三方；`cascade_wire.js` 负责 protobuf 编解码(44/44 自检过)。第三方与官方走**同一条** decode→budget→工具透传→encode 管线。
- **🔑 实时配置(含真实密钥, 不入库)**：
  `C:\Users\Administrator\.devin\extensions\dao-agi.dao-proxy-pro-9.9.261\vendor\外接api\core\配置.json`
  改 key 用 `dao\set_deepseek_key.js`。GitHub 里的 `配置.json` 必须为空 key。

### 3.2 dao-vsix 1.0.9
- 入口 `src/extension.ts`(~4400 行) → `node build.js` → `out/extension.js`。
- **核心面板** `getDaoCloudMiddlePanelHtml()` / `getPanelState()` / `refreshDaoCloudMiddlePanel()`。
- **每次启动注入链** `devinFullInject`：先删旧同名 → 注入两块知识：
  1. `Dao Workspace Server`（工作区+穿透动态 MD）
  2. `道法约束·帛书规则`（`media/dao-rules.md`，7758 字，从 proxy-pro 抽出）
- **内网穿透板块**（v1.0.9 新增）：`readBridgeConn()` 读 dao-bridge 的 `~/.dao/bridge/conn.json`，webview `rBridge()` 渲染；命令 `copyBridgeUrl`/`openBridgeMd`（在 `noAuthNeeded` 白名单，不需登录）。
- **⚠ 绝不能回退的修复**（无之则面板空白/列表拉不到）：
  ```ts
  const useV1Api = (ws.devinApiKey || '').startsWith('cog_');
  const apiKey = useV1Api ? ws.devinApiKey : auth1;   // 4 处会话/知识函数统一
  ```
  以及 webview 的 `esc()` 必须**自包含**（不能调服务端 `mpEsc`）。

### 3.3 dao-bridge 2.0.0 （本轮重写，重点）
- 文件：`cf-daohub/dao-bridge-ext/extension.js`（~370 行，纯 JS）+ `package.json`(v2.0.0) + `media/icon.svg`。
- **不再穿透整机，只穿当前工作区**：`WorkspaceServer` 本地 HTTP(随机端口)，`/api/{health,info,exec,ls,read,write}`；`withinRoot()` 把所有路径操作限定在工作区根（越权 403，无 Token 401）。
- **生命周期**：`activate`(onStartupFinished)→启隧道；`deactivate`(关窗)→杀 cloudflared + 关 server。✅ 实测关 IDE 后公网返回 CF 530。
- **cloudflared**：`findCloudflared` 顺序 = 配置 → `~/.dao/bin` → `~/dao/bin` → 扩展 bin → PATH → 否则从 GitHub latest 下载。本机实际在 `C:\Users\Administrator\dao\bin\cloudflared.exe`。
  - **关键 flag `--protocol http2`**：本类云 VM 封 QUIC/UDP，默认 quic 会 `failed to dial to edge`→CF 1033。http2 强制 TCP 回退后边缘正常路由。**勿删此 flag**。
- **产物（每次启动删旧注新）**：
  - `~/.dao/bridge/conn.json`：`{url, token, local_url, port, workspace, root, host, updated}`
  - `~/.dao/bridge/workspace.md`：公网 URL+Token+工作区信息+云端 Agent 接入 API 清单（发给云端 A 级机即可接管当前工作区）
- **无自定义域名 → 用 quick tunnel**（`*.trycloudflare.com`），每次启动新 URL，正合「每次新通道」需求。用户给的 CF token 账号(Zhouyoukang1234)无 zone，故走 quick tunnel。

---

## 4. 开发流程 & 测试工具

测试脚本都在 `C:\Users\Administrator\dao\`（stub vscode 隔离测试，无需开 IDE）：
| 脚本 | 验证 |
|---|---|
| `test_bridge_ws.js` | dao-bridge：隧道起、6 端点 200/401/403、关窗 server 关、MD/conn 产出 |
| `test_parity_deepseek.js` | proxy-pro #4 Layer A：25 工具透传给 DeepSeek |
| `test_route_e2e.js` | proxy-pro #4 Layer C：完整 route() → DeepSeek → 重编码 |
| `test_autoroute.js` | proxy-pro #3：hotAddProvider 自动路由(9/9) |
| `test_sessions.js` | dao-vsix token 选择(auth1→200, apiKey→401) |
| `test_inject_rules.js` | dao-vsix 帛书规则注入(200, 7758 字) |

公网可达性自测（关键技巧：本机 DNS 不稳，用 `--resolve` 走 CF 边缘 IP + 浏览器 UA 避 1010）：
```powershell
$c = Get-Content "$env:USERPROFILE\.dao\bridge\conn.json" | ConvertFrom-Json
$hn=([uri]$c.url).Host; $ip=(Resolve-DnsName $hn -Server 1.1.1.1 -Type A | ?{$_.IPAddress}|select -Expand IPAddress)[0]
curl.exe -s --resolve "${hn}:443:$ip" "$($c.url)/api/health" -A Mozilla
```

---

## 5. 踩坑与解法（战例，省下一个 agent 大量时间）

1. **装错 IDE 版本**：Windsurf 1.13.3 ≠ Devin Desktop 3.1.7。token 注入全错。→ 必装 3.1.7。
2. **dao-vsix 面板空白**：三个串联 bug——① 重复粘连垃圾片段致 `SyntaxError: Unexpected token '&'`；② webview `esc()` 调服务端 `mpEsc` 致 `ReferenceError`；③ 用 windsurf session-token 打 Devin API 致 401/403。逐个修。
3. **cloudflared QUIC 超时 / CF 1033**：加 `--protocol http2`。
4. **Cloudflare 1010**：非浏览器 UA 被拒 → 客户端必须带浏览器 UA。
5. **vsce 版本**：用 `@vscode/vsce`（dao-vsix node_modules 里那个），别让 npx 拉 vsce@2.15.0。
6. **GUI 终端/命令面板快速 type 会丢字符** → 用剪贴板 `Set-Clipboard` + Ctrl+V 粘贴，或慢速分段输入。
7. **GitHub REST 限流**：批量测 16 账号绑定会打到 rate limit(~1h 恢复)。
8. **Free 账号拉不到 Sessions**：需 `cog_` API Key（app.devin.ai/settings → Service Users → Generate）。非 bug。

---

## 6. 密钥与同步

- **密钥**（本会话用户明文提供，均**不入库**，用后应轮换）：DeepSeek key（写入 proxy 本地 `配置.json`）、GitHub PAT、Cloudflare token。
- **同步目标**：
  1. GitHub：`zhouyoukang1234-spec/devin-remote`（两账号共享同一仓库）→ **PR #47**。代码进 `plugins/`，文档进 `docs/`。public 仓库**严禁明文密钥**。
  2. 141 台式机：`E:\DAO_ARCHIVE`（administrator）。经 CF 中继分块传输。
- 推送前自检：`配置.json` key 为空、无 relay token、无调试脚本含密钥。

---

## 7. 剩余工作 / 下一步

- [ ] **git-auth #3**（用户暂缓）：要刷新「活跃 OAuth 连接」需 github.com 网页登录/设备码；当前只有 PAT（16 账号已绑同一 App，绑定目标态已达成）。
- [ ] proxy-pro #3 UI：把「SWE 基础版=纯通道检测」在面板标注，发消息后反馈「通道已打通」。
- [ ] dao-vsix 官网路由**自动登录**：机制走 `simpleBrowser.show` 共享 session，需在能打开官网的环境 live 验证「打开官网即已登录同账号」。
- [ ] 用 `cog_` API Key 在 Devin Desktop 内 live 跑通全功能面板 Sessions/Knowledge 列表（本会话已用 auth1 验证拉到 104 会话）。
- [ ] 移除 stale `dao.dao-bridge-1.0.0` 扩展目录（已被 2.0.0 取代）。
