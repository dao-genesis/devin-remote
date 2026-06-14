# rt-flow 浏览器版 · 自动切换账号 (Android / Chrome / Edge)

> rt-flow 第五板块「多账号切换」的**浏览器/手机端移植**。无 Devin Desktop / VSCode 依赖，
> 纯 MV3 浏览器扩展，可在桌面 Chrome、Edge，以及 **Android 上的 Kiwi Browser** 运行。
> 道法自然·无为而无不为：账号池 → auth1 → 注入官网自动登录 → 额度耗尽自动切换。

## 这是什么

把 IDE 插件 `rt-flow` + `dao-vsix` 的两套底层能力合一，移到浏览器里：

| IDE 插件做的事 | 本扩展的浏览器原生等价 |
|---|---|
| `rt-flow/devin_cloud.js` — email+password → auth1 登录链路 | `src/cloud.js`（纯 `fetch`，service worker 可跑） |
| `rt-flow` 切号引擎 — 评分 + rotate + 看门狗 | `src/background.js`（额度普查 + 评分 + `chrome.alarms` 轮询） |
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

## 自动切换（rotate）

- 额度来源：`GET app.devin.ai/api/{orgId}/billing/status`
  → `balance = available_credits + max(0, overage_credits)`（含 `has_subscription_or_credits` 权威布尔）。
- `chrome.alarms` 周期轮询活跃账号：余额 ≤ **缓冲(默认 $3)** → 自动 `rotate()` 到评分最优账号（软耗尽轮转·知止不殆）。
- content script 探测页面「out of credits / 额度耗尽」文案 → 主动上报 → 立即轮转（硬耗尽）。
- 评分：余额越高越优；登录失败的账号不参与。

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
1. 面板「添加账号」：邮箱 + 密码（+ 可选标签）。可加多个。
2. 点账号的「激活」→ 后台登录拿 auth1 → 注入 → 打开/刷新 `app.devin.ai` 即已登录该账号。
3. 「立即切到最优」手动轮转；开「额度耗尽自动切换」后无需管，余额见底自动换号。

## 隐私
- 邮箱/密码/auth1 **只存在本机** `chrome.storage.local`，绝不上送任何第三方。
- 登录与额度请求只发往官方域名 `windsurf.com` / `app.devin.ai`。

## 文件
```
manifest.json        MV3 清单 (storage/alarms/cookies/scripting/declarativeNetRequestWithHostAccess)
src/cloud.js         登录链路 + 额度判定 (无依赖, 可单测)
src/background.js    切号引擎 (service worker): 账号池/登录缓存/评分/rotate/DNR/alarms
src/content.js       app.devin.ai 自动登录注入 (document_start)
src/popup.{html,js,css}  控制面板 UI
test/cloud.test.js   纯函数单测 (billingBalance / decodeJwtUserId / 评分)
tools/pack.sh        打包成可装载 zip
```

## 状态 · 实测 · 开发接力

> 给下一个 agent：本板块是 ⑤ rt-flow 在浏览器的移植（详见仓库根 README §rt-flow-mobile、`docs/CANON_five-plugins.md` §⑥、`docs/MODULE_STATUS_道全景.md` 模块矩阵）。从这里起手即可接续。

**已完成（实测通过）**
- 源码健康：`node test/cloud.test.js` → 12/12；`node --check src/{cloud,background,content,popup}.js` 全过。
- 桌面 Chrome（与安卓 Kiwi/Edge 同 Chromium 引擎）全流程实测：账号增删、`chrome.storage` 即时渲染、「验证」命中真实 `windsurf.com`（假密码如实回 HTTP 401）、`content.js` 注入 `app.devin.ai` 登录态链路通。
- **已修复 MV3 冷启竞态**：`src/popup.js` 改为 storage-first（渲染直读 `chrome.storage`，不依赖 service worker 是否唤醒），并给面向引擎的 `send` 加超时重试 → 面板不再卡「读取状态失败」。

**待验证 / 续作缺口**
- **安卓真机侧载**：未在本会话验证 —— 构建 VM 为 Windows Server，嵌套虚拟化未透传 VT-x（无法跑加速 Android 模拟器）。扩展按标准 MV3 构建，按上文「Android（Kiwi Browser）」步骤可直接侧载；官方加速模拟器需 Linux 蓝图（`system-images;android-34;x86_64` + KVM）。
- 可选：`bash tools/pack.sh` 产物挂到 Releases；录一段桌面/真机操作视频作可视证据（与根 README 其它板块的视频体例一致）。

**接手指引**
- 引擎/消息协议在 `src/background.js`（`getState/addAccount/activate/refreshQuota/rotate/saveSettings/getActiveAuth/reportExhausted`）。
- 加新动作：在 `background.js` 的 `onMessage` switch 里加 case，popup 用带超时重试的 `send({type:...})` 调它；纯展示态变更直接写 `chrome.storage`（storage-first，popup 会经 `chrome.storage.onChanged` 自动刷新）。
- 登录/额度判定纯函数在 `src/cloud.js`（可单测，勿在此引入浏览器全局依赖）。
