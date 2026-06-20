# dao-vsix · 二合一本源基座

> 本源基座（二合一）：左 **rt-flow 切号视图** + 中 **Devin Cloud 全功能面板** + **本地 HTTP API**（含多账号反向注入）。可单独安装；也是 `dao-one` 大 one 的本源基座。

- **扩展 id**：`dao.dao-vsix`
- **类型**：核心 · 本源基座（二合一）

## 功能

- **rt-flow 切号**：多账号切换器（活动栏视图）。
- **Devin Cloud 全功能面板**：单账号全量仪表盘 —— 额度 / Knowledge / Playbook / Secret / 蓝图 / MCP / 环境 / 自动化，与官网实时读写同步。
- **本地 HTTP API（30+ 端点）**：`app.devin.ai` 路由官网零 GUI 自动登录、SSE 流式直通；多账号反向注入 `POST /api/devin/batch-inject` + `GET /api/devin/batch-inject/status`，并以 `asciiSafeJson()` 根治 Devin 接口对原始 UTF-8 中文请求体「每隔一字截断」的服务端缺陷。

## 六大板块 · 分而治之 · 网页套网页

「Devin Cloud 全功能面板」逻辑上由**六大板块**组成，各板块各开一张**独立子网页**（而非挤在一个面板里靠内部 tab 切换）：

| board key | 图标 | 名称 |
|---|---|---|
| `overview` | 🏠 | 主页 / 单账号管理 |
| `switch`   | 🔀 | 切号 / 账号池 |
| `bridge`   | 🌐 | 公网穿透 · DAO Bridge |
| `backups`  | 💬 | 对话备份 |
| `inject`   | 💉 | 反向注入 · 全账号 |
| `mcp`      | 🧩 | MCP 服务器 |

承载它的是统一外壳 `/shell`（归一 Devin Cloud 网页），本质是**浏览器套浏览器**：外壳带一个标签栏，每个板块 / 每个多实例账号页都是其中一张**平级并排**的标签（各自一个 iframe 子网页）。在 IDE 插件 webview 里能操作的，在任意外部浏览器或经 dao-bridge 隧道打开 `/shell` 也能操作。

**实现**：`getDaoCloudMiddlePanelHtml(st, soloBoard?)` 在 `soloBoard` 传入某 board key 时进入**单板块模式**——只渲染该板块并用 `body.solo .sb{display:none}` 隐藏左侧导航；`setCloudProvider({buildHtml:(board?)=>...})` 把 board 透传给宿主。统一外壳消费端在 `core/rt-flow/extension.js`（`BOARDS` 注册表 + `mountBoardSolo()`）。

> ⚠️ dao-vsix 运行时副本被捆绑在 `core/dao-vsix/rtflow/`。改了 `core/rt-flow/*` 后**必须重新 vendor** 同步过来，否则独立版跑旧代码。校验：`diff -q core/rt-flow/extension.js core/dao-vsix/rtflow/extension.js`。

更多本源认知与防踩坑见仓库根 [`AGENTS.md`](../../AGENTS.md)。

## 构建

```bash
cd core/dao-vsix
npm install
node build.js                       # 转译 TS → out/
node ../../tools/pack-vsix.js .      # 或 npx @vscode/vsce package --allow-missing-repository --skip-license
```

## 安装

```bash
devin-desktop --install-extension dao-vsix-<ver>.vsix --force   # 或 code --install-extension ...
```

下载见仓库 [Releases](https://github.com/zhouyoukang1234-spec/devin-remote/releases)（tag 形如 `dao-vsix-v<版本>`）。

> 去中心化：本模块独立发版，开发它才会刷新 `dao-vsix-v*` Release，与其它插件互不干扰。
