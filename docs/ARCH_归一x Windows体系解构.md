# 归一插件 × Windows 体系 · 底层架构全解构

> 反者道之动。本文从根本底层说清：当前项目实际是什么、归一插件与 Windows 体系怎么搭配、
> 能实现/不能实现什么、各插件怎么整合、Windows Agent 的几种接入模式（Cascade 原生 /
> 外接 API / Devin Cloud / 第三方 MCP）、接入后能操作什么、用户怎么用。以仓库现有代码为准。

---

## 0. 一句话本源

- **dao-vsix = 二合一**（rt-flow 切号 + Devin Cloud 全功能面板 + 本地 HTTP API）—— 本源主体。
- **dao-one = 三合一** = dao-vsix + **Proxy Pro**（提示词隔离 + 外接模型路由）。**没有四合一/五合一**。
- **Windows 体系（`cloud/vm-replica`）不是第四个插件**，它是一套**操作执行层**：把宿主机上
  「另一个 Windows 账号的 RDP 会话当成一台虚拟机」全权操作（截图/鼠键/shell/文件/浏览器），
  并**两条路**接进归一插件：① 作为 **MCP 工具集**给任意 AI 调；② 在归一 `/shell` 里以
  **复制品桌面同级标签** GUI 呈现。

---

## 1. 归一插件与 Windows 体系怎么搭配

