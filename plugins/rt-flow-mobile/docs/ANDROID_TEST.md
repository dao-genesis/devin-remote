# Android 冷启动 + 实测 (rt-flow 浏览器版)

在自己的虚拟机里部署 Android 模拟器，装 **Kiwi Browser**（Android 上唯一原生支持加载
Chrome 扩展的浏览器），加载本扩展，验证手机端自动切换账号全流程。

## 一、部署 Android 模拟器（官方 cmdline-tools 冷启动）

```bash
export ANDROID_SDK_ROOT=$HOME/android-sdk
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
# 下载 commandlinetools-linux 解压到 $ANDROID_SDK_ROOT/cmdline-tools/latest
yes | sdkmanager --licenses
sdkmanager "platform-tools" "emulator" \
  "platforms;android-34" "system-images;android-34;google_apis;x86_64"
# KVM 加速（必需，否则 x86_64 镜像报 "requires hardware acceleration"）
sudo chmod 666 /dev/kvm        # 或 sudo usermod -aG kvm $USER 后重登
avdmanager create avd -n daoPhone -k "system-images;android-34;google_apis;x86_64" -d pixel_6
emulator -avd daoPhone -no-snapshot -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on &
adb wait-for-device
# 等 sys.boot_completed=1
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
```

## 二、装 Kiwi Browser

```bash
# Kiwi Browser APK (com.kiwibrowser.browser) — 从官方 release / 可信镜像取 arm/x86 APK
adb install -r kiwibrowser.apk
adb shell monkey -p com.kiwibrowser.browser -c android.intent.category.LAUNCHER 1
```

## 三、加载扩展

```bash
bash tools/pack.sh                              # 产出 rt-flow-mobile.zip
adb push rt-flow-mobile.zip /sdcard/Download/
```
Kiwi 内：菜单 → Extensions（`kiwi://extensions`）→ 右上「开发者模式」→
`+(from .zip/.crx/.user.js)` → 选 `/sdcard/Download/rt-flow-mobile.zip` → 安装。

## 四、实测流程

1. Kiwi 菜单点扩展图标 → 打开面板。
2. 「添加账号」：邮箱 + 密码（多个）。
3. 点账号「激活」→ 后台 `windsurf.com` 登录拿 auth1 → 注入。
4. 新开标签访问 `https://app.devin.ai` → 已登录该账号（无需手动输入账密）。
5. 开「额度耗尽自动切换」→ 余额见底自动换号；或点「立即切到最优」手动轮转。

## 五、模拟器内验证 adb 命令

```bash
adb shell input tap <x> <y>            # 点击
adb exec-out screencap -p > shot.png   # 截图
adb logcat | grep -i chromium          # 看扩展/页面日志
```

> 注：Android Chrome 官方版**不支持**扩展；Kiwi(Chromium 内核) 与 Yandex 支持。
> 若只需「自动登录」而不装浏览器扩展，可改用 WebView 壳 App 在 `onPageStarted`
> 注入同一段 `localStorage['auth1_session']` 脚本（见 `src/content.js` 逻辑）。
