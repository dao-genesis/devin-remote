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

        String token = "", org = "", uid = "", orgName = "", label = "";
        try { JSONObject a = new JSONObject(accJson == null ? "{}" : accJson);
            token = a.optString("auth1", ""); org = a.optString("orgId", "");
            uid = a.optString("userId", ""); orgName = a.optString("orgName", "");
            label = a.optString("email", a.optString("id", "")); }
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

        final String script = buildInjection(token, uid, org, orgName);
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
