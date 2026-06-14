// 道 · 归一超级插件本体 (dao-one) — 统一编排器
// ─────────────────────────────────────────────────────────────────────────────
// 物無非彼,物無非是 —— 三套引擎(dao-vsix 全功能面板 / dao-proxy-pro 提示词隔离·外接
// 路由 / rt-flow Devin Cloud 多账号·备份·回归本源)在此归一为「一」:
//   · 三引擎照常运行,但各自的侧栏面板全部隐藏(headless);
//   · 用户只见单一驾驶舱 dao.one —— 按"意图"而非"来源"组织,无感无为;
//   · 驾驶舱经单总线驱动既有命令、并直读 dao 的工作区状态/服务,无不为。
// 损之又损,以至于无为,无为而无不为。
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const { getCockpitHtml } = require("./cockpit.js");

// ── 子引擎(headless): 名 · 子目录 · 入口 ──────────────────────────────────────
const MODULES = [
  { key: "面板", dir: "vendor-vsix", entry: "out/extension.js" }, // dao-vsix
  { key: "路由", dir: "vendor-proxy", entry: "extension.js" }, // dao-proxy-pro
  { key: "Cloud", dir: "vendor-flow", entry: "extension.js" }, // rt-flow
];

const _out = vscode.window.createOutputChannel("道 · 归一");
const log = (m) => { try { _out.appendLine("[" + new Date().toISOString() + "] " + m); } catch (_) {} };

// 子目录隔离 context: 各引擎读自身资源时锚到自己的 vendor-* 目录;其余字段透传。
function subContext(ctx, subDir) {
  const subPath = path.join(ctx.extensionPath, subDir);
  const subUri = vscode.Uri.file(subPath);
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "extensionPath") return subPath;
      if (prop === "extensionUri") return subUri;
      if (prop === "asAbsolutePath") return (rel) => path.join(subPath, rel);
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const _loaded = [];

// ═══════════════════════════════════════════════════════════════════════════
// 数据层 — 直读 dao 工作区状态(瞬时·可靠) + 代理 :9920(实时列表·尽力)
// ═══════════════════════════════════════════════════════════════════════════
const DAO_DIR = path.join(os.homedir(), ".dao");

// 与 dao-vsix 一致地推导 per-workspace 键 → 工作区目录
function daoWorkspaceDir() {
  const folders = vscode.workspace.workspaceFolders;
  let suffix = "";
  try { suffix = vscode.env.sessionId || ""; } catch (_) {}
  const wsPath = folders && folders.length > 0 ? folders[0].uri.fsPath : "no-workspace-" + suffix;
  const key = crypto.createHash("sha256").update(wsPath).digest("hex").substring(0, 12);
  return path.join(DAO_DIR, "workspaces", key);
}

function readDaoState() {
  const dir = daoWorkspaceDir();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); } catch (_) {}
  let token = cfg.token || "";
  if (!token) { try { token = fs.readFileSync(path.join(dir, "token"), "utf8").trim(); } catch (_) {} }
  if (!token) token = vscode.workspace.getConfiguration("dao").get("token") || "";
  return { dir, cfg, token };
}

let _portCache = { port: 0, at: 0 };
function httpGet(port, pathname, token, timeoutMs) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["authorization"] = "Bearer " + token;
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers, timeout: timeoutMs || 2500 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// 解析 dao 服务实际端口: /api/health 在 loopback 免 token,逐个候选探测
async function resolveDaoPort() {
  if (_portCache.port && Date.now() - _portCache.at < 30000) return _portCache.port;
  const base = vscode.workspace.getConfiguration("dao").get("port") || 9920;
  const cands = [base];
  for (let i = 0; i < 8; i++) if (!cands.includes(base + i)) cands.push(base + i);
  for (const p of cands) {
    const h = await httpGet(p, "/api/health", "", 600);
    if (h) { _portCache = { port: p, at: Date.now() }; return p; }
  }
  return 0;
}

// 在响应中提取"计数": 数组→长度; 已知数组字段→长度; count 数字→其值; 否则(ok:false/未知)→null(显示 —)
function countOf(resp) {
  if (resp == null) return null;
  if (Array.isArray(resp)) return resp.length;
  for (const k of ["sessions", "items", "data", "knowledge", "playbooks", "secrets", "connections", "list", "results"]) {
    if (Array.isArray(resp[k])) return resp[k].length;
  }
  for (const k of Object.keys(resp)) if (Array.isArray(resp[k])) return resp[k].length;
  if (typeof resp.count === "number") return resp.count;
  return null;
}

