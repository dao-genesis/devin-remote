# dao-bridge · 独立后端 Agent

把**一台本地电脑**通过 **Cloudflare 快速隧道（`*.trycloudflare.com`）**暴露给云端——零账号、零公网 IP、零端口转发。去中心化，不依赖任何中继 Worker。

> 本目录是**纯 Node 独立后端**（无 VS Code 也能跑：NAS / 路由器 / 容器 / CI）。
> - 想要**随 IDE 自启**的插件形态见 `dao-bridge-ext/`（默认走 Cloudflare 快速隧道，配置账号才走命名隧道）。
> - Android 形态已迁入 `../rt-flow-app/`（独立 APK）。

```
云端 ──HTTPS──▶ https://<random>.trycloudflare.com
                     │  (Cloudflare 快速隧道，临时 URL)
本机 agent.js ──cloudflared 出站──┘  ──▶ 本机执行 ──▶ 真实 stdout 原路返回
```

默认走 Cloudflare 快速隧道（临时 URL，重启会变；插件形态自带看门狗自愈+实时刷新接入文档）。需要稳定 URL 时，配置自己的 Cloudflare 命名隧道。

## 启动(本机)

```powershell
# 需要 Node.js 与 cloudflared（PATH 中可用，或用 DAO_CLOUDFLARED 指定路径）
cd addons/dao-bridge
.\start.ps1
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
