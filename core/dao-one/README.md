# 道 · 归一 (dao-one)

> 帛书《老子》四十二:「道生一,一生二,二生三,三生萬物。」
> 反之 — **三归一**: 以 **dao-vsix 二合一**为本源, 在其全功能面板内**折入** dao-proxy-pro,
> 再合 rt-flow, 整合为**单一插件本体**。
> 大道至简 · 用户无感无为: 装一个 VSIX、活动栏一个「道」图标、最终前端只剩**两面**。

## 本源架构 — 以 dao-vsix 为基础 + Proxy Pro

dao-one **不是**把四套引擎并排成四个侧栏视图, 而是**以 dao-vsix(二合一)为根**, 在其
「dao Cloud 全功能面板」内部**折入** Proxy Pro 三模块, 使之与「内网穿透 / Sessions /
Knowledge …」并列为面板的一个内部 tab。最终用户看到的前端只有**两面**:

```
┌──────────────┬──────────────────────────────────────────────┐
│  左 · rt-flow │  中 · dao Cloud 全功能面板 (单一)             │
│  切号面板     │  ┌────────────────────────────────────────┐  │
│  (多账号轮转  │  │ 🏠主页 🌐内网穿透 🔀Proxy Pro 💬Sessions │  │
│   /备份/额度) │  │ 📚Knowledge 📋Playbooks 🔑Secrets …      │  │
│              │  │ ── 🔀Proxy Pro: ①本源观照 ②渠道配置      │  │
│              │  │      ③模型路由 (内嵌, 复用原生面板)      │  │
│              │  └────────────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────────────┘
```

| 层 | 源 | 在 dao-one 中的角色 |
|---|---|---|
| 本源 · dao-vsix(二合一) | `core/dao-vsix` | 全功能面板(主页/内网穿透/Sessions/Knowledge/Playbooks/Secrets)+ 本地 HTTP API + 官网自动登录 + 多账号反向注入 |
| 折入 · dao-proxy-pro | `core/dao-proxy-pro` | **折进全功能面板**的 🔀Proxy Pro tab: ①本源观照 ②渠道配置 ③模型路由(底层提示词隔离替换 + 外接模型路由) |
| 并立 · rt-flow | `core/rt-flow` | 左侧切号面板: Devin Cloud 多账号实时额度/轮转 + 批量备份/快照 + 回归本源 wipe |
| 内置 · dao-bridge | `addons/dao-bridge` | 内网穿透(作为全功能面板内的「内网穿透」tab, 后端随引擎启动) |

## 折入机制 — 构建期 overlay(dao-vsix 源永不沾 proxy)

**关键: dao-vsix 源保持纯二合一(无 proxy 一字)。** Proxy Pro 折叠只在 **dao-one 打包时**
以构建期补丁叠加, 绝不回写 dao-vsix 本体:

- `proxy-fold.patch` — context-aware 统一 diff, 由 `apply-overlay.js` 叠到 `vendor-vsix/`
  的 `extension.ts` 副本上(非 dao-vsix 源)。叠加内容:全功能面板新增 🔀Proxy Pro 导航 +
  `v-proxy` tab + `<iframe srcdoc>` 渲染 + 后端 `getProxyPanel` 处理器(发现反代端口、复用
  dao-proxy-pro 原生 `getEaConfigHtml` 生成三模块 HTML、零前端重写)。
- **端口直通 + fetch 垫片**: dao-proxy-pro 启动反代后把端口写入 `~/.dao/origin-port.json`;
  全功能面板创建时按该端口设 `portMapping`。因 `portMapping` 仅作用于顶层 webview 帧、不下沉到
  `srcdoc` 子帧, patch 另注入一段极小 fetch 转发垫片(携 CSP nonce): 子帧内 `127.0.0.1`
  反代请求 `postMessage` 给父面板代发、再以重建 `Response` 回传 → 三模块实拉实时数据。
- **降级**: 独立 dao-vsix(无 `vendor-proxy` 兄弟、反代未起)时, Proxy Pro tab 显示
  「未就绪 + 重试」空态, 不报错; dao-vsix 二合一照常工作。

## 构建 / 打包

```bash
cd core/dao-one
npm install            # ws (dao-vsix 运行期依赖) + sucrase (转译 TS)
node build.js          # 从 ../dao-vsix ../dao-proxy-pro ../rt-flow + ../../addons/dao-bridge
                       #   装配 vendor-* (gitignored), 并把 proxy-fold.patch 叠到 vendor-vsix
npx @vscode/vsce package --allow-missing-repository --skip-license
# → dao-one-2.2.2.vsix
devin-desktop --install-extension dao-one-2.2.2.vsix --force
```

- 各源**正本**仍在 `core/{dao-vsix,dao-proxy-pro,rt-flow}` 与 `addons/dao-bridge`;
  `vendor-*` 为 `build.js` 装配的构建产物(已 gitignore, 保持 PR 清爽)。**每次构建都从兄弟
  目录现拷最新源**, 故 dao-one 始终整合 dao-vsix / rt-flow / proxy-pro 的最新成果。
- `proxy-fold.patch` 是 context-aware diff(按上下文匹配、不依赖绝对行号), 抗 dao-vsix 源行号漂移。
- `gen-manifest.js`: 由各子模块 `package.json` 合并生成本目录 `package.json`
  (commands 并集 / configuration 多段并存 / 视图归一到单容器)。
  > ⚠️ `package.json` 含手工维护的贡献项, **勿跑 `gen-manifest.js` 覆盖**(会重置版本、丢失手工合并)。
