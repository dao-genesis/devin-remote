// 一次性生成归一 package.json: 合并三子模块的 commands/configuration/menus,
// 把三个 webview 视图统一挂到单一容器 dao-one 下。运行: node gen-manifest.js
const fs = require("fs");
const path = require("path");
const plugins = path.dirname(__dirname);
const rd = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const vsix = rd(path.join(plugins, "dao-vsix", "package.json"));
const proxy = rd(path.join(plugins, "dao-proxy-pro", "package.json"));
const flow = rd(path.join(plugins, "rt-flow", "package.json"));

// commands 并集 (按 command id 去重,先到先得)
const cmdMap = new Map();
for (const src of [vsix, proxy, flow])
  for (const c of (src.contributes && src.contributes.commands) || [])
    if (!cmdMap.has(c.command)) cmdMap.set(c.command, c);
const commands = [...cmdMap.values()];
// 归一自有命令
commands.unshift(
  { command: "dao.one.refresh", title: "道·归一: 刷新驾驶舱" },
);

// configuration: 三段并存 (数组形式,各自 title) — 规避 key 合并冲突
function asConfigArray(src, fallbackTitle) {
  const c = src.contributes && src.contributes.configuration;
  if (!c) return [];
  return Array.isArray(c) ? c : [{ title: c.title || fallbackTitle, properties: c.properties }];
}
const configuration = [
  ...asConfigArray(vsix, "Dao 面板"),
  ...asConfigArray(proxy, "道 路由"),
  ...asConfigArray(flow, "Cloud"),
];

// menus 并集
const menus = {};
for (const src of [vsix, proxy, flow]) {
  const m = (src.contributes && src.contributes.menus) || {};
  for (const k of Object.keys(m)) menus[k] = (menus[k] || []).concat(m[k]);
}

const manifest = {
  name: "dao-one",
  displayName: "道 · 归一 (Dao One)",
  description:
    "归一超级插件本体: 单一驾驶舱按'意图'统御全功能面板(dao-vsix)+提示词隔离·外接模型路由(dao-proxy-pro)+Devin Cloud 多账号/备份/回归本源(rt-flow)。三引擎隐形协作,用户无感无为,系统无不为。大道至简,道法自然。",
  version: "2.0.0",
  publisher: "dao",
  license: "Apache-2.0",
  icon: "media/icon.png",
  engines: { vscode: "^1.85.0" },
  categories: ["AI", "Other"],
  keywords: ["dao", "devin", "cascade", "proxy", "byok", "归一", "道德经"],
  capabilities: {
    untrustedWorkspaces: { supported: true, description: "dao-one runs in all workspaces" },
    virtualWorkspaces: true,
  },
  activationEvents: ["onStartupFinished"],
  main: "./extension.js",
  contributes: {
    viewsContainers: {
      activitybar: [
        { id: "dao-one", title: "道 · 归一", icon: "media/icon.svg" },
      ],
    },
    views: {
      // 归一·正本清源: 直接复用三引擎本体的真实前端视图,竖排归于单一容器 dao-one。
      // VS Code 原生把同容器多视图渲染成竖排手风琴 —— 即「全能板那种竖排按钮、
      // 点开横展子块」的形态,零前端重写。默认聚焦 ① 切号(rt-flow 最常用)。
      //   ① wam.panel    = rt-flow WAM 切号管理 (默认/最上)
      //   ② dao.essence  = dao-proxy-pro 提示词隔离 + 模型路由 (源照/渠配/模路)
      //   ③ dao.cloudPanel = dao-vsix 全能板 (Devin Cloud · 会话/知识/剧本/密钥)
      "dao-one": [
        { id: "wam.panel", name: "① 切号 · 账号管理", type: "webview" },
        { id: "dao.essence", name: "② Proxy Pro · 模型路由", type: "webview" },
        { id: "dao.cloudPanel", name: "③ 全能板 · Devin Cloud", type: "webview" },
      ],
    },
    commands,
    configuration,
    menus,
  },
  scripts: {
    "vscode:prepublish": "node ./build.js",
    compile: "node ./build.js",
  },
  devDependencies: { sucrase: "^3.35.1", "@vscode/vsce": "^3.9.2" },
  dependencies: { ws: "^8.16.0" },
};

fs.writeFileSync(
  path.join(__dirname, "package.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  "package.json written · commands=" +
    commands.length +
    " configSections=" +
    configuration.length +
    " menus=" +
    Object.keys(menus).join(","),
);
