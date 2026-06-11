# 冷启动 Runbook · 本VM全链路（已替你趟通）

> 把「装 Devin Desktop → 真账号登录 → 构建/安装四插件 VSIX → 编辑器内验证」这条最耗时的冷启动长链路，
> 在全新云 VM（Windows Server 2022 / devinbox）上完整趟通。照此可把数小时压到几十分钟。

## 0. 环境底座
- OS：Windows Server 2022；Home：`C:\Users\Administrator`；Node 20.x + npm 预装；git 就绪。
- 打包 VSIX：优先复用 `dao-vsix/node_modules/.bin/vsce`（新版 `@vscode/vsce`）；旧 vsce 2.15.0 不认 `--skip-license`，勿用。

## 1. 安装 Devin Desktop 3.1.7（必须，勿用 Windsurf 1.13.3）
- 官方下载：devin.ai/download（实际包来自 codeiumdata.com）→ `DevinUserSetup-x64-3.1.7.exe`。
- 安装位置：`%LOCALAPPDATA%\Programs\Devin\Devin.exe`（v3.1.7 / productVersion 1.110.1）。CLI：`devin-desktop`。
- 用户数据：设置 `%APPDATA%\Devin\User\settings.json`；扩展 `%USERPROFILE%\.devin\extensions`（重启不丢）。
- **坑**：装成 Windsurf 1.13.3（内核 1.106.0）→ rt-flow token 注入 + Auth0 登录门全乱。版本必须 3.1.7。

## 2. 登录（三种 token 必须分清）
- `devin-session-token$...`（rt-flow 注入）= 仅 Codeium/AI 后端用；**打 Devin v2 API 返回 403**。
- `auth1`（Devin 五步邮箱登录链）= Devin API（sessions/knowledge/playbook）→ 200。
- `cog_...`（Service User API Key）= Devin v1 API → 200。
- **规则**：仅 `cog_` 前缀走 v1 API，否则一律用 `auth1`。**绝不**拿 Windsurf 的 session-token 去打 Devin API。
- 账号池：账号资源.txt 内 13 个 Devin 账号（email:password）；rt-flow 注入绕过浏览器 OAuth 回跳。
- 手输邮箱时 `@` 常被吞 → 用剪贴板粘贴（`Set-Clipboard` + Ctrl+V）。

## 3. 构建 & 安装四插件 VSIX
```powershell
# 纯 JS 插件直接打包；有 TS 源的先 build
cd <plugin_dir>
node build.js                       # dao-vsix 编译 TS（若适用）
.\node_modules\.bin\vsce package --no-dependencies   # 或复用 dao-vsix 的 vsce
devin-desktop --install-extension <name>-<ver>.vsix --force
devin-desktop --list-extensions     # 验证
```
- 免构建捷径：`00_.../artifacts/` 里有四个最新 VSIX，直接 `--install-extension`。

## 4. 编辑器内验证要点
- proxy-pro：活动栏「本源观照」面板渲染、帛书 SP 注入字数、模式/路由切换提示弹出即「活」。
- dao-vsix：全功能面板 Sessions 拉到真实会话（曾实测 104 条）、内网穿透 board 显示隧道 URL。
- dao-bridge：随 IDE 启动自动起隧道；集成终端 curl 公网 URL 返回 `{status:ok,workspace:...}`；关窗隧道消失（CF 530）。
- LSP「connection to server is erroring」在反代 invert 模式下是**预期现象**（代理拦截出站），与插件无关。

## 5. 141 ↔ 云VM 传输（中继 + base64 无损）
- 141（DESKTOP-MASTER）**无法直连 GitHub**；与云 VM 间走 **workers.dev 中继 + 分块 base64**。
- **核心坑**：经中继 `-CmdFile` 下发的 PowerShell 脚本里，**中文字符串字面量会被破坏**（New-Item 报路径非法）。
  - 解：脚本**只用 ASCII**；要写中文内容的文件，用 `base64(UTF8 bytes)` 内嵌后 `[IO.File]::WriteAllBytes` 落地；
  - 要操作中文命名目录，用 ASCII 前缀通配（如 `00_*`）解析出对象再 `-LiteralPath`，**不要手打中文路径**。
- 大文件：zip → base64 → ~10KB 切片 → 逐片 `Add-Content` 拼到 141 → 解码解压；单次中继 payload 勿超 ~15KB（曾 23KB 触发 agent_timeout）。
- relay 串行：**不要在经 relay 执行的 141 命令里再调 relay**（死锁超时）。
- cloudflared：本 VM 屏蔽 QUIC/UDP，**必须加 `--protocol http2`**（否则 `failed to dial to edge` / CF 1033）；公网访问需带浏览器 UA（否则 CF 1010）。

## 6. 一键脚本
`powershell -ExecutionPolicy Bypass -File .\06_bootstrap.ps1`（环境检查→IDE检查→装四插件→验证）。