```
┌─────────────────────────── 归一插件 dao-one（一个 webview / 一张网页）────────────────────────────┐
│  左栏 rt-flow 切号                中栏 单一全功能面板 = /shell 统一外壳（浏览器套浏览器·带标签栏） │
│                                                                                                  │
│   标签条（peer tabs · 各自一张 iframe 子网页 · 平级并排 · 互不串号）：                            │
│   [🏠主页] [🔀切号] [🌐公网穿透] [💬对话备份] [💉反向注入] [🧩MCP] [🐙GitHub] [🔀ProxyPro]        │
│   [🪟Windows 总控]  ← Windows 体系的“控制面板”板块                                                │
│   [🖥 vm01·复制品桌面] [🖥 vm02·复制品桌面] …  ← 每个隔离 Windows 会话 = 一张同级标签             │
│                                                                                                  │
│   vmdesk:<vm> 标签经 rdp-web 网关(9040) 实时渲染那台会话的 Windows 桌面（网页里的活桌面）        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ 归一插件所有板块和复制品桌面都是同一张 /shell 网页里的平级标签（网页套网页）
        │ IDE webview 能开的，外部浏览器 / 经 dao-bridge 隧道的公网用户打开 /shell 一样能开
        ▼
┌──────────────────────── Windows 体系 cloud/vm-replica（三层·操作执行层）─────────────────────────┐
│  mcp_server.py     把 33 个 vm_* 工具暴露为 MCP（给任意 MCP agent 用）                            │
│       │ HTTP+Bearer 127.0.0.1:9000                                                               │
│  vm_host_daemon.py 宿主守护：vm.create/attach/destroy/list + 自动 provision C:\daoshare          │
│       │ HTTP+Bearer 127.0.0.1:900N（每个 VM 一个端口）                                            │
│  vm_inner_agent.py 跑在每个账号 RDP 会话内：exec/launch/screenshot/click/type/key/drag/file_*    │
│  rdp-web/gateway.js  WebSocket↔RDP 桥，把桌面位图推进网页标签（9040）                             │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**搭配的本质**：归一插件是「大脑 + 门户 + 多账号治理」，Windows 体系是「手脚 + 隔离桌面」。
两者通过 `/shell` 的同级标签（GUI 面）和 MCP/HTTP（程序面）缝合成一个界面里的一切。

---

## 2. 目前能实现哪些功能

### 归一插件本体（dao-one，已实测全通）
- **云端 Devin 直连本地电脑**：经 dao-bridge 零配置内网穿透，云端 Devin 读写本机文件/终端/仓库。
- **单账号全功能面板**：额度/Knowledge/Playbook/Secret/环境蓝图/MCP/自动化，与官网双向同步。
- **多账号 RT Flow 切号 + 反向注入**：批量把 K/Playbook/Secret/MCP/自动化注入所有账号（32/32 实测）。
- **Proxy Pro 三面板**：本源观照（帛书 SP 注入）/ 渠道配置（第三方 base URL·key·模型）/ 模型路由。
- **多实例**：浏览器多实例（每号独立 profile+CDP，注入 auth 自动登录）；IDE 内路由多实例（反代 app.devin.ai 按号路由）。
- **/shell 网页套网页**：六大板块各一张独立子网页，公网多用户按 sid 会话隔离（道并行而不相悖）。

### Windows 体系（vm-replica，本次已端到端实测 4/4）
- **复制品桌面 = 隔离 Windows 会话**：不同 Windows 账号 → 身份/桌面/键鼠/焦点/窗口**完全隔离**。
- **归一面板同级标签打开桌面**：`vmdesk:<vm>` 标签在同一张 /shell 里实时渲染，切标签保活。
- **同一第三方软件双身份并行**：administrator(console)+vm01(RDP) 各跑一份 Notepad++，键入互不串台。
- **底层数据共享 `C:\daoshare`**：本次新增自动 provision + 授权，双向读写、各自身份 —— 鸡犬相闻。
- **operate 工具面**：exec/launch/screenshot/click/type/key/drag/scroll/file_*/ui_tree/activate；
  浏览器 CDP 自动化（vm.browser_* 或直接挂真实 Playwright MCP）；**预测编码操作层**（observe/find/act，
  预测先行·本地校验·反射重试，远超盲截图+点击）；profile 快照/回滚。

---

## 3. 哪些是原有归一插件实现不了、由 Windows 体系补上的

| 需求 | 归一插件本体 | Windows 体系补上 |
|---|---|---|
| 在**同一台机器**上让**多个第三方软件实例**分离/隔离操作 | ❌ 单 Windows 账号是官方硬限制 | ✅ 多 RDP 会话/多账号 + `ts_multifix` 内存级多会话补丁破限 |
| 一个 AI 操作**另一个完全隔离的 Windows 身份/桌面** | ❌ 只操作“当前这台电脑” | ✅ 复制品桌面：独立 username/desktop/输入 |
| 隔离的同时**底层数据共享** | ❌ 无此概念 | ✅ `C:\daoshare` 自动 provision，双向共享 |
| 把隔离桌面放进**同一张归一网页**当同级标签操作 | ❌ 面板只有六大板块 | ✅ `/shell` + rdp-web，`vmdesk:<vm>` 平级标签 |
| 无 Python/无 Node 的**任意 Windows 一键注入** | — | ✅ `build_exe.py` 冻结 inner/host/mcp 三层为单文件 EXE |

> 一句话：归一插件操作的是「**这一台**电脑 / 浏览器 / Devin 对话」；Windows 体系让它能操作
> 「**任意多台隔离的 Windows 身份**，且数据互通」，这是原有归一面板做不到、被本体系补齐的核心增量。

---

## 4. Windows Agent 的几种接入模式（你问的重点）

Windows 操作能力有**一个统一执行层**（vm_inner_agent 的 exec/输入/截图/文件/浏览器），
上面挂**四种接入方式**，让不同来源的 AI 都能驱动它：

### 模式 A · Cascade 原生（Windsurf/Cursor 里的原生 AI）
- **走的是 Proxy Pro 那一套，不是另造体系。** Proxy Pro 把官方语言服务器（**Cascade LSP**）
  重定向到本地外置端点（`8889..8988` per-user），在**提示词工具层做隔离替换**：帛书 System Prompt
  注入 + 身份锚中性化（不再强令 respond with `Cascade`）+ 外接第三方模型路由。
- 对 AI 而言它**仍是原生 Cascade**（原生工具层照常），但底层请求被反代接管、提示词被隔离替换、
  模型可路由到第三方。**Windows 操作**则以工具形式并列进它的工具层（经 MCP/本地端点），
  与官方原生工具并排 —— 即你说的「做成与官方并列的工具层 + 提示词层隔离替换」。✅ 你的理解正确。

### 模式 B · 外接 API（第三方模型直连）
- Proxy Pro「渠道配置 + 模型路由」：配置第三方 provider 的 base URL/key/模型，家族级路由、
  实证探活、真实渠道直连。任何走 OpenAI 兼容 API 的客户端都能接进来，再叠加 Windows 工具面。

### 模式 C · Devin Cloud（像我这样的云端全栈 Agent）编排
- **不是 MCP，是「内网穿透 + 同源反代 + 反向注入」这条原生链路**：
  - dao-vsix 经 `rt-flow/devin_cloud.js` 封装 Devin 全部官方 API；`/shell` 同源反代直出 Devin SPA，
    按 `dao_acct` 钉号注入 auth1，多号并行不串。
  - **dao-bridge** 零配置内网穿透把**整机** `/api/*`（pc_*/browser_*/plugin_*/vscode_* 共 65 工具）
    暴露到公网，云端 Devin 直连本地电脑操作整机（对等你操作自己电脑）。
  - Windows 复制品桌面对云端 Devin 也可见：既能在 /shell 标签里看活桌面，也能经 vm_* 工具/HTTP 驱动。

