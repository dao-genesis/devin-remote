#!/usr/bin/env bash
# 交叉编译 libsshtun.so (路线A 扩展 · 独立于 cloudflared 的第二条去中心化公网后端)。
# 产物放入 app/src/main/jniLibs/<abi>/libsshtun.so, 随 APK 解压到 nativeLibraryDir 执行
# (与 cloudflared 同样绕开 Android 10+ 数据目录 exec 限制)。
#
# 依赖: Go (>=1.22) + Android NDK (>=r26)。用法:
#   ANDROID_NDK=/path/to/ndk ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

NDK="${ANDROID_NDK:?set ANDROID_NDK to your Android NDK dir}"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
OUT="../../app/src/main/jniLibs"
API=24

echo "==> android/arm64"
CGO_ENABLED=1 GOOS=android GOARCH=arm64 CC="$TC/aarch64-linux-android${API}-clang" \
  go build -ldflags="-s -w" -o "$OUT/arm64-v8a/libsshtun.so" .

echo "==> android/amd64"
CGO_ENABLED=1 GOOS=android GOARCH=amd64 CC="$TC/x86_64-linux-android${API}-clang" \
  go build -ldflags="-s -w" -o "$OUT/x86_64/libsshtun.so" .

echo "done:"; ls -la "$OUT"/arm64-v8a/libsshtun.so "$OUT"/x86_64/libsshtun.so
