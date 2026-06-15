# vm-replica · 多 RDP 虚拟机化

> 「太上，下知有之。」让云端 Agent 像操作自己的 Devin VM 一样，平滑地把宿主机上**另一个
> Windows 账号的 RDP 会话当成一台虚拟机**来全权操作 —— 截图 / 鼠标 / 键盘 / shell / 文件，
> 与宿主主控（console）会话完全隔离、互不干扰。

本目录从「只铺路、不实现」升级为 **已落地 + 已端到端实测**。下面先讲怎么用，再讲架构、
安全红线（开机锁死根因与永久修复），最后是实测证据。

---

## 一、三层架构（已实现）

```
 MCP 客户端 (Devin / Claude / Cursor)        ← 任何 MCP-compatible agent
        │  stdio JSON-RPC 2.0
        ▼
 mcp_server.py        把 33 个 vm_* 工具暴露为 MCP（纯 stdlib，可冻结成 exe）
        │  HTTP + Bearer (127.0.0.1:9000)
        ▼
 vm_host_daemon.py    宿主守护：vm.create / attach / destroy / list + 代理一切操作
        │  HTTP + Bearer (127.0.0.1:900N，每个 VM 一个端口)
        ▼
 vm_inner_agent.py    跑在每个账号 RDP 会话内部：exec / screenshot(PNG) / 输入 / 文件
                      纯 stdlib + ctypes Win32，零外部依赖
```

| 文件 | 角色 |
|---|---|
| `vm_inner_agent.py` | **会话内代理**。运行在目标账号的交互式 RDP 会话里，HTTP API 暴露 `exec / launch / file_* / screenshot / click / type / key / drag / scroll / ui_info / activate`。仅绑 `127.0.0.1` + Bearer。纯标准库，无需 pip 安装。 |
| `vm_host_daemon.py` | **宿主守护**。在 console 会话内以管理员运行（mstsc 需要交互桌面渲染）。负责建账号、环回 RDP 拉起会话、把会话移到屏外但保持 active、注册会话内代理任务，并把所有 `vm.*` 操作代理给对应内层代理。 |
| `mcp_server.py` | **MCP Server**。stdio JSON-RPC，把守护能力做成与 Devin 自身 computer 工具对齐的工具集。 |
| `vmctl.py` | 命令行客户端（调试用）：`python vmctl.py vm.list` 等。 |
| `deploy_host.py` | **一次性宿主准备**：部署内层代理、设置 `AllowSavedCredentials` 委派、开启 RDP。 |
| `build_exe.py` | **冻结成独立 EXE**（PyInstaller）：把 inner/host/mcp 三层打包成无 Python 依赖的单文件 exe，用于注入任意用户 Windows（见二·B）。 |
| `config.sample.json` | 守护配置样例（落地为 `C:\ProgramData\dao_vm\config.json`）。 |
| `recover-bootsafe.bat` | **带外恢复脚本**。开机进不去桌面 / RDP 崩溃 / 自动重启时，管理员双击即恢复 boot-safe 本源态。 |
| `archive_practice/`（旧） | 早期/备用实现归档（`vm_agent.py` / `connector.py` / `daovm-up.ps1`）：单账号 at-logon 自启 + mstsc 对话框自动点等方案，已被 host daemon 取代，仅留作参考。详见该目录 README。 |
| `../vendor/playwright-mcp` | **直接复制**的真实 Playwright MCP（@playwright/mcp）。经 `--cdp-endpoint` 连到 inner agent `browser_launch` 暴露的 VM 浏览器 CDP 端点，让 agent 用 Playwright 全套真实工具操作 VM 浏览器（非复刻）。 |
| `../vendor/mcp-servers` | **直接复制**的 modelcontextprotocol/servers（filesystem/git/fetch/memory/...），对位 Devin 文件/Git/抓取工具面的官方实现。 |

---

## 二、用法

