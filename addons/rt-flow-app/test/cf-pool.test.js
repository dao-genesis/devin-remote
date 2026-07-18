"use strict";
// cf-pool.js 纯逻辑护栏: 万法识号→CF 池、凭证判类、闭环建法路由、多号合并统管、打码/状态。
//   无框架: node test/cf-pool.test.js (退出码非 0 即失败)。
const assert = require("assert");
const path = require("path");
const CFP = require(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "cf-pool.js"));
const { parseAccountText } = require(path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "rtflow-parse.js"));

let failures = 0;
function ok(c, msg) { if (c) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 1) 凭证判类: Global API Key(37hex) / API Token(40 urlsafe) / 普通密码
ok(CFP.classifySecret("a".repeat(37)) === "key", "37 位 hex → key (Global API Key)");
ok(CFP.classifySecret("0123456789abcdef0123456789abcdef01234") === "key", "真实形态 37 hex → key");
ok(CFP.classifySecret("Ab_3-".padEnd(40, "x")) === "token", "40 位 urlsafe → token");
ok(CFP.classifySecret("dfgf123ccC!") === "password", "普通密码含符号 → password");
ok(CFP.classifySecret("hunter2") === "password", "短密码 → password");

// 2) 万法识号: email password 一行 → 池记录 (password 归类正确)
let p = CFP.parsePool("ssffcbd80201@hotmail.com dfgf123ccC!", parseAccountText);
ok(p.length === 1 && p[0].email === "ssffcbd80201@hotmail.com" && p[0].password === "dfgf123ccC!", "email password → {email,password}");
ok(!p[0].key && !p[0].token, "普通密码不被误判为 key/token");

// 2b) email + Global API Key 一行 → 归类为 key (不作密码)
let pk = CFP.parsePool("fib@r2cloud.ccwu.cc " + "0123456789abcdef0123456789abcdef01234", parseAccountText);
ok(pk.length === 1 && pk[0].email === "fib@r2cloud.ccwu.cc" && pk[0].key && !pk[0].password, "email + 37hex → {email,key}");

// 2c) 多行·多格式混合 (email:password / 邮箱 密码) 皆识别
let pm = CFP.parsePool("a@x.com pass1\nb@y.com:pass2", parseAccountText);
ok(pm.length === 2 && pm[0].email === "a@x.com" && pm[1].password === "pass2", "多行多格式皆识号");

// 3) 建法路由: key/token 纯后端; email+password 走浏览器登录闭环; 缺凭证 none
ok(CFP.buildMethod({ email: "a@x.com", key: "k" }) === "key", "key+email → key 法");
ok(CFP.buildMethod({ token: "t" }) === "token", "token → token 法");
ok(CFP.buildMethod({ email: "a@x.com", password: "p" }) === "login", "email+password → login 闭环法");
ok(CFP.buildMethod({ email: "a@x.com" }) === "none", "只有邮箱 → none");

// 3b) provisionPayload: 纯后端两法给出 body; login 走浏览器 → null
assert.deepStrictEqual(CFP.provisionPayload({ email: "a@x.com", key: "k" }), { email: "a@x.com", apiKey: "k" });
assert.deepStrictEqual(CFP.provisionPayload({ token: "t" }), { token: "t" });
ok(CFP.provisionPayload({ email: "a@x.com", password: "p" }) === null, "login 法无纯后端 payload (走浏览器)");

// 4) 多号合并统管: 同邮箱更新凭证但保留已建资源/状态; 异邮箱新增
let base = [{ email: "a@x.com", password: "old", workerUrl: "https://w.a", accountId: "acc1", phase: "done" }];
let merged = CFP.mergePool(base, CFP.parsePool("a@x.com newpass\nb@y.com bpass", parseAccountText));
ok(merged.added === 1 && merged.updated === 1, "合并: 1 新增 1 更新");
let a = merged.pool.find(e => e.email === "a@x.com");
ok(a.password === "newpass" && a.workerUrl === "https://w.a" && a.phase === "done", "同号更新密码但保留已建 Worker/状态");

