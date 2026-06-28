# Changelog · dao-vsix（二合一插件）

道法自然 · 无为而无不为。仅记录与「内网穿透 / dao-bridge / 知识库反向注入」相关的关键变更。

## 3.50.56
- **根治自更新闭环静默失败(真因: CLI 不在 PATH 找不到)**。`selfUpdateFindCli()` 旧法仅靠 `where devin/code/windsurf` 在 PATH 查 CLI; 但 VSCode 系发行版(本机 Devin = `E:\Windsurf\Devin.exe`)的安装命令行在 `<安装根>\bin\*.cmd`(如 `E:\Windsurf\bin\windsurf.cmd` / `devin-desktop.cmd`), **默认不进 PATH** → `where` 全空 → `--install-extension` 永不执行 → v3.50.46~54 一个都没自动装上(这正是"更新闭环没生效·机器一直跑老码"的根)。
  - 改为**先按 `path.dirname(process.execPath)` 推导 `bin/*.cmd|exe`**(覆盖 `<根>/bin`、`<根>/../bin`、`<根>`; 名单含 `devin-desktop`), 再退路 `where`/`which`。跨平台(win 用 where、*nix 用 which)。
  - 经此活机已实测从 v3.50.53 → v3.50.55 安装成功并重载生效。

## 3.50.55
- **根治代理检测误判(项⑥·多级网页搜索「网络不可达/站点拒绝代理」真因)**。旧 `detectProxyPort` 用 `net.Socket.connect()` 同步探口, 但 connect 是**非阻塞**的——`try/catch` 捕不到「连接被拒」, 故不论端口是否在监听都「成功」→ 永久误设 `detectedProxyPort=7890`。若用户 Clash/V2Ray 不在 7890(或未开), 代理赛道 CONNECT 必败 → 被墙站(google/stackoverflow 等)直连黑洞 + 代理误判 → 直出错误页。
  - 改为**异步真实 TCP 探活**(等 connect/error 事件·350ms/口超时·逐口短路), 端口实测在监听才采纳; 同步入口只查环境变量/配置(不阻塞事件循环), 端口实探交后台异步。
  - 新增 **Windows 系统代理(注册表 Internet Settings·ProxyServer)** 退路探测; 环境变量匹配兼容 `localhost`(此前仅 `127.0.0.1`)。
  - **周期重探**: 命中后 60s、未命中后 15s 重探 → 代理在插件启动后才开/重启换端口也能自动接管。
