# 人启动 · 冷启动板块（5+2+1 之「1」）

> *为之于其未有也，治之于其未乱也。* —— 把最耗时的冷启动长链路一次趟通，让初始环境中的
> Devin AI（与你同源）几十分钟内完成配置部署，进入实际开发。

核心逻辑只有一条：

```
① 装 Devin Desktop      更新 API 解析最新版 → 静默安装（无 GUI 点击）
② rt-flow 底层秒登账号   注入 token，绕过浏览器 OAuth 回跳，初始化第一个账号
③ 装 5 个插件 VSIX       devin-desktop --install-extension  plugins/*/*.vsix
④ 进入实际开发           按 CANON 五插件各司其职
```

一键脚本：[`tools/coldstart.ps1`](../tools/coldstart.ps1) —— 自动完成 ①③④，账号登录（②）按设计是交互/注入步骤。

```powershell
git clone https://github.com/zhouyoukang1234-spec/devin-remote.git $env:USERPROFILE\repos\devin-remote
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\repos\devin-remote\tools\coldstart.ps1
```

---

## 0. 环境底座
- OS：Windows Server 2022；Home：`C:\Users\Administrator`；预装 Node 20.x + npm；git 就绪。
- 打包 VSIX：优先复用 `@vscode/vsce`（新版）；旧 vsce 2.15.0 不认 `--skip-license`，勿用。

## 1. 装 Devin Desktop（必须 3.1.7+，勿用 Windsurf 1.13.3）
- 版本解析：`GET https://windsurf-stable.codeium.com/api/update/win32-x64-user/stable/latest` → `.url` 取安装包。
- 静默安装：`/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /MERGETASKS=!runcode`。
- 安装位置：`%LOCALAPPDATA%\Programs\Devin\Devin.exe`；CLI：`%LOCALAPPDATA%\Programs\Devin\bin\devin-desktop.cmd`。
- 用户数据：设置 `%APPDATA%\Devin\User\settings.json`；扩展 `%USERPROFILE%\.devin\extensions`（重启不丢）。
- **坑**：误装成 Windsurf 1.13.3（内核 1.106.0）→ rt-flow token 注入 + Auth0 登录门全乱。版本必须 3.1.7+。

## 2. rt-flow 底层秒登第一个账号 · 三类 token 必须分清
rt-flow 的 `plugins/rt-flow/devin_cloud.js` 用「邮箱+密码 → auth1」五步登录链直接拿到可用凭证，**绕过浏览器 OAuth 回跳**，是冷启动最快的登录路径。

| token | 来源 | 能打什么 |
|-------|------|----------|
| `auth1` | Devin 五步邮箱登录链（rt-flow） | Devin API（sessions/knowledge/playbook）→ 200 |
| `cog_...` | Service User API Key | Devin v1 API → 200 |
| `devin-session-token$...` | rt-flow 注入 IDE | **仅** Codeium/AI 后端；打 Devin v2 API 返回 403 |

- **规则**：仅 `cog_` 前缀走 v1 API，否则一律用 `auth1`。**绝不**拿 Windsurf 的 session-token 去打 Devin API。
- 账号池在本地（不入仓库）；手输邮箱时 `@` 常被吞 → 用剪贴板粘贴（`Set-Clipboard` + Ctrl+V）。

## 3. 装 5 个插件 VSIX
```powershell
# 纯 JS 插件直接打包；有 TS 源的先 build
cd <plugin_dir>
node build.js                                       # dao-one 装配 vendor-* + 折 Proxy Pro / dao-vsix 编译 TS（若适用）
npx @vscode/vsce package --no-dependencies --allow-missing-repository
devin-desktop --install-extension <name>-<ver>.vsix --force
devin-desktop --list-extensions                     # 验证
```
- 免构建捷径：仓库 `plugins/*/*.vsix` 已是各插件最新版，`coldstart.ps1` 直接逐个 `--install-extension`。
- **坑（vsce 交互提示）**：`vsce package` 会就「`*` 激活事件 / 缺 LICENSE / 缺 .vscodeignore」连问；非交互环境加 `--allow-star-activation --allow-missing-repository` 并提供 `.vscodeignore`。
- **改完务必 `node --check extension.js`**，并对**渲染后的 webview 内联脚本**再校验一次（见下「webview 两大陷阱」）。

