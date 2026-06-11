# 核心开发经验 · 实战坑与解法（全部验证）

## API / 后端

| 坑 | 解法 |
|---|---|
| 登录端点不在 app.devin.ai | 在 `windsurf.com/_devin-auth/password/login` |
| 会话列表 404 | 必须用 `org-{bare}` 路径段 + `x-cog-org-id` header |
| 事件流难解析 | SSE/ndjson 混合 → 大括号深度计数切 JSON + event_id 去重 |
| presigned-url 422 | s3_key_list 每批 ≤40 |
| changes 重复 | file_edit 按 file_path 最后一次出现为最终态 (last-wins) |
| 超长对话导出卡死(下载文件 N/M 停止) | 根因是串行逐个下载+无重试 → 并发下载(Python 16路/VSIX 12路) + 每文件 3 次重试 45s 超时 + presigned 6 路并发；323 文件从 30+ 分钟降至 ~3 秒 |
| 事件流大会话被 180s 硬上限截断 | 上限提至 600s/512MB，1MB 大块读取，列表拼接避免 bytes O(n²) 累加，每 5s 打印接收进度 |
| accounts.md `email:password` 格式解析不出 | parser 同时支持空格与冒号分隔 |
| 中文打印崩溃(Windows) | `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')` |

## VSIX 插件开发

| 坑 | 解法 |
|---|---|
| TS: deflateRawSync 返回类型不兼容 Buffer | `Buffer.from(zlib.deflateRawSync(buf,{level:6}))` 显式包裹 |
| vsce 打包包含测试文件 | `.vscodeignore` 排除 src/** test_* 等 → 121KB 降至 22.6KB |
| vsce LICENSE 提示交互阻塞 | `echo y | vsce package --no-dependencies` |
| 零运行时依赖 | 纯 Node stdlib: https 请求 + zlib 自实现 ZIP writer (crc32 + local/central headers) |
| 登录态持久化 | `context.globalState` 存 token+org，激活时恢复 |

## 本虚拟机环境（Devin VM, Windows Server 2022）

| 坑 | 解法 |
|---|---|
| `code` CLI 是 Devin stub | 自下载 VS Code win32-x64-archive 解压用 `vscode/bin/code.cmd` |
| GUI 打字丢 `@` 字符 | 文本分段输入 + `key shift+2` 打 @ |
| Python 不含脚本目录到 sys.path | 内联代码或显式 sys.path.insert |
| PIL 缺失 | `pip install pillow` |

## CF 隧道远控 141 台式机

- 端点: `POST {tunnel}/api/exec-sync`，Bearer `dao-ps-agent-2026`，agent_id `141`
- 两种 payload:
  - 执行: `{"agent_id":"141","cmd":"...","timeout":30}`
  - 写文件: `{"agent_id":"141","type":"file_write","payload":{"path":"E:\\...","content_base64":"..."}}`
  - 读文件: `{"agent_id":"141","type":"file_read","payload":{"path":"E:\\..."}}`
- **中文路径**: cmd 行会 GBK 乱码 → 用 `powershell -EncodedCommand <base64(utf-16le)>` 传中文路径；
  内容传输一律 base64 (file_write/file_read) 防编码丢字。
- 命令积压会 408 → 在 141 本地重启 agent: `python agent_dao.py --server http://192.168.31.179:9910`
