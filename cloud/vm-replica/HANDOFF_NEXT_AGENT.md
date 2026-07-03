# HANDOFF — 多RDP类虚拟机 / Devin 云原生 Kernel — 下一个 Agent 接手指南

> 道法自然 · 无为而无不为 · 推进到底 · 物无非彼,物无非是
> 本文是单一权威交接文档,汇总本会话全部成果、进展、架构、缺陷修复、经验教训、当前状态与待办。
> 仓库根: `E:\DAO_ARCHIVE\20_多RDP虚拟机化_VM_REPLICA`

---

## 0. 一句话
把"用户 Windows 上的另一个 RDP 账号"当成一台**类虚拟机**来操作,效果与 Devin 操作自己的云 VM **1:1 完全一致**(exec/文件/截图/鼠标/键盘/窗口),且与主账号(administrator)**互不干扰**;并把这套底层升级为**任意 Agent 经 MCP 即插即用**的通用能力,支持**任意 Windows 从 0 冷启动**新账号当虚拟机用。

---

## 1. 本质与目标(辩证两层)
- **本体层**:Devin 操作自己的云 VM(Server 2022 / Administrator / console / 1280×720@96)。这是**基准**。
- **远程层**:Devin(或任意 Agent)经 RDP 路由操作用户机器上的另一个账号(如 141 的 zhou)。目标 = 与本体层**逐原语等价**,无感一致。
- **物无非彼,物无非是**:两层在原语层面完全等价,差异只来自"真实环境的脏状态"(离屏 RDP、首登弹窗等),本会话已逐一归零。

---

## 2. 架构与链路
```
[任意 Agent / Devin]
   │  (A) MCP stdio JSON-RPC 2.0          (B) 直接 REST
   ▼                                       │
mcp_server.py  ──HTTP──►  vm_host_daemon.py(127.0.0.1:9000, Administrator 交互会话)
 (23 tools)                   │  Bearer token 鉴权;计划任务登录自启+看门狗自愈
                              │  host 动作: vm.create/attach/destroy/list, sessions, health, activate_rdp
                              ▼  HTTP 代理到对应 VM 端口
                       vm_inner_agent.py(127.0.0.1:9001=zhou, 9002+=新建, 跑在各自 RDP 会话内)
                              │  Win32 SendInput/BitBlt 在"本会话桌面"执行
                              ▼
                       该账号的真实桌面(截图/输入/窗口都在此会话内,隔离)
```
- **为什么 host 必须在交互会话**:服务式会话无桌面 → 截图全黑、输入无效。host 用登录计划任务跑在 administrator 的 console 交互会话。
- **为什么 inner agent 在目标会话**:输入/截图必须在目标账号自己的会话桌面执行,才能做到隔离 + 真实帧缓冲。
- **离屏保活**:目标 RDP(mstsc)窗口被恢复(取消最小化)并移到屏幕外 + `SWP_NOACTIVATE`,会话保持"活跃可截图可输入",又不可见、不抢主账号焦点。daemon 看门狗持续保活。

---