// 5) 去重: 同邮箱粘两次只保留一条 (凭证以后者为准)
let dup = CFP.parsePool("a@x.com p1\na@x.com p2", parseAccountText);
ok(dup.length === 1 && dup[0].password === "p2", "同邮箱池内去重·后者为准");

// 6) 打码: 永不明文回显
ok(CFP.maskSecret("0123456789abcdef") === "0123…cdef", "长密钥打码保留首尾");
ok(CFP.maskSecret("") === "", "空值打码为空");

// 7) 状态标签 + 已建资源统计
ok(/待建/.test(CFP.statusLabel({ email: "a@x.com", password: "p" })), "有凭证未建 → 待建");
ok(/凭证不足/.test(CFP.statusLabel({ email: "a@x.com" })), "缺凭证 → 提示补密码");
ok(/已就绪/.test(CFP.statusLabel({ phase: "done", healthy: true, workerUrl: "https://w" })), "done+healthy → 已就绪");
ok(/失败/.test(CFP.statusLabel({ phase: "error", msg: "boom" })), "error → 失败");
let res = CFP.builtResources([{ email: "a@x.com", workerUrl: "https://w.a", accountId: "acc1" }, { email: "b@y.com" }]);
ok(res.length === 1 && res[0].workerUrl === "https://w.a", "builtResources 只列已建成 Worker 的号");

// 8) 万法识号·GitHub 账号 (用户名+密码+TOTP) 自动分流入池 (不与 CF 邮箱账号混淆)
let gh = CFP.parsePool("shapetersonv1 3yBSdOHQFWZog LVUGH4AI7URB2OOI", parseAccountText);
ok(gh.length === 1 && gh[0].provider === "github" && gh[0].ghUser === "shapetersonv1", "GitHub 用户名+密码+TOTP → {provider:github,ghUser}");
ok(gh[0].ghPass === "3yBSdOHQFWZog" && gh[0].ghOtp === "LVUGH4AI7URB2OOI", "GitHub 密码/TOTP 按语义精确归位");

// 8b) md 表格行 (含 Role 列 + ghp_ PAT) 也识别: user|role|pass|totp|pat
let ght = CFP.parsePool("| shapetersonv1 | Owner | 3yBSdOHQFWZog | LVUGH4AI7URB2OOI | ghp_" + "x".repeat(36) + " |", parseAccountText);
ok(ght.length === 1 && ght[0].ghUser === "shapetersonv1" && ght[0].ghPass === "3yBSdOHQFWZog" && ght[0].ghOtp === "LVUGH4AI7URB2OOI", "md 表格行 (Role 列) → TOTP 前一字段为密码");
ok(/^ghp_/.test(ght[0].ghPat || ""), "md 表格行捕获 ghp_ PAT");

// 8c) 显式前缀 gh:/github: 即使无 TOTP 也判为 GitHub
let ghp = CFP.parsePool("gh: someuser somepass", parseAccountText);
ok(ghp.length === 1 && ghp[0].provider === "github" && ghp[0].ghUser === "someuser" && ghp[0].ghPass === "somepass", "gh: 前缀显式判为 GitHub");

// 8d) 强信号门槛: 无 TOTP/无 PAT/无前缀 的「用户名 密码」不误判为 GitHub
let noise = CFP.parseGithubLines("hello world");
ok(noise.length === 0, "普通两词行无强信号 → 不误判 GitHub");

// 8e) 邮箱行不被 GitHub 解析器抢走 (仍走 CF 路径)
ok(CFP.parseGithubLines("a@x.com pass LVUGH4AI7URB2OOI").length === 0, "邮箱首字段 → 不判 GitHub (CF 直登可带 2FA)");

