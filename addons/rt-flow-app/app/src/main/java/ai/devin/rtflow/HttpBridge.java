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
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * HttpBridge · 原生 HTTP 客户端 (绕过 file:// 的 CORS, 且能设置 Origin/Referer 等 fetch 禁用头)。
 * JS 经 Native.httpReq(reqId, method, url, headersJson, body) 调用, 结果异步经 window.__httpCb 回灌。
 * 这是手机版复刻桌面 devinJsonPost/Get 的底座 — 登录/额度/会话/Git 全走它。
 *
 * 网络分道 (道并行而不相悖·彻底解决多账号自动备份导致的卡顿):
 *   · INTERACTIVE 池 — 文本请求 (登录/额度/会话列表/状态轮询/远程接管 RPC)。交互优先, 池大。
 *   · BULK 池       — 二进制下载 (会话产出 ZIP/文件, 体大耗时)。线程数小且降优先级,
 *                     使自动备份的大文件下载**永不抢占**交互请求的连接/线程 → 多账号并发查看状态时不再卡顿。
 *   两池彻底隔离: 备份在 BULK 池慢慢跑, 登录/刷额度/状态轮询在 INTERACTIVE 池照常即时返回。
 */
public final class HttpBridge {
    private HttpBridge() {}

    public interface Cb { void done(String reqId, String resultJson); }

    // 道法自然·网络不强依赖 VPN: 默认路由(可能经系统 VPN)失败时, 自动改走底层非 VPN 网络
    //   (Wi-Fi/蜂窝)重试一次 —— VPN 额度耗尽/节点死亡时, 登录/额度/备份/更新等原生请求不再僵死。
    //   反之无 VPN 时本就直连, 有 VPN 且健康时照常走 VPN —— 顺其自然, 不强制也不禁用。
    //   (锁定模式 Always-on VPN 下系统禁止绕行, 此时回退无效, 维持原错误 —— 尊重用户强制设定。)
    static volatile android.content.Context appCtx = null;

    /** 当前是否有系统 VPN 在跑。 */
    static boolean vpnActive() {
        try {
            android.content.Context ctx = appCtx; if (ctx == null) return false;
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            for (android.net.Network n : cm.getAllNetworks()) {
                android.net.NetworkCapabilities cap = cm.getNetworkCapabilities(n);
                if (cap != null && cap.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    /** 底层非 VPN 网络 (Wi-Fi/蜂窝·有 INTERNET 能力); 无则 null。 */
    static android.net.Network directNetwork() {
        try {
            android.content.Context ctx = appCtx; if (ctx == null) return null;
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;
            for (android.net.Network n : cm.getAllNetworks()) {
                android.net.NetworkCapabilities cap = cm.getNetworkCapabilities(n);
                if (cap == null) continue;
                if (cap.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) continue;
                if (!cap.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
                if (cap.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                        || cap.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)
                        || cap.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) return n;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** 开连接: direct=false 走默认路由; direct=true 绑底层非 VPN 网络(绕开死 VPN)。 */
    static HttpURLConnection openConn(String urlStr, boolean direct) throws Exception {
        URL url = new URL(urlStr);
        if (direct) {
            android.net.Network n = directNetwork();
            if (n != null) return (HttpURLConnection) n.openConnection(url);
        }
        return (HttpURLConnection) url.openConnection();
    }

    private static ThreadFactory namedFactory(final String prefix, final int osPriority) {
        final AtomicInteger n = new AtomicInteger(1);
        return r -> {
            Thread t = new Thread(() -> {
                try { android.os.Process.setThreadPriority(osPriority); } catch (Throwable ignored) {}
                r.run();
            }, prefix + "-" + n.getAndIncrement());
            t.setDaemon(true);
            return t;
        };
    }

    // 交互池: 状态轮询/登录/额度/会话列表/远程 RPC — 始终有充足线程, 不被备份拖慢。
    private static final ExecutorService INTERACTIVE = Executors.newFixedThreadPool(
            8, namedFactory("rtflow-http", android.os.Process.THREAD_PRIORITY_DEFAULT));
    // 大块下载池: 自动备份的 ZIP/产出文件 — 仅 3 线程且后台优先级, 既限并发又让出网络给交互请求。
    private static final ExecutorService BULK = Executors.newFixedThreadPool(
            3, namedFactory("rtflow-bulk", android.os.Process.THREAD_PRIORITY_BACKGROUND));
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    public static void exec(final String reqId, final String method, final String url,
                            final String headersJson, final String body, final Cb cb) {
        INTERACTIVE.submit(() -> cb.done(reqId, run(method, url, headersJson, body, false)));
    }

    /** 二进制下载 (会话产出文件经 presigned URL 取回): 响应体以 base64 回灌 {status, b64}。
     *  专供「下载ZIP全部包括文件夹」用 — 文本桥会按 UTF-8 损坏二进制, 故另开此路。
     *  走 BULK 池 (低优先级·小并发), 备份大文件下载不再拖慢交互请求。 */
    public static void execB64(final String reqId, final String method, final String url,
                               final String headersJson, final String body, final Cb cb) {
        BULK.submit(() -> cb.done(reqId, run(method, url, headersJson, body, true)));
    }

    /** 单次尝试: 默认路由(可能经已死 VPN)失败 → 有 VPN 在跑且有底层网络 → 绕 VPN 直连再试一次。 */
    private static String attempt(String method, String url, String headersJson, String body, boolean b64) throws Exception {
        try { return b64 ? doHttpB64(method, url, headersJson, body, false) : doHttp(method, url, headersJson, body, false); }
        catch (Exception e) {
            if (vpnActive() && directNetwork() != null)
                return b64 ? doHttpB64(method, url, headersJson, body, true) : doHttp(method, url, headersJson, body, true);
            throw e;
        }
    }

    /** 幂等请求(GET/HEAD)瞬时异常(超时/连接重置等)自动重试, 短退避最多 3 次 —— 移动网络抖动下
     *  额度/列表/备份下载不再一次抖动即失败; 非幂等(POST 等)保持单次, 防重复提交。 */
    private static String run(String method, String url, String headersJson, String body, boolean b64) {
        String m = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
        boolean idem = "GET".equals(m) || "HEAD".equals(m);
        int tries = idem ? 3 : 1;
        Exception last = null;
        for (int i = 0; i < tries; i++) {
            try { return attempt(method, url, headersJson, body, b64); }
            catch (Exception e) {
                last = e;
                if (i < tries - 1) {
                    try { Thread.sleep(600L * (i + 1)); }
                    catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                }
            }
        }
        return "{\"status\":0,\"error\":" + jsonStr(String.valueOf(last == null ? "" : last.getMessage())) + "}";
    }

    private static String doHttp(String method, String urlStr, String headersJson, String body, boolean direct) throws Exception {
        String m = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
        HttpURLConnection c = openConn(urlStr, direct);
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
        String ctype = c.getContentType();
        InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
        String text = is == null ? "" : slurp(is);
        try { c.disconnect(); } catch (Exception ignored) {}
        return "{\"status\":" + code + ",\"ctype\":" + jsonStr(ctype == null ? "" : ctype) + ",\"text\":" + jsonStr(text) + "}";
    }

    private static String doHttpB64(String method, String urlStr, String headersJson, String body, boolean direct) throws Exception {
        String m = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
        HttpURLConnection c = openConn(urlStr, direct);
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
        String ctype = c.getContentType();
        InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
        byte[] bytes = is == null ? new byte[0] : slurpBytes(is);
        try { c.disconnect(); } catch (Exception ignored) {}
        String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
        return "{\"status\":" + code + ",\"ctype\":" + jsonStr(ctype == null ? "" : ctype) + ",\"b64\":" + jsonStr(b64) + ",\"size\":" + bytes.length + "}";
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
