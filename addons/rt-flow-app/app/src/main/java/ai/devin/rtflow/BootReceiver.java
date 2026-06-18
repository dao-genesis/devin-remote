package ai.devin.rtflow;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

/**
 * 开机自启 + 自更新自启: 设备重启 / 各厂商快速开机 / 本应用被替换(OTA 自更新)后, 自动拉起穿透服务 (常驻)。
 * 仅监听 BOOT_COMPLETED 在国产 ROM 上常不够 (厂商用各自的 QUICKBOOT 广播); 且 OTA 覆盖安装后系统会杀掉旧进程,
 * 不监听 MY_PACKAGE_REPLACED 则更新后中继不会自己起来 → 这里一并覆盖。(动作集移植自 knoop7/Ava BootReceiver。)
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String a = intent.getAction();
        if (a == null) return;
        boolean wake;
        switch (a) {
            case Intent.ACTION_BOOT_COMPLETED:
            case "android.intent.action.LOCKED_BOOT_COMPLETED":
            case "android.intent.action.QUICKBOOT_POWERON":
            case "com.htc.intent.action.QUICKBOOT_POWERON":
            case "com.samsung.android.intent.action.QUICKBOOT_POWERON":
            case "com.huawei.intent.action.QUICKBOOT_POWERON":
            case "com.vivo.intent.action.QUICKBOOT_POWERON":
            case "com.oppo.intent.action.QUICKBOOT_POWERON":
                wake = true;
                break;
            case Intent.ACTION_MY_PACKAGE_REPLACED:
                // 本应用自更新(OTA 覆盖安装)完成 → 自动恢复中继
                wake = true;
                break;
            case Intent.ACTION_PACKAGE_REPLACED:
                wake = intent.getData() != null && ctx.getPackageName().equals(intent.getData().getSchemeSpecificPart());
                break;
            default:
                wake = false;
        }
        if (!wake) return;
        try {
            Intent svc = new Intent(ctx, RelayService.class);
            if (Build.VERSION.SDK_INT >= 26) ContextCompat.startForegroundService(ctx, svc);
            else ctx.startService(svc);
        } catch (Exception ignored) {}
    }
}
