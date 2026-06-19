# DAO Bridge · 工作区公网穿透

随 IDE 启停，**插件启动即自动打通整机公网穿透**，零配置、无需任何账号。道法自然 · 无为而无不为。

## 刷新 Token 按钮（v3.4.0）
面板新增「🔄 刷新Token」按钮：点一下即生成全新随机 Token，旧 Token 即刻作废，并用新 Token 重连公网通道。
适用于已持久化连接、担心旧 Token 长期暴露时一键轮换。点一次换一次，无自动刷新、无其它副作用。

## local-agent 深度控制 HTTP API（v3.2.0）
把原本仅 UI 可用的命令暴露为 HTTP 端点，本地 Agent（读 `local-agent-access.md`）无需 VS Code UI 即可全量驱动插件底层：

- `POST /api/bridge/restart` — `stop()+start()`，换新的 quick-tunnel 公网地址
- `POST /api/account/logout` — `resetAccount()` 后重启 → 回到无账号 quick tunnel
- `POST /api/export/refresh` — `writeArtifacts()`，返回 `cloud_md+local_md+paths`
- `POST /api/self/reload` — `reloadWindow()` 热加载新 `extension.js`
- `GET  /api/attempt-log` — 回退链诊断（mode/proto/attempts）

并修正：`/api/ls`、`/api/read` 在 ENOENT 时返回 **404**（而非 500）；`/api/config` POST 持久化 `cloudflaredPath`。

## 默认通道 · Worker 中继（v3.3.0）
启动**先试 Worker+DurableObject 出站中继**（`daoBridge.relayUrl`，默认 `dao-relay-do.zhouyoukang.workers.dev`）：纯出站 WSS，拿到天然稳定的 `…workers.dev/relay/<session>` 公网入口。

- **零 Cloudflare 账号**：不需账号 / 域名 / token，正面化解认证成本。
- **URL 天然稳定**：不像 quick tunnel 每次重启变。
- **适配一切平台**：纯出站、无 50MB 二进制，连不上才回退 cloudflared。
- `daoBridge.disableRelay=true` 可关闭；`daoBridge.session` 自定义会话名（留空用主机名）。

## 稳定性 · 自动回退链（v3.1.0）
中继连不上时，按下列顺序自动回退 cloudflared，任一档打通即停，绝不卡死在某一种模式：

1. **命名隧道**（用户 Cloudflare 通道 · 固定域名）— 仅当配置了 `tunnelToken` 时
2. **原生快速隧道**（无账号 · trycloudflare）— 永远兜底

协议 **http2 优先**（TCP/443，穿透性最强，代理 / GFW / 企业网友好），quic 仅作兜底。
就绪判定以「边缘连接真正注册成功」为准（而非仅打印了 URL），避免误报一条实际不通的隧道。

> 用户若添加了 Cloudflare 账号/令牌却打不通，会自动回退到原生快速隧道，公网始终可用。

## 内置 cloudflared · 不依赖用户网络（自愈）
- 优先使用**插件自带**的 `bin/cloudflared`（随发行版 VSIX 分发，离线即用）。
- 缺失时多镜像下载（直连 GitHub → `ghfast.top` / `gh-proxy.com` / `mirror.ghproxy.com` 等国内加速），**断点续传**（`Range` + `Content-Length` 校验）+ 原子落地。
- **自愈**：复用前先 `--version` 探活（不止看体积），半成品 / 损坏二进制自动删除重下；启动清理 `.part`/`.tgz` 残留——根治「自动安装中断→以半成品为基础永久卡死」。
- **macOS**：官方资产是 `.tgz`，自动零依赖解包取出真二进制（修前 mac 不可用）。
- 自动探测本机代理（clash/v2ray 常见端口）用于出站，适配国内网络；https 下载走 CONNECT 隧道。

发行版自包含 VSIX 由 `node tools/fetch-cloudflared.js <targets>` 拉取二进制后用 `tools/pack-vsix.js` 打成 `*-bundled.vsix`（含 cloudflared，体积大，走 Release 分发，不入库）。

## 退出账号 / 重置为无账号模式
面板「退出账号 / 重置为无账号模式」按钮，或命令 `DAO Bridge: 退出账号 / 重置为无账号模式`：
清除全部 Cloudflare 凭证残留（`~/.dao/bridge/*.json`、IDE 设置项、以及「之前添加过账号」遗留的 `~/.cloudflared/cert.pem` 等），**清除前自动备份**到 `~/.dao/bridge/reset-backup-<ts>/`，随后回到零配置快速隧道。

