# dao · 道法自然 · 太上 下知有之

> **5 插件 + 2 模块 + 1 人启动**。GitHub Issues Comments = 无感传输层。

---

## 架构全貌 · 5 + 2 + 1

```
devin-remote/
│
├── plugins/                      # ★ 5 核心插件（VSIX · Devin Desktop 内运行）
│   ├── dao-vsix/                 # ① Devin 全功能面板 + 本地 HTTP 服务（30+ API 端点）
│   ├── cf-daohub/dao-bridge-ext/ # ② 工作区专属内网穿透（Cloudflare QUIC/HTTP2 隧道）
│   ├── devin-git-auth/           # ③ 多 Devin 账号绑定同一 GitHub 仓库
│   ├── dao-proxy-pro/            # ④ 底层提示词隔离替换 + 第三方模型路由
│   └── rt-flow/                  # ⑤ Devin Cloud 接入：对话备份/全量快照/一键回归本源
│
├── modules/                      # ★ 2 核心模块（离线可复刻 · 不依赖 IDE）
│   ├── vm-replica/               # 多 RDP 虚拟机化全链路（需求→架构→MCP 工具集）
│   └── dao-export/               # Devin AI 全量对话/数据导出（零依赖 Python + VSIX）
│
├── bootstrap/                    # ★ 1 人启动（冷启动板块：装 IDE→秒登账号→装插件→开发）
│   └── README.md                 #   人启动总纲 + 经验教训 + 三类 token 辨析
│
├── agent.ps1 / dao-call.ps1      # 传输层（GitHub Issues = 无感邮箱）
├── dao-exec.sh                   # Linux/Mac 控制端
├── tools/                        # 冷启动/同步脚本（coldstart.ps1 · sync · pack-vsix）
├── plugins/cf-daohub/            # Cloudflare 云代理 + Python Agent 守护
└── docs/                         # 正典文档（CANON · AUDIT · 实测验证 · 冷启动 Runbook）
```

---

## ① 五核心插件 — plugins/

### dao-vsix v1.2.1 · Devin 全功能面板 + 路由官网

核心精简两板块：本地 HTTP API（30+ 端点）+ `app.devin.ai` 路由官网零 GUI 自动登录（根挂载代理 + Content-Length + Request 透传）。零输入获取 cog_ API Key（POST /service-users + auth1 自动换取），彻底移除面板所有手动 API Key 输入/引导。v1.2.0：增补测试聊天内置存根通道，与 dao-proxy-pro v9.9.276 配套。官网注入加固：session-token 与 auth1 严格隔离。

**VSIX**: `plugins/dao-vsix/dao-vsix-1.2.1.vsix` · **源码**: `plugins/dao-vsix/src/extension.ts`

### dao-bridge v3.0.0 · 工作区内网穿透

重构为零/最小输入：quick tunnel 默认模式 + 凭证自动加载（`~/.dao/` 目录）+ 命名隧道 token 持久化 + 修正误导 UI（不再暗示必须填 token）。随 IDE 窗口启停，专穿当前工作区。

**VSIX**: `plugins/cf-daohub/dao-bridge-ext/dao-bridge-3.0.0.vsix` · **源码**: `plugins/cf-daohub/dao-bridge-ext/extension.js`

### devin-git-auth v2.3.0 · 多账号 GitHub 认证

零输入：自动加载 `~/.dao/accounts.json` 账号池 + `~/.dao/git-pats.json` PAT。"already registered" 智能处理 + 仓库可达性核验。全 13 账号实测：9/13 可访问 `devin-remote`（10 个已连通），余 3 个卡在后端"已注册但 0 连接"幽灵态 —— 如实诊断、不做假兜底。

**VSIX**: `plugins/devin-git-auth/devin-git-auth-2.3.0.vsix` · **源码**: `plugins/devin-git-auth/extension.js`

### dao-proxy-pro v9.9.277 · 提示词隔离 + 外接路由

底层拦截 IDE AI 请求，隔离替换提示词（道藏规则 + 用户自定义注入），外接第三方模型路由。vendor 目录含 LSP 模拟器、适应性路由、预算控制、三模块面板（49 家模型归一 + 测通）。v9.9.277：修复「渠道配置永远红点」——无 healthCheck 的用户渠道探活返回 `alive:null` 被渲染成红点；探活改为「带 Bearer 鉴权的 /models 探测」（HTTP 200 即绿、自动回填模型），并修复 baseUrl 已含 `/v1` 时模型探测拼成 `/v1/v1/models` 404；前端加 key 即自动探活+拿模型+变绿。

