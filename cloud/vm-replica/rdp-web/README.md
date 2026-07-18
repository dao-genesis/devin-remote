# rdp-web · 官方 RDP 前端内嵌网关

把 Windows 官方「远程桌面连接」的**线协议**与**前端渲染**原样搬运进 IDE 内页——
不重造桌面系统, 只整合既有底层。用户体感与原生 RDP 一致: 实时位图 + 鼠键滚轮。

```
IDE Webview (iframe)
   └─ webclient/  官方 mstsc.js 前端(canvas.js / rle.js / keyboard.js) + wsclient.js(WS 传输)
          │  WebSocket  ws://127.0.0.1:9040/rdp?vm=<分身>
          ▼
   gateway.js  纯 Node(http+crypto 手写 RFC6455 · 无第三方依赖)
          │  官方 RDP 线协议(node-rdpjs 协议栈)· TLS · 环回
          ▼
   127.0.0.2:3389  复制品会话(vm_host_daemon 经官方 RDP 多会话创建)
```

凭据由网关服务端从 `%ProgramData%\dao_vm\config.json` 解析(域=本机名, 用户=分身名,
口令=`default_password`), 前端只带 `?vm=`, 全程 127.0.0.1 环回、零 GUI 依赖、后端可无头验证。

## 组成

- `gateway.js` — RDP ↔ WebSocket 桥 + 静态资源服务(仅 Node 内置模块)。
- `webclient/` — 官方 mstsc.js 前端资源 + `js/wsclient.js`(以原生 WebSocket 替换 socket.io 传输)。
- `rdpjs/` — 精简后的 [node-rdpjs](https://github.com/citronneur/node-rdpjs) 协议栈(GPLv3, 见 `rdpjs/LICENSE`)。

## 对 node-rdpjs 的最小改动(仅现代化 · 不改协议)

上游 `node-rdpjs@0.3.0` 依赖已在现代 Node 移除的 API。为在 Node 20 运行, 仅做以下等价替换:

1. `rdpjs/lib/core/layer.js` — `startTLS` 由 `crypto.createCredentials()` + `tls.createSecurePair()`
   (均已移除)改为 `tls.connect({ socket, rejectUnauthorized:false })`。移除 `starttls`/`crypto` 引用。
2. `rdpjs/lib/security/jsbn.js` — 唯一用到的 `_.isNumber` 内联为 `typeof x==='number'`, 去除 `lodash` 依赖。

改动后 `rdpjs/` 仅依赖 Node 内置模块(`crypto/tls/net/fs/path/util/events`), 无需 `npm install`。

## 无头验证(后端优先 · 非 GUI)

```
node gateway.js                     # 启动网关(127.0.0.1:9040)
# WS 客户端连接 /rdp?vm=vm01 → 收 rdp-connect + 实时 rdp-bitmap 帧 → 回传 mouse/scancode
```

已实测: RDP 握手/TLS 协商成功、位图帧(16bpp RLE)持续下发、官方 `rle.js` 解压得 RGBA、输入回传通。
