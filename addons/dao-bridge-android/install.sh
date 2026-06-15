#!/data/data/com.termux/files/usr/bin/bash
# dao-bridge-android · Termux 一键安装
# 道法自然：在 Termux 里装好 Node + 依赖 + 生成 conn.json + 注册开机自启（Termux:Boot）。
# 仅用于你自己 / 已明确授权的设备。
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$HERE/../dao-bridge" && pwd)"

echo "[install] dao-bridge-android @ $HERE"

# 1) 依赖：nodejs + termux-api（设备信息）
if command -v pkg >/dev/null 2>&1; then
  echo "[install] pkg update + install nodejs-lts termux-api"
  pkg update -y || true
  pkg install -y nodejs-lts termux-api || pkg install -y nodejs termux-api || true
else
  echo "[install] 非 Termux 环境（无 pkg），跳过系统包安装，仅装 npm 依赖"
fi

# 2) npm 依赖装到 ../dao-bridge（core.js 的 require('ws') 从那里解析）
echo "[install] npm install (ws, https-proxy-agent) -> $BRIDGE_DIR"
( cd "$BRIDGE_DIR" && npm install --no-audit --no-fund )

# 3) conn.json：token 优先取环境变量 DAO_TOKEN，否则随机生成（仅落本地）
CONN="$HERE/conn.json"
if [ ! -f "$CONN" ]; then
  TOKEN="${DAO_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')}"
  SESSION="${DAO_SESSION:-android-$(node -e 'console.log(require("os").hostname())')}"
  ROOT="${DAO_ROOT:-$HOME}"
  node -e "require('fs').writeFileSync('$CONN', JSON.stringify({relayUrl: process.env.DAO_RELAY||'https://dao-relay-do.zhouyoukang.workers.dev', session:'$SESSION', token:'$TOKEN', port:Number(process.env.DAO_PORT||9920), root:'$ROOT', flavor:'android'}, null, 2))"
  echo "[install] 生成 conn.json（token 仅本地保存，未入库）"
else
  echo "[install] 已存在 conn.json，保留"
fi

# 4) Termux:Boot 开机自启（需安装 Termux:Boot App 并至少打开一次）
BOOTDIR="$HOME/.termux/boot"
mkdir -p "$BOOTDIR"
cp "$HERE/boot.sh" "$BOOTDIR/dao-bridge-android.sh"
chmod +x "$BOOTDIR/dao-bridge-android.sh"
echo "[install] 已写入开机自启脚本: $BOOTDIR/dao-bridge-android.sh"
echo "[install] 提示：安装 Termux:Boot App 并打开一次，自启才会生效。"

echo "[install] 完成。手动启动： DAO_TOKEN=<token> node \"$HERE/agent-android.js\"   （或 npm --prefix \"$HERE\" start）"
