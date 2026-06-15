# 10_对话与导出_DAO_EXPORT · 道法自然

> 「为学者日益，闻道者日损。损之又损，以至于无为，无为而无不为。」

**本源目标**: 用户只提供 **邮箱+密码**，即可导出 Devin AI 账号内 **一切** 对话历史、事件流、worklog、changes、云端产出文件。

任何 agent 看到本文件夹，即可 **不依赖 VSIX**，纯后端脚本实现一切。

## 文件夹结构

| 文件 | 说明 |
|---|---|
| `BACKEND_GUIDE.md` | ★ 核心 · 纯后端实现指南：完整 API 逆向 + 认证流 + 数据流，照此可从零实现一切 |
| `dao_export_all.py` | ★ 零依赖 Python 导出脚本（v2 高速版：16 路并发下载 + 重试 + 断点续传；实测 70 会话/7173 事件/706 文件 ≈ 58 秒全量导出） |
| `dao-devin-export-1.3.3.vsix` | ★ VS Code 插件成品（最新 v1.3.3：**连接复用 keep-alive 根治高延迟链路下载慢** + 导出内容**人/Agent 双向重构**：README 索引 + session.json 结构化 + 像官网一样的 conversation.md；含 v1.3.2 完整事件提取） |
| `vsix-src/` | ★ 插件完整 TypeScript 源码（可直接 `npm i && npm run package` 重新打包） |
| `dao-vsix-README.md` | 插件使用文档 |
| `DEV_EXPERIENCE.md` | 核心开发经验（坑+解法，全部实战验证） |
| `SESSION_PROCESS.md` | 本对话(构建本系统的Devin会话)全过程记录 |
| `TEST_REPORT.md` | 端到端测试报告(4/4通过) |

## 最简用法

```bash
# 单账号
python dao_export_all.py --email xxx@gmail.com --password xxx
# 批量（accounts.md 每行 email:password）
python dao_export_all.py --accounts accounts.md
```

VSIX 安装: `code --install-extension dao-devin-export-1.3.3.vsix`

## v1.3.3 下载根治 + 人/Agent 双向重构（2026-06-11）—— 「道法自然，导出即闭环」

### ① 下载慢的根因与根治（高延迟链路）
- **根因**：本地（如国内→AWS）下载几百文件要 10+ 分钟，并非代码慢，而是**每个文件都新建一条 TCP+TLS 连接**（无 keep-alive）。高 RTT 链路下每次 TLS 握手要多个往返，几百个文件握手开销线性叠加 → 卡几分钟甚至更久。VM 低延迟链路上同样代码下载 323 文件仅 ~1.9s，掩盖了该问题。
- **根治**：底层统一连接复用 keep-alive 连接池。直连走单例 `https.Agent({keepAlive,maxSockets})`；**本地代理→AWS** 场景走自研 `ProxyTunnelAgent`（CONNECT 隧道建立后池化复用 TLS socket）。整批下载只付出 (并发数) 次握手，其余请求走已暖连接，几乎只剩传输时间。
- **辅以**：下载/presign 并发提到 24/8；下载显式**状态码校验**（非 2xx 抛错，旧版把 S3 错误页当文件存盘且不重试）；**按 contents_key 去重**（云端文件阶段下好的 buffer，changes 阶段直接复用，不二次下载）。
- **实测（同一批 323 文件，VM）**：无 keep-alive 1557ms → keep-alive 796ms → keep-alive+并发24 **589ms（2.6×）**；端到端全量导出（取事件+下载+打包）1.56s。链路延迟越高，倍数越大。

### ② 导出内容人/Agent 双向重构
- **新增 `README.md`（人+Agent 索引）**：YAML front-matter（devin_id/状态/计数）+ 概览 + **原始需求**（首条 user prompt）+ PR/录屏/产出文件表/最终 TODO/阻塞 + **文件地图**。人读如会话主页，Agent 先解析 front-matter 再按图索骥。
- **新增 `session.json`（Agent 单文件全量）**：`schema: dao-export/session@2`，含 meta、original_request、全部 message 轮次、stats、produced_files（带 zip 内路径）、cloud_files（key→path）、recordings、blockers。
- **对话提取补全**：旧版只取 `user_message`/`devin_message`，**漏掉了最重要的首条 `initial_user_message` 和用户对提问的回答 `user_question_answered`** —— 现已全部纳入 conversation 与详情页。
- **conversation.md 像官网**：消息醒目呈现，消息之间的过程（命令/编辑/搜索/TODO）折叠进 `<details>` 摘要，不再淹没在流水账里。
- **cloud_files 可导航**：按真实文件名 basename 命名（而非纯 hash），`_index.json` 保留完整 key→path 映射。

