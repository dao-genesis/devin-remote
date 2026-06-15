# dao-bridge 优化 · 交接清单（给后续 agent）

> 配套阅读：`docs/dao-bridge-底层分析.md`（根因分析与方案，含逐行定位）。
> 本清单把分析结论拆成**可独立执行、可验证**的任务卡，按优先级排列。每张卡写明：改哪里、怎么改、怎么验。
> 全部任务均为**尚未落地**的待办——本次 PR 只交付分析 + 本清单，代码改动后续接手。

---

## 背景速记（接手前必读）

dao-bridge 有两套并存、割裂的穿透实现：

- **实现 A（插件默认在跑）**：`addons/dao-bridge/dao-bridge-ext/extension.js` —— VS Code 插件，跑 cloudflared 子进程。成本最高、最脆弱。
- **实现 B（已验证可用，但未接进插件）**：`addons/dao-bridge/{agent.js,core.js}` —— 纯 Node，本机出站 WSS 连 `dao-relay-do.<sub>.workers.dev` 中继，URL 天然稳定、零账号、无 50MB 二进制。`addons/dao-bridge-android/` 已用这套 core.js 在 Termux/Android 上跑通，**证明 B 是现成可用的**。

核心判断：**最大优化 = 把默认通道从 A 切到 B**，cloudflared 降为可选高级档。这一步同时解决「自动安装中断」「认证成本」「跨平台」三件事。

> 中继 Worker（`dao-relay-do`）源码**不在本仓库**，部署在 zhouyoukang 的 Cloudflare 账户下（README 称可 REST API 一键部署）。接手 P0-治本 前需先拿到/确认 Worker 的 `/connect`(WSS) 与 `/relay/<session>`(POST) 协议契约。

---

## P0 · 治本：把默认通道切到 Worker+DO 中继

**目标**：插件激活后优先用实现 B 出站连中继，拿到稳定 `…workers.dev/relay/<session>` 公网入口；连不上再自动回退 cloudflared（保持现有回退链）。默认行为对「连得上中继」的用户实现零账号、稳定 URL。

**改哪里**
- `extension.js` 的 `Bridge.start()`（`:599`）：在现有 attempts 链最前面插入 `{ mode: "relay" }` 一档。
- 新增 `Bridge._runRelayAttempt()`：移植 `core.js:connectRelay()` 的逻辑（出站 WSS + `request`/`response` 帧转发，复用现有 `WorkspaceServer` 的路由）。
- 公网 URL 设为 `relayUrl/relay/<session>`；`state()`/`writeArtifacts()`/MD 里据此呈现。

**关键约束**
- VS Code 扩展宿主 Node（Electron，约 Node 18）**没有**全局 `WebSocket`，也未默认带 `ws` 依赖。两条路二选一：
  1. **零依赖**：手写最小 RFC6455 客户端（握手用 `crypto` 生成 `Sec-WebSocket-Key`，帧解析 ~100 行），契合本项目「零依赖」风格（参考 rt-flow 的 `devin_cloud.js`）。
  2. **打包 ws**：把 `ws` 加进 dao-bridge-ext 依赖并确保进 VSIX（同时改 `dao-one/build.js` 把 `node_modules/ws` 带进 `vendor-bridge`）。
- 必须**保持向后兼容**：中继不可用时无缝回退 cloudflared，绝不能让现有「能用 quick tunnel」的用户回归。
- `session` 命名：默认主机名，允许 `daoBridge.session` 配置覆盖；与 Android 的 `android-<host>` 命名风格统一。

**怎么验**
- 单测：最小 WS 客户端的握手 + 帧编解码（不依赖真 Worker）。
- 集成：本地起一个假 Worker（Node WS server）模拟 `/connect` + `/relay`，验证 `request→handleRoute→response` 闭环、断线 5s 重连、ping/pong。
- 回归：断网/给错 relayUrl 时，确认自动回退到 cloudflared quick tunnel。

---

## P0 · cloudflared 自动安装健壮化（保留 cloudflared 路径时必做）

**目标**：杜绝「半成品二进制落地后永久卡死」。

**任务卡**
1. **完整性校验**（`extension.js:96 isRealCloudflared` / `:222 downloadCloudflared`）
   - 体积下限（1MB）不够；下载后用 Cloudflare 发布的 `sha256` 校验，或至少 `spawn(bin,["--version"])` 探活成功才算数。
2. **自愈重下**
   - `findCloudflared` 命中文件后做一次 `--version` 探活；**失败即删除并触发重下**（`:613` 当前仅在 `!bin` 时才下载，需改为「探活失败也下载」）。
   - `downloadCloudflared` 复用前（`:225`）同样探活，别再只看体积早退。
