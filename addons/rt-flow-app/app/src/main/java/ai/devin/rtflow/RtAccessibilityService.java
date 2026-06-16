package ai.devin.rtflow;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.util.List;

/**
 * 系统级接管服务 (无需 root)。
 * 提供跨 app 手势注入 / 全局操作 / 读屏 / 按文字点击 / 文本输入 / 全屏截图。
 * 需用户在「设置 → 无障碍」中手动开启一次。
 * 同进程通过静态引用 sInstance 供 RelayService / MainActivity 调用。
 */
public class RtAccessibilityService extends AccessibilityService {

    public static volatile RtAccessibilityService sInstance;

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { /* 无需逐事件处理 */ }

    @Override
    public void onInterrupt() { }

    @Override
    public void onDestroy() {
        sInstance = null;
        super.onDestroy();
    }

    /** 是否已连接 (服务已开启) */
    public static boolean isReady() { return sInstance != null; }

    // ── 手势注入 ──────────────────────────────────────────

    /** 单点点击 (x,y 像素坐标) */
    public boolean tap(int x, int y) {
        Path p = new Path();
        p.moveTo(x, y);
        return dispatch(p, 0, 60);
    }

    /** 长按 */
    public boolean longPress(int x, int y, int durationMs) {
        Path p = new Path();
        p.moveTo(x, y);
        return dispatch(p, 0, durationMs > 0 ? durationMs : 600);
    }

    /** 滑动 */
    public boolean swipe(int x1, int y1, int x2, int y2, int durationMs) {
        Path p = new Path();
        p.moveTo(x1, y1);
        p.lineTo(x2, y2);
        return dispatch(p, 0, durationMs > 0 ? durationMs : 300);
    }

