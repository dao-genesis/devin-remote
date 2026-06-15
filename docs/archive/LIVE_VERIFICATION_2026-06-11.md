# 三插件全链路实测验证报告 · 2026-06-11

> 自包含闭环：全部在 Devin 虚拟机上冷启动 + 登录 + 部署 + 实测，不依赖 141。
> 目标插件：`dao-vsix`、`dao-bridge`、`devin-git-auth`（不含 dao-proxy-pro）。

## 0. 环境 / 冷启动

| 项 | 值 |
|---|---|
| Devin Desktop | 3.1.7（productVersion 1.110.1，版本强耦合，不可换 Windsurf 1.13.3） |
| 工作区 | `C:\Users\Administrator\repos\devin-remote` |
| 扩展目录 | `%USERPROFILE%\.devin\extensions\` |
| dao-vsix | `1.0.9`（预构建 VSIX，172KB） |
| dao-bridge | `2.1.0`（本次修复后重新打包，11.7KB） |
| devin-git-auth | `2.0.0`（无预构建，补图标后现场打包，22.3KB） |
| 登录账号 | Devin 账号邮箱/密码登录过 Auth0 闸门；登录态**跨进程重启保持** |

冷启动闭环 = 安装软件 → 登录账号 → 部署插件 → 实测，全部完成。

---

## 1. dao-bridge ✓ 全链路通过

### 修复（本次核心代码改动）
`plugins/dao-bridge/dao-bridge-ext/extension.js`

- **致命 bug**：`findCloudflared()` 在 PATH 无 cloudflared 时直接把裸二进制名 `"cloudflared.exe"`
  交给 `cp.spawn`。`spawn` 对缺失二进制**不抛同步异常**，只异步 emit `error`，导致外层
  `try/catch` 是死代码、下载兜底永不触发 → 全新机器隧道永远起不来。
- **修复**：`findCloudflared()` 改为先用 `where`/`command -v` 探测 PATH，缺失则返回空串；
  `start()` 在 `bin` 为空时先 `await downloadCloudflared()` 再 spawn；并加 async error
  重试（spawn 失败时重新下载一次）。
- **新增**：命名隧道（稳定 URL）配置 `daoBridge.tunnelToken` 等；留空保持原 quick tunnel（零回归）。

### 实测（含进程重启后自愈）
- 进程重启后 dao-bridge 扩展激活自动重建隧道：cloudflared 自动拉起，
  `~/.dao/bridge/conn.json` 刷新出**新的** quick-tunnel URL（端口随之更新）。
- 面板「能力自测」health → `status=200 ok=true`，返回
  `{"status":"ok","service":"dao-bridge-workspace","version":"2.0","host":"devinbox",...}`。
- 公网 curl 实测：`/api/health` → 200；`/api/exec`（带 `Authorization: Bearer <token>`）→ 200
  并真实执行命令（`echo ... && hostname` 返回 `devinbox`）；无 Token → **401**。

结论：自动下载 + quick tunnel + 公网鉴权全链路打通，且**重启自愈**得到二次验证。

---

## 2. dao-vsix ✓ 全链路通过

- 登录态跨重启保持：面板顶部 `✓ <account>`、组织 `barbba-287`、`Server :9920`、Daily 100%。
- 「全功能面板」账户区：邮箱、组织、Org ID、`Token=auth1`、`API能力 ✓完整API访问`；
  配额区 Plan/Daily/Weekly/Credits 实时显示。
- 「注入状态」：Secret / Knowledge / Playbook / 帛书 全部 ✓。
- Sessions 看板经 auth1 实时拉取 **104 条** session 数据（标题/状态/devin-id/时间均渲染）。

结论：登录、注入、全功能看板实时数据全部通过。

---

## 3. devin-git-auth ◑ 机制全验证；组织级 Git 连接因后端限制未闭合

### 已验证（真实闭环）
- 面板渲染；**PAT 与账号注册表跨重启持久化**（globalState/secrets）。
- Devin 账号邮箱/密码认证 ✓（`POST windsurf.com/_devin-auth/password/login` → `auth1`）。
- 多账号注册表：同时登记 `lcld26815946` 与 `beasley856439` 两个账号（多账号协同 UI 成立）。
- `连接Git` 触发 gh_cli 设备码流（`POST /api/integrations/gh_cli/code`），生成设备码。
- 用 **GitHub 测试账号 hdougle + 本地生成的 TOTP** 完成真实 GitHub 设备授权，
  GitHub 端两次显示 “Congratulations, you're all set! Your device is now connected.”。
- 干净组织 `marpriceo9`（beasley856439）面板显示 `OAuth: 已连接, GitHub: hdougle`
  （`isOAuthConnected` 字段为真）。

### 未闭合点：组织级 Git 连接（`Git连接: 未连接`）
设备授权在 GitHub 端成功后，Devin 后端**始终**返回如下状态（两个不同组织均复现，含全新干净组织）：

```
GET /api/integrations/gh_cli/state
{"error":"GitHub integration already registered",
 "device":{"user_code":"2A85-2C3D",...},
 "oauth":null,                       ← 插件轮询判据，恒为 null
 "last_poll":...}

GET /api/organizations/<org>/git-connections-metadata
[]                                    ← 组织级连接恒为空
```

- 插件 `connectGit` 轮询逻辑**正确**：每 5s 检查 `oauth!=null`，每 30s 兜底检查
  `git-connections>0`，最长 3 分钟。两个判据都合法地一直为假，故状态灯不翻到「已连接」。
- 复现矩阵（API 直连验证）：

  | 账号 | 组织 | git-connections | gh_cli/state error |
  |---|---|---|---|
  | barbba-287（lcld26815946） | barbba-287 | 0 | already registered |
  | beasley856439 | marpriceo9（全新干净） | 0（授权后仍为空） | already registered（授权后） |
  | kxoqhiq431597 / lcrlpjt52958 / kresbf379262 / liaxoo747593 | 各自 | **1（已有连接）** | none |

### 定论
- 这是 **Devin 后端 / 账号开通侧**对 gh_cli 设备授权 → 组织级 Git 连接的**转换未落地**
  （后端报 “already registered” 但 `oauth`/`git-connections` 始终为空），**不是插件代码 bug**。
- 已有 4 个账号（kxoqhiq431597 等）原生 `git-connections=1`，即组织级连接由后端预置时是成立的；
  本插件的 PAT 注入路径（`POST /api/<org>/integrations/github/pat`）仅对全新组织有效，
  对上述账号当前后端状态不可叠加。
- 建议：若需 git-auth 状态灯在本账号池可视化闭合，需后端开放 gh_cli→git-connection 的写入，
  或改用后端已预置 `git-connections=1` 的账号演示「已连接」态。

---

## 4. 凭证与安全

- 全部凭证存于本机 `~/.dao/creds.local.md`，**从不提交**进仓库（已在 .gitignore 之外手动隔离）。
- 推送使用用户提供的 PAT 直推（Devin GitHub 代理对该仓库无写权限）。
- 不修改 dao-proxy-pro；不连 141；不强推 main；不跳过 git hook。

## 5. 产物
- `plugins/dao-bridge/dao-bridge-ext/dao-bridge-2.1.0.vsix`
- `plugins/dao-vsix/dao-vsix-1.0.9.vsix`
- `plugins/devin-git-auth/devin-git-auth-2.0.0.vsix`
- 录屏（三插件实测）：随会话消息附件发送，未入库（二进制）。
