package ai.devin.rtflow;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.util.ArrayList;
import java.util.List;

/**
 * KeepAlive · 后台持久化 / 持久稳定化助手 (移植自 knoop7/Ava 的 KeepAliveHelper + BatteryOptimizationHelper)。
 *
 * 常驻中继(RelayService 前台服务 + WSS 心跳)在国产 ROM 上最大的杀手是: ① Doze/电池优化把后台 CPU 节流、
 * ② 各厂商「自启动管理」默认不放行 → 杀掉后/重启后再也不拉起。本类提供:
 *   - 电池优化豁免状态检测 + 申请 (系统标准 ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
 *   - 各厂商「自启动 / 后台白名单」设置页深链跳转 (华为/荣耀/小米/OPPO/realme/vivo/iQOO/魅族/三星/一加)
 *   - 各厂商保活操作指引文案
 * 仅做「跳转到对应设置页让用户点一次」, 不私自提权; 与已有 Shizuku/无障碍互补。
 */
public final class KeepAlive {
    private KeepAlive() {}

    public enum Maker { HUAWEI, HONOR, XIAOMI, OPPO, VIVO, IQOO, MEIZU, SAMSUNG, ONEPLUS, REALME, OTHER }

    public static Maker maker() {
        String brand = (Build.BRAND == null ? "" : Build.BRAND).toLowerCase();
        String man = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase();
        if (brand.equals("huawei") || man.equals("huawei")) return Maker.HUAWEI;
        if (brand.equals("honor") || man.equals("honor")) return Maker.HONOR;
        if (brand.equals("xiaomi") || man.equals("xiaomi") || brand.equals("redmi")) return Maker.XIAOMI;
        if (brand.equals("oppo") || man.equals("oppo")) return Maker.OPPO;
        if (brand.equals("vivo") || man.equals("vivo")) return Maker.VIVO;
        if (brand.equals("iqoo") || man.equals("iqoo")) return Maker.IQOO;
        if (brand.equals("meizu") || man.equals("meizu")) return Maker.MEIZU;
        if (brand.equals("samsung") || man.equals("samsung")) return Maker.SAMSUNG;
        if (brand.equals("oneplus") || man.equals("oneplus")) return Maker.ONEPLUS;
        if (brand.equals("realme") || man.equals("realme")) return Maker.REALME;
        return Maker.OTHER;
    }

    // ── 电池优化豁免 ──────────────────────────────────────────────
    /** 本应用是否已被加入电池优化白名单 (Doze 豁免)。<M 视为已豁免。 */
    public static boolean isBatteryOptIgnored(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (Exception e) { return false; }
    }

    /** 申请「电池不优化」豁免 (系统标准弹窗)。已豁免则跳通用电池优化列表。返回是否成功发起。 */
    public static boolean requestBatteryOpt(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
        try {
            if (isBatteryOptIgnored(ctx)) {
                Intent it = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(it); return true;
            }
            Intent it = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + ctx.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(it); return true;
        } catch (Exception e) { return openAppDetails(ctx); }
    }

