# dao-bridge（内网穿透）底层架构分析与彻底优化方案

> 范围：`addons/dao-bridge/`（独立插件本体）+ `core/dao-one` 内联的 `vendor-bridge` + `tools/fetch-cloudflared.js`。
> 目标：从根本底层剖析当前架构、核心实现与核心缺陷；针对（1）cloudflared 自动安装中断、（2）用户认证/配置成本、（3）跨平台适配 三大诉求给出反向突破方案。

---

## 0. 一句话结论

dao-bridge 实际上**并存两套互不相通的穿透实现**，而插件真正在跑的那一套（cloudflared 隧道）恰恰是成本最高、最脆弱的一套；而仓库里已经写好、几乎零成本、URL 稳定的另一套（`*.workers.dev` Worker+DurableObject 反向中继）却被晾在 `agent.js`/`core.js` 里没有接进插件。**最大的优化不是修 cloudflared，而是把默认通道切到 Worker 中继**——它一举同时解决「自动安装中断」「认证成本」「跨平台」三个问题。

---

## 1. 核心架构全貌

### 1.1 两套并存、彼此割裂的传输实现

| | 实现 A：cloudflared 隧道 | 实现 B：Worker + DO 反向中继 |
|---|---|---|
| 代码 | `dao-bridge-ext/extension.js`（1283 行，VS Code 插件） | `agent.js` + `core.js`（纯 Node，无 VSCode 依赖） |
| 传输 | 本机起 cloudflared 子进程 → trycloudflare / 命名隧道 | 本机出站 WSS 连 `dao-relay-do.<sub>.workers.dev` |
| 公网地址 | quick：每次重启变；named：固定但需自有域名 | `…workers.dev/relay/<session>`，**天然固定** |
| 外部依赖 | 需 ~50MB cloudflared 二进制（下载/内置） | 仅需 npm 包 `ws`（几十 KB） |
| 账号成本 | quick 无；named 需 CF 账号+域名+令牌 | **零账号** |
| 现状 | 插件激活默认跑这套 | 仅命令行 `start.ps1` 手动跑，未接入插件 UI |
| 端点差异 | `/api/exec` `/api/exec-sync` `/api/agents` … | `/api/exec` `/api/command` `/api/file` …（端点集不一致） |

> 这是架构层第一缺陷：**同一能力两份实现、端点不一致、各自演进**，维护面翻倍，且把脆弱的一套设成了默认。

### 1.2 实现 A（插件主线）数据流

```
VS Code 激活 (onStartupFinished)
   └─ Bridge.start()
        ├─ findCloudflared()            定位真二进制（排除 npm/choco shim）
        ├─ downloadCloudflared()        缺失则多镜像下载到 ~/.dao/bin
        ├─ WorkspaceServer.start()      本机 127.0.0.1:<port> 起 HTTP API（30+ 端点）
        └─ 回退链逐档 spawn cloudflared：
             ① named/http2 → ② quick/http2 → ③ named/quic → ④ quick/quic
             任一档「边缘连接真正注册」即成功；全失败才报错
   产物：~/.dao/bridge/{conn.json, workspace.md, local-agent-access.md}
        + ~/.dao/cf-hub-conn.json（全局）
```

本机 HTTP API（`WorkspaceServer`，`extension.js:343` 起）：

- 免鉴权：`GET /api/health`（泄露 host / platform / workspace / uptime）。
- 需 `Bearer <token>`：`/api/exec` `/api/exec-sync`（**任意命令、不限工作区**）、`/api/ls` `/api/read` `/api/write`（受 `withinRoot` 沙箱）、`/api/config`、`/api/bridge/restart`、`/api/account/logout`、`/api/self/reload`（重载窗口热加载新 extension.js）等。
- token = 16 字节随机（128 bit），存 `~/.dao/bridge/conn.json`，并**写进可分享的 MD 文档**。

### 1.3 回退链设计（这部分是亮点）

`Bridge.start()` / `_runAttempt()`（`extension.js:599`、`:647`）的设计是合理的：

- http2 优先、quic 兜底（国内/GFW 多封 UDP/7844，方向正确）；
- 以日志中「边缘连接真正注册」(`Registered tunnel connection`) 为唯一成功判据，而非只看打印出的 URL（避免「假成功」）；
- 硬失败正则即时放弃当前档，不空等超时；
- 命名隧道打不通自动回退快速隧道，绝不卡死。

代理自适应（`detectProxy` / `probeLocalProxy` / `spawnEnv`）也考虑周到：显式配置 → 环境变量 → 探测 7890/7897/10809 等常见 clash/v2ray 端口，并在给 cloudflared 注入代理前清空 `NO_PROXY=*`（这是 relay agent 会污染的坑）。

