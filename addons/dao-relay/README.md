# dao-relay · 反向隧道中继 (Cloudflare Worker + Durable Object)

> 道法自然·为道日损: 这是「内网穿透」唯一的外部依赖。此前是仓库外的黑盒，现归一入库，
> 任何人都能一条命令复现部署。

## 它做什么

一台「客户端」（rt-flow-app APK 的 RelayService 或 dao-bridge agent）在 NAT/防火墙
后面，**出站**连上本中继；公网上的任何人凭 Bearer token 即可 `POST /relay/<session>`，
请求被中继经 WebSocket 转发给客户端、客户端处理后回传 —— 于是无需公网 IP、无需端口映射，
即可远程驱动内网设备。

```
内网客户端  ──出站 WSS──►  dao-relay (Cloudflare)  ◄──HTTPS POST──  公网任何设备
  (扩展 SW /                /connect?session&token        /relay/<session>
   Termux agent)           {type:request}  ──►
                           ◄── {type:response}
```

## 协议 (与 addons/dao-bridge/core.js、addons/rt-flow-app/assets/engine/relay-app.js 完全一致)

| 方向 | 端点 | 说明 |
|---|---|---|
| 客户端出站 | `GET /connect?session=<id>&token=<t>` (WSS) | 用 `(session, token)` 共同定址 DO（`idFromName(session+"\0"+token)`），把 socket 登记进去 |
| 公网入站 | `POST /relay/<session>` `Authorization: Bearer <t>` | 按**相同的** `(session, token)` 定址 DO；命中已连接客户端才转发，否则 `502 no_agent`。body=`{path,method,body}` → 转发 `{type:request,id,...}`，等 `{type:response,id,status,body}` |
| 健康检查 | `GET /` 或 `GET /health` | 免鉴权返回 `{status:"ok",service,version}` |
| 单网页控制台 | `GET /console?session=<id>&token=<t>`（亦 `/app`） | 中继**自托管**整机控制台：任意公网设备浏览器打开即得 —— 所有标签 + 网页内切换 + 单页多实例 Devin + 实时投屏 + 反向点按/滚动/输入。即使设备侧 cloudflared/SSH/局域网全被拦截也能用（仅经 `/relay` RPC 驱动）。页面 `endpoint` 默认 `location.origin` → 同源走本 Worker `/relay/<session>`，无 CORS。内容取自仓库 `engine/console.html`（单一真源），5 分钟边缘缓存 |
| 网页内原生直渲 | `GET /i/<accKey>/...` | 边缘**直取上游** `app.devin.ai`（不经设备隧道）→ 剥框限 + 注登录态 + 前缀化资源。Devin 渲染数据由边缘 + 公网浏览器自身承载，穿透(中继 DO)始终只走核心 RPC/鉴权。哈希不可变二进制资源(字体/图片/wasm)经 `caches.default` + Cloudflare 缓存层强缓存(按 `/i/<accKey>` 前缀键，账号间不串)，首次回源一次、此后全公网命中边缘，不再重复回 `app.devin.ai` 取字节 |
| 心跳 | 客户端发 `{type:ping}` | 中继回 `{type:pong}` |

### 鉴权模型 —— 零账号配对（不是单一共享密钥）

客户端用**自己随机生成**的 token 出站连 `/connect?session&token` 即占用 `(session, token)` 这个命名空间；
公网侧必须**同时知道相同的 session 与 token** 才能 `POST /relay/<session>` 驱动它（session 或 token 任一不符 →
落到空 DO → `502 no_agent`）。也就是说「知道 session+token」本身就是凭证 —— 用户**无需在 Worker 预置任何共享密钥**，
`dao-bridge` 扩展每台机器随机一个 token 即可，真正零配置零账号。

> ⚠ 旧版本（worker v1）用单一共享 `env.DAO_TOKEN` 且 DO 仅按 `session` 定址，与线上部署及 `dao-bridge` 扩展的实际 UX 不符 ——
> 按旧版自建中继会让「零账号默认通道」直接 401 失效。当前 worker（v2）已对齐线上配对模型（线上 `/health` 报 v10）。

**可选私有模式**：部署时若 `wrangler secret put DAO_TOKEN`，则额外要求 connect/relay 所用 token 必须等于它 ——
把整个中继锁给一个固定密钥（企业自托管）。不设 `DAO_TOKEN`（默认）= 开放配对，零账号即用。

## 去中心化模型 —— 谁都不必依赖谁

这条链路**对终端用户已是零账号**：手机 APK / dao-bridge 出站时自带随机 `(session, token)`，
普通使用者**不需要任何 Cloudflare / GitHub 账号、不需要建 Token、不需要建 Worker**，开机即通。

唯一的「中心」只是**中继 Worker 本身**跑在谁的 Cloudflare 账号上（默认是项目方共享的那一个，
免费套餐、只过控制/鉴权字节，不承载渲染大头）。若你**不想依赖项目方那一个**，下面任选其一即可
各自持有、互不依赖——**没有人是单点**：