async function gatherState() {
  const { cfg, token } = readDaoState();
  const dcfg = vscode.workspace.getConfiguration("dao");
  const wcfg = vscode.workspace.getConfiguration("wam");

  // 身 · 来自 config.json(瞬时可靠)
  const loggedIn = !!(cfg.devinAuth1 || cfg.devinApiKey);
  const apiKey = cfg.devinApiKey || "";
  const apiKeyType = apiKey
    ? apiKey.startsWith("cog_") ? "cog"
      : apiKey.startsWith("devin-session-token$") ? "session"
        : apiKey.startsWith("sk-") ? "sk-ws" : "token"
    : "";
  const id = { loggedIn, email: cfg.devinEmail || "", org: cfg.devinOrgName || "", accountId: cfg.devinAccountId || "", apiKeyType };

  // 额度 · dailyQuotaRemainingPercent(余量%)
  let quota = null;
  const q = cfg.devinQuota;
  if (q && (q.dailyQuotaRemainingPercent != null || q.weeklyQuotaRemainingPercent != null)) {
    const d = q.dailyQuotaRemainingPercent != null ? q.dailyQuotaRemainingPercent : q.weeklyQuotaRemainingPercent;
    quota = {
      pct: d,
      tone: d <= 10 ? "bad" : d <= 30 ? "warn" : "good",
      label: (q.planName ? q.planName + " · " : "") + "日内余量",
      text: d + "%",
    };
  }

  // 衡 · 路由 / 备份(config)
  const route = {
    mode: dcfg.get("origin.defaultMode") || "invert",
    extApi: !!dcfg.get("外api.enabled"),
    modelUnlock: !!dcfg.get("modelUnlock.enabled"),
  };
  const cloud = {
    autoBackup: wcfg.get("devinCloudAutoBackup") !== false,
    autoRotate: wcfg.get("autoRotate") !== false,
    backupDir: wcfg.get("devinCloudBackupDir") || "",
  };

  // 观 · 实时计数(代理 :9920, 尽力而为, 离线则 —)
  const port = await resolveDaoPort();
  const service = { running: !!port, port: port || (dcfg.get("port") || 9920) };
  let counts = {};
  if (port && loggedIn) {
    const [se, kn, pb, sc, gt] = await Promise.all([
      httpGet(port, "/api/devin/sessions?limit=100", token, 3000),
      httpGet(port, "/api/devin/knowledge", token, 3000),
      httpGet(port, "/api/devin/playbooks", token, 3000),
      httpGet(port, "/api/devin/secrets", token, 3000),
      httpGet(port, "/api/devin/git/connections", token, 3000),
    ]);
    counts = { sessions: countOf(se), knowledge: countOf(kn), playbooks: countOf(pb), secrets: countOf(sc), git: countOf(gt) };
  }
  return { service, id, quota, route, cloud, counts };
}

