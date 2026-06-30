# dao · 让 Devin Cloud 成为你本地电脑的 AI 编程助手

> **道法自然 · 太上下知有之** —— 把云端 **Devin Cloud** Agent 通过「零成本、零配置、无感内网穿透」**直连你的本地电脑**，
> 在 VS Code / Windsurf 里像用 Windsurf / Cursor 一样使用 Devin，并统一管理**多账号切换 · 反向注入 · 第三方模型路由**。

[![Release](https://img.shields.io/github/v/release/zhouyoukang1234-spec/devin-remote?label=release&color=2ea44f)](https://github.com/zhouyoukang1234-spec/devin-remote/releases/latest)
&nbsp;·&nbsp;架构 4 + 4 + 3&nbsp;·&nbsp;[▶ 演示视频](#演示视频)&nbsp;·&nbsp;[⬇ 快速安装](#下载--快速安装)&nbsp;·&nbsp;[📱 手机版 APK](#手机版-apk--直接下载)&nbsp;·&nbsp;[📦 模块下载](#模块下载--去中心化按模块独立发版)&nbsp;·&nbsp;[🧊 冷启动](cloud/coldstart/README.md)

<!-- DAO-APK-LINK:START -->
**📱 Devin Cloud 手机版 · 直接下载 APK**（安卓本体，辅助 ②）：[⬇ DevinCloud-mobile-v0.37.117.apk](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/rtflow-v0.37.117/DevinCloud-mobile-v0.37.117.apk) · 下载后允许「安装未知应用」即可装。
<!-- DAO-APK-LINK:END -->

---

## 演示视频

<p align="center">
  <a href="https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/demo-assets/devin-remote-demo.mp4" title="点击播放完整高清演示（含声音 · MP4 · 全球直达）">
    <img src="https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/demo-assets/devin-remote-demo.gif" alt="dao · Devin Cloud 直连本地电脑 · 无感内网穿透 · 平替 WindSurf 演示" width="900" />
  </a>
</p>

<p align="center">
  ▶ <b><a href="https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/demo-assets/devin-remote-demo.mp4">点击播放完整高清演示（含声音 · MP4 · 全球直达）</a></b>
  &nbsp;·&nbsp; 原视频来源：<a href="https://www.bilibili.com/video/BV1HbjP6oE77">哔哩哔哩 BV1HbjP6oE77</a>
</p>

> 上方为**自动循环播放**的预览动图（打开页面即动，无需点击）。想看带声音的全程录屏，**优先点「完整高清演示（MP4）」**：自托管于本仓库 [demo-assets](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/demo-assets) Release，**全球直达、不受 B 站风控 / 分区限制**。B 站为原片出处（`BV1HbjP6oE77`，已核验有效），需在可正常访问哔哩哔哩的网络环境下打开；若 B 站提示「412 安全风控」属其对部分网络的拦截，与本链接无关，用上面的 MP4 直链即可稳定观看。

---

## 这是什么？（30 秒看懂）

- 🌉 **云端 Agent 直连本地电脑**：Devin Cloud 跑在云端，经 `dao-bridge` **零配置内网穿透**直接读写你本地电脑的文件 / 终端 / 仓库 —— 不需要公网 IP、不需要改路由器、不需要 Cloudflare 账号。
- 🪟 **彻底平替 WindSurf / Cursor 的本地体验**：在 VS Code / Windsurf 里把云端 Devin 当本地 AI 助手用，对话、改码、跑命令一气呵成。
- 🏠 **单账号全功能面板**：一个面板**实时读写**当前账号的 额度 / Knowledge / Playbook / Secret / 环境蓝图 / MCP / 环境 / 自动化，与官网完全双向同步。
- 🔁 **多账号 RT Flow + 反向注入**：左栏一键切号；把 Knowledge / Playbook / Secret / MCP / 自动化 **批量注入到所有账号**。
- 🧩 **提示词隔离 + 第三方模型路由**（Proxy Pro 三面板：本源观照 / 渠道配置 / 模型路由）。
- 🔌 **多 IDE 通用 MCP**（3.24.0）：插件装到哪个 IDE（Devin Desktop / Windsurf / Cursor / VS Code / Trae / Antigravity / Claude）就自动识别该 IDE 的 MCP 配置，一键修复跟着软件走，强鲁棒性零硬编码。
- 📦 **去中心化发版**：每个插件各有独立 Release / 下载链接，开发哪个就只刷新哪个，互不干扰。

> 想直接上手 → 看下方 **[下载 · 快速安装](#下载--快速安装)**；想了解构成 → 看 **[架构全貌 4 + 4 + 3](#架构全貌--4--4--3)**。
>
> 🤖 **要改本仓代码的 Agent 先读 [`AGENTS.md`](AGENTS.md)**：本源认知（dao-vsix 才是主体，dao-one 只是 +Proxy Pro）、六大板块分而治之 / 网页套网页（`/shell`）、内网穿透去中心化（不需要 Cloudflare 账号）、多实例、历史踩坑清单，**正本清源、防止重蹈覆辙**。

---

## 下载 · 快速安装

**一键冷启动**（自动装 Devin Desktop + 构建并安装 dao-one 大 one 插件）：

```powershell
git clone https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\cloud\coldstart\coldstart.ps1
```

冷启动脚本会从源码构建 **dao-one 大 one**（`core/dao-one`，以 dao-vsix 二合一为**本源基座** + Proxy Pro 三面板**子模块** + 本地 HTTP API），安装后卸载会抢占同名 id 的 `dao-vsix` / `rt-flow` / `dao-proxy-pro`，让 `dao.dao-one` 成为唯一属主。**最终以 dao-one 大 one 为主交付**；若只要纯二合一本源，可单独构建 `core/dao-vsix`。

> 所有 VSIX 均为构建产物（已 `.gitignore`，走 [Releases](https://github.com/zhouyoukang1234-spec/devin-remote/releases) 分发或本地 `node build.js && npx @vscode/vsce package` 现产）。

---

## 手机版 APK · 直接下载

> **想直接在安卓手机上用 → 不必装电脑端**。手机版是辅助板块的第 ② 个模块（`addons/rt-flow-app`），自成一个 APK，主页即可直接下载安装。

1. 点上方置顶的 **[⬇ 直接下载 APK](#dao--让-devin-cloud-成为你本地电脑的-ai-编程助手)**（或在 [📦 模块下载](#模块下载--去中心化按模块独立发版) 表里 `rt-flow-app` 行点 ⬇ APK）。
2. 安卓打开下载的 `DevinCloud-mobile-v*.apk` → 允许「安装未知应用」→ 安装。
3. 首次启动在「穿透配置」填入中继 `URL / Token / Session` → 保存自动连接，云端 Agent 即可经隧道远程驱动本机。

> 内网穿透的**中继源**（`addons/dao-relay` 的 Worker，URL 形如 `…workers.dev/relay/<session>`）只是把手机挂上公网的**通道**；APK 本体作为独立资产发布在手机版自己的 Release（tag `rtflow-v<版本>`，资产 `DevinCloud-mobile-v<版本>.apk`）。两者各司其职：中继负责连通，APK 才是要装到手机上的软件本体。
>
> 手机版 APK 由其自身的发版流程独立产出（gradle 编译 + 签名固定 `e261b27f`，v0.15.x 原地覆盖升级、数据不丢），不走 VSIX 的 `.github/workflows/release.yml`。

---

## 模块下载 · 去中心化（按模块独立发版）

每个插件**互不干扰**、各有独立的 Release / tag / 下载链接：开发哪个就只刷新哪个，不被「整合大 Release」绑架（鸡犬相闻，民至于老死不相往来）。下表由 CI（`.github/workflows/release.yml`）依据各模块当前版本**自动维护**，链接指向**该模块自己的** Release 资产（tag 形如 `‹模块›-v‹版本›`）。

<!-- DAO-MODULE-INDEX:START -->
| 模块 | 版本 | 扩展 id | 说明 | Release / 下载 |
|---|---|---|---|---|
| **dao-one** | `2.18.3` | `dao.dao-one` | 最终主交付：dao-vsix 二合一本源基座 + Proxy Pro 三面板子模块（折入 Devin Cloud 全功能面板），其余与 dao-vsix 完全一致。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/dao-one-v2.18.3) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/dao-one-v2.18.3/dao-one-2.18.3.vsix) |
| **dao-vsix** | `3.50.64` | `dao.dao-vsix` | 本源基座：rt-flow 切号视图 + Devin Cloud 全功能面板 + 本地 HTTP API（含多账号反向注入）。可单独安装。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/dao-vsix-v3.50.64) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/dao-vsix-v3.50.64/dao-vsix-3.50.64.vsix) |
| **rt-flow** | `4.26.5` | `devaid.rt-flow` | Devin Cloud 接入本体：对话备份 / 全量快照 / 一键回归本源 wipe / 对话额度上限。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/rt-flow-v4.26.5) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/rt-flow-v4.26.5/rt-flow-4.26.5.vsix) |
| **dao-proxy-pro** | `9.9.326` | `dao-agi.dao-proxy-pro` | 底层提示词隔离替换 + 外接第三方模型路由。三面板：本源观照 / 渠道配置 / 模型路由。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/dao-proxy-pro-v9.9.326) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/dao-proxy-pro-v9.9.326/dao-proxy-pro-9.9.326.vsix) |
| **dao-bridge** | `3.11.0` | `dao.dao-bridge` | 内网穿透本体：默认 Cloudflare 快速隧道（去中心化，无 Worker），配置账号走命名隧道；cloudflared 自愈/断点续传，随 IDE 自启。独立 addon，不与其它插件冲突。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/dao-bridge-v3.11.0) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/dao-bridge-v3.11.0/dao-bridge-3.11.0.vsix) |
| **rt-flow-app** | `0.37.117` | `ai.devin.rtflow` _(APK)_ | Devin Cloud 手机版 APK（安卓本体）：切号 + 内网穿透 + 网页多实例 + 浏览器自动化 + 手机本体操控 + 系统级接管 + 渐进式文档。主页可直接下载安装。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/rtflow-v0.37.117) · [⬇ APK](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/rtflow-v0.37.117/DevinCloud-mobile-v0.37.117.apk) |
| **devin-git-auth** | `2.3.2` | `devaid.devin-git-auth` | 多 Devin 账号绑定同一 GitHub（git-permissions 真实授权管理）。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/devin-git-auth-v2.3.2) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/devin-git-auth-v2.3.2/devin-git-auth-2.3.2.vsix) |
| **dao-devin-export** | `1.4.3` | `dao-natural.dao-devin-export` | 单账号对话数据导出插件（VSIX）。 | [Release](https://github.com/zhouyoukang1234-spec/devin-remote/releases/tag/dao-devin-export-v1.4.3) · [⬇ VSIX](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/dao-devin-export-v1.4.3/dao-devin-export-1.4.3.vsix) |
| **dao-relay** | `2.0.0` | _(Worker)_ | 内网穿透栈的中继 Worker 源（Cloudflare Worker，v2·(session,token) 零账号配对·一键部署）。非 VSIX，不进编辑器安装。 | [源码](https://github.com/zhouyoukang1234-spec/devin-remote/tree/main/addons/dao-relay) |
<!-- DAO-MODULE-INDEX:END -->

> 想要一站式的最终主交付，装 **dao-one** 即可（已内联 dao-vsix 本源 + Proxy Pro 子模块）；想要纯二合一本源，装 **dao-vsix**；其余为按需独立插件。

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

**多 IDE 通用 MCP（3.24.0）**：`daoHostIdeKey()` 由 `vscode.env.appName`+`execPath` 识别宿主 IDE；`daoIdeMcpCandidates()` 为各 IDE（Devin Desktop/Windsurf/Cursor/VS Code/Trae/Antigravity/Claude/Gemini）跨平台解析 MCP 配置路径为单一真源；`/api/devin/mcp/ide` 返回 `hostIde`+`hostSource`；一键修复 `daoRepairLocalMcp()` 默认修宿主 IDE + 接龙核心(Windsurf⇄Devin 共享配置)，`allIdes=true` 修全部。浏览器多实例 `winDefaultBrowserExe()` 读注册表默认浏览器，Chrome 优先否则用户默认 Chromium 系浏览器。

**源码**：`core/dao-vsix/src/extension.ts`

### rt-flow · Devin Cloud 接入本体

零依赖 `devin_cloud.js` 封装 Devin Cloud 全部 API。三大模块：对话备份（增量 ZIP + `snapshotAccountData` 全量快照）；一键回归本源 wipe（先本地留底，再清用户数据，保留本源默认）；对话额度上限（实时余额 − 缓冲，低额自动中停）。删除端点已纠正为 `/api/playbooks|secrets/{id}`，Git 用 `git-permissions` 真撤授权。

**底层**：`core/rt-flow/devin_cloud.js` · **变更史**：`core/rt-flow/changelog.md`

### dao-proxy-pro · 提示词隔离 + 外接路由

底层拦截 IDE AI 请求，隔离替换提示词（道藏规则 + 用户注入），外接第三方模型路由。模型家族级路由（tier-agnostic）、实证探活（最小真实 chat 探测）、真实渠道直连根治 501 回弹、去名补全（官方产品名脱敏）。

**源码**：`core/dao-proxy-pro/extension.js` · **渲染校验**：`node tools/render_check.js`

---

## ② 辅助 4 — addons/

### dao-bridge · 内网穿透栈（relay-first · 零账号）

**默认通道 = dao-relay Worker+DO 出站中继**（`dao-relay-do.zhouyoukang.workers.dev`）：零 Cloudflare 账号、URL 天然稳定（`…workers.dev/relay/<session>`）、纯出站无 50MB 二进制、适配一切平台；连不上才**自动回退 cloudflared**（命名隧道 → quick tunnel，http2 优先）。cloudflared 路径已做**自愈**（`--version` 探活 + 断点续传 + 半成品自动重下）与 **macOS `.tgz` 解包**。随 IDE 启停，零配置一键打通整机公网；`daoBridge.disableRelay` 可关中继。

**内网穿透栈**：`dao-bridge-ext/`（VS Code 插件·默认通道）· `agent.js/core.js`（纯 Node 独立后端·全平台兜底）· [`dao-relay/`](addons/dao-relay/README.md)（中继 Worker·归一入库 v2·`(session,token)` 零账号配对）。手机端穿透已迁入 [`rt-flow-app`](addons/rt-flow-app/README.md)（内置 RelayService）。

**源码**：`addons/dao-bridge/dao-bridge-ext/extension.js` · **核心本体**：`addons/dao-bridge/{agent,core}.js`

### rt-flow-app · Devin Cloud 手机版 APK (v0.15.16)

> 主页可[直接下载 APK](#手机版-apk--直接下载)。这是**唯一**的手机端方案（取代已废弃的 `rt-flow-mobile` / `dao-bridge-android`），自成一个 APK。

独立 APK 七合一：**切号 + 内网穿透 + 网页多实例 + 浏览器自动化 + 手机本体操控 + 系统级接管 + 渐进式文档**。1:1 桌面版面板移植 + 手机适配化简。Per-account 展开面板（Sessions/Knowledge/Playbooks/Secrets/Git）+ 对话备份/查看全文/下载（MD/ZIP）。穿透配置动态化。v0.14.0 新增：远程浏览器自动化（browse* 11 RPCs·DOM/Cookie/Storage/截图/执行JS/导出MD）+ 手机本体操控（phone* 10 RPCs·文件系统/相册/剪贴板/通知/应用） + 安全开关 + Progressive Disclosure 文档系统。v0.14.1 新增：高级浏览器自动化（browse* +8·点击元素/填表/等待元素/提交表单/提取链接+输入值/页面信息/滚动）+ 高级手机操控（phone* +4·电池/WiFi/振动/音量）+ getCloudMd/getLocalMd 完整 API 文档生成 RPC。v0.14.2 新增：敏感数据读取（phone* +5·联系人/短信收件箱(含OTP验证码)/通话记录 + 运行时权限申请/查询），辅助全链路账号注册。v0.14.3 新增：ADB/scrcpy 级**系统级接管**（RtAccessibilityService 无需 root·phone* +10）：坐标点击/长按/滑动手势注入 + 返回/主页/最近/通知/锁屏全局操作 + 读屏控件树 + 按文字点击 + 文本输入 + 全屏截图。v0.14.4 重新锚定本源：全仓统一命名 Devin Cloud 手机版（清除 RT Flow 残留）+ 渐进式文档系统重构（云端 MD 轻量接入·三大核心板块概览·getModuleDoc 按需深入·getLocalMd 重型本地）+ 一键授权 phoneEnsureControl（自动跳转无障碍设置·用户只点一次「允许」）+ 远程开关在浏览器壳同步生效 + Node mock-Native 测试台。v0.15.16 对齐桌面：切号面板每条对话行新增 **📦 下载 ZIP（含产出文件夹）** —— 整包内含 `对话_人类可读.md` + `工作日志.md` + `_meta.json` + `files/<全部产出文件>`，与电脑端 dao-vsix「下载对话内容」产物结构一致（纯 JS 零依赖 ZIP 写入器，产出文件经原生桥二进制无损取回）；引擎 RPC `extractConversation` 新增 `zip:true` 回传 `zipB64`，云端 Agent 经隧道即可取「MD+ZIP」整包。

**源码/文档**：[`addons/rt-flow-app/README.md`](addons/rt-flow-app/README.md)

### devin-git-auth · 多账号绑定同一 GitHub

零输入：自动加载 `~/.dao/accounts.json` 账号池 + `~/.dao/git-pats.json` PAT，"already registered" 智能处理 + 仓库可达性核验。

**源码**：`addons/devin-git-auth/extension.js`

### dao-export · 对话数据导出插件（单账号）

仅需邮箱+密码，把 Devin 官方 Session 面板完整路由到 VS Code 内，导出账号级数据 + 全部会话。VSIX 侧边栏实时进度 + 按需加载 worklog 分页。

**源码**：`addons/dao-export/`（`src/` + `package.json`）

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
| rt-flow-app | ✅ S23 Ultra 实测 | v0.15.16 · 七合一(切号+穿透+多实例+浏览器自动化+手机操控+系统级接管+渐进式文档) · browse* 19 + phone* 29 RPCs(含无障碍手势/读屏/截图) + 对话备份/拖拽提取/自动清理 + 去中心化隧道(自带 cloudflared 免账号快隧) + IPC 桥 + 安全开关 + 本地 gradlew 编译验证 |

> 旧架构正典与历史实测见 [`docs/archive/`](docs/archive/)（CANON 五插件规范 · REARCH · AUDIT · LIVE_VERIFICATION）。

---

## PR 自动合并（道法自然）

本仓库配置了 [`.github/workflows/auto-merge.yml`](.github/workflows/auto-merge.yml)：向 `main` 提交的 PR，只要**无冲突（mergeable）即自动合并**，无需人工同意；**有冲突则自动跳过**，留待人工解决。草稿（draft）PR 不会被自动合并。
