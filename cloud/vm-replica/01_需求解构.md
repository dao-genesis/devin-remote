# 01 · 需求解构

## 原始需求（用户原话要点）

1. 整合复刻 Devin 自身操作虚拟机的功能：全链路一次性操作虚拟机所有内容的工具与架构，大体参考复刻。
2. 用 Windows 多 RDP 实现：141 台式机通过远程桌面远程**自身其他 Windows 账号**，
   两个（多个）账号并行使用；其他账号作为"虚拟机"，相对隔离 + 完整 GUI + 隔离开发环境。
3. 先搭基础设施（Windows 多 RDP 环境），再抽离功能操作层：
   像 Devin 操作自己虚拟机一样全链路 —— 新增 Windows 账号 / 连接其他账号 RDP /
   全链路操作其他账号的所有 GUI / 一切底层，实现类似虚拟机的效果。
4. 本阶段任务 = 解构需求 + 整合资料 + 探讨架构，为下一个实践 agent 铺路（不实现）。

## 分层解构

```
L4  Agent 智能层      LLM agent 调用工具完成任务（= Devin 的大脑）
L3  操作抽象层 ★      统一工具集: vm.create / vm.connect / vm.screenshot /
                      vm.click / vm.type / vm.exec / vm.file_read/write / vm.browser
L2  RDP 会话层        建立并维持到其他账号的 RDP 会话，提供帧缓冲+输入注入
L1  多会话基础设施     Windows 同时多个交互式会话（多账号并行登录）
L0  账号/隔离层        Windows 本地账号 = "虚拟机"实例（独立 profile/桌面/进程空间）
```

## 子需求清单

### A. 基础设施（L0-L1）
- [ ] 141 系统版本确认（Win10/11 Pro 还是 Server）→ 决定多会话方案（见 02 文档）
- [ ] 允许多个并发交互式会话（原生 RDS / RDPWrap / termsrv 补丁三选一）
- [ ] 程序化账号生命周期：`New-LocalUser` 创建 / 加 Remote Desktop Users 组 / 删除重置
- [ ] 同账号本地+远程同时登录（RDPWrap 支持）或一账号一"VM"
- [ ] 回环 RDP（自己连自己 127.0.0.2:3389）可行性验证

### B. RDP 会话层（L2）
- [ ] 程序化发起 RDP：FreeRDP (wfreerdp/pyfreerdp) 优先；mstsc+cmdkey 备选
- [ ] 获取画面：FreeRDP shadow/截图接口，或会话内 agent 自截图回传
- [ ] 注入输入：FreeRDP 输入通道，或会话内 agent (pyautogui/SendInput)
- [ ] 会话保活、断线重连、分辨率控制

### C. 操作抽象层（L3）★ 核心价值
- [ ] 定义统一工具协议（参考 Devin 自身工具面：exec/computer/browser/file，见 03 文档）
- [ ] 两种实现路径权衡（见 05）：
  - 路径甲: 外部驱动 — 宿主进程经 RDP 通道控制（无需在"VM"内装东西）
  - 路径乙: 内部 agent — 每个账号会话内跑一个 agent 进程（exec/截图/输入全在内部，经 HTTP/WS 回报）
  - 推荐: **乙为主、甲为辅**（141 已有 agent_dao.py 模式可直接复用）
- [ ] 浏览器控制：会话内 Chrome + CDP（与 Devin 自身方案一致）

### D. 验收标准（下一个 agent 的完成定义）
1. 一条命令新建"VM"（新账号+自动登录会话+内部agent就绪）
2. 并行 ≥2 个账号会话互不干扰
3. 全链路演示：在"VM"内 截图→打开记事本→打字→保存文件→读回内容→执行shell→浏览器打开网页
4. 全部能力以 MCP 工具形式暴露，任意 agent 可接入

## 边界与风险

- RDPWrap/termsrv 补丁触碰微软许可条款 → 个人研究用途，文档中注明
- Windows Defender 可能拦 rdpwrap.dll → 需加排除
- 回环 RDP 在部分版本被限制 → 备选：第二台设备/虚拟网卡/Hyper-V 增强会话
- 非 Server 系统并发会话数实际受硬件限制（RDPWrap 标称至多15）
