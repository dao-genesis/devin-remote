package ai.devin.rtflow;

import android.Manifest;
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
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
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
    static final String DEVIN = "https://app.devin.ai/";
    private static final String SW_URL = "file:///android_asset/engine/switch.html";
    private static final String TU_URL = "file:///android_asset/engine/tunnel.html";
    private static final String CL_URL = "file:///android_asset/engine/cloud.html";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Tab> tabs = new ArrayList<>();
    private int active = -1;

    private FrameLayout content;
    private LinearLayout tabStripRow;
    private EditText addr;

    static class Tab {
        WebView web;
        String title = "新标签";
        String url = "";
        String accountJson = null;   // 非空 = 账号标签 (注入鉴权)
        boolean internal = false;    // file:// 内部页 (暴露 Native 桥)
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        startRelay();
        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);
        setContentView(buildChrome());
        // 首屏: 切号面板
        newTab(SWITCH, null);
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

        bar.addView(menu);
        bar.addView(addr);
        bar.addView(go);

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
        m.getMenu().add(0, 3, 3, "新标签 (Devin)");
        m.getMenu().add(0, 4, 4, "关闭当前标签");
        m.getMenu().add(0, 5, 5, "重连内网穿透");
        m.setOnMenuItemClickListener(it -> {
            switch (it.getItemId()) {
                case 1: newTab(SWITCH, null); return true;
                case 6: newTab(CLOUD, null); return true;
                case 2: newTab(TUNNEL, null); return true;
                case 3: newTab(DEVIN, null); return true;
                case 4: closeTab(active); return true;
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
        else url = "https://www.google.com/search?q=" + android.net.Uri.encode(s);
        navigate(url);
    }

    // ── 标签管理 ──────────────────────────────────────────────────────────
    @SuppressWarnings("SetJavaScriptEnabled")
    private Tab newTab(String url, String accountJson) {
        final Tab tab = new Tab();
        tab.accountJson = accountJson;
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
        if (Build.VERSION.SDK_INT >= 21) st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        boolean internal = url.startsWith("rtflow://") || url.startsWith("file:");
        tab.internal = internal;
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
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return false; }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) {
                tab.url = u; if (tabOf(v) == active) setAddr(u);
            }
            @Override public void onPageFinished(WebView v, String u) {
                tab.url = u; renderTabStrip();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onReceivedTitle(WebView v, String t) { if (t != null && !t.isEmpty()) { tab.title = t; renderTabStrip(); } }
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("RTFlowJS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        tabs.add(tab);
        loadInto(tab, url);
        selectTab(tabs.size() - 1);
        return tab;
    }

    private void loadInto(Tab tab, String url) {
        String real = url;
        if (SWITCH.equals(url)) { real = SW_URL; tab.internal = true; }
        else if (TUNNEL.equals(url)) { real = TU_URL; tab.internal = true; }
        else if (CLOUD.equals(url)) { real = CL_URL; tab.internal = true; }
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
            label.setOnClickListener(v -> selectTab(idx));

            TextView x = new TextView(this);
            x.setText(" ×");
            x.setTextColor(0xFF8B949E);
            x.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            x.setPadding(dp(6), 0, dp(2), 0);
            x.setOnClickListener(v -> closeTab(idx));

            chip.addView(label);
            chip.addView(x);
            tabStripRow.addView(chip);
        }
        Button plus = chipBtn("+");
        plus.setOnClickListener(v -> newTab(SWITCH, null));
        tabStripRow.addView(plus);
    }

    private String chipTitle(Tab t) {
        if (t.url != null && t.url.endsWith("switch.html")) return "切号";
        if (t.url != null && t.url.endsWith("tunnel.html")) return "穿透";
        if (t.url != null && t.url.endsWith("cloud.html")) return "对话";
        if (t.accountJson != null) {
            try { JSONObject a = new JSONObject(t.accountJson); String e = a.optString("email", a.optString("id", "Devin")); return e.length() > 14 ? e.substring(0, 13) + "…" : e; } catch (Exception ignored) {}
        }
        return t.title == null || t.title.isEmpty() ? "标签" : t.title;
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
                Tab t = newTab("about:blank", null);
                String html = "<html><head><meta name=viewport content='width=device-width,initial-scale=1'>" +
                        "<style>body{background:#0e1116;color:#cdd3de;font:13px monospace;padding:12px;white-space:pre-wrap;word-break:break-all}</style></head><body>" +
                        escapeHtml(content) + "</body></html>";
                t.title = title == null ? "MD" : title;
                t.web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            });
        }
        @JavascriptInterface public void log(String s) { android.util.Log.i("RTFlowBrowser", s == null ? "" : s); }
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override protected void onDestroy() {
        for (Tab t : tabs) { try { t.web.destroy(); } catch (Exception ignored) {} }
        tabs.clear();
        super.onDestroy();
    }
}
