// 道 · 归一超级插件本体 (dao-one) — 统一编排器
// ─────────────────────────────────────────────────────────────────────────────
// 反者道之动。正本清源:不再手写驾驶舱,而是「大规模复用」各引擎本体的真实前端 ——
//   · rt-flow      → wam.panel       (左:WAM 切号 · 账号管理 · 备份 · 回归本源)
//   · dao-vsix     → dao.cloudPanel  (中:全能板 · Devin Cloud,右下角小按钮开全功能中央面板)
//   · dao-proxy-pro→ /origin 反代 + getEaConfigHtml (三模块面板内嵌为全能板「Proxy Pro」tab)
//   · dao-bridge   → 内网穿透 (内嵌为全能板「内网穿透」tab + 共享 cloudflared)
// 最终前端只两面:左 rt-flow 切号 + 中 全能板。内网穿透 / Proxy Pro 皆并列内置于全能板内部 tab。
// 四引擎照常 activate(后端齐备:反代端口/隧道),仅 wam.panel 与 dao.cloudPanel 占据容器视图。零前端重写。
// 损之又损,以至于无为,无为而无不为。
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require("vscode");
const path = require("path");

// ── 子引擎: 名 · 子目录 · 入口 ────────────────────────────────────────────────
const MODULES = [
  { key: "面板", dir: "vendor-vsix", entry: "out/extension.js" }, // dao-vsix → dao.cloudPanel
  { key: "路由", dir: "vendor-proxy", entry: "extension.js" }, // dao-proxy-pro → dao.essence
  { key: "Cloud", dir: "vendor-flow", entry: "extension.js" }, // rt-flow → wam.panel
  { key: "穿透", dir: "vendor-bridge", entry: "extension.js", optional: true }, // dao-bridge → daoBridgeView
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
async function activate(context) {
  log("dao-one activate · 归一: " + MODULES.map((m) => m.key).join(" / "));
  // 依次启动四引擎 —— 各自 activate 注册其原生 webview/后端服务。
  // 仅 wam.panel 与 dao.cloudPanel 在 package.json dao-one 容器下声明 → 占据容器视图;
  // dao-proxy-pro 的 /origin 反代与 dao-bridge 隧道照常起,其面板内嵌于全能板内部 tab。
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

  // dao.one.refresh: 兼容菜单/键位 —— 聚焦容器(默认落在 ① 切号)。
  context.subscriptions.push(
    vscode.commands.registerCommand("dao.one.refresh", () =>
      vscode.commands.executeCommand("wam.panel.focus").then(undefined, () => {})
    )
  );
  log("归一容器就绪 · 两面: 左 ① 切号(wam.panel) + 中 ② 全能板(dao.cloudPanel·内置 内网穿透/Proxy Pro tab)");
}

async function deactivate() {
  for (const { mod, m } of _loaded.reverse()) {
    try { if (mod && typeof mod.deactivate === "function") await mod.deactivate(); }
    catch (e) { log("deactivate [" + m.key + "] 失败: " + e); }
  }
}

module.exports = { activate, deactivate };
