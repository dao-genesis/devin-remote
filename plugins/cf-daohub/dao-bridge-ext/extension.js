const vscode = require("vscode");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process");

// ============================================================================
// DAO Bridge · 内网穿透 (工作区版)
// 道法自然 · 无为而无不为
//
// 核心 (按本源需求重构)：
//  - 不再穿透整台机器，而是【专门穿透当前 Devin Desktop 窗口的工作区】。
//  - 随 IDE 窗口生命周期启停：activate→启动隧道，deactivate(关窗)→自动关闭。
//  - 每次启动产出【一个实时 MD 文档】(删旧注新)，含公网 URL + 工作区信息，
//    用户把它发给云端 Agent 即可完美接到当前窗口。
//  - 登录 Cloudflare 账号即可一键打通 (quick tunnel，无需域名)。
// ============================================================================

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TRY_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function daoDir() {
  const d = path.join(os.homedir(), ".dao", "bridge");
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

// cloudflared 定位：配置 → ~/.dao/bin → 扩展自带 → PATH。缺失则尝试下载。
function cloudflaredCandidates(ctx) {
  const cfgPath = vscode.workspace.getConfiguration("daoBridge").get("cloudflaredPath") || "";
  return [
    cfgPath,
    path.join(os.homedir(), ".dao", "bin", "cloudflared.exe"),
    path.join(os.homedir(), "dao", "bin", "cloudflared.exe"),
    ctx ? path.join(ctx.extensionPath, "bin", "cloudflared.exe") : "",
    "cloudflared.exe",
    "cloudflared",
  ].filter(Boolean);
}
function findCloudflared(ctx) {
  for (const c of cloudflaredCandidates(ctx)) {
    try { if (c.indexOf(path.sep) >= 0 && fs.existsSync(c)) return c; } catch (e) {}
  }
  // PATH 兜底：直接返回名字，spawn 时由系统解析
  return "cloudflared.exe";
}
function downloadCloudflared() {
  return new Promise((resolve) => {
    const dst = path.join(os.homedir(), ".dao", "bin", "cloudflared.exe");
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch (e) {}
    if (fs.existsSync(dst)) return resolve(dst);
    const url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
    const get = (u) => https.get(u, { headers: { "User-Agent": UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(res.headers.location); }
      if (res.statusCode !== 200) { res.resume(); return resolve(""); }
      const f = fs.createWriteStream(dst);
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve(dst)));
    });
    get(url).on("error", () => resolve(""));
  });
}

// 工作区信息提取 (本源需求：穿透当前 Devin Desktop 窗口的工作区)
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

// 路径越界守卫：限制在工作区根内
function withinRoot(root, p) {
  try {
    const abs = path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return abs;
    // 允许显式绝对路径但必须仍在 root 下
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
  } catch (e) {}
  return null;
}

