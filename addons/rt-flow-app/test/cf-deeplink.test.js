"use strict";
// 断言 tunnel.html 的 _cfTokenDeepLink() 生成的「预填权限」Create Token 深链, 其五项权限
// 与 dao-vsix daoRelayTokenDeepLink / addons/dao-relay provision.mjs 单一同源 (逐项一致),
// 且 URL 指向 dash.cloudflare.com/profile/api-tokens 并带 permissionGroupKeys/name。
// 改一处权限必须两处同步 —— 偏差即此断言红。无框架: node test/cf-deeplink.test.js。
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "tunnel.html"), "utf8");

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// eval-slice _cfTokenDeepLink from tunnel.html
const start = HTML.indexOf("function _cfTokenDeepLink(");
ok(start >= 0, "tunnel.html 含 _cfTokenDeepLink()");
const slice = HTML.slice(start);
const endMarker = "\n}";
const end = slice.indexOf(endMarker);
const body = slice.slice(0, end + endMarker.length);
const fn = new Function("return (" + body + ")")();

const url = fn("dao-relay");
ok(/^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?/.test(url), "深链指向 dash.cloudflare.com/profile/api-tokens");

const q = new URLSearchParams(url.split("?")[1]);
ok(q.get("name") === "dao-relay", "name=dao-relay");
ok(q.get("accountId") === "*", "accountId=*");
ok(q.get("zoneId") === "all", "zoneId=all");

const perms = JSON.parse(q.get("permissionGroupKeys"));
// 与 dao-vsix daoRelayTokenDeepLink 逐项同源 (顺序+key+type)
const EXPECT = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "account_settings", type: "read" },
  { key: "zone", type: "read" },
  { key: "workers_routes", type: "edit" },
];
ok(JSON.stringify(perms) === JSON.stringify(EXPECT), "五项权限与 dao-relay 规范逐项一致 (workers_scripts/kv/account/zone/routes)");

console.log(failures ? ("\nFAIL " + failures) : "\nALL GREEN (cf-deeplink)");
process.exit(failures ? 1 : 0);
