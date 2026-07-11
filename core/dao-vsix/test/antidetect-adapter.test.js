// antidetect-adapter.test.js · 整合市面已有指纹浏览器 (比特浏览器 BitBrowser / AdsPower) 适配器护栏
//
// 需求: 不自造轮子, 高效整合已有开源/商用指纹浏览器 —— 经其 Local API 用本号确定性指纹+代理建/开隔离环境。
// 本测试锁定:
//   ① daoParseProxy 正确拆解代理串
//   ② 建档 payload 把本号确定性指纹(UA/时区/WebGL/分辨率/核数/内存)与代理如实映射到各厂商字段
//   ③ daoAntidetectOpen 对 mock 厂商 Local API 依「建档→开启」两步下发, 且回传调试端点
//   ④ launchIsolatedBrowser 优先走厂商 API, 失败降级自带 Chromium 隔离
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { transform } = require("sucrase");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 指纹浏览器整合适配器 · 护栏]");

function slice(name) {
    let i = src.indexOf("function " + name);
    assert.ok(i > 0, "源含 " + name);
    if (src.slice(i - 6, i) === "async ") i -= 6; // 保留 async 前缀
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        const c = src[j];
        if (c === "{") { depth++; started = true; }
        else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
}

const mod = [
    "daoFpSeed", "daoAcctFingerprint", "daoParseProxy", "daoHttpJson",
    "daoBitbrowserProfile", "daoAdspowerProfile", "daoAntidetectCfg", "daoAntidetectOpen",
].map(slice).join("\n") +
    "\nmodule.exports = { daoFpSeed, daoAcctFingerprint, daoParseProxy, daoHttpJson, daoBitbrowserProfile, daoAdspowerProfile, daoAntidetectCfg, daoAntidetectOpen };\n";
const js = transform(mod, { transforms: ["typescript"] }).code;
const DAO_DIR = fs.mkdtempSync(path.join(require("os").tmpdir(), "dao-ad-"));
const sandbox = { module: { exports: {} } };
new Function("module", "exports", "Math", "Object", "String", "URL", "Buffer", "http", "https", "fs", "path", "process", "DAO_DIR", js)(
    sandbox.module, sandbox.module.exports, Math, Object, String, URL, Buffer, http, https, fs, path, process, DAO_DIR);
const A = sandbox.module.exports;

// ① 代理拆解
const pp = A.daoParseProxy("socks5://u1:p2@1.2.3.4:1080");
ok(pp && pp.scheme === "socks5" && pp.host === "1.2.3.4" && pp.port === "1080" && pp.user === "u1" && pp.pass === "p2", "daoParseProxy 拆解 scheme/host/port/user/pass");
ok(A.daoParseProxy("") === null, "空代理返回 null");

// ② 建档 payload 映射本号确定性指纹
const fp = A.daoAcctFingerprint("alice@dao.test");
const bb = A.daoBitbrowserProfile("alice_dao.test", fp, "http://us:pw@9.9.9.9:8080");
ok(bb.browserFingerPrint.userAgent === fp.ua && bb.browserFingerPrint.timeZone === fp.tz, "BitBrowser payload 带本号 UA/时区");
ok(bb.browserFingerPrint.webGLRender === fp.webglRenderer && bb.browserFingerPrint.resolution === fp.width + " x " + fp.height, "BitBrowser payload 带 WebGL/分辨率");
ok(bb.proxyMethod === 2 && bb.host === "9.9.9.9" && bb.port === "8080" && bb.proxyPassword === "pw", "BitBrowser payload 带自定义代理");
const ap = A.daoAdspowerProfile("bob_dao.test", fp, "");
ok(ap.fingerprint_config.ua === fp.ua && ap.fingerprint_config.timezone === fp.tz && ap.fingerprint_config.webgl_renderer === fp.webglRenderer, "AdsPower payload 带本号指纹");
ok(ap.user_proxy_config.proxy_soft === "no_proxy", "AdsPower 无代理时 no_proxy");

