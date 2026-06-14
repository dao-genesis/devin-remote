# 道全景 · 全模块状态与推进（实测基线）

> 反者道之动，道并行而不相悖。本表是对仓库 **5 插件 + 2 模块 + 工具/启动** 的一次全方位巡检：
> 每块的入口、当前态、本轮实测结论、与续作缺口。所有「实测」均在 Devin 自身 VM 上实跑，非纸面。

## 一、巡检结论（一句话）
仓库各模块**源码层全部健康**：全部 JS `node --check` 通过、全部 Python `py_compile` 通过；
可构建模块构建可复现、有测试套件的模块全绿、独立 CLI 均可运行。深度功能验证（VSIX 在真机
Devin Desktop 内的交互）需 live IDE 环境，见各模块「缺口」。

## 二、模块矩阵

| 模块 | 入口 | 版本 | 本轮实测 | 续作缺口（需 live Devin Desktop） |
|---|---|---|---|---|
| **vm-replica**（模块） | `agent-vm/{vm_host_daemon,vm_inner_agent,mcp_server}.py` | — | **browser 本源对齐**：VM 启动 Devin 自身 Chrome 构建 + 逐字复制 flag/UA；真实 Playwright MCP(23 工具)经 CDP 驱动 navigate+snapshot 全过；33 MCP 工具；EXE 冻结链通 | 可选：per-VM noVNC 网页观看层（默认不做，避免争用 Devin 单例 UltraVNC） |
| **dao-proxy-pro**①模型路由 | `extension.js` + `vendor/bundled-origin/source.js` | 9.9.277 | **`npm test --quick` = 277 通 / 0 失**；`render_check.js` 三处 webview「RENDERED + PARSED OK」；vsix 9.9.277 与 package.json 同步 | 真机 Reload 复验三模块面板 49 家族归一/测试通道/连线；@conversation 引用双侧实测 |
| **dao-vsix**②全功能面板 | `src/extension.ts`（sucrase→`out/`） | 1.3.0 | **从源码构建可复现**：`npm i`→`node build.js` 转译 OK、`node --check out/extension.js` OK、`vsce package`→`dao-vsix-1.3.0.vsix` 成功（产物已正确 gitignore） | 真机面板 30+ API 端点 + auth1 自动换取实测 |
| **devin-git-auth**③多账号Git | `dao-git-auth-cli.js` / `extension.js` / `engine/*` | 2.3.2 | **CLI 可运行**（`--help` 列 read-status/connect-git/switch-git/full-auto）；engine 7 文件 `node --check` 全过 | 真机多 Devin 账号绑同一 GitHub 端到端 |
| **cf-daohub / dao-bridge**④内网穿透 | `dao-bridge-ext/extension.js` + `dao-bridge/{agent,core}.js` | 3.2.0 | 源码 `node --check` 全过；bridge 本会话实际承载了对 141 的隧道（活体验证） | 命名隧道固定域名（需 CF token） |
| **rt-flow**⑤Cloud备份/回归 | `extension.js` + `devin_cloud.js` + `_vscdb*.py` | 4.4.1 | 全 JS/PY 静态检查通过 | 真机多账号额度/备份/wipe 实测 |
| **rt-flow-mobile**⑥浏览器/手机版 | `src/{cloud,background,content,popup}.js` + `manifest.json`（MV3） | 1.0.0 | **源码健康**：`node test/cloud.test.js` 12/12、`node --check` 全过；**桌面 Chrome 全流程实测通过**（登录注入/自动切号/storage-first 面板，含修复 MV3 冷启竞态卡死） | 安卓 Kiwi/Edge **真机侧载验证**（本 VM 无嵌套 KVM/VT-x，跑不了加速 Android 模拟器）；可选：打 release zip + 录屏证据 |
| **dao-export**（模块） | `dao_export_all.py`（零依赖） | 1.3.3 | **CLI 可运行**（`--help` 全参数正常：email/password/accounts/token/org/filter/workers…） | 真账号全量导出冒烟 |
| tools / bootstrap | `coldstart.ps1` / `pack-vsix.js` / `render_check.js` / `fetch-cloudflared.js` | — | `render_check.js` 作为 webview 渲染守卫已用于本轮验证 | — |

## 三、本轮跨模块推进（PR 线 + 全模块线 并行）
1. **vm-replica（PR #102）**：浏览器逆流到 Devin 自身本源（同一 chrome 二进制 + 同一 flag 档 + UA），
   修复 per-browser profile 冲突致 CDP 起不来的缺陷；新增 `08_本源内观_Introspection.md`。
2. **dao-proxy-pro**：跑通测试套件 277/277；确认 webview 渲染守卫通过。
3. **dao-vsix**：补齐从源码到 VSIX 的可复现构建链（`sucrase` 转译 + `vsce package`）。
4. **devin-git-auth / dao-export**：确认独立 CLI 可运行。
5. **cf-daohub / rt-flow**：源码健康基线确认。

## 四、统一缺口（共性）
- 真机交互验证均需 **运行中的 Devin Desktop**；当前 VM 无该 GUI 运行态，故 VSIX 的「真机 Reload
  复验」类项目无法在本环境闭环——这是环境约束，非代码缺陷。
- 凡需第三方密钥/账号的实测（DeepSeek key、CF 命名隧道 token、真 Devin 账号），按既有红线
  **绝不入库**，由用户按需在本机提供。
