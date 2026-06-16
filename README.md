# dao · 道法自然 · 太上 下知有之

> **最终主交付 = dao-one 大 one**：在 **dao-vsix 二合一**（本源基座：左 rt-flow 切号 + 中 Devin Cloud 全功能面板）之上，把 **Proxy Pro 三面板**作为 Devin Cloud 全功能面板的**一个子模块**折入，其余与 dao-vsix 完全一致。GitHub Issues / Comments = 无感传输层。

[![Release](https://img.shields.io/github/v/release/zhouyoukang1234-spec/devin-remote?label=release&color=2ea44f)](https://github.com/zhouyoukang1234-spec/devin-remote/releases/latest)
&nbsp;4 + 4 + 3&nbsp;·&nbsp;[快速安装 ↓](#下载--快速安装)&nbsp;·&nbsp;[冷启动板块](cloud/coldstart/README.md)

---

## 下载 · 快速安装

**一键冷启动**（自动装 Devin Desktop + 构建并安装 dao-one 大 one 插件）：

```powershell
git clone https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\cloud\coldstart\coldstart.ps1
```

冷启动脚本会从源码构建 **dao-one 大 one**（`core/dao-one`，以 dao-vsix 二合一为**本源基座** + Proxy Pro 三面板**子模块** + 本地 HTTP API），安装后卸载会抢占同名 id 的 `dao-vsix` / `rt-flow` / `dao-proxy-pro`，让 `dao.dao-one` 成为唯一属主。**最终以 dao-one 大 one 为主交付**；若只要纯二合一本源，可单独构建 `core/dao-vsix`。

> 所有 VSIX 均为构建产物（已 `.gitignore`，走 [Releases](https://github.com/zhouyoukang1234-spec/devin-remote/releases/latest) 分发或本地 `node build.js && npx @vscode/vsce package` 现产）。

---

## 架构全貌 · 4 + 4 + 3

```
devin-remote/
│
├── core/                     # ★ 核心 4（dao-one 大 one = 最终主交付；dao-vsix 二合一 = 本源基座）
│   ├── dao-one/              # ① 最终主交付 · 大 one —— dao-vsix 本源基座 + Proxy Pro 三面板子模块（折入 Devin Cloud 全功能面板）
│   ├── dao-vsix/             # ② 本源基座 · 二合一 —— rt-flow 切号 + Devin Cloud 全功能面板 + 本地 HTTP API（含多账号反向注入）
│   ├── rt-flow/              # ③ Devin Cloud 接入本体：备份 / 全量快照 / wipe / 额度上限
│   └── dao-proxy-pro/        # ④ 底层提示词隔离替换 + 外接第三方模型路由
│
├── addons/                   # ★ 辅助 4 · 独立插件（按需单独安装；"aux" 为 Windows 保留名故用 addons）
│   ├── dao-bridge/           # ① 内网穿透本体：默认 dao-relay 零账号 Worker 中继(URL 稳定)→连不上回退 cloudflared
│   │   ├── dao-bridge-ext/   #     随 IDE 自启的 VS Code 插件（relay-first + cloudflared 自愈/断点续传/macOS 解包）
│   │   └── agent.js/core.js  #     纯 Node 独立后端（NAS / 路由器 / 容器 / CI 等无 VSCode 环境）
│   ├── rt-flow-app/          # ② Devin Cloud 手机版 APK（三合一：切号+内网穿透+多实例·取代 rt-flow-mobile 和 dao-bridge-android）
│   ├── devin-git-auth/       # ③ 多 Devin 账号绑定同一 GitHub
│   ├── dao-export/           # ④ 对话数据导出插件（单账号·VSIX）
│   └── dao-relay/            #   ↳ 内网穿透栈：中继 Worker 源码（归一入库·v2·(session,token) 零账号配对·一键部署）
│
├── cloud/                    # ★ 板块 3 · 供 Devin Cloud 全链路开发
│   ├── export-accounts/      # ① 导出其他账号对话全流程（dao_export_all.py + 后端逆向指南）
│   ├── vm-replica/           # ② Windows 多 RDP 类虚拟机（FreeRDP + MCP 工具集）
│   └── coldstart/            # ③ 冷启动高效登录流程（coldstart.ps1 + 人启动总纲 + Runbook）
│
├── tools/                    # 共享构建/脚本（pack-vsix · fetch-cloudflared · render_check · gh-approve · sync）
└── docs/                     # 文档（archive/ 存旧架构正典：CANON 五插件 / REARCH / AUDIT / 实测）
```

道法自然：dao-one 功能上仍内置内网穿透（vendor-bridge），而 **dao-bridge 作为可独立安装的插件归在辅助板块**。

---

## ① 核心 4 — core/

### dao-one · 归一插件本体（最终交付）

**本源架构 — 以 dao-vsix 为基础 + Proxy Pro**：以 **dao-vsix 二合一**为本源，在其 dao Cloud 全功能面板内**折入** Proxy Pro 三模块（①本源观照 ②渠道配置 ③模型路由，与「内网穿透 / Sessions / Knowledge …」并列为面板内部 tab），再合 rt-flow 切号 —— 最终前端只剩**两面**：左 rt-flow 切号 + 中 单一全功能面板。`core/dao-one/build.js` **每次都从兄弟目录** `core/{dao-vsix,dao-proxy-pro,rt-flow}` 与 `addons/dao-bridge` **现拷最新源**装配 `vendor-*`（gitignored 构建产物），并在构建期把 `proxy-fold.patch` 叠到 `vendor-vsix`（**dao-vsix 源永不沾 proxy**，保持纯二合一），再由 vsce 打包。详见 [`core/dao-one/README.md`](core/dao-one/README.md)。

**构建**：`cd core/dao-one && npm install && node build.js && npx @vscode/vsce package --allow-missing-repository --skip-license` · **源码**：`core/dao-one/{build.js,extension.js,proxy-fold.patch,apply-overlay.js,gen-manifest.js,package.json}`
> ⚠️ `package.json` 为手工维护清单（含全部 contributions），**不要跑 `gen-manifest.js` 覆盖**（它会重置版本并丢失手工合并的贡献项）。

### dao-vsix · 二合一面板 + 本地 HTTP API

本地 HTTP API（30+ 端点）+ `app.devin.ai` 路由官网零 GUI 自动登录；SSE 流式直通。**多账号反向注入**：`POST /api/devin/batch-inject`（`{all:true}` 本机池 / `{accounts:[...]}` / `{lines:"..."}`，可选 `{wait:true}`）+ `GET /api/devin/batch-inject/status`，并以 `asciiSafeJson()`（所有非 ASCII 转 `\uXXXX`）根治 Devin 接口对原始 UTF-8 中文请求体「每隔一字截断」的服务端缺陷。

**源码**：`core/dao-vsix/src/extension.ts` · **📹 视频**：[▶ 教程](https://github.com/user-attachments/assets/194e1211-739d-494c-9cf2-ff016672485d)

### rt-flow · Devin Cloud 接入本体

零依赖 `devin_cloud.js` 封装 Devin Cloud 全部 API。三大模块：对话备份（增量 ZIP + `snapshotAccountData` 全量快照）；一键回归本源 wipe（先本地留底，再清用户数据，保留本源默认）；对话额度上限（实时余额 − 缓冲，低额自动中停）。删除端点已纠正为 `/api/playbooks|secrets/{id}`，Git 用 `git-permissions` 真撤授权。

**底层**：`core/rt-flow/devin_cloud.js` · **变更史**：`core/rt-flow/changelog.md` · **📹 视频**：[▶ 教程](https://github.com/user-attachments/assets/9ec20452-cb5f-4423-9204-f06088f75079)

### dao-proxy-pro · 提示词隔离 + 外接路由

底层拦截 IDE AI 请求，隔离替换提示词（道藏规则 + 用户注入），外接第三方模型路由。模型家族级路由（tier-agnostic）、实证探活（最小真实 chat 探测）、真实渠道直连根治 501 回弹、去名补全（官方产品名脱敏）。

**源码**：`core/dao-proxy-pro/extension.js` · **渲染校验**：`node tools/render_check.js` · **📹 视频**：[▶ 教程](https://github.com/user-attachments/assets/7094683e-c9f3-4461-96f6-fadd15c0aabf)

---

## ② 辅助 4 — addons/

### dao-bridge · 内网穿透栈（relay-first · 零账号）

**默认通道 = dao-relay Worker+DO 出站中继**（`dao-relay-do.zhouyoukang.workers.dev`）：零 Cloudflare 账号、URL 天然稳定（`…workers.dev/relay/<session>`）、纯出站无 50MB 二进制、适配一切平台；连不上才**自动回退 cloudflared**（命名隧道 → quick tunnel，http2 优先）。cloudflared 路径已做**自愈**（`--version` 探活 + 断点续传 + 半成品自动重下）与 **macOS `.tgz` 解包**。随 IDE 启停，零配置一键打通整机公网；`daoBridge.disableRelay` 可关中继。

**内网穿透栈**：`dao-bridge-ext/`（VS Code 插件·默认通道）· `agent.js/core.js`（纯 Node 独立后端·全平台兜底）· [`dao-relay/`](addons/dao-relay/README.md)（中继 Worker·归一入库 v2·`(session,token)` 零账号配对）。手机端穿透已迁入 [`rt-flow-app`](addons/rt-flow-app/README.md)（内置 RelayService）。

**源码**：`addons/dao-bridge/dao-bridge-ext/extension.js` · **核心本体**：`addons/dao-bridge/{agent,core}.js` · **📹 视频**：[▶ 教程](https://github.com/user-attachments/assets/8c4aec08-8357-44f2-a169-d44c8d055dd3)

### rt-flow-app · Devin Cloud 手机版 APK (v0.7.0)

独立 APK 三合一：**切号 + 内网穿透 + 网页多实例**。取代了此前的 `rt-flow-mobile`（MV3 扩展·Kiwi 已停更）和 `dao-bridge-android`（Termux Agent）。1:1 桌面 RT Flow 面板移植 + 手机适配化简（去 DW/去 sw·突出编号+账号名·按钮 flex-wrap）。Per-account 展开面板（Sessions/Knowledge/Playbooks/Secrets/Git）。穿透配置动态化（每用户/设备独立，非固定 conn.json）。

**源码/文档**：[`addons/rt-flow-app/README.md`](addons/rt-flow-app/README.md)

### devin-git-auth · 多账号绑定同一 GitHub

零输入：自动加载 `~/.dao/accounts.json` 账号池 + `~/.dao/git-pats.json` PAT，"already registered" 智能处理 + 仓库可达性核验。

**源码**：`addons/devin-git-auth/extension.js` · **📹 视频**：[▶ 教程](https://github.com/user-attachments/assets/ae892f4c-90d4-46df-a0c6-2ca9006b9498)

### dao-export · 对话数据导出插件（单账号）

仅需邮箱+密码，把 Devin 官方 Session 面板完整路由到 VS Code 内，导出账号级数据 + 全部会话。VSIX 侧边栏实时进度 + 按需加载 worklog 分页。

**源码**：`addons/dao-export/`（`src/` + `package.json`）· **📹 视频**：[▶ 教程](https://github.com/user-attachments/assets/6a7fc519-514d-4d1e-b78b-967a4e817a60)

---

## ③ 板块 3 — cloud/（供 Devin Cloud 全链路开发）

### export-accounts · 导出其他账号对话全流程

纯后端（不依赖 VSIX / 浏览器）：邮箱+密码 → HTTP 全量导出。16 路并发 + keepalive + 重试 + 断点续传。

```bash
python cloud/export-accounts/dao_export_all.py --email xxx@gmail.com --password xxx
```

**后端逆向指南**：`cloud/export-accounts/BACKEND_GUIDE.md` · **开发经验**：`cloud/export-accounts/DEV_EXPERIENCE.md`

### vm-replica · Windows 多 RDP 类虚拟机

在台式机上复刻 Devin 操作自身虚拟机的全链路能力，底座换成 Windows 多 RDP：底座 = MCP Server 常驻 · 操作层 = FreeRDP + UIA + 截图视觉 · GUI 智能参考 UFO/OmniParser。第三方 MCP 源（playwright-mcp / mcp-servers）按需拉取，见 [`cloud/vm-replica/vendor/VENDOR.md`](cloud/vm-replica/vendor/VENDOR.md)。

**完整文档**：[`cloud/vm-replica/README.md`](cloud/vm-replica/README.md)

### coldstart · 冷启动高效登录流程

核心一条：让初始环境中的 Devin AI 极速完成配置部署。

```
① 装 Devin Desktop（API 解析最新版 → 静默安装）
② rt-flow 底层高效初始化登录第一个账号（注入 token，绕过浏览器 OAuth 回跳）
③ 构建并安装 dao-one 归一插件，卸载被内联的独立引擎
④ 进入实际开发
```

一键脚本 [`cloud/coldstart/coldstart.ps1`](cloud/coldstart/coldstart.ps1)。完整总纲（三类 token 辨析、VSIX 打包坑、webview 两大陷阱）见 [`cloud/coldstart/README.md`](cloud/coldstart/README.md) · Runbook：`cloud/coldstart/RUNBOOK_coldstart.md`。

---

## ④ 实测状态

| 模块 | 状态 | 说明 |
|------|------|------|
| dao-one | ✅ 构建通过 | dao-vsix 二合一为基 + proxy-pro 折入全能板（构建期 `proxy-fold.patch`）+ rt-flow/bridge；冷启动端到端实测三模块实拉实时数据 |
| dao-vsix | ✅ 全通 | 登录态跨重启保持 · 多账号反向注入 32/32（K/Bridge-KB/P/S 全验证、零损坏） |
| dao-bridge | ✅ 全通 | 隧道重启自愈 · `/api/exec` 鉴权 200/401 正确 |
| dao-proxy-pro | ✅ 已部署 | 提示词隔离 + 模型路由生效 |
| rt-flow | ✅ 实测验证 | 12/12 批量备份 + 一键 wipe 全链路真号验证 |
| devin-git-auth | ◑ 机制通 | 账号/PAT/设备流均通，组织 Git 连接待后端 oauth |
| rt-flow-app | ✅ S23 Ultra 实测 | v0.7.0 · 1:1 桌面面板移植 + 穿透动态配置 + 手机适配 · 取代 rt-flow-mobile 和 dao-bridge-android |

> 旧架构正典与历史实测见 [`docs/archive/`](docs/archive/)（CANON 五插件规范 · REARCH · AUDIT · LIVE_VERIFICATION）。

---

## PR 自动合并（道法自然）

本仓库配置了 [`.github/workflows/auto-merge.yml`](.github/workflows/auto-merge.yml)：向 `main` 提交的 PR，只要**无冲突（mergeable）即自动合并**，无需人工同意；**有冲突则自动跳过**，留待人工解决。草稿（draft）PR 不会被自动合并。