> 结论：**A 的「连上之后」的健壮性不错，问题全部集中在「拿到一个能用的 cloudflared」这一步之前，以及「账号/域名」这一步。**

---

## 2. 缺陷一：cloudflared 自动安装中断 → 整体瘫痪（用户首要痛点）

用户描述：cloudflared 自动安装中途突然中断，半成品文件导致插件彻底用不了、也不继续下载。**这是真实存在的、可复现的根因链**，有四个叠加问题：

### 2.1 【根因】只有 1MB 体积下限，没有任何完整性校验

- `isRealCloudflared()`（`extension.js:96`）判定「真二进制」的唯一硬指标是 `st.size >= 1MB` + Windows 须 `.exe`。
- `downloadCloudflared()`（`:222`）复用已存在文件的条件也只是 `size > 1MB`（`:225`）。
- `httpDownload()`（`:161`）下载完成校验也只是 `size < 1MB → 失败`（`:179`）。

cloudflared 真二进制约 **50MB**。只要一次下载在 **>1MB 但未完成** 时连接被「干净地」关闭（FIN，常见于代理/GFW 抖动），写流会触发 `finish`，体积校验（>1MB）通过，于是**一个被截断的损坏二进制被 rename 成正式文件**。

README 里宣称的「分段落地 + 完整性校验」并不存在——代码里既无 `sha256`、也无 `--version` 探活（已 `grep` 确认仓库零处校验）。

### 2.2 【根因】损坏文件落地后永久卡死、不自愈、不重下

- 下次激活：`findCloudflared()` 命中这个损坏文件（体积过关）→ 直接返回，**`downloadCloudflared()` 根本不会被调用**（`:613-614` 仅在 `!bin` 时下载）。
- 即便走到下载：`downloadCloudflared()` 又因「文件已存在且 >1MB」早退（`:225`），同样不重下。
- 于是：cloudflared 子进程一启动就崩/秒退 → 隧道永远失败 → 用户重装插件、重启 IDE 都没用（损坏文件在 `~/.dao/bin`，不随插件走）。**完全吻合用户描述的「以半成品为基础、整体用不了、也不继续下载」。**

### 2.3 自动安装本身不具断点续传

`httpDownload` 每个镜像都是 `Range:0-` 从头拉整包，任一中断就整包作废换下一个镜像。在慢速/受限网络上，50MB 整包「一次性成功」的概率本就低，反复从零重试很容易次次中断。

### 2.4 「插件自带、离线即用」其实从未生效（致命的次生根因）

这是把上面所有问题放大的总开关：

- 运行时在 `ctx.extensionPath/bin/cloudflared(.exe)` 找内置二进制（`extension.js:112`）；
- 但 `tools/fetch-cloudflared.js:18` 把二进制写到 **`plugins/dao-bridge/dao-bridge-ext/bin`**——这个 `plugins/` 目录在仓库重构成 `addons/` 后**已不存在**（已确认）。
- `core/dao-one/build.js` 的 `buildBridge()` 也只在 `addons/.../bin` 存在时才拷 `bin/`（`:127`）——而它永远不存在。

结果：发版 VSIX 里根本没带 cloudflared，**每一次安装都被迫走 §2.1–2.3 那条脆弱的运行时下载**。所谓「自包含离线 VSIX」是文档与代码路径脱节造成的空头支票。

### 2.5 修复方案（按性价比排序）

1. **【治本·首选】默认通道切到 Worker 中继**（见 §4），cloudflared 整条链路降级为可选项，§2 的下载脆弱性对绝大多数用户直接消失。
2. **加完整性校验 + 自愈**（若保留 cloudflared）：
   - 下载后用 Cloudflare 发布的 `sha256` 校验，或至少 `spawn(bin, ["--version"])` 探活通过才算数；
   - `findCloudflared` 命中文件后做一次轻量 `--version` 探活，**失败即删除并重下**；
   - `downloadCloudflared` 复用前同样探活，不再只看体积。
3. **断点续传**：带 `Range` 续传 `.part` 文件，按 `Content-Length` 校验总长，长度不符即判失败删除。
4. **修 `fetch-cloudflared.js` 路径**：`plugins/` → `addons/`，让 bundled VSIX 真正带二进制；并在 `dao-one` 发版流程里强制校验 `vendor-bridge/bin` 存在。
5. **`.part` 命名去随机化 + 启动清理**：启动时清掉 `~/.dao/bin/*.part*` 残留，避免磁盘碎片堆积。

---

## 3. 缺陷二：认证/配置成本过高（用户第二诉求）

### 3.1 现状三档与各自的成本

