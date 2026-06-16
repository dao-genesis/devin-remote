# dao-vsix · 二合一本源基座

> 本源基座（二合一）：左 **rt-flow 切号视图** + 中 **Devin Cloud 全功能面板** + **本地 HTTP API**（含多账号反向注入）。可单独安装；也是 `dao-one` 大 one 的本源基座。

- **扩展 id**：`dao.dao-vsix`
- **类型**：核心 · 本源基座（二合一）

## 功能

- **rt-flow 切号**：多账号切换器（活动栏视图）。
- **Devin Cloud 全功能面板**：单账号全量仪表盘 —— 额度 / Knowledge / Playbook / Secret / 蓝图 / MCP / 环境 / 自动化，与官网实时读写同步。
- **本地 HTTP API（30+ 端点）**：`app.devin.ai` 路由官网零 GUI 自动登录、SSE 流式直通；多账号反向注入 `POST /api/devin/batch-inject` + `GET /api/devin/batch-inject/status`，并以 `asciiSafeJson()` 根治 Devin 接口对原始 UTF-8 中文请求体「每隔一字截断」的服务端缺陷。

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
