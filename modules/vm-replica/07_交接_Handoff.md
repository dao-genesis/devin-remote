# vm-replica · Agent-VM 集成交接文档 (Handoff)

> 目标（用户原话精炼）：让任意 Agent 像操作自己的 Devin Cloud 虚拟机一样，流畅操作用户 141 台式机上的一个**后台 Windows 账号**——独立桌面、鼠标/键盘/截屏/录屏全同步，**完全不干扰用户前端（console 会话 1）**。底层哲学：外固其本，内圆其心，表里相依，浑然一统。
>
> 本文档面向**接手的下一个 Agent**：读完即可继续推进，无需回溯历史会话。

---

## 0. TL;DR — 当前状态

| 项 | 状态 |
|---|---|
| dao-bridge v3.2.0（内网穿透）部署在 141 | ✅ 运行中，公网直连可用 |
| 多 RDP 内核补丁（rdpwrap / termsrv 8521） | ✅ ini 段正确、落盘；**但需复核内存是否真打入**（见 §3） |
| vm_agent.py（会话内控制服务：截屏/鼠标/键盘/录屏 + HTTP API） | ✅ 代码完成、已部署 141 `C:\ProgramData\dao-vm\` |
| daovm 后台账号 + DaoVMAgent 自启动任务 | ✅ 账号在、密码有效、任务已注册 |
| **后台 daovm RDP 会话常驻** | ❌ **阻塞点**：环回 mstsc 连接到达 RDP 监听器后，在握手阶段被断开（client reason=1800），**未产生 daovm 登录**（见 §4） |
| vm_agent 在 127.0.0.1:9931 健康 | ⏳ 依赖上一项（会话起不来→agent 无处运行） |
| dao-bridge `/api/vm/*` 反代路由 | ❌ **未做**，需新增（见 §6） |
| 端到端输入/录屏验证 | ⏳ 依赖会话常驻 |

**一句话**：所有"代码与内核"层面已就绪，唯一卡点是**无人值守地把 daovm 的后台 RDP 会话拉起来并保持渲染**——环回 RDP 在握手阶段失败（reason 1800）。下一个 Agent 的核心任务就是攻克这一关，然后顺着 §5 往下全部能跑通。

---

## 1. 关键坐标与凭据

```
141 台式机
  主机名:        DESKTOP-MASTER
  局域网 IP:     192.168.31.141
  console 会话:  会话 1 = Administrator (Active)  ← 绝对不可打扰
  另一台:        192.168.31.179（笔记本，141 用 mstsc 8728 连它，勿杀）

dao-bridge (内网穿透插件本体, v3.2.0)
  公网 URL:      会变！始终读 141 上 ~/.dao/bridge/conn.json 的最新值
                 （历史值示例 https://anime-mph-contain-facilitate.trycloudflare.com）
  本地端口:      见 conn.json（历史 15175 / 18777 等，每次重启会变）
  Token:         9dd1db47b078638b2d5196c8384edfe4
  鉴权头:        Authorization: Bearer 9dd1db47b078638b2d5196c8384edfe4

daovm 后台账号
  用户:          daovm   （DESKTOP-MASTER\daovm）
  密码:          DaoVm@8521#Agent   （已用 LogonUser 验证有效）
  环回 IP:       127.0.0.9（也试过 127.0.0.2/.50；RDP 端口 3389 标准）
  vm_agent 端口: 9931（绑 127.0.0.1，Bearer 同上 token，env DAO_VM_TOKEN）

141 上的关键路径
  vm_agent.py:   C:\ProgramData\dao-vm\vm_agent.py
  connector.py:  C:\ProgramData\dao-vm\connector.py（拨号器，见 §5）
  daovm.rdp:     C:\ProgramData\dao-vm\daovm.rdp
  rdpwrap.ini:   C:\Program Files\RDP Wrapper\rdpwrap.ini
  termsrv.dll:   C:\Windows\System32\termsrv.dll
  Python:        Anaconda 3.12（mss / PIL / pyautogui / numpy / cv2 / win32api 均在；无需 ffmpeg）
  仓库副本:      E:\DAO_ARCHIVE\devin-remote（141 自己 git pull，不走隧道传大文件）

本 Devin VM 上的仓库工作树
  C:\Users\Administrator\repos\devin-remote   分支 devin/1781266849-dao-bridge-resilience (= PR #81)
```

---

## 2. 如何从远端驱动 141（接手第一步先跑通这个）

我在本 VM 上用一个轻量客户端 `d141.py`（`C:\Users\Administrator\d141.py`）封装了对 dao-bridge 的调用：
- `call(method, path, json_body)` → 走 `/api/*`（read/write/info 等）
- `ps(script, timeout)` → 走 `/api/exec` 在 141 上跑 PowerShell（**注意编码坑见 §7**）

典型用法：
```python
import sys; sys.path.insert(0, r"C:\Users\Administrator")
from d141 import ps, call
st, j = call("GET", "/api/info")          # 拿 workspace root 等
o, e, c = ps("chcp 437 > $null; qwinsta", 30)   # 在 141 跑命令
```
> 大文件/脚本上传：不要塞进命令行（Windows cmdline ~32KB 截断）。用 `/api/write` 写到 workspace 的 `_stage/`，再 `Copy-Item -LiteralPath` 到目标目录。

---

## 3. 多 RDP 内核现状（已修，但请复核）

**根因（比"偏移写错"更深一层）**：141 的 `termsrv.dll` 存在**版本字符串 ≠ 二进制真值**的现象：
- `.FileVersion`（字符串）历史显示 `8162`，现显示 `8115`
- **`VS_FIXEDFILEINFO` 二进制真值 = `10.0.26100.8521`** ← RDP Wrapper 实际按这个找 ini 段

`rdpwrap.ini` 现状（已落盘）：
- `[10.0.26100.8521]`：LocalOnly=`920F1` · SingleUser=`9F39B` · DefPolicy=`9C53D` · SLInit=`B3468`（上一会话用 RDPWrapOffsetFinder 符号法+特征码法双重核对）
- `[10.0.26100.8115]`：LocalOnly=`90E81` · SingleUser=`9DFCB` · DefPolicy=`9AEEF` · SLInit=`B1DC8`（社区 ini 自带）
- `[SLPolicy] / fSingleSessionPerUser=0` 均正确
- ServiceDll = `C:\Program Files\RDP Wrapper\rdpwrap.dll`（1.7.4.0），TermService=Auto

**今天确曾成功并发**：LocalSessionManager 显示 12:22 建过会话2、12:41 建过会话3（随后断开）。说明多 RDP 在那时是工作的。

**⚠️ 待复核（下一个 Agent 必做）**：用 SeDebugPrivilege 读 termsrv 进程内存，确认补丁**真的打在 8521 偏移**上（`SingleUser @ base+0x9F39B` 应为 `B8 01 00 00 00 90 90` = mov eax,1;nop;nop）。
- 我写了 `C:\Users\Administrator\check_patch_mem.py`，但 `OpenProcess(PROCESS_VM_READ)` 对 SYSTEM 持有的 svchost **失败（返回空）**——**需先启用 SeDebugPrivilege** 再 OpenProcess，否则读不到。这是没复核成的原因。
- 若读出来 8521 偏移**未被打入**（而 8115 偏移被打入或都没打），说明 rdpwrap 选错了版本段 → 单会话限制仍在 → 这正可解释 §4 的 reason 1800。

---

## 4. 阻塞点详解：daovm 环回 RDP 握手失败 (reason 1800)

**现象链**（全部实测）：
1. `connector.py`（见 §5）在 console 会话以交互计划任务方式启动 `mstsc daovm.rdp`。
2. mstsc 弹出**资源访问/发布者警告**（`远程桌面连接安全警告`，列出"使用以下凭据连接 DESKTOP-MASTER\daovm"，按钮 `连接(&N)`/`取消(&C)`）→ connector **成功点了"连接(&N)"**。
3. 紧接着弹出第二个 `远程桌面连接` 对话框，**只有一个"确定"按钮**（= 连接失败错误框）。其文本控件没被枚举到，**错误正文未读到**（对话框可能在第二台显示器、被用户的 4 个 Devin 窗口挡住）。
4. RDP 客户端日志：`ClientActiveX 正在连接 DESKTOP-MASTER` → 紧接 `多传输连接已断开` → **`ClientActiveX 已断开 (Reason= 1800)`**。
5. 服务端：RemoteConnectionManager **收到连接（事件 261）**，但**没有**后续的"接受连接(1158)/加载用户配置(20521)"，`qwinsta` 始终只有 console。
6. Security 日志：**没有任何 daovm 的 4624/4625**——即连接在**身份验证之前**就被断开。

**结论**：失败发生在 **RDP 安全/传输握手阶段**（NLA/CredSSP 或多传输协商），**早于凭据认证**。不是密码问题（密码已验证有效），更像：
- (A) 多 RDP 补丁未真正生效 → 第二会话在协议层被拒（最可能，先查 §3）；或
- (B) 环回 NLA/CredSSP 协商失败。

**下一个 Agent 的攻坚建议（按优先级）**：
1. **先做 §3 的内存复核**（启用 SeDebugPrivilege）。若补丁没打在 8521 → 重算/确认 rdpwrap 用哪个段，必要时把正确偏移同时写进它实际选用的段，重启 TermService 再测。
2. **直接读第二个错误对话框正文**：改 connector，对 `#32770` 枚举所有 `Static` 子控件文本并落日志（我只枚举到按钮）；或在 connector **不点"确定"**时立刻截**全虚拟桌面**（`mss.monitors[0]`，4720×3840 双屏）读错误文字。`C:\Users\Administrator\grab_all.py` 已能截全屏。
3. **换握手参数试**：编辑 `daovm.rdp`：`authentication level:i:2` + `enablecredsspsupport:i:0`（关 CredSSP），或反之；试 `127.0.0.2` / 用主机名而非 IP。
4. **最朴素验证多 RDP 是否活着**：新建一次性账号，走同样环回连接看能否并发出第 2 个会话（隔离 daovm 特定问题 vs 多RDP 整体问题）。上一会话用过 `rdptest` 验证成功，可复刻。

**注意（不可碰）**：141 的 console 会话 1、到 179 的 mstsc(8728)、dao-bridge 进程；不要重启电脑。重启 TermService 是安全的（只影响 RDP 服务端，不影响 141 到 179 的出站客户端，console 不掉线）——上一会话已多次验证。

---

## 5. daovm 会话拨号器 connector.py（已能点掉警告）

`C:\ProgramData\dao-vm\connector.py`（仓库副本：`modules/vm-replica/agent-vm/connector.py`）。
关键设计（**为什么必须这样**）：
- **必须在 console 会话 1 的交互桌面里跑**（同一 window station），否则 `win32gui.EnumWindows` 看不到 mstsc 对话框、PostMessage 也跨不过去。
- 因此用**交互式计划任务**拉起：
  ```powershell
  $act=New-ScheduledTaskAction -Execute (Get-Command python).Source -Argument "C:\ProgramData\dao-vm\connector.py"
  $pr =New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\Administrator" -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName DaoVMConnector -Action $act -Principal $pr -Force
  Start-ScheduledTask DaoVMConnector
  ```
- connector 用 `subprocess.Popen(..., creationflags=DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP)` 启 mstsc，使其**脱离父进程存活**（否则脚本一退出 mstsc 就被收走）。
- 循环里 `EnumWindows` 找 `#32770`，按**按钮文本**（"连接"/"Connect"）点确认键（不盲点默认键，避免点到"取消/否"）。
- 探到 `daovm` 会话行后 `Start-ScheduledTask DaoVMAgent` 拉起 vm_agent，再轮询 `http://127.0.0.1:9931/health`。

> 已验证：connector 能稳定点掉"连接(&N)"警告。剩下的就是 §4 的握手失败。

---

## 6. dao-bridge `/api/vm/*` 反代路由（待新增）

`vm_agent` 绑 `127.0.0.1:9931`，外部 Agent 够不着；需在 dao-bridge 里加反代，复用现有隧道+token：
- 文件：`plugins/dao-bridge/dao-bridge-ext/extension.js`
- 路由表在 `~L384` 起（`const p = u.pathname; ... if (p === "/api/health") ...`，`auth(req)` 鉴权）。
- 新增：`if (p.startsWith("/api/vm/"))` → 把 `p.slice(7)`（去掉 `/api/vm`）转发到 `http://127.0.0.1:9931<rest>`，透传 method/body + `Authorization: Bearer <DAO_VM_TOKEN>`，回写状态码与响应体（截屏/录屏是二进制，注意按 Buffer 透传、设对 Content-Type）。
- 这样远端 Agent：`POST {publicURL}/api/vm/move {x,y}`、`GET {publicURL}/api/vm/screenshot` 即可驱动后台桌面。

---

## 7. 踩坑与约定（省下一个 Agent 的时间）

- **PowerShell 5.1 编码**：默认按 GBK 读无 BOM 的 UTF-8 → 中文路径/脚本乱码。两种解法：①写脚本时加 UTF-8 BOM（`0xEF,0xBB,0xBF`）再 `powershell -File`；②`/api/exec` 跑的脚本里**首行 `chcp 437 > $null`** 统一码页，且尽量用绝对路径、英文。本 VM 的 `d141.ps()` 已用 `-EncodedCommand`(UTF-16) 规避大部分问题。
- **命令行长度**：`-EncodedCommand` 嵌 >12KB base64 会在 ~32KB 处截断 → 走 `/api/write` 上传文件。
- **trycloudflare 快速隧道 URL 重启即变** → 永远读 `~/.dao/bridge/conn.json`。
- **截屏多显示器**：用户是双屏（虚拟桌面 4720×3840，主屏竖屏 2160×3840）。要看错误框务必截 `mss.monitors[0]`（全虚拟桌面）。
- **管道缓冲**：`python script.py | tail` 时 Python 全缓冲，长循环要等进程退出才出全量；调试用 `flush=True` 或落日志文件再读。
- **顺手发现的独立隐患（非本任务，建议告知用户）**：Security 日志里 `Administrator` 每 ~30–60s 一次 **type=3 网络登录失败、密码错误 (0xc000006a)**。疑似某服务/计划任务存了过期的 Administrator 凭据在反复重试，与本任务无关，但值得用户排查。

---

## 8. 文件清单（本次产出）

仓库内（PR #81，`modules/vm-replica/agent-vm/`）：
- `vm_agent.py` — 会话内控制服务（截屏/鼠标/键盘/录屏 + Bearer 鉴权 HTTP API）
- `connector.py` — daovm 会话交互式拨号器（点警告 + 拉 agent + 轮询健康）
- `daovm-up.ps1` — 一键编排（建账号/任务/cmdkey/.rdp/起 mstsc）

本 Devin VM `C:\Users\Administrator\`（诊断脚本，已打包进交接 ZIP 的 `scripts/`）：
- `d141.py` 远端驱动客户端；`check_multirdp.py` / `ini8115.py` / `check_patch_mem.py` 内核诊断；
- `connector.py` / `connector2.py`（带对话框正文日志版）/ `connect_task.py` / `fix_profile.py` 会话拉起；
- `rdp_client_log.py` / `rcm_log.py` / `diag_daovm.py` 事件日志诊断；`grab_all.py` / `grab_screen.py` 全屏截图。

---

## 9. vm_agent.py HTTP API 速查

```
GET  /health           → {ok, version, session_id, console_session_id, screen:{w,h}}
GET  /screenshot       → image/png (mss 抓全屏)
POST /move             {x,y}            POST /click {x,y}     POST /doubleclick {x,y}
POST /rightclick {x,y} POST /drag {x,y,to_x,to_y,duration}    POST /scroll {x,y,delta}
POST /type  {text}     POST /key {key}  POST /hotkey {keys:[...] | "alt+tab"}
POST /record/start {fps=12,monitor=1,name?}   POST /record/stop   GET /record/file → mp4
鉴权: Authorization: Bearer <DAO_VM_TOKEN>  端口: env DAO_VM_PORT (默认 9931)
```

---

> 接手顺序建议：§2 跑通驱动 → §3 复核多RDP内存补丁 → §4 攻 reason 1800（先 §3，再读错误框正文，再调握手参数）→ 会话起来后 §5 自动拉 agent → §6 加反代 → 端到端验证鼠标/键盘/截屏/录屏 → 更新 PR。
> 道法自然，无为而无不为。