### 模式 D · 第三方任意 Agent（Claude / Cursor / 任何 MCP 客户端）
- **走 MCP**。`cloud/vm-replica/mcp_server.py` 把 33 个 `vm_*` 工具做成 stdio JSON-RPC MCP server，
  与 Devin 自身 computer 工具对齐；把它挂到任意 MCP 客户端即可用全套 Windows 操作。
- 另外 DAO Bridge 也提供整机 65 工具的 MCP 镜像（四模块 pc_/browser_/plugin_/vscode_），经隧道直达。

> 归纳你的两类：
> - **原生体系（Cascade + 外接 API）** → 靠 **Proxy Pro** 反代接管提示词/模型 + 工具层并列。
> - **非原生第三方/云端 AI（Devin Cloud / Claude 等）** → 靠 **MCP**（vm_* / 整机 65 工具）
>   和 **dao-bridge 内网穿透 + 同源反代**（Devin Cloud 专用编排）。

---

## 5. 接入后能操作什么？能互不干扰吗？在 IDE 内还是整页？

- **能操作的整机能力**：鼠标/键盘/截屏/执行命令/读写文件/剪贴板/UI 控件树/激活窗口 +
  浏览器 CDP 全套自动化 + IDE 命令/诊断/定义/引用/符号 + git/终端/热修（依模式取子集）。
- **互不干扰**：✅ 已实测。隔离靠**不同 Windows 账号的独立 RDP 会话**（身份/桌面/键鼠/焦点各自独立），
  数据靠 `C:\daoshare` 共享。一个会话里打字/点鼠标绝不污染另一个会话（本次录屏验证）。
- **在 IDE 内做“外面”的操作**：✅ 就在归一插件那**一个 webview 的一张网页**里 —— 复制品桌面是
  /shell 的**同级标签**，你在 IDE 内即可看到并操作另一个 Windows 会话里的第三方软件，无需另开 IDE 窗口、
  无需多开网页。**一个界面实现一切**，正是二合一/归一插件的本源。

---

## 6. 能像 Devin Cloud 全栈工程师一样吗？

**能达到“操作层对等”，但“大脑”取决于接入的 AI。**
- Windows 体系提供的是**与 Devin 自身 computer 工具对齐的执行层**（截图+鼠键+shell+文件+浏览器+
  预测编码操作层），所以任何接入的 AI 都能像 Devin 一样**看屏、动手、跑命令、写文件、开浏览器**。
- 但**自主规划/长程任务编排的“大脑”**来自你接入的模型/Agent：接 Devin Cloud（模式 C）就得到
  Devin 的全栈规划能力 + 本地整机操作；接 Cascade/第三方（模式 A/B）则是那些模型的能力 + Windows 工具面。
- 因此：**归一插件 + Windows 体系 = 给任意 AI 装上「本地 + 多隔离 Windows 身份」的手脚**；
  是否“全栈工程师级”，等于「接入的 AI 智力 × 本执行层的操作广度」。执行层这一侧已具备全栈所需的操作面。

---

## 7. 成果进度（截至本次）

- dao-one 2.26.11 · PR #238（daoshare 自动 provision + 归一面板复制品桌面共享目录行）**CI 全绿、已被 dao-auto 自动合并入 main**。
- 归一面板 GUI 端到端实测 **4/4 通过**（录屏+测试报告已交付）：共享目录展示 / vm01 同级标签 /
  同一第三方软件双身份并行·数据共享·操作隔离 / 标签切换保活。
- **已上报的限制**：≥3 会话真并行受 Server 2022 无 RDS 角色的并发门禁（vm02 网关连流 1097 帧但第三并发会话未建立，
  装 RDS 需重启，未经确认不做）；RDP web 通道快速键入偶发丢字符（mstsc.js 输入节流，建议后续单修）。
- 其余模块实测状态见 `README.md` 第④节（dao-vsix / dao-bridge / proxy-pro / rt-flow / rt-flow-app 均 ✅）。

---

## 8. 用户之后怎么用（最短路径）