## 3. 关键坐标(端点 / 凭据 / 路径 / 账号)
| 项 | 值 |
|---|---|
| 141 主机 | `DESKTOP-MASTER`,Win11;Administrator=console(SID1);**zhou**=RDP(SID2, `127.0.0.3:3389`);已装 **RDPWrap**(支持 >2 会话) |
| 179 主机 | `ZHOUMAC`,Win11,用户 `zhouyoukang`;**relay agent 当前卡死**(见 §8) |
| Devin 本体 VM | Windows Server 2022 / Administrator / console / 1280×720@96(基准) |
| host REST | `POST http://127.0.0.1:9000/`,body=`{"action":"...", ...}`,header `Authorization: Bearer <token>` |
| inner 端口 | zhou=9001;新建账号 9002+(由 host 分配) |
| 配置文件 | `C:\ProgramData\dao_vm\config.json`(`host_port` / `token` / `default_password`);host 读取,inner 继承 |
| 工作目录 | `C:\dao_vm\`(代码、日志、临时);测试载体文件一律放这里,**绝不碰用户 Documents/Desktop/Downloads** |
| Devin→用户机通道 | relay ps-agent(agent 名:`DESKTOP-MASTER`=141,`ZHOUMAC`=179);客户端封装见 `dao_sdk.py` |
| 141 工具链(已对齐本体) | Node v22 / Python 3.12.7 / Git 2.51 / Chrome / VSCode 1.124 / winget 均在 |

> 注:relay 的 CF 隧道 URL 与 token 属临时基础设施,可能变更;以"relay ps-agent + dao_sdk"机制为准。新 Agent 用自己的 relay 连接即可。

---

## 4. 能力清单
**原语(inner agent,21 个动作)**:`exec`、`file_read`、`file_write`、`file_append`、`screenshot`(PNG)、`desktop_info`、`ui_info`、`foreground`、`activate`、`click`、`double_click`、`right_click`、`mouse_move`、`drag`、`scroll`、`type`、`key`、`hold_key`;host 级:`sessions`、`health`、`activate_rdp`;管理:`vm.create/attach/destroy/list`。

**MCP 工具(23 个,`mcp_server.py`)**:`vm_create/attach/destroy/list/exec/screenshot/desktop_info/click/double_click/right_click/mouse_move/drag/scroll/type/key/hold_key/file_read/file_write/file_append/ui_info/activate/foreground/sessions`。纯标准库,stdio + newline-delimited JSON-RPC 2.0,可 PyInstaller 冻结为单 exe。`vm_screenshot` 直接回传 `image/png` 内容块。

---

## 5. 三阶段进展全记录
### Phase 1 — 全量归档(DONE)
所有代码/客户端/测试/报告/证据按 `impl_v2 / archive_practice/{clients,reports,evidence,meta}` 结构归档到 141 仓库,SHA256 校验。

### Phase 2 — 回归本源·辩证对照(DONE,14/14 PASS)
逐项原语在"操作 zhou"与"操作本体 VM"间做 1:1 对照,全部等价。能力矩阵见 `archive_practice/reports/PARITY_MATRIX_PHASE2.md`。drag 期望位移(170,110)=实测(170,110)。深挖暴露并修复 3 个真实缺陷(见 §6 之 #2/#3/#4)。证据:`evidence/phase2_typed.jpg`、`phase2_context.jpg`。

### Phase 3A — 通用 MCP 接入层(DONE,6/6 PASS)
`mcp_server.py` 补齐到 23 工具(新增 file_append/activate/foreground/sessions)。以"外部 Agent"身份真实 spawn stdio 自检:initialize→tools/list(23)→exec(zhou)→CJK 文件往返→screenshot(image/png 1.2MB)→foreground 全 PASS。脚本 `archive_practice/clients/mcp_selftest.py`。

### Phase 3B — 141 冷启动新账号 daovm(DONE)
`vm.create daovm` → 第 3 个并发会话 9s 上线,**zhou+administrator 全程 Active 不受影响**;whoami=`desktop-master\daovm`、截图 1280×800、type 往返逐字命中(`COLD-START 道法自然 OK 无为而无不为`)。演示后 `vm.destroy daovm` 干净销户。发现并修复冷启动首登弹窗夺焦缺陷(§6 之 #5)。脚本 `archive_practice/clients/coldstart_demo.py`;证据 `evidence/coldstart_daovm.jpg`;报告 `reports/PHASE3_UNIVERSAL_COLDSTART.md`。

### Phase 3C — 179 真·空白机从 0 装栈冷启动(TODO,阻塞)
179 relay agent 卡死,待用户在 179 本机重启 ps-agent 后补做。脚本与流程已就绪。

---

## 6. 根因缺陷与修复(最宝贵的工程资产)
所有缺陷都**只在"真实账号 + 离屏 RDP + GUI 应用"长链路**才暴露,正是远程层与本体层的差异点,已逐一归零。

1. **截图全黑 / 键盘被吞**:目标 mstsc 窗口被**最小化** → Windows 挂起该会话图形+输入桌面。**修**:`ensure_rdp_active`(取消最小化、移屏外、`SWP_NOACTIVATE` 不抢焦点)+ daemon 看门狗保活。
2. **hold_key 只出 1 个字符**:SendInput 单次 keydown 不会硬件级自动重复。**修**:离散 down+up 连发模拟自动重复(~0.04s 间隔,0.45s 稳定出 13~14 个字符)。
3. **长按后紧跟的首键(换行)被吞**:离屏 RDP 会话首个输入事件状态"脏"被吞。**修**:`type` 开头注入一个无害 Shift 引信吸收首事件丢失,之后 100% 落地。
4. **多行 `\n`/`\t` 被合并 / 变注释**:用 Unicode 扫描码发不出真正回车/制表。**修**:`\n`/`\t` 发**真实虚拟键** `VK_RETURN`(0x0D)/`VK_TAB`(0x09);多事件单次**原子批量**注入(避免离屏 RDP 合并/丢失)。
5. **冷启动全新账号首登被 "Microsoft 账户/OOBE 首次体验" 窗口夺焦吞键**:`activate ok:false`、`focused_hwnd:0`、前台卡在"Microsoft 账"。**修(根治+兜底)**:`parity_provision.ps1` 管理员写 5 个 HKLM 策略键(`CloudContent\DisableWindowsConsumerFeatures/DisableConsumerAccountStateContent/DisableSoftLanding`、`Policies\System\EnableFirstLogonAnimation=0`、`OOBE\DisablePrivacyExperience=1`,实测 errorlevel 0)→ 此后冷启动账号开机即净桌面;兜底:上线后发 `Esc+Alt+F4+taskkill SystemSettings/wwahost/PeopleApp`。
6. 其他:64 位窗口句柄截断 → 用 64 位句柄;黑帧时 BitBlt→`PrintWindow` 回退;大文件分块传输;监听 `0.0.0.0`→`127.0.0.1`+Bearer token;截图 BMP(2MB)→纯 stdlib PNG(~250KB)。

---

## 7. 经验与教训(operational,务必遵守)
- **绝不用模糊窗口标题定位窗口**:本会话早期一次模糊匹配误命中并经 Ctrl+S 覆盖了用户 `Downloads\lceda-pro-activation.txt`(已用 `Documents\LCEDA-Pro\` 完好副本完整还原,405B 校验一致)。**铁律**:测试只用专属新文件 + 唯一 tag。
- **多 SendInput 事件必须单次原子批量注入**,否则离屏 RDP 会合并/丢失。
- **relay 单命令 I/O ~6000 字符上限** → 大文件 base64 **分块** push/pull(见 `pushrun141.py` / `pull141.py`,chunk≈3500 push / 180KB raw pull)。
- **长操作(首登 ~60s)用文件日志 + detached 执行**,避免 relay ~120s 超时(见 `coldstart_demo.py`)。
- **CJK 经 relay 终端显示会乱码(GBK)但磁盘字节完好** → 用 Python substring 校验内容,勿信终端显示;CJK 路径作为 **Python 字面量** + base64 传输才能完整存活。
- **会话上限**:Server 2022 默认 console+1 RDP;客户端 SKU(Win10/11)需 **RDPWrap** 支持 >2(141 已装,179 待确认)。
- **relay agent 可能"在线但不消费队列"卡死**(心跳正常、pending 累积、命令超时)→ 只能本机重启 ps-agent,无法远程恢复。
- **隔离铁律**:不最小化/登出 zhou、不强断 administrator console、不删 zhou(只删"创建型"账号)、不碰用户既有文件、收尾清理临时文件与 Notepad 标签状态。

---

## 7.5 v3 — 静默/隐形 + 全版本自适应(本会话新增,代码已落地,待 141 实测)
> 目标:太上下知有之 —— 不用时系统**零足迹**回归用户日常状态;适配一切 Windows 版本/版次。

### A. 静默/隐形模式(`vm_host_daemon.py` v3)
- **`host.hibernate`**:优雅拆除全部 VM 活动 —— logoff+删除**我们创建的**账号、按目标选择性 kill mstsc 窗口(仅命中 `TscShellContainerClass` + `RDP_TARGET`,不误伤用户自己的远程连接)、注销 `dao_agent_*` 计划任务、**revert termsrv.dll 补丁**(回归原生单会话)、清理 `C:\dao_vm\` 临时文件(`start_*.bat`)、清除 `cmdkey` 凭据缓存。**attached(用户自己开的)会话只 detach 不 logoff**。守护进程本体保持运行(极轻量、不可见)以接受 `host.wake`。
- **`host.wake`**:从休眠唤醒 —— 重新启用多会话(按检测到的版本自适应)+ 重新部署 inner 脚本,就绪待 `vm.create`;**不自动建号**。
- **`host.stealth_status`**:上报 mode(active/hibernating)、idle 秒数、活跃 VM 数、live mstsc 窗口数、`dao_agent_*` 任务、检测到的 Windows 版本/版次、会话列表,及 `footprint` 判定(zero/non-zero)。用于**核验系统闲时确实隐形**。
- **`host.stealth_config`**:动态配置 `stealth_auto`(闲时自动休眠开关)、`stealth_idle_timeout`(默认 300s)、`cleanup_temp_on_hibernate`。
- **idle 看门狗线程**:`stealth_auto=True` 时,无 API 调用超 `stealth_idle_timeout` 秒且有活跃 VM 即自动 `hibernate()`;每 30s 检查一次。keepalive 看门狗在 hibernating 态**停止一切保活动作**(零可见活动)。
- **hibernating 态请求门禁**:休眠期间只放行 `host.wake/stealth_status/stealth_config/os_info/cleanup`,其余动作返回 503 + 提示先 wake。

### B. 全 Windows 版本自适应(`ts_multifix.py` v2)
- **偏移解析三级级联**:① builtin OFFSETS(精确版本命中,最快)→ ② rdpwrap.ini(社区维护,覆盖数百 build)→ ③ **签名扫描自发现**(`_offsets_from_autodiscovery`:扫 `.data` 找 CSLQuery 5-DWORD 全局簇 [+0x00 bServerSku / +0x04 lMaxUserSessions / +0x0C bAppServerAllowed / +0x18 bRemoteConnAllowed / +0x1C bMultimonAllowed],扫 `.text` 找 CDefPolicy jne)。任一命中即用;结构不匹配则 no-op,**绝不盲写**。
- **版次识别**:`_is_server_sku()` —— Server SKU 多会话原生,直接 no-op(source=`native-server`);Home/Pro/Enterprise/LTSC 走 client 补丁路径。
- **Home 版 RDP 使能**:`_ensure_rdp_enabled()` 写 `fDenyTSConnections=0` + NLA + 开防火墙组(仅注册表,不碰 ServiceDll,可逆),`ensure_multisession()` 开头无条件调用(全版本安全,Home 必需)。
- **`sysinfo()`**:诊断用 —— 返回 termsrv 内存/磁盘版本、偏移来源、是否 Server、rdpwrap.ini 是否存在、解析状态。

### C. GUI 操作体系整合(已在 inner agent + MCP 端到端接通,本会话核验)
预测性操作层(`vm.observe/find/read/act/act_seq/where_changed/wait_change/region_hash/flow_probe/region_centroid`)在 `vm_inner_agent.py` `_dispatch`(行 663–685)已实现,经 daemon `proxy()`(行 737 剥 `vm.` 前缀)代理到 inner。MCP schema 已定义,call_tool 对 escalation 的 region PNG 做 image 块回传。**无需再造,已通**。

### D. 新增 MCP 工具(`mcp_server.py`)
`host_hibernate / host_wake / host_stealth_status / host_stealth_config / host_cleanup / host_os_info` —— 任意 Agent 经 MCP 即可控制静默生命周期。

> ⚠️ 待办:上述 v3 代码**尚未在 141 实测**(DAO Bridge 机控 token 不匹配,见 §13)。恢复机控后按 §13 验证清单实跑。

---

## 8. 当前实时状态(交接时刻)
- **141**:host daemon 健康(计划任务自启自愈);zhou `status=running` 屏外保活;HKLM 首登抑制已生效;仓库已含 Phase 1–3 全部成果(SHA256 校验)。daovm 演示账号已干净销毁,会话恢复为 administrator(console)+ zhou(rdp-tcp#3)。**v3 静默/自适应代码已 PR,待上机实测。**
- **179**:relay ps-agent 卡死,所有命令超时,3C 待办。**需用户在 179 本机重启 ps-agent。**

---

## 9. 待办 / Roadmap(给下一个 Agent)
1. **解锁 179** 后跑 `coldstart_demo.py`(配合 `deploy_blank_windows.ps1 -Provision`)验证真·空白机从 0 装栈冷启动(141 因已装机器级工具链走的是快速路径)。
2. **PyInstaller 打包** `mcp_server/vm_host_daemon/vm_inner_agent` 成单 exe(`impl_v2/build_exe.ps1` 已起草,**尚未实测构建**)→ 彻底脱离 Python 依赖。
3. **一次性冷启动安装器**:把工具链 + RDP 配置 + 三组件 exe 打成单包,任意 Windows 一键(开 RDP/RDPWrap→装栈→建号→连接→部署→自检)。
4. **MCP 客户端自动发现/连接**机制 + 多 Agent 并发接入示例(Claude/Cursor/Windsurf 配置见 `impl_v2/mcp_client_config.example.json`)。
5. **并行 ≥N 台 VM**(141 已经 RDPWrap 解锁,可直接多开;179 待装)。

---

## 10. 怎么接手(快速上手)
```bash
# 客户端工具都在 archive_practice/clients/(dao_sdk.py 封装 relay)
# 1) 健康检查 + 看会话
python clients/healthcheck.py          # 或 ctl141.py / agents_status.py
# 2) 推送并运行一个脚本到 141(分块 base64 + SHA256 校验)
python clients/pushrun141.py <local.py> 'C:\dao_vm\<name>.py' run
# 3) 从 141 拉回大文件(截图等)
python clients/pull141.py 'C:\dao_vm\<file>' <local>
# 4) 直接驱动 zhou(在 141 上 POST 到 127.0.0.1:9000,带 Bearer):
#    action=vm.exec/vm.screenshot/vm.type/vm.file_write...,vm="zhou"
# 5) 冷启动新账号演示:clients/coldstart_demo.py(detached+文件日志)
# 6) MCP 自检(任意 Agent 视角):clients/mcp_selftest.py
```

---

## 11. 仓库结构地图
```
20_多RDP虚拟机化_VM_REPLICA\
├── 01..06_*.md                 设计文档(架构/RDP/全链路/GitHub/经验/给下一个Agent)
├── README.md
├── HANDOFF_NEXT_AGENT.md       ← 本文(权威交接)
├── impl\                       v1 原型(历史参考)
├── impl_v2\                    ★ 当前实现
│   ├── vm_host_daemon.py       host(REST :9000,18+ 动作,看门狗保活)
│   ├── vm_inner_agent.py       inner(会话内 SendInput/BitBlt,含全部缺陷修复)
│   ├── mcp_server.py           ★ MCP 23 工具(stdio JSON-RPC)
│   ├── parity_provision.ps1    ★ 工具链对齐 + 首登弹窗抑制(机器级)
│   ├── deploy_blank_windows.ps1 空白机一键部署(幂等,-Provision/-SelfTest)
│   ├── build_exe.ps1           PyInstaller 打包(草稿,未实测)
│   ├── README_v2.md / mcp_client_config.example.json / *.ps1
└── archive_practice\
    ├── clients\                所有客户端/测试脚本(dao_sdk/pushrun141/pull141/phase2_parity/mcp_selftest/coldstart_demo...)
    ├── reports\                DEV_HISTORY / PARITY_MATRIX_PHASE2 / PHASE3_UNIVERSAL_COLDSTART / PARITY_REPORT / test-report
    ├── evidence\               截图证据(zhou_*/vm01_*/phase2_*/coldstart_daovm.jpg...)
    └── meta\project_snapshot.json
