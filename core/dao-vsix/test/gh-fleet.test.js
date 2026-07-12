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
ok(/function daoGhFleetOpenPat\(/.test(src) &&
   /const safeKey = \('gh:' \+ login\)/.test(src) &&
   /daoLaunchChromiumIsolated\(url, safeKey, fp, proxy, profileDir, patExt/.test(src),
  "daoGhFleetOpenPat: 同一隔离档(gh:<login>)打开建 PAT 页+注入助手(必为本号建·不张冠李戴)");
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

// 7) GitHub 出网代理 (直连被墙网络 · 循 http.proxy/环境变量走 HTTP CONNECT 隧道)
ok(/function ghProxyUrl\(/.test(src) && /getConfiguration\('http'\)\.get\('proxy'\)/.test(src),
  "ghProxyUrl: 循 VS Code http.proxy 设置 + 代理环境变量");
ok(/function ghProxyAgent\(/.test(src) && /'CONNECT '\s*\+\s*host/.test(src),
  "ghProxyAgent: 无依赖 HTTP CONNECT 隧道 (Clash 等混合端口可用)");
ok(/const proxy = ghProxyUrl\(\);/.test(src) && /agent \? \{ agent \} : \{\}/.test(src),
  "ghApiRequest 有代理即走隧道·无代理保持直连");

// 8) GitHub 纵向板块独立鉴权 (自带 PAT · 不依赖 Devin 登录态)
ok(/!\/\^daoGh\/\.test\(String\(msg\.command \|\| ''\)\)/.test(src),
  "auth gate: daoGh* 命令免 Devin 登录(GitHub 板块独立于 Devin 账号池)");

// 9) 断网守柔 (GitHub 不可达时仍可入队 · 状态显示而非拒收)
ok(/netFail\?: boolean/.test(src) && /netFail: true/.test(src),
  "daoGhAccountVerify: HTTP 0 区分为 netFail(网络不可达 ≠ PAT 无效)");
ok(/v\.netFail && login/.test(src) && /verify: 'pending'/.test(src),
  "daoGhFleetAdd: 断网且带 login 仍入队(verify=pending)·不因断网拒收");
ok(/delete \(ex as any\)\.verify/.test(src),
  "daoGhFleetAdd: 网络恢复后验证通过即清 pending");
ok(/pending: \(a as any\)\.verify === 'pending'/.test(src) && /a\.pending/.test(src),
  "daoGhFleetList/前端: 暴露并渲染 ⏳待验证徽章");
ok(/'offline'/.test(src) && /\ud83c\udf10断网/.test(src),
  "org 核对 HTTP 0 → offline·前端显示 🌐断网(非账号问题)");
ok(/a\.verify === 'pending' \? \{ verify: 'pending' \}/.test(src),
  "loadInjectProfile: ghFleet 归一化保留 verify=pending(重载不丢待验证态)");

// 10) 跨版本多窗共档前向兼容 (旧窗保存不得抹掉新窗写入的未知顶层字段, 如 ghFleet)
ok(/out = Object\.assign\(\{\}, raw\);/.test(src) &&
   /if \(\(p as any\)\[k\] !== undefined\) out\[k\] = \(p as any\)\[k\];/.test(src),
  "saveInjectProfile: 合并磁盘档未知顶层字段·只覆盖已知字段(多窗多版本共档不互抹)");

// 11) PAT 通用配置(账号池共用·官网建 PAT 权限/有效期): 默认全 scope + 30 天·用户可调·隔离档助手预勾不自动提交
ok(/const GH_PAT_SCOPES:/.test(src) && /key: 'repo'/.test(src) && /key: 'admin:org'/.test(src) && /key: 'workflow'/.test(src),
  "GH_PAT_SCOPES: 全量 scope 清单(对齐官网)含 repo/admin:org/workflow");
ok(/const GH_PAT_EXP_DAYS:\s*number\[\]\s*=\s*\[0, 7, 30, 60, 90\]/.test(src),
  "GH_PAT_EXP_DAYS: 有效期天数(0=永不过期) 对齐官网下拉");
ok(/function _ghDefaultPatCfg\(\)[\s\S]*?expDays:\s*30/.test(src),
  "_ghDefaultPatCfg: 默认全 scope + 30 天");
ok(/function daoGhGetPatCfg\(/.test(src) && /function daoGhSavePatCfg\(/.test(src),
  "daoGhGetPatCfg/daoGhSavePatCfg: 读写账号池通用 PAT 配置");
ok(/prof\.ghPatCfg = \{ scopes: sc, expDays: ed \}/.test(src) && /const sc = Array\.isArray\(scopes\)[\s\S]*?valid\.has\(s\)/.test(src),
  "daoGhSavePatCfg: scope 白名单过滤 + 有效期归一后落档");
ok(/ghPatCfg\?:\s*\{\s*scopes:\s*string\[\];\s*expDays:\s*number\s*\}/.test(src),
  "InjectProfile 声明 ghPatCfg(仅非密元数据)");
ok(/function daoGhWritePatAssistExt\(/.test(src) && /settings\/tokens\/new\*/.test(src),
  "daoGhWritePatAssistExt: 建 PAT 页助手扩展(仅本号隔离档·匹配 tokens/new)");
{
  const patExtBlock = src.split("daoGhWritePatAssistExt")[1].slice(0, 1800);
  ok(!/\.submit\(\)/.test(patExtBlock) && /Generate token|不自动提交/.test(patExtBlock),
    "建 PAT 助手守柔: 预勾 scope/有效期但绝不自动提交");
}
ok(/scopes=' \+ encodeURIComponent\(scopeStr\)/.test(src),
  "daoGhFleetOpenPat: URL scope 由通用配置生成(非硬编码 admin:org,repo,workflow)");
for (const c of ["daoGhGetPatCfg", "daoGhSavePatCfg"]) {
  ok(new RegExp("case '" + c + "':").test(src), "消息处理: case '" + c + "'");
}
ok(/function ghPatCfgOpen\(/.test(src) && /function ghPatCfgShow\(/.test(src),
  "前端 ghPatCfgOpen/ghPatCfgShow: PAT 通用配置悬浮窗");
ok(/d\.kind==='patCfg'/.test(src) && /d\.kind==='patCfgSaved'/.test(src),
  "前端 ghOnResult 处理 patCfg / patCfgSaved 回包");
ok(/onclick="ghPatCfgOpen\(\)"/.test(src),
  "账号池区提供「⚙ PAT 通用配置」按钮");

// 12) security 多 PAT 分布式注入(规避「只能注一枚 PAT」单点) — 显示各账号 PAT 状态·可多选注入·脱敏
ok(/function _ghPatSecretName\(login: string\): string/.test(src) &&
   /'GITHUB_PAT_' \+ String\(login \|\| ''\)\.toUpperCase\(\)/.test(src),
  "_ghPatSecretName: 每账号一条 GITHUB_PAT_<LOGIN> 键名(多 PAT 分布式)");
ok(/function _ghMaskPat\(pat: string\): string/.test(src) &&
   /p\.slice\(0, 7\) \+ '…\(脱敏\)'/.test(src),
  "_ghMaskPat: PAT 仅回脱敏前缀(明文永不出前端)");
ok(/function daoGhPatStatus\(\)/.test(src) &&
   /injectedCount:/.test(src) && /patPrefix:/.test(src) && /injected,/.test(src) && /primary: isPrimary/.test(src),
  "daoGhPatStatus: 回各账号非密 PAT 状态(hasPat/injected/primary/脱敏前缀)");
{
  // daoGhPatStatus 只回脱敏元数据, 绝不回明文 PAT 值
  const psBlock = src.split("function daoGhPatStatus")[1].split("async function daoGhInjectPats")[0];
  ok(!/value:\s*pat\b/.test(psBlock) && !/pat:\s*pat\b/.test(psBlock),
    "daoGhPatStatus: 返回体不含明文 PAT 值(只 patPrefix 脱敏)");
}
ok(/async function daoGhInjectPats\(logins: string\[\], primary: string, prune: boolean\)/.test(src),
  "daoGhInjectPats: 多选账号 → 逐条注入 security(可指定主 PAT·可 prune)");
ok(/prof\.secrets\.push\(\{ name, value: pat \}\)/.test(src) &&
   /wantSecretNames\.add\(name\)/.test(src),
  "daoGhInjectPats: 每选中账号各写一条 GITHUB_PAT_<LOGIN> 密钥");
ok(/if \(!pat\) \{ skipped\.push\(\{ login: lg, reason: '无 PAT/.test(src),
  "daoGhInjectPats: 无 PAT 账号被跳过并回原因(不冒名·不回退活动号)");
ok(/const allPer = new Set\(fleet\.map\(a => _ghPatSecretName\(a\.login\)\)\);/.test(src) &&
   /prof\.secrets = prof\.secrets\.filter\(s => !\(allPer\.has\(s\.name\) && !wantSecretNames\.has\(s\.name\)\)\)/.test(src),
  "daoGhInjectPats: prune 只清未选中账号遗留的 GITHUB_PAT_* (不动主 GITHUB_PAT/非本机制密钥)");
ok(/const exP = prof\.secrets\.find\(s => s\.name === DAO_PAT_SECRET_NAME\)/.test(src) &&
   /gm\.headers = \{ \.\.\.\(gm\.headers \|\| \{\}\), Authorization: 'Bearer ' \+ patNorm \}/.test(src.split("async function daoGhInjectPats")[1].split("// 一键拷贝")[0]),
  "daoGhInjectPats: 主 PAT 写 GITHUB_PAT + 同步钉 GitHub MCP(Bearer)");
for (const c of ["daoGhPatStatus", "daoGhInjectPats"]) {
  ok(new RegExp("case '" + c + "':").test(src), "消息处理: case '" + c + "'");
}
ok(/未选择任何账号/.test(src),
  "daoGhInjectPats 处理: 空选拒绝注入");
ok(/function ghRenderPatInject\(\)/.test(src) &&
   /id="ghPatInjectList"/.test(src),
  "前端 ghRenderPatInject: 多 PAT 可多选注入清单渲染");
ok(/function ghPatSelToggle\(/.test(src) && /function ghPatInjectAll\(/.test(src) &&
   /function ghPatSetPrimary\(/.test(src) && /function ghPatInjectSel\(/.test(src),
  "前端 ghPatSelToggle/ghPatInjectAll/ghPatSetPrimary/ghPatInjectSel: 多选+主 PAT 交互");
ok(/cmd\('daoGhInjectPats',\{logins:logins,primary:st\.patPrimary\|\|'',prune:true\}\)/.test(src),
  "ghPatInjectSel: 提交所选 logins + 主 PAT 给后端");
ok(/d\.kind==='patStatus'/.test(src) && /d\.kind==='injectPats'/.test(src),
  "前端 ghOnResult 处理 patStatus / injectPats 回包");
ok(/onclick="ghPatInjectSel\(\)"/.test(src) && /注入所选到 security/.test(src),
  "多 PAT 区提供「💉 注入所选到 security」按钮");
{
  // 前端渲染函数不得把 PAT 明文写入 DOM — 只用 patPrefix(脱敏)
  const riBlock = src.split("function ghRenderPatInject")[1].split("// ④ 仅 GitHub MCP")[0];
  ok(/a\.patPrefix/.test(riBlock) && !/a\.pat\b/.test(riBlock),
    "ghRenderPatInject: 只渲染脱敏 patPrefix, 不触碰明文 a.pat");
}

console.log("[gh-fleet] " + pass + " assertion(s) passed\n");
