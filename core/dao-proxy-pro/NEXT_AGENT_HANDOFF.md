# dao-proxy-pro · 续作交接 (v9.9.287)

> 道法自然 · 损之又损。本文件给下一个 agent：当前进度、已打通项、仍卡的一处 bug、复现方法、续作清单。

## 〇、最新进展 (v9.9.287 · 道无名·工具描述去名)
- **根因**：官方工具描述内嵌产品名（`browser_preview`/`edit_notebook` 述 "Cascade"、`check_deploy_status` 述 "Windsurf"），随 `tools` 字段透传给真实渠道；模型把描述里的 "Cascade" 当作自我身份 → 自称 "Cascade"（纯 deepseek 无此现象，属上下文注入而非工具反噬）。
- **修复**（`vendor/外接api/core/dao_router.js`，`_callProvider` 内、`toolsField` 收尾前）：`_deOfficialName()` 在发往渠道前把工具描述里的 `Cascade`→`you`、`Windsurf`/`Codeium`→`the editor`（与道化 SP「本无名」一致，不动工具名/参数，机制不破）；并给 `_msgSummary` 增 `preview` 全息预览以验证官方身份是否仍漏入消息。
- **校验**：`node --check dao_router.js` 通过；已随本提交构建 `dao-proxy-pro-9.9.287.vsix`。
- **141 实机状态（经 DAO Bridge 实测）**：已安装扩展目录 `dao-agi.dao-proxy-pro-9.9.281` 的磁盘文件已是 286+287 级（`source.js` 与仓库一致、`dao_router.js` = 仓库+287），但**运行中的反代进程仍是旧版内存态**（`/origin/ea/overview` 的 `health` 为 null、无 `family_tier_extend`）。`dao_router.js` 改动经 `_eaHotReload` 自动生效；`source.js`（含 285 health）需 Reload Window 才生效。

## 一、当前版本与入口
- 版本：`9.9.266`（`package.json`）。已构建 `dao-proxy-pro-9.9.266.vsix`（随本提交入库）。
- 安装到真实 Devin Desktop 3.1.7：`devin-desktop.cmd --install-extension dao-proxy-pro-9.9.266.vsix --force`，再 Reload Window。
- 三模块面板入口：状态栏右下「道Agent Pro · 道」按钮（`_statusBarItem.command = "dao.eaConfig"`），或命令面板搜「热配置」。
  - 面板命令 `cmdEaConfig`（`extension.js` ~5019）以 `createWebviewPanel(ViewColumn.One)` 打开，标题「道 · 三模块面板」。
  - **注意**：IDE 刚启动、中间编辑组为空（Devin Agent 主页占位）时，首次执行命令可能不立刻显示面板；已验证「触发命令 + 切换到 Editor 视图」后面板正常显示在中列。三个 tab：①本源观照 ②渠道配置 ③模型路由。

## 二、已打通（真机验证）
1. **右侧真·Cascade 选择器解锁**：Pro 锁根因 = 每模型 protobuf `field 4 (varint=1)`（非徽标 field 33）。后端 `source.js` 在 GetUserStatus 响应里同时去 field4(解灰)+field33(去徽标)，每次去锁约 65 项。之前一片灰、只有 solo，现全目录满色可选。
2. **后端 `/origin/ea/overview` 已正确产出**（curl 实测，端口 8937）：
   - `official_families`: **49 个家族**（档位归一：`Claude Opus 4.7` 含 5 档 members、`GPT-5.4` 含 10 档…）。函数 `_getOfficialFamilies()`（`source.js` ~3875），读 `vendor/bundled-origin/_full_model_catalog.json`（108 模型）。
   - `providers`: **4 个**（`builtin-stub` 测试通道 + deepseek + anthropic + openai）。
3. **测试通道**：`builtin-stub` / `stub-transport-test`，mock 固定返回，验证通路。默认路由：`MODEL_SWE_1_6 → builtin-stub`（标准版→测试通道），`MODEL_SWE_1_6_FAST → deepseek`（→ DeepSeek，首个真实外接）。见 `vendor/外接api/core/dao_router.js`。
4. **DeepSeek 路由**：key 仅存本机 `C:\Users\Administrator\.codeium\dao-byok\配.json`（**绝不入库**），模型 `deepseek-v4-flash` / `deepseek-v4-pro`。

