# 冷启动 Runbook · 本VM全链路（已替你趟通）

> 把「装 Devin Desktop → 真账号登录 → 构建/安装四插件 VSIX → 编辑器内验证」这条最耗时的冷启动长链路，
> 在全新云 VM（Windows Server 2022 / devinbox）上完整趟通。照此可把数小时压到几十分钟。

## ⚡ 快速通道（2026-06-11 起，目标 <5 分钟）

**不再需要通过中继逐块读取 141 的 E 盘。** E:\DAO_ARCHIVE 已完整同步到本仓库的 **`archive` 分支**（隐私数据除外，见 .gitignore），新 VM 冷启动只需一条命令：

```powershell
git clone --branch main https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\tools\coldstart.ps1
```

`tools/coldstart.ps1` 自动完成：
1. 通过更新 API `https://windsurf-stable.codeium.com/api/update/win32-x64-user/stable/latest` 解析**最新版** Devin Desktop 安装包 URL → 下载 → `/VERYSILENT` 静默安装（无 GUI 点击）。
2. `git clone --branch archive --single-branch` 拉取 E:\DAO_ARCHIVE 全量镜像（含 `00_*/artifacts/` 预构建 VSIX）。
3. `devin-desktop --install-extension` 批量装全部插件（自动取每个插件最新版本号）。
4. 应用 `devin_user_settings.json` 用户设置，`--list-extensions` 验证。

剩余唯一手动步骤：账号登录（rt-flow 切号；账号池在 141 本地，不入仓库）。

### 141 ↔ GitHub 持续同步
- 141 桌面机**可以直连 GitHub**：走本机 vortex 代理 `http://127.0.0.1:7890`。两个关键坑：
  1. relay agent 环境带 `NO_PROXY=*`，libcurl 会静默绕过 http.proxy → 脚本里必须先 `$env:NO_PROXY=''`；
  2. openssl TLS 后端经代理频繁被重置 → 用 `http.sslBackend=schannel` + 重试循环。
- 同步脚本：`tools/sync-dao-archive.ps1`（双向：fetch+merge 再 commit+push，带重试）；
  `tools/install-sync-task.ps1` 注册计划任务，每 30 分钟自动同步。
- 隐私排除（E:\DAO_ARCHIVE\.gitignore）：`*账资*`、`**/accounts.md`、`**/10_accounts.md`、`**/secrets.json`、cookie/token 扫描结果、`*.pem/*.key/.env`。
- 推送认证：`git remote set-url --push origin https://<PAT>@github.com/...`（注意：**纯 PAT 形式**，`x-access-token:` 前缀会被拒）；141 上 wincredman 坏，需 `credential.helper ''`。

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
- **坑（vsce 交互提示）**：`vsce package` 会就「`*` 激活事件 / 缺 LICENSE / 缺 .vscodeignore」连问三次 `[y/N]`。非交互环境会卡住——要么逐个 `y` 应答，要么加 `--allow-star-activation --allow-missing-repository` 并提供 `.vscodeignore` 以减少提示。
- **改完务必 `node --check extension.js`**，并对**渲染后的 webview 内联脚本**再校验一次（见 §4「webview 两大陷阱」）。

## 4. 编辑器内验证要点
- proxy-pro：活动栏「本源观照」面板渲染、帛书 SP 注入字数、模式/路由切换提示弹出即「活」。
- **③模型路由 数据源**：webview 必须读后端 `http://127.0.0.1:8937/origin/ea/overview`（49 家族归一 + builtin-stub 测试通道置首），**勿**用旧扁平 `/origin/ea/config`+`/origin/model_catalog`（左栏会变扁平列表 + 首项怪名、右栏无测试通道）。