| 档位 | 用户要做什么 | 公网地址 | 痛点 |
|---|---|---|---|
| 快速隧道（默认） | 什么都不做 | trycloudflare，**每次重启就变** | URL 不稳定、trycloudflare 限速/可被墙、不可预先写进文档 |
| 命名隧道 | 注册 CF 账号 + **自有域名** + Zero Trust 建隧道 + 复制 token | 固定 `xxx.yourdomain.com` | 步骤极多、必须有域名，普通用户门槛极高 |
| 浏览器登录 | `cloudflared tunnel login` 走浏览器（可用 GitHub 登 CF） | —（仍需自有域名才有固定名） | 只对「已有 CF 域名」用户有意义，域名党之外无收益 |

`loginCloudFlare()`（`extension.js:711`）能识别 API Token / Global Key / 命名隧道 JWT 三种输入，工程上做得细，但**它解决不了根本矛盾**：稳定域名 = 必须有 CF 账号 + 域名。用户的真实画像是「只有 GitHub，没有 CF 账号，更没有域名」，现有三档对他全部无效或高成本。

### 3.2 为什么「GitHub 账号 → Cloudflare 认证」无法纯自动化

- CF 支持用 GitHub OAuth **登录 dashboard**，但不存在「拿 GitHub token 换 CF API token」的无头接口；
- 命名隧道要稳定 hostname 必须绑定一个 CF 上的 zone（域名），这是 CF 的产品约束，不是本插件能绕过的；
- 因此「输入 CF 账号就完成全链路认证」这个目标，在「坚持用 cloudflared 命名隧道」的前提下，**没有低成本解法**——这正是要「反向突破」的地方：换掉对 cloudflared 的依赖。

### 3.3 反向突破：把「稳定 URL」与「Cloudflare 账号」解耦

**方案 A（强烈推荐）：默认走仓库自带的 Worker + DO 中继。**

仓库里 `agent.js`/`core.js` 已经实现完毕：本机出站 WSS 连 `dao-relay-do.<sub>.workers.dev`，云端经 `…workers.dev/relay/<session>` 直达本机。

- **零账号**：用户不需要任何 Cloudflare / GitHub 凭证；
- **URL 天然稳定**：`session` 由主机名或用户指定，重启不变；
- **无 50MB 二进制**：只需 `ws`；§2 全部消失；
- 用户成本从「注册 CF + 买域名 + 建隧道 + 复制 token」降为**零**。

落地：把 `connectRelay()` 接进插件 `Bridge`，作为第①优先档（cloudflared 退为可选高级档）。中继 Worker 由项目方一次性部署（README 已说明 `dao-relay-do` 可 REST API 一键部署），所有用户共享，按 `session`+`token` 隔离。

**方案 B（仍要用 CF 时把多步压成一步）：** 用户只粘贴一个**带 Tunnel 权限的 API Token**，插件用 CF API 自动「建隧道 → 取隧道 token → 落盘 → 起命名隧道」，省掉 dashboard 里手工建隧道、复制 token 的环节（仍需用户有域名做 ingress hostname）。当前代码是让用户自己去 dashboard 全程手搓，可由插件代劳。

**方案 C（GitHub-only 用户的稳定名）：** 由项目方持有一个域名，提供「申请子域」轻量后端：GitHub 登录 → 分配 `<user>.dao.example.com` → 后端用项目方 CF 账号建路由，把隧道 token 下发给插件。用户只需 GitHub 一次授权。成本转移到项目方，用户侧趋近于零。

> 优先级：A ≫ C ＞ B。A 用现成代码即可，是性价比最高的「反向突破」。

---

## 4. 缺陷三：跨平台适配（用户第三诉求「适配一切」）

### 4.1 当前真实支持矩阵

`cfAssetName()`（`extension.js:138`）声明的目标：

| 平台/架构 | 运行时下载 | 实际可用性 |
|---|---|---|
| Windows amd64 / arm64 | ✅ `.exe` | 可用（主路径） |
| Linux amd64 / arm64 / arm | ✅ 裸二进制 | 可用（含树莓派等 ARM） |
| **macOS amd64 / arm64** | ⚠️ 下成 `.tgz` | **不可用**：下载的是 gzip 压缩包，代码**从不解包**，却直接 `chmod +x` 当二进制 spawn → 必崩。已确认全仓零 `.tgz`/解压逻辑（`fetch-cloudflared.js:81` 干脆「跳过 darwin」）。 |
| FreeBSD / 其他 | ❌ | 资产表里没有 |
| Android(Termux) / iOS / 路由器固件 | ❌ | 见下 |

### 4.2 真正的适配天花板：宿主是 VS Code 扩展

实现 A 是 VS Code 插件，**只能跑在 VS Code / code-server / Windsurf 跑得起来的地方**。要「适配一切」，必须靠实现 B 那个**纯 Node、零 VSCode 依赖**的 `agent.js`：

