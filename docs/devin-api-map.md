# Devin Cloud (app.devin.ai) API 逆流图 · devin-api-map

> 任务 X1 · 逆流官网常用功能/模块的后端 API / 数据结构 / 鉴权方式。
> 本文为 **逆流(reverse-engineer)** 成果汇编：所有端点均来自 `core/dao-vsix/src/extension.ts`
> 中已在生产实测可用的实现，或经 Chrome DevTools 抓 XHR 实操官网得到。
>
> 道法自然 · 一步一验：标注每个端点的**置信度**，未实测的写明「待实测」，绝不臆造。

## 0. 通用约定

- **Base**：`https://app.devin.ai`（常量 `DEVIN_APP`）
- **WSS**：`wss://app.devin.ai/api/acp/live?token=<jwt>`（常量 `DEVIN_WSS_BASE`）
- **鉴权**：两类令牌
  - `auth1`（cog_ API Key / 完整能力）→ `Authorization: Bearer <auth1>`，可调用全部 `/api/*`。
  - `devin-session-token$<jwt>`（Windsurf 会话令牌 / 仅 Codeium）→ 多数 `/api/org-*` 写接口 401/403；
    经 Simple Browser 共享 Auth0 Session 可手动写入（见 `devinAssistedInject`）。
- **组织头**：除 `Authorization` 外，几乎所有 org 级请求都要带 `x-cog-org-id: <orgId>`（形如 `org-xxxx`）。
- **orgId 两种写法**：
  - 带前缀：`org-<uuid>`（用于 `x-cog-org-id` 头、`/api/organizations/<orgId>/...`）。
  - 去前缀：`bareOrgId = orgId.replace(/^org-/, '')`（用于 `/api/org-<bare>/...` 路径段）。
- **成功判定**：`200 | 201`（创建），`200 | 204`（删除），`409`/`400 already registered` 视为「已存在=幂等成功」。

## 1. 鉴权 / 账户 / 配额

| 模块 | 方法 | 路径 | 置信度 | 备注 |
|---|---|---|---|---|
| 计费状态 | GET | `/api/org-<bare>/billing/status` | ✅ 实测 | 判断 plan / 是否可用 API |
| 用量统计 | GET | `/api/org-<bare>/billing/usage/stats` | ✅ 实测 | subscription_status / available_acus / balance / cycle |
| 用量上限 | GET | `/api/org-<bare>/billing/usage/limits` | ✅ 实测 | max_acu_limit |
| 单条额度上限 | POST | `/api/org-<bare>/billing/usage/limits` | ✅ 实测 | body `{ max_credits: number }` |
| 组织成员 | GET | `/api/organizations/<orgId>/members` | ✅ 实测 | `[{ preferred_name, email, roles:[{label,id}] }]` |
| 创建 service-user | POST | `/api/organizations/<orgId>/service-users` | ✅ 实测 | 用于派生 API key |

## 2. Secrets 密钥

| 方法 | 路径 | 置信度 | body / 备注 |
|---|---|---|---|
| GET | `/api/org-<bare>/secrets` | ✅ 实测 | 返回 `[]` 或 `{ secrets: [] }` |
| POST | `/api/org-<bare>/secrets` | ✅ 实测 | `{ key, value, type:'key-value', sensitive:true, note }` · 409=已存在 |
| DELETE | `/api/secrets/<id>` | ✅ 实测 | 先 GET 列表拿 id |

## 3. Knowledge 知识库

| 方法 | 路径 | 置信度 | body / 备注 |
|---|---|---|---|
| GET | `/api/org-<bare>/learning/all` | ✅ 实测 | 返回 `{ learnings: [{id,name,trigger_description,is_enabled}] }` |
| POST | `/api/org-<bare>/learning` | ✅ 实测 | `{ name, body, trigger_description, pinned_repo:null, parent_folder_id:null, is_enabled:true }` |
| DELETE | `/api/org-<bare>/learning/<id>` | ✅ 实测 | |

## 4. Playbooks 剧本

| 方法 | 路径 | 置信度 | body / 备注 |
|---|---|---|---|
| GET | `/api/org-<bare>/playbooks` | ✅ 实测 | `{ playbooks: [{id,title,status}] }` |
| POST | `/api/org-<bare>/playbooks` | ✅ 实测 | `{ title, body, status:'published', access:'team' }` |
| DELETE | `/api/playbooks/<id>` | ✅ 实测 | 注意是 **全局** 路径(无 org 段) |

## 5. Integrations / Git 连接

