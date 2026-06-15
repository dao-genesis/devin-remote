# dao-bridge-android · 手机端独立后台 Agent（Termux 形态）

> 把 **dao-bridge** 的「出站 WSS 穿 NAT + 本地 HTTP API」原样搬到 **Android**：复用 `../dao-bridge/core.js`，
> 在手机上跑一个真实 Node 进程，给出稳定 `*.workers.dev` 公网地址，把**这台手机本体**当作可远程操作的终端。
> 额外提供 `/api/device`（经 `termux-api` 采集电池/网络/电话等设备信息）。
>
> **范围 / 合规**：仅用于**你自己拥有 / 已获得设备所有者明确授权**的手机做远程管理、调试、二次开发。
> 这与桌面 dao-bridge、ADB-over-network、scrcpy、frp 同类，是合法双用途技术。
> 在设备所有者不知情情况下隐蔽取数属于监控软件用途，不在本模块支持范围内。

## 为什么是独立原生进程，而不是浏览器插件

`rt-flow-mobile` 是 MV3 浏览器扩展，跑在浏览器沙箱里——**没有** `child_process`、不能读手机文件系统、不能碰其它 App 数据，
所以 dao-bridge 的 `/api/exec`、`/api/read`、`/api/write` 在扩展里实现不了（架构性限制，非工程量问题）。
要把「手机当终端」，必须在浏览器之外加一层有 OS 权限的原生进程——这就是本模块（Termux 上的 Node Agent）。

详见仓库根 `addons/rt-flow-mobile/` 与本目录 `agent-android.js`。

## 架构（与桌面 dao-bridge 同一套 core）

```
云端 ──HTTPS POST──▶ dao-relay-do.<sub>.workers.dev/relay/<session>
                          │ (Cloudflare Worker + Durable Object)
手机 agent-android.js ──出站 WSS──┘ ──▶ 本机执行 ──▶ 真实 stdout 原样返回
        │
        └─ 复用 ../dao-bridge/core.js（startServer + connectRelay + handleRoute）
           额外路由 handleExtra → /api/device（termux-api）
```

## 安装（Termux）

前置：在手机装 [Termux](https://f-droid.org/packages/com.termux/) 与 [Termux:API](https://f-droid.org/packages/com.termux.api/)、[Termux:Boot](https://f-droid.org/packages/com.termux.boot/)（均建议从 F-Droid 安装，保证版本一致）。

```bash
# 在 Termux 里
pkg install -y git
git clone https://github.com/zhouyoukang1234-spec/devin-remote.git ~/repos/devin-remote
cd ~/repos/devin-remote/addons/dao-bridge-android
DAO_TOKEN=<你的token> bash install.sh
```

`install.sh` 会：安装 `nodejs-lts` + `termux-api` → 在 `../dao-bridge` 装 `ws`/`https-proxy-agent` 依赖 →
生成 `conn.json`（token 仅落本地、不入库）→ 把 `boot.sh` 复制到 `~/.termux/boot/` 实现**开机自启**（需打开一次 Termux:Boot App）。

## 启动

```bash
# 连云端中继（穿 NAT，给公网入口）
DAO_TOKEN=<token> node agent-android.js

# 本地直连模式（仅 127.0.0.1，调试 / PoC，不连云端）
DAO_NO_RELAY=1 DAO_TOKEN=<token> node agent-android.js
```

## 配置（优先级：环境变量 > conn.json > 默认）

| 键 | 说明 | 默认 |
|---|---|---|
| `DAO_RELAY` | Worker 中继 URL | `https://dao-relay-do.zhouyoukang.workers.dev` |
| `DAO_SESSION` | 会话名（= `/relay/<session>`） | `android-<hostname>` |
| `DAO_TOKEN` | 鉴权 token（**必填**） | 首次随机生成 |
| `DAO_PORT` | 本地 server 端口 | `9920` |
| `DAO_ROOT` | 工作根目录 | `$HOME` |
| `DAO_NO_RELAY` | `1` 时只起本地 server 不连中继 | 关 |

## API

在 `../dao-bridge` 全部端点基础上新增 `/api/device`：

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| GET | `/api/health` | - | 存活（免鉴权） |
| POST | `/api/exec` | `{cmd,timeout,cwd}` | 执行命令 |
| POST | `/api/ls` | `{path}` | 列目录 |
| POST | `/api/read` | `{path}` | 读文件 |
| POST | `/api/write` | `{path,content}` | 写文件 |
| GET | `/api/info` | - | 设备/工作区信息 |
| POST | `/api/device` | `{fields?:["battery","wifi","telephony","location"]}` | **新增**：termux-api 设备信息；无 termux-api 时优雅降级为通用 os 信息 |

所有非 health 端点需 `Authorization: Bearer <token>`。

云端调用示例：

```bash
curl -X POST https://dao-relay-do.<sub>.workers.dev/relay/android-<host> \
  -H "Authorization: Bearer <token>" \
  -d '{"path":"/api/device","method":"POST","body":"{\"fields\":[\"battery\",\"wifi\"]}"}'
```

## 测试

```bash
node test/device.test.js   # 纯数测：termux-device 降级 + handleExtra 鉴权/404
node --check agent-android.js termux-device.js
```

## 拿到的权限边界（重要）

Termux 进程的访问范围 = Termux 沙箱：自身文件 + `/sdcard` 共享存储（`termux-setup-storage` 授权后）+
`termux-api` 暴露的能力（短信/通讯录/定位/相机/剪贴板等，**均需运行时授权**）。
要跨 App 无限制读「所有数据」需 root/Magisk——本模块不默认走这条路，也不建议用于他人设备。
