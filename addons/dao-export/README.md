# DAO Devin Export — 道法自然

将 Devin AI 官网的 Session 板块完整路由到 VS Code 内部，并整合**多账号管理（万法识号）**与**单对话整段导出 MD**。跨 IDE（所有 VS Code 类编辑器）、跨平台（Windows / macOS / Linux）通用。

## 功能

### 多账号管理 · 万法识号
- **任意格式批量识别**: 侧边栏粘贴任意格式账号文本，一键批量入库。支持：
  - `email password` / `email:pass` / `email----pass` / `email|pass` / 逗号·分号·制表符分隔
  - 中英标签：`邮箱：x 密码：y` / `Email: x Password: y`（含数字编号 `卡号1: / 卡密1:`）
  - 卡号卡密、微信发货消息（自动剥离噪声/广告/订单模板行）
  - JSON：单行 `{"email","password"}` 或整段 `[{...},...]` 数组
  - Token 直登：`devin-session-token$…` / `auth1_…` / JWT / 60+ 位 base64
  - 顺逆皆通（密码在前/邮箱在前），重复自动跳过
- **多账号操作**: 一键切号（切号后即显示该号 sessions）、单个/批量验号、删除、清空
- **兼容迁移**: 旧版单账号登录态自动迁移为首个账号

### 单对话导出
- **导出单文件 MD（新）**: 每个 session 旁 `⬇ MD` —— 把整段 session 对话导出为**一个独立 `.md` 文件**（元数据 + 完整对话流 + 变更列表 + 折叠 worklog），无需文件夹，其他 Agent 直接喂、导流更快。命令 `DAO: Export Session as MD`，批量 `DAO: Export ALL Sessions as MD`
- **导出全量 ZIP**: 每个 session 旁 `⬇ ZIP`，导出底层之底层全部数据：
  - `session_info.json` / `events.json` / `worklog.md`
  - `cloud_files/` — 所有云端产出文件实际内容（presigned URL 下载）
  - `changes/` — 全部改动文件的最终状态（保留目录结构）
  - `EXPORT_MANIFEST.json` — 导出清单
- **批量导出**: `DAO: Export ALL Sessions` 一次导出当前账号全部 sessions

### Session 详情
点击 session 打开详情面板（概览 / 对话 / Worklog / Changes / 原始数据），顶部可直接 `⬇ 导出 MD` 或 `⬇ 导出 ZIP`。

### Agent Bridge（本地 HTTP API）
插件运行即在 `127.0.0.1` 起一个带 token 的本地 HTTP 接口层，任意 Agent 可直接调用全部功能（含多账号、单对话 MD）。用命令 `DAO: Export Agent Bridge Doc (MD)` 或侧边栏「📄 接入MD」导出实时接入文档。关键端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts` | 多账号列表（脱敏） |
| POST | `/api/accounts` | 万法识号批量加号 `{"text":"…"}` |
| POST | `/api/accounts/verify-all` | 批量验证 |
| POST | `/api/account/{id}/activate` | 切号 |
| GET | `/api/session/{id}/conversation` | 整段对话单文件 Markdown |
| POST | `/api/session/{id}/export-md` | 导出整段对话 MD 到磁盘 |
| POST | `/api/session/{id}/export` | 导出全量 ZIP 到磁盘 |

## 安装

```
code --install-extension dao-devin-export-1.4.1.vsix
```

## 使用

1. 点击左侧活动栏的 DAO Devin 图标
2. 在「万法识号」文本框粘贴任意格式账号（可多行批量），点「添加账号」
3. 点「批量验证」或单号「切换/验证」；切号后下方显示该号 sessions
4. 点 `⬇ MD` 导出整段对话单文件，或 `⬇ ZIP` 导出全部底层数据

## 技术

- 零运行时依赖（纯 Node stdlib：https + zlib 自实现 ZIP；万法识号纯字符串解析）
- API: windsurf.com 登录 / token 直登 → app.devin.ai sessions/events/presigned-url
- 账号保存在 VS Code globalState（脱敏视图用于 UI / Bridge，不外泄密码/token）

无为而无不为 道法自然
