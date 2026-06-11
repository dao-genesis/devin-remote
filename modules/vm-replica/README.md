# 20_多RDP虚拟机化_VM_REPLICA · 为下一个 Agent 铺路

> 「执大象，天下往。」本文件夹是 **需求解构 + 资料整合 + 架构探讨** 的完整准备，
> 下一个 agent 看到此文件夹即可直接开始实践。本阶段不做实现，只铺路到底。

## 本源目标

在 141 台式机上复刻 Devin 操作自身虚拟机的全链路能力，但底座换成 **Windows 多 RDP**：

1. 141 通过 Windows 远程桌面远程**自身的其他 Windows 账号**（多账号并行，互不干扰）
2. 其他账号 = 类虚拟机：相对隔离、完整 GUI、独立开发环境
3. 抽离操作层：像 Devin 操作自己虚拟机一样，全链路程序化操作这些"虚拟机"
   （新建账号 → 连接 RDP → 操作 GUI → shell/文件/浏览器 一切）

## 文档索引（按序阅读）

| 文档 | 内容 |
|---|---|
| `01_需求解构.md` | 需求的完整解构：分层、边界、验收标准 |
| `02_Windows多RDP基础.md` | 多 RDP 基础设施全资料：原生/RDPWrap/termsrv 补丁/账号管理/连接 |
| `03_Devin虚拟机全链路逆向参考.md` | Devin 自身 VM 操作架构逆向（参考复刻的蓝本）+ 150-Kernel 成果索引 |
| `04_GitHub项目调研.md` | OpenHands / UFO / OmniParser / Windows-Use / FreeRDP 等全部相关项目 |
| `05_架构探讨.md` | ★ 核心 · MCP vs 脚本 vs exe vs VSIX 全分析 + 推荐架构 + 全链路设计 |
| `06_下一个Agent行动指南.md` | 分阶段落地路线图 + 验证清单 |

## 一句话结论（详见 05）

**底座 = 常驻 exe/服务（Python/Node 守护进程，扩展现有 agent_dao.py），
操作层 = MCP Server 暴露工具集（create_vm / rdp_connect / screenshot / click / type / exec / file），
RDP 自动化 = FreeRDP + Windows API（UIA）+ 截图视觉，
GUI 智能 = 参考 UFO/OmniParser 的混合 UIA+视觉方案。**