- **HTTP 站点补齐代理赛道**。此前 `isHttps?proxy:0` 致 HTTP 站点根本不走代理(直连必败即报错)。`fetchViaTunnel` 增 HTTP 分支: 标准代理「整 URL 作请求行」(GET http://host/path), 与 HTTPS 的 CONNECT 隧道并存。
- **错误页文案区分**: 「未检测到本地代理(请确认 Clash/V2Ray 已启动)」vs「代理连接失败(直连与代理均不可达)」, 不再一律含糊「站点拒绝代理」。

## 3.50.54
- **同步 vendored rt-flow(补 3.50.53 漏)**。`core/dao-vsix/rtflow/extension.js` 是 dao-vsix 运行期实际加载的 rt-flow 副本(非 gitignored 构建产物, 须手动随源同步)。3.50.53 漏同步 → 切号面板 `__wamRebuild` 的 rt-flow 侧 15s 节流未随 VSIX 落地(仅 dao-vsix 侧 10s 节流生效)。本次补齐, 双层节流完整。

## 3.50.53
- **切号板块三大修复(根治「面板自动跳顶 + 新账号初始化没配好 + 归零清理不生效」)**。
  - **面板自动跳顶根治**: `__wamRebuild` 双层节流(rt-flow 15s + dao-vsix 10s), 大批量验号期间不再每几秒重挂 iframe → 用户可正常滚动和操作。
  - **新账号系统级初始化**: 原 `!p.enabled → skip` 把固定道藏(准则KB/桥KB/DAO_TOKEN)也一起跳过 → 新添加账号根本不初始化。改为: 系统级注入不受用户档案 enabled 门控, 用户自选项仍受控。
  - **立即清理按钮(参手机版)**: 在切号面板增加「⚡ 立即清理(全部)」按钮, 委托 `wam.devinCleanupImmediate`(无模态·全程 toast), 与现有「🌊 归零清理」并列。

## 3.50.52
- **VSIX 自更新模块(根治「插件不会自己更新」)**。桌面端此前无 VSIX 自更新机制 → 插件永远停在安装时版本, 新修复/新功能均无法自动落地。
  - 稳态下每 6h 低频检查 GitHub Release 最新 `dao-vsix-v*` 标签(守柔不阻塞)。
  - 发现新版 → 自动下载 VSIX(自带 GitHub 直连 + 国内 5 路加速镜像多路回落, 任一可达即通)。
  - 自动检测 IDE CLI(`code`/`windsurf`/`cursor`/`devin`)→ `--install-extension --force` → 弹出「立即重载」通知, 一键即生效。
  - 旧版 VSIX 自动清理, 下载失败守柔退出不影响正常运行。
  - 自检:`node build.js`(转译+桥JS语法)、rt-flow 35 单测 OK。仅改 `core/dao-vsix/src/extension.ts`。

## 3.50.51
- **路线C(ntfy mesh)兜底通道根治为「整机全权可用」**。经 mesh 实测发现:除免鉴权 `/api/health` 外, `/api/exec`、`/api/file`、`/api/write` 等需鉴权整机端点经 mesh 一律 `500 unauthorized` —— 兜底通道形同半残(cloudflared 公网URL 全挂时, 云端连不上也操作不了机器, 正是用户所报「端口断了根本连不上、账号信息全没更新」的兜底缺口)。
  - 根因:`sigServeFrame` 构造的 `fakeReq` 不带 `Authorization` 头, `checkAuth` 必判 unauthorized。但 mesh 帧以 token 派生的 AES-256-GCM 封装, **`sigUnseal` 成功 ⟺ 调用方持有正确 token** —— 解封成功本身即等同鉴权。
  - 修法:解封成功后向 `fakeReq` 注入权威 `Bearer`(`bridgeAuthoritativeToken`), 令 mesh 兜底通道全整机端点照常可用。cloudflared 公网URL 与中继 Worker 同时全挂时, 云端仍可经多家公共 ntfy broker 加密直达本机全权操作。
- **反向注入加「公网实活闸门」: 死址/(未连接) 不得覆盖账号库良态**。实测发现 `bridgeAutoPersist → bridgeInjectKnowledge` 路径无活性校验, 隧道未捕获(`publicUrl=null`)时径直把死址写进知识库 → 云端读到连不上端口。
  - 修法:`bridgeInjectKnowledge` 注入前先 `bridgeResolveLiveConn` 公网实活校验; 全死则守柔退出不覆盖, 待探活环重建隧道后再注(与 `reinjectBridgeToAllAccounts` 同闸门)。
  - 自检:`node build.js`(转译+桥JS语法)、rt-flow 35 单测 未受影响。仅改 `core/dao-vsix/src/extension.ts`。

## 3.50.45
- **browser_emulate `reset` 据实测根治为「可靠复位桌面」**。v3.50.44 落地后继续 live 实测发现：无状态短连里，由「已亡会话」设下的设备度量覆写是孤儿态——新连的 `clearDeviceMetricsOverride`、`setDeviceMetricsOverride{width:0}` 皆无法清除（reset 后视口仍停在 390）；但实测确证**新连的 `setDeviceMetricsOverride(新值)` 可全局覆盖生效**（实测 400→1100 即时改变）。
  - 修法：`reset` 改为先以桌面度量（默认 1280×800·dsf 1·mobile false）覆盖（可靠复位桌面布局），再于同一会话内 `clearDeviceMetricsOverride`（此时本会话拥有该覆写，clear 可真正移除→回归原生）；二者叠加确保稳定复位。`reset` 可传 `width/height` 自定义。
  - 自检：`node --check`、`build`、rt-flow 115+35 全过。仅改 `core/dao-vsix/src/extension.ts`。

## 3.50.44
- **browser_emulate 据「实践暴露的缺陷」据实收敛（道法自然·不虚报）**。围绕 emulate 做了三轮实测螺旋，最终落到「只承诺可靠落地的能力」：
  - v3.50.43 曾试图用 `Page.addScriptToEvaluateOnNewDocument` 注入持久客户端 UA 覆写补偿会话级 UA override 的失效——但 live 实测（固定 targetId 串测 emulate→navigate→eval）证明：**该注入脚本同样是会话级**，`daoCdpBatch` 连接一断即被 Chrome 清除（`navigator.userAgent` 仍回落桌面、`reset` 报 `Script not found`）。
  - 经实测确证的「页面级·跨无状态短连与跨导航持久」覆写只有：**设备度量（视口 width/height）+ 触摸**（`Emulation.setDeviceMetricsOverride` / `setTouchEmulationEnabled`）。故 v3.50.44 将 emulate 收敛为这两项，移除不持久的 UA 注入与脚本追踪态；返回体 `note` 据实标注「视口+触摸持久生效（含跨导航）；完整 UA/请求头模拟需常驻 CDP 会话，暂未提供」，`reset` 干净还原、无报错。
  - 完整 UA/请求头级设备模拟 + 实时 screencast「镜像观看」需要为 target 维持一条常驻 CDP 连接（当前 24+3 工具均为无状态短连），属后续架构螺旋——据实交予用户定夺，不在本版投机引入。
  - 自检：`node --check`、`build`、rt-flow 115+35 全过；live 实测 emulate 后跨导航视口/触摸保持、`reset` 无报错。仅改 `core/dao-vsix/src/extension.ts`。

## 3.50.42
- **browser_\* 浏览器板块对齐手机 APK / Playwright·Chrome-MCP（道并行而不相悖·additive）**。browser_\* 经独立 `--user-data-dir` 隔离 Chrome（CDP 9333）运行——与用户主浏览器互不相干，既可操作该实例内「已打开的多标签页」（持久 profile·`browser_targets`/`browser_tabs` 全可寻址、每条工具按 `targetId` 路由并行实例），也可新开多标签后台操作而不干扰用户前台；用户可切到该 Chrome 窗口实时观看全过程。
  - **修复 `browser_upload`（确证缺陷）**：原实现先以一个短连 CDP 会话取元素 `objectId`，再到另一会话调 `DOM.setFileInputFiles` → 因 `objectId` 仅在创建它的会话内有效，必报 `Could not find object with given id`、文件永远设不进去。根治：`daoCdpBatch` 的 `params` 支持「函数」形态——用同一会话内已得结果动态构造下一条命令参数；upload 改为单会话内 `Runtime.evaluate(取节点)` → `DOM.setFileInputFiles(串接 objectId)`，并先以 `exists()` 给出清晰 `element-not-found`。
  - **新增 `browser_emulate`（对照手机·设备模拟）**：`device=iphone|pixel|ipad` 预设或自定义 `width/height/mobile/deviceScaleFactor/userAgent/touch`，经 `Emulation.setDeviceMetricsOverride`+`setUserAgentOverride`+`setTouchEmulationEnabled` 让内嵌页以手机视口/UA/触摸态呈现；`reset=true` 还原。
  - **新增 `browser_cookies`（登录态续用）**：`get/set/clear/delete`，`Network.getCookies`/`setCookies`/`clearBrowserCookies`/`deleteCookies`。
  - **新增 `browser_pdf`**：`Page.printToPDF` 整页导出，传 `path` 直接落盘。
  - 工具面 59→**62**（browser 24→27）；插件按工具集变化自动重生成并反向注入知识库文档。
  - 自检：`node --check`（dao-vsix out）、`build`、rt-flow 测试（115+35）全过；live 经公网 `/mcp` 实测 upload 落值成功、emulate/cookies/pdf 均通。仅改 `core/dao-vsix/src/extension.ts`（不涉 rt-flow re-vendor）。

## 3.50.41
- **站内搜索/外链内嵌提速 + 关于说明归正（无为·additive·不破坏既有反代）**。
  - **内嵌网页/搜索首屏提速**：`genericWebProxy` 注入页在 `<base>` 之后追加 `<link rel="preconnect"/dns-prefetch href=源站 origin>`，浏览器提前完成源站 DNS/TCP/TLS 握手，搜索结果页/外链页的子资源（图/样式/脚本，经 base href 直取源站）更快到位，逼近系统浏览器级首屏。纯增量、不改请求/改写逻辑。
  - **关于·说明归正**：归一面板「关于」原文仍称「外部站点设 X-Frame-Options 不可内嵌，搜索/外链经系统浏览器打开」，与现状（`/__web` 站内代理剥 XFO/CSP·直连+本机代理双赛道·链接/表单/整页跳转自动续走代理·内嵌直出）不符；据实改为内嵌直出说明，个别强校验/需登录态站点回退系统浏览器。
  - 复核确认搜索引擎链路（`/__web` → `genericWebProxy`：XFO/CSP 剥离、`<base>` 注入、点击/GET 表单/`window.open`/`location.assign,replace` 全拦改经代理、3xx 重定向跟随、gzip/br/deflate 解压、下载落盘、直连+代理双赛道、22s 硬超时错误页）完备；多视图加载链路（80ms 去抖批量恢复只载活动页·其余点开即载、上游 keep-alive、改写资产缓存）完备——本版在其上做 additive 提速，未改其结构。
  - 自检：`node --check`（rt-flow 源 + vendored + dao-vsix out）、render_check、rt-flow 测试（115+35）全过、rtflow 源↔vendored 逐字一致、构建后 `out/extension.js` 含 preconnect 注入。

## 3.50.40
- **归一面板（多实例标签栏）对齐手机 APK · 标签状态实时化（守柔·不破坏既有窗口）**。
  - **状态指示灯实时化**：标签状态点（🟢running / 🟠awaiting·待输入 / 🟠blocked·卡住额度耗尽 / 🔵finished / 默认灰）由仅「开标签那一刻」升级为 20s 轮询实时刷新——宿主 `_multiTabStatusTick()` 仅对「已打开的少量标签」按账号一次 `listRunningSessions` 命中即分类（`devin_cloud.classifySession`），经新 `tabUpdate` 消息回推前端更新状态点。
  - **有对话显示对话名**：轮询命中活跃会话即回填对话标题（替代「账号名 · sid8」回退），与手机端一致。
  - **金额移到左侧 + 指示灯左置**：标签 DOM 由 `[点][#号][名][$额]` 改为 `[点][$额][#号][名]`，金额与状态灯同处最左。
  - **标签宽度砍半**：`.tab` max-width 250px→160px、gap/padding 收窄，便于多页并联；`.lbl` 加 `flex:1;min-width:0` 保证省略号截断。
  - **状态通知**：标签转入「卡住/额度耗尽」或「待输入」时前端 toast 提醒（对齐手机消息通知）。
  - 状态字符串→类名归一：前端 `_dotCls` 与宿主 `_classStr` 同构，兼容原始 status 串与已分类 statusClass。持久化标签新增 `statusClass`。
  - 自检：`node --check`（rt-flow 源 + vendored）、render_check、rt-flow 测试 115 全过、rtflow 源↔vendored 逐字一致。仅改 `core/rt-flow/extension.js`（+ re-vendor）。

## 3.50.39
- **归一补全 · `pc_ui_tree` + `pc_activate` 回归(59 工具全量·与知识库文档逐字对齐·大成若缺其用不敝)**。
  - 3.50.37 大升级时 `pc_*` 仅补到 13(drag/key_combo/clipboard),漏掉线上既有的 `pc_ui_tree`(整机窗口 UI Automation 控件树·name/type/aid/坐标)与 `pc_activate`(SW_RESTORE+SetForegroundWindow 按 title/pid 前置窗口)两件,致 `/mcp` 由 59 退化为 57、与「DAO Bridge MCP 使用文档」所载 15 个 `pc_*` 不符。本次按线上 3.50.33 实现原样归位:PowerShell 脚本以 base64 内嵌(`PC_UIA_TREE_PS_B64`/`PC_ACTIVATE_PS_B64`·规避 JS 字面量转义),经 `daoWriteB64Script` 自写 `~/.dao` + `daoRunPwshFile`(execFileSync `-File`)同步执行。
  - 复得 `pc_*`=15、四模块合计 `/mcp`=59,恒与知识库文档/`tools/list` 一致。
  - 自检: `node --check`(src+out)、dao-vsix 构建、render_check、rt-flow 测试(115+35)全过、rtflow 源↔vendored 一致、内嵌 base64 构建后解码回 1841/1627 字节合法 PowerShell。

## 3.50.38
- **MCP 知识库归一 · 与内穿同源的「实时反向注入 + 断线零人工自愈」(闻道者日损)**。
  - **MCP 使用文档(第三篇知识)精简 + 软编码**: `bridgeGenerateMcpUsageMd()` 重写——
工具表不再硬编码,改由 `daoMcpToolDefs()` 按前缀(`pc_`/`browser_`/`plugin_`/`vscode_`)
**实时归组自生成**(数量/名称恒与实际 `/mcp` 一致·为变所适·永不走样);删去过时的 `vm_*`
虚列;补上与内穿文档同源的「断线零人工自愈」配方(端点死→重读本条目拿当前可达 `/mcp`);
正文「本机」行实时回显 主机/工作区/插件版本/工具数。最小描述撬动最大能力。
  - **实时反向注入随状态刷新**: `bridgeCurrentSig()` 签名扩入「主机 / 工作区名 / 根目录
/ 插件版本 / 工具数」(不含易变时间戳·杜绝无谓 churn) → 设备/IDE/工具集/版本任一变化即翻
签名,存活探测环每跳(≤30s)以签名守柔重注(`liveness-state`),`onDidChangeWorkspaceFolders`
即时触发——令 MCP/内穿两篇知识恒随用户各设备与 IDE 整体状态实时刷新,你每次连上读到的都是最新。
  - 自检: `node --check`(src+out)、dao-vsix/dao-one 构建、render_check、rt-flow 测试全过、
rtflow 源↔vendored 一致。

## 3.50.37
- **核心 MCP 板块大升级 · 浏览器模块对齐 Playwright/Chrome-DevTools-MCP(把插件当浏览器用·与「我操作自己浏览器」对等)**。`browser_*` 由原 5 工具(launch/navigate/eval/screenshot/targets)扩为完整一套(CDP 原生·零 npm 依赖): `browser_snapshot`(页内注入 `__daoB` 助手·产可交互元素「无障碍快照」带 `ref`·Playwright 杀手锏)、`browser_click/type/hover/select/press_key/scroll/drag`(走 CDP `Input.*` **可信输入事件**·ref|selector|x,y|nx,ny 多种定位)、`browser_wait`(selector 出现/消失|text|ms)、`browser_back/forward/reload`、`browser_get_text/get_html`、`browser_console/network`(页内 console+fetch/XHR 钩子缓冲)、`browser_tabs`(list/new/select/close)、`browser_upload`(`DOM.setFileInputFiles`)、`browser_close`。
- **软件本体「公开所有端口」**: 新增 `plugin_api`(直通任意 `/api/*`·route 必以 /api/ 开头) + `plugin_reload`(热修·须 `{confirm:true}` 才重启窗口)。
- **VSCode 对等**: `vscode_open`(打开+定位 line/char) + `vscode_active`(读活动编辑器/选区/可见范围/选中文本)。
- **整机对等**: `pc_drag`(归一化拖拽) + `pc_key_combo`(组合键·依次按下逆序抬起) + `pc_clipboard`(`vscode.env.clipboard` 读写)。
- 全部新增工具委托既有内部处理器/`vscode` API/CDP, 不引重依赖(大巧若拙)。自检: `node --check`(src+out)、dao-vsix/dao-one 构建、render_check、rt-flow 测试全过、rtflow 源↔vendored 一致。

## 3.50.36
- **公网「诡异网页」/shell 路由官网对话掉登录之根治(踩坑 6 · webapp_host=null 漏改)**。实测从公网隧道打开 `…/?dao_acct=<号>` 的 `/sessions` 已登录正常,但进 `/org/<slug>` 即**硬跳真站 `app.devin.ai/login?next=…&internal_org=…`**逃出隧道→掉登录。CDP 抓包定位: Devin SPA 引导调 `/api/users/post-auth` 返回 `"webapp_host":null`,SPA(`useEnterprisePrimaryOrgNavigation`)据此**回落默认主机 app.devin.ai** 做组织跳转。同源反代的 `webapp_host` 改写正则**仅匹配带引号字符串值**(`"webapp_host":"…"`),**漏改 `null`** → 保留 null → SPA 逃逸。
  - **修法**: 把 `webapp_host`/`webappHost` 的改写正则扩为同时匹配字符串值与 `null` 字面量,一并归一为本次请求 Host(隧道域/localhost 自适应)。落地三处: `src/extension.ts`(HTML 内联引导态 + JSON API 响应 `devinCloudProxyRoute`)、`core/rt-flow/devin_proxy.js`(IDE 内多实例反代)及其 vendored 副本 `core/dao-vsix/rtflow/devin_proxy.js`。
  - 验证: 改后公网 `/org/<slug>?dao_acct=<活号>` 不再跨主机硬跳,留在隧道同源渲染官网对话。自检: rt-flow 35 PASS、node --check 通过、dao-vsix/dao-one 构建通过、render_check 通过、rtflow vendored 内容一致(忽略既有 CRLF)。

## 3.50.35
- **正本清源 · 四大模块综合 MCP 入本源(原为运行时外科追加, 今永驻 src)**。`/mcp`(Streamable HTTP·JSON-RPC)端点 + 31 工具(`pc_*`/`browser_*`/`plugin_*`/`vscode_*`)此前仅以运行时 payload(`~/.dao/mcp-deploy/apply-mcp.js` 外科追加进 `out/extension.js`)存在 —— **一经重建即丢**。现整段(`daoMcpHandle`/`daoMcpProcessRpc`/`daoMcpCallTool`/`daoMcpToolDefs` + 零依赖原生 WebSocket CDP 客户端 `daoCdpBatch` + `daoCdpEnsureChrome`/`daoCdpPickPage`)落入 `src/extension.ts`，并在 `handleRouteInternal` 顶部(先于 `needAuth`/`isAppProxyPassthrough`)接管 `/mcp`，杜绝被当作官网 SPA 透传。
  - **修 `plugin_git` 404(根因)**: 旧版无 `/api/git/status` 路由 → MCP `plugin_git` 经 `daoMcpInvoke` 落空透传上游 → uvicorn 404。现 `plugin_git` 自给自足:先试 `/api/git/status`(vscode.git API),不可用即回退 `daoGitStatusViaCli()`——`childProcess` 直跑 `git`(workspace 根)解析 porcelain(分支/staged/changes/untracked/ahead/behind/冲突),不依赖路由是否存在或 git 扩展是否激活。
  - 整机 GUI 控制底座(`pcGui*` worker + `getMirrorPageHtml`)本就在源;本次只补缺失的 MCP 层。自检: `node build.js` + `node --check` 通过、dao-one 构建通过、render_check 通过、rt-flow 35 PASS、rtflow vendored 逐字节一致。

## 3.50.34
- **反者道之动 · 重锚本源(去芜投屏 + 深化同源 SPA 反代)**。整机投屏(`/m`·`/api/cap`·`/api/input`·常驻 PowerShell GUI worker + rt-flow `devinMirror` CDP 截帧兜底)是「搬像素」的歧路:重资产/渲染仍留本机,隧道搬重像素流。本源应为「仿手机集团」——真·渲染与重资产全跑在公网访问者自己的浏览器里, 隧道只搬轻量认证数据与资源(知其雄·守其雌)。
  - **去芜**: 删 extension.ts 全部整机投屏代码;删 rt-flow `devin_mirror.js`(源+vendored)、`extension.js` 四个 `/__mirror/*` 路由、`devin_cloud.js` 的 `buildMirrorHtml`/对话视图「🖥️ 官网本体」入口、`dao-one/build.js` vendor 清单条目;删 4 个 mirror 单测。rt-flow PASS 115+35。
  - **深化(根缺口)**: `devinCloudProxyRoute` 的 `localBase` **恒钉 `http://localhost:<port>`** —— 经公网隧道访问时, SPA 内所有绝对回链(资源/重定向/认证桥 `needAuthHdr`/fetch+XHR 鉴权匹配)全指向访问者本机 localhost(不可达)→ 资源加载失败 / 逃逸至 app.devin.ai/auth/login。**这正是当年要投屏兜底的真因**。
  - **归一**: `localBase` 随访问者来源动态生成 —— `x-forwarded-host`(cloudflared/中继必置)→ `host` 头 → 皆缺回落 `ws.publicUrl`;本地(localhost/127.0.0.1/::1)仍回链 localhost(原行为不变), 公网则回链同源公网域(访问者浏览器自身可达)。静态资源缓存键并入 `localBase` 分桶, 杜绝公网改写版污染本地访问(或反之)。3xx 重定向亦随 `localBase` 改写。
  - 构建护栏 `daoDropBridgeJs` 解析通过(4132 chars);rt-flow 源↔vendored 逐字节一致。

## 3.50.26
- **闭合「内穿自愈环」的消费端(云端 Agent 不再依赖用户重发 URL)**。根因:发布端早已闭环(`bridgeLivenessTick` 每 30s 探活,死则刷新隧道并经 `reinjectBridgeToAllAccounts` 把新 URL 反向注入回知识条目「DAO Bridge 内网穿透文档」);唯一缺口是**消费端**——云端 Agent 旧 URL 打不通时去问用户,而不是**重读这条会被自动改写的知识条目**。
  - `bridgeGenerateCloudMd()` 新增「⚡ 云端 Agent · 断线零人工自愈」配方段(随每次反向注入持久写入知识条目):健康探测 5xx/超时/DNS 失败 = 隧道已轮换 → 不问用户,重读本知识条目(插件 ≤30s 自动改写为新 URL)→ 仍旧则每 30s 重读、最多约 5 分钟接管。整条「自动识别→自动刷新→自动反注入本库→云端重读本库」链路闭合,零人工。
  - 纯文档生成段新增,不触隧道/服务逻辑;构建护栏 `daoDropBridgeJs` 解析通过、rt-flow 119 PASS。

## 3.50.25
- **根治两个拖拽上传(下载文件 / 近期对话内容 → 网页上传框)**。根因:外壳 `#convdrop` 覆盖层(`pointer-events:auto`·`inset:0`)拦截**对话拖拽**的 drop 后走 `reopen`(在网页打开)分支,从不上传;下载文件拖拽则**无外壳落点**、仅靠跨源 iframe 原生 DnD 投递,在 VS Code webview 跨源子帧里不稳。两者都没真正把内容喂进页面上传框。
  - **改为「外壳同源接住 drop → postMessage 命令内嵌桥执行上传」**:外壳(父文档)对对话卡/下载卡的 drop 100% 可靠接住(同文档),落点即 `postMessage({__daoUpload})` 给当前账号标签的 iframe;内嵌桥(`daoDropBridgeJs`)新增 `message` 监听 → `fetch` 同源 `/__convmd`|`/__dlfile` 取字节 → `feed()` 穿透 shadowDOM 喂入上传框。**不再依赖跨 iframe 原生 DnD**,两类拖拽走同一条稳路。
  - 对话拖拽语义从「在网页打开」改为「上传该对话 MD」;「在网页打开」由卡片上 🌐进入 按钮(`data-act=enter`)承担,各司其职。下载卡仍保留 `file://`/`DownloadURL`(可拖到其它应用),仅在落到本外壳网页区时改走上传。
  - 构建护栏:`daoDropBridgeJs` `new Function()` 实解析通过(4132 chars);rt-flow 119 PASS。

## 3.50.24
- **反注(MCP)归一 — 弃第二条脆弱隧道,蹭入常驻桥自愈主隧道**。根因:综合 MCP(`mcp_http.py` · 本机 9100)由 `start_mcp_stack.ps1` 自起**第二条** Cloudflare 快速隧道,既翻倍触发限流(1015/429)又**死不自愈**(常见 `mcp_public.json` 里 `url=null`),致账号里注入的 MCP 地址指向死端点。
  - **常驻桥(dao-bridge)新增 `/mcp` 透明流式反代**:`/mcp`(及子路径)双向 `pipe` 到本机 `127.0.0.1:<mcp_port>`(缺省 9100),不收 body 不改写(保全 Streamable-HTTP/SSE),原样透传 `Authorization` 由 MCP 服务端自行鉴权(桥层不要求 master token,与旧独立隧道同源安全模型)。
  - **dao-vsix 注入地址归一**:新增 `daoResolveMcpEndpoint()` — 优先把注入 URL 定为 `<常驻桥URL>/mcp`(token 取 MCP 服务端令牌);仅当桥 URL 暂不可知时回退沿用 MCP 自身隧道地址。`bridgeCurrentSig()` 与 MCP 使用文档(KB)同步走此解析,随桥 URL 轮换自动重注。
  - **`start_mcp_stack.ps1` 默认不再自起隧道**(`-OwnTunnel`/`MCP_OWN_TUNNEL` 可回退),并顺手收掉历史遗留的 `:9100` 快速隧道,真正收敛为单隧道。

## 3.50.23
- **修复 3.50.22 引入的致命语法错误**: `feed()` 外层 `try{` 缺少配套 `catch` → 整段拖拽桥 `daoDropBridgeJs` IIFE 报 `Uncaught SyntaxError: Missing catch or finally after try`,**整个拖拽桥从不执行**(`window.__daoDropBridge` 永不置位、`document` 级 drop/dragover 监听从不注册)→ 用户侧「拖拽完全没用」。
  - **定位**: live CDP 实测代理会话页 → 注入 HTML 含桥脚本但 `window.__daoDropBridge=false`;`Log.entryAdded` 捕获 `Uncaught SyntaxError: Missing catch or finally after try`;源码 `feed()` 字符串大括号 16 开/15 合、`try` 4 个仅 3 个 `catch`。`node --check` 检不出(桥代码是字符串字面量,仅浏览器运行时解析)。
  - **修**: `feed()` 外层 `try` 补 `}catch(e0){return false;}`(大括号 17/17、try/catch 4/4);新增构建期校验 —— 抽取 `daoDropBridgeJs()` 拼接串 `new Function()` 实解析,杜绝桥 JS 字符串语法错误再次蒙混过关。

## 3.50.22
- 根治「拖拽对话/文件到官网 → 提示『未找到上传框』(拖拽没用)」(拖拽桥 `daoDropBridgeJs` `feed()`)。
  - **真因(经 live 桥在用户机 CDP 实测)**: 拖拽桥已正确触发(捕获合成 drop、解析 `application/x-dao-conv`、命中 `/__convmd` 拉取会话 MD),但 Devin 的 `input[type=file]` 与编辑器组件挂在 **shadow root** 内;原 `feed()` 用 `document.querySelectorAll('input[type=file]')` **不穿透 shadow DOM** → 顶层查到 0 个 → 无法注入 → 弹「未找到上传框」。实测仅穿透时可见 `deepFileInputs=1, deepEditors=1`。
  - **修**: 新增 `deepCollect(sel)` 递归遍历所有 `shadowRoot` 收集匹配元素;`feed()` 改用 `deepCollect('input[type=file]')` 写入 `.files` 并派发 `input`/`change`;无文件输入时回退到 `deepCollect('textarea,[contenteditable=true]')` 的真实编辑器目标,依次派发 `dragenter`/`dragover`/`drop` 合成事件。一处定义(`/__daobridge.js` 与 `devinCloudProxyRoute` 内联同源),全平台(浏览器/手机/IDE)拖拽落地一致。

## 3.50.21
- 根治「IDE 内官网路由慢」(同源反代 `devinCloudProxyRoute` + 客户端 Service Worker)。
  - **真因(经 live 桥定位·读代码实证)**: IDE 内打开官网的真实热路径是主口 9920 同源反代 `devinCloudProxyRoute`(`/sessions|/org…?dao_acct=`),它只注入 authBridge+拖拽桥, **无 Service Worker**。而 VS Code webview 的 iframe **不持久化 HTTP 磁盘缓存**(即便资源带 `immutable`),故每次重载/切标/导航都向 9920 重取数百个哈希分片(本仓库 SPA 入口 ~469 chunk)→ 慢。3.50/PR#541 的 SW 只加在 rt-flow 端口模式,**从未覆盖这条热路径**,所以用户侧依旧慢。
  - **修**: `devinCloudProxyRoute` 注入页内**同源 SW 注册**(scope `/`),主口新增 `/__dao_sw.js` 路由直出 SW(`Service-Worker-Allowed: /`)。SW cache-first **仅缓存同源哈希不可变静态资产**(.js/.css/字体/图等),跳过 `/api/`、`/__` 桥与 SW、所有 HTML/导航(无扩展名不匹配)→ HTML/登录态/接口恒走网络不缓存;资产首载落 CacheStorage(webview 中持久),之后跨导航/重载**零代理零上游往返**,媲美真浏览器磁盘缓存。
  - 等价于把 PR#541 的客户端缓存补到 IDE 真正在用的同源反代上;无 SW 支持的环境特性检测降级=零回归。新部署=新哈希=新 URL=自然 cache-miss 取新,旧条目自然孤立。

## 3.50.20
- 根治「站内浏览器/搜索引擎 被墙站(google 等)打不开 → 只能搜不能用」(`genericWebProxy` `/__web`)。
  - **真因(经 live 桥在用户机实测定位)**: 用户在国内, 本机常驻 Clash(`127.0.0.1:7890`)。实测 `curl google via 7890 → 200/1.6s`、`google 直连 → 黑洞超时(000/12s+)`、`bing 直连 → 302/0.3s`。但 `genericWebProxy` 先**直连**、仅在直连失败后**串行**回退代理, 且回退窗口被夹在 `14s(socket)→18s(hardTimer)` 间太窄 → 被墙站直连黑洞耗尽 18s 直接误判「此页打不开」, 代理赛道根本来不及。
  - **修(并行赛道)**: 检出本机代理时, 「直连」与「经本机 Clash/V2Ray CONNECT 隧道」**两路同时取, 谁先成谁用**。国内站直连即刻命中; 被墙站直连黑洞而代理 1~2s 返回 → 不再误判。等价于让站内浏览器与系统浏览器同走代理路由。`hardTimer` 放宽到 22s 作纯兜底。
  - 既有 3xx 重定向跟随、下载登记、注入改写、HTTP(非代理回退)路径不变; 无代理的机器行为不变(直连失败即错误页)。

## 3.50.19
- 修「webview 面板的对话备份拖到代理网页不上传」: 拖拽上传桥(`/__daobridge.js`)读 `application/x-dao-conv{email,sid}`, 但面板的 `bkConvDragStart` 仅发 `application/json{type:dao-conv,devinId}`/`uri-list`(那是给「拖到路由/编辑器打开」用的) → **mime 不匹配**, 桥识别不了 → 上传无反应。
  - 修: `bkConvDragStart` **追加**发 `application/x-dao-conv{email,sid:devinId,title}`(与 `/shell` 一致); 保留原有 json/uri-list 不变 → 拖到路由=打开会话、拖到代理网页=上传该会话 MD, 两不相干。
  - (`/shell` 统一外壳的对话备份 `daowin` / 下载窗 `dlwin` 拖源本就发正确 mime, 不动。)

## 3.50.18
- 改进「站内浏览器/搜索引擎多层页面点进去」(`genericWebProxy` `/__web` 代理): 此前仅拦 `<a href>` 点击与 GET 表单, **JS 驱动的整页跳转(`location.assign`/`location.replace`·搜索结果常用)未拦** → 套娃第二/三层页直跳真站致掉登录/空白。
  - 包裹 `window.location.assign`/`replace` 经同源 `/__web` 代理(对齐官网反代既有 `__fix` 双保险); `_nav` 用**原始** assign 绕开自身改写防自陷; `wrap` 守 `indexOf(P)===0` 防已代理 URL 二次套娃。
  - 点击捕获加 `defaultPrevented`/非左键 守卫, 不抢站点自身处理。
  - 说明(诚实边界): 这解决了服务端渲染站点 + 重定向 + JS 整页跳转的多层点进; 但纯 JS-SPA 结果站(同源 XHR/fetch)与反爬站点需更底层的「路径式反代 + Service Worker(整browser塞进单页)」架构, 列为后续。

## 3.50.17
- 根治「三套反向注入(知识库/Playbook/GitHub PAT)完全没跑通」: 全池反向注入闭环此前**永不收敛**。
  - **真因(经 live 桥实测 `~/.dao/dao-pool-reconcile.log` 定位)**: `devinBatchInject` 对账号池**全串行**(每号 10~20 次云端 API 串行: 登录+清旧+注准则/桥/Secret+全档案+回读校验), 实测 **144 账号 ~90-100 分钟/轮**。后果两层:
    - 单进程内: 该 ~90 分钟批跑期间, 所有 watch/periodic 触发恒 `skip=inflight`, 闭环空转;
    - 跨进程: 用户测试时频繁重启窗口(每 ~50 分钟), 每次重启杀掉在跑的批 → 永远跑不到 `DONE`(日志可见最近 7 个 `RUN` 无一 `DONE`)。
  - **修一·有界并发**: `devinBatchInject` 由全串行改**有界并发池**(默认 6·`dao.batchInjectConcurrency` 可调 1~12·守柔防 429), 冷启全池 ~96 分 → ~12-16 分。
  - **修二·期望态签名快路**(`~/.dao/dao-inject-sig.json`): 每 org 缓存「期望态(token/桥URL/准则/桥MD/用户档案 K-P-S-MCP-Automation-额度)内容哈希」; 缓存 sig==当前期望 sig 即「已收敛」, 经一次廉价 GET 验证缓存 auth 仍活后跳过其余全部上行写入。**稳态核对 = 全池各一次 GET, 秒级完成**; 唯期望态变(改档案/桥URL轮换/换token)方触发重注收敛。
  - **修三·inflight 看门狗**: `reconcileAccountPoolInject` 的 `_poolReconcileInflight` 由纯布尔改**带运行令牌(start 时戳)的时限守卫**(上限 20 分); 旧轮僵死超时即弃之、新轮接管(旧轮若复活, 其 finally 持旧令牌不误清新轮) → 杜绝「挂死令 finally 永不执行 → 永久 `skip=inflight` → 全盘瘫痪」。
  - 量(quota)环与隧道存活环经 live `~/.dao/dao-loops.log` 实测**本就正常**(`[tunnel] probe ALIVE`/30s · `[quota] avail→cap`/60s), 本次不动。

## 3.50.0
- MCP 归一化（综合 MCP）：反向注入到账号的「DAO Bridge MCP 使用文档」由「四大模块」升级为**五大模块综合归一 MCP**
  - 配套 `cloud/vm-replica/agent-vm/mcp_http.py`：单端点整合 `pc_*`/`browser_*`/`plugin_*`/`vscode_*`/`vm_*`（Windows 多 RDP）共 72 个工具，不再分而治之
  - `plugin_*`/`vscode_*` 由 2 个工具扩展到覆盖 dao-vsix 工作区/VSCode 全量 API（ls/file/write/edit/search/terminal/git/tools · commands/diagnostics/definitions/references/symbols）
  - 离线校验：`python cloud/vm-replica/agent-vm/test_mcp_http.py`（目录/schema/路由/查询串/截屏图像）全过

## 3.49.0
- 同步 rt-flow v4.25.0（vendored `rtflow/extension.js`）：归一外壳新增**浏览器分屏并排**
  - 标签右键「▣ 与当前页分屏并排」→ 两张子网页左右并排同时显示，中缝可拖拽调比例(15%~85%)；「▣ 退出分屏」复原
  - 高效操作：`Ctrl+W` 关当前标签 · 标签中键点击关闭 · `Ctrl+\` 切换分屏；账号页/六大板块页均可参与分屏

## 3.48.1
- 严重回归修复：六合一中间面板(getDaoCloudMiddlePanelHtml)整面板全白、所有板块点不动
  - 根因：批6「操作电脑本体」rComputer 在反引号模板内的内联脚本里用了 `'\n'`，模板插值时 `\n` 塌缩为真实换行 → 单引号字符串跨行 → 整段内联脚本 SyntaxError → `sw` 等全部未定义 → 点击导航无反应、内容区空白
  - 修复：改为 `'\\n'`(渲染后为合法的 `\n` 转义)
  - 加固 `tools/render_check.js`：括号感知地剥离 `${...}` 插值(支持嵌套花括号)，并新增对 getDaoCloudMiddlePanelHtml 的渲染后语法校验，可在 CI 拦截此类塌缩

## 3.48.0
- 同步 rt-flow v4.24.0（vendored `rtflow/extension.js`）：修复多实例「一直加载中」污染其他页面
  - 根因：全屏加载遮罩 `#spin` 为全局单例，仅由某 iframe load 清除、无超时/error 兜底；一个卡住的标签(官网多实例 iframe 永不 load)会永久盖住整个外壳
  - 修复：每标签独立 loading 态 + load/error/15s 三重兜底 + setActive 切换按目标标签真实状态重算遮罩 → 后台卡住标签不再污染前台

## 3.47.0
- 归一化收口：六大板块新增「🖥️ 操作电脑本体」(getDaoCloudMiddlePanelHtml 增 `computer` solo 板块 + rComputer 客户端 + 宿主 compInfo/compRun/compTerminal/compOpenFile/compReveal 处理)
  - 本机信息 + 运行命令(工作目录内 child_process.exec·回显 stdout/stderr/退出码) + 送入集成终端 + 编辑器打开 + 系统资源管理器定位
  - 把整个软件当浏览器供 MCP/用户驱动本机；与公网穿透板块配合可远端代操作
- 同步 rt-flow v4.23.0（vendored `rtflow/extension.js`）：归一外壳菜单/主页新增「操作电脑本体」板块入口

## 3.46.0
- 同步 rt-flow v4.22.0（vendored `rtflow/extension.js`）：用户脚本/扩展 — 对接 Chrome 扩展体系(content_scripts·非油猴)
  - 用户脚本/扩展管理器(汉堡「🔌 用户脚本 / 扩展」)：新建/编辑/启用停用/删除；导入「解压扩展目录 / .crx / .zip」解析 manifest.json content_scripts
  - 内置最小 ZIP 读取 + .crx(Cr24 v2/v3) 头剥离(零依赖)；content_scripts 按 match 注入宿主自渲染账号页，附 chrome.storage/runtime/GM_addStyle 垫片
  - 设备迁移整包纳入 userScripts

## 3.45.0
- 同步 rt-flow v4.21.0（vendored `rtflow/extension.js`）：对话/备份归一(对照手机端 APK)
  - 拖拽对话进网页(复刻手机端 `startConvDrag`)：近期对话卡/备份卡拖到网页区即在该账号网页中打开此会话(跨账号正确路由·新开标签)
  - 备份页签命名对齐手机端(「备份库」→「备份网页端」)；文件拖放与对话拖拽互不干扰

## 3.44.0
- 同步 rt-flow v4.20.0（vendored `rtflow/extension.js`）：浏览器交互归一(对照 Chrome/Edge)
  - 新建 Devin 标签(汉堡 + 顶部「＋」)改为每次开全新页, 不再跳回已存在账号首页
  - 页内查找 Ctrl+F(浮层·真·页内 `find()`·不外跳)；标签拖拽排序；标签条横向滚轮；标签右键菜单(刷新/复制/系统浏览器/关闭/关闭其他/关闭右侧)

## 3.43.0
- 同步 rt-flow v4.19.0：设备迁移「整包导出/导入」(对照手机端一键导出+注入)
  - 汉堡 → 🛠 页面工具新增整包导出(账号库+书签+历史+已开标签 → `dao-migration-*.json`)与整包导入(合并账号库+还原状态)
  - 新设备装好插件后导入此文件即可恢复

## 3.42.0
- 同步 rt-flow v4.18.0（vendored `rtflow/extension.js`）：
  - 近期对话改逐账号流式增量返回 + 本地缓存秒开（对照手机端 APK），不再等全量阻塞
  - `/shell` 状态续接：持久化已打开标签，重开自动还原（老用户停原网页·新用户落主页）
  - 顶部「＋」新建标签按钮；浏览历史 / 书签收藏多选 + 批量删除 + 清空

## 3.40.0
- 全方位整合：将 main（rt-flow-app/APK 线 v0.34.6–v0.35.5）与 dao-vsix 公网中枢线
  （3.35.0–3.39.0：每窗 relay 直连自愈、下载/备份悬浮窗、/shell 公网公传、官页镜像）
  合并为单一最终版，并补齐"切号面板两个多实例按钮"的底层修复。
- 修复·浏览器多实例按钮（点了没反应）：findBrowserExe 原取首个存在的浏览器，会命中
  LOCALAPPDATA 内损坏的旧 Chrome（ICU 崩溃）→ spawn 即崩、无窗口。新增 daoProbeBrowser()
  以 `--headless=new` 实测可启动才选，跳过损坏者，回退首个存在者，结果缓存；并补 Edge
  友好启动旗标（--disable-sync / --disable-features=Translate,msEdgeWelcomePage,msSync）。
- 修复·IDE 多实例按钮（openRoutedPanel）：命令与 webview 处理器改为先走 tryRtflowMultiInstance
  （rt-flow 同源多实例，无 X-Frame），失败方回退 openRoutedAccountPanel（保留公传反代路径为兜底）；
  openRoutedPanel 并入 noAuthNeeded 白名单。
- 合并冲突·六板菜单 PAGES：保留云端"主·六合一"home 设计，并追加 main 的"💻 切电版/手版"
  toggleMode 项（其处理器已随 main 合入），两线特性皆不失。
- 校验：dao-vsix 构建 + out/extension.js 语法通过；rt-flow 单测 110/0 全绿。

## 3.39.0
- 归一网页公网传输「分层混合」落地（道并行而不相悖）：dao 自渲染为主干，新增
  「投屏兜底」补齐官网 100% 功能（含回信/Automations/Review/Wiki/设置）。
- 实测纠偏：宿主整窗浏览器经 devin_web 注入 auth1（含迁移标志）可**直登官网 SPA**，
  此前「auth1 被 Auth0 挡」实为 iframe 内嵌特有（第三方存储分区/CSP），整窗不受限。
  故续写已有对话 **无需 apk_** —— 经投屏在官网本体内即可原样回信。
- 新增 `core/rt-flow/devin_mirror.js`：宿主真·官网本体的 CDP 截帧（Page.captureScreenshot·
  JPEG）+ 归一化坐标输入回传（Input.dispatch*），自管浏览器生命周期（close 真杀进程，
  防残留占 profile 夺端口）。令牌只在服务端，浏览器只见像素与归一化输入。
- 路由 `/i/<accKey>/`：新增 `/mirror`（投屏视图）、`/__mirror/frame`（截帧）、
  `/__mirror/input`（输入）、`/__mirror/nav`（导航）；对话视图加「🖥️ 官网本体」入口。
  手机/电脑共用同一 `buildMirrorHtml` viewer（同源帧轮询 data: URL + 同源输入 POST）。
- 单测 +5（投屏路由/委托·viewer 同源帧与输入·令牌不下发·防注入·vendor 含 devin_mirror）
  共 108/0 全绿；dao-vsix/dao-one 构建 + render_check 通过；vendor 字节一致。

## 3.38.0
- 归一网公传「dao 自渲染」正解（Auth0 免疫·手机+电脑完全一致）：现版 Devin 官网
  已迁 Auth0/SSO，账号密码登录只得旧 auth1 令牌、官网 SPA 已不收 → 「内嵌官网 SPA +
  注入 auth1_session」对密码池账号根本走不通（IDE 内多实例按钮失效亦同因）。
- `/i/<accKey>/*` 不再反代官网 SPA，改由 dao 用 auth1 调内部 REST API、服务端自渲染
  原生页：根 `/` → 对话列表（buildSessionsListHtml·检索/刷新/新建对话）；
  `/sessions/<id>` → 原生对话视图（getEventStream → buildConversationHtml·四类气泡/
  思考折叠/全文搜索/用户消息定位）；`/__dao/create`(POST) → 新建对话（auth1）。
  令牌只在服务端、绝不下发浏览器；同源前缀不变、多实例隔离不变。
- 手机（APK 网页）与电脑（归一网页）共用同一组原生渲染件，前端/逻辑完全一致。
- 单测 +6（buildSessionsListHtml 链接/计数/状态/空与失败/转义 + 对话视图回链），共 103/0 全绿。
- 注：续写已有对话（sendMessage）需 Devin API Key（apk_·公开 API 不收 auth1），属平台契约
  约束；列表/查看/新建/检索均 auth1 即可，与手机端「备管」一致。

## 3.37.0
- 归一网页公网传输无感设备使用（道并行而不相悖）：`/shell` 经 DAO Bridge 隧道主口
  9920 暴露后，公网手机/电脑浏览器打开「Devin 对话页 / 多实例号页」iframe 不再指向
  `http://localhost:<随机端口>`（绑 127.0.0.1·未隧道暴露·公网 404），改走**同源路径
  前缀** `/i/<accKey>/*` 直达。`_shellResolveOpen` 返回同源相对 URL；rt-flow
  `devin_proxy` 新增前缀模式（rewriteBase=`/i/<accKey>`）：HTML/JS 根绝对引用补前缀、
  运行时 fetch/XHR/EventSource(SSE) 补前缀+鉴权、缓存按基址重定基。
- 同源多实例隔离：同源前缀下所有账号 iframe 共用一 origin，桥接脚本按 accKey 给
  localStorage 加私有命名空间（get/set/remove/clear 全包）→ 各账号互不串号。端口模式
  （IDE 内置浏览器·异 origin 本已隔离）不注入 shim，零回归。
- 仅动传输层（外科手术式），不碰布局/面板渲染；并修复 3.36.0 的 vendor 脱钩
  （面板代码回灌源 `core/rt-flow/`，恢复 源↔打包 一致）。

## 3.36.0
- 下载/备份悬浮窗（复刻手机端 APK daopan.html）：⬇ 按钮打开「☁近期对话 / 🗂备份库」双标签悬浮窗；跨账号近期对话聚合（状态灯+账号编号+查看/进入/⬇MD/📦全部文件）；convView 多标签同时查看多条对话正文（自动抓取 MD、可逐条导出 MD/ZIP）；备份库按账号分组；搜索过滤、toast 提示、可拖拽标题栏。宿主端新增 dlRecent/dlExportMd/dlZip 数据通道（HTTP /shell 与 VS Code webview 两路均接）。
- 主页路由：汉堡菜单「主页」与左上角 🏠 按钮 → 直接打开「六合一」组合板块（含主页在内的全六板侧栏导航）；🔀切号/🌐公网穿透/💬对话备份/💉反向注入/🧩MCP 仍各自独立单板，分而治之并存。

## 3.35.1

**补齐 relay 运行时依赖 `ws`（让 3.35.0 的去中心化真正生效）**

- 致命遗漏：`build.js` 仅用 sucrase 转译（不打包），`connectSingleRelay` 运行时 `require('ws')` 为外部依赖；而 `.vscodeignore` 把 `node_modules/**` 全量排除、打包又用了 `--no-dependencies` → **`ws` 从未随 VSIX 下发** → 安装版 `require('ws')` 直接抛错被 catch → relay 永远连不上（`relay=local`）。这是 dao-vsix 每窗口 relay 长期休眠、最深层的根因之一（与 3.35.0 的「强制走代理」叠加，双保险地掐死了 relay）。
- 修复：`.vscodeignore` 加 `!node_modules/ws` / `!node_modules/ws/**` 例外，把零依赖的 `ws@8.21.0`（约 195KB）随包下发至 `extension/node_modules/ws`，使 `extension/out/extension.js` 的 `require('ws')` 正常解析。3.35.0 的直连兜底 + 本补丁，方使每窗口真正连上各自的 `relay/<session>`。

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
