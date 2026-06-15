# 五插件 CANON · 正本清源（道法自然）

> 核心是**五个插件**。它们同依赖一个软件本体（Devin Desktop = Windsurf 同源），
> 各自独立的 VSIX 扩展，可并行构建/安装/测试，「道并行而不相悖」。
> 当前权威源码在 `plugins/` 各插件目录，与 GitHub `devin-remote` main 一致。
>
> 另有第 6 板块 **rt-flow-mobile**（浏览器/手机版 Chromium MV3 扩展，**非 VSIX**）：是 ⑤ rt-flow 在浏览器的移植，见下表 #6 与 §⑥。

## 总览

| # | 插件 | 本质 | 归档目录 | 当前版本 | 状态 |
|---|------|------|----------|----------|------|
| 1 | **dao-proxy-pro** | 底层提示词隔离替换 + 外接第三方模型路由进 Windsurf/Cascade | `dao-proxy-pro/` | 9.9.286 | #1–#4 全实现+验证 |
| 2 | **dao-vsix** | Devin 全功能面板（会话/知识库/Playbook/Secret）+ 路由官网 + 内嵌 git/穿透板块 + 启动注入帛书规则 | `dao-vsix/` | 1.3.3 | 主体完成；SSE 流式直通；官网自动登录待 live 复验 |
| 3 | **dao-bridge** | 工作区专属内网穿透（随 IDE 启停 + 实时 MD + Cloudflare 隧道） | `dao-bridge-ext/` | 3.2.0 | live E2E 通过；随 IDE 启停 + 命名隧道（稳定 URL）+ local-agent 深度控制 HTTP API |
| 4 | **devin-git-auth** | 多个 Devin 账号绑定到同一 GitHub 仓库协同 | `devin-git-auth/` | 2.3.2 | 绑定目标态达成；VSIX 已可构建安装；活跃协同待打通 |
| 5 | **rt-flow** | Devin Cloud 接入：批量/自动对话备份 + 全量数据快照 + 一键回归本源(wipe) | `rt-flow/` | 4.6.2 | 12/12 批量备份 + 一键 wipe + 对话额度上限/自动停 + 清理阈值$1 + 余额精确到分 |
| 6 | **rt-flow-mobile**（浏览器/手机版） | rt-flow 多账号切换 + dao-vsix 官网注入登录 → 合一移植为 Chromium MV3 浏览器扩展（**非 VSIX**） | `rt-flow-mobile/` | 1.0.0 | 桌面 Chrome 全流程实测通过（含修复 MV3 冷启竞态·storage-first）；安卓 Kiwi/Edge 侧载待真机验证 |

## 逐插件本源需求（底层驱动力）

### ① dao-proxy-pro
- Cascade 下**显示全部模型**且与 Windsurf 账号（免费/Pro）**零冲突**：未路由模型走官方 Cascade，仅被路由的走第三方通道。
- 首通道 = SWE 基础版（仅通道检测）；首次加第三方（如 DeepSeek）默认把 **SWE 1.6 Fast** 路由到该渠道首个模型。
- 面板②仿 **CC Switch** 加渠道；面板③连线面板右侧自动拉取渠道可用模型。
- 后端与官方 **100% 同步**：引用历史对话（`trajectory_search`）、子代理快速上下文（`skill`）、全部 25 个 Cascade 工具 + 隔离替换后的提示词，一字不差透传第三方模型。

### ② dao-vsix
- 全功能面板：Sessions / Knowledge / Playbook / Secret 本地同步且**跟随 Devin Desktop 登录账号**。
- 路由 Devin 官方网页并**自动登录同账号**（浏览器自动化 / 内嵌注入）。
- 把 **git 多账号绑定** + **内网穿透**两板块并入主面板。
- 每次启动：删旧知识库/Playbook → 注入「工作区动态 MD」+「帛书道德经/阴符经规则」两板块，让 Devin Cloud 接管当前窗口，效果≈本地 Cascade。

