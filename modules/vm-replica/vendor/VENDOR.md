# Vendored MCP tool modules（直接复制 · 非复刻）

把真实的上游 MCP server 整包复制进来，让 agent 用**真实的工具实现**操作 VM 内浏览器/文件/Git，
而不是手写重造（复刻）。源码逐字拷贝、仅去除 `.git`。

| 模块 | 来源 | 版本 / commit |
|---|---|---|
| playwright-mcp | https://github.com/microsoft/playwright-mcp | v0.0.76 · b301c372ec741289eff1cf6aab9d3bec553f31e2 |
| mcp-servers | https://github.com/modelcontextprotocol/servers | 275175cda17ca9c49920ceed2bcf27e12e59f8b2（filesystem/git/fetch/memory/time/sequentialthinking/everything） |

## 为何「拿来」而非「复刻」

- **playwright-mcp** = 浏览器工具面的本源实现。它原生支持 `--cdp-endpoint`（env `PLAYWRIGHT_MCP_CDP_ENDPOINT`），
  可直接连到一个已开 remote-debugging 的浏览器。我们的 `vm_inner_agent.browser_launch` 正是在 VM 会话内
  以 `--remote-debugging-port=<DEBUG_PORT>` 起 Chrome/Edge 并暴露 CDP 端点——两者一拍即合：
  agent 直接拿到 Playwright 全套真实工具（navigate/click/snapshot/fill/...）来操作 VM 浏览器。
- **mcp-servers** = filesystem / git / fetch 等对位 Devin 的 read/write/edit/grep、git、web_get 工具面的官方实现。

## 用法（把 Playwright MCP 接到某台 VM 的浏览器）

```powershell
# 1) 在 VM 会话内开浏览器并暴露 CDP（经 host daemon → inner agent）
#    inner agent 的 browser_launch 会返回 {port: <DEBUG_PORT>}
# 2) 起真实 Playwright MCP，指向该 VM 的 CDP 端点
cd modules/vm-replica/vendor/playwright-mcp
npm install            # 首次：装依赖
npm run build          # 产出 lib/（gitignore，不入库）
node cli.js --cdp-endpoint http://127.0.0.1:<DEBUG_PORT>
#  或免安装直接用发布版： npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<DEBUG_PORT>
```

零 Node 环境（纯 EXE 注入）下，用 `vm_inner_agent` 自带的零依赖 `vm_browser_*` 工具兜底。