**VSIX**: `plugins/dao-proxy-pro/dao-proxy-pro-9.9.277.vsix`

### rt-flow v4.1.2 · Devin Cloud 接入（备份 + 回归本源）⭐新

第五板块，零依赖 `devin_cloud.js` 底层封装 Devin Cloud 全部 API（邮箱+密码→auth1 登录、概览、对话追踪、CRUD、备份、wipe）。两大核心模块：

- **对话备份（批量 + 自动）**：增量 ZIP 备份对话 + `snapshotAccountData` 全量数据快照（知识库/剧本正文 + 密钥/Git/会话/额度元数据全量留底）。快照逐条 `_settle` 重试，一条端点失败不毁整份（`partial`/`errors` 如实标注），批量 12 账号并发实测 12/12。
- **一键回归本源（wipe）**：先 `backupAccountFull` 本地留底，再清空账号全部用户数据（对话归档 + 知识/剧本/密钥真删 + Git 授权撤销），**保留 Devin 本源默认**（3 内置知识 + 32 社区剧本）。区分「用户数据」与「本源默认」，不误删、不臆造成功。

> 实测修复多个「臆造成功」缺陷：剧本/密钥删除端点纠正（`/api/playbooks|secrets/{id}`）、会话改归档（平台不支持硬删）、Git 改用 `git-permissions` 真撤授权（连接元数据平台无删除端点，如实回报）。

**VSIX**: `plugins/rt-flow/rt-flow-4.1.2.vsix` · **底层**: `plugins/rt-flow/devin_cloud.js` · **变更史**: `plugins/rt-flow/changelog.md`

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

**VSIX**: `modules/dao-export/dao-devin-export-1.3.3.vsix`

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

## ④ 传输层（GitHub Issues = 无感邮箱）

```
dao-call ──POST──> GitHub Issue Comment (dao-cmd:base64)
                        │
agent.ps1 ──GET──poll───┘  ← If-Modified-Since: 304=free（不计配额）
                        │
agent.ps1 ──POST──> GitHub Issue Comment (dao-result:base64)
```

**一行启动 Agent**（被控端）：
```powershell
$env:DAO_TOKEN='ghp_xxx'; irm https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/agent.ps1 | iex
```

**控制端**：
```powershell
# PowerShell
$env:DAO_TOKEN='ghp_xxx'; . .\dao-call.ps1
dao 141 hostname      # 执行命令
dao-shot 141          # 截屏
dao-sys 141           # 系统信息

# Bash
DAO_TOKEN=ghp_xxx ./dao-exec.sh -a 141 hostname
```

**Mailbox**：每个 Agent 对应一个 GitHub Issue（`mailbox-<COMPUTERNAME>`），标签 `dao-mailbox`。1 次 API 调用发现所有邮箱。

> 人启动板块：[bootstrap/README.md](bootstrap/README.md) · 历史长版 Runbook：[docs/RUNBOOK_coldstart.md](docs/RUNBOOK_coldstart.md)

---

## ⑤ 实测状态

| 插件 | 状态 | 说明 |
|------|------|------|
| dao-bridge | ✅ 全通 | 隧道重启自愈 · `/api/exec` 鉴权 200/401 正确 |
| dao-vsix | ✅ 全通 | 登录态跨重启保持 · Secret/Knowledge/Playbook 全注入 |
| devin-git-auth | ◑ 机制通 | 账号/PAT/设备流均通，组织 Git 连接待后端 oauth |
| dao-proxy-pro | ✅ 已部署 | 提示词隔离 + 模型路由生效 |
| rt-flow | ✅ 实测验证 | 12/12 批量备份 + 一键 wipe 全链路真号验证（备份留底→用户数据清零→本源默认保留） |

> 实测详情：[docs/LIVE_VERIFICATION_2026-06-11.md](docs/LIVE_VERIFICATION_2026-06-11.md) · 五插件规范：[docs/CANON_five-plugins.md](docs/CANON_five-plugins.md)

---

## ⑥ 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DAO_TOKEN` | GitHub PAT (classic, repo scope) | 交互输入 |
| `DAO_REPO` | owner/repo | `zhouyoukang1234-spec/devin-remote` |
| `DAO_POLL` | agent 轮询间隔(秒) | `10` |
| `DAO_PROXY` | HTTP 代理 | 无 |
| `DAO_TIMEOUT` | 等结果超时(秒) | `120` |

**304 不计配额**：agent 轮询带 `If-Modified-Since`，无新命令时返回 304（免费）。60/hr 限制下可持续运行。
