package ai.devin.rtflow;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.DragEvent;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * MainActivity · Devin Cloud 手机版浏览器外壳 (地址栏 + 多标签 + 内部页)。
 *   - 内部页 rtflow://switch (切号·复用桌面版真前端) / rtflow://tunnel (公网穿透·复用 dao-bridge 真前端)
 *   - 账号标签: 每个标签是独立 WebView, document_start 注入各自 auth1 鉴权头 + sessionStorage 隔离 = 多实例并行互不干扰
 *   - 常驻前台服务 (RelayService) 跑引擎 + 内网穿透; 浏览器外壳与引擎共享 file:// 同源 localStorage 账号库
 */
public class MainActivity extends AppCompatActivity {

    /** 静态实例引用 — 供 RelayService (同进程) IPC 驱动前台 WebView 标签 */
    public static volatile MainActivity sInstance;

    static final String SWITCH = "rtflow://switch";
    static final String TUNNEL = "rtflow://tunnel";
    static final String CLOUD = "rtflow://cloud";
    static final String VPN = "rtflow://vpn";
    static final String SCRIPTS = "rtflow://scripts";
    static final String SHIZUKU = "rtflow://shizuku";
    static final String DAOPAN = "rtflow://daopan";
    static final String DEVIN = "https://app.devin.ai/";
    private static final String SW_URL = "file:///android_asset/engine/switch.html";
    private static final String TU_URL = "file:///android_asset/engine/tunnel.html";
    private static final String CL_URL = "file:///android_asset/engine/cloud.html";
    private static final String VPN_URL = "file:///android_asset/engine/vpn.html";
    private static final String SCR_URL = "file:///android_asset/engine/userscripts.html";
    private static final String SHZ_URL = "file:///android_asset/engine/shizuku.html";
    private static final String DP_URL = "file:///android_asset/engine/daopan.html";

    // 搜索引擎 (国内环境可切百度) — 持久化于 SharedPreferences
    private static final String PREF_SEARCH = "search_engine";
    // 顶部页签每号实时美金 (id / 小写 email → "$X") — 持久化键: 进程被杀/重建/标签恢复后即时回显, 不必等引擎重探
    private static final String PREF_TAB_DOLLARS = "tabDollars";
    // 账号标签实时状态: accountId → {convName, status}  (由切号面板追踪轮询经 Native.setTabStatus 推送)
    private static final java.util.Map<String, String[]> sTabStatus = new java.util.concurrent.ConcurrentHashMap<>();
    // 账号标签实时剩余美金: accountId/email → "$5"  (由切号面板 render() 随额度刷新经 Native.setTabDollars 推送, 显示在状态点左侧)
    private static final java.util.Map<String, String> sTabDollars = new java.util.concurrent.ConcurrentHashMap<>();

    private final Handler main = new Handler(Looper.getMainLooper());
    // 后台单线程 I/O: 标签持久化的外存写盘移出主线程 → 翻页/路由切换不再卡顿。
    private final java.util.concurrent.ExecutorService ioExec = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final Runnable saveTabsTask = this::saveTabsNow;
    private final List<Tab> tabs = new ArrayList<>();
    private int active = -1;
    private static final String PREFS = "rtflow_tabs";

    private int pageZoom = 100;           // 整页缩放百分比 (滑块控制, 解决长页点不到按钮)
    private TextView zoomLabel;
    private ValueCallback<Uri[]> filePathCallback;
    private View fsCustomView = null;                        // 视频全屏承接 (onShowCustomView)
    private WebChromeClient.CustomViewCallback fsCallback = null;
    private Uri cameraOutputUri;          // 网页上传时相机拍照的落地 Uri (FileProvider)
    private androidx.activity.result.ActivityResultLauncher<Intent> fileChooser;
    private androidx.activity.result.ActivityResultLauncher<Intent> shareImportPicker;  // 选「整机分享包」zip

    private FrameLayout content;
    private FrameLayout autoHost;   // 常驻·满屏·INVISIBLE 容器: 停泊非活动标签 WebView, 使其保持挂载窗口+有尺寸
                                    // (否则后台标签 detached → evaluateJavascript 回调不触发、draw() 截不到图)
    private LinearLayout tabStripRow;
    private HorizontalScrollView tabStrip;   // 标签条横向滚动容器 (拖到边缘自动横滚需引用它)
    private int tabDragScrollDir = 0;        // 拖拽中边缘自动滚动方向: -1 左 / +1 右 / 0 停
    private boolean tabDragScrolling = false;
    private EditText addr;
    private Button dlBtn;
    private Button daoBtn;
    private Button starBtn;
    private LinearLayout toolRow;          // 第二行(缩放滑块 + 动作键组): 可收缩, 默认展开
    private Button toolToggle;             // 第一行下拉开关: 点一下收起/展开第二行 (省空间·用不到时收起)
    private boolean toolRowExpanded = true;
    private FrameLayout dlPanel;
    private LinearLayout dlListCol;
    private FrameLayout daoPanel;          // 全服通悬浮窗 (近期对话 / 备份网页端) — 建一次后保活, 开关只切显隐
    private WebView daoWeb;
    private boolean daoOpen = false;       // 全服通悬浮窗逻辑可见态 (面板/WebView 常驻, 故不能用 daoPanel!=null 判断)
    private volatile String sEngineCache = null;
    private volatile String curProxy = null;   // 已应用到内置浏览器(全部 WebView)的本地代理 host:port; null=直连
    private final java.util.Map<Long, String[]> dlPending = new java.util.concurrent.ConcurrentHashMap<>();
    private android.content.BroadcastReceiver dlReceiver;
    private volatile String dragDlPath = null;   // 正在从下载列表拖拽的文件 (拖到页面 → 注入上传/拖放区)
    private volatile String dragDlMime = null;
    private volatile int dragTabIdx = -1;        // 正在拖拽的标签序号 (拖到另一页面 → 提取该对话并导入两个 md)
    private volatile String dragConvAccJson = null; // 全服通近期对话拖拽: 该对话所属账号 (含 email/密码/org → 引擎取数+指引md)
    private volatile String dragConvSid = null;     // 全服通近期对话拖拽: 该对话 sid
    private volatile WebView convDropTarget = null; // 对话拖入的目标页 (提取完成后注入)
    private volatile float convDropX = 0, convDropY = 0;
    private volatile String convDropAccountJson = null; // 被拖对话标签所属账号 (生成"查看全部文件"指引md)
    // ── 在线自动更新 ──
    static final String UPDATE_MANIFEST = "https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/addons/rt-flow-app/latest.json";
    // 去中心化更新: 多镜像源轮询 (任一可达即可检查/下载, 不依赖单一服务器或穿透通道)。
    // GitHub raw + jsDelivr/Fastly/Statically CDN + ghproxy 反代 — 覆盖国内外网络。
    static final String[] UPDATE_MIRRORS = {
        "https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/addons/rt-flow-app/latest.json",
        "https://cdn.jsdelivr.net/gh/zhouyoukang1234-spec/devin-remote@main/addons/rt-flow-app/latest.json",
        "https://fastly.jsdelivr.net/gh/zhouyoukang1234-spec/devin-remote@main/addons/rt-flow-app/latest.json",
        "https://cdn.statically.io/gh/zhouyoukang1234-spec/devin-remote/main/addons/rt-flow-app/latest.json",
        "https://ghproxy.net/https://raw.githubusercontent.com/zhouyoukang1234-spec/devin-remote/main/addons/rt-flow-app/latest.json"
    };
    static final String UPDATE_APK_NAME = "DevinCloud-update.apk";   // 更新包固定文件名 (落 app 私有 Download, 据此识别更新下载, 不受进程重建/字段丢失影响)
    private volatile long updateDlId = -1;          // 当前更新下载任务 id (区别于普通网页下载)
    private volatile File updateApkFile = null;     // 更新 APK 落地文件
    private volatile org.json.JSONArray updateUrls = null;   // 本轮更新候选下载源 (多镜像), 某源下到非法包则自动换下一个
    private volatile int updateUrlIdx = 0;          // 当前已用到的候选源下标

    static class Tab {
        WebView web;
        long vid = 0;                 // 稳定标签 id (不随 index 漂移): 联控在场登记·橙色标记·冲突复刻皆据此寻址
        String title = "新标签";
        String url = "";
        String accountJson = null;   // 非空 = 账号标签 (注入鉴权)
        boolean internal = false;    // file:// 内部页 (暴露 Native 桥)
        String titleOverride = null; // 用户双击标签改的对话名 (优先显示·持久化)
        boolean incognito = false;   // 无痕标签: 不记历史/不持久化
        boolean desktop = false;     // 桌面版 UA
        boolean night = false;       // 夜间反色
        boolean translated = false;  // 整页翻译态 (跨页保持)
        boolean lastEditable = false; // 最近一次前台巡检时页面是否「正在交互」: 聚焦可编辑元素(打字) 或 麦克风/语音识别活跃(语音输入)
        long lastEditableTs = 0;     // 上述「正在输入」状态的记录时刻 → 据此避免输入中被探活重载/可见性翻转打断
        long lastTouchTs = 0;        // 最近一次用户在本页触摸(按下/滑动)的时刻 → 滚动/阅读/点麦克风也算「人在交互」, 据此避免破坏性重载打断
        String pendingReloadUrl = null; // 后台标签渲染进程被回收 → 延迟到选中时再重载 (避免多标签同时重载放大内存压力·消除卡死雪崩)
        boolean maybeStale = false;  // 长时间后台返回 → 渲染线程可能被系统冻结(看着正常但点击/下载等失效) → 选中/恢复时探活, 无响应则静默重载
        long lastShownAt = 0;        // 最近一次被选为前台标签的时刻 → 前台内存保洁据此卸载「长时间未访问」的后台普通网页标签
        long loadedAt = 0;           // 最近一次整页加载(onPageStarted)时刻 → V8 堆龄代理; SPA 客户路由不重置堆故不更新
        long lastHeapReclaimAt = 0;  // 最近一次活动标签堆回收重载时刻 → 防抖限频
        androidx.swiperefreshlayout.widget.SwipeRefreshLayout swipe; // 下拉刷新容器
        String auth1 = "";          // 该标签绑定账号的 auth1 token (原生层媒体代取鉴权用)
        String orgId = "";          // 该标签绑定账号的 org id
    }

    // 输入直通(回归本源): IME→编辑器 全部原样放行, 不拦截、不挂起、不改写。
    //   仅对「删除类」调用留一行轻量参数日志(无同步取文·零往返·零延迟), 供 logcat -s DAO_IME 溯源。
    static class GuardedWebView extends WebView {
        GuardedWebView(Context c) { super(c); }
        @Override public android.view.inputmethod.InputConnection onCreateInputConnection(EditorInfo outAttrs) {
            android.view.inputmethod.InputConnection ic = super.onCreateInputConnection(outAttrs);
            if (ic == null) return null;
            return new android.view.inputmethod.InputConnectionWrapper(ic, true) {
                @Override public boolean deleteSurroundingText(int b, int a) {
                    android.util.Log.i("DAO_IME", "del(" + b + "," + a + ")");
                    return super.deleteSurroundingText(b, a);
                }
                @Override public boolean deleteSurroundingTextInCodePoints(int b, int a) {
                    android.util.Log.i("DAO_IME", "del(" + b + "," + a + ",cp)");
                    return super.deleteSurroundingTextInCodePoints(b, a);
                }
                @Override public boolean sendKeyEvent(android.view.KeyEvent e) {
                    if (e != null && e.getAction() == android.view.KeyEvent.ACTION_DOWN
                            && (e.getKeyCode() == android.view.KeyEvent.KEYCODE_DEL || e.getKeyCode() == android.view.KeyEvent.KEYCODE_FORWARD_DEL))
                        android.util.Log.i("DAO_IME", "key(" + e.getKeyCode() + ")");
                    return super.sendKeyEvent(e);
                }
            };
        }
    }
    private boolean adBlock = true;    // 广告/弹窗拦截: 默认内置开启 (无需用户操作·无开关)

    // 道法自然·联控在场登记: 哪台设备(控台 clientId / 手机本体 __phone__)正「看/控」哪张标签(按 vid)。
    // 控台每轮为其当前标签 claim 一次(带心跳 ts); 超 VIEW_TTL 未续期即视为离场。
    // browseListTabs 回传每张标签的 viewers → 控台据此上橙色(他设备在前置)与点数联控设备数。
    static final long VIEW_TTL = 15000;
    private final java.util.concurrent.ConcurrentHashMap<Long, java.util.concurrent.ConcurrentHashMap<String,Long>> tabViewers = new java.util.concurrent.ConcurrentHashMap<>();
    /** 某设备声明「我正看/控标签 vid」(一设备一时只前置一张 → 从其他 vid 移除该 clientId)。 */
    public void ipcClaimView(long vid, String clientId) {
        if (clientId == null || clientId.isEmpty() || vid <= 0) return;
        long now = System.currentTimeMillis();
        tabViewers.computeIfAbsent(vid, k -> new java.util.concurrent.ConcurrentHashMap<>()).put(clientId, now);
        for (java.util.Map.Entry<Long, java.util.concurrent.ConcurrentHashMap<String,Long>> e : tabViewers.entrySet()) {
            if (!e.getKey().equals(vid)) e.getValue().remove(clientId);                       // 一设备仅前置一张
            java.util.Iterator<java.util.Map.Entry<String,Long>> it = e.getValue().entrySet().iterator();
            while (it.hasNext()) if (now - it.next().getValue() > VIEW_TTL) it.remove();        // 顺手清陈
        }
        main.post(this::refreshPresenceIfChanged);   // 云端来看/离场 → 本机标签条橙色在场标记即时同步
    }
    /** 某标签当前在场 viewers 的 JSON 数组 (活动标签总含 __phone__ = 手机本体前置)。 */
    private String viewersJson(long vid, boolean isActive, long now) {
        java.util.ArrayList<String> ids = new java.util.ArrayList<>();
        if (isActive) ids.add("__phone__");
        java.util.concurrent.ConcurrentHashMap<String,Long> m = tabViewers.get(vid);
        if (m != null) for (java.util.Map.Entry<String,Long> e : m.entrySet())
            if (now - e.getValue() <= VIEW_TTL) ids.add(e.getKey());
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < ids.size(); i++) { if (i > 0) sb.append(","); sb.append(JSONObject.quote(ids.get(i))); }
        return sb.append("]").toString();
    }
    /** 某标签当前「其他设备(云端控台, 非手机本体)」在场计数 (按 TTL 过滤)。>0 → 本机标签条上橙色在场标记。 */
    private int coViewerCount(long vid, long now) {
        java.util.concurrent.ConcurrentHashMap<String,Long> m = tabViewers.get(vid);
        if (m == null) return 0;
        int n = 0;
        for (java.util.Map.Entry<String,Long> e : m.entrySet())
            if (now - e.getValue() <= VIEW_TTL) n++;
        return n;
    }
    private String lastPresenceSig = "";
    // ── 标签条重绘: 合并·内容去重·「结构变才重建, 内容变只原地改文案」 (道并行而不相悖) ──
    // 真因(v0.37.20 前): 账号池每轮对上百账号逐个回推 setTabStatus/setTabDollars, 每条都 main.post
    // renderTabStrip(全量 removeAllViews + 逐标签重建手势/监听器) → 几秒一阵 UI 线程风暴, 打断输入。
    // v0.37.20 曾改为「交互中顺延重建」, 但用户持续操作官网时 userInteracting 恒真 → 标签条永不刷新
    // → 额度/状态识别冻结(反成新病). 正解: 把刷新做成「非破坏性原地更新」——
    //   · 结构(开了哪些标签/顺序)未变 → 只对已存在的 chip setText/换色/增删在场角标, 绝不 removeAllViews,
    //     既不夺焦/不打断打字语音, 又即时刷新额度与状态;
    //   · 仅当用户自己开/关/拖动标签(结构变) 才整条重建(本就是用户主动操作)。
    //   · 高频回推仍经内容签名去重(无可见变化直接跳过) + 轻防抖合并(把一轮上百条并成一次原地更新)。
    // 于是「刷新账号」(原地刷文案) 与「操作页面」(输入) 真正并行不相悖, 额度/状态又恒为最新。
    private String lastStripSig = null;     // 内容签名: 任何可见变化
    private String lastStructSig = null;    // 结构签名: 仅标签集合/顺序变化 → 才需整条重建
    private boolean stripRenderPending = false;
    private final Runnable stripRenderTask = new Runnable() {
        @Override public void run() {
            stripRenderPending = false;
            renderTabStrip();   // 重绘已是非破坏性原地更新, 绝不夺焦/打断输入 → 无需顺延, 额度/状态即时刷新
        }
    };
    /** 合并·防抖 重绘标签条: 高频数据推送(账号状态/额度/在场/标题)统一经此, 把一轮上百条并成一次原地更新。 */
    private void scheduleRenderTabStrip() {
        if (stripRenderPending) return;
        stripRenderPending = true;
        main.postDelayed(stripRenderTask, 250);
    }
    /** 标签条内容签名: 活动页 + 各标签(显示文案 chipTitle 含状态点/额度/对话名 + 云端在场数)。仅此变化才需更新。 */
    private String tabStripSig() {
        long now = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder().append(active).append('#');
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            sb.append(chipTitle(t)).append('|').append(coViewerCount(t.vid, now)).append(';');
        }
        return sb.toString();
    }
    /** 标签条结构签名: 仅「开了哪些标签 + 顺序 + 数量」。变化(开/关/拖动标签)才整条重建; 否则原地更新文案/颜色/角标。 */
    private String tabStructSig() {
        StringBuilder sb = new StringBuilder().append(tabs.size()).append('#');
        for (int i = 0; i < tabs.size(); i++) sb.append(System.identityHashCode(tabs.get(i))).append(';');
        return sb.toString();
    }
    /** 非破坏性原地更新: 不 removeAllViews, 只改各 chip 的文案/颜色/在场角标 → 绝不夺焦/打断输入, 且即时刷新额度与状态。 */
    private void updateTabStripInPlace() {
        long now = System.currentTimeMillis();
        for (int i = 0; i < tabs.size(); i++) {
            View cv = tabStripRow.getChildAt(i);
            if (!(cv instanceof LinearLayout)) { lastStructSig = null; renderTabStrip(); return; } // 结构漂移 → 兜底整条重建
            LinearLayout chip = (LinearLayout) cv;
            Tab t = tabs.get(i);
            int coN = coViewerCount(t.vid, now);
            boolean coView = coN > 0;
            boolean isActive = (i == active);
            boolean viewed = isActive || coView;
            chip.setBackgroundColor(viewed ? (isActive ? 0xFF5A3D22 : 0xFF3A2C1B) : 0xFF1B1F26);
            View lv = chip.getChildAt(0);
            if (lv instanceof TextView) {
                ((TextView) lv).setText(chipTitle(t));
                ((TextView) lv).setTextColor(isActive ? 0xFF9CDCFE : (coView ? 0xFFE3A877 : 0xFFAAB2BD));
            }
            // 在场角标 ☁N 增/删/改 也原地处理 (避免在场 TTL 每几秒翻转就整条 removeAllViews 重建 → 退回风暴)。
            boolean hasBadge = chip.getChildCount() == 3;   // [label, co, x]
            if (coView && !hasBadge) {
                TextView co = new TextView(this);
                co.setText(" \u2601" + coN); co.setTextColor(0xFFF0883E);
                co.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10); co.setPadding(dp(3), 0, dp(1), 0);
                chip.addView(co, 1);
            } else if (coView) {
                View bv = chip.getChildAt(1);
                if (bv instanceof TextView) ((TextView) bv).setText(" \u2601" + coN);
            } else if (hasBadge) {
                chip.removeViewAt(1);
            }
        }
    }
    /** 在场签名: 各标签 vid→云端在场数。仅变化才重绘标签条(省电·防抖)。 */
    private String presenceSig() {
        long now = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            int n = coViewerCount(t.vid, now);
            if (n > 0) sb.append(t.vid).append(':').append(n).append(';');
        }
        return sb.toString();
    }
    /** 云端在场变化(claim/离场/TTL过期) → 即时重绘标签条上橙色在场标记。无变化不重绘。 */
    private void refreshPresenceIfChanged() {
        String sig = presenceSig();
        if (sig.equals(lastPresenceSig)) return;
        lastPresenceSig = sig;
        scheduleRenderTabStrip();
    }
    // 前台期间每 3s 巡检在场(覆盖离场/TTL过期, 无对应 RPC 事件), 变化即重绘; 收到 claim 时另立即重绘。
    private final Runnable presenceTick = new Runnable() {
        @Override public void run() {
            refreshPresenceIfChanged();
            if (appForeground) main.postDelayed(this, 3000);
        }
    };

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        sInstance = this;
        // Shizuku 授权结果: 授权成功后自动自我授予一切权限 (存储/无障碍/危险权限)
        try {
            rikka.shizuku.Shizuku.addRequestPermissionResultListener((requestCode, grantResult) -> {
                if (requestCode == ShizukuManager.REQ_CODE && grantResult == PackageManager.PERMISSION_GRANTED) {
                    new Thread(() -> {
                        final String r = ShizukuManager.grantAll(MainActivity.this);
                        main.post(() -> toast("Shizuku 已授权, 已自动授予权限"));
                    }).start();
                }
            });
        } catch (Throwable ignored) {}
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        // 后台保活: 首启动一次性引导申请「电池不优化」豁免 (常驻中继不被 Doze 杀死)。仅提一次, 用户拒绝/已豁免则不再打扰。
        try {
            SharedPreferences kap = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (!KeepAlive.isBatteryOptIgnored(this) && !kap.getBoolean("battopt-asked", false)) {
                kap.edit().putBoolean("battopt-asked", true).apply();
                main.postDelayed(() -> { try { KeepAlive.requestBatteryOpt(this); } catch (Exception ignored) {} }, 1800);
            }
            // 一次性引导授予「显示在其他应用上层」→ 后台/被杀时远程操控可把软件本体唤回前台 (Android 10+ 后台启动 Activity 依赖此权限)。
            if (!KeepAlive.canDrawOverlays(this) && !kap.getBoolean("overlay-asked", false)) {
                kap.edit().putBoolean("overlay-asked", true).apply();
                main.postDelayed(() -> { try { KeepAlive.requestOverlay(this); } catch (Exception ignored) {} }, 3600);
            }
            // 一次性引导「自启动 / 后台白名单」: 国产 ROM 切走就杀后台的真正元凶 (标准电池豁免管不到它,
            // 必须在各厂商「自启动管理」里单独放行)。仅对已知厂商 ROM 提一次, 用户处理过即不再打扰。
            if (KeepAlive.maker() != KeepAlive.Maker.OTHER && !kap.getBoolean("autostart-asked", false)) {
                kap.edit().putBoolean("autostart-asked", true).apply();
                main.postDelayed(() -> { try { showKeepAliveDialog(true); } catch (Exception ignored) {} }, 5400);
            }
        } catch (Exception ignored) {}
        fileChooser = registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> cb = filePathCallback; filePathCallback = null;
            Uri camUri = cameraOutputUri; cameraOutputUri = null;
            if (cb == null) return;
            Uri[] uris = null;
            Intent data = result.getData();
            if (result.getResultCode() == RESULT_OK) {
                if (data != null && data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data != null && data.getData() != null) {
                    uris = new Uri[]{ data.getData() };
                } else if (camUri != null) {
                    // 相机拍照分支: 结果 Intent 无 data, 照片已写入我们预置的 FileProvider Uri
                    uris = new Uri[]{ camUri };
                }
            }
            cb.onReceiveValue(uris);
        });
        shareImportPicker = registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(), result -> {
            if (result.getResultCode() != RESULT_OK || result.getData() == null || result.getData().getData() == null) return;
            importShareBundle(result.getData().getData());
        });
        HttpBridge.appCtx = getApplicationContext();   // 原生 HTTP 的 VPN 自然回退(死 VPN → 底层直连)需要网络服务
        ensureRelayIdentity();   // 去中心化: 设备唯一 session(防卸载) + 每冷启动轮换 token → relay-config.json
        startRelay();
        restoreWebProxy();       // 恢复上次选定的本地代理路由(若代理仍在线), 重启沿用
        refreshSearchEngine();   // 后端自动判定搜索引擎(有VPN且能连Google→Google, 否则→百度)
        // 下载完成广播 → 落入应用内下载管理器
        dlReceiver = new android.content.BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                long id = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id >= 0) onDownloadComplete(id);
            }
        };
        ContextCompat.registerReceiver(this, dlReceiver,
                new android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED);
        // Token 冷启动轮换由 RelayService 引擎页 (engine.html) 在服务冷启动时执行,
        // 该服务为 START_STICKY 前台常驻 → 仅手动重开(进程被杀后重建)时刷新, 后台恢复不刷, 符合预期。
        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);
        setContentView(buildChrome());
        ensureAllFilesAccess();   // 申请「所有文件访问」→ 账号/标签/历史落到共享文件夹, 卸载重装不丢
        restoreDownloads();       // 下载记录: 卸载/重装后从共享保险箱回读 (文件落 Documents/DevinCloud/downloads)
        purgeUpdateRecords();     // 净化历史误记进「下载库」的更新包条目 (旧版遗留, 现一次性清掉)
        resumePendingUpdate();    // 上次更新下载若在 App 被杀时完成 (广播漏收) → 启动时认领并续装
        loadTabDollars();         // 先回读上次页签美金 → 标签恢复即带金额显示, 不闪空白
        // 恢复上次标签 (持久化) 或首屏切号
        if (!restoreTabs()) {
            newTab(SWITCH, null);
        }
        autoCheckUpdate();   // 冷启动静默检查新版 (有则弹一次确认; 安装仍需用户点一次)
    }

    /** 冷启动后台静默检查更新; 有新版则弹一次确认框, 用户点「立即更新」即下载+唤起安装。 */
    private void autoCheckUpdate() { checkUpdate(true); }

    /** 检查更新核心: silent=true 冷启动静默(仅有新版才打扰); silent=false 手动(☰→检查更新)给全程反馈。
     *  有新版 → 弹「发现新版本」确认框; 已最新 → 提示当前版本; 失败 → 提示原因(仅手动)。 */
    private void checkUpdate(boolean silent) {
        if (!silent) toast("检查更新中…");
        new Thread(() -> {
            try {
                String info = fetchUpdateInfo();
                JSONObject j = new JSONObject(info);
                if (!j.optBoolean("ok", false)) {
                    if (!silent) main.post(() -> toast("检查更新失败: " + j.optString("error", "网络不可达")));
                    return;
                }
                if (!j.optBoolean("hasUpdate", false)) {
                    if (!silent) main.post(() -> toast("已是最新版 · v" + appVersionName()));
                    return;
                }
                final String name = j.optString("latestName", "");
                final String notes = j.optString("notes", "");
                org.json.JSONArray urls = j.optJSONArray("urls");
                final String url = (urls != null && urls.length() > 0) ? pickReachable(urls) : j.optString("url", "");
                if (url.isEmpty()) { if (!silent) main.post(() -> toast("新版本暂无可用下载地址")); return; }
                main.post(() -> {
                    if (isFinishing()) return;
                    try {
                        new android.app.AlertDialog.Builder(this)
                            .setTitle("发现新版本 " + name)
                            .setMessage(notes.isEmpty() ? "有可用更新, 是否现在更新?" : notes)
                            .setPositiveButton("立即更新", (d, w) -> enqueueUpdateDownload(url))
                            .setNegativeButton("稍后", null)
                            .show();
                    } catch (Exception ignored) {}
                });
            } catch (Exception e) {
                if (!silent) main.post(() -> toast("检查更新出错: " + e.getMessage()));
            }
        }).start();
    }

    // ── UI 外壳 ────────────────────────────────────────────────────────────
    private View buildChrome() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF0E1116);

        // 顶部地址栏
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xFF161B22);
        int p = dp(6);
        bar.setPadding(p, p, p, p);

        // 菜单≡: 由 chipBtn 默认 minHeight≈48dp 撑得过高 → 改用 chipBtnBar 压到与地址栏等高
        Button menu = chipBtnBar("\u2261");
        ((LinearLayout.LayoutParams) menu.getLayoutParams()).leftMargin = 0;   // 首键贴左, 不留外间隔
        menu.setOnClickListener(this::showMenu);

        addr = new EditText(this);
        addr.setSingleLine(true);
        addr.setHint("输入网址 / 搜索");
        addr.setTextColor(0xFFCDD3DE);
        addr.setHintTextColor(0xFF6E7681);
        addr.setBackgroundColor(0xFF0D1117);
        addr.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        addr.setPadding(dp(10), dp(8), dp(10), dp(8));
        addr.setImeOptions(EditorInfo.IME_ACTION_GO);
        addr.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        alp.leftMargin = dp(6); alp.rightMargin = dp(6);
        addr.setLayoutParams(alp);
        addr.setOnEditorActionListener((v, id, ev) -> {
            if (id == EditorInfo.IME_ACTION_GO || id == EditorInfo.IME_ACTION_DONE) { go(addr.getText().toString()); return true; }
            return false;
        });

        // 整页缩放滑块 (最右上角): 50%–170%, 默认 100%。解决长页/长文件点不到取消按钮 → 缩小即可全览
        TextView zicon = new TextView(this);
        zicon.setText("\uD83D\uDD0D"); zicon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        zicon.setTextColor(0xFF8B949E); zicon.setPadding(dp(2), 0, dp(1), 0);
        SeekBar zoomBar = new SeekBar(this);
        zoomBar.setMax(120); zoomBar.setProgress(pageZoom - 50);   // 0..120 → 50%..170%
        // 用 weight 自适应剩余宽度 → 不再固定过宽, 适配所有屏宽
        LinearLayout.LayoutParams zlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        zlp.leftMargin = dp(2); zlp.rightMargin = dp(2);
        zoomBar.setLayoutParams(zlp);
        zoomLabel = new TextView(this);
        zoomLabel.setText(pageZoom + "%"); zoomLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        zoomLabel.setTextColor(0xFFCDD3DE); zoomLabel.setMinWidth(dp(40)); zoomLabel.setPadding(dp(3), 0, dp(3), 0);
        zoomBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                pageZoom = 50 + p; zoomLabel.setText(pageZoom + "%"); applyZoomActive();
            }
            @Override public void onStartTrackingTouch(SeekBar s) {}
            @Override public void onStopTrackingTouch(SeekBar s) {}
        });
        // 双击缩放图标 → 复位 100%
        zicon.setOnClickListener(v -> { pageZoom = 100; zoomBar.setProgress(50); zoomLabel.setText("100%"); applyZoomActive(); });

        // 前往→: 由过小的 chipBtnSm 改为 chipBtnBar → 放大到与地址栏等高, 突出这个常用键
        Button go = chipBtnBar("\u2192");
        go.setOnClickListener(v -> go(addr.getText().toString()));
        // 导航键(后退/前进/主页)已移入 ≡ → 页面工具收纳菜单 (基本用不到, 收起腾出工具栏空间)
        // 第一行下拉开关 (取代原翻译键位置): 点一下收起/展开第二行(缩放+动作键), 默认展开 → 用不到时收起省空间。
        toolToggle = chipBtnBar("\u25BC");   // ▼ 展开 / ▶ 收起 — 放大到与地址栏等高, 突出此键
        toolToggle.setOnClickListener(v -> toggleToolRow());
        // 网页栏五角星：点击收藏/取消收藏当前页 — 紧凑排布 (5 键紧贴, 占原 4 键宽)
        starBtn = chipBtnPk("\u2606");
        starBtn.setOnClickListener(v -> toggleBookmarkCurrent());
        // 翻译按钮 (由第一行迁入·排第二位·夹在 收藏↔刷新 之间): 一键整页翻译, 再点恢复原文 — 同电脑端 Chrome 体感
        Button tr = chipBtnPk("\u8BD1");
        tr.setOnClickListener(v -> toggleTranslate());
        // 刷新按钮：原地重载当前标签的 WebView（保留多实例登录态）
        Button reload = chipBtnPk("\u21BB");
        reload.setOnClickListener(v -> reloadActive());
        // 下载管理悬浮窗按钮
        dlBtn = chipBtnPk("\uD83D\uDCE5");
        dlBtn.setOnClickListener(v -> toggleDownloadPanel());
        // 全服通悬浮窗按钮: 近期对话(跨号·实时) + 备份网页端
        daoBtn = chipBtnPk("\uD83D\uDDC2");
        daoBtn.setOnClickListener(v -> toggleDaoPanel());

        // 第一行: 菜单 + 地址 + 下拉开关 + 前往
        bar.addView(menu);
        bar.addView(addr);
        bar.addView(toolToggle);
        bar.addView(go);

        // 第二行(可收缩 toolRow): 🔍 + 缩放滑块(weight自适应) + 5 动作键紧贴 [收藏·翻译·刷新·下载·备份]
        toolRow = new LinearLayout(this);
        toolRow.setOrientation(LinearLayout.HORIZONTAL);
        toolRow.setGravity(Gravity.CENTER_VERTICAL);
        toolRow.setBackgroundColor(0xFF161B22);
        toolRow.setPadding(dp(6), dp(1), dp(8), dp(4));
        toolRow.addView(zicon);
        toolRow.addView(zoomBar);
        toolRow.addView(zoomLabel);
        toolRow.addView(starBtn);
        toolRow.addView(tr);
        toolRow.addView(reload);
        toolRow.addView(dlBtn);
        toolRow.addView(daoBtn);

        // 标签条
        HorizontalScrollView strip = new HorizontalScrollView(this);
        strip.setHorizontalScrollBarEnabled(false);
        strip.setBackgroundColor(0xFF0E1116);
        tabStrip = strip;
        tabStripRow = new LinearLayout(this);
        tabStripRow.setOrientation(LinearLayout.HORIZONTAL);
        tabStripRow.setPadding(dp(4), dp(3), dp(4), dp(3));
        strip.addView(tabStripRow);

        content = new FrameLayout(this);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        content.setLayoutParams(clp);

        // 后台标签停泊容器: 满屏 + INVISIBLE (仍挂载窗口·仍被测量布局, 故 WebView JS 回调可触发、可 draw 截图)
        autoHost = new FrameLayout(this);
        autoHost.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        autoHost.setVisibility(android.view.View.INVISIBLE);
        content.addView(autoHost);

        root.addView(bar);
        root.addView(toolRow);
        root.addView(strip);
        root.addView(content);
        return root;
    }

    private Button chipBtn(String t) {
        Button b = new Button(this);
        b.setText(t);
        b.setAllCaps(false);
        b.setTextColor(0xFFCDD3DE);
        b.setBackgroundColor(0xFF21262D);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setPadding(dp(12), dp(4), dp(12), dp(4));
        b.setMinWidth(0); b.setMinimumWidth(0);
        return b;
    }
    // 紧凑按钮 (动作排用): 更小字号/内边距/高度, 整排长方体更短
    private Button chipBtnSm(String t) {
        Button b = chipBtn(t);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setPadding(dp(9), dp(1), dp(9), dp(1));
        b.setMinHeight(0); b.setMinimumHeight(0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }
    // 略放大的动作键 (工具栏右侧 收藏/刷新/下载/全服通) → 更易点
    private Button chipBtnMd(String t) {
        Button b = chipBtn(t);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setPadding(dp(13), dp(3), dp(13), dp(3));
        b.setMinHeight(0); b.setMinimumHeight(0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }
    // 第一行控件 (菜单≡ / 下拉开关▼ / 前往→): 高度对齐地址栏 — 既压低过高的菜单, 又放大过小的两个右键, 省高度又突出常用键
    private Button chipBtnBar(String t) {
        Button b = chipBtn(t);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setPadding(dp(11), dp(7), dp(11), dp(7));
        b.setMinHeight(0); b.setMinimumHeight(0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }
    // 紧凑动作键 (第二行 5 键紧贴排布: 收藏·翻译·刷新·下载·备份) — 高度同 Md, 横向更窄+无间隔, 5 键占原 4 键宽
    private Button chipBtnPk(String t) {
        Button b = chipBtn(t);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setPadding(dp(9), dp(3), dp(9), dp(3));
        b.setMinHeight(0); b.setMinimumHeight(0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = 0;   // 紧贴: 5 键之间无间隔
        b.setLayoutParams(lp);
        return b;
    }
    // 第一行下拉开关: 收起/展开第二行 (缩放滑块 + 动作键组)。默认展开。
    private void toggleToolRow() {
        toolRowExpanded = !toolRowExpanded;
        if (toolRow != null) toolRow.setVisibility(toolRowExpanded ? View.VISIBLE : View.GONE);
        if (toolToggle != null) toolToggle.setText(toolRowExpanded ? "\u25BC" : "\u25B6");  // ▼ 展开 / ▶ 收起
    }
    private void applyZoomActive() {
        if (active < 0 || active >= tabs.size()) return;
        applyZoom(tabs.get(active).web);
    }
    private Tab cur() { return (active >= 0 && active < tabs.size()) ? tabs.get(active) : null; }
    private void applyZoom(WebView w) {
        if (w == null) return;
        float f = pageZoom / 100f;
        try { w.evaluateJavascript("(function(){try{var d=document.documentElement;if(d)d.style.zoom='" + f + "';}catch(e){}})();", null); } catch (Exception ignored) {}
    }

    private void showMenu(View anchor) {
        PopupMenu m = new PopupMenu(this, anchor);
        android.view.Menu mu = m.getMenu();
        mu.add(0, 1, 0, "切号面板");
        mu.add(0, 6, 1, "对话 / Cloud");
        mu.add(0, 2, 2, "公网穿透");
        mu.add(0, 10, 3, "VPN 加速");
        mu.add(0, 3, 4, "新标签 (Devin)");
        mu.add(0, 13, 5, "无痕标签");
        mu.add(0, 9, 7, "浏览历史");
        mu.add(0, 12, 8, "书签收藏");
        mu.add(0, 14, 9, "用户脚本 (油猴)");
        mu.add(0, 15, 10, "Shizuku 权限 (自我 ADB)");
        android.view.SubMenu page = mu.addSubMenu(0, 100, 9, "页面工具");
        page.add(0, 40, 0, "\u25C0 后退");
        page.add(0, 41, 1, "\u25B6 前进");
        page.add(0, 42, 2, "\u2302 主页 (切号面板)");
        page.add(0, 20, 3, "页内查找");
        page.add(0, 21, 4, cur() != null && cur().desktop ? "切回移动版" : "桌面版网站");
        page.add(0, 22, 5, "阅读模式");
        page.add(0, 23, 6, cur() != null && cur().night ? "关闭夜间模式" : "夜间模式");
        page.add(0, 16, 7, "脚本菜单 (油猴)");
        page.add(0, 26, 8, "导出整机分享包 (APK+全部数据)");
        page.add(0, 27, 8, "导入分享包 (换机同步)");
        android.view.SubMenu shareM = mu.addSubMenu(0, 101, 10, "分享 / 快捷");
        shareM.add(0, 30, 0, "分享本页");
        shareM.add(0, 31, 1, "复制网址");
        shareM.add(0, 32, 2, "添加到主屏");
        mu.add(0, 51, 11, "后台常驻 · 保活");
        mu.add(0, 50, 12, "检查更新 · v" + appVersionName());
        m.setOnMenuItemClickListener(it -> {
            switch (it.getItemId()) {
                case 1: newTab(SWITCH, null); return true;
                case 6: newTab(CLOUD, null); return true;
                case 2: newTab(TUNNEL, null); return true;
                case 10: newTab(VPN, null); return true;
                case 3: newTab(DEVIN, null); return true;
                case 13: openIncognito(); return true;
                case 9: showHistory(); return true;
                case 12: showBookmarks(); return true;
                case 14: newTab(SCRIPTS, null); return true;
                case 16: showUserscriptMenu(); return true;
                case 15: newTab(SHIZUKU, null); return true;
                case 40: { Tab t = cur(); if (t != null && t.web.canGoBack()) t.web.goBack(); else toast("无法后退"); return true; }
                case 41: { Tab t = cur(); if (t != null && t.web.canGoForward()) t.web.goForward(); else toast("无法前进"); return true; }
                case 42: newTab(SWITCH, null); return true;
                case 20: case 25: toggleFindBar(); return true;
                case 21: toggleDesktop(); return true;
                case 22: readerMode(); return true;
                case 23: toggleNight(); return true;
                case 26: exportShareBundle(); return true;
                case 27: pickShareBundle(); return true;
                case 30: shareCurrent(); return true;
                case 31: copyCurrentUrl(); return true;
                case 32: addHomeShortcut(); return true;
                case 50: checkUpdate(false); return true;
                case 51: showKeepAliveDialog(false); return true;
            }
            return false;
        });
        m.show();
    }

    /** 后台常驻 · 保活引导: 展示本机机型的保活操作指引 + 一键直达「自启动白名单 / 电池不限制」设置页。
     *  firstRun=true 为冷启动一次性引导 (仅已知厂商 ROM); =false 为用户主动从菜单打开。
     *  本机「切到其他 App 一会就被杀、整页重载」的根因之一即后台白名单未放行 → 这里把开关递到用户面前。 */
    private void showKeepAliveDialog(boolean firstRun) {
        if (isFinishing()) return;
        boolean battOk = KeepAlive.isBatteryOptIgnored(this);
        String head = firstRun
                ? "为避免切到其他 App 后本应用被系统杀死 (整页重载、对话中断), 请按下方为你的机型放行后台常驻:\n\n"
                : "让应用切到后台也不被系统杀死, 按机型放行:\n\n";
        String tail = "\n\n电池优化豁免: " + (battOk ? "已开启 ✓" : "未开启 — 点「电池不限制」");
        try {
            new android.app.AlertDialog.Builder(this)
                    .setTitle("后台常驻 · 保活")
                    .setMessage(head + KeepAlive.instructions() + tail)
                    .setPositiveButton("自启动白名单", (d, w) -> { try { KeepAlive.openAutoStart(this); } catch (Exception ignored) {} })
                    .setNeutralButton("电池不限制", (d, w) -> { try { KeepAlive.requestBatteryOpt(this); } catch (Exception ignored) {} })
                    .setNegativeButton("知道了", null)
                    .show();
        } catch (Exception ignored) {}
    }

    /** 高内存压力下卸载后台普通网页标签: 销毁其重型 WebView, 换一个空壳 + pendingReloadUrl (选中时再重建)。
     *  后台占用骤降 → 整进程更不易被系统 LMK 整体杀掉, 回前台也无需「整页全部重来」。
     *  仅卸载 非活动·非内部页·非 Devin 账号 (多实例追踪需保活) 的 http(s) 标签。镜像 recoverDeadTab 的换壳路径。 */
    private void unloadBackgroundTab(int idx) {
        if (idx < 0 || idx >= tabs.size() || idx == active) return;
        Tab t = tabs.get(idx);
        if (t.internal || t.accountJson != null || t.pendingReloadUrl != null) return;
        String u = (t.url != null && !t.url.isEmpty()) ? t.url : null;
        if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) return;
        boolean incognito = t.incognito, night = t.night;
        String title = t.title, titleOverride = t.titleOverride;
        try {
            android.view.View host = t.swipe != null ? t.swipe : t.web;
            if (host != null && host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
            if (t.web != null) t.web.destroy();
        } catch (Exception ignored) {}
        Tab fresh = makeTab(null, false);     // 空壳 + 完整配置 + 停泊 autoHost; 追加末尾
        tabs.remove(tabs.size() - 1);         // 取回, 放回原位
        fresh.incognito = incognito; fresh.night = night;
        fresh.url = u; fresh.title = title; fresh.titleOverride = titleOverride;
        fresh.pendingReloadUrl = u;           // selectTab 命中即重建
        tabs.set(idx, fresh);
    }

    /** 卸载长时间闲置的后台 Devin 账号标签 —— 「用久了越卡」最深一层根因的归一收口。
     *  病根: Devin 是常驻重型 SPA, 其 WebView 的 V8 堆 + (含已脱离的) DOM 随长会话只增不减; 而 account 标签
     *  此前被排除在唯一能真正回收这部分占用的「整页卸载」之外(unloadBackgroundTab 跳过 accountJson!=null) ——
     *  施于它的 clearCache(false)/freeMemory 只清 RAM 缓存, 回收不了 V8 堆与脱离 DOM。多实例多账号各开一张
     *  长生 Devin SPA → 数小时后这些重页主导占用 → GC 抖动/合成卡顿越用越重, 转后台亦不解(后台也只清缓存不卸载) →
     *  唯有彻底杀进程重开才清零, 正是用户所述顽疾。修法: 闲置足够久且无人联控观看的后台账号标签也整页卸载换空壳,
     *  保留 accountJson → 选中时 makeTab 的 document-start 注入按原账号重注 auth1、自动重登重建, 占用真正还给系统 →
     *  账号标签占用亦恒有界。安全护栏: 仅 非活动 · 账号标签 · 有可重载 http(s) · 且无联控在场观看者(不打断正被远程
     *  观看/驱动的实例)。阈值取得比普通网页更宽(账号标签更金贵), 仅在保洁周期触发。 */
    private void unloadIdleAccountTab(int idx) {
        if (idx < 0 || idx >= tabs.size() || idx == active) return;
        Tab t = tabs.get(idx);
        if (t.internal || t.accountJson == null || t.pendingReloadUrl != null) return;
        String u = (t.url != null && !t.url.isEmpty()) ? t.url : null;
        if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) return;
        java.util.concurrent.ConcurrentHashMap<String,Long> vw = tabViewers.get(t.vid);
        if (vw != null && !vw.isEmpty()) return;   // 正被联控观看/驱动 → 不卸载 (不打断远程实时操作)
        boolean incognito = t.incognito, night = t.night;
        String title = t.title, titleOverride = t.titleOverride, acct = t.accountJson;
        long vid = t.vid, shownAt = t.lastShownAt;
        try {
            android.view.View host = t.swipe != null ? t.swipe : t.web;
            if (host != null && host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
            if (t.web != null) t.web.destroy();
        } catch (Exception ignored) {}
        Tab fresh = makeTab(acct, false);     // 保留 accountJson → document-start 注入按原账号重注 auth1, 重建即自动重登
        tabs.remove(tabs.size() - 1);
        fresh.incognito = incognito; fresh.night = night; fresh.vid = vid;   // 保留 vid → 联控/在场寻址连续
        fresh.url = u; fresh.title = title; fresh.titleOverride = titleOverride; fresh.lastShownAt = shownAt;
        fresh.pendingReloadUrl = u;           // selectTab 命中即按原账号重注鉴权重建
        tabs.set(idx, fresh);
    }

    private void go(String input) {
        if (input == null) return;
        String s = input.trim();
        if (s.isEmpty()) return;
        String url;
        if (s.equals("切号") || s.equalsIgnoreCase("switch")) url = SWITCH;
        else if (s.equals("穿透") || s.equalsIgnoreCase("tunnel")) url = TUNNEL;
        else if (s.matches("(?i)^[a-z][a-z0-9+.\\-]*://.*")) url = s;
        else if (s.contains(".") && !s.contains(" ")) url = "https://" + s;
        else url = searchUrl(s);
        navigate(url);
    }

    // 搜索引擎后端自动判定: 有 VPN 且能连 Google → Google; 否则 → 百度。结果由后台线程刷新缓存, 不阻主线。
    private String searchEngine() {
        if (sEngineCache != null) return sEngineCache;
        return hasActiveVpn() ? "google" : "baidu";
    }
    private void refreshSearchEngine() {
        new Thread(() -> {
            String r = "baidu";
            try { if (hasActiveVpn() && canReach("https://www.google.com/generate_204")) r = "google"; } catch (Exception ignored) {}
            sEngineCache = r;
        }).start();
    }
    private boolean hasActiveVpn() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= 21) {
                for (android.net.Network n : cm.getAllNetworks()) {
                    NetworkCapabilities cap = cm.getNetworkCapabilities(n);
                    if (cap != null && cap.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }
    /** 当前活动网络: {metered, type(wifi/cellular/ethernet/vpn/unknown), online}。
     *  metered 以系统 isActiveNetworkMetered() 为准 (与 DownloadManager 等系统「省流量」判定一致);
     *  识别不到→保守 metered=false (放行), 绝不因门控误伤既有下载功能。 */
    String netInfoJson() {
        boolean metered = false, online = false; String type = "unknown";
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                try { metered = cm.isActiveNetworkMetered(); } catch (Exception ignored) {}
                if (Build.VERSION.SDK_INT >= 23) {
                    try {
                        android.net.Network n = cm.getActiveNetwork();
                        NetworkCapabilities cap = n == null ? null : cm.getNetworkCapabilities(n);
                        if (cap != null) {
                            online = cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                            if (cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) type = "wifi";
                            else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) type = "cellular";
                            else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) type = "ethernet";
                            else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) type = "vpn";
                        }
                    } catch (Exception ignored) {}
                }
                if ("unknown".equals(type)) {
                    try {
                        android.net.NetworkInfo ni = cm.getActiveNetworkInfo();
                        if (ni != null) {
                            online = online || ni.isConnected();
                            int t = ni.getType();
                            if (t == ConnectivityManager.TYPE_WIFI) type = "wifi";
                            else if (t == ConnectivityManager.TYPE_MOBILE) type = "cellular";
                            else if (t == ConnectivityManager.TYPE_ETHERNET) type = "ethernet";
                        }
                    } catch (Exception ignored) {}
                }
            }
        } catch (Exception ignored) {}
        JSONObject o = new JSONObject();
        try { o.put("metered", metered); o.put("type", type); o.put("online", online); } catch (Exception ignored) {}
        return o.toString();
    }
    private boolean canReach(String u) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(2500); c.setReadTimeout(2500); c.setRequestMethod("HEAD");
            int code = c.getResponseCode();
            return code > 0 && code < 500;
        } catch (Exception e) { return false; }
        finally { if (c != null) c.disconnect(); }
    }

    // ── VPN / 本地代理 实时识别 + 联动 ─────────────────────────────────────
    //  道法自然: 不窃取任何外部 VPN App 的私有密钥(沙箱禁止·违规)。改为合法两件事:
    //   ① 实时识别系统 VPN 开关/接口/DNS + 已装的 VPN/代理 App (PackageManager)
    //   ② 探测本机正在跑的本地代理端口(clash/v2ray/sing-box), 一键把内置浏览器
    //      全部 WebView 出站流量路由经它 → 不依赖系统级 VPN 即可"在 App 内用上"。
    private static final int[] PROXY_PORTS = {7890, 7891, 7897, 1080, 10808, 10809, 8889, 8080, 2080, 9090};
    private static final String[][] KNOWN_VPN_APPS = {
        {"com.github.metacubex.clash.meta", "Clash Meta for Android"},
        {"com.github.kr328.clash", "Clash for Android"},
        {"io.nekohasekai.sfa", "sing-box"},
        {"com.v2ray.ang", "v2rayNG"},
        {"app.hiddify.com", "Hiddify"},
        {"com.wireguard.android", "WireGuard"},
        {"org.outline.android.client", "Outline"},
        {"com.github.shadowsocks", "Shadowsocks"},
    };
    /** 探测 127.0.0.1 上常见 clash/v2ray/sing-box 代理端口, 返回首个可连 "host:port"(无则"")。 */
    private String detectLocalProxy() {
        for (int p : PROXY_PORTS) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", p), 250);
                return "127.0.0.1:" + p;
            } catch (Exception ignored) {}
        }
        return "";
    }
    private JSONObject installedVpnAppObj(String pkg, String name) {
        try { JSONObject j = new JSONObject(); j.put("pkg", pkg); j.put("name", name); return j; } catch (Exception e) { return null; }
    }
    /** 实时综合状态: 系统 VPN 是否在用 / 接口 / DNS / 已装 VPN App / 本地代理 / 已路由代理。 */
    private String vpnStatusJson() {
        JSONObject o = new JSONObject();
        try {
            boolean vpn = false; String iface = ""; org.json.JSONArray dns = new org.json.JSONArray();
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= 21) {
                for (android.net.Network n : cm.getAllNetworks()) {
                    NetworkCapabilities cap = cm.getNetworkCapabilities(n);
                    if (cap != null && cap.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                        vpn = true;
                        try {
                            android.net.LinkProperties lp = cm.getLinkProperties(n);
                            if (lp != null) {
                                if (lp.getInterfaceName() != null) iface = lp.getInterfaceName();
                                for (java.net.InetAddress a : lp.getDnsServers()) dns.put(a.getHostAddress());
                            }
                        } catch (Exception ignored) {}
                    }
                }
            }
            org.json.JSONArray apps = new org.json.JSONArray();
            android.content.pm.PackageManager pm = getPackageManager();
            for (String[] k : KNOWN_VPN_APPS) {
                boolean inst; try { pm.getPackageInfo(k[0], 0); inst = true; } catch (Exception e) { inst = false; }
                if (inst) { JSONObject j = installedVpnAppObj(k[0], k[1]); if (j != null) apps.put(j); }
            }
            o.put("vpnActive", vpn);
            o.put("iface", iface);
            o.put("dns", dns);
            o.put("apps", apps);
            o.put("proxy", detectLocalProxy());
            o.put("proxyApplied", curProxy == null ? "" : curProxy);
            o.put("ts", System.currentTimeMillis());
        } catch (Exception e) { try { o.put("error", String.valueOf(e)); } catch (Exception ig) {} }
        return o.toString();
    }
    /** 把内置浏览器(进程内全部 WebView)出站流量路由经本地代理 host:port (代理优先·失败直连兜底)。 */
    private boolean applyWebViewProxy(String hostPort) {
        try {
            if (hostPort == null || hostPort.trim().isEmpty()) return clearWebViewProxy();
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return false;
            String hp = hostPort.trim();
            androidx.webkit.ProxyConfig cfg = new androidx.webkit.ProxyConfig.Builder()
                    .addProxyRule(hp).addDirect().build();
            androidx.webkit.ProxyController.getInstance().setProxyOverride(cfg, Runnable::run, () -> {});
            curProxy = hp;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("webProxy", hp).apply();
            return true;
        } catch (Exception e) { return false; }
    }
    private boolean clearWebViewProxy() {
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE))
                androidx.webkit.ProxyController.getInstance().clearProxyOverride(Runnable::run, () -> {});
            curProxy = null;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("webProxy").apply();
            return true;
        } catch (Exception e) { return false; }
    }
    /** 冷启动恢复上次选定的本地代理路由 (用户选择持久化, 重启沿用)。 */
    private void restoreWebProxy() {
        try {
            String hp = getSharedPreferences(PREFS, MODE_PRIVATE).getString("webProxy", "");
            if (hp != null && !hp.isEmpty()) new Thread(() -> applyWebViewProxyIfReachable(hp)).start();
        } catch (Exception ignored) {}
    }
    private void applyWebViewProxyIfReachable(String hp) {
        try {
            if (!proxyHealthy(hp)) return;   // 端口不在或上游已死(额度耗尽/节点失效) → 不强行套用, 保持直连
            main.post(() -> applyWebViewProxy(hp));
        } catch (Exception ignored) {}
    }
    /** 代理真健康检查: 不止看端口能连(死 VPN 的本地端口往往还在听), 而是真经代理发一次
     *  HTTPS 请求 —— 任何 HTTP 状态码都算通(证明上游链路活着), 异常/超时即判死。 */
    private static boolean proxyHealthy(String hp) {
        try {
            String[] parts = hp.trim().split(":");
            if (parts.length != 2) return false;
            java.net.Proxy px = new java.net.Proxy(java.net.Proxy.Type.HTTP,
                    new java.net.InetSocketAddress(parts[0], Integer.parseInt(parts[1])));
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("https://app.devin.ai/").openConnection(px);
            c.setConnectTimeout(4000); c.setReadTimeout(6000);
            c.setRequestMethod("HEAD");
            int code = c.getResponseCode();
            try { c.disconnect(); } catch (Exception ignored) {}
            return code > 0;
        } catch (Exception e) { return false; }
    }
    private String searchUrl(String q) {
        String enc = android.net.Uri.encode(q);
        return "baidu".equals(searchEngine())
                ? "https://www.baidu.com/s?wd=" + enc
                : "https://www.google.com/search?q=" + enc;
    }

    // ── 标签管理 ──────────────────────────────────────────────────────────
    @SuppressWarnings("SetJavaScriptEnabled")
    private Tab newTab(String url, String accountJson) {
        boolean internal = url.startsWith("rtflow://") || url.startsWith("file:");
        Tab tab = makeTab(accountJson, internal);
        loadInto(tab, url);
        selectTab(tabs.size() - 1);
        return tab;
    }

    /** 后台开新标签: 创建+加载+停泊 autoHost (已挂载窗口·有尺寸 → 自动化 JS/截图可用), 但不调用 selectTab
     *  → 不切换前台, 用户当前页不受打扰 (道并行而不相悖)。无任何活动标签时退化为前台显示, 避免空屏。 */
    private Tab newTabBackground(String url, String accountJson) {
        boolean internal = url.startsWith("rtflow://") || url.startsWith("file:");
        Tab tab = makeTab(accountJson, internal);   // makeTab 已 parkHost
        loadInto(tab, url);
        if (active < 0) selectTab(tabs.size() - 1);  // 空屏兜底
        else renderTabStrip();                        // 仅刷新标签条, 不抢前台
        return tab;
    }

    /** 创建并配置一个标签的 WebView (不自动加载 URL); 供 newTab 与 onCreateWindow(新窗口) 复用。 */
    @SuppressWarnings("SetJavaScriptEnabled")
    private static long sVidSeq = 1;
    private Tab makeTab(String accountJson, boolean internal) {
        final Tab tab = new Tab();
        tab.vid = sVidSeq++;          // 稳定唯一 id (随创建递增)
        tab.accountJson = accountJson;
        tab.internal = internal;
        WebView web = new GuardedWebView(this);
        tab.web = web;
        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setAllowFileAccess(true);
        st.setAllowFileAccessFromFileURLs(true);
        st.setAllowUniversalAccessFromFileURLs(true);
        st.setSupportZoom(true);
        st.setBuiltInZoomControls(true);
        st.setDisplayZoomControls(false);
        st.setUseWideViewPort(true);
        st.setLoadWithOverviewMode(true);
        st.setSupportMultipleWindows(true);                 // window.open / target=_blank
        st.setJavaScriptCanOpenWindowsAutomatically(true);
        st.setMediaPlaybackRequiresUserGesture(false);
        st.setGeolocationEnabled(true);
        if (Build.VERSION.SDK_INT >= 21) st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Cookie 持久化 (像真浏览器保存其它网站登录态: GitHub 等).
        // 注: Devin 多实例鉴权走 document_start 注入的 fetch/XHR Header(Authorization Bearer)+sessionStorage 隔离,
        //     不依赖 Cookie → 普通网站 Cookie 与 Devin 多实例互不串号 (鸡犬相闻·互不往来)。
        android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) cm.setAcceptThirdPartyCookies(web, true);

        if (internal) {
            web.addJavascriptInterface(new Bridge(web), "Native"); // 仅内部页暴露原生桥
            // 道法自然·共享一切但互不干扰: 板块(内部页)用软件层渲染。硬件加速的 WebView 一旦离屏/停泊到
            // 不可见容器, 其 GPU 合成面被释放, 截图 draw(软件Canvas) 取到黑帧 (普通远程网页走软件路径不受影响,
            // 唯板块这类含合成层的本地页发黑)。改软件层后 draw() 始终取到真实内容 → 任意后台板块标签都能被
            // 远程网页端取帧投屏, 无需把它提到手机前台 (故多端各看各页·并行不相犯)。板块 UI 轻量, 软件层无感。
            web.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null);
        } else {
            st.setUserAgentString(st.getUserAgentString().replace("; wv", "")); // 贴近真浏览器
            web.addJavascriptInterface(new AutofillBridge(web), "__dcaf"); // 登录账密自动保存/填充 (Chrome 式无感)
            web.addJavascriptInterface(new TranslateBridge(web), "__dcTr"); // 整页翻译 (Edge 引擎, 原生桥绕过页面 CSP/跨域)
            web.addJavascriptInterface(new UserScriptBridge(web), "__dcus"); // 用户脚本引擎 (油猴兼容: GM_* + 跨域 xhr 经原生桥)
        }
        // 下载捕获桥(所有标签都挂, 仅 saveBase64 一个能力): 把页面内 blob:/data:/<a download> 下载收进右上下载列表
        web.addJavascriptInterface(new DlBridge(), "RTDL");
        // 下载项长按拖到页面 → 注入页面的上传/拖放区 (file input + dropzone)
        web.setOnDragListener(downloadDropListener(web));

        // 账号标签: document_start 注入鉴权头 + sessionStorage 隔离 (多实例核心)
        final boolean docStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        String injectScript0 = null;
        if (accountJson != null) {
            String token = "", org = "", uid = "", orgName = "";
            try { JSONObject a = new JSONObject(accountJson); token = a.optString("auth1", ""); org = a.optString("orgId", "");
                uid = a.optString("userId", ""); orgName = a.optString("orgName", ""); } catch (Exception ignored) {}
            tab.auth1 = token; tab.orgId = org;
            injectScript0 = TabActivity.buildInjection(token, uid, org, orgName);
            if (docStartSupported) {
                try { WebViewCompat.addDocumentStartJavaScript(web, injectScript0, Collections.singleton("https://app.devin.ai")); } catch (Exception ignored) {}
            }
        }
        // 老 WebView(无 androidx.webkit DOCUMENT_START_SCRIPT 支持)兜底: onPageStarted 尽早 evaluateJavascript 注入,
        // 与 TabActivity 全屏号页一致 —— 否则旧机型多实例账号标签拿不到鉴权注入, 官网登录态种不进 → 号加了却「登不进/功能≈0」。
        final String injectScript = injectScript0;

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String u = req.getUrl() == null ? null : req.getUrl().toString();
                if (req.isForMainFrame() && interceptAttachmentNav(v, u)) return true;
                return handleExternalScheme(u);
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) {
                if (interceptAttachmentNav(v, u)) return true;
                return handleExternalScheme(u);
            }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) {
                tab.url = u; if (tabOf(v) == active) setAddr(u);
                if (u != null && u.startsWith("http")) tab.loadedAt = System.currentTimeMillis();   // 整页加载 → V8 堆归零, 重计堆龄
                // 老 WebView 兜底: 无 DOCUMENT_START_SCRIPT 时, 此处尽早种入多实例鉴权(与 TabActivity 一致) → 旧机型账号可登。
                if (!docStartSupported && injectScript != null && u != null && u.contains("app.devin.ai")) {
                    try { v.evaluateJavascript(injectScript, null); } catch (Exception ignored) {}
                }
                if (u != null && u.startsWith("http")) {
                    // document-start 即挂麦克风/语音探针 → 早于页面脚本调用 getUserMedia, 确保语音一开始就被识别为「交互中」。
                    try { v.evaluateJavascript(MIC_AND_EDIT_PROBE_JS, null); } catch (Exception ignored) {}
                    if (!tab.internal) injectUserScripts(v, u, "start"); // 油猴 @run-at document-start
                }
            }
            @Override public void onPageFinished(WebView v, String u) {
                tab.url = u; scheduleRenderTabStrip(); scheduleSaveTabs();
                if (!tab.incognito) addHistory(u, tab.title, tab);   // 无痕标签不记历史
                if (pageZoom != 100) applyZoom(v);          // 缩放跨页/刷新保持
                if (tab.night) applyNight(v, true);          // 夜间反色跨页保持
                installDownloadHook(v);                      // blob:/data:/<a download> 下载 → 收进右上下载列表
                if (tab.swipe != null) tab.swipe.setRefreshing(false);
                if (!tab.internal && u != null && u.startsWith("http")) {
                    autoFillLogin(v, u);        // 有保存的账密 → 自动填充 (无感)
                    installLoginCapture(v);     // 监听登录提交 → 自动弹「保存登录？」
                    installKbHelper(v);         // 键盘弹出时输入框上滚到可见区中部 (不被遮挡)
                    installBackspaceGuard(v);   // 退格护栏: 拦下输入法误发的左右两侧同删
                    installVideoFit(v);         // 录像播放器窄屏适配: 视频区与步骤栏纵向堆叠同屏
                    installMediaRetry(v);       // 媒体加载自愈: 附件/对象存储直链瞬断→退避自动重载
                    harvestPageAuth(v, tab, u); // 非账号标签从页面登录态采收 auth → 媒体代取可用
                    warmAttachmentCookie(tab.auth1, tab.orgId, u);   // 预铸附件 Cookie → 首次图片/视频即已授权
                    if (tab.translated) applyTranslate(v); // 翻译态跨页保持
                    injectUserScripts(v, u, "end");       // 油猴 @run-at document-end/idle
                }
            }
            // SPA(如 Devin) 经 history.pushState/replaceState 客户端路由不会触发 onPageStarted/Finished,
            // 仅此回调会 → 必须在这里同步 tab.url + 地址栏, 否则拖拽提取/地址栏读到的是旧的整页加载 URL(陈旧)。
            @Override public void doUpdateVisitedHistory(WebView v, String u, boolean isReload) {
                if (u != null && u.startsWith("http")) {
                    tab.url = u;
                    if (tabOf(v) == active) setAddr(u);
                    scheduleRenderTabStrip(); scheduleSaveTabs();
                    // SPA 客户端路由后挂载点可能被替换 → 重装下载/键盘钩子(幂等), 修"切到对话页后点下载无反应、要刷新才行"。
                    if (!tab.internal) { installDownloadHook(v); installKbHelper(v); installBackspaceGuard(v); installVideoFit(v); installMediaRetry(v); harvestPageAuth(v, tab, u); warmAttachmentCookie(tab.auth1, tab.orgId, u); }
                }
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                if (adBlock && req != null && req.getUrl() != null && isAdHost(req.getUrl().getHost()))
                    return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                WebResourceResponse am = authMediaResponse(tab, req);
                if (am != null) return am;
                return super.shouldInterceptRequest(v, req);
            }
            // 代理自愈: 套着本地代理时整页加载失败 → 后台真检代理健康, 已死(VPN 额度耗尽/节点失效)
            //   即自动清代理转直连并重载 —— 有 VPN 走 VPN, VPN 死了自然回退直连, 不再僵死报「网络错误」。
            @Override public void onReceivedError(WebView v, WebResourceRequest req, android.webkit.WebResourceError err) {
                try {
                    if (curProxy == null || req == null || !req.isForMainFrame()) return;
                    final String hp = curProxy;
                    new Thread(() -> {
                        if (proxyHealthy(hp)) return;
                        main.post(() -> { if (clearWebViewProxy()) { toast("代理已失效, 已自动转直连"); try { v.reload(); } catch (Exception ignored) {} } });
                    }).start();
                } catch (Exception ignored) {}
            }
            // 渲染进程被系统在内存压力下回收(WebView 变白/无响应需手动刷新)→ 自动重建该标签并重载, 用户无感恢复。
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
                int idx = tabOf(v);
                boolean crash = detail != null && detail.didCrash();
                // 根因诊断: 渲染进程被系统在内存压力下回收(非崩溃) 是「整页被刷新打断」最可能的真凶 ——
                //   多账号池/多标签把 WebView 共享渲染进程的内存撑高 → 系统杀渲染进程 → 前台官网被迫整页重载。
                android.util.Log.w(FL, "onRenderProcessGone idx=" + idx + " didCrash=" + crash
                        + " (renderer killed -> forced full reload; reduce memory pressure to avoid)");
                if (idx < 0) { try { v.destroy(); } catch (Exception ignored) {} return true; }
                recoverDeadTab(idx);
                return true;   // 已处理: 系统不再杀进程
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onReceivedTitle(WebView v, String t) {
                if (t == null || t.isEmpty()) return;
                tab.title = t; scheduleRenderTabStrip();
                // 网页标题往往在 onPageFinished 之后才异步到达(尤其裸域名 301 跳 www), 此时回填,
                // 否则该条历史会记成上一页的标题。同时回填跳转前的原始 URL。
                if (!tab.incognito) {
                    updateHistoryTitle(v.getUrl(), t);
                    String orig = v.getOriginalUrl();
                    if (orig != null) updateHistoryTitle(orig, t);
                }
            }
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                // 仅记录告警/错误: SPA 的 log/info 极其频繁, 全量写 logcat 是无谓开销 → 略过, 减轻主线程负担。
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.WARNING
                        || m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {
                    android.util.Log.w("RTFlowJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                }
                return true;
            }
            // 视频全屏: <video> 的全屏按钮需此回调承接, 缺失则点全屏无反应/播放异常
            @Override public void onShowCustomView(View view, CustomViewCallback callback) { showFsCustomView(view, callback); }
            @Override public void onHideCustomView() { hideFsCustomView(); }
            // 文件/附件上传: 让网页 <input type=file> 拉起系统选择器 (修复 Devin Cloud 上传附件)
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) { try { filePathCallback.onReceiveValue(null); } catch (Exception ignored) {} }
                filePathCallback = cb;
                cameraOutputUri = null;
                try { fileChooser.launch(buildUploadChooser(params)); return true; }
                catch (Exception e) { filePathCallback = null; toast("无法打开上传选择器"); return false; }
            }
            // 新窗口 (window.open / target=_blank): 开一个新标签承接 → 修登录其他网页/弹窗跳转
            @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture, android.os.Message resultMsg) {
                if (adBlock && !userGesture) { toast("已拦截弹窗"); return false; }   // 拦截非用户触发的弹窗广告
                try {
                    // 继承父标签的账号绑定: 新窗口(target=_blank / window.open)打开的 Devin 对话页
                    // 因此保持鉴权注入 → 既能正常登录, 也能被「网页拖拽对话记录」按引擎取数 (不再零事件)。
                    Tab nt = makeTab(tab.accountJson, false);
                    selectTab(tabs.size() - 1);
                    WebView.WebViewTransport tr = (WebView.WebViewTransport) resultMsg.obj;
                    tr.setWebView(nt.web);
                    resultMsg.sendToTarget();
                    return true;
                } catch (Exception e) { return false; }
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (cb != null) cb.invoke(origin, true, false);
            }
            @Override public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                main.post(() -> handleWebPermission(request));
            }
        });

        // 下载: 走系统 DownloadManager (附件/导出文件落到「下载」目录)
        web.setDownloadListener((dlUrl, ua, contentDisposition, mimetype, len) ->
                startDownload(dlUrl, ua, contentDisposition, mimetype));

        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 三击「同一处」→ 刷新一次 (刷新高频, 省去每次去点右上角小按钮)。仅观察手势不消费事件 (return false),
        // 故单击/双击/上下左右滑动/长按拖拽/缩放等原有交互一律不受影响。
        // 关键: 必须是同一落点的连续三击 (deliberate), 而非滚动/连点散落的三下 —— 否则正常浏览/打字时
        // 误触发整页重载, 既打断操作又像卡死 (根治用户反映的"网页刷新频繁打断")。
        final WebView webRef = web;
        final int tapSlop = android.view.ViewConfiguration.get(this).getScaledTouchSlop();
        final long[] tapLast = new long[]{0L};   // 上次有效轻点的时间
        final int[] tapCnt = new int[]{0};        // 连续轻点计数
        final float[] tapDown = new float[]{0f, 0f};
        final long[] tapDownT = new long[]{0L};
        final float[] tapFirst = new float[]{0f, 0f};   // 第一击落点 (同处判定锚点)
        final int sameSpot = tapSlop * 3;               // 三击须落在该半径内才算"同一处"
        web.setOnTouchListener((v, ev) -> {
            // 「人此刻在这页上交互」的最广信号: 任何触摸(按下/滑动/抬起)都刷新 → 滚动阅读、点麦克风按钮、
            //   长按选词等都算交互中, 据此在 EDIT_GUARD 窗口内拦下一切破坏性重载, 真正「与刷新井水不犯河水」。
            tab.lastTouchTs = System.currentTimeMillis();
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    tapDown[0] = ev.getX(); tapDown[1] = ev.getY(); tapDownT[0] = System.currentTimeMillis();
                    break;
                case MotionEvent.ACTION_UP: {
                    long now = System.currentTimeMillis();
                    boolean isTap = (now - tapDownT[0]) < 300
                            && Math.abs(ev.getX() - tapDown[0]) < tapSlop
                            && Math.abs(ev.getY() - tapDown[1]) < tapSlop;
                    if (isTap) {
                        // 与上一击间隔 <350ms 且落点在同处半径内 → 连击; 否则重新计数 (并把本击设为新锚点)
                        boolean chain = (now - tapLast[0] < 350)
                                && Math.abs(ev.getX() - tapFirst[0]) < sameSpot
                                && Math.abs(ev.getY() - tapFirst[1]) < sameSpot;
                        if (chain) { tapCnt[0] = tapCnt[0] + 1; }
                        else { tapCnt[0] = 1; tapFirst[0] = ev.getX(); tapFirst[1] = ev.getY(); }
                        tapLast[0] = now;
                        if (tapCnt[0] >= 3) {
                            tapCnt[0] = 0;
                            Tab a = cur();
                            if (a != null && a.web == webRef) {
                                android.util.Log.i(FL, "triple-tap manual reload (deliberate gesture)");
                                try { webRef.reload(); toast("已刷新"); } catch (Exception ignored) {}
                            }
                        }
                    } else { tapCnt[0] = 0; }
                    break;
                }
                case MotionEvent.ACTION_CANCEL:
                    tapCnt[0] = 0; break;
            }
            return false;
        });
        // 不再包 SwipeRefreshLayout 下拉刷新: 它会拦截顶部下拉, 导致 Devin 对话页等无法正常上下滑动。
        // 刷新统一走右上角刷新按钮 (reloadActive)。tab.swipe 保持 null, 各处视图挂载自动回退到 web。
        tab.swipe = null;
        tabs.add(tab);
        parkHost(tab);   // 立即停泊到 autoHost: 挂载窗口+有尺寸, 后台自动化标签 JS/截图可用
        return tab;
    }

    /** 把标签的视图停泊到常驻 INVISIBLE 容器 autoHost (保持挂载窗口与尺寸); 活动标签由 selectTab 提到 content 顶层。
     *  停泊即「转入后台」: 仿 Chrome/真浏览器对后台标签的资源调度 —— 调 onPause() 暂停该 WebView 的渲染合成/动画/
     *  WebGL/video 等「额外处理」(不停 JS、不丢页面态), 让出 CPU/GPU 给前台标签 → 多标签下前台打字/滚动不再被
     *  后台页抢资源致卡顿。自动化截图/镜像(ipcScreenshot/ipcMirrorFrame)取帧前都会 resumeWeb 唤醒目标 → 不受影响。 */
    private void parkHost(Tab t) {
        if (t == null || autoHost == null) return;
        android.view.View host = t.swipe != null ? t.swipe : t.web;
        if (host == null || host.getParent() == autoHost) { pauseWeb(t.web); return; }
        if (host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
        autoHost.addView(host, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        pauseWeb(t.web);
    }

    /** 暂停一个后台 WebView 的「额外处理」(渲染合成/动画/插件), 让出系统资源。仅 onPause(), 不动全局 pauseTimers()
     *  (那会冻结所有 WebView 的 JS 计时器·伤及前台); JS 仍可经 evaluateJavascript 跑 → 后台自动化(执行JS)不受影响。 */
    private void pauseWeb(final WebView w) {
        if (w == null) return;
        try { w.onPause(); } catch (Exception ignored) {}
    }

    private void loadInto(Tab tab, String url) {
        String real = url;
        if (SWITCH.equals(url)) { real = SW_URL; tab.internal = true; }
        else if (TUNNEL.equals(url)) { real = TU_URL; tab.internal = true; }
        else if (CLOUD.equals(url)) { real = CL_URL; tab.internal = true; }
        else if (VPN.equals(url)) { real = VPN_URL; tab.internal = true; }
        else if (SCRIPTS.equals(url)) { real = SCR_URL; tab.internal = true; }
        else if (SHIZUKU.equals(url)) { real = SHZ_URL; tab.internal = true; }
        tab.url = real;
        tab.web.loadUrl(real);
    }

    private int tabOf(WebView v) { for (int i = 0; i < tabs.size(); i++) if (tabs.get(i).web == v) return i; return -1; }

    private void selectTab(int idx) {
        if (idx < 0 || idx >= tabs.size()) return;
        active = idx;
        tabs.get(idx).lastShownAt = System.currentTimeMillis();   // 记录「最近被前台访问」→ 供前台内存保洁判定长时间未访问的后台标签
        content.removeAllViews();
        // autoHost 常驻 (停泊其余标签·保持挂载窗口与尺寸, 后台自动化可用); 活动标签提到其上层显示。
        if (autoHost != null) content.addView(autoHost);
        Tab t = tabs.get(idx);
        // 后台被回收的标签延迟重载: 选中即载 (恢复内容, 且一次只载一个 → 不放大内存压力)
        if (t.pendingReloadUrl != null) { String u = t.pendingReloadUrl; t.pendingReloadUrl = null; t.maybeStale = false; t.url = u; try { t.web.loadUrl(u); } catch (Exception ignored) {} }
        else if (t.maybeStale) { t.maybeStale = false; probeTabLiveness(t); }   // 长后台返回切到此标签 → 探活, 冻死则静默重载
        android.view.View host = t.swipe != null ? t.swipe : t.web;
        if (host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
        content.addView(host);
        // 其余标签全部停泊回 autoHost (确保始终挂载窗口·有尺寸)
        for (int i = 0; i < tabs.size(); i++) if (i != idx) parkHost(tabs.get(i));
        // 下载悬浮窗置顶 (在 WebView 之上)
        if (dlPanel != null) {
            if (dlPanel.getParent() != null) ((ViewGroup) dlPanel.getParent()).removeView(dlPanel);
            content.addView(dlPanel);
        }
        // 全服通悬浮窗置顶
        if (daoPanel != null) {
            if (daoPanel.getParent() != null) ((ViewGroup) daoPanel.getParent()).removeView(daoPanel);
            content.addView(daoPanel);
        }
        setAddr(displayUrl(t));
        renderTabStrip();
        if (pageZoom != 100) applyZoom(t.web);
        resumeWeb(t.web);   // 选中即把页面拉回「可见+计时器运行」, 防止 visibilityState 卡 hidden 致交互冻死
        // 切到账号标签 → 顺手命令切号引擎刷一次该号(状态+额度), 顶部标签金额即时显示·不等周期心跳。
        if (t.accountJson != null) pushOpenAcctsToSwitch();
        // 附件 Cookie 是组织级共享状态 → 前台标签优先: 切标签即按其组织预铸 (他组织铸过则重铸)
        if (t.auth1 != null && !t.auth1.isEmpty()) warmAttachmentCookie(t.auth1, t.orgId, "https://app.devin.ai/attachments/");
    }

    /** 把一个 WebView 强制拉回「页面可见 + 计时器运行」状态。
     *  根因: 长时间后台/重新挂载后, Chromium 的 page-visibility 可能卡在 hidden(即使视图其实在前台·有焦点),
     *  此时 setTimeout/setInterval/requestAnimationFrame 全被冻结 → 网页"看着正常能滚动, 但点下载等依赖异步的交互一律失效",
     *  必须手动刷新才好。这里: onResume()+resumeTimers() 唤醒渲染, 再把视图可见性切一下(INVISIBLE→VISIBLE)
     *  逼 Chromium 同步重算页面可见性 → 不重载、不丢滚动/表单即可恢复全部交互。 */
    private void resumeWeb(final WebView w) {
        if (w == null) return;
        try { w.onResume(); } catch (Exception ignored) {}
        try { w.resumeTimers(); } catch (Exception ignored) {}   // 全局: 恢复被冻结的所有 WebView 计时器
        // 用户正在打字/语音输入 → 绝不切视图可见性: INVISIBLE→VISIBLE 这一帧会让 WebView 失焦,
        //   足以顶掉软键盘/打断语音听写。此时只做无损唤醒(onResume+resumeTimers, 已在上方), 跳过可见性翻转。
        //   (8s 看门狗每轮都会进来; 不护就会「输入中每 8s 被弹一下」。真冻死时本就非输入态, 不受影响。)
        try {
            int wi = tabOf(w);
            if (wi >= 0) { Tab wt = tabs.get(wi);
                // 打字/语音(含麦克风) 20s 内, 或最近 4s 内有触摸(滚动/点按进行中) → 跳过翻转, 那一帧的失焦足以顶掉
                //   软键盘/打断语音听写。翻转无损(不重载·不丢态), 故非交互态时照常纠正卡死的 hidden 页。
                if (userInteracting(wt, 4000)) return; }
        } catch (Exception ignored) {}
        try {
            // 只在真的卡 hidden 时才切可见性纠正 → 正常切标签无闪烁。
            w.evaluateJavascript("(function(){try{return document.visibilityState;}catch(e){return 'x';}})()", val -> {
                if (val == null || !val.contains("hidden")) return;
                try {
                    if (w.getVisibility() == android.view.View.VISIBLE) {
                        android.util.Log.i(FL, "resumeWeb: page stuck hidden & user idle -> visibility flip to unfreeze");
                        // 跨帧切 INVISIBLE→VISIBLE: 逼 Chromium 把 page-visibility 当作真实的 hidden→visible 转变处理
                        // (同帧切会被合并成无变化而失效)。仅~1 帧不可见, 只在卡死恢复时触发, 用户无感。
                        w.setVisibility(android.view.View.INVISIBLE);
                        main.post(() -> { try { w.setVisibility(android.view.View.VISIBLE); } catch (Exception ignored) {} });
                    }
                } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    }

    private String displayUrl(Tab t) {
        if (t.url != null && t.url.endsWith("switch.html")) return SWITCH;
        if (t.url != null && t.url.endsWith("tunnel.html")) return TUNNEL;
        if (t.url != null && t.url.endsWith("cloud.html")) return CLOUD;
        return t.url == null ? "" : t.url;
    }

    private void navigate(String url) {
        if (active < 0) { newTab(url, null); return; }
        loadInto(tabs.get(active), url);
    }

    private void closeTab(int idx) {
        if (idx < 0 || idx >= tabs.size()) return;
        Tab t = tabs.remove(idx);
        try { tabViewers.remove(t.vid); } catch (Exception ignored) {}   // 关标签即清其联控在场登记 → tabViewers 不随开/关标签单调累积(久用泄漏根除·橙色在场计数不被死标签污染)
        try {
            android.view.View host = t.swipe != null ? t.swipe : t.web;
            if (host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
            if (t.swipe != null) t.swipe.removeAllViews();
            t.web.destroy();
        } catch (Exception ignored) {}
        if (tabs.isEmpty()) { newTab(SWITCH, null); return; }
        selectTab(Math.max(0, idx - 1));
    }

    /** 渲染进程被回收后, 原地重建该标签的 WebView 并重载原 URL → 网页自动恢复(无需用户手动刷新)。 */
    private void recoverDeadTab(final int idx) {
        main.post(() -> {
            if (idx < 0 || idx >= tabs.size()) return;
            Tab dead = tabs.get(idx);
            String acct = dead.accountJson; boolean internal = dead.internal;
            String url = dead.url; boolean incognito = dead.incognito, night = dead.night;
            try {
                android.view.View host = dead.swipe != null ? dead.swipe : dead.web;
                if (host != null && host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
                if (dead.web != null) dead.web.destroy();
            } catch (Exception ignored) {}
            Tab fresh = makeTab(acct, internal);          // 完整配置 + 停泊; 追加到末尾
            tabs.remove(tabs.size() - 1);                 // 取回, 放回原位
            fresh.incognito = incognito; fresh.night = night;
            fresh.url = url;
            tabs.set(idx, fresh);
            if (active == idx) {
                // 当前可见标签: 立即重载, 用户无感恢复
                if (url != null && !url.isEmpty()) fresh.web.loadUrl(url);
                selectTab(idx);
                toast("网页已自动恢复");
            } else {
                // 后台标签: 不立即重载(否则多标签同时被回收→同时重载, 内存雪崩·更卡)。延迟到用户选中该标签时再载。
                fresh.pendingReloadUrl = (url != null && !url.isEmpty()) ? url : null;
                renderTabStrip();
            }
            saveTabs();
        });
    }

    private void setAddr(String u) { if (addr != null) addr.setText(u == null ? "" : u); updateStar(); }

    private void renderTabStrip() {
        if (tabStripRow == null) return;
        // 内容签名去重: 显示文案/在场/活动页 未变则直接跳过 (账号池逐号回推时绝大多数与已开标签无关 → 恒被此处挡下)。
        String sig = tabStripSig();
        if (sig.equals(lastStripSig)) { main.removeCallbacks(stripRenderTask); stripRenderPending = false; return; }
        main.removeCallbacks(stripRenderTask); stripRenderPending = false;
        lastStripSig = sig;
        // 结构未变(还是这些标签、这个顺序) → 非破坏性原地更新文案/颜色/角标, 绝不 removeAllViews → 不打断输入, 即时刷新额度/状态。
        String struct = tabStructSig();
        if (struct.equals(lastStructSig) && tabStripRow.getChildCount() == tabs.size() + 1) {
            updateTabStripInPlace();
            return;
        }
        // 结构变了(用户开/关/拖动标签, 属主动操作) → 才整条重建。
        lastStructSig = struct;
        tabStripRow.removeAllViews();
        for (int i = 0; i < tabs.size(); i++) {
            final int idx = i;
            Tab t = tabs.get(i);
            int coN = coViewerCount(t.vid, System.currentTimeMillis());   // 云端控台在场数(非手机本体)
            boolean coView = coN > 0;
            LinearLayout chip = new LinearLayout(this);
            chip.setOrientation(LinearLayout.HORIZONTAL);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            // 道法自然·跨设备在场同步: 任意用户(手机本体当前前置 / 云端控台正看控)停留此标签 → 橙色半透明底,
            // 与控台 .mchip.live 同款视觉、双向一致 → 本机最前端页与他设备在场页皆橙色, 一眼见"有几人在哪操作"。
            boolean viewed = (idx == active) || coView;   // idx==active = 手机本体当前最前端页 (一种在场)
            chip.setBackgroundColor(viewed ? ((idx == active) ? 0xFF5A3D22 : 0xFF3A2C1B) : 0xFF1B1F26);
            chip.setPadding(dp(10), dp(5), dp(6), dp(5));
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.rightMargin = dp(4);
            chip.setLayoutParams(clp);

            TextView label = new TextView(this);
            label.setText(chipTitle(t));
            label.setTextColor(idx == active ? 0xFF9CDCFE : (coView ? 0xFFE3A877 : 0xFFAAB2BD));
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            label.setMaxWidth(dp(130));
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            // 手势: 单击=切换标签 · 双击=复制该账号+密码(弹提示) · 长按(整片均可)=拖拽
            final GestureDetector gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onDown(MotionEvent e) { return true; }
                @Override public boolean onSingleTapConfirmed(MotionEvent e) { selectTab(idx); return true; }
                @Override public boolean onDoubleTap(MotionEvent e) {
                    Tab tt = tabs.get(idx);
                    if (tt.accountJson != null) copyTabAccount(tt); else toast("非账号标签·无账密可复制");
                    return true;
                }
            });
            // 长按改自管: GestureDetector 的 onLongPress 在标签条(HorizontalScrollView)里手指稍动就被横滚吞掉,
            // 导致"要找很久位置/经常错位"。这里整片 chip 按下即起计时, 300ms 内不明显移动 → 触发拖拽; 明显滑动则放行横滚。
            gd.setIsLongpressEnabled(false);
            final int slop = android.view.ViewConfiguration.get(this).getScaledTouchSlop();
            final float[] downXY = new float[2];
            final boolean[] longFired = { false };
            final Runnable[] lp = new Runnable[1];
            chip.setOnTouchListener((v, ev) -> {
                switch (ev.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downXY[0] = ev.getRawX(); downXY[1] = ev.getRawY(); longFired[0] = false;
                        if (v.getParent() != null) v.getParent().requestDisallowInterceptTouchEvent(true);
                        lp[0] = () -> { longFired[0] = true; doVibrate(40); v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS); startTabDrag(v, idx); };
                        main.postDelayed(lp[0], 300);
                        break;
                    case MotionEvent.ACTION_MOVE:
                        if (!longFired[0] && (Math.abs(ev.getRawX() - downXY[0]) > slop || Math.abs(ev.getRawY() - downXY[1]) > slop)) {
                            if (lp[0] != null) main.removeCallbacks(lp[0]);   // 明显滑动 → 取消长按, 放行标签条横滚
                            if (v.getParent() != null) v.getParent().requestDisallowInterceptTouchEvent(false);
                        }
                        break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (lp[0] != null) main.removeCallbacks(lp[0]);
                        if (v.getParent() != null) v.getParent().requestDisallowInterceptTouchEvent(false);
                        break;
                }
                gd.onTouchEvent(ev);   // 单击/双击仍由 gd 处理 (拖拽启动后系统发 CANCEL, 不会误触发单击)
                return true;
            });

            TextView x = new TextView(this);
            x.setText(" ×");
            x.setTextColor(0xFF8B949E);
            x.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            x.setPadding(dp(6), 0, dp(2), 0);
            x.setOnClickListener(v -> closeTab(idx));

            chip.addView(label);
            if (coView) {   // 橙色在场角标: 几台其他设备正看/控此页 (与控台 .co 同义)
                TextView co = new TextView(this);
                co.setText(" \u2601" + coN);   // ☁N
                co.setTextColor(0xFFF0883E);
                co.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                co.setPadding(dp(3), 0, dp(1), 0);
                chip.addView(co);
            }
            chip.addView(x);
            chip.setTag(idx);
            tabStripRow.addView(chip);
        }
        // 「+」新标签键: 高度压到与标签等高 (原 Button 默认 minHeight≈48dp 撑得过高·占空间)
        Button plus = chipBtn("+");
        plus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        plus.setPadding(dp(12), dp(5), dp(12), dp(5));
        plus.setMinHeight(0); plus.setMinimumHeight(0);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        plp.gravity = Gravity.CENTER_VERTICAL;
        plus.setLayoutParams(plp);
        plus.setOnClickListener(v -> newTab(DEVIN, null));
        tabStripRow.addView(plus);
        tabStripRow.setOnDragListener(tabDragListener);
    }

    // ── 标签长按拖拽排序 ──────────────────────────────────────────────────
    private final View.OnDragListener tabDragListener = (v, ev) -> {
        switch (ev.getAction()) {
            case DragEvent.ACTION_DRAG_LOCATION:
                updateTabEdgeScroll(ev.getX());   // 拖到左/右边缘 → 自动横滚露出屏外标签
                return true;
            case DragEvent.ACTION_DROP:
                stopTabEdgeScroll();
                try {
                    int from = Integer.parseInt(ev.getClipDescription().getLabel().toString());
                    int to = dropIndex(ev.getX());
                    moveTab(from, to);
                } catch (Exception ignored) {}
                return true;
            case DragEvent.ACTION_DRAG_EXITED:
            case DragEvent.ACTION_DRAG_ENDED:
                stopTabEdgeScroll();
                return true;
            case DragEvent.ACTION_DRAG_STARTED:
            case DragEvent.ACTION_DRAG_ENTERED:
                return true;
            default:
                return false;
        }
    };

    // ── 拖拽到标签条边缘 → 自动横向滚动 (露出屏幕外原本看不到的标签) ──
    private final Runnable tabEdgeScrollRunner = new Runnable() {
        @Override public void run() {
            if (!tabDragScrolling || tabStrip == null || tabDragScrollDir == 0) return;
            int step = dp(18) * tabDragScrollDir;
            int before = tabStrip.getScrollX();
            tabStrip.scrollBy(step, 0);
            // 已到两端尽头则停 (滚动量为 0)
            if (tabStrip.getScrollX() == before) { stopTabEdgeScroll(); return; }
            main.postDelayed(this, 16);
        }
    };

    /** ev.getX() 是相对 tabStripRow(内容) 的坐标; 减去 scrollX 即得在可视视口内的坐标。 */
    private void updateTabEdgeScroll(float xInContent) {
        if (tabStrip == null) return;
        int viewport = tabStrip.getWidth();
        if (viewport <= 0) { stopTabEdgeScroll(); return; }
        float xInViewport = xInContent - tabStrip.getScrollX();
        int edge = dp(44);   // 边缘热区宽度
        int dir = 0;
        if (xInViewport <= edge) dir = -1;
        else if (xInViewport >= viewport - edge) dir = 1;
        if (dir == 0) { stopTabEdgeScroll(); return; }
        tabDragScrollDir = dir;
        if (!tabDragScrolling) {
            tabDragScrolling = true;
            main.post(tabEdgeScrollRunner);
        }
    }

    private void stopTabEdgeScroll() {
        tabDragScrolling = false;
        tabDragScrollDir = 0;
        main.removeCallbacks(tabEdgeScrollRunner);
    }

    private void startTabDrag(View chip, int idx) {
        try {
            dragTabIdx = idx;   // 拖到网页区(非标签条) → 提取该标签对话, 导入目标页
            ClipData data = new ClipData(String.valueOf(idx), new String[]{ "text/plain" }, new ClipData.Item(String.valueOf(idx)));
            View.DragShadowBuilder shadow = new View.DragShadowBuilder(chip);
            if (Build.VERSION.SDK_INT >= 24) chip.startDragAndDrop(data, shadow, null, 0);
            else chip.startDrag(data, shadow, null, 0);
        } catch (Exception ignored) {}
    }

    /** 依拖放 x 坐标找到目标插入位置 (落在哪个 chip 上)。 */
    private int dropIndex(float x) {
        for (int i = 0; i < tabStripRow.getChildCount() && i < tabs.size(); i++) {
            View c = tabStripRow.getChildAt(i);
            if (x < c.getX() + c.getWidth() / 2f) return i;
        }
        return tabs.size() - 1;
    }

    private void moveTab(int from, int to) {
        if (from < 0 || from >= tabs.size() || to < 0 || to >= tabs.size() || from == to) return;
        Tab activeTab = (active >= 0 && active < tabs.size()) ? tabs.get(active) : null;
        Tab moving = tabs.remove(from);
        tabs.add(to, moving);
        if (activeTab != null) active = tabs.indexOf(activeTab); // 拖拽后仍激活原标签
        renderTabStrip();
        saveTabs();
    }

    private void renameTab(int idx) {
        if (idx < 0 || idx >= tabs.size()) return;
        final Tab t = tabs.get(idx);
        final EditText in = new EditText(this);
        in.setText(t.titleOverride != null ? t.titleOverride : chipTitle(t));
        in.setSingleLine(true);
        new android.app.AlertDialog.Builder(this)
                .setTitle("改对话名 (仅标签显示)")
                .setView(in)
                .setPositiveButton("保存", (d, w) -> { t.titleOverride = in.getText().toString().trim(); renderTabStrip(); saveTabs(); })
                .setNegativeButton("取消", null)
                .setNeutralButton("清除", (d, w) -> { t.titleOverride = null; renderTabStrip(); saveTabs(); })
                .show();
    }

    private void showTabMenu(View anchor, int idx) {
        if (idx < 0 || idx >= tabs.size()) return;
        final Tab t = tabs.get(idx);
        PopupMenu m = new PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, "复制账号+密码");
        m.getMenu().add(0, 2, 1, "改对话名");
        m.getMenu().add(0, 3, 2, "收藏本页");
        m.getMenu().add(0, 4, 3, "关闭标签");
        m.setOnMenuItemClickListener(it -> {
            switch (it.getItemId()) {
                case 1: copyTabAccount(t); return true;
                case 2: renameTab(idx); return true;
                case 3: addBookmark(t.url, chipTitle(t), t); return true;
                case 4: closeTab(idx); return true;
            }
            return false;
        });
        m.show();
    }

    private void copyTabAccount(Tab t) {
        if (t.accountJson == null) { toast("非账号标签"); return; }
        try {
            JSONObject a = new JSONObject(t.accountJson);
            String txt = a.optString("email", a.optString("id", "")) + "\n" + a.optString("password", "");
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("rtflow", txt));
            toast("已复制账号+密码");
        } catch (Exception e) { toast("复制失败"); }
    }

    private String chipTitle(Tab t) {
        if (t.titleOverride != null && !t.titleOverride.isEmpty()) return t.titleOverride;
        if (t.url != null && t.url.endsWith("switch.html")) return "切号";
        if (t.url != null && t.url.endsWith("tunnel.html")) return "穿透";
        if (t.url != null && t.url.endsWith("cloud.html")) return "对话";
        if (t.url != null && t.url.endsWith("vpn.html")) return "VPN";
        if (t.accountJson != null) {
            try {
                JSONObject a = new JSONObject(t.accountJson);
                String id = a.optString("id", a.optString("email", ""));
                String email = a.optString("email", id);
                // 标签标题优先显示该账号最活跃对话名 + 实时状态点 (运行/卡顿/结束)
                String emailLc = email.toLowerCase();
                String money = sTabDollars.get(id);
                if (money == null) money = sTabDollars.get(emailLc);
                String pre = (money != null && !money.isEmpty()) ? money + " " : "";
                String[] sta = sTabStatus.get(id);
                if (sta == null) sta = sTabStatus.get(email);
                if (sta == null) sta = sTabStatus.get(emailLc);
                if (sta != null && sta[0] != null && !sta[0].isEmpty()) {
                    String dot = statusDot(sta[1]);
                    String name = sta[0].length() > 12 ? sta[0].substring(0, 11) + "…" : sta[0];
                    return pre + dot + name;     // "$5 🟢 对话名"
                }
                String base = email.length() > 14 ? email.substring(0, 13) + "…" : email;
                return pre + base;               // "$5 邮箱"
            } catch (Exception ignored) {}
        }
        return t.title == null || t.title.isEmpty() ? "标签" : t.title;
    }

    /** 对话状态 → 标签前缀点: 运行🟢 / 卡顿🟠 / 结束(回归常态·无点) */
    private String statusDot(String status) {
        String s = status == null ? "" : status.toLowerCase();
        if (s.contains("block") || s.contains("stuck") || s.contains("wait")) return "\uD83D\uDFE0 ";   // 🟠 卡顿
        if (s.contains("run") || s.contains("work") || s.contains("active")) return "\uD83D\uDFE2 "; // 🟢 运行
        return "";  // finished/normal → 回归常态
    }

    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }
    private void toast(String s) { main.post(() -> Toast.makeText(this, s, Toast.LENGTH_SHORT).show()); }

    private void startRelay() {
        Intent svc = new Intent(this, RelayService.class);
        if (Build.VERSION.SDK_INT >= 26) ContextCompat.startForegroundService(this, svc);
        else startService(svc);
    }

    // ── 内网穿透「去中心化」身份 ────────────────────────────────────────────
    //  零账号配对中继 (dao-relay): (session,token) 即命名空间, 谁知道谁可驱动。
    //  · session = 设备唯一身份, 持久化到防卸载 vault → 重装/换机沿用同一身份(数据不丢)
    //  · token   = SecureRandom 高熵生成, **持久化复用、长期稳定** (P1: 不再每冷启动轮换 →
    //              端点 URL+token 长期不变, 驱动方无需每次重拿; 仅首次或用户手动「刷新Token」才换)
    //  · url     = 中继会合点 (conn.json 默认 worker, 可被用户覆盖)
    //  生成的 relay-config.json 写入 filesDir, 供 RelayService 引擎 N.getConn() 读取。
    private static String randHex(int nChars) {
        java.security.SecureRandom r = new java.security.SecureRandom();
        char[] H = "0123456789abcdef".toCharArray();
        StringBuilder b = new StringBuilder(nChars);
        for (int i = 0; i < nChars; i++) b.append(H[r.nextInt(16)]);
        return b.toString();
    }
    private String readAssetText(String path) {
        try (InputStream is = getAssets().open(path)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        } catch (Exception e) { return ""; }
    }
    private String defaultRelayBase() {
        try { JSONObject c = new JSONObject(readAssetText("engine/conn.json")); String u = c.optString("url", ""); if (!u.isEmpty()) return u; }
        catch (Exception ignored) {}
        return "https://dao-relay-do.zhouyoukang.workers.dev";
    }
    private void writeRelayConfig(String json) {
        try (FileOutputStream o = new FileOutputStream(new File(getFilesDir(), "relay-config.json"))) {
            o.write((json == null ? "{}" : json).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }
    /** 读 filesDir 下的文本文件 (如 relay-config.json); 不存在/出错返回空串。 */
    private String readFilesText(String name) {
        try (InputStream is = new java.io.FileInputStream(new File(getFilesDir(), name))) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        } catch (Exception e) { return ""; }
    }
    /** 冷启动: 取/建设备唯一身份(session/token/e2eKey 均防卸载持久化、稳定复用), 落地 relay-config.json。
     *  P1 修复: token 不再每次冷启动轮换——复用持久化 token, 端点(URL+token)长期稳定, 驱动方无需每次重拿。
     *  仅当身份里无 token(首次)或用户显式「刷新 Token」时才生成新 token。 */
    private void ensureRelayIdentity() {
        try {
            JSONObject id;
            String saved = vaultRead("relay-identity");
            id = (saved != null && saved.trim().startsWith("{")) ? new JSONObject(saved) : new JSONObject();
            String url = id.optString("url", "");
            if (url.isEmpty()) url = defaultRelayBase();
            String session = id.optString("session", "");
            if (session.isEmpty()) session = "rtflow-" + randHex(16);
            // 端到端加密口令: 设备唯一、防卸载持久化、从不上送中继 → 中继(含共享 Worker)只见密文。
            String e2eKey = id.optString("e2eKey", "");
            if (e2eKey.isEmpty()) e2eKey = randHex(32);
            // P1: token 持久化复用 — 仅首次(身份无 token)时生成, 之后每次冷启动沿用同一 token。
            String token = id.optString("token", "");
            if (token.isEmpty()) token = randHex(32);
            id.put("url", url); id.put("session", session); id.put("e2eKey", e2eKey); id.put("token", token);
            vaultWrite("relay-identity", id.toString());   // 身份(url+session+token+e2eKey)防卸载持久化

            String base = url.replaceAll("/+$", "");
            JSONObject cfg = new JSONObject();
            cfg.put("url", url); cfg.put("token", token); cfg.put("session", session);
            cfg.put("e2eKey", e2eKey);
            cfg.put("enabled", true);
            cfg.put("endpoint", base + "/relay/" + session);
            cfg.put("rotatedTs", System.currentTimeMillis());
            writeRelayConfig(cfg.toString());
        } catch (Exception ignored) {}
    }
    /** 显式刷新 token: 作废身份里的旧 token → 重新生成并落地。供穿透面板「刷新 Token」调用。 */
    private void rotateRelayTokenForce() {
        try {
            String saved = vaultRead("relay-identity");
            JSONObject id = (saved != null && saved.trim().startsWith("{")) ? new JSONObject(saved) : new JSONObject();
            id.put("token", randHex(32));   // 新 token, 旧的即刻作废
            vaultWrite("relay-identity", id.toString());
        } catch (Exception ignored) {}
        ensureRelayIdentity();   // 复用刚写入的新 token, 落地 relay-config.json
    }
    /** 用户在穿透面板手动保存配置: 持久化其 url/session 身份(token 仍每冷启动轮换); 空配置=重置为自动身份。 */
    private void applyRelayConfig(String json) {
        try {
            if (json == null || json.trim().length() < 5 || "{}".equals(json.trim())) {
                vaultWrite("relay-identity", "");   // 清身份 → 重新自动生成
                ensureRelayIdentity();
                return;
            }
            JSONObject in = new JSONObject(json);
            JSONObject old = null;
            try { String s = vaultRead("relay-identity"); if (s != null && s.trim().startsWith("{")) old = new JSONObject(s); } catch (Exception ignored) {}
            String url = in.optString("url", defaultRelayBase());
            String session = in.optString("session", "");
            if (session.isEmpty()) session = "rtflow-" + randHex(16);
            // token: 用户显式填则用之; 否则沿用持久化 token(P1: 不再随机轮换); 仍无才首次生成。
            String token = in.optString("token", "");
            if (token.isEmpty() && old != null) token = old.optString("token", "");
            if (token.isEmpty()) token = randHex(32);
            // e2eKey: 用户显式提供则用之; 否则沿用旧身份, 仍无则新生成 (端到端加密口令不轮换)。
            String e2eKey = in.optString("e2eKey", "");
            if (e2eKey.isEmpty() && old != null) e2eKey = old.optString("e2eKey", "");
            if (e2eKey.isEmpty()) e2eKey = randHex(32);
            JSONObject id = new JSONObject(); id.put("url", url); id.put("session", session); id.put("e2eKey", e2eKey); id.put("token", token);
            vaultWrite("relay-identity", id.toString());
            String base = url.replaceAll("/+$", "");
            JSONObject cfg = new JSONObject();
            cfg.put("url", url); cfg.put("token", token); cfg.put("session", session);
            cfg.put("e2eKey", e2eKey);
            cfg.put("enabled", true); cfg.put("endpoint", base + "/relay/" + session);
            cfg.put("rotatedTs", System.currentTimeMillis());
            writeRelayConfig(cfg.toString());
        } catch (Exception ignored) {}
    }

    // 视频全屏承接: WebView 播放器点全屏 → onShowCustomView 交出一个 View, 宿主必须把它挂到
    //   窗口顶层并沉浸显示, 否则「点全屏毫无反应」。退出经 onHideCustomView / 返回键。
    private void showFsCustomView(View view, WebChromeClient.CustomViewCallback callback) {
        if (view == null) return;
        if (fsCustomView != null) { try { if (callback != null) callback.onCustomViewHidden(); } catch (Exception ignored) {} return; }
        fsCustomView = view; fsCallback = callback;
        try {
            ViewGroup decor = (ViewGroup) getWindow().getDecorView();
            view.setBackgroundColor(0xFF000000);
            decor.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } catch (Exception ignored) {}
    }
    private void hideFsCustomView() {
        if (fsCustomView == null) return;
        try { ((ViewGroup) getWindow().getDecorView()).removeView(fsCustomView); } catch (Exception ignored) {}
        fsCustomView = null;
        try { if (fsCallback != null) fsCallback.onCustomViewHidden(); } catch (Exception ignored) {}
        fsCallback = null;
        try { getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE); } catch (Exception ignored) {}
    }

    @Override public void onBackPressed() {
        if (fsCustomView != null) { hideFsCustomView(); return; }   // 全屏视频中: 返回键先退全屏
        if (daoOpen) { hideDaoPanel(); return; }                // 返回键先关全服通悬浮窗 (保活, 再开秒显)
        if (dlPanel != null) { closeDownloadPanel(); return; }
        if (active >= 0 && tabs.get(active).web.canGoBack()) { tabs.get(active).web.goBack(); return; }
        super.onBackPressed();
    }

    // ── 网页麦克风/摄像头授权: WebView 层 grant 之前, 应用自身必须先持有系统运行时权限 (RECORD_AUDIO 等),
    //    否则页面 getUserMedia 仍被系统拒绝 (语音输入报 "Could not access microphone")。缺权限时先向系统申请,
    //    授权回调里再补发 grant → 用户点一次「允许」后语音输入即长期可用。
    private static final int REQ_WEB_PERM = 9;
    private android.webkit.PermissionRequest pendingWebPermission;
    private void handleWebPermission(android.webkit.PermissionRequest request) {
        try {
            java.util.List<String> need = new java.util.ArrayList<>();
            for (String res : request.getResources()) {
                if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                        && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                    need.add(Manifest.permission.RECORD_AUDIO);
                if (android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                        && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
                    need.add(Manifest.permission.CAMERA);
            }
            if (need.isEmpty()) { request.grant(request.getResources()); return; }
            if (pendingWebPermission != null) { try { pendingWebPermission.deny(); } catch (Exception ignored) {} }
            pendingWebPermission = request;
            ActivityCompat.requestPermissions(this, need.toArray(new String[0]), REQ_WEB_PERM);
        } catch (Exception e) { try { request.grant(request.getResources()); } catch (Exception ignored) {} }
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_WEB_PERM || pendingWebPermission == null) return;
        android.webkit.PermissionRequest req = pendingWebPermission; pendingWebPermission = null;
        boolean allGranted = grantResults.length > 0;
        for (int r : grantResults) if (r != PackageManager.PERMISSION_GRANTED) allGranted = false;
        final boolean ok = allGranted;
        main.post(() -> { try { if (ok) req.grant(req.getResources()); else { req.deny(); toast("麦克风权限被拒 · 语音输入不可用, 可在系统设置中开启"); } } catch (Exception ignored) {} });
    }

    /** 原地刷新当前标签的 WebView：同一实例 reload，sessionStorage 隔离的登录态不丢。
     *  并顺带强制切号引擎「立刻重识别当前账号的对话状态 + 额度」(即使切号板块在后台/已停泊)，
     *  根治「点刷新无效 / 对话状态识别不到 / 额度数据老」。刷新引擎走后台 webview·与当前页交互道并行而不相悖。 */
    private void reloadActive() {
        if (active >= 0 && active < tabs.size() && tabs.get(active).web != null) {
            Tab t = tabs.get(active);
            t.web.reload();
            triggerEngineRefresh(acctKeyOf(t));
            toast("刷新中…");
        } else {
            toast("无可刷新页面");
        }
    }

    /** 定位切号引擎(switch.html)的 WebView —— 它承载账号池/对话状态/额度的全部探测通路。
     *  无论它当前是前台标签还是被停泊到后台, 都能经 evaluateJavascript 驱动其引擎(不依赖其自身被冻结的计时器)。 */
    private WebView switchWeb() {
        for (Tab t : tabs) {
            if (t.web != null && t.url != null && t.url.endsWith("switch.html")) return t.web;
        }
        return null;
    }

    /** 从账号标签取其账号键(id, 退回 email); 非账号标签返回空串。 */
    private String acctKeyOf(Tab t) {
        if (t == null || t.accountJson == null) return "";
        try { JSONObject a = new JSONObject(t.accountJson); return a.optString("id", a.optString("email", "")); }
        catch (Exception e) { return ""; }
    }

    /** 用户点刷新 → 命令切号引擎: 当前账号优先即时刷(额度+状态), 再全量强制刷(绕过可见性门控)。 */
    private void triggerEngineRefresh(String accId) {
        WebView sw = switchWeb();
        if (sw == null) return;
        final String arg = JSONObject.quote(accId == null ? "" : accId);
        try { sw.evaluateJavascript("try{forceRefreshNow(" + arg + ")}catch(e){}", null); } catch (Exception ignored) {}
    }

    /** 把「当前已打开为标签的账号集合」推给切号引擎 → 这些号即使切号板块在后台也保持实时识别(状态+额度)，
     *  确保顶部标签「不管有没有对话都实时显示金额」。只涉及用户正开着的少数号·轻量, 全量122号轮仍受门控省网络。 */
    private void pushOpenAcctsToSwitch() {
        WebView sw = switchWeb();
        if (sw == null) return;
        org.json.JSONArray arr = new org.json.JSONArray();
        for (Tab t : tabs) {
            if (t.accountJson == null) continue;
            try {
                JSONObject a = new JSONObject(t.accountJson);
                String id = a.optString("id", "");
                String email = a.optString("email", "");
                if (!id.isEmpty()) arr.put(id.toLowerCase());
                if (!email.isEmpty()) arr.put(email.toLowerCase());
            } catch (Exception ignored) {}
        }
        try { sw.evaluateJavascript("try{setOpenAccts(" + arr.toString() + ")}catch(e){}", null); } catch (Exception ignored) {}
    }

    // ── 顶部页签美金表持久化: 进程被杀/重建/标签恢复后即时回显上次金额, 不必等引擎重探 ──────────
    private final Runnable saveTabDollarsTask = () -> {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            for (java.util.Map.Entry<String, String> e : sTabDollars.entrySet()) {
                if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty()) o.put(e.getKey(), e.getValue());
            }
            final String s = o.toString();
            ioExec.execute(() -> {
                try { getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_TAB_DOLLARS, s).apply(); } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    };
    /** 页签美金表落盘 (防抖 1s · 后台单线程 I/O, 不卡 UI)。 */
    private void scheduleSaveTabDollars() {
        main.removeCallbacks(saveTabDollarsTask);
        main.postDelayed(saveTabDollarsTask, 1000);
    }
    /** 启动时回读上次页签美金 → 标签恢复即带金额显示 (引擎尚未重探完也先有上次值, 金额「一直显示」)。 */
    private void loadTabDollars() {
        try {
            String s = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_TAB_DOLLARS, "");
            if (s == null || s.isEmpty()) return;
            org.json.JSONObject o = new org.json.JSONObject(s);
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) { String k = it.next(); String v = o.optString(k, ""); if (k != null && !k.isEmpty() && !v.isEmpty()) sTabDollars.put(k, v); }
        } catch (Exception ignored) {}
    }

    /** 页签「对话名+状态」推送 (切号面板 Native 桥与常驻引擎 RelayService 桥共用同一入口)。 */
    public void ipcSetTabStatus(String accountId, String convName, String status) {
        if (accountId == null || accountId.isEmpty()) return;
        sTabStatus.put(accountId, new String[]{ convName == null ? "" : convName, status == null ? "" : status });
        main.post(this::scheduleRenderTabStrip);
    }
    /** 页签实时剩余美金推送 ("$5"/空) — 同上双桥共用入口。 */
    public void ipcSetTabDollars(String accountId, String dollars) {
        if (accountId == null || accountId.isEmpty()) return;
        if (dollars == null) dollars = "";
        // 空值 = 引擎此刻无该号额度(未刷/暂取不到) → 保留上次金额, 绝不抹空 (页签金额「一直显示」之本); 仅真有数值才更新。
        if (dollars.isEmpty()) return;
        if (dollars.equals(sTabDollars.get(accountId))) return;   // 未变: 免重渲染/重落盘
        sTabDollars.put(accountId, dollars);
        scheduleSaveTabDollars();
        main.post(this::scheduleRenderTabStrip);
    }

    private static final long OPEN_REFRESH_MS = 6000;   // 已打开账号标签的实时刷新心跳周期(前台)
    private final Runnable openAcctTick = new Runnable() {
        @Override public void run() {
            if (!appForeground) return;
            pushOpenAcctsToSwitch();
            main.postDelayed(this, OPEN_REFRESH_MS);
        }
    };

    /** 引擎心跳(外驱): 前台期间用原生 Handler 周期直驱切号引擎的 engineHeartbeat() ——
     *  切号引擎 WebView 停泊后台时, Chromium 会节流/冻结其 JS 计时器且页面 hidden 恒真,
     *  其自身的状态轮询/额度心跳全被可见性门控拦下 → 自动刷新与对话提醒形同虚设。
     *  evaluateJavascript 不受计时器节流/页面可见性影响, 故由原生侧可靠驱动。 */
    private static final long ENGINE_TICK_MS = 8000;
    private static final long ENGINE_TICK_BG_MS = 30000;   // 后台降频不停跳: 对话阻塞/耗尽推送无需回前台才发(evaluateJavascript 不受 onPause 影响)
    private final Runnable engineTick = new Runnable() {
        @Override public void run() {
            WebView sw = switchWeb();
            if (sw != null) { try { sw.evaluateJavascript("try{engineHeartbeat()}catch(e){}", null); } catch (Exception ignored) {} }
            main.postDelayed(this, appForeground ? ENGINE_TICK_MS : ENGINE_TICK_BG_MS);
        }
    };

    // ── 浏览器功能 ────────────────────────────────────────────────────────
    private static final String DESKTOP_UA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    // 媒体鉴权代取: Devin 附件(截图/录屏视频等)在 app.devin.ai/attachments/ 下, 必须带
    //   Authorization 头(无鉴权 401)。页面 fetch/XHR 已注入 Bearer 头, 但 <img>/<video>/<audio>
    //   等媒体元素的加载由渲染器原生发起、不经 JS → 无鉴权 → 图片时有时无、视频完全无法播放。
    //   此处在原生层代取: 补 Authorization 转发(含 Range 头, 视频拖动/分段加载可用),
    //   30x 手动跟随且仅对 app.devin.ai 发凭据(token 不外泄给对象存储), 响应原样回灌(状态/头/流)。
    //   /attachments/ 的真鉴权是 httpOnly Cookie attachments_token(由 POST /api/users/set-attachment-cookie
    //   铸造·Bearer 对该路径无效) → 代取必须转发 CookieManager 里 WebView 存的 Cookie;
    //   401 时先铸造 Cookie 再重试一次(自愈), Cookie 同样只发 app.devin.ai。
    private WebResourceResponse authMediaResponse(Tab tab, WebResourceRequest req) {
        if (tab == null) return null;
        return authMediaResponseFor(tab.auth1, tab.orgId, req);
    }
    static WebResourceResponse authMediaResponseFor(String auth1, String orgId, WebResourceRequest req) {
        try {
            if (auth1 == null || auth1.isEmpty() || req == null) return null;
            Uri u = req.getUrl();
            if (u == null || !"GET".equalsIgnoreCase(req.getMethod())) return null;
            String host = u.getHost(), path = u.getPath();
            if (host == null || path == null || !host.equalsIgnoreCase("app.devin.ai")) return null;
            if (!path.startsWith("/attachments/")) return null;
            java.util.Map<String, String> rh = req.getRequestHeaders();
            if (rh != null) for (String k : rh.keySet())
                if (k != null && k.equalsIgnoreCase("Authorization")) return null;   // fetch/XHR 已带鉴权 → 不重复代取
            // 本源: /attachments/ 的真鉴权是 httpOnly Cookie attachments_token。Cookie 就绪时应
            //   一律交还 WebView 原生网络栈(返回 null): 原生并发加载/HTTP 缓存/Range·206·seek 全部
            //   与真浏览器一致 —— 代取字节流会 ① 把 <video> 的响应变成不可 seek 流 → FFmpegDemuxer
            //   "data source error" 无限重试; ② 每个图片/文档都占用 WebView 有限的拦截线程做 15-30s
            //   超时的同步网络 IO, 并发图片一多即互相饿死 → 图片时载时不载、整页请求(含点链接)僵死。
            //   Cookie 按 JWT exp 判新鲜(过期自动重铸), 铸不出时才回退代取(下方旧路径)。
            boolean isRange = false;
            if (rh != null) for (String k : rh.keySet())
                if (k != null && k.equalsIgnoreCase("Range")) { isRange = true; break; }
            if (ensureAttachmentCookie(auth1, orgId, u.toString())) return null;   // 原生直取(带 Cookie)
            if (isRange) return null;   // Cookie 铸造失败的流媒体: 代取必坏 seek, 交原生(至多 401)不更差
            java.net.HttpURLConnection c;
            try { c = fetchAttachment(auth1, orgId, u.toString(), rh, false); }
            catch (Exception e1) {
                // 默认路由(可能经已死 VPN)失败 → 绑底层非 VPN 网络重试一次 (自然回退)
                if (HttpBridge.vpnActive() && HttpBridge.directNetwork() != null)
                    c = fetchAttachment(auth1, orgId, u.toString(), rh, true);
                else throw e1;
            }
            if (c != null && c.getResponseCode() == 401) {
                // Cookie 缺失/过期 → 铸造 attachments_token 后重试一次 (自愈)
                try { c.disconnect(); } catch (Exception ignored) {}
                if (mintAttachmentCookie(auth1, orgId)) c = fetchAttachment(auth1, orgId, u.toString(), rh, false);
                else c = null;
            }
            if (c == null) return null;
            int code = c.getResponseCode();
            if (code < 200 || (code >= 300 && code < 400)) return null;
            String ctype = c.getContentType();
            String mime = "application/octet-stream", enc = null;
            if (ctype != null && !ctype.isEmpty()) {
                int sc = ctype.indexOf(';');
                mime = (sc >= 0 ? ctype.substring(0, sc) : ctype).trim();
                if (sc >= 0) {
                    int ci = ctype.toLowerCase(java.util.Locale.US).indexOf("charset=");
                    if (ci >= 0) { enc = ctype.substring(ci + 8).trim(); int semi = enc.indexOf(';'); if (semi >= 0) enc = enc.substring(0, semi).trim(); }
                }
            }
            java.util.Map<String, String> hdrs = new java.util.HashMap<>();
            for (int i = 0; ; i++) {
                String k = c.getHeaderFieldKey(i), vl = c.getHeaderField(i);
                if (k == null && vl == null) break;
                if (k == null) continue;
                String lk = k.toLowerCase(java.util.Locale.US);
                if (lk.equals("transfer-encoding") || lk.equals("connection") || lk.equals("content-encoding")) continue;
                hdrs.put(k, vl);
            }
            java.io.InputStream in = (code >= 400) ? c.getErrorStream() : c.getInputStream();
            if (in == null) in = new java.io.ByteArrayInputStream(new byte[0]);
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = "OK";
            WebResourceResponse resp = new WebResourceResponse(mime, enc, in);
            resp.setStatusCodeAndReasonPhrase(code, reason);
            resp.setResponseHeaders(hdrs);
            return resp;
        } catch (Exception e) { return null; }
    }
    /** 附件代取一次 (30x 手动跟随·凭据与 Cookie 只发 app.devin.ai)。 */
    private static java.net.HttpURLConnection fetchAttachment(String auth1, String orgId, String url, java.util.Map<String, String> rh, boolean direct) throws Exception {
        java.net.HttpURLConnection c = null;
        for (int hop = 0; hop < 5; hop++) {
            c = HttpBridge.openConn(url, direct);
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            if (rh != null) for (java.util.Map.Entry<String, String> e : rh.entrySet()) {
                String k = e.getKey();
                if (k == null) continue;
                String lk = k.toLowerCase(java.util.Locale.US);
                // Accept-Encoding 不转发: 交由底层透明 gzip (自动解压并剥 Content-Encoding/Length, 免回灌压缩体)
                // Cookie 不盲转发: 下方仅对 app.devin.ai 由 CookieManager 补 (30x 后不外泄给对象存储)
                if (lk.equals("authorization") || lk.equals("host") || lk.equals("accept-encoding") || lk.equals("cookie")) continue;
                try { c.setRequestProperty(k, e.getValue()); } catch (Exception ignored) {}
            }
            if ("app.devin.ai".equalsIgnoreCase(new java.net.URL(url).getHost())) {
                c.setRequestProperty("Authorization", "Bearer " + auth1);
                if (orgId != null && !orgId.isEmpty()) c.setRequestProperty("x-cog-org-id", orgId);
                try {
                    // attachments_token 铸造时服务端钉 Path=/attachments → 必须按附件真实路径取,
                    // 按根路径 "/" 取永远拿不到该 Cookie (铸了也 401)。
                    String ck = android.webkit.CookieManager.getInstance().getCookie(url);
                    if (ck != null && !ck.isEmpty()) c.setRequestProperty("Cookie", ck);   // attachments_token → /attachments 真鉴权
                } catch (Exception ignored) {}
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                if (loc == null) return null;
                url = new java.net.URL(new java.net.URL(url), loc).toString();
                try { c.disconnect(); } catch (Exception ignored) {}
                c = null;
                continue;
            }
            break;
        }
        return c;
    }
    /** attachments_token Cookie 是否存在、未过期、且属于目标组织。Token 是组织级作用域的不透明值，
     *  多账号多标签共用同一 CookieManager —— 他组织铸的 Cookie 对本标签附件必 403，
     *  故需记录铸造时的组织并按组织判新鲜 (JWT 则另解 exp, 留 60s 余量; 非 JWT 只判组织)。 */
    static boolean attachmentCookieFresh(String url) { return attachmentCookieFresh(url, null); }
    static boolean attachmentCookieFresh(String url, String orgId) {
        try {
            String ck = android.webkit.CookieManager.getInstance().getCookie(url);
            if (ck == null) return false;
            int i = ck.indexOf("attachments_token=");
            if (i < 0) return false;
            // 组织归属未知(重启后/非本层铸造)也视为不新鲜 —— 残留 Cookie 可能属他组织/已过期,
            //   误判新鲜即整站附件 Unauthorized 直到手动刷新; 重铸一次即归位(单飞+防抖, 代价极小)。
            if (orgId != null && !orgId.isEmpty() && !orgId.equals(cookieOrg())) return false;
            String v = ck.substring(i + 18);
            int sc = v.indexOf(';'); if (sc >= 0) v = v.substring(0, sc);
            String[] parts = v.split("\\.");
            if (parts.length >= 2) {
                try {
                    String payload = new String(android.util.Base64.decode(parts[1],
                            android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP), "UTF-8");
                    long exp = new org.json.JSONObject(payload).optLong("exp", 0);
                    if (exp > 0) return System.currentTimeMillis() / 1000 < exp - 60;
                } catch (Exception ignored) {}
            }
            // 不透明 token 无 exp 可解, 服务端过期对客户端不可见 —— 这正是「用着用着失效,
            //   重启才好」的病灶。按铸造时间保守判活(10 分钟), 超时即重铸(单飞+防抖·代价极小)。
            long mintAt = cookieMintAt();
            return mintAt > 0 && System.currentTimeMillis() - mintAt < 600000;
        } catch (Exception e) { return false; }
    }
    private static final Object MINT_LOCK = new Object();
    private static volatile long sLastMintAt = 0;
    private static volatile String sLastMintOrg = null;
    /** 最近一次成功铸造 attachments_token 的组织 (Cookie 作用域归属)。
     *  CookieManager 里的 Cookie 跨进程重启持久, 归属记忆也必须持久(SharedPreferences),
     *  否则重启后残留他组织 Cookie 被误判新鲜 → 附件全线 Unauthorized 直到手动刷新。 */
    private static volatile String sCookieOrg = null;
    private static volatile boolean sCookieOrgLoaded = false;
    static String cookieOrg() {
        if (!sCookieOrgLoaded) {
            try {
                android.content.Context ctx = HttpBridge.appCtx;
                if (ctx != null) {
                    String v = ctx.getSharedPreferences("rtflow", MODE_PRIVATE).getString("att_cookie_org", "");
                    sCookieOrg = v.isEmpty() ? null : v;
                    sCookieOrgLoaded = true;
                }
            } catch (Exception ignored) {}
        }
        return sCookieOrg;
    }
    static void setCookieOrg(String org) {
        sCookieOrg = (org == null || org.isEmpty()) ? null : org;
        sCookieOrgLoaded = true;
        sCookieMintAt = System.currentTimeMillis();
        try {
            android.content.Context ctx = HttpBridge.appCtx;
            if (ctx != null) ctx.getSharedPreferences("rtflow", MODE_PRIVATE).edit()
                    .putString("att_cookie_org", sCookieOrg == null ? "" : sCookieOrg)
                    .putLong("att_cookie_mint_at", sCookieMintAt).apply();
        } catch (Exception ignored) {}
    }
    private static volatile long sCookieMintAt = -1;
    static long cookieMintAt() {
        if (sCookieMintAt < 0) {
            try {
                android.content.Context ctx = HttpBridge.appCtx;
                if (ctx != null) sCookieMintAt = ctx.getSharedPreferences("rtflow", MODE_PRIVATE).getLong("att_cookie_mint_at", 0);
            } catch (Exception ignored) {}
        }
        return Math.max(sCookieMintAt, 0);
    }
    /** 确保目标组织的 attachments_token 就绪 (单飞铸造·同组织 3s 防抖, 防并发媒体请求触发铸造风暴)。 */
    static boolean ensureAttachmentCookie(String auth1, String orgId, String url) {
        if (attachmentCookieFresh(url, orgId)) return true;
        if (auth1 == null || auth1.isEmpty()) return false;
        synchronized (MINT_LOCK) {
            if (attachmentCookieFresh(url, orgId)) return true;
            long now = System.currentTimeMillis();
            boolean sameOrg = (orgId == null) ? (sLastMintOrg == null) : orgId.equals(sLastMintOrg);
            if (sameOrg && now - sLastMintAt < 3000) return false;
            sLastMintAt = now; sLastMintOrg = orgId;
            return mintAttachmentCookie(auth1, orgId) && attachmentCookieFresh(url, orgId);
        }
    }
    /** 铸造 attachments_token Cookie: POST set-attachment-cookie(Bearer 有效) → Set-Cookie 落入 CookieManager。 */
    static boolean mintAttachmentCookie(String auth1, String orgId) {
        if (auth1 == null || auth1.isEmpty()) return false;
        try { return mintAttachmentCookieVia(auth1, orgId, false); }
        catch (Exception e) {
            // 默认路由(可能经已死 VPN)失败 → 绑底层非 VPN 网络重试一次 (自然回退)
            if (HttpBridge.vpnActive() && HttpBridge.directNetwork() != null) {
                try { return mintAttachmentCookieVia(auth1, orgId, true); } catch (Exception ignored) {}
            }
            return false;
        }
    }
    private static boolean mintAttachmentCookieVia(String auth1, String orgId, boolean direct) throws Exception {
        {
            java.net.HttpURLConnection c = HttpBridge.openConn("https://app.devin.ai/api/users/set-attachment-cookie", direct);
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setRequestProperty("Authorization", "Bearer " + auth1);
            if (orgId != null && !orgId.isEmpty()) c.setRequestProperty("x-cog-org-id", orgId);
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            java.io.OutputStream os = c.getOutputStream(); os.write("{}".getBytes("UTF-8")); os.close();
            int code = c.getResponseCode();
            boolean got = false;
            java.util.Map<String, java.util.List<String>> hf = c.getHeaderFields();
            if (hf != null) for (java.util.Map.Entry<String, java.util.List<String>> e : hf.entrySet()) {
                if (e.getKey() == null || !e.getKey().equalsIgnoreCase("Set-Cookie") || e.getValue() == null) continue;
                android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                for (String v : e.getValue()) if (v != null && !v.isEmpty()) { cm.setCookie("https://app.devin.ai/", v); got = true; }
                if (got) try { cm.flush(); } catch (Exception ignored) {}
            }
            try { c.disconnect(); } catch (Exception ignored) {}
            boolean ok = got && code >= 200 && code < 300;
            if (ok) setCookieOrg(orgId);
            return ok;
        }
    }
    // 媒体鉴权本源补齐: 只有「账号标签」(accountJson 开页)才有 tab.auth1 —— 用户自己登录/链接打开的
    //   Devin 页 auth1 恒空 → 铸不了 attachments_token Cookie → 图片/视频全部 401(纯浏览器正常因
    //   它自己走过 SPA 的 set-attachment-cookie 流程)。此处从页面登录态(localStorage/sessionStorage
    //   的 auth1_session)采收 token/org 回灌 tab → 任何方式打开的 Devin 页媒体代取都能工作。幂等。
    private void harvestPageAuth(WebView v, Tab tab, String pageUrl) {
        try {
            if (v == null || tab == null || tab.auth1 != null && !tab.auth1.isEmpty()) return;
            if (pageUrl == null || !pageUrl.contains("app.devin.ai")) return;
            String js = "(function(){try{"
                + "var raw=sessionStorage.getItem('auth1_session')||localStorage.getItem('auth1_session');"
                + "var a=raw?JSON.parse(raw):null;if(!a||!a.token)return '';"
                + "var uid=a.userId||'';var org='';"
                + "try{var ko=JSON.parse(sessionStorage.getItem('known-org-ids-'+uid)||localStorage.getItem('known-org-ids-'+uid)||'[]');org=ko[0]||''}catch(_){}"
                + "if(!org)org=sessionStorage.getItem('last-internal-org-for-external-org-v1-null')||localStorage.getItem('last-internal-org-for-external-org-v1-null')||'';"
                + "return JSON.stringify({t:a.token,o:org});}catch(e){return ''}})()";
            v.evaluateJavascript(js, val -> {
                try {
                    if (val == null || val.length() < 4 || "null".equals(val)) return;
                    String json = new org.json.JSONTokener(val).nextValue().toString();
                    if (json == null || json.isEmpty()) return;
                    org.json.JSONObject o = new org.json.JSONObject(json);
                    String t = o.optString("t", "");
                    if (t.isEmpty()) return;
                    tab.auth1 = t; tab.orgId = o.optString("o", "");
                    warmAttachmentCookie(tab.auth1, tab.orgId, tab.url);
                } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    }
    /** 页面加载完成即预铸附件 Cookie (后台线程·幂等), 首次媒体加载即已授权。 */
    static void warmAttachmentCookie(final String auth1, final String orgId, final String pageUrl) {
        try {
            if (auth1 == null || auth1.isEmpty() || pageUrl == null || !pageUrl.contains("app.devin.ai")) return;
            if (attachmentCookieFresh("https://app.devin.ai/attachments/", orgId)) return;   // 本组织新鲜 → 不重复铸造 (过期/他组织则重铸)
            new Thread(() -> ensureAttachmentCookie(auth1, orgId, "https://app.devin.ai/attachments/")).start();
        } catch (Exception ignored) {}
    }
    /** 广告/追踪域名命中 (内置精简黑名单)。 */
    private boolean isAdHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase();
        String[] ad = {"doubleclick.net","googlesyndication.com","googleadservices.com","google-analytics.com",
                "googletagmanager.com","googletagservices.com","adservice.google.com","adnxs.com","adsystem.com",
                "scorecardresearch.com","moatads.com","amazon-adsystem.com","facebook.net","analytics.","pagead2.",
                "ads.","adservice.","track.","tracker.","pixel.","taboola.com","outbrain.com","criteo.com","pubmatic.com"};
        for (String a : ad) { if (a.endsWith(".") ? host.contains(a) : (host.equals(a) || host.endsWith("." + a) || host.contains(a))) return true; }
        return false;
    }
    /** 夜间反色: 整页 invert 滤镜 (图片/视频再 invert 还原)。 */
    private void applyNight(WebView w, boolean on) {
        if (w == null) return;
        String js = on
            ? "(function(){var id='__rtnight';if(document.getElementById(id))return;var s=document.createElement('style');s.id=id;s.textContent='html{filter:invert(1) hue-rotate(180deg)!important;background:#fff!important}img,video,canvas,iframe,svg,[style*=\"background-image\"]{filter:invert(1) hue-rotate(180deg)!important}';document.documentElement.appendChild(s);})();"
            : "(function(){var e=document.getElementById('__rtnight');if(e)e.remove();})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    /** 页内查找栏 (Ctrl+F): 输入即高亮, ▲▼ 切换匹配。 */
    private android.widget.LinearLayout findBar;
    private void toggleFindBar() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        if (findBar != null && findBar.getParent() != null) { closeFindBar(); return; }
        final WebView web = t.web;
        findBar = new android.widget.LinearLayout(this);
        findBar.setOrientation(android.widget.LinearLayout.HORIZONTAL);
        findBar.setBackgroundColor(0xFF21262D);
        findBar.setGravity(Gravity.CENTER_VERTICAL);
        findBar.setPadding(dp(8), dp(4), dp(8), dp(4));
        final EditText q = new EditText(this);
        q.setSingleLine(true); q.setHint("页内查找"); q.setTextColor(0xFFE6EDF3); q.setHintTextColor(0xFF6E7681);
        q.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14); q.setBackgroundColor(0xFF0D1117); q.setPadding(dp(8), dp(6), dp(8), dp(6));
        q.setLayoutParams(new android.widget.LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        q.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { try { web.findAllAsync(s.toString()); } catch (Exception ignored) {} }
            @Override public void afterTextChanged(android.text.Editable s) {}
        });
        Button prev = chipBtnSm("\u25B2"); prev.setOnClickListener(v -> { try { web.findNext(false); } catch (Exception ignored) {} });
        Button next = chipBtnSm("\u25BC"); next.setOnClickListener(v -> { try { web.findNext(true); } catch (Exception ignored) {} });
        Button close = chipBtnSm("\u2715"); close.setOnClickListener(v -> closeFindBar());
        findBar.addView(q); findBar.addView(prev); findBar.addView(next); findBar.addView(close);
        content.addView(findBar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
        q.requestFocus();
    }
    private void closeFindBar() {
        Tab t = cur(); if (t != null) try { t.web.clearMatches(); } catch (Exception ignored) {}
        if (findBar != null && findBar.getParent() != null) ((ViewGroup) findBar.getParent()).removeView(findBar);
        findBar = null;
    }
    /** 桌面版/移动版 UA 切换。 */
    private void toggleDesktop() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        t.desktop = !t.desktop;
        WebSettings st = t.web.getSettings();
        if (t.desktop) { st.setUserAgentString(DESKTOP_UA); st.setUseWideViewPort(true); st.setLoadWithOverviewMode(true); toast("已切桌面版"); }
        else { st.setUserAgentString(null); toast("已切移动版"); }
        t.web.reload();
    }
    private void toggleNight() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        t.night = !t.night; applyNight(t.web, t.night); toast(t.night ? "夜间模式开" : "夜间模式关");
    }
    /** 阅读模式: 提取正文, 去广告/侧栏, 大字号深色阅读。 */
    private void readerMode() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        String js = "(function(){try{var best=null,max=0;var ps=document.querySelectorAll('article,main,[role=main],.content,.post,#content');"
            + "for(var i=0;i<ps.length;i++){var l=(ps[i].innerText||'').length;if(l>max){max=l;best=ps[i];}}"
            + "if(!best||max<200){best=document.body;}var html=best.innerHTML;"
            + "document.head.innerHTML='';document.body.innerHTML=\"<div id='rtread'>\"+html+\"</div>\";"
            + "var s=document.createElement('style');s.textContent=\"body{background:#15171a!important;margin:0}#rtread{max-width:720px;margin:0 auto;padding:24px 18px;color:#d6dae0;font:18px/1.7 -apple-system,Georgia,serif}#rtread img{max-width:100%;height:auto}#rtread a{color:#6cb6ff}\";document.head.appendChild(s);}catch(e){}})();";
        try { t.web.evaluateJavascript(js, null); toast("阅读模式"); } catch (Exception e) { toast("无法进入阅读模式"); }
    }
    private void toggleAdBlock() { adBlock = !adBlock; toast(adBlock ? "广告/弹窗拦截: 开" : "广告/弹窗拦截: 关"); Tab t = cur(); if (t != null) t.web.reload(); }
    private void openIncognito() { newTabIncognito(DEVIN); }
    private Tab newTabIncognito(String url) {
        Tab tab = makeTab(null, false);
        tab.incognito = true;
        try {
            WebSettings st = tab.web.getSettings();
            st.setSaveFormData(false);
            st.setSavePassword(false);
            st.setCacheMode(WebSettings.LOAD_NO_CACHE);   // 无痕: 不留磁盘缓存
        } catch (Exception ignored) {}
        // 无痕: 不接受第三方 Cookie (减少跨站跟踪); 同源 Cookie 仍随会话存在, 但页面不入历史/不存表单密码
        try { if (Build.VERSION.SDK_INT >= 21) android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(tab.web, false); } catch (Exception ignored) {}
        loadInto(tab, url);
        selectTab(tabs.size() - 1);
        renderTabStrip();
        toast("无痕标签 (不记历史 / 不存表单密码 / 无磁盘缓存)");
        return tab;
    }
    private void shareCurrent() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        String u = displayUrl(t);
        try { Intent it = new Intent(Intent.ACTION_SEND); it.setType("text/plain");
            it.putExtra(Intent.EXTRA_SUBJECT, t.title == null ? u : t.title); it.putExtra(Intent.EXTRA_TEXT, u);
            startActivity(Intent.createChooser(it, "分享本页")); } catch (Exception e) { toast("无法分享"); }
    }
    private void copyCurrentUrl() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        try { ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("url", displayUrl(t))); toast("已复制网址"); } catch (Exception e) { toast("复制失败"); }
    }
    /** 顶栏翻译: 一键整页翻译 (Edge 浏览器内置免费引擎·无 key·国内可直连), 再点恢复原文。 */
    private void toggleTranslate() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        String u = displayUrl(t);
        if (u == null || u.startsWith("rtflow:") || u.startsWith("file:")) { toast("内部页不可翻译"); return; }
        if (t.translated) { t.translated = false; toast("恢复原文");
            try { t.web.evaluateJavascript("window.__dcTransRestore&&window.__dcTransRestore()", null); } catch (Exception ignored) {}
            return; }
        t.translated = true; toast("翻译中…"); applyTranslate(t.web);
    }
    /** 注入内容脚本翻译引擎 (translate.js): 遍历文本节点 → 经原生桥 __dcTr 调 Edge 翻译 API → 回填译文。 */
    private void applyTranslate(WebView w) {
        if (w == null) return;
        String js = readAssetText("engine/translate.js");
        if (js == null || js.isEmpty()) return;
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    /** 页面加载完: 若该站有保存登录, 自动填充 (Chrome 式无感, 不覆盖已填内容)。 */
    private void autoFillLogin(WebView w, String url) {
        String host = hostOf(url); if (host.isEmpty()) return;
        try {
            org.json.JSONObject all = new org.json.JSONObject(loginsRaw());
            if (!all.has(host)) return;
            org.json.JSONObject c = all.getJSONObject(host);
            String u = c.optString("u", "").replace("\\", "\\\\").replace("'", "\\'");
            String p = c.optString("p", "").replace("\\", "\\\\").replace("'", "\\'");
            String js = "(function(){try{var pw=document.querySelector('input[type=password]');if(!pw)return;if(pw.value)return;"
                + "function set(el,v){var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}"
                + "var ins=document.querySelectorAll('input');var pi=-1;for(var i=0;i<ins.length;i++){if(ins[i]===pw){pi=i;break;}}"
                + "for(var j=pi-1;j>=0;j--){var tp=(ins[j].type||'').toLowerCase();if(tp==='text'||tp==='email'||tp==='tel'||tp===''){set(ins[j],'" + u + "');break;}}"
                + "set(pw,'" + p + "');}catch(e){}})();";
            w.evaluateJavascript(js, null);
        } catch (Exception ignored) {}
    }
    /** 注入登录捕获: 用户提交含密码的表单时回调原生 → 自动弹「保存登录？」。 */
    private void installLoginCapture(WebView w) {
        String js = "(function(){try{if(window.__dcLc)return;window.__dcLc=1;"
            + "function grab(){try{var pw=document.querySelector('input[type=password]');if(!pw||!pw.value)return;"
            + "var u='';var ins=document.querySelectorAll('input');var pi=-1;for(var i=0;i<ins.length;i++){if(ins[i]===pw){pi=i;break;}}"
            + "for(var j=pi-1;j>=0;j--){var tp=(ins[j].type||'').toLowerCase();if(tp==='text'||tp==='email'||tp==='tel'||tp===''){u=ins[j].value||'';break;}}"
            + "if(window.__dcaf&&__dcaf.onLogin)__dcaf.onLogin(u,pw.value);}catch(e){}}"
            + "document.addEventListener('submit',grab,true);"
            + "document.addEventListener('click',function(e){try{var t=e.target;if(!t)return;var tag=(t.tagName||'').toLowerCase();var ty=(t.type||'').toLowerCase();"
            + "if(tag==='button'||ty==='submit'||ty==='button'||(t.getAttribute&&t.getAttribute('role')==='button'))setTimeout(grab,80);}catch(e){}},true);"
            + "document.addEventListener('keydown',function(e){if(e.key==='Enter')setTimeout(grab,80);},true);"
            + "}catch(e){}})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    /** 登录捕获桥 (仅普通网页): 表单提交 → 自动弹「保存登录？」(Chrome 式无感)。 */
    public class AutofillBridge {
        private final WebView owner;
        AutofillBridge(WebView w) { this.owner = w; }
        @JavascriptInterface public void onLogin(String u, String p) {
            if (p == null || p.isEmpty()) return;
            main.post(() -> promptSaveLogin(owner, u, p));
        }
    }

    // ── 整页翻译: Edge 浏览器内置翻译引擎 (免费·无 key·国内可直连) ──────────────
    //   令牌: GET edge.microsoft.com/translate/auth (JWT 约 10 分钟, 缓存复用)
    //   翻译: POST api-edge.cognitive.microsofttranslator.com/translate
    //   走原生 HTTP → 绕开页面 CSP/同源策略 (浏览器扩展用后台页, 我们用原生桥, 等效)
    private static String sTransToken = "";
    private static long sTransTokenTs = 0;
    private static final Object sTransLock = new Object();
    private String ensureTransToken() throws Exception {
        synchronized (sTransLock) {
            if (!sTransToken.isEmpty() && System.currentTimeMillis() - sTransTokenTs < 8 * 60 * 1000) return sTransToken;
        }
        HttpURLConnection c = (HttpURLConnection) new URL("https://edge.microsoft.com/translate/auth").openConnection();
        try {
            c.setConnectTimeout(8000); c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0");
            InputStream is = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096]; int n; while ((n = is.read(buf)) > 0) bos.write(buf, 0, n); is.close();
            String tok = new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
            synchronized (sTransLock) { sTransToken = tok; sTransTokenTs = System.currentTimeMillis(); }
            return tok;
        } finally { c.disconnect(); }
    }
    /** 文本数组 → 译文数组 (顺序一致, 失败项为空串)。后台线程调用。 */
    private org.json.JSONArray doTranslate(org.json.JSONArray texts, String to) throws Exception {
        String token = ensureTransToken();
        org.json.JSONArray body = new org.json.JSONArray();
        for (int i = 0; i < texts.length(); i++) {
            org.json.JSONObject o = new org.json.JSONObject(); o.put("Text", texts.optString(i, "")); body.put(o);
        }
        String tgt = (to == null || to.isEmpty()) ? "zh-Hans" : to;
        String url = "https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to="
            + java.net.URLEncoder.encode(tgt, "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000); c.setReadTimeout(15000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            c.setRequestProperty("Authorization", "Bearer " + token);
            java.io.OutputStream os = c.getOutputStream();
            os.write(body.toString().getBytes(StandardCharsets.UTF_8)); os.close();
            int code = c.getResponseCode();
            InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096]; int n; while (is != null && (n = is.read(buf)) > 0) bos.write(buf, 0, n);
            if (is != null) is.close();
            if (code == 401) synchronized (sTransLock) { sTransToken = ""; }   // 令牌过期 → 下次重取
            org.json.JSONArray res = new org.json.JSONArray(new String(bos.toByteArray(), StandardCharsets.UTF_8));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < res.length(); i++) {
                org.json.JSONArray tr = res.getJSONObject(i).optJSONArray("translations");
                out.put((tr != null && tr.length() > 0) ? tr.getJSONObject(0).optString("text", "") : "");
            }
            return out;
        } finally { c.disconnect(); }
    }
    public class TranslateBridge {
        private final WebView owner;
        TranslateBridge(WebView w) { this.owner = w; }
        @JavascriptInterface public void translate(String reqId, String textsJson, String to) {
            if (reqId == null || textsJson == null) return;
            new Thread(() -> {
                String b64;
                try {
                    org.json.JSONArray out = doTranslate(new org.json.JSONArray(textsJson), to);
                    b64 = android.util.Base64.encodeToString(out.toString().getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
                } catch (Exception e) {
                    b64 = android.util.Base64.encodeToString("[]".getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
                }
                final String fb64 = b64; final String rid = reqId.replace("\\", "\\\\").replace("'", "\\'");
                main.post(() -> { try {
                    owner.evaluateJavascript("window.__dcTrCb&&window.__dcTrCb('" + rid + "','" + fb64 + "')", null);
                } catch (Exception ignored) {} });
            }).start();
        }
        @JavascriptInterface public void report(int count) {
            main.post(() -> toast(count > 0 ? ("已翻译 " + count + " 段") : "本页无可翻译内容"));
        }
    }

    // ── 用户脚本引擎 (油猴 Tampermonkey 兼容) ───────────────────────────────
    //   装不了真·Chrome 扩展(系统 WebView 不支持), 但能跑标准 .user.js:
    //   解析 ==UserScript== 元数据 → 按 @match/@run-at 在每页注入 → 提供 GM_* API。
    //   脚本与 GM 存储落共享保险箱(Documents/DevinCloud), 卸载/重装不丢。
    //   GM_xmlhttpRequest 走原生桥 → 天然跨域、绕开页面 CSP (等同油猴后台请求)。
    private final Object usLock = new Object();
    private String b64(String s) {
        return android.util.Base64.encodeToString(s.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
    }
    org.json.JSONArray usLoadAll() {
        synchronized (usLock) {
            try {
                String s = vaultRead("userscripts");
                if (s == null || s.isEmpty()) s = getSharedPreferences(PREFS, 0).getString("userscripts", "");
                if (s == null || s.isEmpty()) return new org.json.JSONArray();
                return new org.json.JSONArray(s);
            } catch (Exception e) { return new org.json.JSONArray(); }
        }
    }
    private void usSaveAll(org.json.JSONArray a) {
        synchronized (usLock) {
            vaultWrite("userscripts", a.toString());
            getSharedPreferences(PREFS, 0).edit().putString("userscripts", a.toString()).apply();
        }
    }
    private org.json.JSONObject gmStore() {
        synchronized (usLock) {
            try {
                String s = vaultRead("us-store");
                if (s == null || s.isEmpty()) s = getSharedPreferences(PREFS, 0).getString("us-store", "");
                if (s == null || s.isEmpty()) return new org.json.JSONObject();
                return new org.json.JSONObject(s);
            } catch (Exception e) { return new org.json.JSONObject(); }
        }
    }
    private void gmStoreSave(org.json.JSONObject o) {
        synchronized (usLock) {
            vaultWrite("us-store", o.toString());
            getSharedPreferences(PREFS, 0).edit().putString("us-store", o.toString()).apply();
        }
    }
    private String httpGetText(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000); c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0");
            int code = c.getResponseCode();
            InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] b = new byte[4096]; int n; while (is != null && (n = is.read(b)) > 0) bos.write(b, 0, n);
            if (is != null) is.close();
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; } finally { if (c != null) c.disconnect(); }
    }
    /** 解析 .user.js 的 ==UserScript== 元数据块 → 脚本对象 (含 source)。 */
    private org.json.JSONObject usParse(String code) {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            o.put("source", code); o.put("enabled", true);
            org.json.JSONArray matches = new org.json.JSONArray(), includes = new org.json.JSONArray(),
                    excludes = new org.json.JSONArray(), grants = new org.json.JSONArray(), requires = new org.json.JSONArray();
            String name = "", ns = "", ver = "", runAt = "end", desc = "", dl = "", up = "";
            int a = code.indexOf("==UserScript=="), b = code.indexOf("==/UserScript==");
            if (a >= 0 && b > a) {
                for (String ln : code.substring(a, b).split("\n")) {
                    int at = ln.indexOf('@'); if (at < 0) continue;
                    String rest = ln.substring(at + 1).trim();
                    int sp = rest.indexOf(' '); int tb = rest.indexOf('\t');
                    if (sp < 0 || (tb >= 0 && tb < sp)) sp = tb;
                    String key = sp < 0 ? rest : rest.substring(0, sp);
                    String val = sp < 0 ? "" : rest.substring(sp + 1).trim();
                    switch (key) {
                        case "name": if (name.isEmpty()) name = val; break;
                        case "namespace": ns = val; break;
                        case "version": ver = val; break;
                        case "description": if (desc.isEmpty()) desc = val; break;
                        case "match": matches.put(val); break;
                        case "include": includes.put(val); break;
                        case "exclude": excludes.put(val); break;
                        case "grant": grants.put(val); break;
                        case "require": requires.put(val); break;
                        case "run-at": runAt = val.contains("start") ? "start" : (val.contains("idle") ? "idle" : "end"); break;
                        case "downloadURL": dl = val; break;
                        case "updateURL": up = val; break;
                    }
                }
            }
            o.put("name", name.isEmpty() ? "未命名脚本" : name);
            o.put("namespace", ns); o.put("version", ver); o.put("description", desc); o.put("runAt", runAt);
            o.put("matches", matches); o.put("includes", includes); o.put("excludes", excludes);
            o.put("grants", grants); o.put("requires", requires); o.put("downloadURL", dl); o.put("updateURL", up);
        } catch (Exception e) {}
        return o;
    }
    /** 新增或更新脚本 (按 name+namespace 去重), 同时抓取 @require 依赖内联。返回脚本 id 或 ""。 */
    String usAddOrUpdate(String code) {
        try {
            org.json.JSONObject o = usParse(code);
            org.json.JSONArray reqs = o.optJSONArray("requires");
            StringBuilder rc = new StringBuilder();
            if (reqs != null) for (int i = 0; i < reqs.length(); i++) {
                String r = httpGetText(reqs.optString(i)); if (r != null) rc.append(r).append("\n;\n");
            }
            o.put("requireCode", rc.toString());
            org.json.JSONArray all = usLoadAll();
            String nm = o.optString("name"), ns = o.optString("namespace");
            int found = -1; String fid = null;
            for (int i = 0; i < all.length(); i++) {
                org.json.JSONObject e = all.optJSONObject(i);
                if (e != null && nm.equals(e.optString("name")) && ns.equals(e.optString("namespace"))) {
                    found = i; fid = e.optString("id"); o.put("enabled", e.optBoolean("enabled", true)); break;
                }
            }
            String id = (fid != null && !fid.isEmpty()) ? fid : ("us_" + System.currentTimeMillis() + "_" + Math.abs((nm + ns).hashCode()));
            o.put("id", id);
            if (found >= 0) all.put(found, o); else all.put(o);
            usSaveAll(all);
            return id;
        } catch (Exception e) { return ""; }
    }
    private boolean usGlobMatch(String pat, String url) {
        if (pat == null || pat.isEmpty()) return false;
        try {
            if (pat.length() > 2 && pat.startsWith("/") && pat.endsWith("/"))
                return java.util.regex.Pattern.compile(pat.substring(1, pat.length() - 1)).matcher(url).find();
            StringBuilder re = new StringBuilder("^");
            for (int i = 0; i < pat.length(); i++) {
                char c = pat.charAt(i);
                if (c == '*') re.append(".*");
                else if ("\\.[]{}()+-^$|?".indexOf(c) >= 0) re.append('\\').append(c);
                else re.append(c);
            }
            re.append("$");
            return java.util.regex.Pattern.compile(re.toString()).matcher(url).matches();
        } catch (Exception e) { return false; }
    }
    private boolean usMatches(org.json.JSONObject s, String url) {
        try {
            org.json.JSONArray ex = s.optJSONArray("excludes");
            if (ex != null) for (int i = 0; i < ex.length(); i++) if (usGlobMatch(ex.optString(i), url)) return false;
            org.json.JSONArray m = s.optJSONArray("matches");
            if (m != null) for (int i = 0; i < m.length(); i++) if (usGlobMatch(m.optString(i), url)) return true;
            org.json.JSONArray inc = s.optJSONArray("includes");
            if (inc != null) for (int i = 0; i < inc.length(); i++) if (usGlobMatch(inc.optString(i), url)) return true;
            return false;
        } catch (Exception e) { return false; }
    }
    /** 油猴脚本菜单 (GM_registerMenuCommand): 读当前页注册的菜单命令并列出, 选中即触发回调。 */
    private void showUserscriptMenu() {
        Tab t = cur();
        if (t == null || t.web == null) { toast("无页面"); return; }
        String u = displayUrl(t);
        if (u == null || u.startsWith("rtflow:") || u.startsWith("file:") || u.startsWith("about:")) { toast("请在网页上使用脚本菜单"); return; }
        String js = "(function(){try{var m=window.__dcusMenus||[];return JSON.stringify(m.map(function(x){return ''+x.caption;}));}catch(e){return '[]';}})();";
        try { t.web.evaluateJavascript(js, val -> {
            try {
                if (val == null) { toast("读取菜单失败"); return; }
                String json = new org.json.JSONTokener(val).nextValue().toString();
                org.json.JSONArray a = new org.json.JSONArray(json);
                if (a.length() == 0) { toast("本页无脚本菜单命令"); return; }
                final String[] caps = new String[a.length()];
                for (int i = 0; i < a.length(); i++) caps[i] = a.optString(i);
                new android.app.AlertDialog.Builder(this)
                    .setTitle("脚本菜单 (油猴)")
                    .setItems(caps, (d, w) -> {
                        try { t.web.evaluateJavascript("(function(){try{var m=window.__dcusMenus||[];var f=m[" + w + "];if(f&&typeof f.fn==='function')f.fn();}catch(e){}})();", null); }
                        catch (Exception e) {}
                    })
                    .setNegativeButton("关闭", null)
                    .show();
            } catch (Exception e) { toast("读取菜单失败"); }
        }); } catch (Exception e) { toast("读取菜单失败"); }
    }
    /** 在页面注入所有匹配且启用的脚本 (phase: "start"=document-start, "end"=document-end/idle)。 */
    private void injectUserScripts(WebView w, String url, String phase) {
        if (w == null || url == null) return;
        if (url.startsWith("rtflow:") || url.startsWith("file:") || url.startsWith("about:")) return;
        try {
            org.json.JSONArray all = usLoadAll();
            if (all.length() == 0) return;
            StringBuilder js = new StringBuilder();
            boolean runtimeAdded = false;
            for (int i = 0; i < all.length(); i++) {
                org.json.JSONObject s = all.optJSONObject(i);
                if (s == null || !s.optBoolean("enabled", true)) continue;
                String want = "start".equals(s.optString("runAt", "end")) ? "start" : "end";
                if (!want.equals(phase)) continue;
                if (!usMatches(s, url)) continue;
                if (!runtimeAdded) { String rt = readAssetText("engine/userscript.js"); if (rt != null) js.append(rt).append("\n"); runtimeAdded = true; }
                String id = s.optString("id");
                String metaB64 = b64(s.toString());
                String req = s.optString("requireCode", "");
                String code = s.optString("source", "");
                js.append("(function(){try{var __g=window.__dcMakeGM('").append(id).append("',window.__dcB64d('").append(metaB64).append("'));")
                  .append("var GM=__g.GM,GM_info=__g.GM_info,GM_setValue=__g.GM_setValue,GM_getValue=__g.GM_getValue,GM_deleteValue=__g.GM_deleteValue,GM_listValues=__g.GM_listValues,GM_xmlhttpRequest=__g.GM_xmlhttpRequest,GM_xmlHttpRequest=__g.GM_xmlhttpRequest,GM_addStyle=__g.GM_addStyle,GM_openInTab=__g.GM_openInTab,GM_setClipboard=__g.GM_setClipboard,GM_registerMenuCommand=__g.GM_registerMenuCommand,GM_notification=__g.GM_notification,GM_getResourceText=__g.GM_getResourceText,GM_getResourceURL=__g.GM_getResourceURL,GM_log=__g.GM_log,unsafeWindow=window;\n")
                  .append(req).append("\n").append(code).append("\n}catch(e){try{window.__dcus&&window.__dcus.log('userscript error: '+e);}catch(_){} }})();\n");
            }
            if (js.length() > 0) w.evaluateJavascript(js.toString(), null);
        } catch (Exception ignored) {}
    }
    /** GM_* 后端 + 跨域 xhr: 仅普通网页暴露 (__dcus), 与 __dcaf 同安全边界。 */
    public class UserScriptBridge {
        private final WebView owner;
        UserScriptBridge(WebView w) { this.owner = w; }
        @JavascriptInterface public String gmGet(String sid, String key) {
            try { org.json.JSONObject sc = gmStore().optJSONObject(sid); return sc == null ? "" : sc.optString(key, ""); }
            catch (Exception e) { return ""; }
        }
        @JavascriptInterface public void gmSet(String sid, String key, String val) {
            try { org.json.JSONObject st = gmStore(); org.json.JSONObject sc = st.optJSONObject(sid);
                if (sc == null) { sc = new org.json.JSONObject(); st.put(sid, sc); }
                sc.put(key, val); gmStoreSave(st); } catch (Exception e) {}
        }
        @JavascriptInterface public void gmDel(String sid, String key) {
            try { org.json.JSONObject st = gmStore(); org.json.JSONObject sc = st.optJSONObject(sid);
                if (sc != null) { sc.remove(key); gmStoreSave(st); } } catch (Exception e) {}
        }
        @JavascriptInterface public String gmList(String sid) {
            try { org.json.JSONObject sc = gmStore().optJSONObject(sid); org.json.JSONArray out = new org.json.JSONArray();
                if (sc != null) { java.util.Iterator<String> it = sc.keys(); while (it.hasNext()) out.put(it.next()); }
                return out.toString(); } catch (Exception e) { return "[]"; }
        }
        @JavascriptInterface public void xhr(String reqId, String optsJson) {
            new Thread(() -> {
                int status = 0; String bodyB64 = ""; String hdrs = "{}";
                HttpURLConnection c = null;
                try {
                    org.json.JSONObject o = new org.json.JSONObject(optsJson);
                    String method = o.optString("method", "GET").toUpperCase();
                    c = (HttpURLConnection) new URL(o.getString("url")).openConnection();
                    c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setRequestMethod(method);
                    org.json.JSONObject hs = o.optJSONObject("headers");
                    if (hs != null) { java.util.Iterator<String> it = hs.keys(); while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, hs.optString(k)); } }
                    String data = o.optString("data", "");
                    if (!data.isEmpty() && !"GET".equals(method) && !"HEAD".equals(method)) {
                        c.setDoOutput(true); java.io.OutputStream os = c.getOutputStream();
                        os.write(data.getBytes(StandardCharsets.UTF_8)); os.close();
                    }
                    status = c.getResponseCode();
                    InputStream is = (status >= 200 && status < 400) ? c.getInputStream() : c.getErrorStream();
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096]; int n; while (is != null && (n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    if (is != null) is.close();
                    bodyB64 = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
                    org.json.JSONObject hj = new org.json.JSONObject();
                    for (java.util.Map.Entry<String, java.util.List<String>> e : c.getHeaderFields().entrySet())
                        if (e.getKey() != null) hj.put(e.getKey().toLowerCase(), android.text.TextUtils.join(", ", e.getValue()));
                    hdrs = hj.toString();
                } catch (Exception e) { status = 0; } finally { if (c != null) c.disconnect(); }
                final int fs = status; final String fb = bodyB64; final String fh = b64(hdrs);
                final String rid = reqId.replace("\\", "\\\\").replace("'", "\\'");
                main.post(() -> { try { owner.evaluateJavascript(
                        "window.__dcusXhrCb&&window.__dcusXhrCb('" + rid + "'," + fs + ",'" + fb + "','" + fh + "')", null);
                } catch (Exception ig) {} });
            }).start();
        }
        @JavascriptInterface public void openTab(String url) { main.post(() -> { try { newTab(url, null); } catch (Exception e) {} }); }
        @JavascriptInterface public void setClip(String text) {
            main.post(() -> { try { ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("us", text)); } catch (Exception e) {} });
        }
        @JavascriptInterface public void notify(String text) { main.post(() -> toast(text)); }
        @JavascriptInterface public void menu(String sid, String caption, String fnId) { /* v1: 接受但不渲染菜单项 */ }
        @JavascriptInterface public void log(String s) { android.util.Log.d("RTUS", String.valueOf(s)); }
    }

    private long lastSavePrompt = 0;
    private void promptSaveLogin(WebView w, String u, String p) {
        try {
            if (w == null || isFinishing() || p == null || p.isEmpty()) return;
            for (Tab t : tabs) { if (t.web == w) { if (t.incognito) return; break; } }   // 无痕标签不提示保存密码
            long now = System.currentTimeMillis(); if (now - lastSavePrompt < 1500) return; // 防抖
            String host = hostOf(w.getUrl() == null ? "" : w.getUrl());
            if (host.isEmpty()) return;
            org.json.JSONObject all = new org.json.JSONObject(loginsRaw());
            if (all.has(host)) {
                org.json.JSONObject ex = all.getJSONObject(host);
                if (p.equals(ex.optString("p", "")) && (u == null ? "" : u).equals(ex.optString("u", ""))) return; // 未变化不打扰
            }
            lastSavePrompt = now;
            final String fu = (u == null) ? "" : u; final String fp = p; final String fh = host;
            new android.app.AlertDialog.Builder(this)
                .setTitle("保存 " + host + " 的登录？")
                .setMessage("账号: " + (fu.isEmpty() ? "(空)" : fu) + "\n下次访问将自动填充。")
                .setPositiveButton("保存", (d, wi) -> { try {
                    org.json.JSONObject a2 = new org.json.JSONObject(loginsRaw());
                    org.json.JSONObject c = new org.json.JSONObject(); c.put("u", fu); c.put("p", fp);
                    a2.put(fh, c); String s = a2.toString();
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("logins", s).apply(); vaultWrite("logins", s);
                    toast("已保存 " + fh + " 登录");
                } catch (Exception e) {} })
                .setNegativeButton("不保存", null)
                .show();
        } catch (Exception ignored) {}
    }
    /** 把当前页加为主屏快捷方式 (固定图标)。 */
    private void addHomeShortcut() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        String u = displayUrl(t); String label = (t.title == null || t.title.isEmpty()) ? u : t.title;
        if (label.length() > 24) label = label.substring(0, 24);
        try {
            android.content.pm.ShortcutManager sm = getSystemService(android.content.pm.ShortcutManager.class);
            if (sm != null && sm.isRequestPinShortcutSupported()) {
                Intent open = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse(u));
                android.content.pm.ShortcutInfo si = new android.content.pm.ShortcutInfo.Builder(this, "rt_" + u.hashCode())
                    .setShortLabel(label)
                    .setIcon(android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_launcher))
                    .setIntent(open).build();
                sm.requestPinShortcut(si, null); toast("已请求添加到主屏");
            } else toast("当前桌面不支持快捷方式");
        } catch (Exception e) { toast("添加失败"); }
    }
    /** 标签总览: 网格列出所有标签, 点选切换, ✕ 关闭。 */
    private void showTabOverview() {
        final android.app.Dialog d = new android.app.Dialog(this, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        android.widget.ScrollView sv = new android.widget.ScrollView(this);
        sv.setBackgroundColor(0xFF0E1116);
        android.widget.LinearLayout col = new android.widget.LinearLayout(this);
        col.setOrientation(android.widget.LinearLayout.VERTICAL); col.setPadding(dp(12), dp(12), dp(12), dp(12));
        TextView h = new TextView(this); h.setText("标签总览 (" + tabs.size() + ")"); h.setTextColor(0xFF9CDCFE);
        h.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16); h.setPadding(dp(4), dp(4), dp(4), dp(10)); col.addView(h);
        for (int i = 0; i < tabs.size(); i++) {
            final int idx = i; Tab t = tabs.get(i);
            android.widget.LinearLayout card = new android.widget.LinearLayout(this);
            card.setOrientation(android.widget.LinearLayout.HORIZONTAL); card.setGravity(Gravity.CENTER_VERTICAL);
            card.setBackgroundColor(idx == active ? 0xFF1F3A45 : 0xFF161B22);
            card.setPadding(dp(12), dp(12), dp(8), dp(12));
            android.widget.LinearLayout.LayoutParams clp = new android.widget.LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.bottomMargin = dp(8); card.setLayoutParams(clp);
            TextView ti = new TextView(this); ti.setText((t.incognito ? "🕶 " : "") + chipTitle(t));
            ti.setTextColor(0xFFE6EDF3); ti.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14); ti.setSingleLine(true);
            ti.setLayoutParams(new android.widget.LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            Button x = chipBtnSm("\u2715");
            card.addView(ti); card.addView(x);
            card.setOnClickListener(v -> { selectTab(idx); d.dismiss(); });
            x.setOnClickListener(v -> { closeTab(idx); d.dismiss(); showTabOverview(); });
            col.addView(card);
        }
        sv.addView(col); d.setContentView(sv); d.show();
    }
    private String hostOf(String url) { try { String h = Uri.parse(url).getHost(); return h == null ? "" : h; } catch (Exception e) { return ""; } }
    /** 保存当前页可见的用户名/密码到本地 (vault, 按域名)。 */
    private void saveSiteLogin() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        final String host = hostOf(displayUrl(t));
        if (host.isEmpty()) { toast("无法识别站点"); return; }
        String js = "(function(){try{var p=document.querySelector('input[type=password]');if(!p)return '';"
            + "var u='';var ins=document.querySelectorAll('input');var pi=-1;for(var i=0;i<ins.length;i++){if(ins[i]===p){pi=i;break;}}"
            + "for(var j=pi-1;j>=0;j--){var tp=(ins[j].type||'').toLowerCase();if(tp==='text'||tp==='email'||tp==='tel'||tp===''){u=ins[j].value||'';break;}}"
            + "return JSON.stringify({u:u,p:p.value||''});}catch(e){return '';}})();";
        try { t.web.evaluateJavascript(js, val -> {
            try {
                if (val == null || val.length() < 4) { toast("未发现登录表单"); return; }
                String json = new org.json.JSONTokener(val).nextValue().toString(); // 去掉外层引号转义
                org.json.JSONObject c = new org.json.JSONObject(json);
                if (c.optString("p", "").isEmpty()) { toast("密码为空, 未保存"); return; }
                org.json.JSONObject all = new org.json.JSONObject(loginsRaw());
                all.put(host, c); String s = all.toString();
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("logins", s).apply(); vaultWrite("logins", s);
                toast("已保存 " + host + " 登录");
            } catch (Exception e) { toast("保存失败"); }
        }); } catch (Exception e) { toast("保存失败"); }
    }
    /** 用已保存的本站登录填充表单。 */
    private void fillSiteLogin() {
        Tab t = cur(); if (t == null) { toast("无页面"); return; }
        String host = hostOf(displayUrl(t));
        try {
            org.json.JSONObject all = new org.json.JSONObject(loginsRaw());
            if (!all.has(host)) { toast("无 " + host + " 的保存登录"); return; }
            org.json.JSONObject c = all.getJSONObject(host);
            String u = c.optString("u", "").replace("\\", "\\\\").replace("'", "\\'");
            String p = c.optString("p", "").replace("\\", "\\\\").replace("'", "\\'");
            String js = "(function(){try{var pw=document.querySelector('input[type=password]');if(!pw){return;}"
                + "function set(el,v){var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}"
                + "var ins=document.querySelectorAll('input');var pi=-1;for(var i=0;i<ins.length;i++){if(ins[i]===pw){pi=i;break;}}"
                + "for(var j=pi-1;j>=0;j--){var tp=(ins[j].type||'').toLowerCase();if(tp==='text'||tp==='email'||tp==='tel'||tp===''){set(ins[j],'" + u + "');break;}}"
                + "set(pw,'" + p + "');}catch(e){}})();";
            t.web.evaluateJavascript(js, null); toast("已填充");
        } catch (Exception e) { toast("填充失败"); }
    }
    private String loginsRaw() {
        String raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString("logins", "{}");
        if (raw == null || raw.isEmpty() || "{}".equals(raw)) { String v = vaultRead("logins"); if (v != null && !v.isEmpty()) raw = v; }
        return (raw == null || raw.isEmpty()) ? "{}" : raw;
    }

    // ── Native 桥 (仅注入内部页 switch.html / tunnel.html) ─────────────────
    public class Bridge {
        private final WebView owner;
        Bridge(WebView w) { this.owner = w; }
        /** 原生 HTTP (无 CORS, 可设 Origin/Referer) — 切号页登录/额度直接走它; 结果经 window.__httpCb 回灌。 */
        @JavascriptInterface public void httpReq(String reqId, String method, String url, String headersJson, String body) {
            HttpBridge.exec(reqId, method, url, headersJson, body, (id, json) ->
                main.post(() -> { if (owner != null) try {
                    owner.evaluateJavascript("window.__httpCb&&window.__httpCb(" + HttpBridge.jsonStr(id) + "," + json + ")", null);
                } catch (Exception ignored) {} }));
        }
        /** 二进制 HTTP (响应体 base64 → {status,b64,size}); 供「下载ZIP全部包括文件夹」取回产出文件。 */
        @JavascriptInterface public void httpReqB64(String reqId, String method, String url, String headersJson, String body) {
            HttpBridge.execB64(reqId, method, url, headersJson, body, (id, json) ->
                main.post(() -> { if (owner != null) try {
                    owner.evaluateJavascript("window.__httpCb&&window.__httpCb(" + HttpBridge.jsonStr(id) + "," + json + ")", null);
                } catch (Exception ignored) {} }));
        }
        @JavascriptInterface public String conn() {
            RelayService r = RelayService.instance;
            return r != null ? r.readConn() : "{}";
        }
        // ── 用户脚本管理 (供 userscripts.html 内部页) ──
        @JavascriptInterface public String usList() {
            try {
                org.json.JSONArray all = usLoadAll(); org.json.JSONArray out = new org.json.JSONArray();
                for (int i = 0; i < all.length(); i++) {
                    org.json.JSONObject s = all.optJSONObject(i); if (s == null) continue;
                    org.json.JSONObject o = new org.json.JSONObject();
                    o.put("id", s.optString("id")); o.put("name", s.optString("name"));
                    o.put("version", s.optString("version")); o.put("enabled", s.optBoolean("enabled", true));
                    o.put("description", s.optString("description")); o.put("runAt", s.optString("runAt"));
                    o.put("matches", s.optJSONArray("matches")); o.put("includes", s.optJSONArray("includes"));
                    out.put(o);
                }
                return out.toString();
            } catch (Exception e) { return "[]"; }
        }
        @JavascriptInterface public String usGetSource(String id) {
            org.json.JSONArray all = usLoadAll();
            for (int i = 0; i < all.length(); i++) { org.json.JSONObject s = all.optJSONObject(i);
                if (s != null && id.equals(s.optString("id"))) return s.optString("source", ""); }
            return "";
        }
        @JavascriptInterface public String usSaveCode(String code) { return usAddOrUpdate(code); }
        @JavascriptInterface public String usInstall(String url) {   // 同步抓取+解析 (运行于 JS 桥线程, 非主线程)
            String code = httpGetText(url);
            if (code == null || code.indexOf("==UserScript==") < 0) return "";
            return usAddOrUpdate(code);
        }
        @JavascriptInterface public void usDelete(String id) {
            try { org.json.JSONArray all = usLoadAll(), out = new org.json.JSONArray();
                for (int i = 0; i < all.length(); i++) { org.json.JSONObject s = all.optJSONObject(i);
                    if (s != null && !id.equals(s.optString("id"))) out.put(s); }
                usSaveAll(out); } catch (Exception e) {}
        }
        @JavascriptInterface public void usToggle(String id, boolean on) {
            try { org.json.JSONArray all = usLoadAll();
                for (int i = 0; i < all.length(); i++) { org.json.JSONObject s = all.optJSONObject(i);
                    if (s != null && id.equals(s.optString("id"))) { s.put("enabled", on); break; } }
                usSaveAll(all); } catch (Exception e) {}
        }
        /** 批量启停/删除 (脚本列表多选)。 */
        @JavascriptInterface public void usToggleMany(String jsonIds, boolean on) {
            try { java.util.HashSet<String> set = new java.util.HashSet<>(); org.json.JSONArray ids = new org.json.JSONArray(jsonIds);
                for (int i = 0; i < ids.length(); i++) set.add(ids.optString(i));
                org.json.JSONArray all = usLoadAll();
                for (int i = 0; i < all.length(); i++) { org.json.JSONObject s = all.optJSONObject(i);
                    if (s != null && set.contains(s.optString("id"))) s.put("enabled", on); }
                usSaveAll(all); } catch (Exception e) {}
        }
        @JavascriptInterface public void usDeleteMany(String jsonIds) {
            try { java.util.HashSet<String> set = new java.util.HashSet<>(); org.json.JSONArray ids = new org.json.JSONArray(jsonIds);
                for (int i = 0; i < ids.length(); i++) set.add(ids.optString(i));
                org.json.JSONArray all = usLoadAll(), out = new org.json.JSONArray();
                for (int i = 0; i < all.length(); i++) { org.json.JSONObject s = all.optJSONObject(i);
                    if (s != null && !set.contains(s.optString("id"))) out.put(s); }
                usSaveAll(out); } catch (Exception e) {}
        }
        /** 导出全部脚本 (完整 JSON, 用于备份/换机)。 */
        @JavascriptInterface public String usExportAll() { return usLoadAll().toString(); }
        /** 导入脚本 JSON (数组, 每项含 source); 返回成功条数。 */
        @JavascriptInterface public int usImport(String json) {
            try { org.json.JSONArray inc = new org.json.JSONArray(json); int n = 0;
                for (int i = 0; i < inc.length(); i++) { org.json.JSONObject s = inc.optJSONObject(i); if (s == null) continue;
                    String src = s.optString("source", ""); if (src.indexOf("==UserScript==") < 0) continue;
                    String id = usAddOrUpdate(src); if (id != null && !id.isEmpty()) n++; }
                return n; } catch (Exception e) { return 0; }
        }
        /** 检查并应用脚本更新 (downloadURL/updateURL): updated / latest / nourl / fail。 */
        @JavascriptInterface public String usCheckUpdate(String id) {
            try {
                org.json.JSONArray all = usLoadAll(); org.json.JSONObject cur = null;
                for (int i = 0; i < all.length(); i++) { org.json.JSONObject s = all.optJSONObject(i); if (s != null && id.equals(s.optString("id"))) { cur = s; break; } }
                if (cur == null) return "fail";
                String dl = cur.optString("downloadURL", ""), up = cur.optString("updateURL", "");
                String url = !dl.isEmpty() ? dl : up; if (url.isEmpty()) return "nourl";
                String code = httpGetText(url); if (code == null || code.indexOf("==UserScript==") < 0) return "fail";
                String newVer = usParse(code).optString("version", ""), oldVer = cur.optString("version", "");
                usAddOrUpdate(code);
                return (!newVer.isEmpty() && !newVer.equals(oldVer)) ? "updated" : "latest";
            } catch (Exception e) { return "fail"; }
        }
        // ── Shizuku (自我 ADB) ──
        @JavascriptInterface public int shizukuStatus() { return ShizukuManager.status(MainActivity.this); }
        @JavascriptInterface public void shizukuRequest() { main.post(ShizukuManager::requestPermission); }
        @JavascriptInterface public String shizukuGrantAll() { return ShizukuManager.grantAll(MainActivity.this); }
        @JavascriptInterface public String shizukuShell(String cmd) {
            if (cmd == null || cmd.isEmpty()) return "{\"ok\":false,\"error\":\"空命令\"}";
            if (!ShizukuManager.hasPermission()) return "{\"ok\":false,\"error\":\"Shizuku 未授权\"}";
            String[] r = ShizukuManager.exec(cmd);
            try { org.json.JSONObject o = new org.json.JSONObject();
                o.put("ok", "0".equals(r[0])); o.put("exit", r[0]); o.put("out", r.length > 1 ? r[1] : "");
                return o.toString(); } catch (Exception e) { return "{\"ok\":false}"; }
        }
        @JavascriptInterface public void shizukuOpenManager() {
            main.post(() -> { try {
                Intent i = getPackageManager().getLaunchIntentForPackage(ShizukuManager.SHIZUKU_PKG);
                if (i != null) startActivity(i);
                else { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/download/"))); }
            } catch (Exception e) { toast("无法打开 Shizuku"); } });
        }
        @JavascriptInterface public String relayStatus() { return RelayService.lastStatus; }
        @JavascriptInterface public void relayRestart() { main.post(() -> { stopService(new Intent(MainActivity.this, RelayService.class)); startRelay(); }); }
        @JavascriptInterface public void saveRelayConfig(String json) {
            applyRelayConfig(json);   // 去中心化: 持久化设备身份(url/session) + 落地 relay-config.json
        }
        // 面板「刷新Token」: 保留 url/session 身份, 仅强制轮换 token (旧 token 立即失效)
        @JavascriptInterface public void rotateRelayToken() { rotateRelayTokenForce(); }
        // ── 路线B 去中心化隧道: 代理到 RelayService (引擎进程持有 cloudflared) ──
        @JavascriptInterface public String tunnelStat() { return RelayService.tunnelStatus; }
        @JavascriptInterface public boolean isTunnelEnabled() {
            RelayService s = RelayService.instance;
            return s != null && s.tunnelEnabledFlag();
        }
        @JavascriptInterface public void setTunnelEnabled(boolean on) {
            RelayService s = RelayService.instance;
            if (s != null) s.setTunnelEnabledExternal(on);
        }
        // ── 后台保活 · 持久稳定化 (移植自 knoop7/Ava: 电池优化豁免 + 各厂商自启动深链) ──
        /** 机读保活状态: {maker, battOptIgnored, hint} — 供面板展示 + 云端 Agent 远程查看。 */
        @JavascriptInterface public String keepAliveStatus() { return KeepAlive.statusJson(MainActivity.this); }
        /** 申请「电池不优化」豁免 (系统标准弹窗, 用户点一次「允许」)。 */
        @JavascriptInterface public boolean requestBatteryOpt() {
            main.post(() -> KeepAlive.requestBatteryOpt(MainActivity.this));
            return KeepAlive.isBatteryOptIgnored(MainActivity.this);
        }
        /** 跳转厂商「自启动 / 后台白名单」设置页。 */
        @JavascriptInterface public boolean openAutoStart() {
            main.post(() -> KeepAlive.openAutoStart(MainActivity.this));
            return true;
        }
        /** 跳转厂商「省电策略 / 后台耗电」设置页。 */
        @JavascriptInterface public boolean openBatterySettings() {
            main.post(() -> KeepAlive.openBatterySettings(MainActivity.this));
            return true;
        }
        @JavascriptInterface public void clip(String text) {
            main.post(() -> {
                try { ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("rtflow", text == null ? "" : text)); } catch (Exception ignored) {}
            });
        }
        @JavascriptInterface public void toast(String s) { MainActivity.this.toast(s == null ? "" : s); }
        /** 震动反馈 (多选长按/低额提醒) — 直驱 Vibrator, 不受系统触感开关影响。 */
        @JavascriptInterface public void vibrate(int ms) { MainActivity.this.doVibrate(ms > 0 ? ms : 30); }
        // 全服通近期对话: 长按某行 → 起全局拖拽 (该对话 accJson+sid), 拖到任意网页松手注入两形态文件
        @JavascriptInterface public void startConvDrag(String accJson, String sid) { main.post(() -> MainActivity.this.beginConvDrag(accJson, sid)); }
        /** 全量备份落地: Documents/DevinCloud/backups/<账号文件夹>/<name> (脱离沙箱, 卸载/重装不丢)。 */
        @JavascriptInterface public boolean vaultSaveBackup(String folder, String name, String content) {
            return MainActivity.this.vaultSaveBackup(folder, name, content);
        }
        /** 二进制备份落地 (base64 → 字节): 用于整文件夹 ZIP(对话+产出文件)入备份库。 */
        @JavascriptInterface public boolean vaultSaveBackupB64(String folder, String name, String base64) {
            return MainActivity.this.vaultSaveBackupB64(folder, name, base64);
        }
        /** 列某账号备份文件夹内容 → JSON [{name,size,mtime}] (供备份页搜索/本地数据源检索)。 */
        @JavascriptInterface public String vaultListBackups(String folder) {
            return MainActivity.this.vaultListBackups(folder);
        }
        /** 读某备份文件文本 (manifest.json / conv-<sid>.md) — 本地数据源无感回退。 */
        @JavascriptInterface public String vaultReadBackup(String folder, String name) {
            return MainActivity.this.vaultReadBackup(folder, name);
        }
        /** 列出全部备份账号文件夹 → JSON [folderName] (备份库悬浮窗检索全部账号, 含已移出库的)。 */
        @JavascriptInterface public String vaultListBackupAccounts() {
            return MainActivity.this.vaultListBackupAccounts();
        }
        /** 读某备份二进制文件 → base64 (sess-<sid>.zip) — 备份库一键拉取本地全量产出。 */
        @JavascriptInterface public String vaultReadBackupB64(String folder, String name) {
            return MainActivity.this.vaultReadBackupB64(folder, name);
        }
        /** 删除某备份文件 — 单包 ZIP 落地后清除已折入的旧散文件(归纳整理·省空间)。 */
        @JavascriptInterface public boolean vaultDeleteBackup(String folder, String name) {
            return MainActivity.this.vaultDeleteBackup(folder, name);
        }
        // ── 在线自动更新 (面板/引擎/中继共用) ──
        @JavascriptInterface public String appCheckUpdate() { return fetchUpdateInfo(); }
        @JavascriptInterface public String appInstallUpdate(String url) { return startUpdate(url); }
        @JavascriptInterface public String appVer() { return appVersionName(); }   // 真实 APK versionName, 供页脚读取免僵化
        @JavascriptInterface public void openAccountTab(String accJson) { main.post(() -> newTab(DEVIN, accJson)); }
        @JavascriptInterface public void openUrlTab(String url) { main.post(() -> newTab(url == null ? DEVIN : url, null)); }
        // 历史/书签里的多实例 Devin 条目: 用对应账号(注入鉴权)重开该 URL, 而非裸 location.href(会掉回官网登录页)
        @JavascriptInterface public void reopenAccount(String accJson, String url) {
            main.post(() -> {
                String u = (url == null || url.isEmpty()) ? DEVIN : url;
                if (accJson == null || accJson.isEmpty()) newTab(u, null);
                else newTab(u, accJson);
            });
        }
        /** 系统分享 (链接/文本) — 像浏览器的"分享"。 */
        @JavascriptInterface public void share(String text) {
            main.post(() -> {
                try {
                    Intent it = new Intent(Intent.ACTION_SEND); it.setType("text/plain");
                    it.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                    startActivity(Intent.createChooser(it, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) { MainActivity.this.toast("无法分享"); }
            });
        }
        /** 历史/书签条目：删除某 URL。 */
        @JavascriptInterface public void deleteHistoryUrl(String url, boolean devin) { main.post(() -> MainActivity.this.deleteHistoryUrl(url, devin)); }
        @JavascriptInterface public void deleteBookmarkUrl(String url) { main.post(() -> { MainActivity.this.removeBookmarkPersist(url); MainActivity.this.updateStar(); }); }
        /** 在新标签打开 (多实例则注入对应账号)。 */
        @JavascriptInterface public void openEntryNewTab(String accJson, String url) {
            main.post(() -> { String u = (url == null || url.isEmpty()) ? DEVIN : url; newTab(u, (accJson == null || accJson.isEmpty()) ? null : accJson); });
        }
        /** 后台新标签打开 (批量多选打开用, 不抢前台)。 */
        @JavascriptInterface public void openEntryBg(String accJson, String url) {
            main.post(() -> { String u = (url == null || url.isEmpty()) ? DEVIN : url; newTabBackground(u, (accJson == null || accJson.isEmpty()) ? null : accJson); });
        }
        // ── 多选批量 (历史/书签列表页) ──
        @JavascriptInterface public void deleteHistoryUrls(String jsonUrls, boolean devin) {
            main.post(() -> { try { MainActivity.this.deleteHistoryBatch(new org.json.JSONArray(jsonUrls), devin); } catch (Exception e) {} });
        }
        @JavascriptInterface public void deleteBookmarkUrls(String jsonUrls) {
            main.post(() -> { try { MainActivity.this.deleteBookmarkBatch(new org.json.JSONArray(jsonUrls)); } catch (Exception e) {} });
        }
        @JavascriptInterface public int bookmarkUrls(String jsonItems) {
            try { int n = MainActivity.this.addBookmarkBatch(new org.json.JSONArray(jsonItems)); main.post(MainActivity.this::updateStar); return n; }
            catch (Exception e) { return 0; }
        }
        @JavascriptInterface public void downloadUrls(String jsonUrls) {
            main.post(() -> { try { MainActivity.this.downloadBatch(new org.json.JSONArray(jsonUrls)); } catch (Exception e) {} });
        }
        @JavascriptInterface public void clearHistory() { main.post(MainActivity.this::clearHistoryAll); }
        /** 全服通「进入」: 切到该对话所属账号(WAM 注入鉴权) 并前台打开该对话网页页, 同时关掉全服通悬浮窗露出网页。
         *  网页 URL 用去掉 devin- 前缀的 id (app.devin.ai/sessions/<hex>), 与浏览器地址栏一致。 */
        @JavascriptInterface public void openAccountSession(String accJson, String sid) {
            main.post(() -> {
                String s = (sid == null) ? "" : sid.trim();
                if (s.startsWith("devin-")) s = s.substring(6);
                String u = s.isEmpty() ? DEVIN : ("https://app.devin.ai/sessions/" + s);
                newTab(u, (accJson == null || accJson.isEmpty()) ? null : accJson);
                hideDaoPanel();   // 进入对话: 收起全服通悬浮窗露出网页 (保活)
            });
        }
        @JavascriptInterface public void openText(String title, String content) {
            main.post(() -> {
                Tab t = makeTab(null, true); // internal=true → Native bridge available for download button
                selectTab(tabs.size() - 1);
                String safe = (title == null ? "devin" : title).replaceAll("[^a-zA-Z0-9_\\-\\u4e00-\\u9fff]", "_");
                String fname = safe + ".md";
                String jsContent = org.json.JSONObject.quote(content == null ? "" : content);
                String jsFname = org.json.JSONObject.quote(fname);
                String html = "<html><head><meta name=viewport content='width=device-width,initial-scale=1'>" +
                        "<style>body{background:#0e1116;color:#cdd3de;font:13px monospace;padding:12px 12px 64px;white-space:pre-wrap;word-break:break-all}" +
                        "#dlbar{position:fixed;left:0;right:0;bottom:0;background:#161b22;border-top:1px solid #30363d;padding:8px;text-align:center;z-index:9}" +
                        "#dlbar button{background:#1f6feb;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-size:14px;margin:0 4px}</style></head><body>" +
                        "<div id='c'></div>" +
                        "<div id='dlbar'><button onclick='__dl()'>\u2B07 \u4E0B\u8F7D MD</button><button onclick='__cp()'>\uD83D\uDCCB \u590D\u5236</button></div>" +
                        "<script>var __md=" + jsContent + ",__nm=" + jsFname + ";" +
                        "document.getElementById('c').textContent=__md;" +
                        "function __dl(){try{Native.saveTextFile(__nm,__md);}catch(e){}}" +
                        "function __cp(){try{Native.clip(__md);Native.toast('\u5DF2\u590D\u5236');}catch(e){}}" +
                        "</scr" + "ipt></body></html>";
                t.title = title == null ? "MD" : title;
                t.web.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "utf-8", null);
            });
        }
        @JavascriptInterface public void log(String s) { android.util.Log.i("RTFlowBrowser", s == null ? "" : s); }
        // ── 远程操控开关 (穿透面板用; 与 RelayService 静态共享, 同步持久化到 remote-ops-flag) ──
        @JavascriptInterface public boolean isRemoteOpsEnabled() { return RelayService.remoteOpsEnabled; }
        @JavascriptInterface public void setRemoteOps(boolean on) {
            RelayService.remoteOpsEnabled = on;
            try { java.io.File f = new java.io.File(getFilesDir(), "remote-ops-flag");
                  java.io.FileOutputStream o = new java.io.FileOutputStream(f); o.write((on ? "1" : "0").getBytes("UTF-8")); o.close(); }
            catch (Exception e) {}
        }
        /** 无障碍服务是否已开启 (供穿透面板「一键授权」状态显示)。 */
        @JavascriptInterface public boolean phoneA11yReady() { return RtAccessibilityService.isReady(); }
        /** 一键授权系统级接管: 开远程开关 + 已就绪直接可用, 否则跳转无障碍设置让用户点一次「允许」。 */
        @JavascriptInterface public boolean phoneEnsureControl() {
            setRemoteOps(true);
            boolean ready = RtAccessibilityService.isReady();
            if (!ready) main.post(() -> ipcOpenA11ySettings());
            return ready;
        }
        /** 切号面板追踪轮询 → 推送该账号最活跃对话名+状态, 用于顶部标签实时显示。 */
        @JavascriptInterface public void setTabStatus(String accountId, String convName, String status) {
            ipcSetTabStatus(accountId, convName, status);
        }
        /** 切号面板随额度刷新 → 推送该账号实时剩余美金 ("$5"/空), 显示在页签状态点左侧便于管理。 */
        @JavascriptInterface public void setTabDollars(String accountId, String dollars) {
            ipcSetTabDollars(accountId, dollars);
        }
        /** 打开系统 VPN 设置 (用户自行连接已配置的 VPN/导入的 Clash·sing-box·V2Ray 配置)。 */
        @JavascriptInterface public void openVpnSettings() {
            main.post(() -> {
                try { startActivity(new Intent(android.provider.Settings.ACTION_VPN_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                catch (Exception e) { try { startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS)); } catch (Exception ig) { toast("无法打开 VPN 设置"); } }
            });
        }
        /** 尝试唤起已安装的 VPN App (按包名), 失败则跳商店/设置。 */
        @JavascriptInterface public void launchApp(String pkg) {
            main.post(() -> {
                try {
                    Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
                    if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); return; }
                } catch (Exception ignored) {}
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                catch (Exception e) { toast("未安装该 App: " + pkg); }
            });
        }
        // ── VPN/本地代理 实时识别 + 联动内置浏览器 ──
        /** 实时综合状态 JSON: 系统VPN开关/接口/DNS · 已装VPN App · 本地代理端口 · 当前已路由代理。 */
        @JavascriptInterface public String vpnStatus() { return MainActivity.this.vpnStatusJson(); }
        /** 探测本机本地代理 (clash/v2ray 端口), 返回 "host:port" 或 ""。 */
        @JavascriptInterface public String detectProxy() { return MainActivity.this.detectLocalProxy(); }
        /** 把内置浏览器全部 WebView 出站经本地代理路由 (host:port; 空=直连)。 */
        @JavascriptInterface public boolean applyProxy(String hostPort) { return MainActivity.this.applyWebViewProxy(hostPort); }
        /** 取消代理路由, 回到直连。 */
        @JavascriptInterface public boolean clearProxy() { return MainActivity.this.clearWebViewProxy(); }
        /** 当前已应用的代理 host:port (空=直连)。 */
        @JavascriptInterface public String currentProxy() { return MainActivity.this.curProxy == null ? "" : MainActivity.this.curProxy; }
        /** 生成「查看该对话全部文件」取数指引 MD (账号/密码/Session ID/提取流程/中继) — 备份文件夹/ZIP 锚定本源。 */
        @JavascriptInterface public String accessGuideMd(String accJson, String sid, String title) {
            try { return MainActivity.this.buildAccessGuideMd(accJson, sid == null ? "" : sid, title == null ? "" : title); }
            catch (Exception e) { return ""; }
        }
        /** 把文本(对话 MD/知识库/剧本等)落地到系统「下载」目录 — 单一对话下载到本地。 */
        @JavascriptInterface public String saveTextFile(String name, String content) {
            try {
                String safe = (name == null || name.trim().isEmpty()) ? ("rtflow-" + System.currentTimeMillis() + ".md") : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                File dir = downloadStoreDir();   // 保险箱副本 (软件内可拖入/打开 + 卸载不丢); 系统可见副本由 publishToDownloads 负责
                File f = new File(dir, safe);
                byte[] bytes = (content == null ? "" : content).getBytes(StandardCharsets.UTF_8);
                try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(bytes); }
                android.net.Uri pub = publishToDownloads(safe, "text/markdown", bytes);   // 同步进系统下载/最近
                final String puri = pub == null ? "" : pub.toString();
                final File ff = f; final String fn = safe;
                main.post(() -> { MainActivity.this.addDownloadRecord(fn, ff.getAbsolutePath(), puri, "text/markdown", ff.length()); MainActivity.this.toast(puri.isEmpty() ? ("已下载: " + fn) : ("已下载并同步系统下载: " + fn)); });
                return f.getAbsolutePath();
            } catch (Exception e) {
                main.post(() -> MainActivity.this.toast("下载失败: " + (e.getMessage() == null ? "" : e.getMessage())));
                return "";
            }
        }
        /** 保存 base64 二进制 (zip 打包导出) 到系统下载目录。 */
        /** 数据保险箱: 把切号面板的账号库等关键数据落到共享文件夹, 卸载/重装/换机仍可回读。 */
        @JavascriptInterface public void vaultSave(String key, String json) { if (key != null) vaultWrite(key, json); }
        @JavascriptInterface public String vaultLoad(String key) { return key == null ? "" : vaultRead(key); }
        /** 当前网络计费/类型/在线态 (供前端「重下载仅 WiFi·省移动数据」门控)。识别失败→保守视为非计费, 绝不因门控误伤既有功能。 */
        @JavascriptInterface public String netInfo() { return MainActivity.this.netInfoJson(); }
        @JavascriptInterface public String saveBase64File(String name, String base64) {
            try {
                String safe = (name == null || name.trim().isEmpty()) ? ("rtflow-" + System.currentTimeMillis() + ".bin") : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                File dir = downloadStoreDir();   // 保险箱副本 (软件内可拖入/打开 + 卸载不丢); 系统可见副本由 publishToDownloads 负责
                File f = new File(dir, safe);
                byte[] data = android.util.Base64.decode(base64 == null ? "" : base64, android.util.Base64.DEFAULT);
                try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(data); }
                android.net.Uri pub = publishToDownloads(safe, guessMime(safe), data);   // 同步进系统下载/最近
                final String puri = pub == null ? "" : pub.toString();
                final File ff = f; final String fn = safe;
                main.post(() -> { MainActivity.this.addDownloadRecord(fn, ff.getAbsolutePath(), puri, guessMime(fn), ff.length()); MainActivity.this.toast(puri.isEmpty() ? ("已下载: " + fn) : ("已下载并同步系统下载: " + fn)); });
                return f.getAbsolutePath();
            } catch (Exception e) {
                main.post(() -> MainActivity.this.toast("下载失败: " + (e.getMessage() == null ? "" : e.getMessage())));
                return "";
            }
        }
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** 将 JSON 安全内联进 <script>: 转义 < 与行分隔符, 防止破坏脚本块。 */
    private static String jsEmbed(Object json) {
        String s = json == null ? "[]" : json.toString();
        return s.replace("<", "\\u003c").replace("\u2028", "").replace("\u2029", "");
    }

    /** http/https/file/about/javascript/data/blob 留在 WebView; 其余 scheme (mailto/tel/intent/market…) 交系统。 */
    private boolean handleExternalScheme(String u) {
        if (u == null) return false;
        String low = u.toLowerCase();
        if (low.startsWith("http://") || low.startsWith("https://") || low.startsWith("file:")
                || low.startsWith("about:") || low.startsWith("javascript:") || low.startsWith("data:")
                || low.startsWith("blob:")) return false;
        try {
            Intent intent;
            if (low.startsWith("intent:")) intent = Intent.parseUri(u, Intent.URI_INTENT_SCHEME);
            else intent = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) { toast("无法打开: " + u); }
        return true;
    }

    /** 附件下载型 URL: 顶层导航到它只会渲成空白页 —— 应转交下载而非导航。
     *  覆盖 ① app.devin.ai/attachments/…(SPA 下载按钮/附件卡片的 target=_blank 落点)
     *  ② 其 302 落点 S3 预签名直链(带 X-Amz-Signature 且处置明示 attachment)。 */
    static boolean isAttachmentDownloadUrl(String u) {
        if (u == null) return false;
        String low = u.toLowerCase(java.util.Locale.US);
        if (!low.startsWith("http://") && !low.startsWith("https://")) return false;
        try {
            Uri x = Uri.parse(u);
            String host = x.getHost() == null ? "" : x.getHost().toLowerCase(java.util.Locale.US);
            String path = x.getPath() == null ? "" : x.getPath();
            if (host.equals("app.devin.ai") && path.startsWith("/attachments/")) return true;
            if (low.contains("x-amz-signature=") && low.contains("response-content-disposition=attachment")) return true;
        } catch (Exception ignored) {}
        return false;
    }
    /** S3 预签名 URL 的 response-content-disposition(含真实文件名), 无则 null。 */
    static String dispositionFromUrl(String u) {
        try {
            String d = Uri.parse(u).getQueryParameter("response-content-disposition");
            return (d == null || d.isEmpty()) ? null : d;
        } catch (Exception e) { return null; }
    }
    /** 顶层导航落在附件/S3 预签名直链 → 拦下转真下载(留在原页); onCreateWindow 刚开出的空标签顺手关闭。 */
    private boolean interceptAttachmentNav(WebView v, String u) {
        if (!isAttachmentDownloadUrl(u)) return false;
        String ua = null;
        try { ua = v.getSettings().getUserAgentString(); } catch (Exception ignored) {}
        startDownload(u, ua, dispositionFromUrl(u), null);
        int idx = tabOf(v);
        if (idx >= 0) {
            try {
                Tab t = tabs.get(idx);
                if (v.copyBackForwardList().getSize() == 0 && (t.url == null || !t.url.startsWith("http")))
                    closeTab(idx);
            } catch (Exception ignored) {}
        }
        return true;
    }

    private void startDownload(String url, String ua, String contentDisposition, String mime) { startDownload(url, ua, contentDisposition, mime, 0); }
    private void startDownload(String url, String ua, String contentDisposition, String mime, int attempt) {
        // blob:/data: 无法走系统 DownloadManager → 转 JS 取内容, 统一收进应用内下载列表
        if (url != null && url.startsWith("blob:")) { captureBlobDownload(url); return; }
        if (url != null && url.startsWith("data:")) { captureDataUrl(url, contentDisposition); return; }
        // 附件下载首点即成 (不再需重启+刷新): 入队前确保 attachments_token 就绪, 否则 DownloadManager
        //   无鉴权 Cookie → 403 失败。铸造是网络操作 → 整个入队流程放后台线程 (回 UI 线程弹提示)。
        final Tab dt = cur();
        final String fUrl = url, fUa = ua, fCd = contentDisposition, fMime = mime;
        new Thread(() -> {
            try {
                if (dt != null && dt.auth1 != null && !dt.auth1.isEmpty()
                        && fUrl != null && fUrl.contains("app.devin.ai/attachments/"))
                    ensureAttachmentCookie(dt.auth1, dt.orgId, fUrl);
                String name = android.webkit.URLUtil.guessFileName(fUrl, fCd, fMime);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(fUrl));
                if (fMime != null) req.setMimeType(fMime);
                if (fUa != null) req.addRequestHeader("User-Agent", fUa);
                String cookie = android.webkit.CookieManager.getInstance().getCookie(fUrl);
                if (cookie != null) req.addRequestHeader("Cookie", cookie);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                // 落到应用专属外部目录 → 由应用内下载管理器统一展示/打开/拖拽
                req.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) { long id = dm.enqueue(req); dlPending.put(id, new String[]{ name, fMime == null ? "" : fMime, fUrl, String.valueOf(attempt) }); runOnUiThread(() -> toast(attempt > 0 ? ("重试下载: " + name) : ("开始下载: " + name))); }
            } catch (Exception e) { runOnUiThread(() -> toast("下载失败: " + (e.getMessage() == null ? "" : e.getMessage()))); }
        }).start();
    }

    // 页面内 <a download> / blob: / data: 下载捕获脚本 (每个页面加载完安装一次)
    static void installDownloadHook(WebView w) {
        if (w == null) return;
        String js = "(function(){if(window.__rtdl)return;window.__rtdl=1;"
            + "function send(n,m,b){try{RTDL.saveBase64(n||'download',m||'',b||'');}catch(e){}}"
            + "function blobB64(bl,n){var r=new FileReader();r.onload=function(){var s=''+r.result;var i=s.indexOf(',');send(n,(bl.type||''),i>=0?s.slice(i+1):s);};r.readAsDataURL(bl);}"
            + "document.addEventListener('click',function(ev){try{"
            + "var t=ev.target;var a=t&&t.closest?t.closest('a[download],a[href^=\"blob:\"],a[href^=\"data:\"]'):null;if(!a)return;"
            + "var href=a.getAttribute('href')||a.href||'';if(!href)return;"
            + "var name=a.getAttribute('download')||(href.split('/').pop()||'download').split('?')[0];"
            + "if(href.indexOf('blob:')===0){ev.preventDefault();ev.stopPropagation();fetch(href).then(function(r){return r.blob();}).then(function(b){blobB64(b,name);}).catch(function(){});}"
            + "else if(href.indexOf('data:')===0){ev.preventDefault();ev.stopPropagation();var m=(href.match(/^data:([^;,]*)/)||[])[1]||'';var c=href.indexOf(',');var p=href.slice(c+1);var b64=/;base64/i.test(href.slice(0,c))?p:btoa(unescape(encodeURIComponent(decodeURIComponent(p))));send(name,m,b64);}"
            + "}catch(e){}} ,true);})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    // 录像/视频播放器窄屏适配: 官网测试录像播放器为「视频区(flex-1) + 步骤侧栏(w-[26rem]·416px 固定宽)」
    //   的 flex 行布局; 手机宽(≈384px)不足以容下侧栏 → 视频列被挤到 0 宽, 只见步骤列表看不见视频。
    //   通用修法(不依赖具体类名): 发现 <video> 所处的 0 宽列且父容器是 flex 行 → 改父容器为纵向堆叠,
    //   视频区在上、侧栏/进度步骤在下, 两者同屏互不覆盖。幂等 + MutationObserver 覆盖 SPA 动态开窗。
    //   中缝为可拖拽分隔条(触控/鼠标上下拉动调两块占比·占比记忆于 localStorage):
    //   不分场景——无论有无视频在播, 上块占用都可随手拉小, 避免非视频内容时上方留大片空白。
    //   分隔条回收: SPA 复用 DOM, 面板切走后行节点可能被挪去对话页 → 回收判定除「列失联/无视频/宽屏」
    //   外还查「分隔条脱位·行已不在浮层内」; 另按 data-rtdvfit 标记做全局兜底清扫(不在跟踪表内的
    //   分隔条一律摘除), 行级 __rtFitRow 防同行重复插条(修「切走再切回出两条·条跟去对话页」)。
    //   邻里不扰: ① 只对浮层面板(祖先含 position:fixed 或 absolute·即播放器弹窗/侧开面板)内的视频生效
    //   —— 官网录像播放器有两种宿主: 全屏弹窗(fixed)与会话页内嵌面板(absolute inset-0), 两种都要覆盖;
    //   对话流里的内嵌卡片永不是 0 宽列, 不会触发, 日常面板不受扰。
    //   ② 记录改前 inline cssText, 弹窗关闭/视频移除/宽屏时整组还原 —— SPA 复用
    //   DOM 节点也不会把堆叠样式带去其他页面(修「看完视频后其他文件面板也变竖排」)。
    //   触发时序: 面板开启有滑入动画, DOM 插入时列宽尚未定型(非 0 宽), 且动画结束后不再有
    //   mutation —— 单次防抖会永久错过 → 每次触发按 300/1000/2500ms 梯次重检,
    //   另有轻量定时哨兵(仅存在 0 宽视频时才动手)兑底。
    //   守卫时序(修早注入永久失效): 旧版开头即置 __rtVidFit=1, 若注入时 document.body 尚未存在
    //   (首次导航早期即注入), MutationObserver 挂接抛异常被吞, 但守卫已置 → 后续重复注入全部
    //   短路, 该页永久无钩。今改为: 守卫仅在 setup 真正成功后才置, body 未就绪则自重试,
    //   __rtVidFitBoot 防同页并发双装。
    static void installVideoFit(WebView w) {
        if (w == null) return;
        String js = "(function(){try{if(window.__rtVidFit||window.__rtVidFitBoot)return;window.__rtVidFitBoot=1;"
            + "var setup=function(){try{"
            + "if(window.__rtVidFit)return;"
            + "if(!document.body){setTimeout(setup,250);return;}"
            + "var F=[];"
            + "function inOverlay(e){for(;e&&e!==document.body;e=e.parentElement){var p=getComputedStyle(e).position;if(p==='fixed'||p==='absolute')return true;}return false;}"
            + "function revert(f){try{if(f.div&&f.div.parentNode)f.div.parentNode.removeChild(f.div);"
            + "f.row.style.cssText=f.rowCss;delete f.col.__rtFit;delete f.row.__rtFitRow;"
            + "for(var i=0;i<f.kids.length;i++)f.kids[i].el.style.cssText=f.kids[i].css;}catch(e){}}"
            + "function sweep(){for(var i=F.length-1;i>=0;i--){var f=F[i];"
            + "if(!f.col.isConnected||!f.div||!f.div.isConnected||f.div.parentNode!==f.row"
            + "||!f.col.querySelector('video')||!inOverlay(f.row)||window.innerWidth>700){revert(f);F.splice(i,1);}}"
            + "var st=document.querySelectorAll('[data-rtdvfit]');"
            + "for(var i=0;i<st.length;i++){var d=st[i],own=false;"
            + "for(var j=0;j<F.length;j++)if(F[j].div===d){own=true;break;}"
            + "if(!own&&d.parentNode)d.parentNode.removeChild(d);}}"
            + "function fixOne(v){try{if(window.innerWidth>700)return;"
            + "var col=null,row=null;"
            + "for(var e=v;e&&e!==document.body;e=e.parentElement){"
            + "var wd=e.getBoundingClientRect().width;var p=e.parentElement;"
            + "if(wd<2&&p&&p.getBoundingClientRect().width>100){col=e;row=p;break;}}"
            + "if(!col||col.__rtFit||row.__rtFitRow)return;"
            + "if(row.querySelector(':scope>[data-rtdvfit]'))return;" /* 双保险: 按 DOM 标记防同行二次插条 */
            + "if(!inOverlay(row))return;"
            + "var cs=getComputedStyle(row);"
            + "if(cs.display.indexOf('flex')<0||cs.flexDirection!=='row')return;"
            + "var f={row:row,col:col,rowCss:row.style.cssText,kids:[]};"
            + "for(var i=0;i<row.children.length;i++)f.kids.push({el:row.children[i],css:row.children[i].style.cssText});"
            + "col.__rtFit=1;row.__rtFitRow=1;F.push(f);"
            + "var pct=parseFloat(localStorage.getItem('rtflow.vidSplit')||'55');if(!(pct>=5&&pct<=90))pct=55;"
            + "row.style.flexDirection='column';"
            + "col.style.width='100%';col.style.minWidth='100%';col.style.flex='0 0 '+pct+'%';col.style.minHeight='0';col.style.overflow='hidden';"
            + "for(var i=0;i<row.children.length;i++){var c=row.children[i];if(c!==col){"
            + "c.style.width='100%';c.style.maxWidth='100%';c.style.flex='1 1 auto';"
            + "c.style.borderLeft='0';c.style.minHeight='0';}}"
            + "var dv=document.createElement('div');f.div=dv;dv.setAttribute('data-rtdvfit','1');"
            + "dv.style.cssText='flex:0 0 18px;width:100%;cursor:row-resize;touch-action:none;display:flex;align-items:center;justify-content:center;background:rgba(127,127,127,.18);border-top:1px solid rgba(127,127,127,.35);border-bottom:1px solid rgba(127,127,127,.35);';"
            + "var grip=document.createElement('div');grip.style.cssText='width:46px;height:5px;border-radius:3px;background:rgba(127,127,127,.75);pointer-events:none;';dv.appendChild(grip);"
            + "row.insertBefore(dv,col.nextSibling);"
            + "function mv(y){try{var r=row.getBoundingClientRect();if(r.height<40)return;"
            + "var p=(y-r.top)/r.height*100;p=Math.max(5,Math.min(90,p));"
            + "col.style.flex='0 0 '+p+'%';localStorage.setItem('rtflow.vidSplit',''+Math.round(p));}catch(e){}}"
            + "dv.addEventListener('touchstart',function(ev){ev.preventDefault();ev.stopPropagation();},{passive:false});"
            + "dv.addEventListener('touchmove',function(ev){ev.preventDefault();ev.stopPropagation();if(ev.touches&&ev.touches[0])mv(ev.touches[0].clientY);},{passive:false});"
            + "dv.addEventListener('mousedown',function(ev){ev.preventDefault();ev.stopPropagation();"
            + "var mm=function(e){mv(e.clientY);};var up=function(){document.removeEventListener('mousemove',mm);document.removeEventListener('mouseup',up);};"
            + "document.addEventListener('mousemove',mm);document.addEventListener('mouseup',up);});"
            + "}catch(e){}}"
            + "function fit(){try{sweep();document.querySelectorAll('video').forEach(fixOne);}catch(e){}}"
            + "var ts=[];function deb(){while(ts.length)clearTimeout(ts.pop());"
            + "[300,1000,2500].forEach(function(ms){ts.push(setTimeout(fit,ms));});}"
            + "new MutationObserver(deb).observe(document.body,{childList:true,subtree:true});"
            + "window.addEventListener('resize',deb);"
            + "document.addEventListener('transitionend',function(){setTimeout(fit,60);},true);"
            + "setInterval(function(){try{var need=false;document.querySelectorAll('video').forEach(function(v){"
            + "if(v.getBoundingClientRect().width<2)need=true;});"
            + "if(need||F.length||document.querySelector('[data-rtdvfit]'))fit();}catch(e){}},3000);"
            + "window.__rtVidFitRun=fit;window.__rtVidFit=1;window.__rtVidFitBoot=0;fit();"
            + "}catch(e){window.__rtVidFitBoot=0;}};setup();"
            + "}catch(e){window.__rtVidFitBoot=0;}})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    // 媒体加载自愈: 国内直连时, 附件/对象存储(S3/CloudFront 预签名直链)的图片·视频·音频加载
    //   易被跨境链路瞬断(连接重置/超时)或预签名过期(403)击中, 表现为「图片时有时无·视频加载不了」。
    //   此钩子在捕获阶段监听媒体元素 error: 命中 app.devin.ai/attachments 或对象存储直链时,
    //   按 1.5s/4s/9s 退避自动重载至多 3 次 (同 URL 重取 → /attachments 会重新 302 出新鲜预签名);
    //   视频重载前记住播放位置, 元数据就绪后 seek 回原处, 用户无感。幂等 + 只重试媒体元素, 不扰其他请求。
    static void installMediaRetry(WebView w) {
        if (w == null) return;
        String js = "(function(){try{if(window.__rtMediaRetry)return;window.__rtMediaRetry=1;"
            + "var RX=/app\\.devin\\.ai\\/attachments\\/|\\.amazonaws\\.com\\/|\\.cloudfront\\.net\\//;"
            + "document.addEventListener('error',function(ev){try{"
            + "var el=ev.target;if(!el||!el.tagName)return;"
            + "var tag=el.tagName.toUpperCase();"
            + "if(tag==='SOURCE'){el=el.parentElement;if(!el)return;tag=el.tagName.toUpperCase();}"
            + "if(tag!=='IMG'&&tag!=='VIDEO'&&tag!=='AUDIO')return;"
            + "var u=el.currentSrc||el.src||'';if(!RX.test(u))return;"
            + "var n=el.__rtRetry||0;if(n>=3)return;el.__rtRetry=n+1;"
            + "setTimeout(function(){try{"
            + "if(!el.isConnected)return;"
            + "if(tag==='IMG'){var s=el.src;el.src='';el.src=s;}"
            + "else{var t=el.currentTime||0,playing=!el.paused;"
            + "el.load();"
            + "el.addEventListener('loadedmetadata',function h(){el.removeEventListener('loadedmetadata',h);"
            + "try{if(t>0)el.currentTime=t;if(playing&&el.play)el.play().catch(function(){});}catch(e){}});}"
            + "}catch(e){}},[1500,4000,9000][n]||9000);"
            + "}catch(e){}},true);"
            + "}catch(e){}})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    // 键盘弹出时把聚焦的输入框滚到可见区中部 (配合 windowSoftInputMode=adjustResize):
    //   消除"输入框被键盘遮住 / 弹来弹去", 体感对齐真浏览器。幂等(window.__rtkb 守卫), SPA 路由后可重装。
    static void installKbHelper(WebView w) {
        if (w == null) return;
        String js = "(function(){if(window.__rtkb)return;window.__rtkb=1;"
            + "var T=null;function sif(el){if(!el)return;clearTimeout(T);T=setTimeout(function(){try{el.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});}catch(e){try{el.scrollIntoView();}catch(_){}}},220);}"
            + "function isF(t){return t&&t.matches&&t.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable=\"\"],[contenteditable=true],[role=textbox]');}"
            + "document.addEventListener('focusin',function(e){if(isF(e.target))sif(e.target);},true);"
            + "if(window.visualViewport){window.visualViewport.addEventListener('resize',function(){var a=document.activeElement;if(isF(a))sif(a);});}"
            + "})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    // 输入直通(回归本源): 不再有任何 beforeinput 拦截/改写(拦截式护栏实测造成卡顿·光标错位·弹跳)。
    //   仅保留捕获阶段纯旁观取证日志, 供 logcat 对照原生 DAO_IME 溯源。
    static void installBackspaceGuard(WebView w) {
        if (w == null) return;
        String js = ""
            // JS 层输入取证(主壳标签页也覆盖): 捕获阶段旁观记录 keydown/beforeinput/input/composition,
            //   console.log → logcat 'chromium' 直取, 与原生 DAO_IME 日志对照即可定位双删发生层次。只旁观不拦截。
            + "(function(){if(window.__daoImeTr)return;window.__daoImeTr=1;"
            + "function st(t){try{if(t&&(t.tagName==='TEXTAREA'||t.tagName==='INPUT'))return ' sel='+t.selectionStart+','+t.selectionEnd+' len='+(t.value||'').length+' ar='+JSON.stringify((t.value||'').slice(Math.max(0,(t.selectionStart||0)-2),(t.selectionEnd||0)+2));"
            + "var s=window.getSelection&&window.getSelection();if(s&&s.rangeCount){var r=s.getRangeAt(0);return ' ce.off='+r.startOffset+','+r.endOffset+' nlen='+((r.startContainer&&r.startContainer.textContent)||'').length;}}catch(e){}return '';}"
            + "function lg(k,e){try{console.log('DAOIMEJS '+k+' t='+((e.target&&e.target.tagName)||'')+' it='+(e.inputType||'')+' d='+JSON.stringify(e.data==null?null:(''+e.data).slice(-8))+' k='+(e.key||'')+' c='+(e.isComposing?1:0)+st(e.target));}catch(x){}}"
            + "document.addEventListener('keydown',function(e){lg('kd',e);},true);"
            + "document.addEventListener('beforeinput',function(e){lg('bi',e);},true);"
            + "document.addEventListener('input',function(e){lg('in',e);},true);"
            + "document.addEventListener('compositionupdate',function(e){lg('cu',e);},true);"
            + "document.addEventListener('compositionend',function(e){lg('ce',e);},true);})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    // DownloadListener 收到 blob: → 让当前页 JS 取出内容回传
    private void captureBlobDownload(String blobUrl) {
        if (active < 0 || active >= tabs.size()) { toast("下载失败"); return; }
        WebView w = tabs.get(active).web; if (w == null) return;
        String esc = blobUrl.replace("\\", "\\\\").replace("'", "\\'");
        String js = "(function(){try{fetch('" + esc + "').then(function(r){return r.blob();}).then(function(b){var fr=new FileReader();fr.onload=function(){var s=''+fr.result;var i=s.indexOf(',');try{RTDL.saveBase64('download',(b.type||''),i>=0?s.slice(i+1):s);}catch(e){}};fr.readAsDataURL(b);});}catch(e){}})();";
        try { w.evaluateJavascript(js, null); } catch (Exception ignored) {}
    }
    private void captureDataUrl(String dataUrl, String contentDisposition) {
        try {
            int c = dataUrl.indexOf(','); if (c < 0) { toast("下载失败"); return; }
            String meta = dataUrl.substring(5, c);                       // 去掉 "data:"
            String mime = meta.split(";")[0];
            boolean b64 = meta.toLowerCase().contains("base64");
            String payload = dataUrl.substring(c + 1);
            byte[] data = b64 ? android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
                              : java.net.URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8");
            String name = android.webkit.URLUtil.guessFileName(dataUrl, contentDisposition, mime);
            writeDownloadBytes(name, mime, data);
        } catch (Exception e) { toast("下载失败"); }
    }
    // RTDL 桥: 页面把下载内容(base64)回传 → 落地应用下载目录 + 进下载列表
    private class DlBridge {
        @android.webkit.JavascriptInterface
        public void saveBase64(String name, String mime, String b64) {
            try { byte[] data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT); writeDownloadBytes(name, mime, data); }
            catch (Exception e) { main.post(() -> toast("下载捕获失败")); }
        }
        // 对话拖入导入: 源标签提取完的 全量对话md(+取文件指引md) 经此回传 → 注入目标页
        @android.webkit.JavascriptInterface
        public void convExtracted(String json) { main.post(() -> onConvExtracted(json == null ? "{}" : json)); }
    }
    private void writeDownloadBytes(String name, String mime, byte[] data) {
        try {
            if (name == null || name.isEmpty()) name = "download";
            if (!name.contains(".")) {
                String ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime == null ? "" : mime);
                if (ext != null && !ext.isEmpty()) name = name + "." + ext;
            }
            File dir = downloadStoreDir();
            File f = new File(dir, name);
            if (f.exists()) {
                String base = name, ext2 = ""; int dot = name.lastIndexOf('.');
                if (dot > 0) { base = name.substring(0, dot); ext2 = name.substring(dot); }
                f = new File(dir, base + "_" + System.currentTimeMillis() + ext2);
            }
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f); fos.write(data); fos.close();
            final File ff = f; final String fmime = (mime == null || mime.isEmpty()) ? "*/*" : mime; final long sz = ff.length();
            // 同步进系统「下载/最近」→ 其它 App / 文件管理器皆可见可用 (不再只困软件内)
            android.net.Uri pub = publishToDownloads(ff.getName(), fmime, data);
            final String puri = pub == null ? "" : pub.toString();
            main.post(() -> { addDownloadRecord(ff.getName(), ff.getAbsolutePath(), puri, fmime, sz); toast(puri.isEmpty() ? ("下载完成: " + ff.getName()) : ("已下载并同步到系统下载: " + ff.getName())); });
        } catch (Exception e) { main.post(() -> toast("下载失败")); }
    }

    // ── 应用内下载管理器 + 可拖拽悬浮窗 ───────────────────────────────────────
    private void onDownloadComplete(long id) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return;
            android.database.Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id));
            if (cur == null) return;
            try {
                if (!cur.moveToFirst()) return;
                int st = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                String localUri = cur.getString(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                String mediaType = cur.getString(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_MEDIA_TYPE));
                // 更新包: 据 id 或落地文件名识别 (进程重建后 updateDlId 字段会丢, 故还要按文件名兜底),
                // 走自更新分支 → 校验+唤起安装, 绝不混入普通「下载库」(那会污染列表且原文件被搬走/清掉→解析失败/文件已删)。
                String localPath = (localUri != null) ? Uri.parse(localUri).getPath() : null;
                if (isUpdateDownload(id, localPath)) { dlPending.remove(id); onUpdateDownloaded(id); return; }
                String[] meta = dlPending.remove(id);
                if (st == DownloadManager.STATUS_SUCCESSFUL && localUri != null) {
                    String path = Uri.parse(localUri).getPath();
                    if (path == null) return;
                    String name = meta != null ? meta[0] : new File(path).getName();
                    String mime = (meta != null && !meta[1].isEmpty()) ? meta[1] : (mediaType == null ? "*/*" : mediaType);
                    // 从应用沙箱搬到共享保险箱 downloads → 卸载/重装不丢
                    File persisted = persistToVault(new File(path), name);
                    // 同步进系统「下载/最近」→ 其它 App / 文件管理器皆可见可用
                    String puri = "";
                    try { byte[] b = readAllBytes(persisted); android.net.Uri pub = publishToDownloads(name, mime, b); if (pub != null) puri = pub.toString(); } catch (Exception ignored) {}
                    addDownloadRecord(name, persisted.getAbsolutePath(), puri, mime, persisted.length());
                    toast(puri.isEmpty() ? ("下载完成: " + name) : ("已下载并同步系统下载: " + name));
                } else if (st == DownloadManager.STATUS_FAILED) {
                    // 弱网/跨境链路(对象存储直链)易瞬断或凭据过期(403) → 重铸 Cookie 后自动重试,
                    // 至多 2 次; 仍败才报失败, 免用户手点重来。
                    int at = 0; try { if (meta != null && meta.length > 3) at = Integer.parseInt(meta[3]); } catch (Exception ignored) {}
                    String srcUrl = (meta != null && meta.length > 2) ? meta[2] : null;
                    if (srcUrl != null && !srcUrl.isEmpty() && at < 2) {
                        String nm = meta[0]; String mm = meta[1].isEmpty() ? null : meta[1];
                        toast("下载中断, 自动重试: " + nm);
                        startDownload(srcUrl, null, "attachment; filename=\"" + nm + "\"", mm, at + 1);
                    } else toast("下载失败");
                }
            } finally { cur.close(); }
        } catch (Exception ignored) {}
    }
    // ── 在线自动更新 ────────────────────────────────────────────────────────
    /** 当前已安装版本号。 */
    int currentVersionCode() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    /** github release 下载地址 → 多镜像候选 (含 ghproxy 反代, 国内可达)。 */
    private org.json.JSONArray apkMirrors(String gh) {
        org.json.JSONArray a = new org.json.JSONArray();
        if (gh == null || gh.isEmpty()) return a;
        a.put(gh);
        if (gh.startsWith("https://github.com/")) { a.put("https://ghproxy.net/" + gh); a.put("https://gh-proxy.com/" + gh); }
        return a;
    }
    /** 在候选 URL 中挑第一个可达的 (HEAD 探测); 全不通则回退第一个。 */
    private String pickReachable(org.json.JSONArray urls) {
        if (urls == null) return "";
        for (int i = 0; i < urls.length(); i++) {
            String u = urls.optString(i); if (u.isEmpty()) continue;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(u).openConnection();
                c.setConnectTimeout(5000); c.setReadTimeout(5000);
                c.setInstanceFollowRedirects(true); c.setRequestMethod("HEAD");
                c.setRequestProperty("User-Agent", "Mozilla/5.0");
                int code = c.getResponseCode();
                if (code >= 200 && code < 400) return u;
            } catch (Exception ignored) {} finally { if (c != null) c.disconnect(); }
        }
        return urls.length() > 0 ? urls.optString(0) : "";
    }

    /** 更新说明只留最新版一条: 历史版本号长列表对用户是负担, 用户只需最新版的最少量说明。 */
    static String trimNotesLatest(String notes) {
        if (notes == null) return "";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\nv\\d+\\.").matcher(notes);
        if (m.find(1)) notes = notes.substring(0, m.start() + 1);
        return notes.trim();
    }
    /** 拉取在线版本清单并与本机比对。多镜像轮询 (去中心化, 任一可达即可)。后台线程调用。返回 JSON 串。 */
    // CDN 镜像(jsdelivr/statically 等)会缓存旧 latest.json 数小时 → 「取首个可达镜像」会
    // 命中旧版而检查不到新版。故: ① 每镜像 URL 加时间戳防缓存; ② 遍历全部镜像取最大 versionCode。
    String fetchUpdateInfo() {
        String lastErr = "无可用镜像";
        JSONObject best = null; String bestSrc = null;
        for (String murl : UPDATE_MIRRORS) {
            HttpURLConnection c = null;
            try {
                String bust = murl + (murl.indexOf('?') >= 0 ? "&" : "?") + "dao=" + (System.currentTimeMillis() / 60000L);
                c = (HttpURLConnection) new URL(bust).openConnection();
                c.setConnectTimeout(8000); c.setReadTimeout(8000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("Cache-Control", "no-cache");
                c.setRequestProperty("User-Agent", "Mozilla/5.0");
                int code = c.getResponseCode();
                if (code != 200) { lastErr = "HTTP " + code + " @ " + murl; continue; }
                InputStream is = c.getInputStream();
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[4096]; int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                is.close();
                JSONObject m = new JSONObject(new String(bos.toByteArray(), StandardCharsets.UTF_8));
                if (best == null || m.optInt("versionCode", 0) > best.optInt("versionCode", 0)) { best = m; bestSrc = murl; }
            } catch (Exception e) {
                lastErr = String.valueOf(e.getMessage()) + " @ " + murl;
            } finally { if (c != null) c.disconnect(); }
        }
        if (best != null) {
            try {
                int latest = best.optInt("versionCode", 0);
                int cur = currentVersionCode();
                String url = best.optString("url", "");
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("current", cur);
                out.put("latest", latest);
                out.put("latestName", best.optString("versionName", ""));
                out.put("hasUpdate", latest > cur);
                out.put("url", url);
                out.put("urls", apkMirrors(url));
                out.put("notes", trimNotesLatest(best.optString("notes", "")));
                out.put("source", bestSrc);
                return out.toString();
            } catch (Exception e) { lastErr = String.valueOf(e.getMessage()); }
        }
        return "{\"ok\":false,\"error\":" + JSONObject.quote(lastErr) + "}";
    }

    /** 触发更新: 下载最新 APK, 完成后自动唤起系统安装器 (用户点一次「安装」)。url 空则先取清单。 */
    String startUpdate(final String urlIn) {
        try {
            String url = urlIn;
            org.json.JSONArray cands = null;
            if (url == null || url.isEmpty()) {
                JSONObject j = new JSONObject(fetchUpdateInfo());
                if (!j.optBoolean("ok", false)) return j.toString();
                if (!j.optBoolean("hasUpdate", false))
                    return "{\"ok\":true,\"hasUpdate\":false,\"msg\":\"已是最新版\",\"current\":" + j.optInt("current") + "}";
                cands = j.optJSONArray("urls");
                url = (cands != null && cands.length() > 0) ? pickReachable(cands) : j.optString("url", "");
            }
            if (url.isEmpty()) return "{\"ok\":false,\"error\":\"清单无下载地址 url\"}";
            // 候选源: 优先用清单给的多镜像数组; 没有则就地由单 url 推导镜像。下到非法包(如反代返回 HTML)会自动换下一个。
            if (cands == null || cands.length() == 0) cands = apkMirrors(url);
            // 把命中的可达源排到最前 (pickReachable 已选), 其余作兜底
            org.json.JSONArray ordered = new org.json.JSONArray();
            ordered.put(url);
            for (int i = 0; i < cands.length(); i++) { String u = cands.optString(i); if (!u.isEmpty() && !u.equals(url)) ordered.put(u); }
            final org.json.JSONArray furls = ordered;
            main.post(() -> { updateUrls = furls; updateUrlIdx = 0; enqueueUpdateDownload(furls.optString(0)); });
            return "{\"ok\":true,\"downloading\":true,\"url\":" + JSONObject.quote(furls.optString(0)) + ",\"mirrors\":" + furls.length() + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }

    /** 更新包固定落地文件 (app 私有 Download, 不入共享保险箱/系统下载, 不被下载库清理误删)。 */
    private File updateApkDest() {
        File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = getCacheDir();
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, UPDATE_APK_NAME);
    }

    private void enqueueUpdateDownload(String url) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) { toast("更新失败: 无下载服务"); return; }
            updateApkFile = updateApkDest();
            if (updateApkFile.exists()) updateApkFile.delete();
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("Devin Cloud 手机版 · 更新下载中");
            req.setMimeType("application/vnd.android.package-archive");
            req.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, UPDATE_APK_NAME);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            updateDlId = dm.enqueue(req);
            // 持久化任务 id: 进程被杀/Activity 重建后, 仍能据此 (或据文件名) 认领下载完成回调, 不再误当普通下载。
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong("updateDlId", updateDlId).apply();
            toast("正在下载更新…");
        } catch (Exception e) { toast("更新失败: " + e.getMessage()); }
    }

    /** 此 id 是否为「更新包」下载: 内存字段 / 持久化 id / 落地文件名 三重判定 (任一命中即是), 进程重建也不漏认。 */
    private boolean isUpdateDownload(long id, String localPath) {
        if (id >= 0 && id == updateDlId) return true;
        try { if (id >= 0 && id == getSharedPreferences(PREFS, MODE_PRIVATE).getLong("updateDlId", -1)) return true; } catch (Exception ignored) {}
        if (localPath != null && new File(localPath).getName().equals(UPDATE_APK_NAME)) return true;
        return false;
    }

    /** 校验下载到的是不是「我们这个 App 的合法、且不低于当前版本的」安装包。
     *  防反代/镜像把 HTML 错误页当 .apk 存下导致「解析包出现问题」, 也防截断/坏包。 */
    private boolean isValidUpdateApk(File f) {
        try {
            if (f == null || !f.exists() || f.length() < 1024L * 1024L) return false;
            byte[] magic = new byte[4];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) { if (in.read(magic) != 4) return false; }
            if (!(magic[0] == 0x50 && magic[1] == 0x4B && magic[2] == 0x03 && magic[3] == 0x04)) return false; // ZIP/APK 魔数 PK\x03\x04
            android.content.pm.PackageInfo pi = getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            if (pi == null || !getPackageName().equals(pi.packageName)) return false;
            return true;
        } catch (Exception e) { return false; }
    }

    private void onUpdateDownloaded(long id) {
        updateDlId = -1;
        try { getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("updateDlId").apply(); } catch (Exception ignored) {}
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            File apk = null;
            if (dm != null && id >= 0) {
                android.database.Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id));
                if (cur != null) {
                    try {
                        if (cur.moveToFirst()) {
                            int st = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                            if (st != DownloadManager.STATUS_SUCCESSFUL) { tryNextUpdateMirror("更新下载失败"); return; }
                            String lu = cur.getString(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                            if (lu != null) { String p = Uri.parse(lu).getPath(); if (p != null) apk = new File(p); }
                        }
                    } finally { cur.close(); }
                }
            }
            if (apk == null || !apk.exists()) apk = (updateApkFile != null && updateApkFile.exists()) ? updateApkFile : updateApkDest();
            if (!apk.exists()) { tryNextUpdateMirror("更新包未找到"); return; }
            if (!isValidUpdateApk(apk)) {   // 下到的不是合法 APK (多半是镜像/反代返回了网页) → 删掉换下一个源
                try { apk.delete(); } catch (Exception ignored) {}
                tryNextUpdateMirror("下载的安装包无效"); return;
            }
            updateApkFile = apk;
            installApk(apk);
        } catch (Exception e) { toast("更新失败: " + e.getMessage()); }
    }

    /** 当前源下到的包无效/失败时, 自动改用下一个候选镜像重试; 全部用尽才报错。 */
    private void tryNextUpdateMirror(String why) {
        org.json.JSONArray urls = updateUrls;
        int next = updateUrlIdx + 1;
        if (urls != null && next < urls.length()) {
            String u = urls.optString(next);
            if (u != null && !u.isEmpty()) {
                updateUrlIdx = next;
                toast(why + ", 换源重试…");
                main.post(() -> enqueueUpdateDownload(u));
                return;
            }
        }
        toast(why + " (已试遍所有下载源, 请检查网络后重试)");
    }

    /** 启动时认领上次未竟的更新下载: 下载在 App 被杀期间完成→广播漏收, 这里据持久化 id / 落地包补救。
     *  - 任务仍在跑: 复位 updateDlId, 让完成广播能命中;
     *  - 已成功: 直接走校验+安装;
     *  - 落地有「比当前新且合法」的包: 续装; 是旧包/坏包: 清掉, 不打扰。 */
    private void resumePendingUpdate() {
        try {
            long saved = getSharedPreferences(PREFS, MODE_PRIVATE).getLong("updateDlId", -1);
            if (saved >= 0) {
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    android.database.Cursor cur = dm.query(new DownloadManager.Query().setFilterById(saved));
                    if (cur != null) {
                        try {
                            if (cur.moveToFirst()) {
                                int st = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                                if (st == DownloadManager.STATUS_RUNNING || st == DownloadManager.STATUS_PENDING || st == DownloadManager.STATUS_PAUSED) {
                                    updateDlId = saved; return;   // 还在下: 等完成广播
                                }
                                if (st == DownloadManager.STATUS_SUCCESSFUL) { onUpdateDownloaded(saved); return; }
                            }
                        } finally { cur.close(); }
                    }
                }
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("updateDlId").apply();
            }
            // 兜底: 落地若已有合法且更高版本的包, 续装; 否则清掉残包不打扰。
            File apk = updateApkDest();
            if (apk.exists()) {
                if (isValidUpdateApk(apk)) {
                    android.content.pm.PackageInfo pi = getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
                    int vc = pi == null ? 0 : (Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode);
                    if (vc > currentVersionCode()) { updateApkFile = apk; installApk(apk); return; }
                }
                try { apk.delete(); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    /** 待装 APK: 用户被引导去开「安装未知应用」开关, 返回 App 时 onResume 自动续装 (零再触发)。 */
    private File pendingInstallApk;

    private void installApk(File apk) {
        try {
            // Android 8+ 需「允许安装未知应用」。未授权时: 记下待装包 → 自动跳到本应用开关页 →
            // 用户打开开关返回 App, onResume 自动续装, 无需再手动触发更新 (最大化降低操作/认知成本)。
            if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                pendingInstallApk = apk;
                main.post(() -> {
                    if (isFinishing()) return;
                    try {
                        new android.app.AlertDialog.Builder(this)
                            .setTitle("再点一下开关即可自动更新")
                            .setMessage("系统要求先允许「安装未知应用」。点「去开启」会直接跳到本应用的开关页, 打开开关后按返回键回到 App, 更新会自动继续安装, 无需其他操作。")
                            .setCancelable(false)
                            .setPositiveButton("去开启", (d, w) -> openUnknownSourcesSetting())
                            .setNegativeButton("取消", (d, w) -> { pendingInstallApk = null; })
                            .show();
                    } catch (Exception e) { openUnknownSourcesSetting(); }
                });
                return;
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(uri, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
            toast("下载完成, 请点「安装」完成更新");
        } catch (Exception e) { toast("安装唤起失败: " + e.getMessage()); }
    }

    /** 下载文件落地目录: 优先共享保险箱 Documents/DevinCloud/downloads (卸载/重装不丢); 不可写则回退应用沙箱。 */
    private File downloadStoreDir() {
        try {
            File d = new File(vaultDir(), "downloads");
            if ((d.isDirectory() || d.mkdirs()) && d.canWrite()) return d;
        } catch (Exception ignored) {}
        File fb = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
        if (fb == null) fb = getCacheDir();
        if (!fb.exists()) fb.mkdirs();
        return fb;
    }
    /** 把(系统下载落到沙箱的)文件搬入共享保险箱 downloads; 搬不动则原样返回。 */
    private File persistToVault(File src, String name) {
        try {
            File dir = downloadStoreDir();
            if (src.getParentFile() != null && src.getParentFile().equals(dir)) return src;
            String n = (name == null || name.trim().isEmpty()) ? src.getName() : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            File dst = new File(dir, n);
            if (dst.exists()) {
                String base = n, ext = ""; int dot = n.lastIndexOf('.');
                if (dot > 0) { base = n.substring(0, dot); ext = n.substring(dot); }
                dst = new File(dir, base + "_" + System.currentTimeMillis() + ext);
            }
            try (java.io.FileInputStream in = new java.io.FileInputStream(src);
                 java.io.FileOutputStream out = new java.io.FileOutputStream(dst)) {
                byte[] buf = new byte[65536]; int r;
                while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            }
            if (dst.exists() && dst.length() > 0) { src.delete(); return dst; }
        } catch (Exception ignored) {}
        return src;
    }
    /** 读整个文件为字节数组 (供同步进系统下载用)。 */
    private byte[] readAllBytes(File f) throws Exception {
        try (java.io.FileInputStream in = new java.io.FileInputStream(f);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[65536]; int r;
            while ((r = in.read(buf)) > 0) bos.write(buf, 0, r);
            return bos.toByteArray();
        }
    }
    /** 据文件名猜 MIME, 取不到则 application/octet-stream。 */
    private String guessMime(String name) {
        try {
            String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(name == null ? "" : name);
            String mm = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext == null ? "" : ext.toLowerCase());
            if (mm != null && !mm.isEmpty()) return mm;
        } catch (Exception ignored) {}
        return "application/octet-stream";
    }
    /** 把字节流落进系统公共「下载」目录并登记, 使系统「下载/最近」、文件管理器及任意其它 App 都可见可用
     *  (不再只困在软件内部)。API29+ 走 MediaStore.Downloads(Download/DevinCloud, 免「所有文件」权限且自动索引);
     *  旧版写公共 Download 目录 + 媒体扫描登记。返回可直接 ACTION_VIEW/分享/拖拽的内容 Uri; 失败 null。 */
    private android.net.Uri publishToDownloads(String name, String mime, byte[] data) {
        if (data == null) return null;
        try {
            String safe = (name == null || name.trim().isEmpty()) ? ("DevinCloud-" + System.currentTimeMillis()) : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            String m = (mime == null || mime.trim().isEmpty() || "*/*".equals(mime)) ? guessMime(safe) : mime;
            if (Build.VERSION.SDK_INT >= 29) {
                android.content.ContentResolver cr = getContentResolver();
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, safe);
                cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, m);
                cv.put(android.provider.MediaStore.Downloads.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/DevinCloud");
                cv.put(android.provider.MediaStore.Downloads.IS_PENDING, 1);
                android.net.Uri uri = cr.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return null;
                try (java.io.OutputStream os = cr.openOutputStream(uri)) { if (os != null) os.write(data); }
                cv.clear(); cv.put(android.provider.MediaStore.Downloads.IS_PENDING, 0);
                cr.update(uri, cv, null, null);
                return uri;
            }
            File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "DevinCloud");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, safe);
            if (f.exists()) { String b = safe, e = ""; int d = safe.lastIndexOf('.'); if (d > 0) { b = safe.substring(0, d); e = safe.substring(d); } f = new File(dir, b + "_" + System.currentTimeMillis() + e); }
            try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(data); }
            try { android.media.MediaScannerConnection.scanFile(this, new String[]{ f.getAbsolutePath() }, new String[]{ m }, null); } catch (Exception ignored) {}
            try { return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", f); } catch (Exception e) { return android.net.Uri.fromFile(f); }
        } catch (Exception e) { return null; }
    }
    /** 卸载/重装后 SharedPreferences 为空 → 从共享保险箱回读下载记录 (与账号/标签同机制)。 */
    private void restoreDownloads() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String cur = sp.getString("downloads", "");
            if (cur != null && !cur.isEmpty() && !cur.equals("[]")) return;
            String vault = vaultRead("downloads");
            if (vault == null || vault.isEmpty()) return;
            org.json.JSONArray arr = new org.json.JSONArray(vault);
            // 仅保留文件仍存在的记录 (保险箱里的文件卸载不删 → 多数会留存)
            org.json.JSONArray keep = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject e = arr.getJSONObject(i);
                if (new File(e.optString("file", "")).exists() || !e.optString("uri", "").isEmpty()) keep.put(e);
            }
            sp.edit().putString("downloads", keep.toString()).apply();
            if (keep.length() != arr.length()) vaultWrite("downloads", keep.toString());
        } catch (Exception ignored) {}
    }

    /** 清掉历史误记进「下载库」的更新包条目 (旧版本把更新包当普通下载记录了, 现一次性净化)。 */
    private void purgeUpdateRecords() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String s = sp.getString("downloads", "[]");
            org.json.JSONArray arr = new org.json.JSONArray(s);
            org.json.JSONArray keep = new org.json.JSONArray();
            boolean changed = false;
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject e = arr.getJSONObject(i);
                String nm = e.optString("name", ""); String fp = e.optString("file", "");
                if (UPDATE_APK_NAME.equals(nm) || (!fp.isEmpty() && new File(fp).getName().equals(UPDATE_APK_NAME))) { changed = true; continue; }
                keep.put(e);
            }
            if (changed) {
                sp.edit().putString("downloads", keep.toString()).apply();
                vaultWrite("downloads", keep.toString());
                if (dlListCol != null) main.post(() -> renderDownloadList(dlListCol));
            }
        } catch (Exception ignored) {}
    }

    private void addDownloadRecord(String name, String path, String mime, long size) { addDownloadRecord(name, path, "", mime, size); }
    /** uri 非空 = 该文件已登记进系统「下载」(MediaStore/公共目录) → 列表里的打开/拖拽优先用它, 系统级可见可用。 */
    private void addDownloadRecord(String name, String path, String uri, String mime, long size) {
        try {
            // 更新包永不进「下载库」: 它由自更新分支校验+安装, 混进来只会污染列表并被搬走/清掉→「文件已删/解析失败」。
            if (UPDATE_APK_NAME.equals(name) || (path != null && new File(path).getName().equals(UPDATE_APK_NAME))) return;
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("downloads", "[]"));
            org.json.JSONObject e = new org.json.JSONObject();
            e.put("name", name); e.put("file", path == null ? "" : path); e.put("uri", uri == null ? "" : uri); e.put("mime", mime); e.put("size", size); e.put("ts", System.currentTimeMillis());
            arr.put(e);
            while (arr.length() > 100) arr.remove(0);
            sp.edit().putString("downloads", arr.toString()).apply();
            vaultWrite("downloads", arr.toString());   // 落共享保险箱 → 卸载/重装不丢
            if (dlListCol != null) main.post(() -> renderDownloadList(dlListCol));
        } catch (Exception ignored) {}
    }

    private void toggleDownloadPanel() {
        if (dlPanel != null) { closeDownloadPanel(); return; }
        showDownloadPanel();
    }
    private void closeDownloadPanel() {
        if (dlPanel != null && dlPanel.getParent() != null) ((ViewGroup) dlPanel.getParent()).removeView(dlPanel);
        dlPanel = null; dlListCol = null;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  全服通悬浮窗: 近期对话(跨号·实时·拖拽两形态) + 备份网页端(路由 cloud.html)
    // ════════════════════════════════════════════════════════════════════════
    private void toggleDaoPanel() {
        if (daoOpen) { hideDaoPanel(); return; }
        showDaoPanel();
    }
    /** 隐藏全服通悬浮窗但**保活**其 WebView/面板 → 再开秒显, 不再冷启动整页。
     *  仅暂停其 WebView(停后台轮询/渲染, 省电), 不销毁不重载。 */
    private void hideDaoPanel() {
        daoOpen = false;
        if (daoPanel != null) daoPanel.setVisibility(View.GONE);
        if (daoWeb != null) { try { daoWeb.onPause(); } catch (Exception ignored) {} }
    }
    /** 彻底销毁全服通悬浮窗 (仅渲染进程崩溃 / Activity 销毁时用)。 */
    private void destroyDaoPanel() {
        daoOpen = false;
        if (daoWeb != null) { try { daoWeb.destroy(); } catch (Exception ignored) {} daoWeb = null; }
        if (daoPanel != null && daoPanel.getParent() != null) ((ViewGroup) daoPanel.getParent()).removeView(daoPanel);
        daoPanel = null;
    }
    private void showDaoPanel() {
        if (daoPanel == null) buildDaoPanel();           // 首次: 建面板+WebView 并加载一次 (此后保活)
        if (daoPanel.getParent() != null) ((ViewGroup) daoPanel.getParent()).removeView(daoPanel);
        content.addView(daoPanel);                        // 置顶到当前活动标签之上
        daoPanel.setVisibility(View.VISIBLE);
        daoOpen = true;
        if (daoWeb != null) {
            resumeWeb(daoWeb);                            // 唤醒被暂停的 WebView (可见+计时器运行)
            // 页面已驻留内存(localStorage 缓存+实时追踪种子已渲染) → 仅触发一次轻量增量刷新, 不重载整页
            try { daoWeb.evaluateJavascript("try{if(typeof loadRecent==='function'&&document.getElementById('recentView')&&document.getElementById('recentView').classList.contains('on'))loadRecent(false);}catch(e){}", null); } catch (Exception ignored) {}
        }
    }
    /** 首建全服通悬浮窗 (面板+独立 WebView, 加载 daopan.html 一次)。此后开关只切显隐, 不再重建。 */
    private void buildDaoPanel() {
        final FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(0xFF0E1116);
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        int w = Math.min(dp(320), sw - dp(24));
        int h = Math.min(dp(460), (int) (sh * 0.72));
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(w, h);
        plp.gravity = Gravity.TOP | Gravity.END; plp.topMargin = dp(6); plp.rightMargin = dp(8);
        panel.setLayoutParams(plp);

        LinearLayout col = new LinearLayout(this); col.setOrientation(LinearLayout.VERTICAL);
        panel.addView(col, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 标题栏 (拖动可移动整窗)
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(Gravity.CENTER_VERTICAL);
        head.setBackgroundColor(0xFF1F6FEB); head.setPadding(dp(10), dp(8), dp(8), dp(8));
        TextView ttl = new TextView(this); ttl.setText("全服通 · 近期对话 / 备份");
        ttl.setTextColor(0xFFFFFFFF); ttl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        ttl.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView close = new TextView(this); close.setText("✕");
        close.setTextColor(0xFFFFFFFF); close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16); close.setPadding(dp(10), 0, dp(6), 0);
        close.setOnClickListener(v -> hideDaoPanel());
        head.addView(ttl); head.addView(close);
        head.setOnTouchListener(new View.OnTouchListener() {
            float dx, dy;
            @Override public boolean onTouch(View v, MotionEvent ev) {
                switch (ev.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: dx = ev.getRawX() - panel.getTranslationX(); dy = ev.getRawY() - panel.getTranslationY(); return true;
                    case MotionEvent.ACTION_MOVE: panel.setTranslationX(ev.getRawX() - dx); panel.setTranslationY(ev.getRawY() - dy); return true;
                }
                return false;
            }
        });
        col.addView(head);

        WebView web = buildInternalWebView();
        daoWeb = web;
        col.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        daoPanel = panel;
        web.loadUrl(DP_URL);   // 仅首建时加载一次; showDaoPanel 负责挂载到 content 并置顶
    }
    /** 全服通近期对话长按拖拽: 起一个全局拖拽并临时隐藏面板, 使下方网页可接收放手注入。 */
    private void beginConvDrag(String accJson, String sid) {
        try {
            if (sid == null || sid.isEmpty()) return;
            dragConvAccJson = accJson; dragConvSid = sid; dragDlPath = null; dragTabIdx = -1;
            View anchor = (daoWeb != null) ? daoWeb : content;
            anchor.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            doVibrate(30);
            // 小尺寸拖拽影像 (一个蓝色提示条, 而非整个 WebView)
            TextView chip = new TextView(this);
            chip.setText("📄 " + (sid.length() > 18 ? sid.substring(0, 18) : sid) + " · 拖到页面松手");
            chip.setTextColor(0xFFFFFFFF); chip.setBackgroundColor(0xFF1F6FEB);
            chip.setPadding(dp(12), dp(8), dp(12), dp(8)); chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            int wspec = View.MeasureSpec.makeMeasureSpec(dp(240), View.MeasureSpec.AT_MOST);
            int hspec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
            chip.measure(wspec, hspec);
            chip.layout(0, 0, chip.getMeasuredWidth(), chip.getMeasuredHeight());
            ClipData data = new ClipData("conv", new String[]{ "text/plain" }, new ClipData.Item(sid));
            View.DragShadowBuilder shadow = new View.DragShadowBuilder(chip);
            if (Build.VERSION.SDK_INT >= 24) anchor.startDragAndDrop(data, shadow, null, View.DRAG_FLAG_GLOBAL);
            else anchor.startDrag(data, shadow, null, 0);
            if (daoPanel != null) daoPanel.setVisibility(View.INVISIBLE);   // 露出下方网页作为放手目标; ENDED 时恢复
            toast("拖到目标网页松手 (松开后回到全服通)");
        } catch (Exception e) { dragConvAccJson = null; dragConvSid = null; toast("拖拽失败"); }
    }
    /** 独立内部 WebView (非标签): 暴露 Native/RTDL 桥 + 文件拖放监听, 用于全服通悬浮窗。 */
    private WebView buildInternalWebView() {
        WebView web = new WebView(this);
        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setAllowFileAccess(true);
        st.setAllowFileAccessFromFileURLs(true);
        st.setAllowUniversalAccessFromFileURLs(true);
        st.setSupportZoom(true);
        st.setBuiltInZoomControls(true);
        st.setDisplayZoomControls(false);
        st.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.addJavascriptInterface(new Bridge(web), "Native");
        web.addJavascriptInterface(new DlBridge(), "RTDL");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return handleExternalScheme(req.getUrl() == null ? null : req.getUrl().toString());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return handleExternalScheme(u); }
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
                if (v == daoWeb) { destroyDaoPanel(); }   // 渲染进程崩溃: 彻底销毁, 下次开窗重建
                else { try { v.destroy(); } catch (Exception ignored) {} }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                // 仅记录告警/错误: SPA 的 log/info 极其频繁, 全量写 logcat 是无谓开销 → 略过, 减轻主线程负担。
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.WARNING
                        || m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {
                    android.util.Log.w("RTFlowJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                }
                return true;
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) { try { filePathCallback.onReceiveValue(null); } catch (Exception ignored) {} }
                filePathCallback = cb; cameraOutputUri = null;
                try { fileChooser.launch(buildUploadChooser(params)); return true; }
                catch (Exception e) { filePathCallback = null; toast("无法打开上传选择器"); return false; }
            }
        });
        return web;
    }
    private void showDownloadPanel() {
        final FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(0xF2151B24);
        int w = Math.min(dp(300), getResources().getDisplayMetrics().widthPixels - dp(24));
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(w, dp(380));
        plp.gravity = Gravity.TOP | Gravity.END; plp.topMargin = dp(6); plp.rightMargin = dp(8);
        panel.setLayoutParams(plp);

        LinearLayout col = new LinearLayout(this); col.setOrientation(LinearLayout.VERTICAL);
        panel.addView(col, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 标题栏 (拖动可移动整窗, 像电脑悬浮窗)
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(Gravity.CENTER_VERTICAL);
        head.setBackgroundColor(0xFF1F6FEB); head.setPadding(dp(10), dp(8), dp(8), dp(8));
        TextView ttl = new TextView(this); ttl.setText("下载 · 长按文件拖到页面");
        ttl.setTextColor(0xFFFFFFFF); ttl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        ttl.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView close = new TextView(this); close.setText("✕");
        close.setTextColor(0xFFFFFFFF); close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16); close.setPadding(dp(8), 0, dp(4), 0);
        close.setOnClickListener(v -> closeDownloadPanel());
        head.addView(ttl); head.addView(close);
        head.setOnTouchListener(new View.OnTouchListener() {
            float dx, dy;
            @Override public boolean onTouch(View v, MotionEvent ev) {
                switch (ev.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: dx = ev.getRawX() - panel.getTranslationX(); dy = ev.getRawY() - panel.getTranslationY(); return true;
                    case MotionEvent.ACTION_MOVE: panel.setTranslationX(ev.getRawX() - dx); panel.setTranslationY(ev.getRawY() - dy); return true;
                }
                return false;
            }
        });
        col.addView(head);

        android.widget.ScrollView sc = new android.widget.ScrollView(this);
        dlListCol = new LinearLayout(this); dlListCol.setOrientation(LinearLayout.VERTICAL); dlListCol.setPadding(dp(4), dp(4), dp(4), dp(4));
        sc.addView(dlListCol);
        col.addView(sc, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        renderDownloadList(dlListCol);
        dlPanel = panel;
        content.addView(panel);
    }
    private void renderDownloadList(LinearLayout listCol) {
        listCol.removeAllViews();
        try {
            org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("downloads", "[]"));
            if (arr.length() == 0) {
                TextView empty = new TextView(this);
                empty.setText("暂无下载\n网页里下载的文件会出现在这里");
                empty.setTextColor(0xFF8B949E); empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                empty.setGravity(Gravity.CENTER); empty.setPadding(dp(10), dp(24), dp(10), dp(10));
                listCol.addView(empty); return;
            }
            for (int i = arr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = arr.getJSONObject(i);
                final String path = e.optString("file", "");
                final String uri = e.optString("uri", "");
                final String name = e.optString("name", path);
                final String mime = e.optString("mime", "*/*");
                final int recIdx = i;
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(8), dp(8), dp(4), dp(8));
                row.setBackgroundColor(0xFF1B1F26);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.bottomMargin = dp(4); row.setLayoutParams(rlp);
                LinearLayout txt = new LinearLayout(this); txt.setOrientation(LinearLayout.VERTICAL);
                txt.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                TextView nm = new TextView(this); nm.setText(name);
                nm.setTextColor(0xFFE6EDF3); nm.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                nm.setSingleLine(true); nm.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
                File f = new File(path);
                boolean avail = f.exists() || !uri.isEmpty();
                TextView sub = new TextView(this);
                sub.setText((avail ? (f.exists() ? humanSize(f.length()) : "已入系统下载") : "(文件已删)") + " · 点击打开 · 长按拖拽");
                sub.setTextColor(0xFF8B949E); sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                txt.addView(nm); txt.addView(sub);
                Button more = chipBtnSm("\u22EE");
                more.setOnClickListener(v -> showDownloadActions(v, recIdx, path, uri, name, mime));
                row.addView(txt); row.addView(more);
                txt.setOnClickListener(v -> openDownloaded(path, uri, mime));
                txt.setOnLongClickListener(v -> { dragDownloaded(v, path, uri, mime); return true; });
                listCol.addView(row);
            }
        } catch (Exception ignored) {}
    }
    /** 列表项打开/拖拽用的 Uri: 优先系统下载内容 Uri (任意 App 可读), 回退保险箱副本的 FileProvider Uri。 */
    private Uri resolveOpenUri(String path, String uri) {
        if (uri != null && !uri.isEmpty()) { try { return Uri.parse(uri); } catch (Exception ignored) {} }
        try { return fileUri(path); } catch (Exception e) { return null; }
    }
    /** 下载项动作: 分享 / 用其它应用打开 / 重命名 / 删除。 */
    private void showDownloadActions(View anchor, int recIdx, String path, String uri, String name, String mime) {
        PopupMenu pm = new PopupMenu(this, anchor);
        pm.getMenu().add(0, 0, 0, "分享");
        pm.getMenu().add(0, 1, 1, "用其它应用打开");
        pm.getMenu().add(0, 2, 2, "重命名");
        pm.getMenu().add(0, 3, 3, "删除");
        pm.setOnMenuItemClickListener(it -> {
            switch (it.getItemId()) {
                case 0: shareDownloaded(path, uri, mime); return true;
                case 1: openWithChooser(path, uri, mime); return true;
                case 2: renameDownload(recIdx, path, name); return true;
                case 3: deleteDownload(recIdx, path); return true;
            }
            return false;
        });
        pm.show();
    }
    private void shareDownloaded(String path, String uri, String mime) {
        try {
            Uri u = resolveOpenUri(path, uri); if (u == null) { toast("文件已不存在"); return; }
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType((mime == null || mime.isEmpty()) ? "*/*" : mime);
            i.putExtra(Intent.EXTRA_STREAM, u);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(i, "分享到").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { toast("无法分享"); }
    }
    private void openWithChooser(String path, String uri, String mime) {
        try {
            Uri u = resolveOpenUri(path, uri); if (u == null) { toast("文件已不存在"); return; }
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(u, (mime == null || mime.isEmpty()) ? "*/*" : mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(Intent.createChooser(i, "用其它应用打开").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { toast("无法打开"); }
    }
    private void renameDownload(int recIdx, String path, String oldName) {
        final EditText in = new EditText(this); in.setText(oldName); in.setSingleLine(true);
        new android.app.AlertDialog.Builder(this).setTitle("重命名").setView(in)
            .setPositiveButton("确定", (d, w) -> {
                String nn = in.getText().toString().trim(); if (nn.isEmpty()) { toast("名称为空"); return; }
                try {
                    File of = new File(path); File nf = new File(of.getParentFile(), nn);
                    boolean ok = of.exists() && of.renameTo(nf);
                    org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("downloads", "[]"));
                    if (recIdx >= 0 && recIdx < arr.length()) {
                        org.json.JSONObject e = arr.getJSONObject(recIdx);
                        e.put("name", nn); if (ok) e.put("file", nf.getAbsolutePath());
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("downloads", arr.toString()).apply();
                        vaultWrite("downloads", arr.toString());
                    }
                    if (dlListCol != null) renderDownloadList(dlListCol);
                    toast(ok ? "已重命名" : "已更新名称(文件未移动)");
                } catch (Exception ex) { toast("重命名失败"); }
            }).setNegativeButton("取消", null).show();
    }
    private void deleteDownload(int recIdx, String path) {
        try {
            File f = new File(path); if (f.exists()) f.delete();
            org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("downloads", "[]"));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) if (i != recIdx) out.put(arr.getJSONObject(i));
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("downloads", out.toString()).apply();
            vaultWrite("downloads", out.toString());
            if (dlListCol != null) renderDownloadList(dlListCol);
            toast("已删除");
        } catch (Exception e) { toast("删除失败"); }
    }
    private String humanSize(long b) {
        if (b < 1024) return b + " B";
        double k = b / 1024.0; if (k < 1024) return String.format(java.util.Locale.US, "%.1f KB", k);
        double m = k / 1024.0; if (m < 1024) return String.format(java.util.Locale.US, "%.1f MB", m);
        return String.format(java.util.Locale.US, "%.1f GB", m / 1024.0);
    }
    private Uri fileUri(String path) { return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", new File(path)); }
    /** 网页 <input type=file> 上传: 像常规浏览器一样把 相机/图库/文件 并行罗列到同一个选择器。 */
    private Intent buildUploadChooser(android.webkit.WebChromeClient.FileChooserParams params) {
        String acc = "";
        boolean multi = false;
        if (params != null) {
            try { multi = params.getMode() == android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE; } catch (Exception ignored) {}
            String[] at = params.getAcceptTypes();
            if (at != null) { for (String a : at) { if (a != null) acc += a.toLowerCase() + ","; } }
        }
        boolean wantImage = acc.isEmpty() || acc.contains("image") || acc.contains("*/*") || acc.contains(".jpg") || acc.contains(".png");
        boolean wantVideo = acc.isEmpty() || acc.contains("video") || acc.contains("*/*") || acc.contains(".mp4");
        // 主 Intent: 文件 (文档/云盘/任意类型)
        Intent content;
        try { content = (params != null) ? params.createIntent() : new Intent(Intent.ACTION_GET_CONTENT); }
        catch (Exception e) { content = new Intent(Intent.ACTION_GET_CONTENT); }
        if (content.getAction() == null) content.setAction(Intent.ACTION_GET_CONTENT);
        if (content.getType() == null) content.setType("*/*");
        content.addCategory(Intent.CATEGORY_OPENABLE);
        if (multi) content.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        java.util.List<Intent> extra = new java.util.ArrayList<>();
        String pkg = getPackageName();
        // 相机拍照 (输出到 FileProvider Uri, 结果回填) — 明确「相机」入口, 点击直接开相机
        if (wantImage) {
            try {
                File img = new File(getCacheDir(), "cam_" + System.currentTimeMillis() + ".jpg");
                Uri out = FileProvider.getUriForFile(this, pkg + ".fileprovider", img);
                Intent cam = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                cam.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, out);
                cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (cam.resolveActivity(getPackageManager()) != null) { cameraOutputUri = out; extra.add(label(cam, "相机")); }
            } catch (Exception ignored) {}
        }
        // 录像
        if (wantVideo) {
            Intent vid = new Intent(android.provider.MediaStore.ACTION_VIDEO_CAPTURE);
            if (vid.resolveActivity(getPackageManager()) != null) extra.add(label(vid, "录像"));
        }
        // 图库 (照片/视频) — 明确「图库」入口
        Intent gallery;
        if (wantVideo && !wantImage) { gallery = new Intent(Intent.ACTION_PICK, android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI); gallery.setType("video/*"); }
        else { gallery = new Intent(Intent.ACTION_PICK, android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI); gallery.setType(wantVideo ? "image/*,video/*" : "image/*"); }
        if (multi) gallery.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        if (gallery.resolveActivity(getPackageManager()) != null) extra.add(label(gallery, "图库"));
        // 文件夹 (文件管理器/文档/云盘) — 明确「文件夹」入口, 点击直接开文件管理器
        Intent docs = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        docs.addCategory(Intent.CATEGORY_OPENABLE); docs.setType("*/*");
        if (multi) docs.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        if (docs.resolveActivity(getPackageManager()) != null) extra.add(label(docs, "文件夹"));
        Intent chooser = Intent.createChooser(content, "上传 · 相机 / 图库 / 文件夹");
        if (!extra.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toArray(new android.os.Parcelable[0]));
        return chooser;
    }
    /** 给 Intent 套上明确中文标签 (相机/图库/文件夹) 在系统选择器里直观显示。 */
    private Intent label(Intent target, String name) {
        try { return new android.content.pm.LabeledIntent(target, getPackageName(), name, 0); }
        catch (Exception e) { return target; }
    }
    private void openDownloaded(String path, String uri, String mime) {
        try {
            Uri u = resolveOpenUri(path, uri); if (u == null) { toast("文件已不存在"); return; }
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(u, (mime == null || mime.isEmpty()) ? "*/*" : mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) { toast("无法打开此文件 (可在「⋮ → 用其它应用打开」重试)"); }
    }
    private void dragDownloaded(View v, String path, String uriStr, String mime) {
        try {
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            doVibrate(30);
            dragDlPath = path;                                       // 供网页 WebView 的 drop 监听注入 (读保险箱副本)
            dragDlMime = (mime == null || mime.isEmpty()) ? "*/*" : mime;
            Uri uri = resolveOpenUri(path, uriStr);                  // 拖到其它 App: 优先系统下载内容 Uri
            if (uri == null) uri = fileUri(path);
            ClipData data = new ClipData(new File(path).getName(),
                    new String[]{ dragDlMime }, new ClipData.Item(uri));
            View.DragShadowBuilder shadow = new View.DragShadowBuilder(v);
            if (Build.VERSION.SDK_INT >= 24) v.startDragAndDrop(data, shadow, null, View.DRAG_FLAG_GLOBAL | View.DRAG_FLAG_GLOBAL_URI_READ);
            else v.startDrag(data, shadow, null, 0);
            toast("拖到页面的上传/输入区放手");
        } catch (Exception e) { dragDlPath = null; toast("拖拽失败"); }
    }
    /** 网页标签的拖放监听: ① 下载项拖来的文件注入页面; ② 把某对话标签拖入页面→提取并导入两个 md。 */
    private View.OnDragListener downloadDropListener(final WebView web) {
        return (v, ev) -> {
            switch (ev.getAction()) {
                case DragEvent.ACTION_DRAG_STARTED:
                    return dragDlPath != null || dragTabIdx >= 0 || dragConvSid != null;   // 下载项 / 标签对话 / 全服通近期对话 → 接管
                case DragEvent.ACTION_DRAG_ENTERED:
                case DragEvent.ACTION_DRAG_LOCATION:
                case DragEvent.ACTION_DRAG_EXITED:
                    return dragDlPath != null || dragTabIdx >= 0 || dragConvSid != null;
                case DragEvent.ACTION_DROP:
                    if (dragDlPath != null) { dropFileIntoPage(web, ev.getX(), ev.getY(), dragDlPath, dragDlMime); return true; }
                    if (dragTabIdx >= 0) { importConversationFromTab(dragTabIdx, web, ev.getX(), ev.getY()); return true; }
                    if (dragConvSid != null) { importConversationFromData(dragConvAccJson, dragConvSid, web, ev.getX(), ev.getY()); return true; }
                    return false;
                case DragEvent.ACTION_DRAG_ENDED:
                    dragDlPath = null; dragDlMime = null; dragTabIdx = -1; dragConvAccJson = null; dragConvSid = null;
                    if (daoOpen && daoPanel != null) daoPanel.setVisibility(View.VISIBLE);   // 拖拽时临时隐藏的全服通窗 → 恢复
                    return true;
            }
            return false;
        };
    }
    /** 把某标签所示的 Devin 对话(标签拖入页面松手)提取后注入目标页面的上传/拖放区。
     *  优先经引擎(已存 auth1, 服务端取数, 内容完整) extractConversation: 有产出文件 → 文件夹(ZIP)+取数指引MD;
     *  无产出文件 → 对话MD+取数指引MD。引擎不可用/无账号/取数空 → 回退页内 fetch(老链路)。 */
    private void importConversationFromTab(int srcIdx, WebView targetWeb, float x, float y) {
        if (srcIdx < 0 || srcIdx >= tabs.size()) return;
        Tab src = tabs.get(srcIdx);
        if (src == null || src.web == null) { toast("源标签无效"); return; }
        if (src.web == targetWeb) { toast("请把对话标签拖到另一个页面"); return; }
        final WebView sw = src.web;
        final WebView ftarget = targetWeb; final float fx = x, fy = y;
        final String accJson = src.accountJson;   // 该对话所属账号 → 引擎取数 + 生成"查看全部文件"指引md
        final String cachedUrl = src.url == null ? "" : src.url;
        // Devin 是 SPA: 点开对话经 pushState 客户端跳转, 整页加载 URL(=cachedUrl)往往停在 /org/.. 首页 →
        // 直接读 tab.url 会误判"不是对话页"。这里取源标签 WebView 的实时 location.href 为准。
        main.post(() -> {
            try {
                sw.evaluateJavascript("(function(){try{return location.href}catch(e){return ''}})()", val -> {
                    String live = jsUnquote(val);
                    String url = (live != null && live.startsWith("http")) ? live : cachedUrl;
                    proceedImportFromTab(url, sw, ftarget, fx, fy, accJson);
                });
            } catch (Exception e) {
                proceedImportFromTab(cachedUrl, sw, ftarget, fx, fy, accJson);
            }
        });
    }

    /** evaluateJavascript 回调返回的是 JSON 字面量(带引号/转义); 还原为普通字符串。 */
    private static String jsUnquote(String v) {
        if (v == null || v.equals("null")) return "";
        try { return new JSONObject("{\"v\":" + v + "}").optString("v", ""); }
        catch (Exception e) {
            String s = v;
            if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
            return s.replace("\\\"", "\"").replace("\\\\", "\\");
        }
    }

    private void proceedImportFromTab(String url, final WebView sw, WebView targetWeb, float x, float y, final String accJson) {
        if (url == null) url = "";
        String sidTmp = null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(devin-[0-9a-fA-F]{8,})").matcher(url);
        if (m.find()) sidTmp = m.group(1);
        if (sidTmp == null) { java.util.regex.Matcher m2 = java.util.regex.Pattern.compile("/sessions/([A-Za-z0-9_\\-]+)").matcher(url); if (m2.find()) sidTmp = m2.group(1); }
        if (sidTmp == null) { toast("该标签不是 Devin 对话页, 无法导入"); return; }
        final String sid = sidTmp;
        String emailTmp = "";
        if (accJson != null) { try { emailTmp = new JSONObject(accJson).optString("email", ""); } catch (Exception ignored) {} }
        final String email = emailTmp;
        toast("提取对话中…");
        final WebView ftarget = targetWeb; final float fx = x, fy = y; final WebView fsw = sw;
        // 引擎(软件本体)取数注入两形态; 取数空/无引擎 → 回退到源标签页内 fetch 提取
        engineExtractInject(email, sid, accJson, targetWeb, x, y, () -> { toast("引擎取数空, 回退页内提取…"); runInTabConvExtract(fsw, sid, ftarget, fx, fy, accJson); });
    }

    /** 经引擎(软件本体 RelayService)对 email+sid 取数, 注入目标页两形态:
     *  有产出文件 → 文件夹(ZIP·对话md+工作日志+files/) + 取数指引MD; 无产出 → 完整对话MD + 取数指引MD。
     *  email 空 / 引擎离线 / 取数空 → 执行 fallback (回退链路或报错)。 */
    private void engineExtractInject(final String email, final String sid, final String accJson,
                                     final WebView target, final float x, final float y, final Runnable fallback) {
        new Thread(() -> {
            // 秒拖: 该对话已本地备份 → 直接读盘注入两形态, 不联网 (覆盖 全服通拖拽 与 页→页拖拽)
            if (tryLocalBackupInject(email, accJson, sid, target, x, y)) return;
            final RelayService rs = RelayService.instance;
            if (email == null || email.isEmpty() || rs == null) { main.post(() -> { if (fallback != null) fallback.run(); }); return; }
            String conv = "", title = sid, zipB64 = "", zipName = ""; int zipFileCount = 0;
            try {
                JSONObject body = new JSONObject();
                body.put("cmd", "extractConversation");
                body.put("id", email);
                body.put("sid", sid.startsWith("devin-") ? sid : "devin-" + sid);
                body.put("zip", true);
                JSONObject frame = new JSONObject();
                frame.put("path", "/api/rpc"); frame.put("method", "POST"); frame.put("body", body);
                String r = rs.dispatchLocal(frame.toString());
                JSONObject o = new JSONObject(new JSONObject(r).optString("bodyText", "{}"));
                if (o.optBoolean("ok", false)) {
                    conv = o.optString("conversationMd", "");
                    title = o.optString("title", sid);
                    zipB64 = o.optString("zipB64", "");
                    zipName = o.optString("zipName", "");
                    zipFileCount = o.optInt("zipFileCount", 0);
                }
            } catch (Exception ignored) {}
            final String fconv = conv, ftitle = title, fzipB64 = zipB64, fzipName = zipName;
            final int fzfc = zipFileCount;
            main.post(() -> {
                boolean noText = (fconv == null || fconv.isEmpty());
                boolean noZip = (fzipB64 == null || fzipB64.isEmpty());
                if (noText && noZip) { if (fallback != null) fallback.run(); return; }
                String base = (sid.startsWith("devin-") ? sid : "devin-" + sid).replaceAll("[^A-Za-z0-9_\\-]", "_");
                String guide = buildAccessGuideMd(accJson, sid, ftitle);
                java.util.List<String[]> files = new java.util.ArrayList<>();
                if (fzfc > 0 && !noZip) {
                    files.add(new String[]{ (fzipName != null && !fzipName.isEmpty()) ? fzipName : (base + ".zip"), fzipB64 });
                    files.add(new String[]{ base + "-files-access.md", b64Utf8(guide) });
                    dropB64FilesIntoPage(target, x, y, files);
                    toast("已导入 文件夹(ZIP·" + fzfc + "件) + 取数指引");
                } else {
                    files.add(new String[]{ base + "-conversation.md", b64Utf8(fconv) });
                    files.add(new String[]{ base + "-files-access.md", b64Utf8(guide) });
                    dropB64FilesIntoPage(target, x, y, files);
                    toast("已导入 对话MD + 取数指引");
                }
            });
        }).start();
    }

    /** 账号备份文件夹名: 复刻 switch.html _acctFolder ( (email||id) 取@前 → 仅留字母数字_- )。 */
    private String acctFolderOf(String email, String accJson) {
        String base = (email == null) ? "" : email;
        if (base.isEmpty() && accJson != null) {
            try { JSONObject o = new JSONObject(accJson); base = o.optString("email", o.optString("id", "")); } catch (Exception ignored) {}
        }
        if (base == null) base = "";
        int at = base.indexOf('@'); if (at >= 0) base = base.substring(0, at);
        return base.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }

    /** 秒拖: 若该 email+sid 已在本地备份(backups/<folder>/manifest.json), 直接读盘注入两形态, 不联网。
     *  命中并已派发注入返回 true; 未备份/读不到 返回 false (由调用方走联网提取)。 */
    private boolean tryLocalBackupInject(String email, String accJson, String sid, final WebView target, final float x, final float y) {
        try {
            if (target == null || sid == null || sid.isEmpty()) return false;
            String folder = acctFolderOf(email, accJson);
            if (folder.isEmpty()) return false;
            String manStr = vaultReadBackup(folder, "manifest.json");
            if (manStr == null || manStr.isEmpty()) return false;
            JSONObject sessions = new JSONObject(manStr).optJSONObject("sessions");
            if (sessions == null) return false;
            JSONObject ent = sessions.optJSONObject(sid);
            if (ent == null && sid.startsWith("devin-")) ent = sessions.optJSONObject(sid.substring(6));
            if (ent == null && !sid.startsWith("devin-")) ent = sessions.optJSONObject("devin-" + sid);
            if (ent == null) return false;
            final String title = ent.optString("title", sid);
            String mdName = ent.optString("md", "");
            String zipName = ent.optString("zip", "");
            final int hasFiles = ent.optInt("hasFiles", 0);
            final String base = (sid.startsWith("devin-") ? sid : "devin-" + sid).replaceAll("[^A-Za-z0-9_\\-]", "_");
            final String guide = buildAccessGuideMd(accJson, sid, title);
            // 单包 ZIP 为本源: 只要有整包就直注整包(内含对话MD+指引+产出文件, 不再要求 hasFiles>0)
            if (zipName != null && !zipName.isEmpty()) {
                final String zb64 = vaultReadBackupB64(folder, zipName);
                if (zb64 != null && !zb64.isEmpty()) {
                    main.post(() -> {
                        java.util.List<String[]> files = new java.util.ArrayList<>();
                        files.add(new String[]{ base + ".zip", zb64 });
                        files.add(new String[]{ base + "-files-access.md", b64Utf8(guide) });
                        dropB64FilesIntoPage(target, x, y, files);
                        toast("本地备份·秒注入 对话整包ZIP" + (hasFiles > 0 ? ("(" + hasFiles + "件产出)") : "") + " + 取数指引");
                    });
                    return true;
                }
            }
            if (mdName != null && !mdName.isEmpty()) {
                final String md = vaultReadBackup(folder, mdName);
                if (md != null && !md.isEmpty()) {
                    main.post(() -> {
                        java.util.List<String[]> files = new java.util.ArrayList<>();
                        files.add(new String[]{ base + "-conversation.md", b64Utf8(md) });
                        files.add(new String[]{ base + "-files-access.md", b64Utf8(guide) });
                        dropB64FilesIntoPage(target, x, y, files);
                        toast("本地备份·秒注入 对话MD + 取数指引");
                    });
                    return true;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    /** 全服通近期对话拖拽放手: 据账号(含 email/密码/org) + sid 直接经引擎取数并注入目标页 (无需源标签)。 */
    private void importConversationFromData(String accJson, String sid, WebView targetWeb, float x, float y) {
        if (sid == null || sid.isEmpty()) { toast("无对话ID"); return; }
        if (targetWeb == null) return;
        String email = "";
        if (accJson != null) { try { email = new JSONObject(accJson).optString("email", ""); } catch (Exception ignored) {} }
        toast("提取对话中…");
        engineExtractInject(email, sid, accJson, targetWeb, x, y, () -> toast("引擎不可用或取数空, 请确保软件本体在线并已解锁该账号"));
    }
    /** 回退链路: 在源标签 WebView 内就地 fetch 事件流(页面已注入 Bearer) → RTDL.convExtracted 回传 → onConvExtracted 注入两份md。 */
    private void runInTabConvExtract(WebView sw, String sid, WebView target, float x, float y, String accJson) {
        convDropTarget = target; convDropX = x; convDropY = y; convDropAccountJson = accJson;
        final String js = convExtractJs(sid);
        main.post(() -> { try { sw.evaluateJavascript(js, null); } catch (Exception e) { toast("提取失败"); convDropTarget = null; } });
    }
    /** 源标签内运行: fetch 事件流(页面已注入 Bearer) → 构建「全量对话 md」(四类气泡, 与桌面
     *  dao-vsix buildConversationMd 逐字对齐) → RTDL.convExtracted 回传。"查看全部文件"指引 md
     *  由 Java 侧据该账号凭据 + sid 另行生成。 */
    private String convExtractJs(String sid) {
        String s = sid.replace("\\", "\\\\").replace("'", "\\'");
        return "(function(){try{var SID='" + s + "';"
            // 鉴权: Devin 用 Authorization:Bearer(auth1), 不认 cookie。直接从本页登录态真源 (auth1_session)
            //   取出 token+org, 显式带头, 不再 credentials:'include' 空取 → 根治"网页拖拽=零事件"。
            + "var __A=null;try{__A=JSON.parse(sessionStorage.getItem('auth1_session')||localStorage.getItem('auth1_session')||'null');}catch(e){}"
            + "var __TOK=(__A&&__A.token)||'';var __UID=(__A&&__A.userId)||'';var __ORG='';"
            + "try{var __ko=JSON.parse((sessionStorage.getItem('known-org-ids-'+__UID)||localStorage.getItem('known-org-ids-'+__UID))||'null');if(__ko&&__ko.length)__ORG=__ko[0];}catch(e){}"
            + "if(!__ORG){try{__ORG=sessionStorage.getItem('last-internal-org-for-external-org-v1-null')||localStorage.getItem('last-internal-org-for-external-org-v1-null')||'';}catch(e){}}"
            + "function H(x){var h=x||{};if(__TOK)h['Authorization']='Bearer '+__TOK;if(__ORG)h['x-cog-org-id']=__ORG;return h;}"
            // 文本归一 / 时间戳 / 用户回答
            + "function mt(m){if(m==null)return '';if(typeof m==='string')return m;if(Array.isArray(m))return m.map(mt).filter(Boolean).join('\\n');if(typeof m==='object'){if(typeof m.text==='string')return m.text;if(typeof m.message==='string')return m.message;if(m.content!=null)return mt(m.content);return JSON.stringify(m);}return ''+m;}"
            + "function ts(e){var ms=e.created_at_ms||(e.timestamp?Date.parse(e.timestamp):0);return ms?new Date(ms).toISOString():'';}"
            + "function ua(e){var a=e.answers||[];return a.map(function(x){if(!x)return '';if(x.other_text)return x.other_text;if(Array.isArray(x.selected))return x.selected.join('; ');if(typeof x.text==='string')return x.text;return '';}).filter(Boolean).join('\\n');}"
            // 事件归类 → 四类气泡 (移植自桌面 classifyEvent)
            + "function cls(e){if(!e||typeof e!=='object')return null;var t=e.type;"
            + "if(t==='initial_user_message'||t==='user_message')return {k:'user',r:'用户',x:mt(e.message).replace(/^User:\\s*/,'')};"
            + "if(t==='user_question_answered'){var q=ua(e);return q?{k:'user',r:'用户(回答)',x:q}:null;}"
            + "if(t==='devin_message')return {k:'devin',r:'Devin',x:mt(e.message)};"
            + "if(t==='devin_thoughts'){var tt=mt(e.message);return tt?{k:'think',r:'思考',x:tt}:null;}"
            + "if(t==='one_line_thoughts'){var o=e.short||e.summary||'';return o?{k:'think',r:'思考',x:''+o}:null;}"
            + "if(t==='shell_process_started')return {k:'tool',r:'\\uD83D\\uDDA5\\uFE0F shell',d:''+(e.command||'')};"
            + "if(t==='shell_process_completed'||t==='shell_process_completed_background'){var c=e.exit_code==null?'':''+e.exit_code;if(c&&c!=='0')return {k:'tool',r:'\\uD83D\\uDDA5\\uFE0F shell · 退出码 '+c,d:''+(e.output_trunc||'')};return null;}"
            + "if(t==='multi_edit_result')return {k:'tool',r:'\\u270F\\uFE0F 文件编辑',d:(e.file_updates||[]).map(function(f){return (f.action_type||'edit')+' '+(f.file_path||'');}).join('\\n')};"
            + "if(t==='computer_use')return {k:'tool',r:'\\uD83D\\uDDB1\\uFE0F 电脑操作',d:(e.actions||[]).map(function(a){return a&&a.action_type;}).filter(Boolean).join(', ')};"
            + "if(t==='mcp_tool_call'){var d=''+(e.tool_input||'');if(e.output_trunc)d+=(d?'\\n→ ':'')+e.output_trunc;return {k:'tool',r:'\\uD83D\\uDD0C '+(e.tool_name||e.server||'mcp'),d:d};}"
            + "if(t==='search_file_commands')return {k:'tool',r:'\\uD83D\\uDD0D 文件搜索',d:(e.search_commands||[]).map(function(c){return (c.command_name||'search')+': '+(c.regex||c.query||'')+(c.path?' @ '+c.path:'');}).join('\\n')};"
            + "if(t==='web_search')return {k:'tool',r:'\\uD83C\\uDF10 网络搜索',d:''+(e.query||'')+((e.result_urls||[]).length?'\\n'+e.result_urls.join('\\n'):'')};"
            + "if(t==='web_get_contents')return {k:'tool',r:'\\uD83C\\uDF10 抓取网页',d:(e.urls||[]).join('\\n')};"
            + "if(t==='todo_update')return {k:'tool',r:'\\uD83D\\uDCCB 待办更新',d:(e.todos||[]).map(function(td){return '- ['+(td.status==='completed'?'x':' ')+'] '+(td.content||'');}).join('\\n')};"
            + "return null;}"
            // 事件流解析: 花括号配对 + data: 行 双兜底, 去重 + 按时间排序 (与 engine sessionEvents 一致)
            + "function pe(raw){var merged={};var order=[];function add(ev){if(!ev||!ev.type)return;var id=ev.event_id||(ev.type+'-'+ev.timestamp+'-'+ev.created_at_ms);if(!(id in merged)){merged[id]=ev;order.push(id);}}"
            + "var i=0,n=raw.length;while(i<n){while(i<n&&' \\r\\n\\t'.indexOf(raw[i])>=0)i++;if(i>=n)break;"
            + "if(raw[i]==='{'){var depth=0,j=i,inStr=false,esc=false;for(;j<n;j++){var ch=raw[j];if(esc){esc=false;continue;}if(ch==='\\\\'&&inStr){esc=true;continue;}if(ch==='\"'){inStr=!inStr;continue;}if(inStr)continue;if(ch==='{')depth++;if(ch==='}'){depth--;if(depth===0){j++;break;}}}"
            + "try{var o=JSON.parse(raw.slice(i,j));if(o.result&&o.result.length)o.result.forEach(add);else if(o.type)add(o);}catch(e){}i=j;}"
            + "else{var le=raw.indexOf('\\n',i);var end=le===-1?n:le;var line=raw.slice(i,end).trim();i=end+1;if(line.indexOf('data:')===0){var ds=line.slice(5).trim();if(ds&&ds!=='[DONE]'){try{var o2=JSON.parse(ds);if(o2.result&&o2.result.length)o2.result.forEach(add);else if(o2.type)add(o2);}catch(e){}}}}}"
            + "var arr=order.map(function(k){return merged[k];});arr.sort(function(a,b){return (a.created_at_ms||0)-(b.created_at_ms||0);});return arr;}"
            + "fetch('/api/events/'+SID+'/stream',{headers:H({Accept:'text/event-stream'}),credentials:'include'}).then(function(r){return r.text();}).then(function(raw){"
            + "var evs=pe(raw);"
            + "return fetch('/api/sessions/'+SID,{headers:H({}),credentials:'include'}).then(function(r){return r.ok?r.json():{};}).catch(function(){return {};}).then(function(d){"
            + "var title=(d&&d.title)||SID;"
            + "var c=['# 对话: '+title,'','- Session: `'+SID+'`','- 事件数: '+evs.length,''];"
            + "evs.forEach(function(e){var x=cls(e);if(!x)return;var tm=ts(e);"
            + "if(x.k==='user')c.push('## \\uD83D\\uDC64 '+x.r+'  '+tm,'',x.x||'','');"
            + "else if(x.k==='devin')c.push('## \\uD83E\\uDD16 Devin  '+tm,'',x.x||'','');"
            + "else if(x.k==='think')c.push('### \\uD83D\\uDCAD 思考  '+tm,'','> '+String(x.x||'').replace(/\\n/g,'\\n> '),'');"
            + "else if(x.k==='tool')c.push('### '+x.r+'  '+tm,'',x.d?'```\\n'+String(x.d).slice(0,4000)+'\\n```':'','');"
            + "});"
            + "var res={sid:SID,title:title,conv:c.join('\\n'),events:evs.length};"
            + "try{RTDL.convExtracted(JSON.stringify(res));}catch(e){}"
            + "});}).catch(function(err){try{RTDL.convExtracted(JSON.stringify({sid:SID,error:''+err}));}catch(e){}});"
            + "}catch(e){try{RTDL.convExtracted(JSON.stringify({error:''+e}));}catch(_){}}})();";
    }
    /** RTDL.convExtracted 回调 (源标签线程) → 主线程注入两个 md 到目标页:
     *  ① 全量对话 md (四类气泡); ② 「查看该对话全部文件」指引 md (账号+密码+Session ID+提取流程)。 */
    private void onConvExtracted(String json) {
        WebView target = convDropTarget; convDropTarget = null;
        String accJson = convDropAccountJson; convDropAccountJson = null;
        if (target == null) return;
        try {
            JSONObject o = new JSONObject(json);
            String conv = o.optString("conv", "");
            if (conv.isEmpty()) { toast("提取失败: " + o.optString("error", "无对话内容")); return; }
            String sid = o.optString("sid", "session");
            String title = o.optString("title", sid);
            String base = (sid.startsWith("devin-") ? sid : "devin-" + sid).replaceAll("[^A-Za-z0-9_\\-]", "_");
            java.util.List<String[]> files = new java.util.ArrayList<>();
            files.add(new String[]{ base + "-conversation.md", conv });
            files.add(new String[]{ base + "-files-access.md", buildAccessGuideMd(accJson, sid, title) });
            dropTextFilesIntoPage(target, convDropX, convDropY, files);
            toast("已导入 对话+取文件指引 (" + o.optInt("events", 0) + " 事件)");
        } catch (Exception e) { toast("导入失败"); }
    }
    /** 生成「查看该对话全部文件」指引 md: 含该对话所属账号+密码、Session ID、对话提取流程。
     *  网页拖出本就携带该对话上下文 → 第二份文档让另一 Agent(A群) 据此登录并整体取回全部文件。 */
    private String buildAccessGuideMd(String accJson, String sid, String title) {
        String email = "", password = "", orgId = "", orgName = "";
        if (accJson != null) {
            try {
                JSONObject a = new JSONObject(accJson);
                email = a.optString("email", "");
                password = a.optString("password", "");
                orgId = a.optString("orgId", "");
                orgName = a.optString("orgName", "");
            } catch (Exception ignored) {}
        }
        String bare = sid.startsWith("devin-") ? sid.substring(6) : sid;
        StringBuilder b = new StringBuilder();
        b.append("# 查看该对话的全部文件 · 取数指引\n\n");
        b.append("> 本文件随对话拖拽自动生成, 仅针对**当前停留的这一条对话**。\n");
        b.append("> 配套同时拖出的 `").append((sid.startsWith("devin-") ? sid : "devin-" + sid)).append("-conversation.md` 为该对话**全量文本**。\n\n");
        String fullSid = sid.startsWith("devin-") ? sid : "devin-" + sid;
        String emailRef = email.isEmpty() ? "<email>" : email;
        // 0、给读到本文的 Agent 的一句话执行: 账号 + 对话ID + 后端最快全额提取那一行, 置顶, 不必往下翻。
        b.append("## 0、给读到本文的 Agent · 一句话执行\n\n");
        b.append("你拿到的是 **账号 `").append(emailRef).append("`** 的对话 **`").append(fullSid).append("`**");
        b.append("(在线查看 https://app.devin.ai/sessions/").append(bare).append(")。\n");
        b.append("要**完整取回这条对话的全部内容与产出文件**(只读历史·**不耗额度**), 在「板块三 · Devin Cloud 软件本体」对该号执行下面一行即可:\n\n");
        b.append("```jsonc\n");
        b.append("{ \"cmd\": \"extractConversation\", \"id\": \"").append(emailRef).append("\", \"sid\": \"").append(fullSid).append("\", \"save\": true, \"zip\": true }\n");
        b.append("```\n\n");
        b.append("> 该号若未解锁, 先 `{ \"cmd\": \"login\", \"id\": \"").append(emailRef).append("\" }`。一次返回: 完整对话 md + 工作日志 md + 元数据 + **全部产出文件**(`files`/`fileCount`) + 落盘整包 `zipB64`。完整字段与分步/无登录兜底见下文。\n\n");
        b.append("## 一、对话坐标\n\n");
        b.append("| 项 | 值 |\n|----|----|\n");
        b.append("| 标题 | ").append(mdCell(title)).append(" |\n");
        b.append("| Session ID | `").append(sid.startsWith("devin-") ? sid : "devin-" + sid).append("` |\n");
        b.append("| 在线查看 | https://app.devin.ai/sessions/").append(bare).append(" |\n");
        if (!orgName.isEmpty() || !orgId.isEmpty()) b.append("| 组织 | ").append(mdCell(orgName)).append(orgId.isEmpty() ? "" : (" (`" + orgId + "`)")).append(" |\n");
        b.append("\n## 二、该对话所属账号 (额度耗尽也可登录读历史)\n\n");
        b.append("| 项 | 值 |\n|----|----|\n");
        b.append("| 邮箱 | ").append(email.isEmpty() ? "(未知·该标签未带账号)" : ("`" + email + "`")).append(" |\n");
        b.append("| 密码 | ").append(password.isEmpty() ? "(未知)" : ("`" + password + "`")).append(" |\n");
        b.append("\n> 提取只读历史数据, **不消耗额度**。额度限制的是新建会话/发新消息, 不限读取。\n\n");
        b.append("## 三、整体取回该对话全部文件 (推荐: 一行整体提取)\n\n");
        b.append("在「板块三 · Devin Cloud 软件本体」对该号执行:\n\n");
        b.append("```jsonc\n");
        b.append("// 1) 解锁 auth1 (额度耗尽也可)\n");
        b.append("{ \"cmd\": \"login\", \"id\": \"").append(email.isEmpty() ? "<email>" : email).append("\" }\n\n");
        b.append("// 2) 一次拿齐: 元数据 + 完整对话md + 工作日志md + 文件清单; save 落盘共享保险箱, zip 额外打成 MD+ZIP(含产出文件夹)\n");
        b.append("{ \"cmd\": \"extractConversation\", \"id\": \"").append(email.isEmpty() ? "<email>" : email).append("\", \"sid\": \"").append(sid.startsWith("devin-") ? sid : "devin-" + sid).append("\", \"save\": true, \"zip\": true }\n");
        b.append("```\n\n");
        b.append("`extractConversation` 返回: `conversationMd`(完整对话) · `worklogMd`(工作日志) · `detail`(元数据) · `files`/`fileCount`(附件清单 name/url/path) · `saved`(落盘文件名)。\n");
        b.append("加 `zip:true` 时另返 `zipB64`(整包 base64: `对话_人类可读.md`+`工作日志.md`+`_meta.json`+`files/<产出文件>`) + `zipName` + `zipFileCount` — **本地有产出文件即 MD+ZIP 形态**, 云端 Agent 直接 base64 解码落盘即可。\n");
        b.append("> 在手机切号面板里, 每条对话行的 📦 按钮等价于此 ZIP(对话md+工作日志+产出文件夹)一键下载到手机「下载」目录。\n\n");
        b.append("## 四、分步法 (需精细控制时)\n\n");
        b.append("1. `login {id}` → 解锁 `auth1`。\n");
        b.append("2. `listSessions {id, limit:200}` → 确认本 `devin_id`。\n");
        b.append("3. `exportSession {id, sid, kind:\"conversation\"}` 与 `kind:\"worklog\"` 取两类 md。\n");
        b.append("4. `sessionMessages` / `sessionDetail` 兜底取消息与附件。\n");
        b.append("5. 落地手机: 加 `save:true` 写入共享保险箱 `Documents/DevinCloud/` (卸载/重装不丢)。\n\n");
        b.append("## 五、无 auth1 / 只要页面所见即所得 (浏览器自动化)\n\n");
        b.append("1. `browseOpen {url:\"https://app.devin.ai/sessions/").append(bare).append("\", account:\"").append(email.isEmpty() ? "<email>" : email).append("\"}` — 用该号上下文新开页, 不打扰用户当前页。\n");
        b.append("2. `browseWaitForElement` 等内容加载 → `browseExportMd {tabIndex, save:true}` 导出整页 Markdown。\n");
        b.append("3. 或 `browseGetDom` 取完整 DOM 自行解析。\n");
        // 六、经本机中继远程驱动 (端到端加密) — 让授权方在不登录账号的前提下直接驱动本设备, 且中继读不到明文。
        String e2eKey = "", endpoint = "", session = "";
        try {
            String rc = readFilesText("relay-config.json");
            if (rc != null && rc.length() > 5) { JSONObject c = new JSONObject(rc);
                e2eKey = c.optString("e2eKey", ""); endpoint = c.optString("endpoint", ""); session = c.optString("session", ""); }
        } catch (Exception ignored) {}
        if (!e2eKey.isEmpty()) {
            b.append("\n## 六、经本机中继远程驱动 · 端到端加密 (去中心化)\n\n");
            b.append("> 账号邮箱/密码/token **从不**经过中继明文; RPC 载荷用下方 `E2E Key` 端到端加密, 中继(含任何共享 Worker)只见密文。\n\n");
            b.append("| 项 | 值 |\n|----|----|\n");
            if (!endpoint.isEmpty()) b.append("| 中继入口 | `").append(endpoint).append("` |\n");
            if (!session.isEmpty()) b.append("| Session | `").append(session).append("` |\n");
            b.append("| E2E Key | `").append(e2eKey).append("` |\n");
            b.append("| Token | (每次冷启动轮换, 在穿透面板「复制」当前值) |\n");
            b.append("\n驱动方加解密参考实现见仓库 `tools/dao-e2e/`(JS/Python 与设备逐字节兼容): 请求 body 改为 ");
            b.append("`{\"__e2e__\":1,\"c\":seal(JSON.stringify(realBody))}`, 响应 body 形如 `{\"__e2e__\":1,\"c\":\"<密文>\"}` 用同 key `open` 解密。\n");
        }
        return b.toString();
    }
    private static String mdCell(String s) { return s == null ? "" : s.replace("|", "\\|").replace("\n", " ").trim(); }
    /** UTF-8 文本 → base64 (NO_WRAP), 供 dropB64FilesIntoPage 统一注入。 */
    private static String b64Utf8(String s) {
        try { return android.util.Base64.encodeToString((s == null ? "" : s).getBytes("UTF-8"), android.util.Base64.NO_WRAP); } catch (Exception e) { return ""; }
    }
    /** 把内存中的多份文本(md)作为文件注入页面 (file input + dropzone 双路, 同 dropFileIntoPage)。 */
    private void dropTextFilesIntoPage(final WebView web, float x, float y, java.util.List<String[]> files) {
        if (web == null || files == null || files.isEmpty()) return;
        java.util.List<String[]> b = new java.util.ArrayList<>();
        for (String[] f : files) b.add(new String[]{ f[0], b64Utf8(f[1]) });
        dropB64FilesIntoPage(web, x, y, b);
    }
    /** 把内存中的多份文件(name + 已 base64 的字节)注入页面: 文本(md)与二进制(zip)统一走此路。 */
    private void dropB64FilesIntoPage(final WebView web, float x, float y, java.util.List<String[]> files) {
        if (web == null || files == null || files.isEmpty()) return;
        StringBuilder arr = new StringBuilder("[");
        for (int i = 0; i < files.size(); i++) {
            String name = files.get(i)[0]; String b64 = files.get(i)[1]; if (b64 == null) b64 = "";
            if (i > 0) arr.append(",");
            arr.append("{n:'").append(name.replace("\\", "\\\\").replace("'", "\\'")).append("',b:'").append(b64).append("'}");
        }
        arr.append("]");
        final String js = "(function(){try{var specs=" + arr + ";"
            + "function mk(s){var bin=atob(s.b);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);var mime=/\\.zip$/i.test(s.n)?'application/zip':'text/markdown';return new File([u],s.n,{type:mime});}"
            + "var files=specs.map(mk);var dt=new DataTransfer();files.forEach(function(f){dt.items.add(f);});"
            + "var dpr=window.devicePixelRatio||1;var cx=" + x + "/dpr, cy=" + y + "/dpr;"
            + "var el=document.elementFromPoint(cx,cy)||document.body;"
            + "var inp=null;var n=el;while(n){if(n.tagName==='INPUT'&&(n.type||'').toLowerCase()==='file'){inp=n;break;}n=n.parentElement;}"
            + "if(!inp){var z=el;while(z){if(z.querySelector){inp=z.querySelector('input[type=file]');if(inp)break;}z=z.parentElement;}}"
            + "if(!inp)inp=document.querySelector('input[type=file]');"
            // 修复重复(2→4): 命中 file-input 即走 input 单路并立即返回; 绝不再派发 drop 事件,
            // 否则同时挂 input + dropzone 的页面(如 Devin 编辑框)两路都吃 → 每份文件翻倍。
            + "if(inp){try{inp.files=dt.files;}catch(e){}inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return 'input';}"
            // 仅当没有任何 file-input 时, 才回退到 dropzone(drop 事件)单路注入。
            + "var opt={bubbles:true,cancelable:true};"
            + "['dragenter','dragover','drop'].forEach(function(t){try{var e=new DragEvent(t,opt);Object.defineProperty(e,'dataTransfer',{value:dt});el.dispatchEvent(e);}catch(err){}});"
            + "return 'drop';}catch(e){return 'err:'+e;}})();";
        main.post(() -> { try { web.evaluateJavascript(js, null); } catch (Exception e) { toast("注入失败"); } });
    }
    /** 在 (x,y) 处把文件注入网页: 设到 file input 并对落点元素派发 drop 事件 (兼容 dropzone 上传组件)。 */
    private void dropFileIntoPage(final WebView web, float x, float y, String path, String mime) {
        if (web == null) return;
        new Thread(() -> {
            try {
                File f = new File(path);
                if (!f.exists()) { main.post(() -> toast("文件已不存在")); return; }
                byte[] data = new byte[(int) f.length()];
                try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                    int off = 0, r; while (off < data.length && (r = fis.read(data, off, data.length - off)) > 0) off += r;
                }
                String b64 = android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP);
                String name = f.getName().replace("\\", "\\\\").replace("'", "\\'");
                String m = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
                String js = "(function(){try{"
                    + "var b=atob('" + b64 + "');var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);"
                    + "var file=new File([u],'" + name + "',{type:'" + m + "'});"
                    + "var dt=new DataTransfer();dt.items.add(file);"
                    + "var dpr=window.devicePixelRatio||1;var cx=" + x + "/dpr, cy=" + y + "/dpr;"
                    + "var el=document.elementFromPoint(cx,cy)||document.body;"
                    + "var inp=null;var n=el;while(n){if(n.tagName==='INPUT'&&(n.type||'').toLowerCase()==='file'){inp=n;break;}n=n.parentElement;}"
                    + "if(!inp){var z=el;while(z){if(z.querySelector){inp=z.querySelector('input[type=file]');if(inp)break;}z=z.parentElement;}}"
                    + "if(!inp)inp=document.querySelector('input[type=file]');"
                    // 修复重复: 命中 file-input 即单路注入并立即返回, 不再额外派发 drop(否则两路都吃 → 翻倍)。
                    + "if(inp){try{inp.files=dt.files;}catch(e){}inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return 'input';}"
                    + "var opt={bubbles:true,cancelable:true};"
                    + "['dragenter','dragover','drop'].forEach(function(t){try{var dt2=new DataTransfer();dt2.items.add(file);var e=new DragEvent(t,opt);Object.defineProperty(e,'dataTransfer',{value:dt2});el.dispatchEvent(e);}catch(err){}});"
                    + "return 'drop';}catch(e){return 'err:'+e;}})();";
                main.post(() -> {
                    try { web.evaluateJavascript(js, val -> {
                        if (val != null && val.contains("input")) toast("已放入页面上传框");
                        else toast("已投放到页面 (若未生效请点页面的上传按钮)");
                    }); } catch (Exception e) { toast("注入失败"); }
                });
            } catch (Exception e) { main.post(() -> toast("拖拽注入失败")); }
        }).start();
    }

    // ── 网页栏五角星收藏 ───────────────────────────────────────────────────
    private void toggleBookmarkCurrent() {
        Tab cur = (active >= 0 && active < tabs.size()) ? tabs.get(active) : null;
        if (cur == null) return;
        String url = displayUrl(cur);
        if (url == null || url.startsWith("rtflow:") || url.startsWith("file:") || url.startsWith("about:")) { toast("内部页不可收藏"); return; }
        if (isBookmarked(url)) { removeBookmark(url); toast("已取消收藏"); }
        else { addBookmark(url, chipTitle(cur), cur); }
        updateStar();
    }
    private boolean isBookmarked(String url) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("bookmarks", "[]"));
            for (int i = 0; i < arr.length(); i++) if (url.equals(arr.getJSONObject(i).optString("url"))) return true;
        } catch (Exception ignored) {}
        return false;
    }
    private void removeBookmark(String url) { removeBookmarkPersist(url); }
    private void removeBookmarkPersist(String url) {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("bookmarks", "[]"));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) { if (!url.equals(arr.getJSONObject(i).optString("url"))) out.put(arr.getJSONObject(i)); }
            sp.edit().putString("bookmarks", out.toString()).apply();
            vaultWrite("bookmarks", out.toString());
        } catch (Exception ignored) {}
    }
    private void deleteHistoryUrl(String url, boolean devin) {
        String key = devin ? "history_devin" : "history";
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString(key, "[]"));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) { if (!url.equals(arr.getJSONObject(i).optString("url"))) out.put(arr.getJSONObject(i)); }
            sp.edit().putString(key, out.toString()).apply();
            vaultWrite(key, out.toString());
        } catch (Exception ignored) {}
    }

    // ── 多选批量操作 (历史/书签列表页, 对标手机浏览器) ──────────────────────
    private void deleteHistoryBatch(org.json.JSONArray urls, boolean devin) {
        String key = devin ? "history_devin" : "history";
        try {
            java.util.HashSet<String> set = new java.util.HashSet<>();
            for (int i = 0; i < urls.length(); i++) set.add(urls.optString(i));
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString(key, "[]"));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) { org.json.JSONObject e = arr.getJSONObject(i); if (!set.contains(e.optString("url"))) out.put(e); }
            sp.edit().putString(key, out.toString()).apply(); vaultWrite(key, out.toString());
        } catch (Exception ignored) {}
    }
    private void deleteBookmarkBatch(org.json.JSONArray urls) {
        try {
            java.util.HashSet<String> set = new java.util.HashSet<>();
            for (int i = 0; i < urls.length(); i++) set.add(urls.optString(i));
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("bookmarks", "[]"));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) { org.json.JSONObject e = arr.getJSONObject(i); if (!set.contains(e.optString("url"))) out.put(e); }
            sp.edit().putString("bookmarks", out.toString()).apply(); vaultWrite("bookmarks", out.toString());
            updateStar();
        } catch (Exception ignored) {}
    }
    /** 批量收藏 (历史→收藏): 去重已存在, 返回新增条数。不弹 toast (调用方汇总)。 */
    private int addBookmarkBatch(org.json.JSONArray items) {
        int added = 0;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("bookmarks", "[]"));
            java.util.HashSet<String> have = new java.util.HashSet<>();
            for (int i = 0; i < arr.length(); i++) have.add(arr.getJSONObject(i).optString("url"));
            for (int i = 0; i < items.length(); i++) {
                org.json.JSONObject it = items.optJSONObject(i); if (it == null) continue;
                String url = it.optString("url", "");
                if (url.isEmpty() || url.startsWith("rtflow:") || url.startsWith("file:") || url.startsWith("about:")) continue;
                if (have.contains(url)) continue;
                org.json.JSONObject e = new org.json.JSONObject();
                e.put("url", url); e.put("title", it.optString("title", url)); e.put("ts", System.currentTimeMillis());
                String acc = it.optString("account", "");
                if (it.optBoolean("devin", false) && !acc.isEmpty()) { e.put("devin", true); e.put("account", acc); }
                arr.put(e); have.add(url); added++;
            }
            sp.edit().putString("bookmarks", arr.toString()).apply(); vaultWrite("bookmarks", arr.toString());
        } catch (Exception ignored) {}
        return added;
    }
    private void downloadBatch(org.json.JSONArray urls) {
        for (int i = 0; i < urls.length(); i++) { String u = urls.optString(i); if (u != null && u.startsWith("http")) startDownload(u, null, null, null); }
    }
    private void clearHistoryAll() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            sp.edit().putString("history", "[]").putString("history_devin", "[]").apply();
            vaultWrite("history", "[]"); vaultWrite("history_devin", "[]");
        } catch (Exception ignored) {}
    }

    private void updateStar() {
        if (starBtn == null) return;
        Tab cur = (active >= 0 && active < tabs.size()) ? tabs.get(active) : null;
        String url = cur == null ? "" : displayUrl(cur);
        boolean canBm = !(url == null || url.isEmpty() || url.startsWith("rtflow:") || url.startsWith("file:") || url.startsWith("about:"));
        boolean on = canBm && isBookmarked(url);
        starBtn.setText(on ? "\u2605" : "\u2606");
        starBtn.setTextColor(on ? 0xFFE3B341 : 0xFFCDD3DE);
    }

    // ── 数据保险箱: 共享文件夹 Documents/DevinCloud (脱离应用沙箱, 卸载/重装/换机不丢) ──
    /** 申请「所有文件访问」(MANAGE_EXTERNAL_STORAGE) — 授予后才能写公共目录且卸载不删。 */
    private void ensureAllFilesAccess() {
        try {
            if (Build.VERSION.SDK_INT >= 30 && !android.os.Environment.isExternalStorageManager()) {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                toast("请开启「所有文件访问」以便数据卸载重装不丢");
            }
        } catch (Exception e) {
            try { startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
        }
    }
    private File vaultDir() {
        File d = new File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOCUMENTS), "DevinCloud");
        if (!d.exists()) d.mkdirs();
        return d;
    }
    private void vaultWrite(String key, String data) {
        try {
            String safe = key.replaceAll("[\\\\/:*?\"<>|]", "_");
            File f = new File(vaultDir(), safe + ".json");
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write((data == null ? "" : data).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {}
    }
    /** 全量备份落地到 Documents/DevinCloud/backups/<账号文件夹>/<name> — 脱离沙箱, 卸载/重装不丢。 */
    boolean vaultSaveBackup(String folder, String name, String content) {
        try {
            File base = new File(vaultDir(), "backups");
            String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
            File dir = new File(base, sf);
            if (!dir.exists()) dir.mkdirs();
            String safe = (name == null || name.trim().isEmpty()) ? ("backup-" + System.currentTimeMillis() + ".json") : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            File f = new File(dir, safe);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            }
            return true;
        } catch (Exception e) { return false; }
    }
    /** 二进制备份(base64→字节)落地到 backups/<folder>/<name> — 整文件夹 ZIP 入库, 卸载/重装不丢。 */
    boolean vaultSaveBackupB64(String folder, String name, String base64) {
        try {
            File base = new File(vaultDir(), "backups");
            String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
            File dir = new File(base, sf);
            if (!dir.exists()) dir.mkdirs();
            String safe = (name == null || name.trim().isEmpty()) ? ("backup-" + System.currentTimeMillis() + ".bin") : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            byte[] bytes = android.util.Base64.decode(base64 == null ? "" : base64, android.util.Base64.DEFAULT);
            try (FileOutputStream fos = new FileOutputStream(new File(dir, safe))) { fos.write(bytes); }
            return true;
        } catch (Exception e) { return false; }
    }
    /** 列出 backups/<folder>/ 下全部文件 → JSON [{name,size,mtime}] (备份页搜索 / 本地数据源检索)。 */
    String vaultListBackups(String folder) {
        try {
            File base = new File(vaultDir(), "backups");
            String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
            File dir = new File(base, sf);
            org.json.JSONArray arr = new org.json.JSONArray();
            File[] fs = dir.listFiles();
            if (fs != null) for (File f : fs) {
                if (!f.isFile()) continue;
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("name", f.getName()); o.put("size", f.length()); o.put("mtime", f.lastModified());
                arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) { return "[]"; }
    }
    /** 列出 backups/ 下全部账号文件夹名 → JSON [name] (含已移出库的账号, 备份库悬浮窗全量检索)。 */
    String vaultListBackupAccounts() {
        try {
            File base = new File(vaultDir(), "backups");
            org.json.JSONArray arr = new org.json.JSONArray();
            File[] fs = base.listFiles();
            if (fs != null) for (File f : fs) { if (f.isDirectory()) arr.put(f.getName()); }
            return arr.toString();
        } catch (Exception e) { return "[]"; }
    }
    /** 读 backups/<folder>/<name> 二进制 → base64 (sess-<sid>.zip 本地全量产出一键拉取)。 */
    String vaultReadBackupB64(String folder, String name) {
        try {
            File base = new File(vaultDir(), "backups");
            String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
            String safe = (name == null) ? "" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            File f = new File(new File(base, sf), safe);
            if (!f.exists()) return "";
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                int off = 0, r; while (off < buf.length && (r = fis.read(buf, off, buf.length - off)) > 0) off += r;
            }
            return android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP);
        } catch (Exception e) { return ""; }
    }
    /** 读 backups/<folder>/<name> 文本 (manifest.json / conv-<sid>.md) — 本地数据源无感回退。 */
    String vaultReadBackup(String folder, String name) {
        try {
            File base = new File(vaultDir(), "backups");
            String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
            String safe = (name == null) ? "" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            File f = new File(new File(base, sf), safe);
            if (!f.exists()) return "";
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                int off = 0, r; while (off < buf.length && (r = fis.read(buf, off, buf.length - off)) > 0) off += r;
            }
            return new String(buf, StandardCharsets.UTF_8);
        } catch (Exception e) { return ""; }
    }
    /** 删 backups/<folder>/<name> — 仅限备份库内单文件(名字经消毒·不可越目录); 不存在视为已删。 */
    boolean vaultDeleteBackup(String folder, String name) {
        try {
            if (name == null || name.trim().isEmpty()) return false;
            File base = new File(vaultDir(), "backups");
            String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            File f = new File(new File(base, sf), safe);
            if (!f.exists()) return true;
            return f.isFile() && f.delete();
        } catch (Exception e) { return false; }
    }
    /** 直驱 Vibrator 的震动 (不受系统触感开关影响), 供多选长按/低额提醒等使用。 */
    void doVibrate(int ms) {
        try {
            android.os.Vibrator v = (android.os.Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(android.os.VibrationEffect.createOneShot(ms, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
            else v.vibrate(ms);
        } catch (Exception ignored) {}
    }
    private String vaultRead(String key) {
        try {
            String safe = key.replaceAll("[\\\\/:*?\"<>|]", "_");
            File f = new File(vaultDir(), safe + ".json");
            if (!f.exists()) return "";
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
                int off = 0, r; while (off < buf.length && (r = fis.read(buf, off, buf.length - off)) > 0) off += r;
            }
            return new String(buf, StandardCharsets.UTF_8);
        } catch (Exception e) { return ""; }
    }

    // ── 整机分享: 导出/导入 (一个文件含 APK 本体 + 全部数据, 换机一拿即同步) ──────
    //  Android 不允许「单个已安装 APK 内塞数据」(改 APK 即破签名无法安装), 故用等效 zip:
    //  zip = DevinCloud.apk(应用自身安装包) + vault/(整个共享保险箱: 账号/标签/历史/下载/备份/脚本) + prefs.json + manifest.json
    private void exportShareBundle() {
        toast("正在打包整机分享包…");
        new Thread(() -> {
            try {
                saveTabs();   // 先把当前标签状态刷进保险箱
                File outDir = new File(vaultDir(), "share");
                if (!outDir.exists()) outDir.mkdirs();
                File zip = new File(outDir, "DevinCloud-整机分享-v" + appVersionName() + ".zip");
                if (zip.exists()) zip.delete();
                java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(
                        new java.io.BufferedOutputStream(new FileOutputStream(zip)));
                // 1) APK 本体 (应用自己的安装包)
                try {
                    File apk = new File(getApplicationInfo().sourceDir);
                    if (apk.exists()) zipFile(zos, apk, "DevinCloud.apk");
                } catch (Exception ignored) {}
                // 2) 全部 SharedPreferences → prefs.json
                try {
                    org.json.JSONObject pj = new org.json.JSONObject();
                    java.util.Map<String, ?> all = getSharedPreferences(PREFS, MODE_PRIVATE).getAll();
                    for (java.util.Map.Entry<String, ?> e : all.entrySet())
                        pj.put(e.getKey(), e.getValue() == null ? org.json.JSONObject.NULL : e.getValue().toString());
                    org.json.JSONObject wrap = new org.json.JSONObject();
                    wrap.put("__prefsName", PREFS); wrap.put("data", pj);
                    zipBytes(zos, "prefs.json", wrap.toString().getBytes(StandardCharsets.UTF_8));
                } catch (Exception ignored) {}
                // 3) 整个共享保险箱 → vault/ (排除 share/ 自身, 避免自包含)
                File vd = vaultDir();
                zipDir(zos, vd, "vault", new File(vd, "share"));
                // 4) manifest
                try {
                    org.json.JSONObject mf = new org.json.JSONObject();
                    mf.put("app", "Devin Cloud 手机版");
                    mf.put("versionName", appVersionName());
                    mf.put("versionCode", appVersionCode());
                    mf.put("package", getPackageName());
                    mf.put("exportedAt", System.currentTimeMillis());
                    zipBytes(zos, "manifest.json", mf.toString().getBytes(StandardCharsets.UTF_8));
                } catch (Exception ignored) {}
                zos.close();
                final long mb = Math.max(1, zip.length() / 1024 / 1024);
                final Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", zip);
                main.post(() -> {
                    toast("打包完成: " + zip.getName() + " (~" + mb + "MB)");
                    Intent it = new Intent(Intent.ACTION_SEND);
                    it.setType("application/zip");
                    it.putExtra(Intent.EXTRA_STREAM, uri);
                    it.putExtra(Intent.EXTRA_SUBJECT, "Devin Cloud 手机版 · 整机分享包");
                    it.putExtra(Intent.EXTRA_TEXT, "含 APK 本体 + 全部数据。新设备: 装 DevinCloud.apk → 打开 → ≡ 页面工具 → 导入分享包 → 选本 zip, 即同步全部账号/数据。");
                    it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(it, "分享整机分享包"));
                });
            } catch (Exception e) {
                main.post(() -> toast("导出失败: " + e.getMessage()));
            }
        }).start();
    }

    private void pickShareBundle() {
        try {
            Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            it.addCategory(Intent.CATEGORY_OPENABLE);
            it.setType("*/*");
            it.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{ "application/zip", "application/octet-stream" });
            shareImportPicker.launch(it);
        } catch (Exception e) { toast("无法打开选择器: " + e.getMessage()); }
    }

    private void importShareBundle(Uri uri) {
        toast("正在导入分享包…");
        new Thread(() -> {
            File apkOut = null;
            try {
                File vd = vaultDir();
                java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(
                        new java.io.BufferedInputStream(getContentResolver().openInputStream(uri)));
                java.util.zip.ZipEntry ze; byte[] buf = new byte[8192]; String prefsJson = null;
                File cacheApk = new File(getCacheDir(), "DevinCloud-import.apk");
                while ((ze = zis.getNextEntry()) != null) {
                    String name = ze.getName();
                    if (ze.isDirectory() || name == null) { zis.closeEntry(); continue; }
                    if (name.contains("..")) { zis.closeEntry(); continue; }   // 防目录穿越
                    if (name.equals("DevinCloud.apk")) {
                        try (FileOutputStream fos = new FileOutputStream(cacheApk)) { int r; while ((r = zis.read(buf)) > 0) fos.write(buf, 0, r); }
                        apkOut = cacheApk;
                    } else if (name.equals("prefs.json")) {
                        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); int r; while ((r = zis.read(buf)) > 0) bo.write(buf, 0, r);
                        prefsJson = new String(bo.toByteArray(), StandardCharsets.UTF_8);
                    } else if (name.startsWith("vault/")) {
                        String rel = name.substring("vault/".length());
                        if (rel.isEmpty()) { zis.closeEntry(); continue; }
                        File out = new File(vd, rel);
                        File parent = out.getParentFile(); if (parent != null && !parent.exists()) parent.mkdirs();
                        try (FileOutputStream fos = new FileOutputStream(out)) { int r; while ((r = zis.read(buf)) > 0) fos.write(buf, 0, r); }
                    }
                    zis.closeEntry();
                }
                zis.close();
                if (prefsJson != null) {
                    try {
                        org.json.JSONObject wrap = new org.json.JSONObject(prefsJson);
                        org.json.JSONObject data = wrap.optJSONObject("data");
                        if (data != null) {
                            SharedPreferences.Editor ed = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
                            java.util.Iterator<String> ks = data.keys();
                            while (ks.hasNext()) { String k = ks.next(); ed.putString(k, data.getString(k)); }
                            ed.apply();
                        }
                    } catch (Exception ignored) {}
                }
                final File apk = apkOut;
                main.post(() -> {
                    if (apk != null && apk.exists()) {
                        new android.app.AlertDialog.Builder(this)
                                .setTitle("数据已导入")
                                .setMessage("全部账号/标签/历史/下载已还原到共享保险箱。是否现在安装分享包内的 APK 本体? (签名一致, 原地覆盖, 数据不丢)")
                                .setPositiveButton("安装 APK", (d, w) -> installApk(apk))
                                .setNegativeButton("稍后", (d, w) -> toast("数据已还原, 重启应用即生效"))
                                .show();
                    } else {
                        toast("数据已导入并还原; 分享包内无 APK, 重启应用即生效");
                    }
                });
            } catch (Exception e) {
                main.post(() -> toast("导入失败: " + e.getMessage()));
            }
        }).start();
    }

    // zip 工具
    private void zipFile(java.util.zip.ZipOutputStream zos, File f, String entryName) throws Exception {
        zos.putNextEntry(new java.util.zip.ZipEntry(entryName));
        try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) { byte[] b = new byte[8192]; int r; while ((r = fis.read(b)) > 0) zos.write(b, 0, r); }
        zos.closeEntry();
    }
    private void zipBytes(java.util.zip.ZipOutputStream zos, String entryName, byte[] data) throws Exception {
        zos.putNextEntry(new java.util.zip.ZipEntry(entryName)); zos.write(data); zos.closeEntry();
    }
    private void zipDir(java.util.zip.ZipOutputStream zos, File dir, String base, File exclude) throws Exception {
        File[] kids = dir.listFiles(); if (kids == null) return;
        for (File k : kids) {
            if (exclude != null && k.getAbsolutePath().equals(exclude.getAbsolutePath())) continue;
            String entry = base + "/" + k.getName();
            if (k.isDirectory()) zipDir(zos, k, entry, exclude);
            else zipFile(zos, k, entry);
        }
    }
    private String appVersionName() { try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; } }

    /** 公网中继 (RelayService.nativeInvoke) 落到 default 时, 把「值返回型」原生方法委派到本体真桥,
     *  让经 GitHub Pages / route-C 打开的归一网页与手机 APK 1:1 取到同一权威源 (版本/用户脚本/取数指引/GM 存储)。
     *  纯设备/原生UI 动作仍由 RelayService 自身的安全默认拦截, 不在此暴露。
     *  注意: 含 httpGetText 的方法 (usInstall/usCheckUpdate) 仅可在非主线程调用; RelayService 工作线程满足。 */
    public Object relayNativeInvoke(String m, org.json.JSONArray a) {
        if (m == null) return null;
        Bridge nb = new Bridge(null);
        UserScriptBridge ub = new UserScriptBridge(null);
        try {
            switch (m) {
                case "appVer": return nb.appVer();
                // ── 用户脚本板块 (userscripts.html) ──
                case "usList": return nb.usList();
                case "usGetSource": return nb.usGetSource(rniStr(a, 0));
                case "usSaveCode": return nb.usSaveCode(rniStr(a, 0));
                case "usInstall": return nb.usInstall(rniStr(a, 0));
                case "usDelete": nb.usDelete(rniStr(a, 0)); return null;
                case "usToggle": nb.usToggle(rniStr(a, 0), rniBool(a, 1)); return null;
                case "usToggleMany": nb.usToggleMany(rniStr(a, 0), rniBool(a, 1)); return null;
                case "usDeleteMany": nb.usDeleteMany(rniStr(a, 0)); return null;
                case "usExportAll": return nb.usExportAll();
                case "usImport": return nb.usImport(rniStr(a, 0));
                case "usCheckUpdate": return nb.usCheckUpdate(rniStr(a, 0));
                // ── 油猴 GM_* 跨页存储 ──
                case "gmGet": return ub.gmGet(rniStr(a, 0), rniStr(a, 1));
                case "gmSet": ub.gmSet(rniStr(a, 0), rniStr(a, 1), rniStr(a, 2)); return null;
                case "gmDel": ub.gmDel(rniStr(a, 0), rniStr(a, 1)); return null;
                case "gmList": return ub.gmList(rniStr(a, 0));
                // ── daopan 下载包内「取数指引.md」 ──
                case "accessGuideMd": return nb.accessGuideMd(rniStr(a, 0), rniStr(a, 1), rniStr(a, 2));
                default: return null;
            }
        } catch (Throwable t) { return null; }
    }
    private static String rniStr(org.json.JSONArray a, int i) { return a != null && i < a.length() ? a.optString(i, "") : ""; }
    private static boolean rniBool(org.json.JSONArray a, int i) { return a != null && i < a.length() && a.optBoolean(i, false); }
    private int appVersionCode() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    // ── 标签会话持久化 (重开恢复上次标签/登录状态) ──────────────────────────
    /** 标签 URL 是否可在重启后还原: 排除空 / about:blank / data: 以及生成式内部列表页的裸基址 file:///android_asset/
     *  (书签/历史/MD 导出页经 loadDataWithBaseURL 渲染, 无具体文件, 重载会 ERR_FILE_NOT_FOUND → 不持久化, 用户从菜单重新打开)。 */
    private boolean isPersistableTabUrl(String u) {
        if (u == null) return false;
        String s = u.trim();
        if (s.isEmpty() || s.equals("about:blank")) return false;
        if (s.startsWith("data:")) return false;
        if (s.equals("file:///android_asset/") || s.equals("file:///android_asset")) return false;
        return true;
    }

    /** 防抖落盘: 合并 SPA 路由切换/翻页产生的密集调用, ~350ms 后只写一次 (热路径用此, 避免主线程频繁 I/O)。 */
    private void scheduleSaveTabs() {
        main.removeCallbacks(saveTabsTask);
        main.postDelayed(saveTabsTask, 350);
    }
    /** 立即落盘 (关标签/退到后台等关键时刻): 先取消待执行的防抖任务, 再同步序列化。 */
    private void saveTabs() {
        main.removeCallbacks(saveTabsTask);
        saveTabsNow();
    }
    private void saveTabsNow() {
        try {
            // 序列化读 tabs/displayUrl → 必须主线程 (快); 真正的外存写盘交后台单线程, 不卡 UI。
            org.json.JSONArray arr = new org.json.JSONArray();
            int savedActive = 0;
            for (int i = 0; i < tabs.size(); i++) {
                Tab t = tabs.get(i);
                String u = displayUrl(t);
                if (!isPersistableTabUrl(u)) continue;   // 跳过生成式/瞬态内部页, 重启无法还原
                if (i == active) savedActive = arr.length();
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("url", u);
                if (t.accountJson != null) o.put("account", t.accountJson);
                o.put("title", t.title);
                if (t.titleOverride != null) o.put("titleOverride", t.titleOverride);
                arr.put(o);
            }
            final String tabsJson = arr.toString();
            final int fActive = savedActive;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("tabs", tabsJson).putInt("active", fActive).apply();   // apply() 已异步
            org.json.JSONObject vault = new org.json.JSONObject();
            vault.put("tabs", new org.json.JSONArray(tabsJson)); vault.put("active", fActive);
            final String vaultJson = vault.toString();
            ioExec.execute(() -> vaultWrite("tabs", vaultJson));   // 外存写盘移出主线程
        } catch (Exception ignored) {}
    }

    private boolean restoreTabs() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String json = sp.getString("tabs", null);
            int act;
            if (json == null || json.isEmpty()) {
                // 卸载/重装后 SharedPreferences 为空 → 从共享文件夹回读
                String vault = vaultRead("tabs");
                if (vault == null || vault.isEmpty()) return false;
                org.json.JSONObject vo = new org.json.JSONObject(vault);
                json = vo.optString("tabs", "");
                act = vo.optInt("active", 0);
            } else {
                act = sp.getInt("active", 0);
            }
            if (json.isEmpty()) return false;
            org.json.JSONArray arr = new org.json.JSONArray(json);
            if (arr.length() == 0) return false;
            int created = 0, activeTab = -1;
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject o = arr.getJSONObject(i);
                String url = o.optString("url", SWITCH);
                if (!isPersistableTabUrl(url)) continue;   // 跳过历史遗留的不可还原条目(裸 file:///android_asset/ 等)
                String acc = o.has("account") ? o.getString("account") : null;
                boolean isActive = (created == act);
                boolean http = url.startsWith("http://") || url.startsWith("https://");
                Tab nt;
                if (!isActive && acc == null && http) {
                    // 普通网页·后台标签: 懒加载 — 建好 WebView 但暂不 loadUrl, 选中时才载。
                    // 冷启动不再让 N 个页面同时网络加载+跑 JS → 启动快、整体跟手 (一次只载一个)。
                    // 仅限 http(s); 内部 file:// 页(脚本管理等)需 internal=true 的原生桥, 照常即时加载。
                    nt = makeTab(acc, false);
                    nt.url = url;
                    nt.title = o.optString("title", "");
                    nt.pendingReloadUrl = url;            // selectTab 命中即载
                } else {
                    // 活动标签 + Devin 账号标签(多实例需后台保活追踪): 即时加载, 不抢前台。
                    nt = newTabBackground(url, acc);
                }
                if (o.has("titleOverride")) { nt.titleOverride = o.optString("titleOverride", null); }
                if (isActive) activeTab = tabs.size() - 1;
                created++;
            }
            if (created == 0) return false;
            selectTab(activeTab >= 0 ? activeTab : 0);
            return true;
        } catch (Exception e) { return false; }
    }

    // ── 浏览历史 (排除内部功能页) ─────────────────────────────────────────────
    private void addHistory(String url, String title) { addHistory(url, title, null); }
    /** 多实例 Devin 账号网页单独记到 history_devin (命名=对话名+账号编号+账号), 其余走常规 history。 */
    private void addHistory(String url, String title, Tab tab) {
        if (url == null) return;
        // 排除内部功能页
        if (url.startsWith("file:") || url.startsWith("about:") || url.startsWith("data:")
                || url.startsWith("rtflow:") || url.startsWith("javascript:") || url.startsWith("blob:")) return;
        boolean devin = tab != null && tab.accountJson != null && url.contains("devin.ai");
        String key = devin ? "history_devin" : "history";
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString(key, "[]"));
            org.json.JSONObject entry = new org.json.JSONObject();
            entry.put("url", url);
            entry.put("title", devin ? devinHistName(tab) : (title == null ? "" : title));
            entry.put("ts", System.currentTimeMillis());
            if (devin) entry.put("account", tab.accountJson);   // 重新点击时用此账号注入鉴权重开
            // 去重最近同 URL
            for (int i = arr.length() - 1; i >= 0; i--) {
                if (url.equals(arr.optJSONObject(i) != null ? arr.getJSONObject(i).optString("url") : "")) {
                    arr.remove(i); break;
                }
            }
            arr.put(entry);
            while (arr.length() > 200) arr.remove(0);
            sp.edit().putString(key, arr.toString()).apply();
            vaultWrite(key, arr.toString());
        } catch (Exception ignored) {}
    }
    /** 标题异步到达(含 301/302 跳转)时回填最近一条同 URL 的常规历史标题,
     *  修正"网页历史记成上一页标题"。仅改常规 history(history_devin 用账号命名, 不受影响)。 */
    private void updateHistoryTitle(String url, String title) {
        if (url == null || title == null || title.isEmpty()) return;
        if (url.startsWith("file:") || url.startsWith("about:") || url.startsWith("data:")
                || url.startsWith("rtflow:") || url.startsWith("javascript:") || url.startsWith("blob:")) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("history", "[]"));
            for (int i = arr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = arr.optJSONObject(i);
                if (e == null) continue;
                if (sameUrl(url, e.optString("url"))) {
                    if (!title.equals(e.optString("title"))) {
                        e.put("title", title);
                        sp.edit().putString("history", arr.toString()).apply();
                        vaultWrite("history", arr.toString());
                    }
                    return;
                }
            }
        } catch (Exception ignored) {}
    }
    /** URL 等价判定(忽略末尾斜杠差异, 兼容 getUrl()/getOriginalUrl() 的规范化)。 */
    private static boolean sameUrl(String a, String b) {
        if (a == null || b == null) return false;
        if (a.equals(b)) return true;
        return stripTrailingSlash(a).equals(stripTrailingSlash(b));
    }
    private static String stripTrailingSlash(String u) {
        return (u.length() > 1 && u.endsWith("/")) ? u.substring(0, u.length() - 1) : u;
    }
    /** 多实例登录历史命名: 对话名 + #账号编号 + 账号邮箱。 */
    private String devinHistName(Tab t) {
        String conv = chipTitle(t), email = "", no = "";
        try {
            JSONObject a = new JSONObject(t.accountJson);
            email = a.optString("email", a.optString("id", ""));
            int n = a.optInt("no", 0); if (n > 0) no = "#" + n;
        } catch (Exception ignored) {}
        StringBuilder sb = new StringBuilder();
        if (conv != null && !conv.isEmpty()) sb.append(conv);
        if (!no.isEmpty()) { if (sb.length() > 0) sb.append(" "); sb.append(no); }
        if (!email.isEmpty()) { if (sb.length() > 0) sb.append(" · "); sb.append(email); }
        return sb.length() == 0 ? url(t) : sb.toString();
    }
    private String url(Tab t) { return t.url == null ? "" : t.url; }

    private void showHistory() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String rawD = sp.getString("history_devin", "[]");
            if (rawD == null || rawD.isEmpty() || "[]".equals(rawD)) { String v = vaultRead("history_devin"); if (v != null && !v.isEmpty()) rawD = v; }
            String raw = sp.getString("history", "[]");
            if (raw == null || raw.isEmpty() || "[]".equals(raw)) { String v = vaultRead("history"); if (v != null && !v.isEmpty()) raw = v; }
            org.json.JSONArray devinArr = new org.json.JSONArray(rawD);
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            org.json.JSONArray dv = new org.json.JSONArray(), nm = new org.json.JSONArray();
            for (int i = devinArr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = devinArr.getJSONObject(i);
                dv.put(new org.json.JSONObject().put("url", e.optString("url", "")).put("title", e.optString("title", "")).put("account", e.optString("account", "")).put("devin", true));
            }
            for (int i = arr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = arr.getJSONObject(i);
                nm.put(new org.json.JSONObject().put("url", e.optString("url", "")).put("title", e.optString("title", "")).put("devin", false));
            }
            openBrowserListTab("浏览历史", "⚡ 多实例 Devin 登录历史", dv, "暂无多实例登录记录",
                    "🌐 常规网页浏览历史", nm, "暂无常规浏览历史", "hist");
        } catch (Exception e) { toast("历史加载失败"); }
    }

    /** 浏览器式列表页 (历史/书签共用): 点击打开(多实例注入), 长按或 ⋮ → 在新标签打开/复制链接/分享/删除。 */
    private void openBrowserListTab(String h2, String dvHeader, org.json.JSONArray dvItems, String dvEmpty,
                                    String nmHeader, org.json.JSONArray nmItems, String nmEmpty, String mode) {
        try {
            org.json.JSONArray IT = new org.json.JSONArray();
            StringBuilder sb = new StringBuilder();
            sb.append("<html><head><meta name=viewport content='width=device-width,initial-scale=1'><style>");
            sb.append("body{background:#0e1116;color:#cdd3de;font:13px -apple-system,sans-serif;margin:0;padding:12px 12px 40px}");
            sb.append("h2{color:#9cdcfe;margin:8px 0 8px}");
            sb.append(".sec{color:#7ee787;font-size:13px;font-weight:600;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid #21262d}");
            sb.append(".sec.b{color:#9cdcfe}");
            sb.append(".it{display:flex;align-items:center;border-bottom:1px solid #21262d;-webkit-user-select:none;user-select:none}");
            sb.append(".it.dv{border-left:3px solid #2ea043}");
            sb.append(".it .row{flex:1;min-width:0;padding:9px 8px}");
            sb.append(".it .row:active{background:#1f3a45}");
            sb.append(".it .t{color:#e6edf3;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".it .u{color:#8b949e;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".more{padding:10px 12px;color:#8b949e;font-size:18px;user-select:none}.more:active{color:#fff}");
            // 多选 (对标手机浏览器): 顶部工具条 + 行内圆形勾选 + 底部批量动作条
            sb.append(".bar{display:flex;gap:8px;margin:2px 0 6px;flex-wrap:wrap}");
            sb.append(".bar button{background:#161b22;color:#cdd3de;border:1px solid #30363d;border-radius:6px;padding:7px 13px;font-size:13px}.bar button:active{background:#1f6feb33}");
            sb.append(".ck{width:20px;height:20px;border:2px solid #6e7681;border-radius:50%;margin:0 2px 0 6px;flex:none;display:none;position:relative}");
            sb.append("body.sel .ck{display:block}body.sel .more{display:none}");
            sb.append(".it.on{background:#15324a}.it.on .ck{border-color:#1f6feb;background:#1f6feb}");
            sb.append(".it.on .ck:after{content:'';position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}");
            sb.append(".selbar{position:fixed;left:0;right:0;top:0;background:#161b22;border-bottom:1px solid #30363d;display:none;align-items:center;gap:4px;padding:9px 8px;z-index:60}");
            sb.append("body.sel .selbar{display:flex}body.sel{padding-top:52px}");
            sb.append(".selbar .sx{padding:4px 10px;color:#e6edf3;font-size:19px}.selbar .cnt{color:#9cdcfe;font-size:13px;flex:1}");
            sb.append(".selbar .all{padding:7px 12px;color:#cdd3de;font-size:13px;border:1px solid #30363d;border-radius:6px}.selbar .all:active{background:#1f6feb33}");
            sb.append(".actbar{position:fixed;left:0;right:0;bottom:0;background:#161b22;border-top:1px solid #30363d;display:none;z-index:60;padding-bottom:env(safe-area-inset-bottom)}");
            sb.append("body.sel .actbar{display:flex}.actbar .sb{flex:1;text-align:center;color:#e6edf3;font-size:12px;padding:13px 2px}.actbar .sb:active{background:#1f6feb33}.actbar .sb.del{color:#ff7b72}");
            sb.append(".ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:flex-end;z-index:99}");
            sb.append(".ov.on{display:flex}");
            sb.append(".sheet{background:#161b22;width:100%;border-radius:14px 14px 0 0;padding:4px 0 calc(10px + env(safe-area-inset-bottom));box-shadow:0 -4px 20px rgba(0,0,0,.5)}");
            sb.append(".sh-u{color:#8b949e;font-size:12px;padding:12px 16px 10px;border-bottom:1px solid #21262d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".sh-b{padding:14px 16px;color:#e6edf3;font-size:15px}.sh-b:active{background:#1f6feb33}.sh-b.del{color:#ff7b72}");
            sb.append("</style></head><body>");
            sb.append("<div class='selbar'><span class='sx' id='selX'>\u2715</span><span class='cnt' id='cnt'>0 \u9009\u4e2d</span><span class='all' id='selAll'>\u5168\u9009</span></div>");
            sb.append("<h2>").append(escapeHtml(h2)).append("</h2>");
            sb.append("<div class='bar'><button id='btnSel'>\u591a\u9009</button>");
            if (!"bm".equals(mode)) sb.append("<button id='btnClear'>\u6e05\u7a7a\u5386\u53f2</button>");
            sb.append("</div>");
            if (dvHeader != null) {
                sb.append("<div class='sec'>").append(dvHeader).append("</div>");
                for (int i = 0; i < dvItems.length(); i++) { int idx = IT.length(); IT.put(dvItems.getJSONObject(i)); appendRow(sb, dvItems.getJSONObject(i), idx, true); }
                if (dvItems.length() == 0) sb.append("<div style='color:#6e7681;padding:10px 4px'>").append(escapeHtml(dvEmpty)).append("</div>");
            }
            sb.append("<div class='sec b'>").append(nmHeader).append("</div>");
            for (int i = 0; i < nmItems.length(); i++) { int idx = IT.length(); IT.put(nmItems.getJSONObject(i)); appendRow(sb, nmItems.getJSONObject(i), idx, false); }
            if (nmItems.length() == 0) sb.append("<div style='color:#6e7681;padding:10px 4px'>").append(escapeHtml(nmEmpty)).append("</div>");
            sb.append("<div class='actbar'>");
            sb.append("<span class='sb' data-act='open'>\u6253\u5f00</span><span class='sb' data-act='copy'>\u590d\u5236</span><span class='sb' data-act='share'>\u5206\u4eab</span>");
            if (!"bm".equals(mode)) sb.append("<span class='sb' data-act='bm'>\u6536\u85cf</span>");
            sb.append("<span class='sb' data-act='dl'>\u4e0b\u8f7d</span><span class='sb del' data-act='del'>\u5220\u9664</span></div>");
            sb.append("<div class='ov' id='ov'><div class='sheet' id='sheet'></div></div>");
            sb.append("<script>var IT=").append(jsEmbed(IT)).append(";var MODE='").append(mode).append("';");
            sb.append("function openIdx(i){var e=IT[i];if(!e)return;if(e.devin&&e.account){try{Native.reopenAccount(e.account,e.url);return;}catch(x){}}location.href=e.url;}");
            sb.append("function closeSheet(){document.getElementById('ov').classList.remove('on');}");
            sb.append("function rmRow(i){var el=document.querySelector(\".it[data-i='\"+i+\"']\");if(el&&el.parentNode)el.parentNode.removeChild(el);}");
            sb.append("function sheet(i){var e=IT[i];if(!e)return;var s=document.getElementById('sheet');");
            sb.append("var h=\"<div class='sh-u'>\"+((e.title||e.url)+'').replace(/</g,'&lt;')+\"</div>\";");
            sb.append("h+=\"<div class='sh-b' data-a='open' data-i='\"+i+\"'>在新标签打开</div>\";");
            sb.append("h+=\"<div class='sh-b' data-a='copy' data-i='\"+i+\"'>复制链接</div>\";");
            sb.append("h+=\"<div class='sh-b' data-a='share' data-i='\"+i+\"'>分享</div>\";");
            sb.append("h+=\"<div class='sh-b del' data-a='del' data-i='\"+i+\"'>删除</div>\";");
            sb.append("s.innerHTML=h;document.getElementById('ov').classList.add('on');}");
            sb.append("document.getElementById('ov').addEventListener('click',function(ev){var b=ev.target.closest&&ev.target.closest('.sh-b');if(!b){if(ev.target.id==='ov')closeSheet();return;}var a=b.getAttribute('data-a'),i=+b.getAttribute('data-i'),e=IT[i];closeSheet();if(!e)return;");
            sb.append("if(a==='open'){try{Native.openEntryNewTab(e.account||'',e.url||'');}catch(x){}}");
            sb.append("else if(a==='copy'){try{Native.clip(e.url||'');Native.toast('已复制链接');}catch(x){}}");
            sb.append("else if(a==='share'){try{Native.share(e.url||'');}catch(x){}}");
            sb.append("else if(a==='del'){try{if(MODE==='bm')Native.deleteBookmarkUrl(e.url||'');else Native.deleteHistoryUrl(e.url||'',!!e.devin);}catch(x){}rmRow(i);Native&&Native.toast&&Native.toast('已删除');}});");
            // ── 多选 (对标手机浏览器): 长按进入选择 → 勾选 → 底部批量动作 ──
            sb.append("var SEL={},selMode=false,SWALLOW=false;");
            sb.append("function selCount(){return Object.keys(SEL).length;}");
            sb.append("function rowEl(i){return document.querySelector(\".it[data-i='\"+i+\"']\");}");
            sb.append("function setRow(i,on){var el=rowEl(i);if(!el)return;if(on){SEL[i]=1;el.classList.add('on');}else{delete SEL[i];el.classList.remove('on');}}");
            sb.append("function updBar(){var c=document.getElementById('cnt');if(c)c.textContent=selCount()+' \u9009\u4e2d';}");
            sb.append("function enterSel(i){selMode=true;document.body.classList.add('sel');if(i!=null)setRow(i,true);updBar();try{Native.vibrate(18);}catch(x){}}");
            sb.append("function exitSel(){selMode=false;document.body.classList.remove('sel');for(var k in SEL)setRow(k,false);SEL={};}");
            sb.append("function toggleRow(i){if(SEL[i])setRow(i,false);else setRow(i,true);updBar();if(selCount()===0)exitSel();}");
            sb.append("function selAll(){var all=document.querySelectorAll('.it'),every=true;all.forEach(function(el){if(!SEL[el.getAttribute('data-i')])every=false;});all.forEach(function(el){setRow(el.getAttribute('data-i'),!every);});updBar();if(selCount()===0)exitSel();}");
            sb.append("function selItems(){var o=[];for(var k in SEL){var e=IT[k];if(e)o.push(e);}return o;}");
            sb.append("function doAct(a){var its=selItems();if(!its.length){exitSel();return;}var urls=its.map(function(e){return e.url||'';}).filter(Boolean);");
            sb.append("if(a==='open'){its.forEach(function(e){try{Native.openEntryBg(e.account||'',e.url||'');}catch(x){}});try{Native.toast('\u5df2\u540e\u53f0\u6253\u5f00 '+urls.length+' \u4e2a');}catch(x){}exitSel();}");
            sb.append("else if(a==='copy'){try{Native.clip(urls.join('\\n'));Native.toast('\u5df2\u590d\u5236 '+urls.length+' \u6761');}catch(x){}exitSel();}");
            sb.append("else if(a==='share'){try{Native.share(urls.join('\\n'));}catch(x){}exitSel();}");
            sb.append("else if(a==='bm'){var arr=its.map(function(e){return {url:e.url||'',title:e.title||'',account:e.account||'',devin:!!e.devin};});var n=0;try{n=Native.bookmarkUrls(JSON.stringify(arr));}catch(x){}try{Native.toast(n>0?('\u5df2\u6536\u85cf '+n+' \u6761'):'\u5747\u5df2\u6536\u85cf\u8fc7');}catch(x){}exitSel();}");
            sb.append("else if(a==='dl'){var hs=urls.filter(function(u){return u.indexOf('http')===0;});try{Native.downloadUrls(JSON.stringify(hs));Native.toast('\u5f00\u59cb\u4e0b\u8f7d '+hs.length+' \u4e2a');}catch(x){}exitSel();}");
            sb.append("else if(a==='del'){var ix=Object.keys(SEL).slice();if(MODE==='bm'){try{Native.deleteBookmarkUrls(JSON.stringify(urls));}catch(x){}}else{var dv=[],nm=[];its.forEach(function(e){(e.devin?dv:nm).push(e.url||'');});try{if(dv.length)Native.deleteHistoryUrls(JSON.stringify(dv),true);if(nm.length)Native.deleteHistoryUrls(JSON.stringify(nm),false);}catch(x){}}ix.forEach(function(i){IT[i]=null;rmRow(i);});try{Native.toast('\u5df2\u5220\u9664 '+ix.length+' \u6761');}catch(x){}exitSel();}}");
            sb.append("document.getElementById('selX').onclick=exitSel;document.getElementById('selAll').onclick=selAll;");
            sb.append("var bs=document.getElementById('btnSel');if(bs)bs.onclick=function(){if(selMode)exitSel();else enterSel(null);};");
            sb.append("var bc=document.getElementById('btnClear');if(bc)bc.onclick=function(){if(!confirm('\u6e05\u7a7a\u5168\u90e8\u6d4f\u89c8\u5386\u53f2\uff1f'))return;try{Native.clearHistory();}catch(x){}document.querySelectorAll('.it').forEach(function(el){el.parentNode&&el.parentNode.removeChild(el);});exitSel();try{Native.toast('\u5386\u53f2\u5df2\u6e05\u7a7a');}catch(x){}};");
            sb.append("document.querySelector('.actbar').addEventListener('click',function(ev){var b=ev.target.closest&&ev.target.closest('.sb');if(b)doAct(b.getAttribute('data-act'));});");
            // 行: 点击打开/选择; 长按 → 选择模式(已在选择模式则弹单项菜单)
            sb.append("var LT;document.addEventListener('touchstart',function(ev){var r=ev.target.closest&&ev.target.closest('.it');if(!r)return;var i=+r.getAttribute('data-i');LT=setTimeout(function(){LT=0;SWALLOW=true;if(selMode){sheet(i);}else{enterSel(i);}},460);},{passive:true});");
            sb.append("document.addEventListener('touchend',function(ev){if(LT){clearTimeout(LT);LT=0;}},{passive:true});");
            sb.append("document.addEventListener('touchmove',function(ev){if(LT){clearTimeout(LT);LT=0;}},{passive:true});");
            sb.append("document.addEventListener('click',function(ev){if(SWALLOW){SWALLOW=false;ev.preventDefault();ev.stopPropagation();return;}var m=ev.target.closest&&ev.target.closest('.more');if(m&&!selMode){ev.stopPropagation();sheet(+m.getAttribute('data-i'));return;}var r=ev.target.closest&&ev.target.closest('.it');if(!r)return;var i=+r.getAttribute('data-i');if(selMode){toggleRow(i);}else{if(ev.target.closest('.row'))openIdx(i);}});");
            sb.append("</scr"+"ipt></body></html>");
            Tab bt = makeTab(null, true);   // internal=true → Native 桥可用
            selectTab(tabs.size() - 1);
            bt.title = h2;
            bt.web.loadDataWithBaseURL("file:///android_asset/", sb.toString(), "text/html", "utf-8", null);
        } catch (Exception e) { toast("加载失败"); }
    }
    private void appendRow(StringBuilder sb, org.json.JSONObject e, int idx, boolean devin) {
        String u = escapeHtml(e.optString("url", "")), t = escapeHtml(e.optString("title", ""));
        sb.append("<div class='it").append(devin ? " dv" : "").append("' data-i='").append(idx).append("'>");
        sb.append("<div class='ck'></div>");
        sb.append("<div class='row'><div class='t'>").append(t.isEmpty() ? u : t).append("</div>");
        sb.append("<div class='u'>").append(u).append("</div></div>");
        sb.append("<div class='more' data-i='").append(idx).append("'>\u22EE</div></div>");
    }

    // ── 书签收藏 ──────────────────────────────────────────────────────────
    private void addBookmark(String url, String title) { addBookmark(url, title, null); }
    private void addBookmark(String url, String title, Tab tab) {
        if (url == null || url.startsWith("rtflow:") || url.startsWith("file:") || url.startsWith("about:")) { toast("内部页不可收藏"); return; }
        boolean devin = tab != null && tab.accountJson != null && url.contains("devin.ai");
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("bookmarks", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                if (url.equals(arr.getJSONObject(i).optString("url"))) {
                    // 已存在: 若本次来自多实例标签而旧记录缺账号 → 升级补全(自愈旧版无注入的收藏, 修 404)
                    if (devin) {
                        org.json.JSONObject old = arr.getJSONObject(i);
                        old.put("devin", true); old.put("account", tab.accountJson);
                        if (title != null && !title.isEmpty()) old.put("title", title);
                        sp.edit().putString("bookmarks", arr.toString()).apply();
                        vaultWrite("bookmarks", arr.toString());
                        toast("已更新收藏(已绑定账号)");
                    } else { toast("已收藏过"); }
                    return;
                }
            }
            org.json.JSONObject e = new org.json.JSONObject();
            e.put("url", url); e.put("title", title == null ? url : title); e.put("ts", System.currentTimeMillis());
            if (devin) { e.put("devin", true); e.put("account", tab.accountJson); }   // 多实例书签: 重开时注入鉴权
            arr.put(e);
            sp.edit().putString("bookmarks", arr.toString()).apply();
            vaultWrite("bookmarks", arr.toString());
            toast("已收藏");
        } catch (Exception ignored) { toast("收藏失败"); }
    }

    private void showBookmarks() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String raw = sp.getString("bookmarks", "[]");
            if (raw == null || raw.isEmpty() || "[]".equals(raw)) { String v = vaultRead("bookmarks"); if (v != null && !v.isEmpty()) raw = v; }
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            org.json.JSONArray dv = new org.json.JSONArray(), nm = new org.json.JSONArray();
            for (int i = arr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = arr.getJSONObject(i);
                boolean isDv = e.optBoolean("devin", false) && !e.optString("account", "").isEmpty();
                org.json.JSONObject o = new org.json.JSONObject().put("url", e.optString("url", "")).put("title", e.optString("title", ""));
                if (isDv) { o.put("account", e.optString("account", "")).put("devin", true); dv.put(o); }
                else { o.put("devin", false); nm.put(o); }
            }
            openBrowserListTab("书签收藏", "⚡ 多实例 Devin 收藏", dv, "暂无多实例收藏",
                    "🌐 网页收藏", nm, "暂无书签 — 点地址栏 ☆ 收藏本页", "bm");
        } catch (Exception e) { toast("书签加载失败"); }
    }

    private long bgSince = 0;   // 进入后台的时刻; onResume 据此判断是否需对可能被系统冻结的标签探活
    private static final long STALE_BG_MS = 45000;   // 后台超过此时长返回 → 可能被冻结, 触发探活
    private volatile boolean appForeground = false;   // App 是否在前台 (onResume↔onPause); 看门狗仅在前台介入
    private static final long VIS_WATCH_MS = 8000;    // 前台可见性看门狗周期
    private final Runnable visWatchdog = new Runnable() {
        @Override public void run() {
            if (!appForeground) return;
            // 前台期间: 当前可见网页若 visibilityState 卡 hidden(计时器被冻、点下载等失效), resumeWeb 会静默拉回, 无需手动刷新。
            Tab t = cur();
            if (t != null && t.web != null && !t.internal) { resumeWeb(t.web); recordEditable(t); }
            main.postDelayed(this, VIS_WATCH_MS);
        }
    };

    // ── 前台内存保洁: 根治「软件用久了/后台跑久了就持久化卡顿, 唯有彻底关闭再开才流畅」──────────
    //   病根: WebView(Chromium) 多标签长时间运行, 各渲染进程堆与 RAM 缓存只增不减; 已有的 onTrimMemory
    //   回收路径只在「系统下发内存压力回调」时触发, 而大内存机型整段前台会话里系统几乎从不下发该回调 →
    //   占用单调爬升 → GC 抖动/合成卡顿越用越重, 只有杀进程重启才清零。这里不再坐等系统信号, 改为前台
    //   每 MEM_HYGIENE_MS 主动保洁一次 (与 onTrimMemory 同一温和手法, 仅作用于非活动后台标签, 绝不碰前台页):
    //     · 后台标签闲置>90s → clearCache(false)+freeMemory() 释放可回收的瞬时内存与 RAM 缓存;
    //     · 后台普通网页标签 (非账号·非内部页) 闲置>IDLE_UNLOAD_MS → 整页卸载换空壳, 选中时按 pendingReloadUrl
    //       原样重建 → 把堆占用真正还给系统, 长会话占用有界 → 用久了也不再越用越卡。
    private static final long MEM_HYGIENE_MS = 180000;   // 前台每 3 分钟保洁一轮
    private static final long MEM_TRIM_IDLE_MS = 90000;  // 后台标签闲置超 90s 才做轻量释放 (避免快速来回切换的标签被反复清缓存)
    private static final long IDLE_UNLOAD_MS = 900000;   // 后台普通网页标签闲置超 15 分钟 → 整页卸载 (选中即原样重建)
    private static final long ACCT_IDLE_UNLOAD_MS = 1800000; // 后台 Devin 账号标签闲置超 30 分钟(更金贵·阈值更宽) → 整页卸载, 选中即按原账号重注鉴权重建
    // ── 后台常驻重型 WebView「数量上限闸」(LRU 丢弃) · 根治积极使用时的「越用越卡」────────────────
    //   病根(前四轮收的是各类单调累积的「慢泄漏」, 这是另一维度的「快积压」): 闲置卸载只在标签闲到 15/30 分钟
    //   才触发; 而用户积极使用时不停在多个账号/网页标签间来回切, 谁都到不了闲置阈值 → 全部 account/网页标签
    //   常驻为重型 Devin SPA(各自一份 V8 堆+合成层+定时器), acctLive 随「开了多少标签」线性无界增长 → 多张重页
    //   争抢同一渲染线程与内存 → GC 抖动/合成卡顿越用越重, 唯杀进程才清零。个别泄漏可以逐个堵, 但「并发重页
    //   总数」本身才是主成本; 仿移动版 Chrome 的后台标签丢弃: 给后台常驻重型 WebView 数量「硬上限」, 超了就按
    //   最久未访问优先整页卸载换空壳(选中即原样/按原账号重注鉴权重建) → 不论开多少标签, 并发重页恒有界 →
    //   从结构上消除这一维度的累积(对「到底哪个计数在涨」鲁棒)。护栏与闲置卸载一致(跳过 活动/内部/空壳·账号
    //   标签跳过被联控观看者), 且只动闲置超下方阈值的标签 → 正在来回切的工作集绝不被打断。
    private static final int  MAX_LIVE_BG_HEAVY = 5;       // 后台常驻重型 http(s) WebView 上限(不含活动标签)
    private static final long WEB_LRU_MIN_IDLE_MS = 90000;   // 普通网页标签: 闲置超 90s 才可因超限被丢弃(防来回切抖动)
    private static final long ACCT_LRU_MIN_IDLE_MS = 300000; // 账号标签更金贵: 闲置超 5 分钟才可因超限被丢弃(短于 30 分钟硬阈值, 多号积压时更早收敛)
    // ── 转后台后的「重度」内存保洁: 根治用户实测「即使超后台也没用·还是卡, 唯有放置几小时(等系统终于回收进程)才好」──
    //   病根延伸: 本应用常驻前台服务(RelayService)使进程长生不死 → 系统极少 LMK 整体回收 → 转后台时旧逻辑只
    //   pauseWeb(仅暂停渲染合成·不释放内存·不停 JS) 且把前台 memHygiene 取消, 后台遂「零回收」, 堆/缓存原样常驻;
    //   回前台自然还是卡, 只有进程被系统(几小时后)杀掉才清零。修法: 转后台 BG_HYGIENE_DELAY_MS 后起一轮重度释放并
    //   每 BG_HYGIENE_MS 续做 —— 全部标签(含原活动标签, 后台无任何标签可见)清 RAM 缓存+freeMemory, 闲置普通网页
    //   标签整页卸载 → 「把它扔后台」真的能把占用降下来, 回前台即顺。JS 不全局冻结 → 远程自动化(execJs)仍可驱动。
    private static final long BG_HYGIENE_DELAY_MS = 45000;   // 转后台 45s 后做首轮重度释放 (快速切回的不被无谓清理)
    private static final long BG_HYGIENE_MS = 120000;        // 此后后台每 2 分钟续做一轮 → 久置后台占用持续下降而非常驻
    private static final long ACTIVE_CACHE_BOUND_MS = 600000; // 前台活动标签每 ~10 分钟清一次 RAM 缓存 (无损·不重载·不丢态)
    private static final long HEAP_AGE_MS = 3 * 3600000L;        // 活动账号标签连续运行超 3 小时 → V8 堆已老化, 可在空闲时回收
    private static final long ACTIVE_RELOAD_IDLE_MS = 20 * 60000L; // 活动标签 20 分钟无任何交互(人已离开) 才允许堆回收重载
    private static final long HEAP_RECLAIM_MIN_GAP = 3 * 3600000L; // 两次活动标签堆回收重载最小间隔 (防抖)
    private long activeTabCacheTs = 0;
    private final Runnable memHygiene = new Runnable() {
        @Override public void run() {
            if (!appForeground) return;
            try { trimBackgroundTabs(); } catch (Exception ignored) {}
            main.postDelayed(this, MEM_HYGIENE_MS);
        }
    };
    private final Runnable bgHygiene = new Runnable() {
        @Override public void run() {
            if (appForeground) return;   // 已回前台 → 交还给前台 memHygiene
            try { trimAllTabsForBackground(); } catch (Exception ignored) {}
            main.postDelayed(this, BG_HYGIENE_MS);
        }
    };
    /** 转后台重度保洁: 无任何标签可见 → 对全部标签(含原活动标签)清 RAM 缓存+freeMemory; 再把闲置的
     *  非活动·非账号·非内部 http(s) 网页标签整页卸载(选中即原样重建)。是「扔后台即能缓解卡顿」的关键。 */
    private void trimAllTabsForBackground() {
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            if (t.web == null || t.pendingReloadUrl != null) continue;
            try { t.web.clearCache(false); } catch (Exception ignored) {}
            try { t.web.freeMemory(); } catch (Exception ignored) {}
        }
        long bgNow = System.currentTimeMillis();
        for (int i = tabs.size() - 1; i >= 0; i--) {
            Tab t = tabs.get(i);
            if (t.pendingReloadUrl != null) continue;
            unloadBackgroundTab(i);   // 内部已只对 非活动·非账号·非内部·http(s) 生效
            // 闲置足够久的后台 Devin 账号标签也整页卸载 → 后台占用真正下降(不只清缓存), 治「扔后台也没用」。
            if (t.accountJson != null && t.lastShownAt > 0 && (bgNow - t.lastShownAt) > ACCT_IDLE_UNLOAD_MS)
                unloadIdleAccountTab(i);
        }
        enforceLiveTabCap(bgNow);   // 后台亦施数量上限闸: 多号积压时不必等 30 分钟硬阈值即收敛到上限内
        pruneViewers(bgNow);
        pruneAccountMaps();
        releaseMirrorBufIfIdle();   // 转后台久无联控 → 释放 ~10MB 镜像复用缓冲
        logFootprint("bg");
    }
    /** 前台主动内存保洁 (只动非活动后台标签)。轻量释放普遍适用; 长时间未访问的普通网页标签整页卸载以真正回收堆。 */
    private void trimBackgroundTabs() {
        long now = System.currentTimeMillis();
        for (int i = 0; i < tabs.size(); i++) {
            if (i == active) continue;
            Tab t = tabs.get(i);
            if (t.web == null || t.pendingReloadUrl != null) continue;       // 已卸载为空壳的标签无需再清
            if (t.lastShownAt > 0 && (now - t.lastShownAt) < MEM_TRIM_IDLE_MS) continue; // 刚切走的标签先放过, 避免来回切换抖动
            try { t.web.clearCache(false); } catch (Exception ignored) {}
            try { t.web.freeMemory(); } catch (Exception ignored) {}
        }
        // 长时间未访问的后台普通网页标签 → 整页卸载 (unloadBackgroundTab 内部已只对 非账号·非内部页·http(s) 生效)。
        for (int i = tabs.size() - 1; i >= 0; i--) {
            if (i == active) continue;
            Tab t = tabs.get(i);
            if (t.pendingReloadUrl != null) continue;
            if (t.lastShownAt > 0 && (now - t.lastShownAt) > IDLE_UNLOAD_MS) unloadBackgroundTab(i);
            // 长时间未访问的后台 Devin 账号标签整页卸载(无人联控时) → 真正回收其 V8 堆/DOM, 根治账号标签侧「越用越卡」。
            else if (t.accountJson != null && t.lastShownAt > 0 && (now - t.lastShownAt) > ACCT_IDLE_UNLOAD_MS) unloadIdleAccountTab(i);
        }
        // 活动标签长会话 RAM 缓存有界化: 旧逻辑前台保洁绝不碰活动标签 → 久居同一板块(如切号板持续轮询额度)
        //   其 RAM 缓存只增不减, 是「用久了越用越卡」在前台的另一来源。这里仅清 RAM 缓存(clearCache(false) 不含磁盘)
        //   并 freeMemory → 不重载·不丢滚动/表单; 用户正打字/语音/触摸时跳过, 避免资源重取造成的细微卡顿打断交互。
        Tab at = cur();
        if (at != null && at.web != null && at.pendingReloadUrl == null
                && (now - activeTabCacheTs) > ACTIVE_CACHE_BOUND_MS
                && !userInteracting(at, VIS_WATCH_MS)) {
            try { at.web.clearCache(false); } catch (Exception ignored) {}
            try { at.web.freeMemory(); } catch (Exception ignored) {}
            activeTabCacheTs = now;
        }
        // 活动标签长会话 V8 堆/DOM 回收: clearCache 清不动 Devin SPA 自身的 V8 堆/游离 DOM —— 同一会话连开数小时
        //   堆只增不减, 是「用久越卡」在前台最后一个、也是唯一只能靠重载真回收的根。极保守护栏(与 probeTabLiveness
        //   同一「不打断」准则·更严): 仅当 ①活动标签是 Devin 账号重型 SPA; ②本页已连续运行 HEAP_AGE_MS 未整页加载
        //   → 堆确已老化; ③用户已 ACTIVE_RELOAD_IDLE_MS 无任何交互(打字/语音/触摸) → 人已离开不在用; ④App 在前台;
        //   ⑤无联控观看; ⑥距上次回收 > HEAP_RECLAIM_MIN_GAP。命中即 reload() → 堆/DOM 归零重建(Devin 经 URL 恢复
        //   会话·document-start 重注鉴权), 长会话占用真有界。有联控/有输入焦点/人在交互 → 绝不重载, 不丢草稿不打断。
        if (at != null && at.web != null && at.pendingReloadUrl == null && at.accountJson != null && appForeground
                && at.loadedAt > 0 && (now - at.loadedAt) > HEAP_AGE_MS
                && !userInteracting(at, ACTIVE_RELOAD_IDLE_MS)
                && (at.lastHeapReclaimAt == 0 || (now - at.lastHeapReclaimAt) > HEAP_RECLAIM_MIN_GAP)) {
            java.util.concurrent.ConcurrentHashMap<String,Long> vw = tabViewers.get(at.vid);
            if (vw == null || vw.isEmpty()) {   // 正被联控观看/驱动 → 不重载(不打断远程实时操作)
                at.lastHeapReclaimAt = now;
                android.util.Log.i(FL, "active-tab heap reclaim: long-lived idle Devin SPA -> silent reload to reclaim V8 heap");
                try { at.web.reload(); } catch (Exception ignored) {}
            }
        }
        enforceLiveTabCap(now);   // 数量上限闸: 即便都没到闲置卸载阈值, 也把后台常驻重型 WebView 压到上限内
        pruneViewers(now);
        pruneAccountMaps();
        releaseMirrorBufIfIdle();   // 久无联控 → 释放 ~10MB 镜像复用缓冲
        logFootprint("fg");
    }

    /** 后台常驻重型 WebView「数量上限闸」(LRU 丢弃)。把仍持活 WebView 的后台 http(s) 标签(账号+普通网页)总数
     *  压到 MAX_LIVE_BG_HEAVY 以内: 超限时按最久未访问(lastShownAt 升序)优先整页卸载换空壳, 选中即重建。
     *  护栏: 跳过 活动标签/内部板块页/已是空壳(pendingReloadUrl) 的; 账号标签若正被联控观看则不动; 且仅丢弃
     *  闲置超对应 LRU 阈值的标签 → 用户正来回切的工作集(刚访问过的)绝不被打断, 只收割真正积压的后台重页。 */
    private void enforceLiveTabCap(long now) {
        java.util.ArrayList<Integer> cand = new java.util.ArrayList<>();   // 可丢弃候选(已过 LRU 防抖窗)
        int live = 0;
        for (int i = 0; i < tabs.size(); i++) {
            if (i == active) continue;
            Tab t = tabs.get(i);
            if (t.web == null || t.internal || t.pendingReloadUrl != null) continue;
            String u = t.url;
            if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) continue;
            live++;   // 一张后台常驻重型 WebView
            long idle = (t.lastShownAt > 0) ? (now - t.lastShownAt) : Long.MAX_VALUE;
            if (t.accountJson != null) {
                if (idle < ACCT_LRU_MIN_IDLE_MS) continue;     // 刚用过的账号标签不动(防来回切抖动)
                java.util.concurrent.ConcurrentHashMap<String,Long> vw = tabViewers.get(t.vid);
                if (vw != null && !vw.isEmpty()) continue;     // 正被联控观看/驱动 → 不打断
            } else {
                if (idle < WEB_LRU_MIN_IDLE_MS) continue;      // 刚用过的网页标签不动
            }
            cand.add(i);
        }
        if (live <= MAX_LIVE_BG_HEAVY || cand.isEmpty()) return;
        java.util.Collections.sort(cand, (a, b) -> Long.compare(tabs.get(a).lastShownAt, tabs.get(b).lastShownAt)); // 最久未访问在前
        int toEvict = live - MAX_LIVE_BG_HEAVY;
        for (int k = 0; k < cand.size() && toEvict > 0; k++) {
            int idx = cand.get(k);
            if (tabs.get(idx).accountJson != null) unloadIdleAccountTab(idx); else unloadBackgroundTab(idx);
            toEvict--; lruEvicted++;
        }
    }
    private int lruEvicted = 0;   // 累计因数量上限被 LRU 丢弃的后台重型标签数 → 经 DAO_FLUENCY 足迹可观测上限闸是否在生效

    /** 联控在场表保洁: 去掉 (a) 已不存在标签的 vid 项, (b) TTL 过期的观看登记, (c) 清空后的空内层表。
     *  根因: 旧逻辑仅在收到 claim 时顺手清陈, 无 claim(无云端控台连入)时 tabViewers 只增不减, 且关标签从不删项 →
     *  久用单调累积(慢泄漏) 且橙色在场计数可能把已关标签的陈旧观看者算进去。这里随内存保洁周期一并清理, 有界且即时纠偏。 */
    private void pruneViewers(long now) {
        try {
            java.util.HashSet<Long> live = new java.util.HashSet<>();
            for (int i = 0; i < tabs.size(); i++) live.add(tabs.get(i).vid);
            java.util.Iterator<java.util.Map.Entry<Long, java.util.concurrent.ConcurrentHashMap<String,Long>>> it = tabViewers.entrySet().iterator();
            while (it.hasNext()) {
                java.util.Map.Entry<Long, java.util.concurrent.ConcurrentHashMap<String,Long>> e = it.next();
                if (!live.contains(e.getKey())) { it.remove(); continue; }   // 标签已关 → 整项删
                java.util.Iterator<java.util.Map.Entry<String,Long>> jt = e.getValue().entrySet().iterator();
                while (jt.hasNext()) if (now - jt.next().getValue() > VIEW_TTL) jt.remove();   // 过期观看者删
                if (e.getValue().isEmpty()) it.remove();                     // 内层清空 → 整项删
            }
        } catch (Exception ignored) {}
    }

    /** 账号实时态静态表保洁: sTabStatus/sTabDollars 是 static(随进程恒存·跨 Activity 重建不灭), 由切号面板轮询每个
     *  账号即 put 一项却从不按账号离场回收 → 久用(尤其多账号反复轮询)单调累积的慢泄漏。这里随内存保洁周期把两表
     *  收敛到「当前仍打开的账号标签」对应的键(id 与 email·小写), 已无对应打开标签的陈旧账号态整项删 → 恒有界。 */
    private void pruneAccountMaps() {
        try {
            java.util.HashSet<String> live = new java.util.HashSet<>();
            for (int i = 0; i < tabs.size(); i++) {
                String aj = tabs.get(i).accountJson;
                if (aj == null) continue;
                try {
                    JSONObject a = new JSONObject(aj);
                    String id = a.optString("id", "");
                    String email = a.optString("email", "");
                    if (!id.isEmpty()) { live.add(id); live.add(id.toLowerCase()); }
                    if (!email.isEmpty()) { live.add(email); live.add(email.toLowerCase()); }
                } catch (Exception ignored) {}
            }
            java.util.Iterator<java.util.Map.Entry<String, String[]>> st = sTabStatus.entrySet().iterator();
            while (st.hasNext()) if (!live.contains(st.next().getKey())) st.remove();
            java.util.Iterator<java.util.Map.Entry<String, String>> dl = sTabDollars.entrySet().iterator();
            while (dl.hasNext()) if (!live.contains(dl.next().getKey())) dl.remove();
        } catch (Exception ignored) {}
    }

    /** 长会话内存足迹诊断: 每轮保洁打一行 native/dalvik 堆与标签数到 logcat(tag DAO_FLUENCY)。开销极低(纯 Java 计数),
     *  真机经 `adb logcat -s DAO_FLUENCY` 即可定位「用久了越卡」到底是哪类占用单调爬升 → 把根因从猜测变为可观测。 */
    private void logFootprint(String phase) {
        try {
            long natKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
            Runtime rt = Runtime.getRuntime();
            long javaKb = (rt.totalMemory() - rt.freeMemory()) / 1024;
            int parked = 0, shells = 0, acctLive = 0;
            for (int i = 0; i < tabs.size(); i++) {
                Tab t = tabs.get(i);
                if (t.pendingReloadUrl != null) shells++; else if (i != active) parked++;
                if (t.accountJson != null && t.pendingReloadUrl == null) acctLive++;   // 仍持活 WebView 的账号标签数 → 应随闲置卸载而恒有界
            }
            long mirrorKb = ((mirrorBuf != null && !mirrorBuf.isRecycled()) ? (long) mirrorBufW * mirrorBufH * 4 / 1024 : 0)
                          + ((mirrorScaledBuf != null && !mirrorScaledBuf.isRecycled()) ? (long) mirrorScaledW * mirrorScaledH * 4 / 1024 : 0);
            android.util.Log.i(FL, "footprint[" + phase + "] tabs=" + tabs.size() + " parked=" + parked
                    + " shells=" + shells + " acctLive=" + acctLive + " lruEvict=" + lruEvicted + " viewers=" + tabViewers.size()
                    + " acctSt=" + sTabStatus.size() + " acctUsd=" + sTabDollars.size()
                    + " mirrorKB=" + mirrorKb + " nativeKB=" + natKb + " javaKB=" + javaKb);
        } catch (Exception ignored) {}
    }

    @Override protected void onPause() {
        super.onPause();
        appForeground = false;
        main.removeCallbacks(visWatchdog);
        main.removeCallbacks(presenceTick);
        main.removeCallbacks(openAcctTick);
        main.removeCallbacks(engineTick);
        main.postDelayed(engineTick, ENGINE_TICK_BG_MS);   // 后台续跳(30s 降频): 状态追踪/阻塞提醒不再等回前台, 推送时效从十几分钟降到 ≤半分钟
        main.removeCallbacks(memHygiene);
        bgSince = System.currentTimeMillis();
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) {} // 持久化其它网站登录 Cookie
        // App 整体转后台(切到别的应用/锁屏): 没有任何标签可见 → 暂停全部 WebView 的渲染合成/动画, 不再空耗 CPU/GPU/电量
        // (仿真浏览器: 不可见即不渲染)。JS 不停, 远程自动化仍可经 execJs 驱动; 镜像/截图取帧前各自 resumeWeb → 不受影响。
        for (int i = 0; i < tabs.size(); i++) pauseWeb(tabs.get(i).web);
        // 转后台后起重度内存保洁 (45s 宽限避开快速切回); 续做直至回前台 → 久置后台占用持续下降, 回前台即顺。
        main.removeCallbacks(bgHygiene);
        main.postDelayed(bgHygiene, BG_HYGIENE_DELAY_MS);
        saveTabs();
    }

    /** 探活: 向标签 WebView 注入一句极简 JS; 若在超时内无回调 → 渲染线程被冻结/卡死 → 静默重载, 用户无需手动刷新。
     *  仅在确判可能僵死时调用(长后台返回), 健康页面探活即过, 不重载 → 不丢滚动/表单。
     *  关键: 必须连续两次(各 4s)无响应才判僵死并重载 —— 设备繁忙时单次回调迟到很常见, 单次超时即重载
     *  会在每次回前台时误重载、打断操作 (用户反映"刷新频繁打断")。给一次重试 → 仅真冻死才重载。 */
    private static final long EDIT_GUARD_MS = 20000;   // 最近 20s 内在输入 → 不做破坏性重载, 保住草稿
    private static final String FL = "DAO_FLUENCY";     // 流畅度诊断 tag: 每条重载/可见性翻转都打点 → 真机经 logcat 可定位是哪条路径介入
    /** 「用户此刻正与本页交互」: 打字/语音(lastEditable, 已含麦克风/语音识别) 在 20s 窗口内, 或最近 win 毫秒内有触摸
     *  (滚动/阅读/点麦克风按钮)。任一为真即应让出一切破坏性动作 → 「刷新账号」与「操作官网」道并行而不相悖。 */
    private boolean userInteracting(Tab t, long touchWin) {
        if (t == null) return false;
        long now = System.currentTimeMillis();
        if (t.lastEditable && (now - t.lastEditableTs) < EDIT_GUARD_MS) return true;
        return t.lastTouchTs > 0 && (now - t.lastTouchTs) < touchWin;
    }
    /** 前台巡检时记录当前页是否有聚焦的可编辑元素 (input/textarea/contenteditable = 正在打字或语音输入)。
     *  页面僵死时本巡检的 JS 也回不来 → lastEditableTs 自然变陈旧, 不影响真冻死的恢复。 */
    private void recordEditable(final Tab t) {
        if (t == null || t.web == null) return;
        final WebView w = t.web;
        try {
            // 「正在交互」= 聚焦可编辑元素(打字) 或 麦克风/语音识别活跃(语音输入)。两者都置 lastEditable → 复用同一道
            //   20s 护栏拦下破坏性重载/可见性翻转。逐层下探同源 iframe(单网页外壳把对话嵌在子页, 外层 activeElement
            //   恒为 <iframe>)。语音根因: 听写期间往往无聚焦输入框 → 旧判定恒「未输入」→ 语音被刷新打断; 故于各层
            //   幂等挂钩 getUserMedia / SpeechRecognition, 任一层正在采音即判「交互中」, 与打字同等受护。
            w.evaluateJavascript(MIC_AND_EDIT_PROBE_JS,
                val -> { if (tabOf(w) < 0) return; boolean ed = val != null && val.contains("1");
                    t.lastEditable = ed; if (ed) t.lastEditableTs = System.currentTimeMillis(); });
        } catch (Exception ignored) {}
    }
    /** 自包含·幂等·递归: 每层同源 window 挂上麦克风/语音识别探针(若未挂), 再判该层(及子 iframe)是否聚焦可编辑元素
     *  或正在采音。任一为真即返回 '1'(交互中)。挂钩只读旁观(包裹后仍调原实现) → 绝不改变页面采音/识别行为。 */
    private static final String MIC_AND_EDIT_PROBE_JS =
        "(function(){try{"
        + "function hook(w){try{if(!w||w.__rtMicHooked)return;w.__rtMicHooked=1;if(w.__rtMic==null)w.__rtMic=0;"
        + "var md=w.navigator&&w.navigator.mediaDevices;"
        + "if(md&&md.getUserMedia){var o=md.getUserMedia.bind(md);md.getUserMedia=function(c){var p=o(c);"
        + "try{if(c&&c.audio)p.then(function(s){try{var a=s.getAudioTracks?s.getAudioTracks():[];if(a&&a.length){w.__rtMic++;"
        + "a.forEach(function(tk){var d=function(){w.__rtMic=Math.max(0,w.__rtMic-1);};tk.addEventListener('ended',d);"
        + "var st=tk.stop&&tk.stop.bind(tk);if(st)tk.stop=function(){d();return st();};});}}catch(e){}}).catch(function(){});}catch(e){}"
        + "return p;};}"
        + "var SR=w.SpeechRecognition||w.webkitSpeechRecognition;"
        + "if(SR&&SR.prototype&&!SR.prototype.__rtW){try{var ps=SR.prototype.start;SR.prototype.start=function(){w.__rtMic++;"
        + "try{var dn=function(){w.__rtMic=Math.max(0,w.__rtMic-1);};this.addEventListener('end',dn);this.addEventListener('error',dn);}catch(e){}"
        + "return ps.apply(this,arguments);};SR.prototype.__rtW=1;}catch(e){}}"
        + "}catch(e){}}"
        + "function chk(d,w){if(!d)return false;try{hook(w);}catch(e){}try{if(w&&w.__rtMic>0)return true;}catch(e){}"
        + "var a=d.activeElement;if(a){var g=(a.tagName||'').toLowerCase();"
        + "if(g==='input'||g==='textarea'||a.isContentEditable)return true;"
        + "if(g==='iframe'){try{if(chk(a.contentDocument,a.contentWindow))return true;}catch(e){}}}return false;}"
        + "return chk(document,window)?'1':'0';}catch(e){return '0';}})()";
    private void probeTabLiveness(final Tab t) { probeTabLiveness(t, 0); }
    private void probeTabLiveness(final Tab t, final int attempt) {
        if (t == null || t.web == null) return;
        final WebView w = t.web;
        final boolean[] answered = {false};
        try {
            w.evaluateJavascript("(function(){try{return document.readyState;}catch(e){return 'x';}})()",
                    val -> answered[0] = true);
        } catch (Exception e) { return; }
        main.postDelayed(() -> {
            if (answered[0]) return;             // 渲染线程响应 → 健康, 不动
            if (tabOf(w) < 0) return;            // 标签已不在
            if (attempt < 1) { probeTabLiveness(t, attempt + 1); return; }   // 再给一次机会, 避免迟到回调被误判僵死
            // 用户正在输入/语音输入 (最近 ~20s 有聚焦可编辑元素) → 绝不破坏性重载 (会清空草稿·打断语音),
            //   改非破坏性唤醒。页面真冻死时该状态无法刷新 → 自然变陈旧, 下一轮探活即正常重载恢复。
            if (userInteracting(t, EDIT_GUARD_MS)) {
                android.util.Log.i(FL, "probe: frozen but user interacting (type/voice/touch) -> wake only, NO reload");
                try { resumeWeb(w); } catch (Exception ignored) {} return;
            }
            android.util.Log.i(FL, "probe: tab truly frozen & idle -> silent reload to recover");
            try { w.reload(); } catch (Exception ignored) {}   // 连续无响应且非输入中 → 真冻死, 静默重载恢复交互
        }, 4000);
    }

    /** 跳到本应用「安装未知应用」开关页 (package: URI 直达本应用, 避免用户在长列表里找不到)。 */
    private void openUnknownSourcesSetting() {
        try {
            startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            try { startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
        }
    }

    /** 内存压力回调: 释放非活动标签的 WebView 内部缓存 (不卸载页面·不打断后台自动化), 缓解多标签卡死/渲染进程被杀。 */
    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level < TRIM_MEMORY_RUNNING_LOW) return;   // 仅在确有压力时介入
        try {
            for (int i = 0; i < tabs.size(); i++) {
                if (i == active) continue;
                WebView w = tabs.get(i).web;
                if (w != null) { try { w.clearCache(false); } catch (Exception ignored) {} try { w.freeMemory(); } catch (Exception ignored) {} }
            }
            // 高压 (后台且濒临被整体回收, 或极端运行内存): 把后台普通网页标签整页卸载 → 压低进程内存,
            // 让整进程更不易被 LMK 整体杀死 (这是「切走一会就崩、回来整页重载」的釜底抽薪)。
            boolean critical = level >= TRIM_MEMORY_COMPLETE
                    || (!appForeground && level >= TRIM_MEMORY_RUNNING_CRITICAL);
            if (critical) for (int i = tabs.size() - 1; i >= 0; i--) unloadBackgroundTab(i);
        } catch (Exception ignored) {}
    }

    @Override protected void onResume() {
        super.onResume();
        appForeground = true;
        // 回到前台: 立即把当前可见标签拉回「可见+计时器运行」(根治"放久了点下载/交互失效需手动刷新")。
        Tab act = cur();
        if (act != null) resumeWeb(act.web);
        if (daoOpen && daoWeb != null) resumeWeb(daoWeb);   // 全服通悬浮窗若开着, 一并唤醒 (回前台不卡)
        // 持续看门狗: 前台期间每 8s 检一次, 若当前页 visibilityState 卡 hidden 则静默拉回, 无需用户操作。
        main.removeCallbacks(visWatchdog);
        main.postDelayed(visWatchdog, VIS_WATCH_MS);
        main.removeCallbacks(presenceTick);
        main.post(presenceTick);   // 前台巡检跨设备在场, 橙色标记随云端来去实时同步
        main.removeCallbacks(openAcctTick);
        main.post(openAcctTick);   // 前台保持「已打开账号标签」状态/额度实时识别 (不论是否在切号板块)
        main.removeCallbacks(engineTick);
        main.postDelayed(engineTick, 1500);   // 前台外驱引擎心跳: 状态/额度自动刷新与对话提醒不再依赖被节流的 WebView 计时器
        main.removeCallbacks(bgHygiene);   // 回前台 → 停后台重度保洁, 交还前台保洁
        main.removeCallbacks(memHygiene);
        main.postDelayed(memHygiene, MEM_HYGIENE_MS);   // 前台内存保洁: 主动有界化长会话占用, 根治「用久了越用越卡」
        // 长时间后台返回: 渲染线程可能被冻结(看着正常但点不动) → 当前标签探活(冻死则静默重载), 其余标签标记延迟探活。
        long bg = bgSince > 0 ? (System.currentTimeMillis() - bgSince) : 0;
        bgSince = 0;
        if (bg > STALE_BG_MS) {
            for (int i = 0; i < tabs.size(); i++) {
                Tab t = tabs.get(i);
                if (i == active && t.pendingReloadUrl == null) probeTabLiveness(t);
                else if (t.pendingReloadUrl == null) t.maybeStale = true;
            }
        }
        refreshSearchEngine();
        // 用户从「安装未知应用」开关页返回: 若已授权且有待装包, 自动续装 (零再触发)。
        try {
            if (pendingInstallApk != null && (Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls())) {
                File a = pendingInstallApk; pendingInstallApk = null;
                if (a.exists()) installApk(a);
            }
        } catch (Exception ignored) {}
    }

    @Override protected void onDestroy() {
        sInstance = null;
        appForeground = false;
        main.removeCallbacks(visWatchdog);
        main.removeCallbacks(presenceTick);
        main.removeCallbacks(memHygiene);
        main.removeCallbacks(bgHygiene);
        saveTabs();
        try { if (dlReceiver != null) unregisterReceiver(dlReceiver); } catch (Exception ignored) {}
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) {}
        destroyDaoPanel();   // 全服通悬浮窗 WebView 常驻 → Activity 销毁时一并释放
        try { if (mirrorBuf != null && !mirrorBuf.isRecycled()) mirrorBuf.recycle(); } catch (Exception ignored) {}
        try { if (mirrorScaledBuf != null && !mirrorScaledBuf.isRecycled()) mirrorScaledBuf.recycle(); } catch (Exception ignored) {}
        mirrorBuf = null; mirrorCanvas = null; mirrorScaledBuf = null; mirrorScaledCanvas = null;
        for (Tab t : tabs) { try { t.web.destroy(); } catch (Exception ignored) {} }
        tabs.clear();
        super.onDestroy();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // IPC 桥: 供 RelayService (同进程) 远程驱动前台浏览器标签
    //   所有方法在 main (UI) 线程调用; 异步结果通过 CompletableFuture 返回
    // ═══════════════════════════════════════════════════════════════════════════

    /** 列出所有前台浏览器标签 (JSON 数组) */
    public String ipcListTabs() {
        long now = System.currentTimeMillis();
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            if (i > 0) sb.append(",");
            sb.append("{\"index\":").append(i)
              .append(",\"id\":").append(t.vid)
              .append(",\"url\":").append(JSONObject.quote(t.url == null ? "" : t.url))
              .append(",\"title\":").append(JSONObject.quote(t.title == null ? "" : t.title))
              .append(",\"account\":").append(safeTabAccount(t.accountJson))
              .append(",\"internal\":").append(t.internal)
              .append(",\"active\":").append(i == active)
              .append(tabMetaJson(t))
              .append(",\"viewers\":").append(viewersJson(t.vid, i == active, now))
              .append("}");
        }
        return sb.append("]").toString();
    }

    /** 标签实时态 (该号最活跃对话名/状态/剩余额度) JSON 片段, 供 ipcListTabs 外发给网页控台第二行镜像,
     *  让网页与手机原生标签条 1:1 同步显示对话状态点 + 美金额度 (数据源同 chipTitle: sTabStatus/sTabDollars)。 */
    private String tabMetaJson(Tab t) {
        String convName = "", status = "", dollars = "";
        if (t != null && t.accountJson != null) {
            try {
                JSONObject a = new JSONObject(t.accountJson);
                String id = a.optString("id", a.optString("email", ""));
                String email = a.optString("email", id);
                String emailLc = email.toLowerCase();
                String money = sTabDollars.get(id);
                if (money == null) money = sTabDollars.get(emailLc);
                if (money != null) dollars = money;
                String[] sta = sTabStatus.get(id);
                if (sta == null) sta = sTabStatus.get(email);
                if (sta == null) sta = sTabStatus.get(emailLc);
                if (sta != null) {
                    convName = sta[0] == null ? "" : sta[0];
                    status = sta[1] == null ? "" : sta[1];
                }
            } catch (Exception ignored) {}
        }
        return ",\"convName\":" + JSONObject.quote(convName)
             + ",\"status\":" + JSONObject.quote(status)
             + ",\"dollars\":" + JSONObject.quote(dollars);
    }

    /** 下载列表 (供网页控台 📥 悬浮窗 1:1 呈现手机下载管理): 仅外发文件名/大小/状态/mime/序号, 不含绝对路径。 */
    public String ipcListDownloads() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("downloads", "[]"));
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject e = arr.getJSONObject(i);
                String path = e.optString("file", "");
                String uri = e.optString("uri", "");
                String name = e.optString("name", path);
                String mime = e.optString("mime", "*/*");
                File f = new File(path);
                boolean avail = f.exists() || !uri.isEmpty();
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("index", i);
                o.put("name", name);
                o.put("mime", mime);
                o.put("size", f.exists() ? f.length() : 0);
                o.put("sizeText", avail ? (f.exists() ? humanSize(f.length()) : "已入系统下载") : "(文件已删)");
                o.put("avail", avail);
                out.put(o);
            }
            return out.toString();
        } catch (Exception e) { return "[]"; }
    }
    /** 网页控台 📥 悬浮窗的下载项动作 (在手机本机执行, 与原生下载面板同款): share / open / delete。 */
    public void ipcDownloadAction(int recIdx, String action) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("downloads", "[]"));
            if (recIdx < 0 || recIdx >= arr.length()) return;
            org.json.JSONObject e = arr.getJSONObject(recIdx);
            String path = e.optString("file", ""); String uri = e.optString("uri", ""); String mime = e.optString("mime", "*/*");
            if ("share".equals(action)) shareDownloaded(path, uri, mime);
            else if ("open".equals(action)) openWithChooser(path, uri, mime);
            else if ("delete".equals(action)) { deleteDownload(recIdx, path); if (dlListCol != null) runOnUiThread(() -> renderDownloadList(dlListCol)); }
        } catch (Exception ignored) {}
    }

    /** 网页控台「取到本机 / 传到当前页」: 按序号读手机下载文件字节并返回 base64 (路径/URI 解析留在本机, 不外发)。
     *  上限 24MB, 超限返回空串(避免 OOM 与中继巨帧); 优先读本地文件, 回退 content:// URI。 */
    public String ipcReadDownload(int recIdx) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(getSharedPreferences(PREFS, MODE_PRIVATE).getString("downloads", "[]"));
            if (recIdx < 0 || recIdx >= arr.length()) return "";
            org.json.JSONObject e = arr.getJSONObject(recIdx);
            String path = e.optString("file", ""); String uri = e.optString("uri", "");
            final long MAX = 24L * 1024 * 1024;
            java.io.InputStream in = null;
            try {
                File f = path.isEmpty() ? null : new File(path);
                if (f != null && f.exists() && !f.isDirectory()) {
                    if (f.length() > MAX) return "";
                    in = new java.io.FileInputStream(f);
                } else if (!uri.isEmpty()) {
                    in = getContentResolver().openInputStream(android.net.Uri.parse(uri));
                }
                if (in == null) return "";
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[65536]; int r; long total = 0;
                while ((r = in.read(buf)) > 0) { total += r; if (total > MAX) return ""; bos.write(buf, 0, r); }
                return android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
            } finally { if (in != null) try { in.close(); } catch (Exception ignore) {} }
        } catch (Exception e) { return ""; }
    }

    /** 标签所属账号的「脱敏」标识 (供 browseListTabs 经中继外发): 仅 email/id/org/编号, 绝不含 password/auth1/token/apiKey。 */
    private String safeTabAccount(String accountJson) {
        if (accountJson == null || accountJson.isEmpty()) return "\"\"";
        try {
            JSONObject a = new JSONObject(accountJson);
            JSONObject s = new JSONObject();
            String email = a.optString("email", a.optString("id", ""));
            if (!email.isEmpty()) { s.put("email", email); s.put("id", email); }
            String org = a.optString("orgName", "");
            if (!org.isEmpty()) s.put("orgName", org);
            if (a.has("no")) s.put("no", a.opt("no"));
            return s.toString();
        } catch (Exception e) { return "\"\""; }
    }

    /** 在指定标签中执行 JS, 结果通过回调返回 */
    public void ipcExecJs(int tabIndex, String js, android.webkit.ValueCallback<String> cb) {
        if (tabIndex < 0 || tabIndex >= tabs.size()) { if (cb != null) cb.onReceiveValue("null"); return; }
        Tab t = tabs.get(tabIndex);
        if (t.web != null) t.web.evaluateJavascript(js, cb);
        else if (cb != null) cb.onReceiveValue("null");
    }

    /** 导航指定标签: back/forward/reload/stop/goto */
    public void ipcNavigate(int tabIndex, String action, String url) {
        if (tabIndex < 0 || tabIndex >= tabs.size()) return;
        Tab t = tabs.get(tabIndex);
        if (t.web == null) return;
        switch (action) {
            case "back": t.web.goBack(); break;
            case "forward": t.web.goForward(); break;
            case "reload": t.web.reload(); break;
            case "stop": t.web.stopLoading(); break;
            case "goto": if (url != null) t.web.loadUrl(url); break;
        }
    }

    /** 截图指定标签 (返回 base64 PNG) */
    public String ipcScreenshot(int tabIndex) {
        if (tabIndex < 0 || tabIndex >= tabs.size()) return "";
        Tab t = tabs.get(tabIndex);
        if (t.web == null) return "";
        try {
            // 道法自然·共享一切但互不干扰: 仅停泊「非活动」标签到 autoHost; 活动(前台)标签本就在 content 可见,
            // 绝不 park 它 —— 否则任一端截前台标签都会把它从 content 拽进不可见 autoHost, 害手机本体+该端齐黑屏。
            if (tabIndex != active) parkHost(t);   // 后台标签: 确保挂载窗口(有尺寸·可被 draw 截取)
            resumeWeb(t.web);       // 拉回「页面可见+计时器运行」, 否则离屏/冻结态 Chromium 合成层为空 → 截白图
            int w = t.web.getWidth(), h = t.web.getHeight();
            if (w <= 0 || h <= 0) {   // 未布局的后台标签: 按屏幕尺寸强制测量+布局再截
                android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
                w = dm.widthPixels; h = dm.heightPixels;
                t.web.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY),
                              android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY));
                t.web.layout(0, 0, w, h);
            }
            if (w <= 0 || h <= 0) return "";
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas c = new android.graphics.Canvas(bmp);
            t.web.draw(c);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 80, bos);
            bmp.recycle();
            return android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) { return ""; }
    }

    // ── 镜像帧可复用缓冲 (根治联控期每帧新建满屏 ARGB_8888 位图 → 持续 ~10MB 分配抖动 GC) ──────
    //   病根(架构维度): 云端联控时镜像端按 2~5fps 连续取帧, 旧逻辑每帧 createBitmap 一张满屏 ARGB_8888
    //   (1080x2400≈10MB)+ 画完即 recycle —— 不泄漏, 但「每帧十兆级分配/回收」在 UI 线程持续制造 GC 停顿, 是
    //   「操作过久越用越卡」在前台联控路径上的结构性成本。修法: 复用同一张满屏位图(尺寸不变即复用), 画前
    //   drawColor 不透明铺底既铺底又清上一帧(无残影); 只有真正用于编码的降采样副本才临时分配。镜像停止
    //   MIRROR_BUF_IDLE_MS 后于内存保洁周期释放该缓冲 → 不联控时不常驻这 ~10MB。所有访问皆在 UI 线程, 无竞态。
    private android.graphics.Bitmap mirrorBuf;       // 复用的满屏位图
    private android.graphics.Canvas mirrorCanvas;    // 绑定 mirrorBuf 的画布
    private int mirrorBufW = 0, mirrorBufH = 0;      // 当前满屏缓冲尺寸
    private android.graphics.Bitmap mirrorScaledBuf; // 复用的「降采样」编码缓冲 (默认 maxDim=1024 下原本每帧新建 ~2MB)
    private android.graphics.Canvas mirrorScaledCanvas;
    private int mirrorScaledW = 0, mirrorScaledH = 0;
    private android.graphics.Paint mirrorScalePaint;  // 双线性过滤的缩图画笔 (与 createScaledBitmap(filter=true) 同等画质)
    private ByteArrayOutputStream mirrorBos;          // 复用的 JPEG 编码缓冲 (每帧 reset 复用底层 byte[], 免每帧重建+扩容)
    private final android.graphics.Rect mirrorSrcRect = new android.graphics.Rect();  // 复用: 降采样 src 矩形
    private final android.graphics.Rect mirrorDstRect = new android.graphics.Rect();  // 复用: 降采样 dst 矩形
    private volatile long lastMirrorAtMs = 0;        // 最近取镜像帧时刻 (闲置即释放缓冲)
    private static final long MIRROR_BUF_IDLE_MS = 8000;   // 镜像停止 8s 后释放复用缓冲
    /** 镜像缓冲闲置释放: 停止取帧超 MIRROR_BUF_IDLE_MS 即回收满屏+缩图两块缓冲, 不再常驻。UI 线程调用。 */
    private void releaseMirrorBufIfIdle() {
        if (mirrorBuf == null && mirrorScaledBuf == null) return;
        if (System.currentTimeMillis() - lastMirrorAtMs < MIRROR_BUF_IDLE_MS) return;
        try { if (mirrorBuf != null && !mirrorBuf.isRecycled()) mirrorBuf.recycle(); } catch (Exception ignored) {}
        try { if (mirrorScaledBuf != null && !mirrorScaledBuf.isRecycled()) mirrorScaledBuf.recycle(); } catch (Exception ignored) {}
        mirrorBuf = null; mirrorCanvas = null; mirrorBufW = 0; mirrorBufH = 0;
        mirrorScaledBuf = null; mirrorScaledCanvas = null; mirrorScaledW = 0; mirrorScaledH = 0;
        mirrorBos = null;   // 释放编码缓冲底层 byte[] (久无联控不常驻)
    }

    // ── 投屏镜像 (任意公网/局域网浏览器实时镜像并反向操控某原生标签) ─────────────
    /** 镜像取帧: 截某标签为 JPEG(可降采样) + 尺寸/URL/标题/激活态 → JSON 字符串。任意线程可调(内部 marshal 到主线程)。 */
    public String ipcMirrorFrame(int tabIndex, int quality, int maxDim) {
        final String[] out = { "" };
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        runOnUiThread(() -> { try { out[0] = mirrorFrameOnUi(tabIndex, quality, maxDim); } catch (Exception e) { out[0] = ""; } finally { latch.countDown(); } });
        try { latch.await(6, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {}
        return (out[0] == null || out[0].isEmpty()) ? "{\"ok\":false}" : out[0];
    }
    private String mirrorFrameOnUi(int tabIndex, int quality, int maxDim) throws Exception {
        if (tabIndex < 0 || tabIndex >= tabs.size()) return "{\"ok\":false,\"error\":\"no_tab\"}";
        Tab t = tabs.get(tabIndex);
        if (t.web == null) return "{\"ok\":false,\"error\":\"no_web\"}";
        // 仅 park 非活动标签; 活动前台标签留在 content 直接 draw, 否则截图会把手机本体前台拽黑 (与 ipcScreenshot 同策)
        if (tabIndex != active) parkHost(t);
        resumeWeb(t.web);   // 后台标签也解冻, 否则截白图
        int w = t.web.getWidth(), h = t.web.getHeight();
        if (w <= 0 || h <= 0) {
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            w = dm.widthPixels; h = dm.heightPixels;
            t.web.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY),
                          android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY));
            t.web.layout(0, 0, w, h);
        }
        if (w <= 0 || h <= 0) return "{\"ok\":false,\"error\":\"no_size\"}";
        lastMirrorAtMs = System.currentTimeMillis();
        // 满屏位图复用: 尺寸不变即复用同一张, 避免每帧 ~10MB 分配/回收的 GC 抖动。
        android.graphics.Bitmap bmp; android.graphics.Canvas c;
        if (mirrorBuf != null && !mirrorBuf.isRecycled() && mirrorBufW == w && mirrorBufH == h) {
            bmp = mirrorBuf; c = mirrorCanvas;
        } else {
            if (mirrorBuf != null && !mirrorBuf.isRecycled()) { try { mirrorBuf.recycle(); } catch (Exception ignored) {} }
            bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888);
            c = new android.graphics.Canvas(bmp);
            mirrorBuf = bmp; mirrorCanvas = c; mirrorBufW = w; mirrorBufH = h;
        }
        c.drawColor(0xFF0E1116);   // JPEG 无 alpha → 先铺底色(也清除上一帧, 复用无残影)
        t.web.draw(c);
        android.graphics.Bitmap shot = bmp;   // 实际编码用位图: 降采样时为复用缩图缓冲, 否则即满屏缓冲本身
        if (maxDim > 0 && Math.max(w, h) > maxDim) {   // 长边降采样, 控带宽
            float s = maxDim / (float) Math.max(w, h);
            int sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
            // 缩图缓冲亦复用: 尺寸不变即复用, 消除最后一处每帧 ~2MB 分配 → 热路径零每帧分配。
            if (mirrorScaledBuf == null || mirrorScaledBuf.isRecycled() || mirrorScaledW != sw || mirrorScaledH != sh) {
                if (mirrorScaledBuf != null && !mirrorScaledBuf.isRecycled()) { try { mirrorScaledBuf.recycle(); } catch (Exception ignored) {} }
                mirrorScaledBuf = android.graphics.Bitmap.createBitmap(sw, sh, android.graphics.Bitmap.Config.ARGB_8888);
                mirrorScaledCanvas = new android.graphics.Canvas(mirrorScaledBuf);
                mirrorScaledW = sw; mirrorScaledH = sh;
            }
            if (mirrorScalePaint == null) mirrorScalePaint = new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG);
            // 满幅 dst 覆盖整块 → 无上帧残留; 双线性过滤与 createScaledBitmap(filter=true) 同质。矩形复用免每帧新建。
            mirrorSrcRect.set(0, 0, w, h); mirrorDstRect.set(0, 0, sw, sh);
            mirrorScaledCanvas.drawBitmap(bmp, mirrorSrcRect, mirrorDstRect, mirrorScalePaint);
            shot = mirrorScaledBuf;
        }
        int bw = shot.getWidth(), bh = shot.getHeight();
        if (mirrorBos == null) mirrorBos = new ByteArrayOutputStream(); else mirrorBos.reset();   // 复用编码缓冲: reset 保留底层 byte[], 免每帧重建+扩容
        shot.compress(android.graphics.Bitmap.CompressFormat.JPEG, Math.max(20, Math.min(90, quality)), mirrorBos);
        // bmp / mirrorScaledBuf 均为复用缓冲 → 不每帧回收, 统一于闲置时释放。
        String b64 = android.util.Base64.encodeToString(mirrorBos.toByteArray(), android.util.Base64.NO_WRAP);
        JSONObject o = new JSONObject();
        o.put("ok", true); o.put("jpeg", b64); o.put("w", bw); o.put("h", bh);
        o.put("url", t.web.getUrl() == null ? "" : t.web.getUrl());
        o.put("title", t.web.getTitle() == null ? "" : t.web.getTitle());
        o.put("active", tabIndex == active); o.put("n", tabs.size());
        return o.toString();
    }
    /** 标签清单 (供镜像端选择镜像哪个原生标签)。 */
    public String ipcMirrorTabs() {
        final String[] out = { "" };
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        runOnUiThread(() -> {
            try {
                JSONObject o = new JSONObject(); org.json.JSONArray arr = new org.json.JSONArray();
                for (int i = 0; i < tabs.size(); i++) {
                    Tab t = tabs.get(i); JSONObject e = new JSONObject();
                    e.put("i", i);
                    e.put("title", (t.web != null && t.web.getTitle() != null) ? t.web.getTitle() : ("标签 " + (i + 1)));
                    e.put("url", (t.web != null && t.web.getUrl() != null) ? t.web.getUrl() : "");
                    arr.put(e);
                }
                o.put("active", active); o.put("tabs", arr); out[0] = o.toString();
            } catch (Exception e) { out[0] = ""; } finally { latch.countDown(); }
        });
        try { latch.await(3, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {}
        return (out[0] == null || out[0].isEmpty()) ? "{\"active\":-1,\"tabs\":[]}" : out[0];
    }
    /** 反向输入: 把镜像端的 点击/滑动/输入/按键 注入某标签页 (归一化坐标 → 页面视口坐标, 与设备像素密度无关)。 */
    public String ipcMirrorInput(int tabIndex, JSONObject body) {
        if (tabIndex < 0 || tabIndex >= tabs.size() || body == null) return "{\"ok\":false}";
        String js;
        try {
            JSONObject a = new JSONObject();
            a.put("action", body.optString("action", "click"));
            a.put("nx", body.optDouble("nx", body.optDouble("x", 0)));
            a.put("ny", body.optDouble("ny", body.optDouble("y", 0)));
            a.put("text", body.optString("text", ""));
            a.put("key", body.optString("key", ""));
            a.put("dy", body.optDouble("dy", 0));
            js = "(function(A){try{" + MIRROR_INPUT_CORE + "}catch(e){return 'err:'+e}})(" + a + ")";
        } catch (Exception e) { return "{\"ok\":false}"; }
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final String fjs = js;
        runOnUiThread(() -> { try { ipcExecJs(tabIndex, fjs, v -> latch.countDown()); } catch (Exception e) { latch.countDown(); } });
        try { latch.await(3, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {}
        return "{\"ok\":true}";
    }
    /** 反向输入核心 JS (在被镜像页内执行): 归一化坐标→视口坐标, 合成 指针/鼠标/键盘 事件并对 React 受控输入触发 input/change。 */
    private static final String MIRROR_INPUT_CORE =
        "var x=Math.round(A.nx*window.innerWidth),y=Math.round(A.ny*window.innerHeight);" +
        "var el=document.elementFromPoint(x,y);" +
        "function fire(t,tg){var ev;try{ev=new MouseEvent(t,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,view:window,button:0});}catch(_){ev=document.createEvent('MouseEvents');ev.initMouseEvent(t,true,true,window,0,0,0,x,y,false,false,false,false,0,null);}(tg||el).dispatchEvent(ev);}" +
        "function fp(t,tg){try{(tg||el).dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,view:window,pointerType:'touch',isPrimary:true,button:0}));}catch(_){}}" +
        "function setv(t,v){var p=(t.tagName==='TEXTAREA')?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(p,'value').set;s.call(t,v);t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));}" +
        "function isEd(n){return n&&(n.isContentEditable||n.tagName==='INPUT'||n.tagName==='TEXTAREA');}" +
        "function findEd(n){for(var i=0;i<5&&n;i++){if(n.matches&&n.matches('[contenteditable=true],input:not([type=hidden]):not([type=button]):not([type=submit]),textarea'))return n;var q=n.querySelector&&n.querySelector('[contenteditable=true],textarea,input:not([type=hidden]):not([type=button]):not([type=submit])');if(q)return q;n=n.parentElement;}return null;}" +
        "function caret(ed){if(!ed||!ed.isContentEditable)return;try{var rg=document.createRange();rg.selectNodeContents(ed);rg.collapse(false);var sl=getSelection();sl.removeAllRanges();sl.addRange(rg);}catch(_){}}" +
        "if(A.action==='click'||A.action==='tap'){if(!el)return'noel';fp('pointerdown');fire('mousedown');try{el.focus&&el.focus();}catch(_){}fp('pointerup');fire('mouseup');fire('click');if(!isEd(document.activeElement)){var ed=findEd(el);if(ed){try{ed.focus();}catch(_){}caret(ed);}}return'click';}" +
        "if(A.action==='scroll'){var sc=el;while(sc&&sc!==document.body&&sc!==document.documentElement){var st=getComputedStyle(sc);if(/(auto|scroll)/.test(st.overflowY)&&sc.scrollHeight>sc.clientHeight)break;sc=sc.parentElement;}if(sc&&sc!==document.body&&sc!==document.documentElement){sc.scrollTop+=A.dy;}else{window.scrollBy(0,A.dy);}return'scroll';}" +
        "if(A.action==='type'||A.action==='settext'){var t=document.activeElement;if(!t||t===document.body){if(el&&el.focus){try{el.focus();}catch(_){}}t=document.activeElement;}if(!t)return'nofocus';var tg=(t.tagName||'').toLowerCase();if(tg==='input'||tg==='textarea'){setv(t,A.action==='settext'?A.text:((t.value||'')+A.text));return'type';}if(t.isContentEditable){var sl=getSelection();if(!sl.rangeCount||(sl.anchorNode&&!t.contains(sl.anchorNode))){caret(t);}document.execCommand('insertText',false,A.text);return'type-ce';}return'notinput';}" +
        "if(A.action==='key'){var t=document.activeElement||document.body;var k=A.key||'Enter';var kc=k==='Enter'?13:(k==='Backspace'?8:0);['keydown','keypress','keyup'].forEach(function(tp){if(tp==='keypress'&&k!=='Enter')return;try{t.dispatchEvent(new KeyboardEvent(tp,{bubbles:true,cancelable:true,key:k,code:k,keyCode:kc,which:kc,view:window}));}catch(_){}});if(k==='Backspace'){if(t.tagName==='INPUT'||t.tagName==='TEXTAREA'){setv(t,(t.value||'').slice(0,-1));}else if(t.isContentEditable){document.execCommand('delete',false,null);}}return'key';}" +
        "if(A.action==='back'){history.back();return'back';}" +
        "return'noop';";

    /** 获取所有 Cookie (指定 URL) */
    public String ipcGetCookies(String url) {
        try { return android.webkit.CookieManager.getInstance().getCookie(url); }
        catch (Exception e) { return ""; }
    }

    /** 开新标签 (从 IPC 调用) — 远程自动化: 后台静默开, 不抢占用户当前前台页 (道并行而不相悖)。 */
    public void ipcOpenTab(String url, String accountJson) {
        main.post(() -> newTabBackground(url == null ? DEVIN : url, accountJson));
    }

    /** 把指定标签提到前台 (从 IPC 调用) — 仅当 Agent 显式需要"前端同步反映"时调用。 */
    public void ipcActivateTab(int tabIndex) {
        main.post(() -> { if (tabIndex >= 0 && tabIndex < tabs.size()) selectTab(tabIndex); });
    }

    /** 关闭标签 */
    public void ipcCloseTab(int tabIndex) {
        main.post(() -> { if (tabIndex >= 0 && tabIndex < tabs.size()) closeTab(tabIndex); });
    }

    /** 获取标签数量 */
    public int ipcTabCount() { return tabs.size(); }

    /** 获取活动标签索引 */
    public int ipcActiveIndex() { return active; }

    /** 获取剪贴板文本 */
    public String ipcGetClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
                return cs == null ? "" : cs.toString();
            }
        } catch (Exception e) {}
        return "";
    }

    /** 设置剪贴板文本 */
    public void ipcSetClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("dao", text == null ? "" : text));
        } catch (Exception e) {}
    }

    /** 分享文本 */
    public void ipcShare(String text, String title) {
        Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
        if (title != null) i.putExtra(Intent.EXTRA_SUBJECT, title);
        startActivity(Intent.createChooser(i, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** 列出外部存储目录下的文件 */
    public String ipcListFiles(String dir) {
        try {
            File base = (dir == null || dir.isEmpty()) ? android.os.Environment.getExternalStorageDirectory() : new File(dir);
            if (!base.exists() || !base.isDirectory()) return "[]";
            File[] files = base.listFiles();
            if (files == null) return "[]";
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < files.length; i++) {
                if (i > 0) sb.append(",");
                sb.append("{\"name\":").append(JSONObject.quote(files[i].getName()))
                  .append(",\"path\":").append(JSONObject.quote(files[i].getAbsolutePath()))
                  .append(",\"isDir\":").append(files[i].isDirectory())
                  .append(",\"size\":").append(files[i].length())
                  .append(",\"modified\":").append(files[i].lastModified())
                  .append("}");
            }
            return sb.append("]").toString();
        } catch (Exception e) { return "[]"; }
    }

    /** 读取文件内容 (文本或 base64) */
    public String ipcReadFile(String path, boolean base64) {
        try {
            File f = new File(path);
            if (!f.exists() || f.isDirectory()) return "";
            if (base64) {
                byte[] bytes = new byte[(int) f.length()];
                java.io.FileInputStream fis = new java.io.FileInputStream(f);
                fis.read(bytes); fis.close();
                return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
            } else {
                java.io.FileInputStream fis = new java.io.FileInputStream(f);
                byte[] bytes = new byte[(int) f.length()];
                fis.read(bytes); fis.close();
                return new String(bytes, StandardCharsets.UTF_8);
            }
        } catch (Exception e) { return ""; }
    }

    /** 写入文件 */
    public boolean ipcWriteFile(String path, String content) {
        try {
            File f = new File(path);
            f.getParentFile().mkdirs();
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(content.getBytes(StandardCharsets.UTF_8));
            fos.close();
            return true;
        } catch (Exception e) { return false; }
    }

    /** 列出相册图片 (MediaStore) */
    public String ipcListPhotos(int limit) {
        try {
            android.database.Cursor cur = getContentResolver().query(
                android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[]{android.provider.MediaStore.Images.Media._ID,
                             android.provider.MediaStore.Images.Media.DISPLAY_NAME,
                             android.provider.MediaStore.Images.Media.DATA,
                             android.provider.MediaStore.Images.Media.SIZE,
                             android.provider.MediaStore.Images.Media.DATE_MODIFIED},
                null, null, android.provider.MediaStore.Images.Media.DATE_MODIFIED + " DESC");
            if (cur == null) return "[]";
            StringBuilder sb = new StringBuilder("[");
            int count = 0;
            while (cur.moveToNext() && count < (limit > 0 ? limit : 100)) {
                if (count > 0) sb.append(",");
                sb.append("{\"id\":").append(cur.getLong(0))
                  .append(",\"name\":").append(JSONObject.quote(cur.getString(1) == null ? "" : cur.getString(1)))
                  .append(",\"path\":").append(JSONObject.quote(cur.getString(2) == null ? "" : cur.getString(2)))
                  .append(",\"size\":").append(cur.getLong(3))
                  .append(",\"modified\":").append(cur.getLong(4))
                  .append("}");
                count++;
            }
            cur.close();
            return sb.append("]").toString();
        } catch (Exception e) { return "[]"; }
    }

    /** 获取设备信息 */
    public String ipcDeviceInfo() {
        try {
            JSONObject o = new JSONObject();
            o.put("model", Build.MODEL);
            o.put("brand", Build.BRAND);
            o.put("device", Build.DEVICE);
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("release", Build.VERSION.RELEASE);
            o.put("display", Build.DISPLAY);
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            o.put("screenWidth", dm.widthPixels);
            o.put("screenHeight", dm.heightPixels);
            o.put("density", dm.density);
            // 尝试获取手机号 (需 READ_PHONE_STATE 权限, 可能为空)
            try {
                android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) getSystemService(TELEPHONY_SERVICE);
                if (tm != null) {
                    String line = tm.getLine1Number();
                    if (line != null && !line.isEmpty()) o.put("phoneNumber", line);
                }
            } catch (Exception ignored) {}
            o.put("totalStorage", android.os.Environment.getExternalStorageDirectory().getTotalSpace());
            o.put("freeStorage", android.os.Environment.getExternalStorageDirectory().getFreeSpace());
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    /** 列出已安装应用 */
    public String ipcInstalledApps() {
        try {
            List<android.content.pm.ApplicationInfo> apps = getPackageManager().getInstalledApplications(0);
            StringBuilder sb = new StringBuilder("[");
            int count = 0;
            for (android.content.pm.ApplicationInfo ai : apps) {
                if ((ai.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                if (count > 0) sb.append(",");
                sb.append("{\"package\":").append(JSONObject.quote(ai.packageName))
                  .append(",\"label\":").append(JSONObject.quote(
                    getPackageManager().getApplicationLabel(ai).toString()))
                  .append("}");
                count++;
            }
            return sb.append("]").toString();
        } catch (Exception e) { return "[]"; }
    }

    /** 发送本地通知 */
    public void ipcNotify(String title, String text) {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) {
                android.app.NotificationChannel ch = new android.app.NotificationChannel("dao-msg", "消息", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                nm.createNotificationChannel(ch);
            }
            android.app.Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ?
                new android.app.Notification.Builder(this, "dao-msg") :
                new android.app.Notification.Builder(this);
            nb.setContentTitle(title == null ? "Devin Cloud" : title)
              .setContentText(text == null ? "" : text)
              .setSmallIcon(android.R.drawable.ic_dialog_info)
              .setAutoCancel(true);
            nm.notify((int) System.currentTimeMillis(), nb.build());
        } catch (Exception e) {}
    }

    /** 启动指定包名的 APP */
    public boolean ipcLaunchApp(String pkg) {
        try {
            Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return false;
            startActivity(i);
            return true;
        } catch (Exception e) { return false; }
    }

    /** 打开系统无障碍设置页 (引导用户开启 RtAccessibilityService) */
    public void ipcOpenA11ySettings() {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {}
    }

    /** 运行时申请联系人/短信/通话记录敏感权限 (UI 线程弹窗) */
    public void ipcRequestPhonePerms() {
        try {
            java.util.List<String> need = new ArrayList<>();
            String[] perms = {Manifest.permission.READ_CONTACTS, Manifest.permission.READ_SMS, Manifest.permission.READ_CALL_LOG};
            for (String p : perms) {
                if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) need.add(p);
            }
            if (!need.isEmpty()) ActivityCompat.requestPermissions(this, need.toArray(new String[0]), 7);
        } catch (Exception e) {}
    }

    /** 是否已授予某敏感权限 */
    public boolean ipcHasPerm(String perm) {
        try { return ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED; }
        catch (Exception e) { return false; }
    }

    /** 读取联系人 (姓名+号码, 需 READ_CONTACTS) */
    public String ipcContacts(int limit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED)
            return "{\"error\":\"未授予 READ_CONTACTS 权限\",\"needPerm\":\"READ_CONTACTS\"}";
        try {
            android.database.Cursor cur = getContentResolver().query(
                android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                             android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER},
                null, null, android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC");
            if (cur == null) return "[]";
            StringBuilder sb = new StringBuilder("[");
            int count = 0;
            while (cur.moveToNext() && count < (limit > 0 ? limit : 500)) {
                if (count > 0) sb.append(",");
                sb.append("{\"name\":").append(JSONObject.quote(cur.getString(0) == null ? "" : cur.getString(0)))
                  .append(",\"number\":").append(JSONObject.quote(cur.getString(1) == null ? "" : cur.getString(1)))
                  .append("}");
                count++;
            }
            cur.close();
            return sb.append("]").toString();
        } catch (Exception e) { return "{\"error\":" + JSONObject.quote(String.valueOf(e)) + "}"; }
    }

    /** 读取短信收件箱 (含 OTP 验证码, 需 READ_SMS) */
    public String ipcSmsInbox(int limit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED)
            return "{\"error\":\"未授予 READ_SMS 权限\",\"needPerm\":\"READ_SMS\"}";
        try {
            android.database.Cursor cur = getContentResolver().query(
                android.provider.Telephony.Sms.Inbox.CONTENT_URI,
                new String[]{android.provider.Telephony.Sms.ADDRESS,
                             android.provider.Telephony.Sms.BODY,
                             android.provider.Telephony.Sms.DATE,
                             android.provider.Telephony.Sms.READ},
                null, null, android.provider.Telephony.Sms.DATE + " DESC");
            if (cur == null) return "[]";
            StringBuilder sb = new StringBuilder("[");
            int count = 0;
            while (cur.moveToNext() && count < (limit > 0 ? limit : 50)) {
                if (count > 0) sb.append(",");
                sb.append("{\"address\":").append(JSONObject.quote(cur.getString(0) == null ? "" : cur.getString(0)))
                  .append(",\"body\":").append(JSONObject.quote(cur.getString(1) == null ? "" : cur.getString(1)))
                  .append(",\"date\":").append(cur.getLong(2))
                  .append(",\"read\":").append(cur.getInt(3) == 1)
                  .append("}");
                count++;
            }
            cur.close();
            return sb.append("]").toString();
        } catch (Exception e) { return "{\"error\":" + JSONObject.quote(String.valueOf(e)) + "}"; }
    }

    /** 读取通话记录 (需 READ_CALL_LOG) */
    public String ipcCallLog(int limit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED)
            return "{\"error\":\"未授予 READ_CALL_LOG 权限\",\"needPerm\":\"READ_CALL_LOG\"}";
        try {
            android.database.Cursor cur = getContentResolver().query(
                android.provider.CallLog.Calls.CONTENT_URI,
                new String[]{android.provider.CallLog.Calls.NUMBER,
                             android.provider.CallLog.Calls.TYPE,
                             android.provider.CallLog.Calls.DATE,
                             android.provider.CallLog.Calls.DURATION,
                             android.provider.CallLog.Calls.CACHED_NAME},
                null, null, android.provider.CallLog.Calls.DATE + " DESC");
            if (cur == null) return "[]";
            StringBuilder sb = new StringBuilder("[");
            int count = 0;
            while (cur.moveToNext() && count < (limit > 0 ? limit : 50)) {
                if (count > 0) sb.append(",");
                sb.append("{\"number\":").append(JSONObject.quote(cur.getString(0) == null ? "" : cur.getString(0)))
                  .append(",\"type\":").append(cur.getInt(1))
                  .append(",\"date\":").append(cur.getLong(2))
                  .append(",\"duration\":").append(cur.getLong(3))
                  .append(",\"name\":").append(JSONObject.quote(cur.getString(4) == null ? "" : cur.getString(4)))
                  .append("}");
                count++;
            }
            cur.close();
            return sb.append("]").toString();
        } catch (Exception e) { return "{\"error\":" + JSONObject.quote(String.valueOf(e)) + "}"; }
    }
}