## 4. 编辑器内验证要点
- **proxy-pro**：活动栏「本源观照」面板渲染、帛书 SP 注入字数、模式/路由切换提示弹出即「活」。③模型路由数据源必须读 `http://127.0.0.1:8937/origin/ea/overview`（49 家族归一 + builtin-stub 测试通道置首），勿用旧扁平 `/origin/ea/config`+`/origin/model_catalog`。
- **dao-one（大 one）**：全功能面板 Sessions 拉到真实会话、**Proxy Pro 三面板子模块文字浅色可读可操作**（非黑字）、内网穿透 board 显示隧道 URL。
- **dao-bridge**：随 IDE 启动自动起隧道；集成终端 curl 公网 URL 返回 `{status:ok,workspace:...}`；关窗隧道消失（CF 530）。
- **rt-flow**：登录账号后批量备份 12/12 快照、一键 wipe 前后对比（用户数据清零、本源默认保留）。
- LSP「connection to server is erroring」在反代 invert 模式下是**预期现象**（代理拦截出站），与插件无关。

### webview 两大陷阱（务必回归）
1. **模板字面量内正则反斜杠折叠**：webview HTML 由反引号模板生成，串内正则单反斜杠插值时被吞——`/^https?:\/\//` 渲染成 `/^https?:///`（语法错误→整段 IIFE 抛错→面板「加载中」不动）。**改用字符类**：`/^https?:[/][/]/`、`/[ ]+/g`。
2. **window.confirm/alert/prompt 被 VS Code webview 静默屏蔽**：返回假值、动作静默失效。**自带弹层**：`_daoConfirm`(Promise+遮罩)、`_daoToast`(浮层)；每个 webview（三模块面板与悬浮面板）各自都要定义并替换全部 `confirm()/alert()`。
- 渲染校验法：见 [`tools/render_check.js`](../tools/render_check.js)（抽 `<script>` 块模拟模板插值后 `vm.Script` 解析）。

## 5. 经验教训清单（实践到底的沉淀）
- **不臆造成功**：删除/断开类操作必须真号实跑确证返回，404 不等于「已删」（rt-flow 曾揪出三个把 404 当成功的缺陷）。
- **一条失败不毁全局**：批量/并发拉取用逐条重试（allSettled 语义），别用 `Promise.all`（任一抖动即整体丢失）。
- **区分用户数据与本源默认**：wipe 只清用户数据，保留 3 内置知识 + 32 社区剧本。
- **中文路径/字面量坑**：经中继下发的 PowerShell 脚本里中文字面量会被破坏 → 脚本只用 ASCII，中文内容用 `base64(UTF8)` 内嵌后 `[IO.File]::WriteAllBytes` 落地。
- **推送认证**：git 代理对本仓库可能 403（无写权）→ 用 PAT 直推 github.com（**纯 PAT 形式**，`x-access-token:` 前缀会被拒）。若全局 `insteadOf` 把 `https://github.com/` 改写到代理，可直接 push 带 userinfo 的显式 URL `https://x-access-token:<PAT>@github.com/...`（带 userinfo 的前缀不匹配 `insteadOf` 故不被改写）。
- **归一(dao.dao-one)与独立引擎冲突**：归一容器复用并内联四套引擎本体视图（`wam.panel`/`dao.router`/`dao.cloudPanel`/`daoBridgeView`）。VS Code 的 **view/command id 必须全局唯一** —— 若独立引擎（`dao.dao-vsix`/`dao-agi.dao-proxy-pro`/`devaid.rt-flow`/`dao.dao-bridge`）仍各自安装，会抢占同名 id，导致归一里对应板块**静默不渲染**（曾因独立 `dao.dao-bridge` 未卸而 ④内网穿透 整块消失）。`coldstart.ps1` 已在安装后统一卸载这四个内联引擎；改完 dao-one 视图集需 **bump version** 才能让 VS Code 重读 `contributes`（reload 不足时整机重启 Devin 强制重扫）。

> 历史长版 Runbook（含 141 ↔ 云VM 中继兜底等）见 [`docs/RUNBOOK_coldstart.md`](../docs/RUNBOOK_coldstart.md)。