    // ── 悬浮窗 / 显示在其他应用上层 (后台启动 Activity 放行) ──────────
    /** 是否已授予「显示在其他应用上层」。<M 视为已授予。 */
    public static boolean canDrawOverlays(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
            return Settings.canDrawOverlays(ctx);
        } catch (Exception e) { return false; }
    }

    /** 跳转「显示在其他应用上层」授权页 (Android 10+ 后台唤回前台依赖它)。返回是否发起成功。 */
    public static boolean requestOverlay(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
        try {
            ctx.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + ctx.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Exception e) {
            try {
                ctx.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return true;
            } catch (Exception e2) { return openAppDetails(ctx); }
        }
    }

    // ── 厂商自启动 / 后台白名单 ─────────────────────────────────────
    /** 跳转到当前厂商的「自启动 / 后台启动」管理页。失败回退应用详情页。返回是否发起成功。 */
    public static boolean openAutoStart(Context ctx) {
        List<Intent> intents = new ArrayList<>();
        switch (maker()) {
            case HUAWEI: case HONOR:
                add(intents, "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity");
                add(intents, "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.bootstart.BootStartActivity");
                add(intents, "com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity");
                break;
            case XIAOMI:
                add(intents, "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity");
                intents.add(new Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT));
                add(intents, "com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity");
                break;
            case OPPO: case REALME:
                add(intents, "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity");
                add(intents, "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity");
                add(intents, "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity");
                add(intents, "com.coloros.phonemanager", "com.coloros.phonemanager.MainActivity");
                break;
            case VIVO: case IQOO:
                add(intents, "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity");
                add(intents, "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager");
                add(intents, "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity");
                add(intents, "com.iqoo.secure", "com.iqoo.secure.MainGuideActivity");
                break;
            case MEIZU:
                add(intents, "com.meizu.safe", "com.meizu.safe.permission.SmartBGActivity");
                break;
            case SAMSUNG:
                add(intents, "com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity");
                add(intents, "com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity");
                break;
            case ONEPLUS:
                add(intents, "com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity");
                break;
            default: break;
        }
        return tryStart(ctx, intents);
    }

    /** 跳转到当前厂商的「省电策略 / 后台耗电」设置页 (与自启动管理互补)。 */
    public static boolean openBatterySettings(Context ctx) {
        List<Intent> intents = new ArrayList<>();
        switch (maker()) {
            case HUAWEI: case HONOR:
                add(intents, "com.huawei.systemmanager", "com.huawei.systemmanager.power.ui.HwPowerManagerActivity");
                add(intents, "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity");
                break;
            case XIAOMI: {
                Intent i = new Intent().setComponent(new ComponentName("com.miui.powerkeeper",
                        "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"));
                i.putExtra("package_name", ctx.getPackageName());
                i.putExtra("package_label", appName(ctx));
                intents.add(i);
                break;
            }
            case OPPO: case REALME:
                add(intents, "com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity");
                add(intents, "com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerSaverModeActivity");
                break;
            case VIVO: case IQOO:
                add(intents, "com.iqoo.powersaving", "com.iqoo.powersaving.PowerSavingManagerActivity");
                break;
            default: break;
        }
        if (intents.isEmpty()) {
            try {
                ctx.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return true;
            } catch (Exception e) { return openAppDetails(ctx); }
        }
        return tryStart(ctx, intents);
    }

    /** 当前厂商保活操作指引 (人类可读, 面板展示)。 */
    public static String instructions() {
        switch (maker()) {
            case HUAWEI: case HONOR:
                return "华为/荣耀:\n1. 应用启动管理 → 本应用 → 关闭自动管理 → 开「自启动/关联启动/后台活动」\n2. 电池 → 更多设置 → 休眠时保持网络连接";
            case XIAOMI:
                return "小米/Redmi:\n1. 应用设置 → 本应用 → 自启动 → 开启\n2. 省电与电池 → 应用智能省电 → 本应用 → 无限制\n3. 安全中心 → 授权管理 → 自启动管理 → 允许";
            case OPPO: case REALME:
                return "OPPO/realme:\n1. 应用管理 → 本应用 → 耗电管理 → 允许后台运行/允许后台高耗电\n2. 手机管家 → 自启动管理 → 允许";
            case VIVO: case IQOO:
                return "vivo/iQOO:\n1. 应用与权限 → 本应用 → 权限 → 后台弹出界面 → 允许\n2. i管家 → 自启动 → 允许\n3. 电池 → 后台耗电管理 → 允许后台高耗电";
            case MEIZU:
                return "魅族:\n1. 手机管家 → 权限管理 → 后台管理 → 允许后台运行";
            case SAMSUNG:
                return "三星:\n1. 应用 → 本应用 → 电池 → 允许后台活动\n2. 设备维护 → 电池 → 未监视的应用 → 添加本应用";
            case ONEPLUS:
                return "一加:\n1. 应用 → 本应用 → 电池 → 不优化\n2. 电池 → 电池优化 → 本应用 → 不优化";
            default:
                return "通用:\n1. 设置 → 应用 → 本应用 → 电池 → 不限制/不优化\n2. 允许应用自启动和后台运行";
        }
    }

    /** 机读保活状态 (供 Native 桥/引擎 RPC 上报给面板与云端 Agent)。 */
    public static String statusJson(Context ctx) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("maker", maker().name());
            o.put("battOptIgnored", isBatteryOptIgnored(ctx));
            o.put("overlayGranted", canDrawOverlays(ctx));
            o.put("hint", instructions());
            return o.toString();
        } catch (Exception e) { return "{\"battOptIgnored\":false}"; }
    }

    // ── 内部工具 ──────────────────────────────────────────────────
    private static void add(List<Intent> list, String pkg, String cls) {
        list.add(new Intent().setComponent(new ComponentName(pkg, cls)));
    }

    private static boolean tryStart(Context ctx, List<Intent> intents) {
        for (Intent it : intents) {
            try { it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(it); return true; }
            catch (Exception ignored) {}
        }
        return openAppDetails(ctx);
    }

    private static boolean openAppDetails(Context ctx) {
        try {
            ctx.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + ctx.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Exception e) { return false; }
    }

    private static String appName(Context ctx) {
        try {
            return ctx.getPackageManager().getApplicationLabel(
                    ctx.getPackageManager().getApplicationInfo(ctx.getPackageName(), 0)).toString();
        } catch (Exception e) { return "Devin Cloud"; }
    }
}
