# rt-flow-app · RT Flow 手机版 (独立 APK · 二合一)

手机端「装扩展」这条路是死胡同 (Chrome/Edge 安卓无扩展、Kiwi 已停更)。本工程把
切号 + 内网穿透 + 网页多实例 做成**一个独立 APK**, 装一个、无 CA、无 VPN、无扩展商店。

## 架构: 薄壳 + JS 引擎

- **原生壳子 (Java, 极薄)**: 只做四件事
  - `RelayService` — 常驻前台服务, 宿主一个无界面 engine WebView 跑 JS 引擎; 息屏/退后台不断线
  - `MainActivity` — 控制台面板 (`panel.html`, file:// WebView, 与引擎共享 localStorage)
  - `TabActivity` — 一个绑定专属账号的 Devin 网页标签 (多实例之一)
  - `BootReceiver` — 开机自启
- **JS 引擎 (assets/engine, 可隔隧道热修)**
  - `relay-app.js` — 出站 WSS 连中继 (与 `addons/dao-relay/worker.js` 同协议、同安全边界)
  - `engine.html` — 账号存储 + 25 RPC dispatch + 管理/热修通道
  - `panel.html` — 切号面板 UI

业务逻辑全在 JS → 装好后可隔着内网穿透隧道 `hotpatch`/`persistModule` 热修, 无需重新打 APK。

## 切号原理 (= 扩展 DNR 的等价物)

Devin 鉴权是 HTTP 头 `Authorization: Bearer <auth1>` + `x-cog-org-id` (非 cookie)。
`TabActivity` 在 `document_start` 注入脚本:
1. iso 隔离垫片: dao 登录态键 `localStorage` 读写改走 `sessionStorage` (各标签天然隔离 → 多实例)
2. 包裹 `fetch` / `XMLHttpRequest`: 给 `app.devin.ai/api/` 请求强制注入鉴权头 → 切号

## 内网穿透安全边界

只暴露浏览器 RPC 白名单; 任何 shell 路由 (`/api/exec` 等) 一律 403。隧道 token 门禁。

## 构建

```bash
cd addons/rt-flow-app
echo "sdk.dir=/path/to/android-sdk" > local.properties
cp conn.json.example app/src/main/assets/engine/conn.json   # 填中继 url/token/session
./gradlew :app:assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

`conn.json` 含 token, **不入仓库** (.gitignore), 仅烘焙进私有发行 APK; 装上即自动出站连中继。

## 已知项 / 后续

- 后台 (服务) 远程驱动 `openAccountTab` 受 Android BAL (Background Activity Launch) 限制;
  面板内 (前台) 点「开标签」不受影响。远程拉起标签计划用 fullScreenIntent / 悬浮窗权限补。