### A. 一键自建 · 零 Token（最省事，推荐给"想自己掌控"的用户）

点这个按钮，授权 Cloudflare（顺带授权 GitHub 克隆本子目录），它会**自动**建好你**专属**的中继，
全程**不用手搓 API Token、不用装 wrangler、不用域名**：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zhouyoukang1234-spec/devin-remote/tree/main/addons/dao-relay)

> 子目录 `addons/dao-relay` 自包含（自带 `package.json`/`wrangler.toml`/`worker.js`/`public/`，
> 无外部依赖），Cloudflare 会把它当独立仓库根克隆后构建部署。DO 用 `new_sqlite_classes`
> 迁移 = **免费套餐即可**，无需 Workers Paid。

部署完拿到你自己的 `https://dao-relay-do.<你的子域>.workers.dev`，填进下方任一入口即生效。

### A′. 一次贴 Token · 后端全自动（顶层持久通道 · 最低用户成本）

> 反者道之动：把「登 CF → 建 Token → 装 wrangler → 部署 → 抄 URL 回填」这条长链，
> 压成**一次动作**——用户只在官网点一次 **Create** 复制一个**预填好权限**的 API Token，
> 之后后端全链路自动打通、落盘持久化。之所以走「贴 Token」而非 `wrangler login` OAuth：
> 云端 Agent 经网页远程操作用户机时，OAuth 的 `localhost:8976` 回调会落在**用户远程浏览器**
> 而非桌面，远程不便；预填 Token 深链**无回调**、一次成型、永不过期，最稳。

一条命令即成（`provision.mjs`）：

```bash
cd addons/dao-relay
# ① 先拿预填权限(Workers 脚本编辑 + 账号读)的 Token 创建深链，点开→Create→复制：
node provision.mjs --deep-link
# ② 贴回 token，后端自动: 校验→取账号→保证 workers.dev 子域→wrangler deploy→健康检查→落盘：
node provision.mjs <粘贴的CF_API_TOKEN>
#    → 得到永不漂的 https://dao-relay-do.<你的子域>.workers.dev, 写入 ~/.dao/relay.json
```

**插件侧零配置自动采纳**：dao-vsix 的 `getRelayConfig()` 把 `~/.dao/relay.json` 里的持久通道
**置顶**为出站中继首选，既有 cloudflared 快速隧道 / ntfy mesh 自动降为回退（两者取长补短）。
插件同时暴露三个端点供 UI/脚本驱动：

| 端点 | 说明 |
|---|---|
| `GET /api/relay/deep-link` | 返回预填权限的 CF Token 创建深链 + 操作指引 |
| `GET /api/relay/state` | 当前持久通道状态（token / oauth 令牌脱敏）、是否已接管 |
| `POST /api/relay/set` `{url}` | 登记持久通道 URL 并**立即置顶接管**（健康检查 + 落盘 + 重连中继） |
| `POST /api/relay/oauth-login` | 一次登录全自动打通：起本地 8976 回调 → 返回 Cloudflare 登录链接，用户授权后后端自动换 token / 部署 / 落盘 / 置顶 |
| `POST /api/relay/oauth-refresh` | 用 `refresh_token` 续期 access_token 并重部署（自愈） |
| `POST /api/relay/oauth-logout` | 撤销 CF 授权 + 清 `~/.dao/relay.json` → 回退快速隧道 / mesh（删除通道 / 切号） |

于是「org 级 MCP 集成配一次永久有效、URL 永不漂、零用户参与」成立——顶层持久通道就绪即走它，
挂了自动落回快速隧道 / mesh，无为而无不为。

### A″. 一次登录 · 全自动注册 Token（OAuth PKCE · 免手搓·推荐给"人在自己电脑前"的用户）

> 为道日损·再压一层：连「点一次 Create 复制 Token」都省掉。用户只**打开登录链接 → 登录
> Cloudflare → 点一次授权**，后端即经 **OAuth 2.0 授权码 + PKCE（RFC 7636 S256）** 全自动
> 换取 `access_token` + `refresh_token`，注册权限、部署 Worker、落盘、置顶接管——**全程无需
> 手搓任何 Token**。令牌到期用 `refresh_token` 自动续期；用户想删通道 / 换号即撤销授权并清态。

复用 wrangler 官方公共 OAuth 应用（`client_id=54d11594-…`，无需另注册），CF 固定回调
`http://localhost:8976/oauth/callback`（端口 8976 强制）。单一真源 = `oauth.mjs`（已单测）。

命令行直用：

```bash
cd addons/dao-relay
node oauth.mjs login     # 打印登录链接 → 浏览器授权 → 自动部署落盘 (~/.dao/relay.json 含 refresh_token)
node oauth.mjs refresh   # 用 refresh_token 续期并重部署 (自愈)
node oauth.mjs logout    # 撤销 CF 授权 + 清态 → 回退快速隧道 / mesh
```

