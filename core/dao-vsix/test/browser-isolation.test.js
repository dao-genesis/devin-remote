// browser-isolation.test.js · 多账号指纹隔离引擎护栏 (帛书「知其白·守其黑·恆德不貳」)
//
// 需求: 多号同机同 IP 登 GitHub/Devin → 被按「设备指纹+IP+Cookie」三重关联, 一号封殃及全组织。
// 正法: 每号一套隔离档案 —— user-data-dir(原有) + 出口代理 + 确定性指纹 + 指纹注入扩展。
// 本测试锁定:
//   ① 指纹确定性: 同 key 恒得同指纹 (不自相矛盾, 跨会话一致)
//   ② 指纹独立性: 异 key 指纹显著分散 (断关联)
//   ③ launchIsolatedBrowser 落实 代理/UA/语言/时区/注入扩展
//   ④ /api/browser/isolation 与 /api/browser/proxy 端点在册, 且代理凭证脱敏
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { transform } = require("sucrase");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 多账号指纹隔离引擎 · 护栏]");

// —— 运行时: 抽取纯函数 daoFpSeed + daoAcctFingerprint, sucrase 转译后求值 ——
function slice(name) {
    const i = src.indexOf("function " + name);
    assert.ok(i > 0, "源含 " + name);
    // 括号配平截取整个函数体
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        const c = src[j];
        if (c === "{") { depth++; started = true; }
        else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
}
const mod = slice("daoFpSeed") + "\n" + slice("daoAcctFingerprint") +
    "\nmodule.exports = { daoFpSeed, daoAcctFingerprint };\n";
const js = transform(mod, { transforms: ["typescript"] }).code;
const sandbox = { module: { exports: {} }, Math, Object, String };
sandbox.exports = sandbox.module.exports;
new Function("module", "exports", "Math", "Object", "String", js)(
    sandbox.module, sandbox.module.exports, Math, Object, String);
const { daoFpSeed, daoAcctFingerprint } = sandbox.module.exports;

// ① 确定性
const k1 = "alice@example.com";
const a = daoAcctFingerprint(k1), b = daoAcctFingerprint(k1);
ok(JSON.stringify(a) === JSON.stringify(b), "同 key 指纹完全一致 (恆德不貳)");
ok(daoFpSeed(k1) === daoFpSeed(k1) && daoFpSeed("x") !== daoFpSeed("y"), "FNV 种子确定且区分");

// ② 独立性: 采样多号, UA/时区/分辨率/GPU 组合应显著分散
const keys = [];
for (let i = 0; i < 40; i++) keys.push("user" + i + "@dao.test");
const fps = keys.map(daoAcctFingerprint);
const combos = new Set(fps.map(f => [f.ua, f.tz, f.width + "x" + f.height, f.webglRenderer, f.lang].join("|")));
ok(combos.size >= 20, "40 号至少 20 种不同指纹组合 (实得 " + combos.size + ")");
const tzs = new Set(fps.map(f => f.tz));
ok(tzs.size >= 4, "时区分散 (≥4 种, 实得 " + tzs.size + ")");
ok(fps.every(f => /Chrome\/\d+\.0\.0\.0 Safari/.test(f.ua) && f.cores > 0 && f.mem > 0), "每号指纹字段合法 (UA/核数/内存)");
ok(fps.some(f => f.platform === "MacIntel") && fps.some(f => f.platform === "Win32"), "平台含 mac 与 Windows 两类");

// ③ launchIsolatedBrowser 落实隔离维度
const li = src.slice(src.indexOf("function launchIsolatedBrowser"), src.indexOf("function daoIsolationSummary"));
ok(/--proxy-server='\s*\+\s*proxy/.test(li), "启动注入 --proxy-server(每号出口 IP)");
ok(/--user-agent='\s*\+\s*fp\.ua/.test(li), "启动注入 per-号 --user-agent");
ok(/--accept-lang='\s*\+\s*fp\.acceptLang/.test(li), "启动注入 per-号 accept-lang");
ok(/--load-extension='\s*\+\s*extDir/.test(li), "启动加载指纹注入扩展 --load-extension");
ok(/TZ:\s*fp\.tz/.test(li), "子进程 TZ 环境变量按号设时区");
ok(/daoAcctProxy\(safeKey\)/.test(li) && /daoWriteFpExtension\(profileDir,\s*fp\)/.test(li), "启动前取代理并生成注入扩展");

// 指纹扩展须为 MAIN world content-script(否则改不动页面 navigator/webgl)
const we = src.slice(src.indexOf("function daoWriteFpExtension"), src.indexOf("function findBrowserExe"));
ok(/world:\s*'MAIN'/.test(we), "注入扩展 content_script world=MAIN");
ok(/run_at:\s*'document_start'/.test(we), "注入扩展 document_start(先于页面脚本)");
ok(/37445|37446/.test(we), "注入覆盖 WebGL VENDOR/RENDERER 参数");
ok(/navigator,"userAgent",C\.ua/.test(we), "注入对齐 navigator.userAgent(消 platform/UA 矛盾)");
ok(/userAgentData/.test(we), "注入对齐 userAgentData.platform");

// ④ 端点在册 + 脱敏
ok(/case '\/api\/browser\/isolation'/.test(src), "端点 /api/browser/isolation 在册");
ok(/case '\/api\/browser\/proxy'/.test(src), "端点 /api/browser/proxy 在册");
const sum = src.slice(src.indexOf("function daoIsolationSummary"), src.indexOf("const DEVIN_URL_GET_USER_STATUS"));
ok(/u\.password\s*=\s*'\*\*\*'/.test(sum), "隔离概览对代理密码脱敏(不回显凭证)");

console.log("全部通过 (" + pass + " 项)");
