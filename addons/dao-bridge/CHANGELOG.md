# 更新日志 · dao-bridge

本项目遵循语义化版本。日期格式 YYYY-MM-DD。

## [3.6.0] - 2026-06-18

移植 agent-remote-repair 的完整三明治中枢分发模型（operator→hub→agent）—— dao-bridge 现在不仅能被远程操控，还能作为**中枢**协调任意多台被控端，远程在它们身上跑 `.bat`/`.exe`/任意命令。

### 新增（中枢分发能力，extension.js + core.js 同源）
- **被控端一行接入**：`GET /api/bootstrap.ps1`（免鉴权，动态注入当前公网 URL）。在任意 Windows 机器 PowerShell 跑 `irm <公网URL>/api/bootstrap.ps1 | iex` 即接入本中枢为被控端。
- **接入协议**：`POST /api/connect`（登记 + 发放 per-agent token）、`POST /api/poll`（长轮询命令队列，≤25s）、`POST /api/result`（被控端回传结果）、`POST /api/heartbeat`（保活）。
- **按 `agent_id` 路由的 exec**：`/api/exec`·`/api/exec-sync` 现支持 `agent_id`——空/`self`/`local`/本机名 → 中枢本机执行（本源行为，零回归）；填某台被控端主机名 → 入队转发该被控端，`exec-sync` 等待其结果（含原生退出码透传）。
- **异步取结果**：`/api/exec` 返回 `cmd_id`，凭 `POST /api/result-fetch {agent_id,cmd_id}` 拉取。
- **真广播**：`POST /api/broadcast` 把命令入队到所有在线被控端（此前仅占位）。
- **`/api/agents`** 升级为完整设备清单（status/os/user/capabilities/last_seen/pending）。

### 插件层（dao-bridge-ext）
- 新增命令 `daoBridge.copyBootstrap` 与面板「被控端一行接入」区块（点击/按钮复制一行接入指令）。
- webview 加 `Content-Security-Policy`（限制外部来源）+ `data-op` 事件委托（纵深防御）。

### 兼容性
- 保留 `daoBridge.*` 命名空间（不改名）与 `/api/agent/register`·`/api/agent/heartbeat`（向后兼容既有部署）。
- 默认 `shell` 且无 `file` 仍走 `cp.exec`，零回归。

测试：`node test/relay.test.js` 8/8 + `node test/exec.test.js` 6/6 + 新增 `node test/hub.test.js` 8/8（connect→poll→exec-sync→result 三明治分发、per-agent token 校验、broadcast、bootstrap，覆盖 extension 与 core 两条路径）。

## [3.5.0] - 2026-06-18

从根本底层完善执行模块 —— 让 `/api/exec`·`/api/exec-sync` 能远程跑 `.bat`/`.cmd`/`.exe` 及任意程序，覆盖整台电脑。

### 根因
此前 exec 只接受一个裸命令字符串：`extension.js` 走 `cp.exec`（cmd.exe）、headless `core.js` 走 `powershell -Command`。两者对一个 `.bat`/`.exe` 文件路径（**尤其含空格**）都会出问题——cmd.exe 不带引号会被拆词、PowerShell 会把它当「字符串字面量」而非「可执行」→ 远程根本跑不起 `.bat`/`.exe`。且无运行文件、批处理、后台进程的语义，中文输出在 cmd.exe OEM 码页下乱码。

### 完善（统一 exec 规范化，extension.js + core.js 一致）
- **新增 `buildExecCommand()`**：把高层 exec 请求规范化为一条健壮 PowerShell 表达式；用调用运算符 `&` + 单引号量化彻底规避路径/空格问题。
- **新 `type` 字段**（向后兼容，默认仍 `shell`）：
  - `run`/`file` — 运行文件（`.bat`/`.cmd`/`.exe`/`.ps1`…）+ `args` 数组，透传原生退出码。
  - `cmd`/`bat` — 经 `cmd.exe /d /c` + `chcp 65001`（中文 UTF-8 回传）。
  - `detached`/`spawn` — `Start-Process -PassThru` 后台/分离启动 GUI/长驻进程（不阻塞），立即回 PID；可选 `elevate`/`show`。
  - 裸 `file` 字段（无 `cmd`）自动视为 `run`；任意类型可带 `cwd`。
- **`core.js` runShell 加固**：强制 `[Console]::OutputEncoding=UTF8` + 透传原生退出码（此前 `powershell -Command` 只返 0/1，吞掉 `.bat` 的原生退出码）。
- **`extension.js` 向后兼容**：默认 `shell` 且无 `file` 时仍走 `cp.exec`(cmd.exe)，零回归；其余类型走 PowerShell `&` 路径（UTF-8 + 原生退出码 + 含空格路径安全）。
- **能力上报**：`/api/agent/register` 默认 `capabilities` 增加 `cmd,run,detached`；API 文档同步。

### 权限说明
被控端/中枢以**启动它的用户身份**运行；`/api/ls`·`/api/read`·`/api/write` 本就覆盖整机（仅 `daoBridge.confineToWorkspace=true` 时沙箱在工作区）。本版补齐的是命令**派发语义**。

测试：`node test/relay.test.js` 8/8（无回归）+ 新增 `node test/exec.test.js` 6/6（含中枢本机**真实 `.bat` 实跑 + 原生退出码 7**，经 `core.handleRoute` 与 `WorkspaceServer.handleApi` 两条路径）。
