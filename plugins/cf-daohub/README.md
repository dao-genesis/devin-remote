# ☯ CF-DaoHub — 道法自然

**三进程。六文件。双机贯通。**

179 笔记本中枢 + 141 台式机 Agent。云端通过 Cloudflare 公网直连两台设备。

---

## 本机架构

```
                        Internet                          LAN 192.168.31.x
  ┌──────────┐     ┌──────────────┐     ┌────────────────────────┐
  │ Cloud    │────▶│ cloudflared  │────▶│ ps_agent_server.py     │
  │ Agent    │     │ Quick Tunnel │     │ :9910                  │
  │ (anywhere)│    │ (HTTPS/HTTP2)│     │                        │
  └──────────┘     └──────────────┘     │ ┌────────────────────┐ │
                                        │ │ agent_dao.py       │ │
                                        │ │ -> localhost:9910  │ │← 179 ZHOUMAC
                                        │ └────────────────────┘ │
                                        │                        │
                                        │ ┌────────────────────┐ │
                                        │ │ agent_dao.py       │ │
                                        │ │ -> 192.168.31.179  │ │← 141 DESKTOP-MASTER
                                        │ └────────────────────┘ │
                                        └────────────────────────┘
```

- **中枢 (179)**: `hub.ps1` → Server + 本机 Agent + cloudflared 隧道
- **被控端 (141)**: `agent_dao.py` → 长轮询中枢，执行命令
- **云端客户端**: 通过 CF URL 调用 API

---

## 当前接入点

```
CF 公网:  https://qualify-wrap-ministries-liable.trycloudflare.com
Token:    dao-ps-agent-2026
中枢 IP:  192.168.31.179:9910 (LAN)
```

---

## 文件清单

| 文件 | 角色 | 在哪运行 |
|------|------|---------|
| `README.md` | 本文档 | 阅读 |
| `hub.ps1` | 一键启动中枢 | 179 |
| `agent_dao.py` | 通用 Agent 守护 | 179 + 141 |
| `deploy.ps1` | 远程部署 Agent 到 141 | 179 |
| `CLOUD_AGENT_GUIDE.md` | 云端接入指南 | 云端 Agent |
| `cf_cloud_agent.py` | CLI 客户端 | 任意位置 |

---

## 操作指南

### 启动中枢 (179)

```powershell
.\hub.ps1
```

自动：Server :9910 → 本机 Agent → cloudflared 公网隧道 → 写入 `~/.dao/cf-hub-conn.json`

### 部署 141

```powershell
.\deploy.ps1
```

默认参数：`-TargetHost 192.168.31.141 -ServerHost 192.168.31.179`

141 Agent 通过 LAN (`http://192.168.31.179:9910`) 直连中枢，1ms 延迟。

### 云端接入

```bash
# 健康检查
python cf_cloud_agent.py --url https://qualify-wrap-ministries-liable.trycloudflare.com --health

# 在 179 上执行
python cf_cloud_agent.py --url ... --exec hostname

# 在 141 上执行
python cf_cloud_agent.py --url ... --exec "dir C:\" --agent-id DESKTOP-MASTER
```

或复制 `CLOUD_AGENT_GUIDE.md` 中的 Python SDK。

---

## 双机

| Agent ID | 别名 | 机器 | 用户 |
|---|---|---|---|
| `ZHOUMAC` | `179` / `laptop` | 笔记本 | zhouyoukang |
| `DESKTOP-MASTER` | `141` / `desktop` | 台式机 | administrator |

Agent ID 大小写不敏感，别名自动解析。

---

## API 速查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 中枢健康 |
| GET | `/api/agents` | Agent 列表 |
| POST | `/api/exec-sync` | 同步执行 `{"agent_id":"...","cmd":"..."}` |
| POST | `/api/exec` | 异步执行 |
| POST | `/api/broadcast` | 广播全部 |

---

## 添加新机器

在新机器上：
```powershell
python agent_dao.py --server http://192.168.31.179:9910 --hostname 新机器名
```

中枢自动识别，云端立即可达。

---

## 141 Agent 持久化

141 上 Agent 通过 `Invoke-WmiMethod Win32_Process` 启动，使用 `pythonw`（无窗口）。重启 141 后需重新部署或配合计划任务。

计划任务持久化：
```powershell
$action = New-ScheduledTaskAction -Execute "pythonw" -Argument "C:\dao\agent_dao.py --server http://192.168.31.179:9910"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "DaoAgent141" -Action $action -Trigger $trigger -Principal (New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount)
```

---

☯ 太上，下知有之。水善利万物而有静。道法自然。
