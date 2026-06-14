# dao · 道法自然 · 太上 下知有之

> **5 插件 + 2 模块 + 1 人启动**（+ ⑥ rt-flow-mobile 浏览器/手机版扩展·新增板块）。GitHub Issues Comments = 无感传输层。

[![Release](https://img.shields.io/github/v/release/zhouyoukang1234-spec/devin-remote?label=release&color=2ea44f)](https://github.com/zhouyoukang1234-spec/devin-remote/releases/latest)
&nbsp;5 插件 + 2 模块 + 1 人启动&nbsp;·&nbsp;[全部下载 ↓](#下载--快速安装)&nbsp;·&nbsp;[人启动](bootstrap/README.md)

---

## 下载 · 快速安装

**一键冷启动**（自动装 Devin Desktop + 全部插件）：

```powershell
git clone https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\tools\coldstart.ps1
```

**单独下载**（点链接直接拿 VSIX → `devin-desktop --install-extension <vsix> --force`）：

| 板块 | 版本 | 下载 |
|------|------|------|
| ① dao-vsix · 全功能面板 | 2.0.0 | [⬇ vsix](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/v1.0.0/dao-vsix-2.0.0.vsix) |
| ② dao-bridge · 内网穿透 | 3.2.0 | [⬇ vsix](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/v1.0.0/dao-bridge-3.2.0.vsix) |
| ③ devin-git-auth · 多账号 Git | 2.3.2 | [⬇ vsix](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/v1.0.0/devin-git-auth-2.3.2.vsix) |
| ④ dao-proxy-pro · 模型路由 | 9.9.289 | [⬇ vsix](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/v1.0.0/dao-proxy-pro-9.9.289.vsix) |
| ⑤ rt-flow · Cloud 备份/wipe/对话上限 | 4.8.1 | [⬇ vsix](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/v1.0.0/rt-flow-4.8.1.vsix) |
| 模块 · dao-export · 全量导出 | 1.3.3 | [⬇ vsix](https://github.com/zhouyoukang1234-spec/devin-remote/releases/download/v1.0.0/dao-devin-export-1.3.3.vsix) |

> 全部资产见 [Releases](https://github.com/zhouyoukang1234-spec/devin-remote/releases/latest)。vm-replica 模块为纯源码/文档，见 [`modules/vm-replica/`](modules/vm-replica/)。

---

## 📹 操作视频教程 · 小白向（一看就明白）

> 每个视频均在真实虚拟机上实测录制，含分步标注与通过断言。**下方均为内嵌播放器，点击播放按钮即可在本页直接播放，无需下载。**

**① dao-vsix** — 打开全功能面板 → 邮箱密码登录拿 auth1 → 106 会话/175 Playbook → 本地 API :9920

https://github.com/user-attachments/assets/194e1211-739d-494c-9cf2-ff016672485d

**② dao-bridge** — 一键打通公网 → 得到 Cloudflare 公网地址 → 公网 health 实测通

https://github.com/user-attachments/assets/8c4aec08-8357-44f2-a169-d44c8d055dd3

**③ devin-git-auth** — 存 GitHub PAT → 加 Devin 账号 → 一键「全部连接到同一 GitHub」

https://github.com/user-attachments/assets/ae892f4c-90d4-46df-a0c6-2ca9006b9498

**④ dao-proxy-pro** — 本源观照面板（注入底层提示词）→ 多模型家族路由后端

https://github.com/user-attachments/assets/7094683e-c9f3-4461-96f6-fadd15c0aabf

**⑤ rt-flow** — 多账号实时额度 → 一键全部备份 → 本地对话 ZIP 留底

https://github.com/user-attachments/assets/9ec20452-cb5f-4423-9204-f06088f75079

**模块 dao-export** — 邮箱+密码 → 导出账号级数据 + 全部 106/106 会话

https://github.com/user-attachments/assets/6a7fc519-514d-4d1e-b78b-967a4e817a60

> 配套图文：[**小白上手指南**](docs/tutorials/小白上手指南.md)（冷启动 + 6 插件分步 + 排错速查）。

---

## 架构全貌 · 5 + 2 + 1

```
devin-remote/
│
├── plugins/                      # ★ 5 VSIX 核心插件（Devin Desktop 内运行）+ ⑥ rt-flow-mobile 浏览器扩展
│   ├── dao-vsix/                 # ① Devin 全功能面板 + 本地 HTTP 服务（30+ API 端点）
│   ├── dao-bridge/               # ② 工作区专属内网穿透本体（独立后端 Agent + dao-bridge-ext/：Cloudflare QUIC/HTTP2 隧道）
│   ├── devin-git-auth/           # ③ 多 Devin 账号绑定同一 GitHub 仓库
│   ├── dao-proxy-pro/            # ④ 底层提示词隔离替换 + 第三方模型路由
│   ├── rt-flow/                  # ⑤ Devin Cloud 接入：对话备份/全量快照/一键回归本源
│   └── rt-flow-mobile/           # ⑥ 浏览器/手机版自动切号（MV3 扩展·非 VSIX·桌面 Chrome / 安卓 Kiwi/Edge 侧载）⭐新
│
├── modules/                      # ★ 2 核心模块（离线可复刻 · 不依赖 IDE）
│   ├── vm-replica/               # 多 RDP 虚拟机化全链路（需求→架构→MCP 工具集）
│   └── dao-export/               # Devin AI 全量对话/数据导出（零依赖 Python + VSIX）
│
├── bootstrap/                    # ★ 1 人启动（冷启动板块：装 IDE→秒登账号→装插件→开发）
│   └── README.md                 #   人启动总纲 + 经验教训 + 三类 token 辨析
│
├── tools/                        # 冷启动/同步脚本（coldstart.ps1 · pack-vsix）
└── docs/                         # 正典文档（CANON 五插件规范 · 实测验证 · 冷启动 Runbook）
```

---

## ① 五核心插件 — plugins/

### dao-vsix v2.0.0 · Devin 全功能面板 + 路由官网 + 内网穿透集成

核心精简两板块：本地 HTTP API（30+ 端点）+ `app.devin.ai` 路由官网零 GUI 自动登录（根挂载代理 + Content-Length + Request 透传）。零输入获取 cog_ API Key（POST /service-users + auth1 自动换取），彻底移除面板所有手动 API Key 输入/引导。v1.2.0：增补测试聊天内置存根通道，与 dao-proxy-pro v9.9.286 配套。v1.3.3：SSE 流式直通——`text/event-stream` 响应边到边直送、不缓冲、移除 content-length，IDE 内嵌官网逐字流式输出。官网注入加固：session-token 与 auth1 严格隔离。

**VSIX**: 见 [Releases](https://github.com/zhouyoukang1234-spec/devin-remote/releases/latest)（本插件 VSIX 已 gitignore，`npm run compile && vsce package` 现产） · **源码**: `plugins/dao-vsix/src/extension.ts` · **📹 视频**: [▶ 小白教程（点击直接播放）](https://github.com/user-attachments/assets/194e1211-739d-494c-9cf2-ff016672485d)

### dao-bridge v3.2.0 · 工作区内网穿透

重构为零/最小输入：quick tunnel 默认模式 + 凭证自动加载（`~/.dao/` 目录）+ 命名隧道 token 持久化 + 修正误导 UI（不再暗示必须填 token）。随 IDE 窗口启停，专穿当前工作区。v3.2.0：新增 local-agent 深度控制 HTTP API + 修正 cloudflared 二进制解析的 ENOENT 404（绕过 npm/choco shim，直取真实可执行）。

**VSIX**: `plugins/dao-bridge/dao-bridge-ext/dao-bridge-3.2.0.vsix` · **源码**: `plugins/dao-bridge/dao-bridge-ext/extension.js` · **核心本体**: `plugins/dao-bridge/{agent,core}.js` · **📹 视频**: [▶ 小白教程（点击直接播放）](https://github.com/user-attachments/assets/8c4aec08-8357-44f2-a169-d44c8d055dd3)

### devin-git-auth v2.3.2 · 多账号 GitHub 认证

零输入：自动加载 `~/.dao/accounts.json` 账号池 + `~/.dao/git-pats.json` PAT。"already registered" 智能处理 + 仓库可达性核验。全 13 账号实测：9/13 可访问 `devin-remote`（10 个已连通），余 3 个卡在后端"已注册但 0 连接"幽灵态 —— 如实诊断、不做假兜底。

**VSIX**: `plugins/devin-git-auth/devin-git-auth-2.3.2.vsix` · **源码**: `plugins/devin-git-auth/extension.js` · **📹 视频**: [▶ 小白教程（点击直接播放）](https://github.com/user-attachments/assets/ae892f4c-90d4-46df-a0c6-2ca9006b9498)

### dao-proxy-pro v9.9.289 · 提示词隔离 + 外接路由

底层拦截 IDE AI 请求，隔离替换提示词（道藏规则 + 用户自定义注入），外接第三方模型路由。vendor 目录含 LSP 模拟器、适应性路由、预算控制、三模块面板（49 家模型归一 + 测通）。v9.9.277：修复「渠道配置永远红点」——探活改为「带 Bearer 鉴权的 /models 探测」（HTTP 200 即绿、自动回填模型），并修复 baseUrl 已含 `/v1` 时模型探测拼成 `/v1/v1/models` 404。v9.9.282~283：**模型家族级路由（tier-agnostic）**——只要用户显式连接了某家族的任一层级（如 `swe-1-6-fast→deepseek`），该家族全部层级（含 Cascade 默认发的 `swe-1-6-slow`）都路由到同一渠道，不再 501 回弹；纯 seeded 桩家族不被劫持。并导出 `resolveRoute()` 使 test-chat 诊断走真实路由表（不再误报「route config not found」）。v9.9.284~286：兄弟档位择优——真实外接渠道优先于 builtin-stub/substitute（杜绝 slow 档被导向测试桩而非用户连的渠道）；渠道「实证探活」——probe 改发最小真实 chat、看 HTTP 码+响应体，杜绝「/models 200 却 chat 被拒」假阳与「/models 404 却 chat 实通」假阴；**真实渠道直连根治回弹**——`_callProvider` 有 baseUrl 即直连真实渠道、无 baseUrl 才兜底本地网关，根治 deepseek/github 被误丢给未启动本地网关 → ECONNREFUSED → 501 回弹。v9.9.287~289：**去名补全**（工具描述/参数描述/系统提示尾里官方产品名 Cascade→`you`、Windsurf/Codeium→`the editor`，真实出站零大写身份泄漏）；**上游错误可读回传**（GitHub 免费层 8k → 413 转可读错误帧而非对话死亡；预算裁剪 `藏而不用`、默认全注入）；**控制面补全** `/origin/health`（存活别名）+ `/origin/selftest`（道魂/外接/解锁三径自检）。

**VSIX**: `plugins/dao-proxy-pro/dao-proxy-pro-9.9.289.vsix` · **📹 视频**: [▶ 小白教程（点击直接播放）](https://github.com/user-attachments/assets/7094683e-c9f3-4461-96f6-fadd15c0aabf)

### rt-flow v4.8.1 · Devin Cloud 接入（备份 + 回归本源 + 对话额度上限 + 状态持久化）⭐新

第五板块，零依赖 `devin_cloud.js` 底层封装 Devin Cloud 全部 API（邮箱+密码→auth1 登录、概览、对话追踪、CRUD、备份、wipe）。三大核心模块：

- **对话备份（批量 + 自动）**：增量 ZIP/文件夹备份对话 + `snapshotAccountData` 全量数据快照（知识库/剧本正文 + 密钥/Git/会话/额度元数据全量留底）。快照逐条 `_settle` 重试，一条端点失败不毁整份（`partial`/`errors` 如实标注），批量 12 账号并发实测 12/12。
- **一键回归本源（wipe）**：先 `backupAccountFull` 本地留底，再清空账号全部用户数据（对话归档 + 知识/剧本/密钥真删 + Git 授权撤销），**保留 Devin 本源默认**（3 内置知识 + 32 社区剧本）。区分「用户数据」与「本源默认」，不误删、不臆造成功。
- **对话额度上限（v4.5.0·知止不殆）**：每对话使用额度上限 = 账号实时余额 − 缓冲（默 $3）；余额 $70→上限 $67、$55→$52，随余额下降实时跟随、与官网每刀额度同步（精确到分）。账号确认使用中（余额下降或有运行对话）才提速轮询；余额 ≤ 停止阈值（默 $3）自动**中停**运行中对话。自动清理阈值默认 $3→**$1**（额度 ≤ $1 先全量备份成功→再水过无痕）。

> 实测修复多个「臆造成功」缺陷：剧本/密钥删除端点纠正（`/api/playbooks|secrets/{id}`）、会话改归档（平台不支持硬删）、Git 改用 `git-permissions` 真撤授权（连接元数据平台无删除端点，如实回报）；`stopSession` 同理按候选端点实探、不臆造成功。v4.6.1：修复多账号锁旋转误判——账号默认上锁时 `getSortedIndices` 致 `rotate()` 候选为 0 而误报「所有账号失败」（实为登录全成功、仅设置项无锁选），已改为正确跳过锁定项。v4.7.0~4.7.8：**单对话级操作**（概览每对话加查/下 ZIP/清按钮）、**知识库/剧本/密钥逐条查/下/删 + 批量**、**PAT 反注**（一把 PAT 作 `GITHUB_PAT` 密钥写全账号）、**对话追踪账号编号(1-N)**、**低额≤$3 主动中停 + 余额耗用自重轮询**、`VERSION` 常量随 `package.json` 同步（版号统一），并经 141 实机双源回归实测。

**VSIX**: `plugins/rt-flow/rt-flow-4.8.1.vsix` · **底层**: `plugins/rt-flow/devin_cloud.js` · **变更史**: `plugins/rt-flow/changelog.md` · **📹 视频**: [▶ 小白教程（点击直接播放）](https://github.com/user-attachments/assets/9ec20452-cb5f-4423-9204-f06088f75079)

### rt-flow-mobile v1.0.0 · 浏览器/手机版自动切号（rt-flow 的移动端移植）⭐新

第 6 个插件，**不在前述 5 个 VSIX 之列**：把 ⑤ rt-flow 的「多账号自动切换」+ dao-vsix 的「官网注入自动登录」合一，移植到**浏览器**的 Chromium MV3 扩展。无 Devin Desktop / VSCode 依赖，可在桌面 Chrome / Edge 与 **Android 上的 Kiwi / Edge** 侧载运行。换 auth1 即换号。

- **登录注入**：`email+password → POST windsurf.com/_devin-auth/password/login → auth1`；content script 于 `document_start` 在 `app.devin.ai` 种入 `localStorage['auth1_session']` + org 守卫键，并用 `declarativeNetRequest` 给 `/api/*` 注入 `Authorization` / `x-cog-org-id` → SPA 零 GUI 自动登录。
- **自动切号**：`chrome.alarms` 轮询活跃账号余额（`GET /api/{orgId}/billing/status`），≤ 缓冲（默 $3）→ rotate 到评分最优账号；content script 探测页面「额度耗尽」文案 → 主动上报立即轮转。
- **storage-first 面板**：popup 直读 `chrome.storage` 渲染，不依赖 service worker 是否唤醒（根除 MV3 冷启竞态导致的面板卡死）。

**源码**: `plugins/rt-flow-mobile/`（`src/cloud.js` 登录链路 · `src/background.js` 切号引擎 · `src/content.js` 注入 · `src/popup.{html,js,css}` 面板）· **说明/安装/接力**: [`plugins/rt-flow-mobile/README.md`](plugins/rt-flow-mobile/README.md) · **安卓侧载实测**: [`plugins/rt-flow-mobile/docs/ANDROID_TEST.md`](plugins/rt-flow-mobile/docs/ANDROID_TEST.md)

---

## ② 核心模块 — modules/

### vm-replica · 多 RDP 虚拟机化

在 141 台式机上复刻 Devin 操作自身虚拟机的全链路能力，底座换成 Windows 多 RDP。

> 架构：底座 = MCP Server 常驻服务 · 操作层 = FreeRDP + UIA + 截图视觉 · GUI 智能参考 UFO/OmniParser

[→ 完整文档](modules/vm-replica/README.md) · 48 文件（6 需求/架构文档 + 47 MCP 客户端脚本 + 17 实践截图）

### dao-export v1.3.3 · Devin AI 全量对话导出

用户仅需邮箱+密码，导出 Devin 账号内一切（会话/事件/云端文件/Playbooks/Knowledge/Secrets）。

```bash
python dao_export_all.py --email xxx@gmail.com --password xxx
```

16 路并发 + keepalive 连接复用 + 重试 + 断点续传。VSIX 侧边栏实时进度 + 按需加载 worklog 分页。

**VSIX**: `modules/dao-export/dao-devin-export-1.3.3.vsix` · **📹 视频**: [▶ 小白教程（点击直接播放）](https://github.com/user-attachments/assets/6a7fc519-514d-4d1e-b78b-967a4e817a60)

> [→ 完整文档](modules/dao-export/README.md) · 含 VSIX 源码 + API 逆向指南

---

## ③ 人启动 · 冷启动板块 — bootstrap/

核心逻辑只有一条：**让初始环境中的 Devin AI 极速完成配置部署**。

```
① 装 Devin Desktop（更新 API 解析最新版 → 静默安装，无 GUI 点击）
② rt-flow 底层高效初始化登录第一个账号（注入 token，绕过浏览器 OAuth 回跳）
③ devin-desktop --install-extension 批量装 5 个插件 VSIX
④ 进入实际开发
```

一键脚本 `tools/coldstart.ps1` 直接从仓库 `plugins/*/*.vsix` 安装全部插件。完整总纲（含三类 token 辨析、VSIX 打包坑、webview 两大陷阱、经验教训清单）见 **[bootstrap/README.md](bootstrap/README.md)**。

---

## ④ 实测状态

| 插件 | 状态 | 说明 |
|------|------|------|
| dao-bridge | ✅ 全通 | 隧道重启自愈 · `/api/exec` 鉴权 200/401 正确 |
| dao-vsix | ✅ 全通 | 登录态跨重启保持 · Secret/Knowledge/Playbook 全注入 |
| devin-git-auth | ◑ 机制通 | 账号/PAT/设备流均通，组织 Git 连接待后端 oauth |
| dao-proxy-pro | ✅ 已部署 | 提示词隔离 + 模型路由生效 |
| rt-flow | ✅ 实测验证 | 12/12 批量备份 + 一键 wipe 全链路真号验证（备份留底→用户数据清零→本源默认保留） |
| rt-flow-mobile | ◑ 桌面实测 | 浏览器 MV3 扩展：桌面 Chrome 全流程通过（登录注入 / 自动切号 / storage-first 面板，含修复 MV3 冷启竞态）；安卓 Kiwi/Edge 侧载待真机验证（本 VM 无嵌套 KVM/VT-x） |

> 实测详情：[docs/LIVE_VERIFICATION_2026-06-11.md](docs/LIVE_VERIFICATION_2026-06-11.md) · 五插件规范：[docs/CANON_five-plugins.md](docs/CANON_five-plugins.md)

---

## PR 自动合并（道法自然）

本仓库配置了 [`.github/workflows/auto-merge.yml`](.github/workflows/auto-merge.yml)：向 `main` 提交的 PR，只要**无冲突（mergeable）即自动合并**，无需人工同意；**有冲突则自动跳过**，留待人工解决。
