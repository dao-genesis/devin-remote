# 二合一架构 · 切号 + 内网穿透 + 网页多实例 (v1.7.0)

> 为道日损，损之又损，以至于无为而无不为。
> 把 `dao-bridge-android`（Termux 原生 agent）的「出站连中继」这条腿**砍掉**，
> 搬进 `rt-flow-mobile` 扩展的 service worker —— 一个插件同时是
> 「切号板块」+「内网穿透核心」+「网页多实例」，零部署、无感、低成本。

## 三大模块同居一个扩展

| 模块 | 入口 | 实现 |
|---|---|---|
| **切号** | popup / panel「切号」板 | `background.js` 25 条 RPC + DNR 注入鉴权头 + `content.js` 注入 localStorage 登录态 |
| **内网穿透** | panel「内网穿透」板 | `relay.js`：SW 出站 WSS 连中继 → 收公网请求 → 经浏览器 RPC 白名单 → 调 `dispatch` |
| **网页多实例** | 各账号「⧉ 新页」/ panel「多实例」板 | per-tab DNR (`tabIds`) + `iso.js` 把 dao 登录键的 localStorage 读写改向 sessionStorage |

## 关键招 (handoff/03 的洞察)

MV3 service worker 本就能开出站 `WebSocket`，而「内网穿透」用户真正要穿的是
**浏览器 rt-flow 的 25 条能力**（远程切号/列会话/导出/健康度…），不是机器 shell。
这些能力扩展 SW 已全有 → 直接在 SW 里连中继、把这些能力暴给公网即可，Termux 整条腿多余。

```
P0  addons/dao-relay/         中继 Worker+DO 源码归一入库 (此前是仓外黑盒)
P1  background.js dispatch()   25 条 switch 抽成纯函数, popup 与 relay 共用
P2  relay.js                   SW 出站 WSS 客户端 + 浏览器 RPC 白名单 (shell 路由 403)
    多实例                     per-tab 账号绑定 + per-tab DNR + sessionStorage 隔离
P3  panel.html / panel.js      独立控制台: 切号 / 内网穿透 / 多实例 三板; popup 退化为入口
```

## 安全边界 (能边界要诚实)

- 扩展天然**无 shell / 文件系统能力**。relay 入站只接「义 B · 浏览器 RPC 白名单」，
  任何 `/api/exec|read|write|ls|info|device` 一律 **403 shell_disabled**。
- 机器级 shell 语义（义 A）仍由 `dao-bridge`（桌面 VSIX / Termux）独立提供，按需加装、与扩展解耦。

## 网页多实例 = 怎样互不干扰 (民至于老死不相往来)

1. **API 鉴权隔离**：每个绑定 Tab 一条 per-tab DNR 规则（`condition.tabIds:[id]`，priority 2），
   只改写该 Tab 发起的 `app.devin.ai/api/*` 请求头 → 各 Tab 各带各账号的 `Authorization`。
2. **登录态隔离**：同源 `localStorage` 跨 Tab 共享会互相覆盖；`iso.js`（MAIN world·document_start）
   把 `auth1_session` 等 dao 登录键的 `localStorage` 读写**改向 `sessionStorage`**，
   而 `sessionStorage` 按浏览上下文（Tab）天然隔离 → 各 Tab 各登各号。
3. **全局切号不污染多实例**：`broadcastInject` 跳过已绑定 Tab。

## 自测

```bash
cd addons/rt-flow-mobile
node test/relay.test.js          # 内网穿透白名单 / shell 403 / dispatch 映射
node test/multiinstance.test.js  # per-tab DNR / 绑定 / 隔离 / 清理
node test/background.test.js test/cloud.test.js test/git.test.js test/parse.test.js
```
