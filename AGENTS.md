# AGENTS.md · 本源认知与防踩坑（给后续 Agent 看）

> 本文是后续 Agent 接手本仓前**必读**的本源说明。它不是功能清单（功能见各模块 README），
> 而是把历史上反复踩过的坑、容易被「老数据 / 旧叙事」误导的地方一次说清，**正本清源**，
> 防止重蹈覆辙。改动本仓前先读完本文，再读 [`README.md`](README.md) 的「架构全貌 4+4+3」。

---

## 一、本源认知（最重要，先记住）

1. **dao-vsix 才是本源主体。** 所有核心底层（rt-flow 切号 + Devin Cloud 全功能六大板块 +
   本地 HTTP API + 多账号反向注入 + 内网穿透集成 + 多实例）都落在 **`core/dao-vsix`**。
   开发的着重点永远是 dao-vsix，不是 dao-one。
2. **dao-one 只是「dao-vsix + 一个 Proxy Pro 模块」。** `core/dao-one` 是最终归一交付，
   = dao-vsix 本源基座 **折入** dao-proxy-pro 三面板而已，**其余与 dao-vsix 完全一致**。
   不要把 dao-one 当成独立主体去开发；它没有自己的「业务底层」，业务底层全在 dao-vsix。
3. **没有「四合一 / 五合一」这种东西。** 历史对话里残留过 “四合一” 之类的错误叫法，
   那是老数据裹挟，**不代表架构**。准确叫法只有：
   - dao-vsix = **二合一**（切号 + 全功能面板，含本地 API）
   - dao-one = **三合一**（二合一 + Proxy Pro）
   - rt-flow-app（手机 APK）= **七合一**（这是手机端功能计数，与插件无关，别混淆）
   若在代码/文档里再看到 “四合一/五合一” 指代插件，按上面口径就地更正。

---

## 二、六大板块 · 分而治之 · 网页套网页（核心架构）

「Devin Cloud 全功能面板」逻辑上由**六大板块**组成：

| board key | 图标 | 名称 |
|---|---|---|
| `overview` | 🏠 | 主页 / 单账号管理 |
| `switch`   | 🔀 | 切号 / 账号池 |
| `bridge`   | 🌐 | 公网穿透 · DAO Bridge |
| `backups`  | 💬 | 对话备份 |
| `inject`   | 💉 | 反向注入 · 全账号 |
| `mcp`      | 🧩 | MCP 服务器 |

**分而治之 = 每个板块各开一张独立子网页**，而不是挤在一个全功能面板里靠内部 tab 切换。
承载它的是统一外壳 `/shell`（「归一 Devin Cloud 网页」），它本质是一个**浏览器套浏览器**
（网页套网页）：外壳是一个带标签栏的迷你浏览器，每个板块 / 每个多实例账号页都是其中一张
**平级并排**的标签（各自一个 iframe 子网页）。这样：

- 在 IDE 插件 webview 里能操作的，在任意外部浏览器打开 `/shell` 也能操作；
- 公网用户经 dao-bridge 隧道打开 `/shell` 即可访问同一张归一网页。

### 实现位置（改这块时务必两边对齐）

- **dao-vsix 端（板块 HTML 生产者）**：`core/dao-vsix/src/extension.ts`
  - `getDaoCloudMiddlePanelHtml(st, soloBoard?)`：`soloBoard` 传入某个 board key 时进入
    **单板块模式**——只渲染该板块、并用 `body.solo .sb{display:none}` 隐藏左侧板块导航。
    合法 board key 白名单见该函数顶部 `_solo = [...]`。
  - `setCloudProvider({ buildHtml: (board?) => getDaoCloudMiddlePanelHtml(..., board), ... })`：
    把 board 参数透传给宿主。
- **rt-flow 端（统一外壳 `/shell` 消费者）**：`core/rt-flow/extension.js`
  - `BOARDS` 注册表 + `BOARD_META`：每个板块一张独立 iframe 标签（`board:<key>`）。
  - `mountBoardSolo(html, tab)`：把某板块的 solo HTML 挂成一张独立子网页标签。
  - `/shell` 路由的 `cloudInit` 消息携带 `board` 字段，`cloudInitHtml` 回包回显 `board`。

