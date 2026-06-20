# Changelog · dao-vsix（二合一插件）

道法自然 · 无为而无不为。仅记录与「内网穿透 / dao-bridge / 知识库反向注入」相关的关键变更。

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
