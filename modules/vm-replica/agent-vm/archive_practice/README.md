# archive_practice — 早期实践归档（仅供参考，不在主链路）

这些是 vm-replica 演进过程中的早期/备用实现，已被 `agent-vm/` 主链路
（`vm_host_daemon.py` + `vm_inner_agent.py` + `mcp_server.py`）取代。保留以记录心路，
**不参与构建、不被任何当前代码引用**。

| 文件 | 角色 | 被谁取代 |
|---|---|---|
| `vm_agent.py` | dao-bridge 直代理的单账号内层代理变体（含 mss/pyautogui 录屏） | `vm_inner_agent.py`（纯 stdlib+ctypes，零依赖可冻结） |
| `connector.py` | 早期「单账号 at-logon 自启 + mstsc 对话框自动点」连接器 | `vm_host_daemon.py`（环回 RDP + 离屏保活 + 计划任务） |
| `daovm-up.ps1` | 早期一键拉起脚本 | `deploy_host.py` + host daemon |

> 安全红线：早期方案的 at-logon 自启 / rdpwrap 作 ServiceDll 正是开机锁死的根因，已废弃。
> 详见主 README「安全红线」。
