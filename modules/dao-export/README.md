# 10_对话与导出_DAO_EXPORT · 道法自然

> 「为学者日益，闻道者日损。损之又损，以至于无为，无为而无不为。」

**本源目标**: 用户只提供 **邮箱+密码**，即可导出 Devin AI 账号内 **一切** 对话历史、事件流、worklog、changes、云端产出文件。

任何 agent 看到本文件夹，即可 **不依赖 VSIX**，纯后端脚本实现一切。

## 文件夹结构

| 文件 | 说明 |
|---|---|
| `BACKEND_GUIDE.md` | ★ 核心 · 纯后端实现指南：完整 API 逆向 + 认证流 + 数据流，照此可从零实现一切 |
| `dao_export_all.py` | ★ 零依赖 Python 导出脚本（v2 高速版：16 路并发下载 + 重试 + 断点续传；实测 70 会话/7173 事件/706 文件 ≈ 58 秒全量导出） |
| `dao-devin-export-1.1.0.vsix` | VS Code 插件成品（v1.1.0 高速版：12 路并发下载 + 重试；323 文件会话从卡死 30+ 分钟降至约 3 秒） |
| `dao-vsix-source.zip` | 插件完整 TypeScript 源码 |
| `dao-vsix-README.md` | 插件使用文档 |
| `DEV_EXPERIENCE.md` | 核心开发经验（坑+解法，全部实战验证） |
| `SESSION_PROCESS.md` | 本对话(构建本系统的Devin会话)全过程记录 |
| `TEST_REPORT.md` | 端到端测试报告(4/4通过) |
| `accounts.md` | 测试账号 |

## 最简用法

```bash
# 单账号
python dao_export_all.py --email xxx@gmail.com --password xxx
# 批量（accounts.md 每行 email:password）
python dao_export_all.py --accounts accounts.md
```

VSIX 安装: `code --install-extension dao-devin-export-1.1.0.vsix`

## 性能（v2 / v1.1.0 长对话优化，2026-06-11）

- 根因：旧版所有文件**串行逐个下载**、无重试、presigned 批次串行 → 超长对话（几百文件）卡死在「下载文件 N/M」
- 修复：Python 16 路并发 + VSIX 12 路并发；每文件 3 次重试（45s 超时）；presigned 6 路并发；事件流 1MB 大块读取 + 上限提至 600s/512MB + 进度打印；API 请求 gzip；断点续传（已有 file_manifest.json 的会话跳过）；accounts.md 支持 `email:password` 格式
- 实测：323 文件超长会话（原卡 30+ 分钟）→ 下载阶段约 3 秒，0 失败；全账号 70 会话全量导出 58 秒

## 已验证成果

- 账号1 lcld26815946: 104 会话 / 7067 事件 / 598 云端文件
- 账号2 beasley856439: 70 会话 / 7521 事件 / 935 云端文件
- 含早期 3 个归档对话完整数据: fc6d09ed / 0c7c6948 / 878766aa
- 账号级数据: Playbooks / Knowledge / Secrets / Automations / Org 设置
- 账号3 lbvpkv87845410: 70 会话 / 7173 事件 / 706 云端文件（v2 高速版验证，58 秒全量）
