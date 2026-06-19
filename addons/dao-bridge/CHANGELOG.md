# 更新日志 · dao-bridge

本项目遵循语义化版本。日期格式 YYYY-MM-DD。

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