3. **断点续传**
   - `httpDownload`（`:161`）带 `Range` 续传 `.part`；按响应 `Content-Length` 校验总长，长度不符即判失败删除。
   - 补 `res.on('error')` 处理（当前 sink 未处理响应流错误）。
4. **残留清理**
   - 启动时清 `~/.dao/bin/*.part*`；`.part` 命名当前用随机 hex（`:163`），统一可预测以便清理。

**怎么验**：用一个会在 ~2MB 处 RST/FIN 截断的本地 mock server，确认：截断文件不被采纳；已落地的损坏文件下次启动被探活剔除并重下；Content-Length 不符被拒。

---

## P0 · macOS 现在 100% 不可用：`.tgz` 不解包

**改哪里**：`extension.js:138 cfAssetName`（darwin 返回 `.tgz`）+ `downloadCloudflared`（`:222`，直接把下载内容当二进制 `chmod +x`）。

**怎么改**：darwin 下载 `.tgz` 后用 Node 解 gzip + tar 取出 `cloudflared` 再 `chmod 0755`；或探测 Homebrew/官方 pkg 安装路径。`tools/fetch-cloudflared.js:81` 当前直接「跳过 darwin」，一并补上。

**怎么验**：在 macOS（或对 darwin 资产做离线解包单测）确认取出的是可执行真二进制且 `--version` 通过。

---

## P1 · 修「自带 cloudflared、离线即用」的断链（让 bundled VSIX 真带二进制）

**根因**：`tools/fetch-cloudflared.js:18` 把二进制写到 **`plugins/dao-bridge/dao-bridge-ext/bin`**——`plugins/` 在重构成 `addons/` 后已不存在。运行时却在 `ctx.extensionPath/bin` 找（`extension.js:112`）。`dao-one/build.js:127` 也只在 `addons/.../bin` 存在时才拷。

**怎么改**：`fetch-cloudflared.js` 的 `BIN_DIR` 改成 `addons/dao-bridge/dao-bridge-ext/bin`；在 `dao-one` 发版流程加断言「`vendor-bridge/bin/cloudflared*` 必须存在」，否则发版失败。

**怎么验**：跑 `node tools/fetch-cloudflared.js windows-amd64` 后确认文件落在 `addons/.../bin`；打 bundled VSIX 后解包确认含 bin。

---

## P1 · 安全红线（与「降低使用成本」直接冲突，必须同批处理）

1. **轮换泄露的 token**：知识库笔记 `DAO Bridge 内网穿透·远程操作文档` 内嵌了 live token + trycloudflare URL，等于公开了该机器的 RCE 凭证 —— **立即轮换**。
2. **MD 默认不内嵌明文 token**：`generateCloudAgentMd/generateLocalAgentMd`（`:836`/`:912`）把 token 写进「设计上要分享」的文档。改为引用 `conn.json` 或下发一次性短时令牌。
3. **`/api/exec` 加约束**：`exec`/`exec-sync`（`:447`/`:453`）是不限工作区的整机任意命令执行，而 `ls/read/write` 受 `withinRoot` 沙箱。提供「只读模式 / 根目录白名单」开关。
4. **`/api/health` 收敛信息**（`:388`，免鉴权泄露 host/platform/workspace）。
5. **CORS `*`**（`:375` 等）叠加在 RCE API 上，评估收紧。
6. 导出 SDK 关闭了 TLS 校验（MD 内 `CERT_NONE`），评估去除或加固。

---

## P2 · 架构收敛与跨平台兜底

1. **统一两套实现的端点契约**：`core.js`（`/api/command` `/api/file`）与 `extension.js`（`/api/exec-sync` 等）端点集不一致，抽出一份共享路由表，消除分裂。
2. **纯 Node agent 作全平台兜底**：插件检测到当前平台无可用 cloudflared 资产时，自动改用 `connectRelay`，覆盖 FreeBSD / 路由器固件 / 容器 / Android(Termux) 等 VS Code 跑不动的环境。
3. **补 FreeBSD 等官方资产**到 `cfAssetName`；无官方二进制的平台直接走中继。

---

## 验收基线（每张卡完成后跑）

- `node --check addons/dao-bridge/dao-bridge-ext/extension.js`
- `node --check addons/dao-bridge/{agent.js,core.js}`
- `node tools/render_check.js`（webview 渲染守卫）
- 若涉及 dao-one：`cd core/dao-one && node build.js && npx @vscode/vsce package --allow-missing-repository --skip-license`，确认 `vendor-bridge/bin` 存在。

*道法自然 · 无为而无不为*
