const vscode = require("vscode");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function readConnJson() {
  const candidates = [
    path.join(__dirname, "..", "dao-bridge", "conn.json"),
    path.join(os.homedir(), "plugins", "cf-daohub", "dao-bridge", "conn.json"),
    path.join(os.homedir(), ".dao-bridge", "conn.json"),
  ];
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, "utf8")); } catch (e) {}
  }
  return {};
}

function cfg() {
  const c = vscode.workspace.getConfiguration("daoBridge");
  const conn = readConnJson();
  const relayUrl = (c.get("relayUrl") || conn.relayUrl || "https://dao-relay-do.zhouyoukang.workers.dev").replace(/\/$/, "");
  const session = c.get("session") || conn.session || "141";
  const token = c.get("token") || conn.token || "";
  return { relayUrl, session, token, host: conn.host || "?" };
}

// 中继请求：云端 -> workers.dev DurableObject -> WSS -> 本地 agent
function relay(innerPath, method, innerBody, timeout) {
  return new Promise((resolve) => {
    const { relayUrl, session, token } = cfg();
    const url = new URL(relayUrl + "/relay/" + encodeURIComponent(session));
    const env = { path: innerPath, method: method || "GET" };
    if (innerBody !== undefined && innerBody !== null) env.body = JSON.stringify(innerBody);
    const data = JSON.stringify(env);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "User-Agent": UA,           // 关键：缺少浏览器 UA 会被 Cloudflare 1010 拦截
        "Accept": "*/*",
      },
      timeout: timeout || 40000, rejectUnauthorized: false,
    }, (res) => {
      let d = ""; res.on("data", (c) => d += c);
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, text: d }); });
    });
    req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, text: "timeout" }); });
    req.write(data); req.end();
  });
}

