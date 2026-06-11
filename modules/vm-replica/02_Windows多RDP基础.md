# 02 · Windows 多 RDP 基础设施全资料

## 一 · 多并发会话的三条路（按系统选择）

### 方案 A: Windows Server 原生（最稳，若141是Server）
- Server 2016/2019/2022/2025 默认允许 **2 个管理会话**；装 RDS 角色后无上限（需 RDS CAL，120天宽限期可直接用）。
- 步骤:
  1. Server Manager → Add Roles → Remote Desktop Services → **RD Session Host**（+ RD Licensing 可选）
  2. gpedit.msc → 计算机配置 → 管理模板 → Windows组件 → 远程桌面服务 → 远程桌面会话主机 → 连接:
     - 「将远程桌面服务用户限制到单独的远程桌面服务会话」= **已禁用**
     - 「限制连接的数量」= 已启用, 999999
  3. 重启 → 多账号并发登录即通

### 方案 B: RDP Wrapper Library（Win10/11 家庭/专业版首选）
- 项目: github.com/stascorp/rdpwrap（原版，ini 久未更新）；
  **github.com/sebaxakerhtc/rdpwrap**（活跃 fork，ini 跟进新版本）；
  ini 自动更新脚本: github.com/asmtron/rdpwrap-utils
- 原理: rdpwrap.dll 注入 termservice 进程，运行时内存补丁 termsrv.dll
  （Session Limit Bypass / 单用户限制移除 / 许可策略 hook），**不改磁盘文件**，抗 Windows Update。
- 能力: 任意版本做 RDP host；控制台+远程会话同时在线；**同一账号本地+远程同时登录**；至多 ~15 并发；会话影子。
- 安装: `install.bat` → `update.bat`(更新ini) → `RDPConf.exe` 查看状态(全绿) → `RDPCheck.exe` 本机回环自测。
- 坑: Windows 更新 termsrv.dll 版本后 ini 不匹配 → 跑 autoupdate；Defender 报毒 → 加排除。

### 方案 C: 直接补丁 termsrv.dll（不推荐，更新即失效）
- 十六进制改 `CDefPolicy::Query` 跳转；每次系统更新需重补。仅作了解。

## 二 · 账号生命周期（程序化，PowerShell）

```powershell
# 创建"VM"账号
$pw = ConvertTo-SecureString 'Vm@2026!' -AsPlainText -Force
New-LocalUser -Name 'vm01' -Password $pw -PasswordNeverExpires
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member 'vm01'
# (可选)管理员: Add-LocalGroupMember -Group 'Administrators' -Member 'vm01'

# 查询会话
quser; qwinsta
# 注销/删除
logoff <sessionId>; Remove-LocalUser -Name 'vm01'
# 删除 profile（彻底重置"VM"）
Get-CimInstance Win32_UserProfile | ? LocalPath -like '*vm01*' | Remove-CimInstance
```

## 三 · 程序化发起 RDP 连接

```powershell
# mstsc + 凭据预存（回环连本机其他账号: 用 127.0.0.2 绕过自连限制）
cmdkey /generic:TERMSRV/127.0.0.2 /user:vm01 /pass:Vm@2026!
mstsc /v:127.0.0.2 /w:1280 /h:800
```
- **FreeRDP**（程序化首选）: `wfreerdp /v:127.0.0.2 /u:vm01 /p:... /cert:ignore /w:1280 /h:800`
  - Python 绑定 pyfreerdp / node-freerdp 可拿帧缓冲+注入输入 → 操作层基础
- .rdp 文件 + `mstsc file.rdp` 可配置全部参数（分辨率/驱动器映射/剪贴板）
- NLA 失败时: 目标账号需有密码；或注册表关 NLA（SecurityLayer=0, UserAuthentication=0）

## 四 · 会话内自动登录（"VM"开机即就绪）

- Autologon (Sysinternals) 或注册表 Winlogon AutoAdminLogon —— 仅控制台会话。
- RDP 会话自动建立: 由宿主侧脚本 cmdkey+mstsc 自动连一次即产生会话；断开(非注销)后会话保留运行。
- 计划任务 `At log on of vm01` 启动内部 agent（agent_dao.py 模式）→ 会话一建立 agent 即上线。

## 五 · 隔离性评估（账号 vs 真虚拟机）

| 维度 | 多账号RDP | 真VM |
|---|---|---|
| 文件系统 | profile 隔离，系统盘共享 | 完全隔离 |
| 进程/注册表HKCU | 隔离 | 完全隔离 |
| 系统级安装/HKLM | **共享** | 隔离 |
| GUI 桌面 | 独立完整桌面 ✓ | ✓ |
| 资源开销 | 极低（共享内核） | 高 |
| 创建速度 | 秒级 | 分钟级 |

结论: 对"并行开发环境+GUI操作"的需求，多账号RDP 是性价比最优解；
需系统级隔离时再上 Hyper-V（141 若支持，Hyper-V 增强会话本质也是 RDP，同一套操作层可复用）。
