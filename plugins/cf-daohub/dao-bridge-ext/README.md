# DAO Bridge · 工作区公网穿透

随 IDE 启停，**插件启动即自动打通整机公网穿透**，零配置、无需任何账号。道法自然 · 无为而无不为。

## 稳定性 · 自动回退链（v3.1.0）
启动按下列顺序自动尝试，任一档打通即停，绝不卡死在某一种模式：

1. **命名隧道**（用户 Cloudflare 通道 · 固定域名）— 仅当配置了 `tunnelToken` 时
2. **原生快速隧道**（无账号 · trycloudflare）— 永远兜底

协议 **http2 优先**（TCP/443，穿透性最强，代理 / GFW / 企业网友好），quic 仅作兜底。
就绪判定以「边缘连接真正注册成功」为准（而非仅打印了 URL），避免误报一条实际不通的隧道。

> 用户若添加了 Cloudflare 账号/令牌却打不通，会自动回退到原生快速隧道，公网始终可用。

## 内置 cloudflared · 不依赖用户网络
- 优先使用**插件自带**的 `bin/cloudflared`（随发行版 VSIX 分发，离线即用）。
- 缺失时多镜像下载（直连 GitHub → `ghfast.top` / `gh-proxy.com` / `mirror.ghproxy.com` 等国内加速），原子落地 + 体积校验。
- 自动探测本机代理（clash/v2ray 常见端口）用于出站，适配国内网络；https 下载走 CONNECT 隧道。

发行版自包含 VSIX 由 `node tools/fetch-cloudflared.js <targets>` 拉取二进制后用 `tools/pack-vsix.js` 打成 `*-bundled.vsix`（含 cloudflared，体积大，走 Release 分发，不入库）。

## 退出账号 / 重置为无账号模式
面板「退出账号 / 重置为无账号模式」按钮，或命令 `DAO Bridge: 退出账号 / 重置为无账号模式`：
清除全部 Cloudflare 凭证残留（`~/.dao/bridge/*.json`、IDE 设置项、以及「之前添加过账号」遗留的 `~/.cloudflared/cert.pem` 等），**清除前自动备份**到 `~/.dao/bridge/reset-backup-<ts>/`，随后回到零配置快速隧道。

## 用 GitHub 账号登录 Cloudflare（可选 · 需自有域名）
面板「🌐 用浏览器登录 Cloudflare」会调用 `cloudflared tunnel login` 打开浏览器（可用 GitHub 账号登录 Cloudflare），授权后获取 `cert.pem`。仅当你拥有自有域名、想要固定公网域名时才需要此步；否则默认快速隧道即用。

## 设置项
- `daoBridge.cloudflaredPath` 自定义 cloudflared 路径（留空自动探测）
- `daoBridge.tunnelToken` / `daoBridge.hostname` 命名隧道（固定域名）
- `daoBridge.localPort` 本地服务固定端口（0=随机）
- `daoBridge.accessToken` 额外访问 Token
- `daoBridge.proxyUrl` / `daoBridge.autoProxy` 出站代理（国内网络）
