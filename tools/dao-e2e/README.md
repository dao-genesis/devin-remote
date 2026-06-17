# dao-e2e · 中继载荷端到端加密 + 去中心化指南

解决的问题：默认情况下，App 通过一个**共享 Cloudflare Worker** 中继 RPC，
而 RPC 载荷（邮箱/密码/token）是**明文**转发的——中继方（即便是 workers.dev 的
拥有者）理论上能看到账号信息。本目录提供两层去中心化能力：

1. **端到端加密 (E2E)**：让中继**全程只见密文**，即使继续用共享 Worker，
   账号信息也不会以明文经过任何中继。**默认开启、向后兼容。**
2. **自托管/自有隧道 (去中心化拓扑)**：让每个用户用**自己的**免费 Worker 或
   Cloudflare 隧道，账号信息只过自己的端点。

---

## 一、端到端加密 (E2E)

### 信封格式（三端逐字节兼容）
```
base64( [ver=1 (1B)] [salt (16B)] [iv (12B)] [ciphertext + GCM-tag (16B)] )
```
- 密钥派生：`PBKDF2-HMAC-SHA256(passphrase, salt, 100000 次, 32 字节)`
- 对称加密：`AES-256-GCM`（128-bit tag 附于密文尾）

参考实现（均已互验逐字节一致）：
- 设备端 (Java)：`addons/rt-flow-app/app/src/main/java/ai/devin/rtflow/RelayService.java` → `E2E` 内部类
- 驱动端 (Python)：`dao_e2e.py`
- 驱动端 (JS · Node/浏览器)：`dao-e2e.js`

### 线路协议（无需改动中继 worker.js — 纯哑管道）
- **请求** body 改为：`{"__e2e__":1, "c": seal(key, JSON.stringify(realBody))}`
- 设备端 `relay-app.js` 检测到 `__e2e__` → 用 `Native.e2eOpen` 解密 → 正常分发 →
  结果再 `Native.e2eSeal` 加密 → **响应** body：`{"__e2e__":1, "c":"<密文>"}`
- 驱动端用同 key `open` 还原。中继自始至终只转发密文。
- **向后兼容**：明文请求 → 明文响应（旧驱动不受影响）。

### E2E Key 从哪来
- 设备首次启动**自动生成** 32-hex 口令，持久化于数据保险箱（防卸载），写入 `relay-config.json`。
- 在 App「🔧 穿透配置 → 🔐 端到端加密」面板可**查看/复制**。
- 拖拽某条对话时，自动写入「取数指引 MD · 板块六」，连同账号、Session 一并交给授权方。

### 驱动示例（Python）
```python
import dao_e2e
resp = dao_e2e.rpc(
    endpoint="https://<relay>/relay/rtflow-xxxx",
    token="<穿透面板当前 token>",
    e2e_key="<E2E Key>",
    cmd="getState")
print(len(resp["accounts"]), "个账号")   # 中继全程只见密文
```

---

## 二、去中心化拓扑

### 路线 A · 自托管同款 Worker（推荐，免费，一条命令）
每个用户用**自己**的 Cloudflare 账号部署一份中继，账号数据只过自己的端点。
```bash
cd dao-relay
npx wrangler deploy          # 部署到 你的子域.workers.dev
```
然后在 App「🔧 穿透配置」里把「中继 URL」改成自己的
`https://<你的>.workers.dev`，保存重连即可。优先级：本地配置 > 内置 conn.json。

### 路线 C · 自有命名隧道（固定域名）
App「🔑 命名隧道」面板支持登录 Cloudflare（可用 GitHub 账号）→ 自有域名隧道。
适合想要**固定公网域名**的场景。

### 路线 B · 每设备本地 cloudflared 快速隧道 —— **v0.15.15 已在移动端实现**
桌面版 dao-vsix 通过 `tools/fetch-cloudflared.js` 拉取 cloudflared 可执行文件，
在本机起 quick tunnel，做到「每设备一条免登录隧道」。**移动端 v0.15.15 起同样支持**：
穿透面板「🌐 去中心化隧道」开关一开，本机自带的 cloudflared 即建立免费快速隧道，
把设备直接暴露成 `https://xxx.trycloudflare.com` —— 完全不经任何共享 Worker、
每设备一条独立隧道、无需 Cloudflare 账号、无需登录、无需手动。

落地的三项关键工程（已完成并在模拟器端到端验证）：
1. **按 ABI 打包 cloudflared**：用 Go + Android NDK 以 cgo 交叉编译 `GOOS=android`
   的 cloudflared（`android/arm64` + `android/amd64`，使用 Android 系统 DNS 解析器），
   作为 `libcloudflared.so` 打包进 `app/src/main/jniLibs/{arm64-v8a,x86_64}/`。
   安装时 Android 把它解压到 `nativeLibraryDir`（该目录可执行），用 `ProcessBuilder`
   拉起，绕开 Android 10+ 禁止从应用数据目录 exec 的限制。
2. **内置本地入站 HTTP server**（`LocalServer.java`，仅绑 `127.0.0.1:<临时端口>`）：
   协议与 dao-relay Worker **完全一致**（`POST /relay/<session>` + `Bearer <token>`，
   body 可为 E2E 信封），把入站请求桥接到引擎 `serveLocal`（E2E 解密→RPC→重封）。
   故 `dao-e2e` 驱动工具**无需任何改动**，把 endpoint 换成 trycloudflare URL 即可。
3. **前台服务保活**：`RelayService`（前台服务 + `PARTIAL_WAKE_LOCK`）持有
   `cloudflared` 进程与 `LocalServer`，息屏/Doze 下不被节流；`cloudflared` 强制
   `--protocol http2`（走 TCP，QUIC/UDP 常被 NAT/运营商拦）以求稳。

> 注：快速隧道 URL **每次重启会变**（trycloudflare 的设计）；要固定公网域名请用
> 路线 C（命名隧道）。在国内网络下 `*.trycloudflare.com` 仍可能被屏蔽——此时
> 自动回退共享 Worker（仍并行保留），叠加 E2E 隐私无忧；或改用路线 A / C。
>
> 用 `dao-e2e` 经去中心化隧道驱动（与经 Worker 完全相同，只换 endpoint）：
> ```python
> dao_e2e.rpc("https://xxx.trycloudflare.com/relay/rtflow-xxxx", token, e2e_key, "getModuleIndex")
> ```
