#!/data/data/com.termux/files/usr/bin/bash
# dao-bridge-android · Termux:Boot 自启入口
# 放在 ~/.termux/boot/ 下，设备开机后由 Termux:Boot 调起（需安装 Termux:Boot App）。
# termux-wake-lock 防止系统休眠杀进程；崩溃自动重启。
HERE="$(cd "$(dirname "$0")" && pwd)"
# install.sh 把本脚本复制到 ~/.termux/boot/，源 agent 在仓库 addons/dao-bridge-android/
AGENT="${DAO_AGENT:-$HOME/repos/devin-remote/addons/dao-bridge-android/agent-android.js}"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

while true; do
  node "$AGENT" >> "$HOME/dao-bridge-android.log" 2>&1
  echo "[boot] agent exited, restart in 5s @ $(date -u +%FT%TZ)" >> "$HOME/dao-bridge-android.log"
  sleep 5
done
