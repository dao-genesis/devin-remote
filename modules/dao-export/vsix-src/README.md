# DAO Devin Export — 道法自然

将 Devin AI 官网的 Session 板块完整路由到 VS Code 内部。

## 功能

- **登录**: 仅需 Devin AI 邮箱 + 密码（侧边栏直接输入，或命令 `DAO: Login to Devin`）
- **Session 列表**: 同步官网全部 sessions（标题、状态、时间、PR 数），支持搜索过滤
- **Session 详情**: 点击 session 打开详情面板，包含 5 个标签页：
  - 概览（统计 + 完整元数据）
  - 对话（用户/Devin 消息流 + 命令 + 文件编辑事件）
  - Worklog（完整可读工作日志）
  - Changes（最终变更文件列表）
  - 原始数据（完整事件流 JSON）
- **一键导出 ZIP**: 每个 session 旁的 `⬇ ZIP` 按钮，导出底层之底层全部数据：
  - `session_info.json` — 完整 session 元数据
  - `events.json` — 完整事件流（去重合并）
  - `worklog.md` — 可读工作日志
  - `cloud_files/` — 所有云端产出文件实际内容（presigned URL 下载）
  - `changes/` — 全部改动文件的最终状态（保留目录结构）
  - `EXPORT_MANIFEST.json` — 导出清单
- **批量导出**: 命令 `DAO: Export ALL Sessions` 一次导出账号全部 sessions

## 安装

```
code --install-extension dao-devin-export-1.0.0.vsix
```

## 使用

1. 点击左侧活动栏的 DAO Devin 图标
2. 输入邮箱密码登录（自动保存，重启 VS Code 免登录）
3. 浏览/搜索 sessions，点击查看详情
4. 点击 `⬇ ZIP` 一键导出任意 session 全部数据

## 技术

- 零运行时依赖（纯 Node stdlib：https + zlib 自实现 ZIP）
- API: windsurf.com 登录 → app.devin.ai sessions/events/presigned-url
- Token 保存在 VS Code globalState

无为而无不为 道法自然
