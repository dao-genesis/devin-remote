# Changelog · dao-vsix（二合一插件）

道法自然 · 无为而无不为。仅记录与「内网穿透 / dao-bridge / 知识库反向注入」相关的关键变更。

## 3.35.0

**去中心化根治：每窗口各自独立公网隧道（鸡犬相闻·老死不相往来）**

- 根因定位：`connectSingleRelay` 对 `workers.dev`/`cloudflare` 域**强制走本地代理**，一旦本机无代理（或代理 CONNECT 失败）便直接 `onFail()` 放弃——**从不尝试直连**。导致每个实例的 relay 通道永远连不上（`relay=local`），于是**所有窗口没有各自的公网 URL**，全网唯一入口退化为编排器那条写死指向 9920 的「独苗」cloudflared 隧道 → 只有最早占住 9920 的窗口对外可见（你反复看到旧界面的真正底层原因）。
- 修复：无代理 / 代理失败时**直连兜底**（本机出网可达 Cloudflare，cloudflared 隧道已证明这点），让每个实例都能独立连上自己的 `relay/<本窗口唯一 session>`。N 个窗口 = N 条独立出站隧道、N 个独立公网 URL、各自账号，完全并行、互不覆盖。会话 id 已是「workspaceKey + 32 位随机」每窗口唯一，conn 注册表(`dao-conn.json`)已是按 pid 去重的数组——去中心化设计本就齐备，此前只因 relay 连不上而休眠。

## 3.34.0

**内穿自愈增强 + 知识库触发器改「所有对话均触发」**

- 存活探测环(`bridgeLivenessTick`)在探测到隧道死时，对**进程内持有的隧道**改为真正的「停止+重启」(`bridgeStopTunnel` → `bridgeStartTunnel`，保持命名/快速模式)，而非仅刷新地址；新增连续失败计数 `_bridgeLivenessFail`，常驻发布连接连续 3 次探测仍为死则兜底自起快速隧道，不再死等常驻桥轮换。探活成功即清零计数。
- 知识库两篇反向注入文档(`DAO_BRIDGE_KB_TRIGGER` / `DAO_MCP_KB_TRIGGER`)的触发器由「条件触发」改为 **「所有对话均触发」(Always retrieve in every conversation)** —— 每个对话的 Agent 一开始就知道「可远程操作用户本地电脑」的方法，无需特定关键词命中。

## 3.33.1

**修复：端口/URL 自愈自检在 relay 通道下失效 → 知识库不会实时刷新（核心修复）**

- `bridgeProbeAlive` 旧法对公网 URL 做**无鉴权 GET** `/api/health`。但生产默认的 **relay 通道**（Cloudflare Worker · `workers.dev/relay/<session>`）对一切请求强制 `Authorization: Bearer <token>` 鉴权——缺 token 必返 **401**，而旧逻辑把 `401(<500)` 误判为「存活」。
  - 后果：relay 通道下隧道**真断**（本机 hub 掉线）也探不出来 → 30s 存活环永远「活」→ **知识库反向注入永不刷新**，云端 Devin 账号拿到的可能是失效 URL/Token。
- 现修复（与 dao-bridge v3.9.1 看门狗同源）：
  - relay URL → 走**信封 POST** `{path:'/api/health',method:'GET',body:{}}` + `Authorization: Bearer <token>`，校验内层健康体（非错误 JSON、2xx）才算「活」；401 / 502 / `{error}` 一律判「死」→ 触发刷新。
  - 直连 / 命名隧道 → `GET /api/health`（带 token 无害），逻辑不变。
- `bridgeEffectiveUrl()` 旧法仅取透明 `url`，**漏掉 relay-only 连接**（仅 `relayUrl` 无透明 url），导致存活环根本不探 relay 隧道。现兜底回退 `relayUrl`。
- 新增 `bridgeEffectiveToken()` / `bridgeMcpToken()`，存活探测自动带上桥/ MCP 的最新 token。

**效果**：URL / 端口 / Token 一旦变化（自愈轮换、手动重启、隧道断裂自愈），30s 存活环即可在 relay 通道下**真实**探出，触发 `reinjectBridgeToAllAccounts` → 把最新接入文档（含 URL/Token/bootstrap）**实时反向注入到所有 Devin 账号的知识库**。端口怎么变都无所谓，知识库实时跟随。