// ---------------------------------------------------------------------------
// 工作区本地服务：被 cloudflared 暴露到公网，能力域限定于当前工作区
// ---------------------------------------------------------------------------
class WorkspaceServer {
  constructor() {
    this.token = crypto.randomBytes(16).toString("hex");
    this.server = null;
    this.port = 0;
  }
  start() {
    return new Promise((resolve, reject) => {
      const ws = workspaceInfo();
      const auth = (req) => {
        const h = req.headers["authorization"] || "";
        return h === "Bearer " + this.token;
      };
      const send = (res, code, obj) => {
        const b = Buffer.from(JSON.stringify(obj));
        res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length, "Access-Control-Allow-Origin": "*" });
        res.end(b);
      };
      this.server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        const p = u.pathname;
        if (p === "/api/health") return send(res, 200, { status: "ok", service: "dao-bridge-workspace", version: "2.0", host: ws.host, workspace: ws.name });
        if (!auth(req)) return send(res, 401, { error: "unauthorized" });
        if (p === "/api/info" && req.method === "GET") return send(res, 200, workspaceInfo());
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let j = {};
          try { j = body ? JSON.parse(body) : {}; } catch (e) {}
          const root = workspaceInfo().root;
          try {
            if (p === "/api/exec" && req.method === "POST") {
              cp.exec(j.cmd || "", { cwd: root, timeout: (j.timeout || 60) * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
                send(res, 200, { stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")), exit_code: err ? (err.code || 1) : 0 });
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
          } catch (e) { return send(res, 500, { error: String(e && e.message) }); }
          send(res, 404, { error: "not found" });
        });
      });
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }
  stop() { try { this.server && this.server.close(); } catch (e) {} this.server = null; }
}

// ---------------------------------------------------------------------------
// 隧道生命周期：spawn cloudflared quick tunnel，捕获公网 URL，写实时 MD
// ---------------------------------------------------------------------------
class Bridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.srv = new WorkspaceServer();
    this.proc = null;
    this.url = "";
    this.startedAt = null;
    this.onUpdate = null;
    this.lastErr = "";
  }
  mdPath() { return path.join(daoDir(), "workspace.md"); }
  connPath() { return path.join(daoDir(), "conn.json"); }

  async start() {
    this.startedAt = new Date();
    const port = await this.srv.start();
    const bin = findCloudflared(this.ctx);
    // --protocol http2：QUIC/UDP 被防火墙拦截的网络下仍可打通 (避免边缘 1033)
    const args = ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://127.0.0.1:" + port];
    let started = () => {};
    const ready = new Promise((r) => (started = r));
    const spawnIt = (binPath) => {
      this.proc = cp.spawn(binPath, args, { windowsHide: true });
      const onData = (buf) => {
        const s = buf.toString();
        const m = s.match(TRY_RE);
        if (m && !this.url) { this.url = m[0]; this.writeArtifacts(); this.notify(); started(); }
      };
      this.proc.stdout.on("data", onData);
      this.proc.stderr.on("data", onData);
      this.proc.on("error", (e) => { this.lastErr = String(e && e.message); this.notify(); });
      this.proc.on("exit", () => { this.url = ""; this.notify(); });
    };
    try { spawnIt(bin); } catch (e) {
      const dl = await downloadCloudflared();
      if (dl) spawnIt(dl); else { this.lastErr = "cloudflared 不可用"; }
    }
    // 写一次初始 MD (即使 URL 未就绪，先记录工作区)
    this.writeArtifacts();
    // 最多等 25s 拿 URL
    await Promise.race([ready, new Promise((r) => setTimeout(r, 25000))]);
    this.writeArtifacts();
    this.notify();
    return this.url;
  }

  notify() { try { this.onUpdate && this.onUpdate(this.state()); } catch (e) {} }
  state() {
    return { url: this.url, port: this.srv.port, token: this.srv.token, ws: workspaceInfo(), startedAt: this.startedAt, lastErr: this.lastErr, mdPath: this.mdPath() };
  }

  // 删旧注新：每次启动覆盖写单一 MD + conn.json
  writeArtifacts() {
    const ws = workspaceInfo();
    const ts = new Date().toISOString();
    const md = [
      "# ☯ DAO Bridge · 当前 Devin Desktop 工作区接入",
      "",
      "> 道法自然 · 本文档每次启动 Devin Desktop 自动重写。把它发给云端 Agent 即可接到当前窗口工作区。",
      "",
      "## 公网接入",
      "",
      "```",
      "URL:   " + (this.url || "(隧道启动中…)"),
      "Token: " + this.srv.token,
      "Auth:  Authorization: Bearer <Token>",
      "```",
      "",
      "_Quick Tunnel URL 每次启动会变化；始终以本文档最新值为准。_",
      "",
      "## 工作区信息",
      "",
      "| 项 | 值 |",
      "|---|---|",
      "| 工作区 | " + ws.name + " |",
      "| 根目录 | `" + ws.root + "` |",
      "| 文件夹 | " + (ws.folders.join(" / ") || "(无)") + " |",
      "| 主机 | " + ws.host + " (" + ws.user + ") |",
      "| 平台 | " + ws.platform + " |",
      "| IDE | " + ws.ide + " " + ws.ideVersion + " |",
      "| 会话 | " + ws.sessionId + " |",
      "| 更新于 | " + ts + " |",
      "",
      "## 能力 (域限定于工作区根)",
      "",
      "| 方法 | 路径 | Body | 说明 |",
      "|---|---|---|---|",
      "| GET | `/api/health` | - | 存活/工作区名 (免鉴权) |",
      "| GET | `/api/info` | - | 工作区完整信息 |",
      "| POST | `/api/exec` | `{cmd,timeout}` | 在工作区根执行命令 |",
      "| POST | `/api/ls` | `{path}` | 列目录 (限根内) |",
      "| POST | `/api/read` | `{path}` | 读文件 (限根内) |",
      "| POST | `/api/write` | `{path,content}` | 写文件 (限根内) |",
      "",
      "## 云端 Agent 即用片段 (Python)",
      "",
      "```python",
      "import urllib.request, json",
      'URL   = "' + (this.url || "https://<见上>.trycloudflare.com") + '"',
      'TOKEN = "' + this.srv.token + '"',
      "def api(method, p, body=None):",
      "    data = json.dumps(body).encode() if body else None",
      '    req = urllib.request.Request(URL+p, data=data, method=method,',
      '        headers={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json","User-Agent":"Mozilla/5.0"})',
      "    return json.loads(urllib.request.urlopen(req, timeout=60).read())",
      'print(api("GET", "/api/health"))',
      'print(api("POST", "/api/exec", {"cmd":"cd"}))',
      "```",
      "",
      "*道法自然 · 无为而无不为*",
      "",
    ].join("\n");
    try { fs.writeFileSync(this.mdPath(), md, "utf8"); } catch (e) {}
    try {
      fs.writeFileSync(this.connPath(), JSON.stringify({
        url: this.url, token: this.srv.token, local_url: "http://127.0.0.1:" + this.srv.port,
        port: this.srv.port, workspace: ws.name, root: ws.root, host: ws.host, updated: ts,
      }, null, 2), "utf8");
    } catch (e) {}
  }

  stop() {
    try { if (this.proc) { this.proc.kill(); } } catch (e) {}
    this.proc = null;
    this.srv.stop();
    this.url = "";
    // 标记下线 (删旧：清空 conn.json 的 url)
    try {
      const c = JSON.parse(fs.readFileSync(this.connPath(), "utf8"));
      c.url = ""; c.offlineAt = new Date().toISOString();
      fs.writeFileSync(this.connPath(), JSON.stringify(c, null, 2), "utf8");
    } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------
class BridgeViewProvider {
  constructor(ctx, bridge) { this.ctx = ctx; this.bridge = bridge; this.view = null; bridge.onUpdate = (s) => this.post({ type: "state", state: s }); }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (m) => { try { await this.handle(m); } catch (e) { this.post({ type: "result", op: m && m.op, ok: false, text: String(e && e.message) }); } });
    this.post({ type: "state", state: this.bridge.state() });
  }
  post(msg) { if (this.view) this.view.webview.postMessage(msg); }
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
  async handle(m) {
    if (m.op === "restart") { this.bridge.stop(); await this.bridge.start(); return; }
    if (m.op === "openMd") { const d = await vscode.workspace.openTextDocument(this.bridge.mdPath()); vscode.window.showTextDocument(d); return; }
    if (m.op === "copyUrl") { await vscode.env.clipboard.writeText(this.bridge.url || ""); vscode.window.showInformationMessage("已复制公网 URL"); return; }
    if (m.op === "copyMd") { try { await vscode.env.clipboard.writeText(fs.readFileSync(this.bridge.mdPath(), "utf8")); vscode.window.showInformationMessage("已复制 MD 文档"); } catch (e) {} return; }
    if (m.op === "openCf") { vscode.env.openExternal(vscode.Uri.parse("https://one.dash.cloudflare.com")); return; }
    let p, method = "POST", body = null;
    if (m.op === "health") { p = "/api/health"; method = "GET"; }
    else if (m.op === "info") { p = "/api/info"; method = "GET"; }
    else if (m.op === "exec") { p = "/api/exec"; body = { cmd: m.arg }; }
    else if (m.op === "ls") { p = "/api/ls"; body = { path: m.arg }; }
    else return;
    const r = await this.localApi(p, method, body);
    this.post({ type: "result", op: m.op, ok: r.status === 200, status: r.status, text: (r.text || "").slice(0, 4000) });
  }
  html() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);font-size:12px;padding:8px;color:var(--vscode-foreground)}
