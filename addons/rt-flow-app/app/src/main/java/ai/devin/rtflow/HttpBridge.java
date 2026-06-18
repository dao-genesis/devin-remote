package ai.devin.rtflow;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HttpBridge · 原生 HTTP 客户端 (绕过 file:// 的 CORS, 且能设置 Origin/Referer 等 fetch 禁用头)。
 * JS 经 Native.httpReq(reqId, method, url, headersJson, body) 调用, 结果异步经 window.__httpCb 回灌。
 * 这是手机版复刻桌面 devinJsonPost/Get 的底座 — 登录/额度/会话/Git 全走它。
 */
public final class HttpBridge {
    private HttpBridge() {}

    public interface Cb { void done(String reqId, String resultJson); }

    private static final ExecutorService POOL = Executors.newFixedThreadPool(8);
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    public static void exec(final String reqId, final String method, final String url,
                            final String headersJson, final String body, final Cb cb) {
        POOL.submit(() -> {
            String result;
            try { result = doHttp(method, url, headersJson, body); }
            catch (Exception e) { result = "{\"status\":0,\"error\":" + jsonStr(String.valueOf(e.getMessage())) + "}"; }
            cb.done(reqId, result);
        });
    }

    /** 二进制下载 (会话产出文件经 presigned URL 取回): 响应体以 base64 回灌 {status, b64}。
     *  专供「下载ZIP全部包括文件夹」用 — 文本桥会按 UTF-8 损坏二进制, 故另开此路。 */
    public static void execB64(final String reqId, final String method, final String url,
                               final String headersJson, final String body, final Cb cb) {
        POOL.submit(() -> {
            String result;
            try { result = doHttpB64(method, url, headersJson, body); }
            catch (Exception e) { result = "{\"status\":0,\"error\":" + jsonStr(String.valueOf(e.getMessage())) + "}"; }
            cb.done(reqId, result);
        });
    }

    private static String doHttp(String method, String urlStr, String headersJson, String body) throws Exception {
        String m = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(35000);
        c.setRequestMethod(m);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        if (headersJson != null && !headersJson.isEmpty()) {
            JSONObject h = new JSONObject(headersJson);
            Iterator<String> it = h.keys();
            while (it.hasNext()) {
                String k = it.next();
                try { c.setRequestProperty(k, h.getString(k)); } catch (Exception ignored) {}
            }
        }
        boolean hasBody = body != null && !body.isEmpty() && !"GET".equals(m) && !"HEAD".equals(m);
        if (hasBody) {
            c.setDoOutput(true);
            byte[] b = body.getBytes("UTF-8");
            OutputStream os = c.getOutputStream();
            os.write(b);
            os.flush();
            os.close();
        }
        int code = c.getResponseCode();
        InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
        String text = is == null ? "" : slurp(is);
        try { c.disconnect(); } catch (Exception ignored) {}
        return "{\"status\":" + code + ",\"text\":" + jsonStr(text) + "}";
    }

    private static String doHttpB64(String method, String urlStr, String headersJson, String body) throws Exception {
        String m = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
        URL url = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestMethod(m);
        c.setRequestProperty("User-Agent", UA);
        if (headersJson != null && !headersJson.isEmpty()) {
            JSONObject h = new JSONObject(headersJson);
            Iterator<String> it = h.keys();
            while (it.hasNext()) {
                String k = it.next();
                try { c.setRequestProperty(k, h.getString(k)); } catch (Exception ignored) {}
            }
        }
        boolean hasBody = body != null && !body.isEmpty() && !"GET".equals(m) && !"HEAD".equals(m);
        if (hasBody) {
            c.setDoOutput(true);
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes("UTF-8"));
            os.flush();
            os.close();
        }
        int code = c.getResponseCode();
        InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
        byte[] bytes = is == null ? new byte[0] : slurpBytes(is);
        try { c.disconnect(); } catch (Exception ignored) {}
        String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
        return "{\"status\":" + code + ",\"b64\":" + jsonStr(b64) + ",\"size\":" + bytes.length + "}";
    }

    private static byte[] slurpBytes(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
    }

    private static String slurp(InputStream is) throws Exception {
        return new String(slurpBytes(is), "UTF-8");
    }

    /** 最小 JSON 字符串转义 (用于把任意响应文本安全嵌入回灌 JSON)。 */
    static String jsonStr(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
                    else sb.append(ch);
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
