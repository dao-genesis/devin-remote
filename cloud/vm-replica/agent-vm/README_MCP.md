# DAO Bridge MCP · 四大模块自定义 MCP（Streamable HTTP）

> 道法自然 · 无为而无不为 —— **不重造轮子**：直接复用本目录已有、已实测的多 RDP
> 计算机控制底座（`vm_inner_agent.py` / `vm_host_daemon.py`），把它的操作面以
> **MCP（Model Context Protocol）** 的形态对外开放，让任意 MCP 客户端
> （Devin Cloud / Claude / Cursor / Windsurf）像操作自己的 VM 一样操作这台电脑 +
> 二合一插件本体。

## 是什么

`mcp_http.py` 是一个 **MCP Streamable HTTP**（规范 2025-03-26）服务器：单个 `/mcp`
端点，接受 JSON-RPC 2.0 的 POST，返回 `application/json`。纯 Python 标准库，可与
其余 agent-vm 一样用 PyInstaller 冻成单 exe。

它本身不实现任何底层能力，而是把请求**代理**给已有服务：

| 工具组 | 路由到 | 说明 |
|---|---|---|
| `pc_*`       | `vm_inner_agent.py` (PC_PORT) | 模块3·操作用户电脑：exec / screenshot / 鼠键 / 文件 / 窗口枚举 / `ui_tree` 元素级定位 |
| `browser_*`  | `vm_inner_agent.py` (PC_PORT) | 模块1·浏览器：Chrome CDP launch / navigate / eval / screenshot / targets |
| `plugin_*`   | dao-vsix 工作区服务 (DV_PORT) | 模块2·插件本体：health / exec |
| `vscode_*`   | dao-vsix 工作区服务 (DV_PORT) | 模块4·VSCode：执行命令 |

> **「先不用多 RDP」**：`PC_PORT` 指向跑在**交互式控制台会话**里的 inner agent，
> 即用户的真实桌面（单一目标）。日后要做「每账号一台隔离虚机」时，把
> `vm_host_daemon.py` 的多会话编排接回来即可，本服务的工具契约不变。

## 启动

```powershell
powershell -ExecutionPolicy Bypass -File start_mcp_stack.ps1
```

`start_mcp_stack.ps1` 幂等地拉起三件套（已在跑则跳过）：

1. `vm_inner_agent.py` → `PC_PORT`（默认 9050，控制台会话）
2. `mcp_http.py` → `MCP_PORT`（默认 9100）
3. `cloudflared` 快速隧道 → `http://127.0.0.1:<MCP_PORT>`，得到公网 https 地址

并把解析出的公网地址 + Bearer 写入 `C:\ProgramData\dao_vm\mcp_public.json`：

```json
{ "url": "https://<random>.trycloudflare.com/mcp", "token": "<bearer>" }
```

## 配置

`mcp_http.py` 读取环境变量，或 `C:\ProgramData\dao_vm\mcp_http.json` 覆盖：

| 键 | 默认 | 含义 |
|---|---|---|
| `MCP_HTTP_PORT` | 9100 | 本地监听端口 |
| `MCP_HTTP_TOKEN` | （空=不鉴权） | MCP 客户端需带的 Bearer |
| `PC_PORT` / `PC_TOKEN` | 9050 / 空 | inner agent 端口 / Bearer |
| `DV_PORT` / `DV_TOKEN` | 9920 / 空 | dao-vsix 工作区服务端口 / Bearer |

## 注入到 Devin 账号

把 `mcp_public.json` 里的 `url` + `token` 以自定义 MCP 形态注入账号（HTTP 传输）：

```json
{ "name": "DAO Bridge MCP", "transport": "HTTP",
  "url": "https://<...>.trycloudflare.com/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "installation_scope": "org" }
```

- **批量反向注入**：经 dao-vsix `/api/devin/mcp/add`（单账号）或 `/api/devin/batch-inject`
  把该 MCP 注入「全部 RT Flow 账号」。
- **单账号**：仅在 🏠 主页对指定账号手动注入，不被批量干扰。
- **URL 轮换自愈**：快速隧道地址在重启后会变；插件读 `mcp_public.json`，仅当
  `url` 变化时才重注入（主窗口选主·限流），不制造无谓网络。

## 与现有 stdio MCP（`mcp_server.py`）的关系

`mcp_server.py` 是面向**本地** MCP 客户端的 stdio 形态，代理到 `vm_host_daemon`
（含多 RDP 生命周期 `vm.create/attach/...`）。`mcp_http.py` 是面向**远程**客户端
的 HTTP 形态，当前直连 console inner agent（先不用多 RDP）。两者工具语义同源，可并存。