## v1.3.2 对话记录提取完善（2026-06-11）—— 「彻底提取一切对话内容」

问题：旧版 worklog / 「对话」标签按**猜测的事件类型名**（`command`/`file_edit`/`plan`…）匹配，而真实事件流用的是 `devin_thoughts`/`shell_process_started`/`multi_edit_result`/`computer_use`/`todo_update`/`search_file_commands` 等 —— 名字对不上，导致 Devin 的思考、命令、文件编辑、计算机操作、TODO 等**大量内容被静默丢弃**。

- 提取逻辑改用**真实事件类型**，单会话覆盖实测：💭 思考 737 + 💻 命令 306（含 exit code/输出）+ 📋 TODO 27 + 🔍 搜索 72 + 🖥️ 计算机 150 + ✏️ 文件编辑 229，worklog 从 ~0.59MB 增至 ~0.98MB。
- 导出新增 **`conversation.md`**（仅 user/devin 消息的干净对话转录）+ **`conversation.json`**（结构化 `[{role,time,text}]`），即「对话记录提取」的直接产物。
- `extractMessageText` 健壮解析消息：字符串 / `{text}` / `{content}` / `[{type,text}]` 数组，避免把结构化消息直接 JSON dump 给用户。
- 噪声事件（`terminal_update`/`is_typing`/`context_growth_update` 等）在 worklog 中跳过。

## v1.3.1 健壮性修复（2026-06-11）—— 「登录成功却看不到任何对话记录」

根因：插件取数路径在网络/代理异常时**静默吞掉错误**，使「拉取失败（empty）」与「确实没有数据（empty）」无法区分，表现为登录成功但会话列表/对话记录空白且无任何提示。

- `listSessions`：主端点 `org-{bare}/v2sessions` 失败或返回异常结构时，**回退 `/sessions`**（与 `dao_export_all.py` 对齐）；两者皆失败则**抛出带原因的错误**，不再静默返回 `[]`。
- `getEventStream`：流式端点最易在慢速/代理链路上失败 —— 增加 **3 次重试 + 退避**；非 200 显式报错。
- `request`：响应若被代理/CDN 压缩（gzip/deflate/br）**自动解压**，避免 `JSON.parse` 静默失败。
- 登录与取会话**分离**：登录成功但取会话失败时提示「已登录，但获取会话失败（点 ⟳ 重试）」而非误报「登录失败」；恢复登录态时的瞬时失败不再静默登出。
- 详情页「对话」标签：事件流获取失败时直接显示 **⚠️ 失败原因 + 代理配置提示**，而非空白。

## v1.3.0 软编码与软适配（2026-06-11）

- **软适配代理（适配一切用户环境）**：插件与 Python 脚本下载层统一「直连 → 自动检测系统/环境代理 → 优雅失败」。
  - 插件：设置 `daoDevin.proxy` → VS Code `http.proxy` → 环境变量 `HTTPS_PROXY/HTTP_PROXY` → 直连；HTTPS 走标准 CONNECT 隧道，已实测打通。
  - 脚本：默认自动检测（环境变量 + Windows 注册表）；`--proxy URL` 强制代理；`--no-proxy` 强制直连。有代理则成功，无代理直连不通则明确报告，顺其自然。
- **侧边栏「📄 导出MD」按钮**：登录前（登录框下方）与登录后（工具栏）均有，一键导出实时 Agent 接入文档。
- **全面软编码**：VS Code 设置 `daoDevin.*` —— bridgePort（默认 7848，占用自动顺延）、proxy、apiBase、loginUrl、downloadConcurrency、presignConcurrency、downloadRetries、downloadTimeoutMs，全部可配，适配一切用户。

## Agent Bridge（v1.2.0，2026-06-11）

- 插件启动即在 127.0.0.1:7848 起本地 HTTP API（token 鉴权），暴露全部底层：会话/事件/worklog/changes/云端文件/一键 ZIP/账号级数据
- 命令 `DAO: Export Agent Bridge Doc (MD)` 实时生成接入文档（端口+token+全部接口示例），粘贴给任意 Agent 即可接入
- 实测（Devin 自身 VM VS Code 全链路）：UI 导出 323 文件会话数秒；API 一键导出 3.7 秒；全端点验证通过

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