```

---

## 12. 禁止事项(红线)
- 不最小化 / 登出 zhou;不删 zhou 账号;不强断 administrator console(会话 #1)。
- 不远程干预 179 的 relay agent(卡死时需用户本机重启)。
- 不修改用户既有文件(如 `lceda-pro-activation.txt`)。
- 不用宽泛窗口标题匹配定位窗口(必须专属新文件 + 唯一 tag)。
- 不在用户 Documents/Desktop/Downloads 留测试垃圾(收尾清理)。
- 不并发创建过多新账号(避免 quser 争用)。

---

## 13. v3 待验证清单(恢复 141 机控后实跑)
> DAO Bridge 直连机控当前 token 不匹配(隧道到 dao-bridge v3.7.0,其 master token 本机随机生成,与文档 `dao-vsix-*` 不同源)。恢复后按下清单实测 v3:

1. **静默核验**:`host.stealth_status` → 记录 active 态 footprint;`host.hibernate` → 再 `host.stealth_status` 应 `mode=hibernating` 且 `footprint=zero`(mstsc_windows=0、agent_tasks=[]、created VM 已删);人工确认 administrator console + zhou **全程 Active 不受影响**、桌面无残留窗口。
2. **唤醒往返**:`host.wake` → `vm.create test01` 9s 上线;`vm.exec whoami` 正确;`vm.destroy test01`;再 `host.hibernate` 回零足迹。
3. **termsrv revert 干净**:hibernate 后 `ts_multifix.status()` 应 `applied=False`(回原生单会话);wake 后 `applied=True`。
4. **自发现路径**(可选,换非 26100.8521 build 或临时从 OFFSETS 删该键):`ts_multifix.sysinfo()` 的 `offset_source` 应落到 `auto-discovery` 且 status `applied=True`,证明脱离硬编码也能自适应。
5. **Server/Home 分支**:若有 Server 测机 → source=`native-server` no-op;Home 测机 → `_ensure_rdp_enabled()` 生效 + client 补丁路径成功。
6. **闲时自动休眠**:`host.stealth_config {stealth_auto:true, stealth_idle_timeout:60}` → 静置 >60s → 自动进入 hibernating(查 stealth.log)。
7. **GUI 层实跑**:`vm.observe`(<200B 状态签名)、`vm.find text=保存`(无截图定位)、`vm.act` 预测-执行-核验、`vm.act_seq` 多步 —— 对齐 agentctl F381/F382 模式跑一遍归档/存 docx。

---

## 14. v3 上机实测结果(141 · Win11 教育版 26200 · 本会话已跑通)
> DAO Bridge 已恢复(公网URL `capital-eagles-neck-verified`,token `dao-vsix-5ed8…`);
> v3 全套已部署至 `C:\dao_vm\` 并编译通过。以下为真机验证结论:

1. **开机静默(无为)**:守护进程 `main()` 已去掉启动即 `ensure_multisession()`;
   实测启动日志零 termsrv 补丁。多会话补丁改为 `vm.create`/`host.wake` 时惰性施加。
2. **零足迹休眠**:`host.hibernate` → `termsrv` 还原原生(`applied=False`,
   `bServerSku 1→0`,`cdefpolicy_jne 0xEB→0x75`)+ 清残留计划任务(`agent_tasks=[]`)
   + 杀本系统 mstsc + 删 `C:\dao_vm\start_*.bat`;`host.stealth_status` 回
   `mode=hibernating, footprint=zero`。**administrator console(会话#1)全程 Active 不受影响**。
3. **唤醒往返**:`host.wake` → 多会话补丁复原(`bServerSku 0→1, jne 0x75→0xEB, applied=True`)。
4. **端到端 vm.create**:`vm.create vm01` → RDP 会话#2(`rdp-tcp#0`)Active 上线;
   `vm.exec whoami`=`desktop-master\vm01`;`vm.desktop_info`=1280×800;
   `vm.screenshot` BitBlt 截屏成功(179KB PNG,真机桌面首登 OOBE 画面)。
   随后 `host.hibernate` → `destroyed=['vm01']`、mstsc killed=1、footprint 归零。