插件侧同样一键：dao-vsix「内网穿透」板块顶部「⭐ 持久通道 · 一次登录全自动打通」卡片 →
点「🔐 一次登录·全自动打通」即在浏览器打开授权页（对应 `POST /api/relay/oauth-login`），
授权后后端全自动打通并置顶；卡片还提供「↻ 续期/重部署」与「🗑 删除通道/切号」。

> ⚠ 场景取舍：OAuth 的 `localhost:8976` 回调落在**发起授权那台机器**的浏览器。用户**人在自己
> 桌面**时最省事（A″）；若是**云端 Agent 经网页远程**操作用户机，回调会落在远程浏览器不便，
> 此时用无回调的**预填 Token 深链（A′）**更稳。两条路殊途同归，都落 `~/.dao/relay.json` 被插件置顶采纳。

### B. 命令行自建（CI / 批量 / 企业）

```bash
cd addons/dao-relay
npm install                      # 装 wrangler
npx wrangler login               # 或设 CLOUDFLARE_API_TOKEN
# 默认零账号配对，无需任何 secret，直接部署即可：
npx wrangler deploy
# 可选·私有模式：把中继锁给一个固定共享密钥（企业自托管）
# npx wrangler secret put DAO_TOKEN
```

### C. 纯 P2P 直连 · 零中心（推荐：大多数人连 Worker 都不需要）

> 道法自然·为道日损：去中心化的**上策不是「自动化那条长链（GitHub→登 CF→建 Token→搭 Worker）」，
> 而是让它根本不必要**。手机 APK 开机即在**公共 ntfy mesh**（ntfy.sh / ntfy.envs.net /
> ntfy.adminforge.de / ntfy.mzte.de 四家互不隶属的公开实例）上监听，公网设备只需 `session + token`
> 即经这层公共信令一次性交换**加密 SDP**（H(session+token) 派生 AES-GCM，公共 broker 全程只见密文），
> 之后 RPC 全程走 **WebRTC P2P DataChannel 点对点直连手机**，**完全不经任何 Worker**（含项目方的）。

而且**承载这个客户端页面的也不必是 Worker**——它是纯静态死文件，可经**公共 CDN 直开**：

```
https://cdn.jsdelivr.net/gh/zhouyoukang1234-spec/devin-remote@main/addons/rt-flow-app/app/src/main/assets/engine/p2p-client.html
```

链接带参数即**一开即填、可选自动直连**（`session`/`token` 兼容短名 `s`/`t`）：

```
…/p2p-client.html?session=<id>&token=<t>&auto=1
```

于是「分发给别人用」= 把上面这条链接发出去，对方一开即 P2P 直连你的手机，**全程零账号、零搭建、零中心**
（APK 内「接入设置」已内置「复制零中心直连链接」一键生成同款）。仅当对称 NAT/CGNAT 打洞失败时，才依次回退
**同一公共 ntfy mesh 的去中心化中继**（路线C-2，仍零账号零中心）→ 自建 Worker（A/B）→ 项目方默认 Worker（末位兜底）。

| 路线 | 数据面 | 依赖 | 何时用 |
|---|---|---|---|
| P2P 直连（默认） | WebRTC DataChannel 点对点 | 仅公共 ntfy 信令一次（不经 Worker） | 绝大多数网络 |
| ntfy 去中心中继（C-2） | 公共 ntfy mesh 转发 | 公共 ntfy（不经 Worker） | 对称 NAT 打洞失败 |
| 自建 Worker（A/B） | 你专属 `*.workers.dev` 中继 | 你自己的 CF 账号 | 想要固定专属域名 |
| 项目方默认 Worker | 共享中继 | 项目方那一个 | 以上全不可用时的末位兜底 |

## 填进哪里

部署后得到 `https://<name>.<account>.workers.dev`。把它填进：
- **网页控制台**（`/console` 或 APK 内）→ 汉堡菜单 ⚙「接入设置」→「Endpoint」框，或
- 浏览器扩展「内网穿透」板的「中继地址」，或
- Termux agent 的 `DAO_RELAY` 环境变量。

留空则用项目方默认中继（仍是零账号、可直接用）。

## 公网驱动示例

```bash
# 让内网那台浏览器列出当前激活账号的运行中会话:
curl -X POST https://<relay>/relay/<session> \
  -H 'Authorization: Bearer <DAO_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"path":"/api/rpc","method":"POST","body":{"cmd":"runningSessions"}}'
```

## 安全

- 入站、出站都要求非空 Bearer token；`(session, token)` 配对即访问凭证，二者皆需匹配才能命中客户端。
- 可选 `env.DAO_TOKEN` 私有模式：设置后把整个中继锁给单一密钥。
- 当客户端是 **浏览器扩展** 时，它天然没有 shell / 文件系统能力，扩展侧 relay 客户端只放
  浏览器 RPC 白名单（`/api/exec` 等 shell 路由一律 403）。机器级 shell 语义仅由
  `dao-bridge` (Termux/桌面) 提供，按需加装、与扩展解耦。
