# IDE 多实例 webview 加载差距 · 根因实测与分层根治

> 范围：`core/dao-vsix/src/extension.ts`（公网同源云路 `devinCloudProxyRoute`）+
> `core/rt-flow/devin_proxy.js`（IDE 每账号反代，内嵌副本 `core/dao-vsix/rtflow/devin_proxy.js`）。
> 目标：消除「IDE 内多实例登录不同 Devin 账号」相对「浏览器多实例直连」的加载差距。
> 本文为决策记录（结论以**同机实测**为准，非推断），对应 PR #651 / #654 / #659 / #663 / #665（均已并入 main）。

---

## 0. 一句话结论

「IDE 多实例慢于浏览器」的真因**不是**改写 / TLS / 带宽，而是 **SPA ~480 个 Vite 分片按依赖逐层向反代索取、冷态每层一次上游往返的瀑布式串行**；每个新账号 = 独立 localhost 端口 = 独立 origin = 浏览器缓存全空，故每开一个新账号都重走整条冷瀑布。
根治后**静态资源层不仅不慢、反而比浏览器直连快约 36 倍**（暖缓存命中），唯一残留是「预热完成前的冷窗口」，再由「关键路径优先预热」压到只等首屏几片。

---

## 1. 实测对照（同机量化 · 非猜）

| 路径 | 每资产中位 | 20 分片总耗时 |
|---|---|---|
| IDE 内置代理（loopback 暖缓存命中） | **1.14 ms** | 103 ms |
| 浏览器直连 `app.devin.ai`（真实公网 RTT） | **140.93 ms** | 3738 ms |

→ 直连比代理慢 **36.2 倍**。冷/热对照坐实预热价值：同脚本第一遍（缓存有遗漏）4042 ms，补满后 103 ms——**冷瀑布是唯一慢源，预热把它塌缩**。

---

## 2. 分层根治（最小改动 · 道法自然）

| # | 根因 | 修复 | PR |
|---|---|---|---|
| 1 | 多实例每个新 origin 缓存全空，各自重走冷瀑布 | 反代启动即后台并行抓全 SPA 模块图入跨账号共享缓存（L1 内存 + L2 磁盘，32 并发）；缓存键与账号无关，首个实例预热、其余实例直接命中 | #651 |
| 2 | 公网同源路（`devinCloudProxyRoute`，`~/.dao/asset-cache/`）是惰性填充，首个公网设备仍走冷瀑布 | 服务就绪即后台 BFS 预热公网路全模块图 → 首个公网设备即命中宿主暖缓存，隧道只剩 API/HTML 动态核心（知雄守雌） | #654 |
| 3 | 发布/探活/mesh 三处令牌取自 `bridgeToken`，与服务端真验源脱钩 → 重载后 token-drift、401 锁门 | 三处令牌归一到权威源 `ws.token`（机器级恒稳、服务端真验）；探活以「已发布 token 能否真连通」为基准，失效即主动刷新 + 反向注入 | #659 |
| 4 | CloudFront/上游回 `Connection: close` 原样泄给客户端 → 跨 480 分片每个资产重握手 TCP | 两条反代路均剥逐跳头（hop-by-hop）、协议层强制 `keep-alive`，复用同一条 socket（价值在公网隧道路，loopback 近零收益） | #663 |
| 5 | 预热完成前的冷窗口（真机抓全图 ~44s） | 关键路径优先预热：先抓 index 直引入口 chunk + CSS + modulepreload（首屏集，~秒级），置位 `_cloudPrewarmCritical`；深层 dynamic-import 分片后台续抓 → 新账号「首开」只等首屏几片、不等全图 | #665 |

---

## 3. 主动有效性自愈范式（通用）

不以「事件（URL 变化）」为触发，而以**实际有效性**为基准的闭环：周期性探活「当前已发布的 (URL, token) 能否真正连通用户设备」→ 探到不可达/失效（如 token-drift）→ **自动刷新隧道 + 自动反向注入**权威配源。该「主动探效 → 失效即刷新即反注入」循环为通用范式，可套用至所有穿透/账号池/中继模块。

实证（`~/.dao/dao-loops.log`）：
```
[tunnel] probe ALIVE 但已发布配源失效[token-drift] → 主动刷新+反注入
last-inject.json → token=ws.token（机器级恒稳·服务端真验源）
probe ALIVE+EFFECTIVE（持续稳定）
```

---

## 4. 验证标志（部署后坐实）

- 关键路径两阶段分离（`~/.dao/cloud-prewarm.log`）：
  ```
  [cloud] critical-path warm: N assets in Mms   ← 首屏集先暖
  [cloud] prewarm done:        M assets in Kms   ← 全图后台续抓
  ```
- 两条路 `/` 与 `/assets/*.js` 均回 `Connection: keep-alive` + `X-Dao-Ka` 标记。
- 自检：`rt-flow` `npm test` 全绿；`build.js` / `render_check` OK；`core/rt-flow/devin_proxy.js` 与内嵌副本 `core/dao-vsix/rtflow/devin_proxy.js` 逐字节一致。

---

## 5. 收尾根治（残留两项已闭环）

| # | 残留 | 根治 |
|---|---|---|
| 6 | token-drift 虽由自愈环每 ~30s 纠回，仍会周期性短暂漂移：根因是**发布路**多处以 `bridgeToken \|\| ws.token`（易变源优先）对外公布令牌，与服务端真验源 `ws.token` 脱钩，窗口重载随机铸新 `bridgeToken` 即令已发布令牌静默失效 | **发布 token 永不再漂**：所有对外公布/复制/conn.json/getState/候选 路径一律倒为 `ws.token \|\| bridgeToken`（机器级恒稳源优先、`bridgeToken` 退为回落）；`bridgeStartTunnel` 启动链优先 `ws.token`；「刷新 Token」由「凭空铸新随机牌」改为「重新同步发布权威 `ws.token` 并扩散到所有账号」；探活采纳外部候选令牌加 `!ws.token` 守恒护栏（永不以外部源覆盖 `ws.token`）。`checkAuth` 同时认 `ws.token` 与 `bridgeToken`，故内网回环鉴权不受影响 |
| 7 | 真机全图预热 ~44s（分批栅栏：每批 `Promise.all` 须等最慢者才开下一批，尾部阻塞） | 关键路径阶段 + 全图 BFS 每轮均改用**有界并发工作池** `_drainPool`（N 个工人持续取活、一件完成立刻取下一件，持续满载无尾部阻塞），并发 32→48（`_httpsAgent.maxSockets=64`，留 16 socket 给实时供给）；语义不变（关键路径先暖、深层分片据 JS 体续扫），墙钟塌缩 |

> 自检：`rt-flow` `npm test` 全绿（PASS 120 + PASS 35）；`build.js` / `render_check` OK；`_drainPool` 单测（并发上限、序保、空集、容错）通过；`core/rt-flow/devin_proxy.js` 与内嵌副本逐字节一致。
