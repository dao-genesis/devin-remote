# dao-bridge · 独立后端 Agent

把**一台本地电脑**通过**稳定的 `*.workers.dev` 公网地址**暴露给云端——出站 WebSocket 穿 NAT,无需公网 IP / 端口转发 / 隧道重启换 URL。

> 本目录是**纯 Node 独立后端**（无 VS Code 也能跑：NAS / 路由器 / 容器 / CI）。
> - 想要**随 IDE 自启**的插件形态见 `dao-bridge-ext/`（v3.3.0 起同样**默认走本中继**,连不上才回退 cloudflared）。
> - 中继 Worker 源码已**归一入库** `../dao-relay/`（v2 · `(session,token)` 零账号配对 · REST API 一键部署）。
> - Android 形态已迁入 `../rt-flow-app/`（独立 APK，内置 RelayService）。

```
云端 ──HTTPS POST──▶ dao-relay-do.<sub>.workers.dev/relay/<session>
                          │  (Worker + Durable Object，按 id 关联请求/响应)
本机 agent.js ──出站 WSS──┘  ──▶ 本机执行 ──▶ 真实 stdout 原路返回
```

对比仓库根目录的 GitHub-Issues mailbox 方案:mailbox 零基础设施、最稳;本方案低延迟、像普通 HTTP API,二者互补。

## 启动(本机)

```powershell
# 需要 Node.js
cd addons/dao-bridge
.\start.ps1 -Session 141
```

首次会自动 `npm install ws` 并生成 `conn.json`(含随机 token,**仅存本机、不入库**)。
启动后打印云端入口:`POST https://dao-relay-do.<sub>.workers.dev/relay/141`(Header `Authorization: Bearer <token>`)。

## 云端调用

```bash
curl -X POST https://dao-relay-do.<sub>.workers.dev/relay/141 \
  -H "Authorization: Bearer <token>" \
  -d '{"path":"/api/exec","method":"POST","body":"{\"cmd\":\"hostname\"}"}'
```

支持的 `path`:`/api/health` `/api/exec` `/api/info` `/api/ls` `/api/read` `/api/write` `/api/file`。

## 开机自启

```powershell
.\install-task.ps1            # 注册计划任务(登录自启 + 异常自动重启)
.\install-task.ps1 -Remove    # 卸载
```

## 配置(优先级:环境变量 > conn.json > 默认)

| 键 | 说明 | 默认 |
|---|---|---|
| `DAO_RELAY` | Worker 中继 URL | `https://dao-relay-do.zhouyoukang.workers.dev` |
| `DAO_SESSION` | 会话名(= `/relay/<session>`) | `141` / 主机名 |
| `DAO_TOKEN` | 鉴权 token | 首启随机生成 |
| `DAO_PORT` | 本地 server 端口 | `9920` |
| `DAO_ROOT` | 工作根目录 | 用户目录 |

中继 Worker 的源码与一键部署见 `../dao-relay/`(已归一入库;`worker.js` v2,REST API 一键部署,无需 wrangler CLI)。默认端点 `dao-relay-do.zhouyoukang.workers.dev` 由项目方部署、所有用户共享,按 `(session,token)` 隔离;也可自部署后用 `DAO_RELAY` 覆盖。
