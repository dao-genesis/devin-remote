# dao-bridge · 独立后端 Agent

把**一台本地电脑**通过 **Cloudflare 快速隧道（`*.trycloudflare.com`）**暴露给云端——零账号、零公网 IP、零端口转发。去中心化，不依赖任何中继 Worker。

**双通道并行**：快速隧道兜底（临时 URL）+ **持久 Worker 通道置顶**（固定地址，不随隧道轮换）。持久通道是**独立进程常驻**、**不依赖 IDE**——IDE 不开也能被云端直连。

> 本目录是**纯 Node 独立后端**（无 VS Code 也能跑：NAS / 路由器 / 容器 / CI）。
> - 想要**随 IDE 自启**的插件形态见 `dao-bridge-ext/`（默认走 Cloudflare 快速隧道，配置账号才走命名隧道）。
> - Android 形态已迁入 `../rt-flow-app/`（独立 APK）。

```
云端 ──HTTPS──▶ https://<random>.trycloudflare.com
                     │  (Cloudflare 快速隧道，临时 URL)
本机 agent.js ──cloudflared 出站──┘  ──▶ 本机执行 ──▶ 真实 stdout 原路返回
```

默认走 Cloudflare 快速隧道（临时 URL，重启会变；插件形态自带看门狗自愈+实时刷新接入文档）。需要**固定地址**时，挂到自有持久 Worker（`addons/dao-relay`）：

```
云端 ──HTTPS POST──▶ https://<worker>.workers.dev/relay/<session>   (地址固定·不轮换)
                          │  Durable Object 按 (session,token) 定址
本机 agent.js ──出站 WSS /connect?session&token──┘  ──▶ 本机执行 ──▶ 原路返回
```

持久通道与快速隧道**并行**：任一可达即通。零账号配对——客户端用自己的 `(session,token)` 占用命名空间，公网侧须同时知道相同 `session+token` 才能驱动（详见 `addons/dao-relay`）。

## 启动(本机)

```powershell
# 需要 Node.js 与 cloudflared（PATH 中可用，或用 DAO_CLOUDFLARED 指定路径）
cd addons/dao-bridge
.\start.ps1

# 同时挂持久 Worker 通道（固定地址·IDE 无关）：
.\start.ps1 -RelayUrl https://dao-relay-do.<sub>.workers.dev -Session desktop-master -RelayToken dao-vsix-xxxx
```

启动后会拉起 cloudflared 快速隧道，拿到 URL 后打印云端入口：`https://<random>.trycloudflare.com`（Header `Authorization: Bearer <token>`）。token 随机生成、**仅存本机 conn.json、不入库**。

## 云端调用

```bash
curl -X POST https://<random>.trycloudflare.com/api/exec-sync \
  -H "Authorization: Bearer <token>" \
  -d '{"cmd":"hostname"}'
```

支持的 path（透明反代，直打）：`/api/health` `/api/exec` `/api/exec-sync` `/api/info` `/api/ls` `/api/read` `/api/write` `/api/agents` 等。

## 开机自启

```powershell
.\install-task.ps1            # 注册计划任务(登录自启 + 异常自动重启)
.\install-task.ps1 -Remove    # 卸载
```

## 配置(优先级:环境变量 > conn.json > 默认)

| 键 | 说明 | 默认 |
|---|---|---|
| `DAO_TOKEN` | 鉴权 token | 首启随机生成 |
| `DAO_PORT` | 本地 server 端口 | `9920` |
| `DAO_ROOT` | 工作根目录 | 用户目录 |
| `DAO_CLOUDFLARED` | cloudflared 可执行路径 | `cloudflared`（PATH） |
| `DAO_PROXY` | 出站代理（适配国内网络） | 自动探测 |
| `DAO_RELAY_URL` | 持久 Worker 通道地址（设即启用，与快速隧道并行） | 空（仅快速隧道） |
| `DAO_SESSION` | 持久通道 session（公网 `/relay/<session>` 定址） | 主机名 |
| `DAO_RELAY_TOKEN` | 持久通道配对 token | 同 `DAO_TOKEN` |

持久通道公网入口固定为 `<DAO_RELAY_URL>/relay/<DAO_SESSION>`（POST，Header `Authorization: Bearer <DAO_RELAY_TOKEN>`），协议帧 `{type:'request'|'response', id, path, method, body, status}`。

## 公网中枢形态（VPS/服务器 · hub.js）

`agent.js` 是**被控本机**形态（无公网 IP 的家用机：出站快速隧道/持久 Worker 让云端反向直达）。
当机器**自带公网 IP**（VPS/云服务器）时，用 `hub.js` 把它当**中枢**——直接 `0.0.0.0` 监听做集散点，
无需 cloudflared、无需 Worker DO：被控端（另一台电脑）一行接入，操作端经同一中枢桥接驱动被控端。

```bash
# 在有公网 IP 的机器上启动中枢
DAO_TOKEN=<master> DAO_PORT=9930 DAO_PUBLIC_URL=http://<公网IP>:9930 node hub.js
```

- **被控端接入（一行）**：Windows `iwr http://<公网IP>:9930/api/bootstrap.ps1 | iex`；
  Linux/macOS `curl -fsSL http://<公网IP>:9930/api/bootstrap.sh | sh`。出站长轮询登记为一个 agent。
- **操作端驱动**：`POST http://<公网IP>:9930/api/exec-sync`（`Authorization: Bearer <DAO_TOKEN>`），
  body `{"agent_id":"<被控主机名>","cmd":"..."}`（跨平台由中枢按被控端登记平台自动规范化）。空 `agent_id`＝中枢本机。
- 协议为纯 HTTP `connect→poll→result` 长轮询，比 WS 中继稳健；被控端 token 每机独立、不入库。

| 键 | 说明 | 默认 |
|---|---|---|
| `DAO_TOKEN` | 操作端 master token | 缺失则随机生成并打印 |
| `DAO_PORT` | 中枢监听端口 | `9930` |
| `DAO_BIND` | 监听地址 | `0.0.0.0` |
| `DAO_PUBLIC_URL` | 对外接入 URL（注入 bootstrap 脚本） | `http://<外网IP>:<port>` |

> 明文 HTTP 适合内网/诊断；对公网长期暴露建议前置 TLS（反代或命名隧道）后再收口。
