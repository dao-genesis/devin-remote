#!/usr/bin/env bash
# 打包 rt-flow 浏览器版为可装载 zip (Kiwi Browser/Android 用 .zip 直接加载)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HERE/rt-flow-mobile.zip}"
cd "$HERE"
rm -f "$OUT"
zip -r -q "$OUT" manifest.json src icons \
  -x '*.DS_Store' -x 'test/*' -x 'tools/*' -x '*.zip'
echo "packed → $OUT"
unzip -l "$OUT" | tail -n +2 | head -n 30
