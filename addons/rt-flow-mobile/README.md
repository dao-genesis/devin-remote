# rt-flow 浏览器版 · 自动切换账号 (Android / Chrome / Edge)

> rt-flow 第五板块「多账号切换」的**浏览器/手机端移植**。无 Devin Desktop / VSCode 依赖，
> 纯 MV3 浏览器扩展，可在桌面 Chrome、Edge，以及 **Android 上的 Kiwi Browser** 运行。
> 道法自然·无为而无不为：账号池 → auth1 → 注入官网自动登录 → 点击「激活」即切号。
> （v1.5.0 起去除自动轮转，改纯手动切号；v1.6.0 起对话下载新增 HTML 视图、对话追踪新增综合健康度。）

## 这是什么

把 IDE 插件 `rt-flow` + `dao-vsix` 的两套底层能力合一，移到浏览器里：

| IDE 插件做的事 | 本扩展的浏览器原生等价 |
|---|---|
| `rt-flow/devin_cloud.js` — email+password → auth1 登录链路 | `src/cloud.js`（纯 `fetch`，service worker 可跑） |
| `rt-flow` 切号引擎 — 账号池 + 额度普查 | `src/background.js`（账号池 + 额度普查 + 手动激活切号·service worker） |
| `dao-vsix` 反代注入 `localStorage['auth1_session']` 自动登录 | `src/content.js`（同源 content script 在 SPA 读取前种入登录态） |
| `dao-vsix` fetch/XHR override 注 `Authorization`/`x-cog-org-id` | `declarativeNetRequest` 动态规则（浏览器原生改请求头） |

## 登录与注入全流程（与 IDE 版同源）

```
email + password
  └─POST windsurf.com/_devin-auth/password/login ─────────► token (= auth1)
       └─POST app.devin.ai/api/users/post-auth (Bearer auth1)─► org_id / user_id
            └─background 缓存 auth (12h) + 设为 active
                 ├─declarativeNetRequest: 给 app.devin.ai/api/* 注入
                 │    Authorization: Bearer <auth1> + x-cog-org-id: <orgId>
                 └─content script(document_start) 在 app.devin.ai 种入:
                      localStorage['auth1_session'] = {token, userId}
                      localStorage['migrated-to-unscoped-auth0-token-2025-12-18']=true
                      localStorage['known-org-ids-<uid>'] = [orgId]
                      localStorage['post-auth-v3-null-<uid>-org_name-<orgName>'] = {...}
                      cookie webapp_logged_in=true
                      → 若晚于 SPA 启动则 reload 一次(有 guard) → 已登录
```

## 切号（手动·v1.5.0 起）

- 额度来源：`GET app.devin.ai/api/{orgId}/billing/status`
  → `balance = available_credits + max(0, overage_credits)`（含 `has_subscription_or_credits` 权威布尔）。
- **切号 = 手动**：点账号「激活」即换号（注入 DNR 鉴权头 + content script 种 `localStorage` 登录态）。v1.5.0 起去除 `chrome.alarms` 自动轮转与看门狗，回归「为者败之·执者失之」的克制。
- content script 探测页面「out of credits / 额度耗尽」文案 → 仅**通知**（`reportExhausted`），不自动切号，由用户决定。
- 对话追踪综合健康度（v1.6.0·与桌面 v4.7.7 `healthScore` 同源）：余额(权40)/卡住(权30)/待输入(权30) → 0-100 分 + 绿/黄/红档，面板顶部「健康 N」徽标实时显示。

## 安装

### 桌面 Chrome / Edge
1. `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本目录 `plugins/rt-flow-mobile/`
3. 工具栏图标打开面板。

### Android（Kiwi Browser）
1. 打包：`bash tools/pack.sh`（产出 `rt-flow-mobile.zip`）。
2. `adb push rt-flow-mobile.zip /sdcard/Download/`
3. Kiwi Browser → `kiwi://extensions` → 开发者模式 → `+ (from .zip/.crx/.user.js)` → 选该 zip。
4. 菜单里出现扩展图标，点开即面板。

> 详细 Android 冷启动 + 实测见 [`docs/ANDROID_TEST.md`](docs/ANDROID_TEST.md)。

## 使用
1. 面板「添加账号」：邮箱 + 密码（+ 可选标签）。可加多个（万法识别支持批量粘贴任意格式）。
2. 点账号的「激活」→ 后台登录拿 auth1 → 注入 → 打开/刷新 `app.devin.ai` 即已登录该账号。
3. 对话「⭳」下载：拉事件流 → **MD + JSON + HTML 三位一体**打包成单个 zip（规避手机浏览器多文件下载拦截）；HTML 为单文件内联样式·零外链，手机浏览器直接打开即看暗色气泡流。知识库/剧本同理打包下载。

