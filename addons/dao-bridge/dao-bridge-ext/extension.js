// ═══════════════════════════════════════════════════════════
// DAO Bridge · 公网穿透 — 帛书·「天下之至柔驰骋于天下之致坚」
// 道法自然 · 无为而无不为
//
// 核心: 用户只需输入 CloudFlare 账号(或 GitHub 账号) → 全链路自动打通
// 插件一启动 → 整台机器公网穿透 → 云端 Agent 即可接入
// 三模块: 实时状态面板 | 导出云端Agent MD | 导出本地Agent配置MD
// ═══════════════════════════════════════════════════════════

const vscode = require("vscode");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TRY_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BRIDGE_VERSION = "3.5.0";
// 默认中继(Worker+DurableObject)端点 — 零账号穿透的公共入口, 可被 daoBridge.relayUrl 覆盖。
const DEFAULT_RELAY_URL = "https://dao-relay-do.zhouyoukang.workers.dev";

function daoDir() {
  const d = path.join(os.homedir(), ".dao", "bridge");
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
function daoGlobalDir() {
  const d = path.join(os.homedir(), ".dao");
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

// ═══════════════════════════════════════════════════════════
// exec 规范化 — 让 .bat/.cmd/.exe 及任意程序都能远程执行（覆盖整机）
// 痛点根因：裸命令走 cmd.exe / Invoke-Expression 时，一个含空格的 .bat/.exe
//   文件路径会被当成「字符串字面量」或被拆词 → 远程跑不起来。
//   用 PowerShell 调用运算符 & + 单引号量化 + UTF-8/原生退出码包装彻底规避。
// ═══════════════════════════════════════════════════════════
function psq(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'"; }
// POSIX(/bin/sh) 单引号字面量转义（Linux/macOS 本机执行用）
function shq(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'"; }
// 按平台生成 sysinfo 采集命令：Win→Get-ComputerInfo；Linux/macOS→uname/os-release/cpu/mem/disk
function sysinfoCmd(platform) {
  if ((platform || process.platform) === "win32") return "Get-ComputerInfo | Out-String";
  return "echo '=== SYSTEM ==='; uname -a; echo; (lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null); " +
    "echo; echo '=== CPU ==='; (lscpu 2>/dev/null | head -25 || sysctl -n machdep.cpu.brand_string 2>/dev/null); " +
    "echo; echo '=== MEMORY ==='; (free -h 2>/dev/null || vm_stat 2>/dev/null); " +
    "echo; echo '=== DISK ==='; df -h 2>/dev/null; echo; echo '=== UPTIME ==='; uptime 2>/dev/null";
}
// 由被控端登记的 sysinfo 推断其平台：显式 platform 优先；否则按 os_version 关键字判定；缺省回退 win32（向后兼容）。
function platformOf(agent) {
  const s = (agent && agent.sysinfo) || {};
  if (s.platform) return String(s.platform);
  if (/linux|darwin|mac|bsd/i.test(s.os_version || "")) return "linux";
  return "win32";
}
function wrapPwshForUtf8AndExit(cmd) {
  return (
    "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
    "$ErrorActionPreference='Continue'; $Error.Clear(); $global:LASTEXITCODE=0\n" +
    cmd +
    "\n$__c=0; if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){$__c=$LASTEXITCODE} elseif($Error.Count -gt 0){$__c=1}; exit $__c"
  );
}
function runPwsh(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/sh";
    const args = isWin ? ["-NoProfile", "-Command", wrapPwshForUtf8AndExit(cmd)] : ["-c", cmd];
    cp.execFile(shell, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => resolve({
        stdout: stdout || "",
        stderr: stderr || (err && err.killed ? "timeout" : ""),
        exit_code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      }));
  });
}
// 把高层 exec 请求规范化为一条健壮的 PowerShell 表达式。
// type：shell(默认/原样) | cmd|bat(经 cmd.exe /c + chcp 65001 跑 .bat/经典 DOS)
//        | run|file(运行文件 .bat/.cmd/.exe/.ps1 + args) | detached|spawn(Start-Process 后台/分离回 PID)
// 可选：cwd(工作目录) args(数组) elevate(管理员提权) show(显示窗口)
function buildExecCommand(body, targetPlatform) {
  body = body || {};
  const posix = (targetPlatform || "win32") !== "win32";
  const type = String(body.type || "shell").toLowerCase();
  const file = body.file || body.exe || body.program || "";
  const args = Array.isArray(body.args) ? body.args : [];
  const cmd = body.cmd || body.command || (body.payload && body.payload.command) || "";
  if (posix) {
    const cwdP = body.cwd ? "cd " + shq(body.cwd) + " && " : "";
    if (type === "detached" || type === "spawn" || body.detached) {
      const target = file ? shq(file) : cmd;
      const al = args.length ? " " + args.map(shq).join(" ") : "";
      return cwdP + "nohup " + target + al + " >/dev/null 2>&1 & echo \"started pid=$! file=" + (file || cmd) + "\"";
    }
    if (type === "run" || type === "file" || (file && !cmd)) {
      const al = args.length ? " " + args.map(shq).join(" ") : "";
      const runner = /\.sh$/i.test(file) ? "sh " : "";
      return cwdP + runner + shq(file || cmd) + al + " 2>&1";
    }
    return cwdP + cmd;
  }
  const cwd = body.cwd ? "Set-Location -LiteralPath " + psq(body.cwd) + "; " : "";
  if (type === "detached" || type === "spawn" || body.detached) {
    const target = file || cmd;
    const al = args.length ? " -ArgumentList " + args.map(psq).join(",") : "";
    const win = body.show ? "" : " -WindowStyle Hidden";
    const verb = body.elevate ? " -Verb RunAs" : "";
    return cwd + "$p=Start-Process -FilePath " + psq(target) + al + win + verb +
      " -PassThru; 'started pid=' + $p.Id + ' file=' + " + psq(target);
  }
  if (type === "run" || type === "file" || (file && !cmd)) {
    const al = args.length ? " " + args.map(psq).join(" ") : "";
    return cwd + "& " + psq(file || cmd) + al + " 2>&1 | Out-String";
  }
  if (type === "cmd" || type === "bat" || type === "batch") {
    return cwd + "& cmd.exe /d /c " + psq("chcp 65001>nul & " + cmd) + " 2>&1 | Out-String";
  }
  return cwd + cmd;
}

// ═══════════════════════════════════════════════════════════
// 代理探测 — 帛书·「以其善下之」
// 国内网络: 优先用本机已有代理(clash/v2ray)穿透 GFW; 不依赖用户手填
// 顺序: 显式配置 → 环境变量 → 常见本地代理端口探测
// ═══════════════════════════════════════════════════════════

const COMMON_PROXY_PORTS = [7890, 7897, 10809, 1080, 8889, 2080, 10808];

function probeLocalProxy() {
  for (const port of COMMON_PROXY_PORTS) {
    try {
      // 同步探测 TCP 端口是否监听 (Windows: PowerShell; *nix: /dev/tcp 不可靠故用 node net 同步替代)
      const r = cp.spawnSync(process.platform === "win32" ? "powershell" : "bash",
        process.platform === "win32"
          ? ["-NoProfile", "-Command", `(Test-NetConnection 127.0.0.1 -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded`]
          : ["-c", `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo True || echo False`],
        { timeout: 3000, encoding: "utf8" });
      if (r.stdout && /true/i.test(r.stdout)) return "http://127.0.0.1:" + port;
    } catch (e) {}
  }
  return "";
}

let _proxyCache = null;
function detectProxy() {
  if (_proxyCache !== null) return _proxyCache;
  const cfg = vscode.workspace.getConfiguration("daoBridge");
  const explicit = String(cfg.get("proxyUrl") || "").trim();
  const autoProbe = cfg.get("autoProxy") !== false; // 默认开启
  let proxy = explicit
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || "";
  proxy = String(proxy).trim();
  if (!proxy && autoProbe) proxy = probeLocalProxy();
  _proxyCache = proxy || "";
  return _proxyCache;
}

// 给 cloudflared 子进程注入代理环境 — 帛书·「無有入於無間」
// 关键: relay agent 会导出 NO_PROXY=* 致 libcurl/cloudflared 静默绕过代理, 必须先清空
function spawnEnv(proxy) {
  const env = Object.assign({}, process.env);
  delete env.NO_PROXY; delete env.no_proxy;
  if (proxy) {
    env.HTTPS_PROXY = proxy; env.https_proxy = proxy;
    env.HTTP_PROXY = proxy; env.http_proxy = proxy;
    env.ALL_PROXY = proxy; env.all_proxy = proxy;
  }
  return env;
}

// ═══════════════════════════════════════════════════════════
// cloudflared 定位 + 自动下载 — 帛书·「整个体系自带, 不依赖用户网络」
// 优先级: 插件内置 bin/ → ~/.dao/bin → 显式配置 → PATH → 多镜像下载(含国内)
// ═══════════════════════════════════════════════════════════

const CF_BIN_NAME = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

// 真二进制判定 — 帛书·「質真如渝」: 排除 npm/choco 包装脚本(.cmd/.ps1/无扩展名 shim, 仅几百字节),
// cp.spawn(无 shell) 无法执行此类 shim → 正是 141 台式机隧道无法启动的根因。
function isRealCloudflared(p) {
  try {
    if (!p || p.indexOf(path.sep) < 0 || !fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 1000000) return false; // 真二进制 ≈50MB; shim 仅几百字节
    if (process.platform === "win32" && !/\.exe$/i.test(p)) return false; // Windows 必须是 .exe(可被 CreateProcess 执行)
    return true;
  } catch (e) { return false; }
}
// 完整性探活 — 帛书·「質真如渝」: 体积过关不等于二进制完好。
// 半成品(下载在 >1MB 处被 FIN/RST 截断)体积也能 >1MB, 唯有真正 `--version` 跑通才算数。
// 这是「自动安装中断→以半成品为基础永久卡死」的根治判据。
let _cfProbeCache = new Map();
function probeCloudflared(p) {
  if (!p) return false;
  if (_cfProbeCache.has(p)) return _cfProbeCache.get(p);
  let ok = false;
  try {
    const r = cp.spawnSync(p, ["--version"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
    ok = !r.error && r.status === 0 && /cloudflared/i.test(String(r.stdout || "") + String(r.stderr || ""));
  } catch (e) { ok = false; }
  _cfProbeCache.set(p, ok);
  return ok;
}
// 启动清理: 删除自管目录里上一轮残留的半成品(.part / .tgz), 杜绝「以半成品为基础」
function cleanupPartials(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.part(-[0-9a-f]+)?$/i.test(f) || /\.tgz$/i.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
      }
    }
  } catch (e) {}
}
// macOS 资产是 .tgz, 必须解包取出真二进制(此前代码从不解包→mac 100% 不可用)。
// 零依赖: 用内置 zlib gunzip + 手解 tar(512B 头块), 取名为 cloudflared 的文件。
function extractCfTgz(tgzPath, outBin) {
  try {
    const zlib = require("zlib");
    const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
    let off = 0;
    while (off + 512 <= buf.length) {
      const header = buf.slice(off, off + 512);
      const name = header.slice(0, 100).toString("utf8").replace(/\0.*$/s, "");
      off += 512;
      if (!name) break; // 连续空块 = 归档结束
      const sizeOct = header.slice(124, 136).toString("utf8").replace(/[\0 ]+$/g, "").trim();
      const size = parseInt(sizeOct, 8) || 0;
      const base = name.split("/").pop();
      if (base === "cloudflared" && size > 1000000) {
        fs.writeFileSync(outBin, buf.slice(off, off + size));
        try { fs.chmodSync(outBin, 0o755); } catch (e) {}
        try { fs.unlinkSync(tgzPath); } catch (e) {}
        return outBin;
      }
      off += Math.ceil(size / 512) * 512;
    }
  } catch (e) {}
  try { fs.unlinkSync(tgzPath); } catch (e) {}
  return "";
}
function cloudflaredCandidates(ctx) {
  const cfgPath = vscode.workspace.getConfiguration("daoBridge").get("cloudflaredPath") || "";
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return [
    cfgPath,
    // 插件自带(随 VSIX 分发, 离线即用) — 帛书·「大丈夫居其厚」
    ctx ? path.join(ctx.extensionPath, "bin", CF_BIN_NAME) : "",
    ctx ? path.join(ctx.extensionPath, "bin", "cloudflared.exe") : "",
    ctx ? path.join(ctx.extensionPath, "bin", "cloudflared") : "",
    path.join(home, ".dao", "bin", "cloudflared.exe"),
    path.join(home, ".dao", "bin", "cloudflared"),
    // npm/choco/winget 全局安装时缓存的真二进制(非 shim) — 帛书·「善用人者為之下」
    path.join(appdata, "npm", "node_modules", "cloudflared", "bin", "cloudflared.exe"),
    path.join(appdata, "npm", "node_modules", "cloudflared", "bin", "cloudflared"),
    "cloudflared.exe",
    "cloudflared",
  ].filter(Boolean);
}
function findCloudflared(ctx) {
  const managedDir = path.resolve(path.join(os.homedir(), ".dao", "bin"));
  for (const c of cloudflaredCandidates(ctx)) {
    if (!isRealCloudflared(c)) continue;
    if (probeCloudflared(c)) return c; // 体积 + --version 双过关才算数
    // 探活失败 = 半成品/损坏。自管目录下的直接删除以触发重下(自愈);
    // 外部安装(PATH/npm/choco)的不动, 只跳过。
    try { if (path.resolve(c).startsWith(managedDir + path.sep)) { fs.unlinkSync(c); _cfProbeCache.delete(c); } } catch (e) {}
  }
  // PATH 兜底: 遍历 where/command -v 全部结果, 跳过 shim, 只取真二进制
  try {
    const probe = process.platform === "win32" ? "where cloudflared" : "command -v cloudflared 2>/dev/null; which -a cloudflared 2>/dev/null";
    const lines = cp.execSync(probe, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/);
    for (const ln of lines) { const p = ln.trim(); if (isRealCloudflared(p) && probeCloudflared(p)) return p; }
  } catch (e) {}
  return "";
}

// cloudflared 官方资产名(按平台/架构)
function cfAssetName() {
  const p = process.platform, a = process.arch;
  if (p === "win32") return a === "arm64" ? "cloudflared-windows-arm64.exe" : "cloudflared-windows-amd64.exe";
  if (p === "darwin") return a === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  // linux
  if (a === "arm64") return "cloudflared-linux-arm64";
  if (a === "arm") return "cloudflared-linux-arm";
  return "cloudflared-linux-amd64";
}

// 镜像列表 — 帛书·「水善利万物」: 直连 → 国内 GitHub 加速镜像 多路并举
function downloadMirrors(asset) {
  const ghPath = "https://github.com/cloudflare/cloudflared/releases/latest/download/" + asset;
  return [
    ghPath,
    "https://ghfast.top/" + ghPath,
    "https://gh-proxy.com/" + ghPath,
    "https://mirror.ghproxy.com/" + ghPath,
    "https://ghproxy.net/" + ghPath,
    "https://gh.ddlc.top/" + ghPath,
  ];
}

// 单镜像下载 — 帛书·「水善利万物」: 断点续传(.part + Range) + 按 Content-Length 校验总长。
// 续传文件用确定名 `dst.part`(去随机化, 便于清理与跨次续传); 任一档中断, 下一档/下一次接着传,
// 而不是从零重来 → 正面化解「50MB 一次性下完概率低、次次从头中断」。
function httpDownload(url, dst, proxy, onProgress) {
  return new Promise((resolve) => {
    const tmp = dst + ".part";
    let settled = false;
    let expectedTotal = 0; // 期望总长(含已存在的续传字节)
    const done = (ok) => {
      if (settled) return; settled = true;
      if (ok) {
        try {
          const sz = fs.statSync(tmp).size;
          // 体积下限 + 总长一致性: 截断/HTML 错误页/长度不符一律拒收, 不留半成品
          if (sz < 1000000 || (expectedTotal && sz !== expectedTotal)) ok = false;
        } catch (e) { ok = false; }
      }
      if (ok) { try { fs.renameSync(tmp, dst); } catch (e) { ok = false; } }
      if (!ok) { try { fs.unlinkSync(tmp); } catch (e) {} } // 失败即清半成品(续传残留交给 cleanupPartials)
      resolve(ok);
    };
    let resumeAt = 0;
    try { if (fs.existsSync(tmp)) resumeAt = fs.statSync(tmp).size; } catch (e) {}
    const rangeHeaders = () => (resumeAt > 0 ? { Range: "bytes=" + resumeAt + "-" } : {});
    const sink = (res, retryFn, depth) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return retryFn(res.headers.location, depth + 1);
      }
      // 206 = 续传被接受; 200 = 服务端忽略 Range, 从头给整包 → 清空续传重写
      const append = resumeAt > 0 && res.statusCode === 206;
      if (resumeAt > 0 && res.statusCode === 200) { resumeAt = 0; }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return done(false); }
      const cl = Number(res.headers["content-length"] || 0);
      expectedTotal = cl ? (append ? resumeAt : 0) + cl : 0;
      const f = fs.createWriteStream(tmp, { flags: append ? "a" : "w" });
      res.on("error", () => done(false)); // 此前缺失: 响应流中途出错未处理
      res.pipe(f);
      f.on("finish", () => f.close(() => done(true)));
      f.on("error", () => done(false));
    };
    const get = (u, depth) => {
      if (depth > 6) return done(false);
      let opts;
      try { opts = new URL(u); } catch (e) { return done(false); }
      // 有代理且目标为 https: 走 HTTP CONNECT 隧道 — 帛书·「無有入於無間」
      if (proxy && opts.protocol === "https:") {
        let px; try { px = new URL(proxy); } catch (e) { px = null; }
        if (px) {
          const conn = http.request({
            host: px.hostname, port: px.port || 80, method: "CONNECT",
            path: opts.hostname + ":" + (opts.port || 443),
            headers: { Host: opts.hostname + ":" + (opts.port || 443), "User-Agent": UA },
            timeout: 60000,
          });
          conn.on("connect", (resp, socket) => {
            if (resp.statusCode !== 200) { socket.destroy(); return done(false); }
            const req2 = https.get({ hostname: opts.hostname, port: opts.port || 443, path: opts.pathname + opts.search, socket, agent: false, headers: Object.assign({ "User-Agent": UA }, rangeHeaders()), timeout: 60000 },
              (res) => sink(res, get, depth));
            req2.on("error", () => done(false));
            req2.setTimeout(60000, () => { req2.destroy(); done(false); });
          });
          conn.on("error", () => done(false));
          conn.setTimeout(60000, () => { conn.destroy(); done(false); });
          conn.end();
          return;
        }
      }
      const mod = opts.protocol === "http:" ? http : https;
      const req = mod.get({ hostname: opts.hostname, port: opts.port || (opts.protocol === "http:" ? 80 : 443), path: opts.pathname + opts.search, headers: Object.assign({ "User-Agent": UA }, rangeHeaders()), timeout: 60000 },
        (res) => sink(res, get, depth));
      req.on("error", () => done(false));
      req.setTimeout(60000, () => { req.destroy(); done(false); });
    };
    get(url, 0);
  });
}