class BridgeViewProvider {
  constructor(ctx) { this.ctx = ctx; this.view = null; }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (m) => {
      try { await this.handle(m); } catch (e) { this.post({ type: "result", op: m && m.op, ok: false, text: String(e && e.message) }); }
    });
    this.checkHealth();
  }
  post(msg) { if (this.view) this.view.webview.postMessage(msg); }
  async checkHealth() {
    const r = await relay("/api/health", "GET");
    const ok = r.status === 200 && r.json && r.json.status === "ok";
    this.post({ type: "status", ok, info: r.json || null, raw: (r.text || "").slice(0, 200), session: cfg().session });
  }
  async handle(m) {
    if (m.op === "refresh") return this.checkHealth();
    let path_, method = "POST", body = null;
    if (m.op === "health") { path_ = "/api/health"; method = "GET"; }
    else if (m.op === "info") { path_ = "/api/info"; method = "GET"; }
    else if (m.op === "exec") { path_ = "/api/exec"; body = { cmd: m.arg }; }
    else if (m.op === "ls") { path_ = "/api/ls"; body = { path: m.arg }; }
    else if (m.op === "read") { path_ = "/api/read"; body = { path: m.arg }; }
    else if (m.op === "write") { path_ = "/api/write"; body = { path: m.arg, content: m.arg2 }; }
    else return;
    const r = await relay(path_, method, body);
    this.post({ type: "result", op: m.op, ok: r.status === 200, status: r.status, text: (r.text || "").slice(0, 4000) });
  }
  html() {
    const { relayUrl, session, host } = cfg();
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:var(--vscode-font-family);font-size:12px;padding:8px;color:var(--vscode-foreground)}
h3{margin:10px 0 4px;font-size:12px;color:var(--vscode-textLink-foreground)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#888}
.ok{background:#3fb950}.bad{background:#f85149}
input,button{font-size:12px;margin:2px 0;width:100%;box-sizing:border-box;padding:4px;
 background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#3334)}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;border:none}
button:hover{background:var(--vscode-button-hoverBackground)}
.row{display:flex;gap:4px}.row button{width:auto;flex:1}
pre{white-space:pre-wrap;word-break:break-all;background:var(--vscode-textCodeBlock-background);padding:6px;max-height:240px;overflow:auto;font-size:11px}
.muted{color:var(--vscode-descriptionForeground)}
.cf{border:1px solid var(--vscode-input-border,#3334);border-radius:4px;padding:6px;margin-top:8px}
</style></head><body>
<h3>连接状态</h3>
<div><span id="dot" class="dot"></span><span id="stat">检查中…</span></div>
<div class="muted">中继: ${esc(relayUrl)}<br>会话: ${esc(session)} · 主机: ${esc(host)}</div>
<button onclick="send('refresh')">刷新状态</button>

<h3>能力测试（全链路 → 本地/内网机器）</h3>
<div class="row"><button onclick="send('health')">health</button><button onclick="send('info')">info</button></div>
<input id="cmd" placeholder="远程命令，如 hostname" value="hostname">
<button onclick="exec()">exec 执行</button>
<input id="lsp" placeholder="目录路径" value="C:\\Users">
<button onclick="ls()">ls 列目录</button>
<input id="rp" placeholder="读取文件路径">
<button onclick="rd()">read 读文件</button>
<input id="wp" placeholder="写入文件路径">
<input id="wc" placeholder="写入内容">
<button onclick="wr()">write 写文件</button>
<pre id="out" class="muted">（结果显示在这里）</pre>

<div class="cf">
<h3 style="margin-top:0">Cloudflare 一键打通</h3>
<div class="muted">本插件通过部署在你 Cloudflare 账号的 <b>workers.dev Durable Object</b> 中继转发请求到本地 agent。<br>
1) 登录 Cloudflare → 2) 部署 dao-relay-do Worker → 3) 本地运行 agent (start.ps1)。<br>
中继与 token 可在「设置 → DAO Bridge」中配置。</div>
<button onclick="openCf()">打开 Cloudflare 控制台</button>
</div>

<script>
const vscode = acquireVsCodeApi();
function send(op,arg,arg2){vscode.postMessage({op,arg,arg2});}
function exec(){send('exec',document.getElementById('cmd').value);}
function ls(){send('ls',document.getElementById('lsp').value);}
function rd(){send('read',document.getElementById('rp').value);}
function wr(){send('write',document.getElementById('wp').value,document.getElementById('wc').value);}
function openCf(){send('openCf');}
const out=document.getElementById('out');
window.addEventListener('message',(e)=>{const m=e.data;
 if(m.type==='status'){const d=document.getElementById('dot'),s=document.getElementById('stat');
  d.className='dot '+(m.ok?'ok':'bad');
  s.textContent=m.ok?('已连接 · '+(m.info&&m.info.service||'')+' v'+(m.info&&m.info.version||'')+' · '+(m.info&&m.info.host||'')):('未连接 '+(m.raw||''));}
 if(m.type==='result'){out.className='';out.textContent='['+m.op+'] status='+(m.status||0)+' ok='+m.ok+'\\n'+(m.text||'');}
});
</script>
</body></html>`;
  }
}

function activate(context) {
  const provider = new BridgeViewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("daoBridgeView", provider));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.refresh", () => provider.checkHealth()));
  context.subscriptions.push(vscode.commands.registerCommand("daoBridge.exec", async () => {
    const cmd = await vscode.window.showInputBox({ prompt: "远程执行命令" });
    if (!cmd) return;
    const r = await relay("/api/exec", "POST", { cmd });
    vscode.window.showInformationMessage("dao-bridge: " + (r.text || "").slice(0, 300));
  }));
  // openCf handled via message
  const orig = provider.handle.bind(provider);
  provider.handle = async (m) => {
    if (m && m.op === "openCf") { vscode.env.openExternal(vscode.Uri.parse("https://dash.cloudflare.com")); return; }
    return orig(m);
  };
}
function deactivate() {}
module.exports = { activate, deactivate };