| 模块 | 方法 | 路径 | 置信度 | 备注 |
|---|---|---|---|---|
| Git 连接元数据 | GET | `/api/organizations/<orgId>/git-connections-metadata` | ✅ 实测 | 真实可断开连接列表 |
| GitHub PAT 注入 | POST | `/api/org-<bare>/integrations/github/pat` | ✅ 实测 | `{ pat }` · 400 `already registered`=幂等 |
| GitHub PAT 断连 | DELETE | `/api/org-<bare>/integrations/github/pat?connection_id=<id>` | ✅ 实测 | GitLab/Bitbucket 同构换路径段 |
| 各提供商状态 | GET | `/api/org-<bare>/integrations/{github,gitlab,bitbucket}` | ✅ 实测 | 数组非空=已连 |
| Azure DevOps | GET | `/api/org-<bare>/integrations/azure-devops` | ✅ 实测 | `{ connections:[] }` |
| Slack | GET | `/api/org-<bare>/integrations/slack/status` | ✅ 实测 | `{ connection }` |
| Jira | GET | `/api/org-<bare>/integrations/jira/status` | ✅ 实测 | `{ integration }` |

## 6. MCP 服务器

| 模块 | 方法 | 路径 | 置信度 | body / 备注 |
|---|---|---|---|---|
| 列表(市场+已装) | GET | `/api/mcp/servers` | ✅ 实测 | 项主键 `server_id`；`mcp-installation-*`=本组织自装，`mcp-marketplace-server-*`=市场目录 |
| 安装自定义 MCP | POST | `/api/mcp/installations` | ✅ 实测 | 见下方 schema |
| 删除自定义 MCP | DELETE | `/api/mcp/installations/mcp-installation-<id>` | ✅ 实测 | id 需带前缀(自动补全) |

**POST /api/mcp/installations schema（实测要点，易踩坑）：**
```jsonc
{
  "name": "GitHub MCP",
  "slug": "github-mcp",            // 小写连字符
  "short_description": "",
  "description": "",
  "transport": "STDIO",           // 或 "HTTP" / "SSE"
  "is_enabled": true,
  "icon": "",
  "installation_scope": "org",
  // —— transport=STDIO ——
  "command": "npx",
  "args": [{ "value": "-y" }, { "value": "pkg" }],   // ★ 必须 [{value}] 字典数组, 纯字符串数组会 422 (dict_type)
  "env_variables": [{ "key": "TOKEN", "value": "x" }] // ★ 必须 list, 对象会 422 ("should be a valid list")
  // —— transport=HTTP/SSE ——
  // "url": "https://...", "headers": { "Authorization": "Bearer ..." }
}
```

## 7. Automations 自动化

| 方法 | 路径 | 置信度 | 备注 |
|---|---|---|---|
| GET | `/api/org-<bare>/automations` | ✅ 实测 | `[{ name, automation_id, enabled, triggers:[{event_type}] , actions? }]` |
| POST | `/api/org-<bare>/automations` | ⚠️ 待实测 | 推断 body 同 GET 项形态(name/triggers/actions/enabled)；**需 Chrome DevTools 抓官网创建请求确认** |
| DELETE | `/api/org-<bare>/automations/<automation_id>` | ⚠️ 待实测 | 推断；需实测 |

## 8. Blueprints / 蓝图

| 方法 | 路径 | 置信度 | 备注 |
|---|---|---|---|
| GET | `/api/org-<bare>/blueprints`（推断） | ⚠️ 待实测 | 官网蓝图页对应端点未抓取；**需逆流确认真实路径与 schema** |
| POST / DELETE | 同上 | ⚠️ 待实测 | 待 X1 现场抓 XHR |

## 9. Sessions 会话

| 模块 | 方法 | 路径 | 置信度 | 备注 |
|---|---|---|---|---|
| 列表 | GET | `/api/sessions` | ✅ 实测 | 自助账号可用 |
| 详情 | GET | `/api/sessions/<id>` | ✅ 实测 | |
| 消息 | GET | `/api/sessions/<id>/messages` | ⚠️ 部分 | 自助账号常 404，守柔兜底为空 |
| 实时 | WSS | `/api/acp/live?token=<jwt>` | ✅ 实测 | jwt = session-token `$` 之后部分 |

## 10. 逆流方法论（补全 7/8 等「待实测」项）

1. 用反代路由官网：`daoRoutedWebUrl('')`（持 auth1 自动登录）在 IDE 内打开官网。
2. 开 Chrome DevTools → Network → 过滤 `Fetch/XHR`，在官网执行目标操作（建自动化 / 存蓝图）。
3. 记录：请求 URL、Method、Request Headers（`Authorization` / `x-cog-org-id`）、Request Payload、Response。
4. 回填本表对应行，置信度改 ✅，并在 `extension.ts` 落 `devinXxx()` 实现 + 纳入反向注入 `InjectProfile`。
5. 一步一验：每补一个端点，先只读 GET 验证形态，再写 POST，幂等可重入。

---
*维护：与 `core/dao-vsix/src/extension.ts` 同源；新增/变更端点请同步更新本表与置信度。*