> ⚠️ dao-vsix 的运行时副本被**捆绑**在 `core/dao-vsix/rtflow/`（独立版用）。改了
> `core/rt-flow/{extension.js,devin_cloud.js,devin_proxy.js,media/*}` 后，**必须重新 vendor**
> 同步到 `core/dao-vsix/rtflow/`，否则二合一独立版跑的是旧代码。校验：
> `diff -q core/rt-flow/extension.js core/dao-vsix/rtflow/extension.js`。

### 公网多用户「道并行而不相悖」（会话隔离模型）

`/shell` 经 dao-bridge 暴露公网后，会有**多个浏览器同时连**。每个浏览器页 = 一个 `sid`
（`SHELL_HTTP_SHIM` 内 `sh_<rand>`），各自一条 SSE 通道（`_shellClients: sid→res`）。
隔离要点（`core/rt-flow/extension.js` 宿主侧）：

- **板块回推按 sid 隔离**：六大板块是**单一宿主、状态为号主共享**的 `_cloudProvider`。
  用户发起的 `cloudInit/cloudRelay/cloudReady` 经 `_shellCloudRun(sid, fn)` **串行化**执行，
  执行期间 `_shellCloudActiveSid` 锁定该 sid，宿主一切回推（含 `await` 后的异步回包）经
  `_shellCloudDispatch` **只发给该 sid** → 各用户各得其所、互不串台。任务间（无活跃 sid）
  的后台只读刷新（`refresh`）才广播给所有页（数据本为号主共享）。
  > 旧病灶（已修）：`cloudInit` 内 `setHostPost(()=>_shellBroadcast(cloudHost))` —— 把某用户
  > 的板块数据广播给所有连接的浏览器，公网多用户互相串台。源级护栏见 `test/unit.test.js`
  > 「/shell 多用户会话隔离」。
- 各浏览器页的标签集 / 已开的 Devin 对话 iframe **本就按页隔离**（每次加载独立）。

### ⚠️ 待完善：公网用户的「Devin 对话 / 多实例账号页」仍指向 localhost 端口

`_shellResolveOpen` 开账号页时返回 `devin_proxy.ensureProxyForAccount` 的
`http://localhost:<随机端口>/…`，该反代**绑在 127.0.0.1 的独立端口**，**未经 dao-bridge 隧道
暴露**（隧道只暴露主端口 9920）。因此：

- **IDE 内 / 本机浏览器**：localhost 可达 → Devin 对话 iframe 正常。
- **公网隧道用户**：`http://localhost:<port>` 指向**用户自己**的机器 → Devin 对话页加载不出来。
  六大板块（blob-iframe + `/api/shell/*` 走 9920）不受影响，仍正常。

> 归一目标（“公网用户操作与 IDE 内完全一致”）的**最后一块**：把每账号反代改为经主端口 9920
> 的**同源路径前缀**（如 `/i/<accKey>/…`）暴露，`_shellResolveOpen` 返回**同源相对 URL**
> （`'self'` 已在 standalone shell 的 `frame-src` 白名单内）。需要 `devin_proxy` 支持前缀化
> 服务（资产/接口路径重写 + 每账号 auth 注入），可参照现有 `/devin-cloud/*` 同源反代实现。
> 此改动较大且需真实扩展宿主（VS Code）联调，宜单独成一支。

---

## 三、内网穿透是去中心化的 —— 不需要 Cloudflare 账号、不存在必需的 Worker

- 默认通道 = **dao-relay**（`addons/dao-relay`）的零账号中继：`(session, token)` 配对，
  URL 形如 `…workers.dev/relay/<session>`，**零配置、无需任何账号**，插件启动即自动打通。
- **不要以为必须有 Cloudflare 账号 / 必须重发某个 Worker 才能穿透。** dao-bridge 本身是
  去中心化节点。**只有当用户自己想要「固定不变的公网域名」时**，才需要他自己登录
  Cloudflare（命名隧道）；那是可选项，不是前置条件。
- 连不上 relay 时才自动回退 `cloudflared`（quick tunnel）。
- 代码：`addons/dao-bridge/dao-bridge-ext/extension.js`、`addons/dao-bridge/{agent,core}.js`。

> 历史踩坑：曾误判「公网透明代理 /shell 需要用户的 Cloudflare 凭证」。**错误**。
> 默认快速隧道已可用、无需登录；公网暴露 `/shell` 只是 bridge 路由 + relay 传输层的事，
> 与 CF 账号无关。

---

## 四、多实例是内置能力（只需稳定性打磨）