// ③ mock 厂商 Local API — 断「建档→开启」两步 + 指纹下发 + 回传端点
const seen = [];
const server = http.createServer((rq, rs) => {
    let body = ""; rq.on("data", d => body += d); rq.on("end", () => {
        seen.push({ method: rq.method, url: rq.url, body: body });
        rs.setHeader("Content-Type", "application/json");
        if (rq.url === "/browser/update") return rs.end(JSON.stringify({ success: true, data: { id: "bb-777" } }));
        if (rq.url === "/browser/open") return rs.end(JSON.stringify({ success: true, data: { ws: "ws://127.0.0.1:11111/devtools" } }));
        if (rq.url === "/api/v1/user/create") return rs.end(JSON.stringify({ code: 0, data: { id: "ap-888" } }));
        if (rq.url.indexOf("/api/v1/browser/start") === 0) return rs.end(JSON.stringify({ code: 0, data: { ws: { puppeteer: "ws://127.0.0.1:22222/dt" } } }));
        rs.statusCode = 404; rs.end("{}");
    });
});

async function main() {
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + server.address().port;

    // — BitBrowser 路径 —
    const r1 = await A.daoAntidetectOpen({ api: base, provider: "bitbrowser", token: "" }, "alice_dao.test", fp, "http://9.9.9.9:8080", "https://github.com");
    ok(seen[0].url === "/browser/update" && seen[1].url === "/browser/open", "BitBrowser 先建档(/browser/update)后开启(/browser/open)");
    ok(JSON.parse(seen[0].body).browserFingerPrint.userAgent === fp.ua, "BitBrowser 建档请求体携带本号 UA (指纹随号下发)");
    ok(JSON.parse(seen[1].body).id === "bb-777" && JSON.parse(seen[1].body).args[0] === "https://github.com", "BitBrowser 开启用建档返回的 id 且带目标 URL");
    ok(r1.ws === "ws://127.0.0.1:11111/devtools", "BitBrowser 回传调试端点 ws");

    // — AdsPower 路径 —
    seen.length = 0;
    const r2 = await A.daoAntidetectOpen({ api: base, provider: "adspower", token: "tk" }, "bob_dao.test", fp, "", "https://github.com");
    ok(seen[0].url === "/api/v1/user/create" && seen[1].url.indexOf("/api/v1/browser/start") === 0, "AdsPower 先建档(user/create)后开启(browser/start)");
    ok(JSON.parse(seen[0].body).fingerprint_config.ua === fp.ua, "AdsPower 建档请求体携带本号 UA");
    ok(seen[1].url.indexOf("user_id=ap-888") >= 0, "AdsPower 开启用建档返回的 user_id");
    ok(r2.ws === "ws://127.0.0.1:22222/dt", "AdsPower 回传调试端点 ws");

    // 未知 provider → 抛错 (交由调用方降级)
    let threw = false;
    try { await A.daoAntidetectOpen({ api: base, provider: "nope", token: "" }, "x", fp, "", ""); } catch { threw = true; }
    ok(threw, "未知 provider 抛错 (降级触发点)");

    server.close();

    // ④ launchIsolatedBrowser 优先厂商 API, 失败降级 Chromium
    const li = src.slice(src.indexOf("function launchIsolatedBrowser"), src.indexOf("function daoIsolationSummary"));
    ok(/daoAntidetectCfg\(\)/.test(li) && /daoAntidetectOpen\(/.test(li), "launchIsolatedBrowser 优先走厂商 API");
    ok(/\.catch\(/.test(li) && /daoLaunchChromiumIsolated\(targetUrl/.test(li) && /return daoLaunchChromiumIsolated/.test(li), "厂商失败/未配 → 降级自带 Chromium 隔离");
    ok(/case '\/api\/browser\/antidetect'/.test(src), "端点 /api/browser/antidetect 在册");

    console.log("全部通过 (" + pass + " 项)");
}
main().catch(e => { console.error(e); process.exit(1); });