5. **通用性缺陷已修(真机验证)**:`_os_edition()` 旧代码只按**英文** caption 子串判版本,
   本机为**中文 Win11 教育版**→ 全 flag=false。已改为**语言中立**的数字 `OperatingSystemSKU`+
   `ProductType` 判定:实测 `sku=121 → is_education=true, is_enterprise=true, product_type=1`。
   caption 仅作显示、不再参与分类;SKU 为 None 时才回落 caption(含中文「教育/企业/家庭/专业」子串)兜底。
6. **build 号澄清(非缺陷)**:`os_info` 的 build `26200` 是**系统版本号**;
   `termsrv.dll` 二进制版本是 `26100.8521`,恰在 `ts_multifix` OFFSETS 内置表中
   (`source=builtin, sig_ok=True, applied=True`)。两者是不同维度,偏移表按 dll 版本命中,正确。

**下一步(未做,留给后续)**:§13 第 6 项闲时自动休眠计时验证;第 7 项 GUI 预测层
(`vm.observe/find/act`)对齐 agentctl F381/F382 在 vm01 内跑归档/存 docx。

---

## 15. v3.2 — 首登 OOBE 自动落桌 + 静默守护稳定性(141 真机跑通)

> 承接 §14 遗留的「首登 OOBE 弹窗自动消除」,并修掉一个会让**静默守护进程静默崩溃**的隐性缺陷。