```powershell
# 0) 一次性宿主准备（管理员，在 console 交互会话里）
python deploy_host.py

# 1) 起宿主守护（前台运行可看日志；token 自动生成并写入 config.json）
python vm_host_daemon.py

# 2) 创建一台「VM」（建账号 + 环回 RDP + 会话内代理）
python vmctl.py vm.create name=vm01 password='Strong#Pass1'

# 3) 像操作 Devin 自己的 VM 一样操作它
python vmctl.py vm.exec        vm=vm01 command="whoami"
python vmctl.py vm.launch      vm=vm01 command="notepad"      # GUI 应用用 launch（非阻塞）
python vmctl.py vm.screenshot  vm=vm01                        # 返回 PNG base64
python vmctl.py vm.type        vm=vm01 text="道法自然"         # 支持中文/Unicode
python vmctl.py vm.list

# 浏览器（P0）：在 VM 会话内起 Chrome/Edge 并暴露 CDP，然后操作它
python vmctl.py vm.browser_launch   vm=vm01 url="https://example.com"
python vmctl.py vm.browser_navigate vm=vm01 url="https://bing.com"
python vmctl.py vm.browser_eval     vm=vm01 expression="document.title"
python vmctl.py vm.ui_tree          vm=vm01                       # 元素树 grounding（P2）
python vmctl.py vm.snapshot         vm=vm01 tag=base               # profile 快照（P1）
python vmctl.py vm.restore          vm=vm01 tag=base               # 回滚到快照

# MCP 接入：把 mcp_server.py 作为 stdio MCP server 挂到任意 MCP 客户端
python mcp_server.py
```

### 浏览器：直接「拿来」真实 Playwright MCP（非复刻）

`vm.browser_*` 是**纯零依赖**的 CDP 实现，用于无 Node 的纯 EXE 注入场景作兜底。
当目标机有 Node 时，**首选直接复制进 `vendor/playwright-mcp` 的真实 Playwright MCP**：
inner agent 的 `vm.browser_launch` 在 VM 会话内以 `--remote-debugging-port=<DEBUG_PORT>`
（`DEBUG_PORT = base_port + 200`，loopback 全机可达）起浏览器并返回该端点，真实 Playwright MCP
直接连上即得 23 个原生工具（navigate/click/snapshot/fill/...）：

```powershell
python vmctl.py vm.browser_launch vm=vm01    # 返回 {port: <DEBUG_PORT>}
cd ../vendor/playwright-mcp && npm install
node cli.js --cdp-endpoint http://127.0.0.1:<DEBUG_PORT>
#  或免安装： npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<DEBUG_PORT>
```

详见 `../vendor/VENDOR.md`。

> **GUI 应用务必用 `vm.launch`（或 `vm.exec ... detach=true`）**，不要用 `vm.exec`。
> `vm.exec` 会捕获 stdio 并等待进程结束 —— 启动 notepad / chrome 这类长存 GUI 进程会一直
> 阻塞到超时。`vm.launch` 以 `DETACHED_PROCESS` 即发即走，立即返回 pid（实测 0.03s）。

---

## 二·B、基础 EXE 构建 + 任意 Windows 一键注入（无需 Python）

三层均为**纯标准库 + ctypes**，可用 PyInstaller 冻结成单文件 exe，这样即使目标机
**没有装 Python** 也能高效注入：

```powershell
# 构建（一次，在任意装有 Python+PyInstaller 的机器上）
pip install pyinstaller
python build_exe.py            # 产出 dist\dao_inner_agent.exe / dao_host_daemon.exe / dao_mcp_server.exe
```

| 产物 EXE | 来源 | 作用 |
|---|---|---|
| `dao_inner_agent.exe` | `vm_inner_agent.py` | 会话内代理（截图/输入/exec/文件） |
| `dao_host_daemon.exe` | `vm_host_daemon.py` | console 内 VM 生命周期管理 |
| `dao_mcp_server.exe` | `mcp_server.py` | agent 的 stdio MCP 工具层 |

**任意用户 Windows 注入流程（全程无 Python）：**

