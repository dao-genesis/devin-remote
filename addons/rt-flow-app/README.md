# Devin Cloud 手机版 · rt-flow-app (v0.14.4)

> **唯一的手机端方案**。取代了此前的 `rt-flow-mobile`（MV3 浏览器扩展·Kiwi 已停更）
> 和 `dao-bridge-android`（Termux Node Agent）。一个 APK 六合一：切号 + 内网穿透 + 网页多实例 + **浏览器自动化** + **手机本体操控** + **渐进式文档**。
>
> 道法自然 · 无为而无不为

## 功能总览

| 模块 | 说明 |
|------|------|
| **切号面板** (`switch.html`) | 1:1 桌面版面板移植：账号列表 + per-account 展开（Sessions/Knowledge/Playbooks/Secrets/Git）+ 备份管理 + 下载管理 |
| **内网穿透** (`relay-app.js` + `RelayService`) | 出站 WSS 连中继，**动态配置**（首次启动在面板填写 url/token/session，存 localStorage + userFile）；50+ RPC 命令远程驱动 |
| **网页多实例** (`TabActivity`) | 每标签绑定一个账号，`fetch`/`XHR` 注入鉴权头 + `sessionStorage` 隔离登录态 → 多号共存 |
| **浏览器自动化** (`browse*` RPCs) | 远程操控前台 WebView 标签：列举/打开/关闭/导航/执行JS/提取DOM/读Cookie+Storage/截图/导出MD/页内查找 — 不干扰用户正常使用 |
| **手机本体操控** (`phone*` RPCs) | 设备信息+手机号/文件系统读写/相册图片列举/剪贴板读写/系统分享/通知/应用列举+启动/电池/WiFi/振动/音量/联系人/短信(OTP)/通话记录 |
| **系统级接管** (`RtAccessibilityService`) | ADB/scrcpy 级无 root 接管：坐标点击/长按/滑动手势注入 + 返回/主页/最近/通知/锁屏全局操作 + 读屏控件树 + 按文字点击 + 文本输入 + 全屏截图(API30+) |
| **安全开关 + 一键授权** (tunnel.html) | 远程操控默认关闭，穿透面板手动启用；browse*/phone* 全部受此门禁。系统级接管走 `phoneEnsureControl` 一键自动跳转无障碍设置，用户只点一次「允许」 |
| **渐进式文档** (`getCloudMd`/`getModuleIndex`/`getModuleDoc`/`getLocalMd`) | 三层披露：云端 MD = 轻量「初始接入」(接入信息 + 三大核心板块概览 + 一键授权)；Agent 按需 `getModuleDoc({module})` 深入某板块拉全部细节；`getLocalMd` = 重型本地操控全表 |
| **文件上传** | `onShowFileChooser` → 系统选择器（含微信/QQ 最近文件） |
| **系统下载** | `DownloadManager` → 下载目录 + 通知 |
| **多窗口** | `onCreateWindow` → 新标签承接 `window.open` / `target=_blank` |
| **热修** | JS 引擎可隔中继 `hotpatch` / `persistModule` / `reloadEngine`，无需重装 APK |

## 架构: 薄壳 + JS 引擎 + IPC 桥

