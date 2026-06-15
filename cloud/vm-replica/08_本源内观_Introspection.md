# 08 · 本源内观报告 — 逆流到 Devin 自身工具的最上游机制

> 反者道之动也。本篇向内观照 Devin 在自身 Windows VM 上的真实工具栈（进程、二进制、
> 服务、启动参数），逆流到每个工具最上游的底层机制，并据此把 vm-replica 对齐到
> 「物无非彼，物无非是」——让用户多账号 RDP 体系下的类虚拟机，与 Devin 操作自己 VM
> 全链路一致。所有结论均来自对本机运行态的实地内观（证据见文末）。

---

## 一、Devin 自身 VM 的工具栈（实地内观所得）

机型：Windows Server 2022（本会话的 Devin VM，console = session 1，Administrator）。

| 监听 | 进程 / 二进制 | 角色（Devin 工具的上游本源） |
|---|---|---|
| `:9876` | `D:\devin-remote.exe`（3 实例） | **Devin 主代理**。brain 经它下发一切工具调用：shell/文件/computer/browser。 |
| `:29229` | `C:\devin\chrome\chrome-win64\chrome.exe` | **browser 工具本源**。固定 flag 档 + UA `Devin/1.0; +devin.ai`，CDP(DevTools)。 |
| `:5900` | `C:\Program Files\uvnc bvba\UltraVNC\winvnc.exe`（服务 `uvnc_service`） | **computer 工具本源**。RFB 协议提供桌面像素与鼠标/键盘注入（绑 session 1）。 |
| `:6080` `:5800` | `C:\devin\python\python.exe -m websockify --web C:\devin\noVNC 0.0.0.0:6080 localhost:5900` | **noVNC**：把 RFB 包成 WebSocket，供网页端（Desktop 标签）实时观看/操作。 |
| `:6789` | `C:\ProgramData\devin\binaries\code.exe serve-web` | VS Code 网页版（IDE 标签）。 |
| `:22` | `sshd.exe` | SSH。 |

启动总装来自 `C:\devin\session-init.ps1`（cloudbase-init userdata）：它注册 `DevinRemote`
计划任务跑 devin-remote.exe、注册并启动 UltraVNC 服务、（重）启 websockify 服务、起 VS Code。
Chrome 不在 init 里——由 devin-remote 在 **browser 工具首次被调用时按需拉起**。

### 关键洞见（最上游本质）
- **browser 工具 = CDP**。Devin 不"截图点按"操作网页，而是用 DevTools 协议直控页面。
- **computer 工具 = RFB(VNC)**。桌面观看与输入注入走 UltraVNC 的 RFB；noVNC 只是把 RFB
  搬到浏览器里给人看。**对 agent 而言，computer 工具消费的是"屏幕像素 + 输入事件"两个语义原语**。
- **shell / 文件 / 进程**由 devin-remote 直接在会话内执行（与普通 Win32 进程/文件 IO 同构）。
- 整套是**单例、绑 session 1**：一台 VM 一个 winvnc 服务、一个 noVNC、一个 chrome CDP 端点。

---

## 二、本源 → vm-replica 对齐表（物无非彼，物无非是）

| Devin 工具 | 上游本源机制 | vm-replica 对应实现 | 一致性 |
|---|---|---|---|
| **browser** | `C:\devin\chrome\…\chrome.exe` 固定 flag 档 + UA，CDP `:29229` | inner agent `browser_launch` **优先用同一 Devin chrome 二进制**、**逐字复制同一 flag 档与 UA**，按 VM 分配 `--remote-debugging-port`/`--user-data-dir`；外层挂**真实 Playwright MCP**（`vendor/playwright-mcp`）经 `--cdp-endpoint` 连上 | **完全一致**：同一 chrome、同一 CDP 协议、同一工具面 |
| **computer · 截图** | UltraVNC RFB framebuffer | inner agent `screenshot`：Win32 `BitBlt`+GDI 抓会话桌面→PNG | **语义一致**：agent 消费的都是"桌面像素 PNG" |
| **computer · 输入** | UltraVNC RFB PointerEvent/KeyEvent | inner agent `click/double/right/move/drag/scroll/type/key/hold_key`：Win32 `SendInput`/`PostMessage` | **语义一致**：agent 消费的都是"注入到目标桌面的鼠标/键盘事件"，中文 Unicode 实测一致 |
| **computer · 元素定位** | （Devin 靠像素+少量 a11y） | inner agent `ui_info` + `ui_tree`：ctypes 控件树（class/text/rect/ctrlId/visible，含 WM_GETTEXT） | **超集**：提供元素级 grounding |
| **shell / exec** | devin-remote 会话内执行 | inner agent `exec`（阻塞捕获 stdio）/ `launch`(`DETACHED_PROCESS` 非阻塞) | **完全一致** |
| **文件读写** | devin-remote 文件 IO | inner agent `file_read/write/append`（字节级，CJK 一致） | **完全一致** |
| **agent 传输** | `devin-remote.exe :9876`（brain↔VM） | `vm_host_daemon.py :9000`(HTTP+Bearer) + `mcp_server.py`(stdio JSON-RPC) | **同构**：MCP 客户端经统一工具面驱动 VM |
| **桌面网页观看** | noVNC websockify `:6080`→`:5900` | VM 会话由 host daemon 经环回 RDP 拉起并离屏保活；人可经 `mstsc`/RDP 观看该会话 | 见 §三说明 |