1. **OOBE 自动推进(语言/版次中立)**:`vm_host_daemon.py::advance_oobe()` 轮询
   `_oobe_active()`,在 OOBE 页上反复送 `Enter` 直至落桌(实测 `steps=2`);落桌后**不再用 Esc**。
2. **真因:Win11 开始菜单不吃 Esc**。Esc 只清空开始菜单内的搜索框,**不关闭** Start 浮层;
   可靠且语言中立的开关是 **Win 键**。新增 `vm_inner_agent.py::ensure_desktop(max_iter=5)`:
   仅当**前台窗口的所属进程**属于 shell 浮层宿主白名单
   (`startmenuexperiencehost.exe / searchhost.exe / searchapp.exe / shellexperiencehost.exe`,
   进程名匹配、非本地化 UI 串)时才点一下 Win 键 → 决不会在已干净的桌面上误开 Start。
   进程名经 `QueryFullProcessImageName`(`PROCESS_QUERY_LIMITED_INFORMATION`)取得,跨完整性级别可用。
   `advance_oobe` 落桌后 settle 2s 调用之;新增 dispatch `ensure_desktop` 与代理 `vm.ensure_desktop`。
   实测 vm06:`oobe=advanced-to-desktop, steps=2, ensure_desktop={closed:0}`(前台为机器级自启应用、
   非 shell 宿主→正确地不动),`vm.screenshot` 得**干净可用桌面、无 OOBE / 无残留 Start**;
   `whoami=desktop-master\vm06`、`query session`=会话#7 `rdp-tcp#0` Active → 确系**隔离 RDP 会话**。
   (会话内可见的图标来自 `C:\Users\Public\Desktop` 公共快捷方式、可见的第三方 App 来自 HKLM 全局自启,
   属机器级继承,非本系统行为。)
