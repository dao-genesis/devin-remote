# ☯ CF-DaoHub 云端接入指南

**一文档通两机。云端 Agent 读此文件即可直连 179 + 141。**

---

## 接入点

```
CF 公网:  https://qualify-wrap-ministries-liable.trycloudflare.com
Token:    dao-ps-agent-2026
```

CF Quick Tunnel URL 在 cloudflared 重启后会变化。始终优先从 `~/.dao/cf-hub-conn.json` 读取最新 URL。

---

## 前置条件

**每台目标机器必须运行 Agent 守护进程。** 云端 Agent 无法唤醒一台没有 Agent 的机器。

179 中枢自带 Agent（`hub.ps1` 自动启动）。141 需单独部署：

```powershell
# 在 141 上直接运行（需要 Python）
python agent_dao.py --server http://192.168.31.179:9910

# 或从 179 通过 WinRM 远程部署
.\deploy.ps1
```

用 `health()` 或 `GET /api/agents` 确认两台机器均为 `online` 后再执行命令。

---

## 双机

| Agent ID | 别名 | 机器 | 用户 |
|---|---|---|---|
| `ZHOUMAC` | `179` / `laptop` | 笔记本 | zhouyoukang |
| `DESKTOP-MASTER` | `141` / `desktop` | 台式机 | administrator |

所有 API 的 `agent_id` 参数大小写不敏感，别名自动解析。

---

## Python SDK（复制即用）

```python
import urllib.request, json, ssl, time, os

# === 代理免疫 + SSL 跳过（trycloudflare 自签证书） ===
for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    os.environ.pop(k, None)
os.environ['NO_PROXY'] = '*'

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=ctx),
)
urllib.request.install_opener(opener)

# === 中枢配置 ===
URL   = "https://qualify-wrap-ministries-liable.trycloudflare.com"
TOKEN = "dao-ps-agent-2026"

def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{URL}{path}", data=data,
        headers={"Authorization": f"Bearer {TOKEN}",
                 "Content-Type": "application/json"},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

def health():
    """中枢存活"""
    return api("GET", "/api/health")

def dao(cmd, agent="ZHOUMAC", timeout=30, retries=3):
    """
    在指定 Agent 上执行命令，返回 stdout 字符串。

    agent: 'ZHOUMAC' | 'DESKTOP-MASTER' | '179' | '141' | 'laptop' | 'desktop'
    """
    for i in range(retries):
        r = api("POST", "/api/exec-sync", {
            "agent_id": agent, "cmd": cmd, "timeout": timeout
        }, timeout=timeout + 15)
        if r.get("status") == "completed":
            return r["result"]["stdout"]
        if "not found" in str(r.get("error", "")):
            time.sleep(5)
    return f"[dao] unreachable: {agent}"

def dao_raw(cmd, agent="ZHOUMAC", timeout=30):
    """执行命令，返回完整结果 dict {stdout, stderr, exit_code}"""
    r = api("POST", "/api/exec-sync", {
        "agent_id": agent, "cmd": cmd, "timeout": timeout
    }, timeout=timeout + 15)
    return r.get("result", {}) if r.get("status") == "completed" else r
```

### 用法

```python
health()                          # {'status': 'ok', 'agents_online': 2, ...}

dao("hostname")                   # "zhoumac\n"
dao("hostname", "141")            # "DESKTOP-MASTER\n"
dao("whoami", "desktop")          # "desktop-master\\administrator\n"
dao("ipconfig", "179")

# 完整结果
r = dao_raw("dir C:\\", "DESKTOP-MASTER")
print(r["stdout"], r["stderr"], r["exit_code"])
```

---

## CLI 客户端（cf_cloud_agent.py）

无需写代码，一行命令：

```bash
# 健康检查
python cf_cloud_agent.py --url https://qualify-wrap-ministries-liable.trycloudflare.com --token dao-ps-agent-2026 --health

# 列出 Agent
python cf_cloud_agent.py --url ... --token ... --agents

# 执行命令
python cf_cloud_agent.py --url ... --token ... --exec "hostname"
python cf_cloud_agent.py --url ... --token ... --exec "dir C:\" --agent-id 141

# 广播到所有机器
python cf_cloud_agent.py --url ... --token ... --broadcast "echo ok"
```

---

## API 参考

所有请求 Header: `Authorization: Bearer dao-ps-agent-2026`

### 查询

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/health` | `{"status":"ok","version":"3.4","agents_online":N}` |
| GET | `/api/agents` | `{"agents":[{"id","hostname","status","pending_commands",...}]}` |

### 命令执行

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| POST | `/api/exec-sync` | `{"agent_id":"ZHOUMAC","cmd":"...","timeout":30}` | 同步执行，阻塞等结果 |
| POST | `/api/exec` | `{"agent_id":"ZHOUMAC","cmd":"..."}` | 异步执行，返回 `cmd_id` |
| POST | `/api/broadcast` | `{"type":"shell","payload":{"command":"..."}}` | 广播到全部在线 Agent |

### 扩展操作（通过 exec-sync 的 type 字段）

| type | payload | 说明 |
|---|---|---|
| `shell` | `{"command":"..."}` | 默认，shell 命令 |
| `screenshot` | `{}` | 截屏，返回 base64 PNG |
| `file_read` | `{"path":"C:\\..."}` | 读文件，返回 base64 内容 |
| `file_write` | `{"path":"C:\\...","content_base64":"..."}` | 写文件 |

---

## 架构

```
云端 Agent ──CF HTTPS──→ cloudflared ──→ localhost:9910 (Server)
                                              ↑
                        141 Agent ──LAN直连──→ 192.168.31.179:9910
```

- **外部客户端**：通过 CF Tunnel 公网 URL 接入，全球可达
- **141 Agent**：局域网直连 179，1ms 延迟，无 408 超时
- **179 Agent**：localhost 直连同机 Server

Agent 守护脚本：`agent_dao.py --server <中枢地址>`，同一份代码，LAN/公网通用。

---

## 自发现

中枢启动时写入 `~/.dao/cf-hub-conn.json`：

```json
{
    "url": "https://qualify-wrap-ministries-liable.trycloudflare.com",
    "token": "dao-ps-agent-2026",
    "local_url": "http://localhost:9910",
    "port": 9910
}
```

云端 Agent 读取此文件获知最新 URL，避免硬编码。

---

*道法自然 · 无为而无不为*