async function downloadCloudflared(onProgress) {
  const binDir = path.join(os.homedir(), ".dao", "bin");
  const dst = path.join(binDir, CF_BIN_NAME);
  try { fs.mkdirSync(binDir, { recursive: true }); } catch (e) {}
  cleanupPartials(binDir); // 清上一轮半成品, 杜绝「以半成品为基础」
  // 既有文件: 必须 --version 探活通过才复用; 否则删除重下(自愈)。不再只看体积。
  try { if (fs.existsSync(dst) && isRealCloudflared(dst) && probeCloudflared(dst)) return dst; } catch (e) {}
  try { if (fs.existsSync(dst)) { fs.unlinkSync(dst); _cfProbeCache.delete(dst); } } catch (e) {}
  const asset = cfAssetName();
  const isTgz = /\.tgz$/i.test(asset); // macOS
  const dlTarget = isTgz ? path.join(binDir, "cloudflared.tgz") : dst;
  const proxy = detectProxy();
  const mirrors = downloadMirrors(asset);
  for (let i = 0; i < mirrors.length; i++) {
    try { onProgress && onProgress("下载 cloudflared … 镜像 " + (i + 1) + "/" + mirrors.length); } catch (e) {}
    const ok = await httpDownload(mirrors[i], dlTarget, proxy);
    if (!ok) continue;
    let bin = dlTarget;
    if (isTgz) { bin = extractCfTgz(dlTarget, dst); if (!bin) continue; }
    if (process.platform !== "win32") { try { fs.chmodSync(bin, 0o755); } catch (e) {} }
    _cfProbeCache.delete(bin);
    if (probeCloudflared(bin)) return bin; // 落地后最终完整性校验
    try { fs.unlinkSync(bin); } catch (e) {} // 探活失败 → 删除, 换下一个镜像重下
  }
  return "";
}

// ═══════════════════════════════════════════════════════════
// 最小 WebSocket 客户端(RFC6455) — 帛书·「天下之至柔驰骋于天下之致坚」
// VS Code 扩展宿主(Electron Node)无全局 WebSocket、也未带 ws 依赖。
// 故零依赖手写: 原生 net/tls + crypto 握手 + 帧编解码 + 客户端掩码 + ping/pong。
// 仅实现 relay 桥所需子集(text/ping/pong/close, 自动拼分片), 直连与代理 CONNECT 皆可。
// ═══════════════════════════════════════════════════════════
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
class DaoWsClient {
  constructor(url, opts) {
    opts = opts || {};
    this.url = url;
    this.proxy = opts.proxy || "";
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this.sock = null; this.closed = false;
    this._buf = Buffer.alloc(0);
    this._frags = []; this._fragOp = 0;
  }
  connect() {
    let u; try { u = new URL(this.url); } catch (e) { return this._fail(new Error("bad ws url")); }
    const isTls = u.protocol === "wss:";
    const port = Number(u.port) || (isTls ? 443 : 80);
    const reqPath = (u.pathname || "/") + (u.search || "");
    // 代理(http CONNECT 隧道)→ 拿到裸 socket → 视需要 TLS → WS 握手
    if (this.proxy) {
      let px = null; try { px = new URL(this.proxy); } catch (e) { px = null; }
      if (px) {
        const conn = http.request({ host: px.hostname, port: Number(px.port) || 80, method: "CONNECT", path: u.hostname + ":" + port, headers: { Host: u.hostname + ":" + port, "User-Agent": UA }, timeout: 20000 });
        conn.on("connect", (resp, socket) => {
          if (resp.statusCode !== 200) { try { socket.destroy(); } catch (e) {} return this._fail(new Error("proxy connect " + resp.statusCode)); }
          this._afterRaw(socket, u, isTls, reqPath);
        });
        conn.on("error", (e) => this._fail(e));
        conn.setTimeout(20000, () => { try { conn.destroy(); } catch (e) {} this._fail(new Error("proxy timeout")); });
        conn.end();
        return;
      }
    }
    if (isTls) {
      const tls = require("tls");
      const t = tls.connect({ host: u.hostname, port, servername: u.hostname }, () => this._startHandshake(t, u.host, reqPath));
      t.setTimeout(20000, () => { try { t.destroy(); } catch (e) {} this._fail(new Error("connect timeout")); });
      t.on("error", (e) => this._fail(e));
    } else {
      const net = require("net");
      const s = net.connect({ host: u.hostname, port }, () => this._startHandshake(s, u.host, reqPath));
      s.setTimeout(20000, () => { try { s.destroy(); } catch (e) {} this._fail(new Error("connect timeout")); });
      s.on("error", (e) => this._fail(e));
    }
  }
  _afterRaw(socket, u, isTls, reqPath) {
    if (isTls) {
      const tls = require("tls");
      const t = tls.connect({ socket, servername: u.hostname }, () => this._startHandshake(t, u.host, reqPath));
      t.on("error", (e) => this._fail(e));
    } else { this._startHandshake(socket, u.host, reqPath); }
  }
  _startHandshake(socket, host, reqPath) {
    const key = crypto.randomBytes(16).toString("base64");
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64").toLowerCase();
    let done = false; let hs = Buffer.alloc(0);
    const onData = (d) => {
      if (done) return this._onFrameData(d);
      hs = Buffer.concat([hs, d]);
      const idx = hs.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const header = hs.slice(0, idx).toString("utf8").toLowerCase();
      const rest = hs.slice(idx + 4);
      if (!/^http\/1\.1 101/.test(header) || header.indexOf("sec-websocket-accept: " + accept) < 0) {
        return this._fail(new Error("ws handshake rejected"));
      }
      done = true; this.sock = socket;
      socket.removeListener("data", onData);
      socket.on("data", (x) => this._onFrameData(x));
      socket.setTimeout(0);
      if (rest.length) this._onFrameData(rest);
      try { this.onopen && this.onopen(); } catch (e) {}
    };
    socket.on("data", onData);
    socket.on("close", () => this._closeOnce());
    socket.on("error", (e) => this._err(e));
    const req = "GET " + reqPath + " HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\nUser-Agent: " + UA + "\r\n\r\n";
    try { socket.write(req); } catch (e) { this._fail(e); }
  }
  send(str) { return this._writeFrame(0x1, Buffer.from(String(str), "utf8")); }
  ping() { return this._writeFrame(0x9, Buffer.alloc(0)); }
  _writeFrame(opcode, payload) {
    if (!this.sock) return false;
    const len = payload.length; let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    header[0] = 0x80 | opcode; // FIN + opcode
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try { this.sock.write(Buffer.concat([header, mask, masked])); return true; } catch (e) { return false; }
  }
  _onFrameData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    while (true) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0], b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f; let offset = 2;
      if (len === 126) { if (this._buf.length < 4) return; len = this._buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this._buf.length < 10) return; len = Number(this._buf.readBigUInt64BE(2)); offset = 10; }
      let maskKey = null;
      if (masked) { if (this._buf.length < offset + 4) return; maskKey = this._buf.slice(offset, offset + 4); offset += 4; }
      if (this._buf.length < offset + len) return;
      let payload = this._buf.slice(offset, offset + len);
      if (masked && maskKey) { const o = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ maskKey[i & 3]; payload = o; }
      this._buf = this._buf.slice(offset + len);
      this._handleFrame(fin, opcode, payload);
    }
  }
  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(); return; }            // close
    if (opcode === 0x9) { this._writeFrame(0xA, payload); return; } // ping → pong
    if (opcode === 0xA) { return; }                          // pong
    if (opcode === 0x0) { this._frags.push(payload); }        // 续帧
    else { this._frags = [payload]; this._fragOp = opcode; }
    if (!fin) return;
    const full = Buffer.concat(this._frags); this._frags = [];
    if (this._fragOp === 0x1 || this._fragOp === 0x2) {
      try { this.onmessage && this.onmessage(full.toString("utf8")); } catch (e) {}
    }
  }
  close() {
    if (this.closed) return;
    try { this._writeFrame(0x8, Buffer.alloc(0)); } catch (e) {}
    try { this.sock && this.sock.end(); } catch (e) {}
    this._closeOnce();
  }
  _closeOnce() { if (this.closed) return; this.closed = true; try { this.onclose && this.onclose(); } catch (e) {} }
  _err(e) { try { this.onerror && this.onerror(e); } catch (x) {} }
  _fail(e) { this._err(e); this._closeOnce(); }
}