- 任何能跑 Node 的平台都能跑（含 Termux on Android、各类 NAS、路由器固件、容器、CI）；
- 不依赖 50MB 平台特定二进制（cloudflared 在小众平台/架构未必有发布资产）；
- 这再次指向 §4 与 §2、§3 是**同一个解**：统一到 Worker 中继 + 纯 Node agent。

### 4.3 修复方案

1. **macOS 立即修**：下 `.tgz` 后用 Node 解 gzip + tar 取出 `cloudflared` 再 `chmod +x`（或直接用 Homebrew/官方 pkg 路径探测）。当前 macOS 用户 100% 不可用。
2. **补 FreeBSD** 等 cloudflared 官方有发布的目标到资产表；对没有官方二进制的平台，自动降级到 Worker 中继。
3. **以纯 Node agent 为「全平台兜底」**：插件检测到当前平台无可用 cloudflared 资产时，自动改用 `connectRelay()`（实现 B），实现真正的「唯变所适、适配一切」。
4. **统一两套实现的端点契约**（`core.js` 与 `extension.js` 共用一份路由表），消除 `/api/command` vs `/api/exec-sync` 之类的分裂。

---

## 5. 附带发现的安全问题（建议同批处理）

这些不是用户提的，但「从根本底层」审计必须指出，且与「降低使用成本」直接冲突（越省事越容易裸奔）：

1. **`/api/exec` 是不限工作区的整机任意命令执行**，而 `/api/ls|read|write` 却被 `withinRoot` 沙箱限制——能力面不一致，exec 等于完整 RCE。
2. **接入 MD 文档内嵌明文 token + 公网 URL，且设计上就是要「发给云端 Agent」**（`generateCloudAgentMd`）。任何拿到这份文档的人 = 对该机器的完整 RCE。本会话注入的知识库笔记里就直接贴了 live token + trycloudflare URL，正是这个风险的现实体现——**强烈建议轮换该 token**。
3. **`/api/health` 免鉴权泄露主机/平台/工作区信息**；trycloudflare URL 是公网可枚举的，等于对外广播「这里有台机器」。
4. **CORS `Access-Control-Allow-Origin: *`** 叠加在 RCE API 上。
5. **导出的 Python SDK 关闭 TLS 校验**（`CERT_NONE`）——示范了 MITM 不设防的用法。

建议：exec 也纳入可配置的根目录/白名单约束；MD 默认不内嵌 token（改为引用 `conn.json` 或一次性短时令牌）；health 收敛信息；提供「只读模式」开关。

---

## 6. 优先级总表（道法自然 · 无为而无不为）

| 优先级 | 动作 | 解决的痛点 | 工作量 |
|---|---|---|---|
| P0 | **默认通道切到 Worker+DO 中继**（接 `connectRelay` 进插件，cloudflared 降为可选） | §2 全部 + §3 全部 + §4 全部 | 中（代码已现成，主要是接线 + UI） |
| P0 | **cloudflared 完整性校验 + 自愈重下 + 断点续传** | §2.1–2.3 | 中 |
| P0 | **修 macOS `.tgz` 不解包**（当前 mac 100% 不可用） | §4.1 | 小 |
| P1 | **修 `fetch-cloudflared.js` 的 `plugins/`→`addons/` 路径**，让 bundled VSIX 真带二进制 | §2.4 | 小 |
| P1 | **轮换泄露的 token + MD 默认不内嵌明文 token** | §5.2 | 小 |
| P1 | exec 加根目录约束 / 只读模式开关；health 信息收敛 | §5 | 小 |
| P2 | 统一 A/B 两套端点契约，消除重复实现 | §1.1 | 中 |
| P2 | 方案 C：项目方域名 + GitHub 登录分配稳定子域 | §3.3 | 大（需后端） |

---

## 7. 给用户的直接回答

- **「自动安装中断导致整体瘫痪」**：根因是「无完整性校验（只看 1MB 体积）」+「损坏文件落地后永久不自愈/不重下」+「自带二进制因路径写错（`plugins/` vs `addons/`）从未真正打包，导致每次都被迫走脆弱的运行时下载」。短期按 P0/P1 修；治本是少用 cloudflared。
- **「让用户只输 CF 账号/GitHub 就完成认证、降低成本」**：在坚持 cloudflared 命名隧道的前提下无低成本解（CF 的域名约束 + 无 GitHub→CF 无头换 token）。**反向突破 = 换掉默认传输**：用仓库已写好的 Worker+DO 中继，零账号、URL 天然稳定。GitHub-only 用户走方案 C 的项目方子域分配。
- **「突破 Win/Linux/Mac 之外、适配一切」**：插件形态被 VS Code 宿主锁死；真正的「适配一切」靠那套纯 Node 的 `agent.js` + Worker 中继，任何能跑 Node 的平台（含 Android/Termux/NAS/路由器/容器）都能上。macOS 现在因 `.tgz` 不解包是直接坏的，需先修。