1. 冷启动一键装 dao-one（`cloud/coldstart/coldstart.ps1`），得到归一插件（左切号 + 中 /shell 全功能面板）。
2. 面板 ☰ → 🪟 Windows 总控 → 复制品桌面卡片：看到 `C:\daoshare` 共享目录、宿主守护状态、各 VM。
3. 点「打开桌面」→ 该 Windows 会话以**同级标签**在同一网页里活起来，直接操作里面的第三方软件。
4. 需要 AI 驱动：
   - 云端 Devin → 已经过 dao-bridge 隧道直连整机，或调 vm_* / 65 工具；
   - Windsurf/Cursor 原生 Cascade → Proxy Pro 接管提示词/模型 + Windows 工具层并列；
   - 任意第三方 Agent → 挂 `mcp_server.py`（33 个 vm_* 工具）即可。
5. 多身份并行：`vm.create vm02/vm03…`，各自独立桌面、共享 `C:\daoshare`，在 /shell 里各占一张标签。

---

## 9. 核心本源修正 · 同账号「复制品」而非新建分身（方向性）

> 这是最重要的一条，需继续大功夫突破。

### 现状 vs 真需求
- **现状（当前代码）**：`vm_host_daemon.create_vm()` 用 `New-LocalUser` 建**独立新账号**（vm01/vm02，独立 SID/独立 profile）。
  数据不通，才需要 `C:\daoshare` 作旁路共享 —— 这正是你说「分身账号数据难适配、很麻烦」要**规避**的。
- **真需求**：对用户**同一个 Windows 账号**做**复制品** —— 同账号 → profile/数据/HKCU **天然共享**（鸡犬相闻），
  但每个复制品是**独立的交互式会话/桌面**（GUI/键鼠/焦点隔离），且**同一第三方软件能在每个复制品里各跑独立实例**。

### 那个「单实例」bug 的根因（必须说清）
- Windows 默认 `fSingleSessionPerUser=1`：**同账号第二次连接会「重连到已存在的那个会话」**，而不是开出第二个桌面。
  所以桌面 B 点图标，其实操作的就是桌面 A 那个**同一个会话里的同一个实例** —— 这不是软件的 bug，是「同账号=同会话」导致的必然。
- 破法：`fSingleSessionPerUser=0` + 多会话使能 → **同一 username 拿到两个真正不同的会话**（session N/M）。
  每个会话有独立的对象命名空间 `Session\N\BaseNamedObjects` → **会话级单实例**（多数第三方软件用 `Local\` mutex 或
  会话内 `FindWindow`）在每个复制品里**各自独立运行**，互不调前台。
- 残余硬骨头：少数软件用**机器级 `Global\` mutex**（跨会话仍全机唯一）→ 仍单实例。这类需逐个专治（沙箱/改命名空间/软件自带多开开关），
  是「在实践中暴露、持续解决」的部分。

### 会话隔离但数据共享 = 正是同账号多会话的天然属性
同一用户的多个并发会话**共享同一份 profile**（`C:\Users\<user>`、HKCU 单份加载）→ 文件/配置/登录态天然互通（数据共享），
而桌面/输入/焦点各自独立（操作隔离）。**这正好 1:1 命中你的模型**，无需再为新账号重适配数据。

### 落地路径（分平台）
| 目标机 | 同账号多会话怎么开 | 是否需重启 |
|---|---|---|
| 用户自己的 **Win10/11 客户端** | `ts_multifix` 内存级补丁（不碰磁盘 ServiceDll）+ `fSingleSessionPerUser=0` | **免重启** |
| **Windows Server**（如本测试机 2022） | 内存补丁被授权路径回同步吊销 → 需 **RD Session Host 角色** | 装角色需 **1 次重启** |

### 代码要做的改造（下一步）
1. `create_vm` 增加 **replica-of-self 模式**：`{"replica_of":"<当前用户>"}` 时**不建新账号**，直接用同 username（同 profile）
   + 置 `fSingleSessionPerUser=0` + `ensure_multisession()`，环回 RDP 开出该用户的第二/第三个会话。
2. 归一面板「复制品桌面」卡片按此语义呈现：默认就是「当前账号的复制品」，`C:\daoshare` 降级为可选增强而非必需。
3. 每张 `vmdesk:<n>` 标签 = 同账号的一个复制品会话，像原生 RDP 窗口一样嵌在 /shell 里 1:1 操作。
4. 实测：同账号两会话并行跑**同一个第三方软件**，验证各自独立实例（`Local\` 类）+ 标记出 `Global\` 类的残余清单。

*道法自然 · 无为而无不为。*