    private boolean dispatch(Path path, long startTime, int duration) {
        try {
            GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, startTime, duration);
            GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
            return dispatchGesture(gesture, null, null);
        } catch (Exception e) { return false; }
    }

    // ── 全局操作 ──────────────────────────────────────────

    /** back/home/recents/notifications/quicksettings/lockscreen/powerdialog/screenshot */
    public boolean globalAction(String action) {
        try {
            int a;
            switch (action == null ? "" : action.toLowerCase()) {
                case "back": a = GLOBAL_ACTION_BACK; break;
                case "home": a = GLOBAL_ACTION_HOME; break;
                case "recents": a = GLOBAL_ACTION_RECENTS; break;
                case "notifications": a = GLOBAL_ACTION_NOTIFICATIONS; break;
                case "quicksettings": a = GLOBAL_ACTION_QUICK_SETTINGS; break;
                case "powerdialog": a = GLOBAL_ACTION_POWER_DIALOG; break;
                case "lockscreen":
                    if (Build.VERSION.SDK_INT >= 28) a = GLOBAL_ACTION_LOCK_SCREEN; else return false;
                    break;
                case "screenshot":
                    if (Build.VERSION.SDK_INT >= 28) a = GLOBAL_ACTION_TAKE_SCREENSHOT; else return false;
                    break;
                default: return false;
            }
            return performGlobalAction(a);
        } catch (Exception e) { return false; }
    }

    // ── 读屏: 导出当前界面控件树 ──────────────────────────

    public String dumpScreen() {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return "{\"error\":\"无活动窗口\"}";
            StringBuilder sb = new StringBuilder();
            sb.append("[");
            int[] count = {0};
            dumpNode(root, sb, count, 0, 600);
            sb.append("]");
            return sb.toString();
        } catch (Exception e) { return "{\"error\":" + JSONObject.quote(String.valueOf(e)) + "}"; }
    }

    private void dumpNode(AccessibilityNodeInfo node, StringBuilder sb, int[] count, int depth, int max) {
        if (node == null || count[0] >= max) return;
        try {
            CharSequence text = node.getText();
            CharSequence desc = node.getContentDescription();
            boolean hasText = (text != null && text.length() > 0);
            boolean hasDesc = (desc != null && desc.length() > 0);
            boolean clickable = node.isClickable();
            boolean editable = node.isEditable();
            // 仅收录有意义的节点 (有文本/描述/可点击/可编辑)
            if (hasText || hasDesc || clickable || editable) {
                android.graphics.Rect r = new android.graphics.Rect();
                node.getBoundsInScreen(r);
                if (count[0] > 0) sb.append(",");
                sb.append("{\"text\":").append(JSONObject.quote(hasText ? text.toString() : ""))
                  .append(",\"desc\":").append(JSONObject.quote(hasDesc ? desc.toString() : ""))
                  .append(",\"class\":").append(JSONObject.quote(node.getClassName() == null ? "" : node.getClassName().toString()))
                  .append(",\"clickable\":").append(clickable)
                  .append(",\"editable\":").append(editable)
                  .append(",\"cx\":").append(r.centerX())
                  .append(",\"cy\":").append(r.centerY())
                  .append(",\"bounds\":\"").append(r.left).append(",").append(r.top).append(",").append(r.right).append(",").append(r.bottom).append("\"")
                  .append("}");
                count[0]++;
            }
            for (int i = 0; i < node.getChildCount(); i++) {
                dumpNode(node.getChild(i), sb, count, depth + 1, max);
            }
        } catch (Exception ignored) {}
    }

    // ── 按文字查找并点击 ──────────────────────────────────

    public boolean clickText(String text) {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null || text == null) return false;
            List<AccessibilityNodeInfo> matches = root.findAccessibilityNodeInfosByText(text);
            if (matches == null || matches.isEmpty()) return false;
            for (AccessibilityNodeInfo n : matches) {
                AccessibilityNodeInfo target = n;
                // 向上找可点击祖先
                while (target != null && !target.isClickable()) target = target.getParent();
                if (target != null) {
                    boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    if (ok) return true;
                }
            }
            // 退而求其次: 点第一个匹配节点的中心坐标
            android.graphics.Rect r = new android.graphics.Rect();
            matches.get(0).getBoundsInScreen(r);
            return tap(r.centerX(), r.centerY());
        } catch (Exception e) { return false; }
    }

    // ── 文本输入: 向当前焦点可编辑控件填字 ────────────────

    public boolean inputText(String text) {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return false;
            AccessibilityNodeInfo focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focus == null || !focus.isEditable()) return false;
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text == null ? "" : text);
            return focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        } catch (Exception e) { return false; }
    }

    // ── 全屏截图 (API 30+, 无需 MediaProjection 弹窗) ─────

    public String takeScreenshotBase64() {
        if (Build.VERSION.SDK_INT < 30) return "{\"error\":\"需 Android 11+ (API30)\"}";
        final String[] out = {null};
        final Object lock = new Object();
        try {
            takeScreenshot(android.view.Display.DEFAULT_DISPLAY,
                getApplicationContext().getMainExecutor(),
                new TakeScreenshotCallback() {
                    @Override public void onSuccess(ScreenshotResult screenshot) {
                        try {
                            android.graphics.Bitmap bmp = android.graphics.Bitmap.wrapHardwareBuffer(
                                screenshot.getHardwareBuffer(), screenshot.getColorSpace());
                            if (bmp != null) {
                                android.graphics.Bitmap soft = bmp.copy(android.graphics.Bitmap.Config.ARGB_8888, false);
                                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                                soft.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, bos);
                                out[0] = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
                                soft.recycle();
                            }
                            screenshot.getHardwareBuffer().close();
                        } catch (Exception ignored) {}
                        synchronized (lock) { lock.notifyAll(); }
                    }
                    @Override public void onFailure(int errorCode) {
                        synchronized (lock) { lock.notifyAll(); }
                    }
                });
            synchronized (lock) { lock.wait(5000); }
        } catch (Exception e) { return "{\"error\":" + JSONObject.quote(String.valueOf(e)) + "}"; }
        return out[0] != null ? out[0] : "{\"error\":\"截图失败\"}";
    }
}