3. **静默守护稳定性缺陷(真机暴露并修复)**:守护须**无窗**运行(`pythonw`,静默要求),但
   `ensure_multisession()` 里两处裸 `print()` 在 `sys.stdout is None`(pythonw)或 stdout 管道被关时
   抛 `OSError [Errno 22] Invalid argument`,导致 `vm.create` 返回 500、整条创建链路崩。
   修法:两处 `print()` 改走 `log.info`;日志改为**始终挂 `FileHandler`**(`C:\ProgramData\dao_vm\stealth.log`),
   仅在存在真实 stdout 时才追加 `StreamHandler`;并在 `sys.stdout/stderr is None` 时把二者重定向到日志文件,
   使任何残留 `print()` 永不抛异常。守护遂可 `pythonw` 无窗常驻(PID 由 `Start-Process -WindowStyle Hidden` 拉起)。
4. **完整往返复验(新守护)**:`vm.create vm06`(落桌洁净)→ `host.hibernate`
   (`destroyed=[vm06]`、mstsc killed=1、`termsrv_revert` 还原原生、`oobe_revert.restored=1`)
   → `host.stealth_status` = `mode=hibernating, active_vms=0, agent_tasks=[], footprint=zero`,
   仅剩 administrator console 会话 → **完全静默、太上下知有之**。

**下一步(留给后续)**:§13 第 6 项闲时自动休眠计时;把守护无窗常驻固化为登录触发的隐藏计划任务
(现为 `Start-Process -WindowStyle Hidden pythonw`,重启不自起);第 7 项 GUI 预测层
(`vm.observe/find/act`)在 vm 内跑 F381/F382 归档/存 docx。

---

— 推进到底,道法自然,无为而无不为。
