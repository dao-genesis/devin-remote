# 纯后端实现指南 · Devin AI 账号全量数据导出 API 逆向

> 「反也者，道之动也。」本文档使任何 agent **不依赖 VSIX、不依赖浏览器、不依赖对话ID/APIKey**，
> 仅凭 **邮箱+密码**，纯 HTTP 实现一切导出。全部端点均实战验证（2026-06）。

## 一 · 认证流（本源入口）

### 1. 登录拿 token
```
POST https://windsurf.com/_devin-auth/password/login
Content-Type: application/json
Body: {"email": "...", "password": "..."}
→ 200 {"token": "auth1_..."}
```
此 token 即 Bearer token，长期有效，后续所有请求带 `Authorization: Bearer auth1_...`。

### 2. Post-Auth 拿组织ID
```
POST https://app.devin.ai/api/users/post-auth   (Bearer)
→ {"org_id": "org-xxxxxxxx...", "org_name": "..."}
```
- `org_id` 形如 `org-bb721a3a...`，**bare id** = 去掉 `org-` 前缀。
- 后续请求加 header: `x-cog-org-id: <org_id>`。
- 建议同时带 `User-Agent: Mozilla/5.0 ...`（部分端点校验UA）。

## 二 · 会话级数据（对话本体）

| 数据 | 端点 |
|---|---|
| 会话列表 | `GET https://app.devin.ai/api/org-{bare}/v2sessions` → `{result:[...]}`（含 session_id/title/status/created_at/pr 等） |
| 会话详情 | `GET https://app.devin.ai/api/sessions/{devin_id}` |
| 完整事件流 | `GET https://app.devin.ai/api/events/{devin_id}/stream`（SSE/ndjson，需流式解析） |
| 事件流备选 | `GET https://app.devin.ai/api/events/first-load/{devin_id}`（一次性 JSON） |

事件流解析要点：
- 响应是 SSE 风格 `data: {...}` 行 或 纯 ndjson；用 **大括号深度计数** 切分 JSON 对象最稳。
- 用 `event_id` 去重（stream 可能重发）。
- 事件类型含: user_message / devin_message / command / file_edit / plan / browser 等
  —— worklog 即由这些事件按时间渲染而成。

## 三 · 云端产出文件（最本源的成果）

产出文件存于 Devin 云端 S3，与虚拟机生命周期无关（虚拟机重建后由此恢复）：

```
POST https://app.devin.ai/api/presigned-url/batch/{devin_id}
Body: {"s3_key_list": ["...", ...]}     # 每批 ≤40 个 key
→ {key: presigned_url, ...}             # 直接 GET presigned_url 下载文件内容
```

s3_key 来源：**遍历事件流中的所有事件 JSON**，递归提取形如 s3 key 的字段
（`contents_key` / `s3_key` / attachments 等）。`file_edit` 事件含 `file_path` + `contents_key`，
按时间最后一次出现即该文件**最终状态**（changes/ 的来源）。

## 四 · 账号级数据

| 数据 | 端点（均 GET, Bearer + x-cog-org-id） |
|---|---|
| Secrets | `https://app.devin.ai/api/org-{bare}/secrets` |
| Playbooks | `https://app.devin.ai/api/org-{bare}/playbooks` |
| Knowledge | `https://app.devin.ai/api/org-{bare}/learning/all` |
| Automations | `https://app.devin.ai/api/org-{bare}/automations` |
| Org 设置 | `https://app.devin.ai/api/organizations/{org_id}` |
| 成员 | `https://app.devin.ai/api/organizations/{org_id}/members` |

## 五 · 导出物结构（dao_export_all.py 实现）

```
dao_export/{account}_{timestamp}/
├── _account/                    # 账号级: playbooks/knowledge/secrets/automations/org
├── {session_title}_{id8}/
│   ├── session_info.json        # 会话元数据
│   ├── events.json              # 完整事件流(去重排序)
│   ├── worklog.md               # 可读工作日志(由事件渲染)
│   ├── cloud_files/             # 全部云端产出文件实际内容
│   ├── changes/                 # 全部改动文件最终状态(保留目录结构)
│   └── EXPORT_MANIFEST.json
└── _export_summary.json
```

## 六 · 实现注意（实战坑）

1. **零依赖**: Python 仅 stdlib (urllib/ssl/zlib/json)；TLS 验证可关 (`CERT_NONE`) 以兼容代理环境。
2. **Windows 编码**: stdout 需包 UTF-8 TextIOWrapper，否则 cp1252 打印中文崩溃。
3. presigned-url 批量 **每批最多 40 个 key**，超出 422。
4. 个别 session 事件流为空/404 → 回退 first-load；仍失败则跳过并记录。
5. 文件名安全化: 标题含中文/特殊字符需 safeName 处理。
6. ZIP 自实现: `zlib.deflateRawSync`(Node) / `zipfile`(Python)，UTF-8 文件名 flag (bit 11)。

## 七 · 验证数据（2026-06-11）

- lcld26815946@gmail.com → org barbba-287, 104 sessions（导出101）
- beasley856439@gmail.com → org marpriceo9, 70 sessions（全部导出）
- 总计 14,588 事件 + 1,533 云端文件 + 356 变更文件 = 83.7 MB