```
app/src/main/java/ai/devin/rtflow/
├── MainActivity.java     控制台 (switch.html + 多标签浏览器)
│   ├── Browser bridge    N.openAccountTab / clip / conn / relayStatus / relayRestart / saveRelayConfig / toast ...
│   └── IPC 桥            sInstance 静态引用 → ipcListTabs / ipcExecJs / ipcNavigate / ipcScreenshot /
│                          ipcGetCookies / ipcListFiles / ipcReadFile / ipcListPhotos / ipcDeviceInfo ...
├── TabActivity.java      绑定账号的 Devin 网页标签 (多实例)
├── RelayService.java     常驻前台服务 + engine WebView (relay-app.js)
│   ├── Bridge            N.getConn (动态优先) / httpReq / writeFile / readFile / openTab ...
│   ├── 远程操控 IPC      browseListTabs / browseExecJs / browseNavigate / browseScreenshot / browseGetCookies ...
│   ├── 手机操控          phoneDeviceInfo / phoneListFiles / phoneReadFile / phoneListPhotos / phoneClipboard ...
│   └── 安全开关          remoteOpsEnabled · setRemoteOps / isRemoteOpsEnabled
├── HttpBridge.java       原生 HTTP (无 CORS) — 登录/额度/Cloud API 底座
├── RtAccessibilityService.java  系统级接管 (sInstance) → tap/swipe/longPress/globalAction/dumpScreen/clickText/inputText/takeScreenshot
└── BootReceiver.java     开机自启

app/src/main/assets/engine/
├── relay-app.js          出站 WSS 连中继 (同 dao-relay Worker 协议)
├── engine.html           账号存储 + 50+ RPC dispatch + 浏览器自动化 + 手机操控 + 渐进式文档 + 管理/热修通道
├── switch.html           切号面板 UI (1:1 桌面版移植 + 手机适配)
├── tunnel.html           穿透配置 + 远程操控安全开关
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
| v0.7.0 | 真正 1:1 桌面面板移植 + per-account 展开 + 穿透动态配置 + 化简(去DW/去sw) + 备份管理 + 下载管理 |
| v0.13.6 | 布局修复 + 12 项浏览器功能 (前进/后退/桌面UA/无痕/标签概览/下载管理/阅读模式/广告拦截等) |
| v0.14.0 | 浏览器自动化 (browse* 11 RPCs) + 手机本体操控 (phone* 10 RPCs) + IPC 桥 + 安全开关 + 渐进式文档系统 |
| v0.14.1 | 高级浏览器自动化 (browse* +8: 点击/填表/等待元素/提交/提取链接+输入/页面信息/滚动) + 高级手机操控 (phone* +4: 电池/WiFi/振动/音量) + getCloudMd/getLocalMd 完整 API 文档 RPC |
| v0.14.2 | 敏感数据读取 (phone* +5: 联系人/短信收件箱(含OTP)/通话记录 + 运行时权限申请/查询) — 辅助全链路账号注册与验证码读取 |
| v0.14.3 | ADB/scrcpy 级系统级接管 (AccessibilityService, 无需 root)：phone* +10 — 手势注入(点击/长按/滑动) + 全局操作(返回/主页/最近/通知/锁屏) + 读屏(控件树) + 按文字点击 + 文本输入 + 全屏截图(takeScreenshot) |
| v0.14.4 | 重新锚定本源 — 全仓统一命名 Devin Cloud 手机版 (清除 RT Flow 残留) + 渐进式文档系统重构 (云端轻量接入/三大核心板块概览·getModuleDoc 深入/本地重型) + 一键授权 `phoneEnsureControl` (穿透面板「⚡ 一键授权系统级接管」按钮·自动跳转·用户只点允许) + 远程开关在浏览器壳同步生效 + Node mock-Native 测试台 (32 断言全过) |
| v0.14.5 | 真机全链路实测修复 — 后台标签 `autoHost` 常驻停泊 (满屏·INVISIBLE·保持挂载窗口与尺寸)，修复 `browseExecJs`/`browseGetDom`/`browseScreenshot` 对后台标签失效 (detached WebView 不触发 JS 回调、0 尺寸截不到图) 的真机 bug + `browseExecJs` 守卫式 wait/notify 防丢唤醒 + `ipcScreenshot` 0 尺寸兜底 (按屏幕强制测量布局)。经中继真机实测: 文档系统/软件本体(getState/listSessions 真实API)/手机本体(phoneInfo/Battery)/一键授权全部验证通过 |
| v0.14.6 | 系统级接管真机实测修复 — `accessibility_config.xml` 补 `android:canTakeScreenshot="true"`，修复 `phoneScreenCapture` 抛 `SecurityException: Services don't have the capability of taking the screenshot`。经中继真机实测无障碍闭环: `phoneDumpScreen` 读屏控件树(45/92节点) + `phoneGlobalAction home` 手势注入(回主页·再读屏验证生效) 全部通过 |
| v0.14.7 | ① 额度用完显示灰色 `$0`（弱化视觉干扰，不再刺眼红）② 在线自动更新底座 — 冷启动静默检查 `latest.json` 有新版即弹一次确认；新增 `appCheckUpdate`/`appInstallUpdate` RPC，云端经中继可直接推送更新（下载新版 APK + 唤起系统安装器，用户仅点一次「安装」），以后不必再从聊天反复发 APK。新增 `REQUEST_INSTALL_PACKAGES` 权限 + `FileProvider` 安装 Intent |
| v0.14.8 | 穿透稳健性 + 面板改版。① 隧道客户端 `relay-app.js`：连接看门狗（10s 未握手即弃端点重试，治 GFW 致 `CONNECTING` 长挂）+ 退避加速（1.5s→20s 封顶）+ **多端点自动故障转移**（`url` 可填多个，逗号/空格/换行分隔，逐个择优连通）+ `/health` 探测把模糊错误细化为可操作诊断（区分「不可达/被屏蔽」与「WSS 握手失败」）。② 穿透面板：「复制URL」「复制Token」合并为「📋 复制接入信息」；4 个云端/本地 MD 文档按钮拉到第一页主页；状态卡显示当前连通端点/重连次数/故障转移端点数 |
| v0.14.9 | **当前版本**：降低用户三大成本（操作/认知/使用）。① **去除网页下拉刷新**（`SwipeRefreshLayout` 拦截顶部下拉导致 Devin 对话页无法正常上下滑动）；刷新统一走右上角刷新按钮 `reloadActive`。② **自动更新自动弹「允许安装未知应用」**：未授权时 `canRequestPackageInstalls()` 检测 → 弹清晰说明 → 自动跳到本应用开关页（`package:` URI 直达，避免在长列表里找不到）→ 用户开开关返回 App，`onResume` **自动续装**（零再触发）。③ **国内连不上直接提示开 VPN**：`probeHealth` 诊断文案改为「请开启 VPN/科学上网后重连」，不再让用户困惑 |

## 取代的旧模块

- ~~`addons/rt-flow-mobile/`~~ — MV3 浏览器扩展 (Kiwi Browser 已停更，Chrome/Edge 安卓无扩展)
- ~~`addons/dao-bridge-android/`~~ — Termux Node Agent (rt-flow-app 内置 RelayService 完全替代)

这两个目录已从仓库移除。手机端以本 APK 为唯一方案。
