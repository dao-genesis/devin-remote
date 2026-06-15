package ai.devin.rtflow;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

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
 */
public class TabActivity extends AppCompatActivity {

    private static final AtomicInteger SEQ = new AtomicInteger(1);
    private static final Map<Integer, String> TABS = Collections.synchronizedMap(new LinkedHashMap<>());

    private int tabId;
    private WebView web;

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String url = getIntent().getStringExtra("url");
        String accJson = getIntent().getStringExtra("account");
        if (url == null) url = "https://app.devin.ai/";

        String token = "", org = "", label = "";
        try { JSONObject a = new JSONObject(accJson == null ? "{}" : accJson);
            token = a.optString("auth1", ""); org = a.optString("orgId", ""); label = a.optString("email", a.optString("id", "")); }
        catch (Exception ignored) {}

        tabId = SEQ.getAndIncrement();
        TABS.put(tabId, label);
        setTitle("RT Flow · " + label);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "")); // 去 WebView 标记, 贴近真浏览器
        web.setWebViewClient(new WebViewClient());

        final String script = buildInjection(token, org);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, script, Collections.singleton("https://app.devin.ai"));
        } else {
            web.setWebViewClient(new WebViewClient() {
                @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap f) { v.evaluateJavascript(script, null); }
            });
        }

        setContentView(web);
        web.loadUrl(url);
    }

    /** 构造 document_start 注入脚本: iso 隔离 + 账号种入 + fetch/XHR 头注入。 */
    private static String buildInjection(String token, String org) {
        String t = token == null ? "" : token.replace("\\", "\\\\").replace("'", "\\'");
        String o = org == null ? "" : org.replace("\\", "\\\\").replace("'", "\\'");
        return "(function(){try{" +
            "var TOKEN='" + t + "',ORG='" + o + "';" +
            "try{sessionStorage.setItem('__dao_tab_isolated__','1');}catch(e){}" +
            // iso 垫片: dao 登录态键改走 sessionStorage (本标签私有)
            "(function(){var DAO=/^(auth1_session$|migrated-to-unscoped-auth0-token|known-org-ids-|last-internal-org-for-external-org|post-auth-v3-)/;" +
            "var P=Storage.prototype,ls=window.localStorage,ss=window.sessionStorage,g=P.getItem,st=P.setItem,rm=P.removeItem;" +
            "P.getItem=function(k){if(this===ls&&DAO.test(k))return g.call(ss,k);return g.call(this,k);};" +
            "P.setItem=function(k,v){if(this===ls&&DAO.test(k))return st.call(ss,k,v);return st.call(this,k,v);};" +
            "P.removeItem=function(k){if(this===ls&&DAO.test(k))return rm.call(ss,k);return rm.call(this,k);};})();" +
            "try{if(TOKEN)sessionStorage.setItem('auth1_session',TOKEN);}catch(e){}" +
            // fetch/XHR 强制注入鉴权头 (= DNR 等价物)
            "function isApi(u){try{return /app\\.devin\\.ai\\/api\\//.test(u)||u.indexOf('/api/')===0;}catch(e){return false;}}" +
            "var of=window.fetch;window.fetch=function(input,init){try{var url=(typeof input==='string')?input:(input&&input.url)||'';if(TOKEN&&isApi(url)){init=init||{};var h=new Headers(init.headers||(typeof input!=='string'&&input.headers)||{});h.set('Authorization','Bearer '+TOKEN);if(ORG)h.set('x-cog-org-id',ORG);init.headers=h;}}catch(e){}return of.call(this,input,init);};" +
            "var oo=XMLHttpRequest.prototype.open,osd=XMLHttpRequest.prototype.send;" +
            "XMLHttpRequest.prototype.open=function(m,u){this.__api=isApi(u);return oo.apply(this,arguments);};" +
            "XMLHttpRequest.prototype.send=function(b){try{if(TOKEN&&this.__api){this.setRequestHeader('Authorization','Bearer '+TOKEN);if(ORG)this.setRequestHeader('x-cog-org-id',ORG);}}catch(e){}return osd.apply(this,arguments);};" +
            "}catch(e){}})();";
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
