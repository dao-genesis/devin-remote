// bridge-cf-pool.test.js · 源级护栏: 内网穿透板块「CF 账号池 · 多号统管」(电脑端做得比手机端更全,
//   移植 addons/rt-flow-app cf-pool.js 池哲学)。本源: 过去电脑端只管单一持久通道账号(relay.json);
//   此处引入账号池 —— 粘贴任意格式的多账号凭证→识号入池→用各号自己的 Bearer/Global API Key 直连
//   CF API 逐号列/撤 API Token、列/删 Worker, 多号并列统一管理, 无需逐个登录 dash.cloudflare.com。
//   凭证只落 ~/.dao/cf-pool.json(600), 回包只出非密元数据。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }
function sliceFn(s, decl) {
    const start = s.indexOf(decl);
    if (start < 0) return "";
    const rest = s.slice(start + decl.length);
    const nexts = [/\n(async function |function |case ')/, /\n\/\/ [^\n]*\n(async function|function)/]
        .map(re => { const m = re.exec(rest); return m ? m.index : -1; })
        .filter(x => x > 0);
    const end = nexts.length ? Math.min(...nexts) : rest.length;
    return s.slice(start, start + decl.length + end);
}

console.log("[dao-vsix 内网穿透 · CF 账号池 · 多号统管 · 源级护栏]");

// ① 凭据判类与手机 cf-pool.js 同构: Global API Key=37hex, API Token=40 urlsafe, 余=密码。
const cls = sliceFn(src, "function cfClassifySecret");
ok(/\[a-f0-9\]\{37\}/i.test(cls) && /return 'key'/.test(cls), "Global API Key = 37 位 hex → key");
ok(/\[A-Za-z0-9_-\]\{40\}/.test(cls) && /return 'token'/.test(cls), "API Token = 40 位 urlsafe → token");
ok(/return 'password'/.test(cls), "其余 → password");

// ② 任意格式粘贴解析 + 去重键(邮箱/token/key)。
ok(/function cfParsePoolText\(/.test(src), "cfParsePoolText 解析多行任意格式凭证");
const key = sliceFn(src, "function cfPoolKeyOf");
ok(/'email:'/.test(key) && /'token:'/.test(key) && /'key:'/.test(key), "去重键: 邮箱优先, 否则 token/key");

// ③ 池落盘于 ~/.dao/cf-pool.json, 权限 600, 绝不经回包外泄明文。
ok(/const CF_POOL_FILE = path\.join\(DAO_DIR, 'cf-pool\.json'\)/.test(src), "凭证落盘 ~/.dao/cf-pool.json");
const wr = sliceFn(src, "function bridgeCfPoolWrite");
ok(/mode: 0o600/.test(wr) && /chmodSync\(CF_POOL_FILE, 0o600\)/.test(wr), "池文件 600 权限(与其它密文落盘一致)");
const lst = sliceFn(src, "function bridgeCfPoolList");
ok(!/token: e\.token|key: e\.key|password: e\.password/.test(lst), "清单只出非密元数据(cred 类型标签), 绝不回令牌密文");
ok(/cred: e\.token \? 'token'/.test(lst) && /canApi:/.test(lst), "清单出 cred 类型 + canApi(可否纯 API 统管)");

// ④ 双鉴权直连: Bearer Token 或 Global API Key(X-Auth-Email/X-Auth-Key)。
const auth = sliceFn(src, "function bridgeCfApiRequestAuth");
ok(/'Authorization'\] = 'Bearer ' \+ auth\.token/.test(auth), "有 Token → Bearer 鉴权");
ok(/X-Auth-Email/.test(auth) && /X-Auth-Key/.test(auth), "有 Global API Key → X-Auth-Email/X-Auth-Key 鉴权");
const ea = sliceFn(src, "function cfEntryAuth");
ok(/return null/.test(ea), "仅邮箱+密码(无 Token/Key)→ null(需登录建 token, 不硬造)");

// ⑤ 逐号列资源: /accounts 解析 accountId + /user/tokens + /accounts/:id/workers/scripts, 当前通道打标。
const res = sliceFn(src, "async function bridgeCfPoolResources");
ok(/\/user\/tokens/.test(res), "列 API Token 走 /user/tokens");
ok(/\/accounts\/' \+ accountId \+ '\/workers\/scripts/.test(res), "列 Worker 走 /accounts/:id/workers/scripts");
ok(/active: nm === RELAY_WORKER_NAME/.test(res), "当前持久通道 Worker 打 active 标, 防误删");
ok(/needLogin: true/.test(res), "仅密码账号 → needLogin 提示先登录建 token");

// ⑥ 逐号撤销/删除: DELETE /user/tokens/:id · DELETE /accounts/:id/workers/scripts/:name?force=true。
const rev = sliceFn(src, "async function bridgeCfPoolRevokeToken");
ok(/'DELETE', '\/user\/tokens\/' \+ encodeURIComponent\(id\)/.test(rev), "撤销 Token: DELETE /user/tokens/:id(用该号凭证)");
const del = sliceFn(src, "async function bridgeCfPoolDeleteWorker");
ok(/'DELETE', '\/accounts\/' \+ e\.accountId \+ '\/workers\/scripts\/'/.test(del) && /\?force=true/.test(del), "删除 Worker: DELETE /accounts/:id/workers/scripts/:name?force=true");

// ⑦ dispatch 六命令均挂 + 在免 Devin 登录白名单(与其它 relay/cf 命令一致)。
ok(/case 'cfPoolList':/.test(src) && /case 'cfPoolAdd':/.test(src) && /case 'cfPoolRemove':/.test(src) && /case 'cfPoolResources':/.test(src) && /case 'cfPoolRevokeToken':/.test(src) && /case 'cfPoolDeleteWorker':/.test(src), "六命令均挂 dispatch");
ok(/'cfPoolList', 'cfPoolAdd', 'cfPoolRemove', 'cfPoolResources', 'cfPoolRevokeToken', 'cfPoolDeleteWorker'/.test(src), "六命令在 noAuthNeeded 白名单");
ok(/reply\(\{ type: 'bridgeCfPool'/.test(src) && /reply\(\{ type: 'bridgeCfPoolResources'/.test(src), "回包 type=bridgeCfPool / bridgeCfPoolResources");

// ⑧ 前端: 渲染池 + 识号入池 + 逐号管理资源 + 撤/删二次确认 + message 处理。
ok(/function rCfPool\(\)/.test(src) && /function rCfPoolRes\(/.test(src), "前端 rCfPool()/rCfPoolRes() 渲染池与逐号资源");
ok(/function cfPoolAdd\(\)/.test(src) && /cmd\('cfPoolAdd'/.test(src), "识号入池调 cfPoolAdd");
ok(/function cfPoolRevoke\(kb,id,name\)/.test(src) && /(daoConfirm|confirm)\('撤销 API Token/.test(src), "撤销 Token 前二次确认(不可逆)");
ok(/function cfPoolDelWorker\(kb,name,active\)/.test(src) && /当前持久通道 Worker/.test(src), "删当前通道 Worker 有强警示确认");
ok(/id="cfPoolBox"/.test(src) && /d\.type==='bridgeCfPool'/.test(src) && /d\.type==='bridgeCfPoolResources'/.test(src), "面板挂 CF 账号池区 + message 处理刷新");

// ⑨ 「Token 权限拉满」纯后端直建(凭 Global API Key/Token · 无需浏览器登录 · 绕过 Turnstile):
//    partition 全部权限组按 scope → 账号级/用户级/zone 级各建 allow=* 策略 → POST /user/tokens。
const pol = sliceFn(src, "function cfBuildMaxScopePolicies");
ok(/com\.cloudflare\.api\.account\.' \+ accountId/.test(pol) && /effect: 'allow'/.test(pol), "账号级策略 allow=* on com.cloudflare.api.account.<id>");
ok(/com\.cloudflare\.api\.user\.' \+ userId/.test(pol), "用户级策略 allow=* on com.cloudflare.api.user.<id>(令牌可自管理)");
ok(/com\.cloudflare\.api\.account\.zone\.\*/.test(pol), "zone 级策略 allow=* on account.zone.*(供绑自定义域)");
const mint = sliceFn(src, "async function bridgeCfPoolMintToken");
ok(/\/user\/tokens\/permission_groups/.test(mint), "取全部权限组走 /user/tokens/permission_groups");
ok(/'POST', '\/user\/tokens'/.test(mint) && /policies/.test(mint), "POST /user/tokens 建 Token(拉满 policies)");
ok(/e\.token = String\(cr\.json\.result\.value\)/.test(mint) && /bridgeCfPoolWrite\(pool\)/.test(mint), "新 Token value 落回池(600·供后续统管/复制)");
ok(/needLogin: true/.test(mint), "仅密码账号 → needLogin(不硬造·需先过 Turnstile 登录)");

// ⑩ Token 明文提取只经宿主剪贴板(绝不回传 webview): copyToken 读值 → vscode.env.clipboard。
const cpv = sliceFn(src, "function bridgeCfPoolTokenValue");
ok(/return \(e && e\.token\) \? String\(e\.token\) : ''/.test(cpv), "bridgeCfPoolTokenValue 只在后端取明文");
ok(/case 'cfPoolCopyToken':/.test(src) && /vscode\.env\.clipboard\.writeText\(v\)/.test(src), "复制 Token 经宿主剪贴板(不回传 webview·守密)");
ok(/case 'cfPoolMintToken':/.test(src), "建 Token 命令挂 dispatch");
ok(/'cfPoolMintToken', 'cfPoolCopyToken'/.test(src), "建/复制 Token 在 noAuthNeeded 白名单");
ok(/function cfPoolMint\(kb\)/.test(src) && /🔑 建 Token\(拉满\)/.test(src), "前端「建 Token(拉满)」按钮 + 二次确认");
ok(/function cfPoolCopyToken\(kb\)/.test(src) && /hasToken\?/.test(src), "已落盘 Token 号出「复制 Token」按钮(hasToken 条件)");

console.log("全部通过 (" + pass + " 项)");
