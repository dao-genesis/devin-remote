# DAO Devin Export v1.2.0 — 全链路实测报告（Devin 自身 VM）

日期: 2026-06-11 ｜ 环境: Devin VM (Windows Server 2022) + VS Code 1.123 ｜ 账号: lbvpkv87845410@gmail.com

## 结果总览

| 测试 | 结果 |
|---|---|
| 插件安装 + 登录 + 70/70 会话列出 | 通过 |
| UI 导出 323 文件长会话（原卡死 30+ 分钟） | 通过：3.0MB ZIP 数秒完成，377 条目完整性校验 OK |
| 导出MD（实时 Agent 接入文档） | 通过：含实时端口 7848 + token + 全部接口示例 |
| Agent Bridge HTTP API 全端点 | 通过（见下） |
| 错误 token 拒绝 | 通过：401 invalid token |

## Bridge API 实测明细

- `GET /api/ping` → ok（免鉴权探活）
- `GET /api/status` → version 1.2.0, loggedIn, 70 sessions cached
- `GET /api/sessions` → 70 条
- `GET /api/session/{id}` / `/events` / `/worklog` / `/changes` / `/keys` → 2469 events / 48 changes / 323 keys
- `GET /api/account/playbooks|knowledge|secrets|org` → 全部返回真实数据
- `POST /api/session/{id}/export` → 3,170,429 字节 ZIP 落盘，耗时 **3.7 秒**

## 证据截图

登录后会话列表（70/70）:
![sessions](C:\Users\Administrator\screenshots\screenshot_32b89855932b47bbba46d9244408ca6b.png)

长会话详情（2469 事件 / 323 云端文件）:
![detail](C:\Users\Administrator\screenshots\screenshot_11e415846d144527bd0a61b7b0223c24.png)

UI 导出完成提示（3.0 MB）:
![export](C:\Users\Administrator\screenshots\screenshot_35a11f528f174da4a9791238abe38dac.png)

导出MD 实时接入文档 + 终端调用 Bridge（70 sessions via Agent Bridge）:
![bridge](C:\Users\Administrator\screenshots\screenshot_58d49e3cd2a745b386f7b6d090c51287.png)

## 141 本机后台测试结论（重要发现）

E:\DAO_EXPORT_TEST_LOG.txt 显示：API（登录/会话/事件流/账号级数据）全部成功，但 **全部 419 个文件下载失败 WinError 10060**——141 所在网络屏蔽/不可达 presigned S3 下载域名。这是原始「卡 30 分钟只下载一部分」的环境根因之一（代码串行+无重试是另一半）。

解法（任选）：
1. 在 141 设 `HTTPS_PROXY` 环境变量（脚本 urllib 自动读取）走可达 S3 的代理/VPN
2. 在可达 S3 的机器（如 Devin VM / 179）跑导出后回传 141

## 已回写 141（MD5 全部校验一致）

- dao-devin-export-1.2.0.vsix（并已在 141 VS Code 安装成功）
- dao-vsix-source.zip（v1.2.0 完整源码）
- README.md / dao-vsix-README.md / DEV_EXPERIENCE.md（含上述新坑+解法）

无为而无不为 道法自然
