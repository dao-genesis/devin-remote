# Devin Cloud 手机版 · rt-flow-app (v0.7.0)

> **唯一的手机端方案**。取代了此前的 `rt-flow-mobile`（MV3 浏览器扩展·Kiwi 已停更）
> 和 `dao-bridge-android`（Termux Node Agent）。一个 APK 三合一：切号 + 内网穿透 + 网页多实例。
>
> 道法自然 · 无为而无不为

## 功能总览

| 模块 | 说明 |
|------|------|
| **切号面板** (`switch.html`) | 1:1 桌面 RT Flow 面板移植：账号列表 + per-account 展开（Sessions/Knowledge/Playbooks/Secrets/Git）+ 备份管理 + 下载管理 |
| **内网穿透** (`relay-app.js` + `RelayService`) | 出站 WSS 连中继，**动态配置**（首次启动在面板填写 url/token/session，存 localStorage + userFile）；50+ RPC 命令远程驱动 |
| **网页多实例** (`TabActivity`) | 每标签绑定一个账号，`fetch`/`XHR` 注入鉴权头 + `sessionStorage` 隔离登录态 → 多号共存 |
| **文件上传** | `onShowFileChooser` → 系统选择器（含微信/QQ 最近文件） |
| **系统下载** | `DownloadManager` → 下载目录 + 通知 |
| **多窗口** | `onCreateWindow` → 新标签承接 `window.open` / `target=_blank` |
| **热修** | JS 引擎可隔中继 `hotpatch` / `persistModule` / `reloadEngine`，无需重装 APK |

## 架构: 薄壳 + JS 引擎

```
app/src/main/java/ai/devin/rtflow/
├── MainActivity.java     控制台 (switch.html + 多标签浏览器)
│   └── Browser bridge    N.openAccountTab / clip / conn / relayStatus / relayRestart / saveRelayConfig / toast ...
├── TabActivity.java      绑定账号的 Devin 网页标签 (多实例)
├── RelayService.java     常驻前台服务 + engine WebView (relay-app.js)
│   └── Bridge            N.getConn (动态优先) / httpReq / writeFile / readFile / openTab ...
├── HttpBridge.java       原生 HTTP (无 CORS) — 登录/额度/Cloud API 底座
└── BootReceiver.java     开机自启

app/src/main/assets/engine/
├── relay-app.js          出站 WSS 连中继 (同 dao-relay Worker 协议)
├── engine.html           账号存储 + 50 RPC dispatch + 管理/热修通道
├── switch.html           切号面板 UI (1:1 桌面 RT Flow 移植 + 手机适配)
├── devin-core.js         登录链路 (email+password → auth1)
├── devin-cloud.js        Devin Cloud 全功能 CRUD API
├── rtflow-parse.js       万法识号 v2.7 (任意格式→结构化账号)
└── conn.json             中继配置兜底 (动态配置优先)
```

## 切号面板 (switch.html) — v0.7.0

**化简后的手机适配**（去芜存精）：
- **去掉** DW 额度条、手动切号按钮 ⚡ — 整行点击即切号（多实例注入浏览器直接打开）
- **突出** 编号 (20px/800wt) + 账号名 (13px/600wt/高亮白色)
- **按钮 flex-wrap**：竖屏放不下时自动折到第二行（28px 触摸目标）
- 每行保留：☁▾展开 / 🔄刷额度(或🔑登录) / 📋复制 / 🌊清理 / ×删除

**Per-account 展开面板** (☁▾)：
- 异步并发拉取 `DaoCloud.listSessions / listKnowledge / listPlaybooks / listSecrets / checkGit`
- Sessions 列表（状态 badge: 运行/待输入/卡住/完成/空闲 + 归档按钮）
- 知识库/剧本/密钥 board（点统计展开 → 查看/删除）
- Git 连接概要 + PAT 注入
- 底部操作：备份 / 发起对话 / 水过无痕

**备份管理**：映射 dao-vsix 备份面板，按账号分组显示对话索引，可查看/清空。

**下载管理**：右下角悬浮窗，追踪 app 内下载记录。

## 内网穿透 (动态配置)

**不再固定 conn.json**。三层优先级：
1. `localStorage("rtflow.relay")` — 用户在切号面板填写
2. `readUserFile("relay-config.json")` — 原生文件持久化
3. `conn.json` asset — 兜底

首次启动：面板「穿透配置」区自动展开 → 填入 URL/Token/Session → 保存 → 自动连接。
每个用户/设备独立配置，不同用户不同数据。

## 切号原理 (= 桌面扩展 DNR 的等价物)

Devin 鉴权是 HTTP 头 `Authorization: Bearer <auth1>` + `x-cog-org-id`（非 cookie）。
`TabActivity` 在 `document_start` 注入脚本：
1. iso 隔离垫片：dao 登录态键 `localStorage` 读写改走 `sessionStorage`（各标签天然隔离 → 多实例）
2. 包裹 `fetch` / `XMLHttpRequest`：给 `app.devin.ai/api/` 请求强制注入鉴权头 → 切号

## 构建

```bash
cd addons/rt-flow-app
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew assembleRelease
# 产物: app/build/outputs/apk/release/app-release.apk
```

穿透配置由用户首次启动时在 UI 填写，无需预配 `conn.json`。

## 历史演进

| 版本 | 要点 |
|------|------|
| v0.4.0 | 初版：基础切号 + 固定 conn.json 穿透 |
| v0.5.0 | 补文件上传 / 多窗口 / 下载 / 改名「Devin Cloud 手机版」 |
| v0.6.0 | 面板从根上重做（尝试 1:1 但不完整） |
| v0.7.0 | **当前版本**：真正 1:1 桌面面板移植 + per-account 展开 + 穿透动态配置 + 化简(去DW/去sw) + 备份管理 + 下载管理 |

## 取代的旧模块

- ~~`addons/rt-flow-mobile/`~~ — MV3 浏览器扩展 (Kiwi Browser 已停更，Chrome/Edge 安卓无扩展)
- ~~`addons/dao-bridge-android/`~~ — Termux Node Agent (rt-flow-app 内置 RelayService 完全替代)

这两个目录已从仓库移除。手机端以本 APK 为唯一方案。