## 用 GitHub 账号登录 Cloudflare（可选 · 需自有域名）
面板「🌐 用浏览器登录 Cloudflare」会调用 `cloudflared tunnel login` 打开浏览器（可用 GitHub 账号登录 Cloudflare），授权后获取 `cert.pem`。仅当你拥有自有域名、想要固定公网域名时才需要此步；否则默认快速隧道即用。

## 整机穿透（工作区只是文本的一部分）
云端 Agent 可全方位操作整台电脑：`/api/exec` 整机任意命令；`/api/ls|read|write` **默认整机**（绝对路径原样、相对路径相对工作区根）。
仅当显式开启 `daoBridge.confineToWorkspace=true` 才把文件操作沙箱在工作区根目录内。

### 远程执行 `.bat`/`.cmd`/`.exe`/任意程序
`/api/exec` 与 `/api/exec-sync` 支持 `type` 字段（向后兼容，默认 `shell`）：

| type | 说明 | 示例 body |
|---|---|---|
| `shell`(默认) | 原样命令（cmd.exe） | `{"cmd":"hostname"}` |
| `run`/`file` | 运行文件 `.bat`/`.cmd`/`.exe`/`.ps1` + `args`，含空格路径也安全，透传原生退出码 | `{"type":"run","file":"C:\\Program Files\\app\\run.bat","args":["x"]}` |
| `cmd`/`bat` | 经 `cmd.exe /c` + `chcp 65001` 执行（中文 UTF-8 回传） | `{"type":"cmd","cmd":"dir & ver"}` |
| `detached`/`spawn` | `Start-Process` 后台/分离启动 GUI 或长驻进程，立即回 PID；可选 `elevate`/`show` | `{"type":"detached","file":"notepad.exe"}` |

可选 `cwd`（工作目录，覆盖整机任意路径）。根因：裸路径走 cmd.exe/`Invoke-Expression` 时含空格的 `.bat`/`.exe` 会被当字符串字面量/被拆词 → 跑不起来；`run`/`cmd`/`detached` 用 PowerShell 调用运算符 `&` + 单引号量化彻底规避。

## 中枢分发模型 · 被控端一行接入（operator→hub→agent，v3.6.0）
dao-bridge 既可被远程操控，也可作为**中枢**协调任意多台被控端，远程在它们身上跑命令/`.bat`/`.exe`。

1. 在面板「被控端一行接入」区块复制指令（或运行命令 `DAO Bridge: 复制被控端一行接入指令`），在任意 Windows 机器 PowerShell 跑：
   ```powershell
   irm <公网URL>/api/bootstrap.ps1 | iex
   ```
   该机即接入本中枢为被控端（`/api/connect` 登记 + 发放 per-agent token，`/api/poll` 长轮询命令，`/api/result` 回传结果）。
2. `GET /api/agents` 查看在线被控端清单（status/os/user/capabilities/last_seen/pending）。
3. 远程在某台被控端执行——给 exec 加 `agent_id`（被控端主机名）：
   ```jsonc
   // 同步等结果（含原生退出码透传）
   POST /api/exec-sync  {"agent_id":"BOX-A","type":"run","file":"C:\\t\\x.bat","args":["7"]}
   // 异步：返回 cmd_id，再 POST /api/result-fetch {"agent_id":"BOX-A","cmd_id":"..."} 取结果
   POST /api/exec       {"agent_id":"BOX-A","cmd":"hostname"}
   ```
   `agent_id` 为空/`self`/`local`/中枢本机名 → 在中枢本机执行（本源行为）。
4. `POST /api/broadcast {"cmd":"..."}` 把命令入队到所有在线被控端。

被控端接入端点（`connect`/`poll`/`result`/`heartbeat`）以 per-agent token 自证、免 master token；其余端点仍需 `Authorization: Bearer <Token>`。保留 `/api/agent/register`·`/api/agent/heartbeat` 向后兼容既有部署。

## 设置项
- `daoBridge.relayUrl` Worker 中继端点（默认通道，留空走 cloudflared）
- `daoBridge.session` 中继会话名 = `/relay/<session>`（留空用主机名）
- `daoBridge.disableRelay` 关闭中继默认通道
- `daoBridge.confineToWorkspace` 文件操作沙箱在工作区内（默认关闭=整机）
- `daoBridge.cloudflaredPath` 自定义 cloudflared 路径（留空自动探测）
- `daoBridge.tunnelToken` / `daoBridge.hostname` 命名隧道（固定域名）
- `daoBridge.localPort` 本地服务固定端口（0=随机）
- `daoBridge.accessToken` 额外访问 Token
- `daoBridge.proxyUrl` / `daoBridge.autoProxy` 出站代理（国内网络）