// 8f) CF 与 GitHub 混合多行 → 各自分流入池·键不冲突
let mix = CFP.parsePool("a@x.com pass1\nshapetersonv1 ghpass LVUGH4AI7URB2OOI", parseAccountText);
ok(mix.length === 2 && mix.some(e => e.email === "a@x.com") && mix.some(e => e.provider === "github"), "CF+GitHub 混合各自入池");

// 8g) 判类器边界
ok(CFP.isTotpSeed("LVUGH4AI7URB2OOI") === true && CFP.isTotpSeed("cO6WlSdTohiRtayv") === false, "TOTP 种子=大写 base32; 含小写的强密码不误判为种子");
ok(CFP.isGhUser("shapeterson-v1") === true && CFP.isGhUser("a@x.com") === false, "GitHub 用户名判定 (排除邮箱)");
ok(CFP.isGhPat("ghp_" + "a".repeat(36)) === true, "ghp_ PAT 判定");

// 9) buildMethod / autoPayload: GitHub 走 SSO; CF 直登
ok(CFP.buildMethod({ provider: "github", ghUser: "u", ghPass: "p" }) === "github", "github 号 → github 法");
ok(CFP.buildMethod({ provider: "github", ghUser: "u" }) === "none", "github 缺密码 → none");
assert.deepStrictEqual(CFP.autoPayload({ provider: "github", ghUser: "u", ghPass: "p", ghOtp: "S".repeat(16) }),
  { provider: "github", ghUser: "u", ghPass: "p", ghOtp: "S".repeat(16) }, "github autoPayload");
assert.deepStrictEqual(CFP.autoPayload({ email: "a@x.com", password: "p" }),
  { provider: "cloudflare", email: "a@x.com", password: "p" }, "cloudflare autoPayload");
assert.deepStrictEqual(CFP.autoPayload({ email: "a@x.com", password: "p", accountId: "acc1" }),
  { accountId: "acc1", provider: "cloudflare", email: "a@x.com", password: "p" }, "autoPayload 带 accountId");
ok(CFP.autoPayload({ token: "t" }) === null, "纯后端 token 无离屏编排 payload");

// 9b) siteUrl / displayName
ok(CFP.siteUrl({ email: "a@x.com" }) === "https://dash.cloudflare.com/login", "未建 → 开 CF 登录页");
ok(CFP.siteUrl({ email: "a@x.com", workerUrl: "https://w" }) === "https://dash.cloudflare.com/", "已建 → 开 CF 仪表盘");
ok(CFP.displayName({ provider: "github", ghUser: "u" }) === "u" && CFP.displayName({ email: "a@x.com" }) === "a@x.com", "displayName 两类");
ok(CFP.accountType({ provider: "github" }) === "github" && CFP.accountType({ email: "a@x.com" }) === "cloudflare", "accountType 两类");

// 9c) 状态标签: github 待建 / 已有 Worker 时错误不覆盖资源就绪
ok(/GitHub/.test(CFP.statusLabel({ provider: "github", ghUser: "u", ghPass: "p" })), "github 待建标签含 GitHub");
ok(/已建|已就绪/.test(CFP.statusLabel({ workerUrl: "https://w" })), "有 Worker → 已建 (不因历史无状态而空)");

// 9d) 合并: github 号同用户名去重·保留已建资源
let gbase = [{ provider: "github", ghUser: "u", ghPass: "old", workerUrl: "https://w", phase: "done" }];
let gm = CFP.mergePool(gbase, CFP.parsePool("gh: u newpass", parseAccountText));
let gu = gm.pool.find(e => e.provider === "github");
ok(gm.added === 0 && gm.updated === 1 && gu.ghPass === "newpass" && gu.workerUrl === "https://w", "github 同号更新密码保留 Worker");

console.log(failures ? ("\nFAIL " + failures) : "\nALL GREEN (cf-pool)");
process.exit(failures ? 1 : 0);
