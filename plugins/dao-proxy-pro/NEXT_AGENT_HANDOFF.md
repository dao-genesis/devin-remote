# dao-proxy-pro · 续作交接 (v9.9.265)

> 道法自然 · 损之又损。本文件给下一个 agent：当前进度、已打通项、仍卡的一处 bug、复现方法、续作清单。

## 一、当前版本与入口
- 版本：`9.9.265`（`package.json`）。已构建 `dao-proxy-pro-9.9.265.vsix`（随本提交入库）。
- 已安装到真实 Devin Desktop 3.1.7：`C:\Users\Administrator\.devin\extensions\dao-agi.dao-proxy-pro-9.9.265\`。
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

## 三、★ 仍卡的一处 bug（下一个 agent 首要处理）
**现象**：③模型路由 面板左侧仍显示「扁平档位列表」（Claude Opus 4.7 Medium / Low / High / XHigh / Max 各成一项、GPT-5.4 各 Thinking 档分列，前两项显示截断怪名 `MODE.../MO...`），右侧只有 3 个外接 provider（deepseek/anthropic/openai），**未见 49 家族归一、未见「测试通道」**。

**已排除**：
- 后端正确：`curl http://127.0.0.1:8937/origin/ea/overview` 返回 `official_families` 49 + `providers` 4（含 builtin-stub）。
- 前端代码正确：`extension.js` `eaRender()` ~3156 `var _fams = d.official_families||[]; if(_fams.length>0){…按家族渲染…}`，否则回退 seen_models（~3196）。安装目录的 `extension.js` 确含该分支。
- `fJson` 已 `cache:'no-store'`；只有一个服务进程（8937，PID=Devin node utility 内进程）。
- 执行过「Developer: Reload Webviews」后**仍是旧扁平数据** → 说明 webview 拿到的 `_eaData` 里 `official_families` 为空 / `providers` 只有 3 个，与 curl 不一致。

**结论/下一步假设**：webview 实际 fetch 到的 overview 与 curl 不同（疑似 webview 内 `_BASE` 端口、portMapping、或 webview 资源缓存导致拿到旧快照）。建议：
1. 用「Help → Toggle Developer Tools」，在 webview 的 frame context 里 `console.log(_BASE)` 与 `fetch(_BASE+'/origin/ea/overview').then(r=>r.json()).then(d=>console.log(d.official_families?.length, Object.keys(d.providers||{})))`，确认 webview 实际命中的端口与返回。
2. 若端口不符：核对 `cmdEaConfig` 里 `getEaConfigHtml(_cachedPort,N)` 与 `_BASE` 注入、`portMapping`。`_cachedPort` 可能因 EACCES 回退改过（`source.js` ~585），而 webview HTML 烧入的是旧端口。
3. **最稳妥**：直接「Developer: Reload Window」整窗重启（扩展宿主+服务+webview 全新），再开面板核验左侧是否变 49 家族、右侧首项是否出现「测试通道」。本会话因键入丢首字符多次未成功执行 Reload Window，下个 agent 重试即可。
4. 另：前端当前把 `builtin-stub` 从 provider 列表里跳过了（②渠道配置不可编辑它，合理），但 ③模型路由右侧应当展示「测试通道」作为首个外接项 —— 需确认 render 是否对 routing 右侧也误跳过。

## 四、续作清单（按用户最新路线图）
- [ ] 修复上述 webview 旧数据问题 → 左侧 49 家族档位归一、修首项怪名、右侧首项「测试通道」。
- [ ] ②渠道配置：对齐 cc-switch（`github.com/farion1231/cc-switch`，已克隆 `C:\Users\Administrator\cc-switch-ref\`，预设 `src/config/universalProviderPresets.ts`），整合免费渠道冒烟测试。
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
