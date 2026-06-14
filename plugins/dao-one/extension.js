// 道 · 归一超级插件本体 (dao-one) — 统一编排器
// ─────────────────────────────────────────────────────────────────────────────
// 反者道之动。正本清源:不再手写驾驶舱,而是「大规模复用」三套引擎本体的真实前端 ——
//   · dao-vsix     → dao.cloudPanel  (全能板 · Devin Cloud)
//   · dao-proxy-pro→ dao.essence     (源照 / 渠配 / 模型路由)
//   · rt-flow      → wam.panel       (WAM 切号 · 账号管理 · 备份 · 回归本源)
// 三引擎在此归一为「一」:各引擎照常 activate 并注册其原生 webview,本体只把这三个
// 视图统一挂到单一容器 dao-one(见 package.json),由 VS Code 竖排手风琴渲染 ——
// 默认聚焦 ① 切号(rt-flow 最常用),点击其余入口横展子块。零前端重写。
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
  // 依次启动三引擎 —— 各自的 activate 会 registerWebviewViewProvider(其原生视图 id)。
  // 这些视图 id(dao.cloudPanel / dao.essence / wam.panel)已在 package.json 的
  // dao-one 容器下声明 → VS Code 自动竖排渲染,无需本体手写任何前端。
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
  log("归一容器就绪 · 三真实前端竖排: ① 切号 / ② Proxy Pro / ③ 全能板");
}

async function deactivate() {
  for (const { mod, m } of _loaded.reverse()) {
    try { if (mod && typeof mod.deactivate === "function") await mod.deactivate(); }
    catch (e) { log("deactivate [" + m.key + "] 失败: " + e); }
  }
}

module.exports = { activate, deactivate };
