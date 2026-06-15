# dao-relay · 反向隧道中继 (Cloudflare Worker + Durable Object)

> 道法自然·为道日损: 这是「内网穿透」唯一的外部依赖。此前是仓库外的黑盒，现归一入库，
> 任何人都能一条命令复现部署。

## 它做什么

一台「客户端」（Termux agent 或 **rt-flow-mobile 浏览器扩展的 service worker**）在 NAT/防火墙
后面，**出站**连上本中继；公网上的任何人凭 Bearer token 即可 `POST /relay/<session>`，
请求被中继经 WebSocket 转发给客户端、客户端处理后回传 —— 于是无需公网 IP、无需端口映射，
即可远程驱动内网设备。

```
内网客户端  ──出站 WSS──►  dao-relay (Cloudflare)  ◄──HTTPS POST──  公网任何设备
  (扩展 SW /                /connect?session&token        /relay/<session>
   Termux agent)           {type:request}  ──►
                           ◄── {type:response}
```

## 协议 (与 addons/dao-bridge/core.js、addons/rt-flow-mobile/src/relay.js 完全一致)

| 方向 | 端点 | 说明 |
|---|---|---|
| 客户端出站 | `GET /connect?session=<id>&token=<t>` (WSS) | 校验 token，把 socket 登记到 `idFromName(session)` 的 DO |
| 公网入站 | `POST /relay/<session>` `Authorization: Bearer <t>` | body=`{path,method,body}` → 转发 `{type:request,id,...}`，等 `{type:response,id,status,body}` |
| 健康检查 | `GET /` 或 `GET /health` | 免鉴权返回 `{status:"ok"}` |
| 心跳 | 客户端发 `{type:ping}` | 中继回 `{type:pong}` |

单一共享 token (`DAO_TOKEN`，wrangler secret)；`session` 命名空间隔离多个客户端。

## 部署

```bash
cd addons/dao-relay
npm install                      # 装 wrangler
npx wrangler login               # 或设 CLOUDFLARE_API_TOKEN
npx wrangler secret put DAO_TOKEN   # 输入共享 token (勿写进仓库)
npx wrangler deploy
```

部署后得到 `https://<name>.<account>.workers.dev`。把它填进：
- 浏览器扩展「内网穿透」板的「中继地址」，或
- Termux agent 的 `DAO_RELAY` 环境变量。

## 公网驱动示例

```bash
# 让内网那台浏览器列出当前激活账号的运行中会话:
curl -X POST https://<relay>/relay/<session> \
  -H 'Authorization: Bearer <DAO_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"path":"/api/rpc","method":"POST","body":{"cmd":"runningSessions"}}'
```

## 安全

- 入站、出站都强制 Bearer token 校验。
- 当客户端是 **浏览器扩展** 时，它天然没有 shell / 文件系统能力，扩展侧 relay 客户端只放
  浏览器 RPC 白名单（`/api/exec` 等 shell 路由一律 403）。机器级 shell 语义仅由
  `dao-bridge` (Termux/桌面) 提供，按需加装、与扩展解耦。
