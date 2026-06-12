#!/usr/bin/env node
// fetch-cloudflared.js — 把 cloudflared 二进制拉进 dao-bridge 插件的 bin/ 目录,
// 以便打出"自带 cloudflared、离线即用"的自包含 VSIX。道法自然 · 整个体系自带。
//
// Usage:
//   node tools/fetch-cloudflared.js [targets]
//   targets: 逗号分隔, 缺省 windows-amd64。可选: windows-amd64,windows-arm64,linux-amd64,linux-arm64,darwin-amd64,darwin-arm64
//
// 镜像顺序: 直连 GitHub → 国内 GitHub 加速镜像 (ghfast.top / gh-proxy.com / mirror.ghproxy.com ...)
// 支持环境变量代理 HTTPS_PROXY (https 走 CONNECT 隧道)。

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const UA = "Mozilla/5.0 dao-bridge fetch-cloudflared";
const BIN_DIR = path.resolve(__dirname, "..", "plugins", "cf-daohub", "dao-bridge-ext", "bin");

const ASSET = {
  "windows-amd64": "cloudflared-windows-amd64.exe",
  "windows-arm64": "cloudflared-windows-arm64.exe",
  "linux-amd64": "cloudflared-linux-amd64",
  "linux-arm64": "cloudflared-linux-arm64",
  "darwin-amd64": "cloudflared-darwin-amd64.tgz",
  "darwin-arm64": "cloudflared-darwin-arm64.tgz",
};
// 落地文件名: 与运行时 CF_BIN_NAME 对齐 (windows → cloudflared.exe, 其余 → cloudflared)
const OUT = {
  "windows-amd64": "cloudflared.exe",
  "windows-arm64": "cloudflared.exe",
  "linux-amd64": "cloudflared",
  "linux-arm64": "cloudflared",
  "darwin-amd64": "cloudflared.tgz",
  "darwin-arm64": "cloudflared.tgz",
};

function mirrors(asset) {
  const gh = "https://github.com/cloudflare/cloudflared/releases/latest/download/" + asset;
  return [gh, "https://ghfast.top/" + gh, "https://gh-proxy.com/" + gh, "https://mirror.ghproxy.com/" + gh, "https://ghproxy.net/" + gh];
}

function download(url, dst, proxy) {
  return new Promise((resolve) => {
    const tmp = dst + ".part";
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; if (ok) { try { fs.renameSync(tmp, dst); } catch (e) { ok = false; } } if (!ok) { try { fs.unlinkSync(tmp); } catch (e) {} } resolve(ok); };
    const sink = (res, retry, depth) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return retry(res.headers.location, depth + 1); }
      if (res.statusCode !== 200) { res.resume(); return done(false); }
      const f = fs.createWriteStream(tmp); res.pipe(f);
      f.on("finish", () => f.close(() => { try { if (fs.statSync(tmp).size < 1000000) return done(false); } catch (e) { return done(false); } done(true); }));
      f.on("error", () => done(false));
    };
    const get = (u, depth) => {
      if (depth > 6) return done(false);
      let o; try { o = new URL(u); } catch (e) { return done(false); }
      if (proxy && o.protocol === "https:") {
        let px; try { px = new URL(proxy); } catch (e) { px = null; }
        if (px) {
          const c = http.request({ host: px.hostname, port: px.port || 80, method: "CONNECT", path: o.hostname + ":443", headers: { Host: o.hostname + ":443" }, timeout: 60000 });
          c.on("connect", (resp, socket) => { if (resp.statusCode !== 200) { socket.destroy(); return done(false); } const r2 = https.get({ hostname: o.hostname, port: 443, path: o.pathname + o.search, socket, agent: false, headers: { "User-Agent": UA }, timeout: 60000 }, (res) => sink(res, get, depth)); r2.on("error", () => done(false)); });
          c.on("error", () => done(false)); c.end(); return;
        }
      }
      const mod = o.protocol === "http:" ? http : https;
      const req = mod.get({ hostname: o.hostname, port: o.port || (o.protocol === "http:" ? 80 : 443), path: o.pathname + o.search, headers: { "User-Agent": UA }, timeout: 60000 }, (res) => sink(res, get, depth));
      req.on("error", () => done(false)); req.setTimeout(60000, () => { req.destroy(); done(false); });
    };
    get(url, 0);
  });
}

(async () => {
  const targets = (process.argv[2] || "windows-amd64").split(",").map((s) => s.trim()).filter(Boolean);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  fs.mkdirSync(BIN_DIR, { recursive: true });
  let allOk = true;
  for (const t of targets) {
    if (!ASSET[t]) { console.error("unknown target:", t); allOk = false; continue; }
    if (/darwin/.test(t)) { console.error("darwin 为 .tgz, 需手动解包; 跳过自动落地:", t); continue; }
    const dst = path.join(BIN_DIR, OUT[t]);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 1000000) { console.log("already present:", dst); continue; }
    let ok = false;
    for (const m of mirrors(ASSET[t])) {
      process.stdout.write("fetch " + t + " <- " + m + " ... ");
      ok = await download(m, dst, proxy);
      console.log(ok ? "OK" : "fail");
      if (ok) break;
    }
    if (ok) { if (!/windows/.test(t)) try { fs.chmodSync(dst, 0o755); } catch (e) {} console.log("  ->", dst, fs.statSync(dst).size, "bytes"); }
    else { console.error("  FAILED all mirrors for", t); allOk = false; }
  }
  process.exit(allOk ? 0 : 1);
})();