1. 拷贝 `dao_host_daemon.exe` + `dao_inner_agent.exe` 到目标机 `C:\dao_vm\`（config 的 `inner_exe`
   默认指向此路径；守护会**优先用 exe**、未装 Python 也能拉起会话内代理）。
2. 在 console 会话里跑 `dao_host_daemon.exe`（首次会生成 `config.json` 并写入随机 token）。
3. 把 `dao_mcp_server.exe` 作为 stdio MCP server 挂到 agent 的 MCP 客户端 —— 之后就能用
   `vm_create / vm_exec / vm_screenshot / vm_type / vm_browser_* / vm_ui_tree / vm_snapshot …` 等 33 个工具操作该机的 RDP「VM」。

> Windows 10/11 需多开时，再叠加「会话内按需加载 rdpwrap」（绝不挂 ServiceDll，见第三节）。

### 并发 VM 数受 Windows RDP 许可约束（不是本模块的限制）

架构本身支持任意多台 VM（每台一个端口、一个内层代理）。**同时在线的 VM 数量受宿主 OS 的
RDP 许可限制**，与本代码无关：

| 宿主 | 并发远程会话上限 | 突破方式 |
|---|---|---|
| Windows Server **未装 RDS 角色** | 管理模式 **2 个**远程会话（+1 控制台） | 安装 RD Session Host 角色 + RDS CAL |
| Windows 10/11 | 原生 **1 个** | 会话内**按需**加载 rdpwrap 多会话补丁（绝不挂 ServiceDll，见下） |

> 实测铁证：在本仓库的 Server 2022（未装 RDS）上创建第 2 台 VM 时，`vm02` 已**认证成功**
> （RemoteConnectionManager event 1149），但会话仲裁后在登录前被断开（LocalSessionManager
> event 41→40，无 event 21 logon succeeded）—— 正是管理模式 2 会话上限。单台 VM 全部 24
> 工具实测 25/25 通过。`ensure_rdp_active` 已支持「保活全部匹配的 mstsc 窗口」，在许可放开
> （RDS / rdpwrap）的宿主上即可多台 VM 并发。

---

## 三、安全红线 · 开机锁死根因与永久修复 ★必读

历史上这台 141 台式机反复出现「突然重启 + 进不去桌面，要再重启一次才能登录」。**根因已用
事件日志铁证定位**：

> `TermService` 的 `ServiceDll` 被指向了 `rdpwrap.dll`。该 DLL 在此 build（26100.x）上
> 崩溃循环 —— 系统日志连续 `event 7031`（Remote Desktop Services terminated …
> done this 1,2,3,4,5 times），SCM 升级到「重启计算机」恢复动作，最终 `event 1074`
> winlogon 以 SYSTEM 重启整机（伴随 6008/41 非正常关机）。开机时会话管理器加载
> rdpwrap 作为 ServiceDll 失败 → 登录链初始化失败 → RPC server unavailable / 进不了桌面。

**永久修复（`recover-bootsafe.bat` 已固化，并作为默认本源态）：**

1. `ServiceDll` 永远 = 原生 `%SystemRoot%\System32\termsrv.dll`（开机 100% 可靠）。
2. `fSingleSessionPerUser=1`（原生单会话默认）。
3. SCM 失败恢复 = **只重启服务、永不重启计算机**（`sc failure TermService … restart/…`）。
4. 禁用一切 DAO 注入的 **at-logon 自启任务**（DaoVMAgent / DaoVMConnector / …）。

**因此本模块的硬规则：**

- ❌ **绝不**把 rdpwrap.dll 长期挂为 `ServiceDll`。
- ❌ **绝不**安装「开机/登录即自动跑 mstsc / 改 RDP」的 at-logon 自启任务。
- ✅ 多会话能力**按需**获得：
  - **Windows Server**（如本仓库的实测 VM）：原生支持远程会话、无需 rdpwrap（管理模式并发上限 2，见上「并发」节）。
  - **Windows 10/11**：需要时在会话内**临时加载** rdpwrap 补丁、用完即撤，绝不持久化为 ServiceDll。
- ✅ `vm_host_daemon` 默认只在 console 会话内手动起，不随机器自启；console 主会话始终保持纯净。

---

## 四、实测证据（在 Devin 自己的 Windows Server 2022 VM 上端到端验证）

按用户方针「先恢复 141 到本源，再全程在 Devin 自己的 VM 上实践一切」，本实现完全在 Devin VM
上验证，**不依赖也不打扰 141**：

| 验证项 | 结果 |
|---|---|
| `vm.create vm01` 环回 RDP（127.0.0.2，原生多会话，**无 rdpwrap**） | ✅ vm01 成为独立 Active 会话（session 2），console（session 1）不受干扰 |
| `vm.exec whoami` | ✅ 返回 `devinbox\vmtest`（证明在隔离会话内执行） |
| `vm.screenshot` | ✅ 返回该会话**自身桌面**的真实 PNG（非黑屏，1280×800） |
| `vm.launch notepad / calc` | ✅ 0.03s 非阻塞返回，应用在 VM 会话内打开 |
| `vm.activate` + `vm.type "道法自然…"` | ✅ Unicode/中文正确输入到 VM 内 Notepad |
| `mcp_server.py` stdio | ✅ initialize / tools/list(24) / vm_exec / vm_screenshot(image) 全通过 |
| **全工具面硬验证（24 工具）** | ✅ **25/25 PASS** — exec/launch/detach、file_write/read/append（CJK 字节级一致）、screenshot(PNG)、ui_info、activate、type(CJK)/key/hold_key、click/double/right/mouse_move/drag/scroll、desktop_info、vm.list/sessions/host.activate_rdp |
| **MCP 工具层（真 stdio JSON-RPC）** | ✅ **19/19 PASS** — 以真实 MCP 协议起 `mcp_server.py`：initialize / notifications/initialized / tools/list(24) / 逐个 `tools/call` 实操 VM（含 screenshot 返回 image content） |
| **全 EXE 链（无 Python 运行时）** | ✅ `dao_host_daemon.exe`(session1) → 环回 RDP → `dao_inner_agent.exe`(VM 会话) → 由 `dao_mcp_server.exe` 驱动：whoami=`devinbox\\vmexe`、launch notepad、type CJK、screenshot 均通 |
| **P0 浏览器 · 真实 Playwright MCP（直接拿来）** | ✅ `vm.browser_launch` 在 VM 起 Edge(Edg/149) 暴露 CDP(9201) → `vendor/playwright-mcp` 真实 Playwright MCP `--cdp-endpoint` 连上：initialize server=`Playwright`、**23 个真实工具**、`browser_navigate`(example.com)+`browser_snapshot`(无障碍树) 全过 |
| **P0 浏览器 · 零依赖兜底（无 Node）** | ✅ `vm.browser_eval` 返回实时页面标题、`vm.browser_navigate`/`vm.browser_targets` 正常（自写 stdlib WebSocket+CDP，可冻结 EXE） |
| **P1 快照/恢复** | ✅ `vm.snapshot`(robocopy /B 镜像)→`vm.restore` 实测：删文件+加文件后 restore 完全回滚，字节级一致；`vm.snapshots` 列出 tag |
| **P2 元素树 grounding** | ✅ `vm.ui_tree` 返回控件树（class/text/rect/ctrlId/visible），含 WM_GETTEXT 取按钮/编辑框文本 |
| **MCP 层（33 工具）** | ✅ tools/list=33，9 个新工具（vm_browser_* / vm_ui_tree / vm_snapshot* ）全部注册且 `tools/call` 端到端可调 |

> 实测中发现并修复的缺陷：
> 1. `vm.exec` 启动 GUI 应用会阻塞到超时 → 新增 `vm.launch` / `detach=true` 非阻塞模式
>    （`DETACHED_PROCESS`，不继承 stdio 管道）。
> 2. `ensure_rdp_active` 原先只保活**第一个** mstsc 窗口 → 改为保活**全部**匹配窗口，
>    使许可放开的宿主上多台 VM 会话都能持续可操作。

---

## 五、铺路文档（背景资料，按序阅读）

| 文档 | 内容 |
|---|---|
| `01_需求解构.md` | 需求分层、边界、验收标准 |
| `02_Windows多RDP基础.md` | 原生 / RDPWrap / termsrv 补丁 / 账号管理 / 连接 |
| `03_Devin虚拟机全链路逆向参考.md` | Devin 自身 VM 操作架构逆向（复刻蓝本） |
| `04_GitHub项目调研.md` | OpenHands / UFO / OmniParser / FreeRDP 等 |
| `05_架构探讨.md` | MCP vs 脚本 vs exe vs VSIX 分析 + 推荐架构 |
| `06_下一个Agent行动指南.md` | 分阶段落地路线图 + 验证清单 |
