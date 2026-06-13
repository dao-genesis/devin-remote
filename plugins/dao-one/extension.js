// 道 · 归一超级插件本体 (dao-one)
// ─────────────────────────────────────────────────────────────────────────────
// 帛书·《老子》四十二:「道生一,一生二,二生三,三生萬物。」
//   反之 — 三归一: dao-vsix(全功能面板) + dao-proxy-pro(提示词隔离·外接路由) +
//   rt-flow(Devin Cloud 接入·多账号·备份·回归本源) 一次性整合为单一插件本体。
//
// 大道至简 · 用户无感无为:
//   装一个 VSIX、活动栏一个「道」图标、下挂三折叠板块 ①面板 ②路由 ③Cloud。
//
// 整合逻辑(最优质·零损耗):
//   VS Code 的视图归属由 package.json 的 views 映射决定,而非代码。三子模块各自
//   注册的 WebviewViewProvider 视图 id (dao.cloudPanel / dao.essence / wam.panel)
//   在归一 package.json 里统一挂到同一容器 dao-one 下 → 单图标三板块。
//   入口仅 require 三子模块、用各自子目录隔离的 context 依次 activate,既保留它们
//   已 live 验证的全部逻辑(三万行),又呈现为单一插件。
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require("vscode");
const path = require("path");

// 子模块清单: 名 · 子目录 · 入口相对路径
const MODULES = [
  { key: "面板", dir: "vendor-vsix", entry: "out/extension.js" }, // dao-vsix (TS→out)
  { key: "路由", dir: "vendor-proxy", entry: "extension.js" }, // dao-proxy-pro
  { key: "Cloud", dir: "vendor-flow", entry: "extension.js" }, // rt-flow
];

const _out = vscode.window.createOutputChannel("道 · 归一");
function log(m) {
  try {
    _out.appendLine("[" + new Date().toISOString() + "] " + m);
  } catch (_) {}
}

// 子目录隔离 context: 让各子模块用 extensionPath/extensionUri/asAbsolutePath 读取
// 自身资源时,锚到各自的 vendor-* 子目录(其余字段—subscriptions/globalState/secrets
// 等—与归一本体共享)。守柔: 只覆盖路径相关字段,其它一律透传。
function subContext(ctx, subDir) {
  const subPath = path.join(ctx.extensionPath, subDir);
  const subUri = vscode.Uri.file(subPath);
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "extensionPath") return subPath;
      if (prop === "extensionUri") return subUri;
      if (prop === "asAbsolutePath")
        return (rel) => path.join(subPath, rel);
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const _loaded = [];

async function activate(context) {
  log("dao-one activate · 三归一: " + MODULES.map((m) => m.key).join(" / "));
  // 一条失败不毁全局(帛书「一条失败不毁全份」): 逐模块隔离 activate,
  // 单个子模块抛错只记录、不阻断其余板块。
  for (const m of MODULES) {
    const full = path.join(context.extensionPath, m.dir, m.entry);
    try {
      const mod = require(full);
      if (mod && typeof mod.activate === "function") {
        const api = await mod.activate(subContext(context, m.dir));
        _loaded.push({ mod, m });
        log("✓ [" + m.key + "] activate 成功 (" + m.dir + ")");
        if (api) {
          /* 子模块导出的 API 暂不外联,各自独立运行 */
        }
      } else {
        log("✗ [" + m.key + "] 无 activate 导出: " + full);
      }
    } catch (e) {
      log("✗ [" + m.key + "] activate 失败: " + (e && e.stack ? e.stack : e));
    }
  }
  log("dao-one activate 完成 · 已载 " + _loaded.length + "/" + MODULES.length);
}

async function deactivate() {
  for (const { mod, m } of _loaded.reverse()) {
    try {
      if (mod && typeof mod.deactivate === "function") await mod.deactivate();
    } catch (e) {
      log("deactivate [" + m.key + "] 失败: " + e);
    }
  }
}

module.exports = { activate, deactivate };
