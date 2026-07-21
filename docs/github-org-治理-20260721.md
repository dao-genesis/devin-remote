# dao-genesis GitHub 组织治理现状 · 2026-07-21

> 本文只记组织成员治理状态与操作路径，**不含任何凭证明文**（密码/PAT/TOTP 一律不落盘）。

## 本轮治理（已完成·API 复核）

### 清理（移出组织）
| 账号 | 原因 |
|---|---|
| avidyenesset | 已被 GitHub 封停（PAT 403） |
| ferryhealt | 失联/失效 |
| ndmd0jm3zg46 | 失联/失效 |

### 新增管理者（组织 owner·均 active）
| 账号 | 状态 |
|---|---|
| ner-kellye | state=active · role=admin |
| ach-charlesj | state=active · role=admin |
| leslie-backus539r | state=active · role=admin |

## 治理后组织现状

- 管理者（8）：ShihanChen-fv0 · ach-charlesj · burdyfa2894 · hendrawgh · leslie-backus539r · nedithvjbarrett · ner-kellye · shapetersonv1
- 普通成员（6）：bigmikajia · danceyikinh · hoxflyongzh · mlance-gamve · oulnuray · oumanushinilla
- 待接受邀请：无

## 操作要点（复用手册）

1. **加管理者**：`POST /orgs/dao-genesis/invitations`（带 GitHub user id + `role=admin`），
   而不是 `PUT /orgs/.../memberships/<login>`（后者对新号常落 inactive/unaffiliated）。
2. **强制 2FA 复核关卡**：新号登录后若被 GitHub 拦在
   「You can no longer delay 2FA verification」页面，直达
   `https://github.com/settings/two_factor_checkup`，向 `#app_totp` 提交**新窗口期**的
   TOTP（避开 30s 周期末尾），通过后再回 `/orgs/dao-genesis/invitation` 点 Join。
3. **移出成员**：`DELETE /orgs/dao-genesis/members/<login>`；操作前先
   `GET /orgs/dao-genesis/memberships/<login>` 精确确认目标，杜绝误删。
4. 账号级 401/Invalid password 属**账号问题**，不是系统缺陷，单独归因。

## 凭据轮换建议

- 治理涉及的三个新号密码/TOTP 曾经会话链路传递，建议用户择机自行轮换。
- 被移出账号的历史 PAT（如仍在注入档案 `~/.dao/dao-inject-profile.json`）应一并清退。
