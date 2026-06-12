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
const BRIDGE_VERSION = "3.1.0";

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

function cloudflaredCandidates(ctx) {
  const cfgPath = vscode.workspace.getConfiguration("daoBridge").get("cloudflaredPath") || "";
  return [
    cfgPath,
    // 插件自带(随 VSIX 分发, 离线即用) — 帛书·「大丈夫居其厚」
    ctx ? path.join(ctx.extensionPath, "bin", CF_BIN_NAME) : "",
    ctx ? path.join(ctx.extensionPath, "bin", "cloudflared.exe") : "",
    ctx ? path.join(ctx.extensionPath, "bin", "cloudflared") : "",
    path.join(os.homedir(), ".dao", "bin", "cloudflared.exe"),
    path.join(os.homedir(), ".dao", "bin", "cloudflared"),
    "cloudflared.exe",
    "cloudflared",
  ].filter(Boolean);
}
function findCloudflared(ctx) {
  for (const c of cloudflaredCandidates(ctx)) {
    try { if (c.indexOf(path.sep) >= 0 && fs.existsSync(c) && fs.statSync(c).size > 1000000) return c; } catch (e) {}
  }
  try {
    const probe = process.platform === "win32" ? "where cloudflared" : "command -v cloudflared";
    const out = cp.execSync(probe, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
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

function httpDownload(url, dst, proxy) {
  return new Promise((resolve) => {
    const tmp = dst + ".part-" + crypto.randomBytes(4).toString("hex");
    let settled = false;
    const done = (ok) => {
      if (settled) return; settled = true;
      if (ok) { try { fs.renameSync(tmp, dst); } catch (e) { ok = false; } }
      if (!ok) { try { fs.unlinkSync(tmp); } catch (e) {} }
      resolve(ok);
    };
    const sink = (res, retryFn, depth) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return retryFn(res.headers.location, depth + 1);
      }
      if (res.statusCode !== 200) { res.resume(); return done(false); }
      const f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on("finish", () => f.close(() => {
        try { if (fs.statSync(tmp).size < 1000000) return done(false); } // 损坏/HTML 错误页
        catch (e) { return done(false); }
        done(true);
      }));
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
            const req2 = https.get({ hostname: opts.hostname, port: opts.port || 443, path: opts.pathname + opts.search, socket, agent: false, headers: { "User-Agent": UA }, timeout: 60000 },
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
      const req = mod.get({ hostname: opts.hostname, port: opts.port || (opts.protocol === "http:" ? 80 : 443), path: opts.pathname + opts.search, headers: { "User-Agent": UA }, timeout: 60000 },
        (res) => sink(res, get, depth));
      req.on("error", () => done(false));
      req.setTimeout(60000, () => { req.destroy(); done(false); });
    };
    get(url, 0);
  });
}

async function downloadCloudflared(onProgress) {
  const dst = path.join(os.homedir(), ".dao", "bin", CF_BIN_NAME);
  try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch (e) {}
  try { if (fs.existsSync(dst) && fs.statSync(dst).size > 1000000) return dst; } catch (e) {}
  const asset = cfAssetName();
  const proxy = detectProxy();
  const mirrors = downloadMirrors(asset);
  for (let i = 0; i < mirrors.length; i++) {
    try { onProgress && onProgress("下载 cloudflared … 镜像 " + (i + 1) + "/" + mirrors.length); } catch (e) {}
    const ok = await httpDownload(mirrors[i], dst, proxy);
    if (ok) {
      if (process.platform !== "win32") { try { fs.chmodSync(dst, 0o755); } catch (e) {} }
      return dst;
    }
  }
  return "";
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

class WorkspaceServer {
  constructor() {
    this.token = "";
    this.server = null;
    this.port = 0;
    this.agentRegistry = new Map();
    this.startedAt = null;
    this._bridgeRef = null;
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
      const wsInfo = workspaceInfo();
      const auth = (req) => {
        const h = req.headers["authorization"] || "";
        if (h === "Bearer " + this.token) return true;
        // 检查配置的token
        const cfgToken = vscode.workspace.getConfiguration("daoBridge").get("accessToken") || "";
        if (cfgToken && h === "Bearer " + cfgToken) return true;
        return false;
      };
      const send = (res, code, obj) => {
        const b = Buffer.from(JSON.stringify(obj));
        res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
        res.end(b);
      };

      this.server = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
          return res.end();
        }
        const u = new URL(req.url, "http://x");
        const p = u.pathname;

        // 免鉴权端点
        if (p === "/api/health") {
          return send(res, 200, {
            status: "ok", service: "dao-bridge", version: BRIDGE_VERSION,
            host: wsInfo.host, workspace: wsInfo.name,
            agents_online: this.agentRegistry.size,
            uptime: Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000),
          });
        }

        if (!auth(req)) return send(res, 401, { error: "unauthorized" });

        // 无Body端点
        if (p === "/api/info" && req.method === "GET") return send(res, 200, workspaceInfo());
        if (p === "/api/agents" && req.method === "GET") {
          const agents = [];
          for (const [id, a] of this.agentRegistry) {
            agents.push({ id, hostname: a.hostname, status: a.status || "online", lastSeen: a.lastSeen, capabilities: a.capabilities || [] });
          }
          return send(res, 200, { agents });
        }
        if (p === "/api/bridge-state" && req.method === "GET") {
          const br = this._bridgeRef;
          return send(res, 200, {
            url: br ? br.url : "", port: this.port, token: this.token,
            mode: br ? br.mode : "", tunnelPid: br && br.proc ? br.proc.pid : null,
            startedAt: this.startedAt ? this.startedAt.toISOString() : "",
            workspace: wsInfo, agents_online: this.agentRegistry.size,
          });
        }
        // 导出MD文档端点
        if (p === "/api/export-cloud-md" && req.method === "GET") {
          const br = this._bridgeRef;
          const md = br ? br.generateCloudAgentMd() : "# DAO Bridge 未启动";
          return send(res, 200, { md });
        }
        if (p === "/api/export-local-md" && req.method === "GET") {
          const br = this._bridgeRef;
          const md = br ? br.generateLocalAgentMd() : "# DAO Bridge 未启动";
          return send(res, 200, { md });
        }

        // Body端点
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let j = {};
          try { j = body ? JSON.parse(body) : {}; } catch (e) {}
          const root = workspaceInfo().root;
          try {
            // 命令执行 — CLOUD_AGENT_GUIDE同构
            if (p === "/api/exec" && req.method === "POST") {
              cp.exec(j.cmd || "", { cwd: j.cwd || root, timeout: (j.timeout || 60) * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
                send(res, 200, { stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")), exit_code: err ? (err.code || 1) : 0 });
              });
              return;
            }
            if (p === "/api/exec-sync" && req.method === "POST") {
              cp.exec(j.cmd || "", { cwd: j.cwd || root, timeout: (j.timeout || 60) * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
                send(res, 200, { status: "completed", result: { stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")), exit_code: err ? (err.code || 1) : 0 } });
              });
              return;
            }
            if (p === "/api/ls" && req.method === "POST") {
              const dir = withinRoot(root, j.path || ".");
              if (!dir) return send(res, 403, { error: "path escapes workspace root" });
              const items = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
              return send(res, 200, { path: dir, items });
            }
            if (p === "/api/read" && req.method === "POST") {
              const fp = withinRoot(root, j.path || "");
              if (!fp) return send(res, 403, { error: "path escapes workspace root" });
              return send(res, 200, { path: fp, content: fs.readFileSync(fp, "utf8") });
            }
            if (p === "/api/write" && req.method === "POST") {
              const fp = withinRoot(root, j.path || "");
              if (!fp) return send(res, 403, { error: "path escapes workspace root" });
              fs.mkdirSync(path.dirname(fp), { recursive: true });
              fs.writeFileSync(fp, j.content == null ? "" : String(j.content), "utf8");
              return send(res, 200, { path: fp, ok: true });
            }
            // Agent注册 — 本地Agent接入
            if (p === "/api/agent/register" && req.method === "POST") {
              const agentId = j.agent_id || j.id || "";
              if (!agentId) return send(res, 400, { error: "agent_id required" });
              this.agentRegistry.set(agentId, {
                hostname: j.hostname || "", status: "online", lastSeen: new Date().toISOString(),
                capabilities: j.capabilities || ["shell", "file_read", "file_write"],
                url: j.url || "",
              });
              return send(res, 200, { ok: true, agent_id: agentId });
            }
            if (p === "/api/agent/heartbeat" && req.method === "POST") {
              const agentId = j.agent_id || j.id || "";
              const existing = this.agentRegistry.get(agentId);
              if (existing) { existing.lastSeen = new Date().toISOString(); existing.status = "online"; }
              return send(res, 200, { ok: true });
            }
            // 广播 — 发送到所有在线Agent
            if (p === "/api/broadcast" && req.method === "POST") {
              return send(res, 200, { ok: true, delivered: this.agentRegistry.size, note: "broadcast queued" });
            }
            // 插件配置接口 — 本地Agent可读写配置
            if (p === "/api/config" && req.method === "GET") {
              const cfg = vscode.workspace.getConfiguration("daoBridge");
              return send(res, 200, {
                tunnelToken: cfg.get("tunnelToken") || "",
                hostname: cfg.get("hostname") || "",
                localPort: cfg.get("localPort") || 0,
                cloudflaredPath: cfg.get("cloudflaredPath") || "",
              });
            }
            if (p === "/api/config" && req.method === "POST") {
              const cfg = vscode.workspace.getConfiguration("daoBridge");
              const updates = [];
              if (j.tunnelToken !== undefined) updates.push(cfg.update("tunnelToken", j.tunnelToken, true));
              if (j.hostname !== undefined) updates.push(cfg.update("hostname", j.hostname, true));
              if (j.localPort !== undefined) updates.push(cfg.update("localPort", j.localPort, true));
              Promise.all(updates).then(() => send(res, 200, { ok: true })).catch((e) => send(res, 500, { error: e.message }));
              return;
            }
          } catch (e) { return send(res, 500, { error: String(e && e.message) }); }
          send(res, 404, { error: "not found" });
        });
      });
      this.server.on("error", reject);
      this.server.listen(fixedPort || 0, "127.0.0.1", () => { this.port = this.server.address().port; resolve(this.port); });
    });
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
    this.cfCredentials = loadCfCredentials();
    this.srv._bridgeRef = this;
  }
  mdPath() { return path.join(daoDir(), "workspace.md"); }
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

      // cloudflared: 内置优先, 缺失则多镜像下载(含国内加速) — 不依赖用户网络/手动安装
      let bin = findCloudflared(this.ctx);
      if (!bin) { this.lastErr = "cloudflared 缺失，正在内置/下载…"; this.notify(); bin = await downloadCloudflared((m) => { this.lastErr = m; this.notify(); }); }
      if (!bin) { this.lastErr = "cloudflared 不可用（内置缺失 + 多镜像下载均失败）— 请检查网络或在设置填 cloudflaredPath"; this.writeArtifacts(); this.notify(); return ""; }
      this.cfBin = bin;

      const proxy = detectProxy();
      this.proxy = proxy;
      const port = await this.srv.start(tunnelToken ? (fixedPort || 9910) : (fixedPort || 0));

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
    };
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
      "Mode:  " + (this.mode === "named" ? "named (命名隧道·稳定 URL)" : "quick (临时 URL)") + (this.protocol ? " · proto=" + this.protocol : "") + (this.proxy ? " · proxy=" + this.proxy : ""),
      "```",
      "",
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
      "| POST | `/api/exec` | `{cmd,timeout}` | 执行命令 |",
      "| POST | `/api/exec-sync` | `{cmd,timeout}` | 同步执行 |",
      "| POST | `/api/ls` | `{path}` | 列目录 |",
      "| POST | `/api/read` | `{path}` | 读文件 |",
      "| POST | `/api/write` | `{path,content}` | 写文件 |",
      "| POST | `/api/broadcast` | `{type,payload}` | 广播 |",
      "| GET | `/api/export-cloud-md` | - | 导出本文档 |",
      "| GET | `/api/export-local-md` | - | 导出本地Agent配置文档 |",
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
      "def api(m,p,body=None,t=30):",
      "    d=json.dumps(body).encode() if body else None",
      '    req=urllib.request.Request(f"{URL}{p}",data=d,headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"},method=m)',
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
    return [
      "# ☯ DAO Bridge · 本地Agent配置接口文档",
      "",
      "> 本文档供本机其他Agent(如Devin、Cursor等)读取，用于接入和配置 DAO Bridge 插件。",
      "",
      "## 本地接入",
      "",
      "```",
      "Local URL: http://127.0.0.1:" + this.srv.port,
      "Token:     " + this.srv.token,
      "Auth:      Authorization: Bearer <Token>",
      "```",
      "",
      "## Agent注册",
      "",
      "本地Agent需先注册才能被Bridge管理：",
      "",
      "```",
      'POST /api/agent/register {"agent_id":"my-agent","hostname":"...","capabilities":["shell"]}',
      "```",
      "",
      "注册后定期发送心跳保持在线状态：",
      "",
      "```",
      'POST /api/agent/heartbeat {"agent_id":"my-agent"}',
      "```",
      "",
      "## 配置读写",
      "",
      "读取当前插件配置：",
      "```",
      "GET /api/config",
      "```",
      "",
      "修改插件配置（如切换隧道模式）：",
      "```",
      'POST /api/config {"tunnelToken":"...","hostname":"...","localPort":9910}',
      "```",
      "",
      "## 可用API",
      "",
      "| 方法 | 路径 | 说明 |",
      "|---|---|---|",
      "| GET | `/api/health` | 存活检查(免鉴权) |",
      "| GET | `/api/info` | 工作区信息 |",
      "| GET | `/api/agents` | 在线Agent列表 |",
      "| GET | `/api/bridge-state` | 隧道完整状态 |",
      "| GET | `/api/config` | 读取插件配置 |",
      "| POST | `/api/config` | 修改插件配置 |",
      "| POST | `/api/agent/register` | Agent注册 |",
      "| POST | `/api/agent/heartbeat` | Agent心跳 |",
      "| POST | `/api/exec` | 执行命令 |",
      "| POST | `/api/exec-sync` | 同步执行命令 |",
      "| POST | `/api/ls` | 列目录 |",
      "| POST | `/api/read` | 读文件 |",
      "| POST | `/api/write` | 写文件 |",
      "",
      "## 当前状态",
      "",
      "| 项 | 值 |",
      "|---|---|",
      "| 公网URL | " + (this.url || "(未连接)") + " |",
      "| 本地端口 | " + this.srv.port + " |",
      "| 模式 | " + this.mode + " |",
      "| 主机 | " + wsInfo.host + " |",
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
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
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
    <button onclick="send('copyUrl')">复制URL</button>
    <button onclick="send('copyToken')">复制Token</button>
    <button onclick="send('restart')">重启隧道</button>
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
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("daoBridgeView", provider));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.restart", async () => { _bridge.stop(); await _bridge.start(); }));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.openMd", async () => { const d = await vscode.workspace.openTextDocument(_bridge.mdPath()); vscode.window.showTextDocument(d); }));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.exportCloudMd", async () => { await vscode.env.clipboard.writeText(_bridge.generateCloudAgentMd()); vscode.window.showInformationMessage("已复制云端Agent MD"); }));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.exportLocalMd", async () => { await vscode.env.clipboard.writeText(_bridge.generateLocalAgentMd()); vscode.window.showInformationMessage("已复制本地Agent MD"); }));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.logout", async () => {
    const r = await _bridge.resetAccount();
    _bridge.stop(); await _bridge.start();
    vscode.window.showInformationMessage("DAO Bridge: " + r.message + " · 已回到无账号快速隧道");
  }));
  context.subscriptions.push({ dispose: () => { try { _bridge.stop(); } catch (e) {} } });
  // 自动启动 — 插件激活即穿透
  _bridge.start().then((url) => { if (url) vscode.window.setStatusBarMessage("DAO Bridge 已打通: " + url, 8000); });
}
function deactivate() { try { if (_bridge) _bridge.stop(); } catch (e) {} }
module.exports = { activate, deactivate, Bridge, detectProxy, downloadCloudflared, findCloudflared };
