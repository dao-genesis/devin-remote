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

## 8. 当前实时状态(交接时刻)
- **141**:host daemon 健康(计划任务自启自愈);zhou `status=running` 屏外保活;HKLM 首登抑制已生效;仓库已含 Phase 1–3 全部成果(SHA256 校验)。daovm 演示账号已干净销毁,会话恢复为 administrator(console)+ zhou(rdp-tcp#3)。
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

— 推进到底,道法自然,无为而无不为。
