# rt-flow-mobile · 浏览器版自动切号 · 道法自然

> 太上，下知有之 · 用户无为 · 插件无不为
>
> 把 ⑤ `rt-flow`（IDE 内 Cascade 自动切号）与 ① `dao-vsix`（浏览器页面自动注入账号）合一，
> 落到一个 **Chromium MV3 扩展**：在 `app.devin.ai` 浏览器版里多账号零 GUI 自动登录 + 余额监控 + 自动切到下一健康号。
> 可装在**安卓** Chromium 浏览器（Kiwi / Edge / Yandex）与**桌面** Chrome / Edge。

---

## 一句话流程

```text
账号池(email password) → 后台登录拿 auth1 → localStorage 注入自动登录
        ↑                                          ↓
   用户无为                          余额 ≤ 停止阈值 → 自动切到余额最高的下一号
```

---

## 底层原理（与正典同源）

两条链路移植自仓库现有实现，语义完全一致：

1. **登录拿 auth1**（移植 `plugins/rt-flow/devin_cloud.js`）
   - `POST windsurf.com/_devin-auth/password/login {email,password}` → `token`(=auth1) + `user_id`
   - `POST app.devin.ai/api/users/post-auth` (Bearer auth1) → `org_id` / `org_name`
   - `GET app.devin.ai/api/{org_id}/billing/status` (Bearer auth1) → 实时余额(USD)

2. **浏览器页面自动注入登录**（移植 `plugins/dao-vsix/src/extension.ts:5766` 的 auth bridge）
   - 经真机抓取确认：Devin SPA 登录态唯一真源是 `localStorage['auth1_session'] = {token,userId}`
   - `content.js` 在 `document_start` 写入该键 + org 相关键 + `post-auth-v3-*` 守卫键 + cookie `webapp_logged_in=true`
   - **换 auth1 即换号** → 切号 = 写新 active + 重载标签页

> 与 dao-vsix 的差别：dao-vsix 因为在 IDE 里要绕 `X-Frame-Options` 用了**本地反向代理 + 改写 HTML + 劫持 fetch 注入 header**；
> 浏览器扩展直接跑在 `app.devin.ai` 真实域上，**无需代理**——SPA 自己读 `localStorage` 后会自带 `Authorization` 发请求。大道甚夷。

---

## 切号决策（`core/score.js` · 纯函数 · 可单测）

移植自 `rt-flow` 的 `_scoreOf` / `computeConvCap` / `lowBalanceVerdict`，浏览器版以 **USD 余额**为主轴：

| 层级 | 条件 | 分值 |
|------|------|------|
| 永禁 | 无密码 / `skipAutoSwitch` 锁 / 余额 ≤ 停止阈值(真耗尽) | `-Infinity` |
| 未验 | 未取到余额 | `100` |
| 已验 | 余额 USD ×100 + staleMin 微调 | `1 ~ 999900` |
| 锁中降权 | 当前正使用号 ×0.01（防来回震荡） | — |

`shouldSwitch`：当前号**耗尽**或**被锁** 且 存在更优候选 → 切到 `pickBestIndex`。无健康候选则**不切**（不臆造成功）。

---

## 安装

### 桌面 Chrome / Edge
1. `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `plugins/rt-flow-mobile/`

### 安卓（Kiwi Browser，唯一稳定支持 Chrome 扩展的安卓浏览器）
1. 安卓装 [Kiwi Browser](https://kiwibrowser.com/)
2. 把本目录打成 zip（或仓库 zip），Kiwi → ⋮ → Extensions → 开发者模式 → 「+ (from .zip)」选本目录
3. 也可用 Edge Canary / Yandex（机制相同）

> iOS / 原版 Chrome for Android 不支持扩展，故移动端走 Kiwi/Edge Chromium 系。

---

## 使用

1. 点扩展图标 → 「＋ 添加账号」→ 粘贴 `email password`（每行一个，任意格式可解析）
2. 「↻ 验证全部」→ 登录拿余额、评分排序
3. 「用此号」手动切；或开启自动切号——后台按余额轮询，当前号余额 ≤ 停止阈值即自动切到余额最高的下一号
4. 打开 `https://app.devin.ai` → 已是当前账号登录态（零 GUI）

### 设置（`core` 默认值）

| 项 | 默认 | 说明 |
|----|------|------|
| `stopThreshold` | `$3` | 余额 ≤ 此值视为耗尽 → 切走 / 不进候选 |
| `buffer` | `$3` | 每对话使用额度上限缓冲（`cap = 余额 − buffer`） |
| `pollActiveSec` | `30s` | 低余额时提速轮询 |
| `pollIdleMin` | `30min` | 空闲降速轮询 |
| `lowBalanceWarn` | `$5` | 跌破一次只提醒一次（回升后复位） |

---

## 测试

```bash
node test/unit.test.js     # 26 例 · 零依赖 · 覆盖评分/候选/切号/余额上限/低额预警/billing 解析
```

---

## 文件

```
rt-flow-mobile/
├── manifest.json          # MV3
├── background.js          # service worker · 账号池 + 登录 + 余额监控 + 切号引擎 + alarms
├── content.js             # document_start · localStorage 注入自动登录 (移植 dao-vsix auth bridge)
├── popup.html / popup.js  # 移动端友好面板 · 账号列表/余额/手动切号/锁/删
├── core/
│   ├── score.js           # 纯函数评分 (移植 rt-flow _scoreOf/computeConvCap/lowBalanceVerdict)
│   └── devin_cloud.js     # fetch 版登录/余额 (移植 rt-flow devin_cloud.js)
├── icons/                 # 零依赖生成的图标 + gen_icons.js
└── test/unit.test.js      # 零依赖单测
```

> 安全：账号 email/password 仅存 `chrome.storage.local`（本机），auth1 仅注入 `app.devin.ai` 同源 localStorage。不上传任何第三方。
