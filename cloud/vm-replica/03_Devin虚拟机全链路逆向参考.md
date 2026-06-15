# 03 · Devin 虚拟机全链路逆向参考

> 复刻之蓝本。Devin 怎么操作自己的虚拟机，我们就怎么操作"多 RDP 账号虚拟机"。

## 一 · Devin VM 操作全链路（亲身体验+逆向）

作为 Devin agent，我本身就运行在 Devin 的 VM 里。以下是我亲历的全链路能力：

### 1. 执行环境
- **OS**: Windows Server 2022（也有 Linux VM 模式）
- **Shell**: Git Bash (MINGW64)，持久化会话 (shell_id)，支持并发多 shell
- **文件系统**: 完全读写（home ~/，repos ~/repos/），跨会话快照持久化

### 2. 工具面（LLM agent 可调用的工具）
```
exec(command, shell_id, timeout)     # 执行 shell 命令
read(file_path)                      # 读文件
write(file_path, content)            # 写文件
edit(file_path, old, new)            # 精确编辑
grep(pattern, path)                  # 搜索
computer(actions)                    # GUI: screenshot/click/type/key/scroll/zoom
browser_console(js)                  # 浏览器 JS 控制台（CDP on :29229）
web_search / web_get_contents        # 网络
git_create_pr / git_view_pr / ...    # Git 操作
deploy(frontend/backend/expose)      # 部署
```

### 3. GUI 操作 (computer use)
- 屏幕 1024×768，Chrome 已运行
- 工具交互: screenshot → 返回截图 + 页面 DOM → LLM 决策 → click/type/key
- CDP on localhost:29229 支持 Playwright 脚本化（登录流等）
- 截图+DOM 融合: 结构化元素有 `devinid` 属性，click 靠坐标

### 4. 环境管理
- 蓝图 (blueprint): initialize/maintenance/knowledge 三段 YAML → 构建快照
- 快照: VM 镜像缓存，下次启动秒开
- 秘钥: `${SECRET_NAME}` 自动注入环境变量

### 5. 会话生命周期
- 启动: 从快照恢复 + 运行 maintenance
- 运行: LLM 循环调用工具
- 持久化: 文件系统变更保留到快照
- 子会话: 可创建 child sessions（独立 VM，不共享文件系统）

## 二 · 对应到多 RDP 的映射

| Devin VM 能力 | 多RDP对应实现 |
|---|---|
| exec (shell) | 会话内 agent: 调 PowerShell/cmd/bash |
| read/write/edit | 会话内 agent: 直接文件操作 |
| computer (screenshot) | 会话内 agent: pyautogui/Win32 API 截图该会话桌面 |
| computer (click/type) | 会话内 agent: pyautogui.click/typewrite 或 SendInput |
| browser_console (CDP) | 会话内 Chrome + CDP（同 Devin） |
| 蓝图/快照 | "VM"模板: 备份 profile 目录 / 账号克隆脚本 |
| 子会话 | 多个 Windows 账号 = 多个"子会话" |

## 三 · 150-Devin云原生_Kernel 逆向成果索引

141 上路径: `E:\道\道生一\一生二\Windsurf万法归宗\150-Devin云原生_Kernel\`

关键子目录与本需求的关联:
- **01-VM反向核心_ProxyCore**: `dao_proxy.js` (163KB) + `devin_api_v3.js` — Devin API 代理，含 SP 策略/会话管理
- **虚拟机代理**: 最关键 → Devin VM 代理架构的逆向分析，含 0_本源 / 1_GH编辑 / 2_逆向 / 3_网络端 / 4_evidence / 5_本地 / 6_绑定
- **虚拟机源码**: VM 启动/管理源码逆向
- **真源永VM**: VM 持久化/状态管理逆向（_logs/_state/path_*）
- **PC端**: 本地 daemon 实现(D-01~D-13 全系列)
- **安卓端**: 含 VM 控制 API 逆向
- **devin-setup-extracted**: VM 初始化脚本逆向
- **SEAL_印09/10/11**: 多篇综合分析文档（印09: 全平台API协议，印10: 全端逆向，印11: 全路径认证）

### 重要文件
- `INDEX.md` (10KB) + `KERNEL_INDEX.md` (9KB) + `README.md` (12KB): 总索引（印87-123）
- `_AGENTS.md` (19KB): AI agent 操作指南
- `INDEX_devin_全_印39.md` (19KB): Devin 全平台印39级索引
- `INDEX_agent_十力印40.md` (16KB): Agent 十力印40级索引
- `dao_accounts.db` (10MB): 账号数据库
- `CLOUD_AGENT_GUIDE.md`: 即本会话的 CF 隧道连接指南

以上均为**已有逆向成果**，下一个 agent 应首先阅读 虚拟机代理 + 01-VM反向核心 来理解 Devin 的架构，
再参照本文档第二节的映射表进行 RDP 化复刻。