// ═══════════════════════════════════════════════════════════════════════════
// 驾驶舱 WebviewViewProvider
// ═══════════════════════════════════════════════════════════════════════════
class CockpitProvider {
  constructor(ctx) { this.ctx = ctx; this.view = null; }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(this.ctx.extensionPath, "media"))] };
    const nonce = crypto.randomBytes(16).toString("hex");
    view.webview.html = getCockpitHtml(nonce, view.webview.cspSource);
    view.webview.onDidReceiveMessage((m) => this.onMsg(m));
    view.onDidChangeVisibility(() => { if (view.visible) this.push(); });
  }
  async push() {
    if (!this.view) return;
    try { this.view.webview.postMessage({ type: "state", data: await gatherState() }); } catch (e) { log("push err " + e); }
  }
  toast(text, bad) { if (this.view) try { this.view.webview.postMessage({ type: "toast", text, bad: !!bad }); } catch (_) {} }

  async run(id, ...args) {
    try { await vscode.commands.executeCommand(id, ...args); return true; }
    catch (e) { log("cmd 失败 " + id + ": " + e); this.toast("✗ " + id + " 未就绪", true); return false; }
  }
  async onMsg(m) {
    if (!m || !m.type) return;
    switch (m.type) {
      case "ready":
      case "refresh":
        return this.push();
      case "cmd": {
        const ok = await this.run(m.id);
        if (ok) this.toast("✓ 已执行");
        setTimeout(() => this.push(), 900);
        return;
      }
      case "route": {
        const cfg = vscode.workspace.getConfiguration("dao");
        const cur = cfg.get("origin.defaultMode") || "invert";
        const next = cur === "invert" ? "passthrough" : "invert";
        const cmd = next === "passthrough" ? "wam.originPassthrough" : "wam.originInvert";
        const ok = await this.run(cmd);
        // 写入规范模式配置 → 驾驶舱显示与运行时一致, 且持久到下次启动
        try { await cfg.update("origin.defaultMode", next, vscode.ConfigurationTarget.Global); } catch (_) {}
        if (ok) this.toast(next === "passthrough" ? "→ 直连官方(官)" : "→ 本源观照(道)");
        setTimeout(() => this.push(), 700);
        return;
      }
      case "backup": {
        const cfg = vscode.workspace.getConfiguration("wam");
        const cur = cfg.get("devinCloudAutoBackup") !== false;
        try {
          await cfg.update("devinCloudAutoBackup", !cur, vscode.ConfigurationTarget.Global);
          this.toast(!cur ? "✓ 自动备份 · 开" : "○ 自动备份 · 关");
        } catch (e) { this.toast("✗ 备份开关失败", true); }
        return this.push();
      }
      case "rotate": {
        // 自动轮转开关 — 交由 rt-flow 命令切换(单一真源), 再回写规范配置以同步驾驶舱
        await this.run("wam.toggleAutoRotate");
        const cfg = vscode.workspace.getConfiguration("wam");
        const cur = cfg.get("autoRotate") !== false;
        this.toast(cur ? "✓ 自动轮转 · 开" : "○ 自动轮转 · 关");
        setTimeout(() => this.push(), 600);
        return;
      }
      case "pasteAccount": {
        // B2 · 主账号粘贴即换: 把整行(账密/凭据)交给 rt-flow 添加并 token 直登, 然后刷新驾驶舱
        const text = (m.text || "").trim();
        if (!text) { this.toast("先粘贴 账号:密码 一行", true); return; }
        const ok = await this.run("wam.addAccount", text);
        if (ok) this.toast("✓ 已粘贴主账号 · 直登并刷新");
        setTimeout(() => this.push(), 1200);
        return;
      }
      case "intent":
        return this.intent(m.id);
    }
  }
  // 编排意图: 一举而备 —— 多引擎按序协作
  async intent(id) {
    if (id === "freshIdentity") {
      const pick = await vscode.window.showWarningMessage(
        "一键净身: 先备份当前账号对话 → 净痕(water-trace) → 轮转到下一账号。继续?",
        { modal: true }, "继续"
      );
      if (pick !== "继续") return;
      this.toast("① 备份当前…");
      await this.run("wam.devinBackupAccount");
      this.toast("② 净痕…");
      await this.run("wam.devinWipeAccount");
      this.toast("③ 轮转账号…");
      await this.run("wam.panicSwitch");
      this.toast("✓ 净身完成 · 水无痕");
      setTimeout(() => this.push(), 1200);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
async function activate(context) {
  log("dao-one activate · 归一: " + MODULES.map((m) => m.key).join(" / "));
  // 三引擎 headless: 各自的侧栏视图未在 package.json 声明 → 不渲染, 但服务/路由/轮转照常。
  for (const m of MODULES) {
    const full = path.join(context.extensionPath, m.dir, m.entry);
    try {
      const mod = require(full);
      if (mod && typeof mod.activate === "function") {
        await mod.activate(subContext(context, m.dir));
        _loaded.push({ mod, m });
        log("✓ [" + m.key + "] 引擎启动 (" + m.dir + ")");
      } else log("✗ [" + m.key + "] 无 activate: " + full);
    } catch (e) { log("✗ [" + m.key + "] 启动失败: " + (e && e.stack ? e.stack : e)); }
  }
  log("引擎就绪 " + _loaded.length + "/" + MODULES.length);

  // 单一驾驶舱
  const provider = new CockpitProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("dao.one", provider));
  context.subscriptions.push(vscode.commands.registerCommand("dao.one.refresh", () => provider.push()));
  context.subscriptions.push(vscode.commands.registerCommand("dao.one.focus", () => vscode.commands.executeCommand("dao.one.focus")));
  log("驾驶舱 dao.one 就绪");
}

async function deactivate() {
  for (const { mod, m } of _loaded.reverse()) {
    try { if (mod && typeof mod.deactivate === "function") await mod.deactivate(); }
    catch (e) { log("deactivate [" + m.key + "] 失败: " + e); }
  }
}

module.exports = { activate, deactivate };
