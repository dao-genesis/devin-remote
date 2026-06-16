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
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.net.Uri;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import android.content.SharedPreferences;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * MainActivity · RT Flow 手机版浏览器外壳 (地址栏 + 多标签 + 内部页)。
 *   - 内部页 rtflow://switch (切号·复用 RT Flow 真前端) / rtflow://tunnel (公网穿透·复用 dao-bridge 真前端)
 *   - 账号标签: 每个标签是独立 WebView, document_start 注入各自 auth1 鉴权头 + sessionStorage 隔离 = 多实例并行互不干扰
 *   - 常驻前台服务 (RelayService) 跑引擎 + 内网穿透; 浏览器外壳与引擎共享 file:// 同源 localStorage 账号库
 */
public class MainActivity extends AppCompatActivity {

    static final String SWITCH = "rtflow://switch";
    static final String TUNNEL = "rtflow://tunnel";
    static final String CLOUD = "rtflow://cloud";
    static final String VPN = "rtflow://vpn";
    static final String DEVIN = "https://app.devin.ai/";
    private static final String SW_URL = "file:///android_asset/engine/switch.html";
    private static final String TU_URL = "file:///android_asset/engine/tunnel.html";
    private static final String CL_URL = "file:///android_asset/engine/cloud.html";
    private static final String VPN_URL = "file:///android_asset/engine/vpn.html";

    // 搜索引擎 (国内环境可切百度) — 持久化于 SharedPreferences
    private static final String PREF_SEARCH = "search_engine";
    // 账号标签实时状态: accountId → {convName, status}  (由切号面板追踪轮询经 Native.setTabStatus 推送)
    private static final java.util.Map<String, String[]> sTabStatus = new java.util.concurrent.ConcurrentHashMap<>();

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Tab> tabs = new ArrayList<>();
    private int active = -1;
    private static final String PREFS = "rtflow_tabs";

    private ValueCallback<Uri[]> filePathCallback;
    private androidx.activity.result.ActivityResultLauncher<Intent> fileChooser;

    private FrameLayout content;
    private LinearLayout tabStripRow;
    private EditText addr;
    private Button dlBtn;

