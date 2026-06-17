package ai.devin.rtflow;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;

import rikka.shizuku.Shizuku;

/**
 * Shizuku 集成: "软件自我 ADB" 的现实形态。
 *
 * Android 安全模型禁止 App 凭空给自己授予 ADB/shell 级权限 (无 root 时这是不可逾越的边界)。
 * Shizuku 是唯一合规路线 —— 用户一次性激活后 (安卓11+ 无线调试配一次 / 插一次电脑 / root),
 * 一个以 shell uid 2000 运行的特权进程常驻, App 经 binder 调用它执行 adb shell 级命令。
 * 激活后持久稳定 (类似有线 USB 的可靠性), App 可自我授予存储/无障碍等权限。
 *
 * 本类只做客户端: 探测 binder、申请权限、跑 shell。不做任何"绕过激活"的事 (做不到, 谁都做不到)。
 */
final class ShizukuManager {
    static final int REQ_CODE = 0x5A1C;
    static final String SHIZUKU_PKG = "moe.shizuku.privileged.api";

    private ShizukuManager() {}

    /** Shizuku 管理器 App 是否已安装。 */
    static boolean isManagerInstalled(Context ctx) {
        try { ctx.getPackageManager().getPackageInfo(SHIZUKU_PKG, 0); return true; }
        catch (Exception e) { return false; }
    }

    /** 特权服务是否在运行 (binder 可达)。 */
    static boolean isRunning() {
        try { return Shizuku.pingBinder(); } catch (Throwable t) { return false; }
    }

    /** 是否已授予本 App Shizuku 权限。 */
    static boolean hasPermission() {
        try {
            if (!isRunning()) return false;
            if (Shizuku.isPreV11()) return false;
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) { return false; }
    }

    /** 综合状态: 0=未安装管理器, 1=已装未运行, 2=运行中未授权, 3=已授权可用。 */
    static int status(Context ctx) {
        if (isRunning()) return hasPermission() ? 3 : 2;
        return isManagerInstalled(ctx) ? 1 : 0;
    }

    /** 弹出 Shizuku 授权请求 (需先 running)。 */
    static void requestPermission() {
        try {
            if (!isRunning() || Shizuku.isPreV11()) return;
            if (Shizuku.shouldShowRequestPermissionRationale()) return; // 用户曾拒绝且勾选不再提示
            Shizuku.requestPermission(REQ_CODE);
        } catch (Throwable ignored) {}
    }

    /** 经 Shizuku 以 shell uid 跑命令, 返回 {exit, out}。需 hasPermission()==true。 */
    static String[] exec(String cmd) {
        Process p = null;
        try {
            // Shizuku.newProcess 为受限 API, 用反射调用以跨版本兼容。
            Method m = Shizuku.class.getDeclaredMethod("newProcess", String[].class, String[].class, String.class);
            m.setAccessible(true);
            p = (Process) m.invoke(null, new String[]{"sh", "-c", cmd}, null, null);
            if (p == null) return new String[]{"-1", "newProcess returned null"};
            OutputStream os = p.getOutputStream(); if (os != null) os.close();
            String out = readAll(p.getInputStream());
            String err = readAll(p.getErrorStream());
            int code = p.waitFor();
            String combined = (out == null ? "" : out) + ((err != null && !err.isEmpty()) ? ("\n" + err) : "");
            return new String[]{String.valueOf(code), combined.trim()};
        } catch (Throwable t) {
            return new String[]{"-1", String.valueOf(t.getMessage())};
        } finally { if (p != null) try { p.destroy(); } catch (Throwable ignored) {} }
    }

    private static String readAll(InputStream is) {
        if (is == null) return "";
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] b = new byte[4096]; int n; while ((n = is.read(b)) > 0) bos.write(b, 0, n);
            is.close(); return bos.toString("UTF-8");
        } catch (Throwable t) { return ""; }
    }

    /**
     * 用 Shizuku 自我授予一切可自动开的权限:
     *  - MANAGE_EXTERNAL_STORAGE (appops, 全文件访问)
     *  - 危险运行时权限 (pm grant: 联系人/短信/通话记录/电话/相册/通知)
     *  - 无障碍服务 (settings put secure, 免去手动跳设置)
     * 返回每步结果汇总 (供 UI 显示)。
     */
    static String grantAll(Context ctx) {
        if (!hasPermission()) return "Shizuku 未授权, 无法自动授权";
        String pkg = ctx.getPackageName();
        StringBuilder sb = new StringBuilder();

        // 1) 全文件访问
        step(sb, "全文件访问", "appops set " + pkg + " MANAGE_EXTERNAL_STORAGE allow");

        // 2) 运行时危险权限
        String[] perms = {
            "android.permission.READ_CONTACTS", "android.permission.READ_SMS",
            "android.permission.READ_CALL_LOG", "android.permission.READ_PHONE_STATE",
            "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE",
            "android.permission.POST_NOTIFICATIONS"
        };
        for (String pm : perms) step(sb, pm.substring(pm.lastIndexOf('.') + 1), "pm grant " + pkg + " " + pm);

        // 3) 无障碍服务: 追加到 secure 设置 (保留已有, 避免覆盖其它无障碍 App)
        String svc = pkg + "/" + pkg + ".RtAccessibilityService";
        String[] cur = exec("settings get secure enabled_accessibility_services");
        String existing = (cur != null && cur.length > 1 && cur[1] != null) ? cur[1].trim() : "";
        if (existing.equals("null")) existing = "";
        String target;
        if (existing.isEmpty()) target = svc;
        else if (existing.contains(svc)) target = existing;
        else target = existing + ":" + svc;
        step(sb, "无障碍服务", "settings put secure enabled_accessibility_services " + target);
        step(sb, "无障碍开关", "settings put secure accessibility_enabled 1");

        return sb.toString().trim();
    }

    private static void step(StringBuilder sb, String label, String cmd) {
        String[] r = exec(cmd);
        boolean ok = r != null && "0".equals(r[0]);
        sb.append(ok ? "✓ " : "✗ ").append(label);
        if (!ok && r != null && r.length > 1 && r[1] != null && !r[1].isEmpty())
            sb.append(" (").append(r[1].length() > 60 ? r[1].substring(0, 60) : r[1]).append(")");
        sb.append("\n");
    }
}
