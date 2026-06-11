# 04 · GitHub 相关项目调研（2026-06）

## A. Agent 整体框架（参考整体架构）

### OpenHands (原 OpenDevin) — github.com/OpenHands/OpenHands ★76k
- AI 驱动开发平台，最接近 Devin 的开源复刻
- 组成: **Software Agent SDK**(Python，可组合，agent引擎) / CLI / Local GUI(REST+React，体验类似Devin) / Cloud
- 工作区: 本机 或 Docker/K8s 临时工作区（Agent Server 远程执行）
- **借鉴点**: Agent Server 的 client-server 架构 + 工具协议（exec/file/browse），
  我们的"RDP VM"即替换其 Docker workspace 为 Windows 账号会话

## B. Windows GUI 操作 agent（操作层核心参考）

### microsoft/UFO (UFO²/UFO³) — github.com/microsoft/ufo ★
- Windows AgentOS：深度 OS 集成 (UIA + Win32 + WinCOM)，混合 GUI+API 动作
- HostAgent + AppAgents 架构；UFO³ Galaxy 多设备 DAG 编排
- **Picture-in-Picture 桌面**: 并行自动化不干扰用户 —— 与我们多RDP隔离思想同源
- 混合控件检测: UIA 元数据 + OmniParser 视觉，51% 减少 LLM 调用（speculative multi-action）
- **借鉴点**: 工具集设计 capture_screenshot/get_ui_tree/click/set_edit_text；UIA优先、视觉兜底

### microsoft/OmniParser — github.com/microsoft/OmniParser ★
- 纯视觉屏幕解析: 截图 → 结构化 UI 元素（图标/按钮/文本框+坐标）
- **OmniTool**: OmniParser + 任意 LLM 控制 Windows 11 VM —— 与本需求几乎完全相同的参考实现
- **借鉴点**: 截图→元素grounding→坐标点击 流水线；OmniTool 的 VM 控制循环

### CursorTouch/Windows-Use — github.com/CursorTouch/Windows-Use
- 轻量 Python: LLM 直接操作 Windows GUI（UIA tree + 截图 + pyautogui 输入）
- **借鉴点**: 最小可行实现，适合做内部 agent 的骨架

### Claude Computer Use (Anthropic) — anthropic 官方 demo
- screenshot/click/type 工具循环 + 虚拟显示器；Devin computer 工具同型
- **借鉴点**: 工具 schema 定义（即本会话 computer 工具的 actions 列表，可直接照抄）

## C. RDP 协议/客户端（会话层）

### FreeRDP — github.com/FreeRDP/FreeRDP ★
- 开源 RDP 全实现；wfreerdp(Windows客户端)/freerdp-shadow(服务端)
- 可编程: C API + pyfreerdp/node 绑定，能拿帧缓冲、注入键鼠 → **外部驱动路径的基石**

### 其他
- stascorp/rdpwrap + sebaxakerhtc/rdpwrap + asmtron/rdpwrap-utils: 多会话补丁（见02文档）
- qwqdanchun/rdp-clip / mstsc 自动化: AutoHotkey/PowerShell 包装可参考
- Devolutions/IronRDP (Rust): 现代 RDP 客户端库，长期可选

## D. 输入/截图底层库（内部 agent 路径）

| 库 | 用途 |
|---|---|
| pyautogui | 截图+键鼠（最简） |
| pywinauto | UIA 自动化（控件级，比坐标稳） |
| mss | 高速截图 |
| pynput / SendInput(ctypes) | 底层输入注入 |
| Playwright/CDP | 会话内浏览器控制（与 Devin 同款） |

## E. MCP 生态（暴露为标准工具）

- modelcontextprotocol/python-sdk: MCP Server 框架
- 已有先例: mcp-server-commands / computer-control-mcp（截图+键鼠 MCP 化）
- **借鉴点**: 把 L3 操作层包成 MCP Server，任何支持 MCP 的 agent (Claude/Devin/Windsurf) 即插即用

## 优先阅读顺序（下一个 agent）

1. OmniParser 的 **OmniTool**（最接近成品的参考）
2. UFO² 的工具集与混合检测设计
3. Windows-Use 源码（最小骨架）
4. FreeRDP 命令行 + rdpwrap 安装（基础设施）
5. OpenHands Agent Server 协议（架构参考）