// 出站中继桥(WSS 穿 NAT) — 帛书·「反者道之动」: 本机主动出站连 Worker+DurableObject,
// 云端经稳定 *.workers.dev/relay/<session> 直达本机。零账号、URL 天然稳定、无 50MB 二进制。
// 与 core.js 的 connectRelay 共用同一帧契约(request/response/ping/pong), 统一两套实现。
function connectRelayWs(opts) {
  let ws = null, connected = false, stopped = false, pingTimer = null, reconnectTimer = null, pubUrl = null;
  const base = String(opts.relayUrl || "").replace(/\/$/, "");
  const wsUrl = base.replace(/^http/, "ws") + "/connect?session=" + encodeURIComponent(opts.session) + "&token=" + encodeURIComponent(opts.token);
  const schedule = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!connected) open(); }, 5000);
  };
  function open() {
    if (stopped) return;
    ws = new DaoWsClient(wsUrl, { proxy: opts.proxy });
    ws.onopen = () => {
      connected = true; pubUrl = base + "/relay/" + opts.session;
      try { opts.log && opts.log("relay connected: " + pubUrl); } catch (e) {}
      try { opts.onStatus && opts.onStatus(true, pubUrl); } catch (e) {}
      pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping" })); } catch (e) {} }, 15000);
    };
    ws.onmessage = async (raw) => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type === "pong") return;
      if (m.type === "request" && m.id) {
        let out;
        try {
          const bodyStr = typeof m.body === "string" ? m.body : JSON.stringify(m.body || {});
          out = await opts.handle(m.method || "GET", m.path || "/api/health", bodyStr);
        } catch (e) { out = { status: 500, body: { error: String(e && e.message || e) } }; }
        try { ws.send(JSON.stringify({ type: "response", id: m.id, status: out.status, body: out.body })); } catch (e) {}
      }
    };
    ws.onclose = () => { connected = false; if (pingTimer) clearInterval(pingTimer); pingTimer = null; pubUrl = null; try { opts.onStatus && opts.onStatus(false, ""); } catch (e) {} schedule(); };
    ws.onerror = () => {};
    try { ws.connect(); } catch (e) { schedule(); }
  }
  open();
  return {
    stop() { stopped = true; if (pingTimer) clearInterval(pingTimer); if (reconnectTimer) clearTimeout(reconnectTimer); try { ws && ws.close(); } catch (e) {} },
    isConnected: () => connected,
    publicUrl: () => pubUrl,
  };
}

// ═══════════════════════════════════════════════════════════
// 工作区 + 机器信息
// ═══════════════════════════════════════════════════════════

function workspaceInfo() {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const root = folders[0] || os.homedir();
  return {
    name: vscode.workspace.name || (folders[0] ? path.basename(folders[0]) : "(无工作区)"),
    root,
    folders,
    host: os.hostname(),
    user: os.userInfo().username,
    platform: `${os.platform()} ${os.release()}`,
    ide: vscode.env.appName,
    ideVersion: vscode.version,
    machineId: vscode.env.machineId,
    sessionId: vscode.env.sessionId,
  };
}

function withinRoot(root, p) {
  try {
    const abs = path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return abs;
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
  } catch (e) {}
  return null;
}

// ═══════════════════════════════════════════════════════════
// CloudFlare 账号自动化 — 帛书·「反者道之动」
// 用户只需输入 email + API Key(Global) → 全链路打通
// ═══════════════════════════════════════════════════════════

function loadCfCredentials() {
  const credFile = path.join(daoDir(), "cf-credentials.json");
  try { return JSON.parse(fs.readFileSync(credFile, "utf8")); } catch (e) {}
  return null;
}

// 守母: 命名隧道配置从 ~/.dao 凭证库自动加载 — 用户无需触碰 IDE 设置
// 来源(优先级): ~/.dao/bridge/named-tunnel.json → ~/.dao/dao-config.json
// 字段: cfTunnelToken/tunnelToken, cfHostname/hostname
function loadDaoTunnelConfig() {
  const out = { token: "", hostname: "" };
  const files = [
    path.join(daoDir(), "named-tunnel.json"),
    path.join(daoGlobalDir(), "dao-config.json"),
  ];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!out.token) out.token = String(j.cfTunnelToken || j.tunnelToken || "").trim();
      if (!out.hostname) out.hostname = String(j.cfHostname || j.hostname || "").trim();
    } catch (e) {}
  }
  return out;
}
function saveCfCredentials(creds) {
  const credFile = path.join(daoDir(), "cf-credentials.json");
  fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), "utf8");
}

function cfApiRequest(method, apiPath, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: "api.cloudflare.com",
      path: "/client/v4" + apiPath,
      method: method,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, text: d }); }
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    if (data) req.write(data);
    req.end();
  });
}

async function verifyCfToken(token) {
  const r = await cfApiRequest("GET", "/user/tokens/verify", token);
  return r.status === 200 && r.json && r.json.success;
}

// ═══════════════════════════════════════════════════════════
// 工作区本地服务 — CLOUD_AGENT_GUIDE.md 同构架构
// 帛书·「道生一」— 暴露完整能力给公网
// ═══════════════════════════════════════════════════════════

// 被控端一行接入脚本(动态注入当前公网 URL)— 长轮询命令队列, 回传结果。
function buildBootstrap(hubUrl) {
  hubUrl = (hubUrl || "").replace(/\/$/, "");
  return `# dao 被控端 · 一行接入 · 道生一,一命接万机
$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
try{ $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8 }catch{}
$U='${hubUrl}'
function Dao-Post($path,$obj){ $b=[Text.Encoding]::UTF8.GetBytes(($obj|ConvertTo-Json -Depth 8 -Compress)); return irm "$U$path" -Method POST -Body $b -ContentType 'application/json; charset=utf-8' -TimeoutSec 35 }
$sys=@{ hostname=$env:COMPUTERNAME; username=$env:USERNAME; platform='win32'; os_version=[Environment]::OSVersion.VersionString; ps_version=$PSVersionTable.PSVersion.ToString(); capabilities=@('shell','cmd','run','detached') }
try { $reg = Dao-Post '/api/connect' @{sysinfo=$sys} } catch { Write-Host "[dao] connect failed: $($_.Exception.Message)" -ForegroundColor Red; return }
$aid=$reg.agent_id; $tok=$reg.token
Write-Host "[dao] 已接入中枢 as $aid  (Ctrl+C 退出)" -ForegroundColor Green
while($true){
  try{
    $poll = Dao-Post '/api/poll' @{id=$aid;token=$tok;timeout=25}
    foreach($c in @($poll.commands)){
      if(-not $c){ continue }
      $out=''; $err=''; $code=0
      $sw=[Diagnostics.Stopwatch]::StartNew()
      $global:LASTEXITCODE=0
      try{
        switch($c.type){
          'sysinfo' { $out = (Get-ComputerInfo | Out-String) }
          default {
            $Error.Clear()
            $ErrorActionPreference='Continue'
            $raw = Invoke-Expression $c.payload.command 2>&1
            $ErrorActionPreference='SilentlyContinue'
            $out = ($raw | Out-String)
            if($Error.Count -gt 0){
              $code=1
              $msgs = (@($Error | Select-Object -First 20) | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
              if([string]::IsNullOrWhiteSpace($out)){ $out=$msgs } else { $out = $out + [Environment]::NewLine + $msgs }
            }
            if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){ $code=$LASTEXITCODE }
          }
        }
      }catch{ $err=$_.Exception.Message; $code=1 }
      $sw.Stop()
      $res=@{ stdout=$out; stderr=$err; exit_code=$code; execution_time_ms=$sw.ElapsedMilliseconds }
      try{ Dao-Post '/api/result' @{agent_id=$aid;token=$tok;cmd_id=$c.cmd_id;result=$res} | Out-Null }catch{}
    }
  }catch{
    try{ $reg = Dao-Post '/api/connect' @{sysinfo=$sys}; $aid=$reg.agent_id; $tok=$reg.token }catch{ Start-Sleep 3 }
  }
}
`;
}

// Linux/macOS 被控端 · 一行接入：curl -fsSL <hub>/api/bootstrap.sh | sh
// bash 仅引导，connect→poll→exec→result 循环交给 python3（Linux/macOS 普遍自带），命令经 /bin/sh 执行；
// 登记 platform=本机平台，中枢据此按 POSIX 规范化下发指令。轮询用 POST /api/poll（与本中枢一致）。
function buildBootstrapSh(hubUrl) {
  hubUrl = (hubUrl || "").replace(/\/$/, "");
  return `#!/bin/sh
# dao Linux/macOS 被控端 · 一行接入 · 道生一,一命接万机
U="${hubUrl}"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "[dao] 需要 python3 才能接入（Linux/macOS 通常自带）"; exit 1; fi
exec "$PY" - "$U" <<'DAOEOF'
import sys, os, json, time, socket, platform, subprocess, urllib.request
U = sys.argv[1].rstrip('/')
SYSINFO = r'''echo '=== SYSTEM ==='; uname -a; echo; (lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null); echo; echo '=== CPU ==='; (lscpu 2>/dev/null | head -25 || sysctl -n machdep.cpu.brand_string 2>/dev/null); echo; echo '=== MEMORY ==='; (free -h 2>/dev/null || vm_stat 2>/dev/null); echo; echo '=== DISK ==='; df -h 2>/dev/null; echo; echo '=== UPTIME ==='; uptime 2>/dev/null'''
SYS = {
  'hostname': socket.gethostname(),
  'username': os.environ.get('USER') or os.environ.get('LOGNAME') or 'user',
  'platform': sys.platform,
  'os_version': ' '.join(platform.uname()),
  'capabilities': ['shell', 'run', 'detached', 'sysinfo'],
}
def post(path, obj):
    d = json.dumps(obj).encode('utf-8')
    req = urllib.request.Request(U + path, data=d, headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=40).read().decode('utf-8'))
def connect():
    r = post('/api/connect', {'sysinfo': SYS})
    return r['agent_id'], r['token']
aid, tok = connect()
sys.stderr.write('[dao] 已接入中枢 as %s  (Ctrl+C 退出)\\n' % aid)
while True:
    try:
        poll = post('/api/poll', {'id': aid, 'token': tok, 'timeout': 25})
        for c in (poll.get('commands') or []):
            if not c: continue
            t0 = time.time(); out = ''; err = ''; code = 0
            try:
                cmd = SYSINFO if c.get('type') == 'sysinfo' else (c.get('payload') or {}).get('command', '')
                p = subprocess.run(['/bin/sh', '-c', cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
                out = p.stdout.decode('utf-8', 'replace'); err = p.stderr.decode('utf-8', 'replace'); code = p.returncode
            except Exception as e:
                err = str(e); code = 1
            res = {'stdout': out, 'stderr': err, 'exit_code': code, 'execution_time_ms': int((time.time() - t0) * 1000)}
            try: post('/api/result', {'agent_id': aid, 'token': tok, 'cmd_id': c['cmd_id'], 'result': res})
            except Exception: pass
    except Exception:
        try: aid, tok = connect()
        except Exception: time.sleep(3)
DAOEOF
`;
}

class WorkspaceServer {
  constructor() {
    this.token = "";
    this.server = null;
    this.port = 0;
    this.agentRegistry = new Map();
    this.startedAt = null;
    this._bridgeRef = null;
    this.HEARTBEAT_TIMEOUT = 120 * 1000;
    this.POLL_MAX = 25; // < relay/cloudflared 单连超时, 留余量
  }

  // 刷新令牌（一刷即换）— 帛书·「反者道之动」: 生成全新随机令牌, 旧令牌即刻作废。
  rotateToken() {
    this.token = crypto.randomBytes(16).toString("hex");
    return this.token;
  }