---

## 三、为何 computer 工具走 GDI 而非「再起一套 noVNC」（刻意为之，非缺失）

逆流到最上游后，computer 工具的本质是两个原语：**桌面像素** + **输入事件**。Devin 用 RFB 产生
它们，vm-replica 用 Win32 GDI/SendInput 产生**等价**的它们——在 agent 消费的边界上完全一致。

刻意**不**为每台 VM 复制一套 UltraVNC+noVNC，原因是**本源约束**：
- UltraVNC 是**单例服务**、绑 session 1、独占 `:5900`。它正是 Devin 自身 computer 工具的命脉。
  在同机另起第二个 winvnc（app 模式）会与该服务争用端口/桌面钩子，**有掀翻 Devin 自身 computer
  工具的风险**——这违反「保稳定」的最高红线（参 §安全红线与 141 锁死教训）。
- 因此 vm-replica 选择**不触碰**这套单例，改用零依赖的 GDI 抓屏 + SendInput 注入，既得到与
  RFB 等价的能力，又可冻结进无依赖 EXE 注入任意 Windows（Devin 的 noVNC 依赖 python+noVNC 资产，
  无法随 EXE 走）。
- 若确需「像 Desktop 标签那样网页实时观看某台 VM」，正道是为该 VM 起一套**独立、隔离**的 VNC
  +noVNC（不动 uvnc_service），可作为可选项按需开启——已在路线图，默认关闭以保稳定。

> 一句话：**agent 操作 VM 所需的一切原语已与 Devin 操作自身 VM 完全一致；唯一未复制的是
> 「给人看的网页观看层」的第二实例，且是出于保护 Devin 自身工具稳定的刻意取舍。**

---

## 四、本轮据本源所做的对齐（代码改动）

- `vm_inner_agent.py`：
  - `_BROWSER_CANDIDATES` 置 `C:\devin\chrome\chrome-win64\chrome.exe` 为**首选**。
  - 新增 `_DEVIN_CHROME_FLAGS`：**逐字复制** Devin 运行态 chrome 的完整 flag 档与 UA。
  - `browser_launch` 用该 flag 档启动；若 `C:\ProgramData\devin\package\chrome_extensions\adblock`
    存在则一并 `--load-extension`，与 Devin 自身一致。
- 验证：scratch 实跑 `browser_launch` → 启动的正是 `C:\devin\chrome\…\chrome.exe`，
  CDP `/version` UA 含 `Devin/1.0; +devin.ai`，Chrome/137.0.7118.2，与 Devin 自身浏览器逐字节同构。

---

## 五、内观证据（本机运行态，节选）

```
:9876  D:\devin-remote.exe                         (brain↔VM 主代理)
:29229 C:\devin\chrome\chrome-win64\chrome.exe      --remote-debugging-port=29229
        UA = ...Chrome/137.0.0.0 Safari/537.36; Devin/1.0; +devin.ai
:5900  C:\Program Files\uvnc bvba\UltraVNC\winvnc.exe -service_run   (uvnc_service)
:6080  C:\devin\python\python.exe -m websockify --web C:\devin\noVNC 0.0.0.0:6080 localhost:5900
:6789  C:\ProgramData\devin\binaries\code.exe serve-web ... --port 6789
启动总装：C:\devin\session-init.ps1（注册 DevinRemote 任务 + UltraVNC 服务 + websockify + VSCode）
```
