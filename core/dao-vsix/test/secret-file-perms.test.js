// secret-file-perms.test.js · 源级护栏: 凭据落盘一律 writeSecretFile(0600/0700)。
//
// 病灶(已修): api-token / relay.json / cf-credentials.json / named-tunnel.json /
//   dao-accounts-auth.json 等含令牌/凭证/Cookie 的文件以默认 umask(0644) 落盘,
//   同机其他用户可直接窃读 Bearer/CF API Token/Devin auth1。
// 正法: writeSecretFile — 目录 0700、文件 0600、写后 chmod 兜底(非 POSIX 平台守柔)。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 凭据落盘 0600 · 源级护栏]");

ok(/function writeSecretFile\(/.test(src), "存在 writeSecretFile 助手");
ok(/mode:\s*0o600/.test(src), "writeSecretFile 以 0600 写文件");
ok(/mode:\s*0o700/.test(src), "writeSecretFile 以 0700 建目录");
ok(/chmodSync\([^)]*0o600\)/.test(src), "写后 chmod 0600 兜底(文件已存在时收紧)");

// 已知凭据文件绝不再走裸 fs.writeFileSync(默认 0644)
const secretFiles = [
  "tunnel-token",
  "named-tunnel.json",
  "auth-token",
  "last-inject.json",
  "plugin-api.json",
];
for (const f of secretFiles) {
  const re = new RegExp("fs\\.writeFileSync\\([^\\n]*'" + f.replace(".", "\\.") + "'");
  ok(!re.test(src), `${f} 不再走裸 fs.writeFileSync`);
}
ok(!/fs\.writeFileSync\(RELAY_STATE_FILE/.test(src), "relay.json(RELAY_STATE_FILE) 不再走裸 fs.writeFileSync");
ok(!/fs\.writeFileSync\(DAO_CONN_CURRENT/.test(src), "dao-conn-current.json 不再走裸 fs.writeFileSync");
ok(!/fs\.writeFileSync\(DAO_CONN_REGISTRY/.test(src), "dao-conn.json(注册表) 不再走裸 fs.writeFileSync");
ok(!/fs\.writeFileSync\(bridgeCfCredFile\(\)/.test(src), "cf-credentials.json 不再走裸 fs.writeFileSync");
ok(!/fs\.writeFileSync\(WEB_COOKIE_FILE/.test(src), "web-cookies 不再走裸 fs.writeFileSync");
ok(!/fs\.writeFileSync\(ACCOUNTS_AUTH_FILE/.test(src), "dao-accounts-auth.json 不再走裸 fs.writeFileSync");

// 启动时一次性收紧存量文件(旧版 0644 落盘的遗留)
ok(/function hardenSecretFilePerms\(/.test(src), "存在 hardenSecretFilePerms 存量收紧");
ok(/hardenSecretFilePerms\(\);/.test(src.slice(src.indexOf("export async function activate"))), "activate 启动即收紧存量凭据文件");

console.log(`✅ 全部通过 (${pass})`);
