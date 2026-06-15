# 外接 MCP 工具模块（按需拉取 · 非入库）

> 去芜存菁：上游 MCP server 体量大且属第三方源码，**不再 vendored 进本仓**，改为按需在固定 commit 拉取。
> 道法自然——「拿来」而非「复刻」，但也不必把别人的全仓常驻本仓。

| 模块 | 来源 | 版本 / commit | 用途 |
|---|---|---|---|
| playwright-mcp | https://github.com/microsoft/playwright-mcp | v0.0.76 · `b301c372ec741289eff1cf6aab9d3bec553f31e2` | 浏览器工具面本源实现，原生 `--cdp-endpoint` 接已开 remote-debugging 的浏览器 |
| mcp-servers | https://github.com/modelcontextprotocol/servers | `275175cda17ca9c49920ceed2bcf27e12e59f8b2` | filesystem / git / fetch / memory / time / sequentialthinking / everything 官方实现 |

## 按需拉取（在本目录下执行）

```powershell
# playwright-mcp（固定 commit）
git clone --filter=blob:none https://github.com/microsoft/playwright-mcp.git
(cd playwright-mcp; git checkout b301c372ec741289eff1cf6aab9d3bec553f31e2; Remove-Item -Recurse -Force .git)

# mcp-servers（固定 commit）
git clone --filter=blob:none https://github.com/modelcontextprotocol/servers.git mcp-servers
(cd mcp-servers; git checkout 275175cda17ca9c49920ceed2bcf27e12e59f8b2; Remove-Item -Recurse -Force .git)
```

拉取的 `playwright-mcp/`、`mcp-servers/` 已在 `.gitignore` 忽略，不入库。

## 用法（把 Playwright MCP 接到某台 VM 的浏览器）

```powershell
# 1) 在 VM 会话内开浏览器并暴露 CDP（经 host daemon → inner agent）
#    inner agent 的 browser_launch 会返回 {port: <DEBUG_PORT>}
# 2) 起真实 Playwright MCP，指向该 VM 的 CDP 端点
cd cloud/vm-replica/vendor/playwright-mcp
npm install
npm run build
node cli.js --cdp-endpoint http://127.0.0.1:<DEBUG_PORT>
#  或免安装直接用发布版： npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<DEBUG_PORT>
```

零 Node 环境（纯 EXE 注入）下，用 `vm_inner_agent` 自带的零依赖 `vm_browser_*` 工具兜底。