### webview 两大陷阱（v9.9.267 / v9.9.268-269 修复，务必回归）
1. **模板字面量内正则反斜杠折叠**：webview HTML 由反引号模板字符串生成，串内正则的单反斜杠会在插值时被吞——`/^https?:\/\//` 渲染成 `/^https?:///`（语法错误，整段 IIFE 抛错→面板「加载中」不动）。**改用字符类**：`/^https?:[/][/]/`、`/[ ]+/g`（Unicode `\uXXXX` 不受影响，可保留）。
2. **window.confirm/alert/prompt 被 VS Code webview 静默屏蔽**：返回假值、动作静默失效（如双击断线无反应）。**自带弹层**：`_daoConfirm(msg)`(Promise+遮罩+取消/确认)、`_daoToast(msg)`(2.6s 浮层)。三模块面板(getEaConfigHtml)与悬浮面板(getEssenceHtml)**各自**都要定义并替换全部 `confirm()/alert()`。
- 渲染校验法：抽出 `<script>` 块、把 `${...}` 占位、用反引号包裹 `eval` 模拟模板插值（还原 `\uXXXX`/`\/` 折叠），再 `new vm.Script()` 解析（参见 `tools/render_check.js`，可直接 `node tools/render_check.js`）。
- dao-vsix：全功能面板 Sessions 拉到真实会话（曾实测 104 条）、内网穿透 board 显示隧道 URL。
- dao-bridge：随 IDE 启动自动起隧道；集成终端 curl 公网 URL 返回 `{status:ok,workspace:...}`；关窗隧道消失（CF 530）。
- LSP「connection to server is erroring」在反代 invert 模式下是**预期现象**（代理拦截出站），与插件无关。

## 5. 141 ↔ 云VM 传输（中继 + base64 无损）【已被快速通道取代，仅作 fallback】
- ~~141（DESKTOP-MASTER）无法直连 GitHub~~ → **已推翻**：141 走本机 7890 代理可直连 GitHub（见顶部快速通道）。中继 base64 仅在代理失效时作为兜底。
- **核心坑**：经中继 `-CmdFile` 下发的 PowerShell 脚本里，**中文字符串字面量会被破坏**（New-Item 报路径非法）。
  - 解：脚本**只用 ASCII**；要写中文内容的文件，用 `base64(UTF8 bytes)` 内嵌后 `[IO.File]::WriteAllBytes` 落地；
  - 要操作中文命名目录，用 ASCII 前缀通配（如 `00_*`）解析出对象再 `-LiteralPath`，**不要手打中文路径**。
- 大文件：zip → base64 → ~10KB 切片 → 逐片 `Add-Content` 拼到 141 → 解码解压；单次中继 payload 勿超 ~15KB（曾 23KB 触发 agent_timeout）。
- relay 串行：**不要在经 relay 执行的 141 命令里再调 relay**（死锁超时）。
- cloudflared：本 VM 屏蔽 QUIC/UDP，**必须加 `--protocol http2`**（否则 `failed to dial to edge` / CF 1033）；公网访问需带浏览器 UA（否则 CF 1010）。

## 6. 一键脚本
`powershell -ExecutionPolicy Bypass -File .\06_bootstrap.ps1`（环境检查→IDE检查→装四插件→验证）。

## 7. 冷启动本源次序 & 易失文件（反者道之动）
- **次序**：先把 Devin Desktop **装到本 VM**（§1）→ 再做全部配置/登录/装插件（§2-3）→ 再在编辑器内推进验证（§4）。先装后配，无为而无不为。
- **易失目录**：进程重启会清空 `/tmp`（如 `/tmp/devin-recordings/*.mp4` 录屏会丢）。需要留存的产物（录屏、构建件、脚本）一律落到 `C:\Users\Administrator` 或仓库内持久路径，**勿**留在临时目录。
- **后端**：proxy-pro 后端常驻 `127.0.0.1:8937`；重启后需重新拉起。`curl /origin/ea/overview` 应返回 `ok=true`、`official_families.length=49`、`providers=[builtin-stub,deepseek,anthropic,openai]`。