h3{margin:10px 0 4px;font-size:12px;color:var(--vscode-textLink-foreground)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#888}
.ok{background:#3fb950}.bad{background:#f85149}
input,button{font-size:12px;margin:2px 0;width:100%;box-sizing:border-box;padding:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#3334)}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;border:none}
button:hover{background:var(--vscode-button-hoverBackground)}
.row{display:flex;gap:4px}.row button{width:auto;flex:1}
pre{white-space:pre-wrap;word-break:break-all;background:var(--vscode-textCodeBlock-background);padding:6px;max-height:220px;overflow:auto;font-size:11px}
.muted{color:var(--vscode-descriptionForeground)}
.url{user-select:all;font-weight:600;color:var(--vscode-textLink-foreground);word-break:break-all}
.card{border:1px solid var(--vscode-input-border,#3334);border-radius:4px;padding:8px;margin-top:8px}
</style></head><body>
<h3>☯ 当前工作区隧道</h3>
<div><span id="dot" class="dot"></span><span id="stat">启动中…</span></div>
<div class="card">
<div class="muted">公网 URL</div><div id="url" class="url">—</div>
<div class="muted" style="margin-top:6px">工作区 / 根目录</div><div id="ws" style="word-break:break-all">—</div>
<div class="row" style="margin-top:6px"><button onclick="send('copyUrl')">复制URL</button><button onclick="send('copyMd')">复制MD</button><button onclick="send('openMd')">打开MD</button></div>
<button onclick="send('restart')">重启隧道</button>
</div>

<h3>能力自测 (打到本工作区)</h3>
<div class="row"><button onclick="send('health')">health</button><button onclick="send('info')">info</button></div>
<input id="cmd" placeholder="命令，如 cd" value="cd"><button onclick="send('exec',v('cmd'))">exec</button>
<input id="lsp" placeholder="目录(相对工作区)" value="."><button onclick="send('ls',v('lsp'))">ls</button>
<pre id="out" class="muted">（结果显示在这里）</pre>

<div class="card">
<h3 style="margin-top:0">Cloudflare</h3>
<div class="muted">登录你的 Cloudflare 账号即可一键打通 (quick tunnel，无需域名)。隧道随本窗口启停；关闭 IDE 自动断开。</div>
<button onclick="send('openCf')">打开 Cloudflare 控制台</button>
</div>
<script>
const vscode=acquireVsCodeApi();
function send(op,arg){vscode.postMessage({op,arg});}
function v(id){return document.getElementById(id).value;}
const out=document.getElementById('out');
window.addEventListener('message',(e)=>{const m=e.data;
 if(m.type==='state'){const s=m.state||{};const on=!!s.url;
  document.getElementById('dot').className='dot '+(on?'ok':'bad');
  document.getElementById('stat').textContent=on?'已打通 · 隧道在线':(s.lastErr?('未连接 '+s.lastErr):'隧道启动中…');
  document.getElementById('url').textContent=s.url||'—';
  document.getElementById('ws').textContent=s.ws?(s.ws.name+'  ·  '+s.ws.root):'—';}
 if(m.type==='result'){out.className='';out.textContent='['+m.op+'] status='+(m.status||0)+' ok='+m.ok+'\\n'+(m.text||'');}
});
</script>
</body></html>`;
  }
}

let _bridge = null;
function activate(context) {
  _bridge = new Bridge(context);
  const provider = new BridgeViewProvider(context, _bridge);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("daoBridgeView", provider));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.restart", async () => { _bridge.stop(); await _bridge.start(); }));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.openMd", async () => { const d = await vscode.workspace.openTextDocument(_bridge.mdPath()); vscode.window.showTextDocument(d); }));
  context.subscriptions.push({ dispose: () => { try { _bridge.stop(); } catch (e) {} } });
  // 随窗口启动自动打通
  _bridge.start().then((url) => { if (url) vscode.window.setStatusBarMessage("DAO Bridge 已打通: " + url, 8000); });
}
function deactivate() { try { if (_bridge) _bridge.stop(); } catch (e) {} }
module.exports = { activate, deactivate };
