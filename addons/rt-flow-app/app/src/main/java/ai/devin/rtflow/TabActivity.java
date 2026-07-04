package ai.devin.rtflow;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * TabActivity · 一个绑定专属账号的 Devin 网页标签 (多实例之一)。
 * document_start 注入: ① iso 隔离垫片 (auth 键 localStorage→sessionStorage, 各标签互不干扰)
 *                       ② fetch/XHR 强制注入 Authorization+x-cog-org-id (= 扩展 DNR 的等价物)
 * 浏览器同构层: 与主壳账号标签同一套 WebChromeClient/DownloadListener —— 视频全屏、
 * <input type=file> 上传、window.open 新窗、附件/blob:/data: 下载, 均与真浏览器行为一致。
 */
public class TabActivity extends AppCompatActivity {

    private static final AtomicInteger SEQ = new AtomicInteger(1);
    private static final Map<Integer, String> TABS = Collections.synchronizedMap(new LinkedHashMap<>());

    private int tabId;
    private WebView web;
    private String accJson = "{}";
    private String accAuth1 = "", accOrgId = "";
    // 附件 Cookie 是组织级共享状态 → 回到前台即按本实例组织预铸 (他组织标签铸过则重铸)
    @Override protected void onResume() {
        super.onResume();
        if (accAuth1 != null && !accAuth1.isEmpty())
            MainActivity.warmAttachmentCookie(accAuth1, accOrgId, "https://app.devin.ai/attachments/");
    }

