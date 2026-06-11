# dao · 道法自然 · 太上 下知有之

> GitHub Issues Comments = 无感传输层。四核心插件 + 两核心模块 + 冷启动传输层。

---

## 架构全貌

```
devin-remote/
│
├── plugins/                      # ★ 四核心插件（VSIX · Devin Desktop 内运行）
│   ├── dao-vsix/                 # ① Devin 全功能面板 + 本地 HTTP 服务（30+ API 端点）
│   ├── cf-daohub/dao-bridge-ext/ # ② 工作区专属内网穿透（Cloudflare QUIC/HTTP2 隧道）
│   ├── devin-git-auth/           # ③ 多 Devin 账号绑定同一 GitHub 仓库
│   └── dao-proxy-pro/            # ④ 底层提示词隔离替换 + 第三方模型路由
│
├── modules/                      # ★ 核心模块（离线可复刻 · 不依赖 IDE）
│   ├── vm-replica/               # 多 RDP 虚拟机化全链路（需求→架构→MCP 工具集）
│   └── dao-export/               # Devin AI 全量对话导出（零依赖 Python + VSIX）
│
├── agent.ps1 / dao-call.ps1      # ★ 冷启动 · 传输层（GitHub Issues = 无感邮箱）
├── dao-exec.sh                   # Linux/Mac 控制端
├── tools/                        # 冷启动脚本（一键部署/同步/rt-flow 辅助插件）
│
├── plugins/cf-daohub/            # Cloudflare 云代理 + Python Agent 守护
│
├── docs/                         # 正典文档（CANON · AUDIT · 实测验证 · 冷启动 Runbook）
└── archive/                      # 历史归档（旧版 cf-bridge 重复件 · 早期文档）
```

---

## ① 四核心插件 — plugins/

### dao-vsix v1.1.0 · Devin 全功能面板 + 路由官网

核心精简两板块：本地 HTTP API（30+ 端点）+ `app.devin.ai` 路由官网零 GUI 自动登录（根挂载代理 + Content-Length + Request 透传，`/org/<slug>` 直渲染认证态）。登录实时同步：修掉 `substring(20)` 一字符偏差 + 账号池解析链，面板随主账号实时跟随。CloudFlare 用户界面整体移出（公网穿透交给 dao-bridge）。

**VSIX**: `plugins/dao-vsix/dao-vsix-1.1.0.vsix` · **源码**: `plugins/dao-vsix/src/extension.ts`

### dao-bridge v3.0.0 · 工作区内网穿透

随 IDE 窗口启停，专穿当前工作区。Quick 隧道（`*.trycloudflare.com`）与 Named 隧道（稳定域名，需 `tunnelToken` 配置）。路径越界守卫，本地 HTTP 六端点。v3.0.0 重新打包 —— 源码早是三模块新版，安装包终于对齐。

**VSIX**: `plugins/cf-daohub/dao-bridge-ext/dao-bridge-3.0.0.vsix` · **源码**: `plugins/cf-daohub/dao-bridge-ext/extension.js`

### devin-git-auth v2.1.0 · 多账号 GitHub 认证

零输入：自动加载 `~/.dao/accounts.json` 账号池 + `~/.dao/git-pats.json` PAT。"already registered" 智能处理 + 仓库可达性核验。全 13 账号实测：9/13 可访问 `devin-remote`（10 个已连通），余 3 个卡在后端"已注册但 0 连接"幽灵态 —— PAT 删除/集成删除/官方 UI 均无法清除，如实诊断、不做假兜底。

**VSIX**: `plugins/devin-git-auth/devin-git-auth-2.1.0.vsix` · **源码**: `plugins/devin-git-auth/extension.js`

### dao-proxy-pro v9.9.274 · 提示词隔离 + 外接路由

底层拦截 IDE AI 请求，隔离替换提示词（道藏规则 + 用户自定义注入），外接第三方模型路由。vendor 目录含 LSP 模拟器、适应性路由、预算控制、三模块面板（49 家模型归一 + 测通）。

**VSIX**: `plugins/dao-proxy-pro/dao-proxy-pro-9.9.274.vsix`

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

## ③ 冷启动 · 传输层

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

> 完整冷启动 Runbook：[docs/RUNBOOK_coldstart.md](docs/RUNBOOK_coldstart.md)

---

## ④ 实测状态 · 2026-06-11

| 插件 | 状态 | 说明 |
|------|------|------|
| dao-bridge | ✅ 全通 | 隧道重启自愈 · `/api/exec` 鉴权 200/401 正确 |
| dao-vsix | ✅ 全通 | 登录态跨重启保持 · Secret/Knowledge/Playbook 全注入 |
| devin-git-auth | ◑ 机制通 | 账号/PAT/设备流均通，组织 Git 连接待后端 oauth |
| dao-proxy-pro | ✅ 已部署 | 提示词隔离 + 模型路由生效 |

> 实测详情：[docs/LIVE_VERIFICATION_2026-06-11.md](docs/LIVE_VERIFICATION_2026-06-11.md) · 四插件规范：[docs/CANON_four-plugins.md](docs/CANON_four-plugins.md)

---

## ⑤ 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DAO_TOKEN` | GitHub PAT (classic, repo scope) | 交互输入 |
| `DAO_REPO` | owner/repo | `zhouyoukang1234-spec/devin-remote` |
| `DAO_POLL` | agent 轮询间隔(秒) | `10` |
| `DAO_PROXY` | HTTP 代理 | 无 |
| `DAO_TIMEOUT` | 等结果超时(秒) | `120` |

**304 不计配额**：agent 轮询带 `If-Modified-Since`，无新命令时返回 304（免费）。60/hr 限制下可持续运行。