### ③ dao-bridge
- 登录**自己的 Cloudflare 账号**即可一键全链路跑通；**专穿当前 Devin Desktop 工作区**（非整机）。
- 随 IDE 窗口启停；每次启动产出实时更新的 MD 文档（公网 URL + token + 工作区信息）供云端 A 级机连接。
- 工作区信息提取可与 proxy-pro 的提示词隔离板块同步（动态提取 Cascade 提示词中的工作区上下文）。

### ④ devin-git-auth
- 多个 Devin 账号统一鉴权、共享同一 GitHub 仓库，协同开发。
- 已达成：16 账号统一注册到同一 GitHub App。待打通：刷新「全新活跃 OAuth 连接」并验证多账号共享同一仓库的活跃协同（需 github.com 网页登录 / 设备码——账号资源里有两个测试 GitHub 账号 + TOTP 可用）。

### ⑤ rt-flow
- 零依赖 `devin_cloud.js` 底层封装 Devin Cloud 全部 API（邮箱+密码→auth1 登录、概览、对话追踪、CRUD、备份、wipe），不依赖浏览器 OAuth 回跳。
- **对话备份（批量 + 自动）**：增量 ZIP 备份对话 + `snapshotAccountData` 全量数据快照（知识库/剧本正文 + 密钥/Git/会话/额度元数据）。快照逐条 `_settle` 重试，一条端点失败不毁整份（`partial`/`errors` 如实标注），与 dao-export 模块端点逆向经验互通。
- **一键回归本源（wipe）**：先 `backupAccountFull` 本地留底，再清空账号全部用户数据（对话归档 + 知识/剧本/密钥真删 + Git 授权撤销），**保留 Devin 本源默认**（3 内置知识 + 32 社区剧本）。
- 实践戒律：区分「用户数据」与「本源默认」，删除端点必须真号实跑确证（曾揪出多个把 404 当成功的「臆造成功」缺陷），残留如实回报、绝不臆造。

### ⑥ rt-flow-mobile（浏览器/手机版·新增板块，非 5 个 VSIX 之一）
- 把 ⑤ rt-flow 的「多账号自动切号」与 dao-vsix 的「官网注入自动登录」**合一移植到浏览器**：纯 Chromium MV3 扩展，无 Devin Desktop / VSCode 依赖，可在桌面 Chrome / Edge 与 **Android 的 Kiwi / Edge** 侧载。
- 登录注入：`email+password → windsurf.com 登录 → auth1`；content script 于 `document_start` 在 `app.devin.ai` 种入 `localStorage['auth1_session']` + org 守卫键，`declarativeNetRequest` 给 `/api/*` 注 `Authorization`/`x-cog-org-id` → SPA 零 GUI 自动登录。换 auth1 即换号。
- 自动切号：`chrome.alarms` 轮询余额，≤ 缓冲（默 $3）→ rotate 评分最优；页面探测「额度耗尽」→ 立即轮转。
- 实践戒律：popup 渲染 **storage-first**（直读 `chrome.storage`，不依赖 service worker 是否唤醒），根除 MV3 冷启竞态卡死；网络层异常如实回显、不静默吞。
- 入口：`plugins/rt-flow-mobile/`（`src/cloud.js`/`src/background.js`/`src/content.js`/`src/popup.*`）；说明与接力见该目录 README 的「状态 · 实测 · 开发接力」。

## 告诫下一个 agent

- 五插件正本就在 `plugins/` 五个目录 + GitHub `devin-remote`。不要把旁支仓库当主线翻找。
- 提示词以「已隔离替换」状态为准（帛书《老子》道德经 + 道藏《阴符经》），见各插件内 `media/dao-rules.md` 与 proxy-pro vendor。
- **浏览器/手机版**单独成第 6 板块 `plugins/rt-flow-mobile/`（Chromium MV3 扩展，非 VSIX）；它是 rt-flow 在浏览器的移植，接续开发从该目录 README 的「状态 · 实测 · 开发接力」起手。