## 隐私
- 邮箱/密码/auth1 **只存在本机** `chrome.storage.local`，绝不上送任何第三方。
- 登录与额度请求只发往官方域名 `windsurf.com` / `app.devin.ai`。

## 文件
```
manifest.json        MV3 清单 (storage/cookies/scripting/notifications/declarativeNetRequestWithHostAccess)
src/cloud.js         登录链路 + 额度判定 + 导出(MD/JSON/HTML) + 健康度/终报纯函数 (无依赖, 可单测)
src/background.js    账号引擎 (service worker): 账号池/登录缓存/激活切号/DNR/对话追踪
src/content.js       app.devin.ai 自动登录注入 (document_start)
src/popup.{html,js,css}  控制面板 UI
test/cloud.test.js   纯函数单测 (billingBalance/导出/stallVerdict/healthScore/conversationFinalReport/buildConversationHtml)
test/background.test.js  applyDnr DNR 规则单测 (vm 沙箱 + chrome mock·防额度串号回归)
test/parse.test.js / test/git.test.js  万法识别解析 / Git 状态归类单测
tools/pack.sh        打包成可装载 zip
```

## 状态 · 实测 · 开发接力

> 给下一个 agent：本板块是 ⑤ rt-flow 在浏览器的移植（详见仓库根 README §rt-flow-mobile、`docs/CANON_five-plugins.md` §⑥、`docs/MODULE_STATUS_道全景.md` 模块矩阵）。从这里起手即可接续。

**已完成（实测通过）**
- 源码健康：`node test/cloud.test.js` → 54/54、`node test/background.test.js` → 13/13、`node test/parse.test.js` → 23/23、`node test/git.test.js` → 5/5（共 95）；`node --check src/{cloud,background,content,popup}.js` 全过。
- **v1.6.0 同步桌面成果**：对话下载新增 HTML 视图（1:1 移植 `devin_cloud.js` `buildConversationHtml`·单文件暗色气泡流），对话追踪新增综合健康度（移植 `healthScore`），并补 `stallVerdict`/`conversationFinalReport` 纯函数（与桌面 v4.7.x 同源·全可单测）。
- **安卓真机全链路实测通过**（KVM 加速 Android 模拟器 + Kiwi Browser 侧载，CDP 驱动）：加账号 → 激活（DNR 注入 + 免密登录 `app.devin.ai` 落到该账号 org）→ 额度普查读到各账号**真实且互异**余额 → `rotate` 切到余额最高账号。
- **已修复·额度串号 (cross-account contamination)**：`applyDnr` 的 DNR 规则原先匹配所有 `||app.devin.ai/api/` 请求，连扩展自身 service worker 的 `getBilling` fetch 也被改写成活跃账号的鉴权头 → 普查时每个账号都读成活跃账号余额，`rotate` 评分失真。加 `initiatorDomains:["app.devin.ai"]` 限定为页面发起的请求即解（扩展自身 fetch 不再被改写；页面免密登录注入不受影响）。
- **已修复·userId 取值**：auth1 为不透明令牌（非 JWT）、post-auth 不回传 user_id，故以 `windsurf.com` 登录响应体的 `user_id` 为权威真源（`cloud.js` login 回退链）。
- 桌面 Chrome（与安卓 Kiwi/Edge 同 Chromium 引擎）全流程实测：账号增删、`chrome.storage` 即时渲染、「验证」命中真实 `windsurf.com`（假密码如实回 HTTP 401）、`content.js` 注入 `app.devin.ai` 登录态链路通。
- **已修复 MV3 冷启竞态**：`src/popup.js` 改为 storage-first（渲染直读 `chrome.storage`，不依赖 service worker 是否唤醒），并给面向引擎的 `send` 加超时重试 → 面板不再卡「读取状态失败」。

**待验证 / 续作缺口**
- 可选：`bash tools/pack.sh` 产物挂到 Releases；操作视频可视证据已随 PR 提供。

**接手指引**
- 引擎/消息协议在 `src/background.js`（`getState/addAccount/activate/refreshQuota/rotate/saveSettings/getActiveAuth/reportExhausted`）。
- 加新动作：在 `background.js` 的 `onMessage` switch 里加 case，popup 用带超时重试的 `send({type:...})` 调它；纯展示态变更直接写 `chrome.storage`（storage-first，popup 会经 `chrome.storage.onChanged` 自动刷新）。
- 登录/额度判定纯函数在 `src/cloud.js`（可单测，勿在此引入浏览器全局依赖）。
