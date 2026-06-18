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
    // 账号标签实时状态: accountId → {convName, status}  (由切号面板追踪轮询经 Native.setTabStatus 推送)
    private static final java.util.Map<String, String[]> sTabStatus = new java.util.concurrent.ConcurrentHashMap<>();
    // 账号标签实时剩余美金: accountId/email → "$5"  (由切号面板 render() 随额度刷新经 Native.setTabDollars 推送, 显示在状态点左侧)
    private static final java.util.Map<String, String> sTabDollars = new java.util.concurrent.ConcurrentHashMap<>();

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Tab> tabs = new ArrayList<>();
    private int active = -1;
    private static final String PREFS = "rtflow_tabs";

    private int pageZoom = 100;           // 整页缩放百分比 (滑块控制, 解决长页点不到按钮)
    private TextView zoomLabel;
    private ValueCallback<Uri[]> filePathCallback;
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
    private FrameLayout dlPanel;
    private LinearLayout dlListCol;
    private FrameLayout daoPanel;          // 全服通悬浮窗 (近期对话 / 备份网页端)
    private WebView daoWeb;
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
    private volatile long updateDlId = -1;          // 当前更新下载任务 id (区别于普通网页下载)
    private volatile File updateApkFile = null;     // 更新 APK 落地文件

    static class Tab {
        WebView web;
        String title = "新标签";
        String url = "";
        String accountJson = null;   // 非空 = 账号标签 (注入鉴权)
        boolean internal = false;    // file:// 内部页 (暴露 Native 桥)
        String titleOverride = null; // 用户双击标签改的对话名 (优先显示·持久化)
        boolean incognito = false;   // 无痕标签: 不记历史/不持久化
        boolean desktop = false;     // 桌面版 UA
        boolean night = false;       // 夜间反色
        boolean translated = false;  // 整页翻译态 (跨页保持)
        String pendingReloadUrl = null; // 后台标签渲染进程被回收 → 延迟到选中时再重载 (避免多标签同时重载放大内存压力·消除卡死雪崩)
        boolean maybeStale = false;  // 长时间后台返回 → 渲染线程可能被系统冻结(看着正常但点击/下载等失效) → 选中/恢复时探活, 无响应则静默重载
        androidx.swiperefreshlayout.widget.SwipeRefreshLayout swipe; // 下拉刷新容器
    }
    private boolean adBlock = true;    // 广告/弹窗拦截: 默认内置开启 (无需用户操作·无开关)

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
        // 恢复上次标签 (持久化) 或首屏切号
        if (!restoreTabs()) {
            newTab(SWITCH, null);
        }
        autoCheckUpdate();   // 冷启动静默检查新版 (有则弹一次确认; 安装仍需用户点一次)
    }

    /** 冷启动后台静默检查更新; 有新版则弹一次确认框, 用户点「立即更新」即下载+唤起安装。 */
    private void autoCheckUpdate() {
        new Thread(() -> {
            try {
                String info = fetchUpdateInfo();
                JSONObject j = new JSONObject(info);
                if (!j.optBoolean("ok", false) || !j.optBoolean("hasUpdate", false)) return;
                final String name = j.optString("latestName", "");
                final String notes = j.optString("notes", "");
                org.json.JSONArray urls = j.optJSONArray("urls");
                final String url = (urls != null && urls.length() > 0) ? pickReachable(urls) : j.optString("url", "");
                if (url.isEmpty()) return;
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
            } catch (Exception ignored) {}
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

        Button menu = chipBtn("≡");
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

        Button go = chipBtnSm("→");
        go.setOnClickListener(v -> go(addr.getText().toString()));
        // 导航键(后退/前进/主页)已移入 ≡ → 页面工具收纳菜单 (基本用不到, 收起腾出工具栏空间)
        // 网页栏五角星：点击收藏/取消收藏当前页 (像浏览器) — 略放大更易点
        starBtn = chipBtnMd("\u2606");
        starBtn.setOnClickListener(v -> toggleBookmarkCurrent());
        // 刷新按钮：原地重载当前标签的 WebView（保留多实例登录态）
        Button reload = chipBtnMd("\u21BB");
        reload.setOnClickListener(v -> reloadActive());
        // 翻译按钮 (网址旁·一键整页翻译, 再点恢复原文) — 同电脑端 Chrome 体感
        Button tr = chipBtnSm("\u8BD1");
        tr.setOnClickListener(v -> toggleTranslate());
        // 下载管理悬浮窗按钮
        dlBtn = chipBtnMd("\uD83D\uDCE5");
        dlBtn.setOnClickListener(v -> toggleDownloadPanel());
        // 全服通悬浮窗按钮 (下载键右侧): 近期对话(跨号·实时) + 备份网页端
        daoBtn = chipBtnMd("\uD83D\uDDC2");
        daoBtn.setOnClickListener(v -> toggleDaoPanel());

        // 第一行: 菜单 + 地址 + 前往
        bar.addView(menu);
        bar.addView(addr);
        bar.addView(tr);
        bar.addView(go);

        // 第二行: 导航键 + 缩放滑块(weight自适应) + 收藏/刷新/下载
        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER_VERTICAL);
        btnRow.setBackgroundColor(0xFF161B22);
        btnRow.setPadding(dp(6), dp(1), dp(8), dp(4));
        btnRow.addView(zicon);
        btnRow.addView(zoomBar);
        btnRow.addView(zoomLabel);
        btnRow.addView(starBtn);
        btnRow.addView(reload);
        btnRow.addView(dlBtn);
        btnRow.addView(daoBtn);

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
        root.addView(btnRow);
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
        page.add(0, 26, 7, "导出整机分享包 (APK+全部数据)");
        page.add(0, 27, 8, "导入分享包 (换机同步)");
        android.view.SubMenu shareM = mu.addSubMenu(0, 101, 10, "分享 / 快捷");
        shareM.add(0, 30, 0, "分享本页");
        shareM.add(0, 31, 1, "复制网址");
        shareM.add(0, 32, 2, "添加到主屏");
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
            }
            return false;
        });
        m.show();
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
            String[] parts = hp.split(":");
            if (parts.length != 2) return;
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress(parts[0], Integer.parseInt(parts[1])), 400);
            } catch (Exception e) { return; }   // 代理已不在 → 不强行套用, 保持直连
            main.post(() -> applyWebViewProxy(hp));
        } catch (Exception ignored) {}
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
    private Tab makeTab(String accountJson, boolean internal) {
        final Tab tab = new Tab();
        tab.accountJson = accountJson;
        tab.internal = internal;
        WebView web = new WebView(this);
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
        if (accountJson != null) {
            String token = "", org = "", uid = "", orgName = "";
            try { JSONObject a = new JSONObject(accountJson); token = a.optString("auth1", ""); org = a.optString("orgId", "");
                uid = a.optString("userId", ""); orgName = a.optString("orgName", ""); } catch (Exception ignored) {}
            String script = TabActivity.buildInjection(token, uid, org, orgName);
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                try { WebViewCompat.addDocumentStartJavaScript(web, script, Collections.singleton("https://app.devin.ai")); } catch (Exception ignored) {}
            }
        }

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return handleExternalScheme(req.getUrl() == null ? null : req.getUrl().toString());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return handleExternalScheme(u); }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) {
                tab.url = u; if (tabOf(v) == active) setAddr(u);
                if (!tab.internal && u != null && u.startsWith("http")) injectUserScripts(v, u, "start"); // 油猴 @run-at document-start
            }
            @Override public void onPageFinished(WebView v, String u) {
                tab.url = u; renderTabStrip(); saveTabs();
                if (!tab.incognito) addHistory(u, tab.title, tab);   // 无痕标签不记历史
                if (pageZoom != 100) applyZoom(v);          // 缩放跨页/刷新保持
                if (tab.night) applyNight(v, true);          // 夜间反色跨页保持
                installDownloadHook(v);                      // blob:/data:/<a download> 下载 → 收进右上下载列表
                if (tab.swipe != null) tab.swipe.setRefreshing(false);
                if (!tab.internal && u != null && u.startsWith("http")) {
                    autoFillLogin(v, u);        // 有保存的账密 → 自动填充 (无感)
                    installLoginCapture(v);     // 监听登录提交 → 自动弹「保存登录？」
                    installKbHelper(v);         // 键盘弹出时输入框上滚到可见区中部 (不被遮挡)
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
                    renderTabStrip(); saveTabs();
                    // SPA 客户端路由后挂载点可能被替换 → 重装下载/键盘钩子(幂等), 修"切到对话页后点下载无反应、要刷新才行"。
                    if (!tab.internal) { installDownloadHook(v); installKbHelper(v); }
                }
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                if (adBlock && req != null && req.getUrl() != null && isAdHost(req.getUrl().getHost()))
                    return new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
                return super.shouldInterceptRequest(v, req);
            }
            // 渲染进程被系统在内存压力下回收(WebView 变白/无响应需手动刷新)→ 自动重建该标签并重载, 用户无感恢复。
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
                int idx = tabOf(v);
                if (idx < 0) { try { v.destroy(); } catch (Exception ignored) {} return true; }
                recoverDeadTab(idx);
                return true;   // 已处理: 系统不再杀进程
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onReceivedTitle(WebView v, String t) { if (t != null && !t.isEmpty()) { tab.title = t; renderTabStrip(); } }
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("RTFlowJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
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
                    Tab nt = makeTab(null, false);
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
                main.post(() -> { try { request.grant(request.getResources()); } catch (Exception ignored) {} });
            }
        });

        // 下载: 走系统 DownloadManager (附件/导出文件落到「下载」目录)
        web.setDownloadListener((dlUrl, ua, contentDisposition, mimetype, len) ->
                startDownload(dlUrl, ua, contentDisposition, mimetype));

        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 三击页面任意处 → 刷新一次 (刷新高频, 省去每次去点右上角小按钮)。仅观察手势不消费事件 (return false),
        // 故单击/双击/上下左右滑动/长按拖拽/缩放等原有交互一律不受影响。
        final WebView webRef = web;
        final int tapSlop = android.view.ViewConfiguration.get(this).getScaledTouchSlop();
        final long[] tapLast = new long[]{0L};   // 上次有效轻点的时间
        final int[] tapCnt = new int[]{0};        // 连续轻点计数
        final float[] tapDown = new float[]{0f, 0f};
        final long[] tapDownT = new long[]{0L};
        web.setOnTouchListener((v, ev) -> {
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
                        tapCnt[0] = (now - tapLast[0] < 500) ? tapCnt[0] + 1 : 1;
                        tapLast[0] = now;
                        if (tapCnt[0] >= 3) {
                            tapCnt[0] = 0;
                            Tab a = cur();
                            if (a != null && a.web == webRef) { try { webRef.reload(); toast("已刷新"); } catch (Exception ignored) {} }
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

    /** 把标签的视图停泊到常驻 INVISIBLE 容器 autoHost (保持挂载窗口与尺寸); 活动标签由 selectTab 提到 content 顶层。 */
    private void parkHost(Tab t) {
        if (t == null || autoHost == null) return;
        android.view.View host = t.swipe != null ? t.swipe : t.web;
        if (host == null || host.getParent() == autoHost) return;
        if (host.getParent() != null) ((ViewGroup) host.getParent()).removeView(host);
        autoHost.addView(host, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
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
        try {
            // 只在真的卡 hidden 时才切可见性纠正 → 正常切标签无闪烁。
            w.evaluateJavascript("(function(){try{return document.visibilityState;}catch(e){return 'x';}})()", val -> {
                if (val == null || !val.contains("hidden")) return;
                try {
                    if (w.getVisibility() == android.view.View.VISIBLE) {
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
        tabStripRow.removeAllViews();
        for (int i = 0; i < tabs.size(); i++) {
            final int idx = i;
            Tab t = tabs.get(i);
            LinearLayout chip = new LinearLayout(this);
            chip.setOrientation(LinearLayout.HORIZONTAL);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setBackgroundColor(idx == active ? 0xFF1F3A45 : 0xFF1B1F26);
            chip.setPadding(dp(10), dp(5), dp(6), dp(5));
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.rightMargin = dp(4);
            chip.setLayoutParams(clp);

            TextView label = new TextView(this);
            label.setText(chipTitle(t));
            label.setTextColor(idx == active ? 0xFF9CDCFE : 0xFFAAB2BD);
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
            chip.addView(x);
            chip.setTag(idx);
            tabStripRow.addView(chip);
        }
        Button plus = chipBtn("+");
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

    @Override public void onBackPressed() {
        if (daoPanel != null) { closeDaoPanel(); return; }     // 返回键先关全服通悬浮窗
        if (dlPanel != null) { closeDownloadPanel(); return; }
        if (active >= 0 && tabs.get(active).web.canGoBack()) { tabs.get(active).web.goBack(); return; }
        super.onBackPressed();
    }

    /** 原地刷新当前标签的 WebView：同一实例 reload，sessionStorage 隔离的登录态不丢。 */
    private void reloadActive() {
        if (active >= 0 && active < tabs.size() && tabs.get(active).web != null) {
            tabs.get(active).web.reload();
            toast("刷新中…");
        } else {
            toast("无可刷新页面");
        }
    }

    // ── 浏览器功能 ────────────────────────────────────────────────────────
    private static final String DESKTOP_UA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
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
        try { tab.web.getSettings().setSaveFormData(false); } catch (Exception ignored) {}
        loadInto(tab, url);
        selectTab(tabs.size() - 1);
        renderTabStrip();
        toast("无痕标签 (不记历史)");
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
        // ── 在线自动更新 (面板/引擎/中继共用) ──
        @JavascriptInterface public String appCheckUpdate() { return fetchUpdateInfo(); }
        @JavascriptInterface public String appInstallUpdate(String url) { return startUpdate(url); }
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
        /** 全服通「进入」: 切到该对话所属账号(WAM 注入鉴权) 并前台打开该对话网页页, 同时关掉全服通悬浮窗露出网页。
         *  网页 URL 用去掉 devin- 前缀的 id (app.devin.ai/sessions/<hex>), 与浏览器地址栏一致。 */
        @JavascriptInterface public void openAccountSession(String accJson, String sid) {
            main.post(() -> {
                String s = (sid == null) ? "" : sid.trim();
                if (s.startsWith("devin-")) s = s.substring(6);
                String u = s.isEmpty() ? DEVIN : ("https://app.devin.ai/sessions/" + s);
                newTab(u, (accJson == null || accJson.isEmpty()) ? null : accJson);
                if (daoPanel != null) closeDaoPanel();
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
            if (accountId == null || accountId.isEmpty()) return;
            sTabStatus.put(accountId, new String[]{ convName == null ? "" : convName, status == null ? "" : status });
            main.post(MainActivity.this::renderTabStrip);
        }
        /** 切号面板随额度刷新 → 推送该账号实时剩余美金 ("$5"/空), 显示在页签状态点左侧便于管理。 */
        @JavascriptInterface public void setTabDollars(String accountId, String dollars) {
            if (accountId == null || accountId.isEmpty()) return;
            if (dollars == null) dollars = "";
            if (dollars.isEmpty()) sTabDollars.remove(accountId); else sTabDollars.put(accountId, dollars);
            main.post(MainActivity.this::renderTabStrip);
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
        /** 把文本(对话 MD/知识库/剧本等)落地到系统「下载」目录 — 单一对话下载到本地。 */
        @JavascriptInterface public String saveTextFile(String name, String content) {
            try {
                String safe = (name == null || name.trim().isEmpty()) ? ("rtflow-" + System.currentTimeMillis() + ".md") : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                File dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, safe);
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
                }
                final File ff = f; final String fn = safe;
                main.post(() -> { MainActivity.this.addDownloadRecord(fn, ff.getAbsolutePath(), "text/markdown", ff.length()); MainActivity.this.toast("已下载: " + fn); });
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
        @JavascriptInterface public String saveBase64File(String name, String base64) {
            try {
                String safe = (name == null || name.trim().isEmpty()) ? ("rtflow-" + System.currentTimeMillis() + ".bin") : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                File dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, safe);
                byte[] data = android.util.Base64.decode(base64 == null ? "" : base64, android.util.Base64.DEFAULT);
                try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(data); }
                final File ff = f; final String fn = safe;
                main.post(() -> { MainActivity.this.addDownloadRecord(fn, ff.getAbsolutePath(), "application/octet-stream", ff.length()); MainActivity.this.toast("已下载: " + fn); });
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

    private void startDownload(String url, String ua, String contentDisposition, String mime) {
        // blob:/data: 无法走系统 DownloadManager → 转 JS 取内容, 统一收进应用内下载列表
        if (url != null && url.startsWith("blob:")) { captureBlobDownload(url); return; }
        if (url != null && url.startsWith("data:")) { captureDataUrl(url, contentDisposition); return; }
        try {
            String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mime);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (mime != null) req.setMimeType(mime);
            if (ua != null) req.addRequestHeader("User-Agent", ua);
            String cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // 落到应用专属外部目录 → 由应用内下载管理器统一展示/打开/拖拽
            req.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) { long id = dm.enqueue(req); dlPending.put(id, new String[]{ name, mime == null ? "" : mime }); toast("开始下载: " + name); }
        } catch (Exception e) { toast("下载失败: " + (e.getMessage() == null ? "" : e.getMessage())); }
    }

    // 页面内 <a download> / blob: / data: 下载捕获脚本 (每个页面加载完安装一次)
    private void installDownloadHook(WebView w) {
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
    // 键盘弹出时把聚焦的输入框滚到可见区中部 (配合 windowSoftInputMode=adjustResize):
    //   消除"输入框被键盘遮住 / 弹来弹去", 体感对齐真浏览器。幂等(window.__rtkb 守卫), SPA 路由后可重装。
    private void installKbHelper(WebView w) {
        if (w == null) return;
        String js = "(function(){if(window.__rtkb)return;window.__rtkb=1;"
            + "var T=null;function sif(el){if(!el)return;clearTimeout(T);T=setTimeout(function(){try{el.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});}catch(e){try{el.scrollIntoView();}catch(_){}}},220);}"
            + "function isF(t){return t&&t.matches&&t.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable=\"\"],[contenteditable=true],[role=textbox]');}"
            + "document.addEventListener('focusin',function(e){if(isF(e.target))sif(e.target);},true);"
            + "if(window.visualViewport){window.visualViewport.addEventListener('resize',function(){var a=document.activeElement;if(isF(a))sif(a);});}"
            + "})();";
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
            main.post(() -> { addDownloadRecord(ff.getName(), ff.getAbsolutePath(), fmime, sz); toast("下载完成: " + ff.getName()); });
        } catch (Exception e) { main.post(() -> toast("下载失败")); }
    }

    // ── 应用内下载管理器 + 可拖拽悬浮窗 ───────────────────────────────────────
    private void onDownloadComplete(long id) {
        if (id == updateDlId) { onUpdateDownloaded(id); return; }   // 更新包: 唤起安装器
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
                String[] meta = dlPending.remove(id);
                if (st == DownloadManager.STATUS_SUCCESSFUL && localUri != null) {
                    String path = Uri.parse(localUri).getPath();
                    if (path == null) return;
                    String name = meta != null ? meta[0] : new File(path).getName();
                    String mime = (meta != null && !meta[1].isEmpty()) ? meta[1] : (mediaType == null ? "*/*" : mediaType);
                    // 从应用沙箱搬到共享保险箱 downloads → 卸载/重装不丢
                    File persisted = persistToVault(new File(path), name);
                    addDownloadRecord(name, persisted.getAbsolutePath(), mime, persisted.length());
                    toast("下载完成: " + name);
                } else if (st == DownloadManager.STATUS_FAILED) {
                    toast("下载失败");
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

    /** 拉取在线版本清单并与本机比对。多镜像轮询 (去中心化, 任一可达即可)。后台线程调用。返回 JSON 串。 */
    String fetchUpdateInfo() {
        String lastErr = "无可用镜像";
        for (String murl : UPDATE_MIRRORS) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(murl).openConnection();
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
                int latest = m.optInt("versionCode", 0);
                int cur = currentVersionCode();
                String url = m.optString("url", "");
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("current", cur);
                out.put("latest", latest);
                out.put("latestName", m.optString("versionName", ""));
                out.put("hasUpdate", latest > cur);
                out.put("url", url);
                out.put("urls", apkMirrors(url));
                out.put("notes", m.optString("notes", ""));
                out.put("source", murl);
                return out.toString();
            } catch (Exception e) {
                lastErr = String.valueOf(e.getMessage()) + " @ " + murl;
            } finally { if (c != null) c.disconnect(); }
        }
        return "{\"ok\":false,\"error\":" + JSONObject.quote(lastErr) + "}";
    }

    /** 触发更新: 下载最新 APK, 完成后自动唤起系统安装器 (用户点一次「安装」)。url 空则先取清单。 */
    String startUpdate(final String urlIn) {
        try {
            String url = urlIn;
            if (url == null || url.isEmpty()) {
                JSONObject j = new JSONObject(fetchUpdateInfo());
                if (!j.optBoolean("ok", false)) return j.toString();
                if (!j.optBoolean("hasUpdate", false))
                    return "{\"ok\":true,\"hasUpdate\":false,\"msg\":\"已是最新版\",\"current\":" + j.optInt("current") + "}";
                org.json.JSONArray urls = j.optJSONArray("urls");
                url = (urls != null && urls.length() > 0) ? pickReachable(urls) : j.optString("url", "");
            }
            if (url.isEmpty()) return "{\"ok\":false,\"error\":\"清单无下载地址 url\"}";
            final String furl = url;
            main.post(() -> enqueueUpdateDownload(furl));
            return "{\"ok\":true,\"downloading\":true,\"url\":" + JSONObject.quote(furl) + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }

    private void enqueueUpdateDownload(String url) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) { toast("更新失败: 无下载服务"); return; }
            File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
            updateApkFile = new File(dir, "DevinCloud-update.apk");
            if (updateApkFile.exists()) updateApkFile.delete();
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("Devin Cloud 手机版 · 更新下载中");
            req.setMimeType("application/vnd.android.package-archive");
            req.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, "DevinCloud-update.apk");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            updateDlId = dm.enqueue(req);
            toast("正在下载更新…");
        } catch (Exception e) { toast("更新失败: " + e.getMessage()); }
    }

    private void onUpdateDownloaded(long id) {
        updateDlId = -1;
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                android.database.Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id));
                if (cur != null) {
                    try {
                        if (cur.moveToFirst()) {
                            int st = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                            if (st != DownloadManager.STATUS_SUCCESSFUL) { toast("更新下载失败"); return; }
                        }
                    } finally { cur.close(); }
                }
            }
            if (updateApkFile == null || !updateApkFile.exists()) { toast("更新包未找到"); return; }
            installApk(updateApkFile);
        } catch (Exception e) { toast("更新失败: " + e.getMessage()); }
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
                if (new File(e.optString("file", "")).exists()) keep.put(e);
            }
            sp.edit().putString("downloads", keep.toString()).apply();
            if (keep.length() != arr.length()) vaultWrite("downloads", keep.toString());
        } catch (Exception ignored) {}
    }

    private void addDownloadRecord(String name, String path, String mime, long size) {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("downloads", "[]"));
            org.json.JSONObject e = new org.json.JSONObject();
            e.put("name", name); e.put("file", path); e.put("mime", mime); e.put("size", size); e.put("ts", System.currentTimeMillis());
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
        if (daoPanel != null) { closeDaoPanel(); return; }
        showDaoPanel();
    }
    private void closeDaoPanel() {
        if (daoWeb != null) { try { daoWeb.destroy(); } catch (Exception ignored) {} daoWeb = null; }
        if (daoPanel != null && daoPanel.getParent() != null) ((ViewGroup) daoPanel.getParent()).removeView(daoPanel);
        daoPanel = null;
    }
    private void showDaoPanel() {
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
        close.setOnClickListener(v -> closeDaoPanel());
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
        content.addView(panel);
        web.loadUrl(DP_URL);
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
                if (v == daoWeb) { closeDaoPanel(); }
                else { try { v.destroy(); } catch (Exception ignored) {} }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("RTFlowJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
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
                TextView sub = new TextView(this);
                sub.setText((f.exists() ? humanSize(f.length()) : "(文件已删)") + " · 点击打开 · 长按拖拽");
                sub.setTextColor(0xFF8B949E); sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                txt.addView(nm); txt.addView(sub);
                Button more = chipBtnSm("\u22EE");
                more.setOnClickListener(v -> showDownloadActions(v, recIdx, path, name, mime));
                row.addView(txt); row.addView(more);
                txt.setOnClickListener(v -> openDownloaded(path, mime));
                txt.setOnLongClickListener(v -> { dragDownloaded(v, path, mime); return true; });
                listCol.addView(row);
            }
        } catch (Exception ignored) {}
    }
    /** 下载项动作: 用其它应用打开 / 重命名 / 删除。 */
    private void showDownloadActions(View anchor, int recIdx, String path, String name, String mime) {
        PopupMenu pm = new PopupMenu(this, anchor);
        pm.getMenu().add(0, 1, 0, "用其它应用打开");
        pm.getMenu().add(0, 2, 1, "重命名");
        pm.getMenu().add(0, 3, 2, "删除");
        pm.setOnMenuItemClickListener(it -> {
            switch (it.getItemId()) {
                case 1: openWithChooser(path, mime); return true;
                case 2: renameDownload(recIdx, path, name); return true;
                case 3: deleteDownload(recIdx, path); return true;
            }
            return false;
        });
        pm.show();
    }
    private void openWithChooser(String path, String mime) {
        try {
            File f = new File(path); if (!f.exists()) { toast("文件已不存在"); return; }
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(fileUri(path), (mime == null || mime.isEmpty()) ? "*/*" : mime);
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
    private void openDownloaded(String path, String mime) {
        try {
            File f = new File(path);
            if (!f.exists()) { toast("文件已不存在"); return; }
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(fileUri(path), (mime == null || mime.isEmpty()) ? "*/*" : mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) { toast("无法打开此文件"); }
    }
    private void dragDownloaded(View v, String path, String mime) {
        try {
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            doVibrate(30);
            dragDlPath = path;                                       // 供网页 WebView 的 drop 监听注入
            dragDlMime = (mime == null || mime.isEmpty()) ? "*/*" : mime;
            Uri uri = fileUri(path);
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
                    if (daoPanel != null) daoPanel.setVisibility(View.VISIBLE);   // 拖拽时临时隐藏的全服通窗 → 恢复
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
            if (zipName != null && !zipName.isEmpty() && hasFiles > 0) {
                final String zb64 = vaultReadBackupB64(folder, zipName);
                if (zb64 != null && !zb64.isEmpty()) {
                    main.post(() -> {
                        java.util.List<String[]> files = new java.util.ArrayList<>();
                        files.add(new String[]{ base + ".zip", zb64 });
                        files.add(new String[]{ base + "-files-access.md", b64Utf8(guide) });
                        dropB64FilesIntoPage(target, x, y, files);
                        toast("本地备份·秒注入 文件夹ZIP(" + hasFiles + "件) + 取数指引");
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
            + "fetch('/api/events/'+SID+'/stream',{headers:{Accept:'text/event-stream'},credentials:'include'}).then(function(r){return r.text();}).then(function(raw){"
            + "var evs=pe(raw);"
            + "return fetch('/api/sessions/'+SID,{credentials:'include'}).then(function(r){return r.ok?r.json():{};}).catch(function(){return {};}).then(function(d){"
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
    private int appVersionCode() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    // ── 标签会话持久化 (重开恢复上次标签/登录状态) ──────────────────────────
    private void saveTabs() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (int i = 0; i < tabs.size(); i++) {
                Tab t = tabs.get(i);
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("url", displayUrl(t));
                if (t.accountJson != null) o.put("account", t.accountJson);
                o.put("title", t.title);
                if (t.titleOverride != null) o.put("titleOverride", t.titleOverride);
                arr.put(o);
            }
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            sp.edit().putString("tabs", arr.toString()).putInt("active", active).apply();
            org.json.JSONObject vault = new org.json.JSONObject();
            vault.put("tabs", arr); vault.put("active", active);
            vaultWrite("tabs", vault.toString());
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
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject o = arr.getJSONObject(i);
                String url = o.optString("url", SWITCH);
                String acc = o.has("account") ? o.getString("account") : null;
                Tab nt = newTab(url, acc);
                if (o.has("titleOverride")) { nt.titleOverride = o.optString("titleOverride", null); }
            }
            if (act >= 0 && act < tabs.size()) selectTab(act);
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
            sb.append(".it{display:flex;align-items:center;border-bottom:1px solid #21262d}");
            sb.append(".it.dv{border-left:3px solid #2ea043}");
            sb.append(".it .row{flex:1;min-width:0;padding:9px 8px}");
            sb.append(".it .row:active{background:#1f3a45}");
            sb.append(".it .t{color:#e6edf3;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".it .u{color:#8b949e;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".more{padding:10px 12px;color:#8b949e;font-size:18px;user-select:none}.more:active{color:#fff}");
            sb.append(".ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:flex-end;z-index:99}");
            sb.append(".ov.on{display:flex}");
            sb.append(".sheet{background:#161b22;width:100%;border-radius:14px 14px 0 0;padding:4px 0 calc(10px + env(safe-area-inset-bottom));box-shadow:0 -4px 20px rgba(0,0,0,.5)}");
            sb.append(".sh-u{color:#8b949e;font-size:12px;padding:12px 16px 10px;border-bottom:1px solid #21262d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".sh-b{padding:14px 16px;color:#e6edf3;font-size:15px}.sh-b:active{background:#1f6feb33}.sh-b.del{color:#ff7b72}");
            sb.append("</style></head><body>");
            sb.append("<h2>").append(escapeHtml(h2)).append("</h2>");
            if (dvHeader != null) {
                sb.append("<div class='sec'>").append(dvHeader).append("</div>");
                for (int i = 0; i < dvItems.length(); i++) { int idx = IT.length(); IT.put(dvItems.getJSONObject(i)); appendRow(sb, dvItems.getJSONObject(i), idx, true); }
                if (dvItems.length() == 0) sb.append("<div style='color:#6e7681;padding:10px 4px'>").append(escapeHtml(dvEmpty)).append("</div>");
            }
            sb.append("<div class='sec b'>").append(nmHeader).append("</div>");
            for (int i = 0; i < nmItems.length(); i++) { int idx = IT.length(); IT.put(nmItems.getJSONObject(i)); appendRow(sb, nmItems.getJSONObject(i), idx, false); }
            if (nmItems.length() == 0) sb.append("<div style='color:#6e7681;padding:10px 4px'>").append(escapeHtml(nmEmpty)).append("</div>");
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
            // 行: 点击打开; 长按 → 动作菜单
            sb.append("var LT;document.addEventListener('touchstart',function(ev){var r=ev.target.closest&&ev.target.closest('.row');if(!r)return;var i=+r.parentNode.getAttribute('data-i');LT=setTimeout(function(){LT=0;sheet(i);},480);},{passive:true});");
            sb.append("document.addEventListener('touchend',function(ev){if(LT){clearTimeout(LT);LT=0;}},{passive:true});");
            sb.append("document.addEventListener('touchmove',function(ev){if(LT){clearTimeout(LT);LT=0;}},{passive:true});");
            sb.append("document.addEventListener('click',function(ev){var m=ev.target.closest&&ev.target.closest('.more');if(m){ev.stopPropagation();sheet(+m.getAttribute('data-i'));return;}var r=ev.target.closest&&ev.target.closest('.row');if(r){openIdx(+r.parentNode.getAttribute('data-i'));}});");
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
            if (t != null && t.web != null && !t.internal) resumeWeb(t.web);
            main.postDelayed(this, VIS_WATCH_MS);
        }
    };

    @Override protected void onPause() {
        super.onPause();
        appForeground = false;
        main.removeCallbacks(visWatchdog);
        bgSince = System.currentTimeMillis();
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) {} // 持久化其它网站登录 Cookie
        saveTabs();
    }

    /** 探活: 向标签 WebView 注入一句极简 JS; 若在超时内无回调 → 渲染线程被冻结/卡死 → 静默重载, 用户无需手动刷新。
     *  仅在确判可能僵死时调用(长后台返回), 健康页面探活即过, 不重载 → 不丢滚动/表单。 */
    private void probeTabLiveness(final Tab t) {
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
            try { w.reload(); } catch (Exception ignored) {}   // 无响应 → 冻死, 静默重载恢复交互
        }, 2500);
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
        } catch (Exception ignored) {}
    }

    @Override protected void onResume() {
        super.onResume();
        appForeground = true;
        // 回到前台: 立即把当前可见标签拉回「可见+计时器运行」(根治"放久了点下载/交互失效需手动刷新")。
        Tab act = cur();
        if (act != null) resumeWeb(act.web);
        // 持续看门狗: 前台期间每 8s 检一次, 若当前页 visibilityState 卡 hidden 则静默拉回, 无需用户操作。
        main.removeCallbacks(visWatchdog);
        main.postDelayed(visWatchdog, VIS_WATCH_MS);
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
        saveTabs();
        try { if (dlReceiver != null) unregisterReceiver(dlReceiver); } catch (Exception ignored) {}
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) {}
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
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            if (i > 0) sb.append(",");
            sb.append("{\"index\":").append(i)
              .append(",\"url\":").append(JSONObject.quote(t.url == null ? "" : t.url))
              .append(",\"title\":").append(JSONObject.quote(t.title == null ? "" : t.title))
              .append(",\"account\":").append(safeTabAccount(t.accountJson))
              .append(",\"internal\":").append(t.internal)
              .append(",\"active\":").append(i == active)
              .append("}");
        }
        return sb.append("]").toString();
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
