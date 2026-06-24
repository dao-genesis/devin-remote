# Changelog · dao-vsix（二合一插件）

道法自然 · 无为而无不为。仅记录与「内网穿透 / dao-bridge / 知识库反向注入」相关的关键变更。

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
