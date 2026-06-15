# 06 · 下一个 Agent 行动指南

> 「上士闻道，堇而行之。」按此清单顺序执行即可，一切资料已就位。

## 0. 上下文就位（10分钟）

1. 读本文件夹 README → 01 → 02 → 05（03/04 作参考随用随查）
2. 连接方式: 见 `E:\DAO_ARCHIVE\10_对话与导出_DAO_EXPORT\DEV_EXPERIENCE.md` CF隧道节
   （若你直接运行在141上则跳过）
3. 浏览 `E:\道\道生一\一生二\Windsurf万法归宗\150-Devin云原生_Kernel\` 的
   `INDEX.md` + `虚拟机代理/` （Devin 架构蓝本）

## 1. 阶段0 · 基础设施验证（先把地基打实）

```powershell
# 1) 探明系统
Get-ComputerInfo | Select WindowsProductName, OsVersion
# Server → 走02文档方案A(组策略)；Pro/Home → 方案B(RDPWrap sebaxakerhtc fork)

# 2) 建测试账号 vm01 (02文档命令)
# 3) 回环 RDP 自测: cmdkey + mstsc /v:127.0.0.2 ；RDPCheck.exe
# 4) 验收: quser 显示 ≥2 个 Active 会话
```
坑预警: Defender 拦 rdpwrap → 排除目录；NLA 失败 → 注册表关 NLA；
回环被拒 → 用 127.0.0.2 而非 127.0.0.1，或临时第二设备验证。

## 2. 阶段1 · vm_inner_agent（核心，~300行）

单文件 Python，HTTP 服务（端口从环境变量），工具:
`exec / file_read / file_write / screenshot(mss) / click / type / key / scroll(pyautogui) / ui_tree(pywinauto)`
- 参照: Windows-Use 源码 + Devin computer 工具 schema（03文档）
- 注册计划任务: `At log on of vm01` 启动 → RDP 会话一建立即上线
- 验收: 宿主 curl vm01 agent 完成 截图→开记事本→打字→存盘→读回

## 3. 阶段2 · vm_host_daemon

- 扩展现有 agent_dao.py 模式: REST 路由 vm.create/destroy/list/connect/snapshot
- create = New-LocalUser + 加组 + cmdkey + 后台 FreeRDP/mstsc 自连 + 等待 inner agent 心跳
- 端口分配表 {vm01:9001, vm02:9002...} 持久化 JSON

## 4. 阶段3 · MCP 包装 + 验收

- modelcontextprotocol/python-sdk，把 REST 包成 MCP 工具
- 端到端验收（01文档 D 节四条全过）
- 录屏/截图留证，写 HANDOFF.md

## 5. 阶段4 · 增强（可选）

- 快照/模板（robocopy profile）、Chrome CDP、OmniParser 视觉、UFO 式 UIA 混合

## 产出归档约定

- 代码放 `E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA\impl\`
- 经验追加到本文件夹 `DEV_NOTES.md`
- 道法自然，无为而无不为。
