# 05 · 架构探讨 · MCP vs 脚本 vs VSIX vs exe（正规化结论）

> 「大制无割。」分两个正交决策：**基底服务用什么承载** × **agent 操作层用什么协议**。

## 决策一 · 基底服务（谁来提供底层能力）

| 选项 | 评估 |
|---|---|
| **exe/常驻服务（守护进程）** ★ 推荐 | 开机自启、无前台依赖、可注册 Windows 服务/计划任务；141 已有 agent_dao.py 常驻模式，直接扩展即可。Python 脚本 + (可选 pyinstaller 打包 exe) |
| VSIX | 依赖 VS Code 进程存活，且 webview 沙箱不适合系统级操作（建账号/连RDP需管理员权限）。VSIX 适合做**前端面板**（复用 10_ 文件夹的插件经验），不适合做基底 |
| 纯脚本（按需执行） | 无状态、无会话保活能力；RDP 会话和内部 agent 需要常驻管理 → 不够 |
| Electron/Tauri app | 重；GUI 非必需（agent 是使用者，不是人） |

**结论**: 基底 = **Python 常驻守护进程**（先脚本形态跑通，后 pyinstaller 打包 exe + NSSM 注册服务）。
理由: 141 现有 CF 隧道 agent (agent_dao.py) 已验证此模式，最小改动、最大复用。

## 决策二 · agent 操作层协议

| 选项 | 评估 |
|---|---|
| **MCP Server** ★ 推荐 | 标准化、即插即用（Claude/Devin/Windsurf/Cursor 全支持）；工具 schema 自描述；一次实现处处可用 |
| HTTP REST API | 通用兜底，MCP 之下再留一层 REST（现有 /api/exec-sync 模式），脚本/curl 也能调 |
| CLI 脚本集 | 适合人肉调试，agent 调用经 shell 转一道，丢失结构化 |
| 自定义 WS 协议 | 重复造轮子 |

**结论**: **双层暴露 = REST(内核) + MCP(外壳)**。守护进程提供 REST；MCP Server 是 REST 的薄包装。

## 推荐总架构

```
┌─ Agent (Devin/Claude/任意) ── MCP/REST ─┐
│                                          ▼
│   141 宿主守护进程 vm_host_daemon (Python, 管理员权限, 常驻)
│   工具: vm.create/destroy/list  ← New-LocalUser + RDPWrap 会话管理
│         vm.connect              ← FreeRDP/mstsc 建立回环 RDP 会话
│         vm.snapshot/restore     ← profile 目录备份/恢复
│                │
│                │  (HTTP/WS, localhost 端口池: 9001,9002,...)
│                ▼
│   每个"VM"(Windows账号会话)内: vm_inner_agent (计划任务登录自启)
│   工具: exec / file_read / file_write / screenshot /
│         click / type / key / scroll (pyautogui+UIA) /
│         ui_tree (pywinauto) / browser (Chrome CDP)
└──────────────────────────────────────────┘
```

### 关键设计点
1. **内部 agent 为主**（每账号会话内常驻），外部 RDP 通道只负责"造出会话"和兜底观察。
   优势: 截图/输入天然作用于本会话桌面，无需解析 RDP 帧缓冲，实现成本低一个数量级。
2. 工具 schema 直接照抄 Devin computer 工具 + exec 工具（见 03 文档），语义对齐，
   未来任何为 Devin 写的流程可平移。
3. GUI 智能: 第一版纯坐标(截图给LLM)，第二版加 pywinauto UIA tree（UFO 模式），
   第三版可选 OmniParser 视觉 grounding。
4. 会话保活: RDP 断开(非注销)后会话仍在运行，内部 agent 不受影响 —— 与
   Devin VM 的"断联重连状态不丢"体验一致。
5. 快照: `robocopy C:\Users\vm01 → 备份` + 注册表 HKCU 导出 ≈ Devin 蓝图/快照的简化复刻。

## 全链路时序（目标体验）

```
agent → vm.create("vm01")        # 建账号+预存凭据+RDP自连一次+内部agent上线   (~10s)
agent → vm.exec("vm01","npm i")  # 在 vm01 会话内执行
agent → vm.screenshot("vm01")    # vm01 桌面截图 → LLM 看图决策
agent → vm.click("vm01",x,y) / vm.type("vm01","hello")
agent → vm.browser("vm01","https://...")  # CDP 操作 vm01 内 Chrome
agent → vm.snapshot("vm01")      # 固化为模板
agent → vm.destroy("vm01")       # 注销+删账号+删profile
```

## 阶段化（为下一个 agent）

- 阶段0: 探明 141 系统版本 → 选多会话方案（02 文档）→ 跑通双账号并发 + 回环 RDP
- 阶段1: vm_inner_agent (exec+file+screenshot+input, ~300行Python) + 计划任务自启
- 阶段2: vm_host_daemon (账号生命周期+端口路由+REST)
- 阶段3: MCP Server 包装 + 端到端验收（01 文档 D 节标准）
- 阶段4: 快照/模板 + 浏览器 CDP + UIA 增强
