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
- **Agent Bridge (v1.2.0)**: 插件启动即在本地 127.0.0.1:7848 起 HTTP API（token 鉴权），暴露全部底层功能——会话列表/事件流/worklog/changes/云端文件/一键 ZIP 导出/账号级 playbooks·knowledge·secrets·org。后端 Agent 直接调 HTTP 即可使用所有模块，无需任何文档或依赖。命令：`DAO: Start/Stop Agent Bridge`
- **导出MD (v1.2.0)**: 命令 `DAO: Export Agent Bridge Doc (MD)` 实时生成接入文档（当前端口、token、全部接口、curl/PowerShell 示例），粘贴给任意 Agent 即可立刻接入正在运行的插件

## 安装

```
code --install-extension dao-devin-export-1.3.3.vsix
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
- 高速下载引擎（v1.1.0）：cloud_files 与 changes 均为 12 路并发下载 + 每文件 3 次重试（45s 超时），presigned-url 批量解析 6 路并发——实测 323 文件会话从卡死 30+ 分钟降至约 3 秒
- Agent Bridge（v1.2.0）：Node stdlib http，仅监听 127.0.0.1，token 每次自动生成并持久化（globalState），全部端点见 `GET /api/status` 或导出的 MD 文档；实测 API 一键导出 323 文件会话 3.7 秒

无为而无不为 道法自然