    static class Tab {
        WebView web;
        String title = "新标签";
        String url = "";
        String accountJson = null;   // 非空 = 账号标签 (注入鉴权)
        boolean internal = false;    // file:// 内部页 (暴露 Native 桥)
        String titleOverride = null; // 用户双击标签改的对话名 (优先显示·持久化)
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        fileChooser = registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> cb = filePathCallback; filePathCallback = null;
            if (cb == null) return;
            Uri[] uris = null;
            Intent data = result.getData();
            if (result.getResultCode() == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    uris = new Uri[]{ data.getData() };
                }
            }
            cb.onReceiveValue(uris);
        });
        startRelay();
        // Token 冷启动轮换由 RelayService 引擎页 (engine.html) 在服务冷启动时执行,
        // 该服务为 START_STICKY 前台常驻 → 仅手动重开(进程被杀后重建)时刷新, 后台恢复不刷, 符合预期。
        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);
        setContentView(buildChrome());
        ensureAllFilesAccess();   // 申请「所有文件访问」→ 账号/标签/历史落到共享文件夹, 卸载重装不丢
        // 恢复上次标签 (持久化) 或首屏切号
        if (!restoreTabs()) {
            newTab(SWITCH, null);
        }
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

        Button go = chipBtn("→");
        go.setOnClickListener(v -> go(addr.getText().toString()));

        // 最右侧刷新按钮：原地重载当前标签的 WebView（保留多实例登录态）
        Button reload = chipBtn("\u21BB");
        reload.setOnClickListener(v -> reloadActive());

        bar.addView(menu);
        bar.addView(addr);
        bar.addView(go);
        bar.addView(reload);

        // 标签条
        HorizontalScrollView strip = new HorizontalScrollView(this);
        strip.setHorizontalScrollBarEnabled(false);
        strip.setBackgroundColor(0xFF0E1116);
        tabStripRow = new LinearLayout(this);
        tabStripRow.setOrientation(LinearLayout.HORIZONTAL);
        tabStripRow.setPadding(dp(4), dp(3), dp(4), dp(3));
        strip.addView(tabStripRow);

        content = new FrameLayout(this);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        content.setLayoutParams(clp);

        // 右上角下载管理悬浮按钮 (避免遮挡页面底部内容)
        dlBtn = new Button(this);
        dlBtn.setText("📥");
        dlBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        dlBtn.setBackgroundColor(0xCC1F6FEB);
        dlBtn.setTextColor(0xFFFFFFFF);
        dlBtn.setMinWidth(0); dlBtn.setMinimumWidth(0);
        dlBtn.setPadding(dp(10), dp(8), dp(10), dp(8));
        FrameLayout.LayoutParams dlp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dlp.gravity = Gravity.TOP | Gravity.END;
        dlp.rightMargin = dp(12); dlp.topMargin = dp(8);
        dlBtn.setLayoutParams(dlp);
        dlBtn.setOnClickListener(v -> {
            try { startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)); }
            catch (Exception e) { toast("无法打开下载管理"); }
        });

        root.addView(bar);
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

    private void showMenu(View anchor) {
        PopupMenu m = new PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, "切号面板");
        m.getMenu().add(0, 6, 1, "对话 / Cloud");
        m.getMenu().add(0, 2, 2, "公网穿透");
        m.getMenu().add(0, 10, 3, "VPN 加速");
        m.getMenu().add(0, 3, 4, "新标签 (Devin)");
        m.getMenu().add(0, 9, 5, "浏览历史");
        m.getMenu().add(0, 12, 6, "书签收藏");
        m.getMenu().add(0, 13, 7, "收藏本页");
        m.getMenu().add(0, 11, 8, "搜索引擎: " + ("baidu".equals(searchEngine()) ? "百度" : "Google"));
        m.getMenu().add(0, 5, 9, "重连内网穿透");
        m.setOnMenuItemClickListener(it -> {
            switch (it.getItemId()) {
                case 1: newTab(SWITCH, null); return true;
                case 6: newTab(CLOUD, null); return true;
                case 2: newTab(TUNNEL, null); return true;
                case 10: newTab(VPN, null); return true;
                case 3: newTab(DEVIN, null); return true;
                case 9: showHistory(); return true;
                case 12: showBookmarks(); return true;
                case 13: { Tab cur = (active >= 0 && active < tabs.size()) ? tabs.get(active) : null; if (cur != null) addBookmark(displayUrl(cur), chipTitle(cur)); return true; }
                case 11: toggleSearchEngine(); return true;
                case 5: stopService(new Intent(this, RelayService.class)); startRelay(); toast("已请求重连内网穿透"); return true;
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

    private String searchEngine() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String def = java.util.Locale.getDefault().getCountry().equalsIgnoreCase("CN") ? "baidu" : "google";
        return sp.getString(PREF_SEARCH, def);
    }
    private void toggleSearchEngine() {
        String next = "baidu".equals(searchEngine()) ? "google" : "baidu";
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_SEARCH, next).apply();
        toast("搜索引擎已切换: " + ("baidu".equals(next) ? "百度" : "Google"));
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
        }

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
            }
            @Override public void onPageFinished(WebView v, String u) {
                tab.url = u; renderTabStrip(); saveTabs(); addHistory(u, tab.title);
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
                Intent intent;
                try { intent = params.createIntent(); }
                catch (Exception e) { intent = new Intent(Intent.ACTION_GET_CONTENT); intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE); }
                if (intent.getType() == null) intent.setType("*/*");
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { fileChooser.launch(Intent.createChooser(intent, "选择要上传的文件")); }
                catch (Exception e) { filePathCallback = null; toast("无法打开文件选择器"); return false; }
                return true;
            }
            // 新窗口 (window.open / target=_blank): 开一个新标签承接 → 修登录其他网页/弹窗跳转
            @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture, android.os.Message resultMsg) {
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
        tabs.add(tab);
        return tab;
    }

    private void loadInto(Tab tab, String url) {
        String real = url;
        if (SWITCH.equals(url)) { real = SW_URL; tab.internal = true; }
        else if (TUNNEL.equals(url)) { real = TU_URL; tab.internal = true; }
        else if (CLOUD.equals(url)) { real = CL_URL; tab.internal = true; }
        else if (VPN.equals(url)) { real = VPN_URL; tab.internal = true; }
        tab.url = real;
        tab.web.loadUrl(real);
    }

    private int tabOf(WebView v) { for (int i = 0; i < tabs.size(); i++) if (tabs.get(i).web == v) return i; return -1; }

    private void selectTab(int idx) {
        if (idx < 0 || idx >= tabs.size()) return;
        active = idx;
        content.removeAllViews();
        Tab t = tabs.get(idx);
        if (t.web.getParent() != null) ((ViewGroup) t.web.getParent()).removeView(t.web);
        content.addView(t.web);
        // 悬浮下载按钮置顶 (在 WebView 之上)
        if (dlBtn != null) {
            if (dlBtn.getParent() != null) ((ViewGroup) dlBtn.getParent()).removeView(dlBtn);
            content.addView(dlBtn);
        }
        setAddr(displayUrl(t));
        renderTabStrip();
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
        try { if (t.web.getParent() != null) ((ViewGroup) t.web.getParent()).removeView(t.web); t.web.destroy(); } catch (Exception ignored) {}
        if (tabs.isEmpty()) { newTab(SWITCH, null); return; }
        selectTab(Math.max(0, idx - 1));
    }

    private void setAddr(String u) { if (addr != null) addr.setText(u == null ? "" : u); }

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
            // 手势: 单击=切换标签 · 双击=复制该账号+密码(弹提示) · 长按=拖拽排序
            final GestureDetector gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onDown(MotionEvent e) { return true; }
                @Override public boolean onSingleTapConfirmed(MotionEvent e) { selectTab(idx); return true; }
                @Override public boolean onDoubleTap(MotionEvent e) {
                    Tab tt = tabs.get(idx);
                    if (tt.accountJson != null) copyTabAccount(tt); else toast("非账号标签·无账密可复制");
                    return true;
                }
                @Override public void onLongPress(MotionEvent e) { startTabDrag(chip, idx); }
            });
            chip.setOnTouchListener((v, ev) -> gd.onTouchEvent(ev));

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
        if (ev.getAction() == DragEvent.ACTION_DROP) {
            try {
                int from = Integer.parseInt(ev.getClipDescription().getLabel().toString());
                int to = dropIndex(ev.getX());
                moveTab(from, to);
            } catch (Exception ignored) {}
            return true;
        }
        return ev.getAction() == DragEvent.ACTION_DRAG_STARTED
                || ev.getAction() == DragEvent.ACTION_DRAG_ENTERED
                || ev.getAction() == DragEvent.ACTION_DRAG_LOCATION
                || ev.getAction() == DragEvent.ACTION_DRAG_EXITED
                || ev.getAction() == DragEvent.ACTION_DRAG_ENDED;
    };

    private void startTabDrag(View chip, int idx) {
        try {
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
                case 3: addBookmark(t.url, chipTitle(t)); return true;
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
                String[] sta = sTabStatus.get(id);
                if (sta == null) sta = sTabStatus.get(email);
                if (sta != null && sta[0] != null && !sta[0].isEmpty()) {
                    String dot = statusDot(sta[1]);
                    String name = sta[0].length() > 12 ? sta[0].substring(0, 11) + "…" : sta[0];
                    return dot + name;
                }
                return email.length() > 14 ? email.substring(0, 13) + "…" : email;
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

    @Override public void onBackPressed() {
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
        @JavascriptInterface public String conn() {
            RelayService r = RelayService.instance;
            return r != null ? r.readConn() : "{}";
        }
        @JavascriptInterface public String relayStatus() { return RelayService.lastStatus; }
        @JavascriptInterface public void relayRestart() { main.post(() -> { stopService(new Intent(MainActivity.this, RelayService.class)); startRelay(); }); }
        @JavascriptInterface public void saveRelayConfig(String json) {
            RelayService r = RelayService.instance;
            if (r != null) r.saveRelayConfig(json == null ? "{}" : json);
        }
        @JavascriptInterface public void clip(String text) {
            main.post(() -> {
                try { ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("rtflow", text == null ? "" : text)); } catch (Exception ignored) {}
            });
        }
        @JavascriptInterface public void toast(String s) { MainActivity.this.toast(s == null ? "" : s); }
        @JavascriptInterface public void openAccountTab(String accJson) { main.post(() -> newTab(DEVIN, accJson)); }
        @JavascriptInterface public void openUrlTab(String url) { main.post(() -> newTab(url == null ? DEVIN : url, null)); }
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
        /** 切号面板追踪轮询 → 推送该账号最活跃对话名+状态, 用于顶部标签实时显示。 */
        @JavascriptInterface public void setTabStatus(String accountId, String convName, String status) {
            if (accountId == null || accountId.isEmpty()) return;
            sTabStatus.put(accountId, new String[]{ convName == null ? "" : convName, status == null ? "" : status });
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
                main.post(() -> MainActivity.this.toast("已下载: " + safe));
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
                main.post(() -> MainActivity.this.toast("已下载: " + safe));
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
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (mime != null) req.setMimeType(mime);
            if (ua != null) req.addRequestHeader("User-Agent", ua);
            String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mime);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) { dm.enqueue(req); toast("开始下载: " + name); }
        } catch (Exception e) { toast("下载失败: " + (e.getMessage() == null ? "" : e.getMessage())); }
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
    private void addHistory(String url, String title) {
        if (url == null) return;
        // 排除内部功能页
        if (url.startsWith("file:") || url.startsWith("about:") || url.startsWith("data:")
                || url.startsWith("rtflow:") || url.startsWith("javascript:") || url.startsWith("blob:")) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String raw = sp.getString("history", "[]");
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            org.json.JSONObject entry = new org.json.JSONObject();
            entry.put("url", url);
            entry.put("title", title == null ? "" : title);
            entry.put("ts", System.currentTimeMillis());
            // 去重最近同 URL
            for (int i = arr.length() - 1; i >= 0; i--) {
                if (url.equals(arr.optJSONObject(i) != null ? arr.getJSONObject(i).optString("url") : "")) {
                    arr.remove(i); break;
                }
            }
            arr.put(entry);
            // 保留最近 200 条
            while (arr.length() > 200) arr.remove(0);
            sp.edit().putString("history", arr.toString()).apply();
            vaultWrite("history", arr.toString());
        } catch (Exception ignored) {}
    }

    private void showHistory() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String raw = sp.getString("history", "[]");
            if (raw == null || raw.isEmpty() || "[]".equals(raw)) { String v = vaultRead("history"); if (v != null && !v.isEmpty()) raw = v; }
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            StringBuilder sb = new StringBuilder();
            sb.append("<html><head><meta name=viewport content='width=device-width,initial-scale=1'>");
            sb.append("<style>body{background:#0e1116;color:#cdd3de;font:13px -apple-system,sans-serif;padding:12px}");
            sb.append("h2{color:#9cdcfe;margin-bottom:12px}");
            sb.append(".it{padding:8px;border-bottom:1px solid #21262d;cursor:pointer}");
            sb.append(".it:active{background:#1f3a45}");
            sb.append(".it .t{color:#e6edf3;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".it .u{color:#8b949e;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".it .ts{color:#6e7681;font-size:10px}");
            sb.append("</style></head><body><h2>浏览历史</h2>");
            for (int i = arr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = arr.getJSONObject(i);
                String u = escapeHtml(e.optString("url", ""));
                String t = escapeHtml(e.optString("title", ""));
                sb.append("<div class='it' onclick=\"location.href='").append(u.replace("'", "\\'")).append("'\">");
                sb.append("<div class='t'>").append(t.isEmpty() ? u : t).append("</div>");
                sb.append("<div class='u'>").append(u).append("</div></div>");
            }
            if (arr.length() == 0) sb.append("<div style='color:#6e7681;text-align:center;padding:40px'>暂无浏览历史</div>");
            sb.append("</body></html>");
            Tab ht = newTab("about:blank", null);
            ht.title = "浏览历史";
            ht.web.loadDataWithBaseURL(null, sb.toString(), "text/html", "utf-8", null);
        } catch (Exception e) { toast("历史加载失败"); }
    }

    // ── 书签收藏 ──────────────────────────────────────────────────────────
    private void addBookmark(String url, String title) {
        if (url == null || url.startsWith("rtflow:") || url.startsWith("file:") || url.startsWith("about:")) { toast("内部页不可收藏"); return; }
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("bookmarks", "[]"));
            for (int i = 0; i < arr.length(); i++) { if (url.equals(arr.getJSONObject(i).optString("url"))) { toast("已收藏过"); return; } }
            org.json.JSONObject e = new org.json.JSONObject();
            e.put("url", url); e.put("title", title == null ? url : title); e.put("ts", System.currentTimeMillis());
            arr.put(e);
            sp.edit().putString("bookmarks", arr.toString()).apply();
            toast("已收藏");
        } catch (Exception ignored) { toast("收藏失败"); }
    }

    private void showBookmarks() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString("bookmarks", "[]"));
            StringBuilder sb = new StringBuilder();
            sb.append("<html><head><meta name=viewport content='width=device-width,initial-scale=1'>");
            sb.append("<style>body{background:#0e1116;color:#cdd3de;font:13px -apple-system,sans-serif;padding:12px}");
            sb.append("h2{color:#9cdcfe;margin-bottom:12px}");
            sb.append(".it{padding:8px;border-bottom:1px solid #21262d}");
            sb.append(".it .t{color:#e6edf3;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append(".it .u{color:#8b949e;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
            sb.append("</style></head><body><h2>书签收藏</h2>");
            for (int i = arr.length() - 1; i >= 0; i--) {
                org.json.JSONObject e = arr.getJSONObject(i);
                String u = escapeHtml(e.optString("url", "")), t = escapeHtml(e.optString("title", ""));
                sb.append("<div class='it' onclick=\"location.href='").append(u.replace("'", "\\'")).append("'\">");
                sb.append("<div class='t'>").append(t.isEmpty() ? u : t).append("</div>");
                sb.append("<div class='u'>").append(u).append("</div></div>");
            }
            if (arr.length() == 0) sb.append("<div style='color:#6e7681;text-align:center;padding:40px'>暂无书签 — 长按标签「收藏本页」</div>");
            sb.append("</body></html>");
            Tab bt = newTab("about:blank", null);
            bt.title = "书签";
            bt.web.loadDataWithBaseURL(null, sb.toString(), "text/html", "utf-8", null);
        } catch (Exception e) { toast("书签加载失败"); }
    }

    @Override protected void onPause() {
        super.onPause();
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) {} // 持久化其它网站登录 Cookie
        saveTabs();
    }

    @Override protected void onDestroy() {
        saveTabs();
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) {}
        for (Tab t : tabs) { try { t.web.destroy(); } catch (Exception ignored) {} }
        tabs.clear();
        super.onDestroy();
    }
}
