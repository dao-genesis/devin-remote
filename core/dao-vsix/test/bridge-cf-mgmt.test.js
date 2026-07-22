// bridge-cf-mgmt.test.js · 源级护栏: 内网穿透板块「管理 Token / Worker」(移植手机 APK cf-list-tokens/
//   cf-revoke-token/cf-delete-worker)。本源: 打通持久通道后, 用户要能在同一页列/撤 API Token、列/删
//   Worker(「也没法管理那个 token 这些东西」), 不必另开页面。凭据源恒为 relay.json 落盘的用户自有 CF
//   Bearer, 只回非密元数据, 绝不回令牌密文; 当前通道 Worker 打标防误删。
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

console.log("[dao-vsix 内网穿透 · CF Token/Worker 统管 · 源级护栏]");

// ① 凭据源 = provision 落盘的 relay.json.token(用户自有 CF Bearer), 不足 20 位视为无(OAuth-only/未打通)。
const rd = sliceFn(src, "function bridgeReadRelayCf");
ok(/function bridgeReadRelayCf\(\)/.test(src), "存在 bridgeReadRelayCf() 读凭据");
ok(/RELAY_STATE_FILE/.test(rd), "凭据源恒为 relay.json(provision 落盘)");
ok(/token\.length < 20/.test(rd), "无有效 API Token(如 OAuth-only)→ 返回 null, 不硬造");

// ② 列资源: /user/tokens + /accounts/:id/workers/scripts, 只回非密元数据, 当前通道 Worker 打标。
const lst = sliceFn(src, "async function bridgeCfListResources");
ok(/\/user\/tokens/.test(lst), "列 API Token 走 /user/tokens");
ok(/\/accounts\/' \+ cf\.accountId \+ '\/workers\/scripts/.test(lst), "列 Worker 走 /accounts/:id/workers/scripts");
ok(/RELAY_WORKER_NAME/.test(lst) && /const RELAY_WORKER_NAME = 'dao-relay-do'/.test(src), "当前通道 Worker(dao-relay-do)打 active 标, 防误删");
ok(!/token:\s*(String\(t\.token|t\.secret|t\.value)/.test(lst), "只回 id/name/status/时间, 绝不回令牌密文");

// ③ 撤销/删除: DELETE /user/tokens/:id · DELETE /accounts/:id/workers/scripts/:name?force=true。
const rev = sliceFn(src, "async function bridgeCfRevokeToken");
ok(/'DELETE', '\/user\/tokens\/' \+ encodeURIComponent\(id\)/.test(rev), "撤销 Token: DELETE /user/tokens/:id");
const del = sliceFn(src, "async function bridgeCfDeleteWorker");
ok(/'DELETE', '\/accounts\/' \+ cf\.accountId \+ '\/workers\/scripts\/'/.test(del), "删除 Worker: DELETE /accounts/:id/workers/scripts/:name");
ok(/\?force=true/.test(del), "删 Worker 带 ?force=true(连带清路由/域·不留残)");

// ④ dispatch 挂上 + 在免 Devin 登录白名单(与其它 relay/bridge 命令一致)。
ok(/case 'cfListResources':/.test(src) && /case 'cfRevokeToken':/.test(src) && /case 'cfDeleteWorker':/.test(src), "三命令均挂 dispatch");
ok(/'cfListResources', 'cfRevokeToken', 'cfDeleteWorker'/.test(src), "三命令在 noAuthNeeded 白名单");
ok(/reply\(\{ type: 'bridgeCfResources'/.test(src), "回包 type=bridgeCfResources(撤/删后回传最新清单)");

// ⑤ 前端: 渲染 + 撤销/删除确认 + 仅在已打通(active)卡片内出现。
ok(/function rCfResources\(\)/.test(src), "前端 rCfResources() 渲染 Token/Worker 清单");
ok(/function cfRevoke\(id,name\)/.test(src) && /(daoConfirm|confirm)\('撤销 API Token/.test(src), "撤销 Token 前二次确认(不可逆)");
ok(/function cfDelWorker\(name,active\)/.test(src) && /当前持久通道 Worker/.test(src), "删当前通道 Worker 有强警示确认");
ok(/id="cfResBox"/.test(src) && /cmd\(&#39;cfListResources&#39;\)/.test(src), "已打通卡片内挂『管理 Token/Worker』区 + 加载按钮");
ok(/d\.type==='bridgeCfResources'/.test(src), "前端 message 处理 bridgeCfResources → 刷新 cfResBox");

console.log("全部通过 (" + pass + " 项)");
