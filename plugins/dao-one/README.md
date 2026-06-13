# 道 · 归一 (dao-one)

> 帛书《老子》四十二:「道生一,一生二,二生三,三生萬物。」
> 反之 — **三归一**: 把 dao-vsix、dao-proxy-pro、rt-flow 一次性整合为**单一插件本体**。
> 大道至简 · 用户无感无为: 装一个 VSIX、活动栏一个「道」图标、下挂三折叠板块。

## 三板块(单一活动栏图标「道 · 归一」)

| 板块 | 源 | 能力 |
|---|---|---|
| ① 面板 · Devin | dao-vsix 1.3.3 | 全功能面板 Sessions/Knowledge/Playbook/Secret + 本地 HTTP API + 路由官网自动登录 + 内嵌 Git/穿透 + 启动注入帛书规则 |
| ② 路由 · 本源观照 | dao-proxy-pro 9.9.286 | 底层提示词隔离替换 + 外接第三方模型路由进 Cascade(cc-switch 加渠道·连线路由·实证探活) |
| ③ Cloud · 备份/账号 | rt-flow 4.6.2 | Devin Cloud 多账号实时额度/轮转 + 一键批量备份/全量快照 + 一键回归本源(wipe) + 对话额度上限 |

## 整合逻辑(最优质 · 零损耗)

VS Code 的视图归属由 `package.json` 的 `views` 映射决定,而非代码。三子模块各自注册的
WebviewViewProvider 视图 id(`dao.cloudPanel` / `dao.essence` / `wam.panel`)在归一
`package.json` 里统一挂到同一容器 `dao-one` 下,即呈现为单图标三板块。入口 `extension.js`
仅 `require` 三子模块、用各自子目录隔离的 `context`(`subContext`)依次 `activate`,
既**完整保留**它们已 live 验证的全部逻辑,又呈现为**单一插件**。一条子模块失败不毁全局。

## 构建 / 打包

```bash
npm install            # ws (dao-vsix 运行期依赖) + sucrase (转译 TS)
node build.js          # 从 ../dao-vsix ../dao-proxy-pro ../rt-flow 组装 vendor-*
npx @vscode/vsce package --allow-missing-repository --skip-license
# → dao-one-1.0.0.vsix
devin-desktop --install-extension dao-one-1.0.0.vsix --force
```

- 三子模块**正本**仍在 `plugins/{dao-vsix,dao-proxy-pro,rt-flow}`;`vendor-*` 为
  `build.js` 装配的构建产物(已 gitignore,保持 PR 清爽,符合 dao-vsix `out/` 既有惯例)。
- `gen-manifest.js`: 由三子模块 `package.json` 合并生成本目录 `package.json`
  (commands 并集 / configuration 三段并存 / 视图归一到单容器)。