## 三、★ 已修复 (v9.9.266) — 三模块面板 ③模型路由 旧数据源
**根因**：之前以为是 webview 拿到旧快照/端口不符，实为**两个面板用了两套数据源**：
- 悬浮面板 `eaRender()`（状态栏切换按钮）早已走 `/origin/ea/overview` → 正确渲染 49 家族归一 + 测试通道。
- **三模块面板** `getEaConfigHtml()` 的 `loadConfig()` 却走 `/origin/ea/config` + `/origin/model_catalog`（扁平 catalog ~108），`renderLeft()` 直接平铺 modelUid/label → 这才是「扁平档位列表 + 怪名」；`renderRight()` 只遍历 `_providers`（来自 config，无 builtin-stub）→ 故无「测试通道」。

**修复**（`extension.js` `getEaConfigHtml` 内嵌脚本）：
1. `loadConfig()` 改走 `/origin/ea/overview`，与悬浮面板同源：`_families = d.official_families`、`_providers = d.providers`（首项含 `builtin-stub` 测试通道）、`_routes = d.routes`。
2. `renderLeft()` 重写为**家族归一**：按 provider 分组标题，一族一项（`data-uid`=默认成员，`data-uids`=全档位），多档显示 `×N` 折叠徽标；路由判定 `_routeFor()` 双形归一（`MODEL_X_Y ↔ x-y`）。
3. `renderRight()` 首项渲染内置「测试通道」（`_builtin`，标 `· 内置`、不可删、无需探测），其余为用户渠道。
4. `renderWires()` 按 `data-uids` 反查家族左节点，路由落在任一档位都能连线。
5. ②渠道配置补 cc-switch 风：预设下拉(`_PRESETS` 11 家)一键填表、已配渠道列表(`renderChannels`)含编辑/删除、新增「模型」输入框。

校验：`node --check extension.js` 通过；内嵌 webview JS 抽取后 `node --check` 通过。**仍需真机 Reload Window 复验**左侧 49 家族、右侧首项「测试通道」、连线/断线、预设加渠道。

## 四、续作清单（按用户最新路线图）
- [x] (v9.9.266) 修复三模块面板 ③模型路由 旧数据源 → 左侧 49 家族档位归一、修首项怪名、右侧首项「测试通道」；②渠道配置补 cc-switch 风列表+预设。
- [ ] 真机 Reload Window 复验上述渲染 + 连线/断线 + 预设加渠道（本会话无 Devin Desktop 运行环境，未能 live 验证）。
- [ ] ②渠道配置：进一步对齐 cc-switch（`github.com/farion1231/cc-switch`，已克隆 `C:\Users\Administrator\cc-switch-ref\`，预设 `src/config/universalProviderPresets.ts`），整合免费渠道冒烟测试。
- [ ] 实测·官方 Slow（用 RT-Flow 从 141 账号库切号）全工具：code / 社群 / 子代理。注意：免费测试账号官方 Slow 曾返回 501（entitlement 受限），故需切到可用账号。
- [ ] 实测·@conversation 引用（+号多级菜单）官方 & 路由 DeepSeek 双侧。
- [ ] 实测·SWE-1.6 标准→测试通道固定返回；SWE-1.6 Fast→DeepSeek 路由 + 历史引用。
- [ ] 同步：GitHub ↔ 141 `E:\DAO_ARCHIVE` 两处一致。

## 五、关键路径速查
- 前端 UI：`plugins/dao-proxy-pro/extension.js`（`eaRender` ~3134、`cmdEaConfig` ~5019、`getEaConfigHtml`）。
- 后端代理：`plugins/dao-proxy-pro/vendor/bundled-origin/source.js`（`/origin/ea/overview` ~3488、`_getOfficialFamilies` ~3875、builtin-stub 注入 ~3493、field4/33 解锁）。
- 默认路由：`plugins/dao-proxy-pro/vendor/外接api/core/dao_router.js`。
- 全量目录：`plugins/dao-proxy-pro/vendor/bundled-origin/_full_model_catalog.json`（108 模型）。
- 本机敏感数据（**不入库**）：DeepSeek key 在 `~/.codeium/dao-byok/配.json`；账号库在 141 `E:\DAO_ARCHIVE`。