  start(fixedPort) {
    return new Promise((resolve, reject) => {
      // 复用已保存的token
      const connFile = path.join(daoDir(), "conn.json");
      try {
        const old = JSON.parse(fs.readFileSync(connFile, "utf8"));
        if (old.token) this.token = old.token;
      } catch (e) {}
      if (!this.token) this.token = crypto.randomBytes(16).toString("hex");
      this.startedAt = new Date();

      const send = (res, code, obj) => {
        const b = Buffer.from(JSON.stringify(obj));
        res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
        res.end(b);
      };
      // HTTP 直连只做鉴权 + 收 body, 路由统一交给 handleApi(与 relay 转发共用一份契约)
      this.server = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
          return res.end();
        }
        const pathname = new URL(req.url, "http://x").pathname;
        if (pathname === "/api/bootstrap.ps1" || pathname === "/bootstrap.ps1") {
          const hubUrl = this._bridgeRef && this._bridgeRef.url ? this._bridgeRef.url : ("http://127.0.0.1:" + this.port);
          const sb = Buffer.from(buildBootstrap(hubUrl), "utf8");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": sb.length, "Access-Control-Allow-Origin": "*" });
          return res.end(sb);
        }
        if (pathname === "/api/bootstrap.sh" || pathname === "/bootstrap.sh") {
          const hubUrl = this._bridgeRef && this._bridgeRef.url ? this._bridgeRef.url : ("http://127.0.0.1:" + this.port);
          const sb = Buffer.from(buildBootstrapSh(hubUrl), "utf8");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": sb.length, "Access-Control-Allow-Origin": "*" });
          return res.end(sb);
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          let j = {};
          try { j = body ? JSON.parse(body) : {}; } catch (e) {}
          const authed = pathname === "/api/health" ? true : this.authToken(req.headers["authorization"] || "");
          try {
            const out = await this.handleApi(req.method || "GET", pathname, j, authed);
            send(res, out.status, out.body);
          } catch (e) { send(res, 500, { error: String(e && e.message) }); }
        });
      });
      this.server.on("error", reject);
      this.server.listen(fixedPort || 0, "127.0.0.1", () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  authToken(h) {
    if (h === "Bearer " + this.token) return true;
    const cfgToken = vscode.workspace.getConfiguration("daoBridge").get("accessToken") || "";
    if (cfgToken && h === "Bearer " + cfgToken) return true;
    return false;
  }

  // 解析目标路径 — 帛书·「整个电脑的穿透·工作区只是文本的一部分」
  // 默认整机: 绝对路径原样, 相对路径相对工作区根 → 云端 Agent 能操作全机。
  // 仅当用户显式开 daoBridge.confineToWorkspace 才沙箱在工作区内(越界返回 null)。
  resolveTarget(root, p, fallback) {
    const confine = vscode.workspace.getConfiguration("daoBridge").get("confineToWorkspace") === true;
    const raw = (p == null || p === "") ? (fallback || "") : p;
    if (confine) return withinRoot(root, raw);
    if (!raw) return root;
    return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  }

  // ── 演化·中枢分发：被控端登记 + 每 agent 命令队列/结果表/唤醒器(三明治 operator→hub→agent) ──
  registerAgent(sysinfo) {
    sysinfo = sysinfo || {};
    const id = sysinfo.hostname || ("agent-" + crypto.randomBytes(3).toString("hex"));
    const token = crypto.randomBytes(24).toString("hex");
    const existing = this.agentRegistry.get(id);
    if (existing) {
      existing.id = id; existing.token = token; existing.sysinfo = sysinfo;
      existing.lastSeen = Date.now(); existing.status = "online";
      existing.hostname = sysinfo.hostname || id;
      existing.capabilities = sysinfo.capabilities || existing.capabilities || ["shell"];
      if (!existing.queue) existing.queue = [];
      if (!existing.waiters) existing.waiters = [];
      if (!existing.results) existing.results = new Map();
      if (!existing.resultWaiters) existing.resultWaiters = new Map();
      return existing;
    }
    const a = {
      id, token, sysinfo, hostname: sysinfo.hostname || id,
      capabilities: sysinfo.capabilities || ["shell"],
      connectedAt: Date.now(), lastSeen: Date.now(), status: "online",
      queue: [], waiters: [], results: new Map(), resultWaiters: new Map(),
    };
    this.agentRegistry.set(id, a);
    return a;
  }
  getAgent(id) {
    if (!id) return null;
    let a = this.agentRegistry.get(id);
    if (a) { a.id = a.id || id; return a; }
    const t = String(id).toLowerCase();
    for (const [k, v] of this.agentRegistry) if (k.toLowerCase() === t) { v.id = v.id || k; return v; }
    return null;
  }
  agentAlive(a) {
    const ls = typeof a.lastSeen === "number" ? a.lastSeen : (Date.parse(a.lastSeen || 0) || 0);
    return Date.now() - ls < this.HEARTBEAT_TIMEOUT;
  }
  isSelf(agentId) {
    const k = String(agentId || "").toLowerCase().trim();
    return k === "" || k === "self" || k === "local" || k === os.hostname().toLowerCase();
  }
  queueCommand(agentId, type, payload) {
    const a = this.getAgent(agentId);
    if (!a) return { err: "agent not found" };
    if (!a.queue) a.queue = []; if (!a.waiters) a.waiters = [];
    const cmdId = "cmd_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
    a.queue.push({ cmd_id: cmdId, type: type || "shell", payload: payload || {} });
    const w = a.waiters.shift(); if (w) w();
    return { cmdId, agent: a };
  }
  pollCommands(a, timeoutSec) {
    a.lastSeen = Date.now(); a.status = "online";
    if (!a.queue) a.queue = []; if (!a.waiters) a.waiters = [];
    const ms = Math.min(timeoutSec || this.POLL_MAX, this.POLL_MAX) * 1000;
    return new Promise((resolve) => {
      if (a.queue.length) return resolve(a.queue.splice(0));
      let done = false;
      const finish = (cmds) => {
        if (done) return; done = true; clearTimeout(timer);
        const i = a.waiters.indexOf(wake); if (i >= 0) a.waiters.splice(i, 1);
        resolve(cmds);
      };
      const wake = () => finish(a.queue.splice(0));
      a.waiters.push(wake);
      const timer = setTimeout(() => finish([]), ms);
    });
  }
  submitResult(a, cmdId, result) {
    a.lastSeen = Date.now();
    if (!a.results) a.results = new Map();
    a.results.set(cmdId, Object.assign({ completed_at: Date.now() }, result));
    if (a.results.size > 100) {
      const oldest = [...a.results.entries()].sort((x, y) => (x[1].completed_at || 0) - (y[1].completed_at || 0));
      for (let i = 0; i < a.results.size - 100; i++) a.results.delete(oldest[i][0]);
    }
    const w = a.resultWaiters && a.resultWaiters.get(cmdId);
    if (w) w(a.results.get(cmdId));
  }
  waitResult(a, cmdId, timeoutMs) {
    return new Promise((resolve) => {
      const existing = a.results && a.results.get(cmdId);
      if (existing) return resolve(existing);
      if (!a.resultWaiters) a.resultWaiters = new Map();
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); a.resultWaiters.delete(cmdId); resolve(r); };
      a.resultWaiters.set(cmdId, finish);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }
  agentListFull() {
    const out = [];
    for (const [id, a] of this.agentRegistry) {
      const si = a.sysinfo || {};
      out.push({
        id,
        hostname: a.hostname || id,
        status: this.agentAlive(a) ? "online" : "offline",
        os: si.os_version || a.os || "?",
        user: si.username || a.user || "?",
        capabilities: a.capabilities || ["shell"],
        last_seen: typeof a.lastSeen === "number" ? new Date(a.lastSeen).toISOString() : (a.lastSeen || ""),
        pending: (a.queue && a.queue.length) || 0,
      });
    }
    return out;
  }

  // 统一路由(HTTP 直连 与 relay 转发共用)→ {status, body}。
  // authed=true: 调用方已鉴权(relay 在 /connect 时已用 token 校验)。
  // 重启/退出/热加载等异步副作用经 setTimeout 调度, 立即回 ack。
  async handleApi(method, pathname, j, authed) {
    j = j || {};
    const wsInfo = workspaceInfo();
    const root = wsInfo.root;
    const br = this._bridgeRef;
    const escapeErr = { status: 403, body: { error: "path escapes workspace root (daoBridge.confineToWorkspace)" } };

    if (pathname === "/api/health") {
      return { status: 200, body: {
        status: "ok", service: "dao-bridge", version: BRIDGE_VERSION,
        host: wsInfo.host, workspace: wsInfo.name,
        agents_online: this.agentRegistry.size,
        uptime: Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000),
      } };
    }
    // ── 演化·被控端端点(以 per-agent token 自证, 免 master token) + 一行接入脚本 ──
    if (pathname === "/api/bootstrap.ps1" || pathname === "/bootstrap.ps1") {
      const hubUrl = br && br.url ? br.url : ("http://127.0.0.1:" + this.port);
      return { status: 200, body: buildBootstrap(hubUrl) };
    }
    if (pathname === "/api/bootstrap.sh" || pathname === "/bootstrap.sh") {
      const hubUrl = br && br.url ? br.url : ("http://127.0.0.1:" + this.port);
      return { status: 200, body: buildBootstrapSh(hubUrl) };
    }
    if (pathname === "/api/connect" && method === "POST") {
      const a = this.registerAgent(j.sysinfo || j || {});
      try { if (br && br.notify) br.notify(); } catch (e) {}
      return { status: 200, body: { agent_id: a.id, token: a.token, server_time: new Date().toISOString() } };
    }
    if (pathname === "/api/poll" && method === "POST") {
      const a = this.getAgent(j.id);
      if (!a || a.token !== j.token) return { status: 401, body: { error: "unauthorized" } };
      const cmds = await this.pollCommands(a, parseInt(j.timeout, 10) || this.POLL_MAX);
      return { status: 200, body: { commands: cmds } };
    }
    if (pathname === "/api/result" && method === "POST") {
      const a = this.getAgent(j.agent_id);
      if (!a || a.token !== j.token) return { status: 401, body: { error: "unauthorized" } };
      this.submitResult(a, j.cmd_id, j.result || {});
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/api/heartbeat" && method === "POST") {
      const a = this.getAgent(j.agent_id);
      if (a && a.token === j.token) { a.lastSeen = Date.now(); a.status = "online"; }
      return { status: 200, body: { ok: true } };
    }

    if (!authed) return { status: 401, body: { error: "unauthorized" } };

    if (pathname === "/api/info" && method === "GET") return { status: 200, body: workspaceInfo() };
    if (pathname === "/api/agents" && method === "GET") {
      return { status: 200, body: { agents: this.agentListFull() } };
    }
    // 操控端拉取异步结果(/api/exec 返回 cmd_id 后凭此查询; broadcast 各路结果亦然)
    if (pathname === "/api/result-fetch" && method === "POST") {
      const a = this.getAgent(j.agent_id);
      if (!a) return { status: 404, body: { error: "agent not found" } };
      const r = a.results && a.results.get(j.cmd_id);
      if (!r) return { status: 200, body: { status: "pending", agent_id: a.id, cmd_id: j.cmd_id } };
      return { status: 200, body: { status: "completed", agent_id: a.id, cmd_id: j.cmd_id, result: r } };
    }
    if (pathname === "/api/bridge-state" && method === "GET") {
      return { status: 200, body: {
        url: br ? br.url : "", port: this.port, token: this.token,
        mode: br ? br.mode : "", tunnelPid: br && br.proc ? br.proc.pid : null,
        startedAt: this.startedAt ? this.startedAt.toISOString() : "",
        workspace: wsInfo, agents_online: this.agentRegistry.size,
      } };
    }
    if (pathname === "/api/attempt-log" && method === "GET") {
      return { status: 200, body: {
        mode: br ? br.mode : "", protocol: br ? br.protocol : "", proxy: br ? br.proxy : "",
        url: br ? br.url : "", cfBin: br ? br.cfBin : "", lastErr: br ? br.lastErr : "",
        attempts: br ? br.attemptLog : [],
      } };
    }
    if (pathname === "/api/export-cloud-md" && method === "GET") return { status: 200, body: { md: br ? br.generateCloudAgentMd() : "# DAO Bridge 未启动" } };
    if (pathname === "/api/export-local-md" && method === "GET") return { status: 200, body: { md: br ? br.generateLocalAgentMd() : "# DAO Bridge 未启动" } };

    // 命令执行 — 整机任意命令(整个电脑的穿透, 不受工作区限制)
    //   type=shell 且无 file → 向后兼容: 纯命令字符串仍走 cmd.exe(cp.exec)
    //   其余(run/cmd/detached 或带 file) → PowerShell & 调用运算符: .bat/.cmd/.exe/.ps1/后台进程皆可,
    //                                        UTF-8 中文回传 + 透传原生退出码, 含空格路径也安全。
    if ((pathname === "/api/exec" || pathname === "/api/exec-sync") && method === "POST") {
      const sync = pathname === "/api/exec-sync";
      const type = String(j.type || "shell").toLowerCase();
      const timeoutMs = Math.min(Number(j.timeout) || 60, 300) * 1000;
      // 按 agent_id 路由: SELF(中枢本机) → 本机执行; 否则 → 入队转发被控端(connect/poll/result)
      if (this.isSelf(j.agent_id)) {
        let r;
        if (type === "sysinfo") {
          r = await runPwsh(sysinfoCmd(process.platform), j.cwd || root, timeoutMs);
        } else if (type === "shell" && !j.file) {
          r = await new Promise((resolve) => {
            cp.exec(j.cmd || "", { cwd: j.cwd || root, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")), exit_code: err ? (err.code || 1) : 0 });
            });
          });
        } else {
          const command = buildExecCommand(j, process.platform);
          if (!command) return { status: 400, body: { error: "cmd/file required" } };
          r = await runPwsh(command, j.cwd || root, timeoutMs);
        }
        return sync ? { status: 200, body: { status: "completed", agent_id: wsInfo.host, result: r } } : { status: 200, body: r };
      }
      // 被控端按其登记平台规范化（Windows→PowerShell；Linux/macOS→/bin/sh），即"两套指令由中枢按目标自动选"。
      const tgt = this.getAgent(j.agent_id);
      if (!tgt) return { status: 404, body: { error: "agent not found" } };
      const ctype = type === "sysinfo" ? "sysinfo" : "shell";
      const payload = type === "sysinfo" ? {} : { command: buildExecCommand(j, platformOf(tgt)) };
      const qd = this.queueCommand(j.agent_id, ctype, payload);
      if (qd.err) return { status: 404, body: { error: qd.err } };
      if (!sync) return { status: 200, body: { cmd_id: qd.cmdId, agent_id: qd.agent.id, type } };
      const result = await this.waitResult(qd.agent, qd.cmdId, timeoutMs);
      if (!result) return { status: 504, body: { status: "timeout", agent_id: qd.agent.id, cmd_id: qd.cmdId } };
      return { status: 200, body: { status: "completed", agent_id: qd.agent.id, cmd_id: qd.cmdId, result } };
    }
    if (pathname === "/api/ls" && method === "POST") {
      const dir = this.resolveTarget(root, j.path, ".");
      if (!dir) return escapeErr;
      if (!fs.existsSync(dir)) return { status: 404, body: { error: "not found", path: dir } };
      const items = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
      return { status: 200, body: { path: dir, items } };
    }
    if (pathname === "/api/read" && method === "POST") {
      const fp = this.resolveTarget(root, j.path, "");
      if (!fp) return escapeErr;
      if (!fs.existsSync(fp)) return { status: 404, body: { error: "not found", path: fp } };
      return { status: 200, body: { path: fp, content: fs.readFileSync(fp, "utf8") } };
    }
    if (pathname === "/api/write" && method === "POST") {
      const fp = this.resolveTarget(root, j.path, "");
      if (!fp) return escapeErr;
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, j.content == null ? "" : String(j.content), "utf8");
      return { status: 200, body: { path: fp, ok: true } };
    }
    if (pathname === "/api/agent/register" && method === "POST") {
      const agentId = j.agent_id || j.id || "";
      if (!agentId) return { status: 400, body: { error: "agent_id required" } };
      this.agentRegistry.set(agentId, {
        hostname: j.hostname || "", status: "online", lastSeen: new Date().toISOString(),
        capabilities: j.capabilities || ["shell", "cmd", "run", "detached", "file_read", "file_write"], url: j.url || "",
      });
      return { status: 200, body: { ok: true, agent_id: agentId } };
    }
    if (pathname === "/api/agent/heartbeat" && method === "POST") {
      const existing = this.agentRegistry.get(j.agent_id || j.id || "");
      if (existing) { existing.lastSeen = new Date().toISOString(); existing.status = "online"; }
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/api/broadcast" && method === "POST") {
      const delivered = [];
      for (const [id, a] of this.agentRegistry) {
        const qd = this.queueCommand(id, "shell", { command: buildExecCommand(j, platformOf(a)) });
        if (qd.cmdId) delivered.push({ agent_id: id, cmd_id: qd.cmdId });
      }
      return { status: 200, body: { ok: true, delivered } };
    }
    if (pathname === "/api/config" && method === "GET") {
      const cfg = vscode.workspace.getConfiguration("daoBridge");
      return { status: 200, body: {
        tunnelToken: cfg.get("tunnelToken") || "", hostname: cfg.get("hostname") || "",
        localPort: cfg.get("localPort") || 0, cloudflaredPath: cfg.get("cloudflaredPath") || "",
        relayUrl: cfg.get("relayUrl") || "", session: cfg.get("session") || "",
        confineToWorkspace: cfg.get("confineToWorkspace") === true,
      } };
    }
    if (pathname === "/api/config" && method === "POST") {
      const cfg = vscode.workspace.getConfiguration("daoBridge");
      try {
        for (const k of ["tunnelToken", "hostname", "localPort", "cloudflaredPath", "relayUrl", "session"])
          if (j[k] !== undefined) await cfg.update(k, j[k], true);
        return { status: 200, body: { ok: true } };
      } catch (e) { return { status: 500, body: { error: String(e && e.message || e) } }; }
    }
    // 本地Agent深度操控: 重启隧道(URL 可能变, 重读 conn.json)
    if (pathname === "/api/bridge/restart" && method === "POST") {
      if (br) setTimeout(async () => { try { br.stop(); await br.start(); } catch (e) {} }, 200);
      return { status: 200, body: { ok: true, note: "tunnel restarting; re-read ~/.dao/bridge/conn.json for new url/token" } };
    }
    if (pathname === "/api/account/logout" && method === "POST") {
      if (br) setTimeout(async () => { try { await br.resetAccount(); br.stop(); await br.start(); } catch (e) {} }, 200);
      return { status: 200, body: { ok: true, note: "account reset + restart; re-read conn.json" } };
    }
    if (pathname === "/api/export/refresh" && method === "POST") {
      if (!br) return { status: 503, body: { error: "bridge not ready" } };
      br.writeArtifacts();
      return { status: 200, body: { ok: true, cloud_md_path: br.mdPath(), local_md_path: br.localAgentMdPath(), cloud_md: br.generateCloudAgentMd(), local_md: br.generateLocalAgentMd() } };
    }
    if (pathname === "/api/self/reload" && method === "POST") {
      setTimeout(() => { try { vscode.commands.executeCommand("workbench.action.reloadWindow"); } catch (e) {} }, 600);
      return { status: 200, body: { ok: true, note: "reloading window in 600ms; extension host restarts (disruptive to active UI)" } };
    }
    return { status: 404, body: { error: "not found", route: pathname } };
  }

  stop() { try { this.server && this.server.close(); } catch (e) {} this.server = null; }
}

