// gh-fleet.test.js · 源级护栏: GitHub 板块「独立舰队」(纯 GitHub 账号·与 Devin 池分离)。
//
// 本源(AGENTS §二 + 用户需求): GitHub 与 Devin 完全分离。切号板块管 Devin 账号池;
//   GitHub 板块的「独立舰队」管纯 GitHub 账号(login+各自 PAT+组织角色), 支持管理者↔成员
//   随意互转、移出组织、本地删除(封号即换)。角色变更走本体组织的 admin PAT(GITHUB_PAT)。
// 本护栏钉死该契约: 独立存档字段 ghFleet、四类后端消息处理、幂等角色互转 API、前端渲染。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix GitHub 独立舰队 · 源级护栏]");

// 1) 独立存档字段 ghFleet (与 Devin 池分离·持久化于注入档)
ok(/ghFleet\?:\s*\{\s*login:\s*string;\s*pat\?:\s*string;\s*role\?:\s*string/.test(src),
  "InjectProfile 声明独立 ghFleet 字段 (login+pat+role)");
ok(/ghFleet:\s*Array\.isArray\(j\.ghFleet\)/.test(src),
  "loadInjectProfile 解析持久化 ghFleet");

// 2) 后端 API: 校验/加入/列表/互转/移出组织/本地删
ok(/async function daoGhAccountVerify\(/.test(src), "daoGhAccountVerify: 校验单个 GitHub PAT (GET /user)");
ok(/async function daoGhFleetAdd\(/.test(src), "daoGhFleetAdd: 批量校验并加入独立舰队");
ok(/async function daoGhFleetList\(/.test(src), "daoGhFleetList: 舰队清单+组织在线角色核对");
ok(/async function daoGhFleetSetRole\(/.test(src), "daoGhFleetSetRole: 管理者↔成员互转");
ok(/async function daoGhFleetRemoveFromOrg\(/.test(src), "daoGhFleetRemoveFromOrg: 移出组织 membership");
ok(/function daoGhFleetForget\(/.test(src), "daoGhFleetForget: 从本地舰队删除(封号即换)");

// 3) 角色互转必须幂等 PUT membership 且用本体组织 admin PAT
ok(/ghApiRequest\('PUT',\s*'\/orgs\/'\s*\+\s*encodeURIComponent\(org\)\s*\+\s*'\/memberships\/'/.test(src),
  "互转走 PUT /orgs/{org}/memberships/{login} (幂等设角色)");
ok(/ghApiRequest\('DELETE',\s*'\/orgs\/'\s*\+\s*encodeURIComponent\(org\)\s*\+\s*'\/memberships\/'/.test(src),
  "移出组织走 DELETE /orgs/{org}/memberships/{login}");

// 4) 消息处理挂接
for (const c of ["daoGhFleetAdd", "daoGhFleetList", "daoGhFleetRole", "daoGhFleetRemoveOrg", "daoGhFleetForget"]) {
  ok(new RegExp("case '" + c + "':").test(src), "消息处理: case '" + c + "'");
}

// 5) 前端: 独立舰队卡片 + 渲染器(与 Devin 账号池 ghAcctList 分离)
ok(/ghGhFleetList/.test(src), "前端存在独立舰队容器 ghGhFleetList");
ok(/function ghRenderGhFleet\(/.test(src), "前端渲染器 ghRenderGhFleet");
ok(/function ghFleetAdd\(|function ghFleetRole\(|function ghFleetForget\(/.test(src),
  "前端交互函数 ghFleetAdd/ghFleetRole/ghFleetForget 存在");

// 6) 半登录账号「续登助手」(账密存号→隔离档续登+隔离档建 PAT·守柔不无头·不张冠李戴)
ok(/function ghTotp\(/.test(src) && /function ghBase32Decode\(/.test(src),
  "本地 TOTP(RFC6238): ghTotp + ghBase32Decode(2FA 当前码本地出示·seed 不外传)");
ok(/function daoGhWriteLoginAssistExt\(/.test(src),
  "续登助手扩展(仅本号隔离 profile·自动填充不自动提交)");
ok(/不自动提交|autofill|自动填充/.test(src) && !/\.submit\(\)/.test(src.split("daoGhWriteLoginAssistExt")[1].slice(0, 1200)),
  "续登助手守柔: 自动填充但绝不自动提交(不做无头登录)");
ok(/async function daoGhFleetAssistLogin\(/.test(src),
  "daoGhFleetAssistLogin: 该号专属隔离档打开 GitHub 登录页 + 填充");
ok(/function daoGhFleetOpenPat\(/.test(src) && /launchIsolatedBrowser\(url,\s*'gh:'/.test(src),
  "daoGhFleetOpenPat: 同一隔离档打开建 PAT 页(必为本号建·不张冠李戴)");
ok(/无有效 auth1|该账号无账密存号|账号不在池中/.test(src),
  "无账密存号/不在池中 → 明确报错(不回退活动号)");
for (const c of ["daoGhFleetAssistLogin", "daoGhFleetOpenPat"]) {
  ok(new RegExp("case '" + c + "':").test(src), "消息处理: case '" + c + "'");
}
ok(/function ghAssistLogin\(/.test(src) && /function ghFleetOpenPat\(/.test(src),
  "前端交互函数 ghAssistLogin / ghFleetOpenPat 存在");
ok(/hasCred:\s*!!\(a\.cred/.test(src),
  "daoGhFleetList 暴露 hasCred(前端据此显示半登录🔓+续登按钮)");
ok(/d\.kind==='assistLogin'/.test(src) && /d\.kind==='fleetOpenPat'/.test(src),
  "前端 ghOnResult 处理 assistLogin / fleetOpenPat 回包");

console.log("[gh-fleet] " + pass + " assertion(s) passed\n");