多实例**本就集成在插件内**，两条路并行、各登各号、互不串号：

- **浏览器多实例**：`winDefaultBrowserExe()` 起独立 profile 的 Chromium 窗口（每号一份 CDP
  隔离环境，注入该号 auth 自动登录）。
- **IDE 内路由多实例**：`core/rt-flow/devin_proxy.js` 反代 `app.devin.ai`，在 IDE 内置浏览器
  里按号路由（含 L2 磁盘缓存）。

两条路用**同一套** auth 注入（`localStorage['auth1_session']={token,userId}` + 一组 org/post-auth
键，见各文件 `buildInjectSource/buildAuthBridge`）。auth1 仍是当前 auth0 版 SPA 认可的登录态真源——
实测在 `app.devin.ai` 真源注入即秒登。

不需要新造多实例机制；遇到问题是做**稳定性完善**（见第五节踩坑 6：反代源的规范主机校验）。

---

## 五、历史踩坑清单（改前对照）

1. **dao-one 的双布局句柄解析。** dao-one mega 把各引擎装配进 `vendor-*`（rt-flow 在
   `vendor-flow/`、dao-vsix 在 `vendor-vsix/`）。被 vendor 进来的 dao-vsix 解析 rt-flow /
   devin_cloud 句柄时必须**双布局自适应**：独立版用捆绑的 `../rtflow`，mega 版回落到兄弟
   实例 `../../vendor-flow`（命中 Node 模块缓存拿同一 `_internals`，**绝不重复 activate**，
   否则命令/视图重注册必崩）。否则 `/shell`、对话备份引擎等在 mega 里恒坏。
2. **`proxy-fold.patch` 易碎。** 它把 Proxy Pro 叠到 `vendor-vsix`（**dao-vsix 源永不沾
   proxy**，保持纯二合一）。整行上下文 diff 叠到高频改动的大文件上，一行变长就崩。已改为
   `apply-overlay.js` 的 **fuzz 容差** + `build.js` 里**幂等 token 注入**；新增折入点优先用
   幂等注入，别再写脆弱的整行 diff。见 `core/dao-one/README.md`。
3. **dao-one `package.json` 是手工维护清单**（含全部 contributions）。**不要跑
   `gen-manifest.js` 覆盖**，它会重置版本并丢失手工合并的贡献项。
4. **捆绑 rtflow 易过期**（见第二节末尾的 re-vendor 提醒）。
5. **中文请求体截断**：调 Devin 接口务必用 `asciiSafeJson()`（非 ASCII 全转 `\uXXXX`），
   否则服务端会「每隔一字截断」。
6. **IDE 内路由多实例「掉登录」之真因 = 规范主机校验，不是 auth 没注入。** auth0 版 SPA 会读
   服务端下发的 `webapp_host`，一旦 `location.host !== webapp_host` 就 `location.href =`
   `` `https://${webapp_host}/login?next=...` `` **硬跳真站**（绝对 URL·`location.href` 无法 hook），
   于是反代的 `localhost:<port>` 源被弹回真站登录页。**修法（已落地）**：`devin_proxy.js` 改写
   **JSON 响应**里的 `webapp_host` = 本次请求 `Host`（IDE webview / 直连 localhost / 经 bridge 隧道
   均自动匹配）→ 校验通过、留在反代源、保持登录。配套把 HTML/JS/Location 的 `https://app.devin.ai`
   改为**裸前缀全量改写**（含单引号/反引号结尾），并加 `location.assign/replace`+`history` 运行时兜底。
   排错口诀：先 `curl <proxyPort>/<orgResolve JSON>` 看 `webapp_host` 是否=本地 Host；别再去怀疑 auth1。

---

## 六、改完怎么自检

```bash
# 1) rt-flow 单测
cd core/rt-flow && npm test

# 2) dao-vsix / dao-one 构建
cd core/dao-vsix && node build.js
cd core/dao-one  && node build.js

# 3) 渲染校验（面板 HTML 可解析）
node tools/render_check.js

# 4) 捆绑 rtflow 是否与本源一致
diff -q core/rt-flow/extension.js core/dao-vsix/rtflow/extension.js

# 5) /shell 六大板块 solo 自测（需本地 API 在 9920）
#    每个 board 应返回 body.solo + 对应 tab、左导航隐藏
```

> 历史正典与旧实测在 [`docs/archive/`](docs/archive/)，仅供考古，**以本文与 README 为准**。