    // 网页 <input type=file> 上传 (缺 onShowFileChooser 时点击无任何反应 — 与真浏览器不一致)
    private ValueCallback<Uri[]> filePathCallback;
    private final ActivityResultLauncher<Intent> fileChooser = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                ValueCallback<Uri[]> cb = filePathCallback; filePathCallback = null;
                if (cb == null) return;
                Uri[] uris = null;
                Intent data = result.getData();
                if (result.getResultCode() == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        uris = new Uri[n];
                        for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) uris = new Uri[]{ data.getData() };
                }
                cb.onReceiveValue(uris);
            });

    // 视频全屏承接 (onShowCustomView): 缺失则播放器点全屏无反应
    private View fsView = null;
    private WebChromeClient.CustomViewCallback fsCallback = null;

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String url = getIntent().getStringExtra("url");
        accJson = getIntent().getStringExtra("account");
        if (accJson == null) accJson = "{}";
        if (url == null) url = "https://app.devin.ai/";

        String token = "", org = "", uid = "", orgName = "", label = "";
        try { JSONObject a = new JSONObject(accJson);
            token = a.optString("auth1", ""); org = a.optString("orgId", "");
            uid = a.optString("userId", ""); orgName = a.optString("orgName", "");
            label = a.optString("email", a.optString("id", "")); }
        catch (Exception ignored) {}

        accAuth1 = token; accOrgId = org;
        tabId = SEQ.getAndIncrement();
        TABS.put(tabId, label);
        setTitle("Devin Cloud · " + label);

        web = new MainActivity.GuardedWebView(this);   // 退格护栏(IME 左右同删夹断)与主壳同源
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "")); // 去 WebView 标记, 贴近真浏览器
        // 浏览器同构设置 (与主壳账号标签 makeTab 同源): 缺任一项都会与真浏览器行为分叉
        s.setAllowFileAccess(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportMultipleWindows(true);                 // window.open / target=_blank
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);      // 会话页视频自动续播
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        final String script = buildInjection(token, uid, org, orgName);
        final boolean docStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (docStart) WebViewCompat.addDocumentStartJavaScript(web, script, Collections.singleton("https://app.devin.ai"));
        final String fToken = token, fOrg = org;
        web.setWebViewClient(new WebViewClient() {
            // 顶层导航落在附件/S3 预签名直链 → 拦下转真下载, 留在会话页 (不再整页跳空白)
            @Override public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest req) {
                String u = req.getUrl() == null ? null : req.getUrl().toString();
                return req.isForMainFrame() && interceptAttachmentNav(u);
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return interceptAttachmentNav(u); }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) {
                if (!docStart) v.evaluateJavascript(script, null);
            }
            @Override public void onPageFinished(WebView v, String u) {
                MainActivity.warmAttachmentCookie(fToken, fOrg, u);   // 预铸附件 Cookie → 图片/视频首次即授权
                MainActivity.installDownloadHook(v);                  // <a download>/blob:/data: 下载捕获
                MainActivity.installKbHelper(v);                      // 键盘弹出滚动补偿
                MainActivity.installBackspaceGuard(v);                // IME 退格护栏 (与主壳一致)
                MainActivity.installVideoFit(v);                      // 录像播放器窄屏适配 (与主壳一致)
            }
            // 媒体鉴权代取: /attachments/ 图片视频与主壳同源同一套 (Cookie 转发 + 401 铸造自愈)
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v, android.webkit.WebResourceRequest req) {
                android.webkit.WebResourceResponse am = MainActivity.authMediaResponseFor(fToken, fOrg, req);
                if (am != null) return am;
                return super.shouldInterceptRequest(v, req);
            }
            // 渲染进程被系统回收时若不接管, Android 默认连带杀整个 App(= 闪退)。接管 → 重建本页(无感恢复)。
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                try { v.destroy(); } catch (Exception ignored) {}
                recreate();
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // 视频全屏: <video> 的全屏按钮需此回调承接, 缺失则点全屏无反应/播放异常
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fsView != null) { try { callback.onCustomViewHidden(); } catch (Exception ignored) {} return; }
                fsView = view; fsCallback = callback;
                ((ViewGroup) getWindow().getDecorView()).addView(view,
                        new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
            @Override public void onHideCustomView() {
                if (fsView == null) return;
                try { ((ViewGroup) getWindow().getDecorView()).removeView(fsView); } catch (Exception ignored) {}
                fsView = null;
                try { if (fsCallback != null) fsCallback.onCustomViewHidden(); } catch (Exception ignored) {}
                fsCallback = null;
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
            // 文件/附件上传: 让网页 <input type=file> 拉起系统选择器
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) { try { filePathCallback.onReceiveValue(null); } catch (Exception ignored) {} }
                filePathCallback = cb;
                try {
                    Intent i;
                    try { i = params.createIntent(); } catch (Exception e) { i = null; }
                    if (i == null) i = new Intent(Intent.ACTION_GET_CONTENT);
                    if (i.getAction() == null) i.setAction(Intent.ACTION_GET_CONTENT);
                    if (i.getType() == null) i.setType("*/*");
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    try { if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); } catch (Exception ignored) {}
                    fileChooser.launch(Intent.createChooser(i, "选择文件"));
                    return true;
                } catch (Exception e) { filePathCallback = null; toast("无法打开上传选择器"); return false; }
            }
            // 新窗口 (window.open / target=_blank): 开一个同账号的新 TabActivity 承接
            @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture, android.os.Message resultMsg) {
                try {
                    final WebView probe = new WebView(TabActivity.this);
                    probe.setWebViewClient(new WebViewClient() {
                        private void openInNewTab(String u) {
                            try {
                                // 附件/S3 直链的 target=_blank: 开新页只会空白 → 直接转真下载
                                if (MainActivity.isAttachmentDownloadUrl(u))
                                    startDownload(u, web.getSettings().getUserAgentString(), MainActivity.dispositionFromUrl(u), null);
                                else if (u != null && !u.isEmpty()) startActivity(new Intent(TabActivity.this, TabActivity.class)
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK | Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                                        .putExtra("url", u).putExtra("account", accJson));
                            } catch (Exception ignored) {}
                            try { probe.destroy(); } catch (Exception ignored) {}
                        }
                        @Override public boolean shouldOverrideUrlLoading(WebView pv, android.webkit.WebResourceRequest r) {
                            openInNewTab(r.getUrl() == null ? null : r.getUrl().toString()); return true;
                        }
                        @SuppressWarnings("deprecation")
                        @Override public boolean shouldOverrideUrlLoading(WebView pv, String u) { openInNewTab(u); return true; }
                    });
                    WebView.WebViewTransport tr = (WebView.WebViewTransport) resultMsg.obj;
                    tr.setWebView(probe);
                    resultMsg.sendToTarget();
                    return true;
                } catch (Exception e) { return false; }
            }
            @Override public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(() -> { try { request.grant(request.getResources()); } catch (Exception ignored) {} });
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback cb) {
                if (cb != null) cb.invoke(origin, true, false);
            }
        });

        // 下载 (附件/导出文件): http(s) 走系统 DownloadManager; blob:/data: 由页面 JS 经 RTDL 桥回传
        web.addJavascriptInterface(new BlobSink(), "RTDL");
        web.setDownloadListener((dlUrl, ua, contentDisposition, mimetype, len) ->
                startDownload(dlUrl, ua, contentDisposition, mimetype));

        setContentView(web);
        web.loadUrl(url);
    }

    private void toast(String msg) { try { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); } catch (Exception ignored) {} }

    /** 顶层导航拦截: 附件下载型 URL 转交 startDownload, 返 true 阻断导航。 */
    private boolean interceptAttachmentNav(String u) {
        if (!MainActivity.isAttachmentDownloadUrl(u)) return false;
        String ua = null;
        try { ua = web.getSettings().getUserAgentString(); } catch (Exception ignored) {}
        startDownload(u, ua, MainActivity.dispositionFromUrl(u), null);
        return true;
    }

    private void startDownload(String url, String ua, String contentDisposition, String mime) {
        // blob: 无法走系统 DownloadManager → 由页面 JS 取内容经 RTDL 桥回传
        if (url != null && url.startsWith("blob:")) {
            String esc = url.replace("\\", "\\\\").replace("'", "\\'");
            String js = "(function(){try{fetch('" + esc + "').then(function(r){return r.blob();}).then(function(b){var fr=new FileReader();fr.onload=function(){var s=''+fr.result;var i=s.indexOf(',');try{RTDL.saveBase64('download',(b.type||''),i>=0?s.slice(i+1):s);}catch(e){}};fr.readAsDataURL(b);});}catch(e){}})();";
            try { if (web != null) web.evaluateJavascript(js, null); } catch (Exception ignored) {}
            return;
        }
        if (url != null && url.startsWith("data:")) {
            try {
                int c = url.indexOf(','); if (c < 0) { toast("下载失败"); return; }
                String meta = url.substring(5, c);
                String dmime = meta.split(";")[0];
                boolean b64 = meta.toLowerCase(java.util.Locale.US).contains("base64");
                String payload = url.substring(c + 1);
                byte[] data = b64 ? android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
                                  : java.net.URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8");
                String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, dmime);
                saveToDownloads(name, dmime, data);
            } catch (Exception e) { toast("下载失败"); }
            return;
        }
        // 附件下载首点即成: 入队前确保 attachments_token 就绪 (铸造是网络操作 → 后台线程)
        final String fUrl = url, fUa = ua, fCd = contentDisposition, fMime = mime;
        new Thread(() -> {
            try {
                if (accAuth1 != null && !accAuth1.isEmpty()
                        && fUrl != null && fUrl.contains("app.devin.ai/attachments/"))
                    MainActivity.ensureAttachmentCookie(accAuth1, accOrgId, fUrl);
                String name = android.webkit.URLUtil.guessFileName(fUrl, fCd, fMime);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(fUrl));
                if (fMime != null) req.setMimeType(fMime);
                if (fUa != null) req.addRequestHeader("User-Agent", fUa);
                String cookie = CookieManager.getInstance().getCookie(fUrl);   // 附件下载鉴权: 路径匹配 Cookie 随行
                if (cookie != null) req.addRequestHeader("Cookie", cookie);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) { dm.enqueue(req); runOnUiThread(() -> toast("开始下载: " + name)); }
            } catch (Exception e) { runOnUiThread(() -> toast("下载失败: " + (e.getMessage() == null ? "" : e.getMessage()))); }
        }).start();
    }

    // RTDL 桥: 页面把 blob:/data: 下载内容(base64)回传 → 落地系统「下载」
    private class BlobSink {
        @android.webkit.JavascriptInterface
        public void saveBase64(String name, String mime, String b64) {
            try {
                byte[] data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                saveToDownloads(name, mime, data);
            } catch (Exception e) { runOnUiThread(() -> toast("下载捕获失败")); }
        }
    }

    private void saveToDownloads(String name, String mime, byte[] data) {
        try {
            if (name == null || name.isEmpty()) name = "download";
            if (!name.contains(".")) {
                String ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime == null ? "" : mime);
                if (ext != null && !ext.isEmpty()) name = name + "." + ext;
            }
            final String fmime = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, fmime);
                Uri uri = getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new java.io.IOException("insert failed");
                try (java.io.OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) throw new java.io.IOException("open failed");
                    os.write(data);
                }
            } else {
                java.io.File dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                java.io.File f = new java.io.File(dir, name);
                if (f.exists()) {
                    String base = name, ext2 = ""; int dot = name.lastIndexOf('.');
                    if (dot > 0) { base = name.substring(0, dot); ext2 = name.substring(dot); }
                    f = new java.io.File(dir, base + "_" + System.currentTimeMillis() + ext2);
                }
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) { fos.write(data); }
            }
            final String fname = name;
            runOnUiThread(() -> toast("下载完成: " + fname));
        } catch (Exception e) { runOnUiThread(() -> toast("下载失败")); }
    }

    /**
     * 构造 document_start 注入脚本 — 严格复刻桌面 devin_proxy.js 配方:
     *   ① iso 垫片: dao 登录态键 localStorage→sessionStorage (本标签私有, 多实例互不干扰)
     *   ② 种入 SPA 登录态: auth1_session={token,userId} + 迁移键 + known-org-ids + post-auth-v3 守键
     *   ③ cookie webapp_logged_in=true
     *   ④ fetch/XHR 强制注入 Authorization:Bearer + x-cog-org-id (= 桌面 DNR 等价物)
     * 关键修正: auth1_session 必须是 {token,userId} 对象 (旧版误写裸 token → SPA 解析失败, 登不进)。
     */
    static String buildInjection(String token, String userId, String org, String orgName) {
        String t = esc(token), u = esc(userId), o = esc(org), on = esc(orgName);
        return "(function(){try{" +
            "var __a1='" + t + "',__uid='" + u + "',__org='" + o + "',__orgName='" + on + "';" +
            "try{sessionStorage.setItem('__dao_tab_isolated__','1');}catch(e){}" +
            // iso 垫片: dao 登录态键改走 sessionStorage (本标签私有)
            "(function(){var DAO=/^(auth1_session$|migrated-to-unscoped-auth0-token|known-org-ids-|last-internal-org-for-external-org|post-auth-v3-)/;" +
            "var P=Storage.prototype,ls=window.localStorage,ss=window.sessionStorage,g=P.getItem,st=P.setItem,rm=P.removeItem;" +
            "P.getItem=function(k){if(this===ls&&DAO.test(k))return g.call(ss,k);return g.call(this,k);};" +
            "P.setItem=function(k,v){if(this===ls&&DAO.test(k))return st.call(ss,k,v);return st.call(this,k,v);};" +
            "P.removeItem=function(k){if(this===ls&&DAO.test(k))return rm.call(ss,k);return rm.call(this,k);};})();" +
            // 种入 SPA 登录态 (经 iso 垫片落到本标签私有 sessionStorage)
            "if(__a1){" +
            "localStorage.setItem('auth1_session',JSON.stringify({token:__a1,userId:__uid}));" +
            "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');" +
            "if(__uid)localStorage.setItem('known-org-ids-'+__uid,JSON.stringify([__org]));" +
            "if(__org)localStorage.setItem('last-internal-org-for-external-org-v1-null',__org);" +
            "if(__org&&__uid&&__orgName){var __k='post-auth-v3-null-'+__uid+'-org_name-'+__orgName;" +
            "if(!localStorage.getItem(__k))localStorage.setItem(__k,JSON.stringify({externalOrgId:null,userId:__uid,internalOrgId:__org,orgName:__orgName,result:{resolved_external_org_id:null,org_id:__org,org_name:__orgName,is_valid_resource:true}}));}" +
            "}" +
            "try{document.cookie='webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';}catch(e){}" +
            // fetch/XHR 强制注入鉴权头 (= DNR 等价物)
            "function isApi(u){try{return /app\\.devin\\.ai\\/api\\//.test(u)||u.indexOf('/api/')===0;}catch(e){return false;}}" +
            "var of=window.fetch;window.fetch=function(input,init){try{var url=(typeof input==='string')?input:(input&&input.url)||'';if(__a1&&isApi(url)){init=init||{};var h=new Headers(init.headers||(typeof input!=='string'&&input.headers)||{});if(!h.has('Authorization'))h.set('Authorization','Bearer '+__a1);if(__org&&!h.has('x-cog-org-id'))h.set('x-cog-org-id',__org);init.headers=h;}}catch(e){}return of.call(this,input,init);};" +
            "var oo=XMLHttpRequest.prototype.open,osd=XMLHttpRequest.prototype.send;" +
            "XMLHttpRequest.prototype.open=function(m,u){this.__api=isApi(u);return oo.apply(this,arguments);};" +
            "XMLHttpRequest.prototype.send=function(b){try{if(__a1&&this.__api){this.setRequestHeader('Authorization','Bearer '+__a1);if(__org)this.setRequestHeader('x-cog-org-id',__org);}}catch(e){}return osd.apply(this,arguments);};" +
            "}catch(e){}})();";
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("'", "\\'");
    }

    public static String listJson() {
        StringBuilder sb = new StringBuilder("[");
        synchronized (TABS) {
            boolean first = true;
            for (Map.Entry<Integer, String> e : TABS.entrySet()) {
                if (!first) sb.append(",");
                first = false;
                sb.append("{\"tabId\":").append(e.getKey()).append(",\"account\":")
                  .append(JSONObject.quote(e.getValue() == null ? "" : e.getValue())).append("}");
            }
        }
        return sb.append("]").toString();
    }

    public static void closeById(int id) { TABS.remove(id); }

    @Override protected void onDestroy() { TABS.remove(tabId); if (web != null) { web.destroy(); web = null; } super.onDestroy(); }
}