// ═══════════════════════════════════════════════════════════
// Bridge 隧道生命周期 — 帛书·「道生一·一生二·二生三」
// 一键启动 → cloudflared tunnel → 整台机器公网穿透
// ═══════════════════════════════════════════════════════════

class Bridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.srv = new WorkspaceServer();
    this.proc = null;
    this.url = "";
    this.startedAt = null;
    this.onUpdate = null;
    this.lastErr = "";
    this.mode = "quick";
    this.protocol = "";
    this.proxy = "";
    this.cfBin = "";
    this.attemptLog = [];
    this._starting = false;
    this.relay = null; // 活跃的 Worker 中继(connectRelayWs 控制器)
    this.cfCredentials = loadCfCredentials();
    this.srv._bridgeRef = this;
    // 自愈看门狗状态 — 跨 stop()/start() 存活, 仅 deactivate 才停
    this._wd = null;
    this._healthFails = 0;
    this._healing = false;
    this._wdBusy = false;
    this._lastOkAt = 0;
    this._wdThreshold = 2;
  }

  // ═══════════════════════════════════════════════════════════
  // 自愈看门狗 — 帛书·「天网恢恢，疏而不失」
  // 只要 IDE(扩展宿主)在跑, 就周期回环自检: 主动打自己的公网 URL /api/health,
  // 端到端验证隧道真的可达(可识破 socket 假死/息屏后僵尸连接 — 仅靠 WS 关闭事件抓不到)。
  // 连续失败即自动重连; relay/named 复用 session/域名→URL 稳定, 被控端无感; quick 会换 URL 并重写 MD。
  // IDE 关闭 → deactivate → stopWatchdog, 一并停。
  // ═══════════════════════════════════════════════════════════
  startWatchdog() {
    if (this._wd) return; // 幂等
    let iv = 20000, th = 2;
    try { const c = vscode.workspace.getConfiguration("daoBridge"); iv = parseInt(c.get("watchdogIntervalMs"), 10) || 20000; th = parseInt(c.get("watchdogFailThreshold"), 10) || 2; } catch (e) {}
    this._wdThreshold = Math.max(1, th);
    this._wd = setInterval(() => { this._wdTick(); }, Math.max(5000, iv));
  }
  stopWatchdog() { if (this._wd) { clearInterval(this._wd); this._wd = null; } }

  async _wdTick() {
    if (this._starting || this._healing || this._wdBusy) return;
    this._wdBusy = true;
    try {
      const ok = await this._publicHealthCheck();
      if (ok) { this._healthFails = 0; this._lastOkAt = Date.now(); }
      else {
        this._healthFails++;
        this.lastErr = "回环自检失败 ×" + this._healthFails + (this.url ? (" (" + this.url + ")") : " (无公网URL)");
        this.notify();
        if (this._healthFails >= this._wdThreshold) await this._heal();
      }
    } catch (e) { /* 自检本身异常不打断看门狗 */ }
    finally { this._wdBusy = false; }
  }

  async _heal() {
    if (this._starting || this._healing) return;
    this._healing = true;
    const prevUrl = this.url;
    try {
      this.lastErr = "自愈: 隧道不可达, 自动重连中…"; this.notify();
      this.stop();
      const url = await this.start();
      this._healthFails = 0;
      if (url) { this._lastOkAt = Date.now(); this.lastErr = "自愈完成: " + (url === prevUrl ? "URL 不变" : "新 URL " + url); }
      this.notify();
    } catch (e) { this.lastErr = "自愈异常: " + (e && e.message); }
    finally { this._healing = false; }
  }

  // 端到端回环: 经公网 URL 打 /api/health(relay 走信封, 透明反代直打), 8s 超时。
  _publicHealthCheck() {
    return new Promise((resolve) => {
      const u = this.url;
      if (!u) return resolve(false);
      const relay = this.mode === "relay" || /\/relay\//.test(u);
      let target, postData = null;
      const headers = { "User-Agent": UA };
      try {
        if (relay) {
          target = new URL(u);
          postData = JSON.stringify({ path: "/api/health", method: "GET", body: {} });
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = Buffer.byteLength(postData);
        } else {
          target = new URL(u.replace(/\/$/, "") + "/api/health");
        }
      } catch (e) { return resolve(false); }
      const lib = target.protocol === "http:" ? http : https;
      const req = lib.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + (target.search || ""),
        method: relay ? "POST" : "GET",
        headers,
      }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(false);
          try { const j = JSON.parse(d); resolve(!j.error); } catch (e) { resolve(true); }
        });
      });
      req.on("error", () => resolve(false));
      req.setTimeout(8000, () => { try { req.destroy(); } catch (e) {} resolve(false); });
      if (postData) req.write(postData);
      req.end();
    });
  }

  // 中继尝试 — 出站 WSS 连 Worker。初连窗口内握手成功即采用并持有(后台自动重连);
  // 窗口内连不上则停掉中继, 让上层回退 cloudflared。
  _runRelayAttempt(relayUrl, session, proxy) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
      try { if (this.relay) { this.relay.stop(); this.relay = null; } } catch (e) {}
      this.relay = connectRelayWs({
        relayUrl, session, token: this.srv.token, proxy,
        handle: (m, p, bodyStr) => { let j = {}; try { j = bodyStr ? JSON.parse(bodyStr) : {}; } catch (e) {} return this.srv.handleApi(m, p, j, true); },
        log: (msg) => { this.lastErr = msg; },
        onStatus: (up, url) => { if (up) { this.url = url; this.mode = "relay"; this.protocol = "wss"; this.notify(); finish(true); } },
      });
      const timer = setTimeout(() => { if (!settled) { try { this.relay.stop(); } catch (e) {} this.relay = null; finish(false); } }, 9000);
    });
  }
  mdPath() { return path.join(daoDir(), "workspace.md"); }
  bootstrapCmd() { const u = (this.url || "").replace(/\/$/, ""); return "irm " + (u || "<公网URL>") + "/api/bootstrap.ps1 | iex"; }
  localAgentMdPath() { return path.join(daoDir(), "local-agent-access.md"); }
  connPath() { return path.join(daoDir(), "conn.json"); }
  globalConnPath() { return path.join(daoGlobalDir(), "cf-hub-conn.json"); }

  // ═══════════════════════════════════════════════════════════
  // 启动 — 帛书·「反者道之动也，弱者道之用也」
  // 自动回退链(用户最小输入, 系统无不为):
  //   ① 命名隧道(用户 Cloudflare 通道·固定域名) — 若配置了 token
  //   ② 原生快速隧道(无账号·trycloudflare) — 永远兜底
  //   每档再做 quic↔http2 协议回退(国内/GFW 优先 http2 走代理)
  // 任一档打通即停; 全失败才如实报错。绝不卡死在某一种模式。
  // ═══════════════════════════════════════════════════════════
  async start() {
    if (this._starting) return this.url;
    this._starting = true;
    try {
      this.startedAt = new Date();
      this.url = ""; this.lastErr = ""; this.attemptLog = [];
      const cfg = vscode.workspace.getConfiguration("daoBridge");
      let tunnelToken = String(cfg.get("tunnelToken") || "").trim();
      let hostname = String(cfg.get("hostname") || "").trim();
      // 守母: IDE 设置为空时自动从 ~/.dao 凭证库取命名隧道配置 — 零设置项介入
      if (!tunnelToken) { const dc = loadDaoTunnelConfig(); if (dc.token) tunnelToken = dc.token; if (!hostname && dc.hostname) hostname = dc.hostname; }
      const fixedPort = parseInt(cfg.get("localPort"), 10) || 0;
      const proxy = detectProxy();
      this.proxy = proxy;

      // 本地服务先起(token + 统一路由就绪), relay 与 cloudflared 皆复用之
      const port = await this.srv.start(tunnelToken ? (fixedPort || 9910) : (fixedPort || 0));

      // ① 默认通道: Worker+DurableObject 出站中继 — 帛书·「反者道之动」。
      //    零 Cloudflare 账号 / URL 天然稳定(*.workers.dev/relay/<session>) / 纯出站适配一切(无 50MB 二进制)。
      //    一举正面化解「自动安装中断」「认证成本」「跨平台」三件事; 连不上才退 cloudflared。
      const relayUrl = String(cfg.get("relayUrl") || DEFAULT_RELAY_URL).trim();
      if (cfg.get("disableRelay") !== true && relayUrl) {
        const session = String(cfg.get("session") || "").trim() || os.hostname();
        this.mode = "relay"; this.protocol = "wss"; this.notify();
        const ok = await this._runRelayAttempt(relayUrl, session, proxy);
        this.attemptLog.push({ mode: "relay", proto: "wss", ok, url: ok ? this.url : "" });
        if (ok) { this.writeArtifacts(); this.notify(); return this.url; }
        this.lastErr = "中继未连通(" + relayUrl + ")，回退 cloudflared…"; this.notify();
      }

      // ② 回退: cloudflared 隧道。内置优先, 缺失则多镜像下载(含国内加速) — 不依赖用户手动安装
      let bin = findCloudflared(this.ctx);
      if (!bin) { this.lastErr = "cloudflared 缺失，正在内置/下载…"; this.notify(); bin = await downloadCloudflared((m) => { this.lastErr = m; this.notify(); }); }
      if (!bin) { this.lastErr = "中继未连通且 cloudflared 不可用（内置缺失 + 多镜像下载均失败）— 请检查网络或在设置填 cloudflaredPath"; this.writeArtifacts(); this.notify(); return ""; }
      this.cfBin = bin;

      // 协议: http2 优先 — TCP/443, 穿透性最强(代理/GFW/企业网友好)。
      // 实测多数网络(含国内、本测试机)UDP/7844 被封, quic 必失败; cloudflared 自身亦会
      // quic→http2 预检回退, 故直接 http2 最快最稳。quic 仅作兜底(极少数仅放行 UDP 的网络)。
      const attempts = [];
      if (tunnelToken) attempts.push({ mode: "named", proto: "http2", tunnelToken, hostname });
      attempts.push({ mode: "quick", proto: "http2", port });
      if (tunnelToken) attempts.push({ mode: "named", proto: "quic", tunnelToken, hostname });
      attempts.push({ mode: "quick", proto: "quic", port });

      for (const a of attempts) {
        this.mode = a.mode; this.protocol = a.proto; this.notify();
        const ok = await this._runAttempt(bin, a, port, proxy);
        this.attemptLog.push({ mode: a.mode, proto: a.proto, ok, url: ok ? this.url : "" });
        if (ok) { this.writeArtifacts(); this.notify(); return this.url; }
        try { if (this.proc) this.proc.kill(); } catch (e) {}
        this.proc = null;
      }
      this.lastErr = "全部回退均失败（" + attempts.map((a) => a.mode + "/" + a.proto).join(" → ") + "）"
        + (proxy ? " · 已尝试代理 " + proxy : " · 未发现可用代理") + " — 疑似网络/GFW 阻断 Cloudflare 边缘";
      this.writeArtifacts(); this.notify();
      return "";
    } finally { this._starting = false; }
  }

  // 单次尝试: spawn cloudflared, 等待"已就绪"信号或超时
  _runAttempt(bin, a, port, proxy) {
    return new Promise((resolve) => {
      this.url = a.mode === "named" && a.hostname
        ? (/^https?:\/\//.test(a.hostname) ? a.hostname : "https://" + a.hostname) : "";
      const args = a.mode === "named"
        ? ["tunnel", "--no-autoupdate", "--protocol", a.proto, "run", "--token", a.tunnelToken]
        : ["tunnel", "--no-autoupdate", "--protocol", a.proto, "--url", "http://127.0.0.1:" + port];
      let settled = false;
      let registered = false; // 真正与边缘建立连接(而非仅打印 URL)
      const REG_RE = /Registered tunnel connection|Connection [0-9a-f-]+ registered|Updated to new configuration/i;
      // 硬失败信号: 预检全失败 / 边缘不可达 — 立即放弃本档, 不空等超时
      const HARD_FAIL_RE = /failed to connect to the edge|hard_fail=true|no more connections active and exiting|context canceled|Unauthorized|tunnel credentials|token is invalid|invalid tunnel/i;
      const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
      let proc;
      try { proc = cp.spawn(bin, args, { windowsHide: true, env: spawnEnv(proxy) }); }
      catch (e) { this.lastErr = String(e && e.message); return finish(false); }
      this.proc = proc;
      const onData = (buf) => {
        const s = buf.toString();
        // 快速隧道: 先捕获临时 URL(但此时尚未连通, 不能据此判成功)
        if (a.mode !== "named") { const m = s.match(TRY_RE); if (m && !this.url) { this.url = m[0]; this.notify(); } }
        // 唯一可信的"已就绪"信号: 边缘连接真正注册成功(named/quick 同理)
        if (REG_RE.test(s)) {
          registered = true;
          if (a.mode === "named" || this.url) finish(true);
        }
        if (HARD_FAIL_RE.test(s)) {
          const line = (s.match(HARD_FAIL_RE) || [s])[0];
          this.lastErr = String(line).slice(0, 220);
          if (!registered) finish(false);
        } else if (/failed to|error=|unable to|connection refused|timeout/i.test(s)) {
          const line = s.trim().split(/\r?\n/).slice(-1)[0];
          if (line) this.lastErr = line.slice(0, 220);
        }
      };
      try { proc.stdout.on("data", onData); proc.stderr.on("data", onData); } catch (e) {}
      proc.on("error", (e) => { this.lastErr = String(e && e.message); finish(false); });
      proc.on("exit", (code) => {
        if (!settled) { this.lastErr = "cloudflared 退出(code=" + code + ", " + a.mode + "/" + a.proto + ")"; finish(false); }
        else if (a.mode !== "named") { this.url = ""; this.notify(); }
      });
      // http2 直连含预检+注册约需 8~18s; quic 在被封网络上必超时, 给足回退时间
      const timer = setTimeout(() => finish(registered && (a.mode === "named" || !!this.url)), a.proto === "quic" ? 26000 : 22000);
    });
  }

  notify() { try { this.onUpdate && this.onUpdate(this.state()); } catch (e) {} }
  state() {
    return {
      url: this.url, port: this.srv.port, token: this.srv.token,
      ws: workspaceInfo(), startedAt: this.startedAt, lastErr: this.lastErr,
      mdPath: this.mdPath(), mode: this.mode, protocol: this.protocol, version: BRIDGE_VERSION,
      proxy: this.proxy, attempts: this.attemptLog,
      cfLoggedIn: !!(this.cfCredentials && (this.cfCredentials.apiToken || this.cfCredentials.globalApiKey || this.cfCredentials.tunnelToken)),
      cfEmail: this.cfCredentials ? this.cfCredentials.email || "" : "",
      agentCount: this.srv.agentRegistry.size,
      bootstrap: this.bootstrapCmd(),
      lastOkAt: this._lastOkAt, healing: this._healing, healthFails: this._healthFails,
    };
  }

  // 刷新令牌（点一下，换一次）— 帛书·「反者道之动」: 生成全新令牌, 旧令牌即刻作废,
  // 再用新令牌重连公网通道(中继按 (session,token) 配对, 旧 token 落空→no_agent)。
  async refreshToken() {
    if (this._starting) return { ok: false, message: "隧道正在启动，请稍候再刷新" };
    const fresh = this.srv.rotateToken();
    this.writeArtifacts(); // 先把新令牌落盘, 供 start() 复用
    this.stop();           // 收掉旧通道(旧令牌随之作废)
    const url = await this.start(); // 用新令牌重连
    return { ok: true, token: fresh, url };
  }

  // ═══════════════════════════════════════════════════════════
  // CloudFlare 账号登录 — 帛书·「反者道之动」
  // 用户输入 email + Global API Key → 验证 → 保存 → 自动打通
  // ═══════════════════════════════════════════════════════════

  async loginCloudFlare(email, apiKeyOrToken) {
    // 尝试作为API Token验证
    const ok = await verifyCfToken(apiKeyOrToken);
    if (ok) {
      this.cfCredentials = { email, apiToken: apiKeyOrToken, source: "api-token", savedAt: new Date().toISOString() };
      saveCfCredentials(this.cfCredentials);
      return { ok: true, message: "CloudFlare API Token 验证成功" };
    }
    // 尝试作为Global API Key
    const r = await new Promise((resolve) => {
      const opts = {
        hostname: "api.cloudflare.com", path: "/client/v4/user", method: "GET",
        headers: { "X-Auth-Email": email, "X-Auth-Key": apiKeyOrToken, "Content-Type": "application/json", "User-Agent": UA },
      };
      const req = https.request(opts, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, text: d }); } });
      });
      req.on("error", (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
      req.end();
    });
    if (r.status === 200 && r.json && r.json.success) {
      this.cfCredentials = { email, globalApiKey: apiKeyOrToken, source: "global-api-key", savedAt: new Date().toISOString() };
      saveCfCredentials(this.cfCredentials);
      return { ok: true, message: "CloudFlare Global API Key 验证成功" };
    }
    // 守柔: 既非 API Token 也非 Global Key, 但形似 cloudflared 命名隧道令牌(长 base64/JWT)
    // → 持久化到 ~/.dao/bridge/named-tunnel.json, 下次重启自动以命名隧道(固定域名)启动
    const tok = String(apiKeyOrToken || "").trim();
    if (tok.length >= 100 && /^[A-Za-z0-9_\-=.]+$/.test(tok)) {
      try {
        fs.writeFileSync(path.join(daoDir(), "named-tunnel.json"),
          JSON.stringify({ cfTunnelToken: tok, email, savedAt: new Date().toISOString() }, null, 2), "utf8");
        return { ok: true, message: "已保存命名隧道令牌 — 点击「重启隧道」即以固定域名启动" };
      } catch (e) {}
    }
    return { ok: false, message: "CloudFlare 验证失败 — 请检查 email 和 API Key/Token（如仅用快速隧道则无需填写）" };
  }

  // ═══════════════════════════════════════════════════════════
  // 退出账号 / 重置为无账号模式 — 帛书·「为学者日益，闻道者日损。损之又损，以至于无为」
  // 清除全部 CloudFlare 账号/令牌残留(含「之前添加过账号」的 cloudflared cert),
  // 回到零配置原生快速隧道。清除前先备份到 ~/.dao/bridge/reset-backup-<ts>/, 不臆造、不误删。
  // ═══════════════════════════════════════════════════════════
  async resetAccount() {
    const removed = [];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(daoDir(), "reset-backup-" + ts);
    const backup = (src) => {
      try {
        if (!fs.existsSync(src)) return false;
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
        fs.unlinkSync(src);
        removed.push(src);
        return true;
      } catch (e) { return false; }
    };
    // ① dao 自管的命名隧道令牌 / CF 凭证
    backup(path.join(daoDir(), "named-tunnel.json"));
    backup(path.join(daoDir(), "cf-credentials.json"));
    // ② dao-config.json 里若写了 cfTunnelToken/cfHostname → 抹掉这些字段(保留其余)
    try {
      const dc = path.join(daoGlobalDir(), "dao-config.json");
      if (fs.existsSync(dc)) {
        const j = JSON.parse(fs.readFileSync(dc, "utf8"));
        let touched = false;
        for (const k of ["cfTunnelToken", "tunnelToken", "cfHostname", "hostname"]) if (k in j) { delete j[k]; touched = true; }
        if (touched) { fs.writeFileSync(dc, JSON.stringify(j, null, 2), "utf8"); removed.push(dc + "(字段)"); }
      }
    } catch (e) {}
    // ③ cloudflared 浏览器登录残留(cert.pem + 隧道凭证 json) — 「之前添加过账号」的根因常在此
    try {
      const cfHome = path.join(os.homedir(), ".cloudflared");
      if (fs.existsSync(cfHome)) {
        for (const f of fs.readdirSync(cfHome)) {
          if (f === "cert.pem" || /\.json$/i.test(f)) backup(path.join(cfHome, f));
        }
      }
    } catch (e) {}
    // ④ IDE 设置项清空(全局)
    try {
      const cfg = vscode.workspace.getConfiguration("daoBridge");
      for (const k of ["tunnelToken", "hostname", "cfApiToken"]) {
        try { await cfg.update(k, "", vscode.ConfigurationTarget.Global); } catch (e) {}
      }
    } catch (e) {}
    this.cfCredentials = null;
    this.notify();
    return { ok: true, message: "已退出账号并清空全部凭证残留" + (removed.length ? "（备份于 " + backupDir + "）" : ""), removed };
  }

  // ═══════════════════════════════════════════════════════════
  // 用浏览器登录 Cloudflare(GitHub 账号亦可) → cert.pem — 帛书·「太上，下知有之」
  // 仅适用于"已有自有域名"的用户(想要固定公网域名)。无域名用户无需此步, 默认快速隧道即用。
  // ═══════════════════════════════════════════════════════════
  cfTunnelLogin() {
    return new Promise((resolve) => {
      const bin = this.cfBin || findCloudflared(this.ctx);
      if (!bin) return resolve({ ok: false, message: "cloudflared 不可用" });
      const cert = path.join(os.homedir(), ".cloudflared", "cert.pem");
      let proc;
      try { proc = cp.spawn(bin, ["tunnel", "login"], { windowsHide: true, env: spawnEnv(this.proxy || detectProxy()) }); }
      catch (e) { return resolve({ ok: false, message: String(e && e.message) }); }
      let opened = false;
      const onData = (buf) => {
        const s = buf.toString();
        const m = s.match(/https:\/\/dash\.cloudflare\.com\/[^\s]+/i);
        if (m && !opened) { opened = true; try { vscode.env.openExternal(vscode.Uri.parse(m[0])); } catch (e) {} }
      };
      try { proc.stdout.on("data", onData); proc.stderr.on("data", onData); } catch (e) {}
      // 轮询 cert.pem 出现(用户在浏览器授权后 cloudflared 写出)
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (fs.existsSync(cert)) { clearInterval(iv); try { proc.kill(); } catch (e) {} resolve({ ok: true, message: "Cloudflare 浏览器登录成功（已获取 cert.pem）" }); }
        else if (Date.now() - t0 > 180000) { clearInterval(iv); try { proc.kill(); } catch (e) {} resolve({ ok: false, message: "登录超时（180s 内未完成浏览器授权）" }); }
      }, 1500);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MD文档生成 — 帛书·「始制有名」
  // ═══════════════════════════════════════════════════════════

  generateCloudAgentMd() {
    const wsInfo = workspaceInfo();
    const ts = new Date().toISOString();
    const relay = this.mode === "relay";
    const modeLabel = relay
      ? "relay (Worker 中继·稳定 URL·零账号)"
      : (this.mode === "named" ? "named (命名隧道·稳定 URL)" : "quick (临时 URL)");
    return [
      "# ☯ DAO Bridge · 云端Agent接入文档",
      "",
      "> 道法自然 · 本文档自动生成。把它发给云端 Agent 即可接到当前机器。",
      "",
      "## 接入点",
      "",
      "```",
      "URL:   " + (this.url || "(隧道启动中…)"),
      "Token: " + this.srv.token,
      "Auth:  Authorization: Bearer <Token>",
      "Mode:  " + modeLabel + (this.protocol ? " · proto=" + this.protocol : "") + (this.proxy ? " · proxy=" + this.proxy : ""),
      "```",
      "",
      ...(relay ? [
        "> ⚠ 中继模式：URL 不是透明反代，而是**信封端点**。请把请求包成信封 `POST <URL>` body `{path,method,body}` —",
        "> 例：`POST <URL>` `{\"path\":\"/api/exec-sync\",\"method\":\"POST\",\"body\":{\"cmd\":\"hostname\"}}`。下方 SDK 的 `api()` 已自动适配，照常调用即可。",
        "",
      ] : []),
      "## 机器信息",
      "",
      "| 项 | 值 |",
      "|---|---|",
      "| 主机 | " + wsInfo.host + " (" + wsInfo.user + ") |",
      "| 平台 | " + wsInfo.platform + " |",
      "| 工作区 | " + wsInfo.name + " |",
      "| 根目录 | `" + wsInfo.root + "` |",
      "| IDE | " + wsInfo.ide + " " + wsInfo.ideVersion + " |",
      "| 在线Agent数 | " + this.srv.agentRegistry.size + " |",
      "| 更新于 | " + ts + " |",
      "",
      "## API 参考",
      "",
      "所有请求 Header: `Authorization: Bearer " + this.srv.token + "`",
      "",
      "| 方法 | 路径 | Body | 说明 |",
      "|---|---|---|---|",
      "| GET | `/api/health` | - | 存活 (免鉴权) |",
      "| GET | `/api/info` | - | 工作区信息 |",
      "| GET | `/api/agents` | - | 在线Agent列表 |",
      "| GET | `/api/bridge-state` | - | 隧道状态 |",
      "| POST | `/api/exec` | `{agent_id,type,cmd,file,args,cwd,timeout}` | 执行命令(type: shell/cmd/run/detached·中枢按被控端平台自动选 PS/POSIX) |",
      "| POST | `/api/exec-sync` | `{agent_id,type,cmd,file,args,cwd,timeout}` | 同步执行(Win 跑 .bat/.exe/.ps1+args；Linux/macOS 走 /bin/sh) |",
      "| | | 例 `{type:'run',file:'C:\\\\a\\\\b.bat',args:['x']}` / `{type:'run',file:'/opt/a.sh'}` / `{type:'detached',file:'app'}` | |",
      "| GET | `/api/bootstrap.ps1` | - | 被控端一行接入·Windows(`irm <URL>/api/bootstrap.ps1\\|iex`·免鉴权) |",
      "| GET | `/api/bootstrap.sh` | - | 被控端一行接入·Linux/macOS(`curl -fsSL <URL>/api/bootstrap.sh\\|sh`·免鉴权) |",
      "| POST | `/api/ls` | `{path}` | 列目录 |",
      "| POST | `/api/read` | `{path}` | 读文件 |",
      "| POST | `/api/write` | `{path,content}` | 写文件 |",
      "| POST | `/api/broadcast` | `{type,payload}` | 广播 |",
      "| GET | `/api/export-cloud-md` | - | 导出本文档 |",
      "| GET | `/api/export-local-md` | - | 导出本地Agent配置文档 |",
      "| GET | `/api/attempt-log` | - | 隧道回退链诊断 |",
      "| GET/POST | `/api/config` | `{tunnelToken,hostname,localPort,cloudflaredPath}` | 读/写插件配置 |",
      "| POST | `/api/bridge/restart` | - | 重启隧道(URL会变,重读conn.json) |",
      "| POST | `/api/account/logout` | - | 退出账号→无账号快速隧道 |",
      "| POST | `/api/export/refresh` | - | 重生成并落盘两个MD |",
      "| POST | `/api/self/reload` | - | 重载窗口(热加载新插件代码·会打断UI) |",
      "",
      "## Python SDK",
      "",
      "```python",
      "import urllib.request, json, ssl, os",
      "for k in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'): os.environ.pop(k,None)",
      "os.environ['NO_PROXY']='*'",
      "ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE",
      "urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx)))",
      'URL="' + (this.url || "https://<见上>.trycloudflare.com") + '"',
      'TOKEN="' + this.srv.token + '"',
      "RELAY=('/relay/' in URL)  # 中继=信封端点; 直连=透明反代。同一份 api() 两者通用",
      "def api(m,p,body=None,t=30):",
      "    if RELAY:",
      "        url=URL; method='POST'; d=json.dumps({'path':p,'method':m,'body':body or {}}).encode()",
      "    else:",
      "        url=f'{URL}{p}'; method=m; d=json.dumps(body).encode() if body else None",
      '    req=urllib.request.Request(url,data=d,headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"},method=method)',
      "    return json.loads(urllib.request.urlopen(req,timeout=t).read())",
      'print(api("GET","/api/health"))',
      'print(api("POST","/api/exec-sync",{"cmd":"hostname"}))',
      "```",
      "",
      "*道法自然 · 无为而无不为*",
    ].join("\n");
  }

  generateLocalAgentMd() {
    const wsInfo = workspaceInfo();
    const ts = new Date().toISOString();
    const base = "http://127.0.0.1:" + this.srv.port;
    return [
      "# ☯ DAO Bridge · 本地Agent底层操控手册",
      "",
      "> 道法自然 · 本文档自动生成。本机任何 Agent(Devin/Cursor/脚本)读此文档，",
      "> 即可比用户更深地接入插件底层：配置隧道、退出/重置账号、热重启、热加载、",
      "> 自诊断、自修复。外固其本，内圆其心，表里相依，浑然一统。",
      "",
      "## 一、接入点",
      "",
      "```",
      "Local URL: " + base + "   (本机直连·最稳，无隧道依赖)",
      "Public URL: " + (this.url || "(隧道启动中…)") + "   (公网直连·云端Agent用)",
      "Token:     " + this.srv.token,
      "Auth:      Authorization: Bearer <Token>   (/api/health 免鉴权)",
      "```",
      "",
      "> Token 与最新 URL 始终可从 `~/.dao/bridge/conn.json` 读取(重启隧道后 URL 会变)。",
      "",
      "## 二、最小可用 SDK（复制即用）",
      "",
      "```python",
      "import urllib.request, json",
      'BASE  = "' + base + '"   # 本机直连；公网用 conn.json 里的 url',
      'TOKEN = "' + this.srv.token + '"',
      "def api(method, path, body=None, t=60):",
      "    d = json.dumps(body).encode() if body is not None else None",
      '    h = {"Authorization":"Bearer "+TOKEN, "Content-Type":"application/json"}',
      "    req = urllib.request.Request(BASE+path, data=d, headers=h, method=method)",
      "    return json.loads(urllib.request.urlopen(req, timeout=t).read())",
      "",
      'def sh(cmd, t=120):  # 在本机执行任意命令(最强底层入口)',
      '    return api("POST","/api/exec-sync",{"cmd":cmd,"timeout":t})["result"]',
      "```",
      "",
      "## 三、完整 API",
      "",
      "| 方法 | 路径 | Body | 说明 |",
      "|---|---|---|---|",
      "| GET | `/api/health` | - | 存活检查(免鉴权) |",
      "| GET | `/api/info` | - | 工作区/机器信息 |",
      "| GET | `/api/agents` | - | 在线Agent列表 |",
      "| GET | `/api/bridge-state` | - | 隧道完整状态(url/port/mode/pid) |",
      "| GET | `/api/attempt-log` | - | 隧道回退链诊断(自修复依据) |",
      "| GET | `/api/config` | - | 读取插件配置 |",
      "| POST | `/api/config` | `{tunnelToken,hostname,localPort,cloudflaredPath}` | 写配置 |",
      "| POST | `/api/agent/register` | `{agent_id,hostname,capabilities}` | Agent注册 |",
      "| POST | `/api/agent/heartbeat` | `{agent_id}` | Agent心跳 |",
      "| POST | `/api/exec` / `/api/exec-sync` | `{type,cmd,file,args,cwd,timeout}` | 执行命令(底层万能入口·type:shell/cmd/run/detached·run跑.bat/.exe/.ps1) |",
      "| POST | `/api/ls` / `/api/read` / `/api/write` | `{path,content}` | 工作区内文件操作 |",
      "| POST | `/api/broadcast` | `{type,payload}` | 广播到在线Agent |",
      "| GET | `/api/export-cloud-md` / `/api/export-local-md` | - | 导出接入文档 |",
      "| POST | `/api/bridge/restart` | - | 重启隧道(URL会变,重读conn.json) |",
      "| POST | `/api/account/logout` | - | 退出账号→无账号快速隧道 |",
      "| POST | `/api/export/refresh` | - | 重生成并落盘两个MD |",
      "| POST | `/api/self/reload` | - | 重载窗口·热加载新插件代码(会打断UI) |",
      "",
      "## 四、底层操控工作流",
      "",
      "### 1) 注册并保持在线",
      "```python",
      'api("POST","/api/agent/register",{"agent_id":"dao-local","hostname":"local","capabilities":["shell","file_read","file_write"]})',
      '# 之后定期: api("POST","/api/agent/heartbeat",{"agent_id":"dao-local"})',
      "```",
      "",
      "### 2) 配置隧道 / 注册账户(命名隧道·固定域名)",
      "```python",
      'api("POST","/api/config",{"tunnelToken":"<CF隧道令牌>","hostname":"bridge.example.com"})',
      'api("POST","/api/bridge/restart")   # 应用配置，重启后从 conn.json 取新URL',
      "```",
      "",
      "### 3) 退出/重置账号(回到无账号快速隧道)",
      "```python",
      'api("POST","/api/account/logout")   # 清凭证残留+自动备份, 重启为 quick 隧道',
      "```",
      "",
      "### 4) 自诊断(打不通时定位根因)",
      "```python",
      'st  = api("GET","/api/bridge-state")      # url 是否为空 / mode / tunnelPid',
      'log = api("GET","/api/attempt-log")       # 回退链每档 quic/http2 是否注册成功',
      'who = sh("where cloudflared")             # 确认是否取到真 .exe (非 npm shim)',
      "```",
      "",
      "### 5) 热修复插件本体(热推进/热改进/热修复)",
      "```python",
      '# a. 用 exec 把新版 extension.js 落到插件目录(exec 不受工作区根限制):',
      'ext = sh("powershell -c \\"(Get-ChildItem $env:USERPROFILE\\\\.windsurf\\\\extensions,$env:USERPROFILE\\\\.vscode\\\\extensions -Dir -ErrorAction SilentlyContinue | ? Name -like \'dao.dao-bridge*\').FullName\\"")',
      'sh("copy /Y C:\\\\path\\\\to\\\\new-extension.js \\"<上面的目录>\\\\extension.js\\"")',
      '# b. 热加载使新代码生效(会重载窗口):',
      'api("POST","/api/self/reload")',
      "```",
      "",
      "## 五、当前状态",
      "",
      "| 项 | 值 |",
      "|---|---|",
      "| 公网URL | " + (this.url || "(未连接)") + " |",
      "| 本地URL | " + base + " |",
      "| 模式 | " + this.mode + (this.protocol ? " · " + this.protocol : "") + " |",
      "| 主机 | " + wsInfo.host + " (" + wsInfo.user + ") |",
      "| 工作区根 | `" + wsInfo.root + "` |",
      "| 版本 | " + BRIDGE_VERSION + " |",
      "| 更新于 | " + ts + " |",
      "",
      "*道法自然 · 无为而无不为*",
    ].join("\n");
  }

  writeArtifacts() {
    try { fs.writeFileSync(this.mdPath(), this.generateCloudAgentMd(), "utf8"); } catch (e) {}
    try { fs.writeFileSync(this.localAgentMdPath(), this.generateLocalAgentMd(), "utf8"); } catch (e) {}
    const wsInfo = workspaceInfo();
    const connData = {
      url: this.url, token: this.srv.token, local_url: "http://127.0.0.1:" + this.srv.port,
      port: this.srv.port, workspace: wsInfo.name, root: wsInfo.root, host: wsInfo.host,
      updated: new Date().toISOString(), version: BRIDGE_VERSION,
    };
    try { fs.writeFileSync(this.connPath(), JSON.stringify(connData, null, 2), "utf8"); } catch (e) {}
    try { fs.writeFileSync(this.globalConnPath(), JSON.stringify(connData, null, 2), "utf8"); } catch (e) {}
  }

  stop() {
    try { if (this.proc) { this.proc.kill(); } } catch (e) {}
    this.proc = null;
    try { if (this.relay) { this.relay.stop(); } } catch (e) {}
    this.relay = null;
    this.srv.stop();
    this.url = "";
    try {
      const c = JSON.parse(fs.readFileSync(this.connPath(), "utf8"));
      c.url = ""; c.offlineAt = new Date().toISOString();
      fs.writeFileSync(this.connPath(), JSON.stringify(c, null, 2), "utf8");
    } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════
// 面板 — 帛书·「万物负阴而抱阳」
// 三模块: 实时状态 | 导出云端Agent MD | 导出本地Agent MD
// 用户只需输入账号密码 → 全链路打通
// ═══════════════════════════════════════════════════════════

class BridgeViewProvider {
  constructor(ctx, bridge) {
    this.ctx = ctx;
    this.bridge = bridge;
    this.view = null;
    bridge.onUpdate = (s) => this.post({ type: "state", state: s });
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (m) => {
      try { await this.handle(m); } catch (e) {
        this.post({ type: "result", op: m && m.op, ok: false, text: String(e && e.message) });
      }
    });
    this.post({ type: "state", state: this.bridge.state() });
  }
  post(msg) { if (this.view) this.view.webview.postMessage(msg); }

  async handle(m) {
    if (m.op === "restart") { this.bridge.stop(); const url = await this.bridge.start(); this.post({ type: "result", op: "restart", ok: !!url, text: url || this.bridge.lastErr }); return; }
    if (m.op === "stop") { this.bridge.stop(); this.notify(); return; }
    if (m.op === "copyUrl") { await vscode.env.clipboard.writeText(this.bridge.url || ""); vscode.window.showInformationMessage("已复制公网 URL"); return; }
    if (m.op === "copyToken") { await vscode.env.clipboard.writeText(this.bridge.srv.token || ""); vscode.window.showInformationMessage("已复制 Token"); return; }
    if (m.op === "copyAll") {
      const u = this.bridge.url || "", t = this.bridge.srv.token || "";
      const text = (u || t) ? ("URL:   " + u + "\nToken: " + t + "\nAuth:  Authorization: Bearer " + t) : "";
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(u ? "已复制 URL 与 Token" : "隧道尚未就绪，已复制当前 Token");
      return;
    }
    if (m.op === "copyBootstrap") { await vscode.env.clipboard.writeText(this.bridge.bootstrapCmd()); vscode.window.showInformationMessage("已复制被控端一行接入指令"); return; }
    if (m.op === "refreshToken") {
      this.post({ type: "result", op: "refreshToken", ok: true, text: "正在刷新 Token 并用新 Token 重连…" });
      const r = await this.bridge.refreshToken();
      this.post({ type: "result", op: "refreshToken", ok: !!r.ok, text: r.ok ? ("已刷新 Token · 旧 Token 已作废" + (r.url ? " · " + r.url : "（重连中）")) : (r.message || "刷新失败") });
      this.post({ type: "state", state: this.bridge.state() });
      return;
    }
    if (m.op === "exportCloudMd") {
      const md = this.bridge.generateCloudAgentMd();
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage("已复制云端Agent接入MD文档");
      return;
    }
    if (m.op === "exportLocalMd") {
      const md = this.bridge.generateLocalAgentMd();
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage("已复制本地Agent配置MD文档");
      return;
    }
    if (m.op === "openCloudMd") {
      const d = await vscode.workspace.openTextDocument(this.bridge.mdPath());
      vscode.window.showTextDocument(d);
      return;
    }
    if (m.op === "openLocalMd") {
      const d = await vscode.workspace.openTextDocument(this.bridge.localAgentMdPath());
      vscode.window.showTextDocument(d);
      return;
    }
    if (m.op === "cfLogin") {
      const email = m.email || "";
      const key = m.key || "";
      if (!key) {
        this.post({ type: "result", op: "cfLogin", ok: false, text: "请填入 隧道 Token / API Token（email 可选）" });
        return;
      }
      const r = await this.bridge.loginCloudFlare(email, key);
      this.post({ type: "result", op: "cfLogin", ok: r.ok, text: r.message });
      if (r.ok) { this.bridge.stop(); const url = await this.bridge.start(); this.post({ type: "result", op: "cfLogin", ok: !!url, text: r.message + " · " + (url ? "已按用户通道打通" : "用户通道未通已回退") }); }
      this.post({ type: "state", state: this.bridge.state() });
      return;
    }
    if (m.op === "cfBrowserLogin") {
      this.post({ type: "result", op: "cfBrowserLogin", ok: true, text: "正在打开浏览器登录 Cloudflare（GitHub 账号亦可）…完成授权后自动检测" });
      const r = await this.bridge.cfTunnelLogin();
      this.post({ type: "result", op: "cfBrowserLogin", ok: r.ok, text: r.message });
      this.post({ type: "state", state: this.bridge.state() });
      return;
    }
    if (m.op === "logout") {
      const r = await this.bridge.resetAccount();
      this.post({ type: "result", op: "logout", ok: r.ok, text: r.message });
      this.bridge.stop();
      const url = await this.bridge.start();
      this.post({ type: "result", op: "logout", ok: true, text: r.message + " · 已回到无账号快速隧道" + (url ? "：" + url : "（启动中）") });
      this.post({ type: "state", state: this.bridge.state() });
      return;
    }
    if (m.op === "openCf") { vscode.env.openExternal(vscode.Uri.parse("https://one.dash.cloudflare.com")); return; }
    if (m.op === "health") {
      const r = await this.localApi("/api/health", "GET");
      this.post({ type: "result", op: "health", ok: r.status === 200, status: r.status, text: r.text });
      return;
    }
    if (m.op === "exec") {
      const r = await this.localApi("/api/exec", "POST", { cmd: m.arg });
      this.post({ type: "result", op: "exec", ok: r.status === 200, status: r.status, text: r.text });
      return;
    }
  }

  async localApi(p, method, body) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: "127.0.0.1", port: this.bridge.srv.port, path: p, method: method || "GET",
        headers: { "Authorization": "Bearer " + this.bridge.srv.token, "Content-Type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d }));
      });
      req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
      if (data) req.write(data); req.end();
    });
  }

  notify() { this.post({ type: "state", state: this.bridge.state() }); }

  html() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:12px;padding:8px;color:var(--vscode-foreground);overflow-y:auto}
