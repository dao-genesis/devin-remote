package ai.devin.rtflow;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebSettings;

import androidx.annotation.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;

/**
 * RelayService · 常驻前台服务, 宿主一个无界面 engine WebView 跑 JS 引擎 (relay 客户端 + 25 RPC)。
 * 内网穿透常驻于此; 息屏/退后台不断线。业务逻辑全在 WebView 的 JS 里 → 可隔隧道热修。
 */
public class RelayService extends Service {
    public static final String CH = "rtflow-relay";
    public static volatile String lastStatus = "{\"connected\":false}";
    public static volatile RelayService instance;

    private WebView engine;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // 恢复远程操控开关状态
        String flag = readUserFile("remote-ops-flag");
        remoteOpsEnabled = "1".equals(flag);
        startForeground(1, buildNotification("内网穿透服务启动中…"));
        main.post(this::initEngine);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void initEngine() {
        engine = new WebView(this);
        WebSettings s = engine.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true); // 让 file:// 引擎页跨域 fetch Devin API (无 CORS 阻断)
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        engine.addJavascriptInterface(new Bridge(), "Native");
        engine.loadUrl("file:///android_asset/engine/engine.html");
        engine.resumeTimers();
    }

    /** 远程操控安全开关 (默认关, 需在穿透面板手动启用) */
    public static volatile boolean remoteOpsEnabled = false;

    /** JS ↔ 原生桥 (引擎页用 window.Native.*) */
    public class Bridge {
        @JavascriptInterface public String getConn() {
            // 动态配置优先 (用户在切号面板填写), 无则回退 conn.json 资源
            String dyn = readUserFile("relay-config.json");
            return (dyn != null && !dyn.isEmpty() && dyn.length() > 5) ? dyn : readAsset("engine/conn.json");
        }
        @JavascriptInterface public void onStatus(String json) {
            lastStatus = json == null ? "{}" : json;
            Intent i = new Intent("ai.devin.rtflow.STATUS").setPackage(getPackageName()).putExtra("status", lastStatus);
            sendBroadcast(i);
            main.post(() -> { try { startForeground(1, buildNotification(statusLine(lastStatus))); } catch (Exception e) {} });
        }
        @JavascriptInterface public void openTab(String url, String accountJson) {
            Intent i = new Intent(RelayService.this, TabActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK | Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                    .putExtra("url", url).putExtra("account", accountJson);
            startActivity(i);
        }
        @JavascriptInterface public String listTabs() { return TabActivity.listJson(); }
        @JavascriptInterface public void closeTab(int tabId) { TabActivity.closeById(tabId); }
        @JavascriptInterface public void writeFile(String name, String content) { writeUserFile(name, content); }
        @JavascriptInterface public String readFile(String name) { return readUserFile(name); }
        @JavascriptInterface public void reload() { main.post(() -> { if (engine != null) engine.reload(); }); }
        @JavascriptInterface public void log(String s) { android.util.Log.i("RTFlowEngine", s == null ? "" : s); }
        /** 原生 HTTP (无 CORS, 可设 Origin/Referer) — 登录/额度/会话/Git 的底座; 结果经 window.__httpCb 回灌。 */
        @JavascriptInterface public void httpReq(String reqId, String method, String url, String headersJson, String body) {
            HttpBridge.exec(reqId, method, url, headersJson, body, (id, json) ->
                main.post(() -> { if (engine != null) try {
                    engine.evaluateJavascript("window.__httpCb&&window.__httpCb(" + HttpBridge.jsonStr(id) + "," + json + ")", null);
                } catch (Exception ignored) {} }));
        }

        // ── 远程操控 IPC (经 MainActivity.sInstance 驱动前台 WebView) ──────────

        @JavascriptInterface public boolean isRemoteOpsEnabled() { return remoteOpsEnabled; }
        @JavascriptInterface public void setRemoteOps(boolean on) { remoteOpsEnabled = on; writeUserFile("remote-ops-flag", on ? "1" : "0"); }

        @JavascriptInterface public String browseListTabs() {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "[]";
            final String[] r = {""};
            try { m.runOnUiThread(() -> { r[0] = m.ipcListTabs(); synchronized(r){r.notifyAll();} });
                synchronized(r){ r.wait(3000); } } catch (Exception e) {}
            return r[0].isEmpty() ? "[]" : r[0];
        }

        @JavascriptInterface public String browseExecJs(int tabIndex, String js) {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "null";
            final String[] r = {"null"};
            try { m.runOnUiThread(() -> m.ipcExecJs(tabIndex, js, v -> { r[0] = v; synchronized(r){r.notifyAll();} }));
                synchronized(r){ r.wait(5000); } } catch (Exception e) {}
            return r[0];
        }

        @JavascriptInterface public void browseNavigate(int tabIndex, String action, String url) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcNavigate(tabIndex, action, url));
        }

        @JavascriptInterface public String browseScreenshot(int tabIndex) {
            if (!remoteOpsEnabled) return "";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "";
            final String[] r = {""};
            try { m.runOnUiThread(() -> { r[0] = m.ipcScreenshot(tabIndex); synchronized(r){r.notifyAll();} });
                synchronized(r){ r.wait(5000); } } catch (Exception e) {}
            return r[0];
        }

        @JavascriptInterface public String browseGetCookies(String url) {
            if (!remoteOpsEnabled) return "";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "";
            return m.ipcGetCookies(url);
        }

        @JavascriptInterface public void browseOpenTab(String url, String accountJson) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.ipcOpenTab(url, accountJson);
        }

        @JavascriptInterface public void browseCloseTab(int tabIndex) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.ipcCloseTab(tabIndex);
        }

        // ── 手机本体操控 (文件/相册/剪贴板/通知/分享/应用) ──────────

        @JavascriptInterface public String phoneDeviceInfo() {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcDeviceInfo() : "{}";
        }

        @JavascriptInterface public String phoneListFiles(String dir) {
            if (!remoteOpsEnabled) return "[]";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcListFiles(dir) : "[]";
        }

        @JavascriptInterface public String phoneReadFile(String path, boolean base64) {
            if (!remoteOpsEnabled) return "";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcReadFile(path, base64) : "";
        }

        @JavascriptInterface public boolean phoneWriteFile(String path, String content) {
            if (!remoteOpsEnabled) return false;
            MainActivity m = MainActivity.sInstance;
            return m != null && m.ipcWriteFile(path, content);
        }

        @JavascriptInterface public String phoneListPhotos(int limit) {
            if (!remoteOpsEnabled) return "[]";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "[]";
            final String[] r = {"[]"};
            try { m.runOnUiThread(() -> { r[0] = m.ipcListPhotos(limit); synchronized(r){r.notifyAll();} });
                synchronized(r){ r.wait(5000); } } catch (Exception e) {}
            return r[0];
        }

        @JavascriptInterface public String phoneClipboardGet() {
            if (!remoteOpsEnabled) return "";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcGetClipboard() : "";
        }

        @JavascriptInterface public void phoneClipboardSet(String text) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcSetClipboard(text));
        }

        @JavascriptInterface public void phoneShare(String text, String title) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcShare(text, title));
        }

        @JavascriptInterface public void phoneNotify(String title, String text) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcNotify(title, text));
        }

        @JavascriptInterface public String phoneInstalledApps() {
            if (!remoteOpsEnabled) return "[]";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcInstalledApps() : "[]";
        }

        @JavascriptInterface public boolean phoneLaunchApp(String pkg) {
            if (!remoteOpsEnabled) return false;
            MainActivity m = MainActivity.sInstance;
            if (m == null) return false;
            final boolean[] r = {false};
            try { m.runOnUiThread(() -> { r[0] = m.ipcLaunchApp(pkg); synchronized(r){r.notifyAll();} });
                synchronized(r){ r.wait(3000); } } catch (Exception e) {}
            return r[0];
        }

        @JavascriptInterface public String readAssetFile(String path) {
            return readAsset(path);
        }

        // ── 敏感数据: 联系人/短信/通话记录 (需运行时权限, 受 remoteOps 门禁) ──────────
        @JavascriptInterface public void phoneRequestPerms() {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcRequestPhonePerms());
        }
        @JavascriptInterface public boolean phoneHasPerm(String perm) {
            MainActivity m = MainActivity.sInstance;
            return m != null && m.ipcHasPerm(perm);
        }
        @JavascriptInterface public String phoneContacts(int limit) {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcContacts(limit) : "[]";
        }
        @JavascriptInterface public String phoneSmsInbox(int limit) {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcSmsInbox(limit) : "[]";
        }
        @JavascriptInterface public String phoneCallLog(int limit) {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.ipcCallLog(limit) : "[]";
        }

        // ── 高级手机操控: 电池/WiFi/振动/音量 ──────────
        @JavascriptInterface public String phoneBattery() {
            if (!remoteOpsEnabled) return "{}";
            try {
                android.content.Intent bs = RelayService.this.registerReceiver(null,
                    new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
                if (bs == null) return "{}";
                int level = bs.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
                int scale = bs.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1);
                int status = bs.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1);
                int pct = (level >= 0 && scale > 0) ? (level * 100 / scale) : -1;
                boolean charging = (status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                                    status == android.os.BatteryManager.BATTERY_STATUS_FULL);
                return "{\"percent\":" + pct + ",\"charging\":" + charging + ",\"status\":" + status + "}";
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface public String phoneWifiInfo() {
            if (!remoteOpsEnabled) return "{}";
            try {
                android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager)
                    RelayService.this.getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);
                if (wm == null) return "{}";
                android.net.wifi.WifiInfo wi = wm.getConnectionInfo();
                if (wi == null) return "{\"enabled\":" + wm.isWifiEnabled() + "}";
                return "{\"enabled\":" + wm.isWifiEnabled() + ",\"ssid\":" + org.json.JSONObject.quote(wi.getSSID()) +
                    ",\"rssi\":" + wi.getRssi() + ",\"linkSpeed\":" + wi.getLinkSpeed() +
                    ",\"ip\":\"" + android.text.format.Formatter.formatIpAddress(wi.getIpAddress()) + "\"}";
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface public void phoneVibrate(int ms) {
            if (!remoteOpsEnabled) return;
            try {
                android.os.Vibrator v = (android.os.Vibrator) RelayService.this.getSystemService(android.content.Context.VIBRATOR_SERVICE);
                if (v != null) {
                    if (Build.VERSION.SDK_INT >= 26) v.vibrate(android.os.VibrationEffect.createOneShot(ms > 0 ? ms : 200, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                    else v.vibrate(ms > 0 ? ms : 200);
                }
            } catch (Exception e) {}
        }

        @JavascriptInterface public int phoneGetVolume() {
            try {
                android.media.AudioManager am = (android.media.AudioManager) RelayService.this.getSystemService(android.content.Context.AUDIO_SERVICE);
                return am != null ? am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC) : 0;
            } catch (Exception e) { return 0; }
        }
        @JavascriptInterface public int phoneGetMaxVolume() {
            try {
                android.media.AudioManager am = (android.media.AudioManager) RelayService.this.getSystemService(android.content.Context.AUDIO_SERVICE);
                return am != null ? am.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC) : 15;
            } catch (Exception e) { return 15; }
        }
        @JavascriptInterface public void phoneSetVolume(int vol) {
            if (!remoteOpsEnabled) return;
            try {
                android.media.AudioManager am = (android.media.AudioManager) RelayService.this.getSystemService(android.content.Context.AUDIO_SERVICE);
                if (am != null) am.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, vol, 0);
            } catch (Exception e) {}
        }
    }

    private static String statusLine(String json) {
        boolean conn = json != null && json.contains("\"connected\":true");
        return conn ? "🟢 内网穿透已连接 · 可远程接入" : "🟡 内网穿透连接中…";
    }

    private Notification buildNotification(String text) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH, "Devin Cloud 穿透", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26) ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        return b.setContentTitle("Devin Cloud 手机版")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private String readAsset(String path) {
        try (InputStream is = getAssets().open(path)) { return slurp(is); }
        catch (Exception e) { return "{}"; }
    }
    /** 供浏览器外壳内部页 (Native.conn) 读取中继配置 (动态优先, conn.json 兜底)。 */
    public String readConn() {
        String dyn = readUserFile("relay-config.json");
        return (dyn != null && !dyn.isEmpty() && dyn.length() > 5) ? dyn : readAsset("engine/conn.json");
    }
    /** 供 MainActivity 浏览器桥写入动态穿透配置 */
    public void saveRelayConfig(String json) { writeUserFile("relay-config.json", json); }
    private void writeUserFile(String name, String content) {
        try { File f = new File(getFilesDir(), safe(name)); java.io.FileOutputStream o = new java.io.FileOutputStream(f); o.write(content.getBytes("UTF-8")); o.close(); }
        catch (Exception e) { android.util.Log.e("RTFlow", "write " + e); }
    }
    private String readUserFile(String name) {
        try { File f = new File(getFilesDir(), safe(name)); if (!f.exists()) return ""; java.io.FileInputStream i = new java.io.FileInputStream(f); String r = slurp(i); i.close(); return r; }
        catch (Exception e) { return ""; }
    }
    private static String safe(String n) { return n == null ? "x" : n.replaceAll("[^A-Za-z0-9_.-]", "_"); }
    private static String slurp(InputStream is) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n); return bo.toString("UTF-8");
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { instance = null; if (engine != null) { engine.destroy(); engine = null; } super.onDestroy(); }
}
