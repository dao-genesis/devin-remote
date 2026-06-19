# 更新日志 · dao-bridge

本项目遵循语义化版本。日期格式 YYYY-MM-DD。

## [3.8.0] - 2026-06-19

全网状拓扑·任意设备皆可作中枢/被控端·中枢按被控端平台自动选指令（Win→PowerShell，Linux/macOS→/bin/sh）。

### 新增
- **Linux/macOS 被控端一行接入**：`GET /api/bootstrap.sh`（`curl -fsSL <hub>/api/bootstrap.sh | sh`）。bash 仅引导，connect→poll→exec→result 循环交 `python3`，命令经 `/bin/sh` 执行；登记 `platform=sys.platform`；轮询用 POST `/api/poll`。
- **`platformOf(agent)`**：由被控端登记的 `sysinfo` 推断平台——显式 `platform` 优先 → `os_version` 关键字（linux/darwin/mac/bsd）→ **缺省回退 `win32`**（向后兼容）。
- **中枢按被控端平台路由**：`WorkspaceServer` 与 `core.handleRoute` 的 `/api/exec`、`/api/exec-sync`、`/api/broadcast` 取目标 agent 平台，`buildExecCommand(body, platformOf(target))` 下发对应语法。两个中枢（VSIX 插件 + 独立 core）逻辑一致。
- PowerShell `bootstrap.ps1` 登记新增 `platform='win32'` 字段。

### 兼容
- 老版被控端（无 `platform` 字段）默认按 `win32`/PowerShell 处理，行为不变。

### 测试
- `hub.test.js` 新增 Linux 被控端模拟 + 跨平台路由断言（`WorkspaceServer` 与 `core` 双中枢、`bootstrap.sh`、`platformOf`）；hub/exec/relay 全绿。

## [3.7.0] - 2026-06-19

侧栏「公网穿透状态」顶部按钮归一为三个：**复制 / 重启隧道 / 刷新Token**。

### 变更
- **合并 复制URL + 复制Token → 单一「📋 复制」**：一键把 `URL` 与 `Token`（含 `Authorization: Bearer <Token>` 头）一次性写入剪贴板，直接粘贴给云端 Agent 即可接入；新增后端 `copyAll` 处理。
- 顶部行恒为三按钮（复制 / ♻️ 重启隧道 / 🔄 刷新Token），不再分两行。
- 旧的 `copyUrl` / `copyToken` 后端处理保留（命令与向后兼容），仅从 UI 顶部移除。

### 跨平台适配（Linux / macOS 中枢本机）
- `buildExecCommand(body, targetPlatform)` 新增 POSIX 分支：中枢本机(SELF)按 `process.platform` 规范化——Linux/macOS 走 `/bin/sh`，Windows 仍走 PowerShell；被控端经 bootstrap 恒为 Windows(PowerShell) 不变。
- `cmd` 类型在 *nix 无 `cmd.exe` → 降级为普通 shell 命令；`run/file` 用单引号量化(`.sh` 自动 `sh` 调用)；`detached` 用 `nohup … & echo "started pid=$!"`；`cwd` 用 `cd '<dir>' &&`。
- `sysinfo` 按平台采集：Windows `Get-ComputerInfo`；Linux/macOS `uname`/`os-release`/`lscpu`/`free`/`df`。
- exec 测试新增 POSIX 实跑用例（`.sh` 运行+退出码、cmd 降级、detached、sysinfo），Linux 全绿；Windows 原有断言不变。

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