h3{margin:10px 0 4px;font-size:12px;color:var(--vscode-textLink-foreground)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#888}
.ok{background:#3fb950}.bad{background:#f85149}.pending{background:#e8c84a}
input,button{font-size:12px;margin:2px 0;width:100%;box-sizing:border-box;padding:4px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#3334)}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;border:none;border-radius:3px;padding:4px 8px}
button:hover{background:var(--vscode-button-hoverBackground)}
.row{display:flex;gap:4px}.row button{width:auto;flex:1}
pre{white-space:pre-wrap;word-break:break-all;background:var(--vscode-textCodeBlock-background);padding:6px;max-height:200px;overflow:auto;font-size:11px;margin:4px 0;border-radius:3px}
.muted{color:var(--vscode-descriptionForeground);font-size:11px}
.url{user-select:all;font-weight:600;color:var(--vscode-textLink-foreground);word-break:break-all;font-size:11px}
.card{border:1px solid var(--vscode-input-border,#3334);border-radius:4px;padding:8px;margin-top:6px}
.lbl{color:var(--vscode-descriptionForeground);font-size:10px;margin-top:4px}
.val{font-size:11px;word-break:break-all}
.section{margin-top:8px;padding-top:6px;border-top:1px solid var(--vscode-input-border,#3334)}
</style></head><body>

<!-- 模块1: 实时状态 -->
<h3>☯ 公网穿透状态</h3>
<div><span id="dot" class="dot"></span><span id="stat">启动中…</span></div>
<div class="muted" style="margin-top:4px">无名之樸 · 插件启动即自动打通整机公网穿透，<b>零配置、无需任何账号</b>。</div>
<div class="card">
  <div class="lbl">公网 URL</div><div id="url" class="url">—</div>
  <div class="lbl">工作区</div><div id="ws" class="val">—</div>
  <div class="lbl">端口 / 模式 / 协议</div><div id="mode" class="val">—</div>
  <div class="lbl">代理 / 回退链</div><div id="net" class="val">—</div>
  <div class="lbl">在线Agent</div><div id="agents" class="val">0</div>
  <div class="row" style="margin-top:6px">
    <button onclick="send('copyAll')" title="一键复制公网 URL 与 Token（含 Authorization 头），直接粘贴给云端 Agent">📋 复制</button>
    <button onclick="send('restart')" title="重启隧道（URL 会变，Token 不变）">♻️ 重启隧道</button>
    <button onclick="send('refreshToken')" title="生成全新 Token，旧 Token 立即作废，并用新 Token 重连公网通道">🔄 刷新Token</button>
  </div>
</div>

<!-- 模块2: CloudFlare 命名隧道 (可选) -->
<div class="section">
<h3>🔑 命名隧道 · 固定域名（可选）</h3>
<div class="muted">默认快速隧道已可用，<b>无需登录</b>。仅当你想要<b>固定不变的公网域名</b>时，才需配置 CloudFlare 命名隧道令牌（也可放入 <code>~/.dao/dao-config.json</code> 的 <code>cfTunnelToken</code> 自动加载）。</div>
<div id="cfStatus" class="muted" style="margin-top:4px">未配置（使用零配置快速隧道）</div>
<div id="cfLoginForm">
  <input id="cfEmail" type="email" placeholder="CloudFlare Email（可选）">
  <input id="cfKey" type="password" placeholder="Tunnel Token / API Token（可选）">
  <button onclick="send('cfLogin',null,{email:v('cfEmail'),key:v('cfKey')})">保存并切到用户通道</button>
  <div class="muted" style="margin-top:6px">没有 token？用浏览器登录 Cloudflare（<b>可用 GitHub 账号</b>，需自有域名才有固定域名）：</div>
  <button onclick="send('cfBrowserLogin')">🌐 用浏览器登录 Cloudflare</button>
</div>
<button id="logoutBtn" onclick="if(confirm('退出账号并清空全部 Cloudflare 凭证残留(含 cloudflared 登录 cert)，回到无账号快速隧道？'))send('logout')" style="margin-top:6px;background:#a33;display:none">退出账号 / 重置为无账号模式</button>
<button onclick="send('openCf')" style="margin-top:4px;background:var(--vscode-textLink-foreground)">打开 CloudFlare 控制台</button>
</div>

<!-- 模块2.5: 被控端一行接入(三明治·operator→hub→agent) -->
<div class="section">
<h3>⊕ 被控端一行接入(三明治)</h3>
<div class="muted">在任意 Windows 机器 PowerShell 跨下面这一行，即将它接入本中枢为被控端；之后 <code>/api/agents</code> 可见，并可用 <code>agent_id</code> 远程跑 .bat/.exe。</div>
<pre id="boot" class="url" data-op="copyBootstrap" style="cursor:pointer" title="点击复制接入指令">…</pre>
<button onclick="send('copyBootstrap')">📋 复制被控端一行接入指令</button>
</div>

<!-- 模块3: 导出MD -->
<div class="section">
<h3>📄 导出接入文档</h3>
<div class="row">
  <button onclick="send('exportCloudMd')">☁️ 云端Agent MD</button>
  <button onclick="send('exportLocalMd')">🖥️ 本地Agent MD</button>
</div>
<div class="row">
  <button onclick="send('openCloudMd')">打开云端MD</button>
  <button onclick="send('openLocalMd')">打开本地MD</button>
</div>
</div>

<!-- 能力自测 -->
<div class="section">
<h3>⚡ 能力自测</h3>
<div class="row"><button onclick="send('health')">health</button></div>
<input id="cmd" placeholder="命令" value="hostname"><button onclick="send('exec',v('cmd'))">exec</button>
<pre id="out" class="muted">（结果）</pre>
</div>

<script>
const vscode=acquireVsCodeApi();
function send(op,arg,extra){vscode.postMessage(Object.assign({op,arg},extra||{}));}
document.addEventListener('click',function(e){var t=e.target.closest('[data-op]');if(t){send(t.getAttribute('data-op'));}});
function v(id){return document.getElementById(id).value;}
const out=document.getElementById('out');
window.addEventListener('message',(e)=>{const m=e.data;
  if(m.type==='state'){const s=m.state||{};const on=!!s.url;
    document.getElementById('dot').className='dot '+(on?'ok':(s.lastErr?'bad':'pending'));
    document.getElementById('stat').textContent=on?'已打通 · 公网在线':(s.lastErr?(''+s.lastErr):'隧道启动中…');
    document.getElementById('url').textContent=s.url||'—';
    document.getElementById('ws').textContent=s.ws?(s.ws.name+' · '+s.ws.root):'—';
    document.getElementById('mode').textContent=':'+s.port+' / '+s.mode+(s.protocol?' / '+s.protocol:'');
    var chain=(s.attempts||[]).map(function(a){return a.mode+'/'+a.proto+(a.ok?'✓':'✗');}).join(' → ');
    document.getElementById('net').textContent=(s.proxy?('代理 '+s.proxy):'直连(无代理)')+(chain?(' · '+chain):'');
    document.getElementById('agents').textContent=String(s.agentCount||0);
    document.getElementById('boot').textContent=s.bootstrap||('irm '+(s.url||'<公网URL>')+'/api/bootstrap.ps1 | iex');
    var loggedIn=!!(s.cfLoggedIn||s.mode==='named');
    document.getElementById('logoutBtn').style.display=loggedIn?'block':'none';
    const cfSt=document.getElementById('cfStatus');
    if(loggedIn){cfSt.textContent='✓ 用户通道'+(s.cfEmail?(' · '+s.cfEmail):'')+(s.mode==='named'?'（命名隧道运行中）':'');cfSt.style.color='#3fb950';document.getElementById('cfLoginForm').style.display='none';}
    else{cfSt.textContent='未登录（零配置快速隧道）';cfSt.style.color='';document.getElementById('cfLoginForm').style.display='block';}
  }
  if(m.type==='result'){out.className='';out.textContent='['+m.op+'] '+(m.ok?'✓':'✗')+' '+(m.text||'');}
});
</script>
</body></html>`;
  }
}

// ═══════════════════════════════════════════════════════════
// 激活 · 道法自然
// ═══════════════════════════════════════════════════════════

let _bridge = null;
function activate(context) {
  _bridge = new Bridge(context);
  const provider = new BridgeViewProvider(context, _bridge);
  // 防御式注册: 任一注册抛错(如残留同名插件抢注)不再 brick 掉其余贡献点(含 webview 消息处理器)。
  const safeReg = (fn, label) => { try { context.subscriptions.push(fn()); } catch (e) { try { console.error("[dao-bridge] register failed: " + label + " · " + (e && e.message)); } catch (_) {} } };
  safeReg(() => vscode.window.registerWebviewViewProvider("daoBridgeView", provider), "view:daoBridgeView");
  safeReg(() => vscode.commands.registerCommand("daoBridge.restart", async () => { _bridge.stop(); await _bridge.start(); }), "cmd:restart");
  safeReg(() => vscode.commands.registerCommand("daoBridge.openMd", async () => { const d = await vscode.workspace.openTextDocument(_bridge.mdPath()); vscode.window.showTextDocument(d); }), "cmd:openMd");
  safeReg(() => vscode.commands.registerCommand("daoBridge.exportCloudMd", async () => { await vscode.env.clipboard.writeText(_bridge.generateCloudAgentMd()); vscode.window.showInformationMessage("已复制云端Agent MD"); }), "cmd:exportCloudMd");
  safeReg(() => vscode.commands.registerCommand("daoBridge.exportLocalMd", async () => { await vscode.env.clipboard.writeText(_bridge.generateLocalAgentMd()); vscode.window.showInformationMessage("已复制本地Agent MD"); }), "cmd:exportLocalMd");
  safeReg(() => vscode.commands.registerCommand("daoBridge.copyBootstrap", async () => { await vscode.env.clipboard.writeText(_bridge.bootstrapCmd()); vscode.window.showInformationMessage("DAO Bridge: 已复制被控端一行接入指令"); }), "cmd:copyBootstrap");
  safeReg(() => vscode.commands.registerCommand("daoBridge.logout", async () => {
    const r = await _bridge.resetAccount();
    _bridge.stop(); await _bridge.start();
    vscode.window.showInformationMessage("DAO Bridge: " + r.message + " · 已回到无账号快速隧道");
  }), "cmd:logout");
  context.subscriptions.push({ dispose: () => { try { _bridge.stopWatchdog(); } catch (e) {} try { _bridge.stop(); } catch (e) {} } });
  // 自动启动 — 插件激活即穿透; 看门狗常驻自愈, 只要 IDE 在跑就持久有效
  _bridge.startWatchdog();
  _bridge.start().then((url) => { if (url) vscode.window.setStatusBarMessage("DAO Bridge 已打通: " + url, 8000); });
}
function deactivate() { try { if (_bridge) { _bridge.stopWatchdog(); _bridge.stop(); } } catch (e) {} }
module.exports = { activate, deactivate, Bridge, WorkspaceServer, detectProxy, downloadCloudflared, findCloudflared, isRealCloudflared, probeCloudflared, extractCfTgz, cfAssetName, DaoWsClient, connectRelayWs, buildExecCommand, buildBootstrap, buildBootstrapSh, platformOf };
