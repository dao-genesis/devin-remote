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
import android.os.PowerManager;
import android.net.wifi.WifiManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebSettings;

import androidx.annotation.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * RelayService · 常驻前台服务, 宿主一个无界面 engine WebView 跑 JS 引擎 (relay 客户端 + 25 RPC)。
 * 内网穿透常驻于此; 息屏/退后台不断线。业务逻辑全在 WebView 的 JS 里 → 可隔隧道热修。
 */
public class RelayService extends Service {
    public static final String CH = "rtflow-relay";
    public static final String CONV_CH = "rtflow-conv";   // 对话追踪·全局通知频道 (高优先, 可锁屏/后台弹)
    public static volatile String lastStatus = "{\"connected\":false}";
    public static volatile RelayService instance;

    private WebView engine;
    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;   // P2: 持锁防 Doze CPU 节流, 保 WSS 心跳不断
    private WifiManager.WifiLock wifiLock;     // 息屏防 Wi-Fi 休眠/降频, 保出站 WSS 不掉 (移植自 knoop7/Ava WifiWakeLock)
    // 去中心化直连 (局域网直连 + 路线B cloudflared 隧道)
    private LocalServer localServer;
    private TunnelManager tunnel;
    private volatile int localPort = -1;            // LocalServer 监听端口 (局域网直连 + 隧道共用)
    private volatile String lanUrlsJson = "[]";     // 本机当前局域网直连 URL 列表 (随网络变化刷新)
    public static volatile String tunnelStatus = "{\"enabled\":false}";
    private int tunnelRetries = 0;                 // cloudflared 连续异常退出计数 (连通后清零)
    private volatile int tunnelGen = 0;            // 隧道启动代次 (作废过期的无URL看门狗)
    private static final int TUNNEL_RETRY_SOFT = 3;   // 超过此次数仍持续重连, 但诚实提示已回退中继
    private static final long TUNNEL_RETRY_CAP = 60000L; // 重连退避上限 60s (隧道=公网入口, 永不彻底放弃→真·无感常驻)
    private static final long TUNNEL_URL_TIMEOUT = 50000L;// 起后 50s 仍拿不到公网URL=卡住, 重启隧道
    // 路线A 扩展: 独立于 cloudflared 的第二条去中心化公网后端 (SSH 反向隧道·localhost.run 等), 与主隧道并行兜底。
    private SshTunnelManager sshTunnel;
    private volatile String sshUrl = "";           // SSH 后端当前公网 URL
    private int sshRetries = 0;                     // SSH 后端连续退出计数 (连通后清零)
    private int sshEdgeIdx = 0;                      // 当前所用公共 SSH 边缘下标 (退出后轮换兜底)
    private volatile int sshGen = 0;                 // SSH 隧道启动代次 (作废过期看门狗)
    private int sshHealthFails = 0;                  // SSH 公网 URL 健康探测连续失败数 (满阈值换边缘)
    private static final long SSH_HEALTH_INTERVAL = 60000L;  // 每 60s 探一次备用隧道公网 URL 是否真活
    private int cfHealthFails = 0;                   // cloudflared 公网 URL 健康探测连续失败数 (满阈值触发重启)
    private int cfHealthRestarts = 0;                // 健康探测驱动的连续重启次数 (达上限判定本网络拦 cf 边缘→如实标离线+慢探恢复)
    private static final long CF_HEALTH_INTERVAL = 30000L;   // 每 30s 探一次主隧道公网 URL 是否真活 (cf 是主入口, 比备隧更勤)
    private static final int CF_HEALTH_RESTART_CAP = 3;      // 连续重启仍 530 即判定网络拦截, 停 cf 省电并如实标离线
    private static final long CF_RECOVER_INTERVAL = 300000L; // 判定拦截后每 5min 重启 cf 重试 (网络变更即自动复活)
    private final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.SynchronousQueue<String>> pendingLocal
            = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // 恢复远程操控开关状态: 默认开启 (用户首次无需手动开, 直接可远程驱动);
        // 仍受会话 token 门禁保护。用户若曾手动关闭 ("0") 则尊重其选择。
        String flag = readUserFile("remote-ops-flag");
        if (flag == null || flag.isEmpty()) { remoteOpsEnabled = true; writeUserFile("remote-ops-flag", "1"); }
        else remoteOpsEnabled = "1".equals(flag);
        startForeground(1, buildNotification("内网穿透服务启动中…"));
        acquireWake();
        main.post(this::initEngine);
        // 去中心化直连默认开启: 服务一起即拉起本地 server (绑 0.0.0.0), 同一局域网的控制端可零中继/零隧道直连本机。
        if (lanDirectFlag()) main.postDelayed(this::ensureLocalServer, 1200);
        // 去中心化隧道默认开启: 服务一起即在本地 server 之上拉起两条独立公网后端 (cloudflared 主 + SSH 备),
        // 用户用默认配置即拥有「不经任何 Worker」的独立公网入口, 无需手动开。用户若曾手动关闭 ("0") 则尊重其选择。
        if (tunnelEnabledFlag()) main.postDelayed(this::startTunnel, 1800);
    }

    /** 局域网直连开关 (默认开): 控制端与手机同网时可直连, 不依赖任何 Worker/隧道。 */
    private boolean lanDirectFlag() { String f = readUserFile("lan-direct"); return f == null || f.isEmpty() || "1".equals(f); }

    /** 起本地入站 server (绑 0.0.0.0) — 局域网直连与 cloudflared 隧道共用同一实例; 幂等。
     *  起好后刷新并广播当前局域网直连 URL, 供穿透面板展示/复制。 */
    private synchronized void ensureLocalServer() {
        try {
            if (localServer == null || !localServer.isRunning()) {
                localServer = new LocalServer(new LocalServer.Dispatcher() {
                    public String token() { return relayToken(); }
                    public String dispatch(String f) throws Exception { return dispatchLocal(f); }
                    // 浏览器原样拿 APK 自身的真实页面 (switch/tunnel/cloud/…) 与其 JS 资源
                    // → 任意设备浏览器打开即得与手机本体「表层+底层」完全一致的页面 (手机=中枢)。
                    public String[] staticAsset(String path) { return RelayService.this.staticAsset(path); }
                    public String[] embedDoc(String url) { return RelayService.this.embedDoc(url); }
                    public String[] embedProxy(String method, String url, String acct, String body, String reqContentType, String reqHost) { return RelayService.this.embedProxy(method, url, acct, body, reqContentType, reqHost); }
                    public int proxyPort(String target, String acct) { return RelayService.this.proxyPort(target, acct); }
                    public String proxyPublicUrl(String target, String acct) { return RelayService.this.proxyPublicUrl(target, acct); }
                    // 同源前缀边缘反代 (与 dao-relay Worker /i-init·/i/·/e/ 完全一致 → APK 与单网页同款在页渲染)
                    public String iInitRedirect(String token, String acc, String u) { return RelayService.this.iInitRedirect(token, acc, u); }
                    public String[] iProxy(String method, String prefix, String restPath, String acc, String genericOrigin, String body, String reqContentType, String reqHost) { return RelayService.this.iProxy(method, prefix, restPath, acc, genericOrigin, body, reqContentType, reqHost); }
                });
                localPort = localServer.start();
                android.util.Log.i("RTFlowTunnel", "local server on 0.0.0.0:" + localPort);
            } else {
                localPort = localServer.getPort();
            }
        } catch (Exception e) {
            android.util.Log.w("RTFlowTunnel", "local server start failed: " + e.getMessage());
        }
        refreshLanInfo();
    }

    /** 枚举本机非回环 IPv4 局域网地址, 拼成 http://<ip>:<port> 直连 URL 列表 → lanUrlsJson, 并广播状态。 */
    private void refreshLanInfo() {
        org.json.JSONArray arr = new org.json.JSONArray();
        try {
            int p = localPort;
            if (p > 0) {
                java.util.Enumeration<java.net.NetworkInterface> ifs = java.net.NetworkInterface.getNetworkInterfaces();
                while (ifs != null && ifs.hasMoreElements()) {
                    java.net.NetworkInterface ni = ifs.nextElement();
                    try { if (!ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue; } catch (Exception ignored) { continue; }
                    java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                    while (addrs.hasMoreElements()) {
                        java.net.InetAddress a = addrs.nextElement();
                        if (a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                        if (!(a instanceof java.net.Inet4Address)) continue;   // IPv4 局域网地址 (192.168/10/172.16-31)
                        arr.put("http://" + a.getHostAddress() + ":" + p);
                    }
                }
            }
        } catch (Exception ignored) {}
        lanUrlsJson = arr.toString();
        // LAN 信息变化时刷新一次状态广播 (沿用当前主隧道/备用隧道连通态)。
        rebroadcast(null);
    }

    // ── 路线B 去中心化隧道 (设备自带 cloudflared 快速隧道) ──────────────────
    /** 当前会话 token (与 relay-config 一致), 供 LocalServer Bearer 鉴权。 */
    private String relayToken() {
        try {
            String dyn = readUserFile("relay-config.json");
            if (dyn != null && dyn.length() > 5) return new org.json.JSONObject(dyn).optString("token", "");
        } catch (Exception ignored) {}
        return "";
    }
    /** 把 cloudflared 转发来的 frame 喂给引擎 serveLocal, 阻塞拿回 {status,bodyText} (≤60s)。
     *  浏览器跑 APK 真实页面时, 其 Native 桥重定向到的两条专用路由在此就地处理 (不进引擎):
     *    · /api/native — 值返回型 Native 方法 (状态读取 / 隧道·E2E·配置 读写 / 金库读写)。
     *    · /api/http   — 原生 HTTP (手机侧发起, 绕 CORS, 带账号 auth1), 即 DaoCloud 的底座。 */
    String dispatchLocal(String frameJson) throws Exception {
        try {
            org.json.JSONObject f = new org.json.JSONObject(frameJson);
            String fpath = f.optString("path", "");
            if ("/api/native".equals(fpath)) return webNative(f.optJSONObject("body"));
            if ("/api/http".equals(fpath))   return webHttp(f.optJSONObject("body"));
            if ("/api/mirror".equals(fpath)) return webMirror(f.optJSONObject("body"));
        } catch (Exception ignored) {}
        final String reqId = "L" + System.nanoTime();
        java.util.concurrent.SynchronousQueue<String> q = new java.util.concurrent.SynchronousQueue<>();
        pendingLocal.put(reqId, q);
        final String fj = frameJson;
        main.post(() -> { if (engine != null) try {
            engine.evaluateJavascript("window.__localServe&&window.__localServe(" + HttpBridge.jsonStr(reqId) + "," + HttpBridge.jsonStr(fj) + ")", null);
        } catch (Exception ignored) {} });
        try {
            String r = q.poll(60, java.util.concurrent.TimeUnit.SECONDS);
            if (r == null) throw new Exception("engine_timeout");
            return r;
        } finally { pendingLocal.remove(reqId); }
    }

    // ── 浏览器跑 APK 真实页面: 静态资源服务 + Native 桥就地实现 ─────────────────

    /** 浏览器拿 APK 自身的真实页面与其 JS 资源。HTML 注入 remote-native 垫片 → 页面零改动运行。 */
    String[] staticAsset(String path) {
        if (path == null) return null;
        String name;
        // 入口 = 单一真源网页外壳 console.html (= dao-relay Worker 的 /console 同一文件):
        //   含标签条 + 板块 + 实时镜像 + 橙色在场 + N人在线 + openInPage(/i-init→/i/<号>/ 同源前缀反代)。
        //   APK 本机 LocalServer(经 cloudflared/局域网)与 Worker /console 服务同一文件 → APK 与单网页逐字节完全一致。
        //   单页直链仍可达 (如 /switch.html), 供外壳内嵌与直接打开。
        if (path.equals("/") || path.equals("/app") || path.equals("/app/")
                || path.equals("/index.html") || path.equals("/console")
                || path.equals("/console.html")
                || path.equals("/shell") || path.equals("/home")) name = "console.html";
        else if (path.equals("/mirror") || path.equals("/mirror/")) name = "mirror.html";   // 投屏镜像入口
        else if (path.startsWith("/") && path.indexOf('/', 1) < 0
                && (path.endsWith(".html") || path.endsWith(".js"))) name = path.substring(1);
        else return null;
        // 仅服务白名单目录内确实存在的资源, 杜绝路径穿越。
        if (name.contains("..") || name.contains("/")) return null;
        String body = readAsset("engine/" + name);
        if (body == null || body.isEmpty()) return null;
        if (name.endsWith(".js")) return new String[]{"application/javascript; charset=utf-8", body};
        return new String[]{"text/html; charset=utf-8", injectShim(body)};
    }

    /** 在 <head> 最前注入垫片脚本, 保证它先于页面自身脚本 (var N = window.Native||{}) 执行。 */
    private static String injectShim(String html) {
        String tag = "<script src=\"/__rn.js\"></script>";
        if (html.contains("/__rn.js")) return html;
        int h = html.indexOf("<head");
        if (h >= 0) { int gt = html.indexOf('>', h); if (gt >= 0) return html.substring(0, gt + 1) + "\n" + tag + html.substring(gt + 1); }
        return tag + "\n" + html;
    }

    /** 反向代理外站顶层文档 (破 X-Frame-Options/CSP frame-ancestors): 原生抓取 → 剥框限响应/meta → 注入 <base>
     *  让相对资源回源站直取 → 同源回服, 使外站能被外壳 iframe 内嵌。诚实边界: 需登录态/同源 XHR 的重型 SPA
     *  仍可能因鉴权/CORS 不完整 (子资源直连源站, 跨域 API 不带本源 cookie); 静态/可公开内嵌站点可用。 */
    String[] embedDoc(String url) {
        try {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return null;
            final java.util.concurrent.SynchronousQueue<String> q = new java.util.concurrent.SynchronousQueue<>();
            HttpBridge.Cb cb = (id, json) -> { try { q.offer(json == null ? "{}" : json, 5, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {} };
            HttpBridge.exec("E" + System.nanoTime(), "GET", url,
                    "{\"Accept\":\"text/html,application/xhtml+xml,*/*\"}", "", cb);
            String res = q.poll(45, java.util.concurrent.TimeUnit.SECONDS);
            if (res == null) return null;
            org.json.JSONObject o = new org.json.JSONObject(res);
            if (o.optInt("status", 0) < 200 || o.optInt("status", 0) >= 400) return null;
            String html = o.optString("text", "");
            if (html.isEmpty()) return null;
            return new String[]{"text/html; charset=utf-8", stripFraming(html, url)};
        } catch (Exception e) { return null; }
    }

    /** 注入 <base> 让相对资源回源站; 剥掉页内 CSP <meta> (X-Frame-Options/CSP 响应头本就不会被我们回服)。 */
    private static String stripFraming(String html, String url) {
        String origin;
        try { java.net.URL u = new java.net.URL(url); origin = u.getProtocol() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : ""); }
        catch (Exception e) { origin = ""; }
        html = html.replaceAll("(?is)<meta[^>]+http-equiv\\s*=\\s*[\"']?content-security-policy[\"']?[^>]*>", "");
        if (!origin.isEmpty() && !html.toLowerCase().contains("<base")) {
            String base = "<base href=\"" + origin + "/\">";
            int h = html.indexOf("<head");
            if (h >= 0) { int gt = html.indexOf('>', h); if (gt >= 0) return html.substring(0, gt + 1) + base + html.substring(gt + 1); }
            return base + html;
        }
        return html;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  凭证转发 + 全量重写反向代理 /px/<acct>/<absurl>
    //  ── 鱼和熊掌兼得: 让外站(含 app.devin.ai 登录态)能在 app.html 外壳内 iframe 渲染。
    //  破三重限制: ① X-Frame-Options(我们不回服框限头) ② CORS(子资源/API 全同源经本代理)
    //              ③ 跨域鉴权(代理服务端按 acct 注入该号 Bearer auth1 + x-cog-org-id 回打源站)。
    //  登录态种子复刻 TabActivity.buildInjection: localStorage 种子 + cookie, 与原生多实例逐键一致。
    //  诚实边界: WebSocket/SSE 实时流无法经 HTTP 代理(留直连·跨域鉴权不全) → 会话内容可渲染, 实时增量可能不更新。
    // ════════════════════════════════════════════════════════════════════════
    String[] embedProxy(String method, String url, String acct, String body, String reqCtype, String reqHost) {
        try {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return null;
            java.net.URL u = new java.net.URL(url);
            String host = u.getHost() == null ? "" : u.getHost();
            String origin = u.getProtocol() + "://" + host + (u.getPort() > 0 ? ":" + u.getPort() : "");
            boolean devin = host.endsWith("devin.ai") || host.endsWith("cognition.ai");
            String pathOnly = u.getPath() == null ? "" : u.getPath();
            String ctOut = guessType(pathOnly, url);
            boolean isText = ctOut.startsWith("text/") || ctOut.equals("application/json")
                    || ctOut.equals("image/svg+xml") || ctOut.equals("application/javascript")
                    || ctOut.equals("application/manifest+json");
            boolean isHtml = ctOut.equals("text/html");

            // 账号注入: 取该号 auth1/org → Bearer + x-cog-org-id (= 原生多实例鉴权等价物)
            org.json.JSONObject acc = devin ? findAcct(acct) : null;
            String auth1 = acc == null ? "" : acc.optString("auth1", "");
            String org = acc == null ? "" : acc.optString("orgId", "");
            org.json.JSONObject hdr = new org.json.JSONObject();
            hdr.put("Accept", isHtml ? "text/html,application/xhtml+xml,*/*" : "*/*");
            if (reqCtype != null && !reqCtype.isEmpty() && !"GET".equalsIgnoreCase(method)) hdr.put("Content-Type", reqCtype);
            if (devin && !auth1.isEmpty()) { hdr.put("Authorization", "Bearer " + auth1); if (!org.isEmpty()) hdr.put("x-cog-org-id", org); }

            final java.util.concurrent.SynchronousQueue<String> q = new java.util.concurrent.SynchronousQueue<>();
            HttpBridge.Cb cb = (id, json) -> { try { q.offer(json == null ? "{}" : json, 6, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {} };
            String rid = "PX" + System.nanoTime();
            if (isText) HttpBridge.exec(rid, method, url, hdr.toString(), body, cb);
            else        HttpBridge.execB64(rid, method, url, hdr.toString(), body, cb);
            String res = q.poll(50, java.util.concurrent.TimeUnit.SECONDS);
            if (res == null) return null;
            org.json.JSONObject o = new org.json.JSONObject(res);
            int status = o.optInt("status", 0);
            if (status < 200) return null;     // 0 = 抓取异常
            String statusStr = String.valueOf(status);

            if (isText) {
                String text = o.optString("text", "");
                if (isHtml) text = rewriteDoc(text, origin, acct, acc);
                else if (devin && ctOut.contains("json") && text != null && text.contains("webapp_host")) text = rewriteWebappHost(text, reqHost, url);
                return new String[]{ctOut + (ctOut.startsWith("text/") || ctOut.contains("json") ? "; charset=utf-8" : ""), text, "text", statusStr};
            } else {
                return new String[]{ctOut, o.optString("b64", ""), "b64", statusStr};
            }
        } catch (Exception e) { return null; }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  根挂载透明代理 (单端口 = 单 (站, 号)) — 鱼与熊掌的「熊掌」, 让登录态重型 SPA 完整渲染。
    //  路径前缀 /px 代理会污染 SPA 的 location → 客户端路由(pushState 改根路径)错乱、懒加载 chunk 解析到根 404。
    //  根挂载: 独立端口的根 / 即源站根 → 真实路径逐字一致, 0 改写, 路由/chunk/api 全自然命中 (AVD 实测登录态秒开)。
    // ════════════════════════════════════════════════════════════════════════
    private final java.util.Map<String, ProxyServer> proxyServers = new java.util.concurrent.ConcurrentHashMap<>();
    // 公网根挂载: 每 (源站,账号) 一条专属 cloudflared 快速隧道, 把其根挂载端口暴露成独立 https 公网 origin。
    private final java.util.Map<String, TunnelManager> proxyTunnels = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Map<String, String> proxyTunnelUrls = new java.util.concurrent.ConcurrentHashMap<>();

    /** 为 (目标站 origin, 账号) 分配/复用根挂载代理端口 → 端口号 (>0); -1 失败。同 (站,号) 复用同端口供 SPA 大量子资源共享。 */
    int proxyPort(String target, String acct) {
        try {
            if (target == null || target.isEmpty()) return -1;
            java.net.URL u = new java.net.URL(target);
            String origin = u.getProtocol() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
            String a = (acct == null || acct.isEmpty()) ? "_" : acct;
            String key = origin + "|" + a;
            ProxyServer ps = proxyServers.get(key);
            if (ps != null && ps.isRunning()) return ps.getPort();
            ps = new ProxyServer(origin, a, (method, url, ac, body, ct, accept, reqHost) -> embedRoot(method, url, ac, body, ct, accept, reqHost));
            int port = ps.start();
            proxyServers.put(key, ps);
            return port;
        } catch (Exception e) { return -1; }
    }

    /** 公网根挂载: 为 (源站,账号) 的根挂载端口再起一条专属 cloudflared 快速隧道 → 返回该端口的 https 公网 URL。
     *  公网任意浏览器据此 iframe 内嵌即享根挂载(真实路径逐字一致, 不必回退 /px); 每 (站,号) 复用同隧道; 失败返回 ""。 */
    String proxyPublicUrl(String target, String acct) {
        try {
            int port = proxyPort(target, acct);
            if (port <= 0) return "";
            java.net.URL u = new java.net.URL(target);
            String origin = u.getProtocol() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
            final String key = origin + "|" + ((acct == null || acct.isEmpty()) ? "_" : acct);
            String have = proxyTunnelUrls.get(key);
            TunnelManager ex = proxyTunnels.get(key);
            if (have != null && !have.isEmpty() && ex != null && ex.isAlive()) return have;
            if (ex != null) { try { ex.stop(); } catch (Exception ignored) {} proxyTunnels.remove(key); proxyTunnelUrls.remove(key); }
            TunnelManager tm = new TunnelManager(this, port, new NativeTunnel.Callback() {
                public void onUrl(String url) { proxyTunnelUrls.put(key, url); }
                public void onLog(String line) { android.util.Log.i("RTFlowTunnel", "[px-cf] " + line); }
                public void onExit(int code) { proxyTunnelUrls.remove(key); }
            });
            proxyTunnels.put(key, tm);
            if (!tm.start()) { proxyTunnels.remove(key); return ""; }
            for (int i = 0; i < 100; i++) {   // 等公网 URL 就绪 (快速隧道边缘握手 ~5-15s), 上限 20s
                String url = proxyTunnelUrls.get(key);
                if (url != null && !url.isEmpty()) return url;
                Thread.sleep(200);
            }
            return "";
        } catch (Exception e) { return ""; }
    }

    /** 根挂载抓取: 抓 url(代 acct 注入 Bearer auth1 + x-cog-org-id) → 顶层 HTML 剥 CSP + 注入登录态种子。
     *  无 base / 无 URL 改写垫片 (根挂载下源站同源, 真实路径自然命中)。回服时用源站真实 Content-Type (Connect-RPC 校验)。 */
    String[] embedRoot(String method, String url, String acct, String body, String reqCtype, String accept, String reqHost) {
        try {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return null;
            java.net.URL u = new java.net.URL(url);
            String host = u.getHost() == null ? "" : u.getHost();
            boolean devin = host.endsWith("devin.ai") || host.endsWith("cognition.ai");
            String pathOnly = u.getPath() == null ? "" : u.getPath();
            String ctGuess = guessType2(pathOnly, accept);
            boolean isText = ctGuess.startsWith("text/") || ctGuess.equals("application/json")
                    || ctGuess.equals("image/svg+xml") || ctGuess.equals("application/javascript")
                    || ctGuess.equals("application/manifest+json");
            boolean isHtmlGuess = ctGuess.equals("text/html");

            org.json.JSONObject acc = devin ? findAcct(acct) : null;
            String auth1 = acc == null ? "" : acc.optString("auth1", "");
            String org = acc == null ? "" : acc.optString("orgId", "");
            org.json.JSONObject hdr = new org.json.JSONObject();
            hdr.put("Accept", accept == null || accept.isEmpty() ? (isHtmlGuess ? "text/html,application/xhtml+xml,*/*" : "*/*") : accept);
            if (reqCtype != null && !reqCtype.isEmpty() && !"GET".equalsIgnoreCase(method)) hdr.put("Content-Type", reqCtype);
            if (devin && !auth1.isEmpty()) { hdr.put("Authorization", "Bearer " + auth1); if (!org.isEmpty()) hdr.put("x-cog-org-id", org); }

            final java.util.concurrent.SynchronousQueue<String> q = new java.util.concurrent.SynchronousQueue<>();
            HttpBridge.Cb cb = (id, json) -> { try { q.offer(json == null ? "{}" : json, 6, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {} };
            String rid = "PR" + System.nanoTime();
            if (isText) HttpBridge.exec(rid, method, url, hdr.toString(), body, cb);
            else        HttpBridge.execB64(rid, method, url, hdr.toString(), body, cb);
            String res = q.poll(50, java.util.concurrent.TimeUnit.SECONDS);
            if (res == null) return null;
            org.json.JSONObject o = new org.json.JSONObject(res);
            int status = o.optInt("status", 0);
            if (status < 200) return null;
            String statusStr = String.valueOf(status);
            String realCt = o.optString("ctype", "");

            if (isText) {
                String text = o.optString("text", "");
                String ct = !realCt.isEmpty() ? realCt : ctGuess;
                boolean htmlResp = ct.toLowerCase().contains("text/html");
                if (htmlResp) { text = injectSeed(text, acc); if (!ct.toLowerCase().contains("charset")) ct = "text/html; charset=utf-8"; }
                else {
                    if (devin && ct.toLowerCase().contains("json") && text != null && text.contains("webapp_host")) text = rewriteWebappHost(text, reqHost, url);
                    if (!ct.toLowerCase().contains("charset") && (ct.startsWith("text/") || ct.contains("json") || ct.contains("javascript"))) ct = ct + "; charset=utf-8";
                }
                return new String[]{ct, text, "text", statusStr};
            } else {
                return new String[]{!realCt.isEmpty() ? realCt : ctGuess, o.optString("b64", ""), "b64", statusStr};
            }
        } catch (Exception e) { return null; }
    }

    /** 根挂载: 顶层 HTML 剥 CSP <meta> + 在源站脚本前注入登录态种子。无 base / 无 URL 改写。 */
    private static String injectSeed(String html, org.json.JSONObject acc) {
        html = html.replaceAll("(?is)<meta[^>]+http-equiv\\s*=\\s*[\"']?content-security-policy[\"']?[^>]*>", "");
        String a1 = acc == null ? "" : acc.optString("auth1", "");
        if (a1.isEmpty()) return html;     // 非 devin / 无登录号 → 仅剥 CSP
        String uid = acc.optString("userId", ""), org = acc.optString("orgId", ""), on = acc.optString("orgName", "");
        String inject = "<script>" + loginSeed(a1, uid, org, on) + whInstall() + "</script>\n";
        int h = indexOfIgnoreCase(html, "<head");
        if (h >= 0) { int gt = html.indexOf('>', h); if (gt >= 0) return html.substring(0, gt + 1) + inject + html.substring(gt + 1); }
        return inject + html;
    }

    /** 服务端改写 JSON 响应里的 webapp_host = 本次请求 Host (AGENTS 踩埑 6 之正解): auth0 SPA 读服务端下发
     *  webapp_host, 一旦 !== location.host 即硬跳真站 /login。代理下 location.host = 本代理 Host, 故把响应里的
     *  webapp_host 改写成本次 Host → 校验通过、留在代理源保持登录。 */
    private static String rewriteWebappHost(String json, String reqHost, String url) {
        try {
            if (json == null || reqHost == null || reqHost.isEmpty()) return json;
            String h = reqHost.trim();
            // 值可能是 null (普通组 = 用默认主机 app.devin.ai) 或 "字符串"; 两者都改成本代理 host。
            String rewritten = json.replaceAll("(\"webapp_host\"\\s*:\\s*)(?:null|\"[^\"]*\")",
                    "$1\"" + java.util.regex.Matcher.quoteReplacement(h) + "\"");
            if (!rewritten.equals(json)) android.util.Log.i("rtflow-proxy", "webapp_host rewritten -> " + h + " for " + url);
            return rewritten;
        } catch (Exception e) { return json; }
    }

    /** webapp_host 改写器 (函数体 _RW): 把字符串里的 "webapp_host":"..." 改写成本页 location.host。 */
    private static String whRw() {
        return "function(v){try{return (typeof v==='string'&&v.indexOf('webapp_host')>=0)?"
            + "v.replace(/(\"webapp_host\"\\s*:\\s*)(null|\"[^\"]*\")/g,'$1\"'+location.host+'\"'):v;}catch(e){return v;}}";
    }
    /** webapp_host 守卫: auth0 版 SPA 读服务端下发的 webapp_host, 一旦 webapp_host !== location.host
     *  即 location.href= 硬跳真站 `/login`(绝对 URL 无法 hook) → 代理/根挂载源被弹回真站登录页 = 「登录不进去」。
     *  webapp_host 真源 = SPA 写进 localStorage 的 post-auth 解析值 (F.data 取自 localStorage), 故 hook localStorage.setItem
     *  把写入值里的 webapp_host 改写成本页 location.host (并扫一遍已存键); 另兜底改写 fetch 的 JSON 响应。
     *  以 location.host 为真 → 直连/局域网/cloudflared 隧道/Worker 全准 (无需服务端预知公网 host)。 */
    private static String whInstall() {
        return "try{if(!window.__rnWH){window.__rnWH=1;var _RW=" + whRw() + ";"
            + "try{var _os=localStorage.setItem.bind(localStorage);localStorage.setItem=function(k,v){return _os(k,_RW(v));};"
            + "for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i);var v=localStorage.getItem(k);var nv=_RW(v);if(nv!==v)_os(k,nv);}}catch(e){}"
            + "try{var _of=window.fetch;if(_of)window.fetch=function(){return _of.apply(this,arguments).then(function(r){try{var ct=(r.headers&&r.headers.get&&(r.headers.get('content-type')||''))||'';if(ct.indexOf('json')<0)return r;return r.clone().text().then(function(t){try{if(!t||t.indexOf('webapp_host')<0)return r;var nt=_RW(t);if(nt===t)return r;return new Response(nt,{status:r.status,statusText:r.statusText,headers:r.headers});}catch(e){return r;}}).catch(function(){return r;});}catch(e){return r;}});};}catch(e){}"
            + "}}catch(e){}";
    }

    /** 登录态种子 (逐键复刻 TabActivity.buildInjection 多实例注入)。根挂载下源站同源, 无需改写垫片。 */
    private static String loginSeed(String a1, String uid, String org, String on) {
        return "(function(){try{var A1=" + js(a1) + ",UID=" + js(uid) + ",ORG=" + js(org) + ",ON=" + js(on) + ";"
            + "localStorage.setItem('auth1_session',JSON.stringify({token:A1,userId:UID}));"
            + "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');"
            + "if(UID)localStorage.setItem('known-org-ids-'+UID,JSON.stringify([ORG]));"
            + "if(ORG)localStorage.setItem('last-internal-org-for-external-org-v1-null',ORG);"
            + "if(ORG&&UID&&ON){var K='post-auth-v3-null-'+UID+'-org_name-'+ON;if(!localStorage.getItem(K))localStorage.setItem(K,JSON.stringify({externalOrgId:null,userId:UID,internalOrgId:ORG,orgName:ON,result:{resolved_external_org_id:null,org_id:ORG,org_name:ON,is_valid_resource:true}}));}"
            + "document.cookie='webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';"
            + "}catch(e){}})();";
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 同源前缀边缘反代 (dao-relay Worker pxProxy 的 APK 端口实现) —— APK↔单网页完全一致:
    //   console.html 的 openInPage 一律走 /i-init → /i/<acc>/<path>; 无论该 console 由 Worker 还是
    //   由本机 LocalServer(经 cloudflared/局域网)服务, 渲染逻辑逐字节一致 → 「把整个浏览器塞进单网页」。
    //   · /i/<acc>/..  Devin 多源(app/ws/reg/cdn/ss) 同源前缀代理 + 该号 auth1 注入 + webapp_host 改写;
    //   · /e/<b64>/..  任意第三方站同源前缀代理(无账号注入)。
    //   认证以本机金库 findAcct(acc) 直查(APK 自带金库, 故 /i-init 不必下发 cookie)。
    // ═══════════════════════════════════════════════════════════════════════
    private static final String PX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

    /** /i-init: 校验 token + 该号有登录态 → 回 {redirect:/i/<encAcc>/<u>}; null=不可用。 */
    String iInitRedirect(String token, String acc, String u) {
        try {
            if (token == null || !token.equals(relayToken())) return null;
            org.json.JSONObject a = findAcct(acc);
            if (a == null || a.optString("auth1", "").isEmpty()) return null;
            if (u == null || u.isEmpty()) u = "/";
            if (u.charAt(0) != '/') u = "/" + u;
            return "/i/" + enc(acc) + u;
        } catch (Exception e) { return null; }
    }

    /** 同源前缀边缘反代抓取+改写 (pxProxy 的 Java 端口)。genericOrigin==null → Devin(注认证); 非 null → 第三方站。
     *  返回 {contentType, payload, encoding("text"|"b64"), status}; null=失败。 */
    String[] iProxy(String method, String prefix, String restPath, String acct, String genericOrigin,
                    String body, String reqCtype, String reqHost) {
        try {
            boolean isDevin = (genericOrigin == null);
            String base, upath;
            if (isDevin) {
                String rp = restPath;
                if (rp.startsWith("/__ws/")) { base = "https://windsurf.com"; upath = rp.substring(5); }
                else if (rp.startsWith("/__reg/")) { base = "https://register.windsurf.com"; upath = rp.substring(6); }
                else if (rp.startsWith("/__cdn/")) { base = "https://server.codeium.com"; upath = rp.substring(6); }
                else if (rp.startsWith("/__ss/")) { base = "https://server.self-serve.windsurf.com"; upath = rp.substring(5); }
                else { base = "https://app.devin.ai"; upath = rp; }
            } else { base = genericOrigin; upath = restPath; }
            if (upath.isEmpty() || upath.charAt(0) != '/') upath = "/" + upath;
            String url = base + upath;
            java.net.URL u = new java.net.URL(url);
            String pathOnly = u.getPath() == null ? "" : u.getPath();
            String ctGuess = guessType2(pathOnly, "*/*");
            boolean isText = ctGuess.startsWith("text/") || ctGuess.contains("json") || ctGuess.contains("javascript")
                    || ctGuess.equals("image/svg+xml") || ctGuess.contains("manifest");

            org.json.JSONObject acc = isDevin ? findAcct(acct) : null;
            String auth1 = acc == null ? "" : acc.optString("auth1", "");
            String org = acc == null ? "" : acc.optString("orgId", "");
            org.json.JSONObject hdr = new org.json.JSONObject();
            hdr.put("User-Agent", PX_UA);
            hdr.put("Accept", "*/*");
            hdr.put("Origin", base);
            hdr.put("Referer", base + "/");
            if (reqCtype != null && !reqCtype.isEmpty() && !"GET".equalsIgnoreCase(method)) hdr.put("Content-Type", reqCtype);
            if (isDevin && !auth1.isEmpty()) { hdr.put("Authorization", "Bearer " + auth1); if (!org.isEmpty()) hdr.put("x-cog-org-id", org); }

            final java.util.concurrent.SynchronousQueue<String> q = new java.util.concurrent.SynchronousQueue<>();
            HttpBridge.Cb cb = (id, jsn) -> { try { q.offer(jsn == null ? "{}" : jsn, 6, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {} };
            String rid = "IX" + System.nanoTime();
            if (isText) HttpBridge.exec(rid, method, url, hdr.toString(), body, cb);
            else        HttpBridge.execB64(rid, method, url, hdr.toString(), body, cb);
            String res = q.poll(50, java.util.concurrent.TimeUnit.SECONDS);
            if (res == null) return null;
            org.json.JSONObject o = new org.json.JSONObject(res);
            int status = o.optInt("status", 0);
            if (status < 200) return null;
            String statusStr = String.valueOf(status);
            String realCt = o.optString("ctype", "");

            if (isText) {
                String text = o.optString("text", "");
                String ct = !realCt.isEmpty() ? realCt : ctGuess;
                String low = ct.toLowerCase();
                boolean isHtml = low.contains("text/html");
                boolean isJs = low.contains("javascript");
                boolean isJson = low.contains("json");
                boolean isCss = low.contains("text/css");
                if (isHtml) {
                    if (isDevin) {
                        text = text.replace("https://app.devin.ai", prefix)
                                .replace("https://windsurf.com/", prefix + "/__ws/")
                                .replace("https://register.windsurf.com/", prefix + "/__reg/")
                                .replace("https://server.codeium.com/", prefix + "/__cdn/")
                                .replace("https://server.self-serve.windsurf.com/", prefix + "/__ss/");
                    } else {
                        text = text.replace(genericOrigin, prefix);
                    }
                    text = text.replaceAll("(?i)(\\s(?:href|src|action)\\s*=\\s*)([\"'])/(?!/)",
                            "$1$2" + java.util.regex.Matcher.quoteReplacement(prefix) + "/");
                    text = text.replaceAll("(?is)<meta[^>]+http-equiv\\s*=\\s*[\"']?content-security-policy[\"']?[^>]*>", "");
                    String bridge = isDevin ? pxAuthBridge(prefix, acc) : pxGenericBridge(prefix, genericOrigin);
                    int h = indexOfIgnoreCase(text, "<head");
                    if (h >= 0) { int gt = text.indexOf('>', h); if (gt >= 0) text = text.substring(0, gt + 1) + bridge + text.substring(gt + 1); else text = bridge + text; }
                    else text = bridge + text;
                    ct = "text/html; charset=utf-8";
                } else if (isJs) {
                    if (isDevin && (text.contains("https://app.devin.ai") || text.contains("https://windsurf.com/")
                            || text.contains("https://register.windsurf.com/") || text.contains("https://server.codeium.com/")
                            || text.contains("https://server.self-serve.windsurf.com/"))) {
                        text = text.replace("https://app.devin.ai", prefix)
                                .replace("https://windsurf.com/", prefix + "/__ws/")
                                .replace("https://register.windsurf.com/", prefix + "/__reg/")
                                .replace("https://server.codeium.com/", prefix + "/__cdn/")
                                .replace("https://server.self-serve.windsurf.com/", prefix + "/__ss/");
                    }
                    // Vite assetsURL(base="/") 预加载不带前缀 → 改写为读运行时 window.__PXFX → 资源走 /i/<acc>/assets/..
                    if (isDevin) text = text.replaceAll("function\\(([A-Za-z_$][\\w$]*)\\)\\{return`/`\\+\\1\\}",
                            "function($1){return(window.__PXFX||\"\")+\"/\"+$1}");
                    if (!isDevin && text.contains(genericOrigin)) text = text.replace(genericOrigin, prefix);
                } else if (isJson && isDevin) {
                    if (text.contains("webapp_host")) text = rewriteWebappHost(text, reqHost, url);
                } else if (isCss) {
                    if (isDevin && text.contains("https://app.devin.ai/")) text = text.replace("https://app.devin.ai/", prefix + "/");
                    else if (!isDevin && text.contains(genericOrigin)) text = text.replace(genericOrigin, prefix);
                }
                low = ct.toLowerCase();
                if (!low.contains("charset") && (low.startsWith("text/") || low.contains("json") || low.contains("javascript"))) ct = ct + "; charset=utf-8";
                return new String[]{ct, text, "text", statusStr};
            } else {
                return new String[]{!realCt.isEmpty() ? realCt : ctGuess, o.optString("b64", ""), "b64", statusStr};
            }
        } catch (Exception e) { return null; }
    }

    /** 认证桥接 (前缀模式·源自 worker.js pxAuthBridge): nsShim 按 prefix 命名空间隔离 localStorage(同源多实例不串号)
     *  + 注入 auth1/org 登录态种子 + __pf/__strip 路由前缀虚拟化 + 拦 fetch/XHR/EventSource 归一前缀挂 Bearer。 */
    private static String pxAuthBridge(String prefix, org.json.JSONObject acc) {
        String a1 = acc == null ? "" : acc.optString("auth1", "");
        String uid = acc == null ? "" : acc.optString("userId", "");
        String org = acc == null ? "" : acc.optString("orgId", "");
        String on = (acc == null ? "" : acc.optString("orgName", "")).replaceAll("['\"\\\\<>]", "");
        String P = prefix + "::";
        return "<script>(function(){try{"
            + "try{(function(){var L=window.localStorage;var P=" + js(P) + ";"
            + "var og=L.getItem.bind(L),os=L.setItem.bind(L),orm=L.removeItem.bind(L);"
            + "L.getItem=function(k){return og(P+k);};L.setItem=function(k,v){return os(P+k,v);};L.removeItem=function(k){return orm(P+k);};"
            + "L.clear=function(){try{var ks=[],i;for(i=0;i<L.length;i++){var kk=L.key(i);if(kk&&kk.indexOf(P)===0)ks.push(kk);}for(i=0;i<ks.length;i++)orm(ks[i]);}catch(e){}};"
            + "})();}catch(e){}"
            + "var __a1=" + js(a1) + ";var __uid=" + js(uid) + ";var __org=" + js(org) + ";var __orgName=" + js(on) + ";"
            + "if(__a1){localStorage.setItem('auth1_session',JSON.stringify({token:__a1,userId:__uid}));"
            + "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');"
            + "if(__uid)localStorage.setItem('known-org-ids-'+__uid,JSON.stringify([__org]));"
            + "if(__org)localStorage.setItem('last-internal-org-for-external-org-v1-null',__org);"
            + "if(__org&&__uid&&__orgName){var __k='post-auth-v3-null-'+__uid+'-org_name-'+__orgName;"
            + "if(!localStorage.getItem(__k))localStorage.setItem(__k,JSON.stringify({externalOrgId:null,userId:__uid,internalOrgId:__org,orgName:__orgName,result:{resolved_external_org_id:null,org_id:__org,org_name:__orgName,is_valid_resource:true}}));}}"
            + "document.cookie='webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';"
            + "var __base=" + js(prefix) + ";var __pfx=" + js(prefix) + ";var __abs='https://app.devin.ai';var __O=location.origin;window.__PXFX=__pfx;"
            + "var __pf=function(u){if(typeof u!=='string')return u;u=u.split(__abs).join(__O+__pfx);"
            + "if(u.indexOf(__O)===0){var p=u.slice(__O.length);if(p.charAt(0)==='/'&&p!==__pfx&&p.indexOf(__pfx+'/')!==0&&p.indexOf(__pfx)!==0){u=__O+__pfx+p;}return u;}"
            + "if(__pfx&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u!==__pfx&&u.indexOf(__pfx+'/')!==0){u=__pfx+u;}return u;};"
            + "var __strip=function(u){if(typeof u!=='string')return u;u=u.split(__abs).join(__O);"
            + "if(__pfx){if(u.indexOf(__O+__pfx)===0){var r=u.slice((__O+__pfx).length)||'/';u=__O+(r.charAt(0)==='/'?r:'/'+r);}"
            + "else if(u.charAt(0)==='/'&&(u===__pfx||u.indexOf(__pfx+'/')===0)){var r2=u.slice(__pfx.length)||'/';u=r2.charAt(0)==='/'?r2:'/'+r2;}}return u;};"
            + "var _ps=history.pushState,_rs=history.replaceState;"
            + "try{var _la=window.location.assign.bind(window.location);window.location.assign=function(u){return _la(__strip(u));};}catch(e){}"
            + "try{var _lr=window.location.replace.bind(window.location);window.location.replace=function(u){return _lr(__strip(u));};}catch(e){}"
            + "try{history.pushState=function(s,t,u){return _ps.call(history,s,t,__strip(u));};}catch(e){}"
            + "try{history.replaceState=function(s,t,u){return _rs.call(history,s,t,__strip(u));};}catch(e){}"
            + "try{if(__pfx&&location.pathname.indexOf(__pfx)===0){var __sp=location.pathname.slice(__pfx.length)||'/';if(__sp.charAt(0)!=='/')__sp='/'+__sp;_rs.call(history,history.state,'',__sp+location.search+location.hash);}}catch(e){}"
            + "var needAuth=function(u){return typeof u==='string'&&(u.charAt(0)==='/'||u.indexOf(__base)===0);};"
            + "var oF=window.fetch;window.fetch=function(u,o){var nu=u;try{if(typeof u==='string'){nu=__pf(u);}else if(u&&u.url){var ru=__pf(u.url);nu=(ru!==u.url)?new Request(ru,u):u;}}catch(e){nu=u;}o=o||{};"
            + "if(typeof nu==='string'&&needAuth(nu)&&typeof o.headers==='object'&&o.headers&&!Array.isArray(o.headers)){if(!o.headers['Authorization'])o.headers['Authorization']='Bearer '+__a1;if(!o.headers['x-cog-org-id'])o.headers['x-cog-org-id']=__org;}"
            + "return oF.call(this,nu,o);};"
            + "var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var nu=(typeof u==='string')?__pf(u):u;"
            + "var r=oX.apply(this,[m,nu].concat([].slice.call(arguments,2)));if(needAuth(nu)){try{this.setRequestHeader('Authorization','Bearer '+__a1);this.setRequestHeader('x-cog-org-id',__org);}catch(e){}}return r;};"
            + "try{var _ES=window.EventSource;if(_ES){var nES=function(u,o){return new _ES(__pf(u),o);};nES.prototype=_ES.prototype;try{nES.CONNECTING=_ES.CONNECTING;nES.OPEN=_ES.OPEN;nES.CLOSED=_ES.CLOSED;}catch(e){}window.EventSource=nES;}}catch(e){}"
            + "}catch(e){}})();</script>";
    }

    /** 第三方站轻量桥接 (源自 worker.js pxGenericBridge): 仅运行时前缀化动态 URL, 无账号注入。 */
    private static String pxGenericBridge(String prefix, String origin) {
        return "<script>(function(){try{var __pfx=" + js(prefix) + ";var __abs=" + js(origin) + ";var __O=location.origin;"
            + "var __pf=function(u){if(typeof u!=='string')return u;u=u.split(__abs).join(__O+__pfx);if(u.indexOf(__O)===0){var p=u.slice(__O.length);if(p.charAt(0)==='/'&&p!==__pfx&&p.indexOf(__pfx+'/')!==0&&p.indexOf(__pfx)!==0){u=__O+__pfx+p;}return u;}if(u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u!==__pfx&&u.indexOf(__pfx+'/')!==0){u=__pfx+u;}return u;};"
            + "var oF=window.fetch;window.fetch=function(u,o){var nu=u;try{if(typeof u==='string'){nu=__pf(u);}else if(u&&u.url){var ru=__pf(u.url);nu=(ru!==u.url)?new Request(ru,u):u;}}catch(e){nu=u;}return oF.call(this,nu,o);};"
            + "var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string')u=__pf(u);return oX.apply(this,[m,u].concat([].slice.call(arguments,2)));};"
            + "}catch(e){}})();</script>";
    }

    /** guessType 变体: 无扩展名非 api 路径用 Accept 区分导航(html) vs 数据(json, 真实 Content-Type 再覆盖头)。 */
    private static String guessType2(String path, String accept) {
        String t = guessType(path, path);
        if (!t.equals("text/html")) return t;     // 有明确扩展名或 /api/ → 用之
        if (accept != null && accept.toLowerCase().contains("text/html")) return "text/html";
        if (path != null && path.indexOf('.') < 0) return "application/json";   // 无扩展名非导航 → 数据
        return "text/html";
    }

    /** 从金库 accounts 取指定账号 (按 id/email) → 含 auth1/orgId/userId/orgName。 */
    private org.json.JSONObject findAcct(String acct) {
        if (acct == null || acct.isEmpty()) return null;
        try {
            String raw = vaultRead("accounts");
            if (raw == null || raw.isEmpty()) return null;
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject a = arr.optJSONObject(i);
                if (a == null) continue;
                if (acct.equals(a.optString("id")) || acct.equals(a.optString("email"))) {
                    if (!a.optString("auth1", "").isEmpty()) return a;
                }
            }
            // 未指定有效号 → 退化用首个已登录号 (acct=="_" 占位时)
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject a = arr.optJSONObject(i);
                if (a != null && !a.optString("auth1", "").isEmpty()) return a;
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** 顶层 HTML 改写: 剥 CSP <meta> → 注入 <base>(指向本代理前缀) + 登录态种子 + fetch/XHR 改写垫片
     *  → 根相对/绝对资源与 API 全经本代理同源直取, 且 API 带账号 Bearer。 */
    private static String rewriteDoc(String html, String origin, String acct, org.json.JSONObject acc) {
        String prefix = "/px/" + enc(acct == null ? "_" : acct) + "/";
        String baseHref = prefix + origin + "/";
        // 剥页内 CSP (response 头本就不回服)
        html = html.replaceAll("(?is)<meta[^>]+http-equiv\\s*=\\s*[\"']?content-security-policy[\"']?[^>]*>", "");
        // 根相对资源 → 相对 (去前导 /), 经 <base> 落到本代理前缀; 跳过协议相对 //
        html = html.replaceAll("(?i)(\\s(?:src|href|action)\\s*=\\s*[\"'])/(?!/)", "$1");
        String a1 = acc == null ? "" : acc.optString("auth1", "");
        String uid = acc == null ? "" : acc.optString("userId", "");
        String org = acc == null ? "" : acc.optString("orgId", "");
        String on = acc == null ? "" : acc.optString("orgName", "");
        String inject = "<base href=\"" + baseHref + "\">\n<script>" + seedShim(origin, prefix, a1, uid, org, on) + "</script>\n";
        int h = indexOfIgnoreCase(html, "<head");
        if (h >= 0) { int gt = html.indexOf('>', h); if (gt >= 0) return html.substring(0, gt + 1) + inject + html.substring(gt + 1); }
        return inject + html;
    }

    /** 登录态种子(复刻 TabActivity.buildInjection)+ fetch/XHR/import 改写垫片(指向本代理同源前缀)。 */
    private static String seedShim(String origin, String prefix, String a1, String uid, String org, String on) {
        return "(function(){try{"
            + whInstall()
            + "var TARGET=" + js(origin) + ",PREFIX=" + js(prefix) + ";"
            + "var A1=" + js(a1) + ",UID=" + js(uid) + ",ORG=" + js(org) + ",ON=" + js(on) + ";"
            + "if(A1){try{"
            + "localStorage.setItem('auth1_session',JSON.stringify({token:A1,userId:UID}));"
            + "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');"
            + "if(UID)localStorage.setItem('known-org-ids-'+UID,JSON.stringify([ORG]));"
            + "if(ORG)localStorage.setItem('last-internal-org-for-external-org-v1-null',ORG);"
            + "if(ORG&&UID&&ON){var K='post-auth-v3-null-'+UID+'-org_name-'+ON;if(!localStorage.getItem(K))localStorage.setItem(K,JSON.stringify({externalOrgId:null,userId:UID,internalOrgId:ORG,orgName:ON,result:{resolved_external_org_id:null,org_id:ORG,org_name:ON,is_valid_resource:true}}));}"
            + "document.cookie='webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';"
            + "}catch(e){}}"
            // 改写: 根相对/绝对(同源 TARGET)请求 → 本代理同源前缀 (服务端代账号注入鉴权 → 免 CORS + 带登录态)
            + "function P(u){try{if(typeof u!=='string'||!u)return u;"
            + "if(u.indexOf(PREFIX)===0||u.indexOf(location.origin+PREFIX)===0)return u;"
            + "var abs;if(/^https?:\\/\\//i.test(u))abs=u;else if(u.charAt(0)==='/')abs=TARGET+u;else return u;"
            + "if(abs.indexOf(TARGET)===0)return PREFIX+abs;return u;}catch(e){return u;}}"
            + "var of=window.fetch;if(of)window.fetch=function(i,init){try{if(typeof i==='string')i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);}catch(e){}return of.call(this,i,init);};"
            + "var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{u=P(u);}catch(e){}return oo.apply(this,[m,u].concat([].slice.call(arguments,2)));};"
            + "}catch(e){}})();";
    }

    private static int indexOfIgnoreCase(String s, String t) {
        if (s == null) return -1; int n = s.length(), m = t.length();
        for (int i = 0; i + m <= n; i++) if (s.regionMatches(true, i, t, 0, m)) return i;
        return -1;
    }
    private static String enc(String s) { try { return java.net.URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; } }
    /** JS 字符串字面量 (双引号包裹, 转义)。 */
    private static String js(String s) {
        if (s == null) return "\"\"";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) { char c = s.charAt(i);
            switch (c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '<': b.append("\\u003c"); break;
                default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); } }
        return b.append("\"").toString();
    }
    /** 按 URL 路径扩展名推断 Content-Type (HttpBridge 不回服源站头, 故就地推断)。 */
    private static String guessType(String path, String url) {
        String p = path.toLowerCase();
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".map")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".otf")) return "font/otf";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".avif")) return "image/avif";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".mp4")) return "video/mp4";
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.contains("/api/")) return "application/json";
        return "text/html";   // 无扩展名 = SPA 入口/客户端路由 → 回 index 外壳, 注入种子
    }

    /** /api/native — 值返回型 Native 方法就地执行, 回 {status,bodyText:{"r":...}}。 */
    private String webNative(org.json.JSONObject body) {
        Object r = null;
        try {
            String m = body == null ? "" : body.optString("m", "");
            org.json.JSONArray a = body == null ? new org.json.JSONArray() : body.optJSONArray("a");
            if (a == null) a = new org.json.JSONArray();
            r = nativeInvoke(m, a);
        } catch (Exception e) { r = null; }
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("r", r == null ? org.json.JSONObject.NULL : r);
            return "{\"status\":200,\"bodyText\":" + HttpBridge.jsonStr(o.toString()) + "}";
        } catch (Exception e) { return "{\"status\":200,\"bodyText\":\"{\\\"r\\\":null}\"}"; }
    }

    /** /api/mirror — 投屏镜像: 取帧 / 标签清单 / 反向输入。任意公网/局域网浏览器经 mirror.html 调用本路由,
     *  实时镜像并满血操控手机里那个被 app.devin.ai 信任的原生标签 (Bearer + remoteOps 双重闸门)。 */
    private String webMirror(org.json.JSONObject body) {
        try {
            if (!remoteOpsEnabled) return localJson("{\"ok\":false,\"error\":\"remote_ops_disabled\",\"hint\":\"在穿透面板启用远程操控\"}");
            MainActivity m = MainActivity.sInstance;
            if (m == null) { wakeHostStatic(); return localJson("{\"ok\":false,\"error\":\"no_host\",\"hint\":\"软件本体被后台杀, 已尝试唤回, 稍候重试\"}"); }
            String op = body == null ? "frame" : body.optString("op", "frame");
            if ("tabs".equals(op)) return localJson(m.ipcMirrorTabs());
            int tab = body == null ? -1 : body.optInt("tab", -1);
            if ("input".equals(op)) return localJson(m.ipcMirrorInput(tab, body));
            if ("activate".equals(op)) { m.ipcActivateTab(tab); return localJson("{\"ok\":true}"); }
            if ("nav".equals(op)) { m.ipcNavigate(tab, body.optString("action", "reload"), body.optString("url", "")); return localJson("{\"ok\":true}"); }
            // 默认取帧
            int q = body == null ? 55 : body.optInt("q", 55);
            int max = body == null ? 1080 : body.optInt("max", 1080);
            return localJson(m.ipcMirrorFrame(tab, q, max));
        } catch (Exception e) { return localJson("{\"ok\":false,\"error\":\"ex\"}"); }
    }
    /** 把一段已序列化 JSON 包成 LocalServer 期望的 {status,bodyText} 信封。 */
    private static String localJson(String bodyJson) {
        return "{\"status\":200,\"bodyText\":" + HttpBridge.jsonStr(bodyJson == null ? "{}" : bodyJson) + "}";
    }
    /** webNative/webHttp/webMirror 回的是 {status,bodyText} 信封; 取出 bodyText (即浏览器应直接收到的响应体)。 */
    private static String unwrapBody(String env) {
        try { return new org.json.JSONObject(env == null ? "{}" : env).optString("bodyText", "{}"); }
        catch (Exception e) { return "{}"; }
    }
    /** 静态唤回本体 (镜像取帧时本体被杀 → 冷启动拉起, 调用方稍候重试)。 */
    private void wakeHostStatic() {
        try { startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP)); }
        catch (Exception ignored) {}
    }
    /** /api/http — 手机侧发起原生 HTTP (绕 CORS, 带账号 auth1), 阻塞拿回 {status,headers,body}。 */
    private String webHttp(org.json.JSONObject body) {
        try {
            final boolean b64 = body.optBoolean("b64", false);
            String method = body.optString("method", "GET");
            String url = body.optString("url", "");
            String headers = body.optJSONObject("headers") != null ? body.optJSONObject("headers").toString() : "{}";
            String reqBody = body.optString("body", "");
            final java.util.concurrent.SynchronousQueue<String> q = new java.util.concurrent.SynchronousQueue<>();
            HttpBridge.Cb cb = (id, json) -> { try { q.offer(json == null ? "{}" : json, 5, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {} };
            String rid = "W" + System.nanoTime();
            if (b64) HttpBridge.execB64(rid, method, url, headers, reqBody, cb);
            else HttpBridge.exec(rid, method, url, headers, reqBody, cb);
            String res = q.poll(95, java.util.concurrent.TimeUnit.SECONDS);
            if (res == null) res = "{\"status\":0,\"error\":\"timeout\"}";
            return "{\"status\":200,\"bodyText\":" + HttpBridge.jsonStr(res) + "}";
        } catch (Exception e) {
            return "{\"status\":200,\"bodyText\":\"{\\\"status\\\":0,\\\"error\\\":\\\"bridge\\\"}\"}";
        }
    }

    /** 值返回型 Native 方法的就地实现 (与手机本体同一套底层方法/同一金库目录)。
     *  纯设备/原生UI 动作 (开系统设置/代理/Shizuku 等) 在浏览器里无意义 → 返回安全默认值。 */
    private Object nativeInvoke(String m, org.json.JSONArray a) throws Exception {
        Bridge b = new Bridge();
        switch (m == null ? "" : m) {
            // ── 状态读取 ──
            case "conn": return readConn();
            case "relayStatus": return lastStatus;
            case "tunnelStat": return tunnelStatus;
            case "isTunnelEnabled": return tunnelEnabledFlag();
            case "isLanDirect": return lanDirectFlag();
            case "lanDirect": return b.lanDirect();
            case "e2eEnabled": return b.e2eEnabled();
            case "e2eRequired": return b.e2eRequired();
            case "e2eSeal": return b.e2eSeal(argStr(a, 0));
            case "e2eOpen": return b.e2eOpen(argStr(a, 0));
            case "keepAliveStatus": try { return KeepAlive.statusJson(this); } catch (Throwable t) { return "{}"; }
            case "phoneA11yReady": try { return RtAccessibilityService.isReady(); } catch (Throwable t) { return false; }
            case "isRemoteOpsEnabled": return remoteOpsEnabled;
            // ── 配置/隧道 读写 ──
            case "setTunnelEnabled": b.setTunnelEnabled(argBool(a, 0)); return null;
            case "setLanDirect": b.setLanDirect(argBool(a, 0)); return null;
            case "setE2eRequired": b.setE2eRequired(argBool(a, 0)); return null;
            case "setRemoteOps": b.setRemoteOps(argBool(a, 0)); return null;
            case "saveRelayConfig": writeUserFile("relay-config.json", argStr(a, 0)); return null;
            case "relayRestart": main.post(() -> { if (engine != null) engine.reload(); }); return null;
            // ── 网页内原生直渲: 为 (目标站, 账号) 起根挂载代理 + 专属公网隧道, 返回可被控台 iframe 的 https 公网 URL
            //    (剥 CSP/X-Frame-Options + 代账号注入 auth1) → Devin 多实例/任意第三方站皆在控台单页内原生操作。
            case "proxyPublicUrl": return proxyPublicUrl(argStr(a, 0), argStr(a, 1));
            // ── 金库读写 (与手机本体同一目录 Documents/DevinCloud) ──
            case "vaultLoad": return vaultRead(argStr(a, 0));
            case "vaultSave": vaultWrite(argStr(a, 0), argStr(a, 1)); return null;
            case "vaultListBackupAccounts": return bkListAccounts();
            case "vaultListBackups": return bkList(argStr(a, 0));
            case "vaultReadBackup": return bkRead(argStr(a, 0), argStr(a, 1));
            case "vaultReadBackupB64": return bkReadB64(argStr(a, 0), argStr(a, 1));
            case "vaultSaveBackup": return bkSave(argStr(a, 0), argStr(a, 1), argStr(a, 2));
            case "vaultSaveBackupB64": return bkSaveB64(argStr(a, 0), argStr(a, 1), argStr(a, 2));
            // ── 纯设备/原生UI: 浏览器里无意义, 安全默认 ──
            case "requestBatteryOpt": case "openAutoStart": case "openBatterySettings":
            case "phoneEnsureControl": case "applyProxy": case "clearProxy": return false;
            case "shizukuStatus": return 0;
            case "vpnStatus": case "detectProxy": case "currentProxy":
            case "shizukuGrantAll": case "shizukuShell": case "appCheckUpdate":
            case "appInstallUpdate": case "rotateRelayToken": return "";
            default: return null;
        }
    }
    private static String argStr(org.json.JSONArray a, int i) { return a != null && i < a.length() ? a.optString(i, "") : ""; }
    private static boolean argBool(org.json.JSONArray a, int i) { return a != null && i < a.length() && a.optBoolean(i, false); }

    // 全量备份目录操作 (Documents/DevinCloud/backups/<账号文件夹>/<name>) — 与 MainActivity 同一目录。
    private File bkDir(String folder) {
        File base = new File(vaultDir(), "backups");
        String sf = (folder == null || folder.trim().isEmpty()) ? "misc" : folder.replaceAll("[\\\\/:*?\"<>|]", "_");
        File d = new File(base, sf); if (!d.exists()) d.mkdirs(); return d;
    }
    private String bkListAccounts() {
        try { org.json.JSONArray arr = new org.json.JSONArray();
            File[] fs = new File(vaultDir(), "backups").listFiles();
            if (fs != null) for (File f : fs) if (f.isDirectory()) arr.put(f.getName());
            return arr.toString(); } catch (Exception e) { return "[]"; }
    }
    private String bkList(String folder) {
        try { org.json.JSONArray arr = new org.json.JSONArray();
            File[] fs = bkDir(folder).listFiles();
            if (fs != null) for (File f : fs) { if (!f.isFile()) continue;
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("name", f.getName()); o.put("size", f.length()); o.put("mtime", f.lastModified()); arr.put(o); }
            return arr.toString(); } catch (Exception e) { return "[]"; }
    }
    private String bkRead(String folder, String name) {
        try { File f = new File(bkDir(folder), safe(name)); if (!f.exists()) return "";
            java.io.FileInputStream i = new java.io.FileInputStream(f); String r = slurp(i); i.close(); return r;
        } catch (Exception e) { return ""; }
    }
    private String bkReadB64(String folder, String name) {
        try { File f = new File(bkDir(folder), safe(name)); if (!f.exists()) return "";
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) { int off = 0, r;
                while (off < buf.length && (r = fis.read(buf, off, buf.length - off)) > 0) off += r; }
            return android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP);
        } catch (Exception e) { return ""; }
    }
    private boolean bkSave(String folder, String name, String content) {
        try { String safe = (name == null || name.trim().isEmpty()) ? ("backup-" + System.currentTimeMillis() + ".json") : safe(name);
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(new File(bkDir(folder), safe))) {
                fos.write((content == null ? "" : content).getBytes("UTF-8")); } return true;
        } catch (Exception e) { return false; }
    }
    private boolean bkSaveB64(String folder, String name, String base64) {
        try { String safe = (name == null || name.trim().isEmpty()) ? ("backup-" + System.currentTimeMillis() + ".bin") : safe(name);
            byte[] bytes = android.util.Base64.decode(base64 == null ? "" : base64, android.util.Base64.DEFAULT);
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(new File(bkDir(folder), safe))) { fos.write(bytes); } return true;
        } catch (Exception e) { return false; }
    }

    /** 开启隧道: 同时拉起两条相互独立的去中心化公网后端 (cloudflared 主 + SSH 反向隧道备)。
     *  两条各自独立自愈, 互不牵连 → 任一被封/掉线另一条仍提供公网入口。 */
    private synchronized void startTunnel() {
        ensureLocalServer();
        if (localServer == null || localServer.getPort() <= 0) {
            updateTunnelStatus("", false, "本地 server 启动失败, 隧道无法建立"); return;
        }
        startCfTunnel();
        startSshTunnel();
    }
    /** 主后端: cloudflared 快速隧道 (仅此一条, 自愈时只重启自己, 不牵连 SSH 备用后端)。 */
    private synchronized void startCfTunnel() {
        try {
            ensureLocalServer();
            if (localServer == null || localServer.getPort() <= 0) {
                updateTunnelStatus("", false, "本地 server 启动失败, 隧道无法建立"); return;
            }
            int port = localServer.getPort();
            if (tunnel != null) tunnel.stop();
            tunnel = new TunnelManager(this, port, new NativeTunnel.Callback() {
                public void onUrl(String url) { tunnelRetries = 0; writeUserFile("tunnel-url", url); updateTunnelStatus(url, true, "隧道已连通", 0, false); }
                public void onLog(String line) { android.util.Log.i("RTFlowTunnel", line); }
                public void onExit(int code) { onTunnelExit(code); }
            });
            final int gen = ++tunnelGen;
            boolean ok = tunnel.start();
            updateTunnelStatus("", false, ok ? "正在建立隧道…" : "cloudflared 二进制缺失/启动失败");
            if (ok) {
                // 无URL看门狗: 进程在跑却 50s 拿不到公网URL(卡在边缘握手) → 重启隧道, 不傻等。
                main.postDelayed(() -> {
                    if (gen != tunnelGen || !tunnelEnabledFlag()) return;   // 已被新一轮取代/已关
                    TunnelManager t = tunnel;
                    if (t != null && t.isAlive() && !t.hasUrl()) {
                        android.util.Log.w("RTFlowTunnel", "tunnel no URL after " + (TUNNEL_URL_TIMEOUT / 1000) + "s → restart");
                        tunnelRetries++;
                        try { t.stop(); } catch (Exception ignored) {}
                        startCfTunnel();
                    }
                }, TUNNEL_URL_TIMEOUT);
                cfHealthFails = 0;
                scheduleCfHealth(gen);   // 公网可达性健康探测: 进程在跑且已报 URL, 但边缘可能回源失败/被拦而对公网返回 530(假活), 进程看门狗抓不到。
            }
        } catch (Exception e) {
            updateTunnelStatus("", false, "隧道启动失败: " + e.getMessage());
        }
    }
    /** 主隧道健康探测: cloudflared 进程在跑、也报了公网 URL, 但边缘可能回源失败/被网络拦截而对公网返回 530 (假活)。
     *  进程退出看门狗与无URL看门狗都抓不到这种"假活", 故定期探公网 URL/health;
     *  连失 2 次即走 onTunnelExit 退避重启 (并如实标记主隧道离线; 新一代→本探测循环自然终止)。
     *  注: 若本网络持续拦截 Cloudflare 边缘, 重启会很快累计到软上限而诚实回退中继, 备隧(SSH)始终并行兜底。 */
    private void scheduleCfHealth(final int gen) {
        main.postDelayed(() -> {
            if (gen != tunnelGen || !tunnelEnabledFlag()) return;
            TunnelManager t = tunnel;
            final String u = (t != null) ? t.getUrl() : "";
            if (u == null || u.isEmpty()) { scheduleCfHealth(gen); return; }  // 尚无 URL → 交无URL看门狗处理, 本探测仅续期
            new Thread(() -> {
                final boolean ok = probeUrl(u + "/health", 10000);
                main.post(() -> {
                    if (gen != tunnelGen || !tunnelEnabledFlag()) return;
                    if (ok) { cfHealthFails = 0; cfHealthRestarts = 0; scheduleCfHealth(gen); return; }  // 真活 → 清零累计, 主隧道恢复正常
                    cfHealthFails++;
                    if (cfHealthFails < 2) { scheduleCfHealth(gen); return; }   // 单次抑制抖动, 连失 2 次才动手
                    cfHealthFails = 0;
                    TunnelManager cur = tunnel;
                    if (cur != null) try { cur.stop(); } catch (Exception ignored) {}
                    if (cfHealthRestarts < CF_HEALTH_RESTART_CAP) {
                        // 可能是边缘瞬时抖动/该快速隧道被废弃 → 重启一次拿新边缘 URL (startCfTunnel 提升 gen→本循环终止)。
                        cfHealthRestarts++;
                        android.util.Log.w("RTFlowTunnel", "cf health probe failed (edge 530/unreachable) → restart #" + cfHealthRestarts);
                        startCfTunnel();
                    } else {
                        // 连续重启仍 530 → 判定本网络拦截 Cloudflare 边缘: 如实标主隧道离线, 停 cf 省电, 慢探恢复 (备隧 SSH/中继始终兜底)。
                        android.util.Log.w("RTFlowTunnel", "cf edge persistently unreachable (530) → mark offline, slow recover");
                        tunnel = null;
                        final int rgen = ++tunnelGen;   // 作废本健康循环 + 任何在途看门狗
                        try { writeUserFile("tunnel-url", ""); } catch (Exception ignored) {}
                        updateTunnelStatus("", false, "cloudflared 边缘持续不可达(530·本网络疑拦截 Cloudflare) · 已回退备隧(SSH)/中继, 后台每5min重试…", tunnelRetries, true);
                        main.postDelayed(() -> {
                            if (!tunnelEnabledFlag() || tunnelGen != rgen) return;
                            // 慢探恢复: 只留 1 次重启余量 (而非全部从零), 若仍 530 则极速回到离线, 减少无效重启。
                            cfHealthRestarts = CF_HEALTH_RESTART_CAP - 1; cfHealthFails = 0;
                            startCfTunnel();
                        }, CF_RECOVER_INTERVAL);
                    }
                });
            }, "rtflow-cf-health").start();
        }, CF_HEALTH_INTERVAL);
    }
    /** 路线A 扩展: 起独立 SSH 反向隧道后端 (与 cloudflared 并行), 退出时轮换公共边缘并持久自愈。 */
    private synchronized void startSshTunnel() {
        try {
            if (localServer == null || localServer.getPort() <= 0) return;
            int port = localServer.getPort();
            if (sshTunnel != null) sshTunnel.stop();
            final String edge = SshTunnelManager.EDGES[sshEdgeIdx % SshTunnelManager.EDGES.length];
            sshTunnel = new SshTunnelManager(this, port, edge, new NativeTunnel.Callback() {
                public void onUrl(String url) { sshRetries = 0; sshUrl = url; rebroadcast("备用隧道已连通 (" + edge + ")"); }
                public void onLog(String line) { android.util.Log.i("RTFlowTunnel", "[ssh] " + line); }
                public void onExit(int code) { onSshExit(code); }
            });
            final int gen = ++sshGen;
            boolean ok = sshTunnel.start();
            if (ok) {
                // 无URL看门狗: SSH 进程在跑却 50s 拿不到公网URL → 换边缘重启。
                main.postDelayed(() -> {
                    if (gen != sshGen || !tunnelEnabledFlag()) return;
                    SshTunnelManager t = sshTunnel;
                    if (t != null && t.isAlive() && !t.hasUrl()) {
                        android.util.Log.w("RTFlowTunnel", "[ssh] no URL after " + (TUNNEL_URL_TIMEOUT / 1000) + "s → next edge");
                        sshEdgeIdx++;
                        try { t.stop(); } catch (Exception ignored) {}
                        startSshTunnel();
                    }
                }, TUNNEL_URL_TIMEOUT);
                sshHealthFails = 0;
                scheduleSshHealth(gen);
            }
        } catch (Exception ignored) {}
    }
    /** SSH 后端退出: 轮换到下一个公共边缘, 持久退避重连 (与 cloudflared 同样永不彻底放弃)。 */
    private synchronized void onSshExit(int code) {
        if (!tunnelEnabledFlag()) return;
        sshUrl = "";
        sshRetries++; sshEdgeIdx++;   // 换下一个边缘
        long delay = Math.min(2000L * sshRetries, TUNNEL_RETRY_CAP);
        rebroadcast(null);
        main.postDelayed(() -> { if (tunnelEnabledFlag()) startSshTunnel(); }, delay);
    }
    /** 备用隧道健康探测: 公共 SSH 边缘可能在不关闭 SSH 会话的情况下静默废弃隧道(URL 返回 503)。
     *  进程退出看门狗抓不到这种"假活", 故定期探公网 URL/health; 连失 2 次即换边缘重连。 */
    private void scheduleSshHealth(final int gen) {
        main.postDelayed(() -> {
            if (gen != sshGen || !tunnelEnabledFlag()) return;
            final String u = sshUrl;
            if (u == null || u.isEmpty()) { scheduleSshHealth(gen); return; }
            new Thread(() -> {
                final boolean ok = probeUrl(u + "/health", 10000);
                main.post(() -> {
                    if (gen != sshGen || !tunnelEnabledFlag()) return;
                    if (ok) { sshHealthFails = 0; scheduleSshHealth(gen); return; }
                    sshHealthFails++;
                    if (sshHealthFails >= 2) {
                        android.util.Log.w("RTFlowTunnel", "[ssh] health probe failed → cycle edge");
                        sshHealthFails = 0; sshUrl = ""; sshEdgeIdx++;
                        SshTunnelManager t = sshTunnel;
                        if (t != null) try { t.stop(); } catch (Exception ignored) {}
                        rebroadcast(null);
                        startSshTunnel();   // 提升 gen → 本探测循环自然终止
                    } else scheduleSshHealth(gen);
                });
            }, "rtflow-ssh-health").start();
        }, SSH_HEALTH_INTERVAL);
    }
    /** 轻量 GET 探测: 2xx/3xx/4xx 视为隧道在线; 5xx(含 localhost.run "no tunnel here" 503)或异常=死。 */
    private boolean probeUrl(String url, int timeoutMs) {
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(timeoutMs); c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            return code >= 200 && code < 500;
        } catch (Exception e) { return false; }
        finally { if (c != null) try { c.disconnect(); } catch (Exception ignored) {} }
    }
    private synchronized void stopTunnel() {
        // 仅停 cloudflared 隧道; 本地 server 保留 (局域网直连默认常驻, 不随隧道关闭而下线)。
        tunnelGen++;   // 作废任何在途的无URL看门狗/重连
        if (tunnel != null) { tunnel.stop(); tunnel = null; }
        sshGen++;
        if (sshTunnel != null) { sshTunnel.stop(); sshTunnel = null; }
        sshUrl = ""; sshRetries = 0; sshEdgeIdx = 0; sshHealthFails = 0;
        if (!lanDirectFlag() && localServer != null) { localServer.stop(); localServer = null; localPort = -1; }
        tunnelRetries = 0; cfHealthFails = 0; cfHealthRestarts = 0;
        try { writeUserFile("tunnel-url", ""); } catch (Exception ignored) {}
        refreshLanInfo();
        updateTunnelStatus("", false, "隧道已停止" + (lanDirectFlag() ? " · 局域网直连仍在线" : ""), 0, false);
    }
    /** cloudflared 异常退出处理: 用户仍开着隧道则持久自愈, 退避重连永不彻底放弃 (隧道=公网入口)。
     *  软上限后诚实提示"已回退中继"但后台仍持续重连 → 网络恢复即自动复活。
     *  关键: 中继(Worker) 与隧道并行, 隧道失败丝毫不影响中继 → 手机始终在线可远程接入。 */
    private synchronized void onTunnelExit(int code) {
        if (!tunnelEnabledFlag()) { updateTunnelStatus("", false, "已停止", 0, false); return; }
        try { writeUserFile("tunnel-url", ""); } catch (Exception ignored) {}
        // 持久自愈: 隧道=公网入口, 永不彻底放弃。退避 2s/4s/6s…上限 60s, 后台无限重连 → 网络恢复即自动复活(真·无感常驻)。
        tunnelRetries++;
        int attempt = tunnelRetries;
        long delay = Math.min(2000L * attempt, TUNNEL_RETRY_CAP);
        boolean fallback = attempt > TUNNEL_RETRY_SOFT;  // 软上限后诚实提示已回退中继, 但仍持续重连
        String msg = fallback
                ? "去中心化隧道暂连不上(cloudflared 第" + attempt + "次退出, 本网络疑拦截 Cloudflare 边缘) · 已回退中继, 手机仍在线; 后台每" + (delay / 1000) + "s持续重连…"
                : "cloudflared 退出(" + code + ") · 第 " + attempt + " 次重连中(" + (delay / 1000) + "s)…";
        updateTunnelStatus("", false, msg, attempt, fallback);
        main.postDelayed(() -> { if (tunnelEnabledFlag()) startCfTunnel(); }, delay);
    }
    // 供 MainActivity 面板代理调用 (同进程)。默认开启: 仅当用户曾显式关闭 ("0") 才视为关; 与局域网直连/远程操控一致。
    public boolean tunnelEnabledFlag() { return !"0".equals(readUserFile("tunnel-enabled")); }
    public void setTunnelEnabledExternal(boolean on) {
        writeUserFile("tunnel-enabled", on ? "1" : "0");
        main.post(() -> { if (on) startTunnel(); else stopTunnel(); });
    }
    private void updateTunnelStatus(String url, boolean connected, String msg) {
        updateTunnelStatus(url, connected, msg, 0, false);
    }
    /** 沿用当前广播里的 cloudflared 主隧道态, 仅刷新一次 (用于 SSH 后端/局域网信息变化触发重广播)。 */
    private void rebroadcast(String msgOverride) {
        try {
            org.json.JSONObject cur = new org.json.JSONObject(tunnelStatus);
            String msg = msgOverride != null ? msgOverride : cur.optString("msg", "");
            updateTunnelStatus(cur.optString("cfUrl", cur.optString("url", "")), cur.optBoolean("cfConnected", false),
                    msg, cur.optInt("retries", 0), cur.optBoolean("fallback", false));
        } catch (Exception ignored) {
            updateTunnelStatus("", false, msgOverride == null ? "" : msgOverride, 0, false);
        }
    }
    private void updateTunnelStatus(String url, boolean connected, String msg, int retries, boolean fallback) {
        try {
            String cf = url == null ? "" : url;
            String ssh = sshUrl == null ? "" : sshUrl;
            boolean anyConn = connected || !ssh.isEmpty();
            String effective = !cf.isEmpty() ? cf : ssh;   // 主隧道优先, 否则用备用隧道作生效入口
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("enabled", tunnelEnabledFlag()); o.put("connected", anyConn);
            o.put("url", effective); o.put("msg", msg == null ? "" : msg);
            o.put("cfUrl", cf); o.put("cfConnected", connected);
            o.put("retries", retries); o.put("fallback", fallback);
            // 全部生效的去中心化公网入口 (主 cloudflared + 备用 SSH 反向隧道), 供面板逐条展示/复制。
            org.json.JSONArray tunnels = new org.json.JSONArray();
            org.json.JSONArray publicUrls = new org.json.JSONArray();
            if (!cf.isEmpty()) { tunnels.put(new org.json.JSONObject().put("name", "cloudflared").put("url", cf)); publicUrls.put(cf); }
            if (!ssh.isEmpty()) { tunnels.put(new org.json.JSONObject().put("name", "ssh").put("url", ssh)); publicUrls.put(ssh); }
            o.put("sshUrl", ssh);
            o.put("tunnels", tunnels);
            o.put("publicUrls", publicUrls);
            // 局域网直连信息 (零中继/零隧道, 同网直连本机): 始终随状态广播, 供穿透面板展示/复制。
            o.put("lanDirect", lanDirectFlag());
            o.put("localPort", localPort);
            org.json.JSONArray lans; try { lans = new org.json.JSONArray(lanUrlsJson); } catch (Exception e) { lans = new org.json.JSONArray(); }
            o.put("lanUrls", lans);
            o.put("lanUrl", lans.length() > 0 ? lans.optString(0, "") : "");
            o.put("ts", System.currentTimeMillis());
            tunnelStatus = o.toString();
        } catch (Exception ignored) {}
        try { sendBroadcast(new Intent("ai.devin.rtflow.TUNNEL").setPackage(getPackageName()).putExtra("tunnel", tunnelStatus)); } catch (Exception ignored) {}
    }

    /** P2: 取一个 PARTIAL_WAKE_LOCK — 前台穿透服务存活期间保持 CPU 唤醒,
     *  使 relay-app.js 里 15s 一次的 WSS 心跳不被 Doze/息屏节流而掉线。
     *  用户显式开启穿透才会有本服务 + 前台通知常驻, 取舍合理。 */
    private void acquireWake() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rtflow:relay");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        } catch (Exception ignored) {}
        // Wi-Fi 锁: 仅持 CPU 锁仍可能因 Wi-Fi 休眠/降频导致 WSS 心跳被拖延 → 一并持高性能/低延迟 Wi-Fi 锁。
        try {
            if (wifiLock != null && wifiLock.isHeld()) return;
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm == null) return;
            int mode = (Build.VERSION.SDK_INT >= 34)
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "rtflow:relay-wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception ignored) {}
    }
    private void releaseWake() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        wakeLock = null;
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        wifiLock = null;
    }

    private int engineRecoveries = 0;   // 引擎渲染进程被回收并自愈的累计次数 (诊断用)

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
        // 引擎 WebView 是无界面(永远离屏)的, 系统默认把离屏 WebView 渲染进程降到最低优先级 →
        //   内存压力下最先被回收 = 中继断连。这里钉住为 IMPORTANT 且离屏不降级, 大幅减少被杀概率 (修"经常自动断连")。
        if (Build.VERSION.SDK_INT >= 24)
            engine.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        // 渲染进程一旦真被系统回收: 若不接管, Android 默认会连带杀掉整个 App 进程(= 闪退 + 断连)。
        //   接管 → 销毁死实例 → 重建引擎页(engine.html 内联 DaoRelayApp.start 自动重连中继) → 进程不被杀。
        engine.setWebViewClient(new android.webkit.WebViewClient() {
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                engineRecoveries++;
                lastStatus = "{\"connected\":false,\"recovering\":true,\"recoveries\":" + engineRecoveries + "}";
                try { if (engine == view) engine = null; view.destroy(); } catch (Exception ignored) {}
                main.postDelayed(() -> { try { initEngine(); } catch (Exception ignored) {} }, 800);
                return true;   // 已处理: 系统不再连带杀 App
            }
        });
        engine.addJavascriptInterface(new Bridge(), "Native");
        engine.loadUrl("file:///android_asset/engine/engine.html");
        engine.resumeTimers();
    }

    /** 远程操控安全开关 (默认关, 需在穿透面板手动启用) */
    public static volatile boolean remoteOpsEnabled = false;

    /** 把前台标签 evaluateJavascript 的结果异步回灌给引擎页 window.__browseCb(reqId, value)。
     *  resultJson 是 evaluateJavascript 的原始返回 (合法 JSON), 直接内联即为已解析的 JS 值。 */
    private void deliverBrowse(String reqId, String resultJson) {
        final String payload = (resultJson == null || resultJson.isEmpty()) ? "null" : resultJson;
        main.post(() -> { if (engine != null) try {
            engine.evaluateJavascript("window.__browseCb&&window.__browseCb(" + HttpBridge.jsonStr(reqId) + "," + payload + ")", null);
        } catch (Exception ignored) {} });
    }

    /** JS ↔ 原生桥 (引擎页用 window.Native.*) */
    public class Bridge {
        @JavascriptInterface public String getConn() {
            // 动态配置优先 (用户在切号面板填写), 无则回退 conn.json 资源
            String dyn = readUserFile("relay-config.json");
            return (dyn != null && !dyn.isEmpty() && dyn.length() > 5) ? dyn : readAsset("engine/conn.json");
        }
        // ── RPC 载荷端到端加密 (中继只见密文, 连自托管/共享 Worker 都读不到账号密码) ──
        //  密钥 = PBKDF2(用户口令, 随机盐) → AES-256-GCM; 口令存于 relay-config.e2eKey,
        //  从不上送中继。授权驱动方(A群)经「取数指引 MD」获得同一口令即可解密。
        //  口令为空 = 关(明文, 向后兼容旧驱动)。
        @JavascriptInterface public boolean e2eEnabled() { return !e2eKeyVal().isEmpty(); }
        @JavascriptInterface public String e2eSeal(String plaintext) {
            try { String k = e2eKeyVal(); if (k.isEmpty() || plaintext == null) return ""; return E2E.seal(k, plaintext); }
            catch (Exception e) { return ""; }
        }
        @JavascriptInterface public String e2eOpen(String envB64) {
            try { String k = e2eKeyVal(); if (k.isEmpty() || envB64 == null) return ""; return E2E.open(k, envB64); }
            catch (Exception e) { return ""; }
        }
        // ── 强制端到端加密 (默认关·向后兼容)。开 = 引擎拒收明文 RPC, 杜绝明文驱动经中继泄露账号/密码。──
        @JavascriptInterface public boolean e2eRequired() { return e2eRequiredFlag(); }
        @JavascriptInterface public void setE2eRequired(boolean on) { writeUserFile("e2e-required", on ? "1" : "0"); }
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
        @JavascriptInterface public void vaultSave(String key, String json) { if (key != null) vaultWrite(key, json); }
        @JavascriptInterface public String vaultLoad(String key) { return key == null ? "" : vaultRead(key); }
        @JavascriptInterface public void reload() { main.post(() -> { if (engine != null) engine.reload(); }); }
        @JavascriptInterface public void log(String s) { android.util.Log.i("RTFlowEngine", s == null ? "" : s); }
        /** 对话追踪·全局系统通知 (引擎后台检测到会话卡住/待处理/结束时调用; 软件被切后台/锁屏亦可弹)。 */
        @JavascriptInterface public void notifyGlobal(String tag, String title, String text) {
            main.post(() -> postConvNotification(tag, title, text));
        }
        /** 原生 HTTP (无 CORS, 可设 Origin/Referer) — 登录/额度/会话/Git 的底座; 结果经 window.__httpCb 回灌。 */
        @JavascriptInterface public void httpReq(String reqId, String method, String url, String headersJson, String body) {
            HttpBridge.exec(reqId, method, url, headersJson, body, (id, json) ->
                main.post(() -> { if (engine != null) try {
                    engine.evaluateJavascript("window.__httpCb&&window.__httpCb(" + HttpBridge.jsonStr(id) + "," + json + ")", null);
                } catch (Exception ignored) {} }));
        }

        // ── 路线B 去中心化隧道桥 ────────────────────────────────────────
        /** 引擎 serveLocal 完成后回灌结果, 唤醒等待中的 LocalServer 线程。 */
        @JavascriptInterface public void localServeResult(String reqId, String json) {
            if (reqId == null) return;
            java.util.concurrent.SynchronousQueue<String> q = pendingLocal.get(reqId);
            if (q != null) { try { q.offer(json == null ? "{}" : json, 5, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception ignored) {} }
        }
        /** 穿透面板「去中心化隧道」开关。开 = 起本地 server + cloudflared; 关 = 停。 */
        @JavascriptInterface public void setTunnelEnabled(boolean on) {
            writeUserFile("tunnel-enabled", on ? "1" : "0");
            main.post(() -> { if (on) startTunnel(); else stopTunnel(); });
        }
        @JavascriptInterface public boolean isTunnelEnabled() { return tunnelEnabledFlag(); }
        @JavascriptInterface public String tunnelStat() { return tunnelStatus; }

        // ── 局域网直连 (无感等效内网穿透·零中继零隧道) ──────────────────────
        /** 局域网直连开关 (默认开)。开 = 起本地 server(绑 0.0.0.0) 供同网控制端直连; 关 = 仅在隧道开时才起。 */
        @JavascriptInterface public void setLanDirect(boolean on) {
            writeUserFile("lan-direct", on ? "1" : "0");
            main.post(() -> { if (on) ensureLocalServer(); else if (!tunnelEnabledFlag()) stopTunnel(); else refreshLanInfo(); });
        }
        @JavascriptInterface public boolean isLanDirect() { return lanDirectFlag(); }
        /** 当前局域网直连接入信息: {lanDirect, port, urls:[...], token, session, e2eKey}。 */
        @JavascriptInterface public String lanDirect() {
            main.post(RelayService.this::refreshLanInfo);   // 取最新网络地址 (下一次轮询即生效)
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("lanDirect", lanDirectFlag());
                o.put("port", localPort);
                o.put("urls", new org.json.JSONArray(lanUrlsJson));
                String cfg = readUserFile("relay-config.json");
                if (cfg != null && cfg.length() > 5) {
                    org.json.JSONObject c = new org.json.JSONObject(cfg);
                    o.put("token", c.optString("token", ""));
                    o.put("session", c.optString("session", ""));
                    o.put("e2eKey", c.optString("e2eKey", ""));
                }
                return o.toString();
            } catch (Exception e) { return "{\"lanDirect\":" + lanDirectFlag() + ",\"port\":" + localPort + ",\"urls\":" + lanUrlsJson + "}"; }
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

        // 道法自然·联控在场登记: 控台声明「本设备(clientId)正看/控标签 vid」。轻量·非阻塞·不进引擎。
        @JavascriptInterface public void browseClaimView(double vid, String clientId) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcClaimView((long) vid, clientId));
        }

        @JavascriptInterface public String browseExecJs(int tabIndex, String js) {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "null";
            final String[] r = {"null"};
            final boolean[] done = {false};
            try {
                m.runOnUiThread(() -> m.ipcExecJs(tabIndex, js, v -> { synchronized(r){ r[0] = (v == null ? "null" : v); done[0] = true; r.notifyAll(); } }));
                synchronized(r){ long end = System.currentTimeMillis() + 8000;
                    while (!done[0]) { long left = end - System.currentTimeMillis(); if (left <= 0) break; r.wait(left); } }
            } catch (Exception e) {}
            return r[0];
        }

        // 非阻塞版 execJs: 引擎页 JS 线程不能同步等待前台标签的 evaluateJavascript 回调
        // (两 WebView 共用同一渲染线程, 同步桥会把渲染线程挂死 → 回调永不触发, 8s 超时返回 null)。
        // 故改为投递 reqId + 经 window.__browseCb(reqId, result) 异步回灌 (与 httpReq/__httpCb 同模式)。
        @JavascriptInterface public void browseExecJsAsync(String reqId, int tabIndex, String js) {
            if (!remoteOpsEnabled) { deliverBrowse(reqId, "null"); return; }
            MainActivity m = MainActivity.sInstance;
            if (m == null) { deliverBrowse(reqId, "null"); return; }
            m.runOnUiThread(() -> m.ipcExecJs(tabIndex, js, v -> deliverBrowse(reqId, v)));
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

        /** 投屏取帧: 压缩 JPEG (降采样 + 铺底色) + 尺寸/URL/标题。网页控台镜像走它 —— 帧体积较整幅 PNG 小一个量级,
         *  弱网下不再因大包超时而黑屏; 停泊的板块(本地页)也能被任意端取帧投屏。返回 ipcMirrorFrame 的 JSON。 */
        @JavascriptInterface public String mirrorFrame(int tabIndex, int quality, int maxDim) {
            if (!remoteOpsEnabled) return "{\"ok\":false,\"error\":\"remote_ops_disabled\"}";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "{\"ok\":false,\"error\":\"no_host\"}";
            try { return m.ipcMirrorFrame(tabIndex, quality > 0 ? quality : 55, maxDim > 0 ? maxDim : 1024); }
            catch (Exception e) { return "{\"ok\":false,\"error\":\"ex\"}"; }
        }

        /** 网页原生直渲底座(零账号中继版): 把「直渲」路由经中继暴露 → 浏览器在 srcdoc 里原生跑 APK
         *  自身真实页面 (switch/cloud/tunnel/…), 由浏览器自身渲染、原生交互, 彻底取代截图投屏
         *  (无黑屏 / 不卡顿 / 反向操作即时; 账号数据并行而不相悖)。frameJson = {path, body}。
         *  返回浏览器应直接收到的响应体 JSON 串:
         *    · /api/native — 值返回型 Native 方法 (状态/配置/金库 读写)        → {"r":...}
         *    · /api/http   — 手机侧原生 HTTP (绕 CORS, 带账号 auth1)            → {status,headers,body}
         *    · /api/asset  — APK 自身页面/JS 资源原文 (供 srcdoc 内联)          → {ok,ct,text}
         *    · /api/mirror — 兼容旧投屏取帧 (回退用)。 */
        @JavascriptInterface public String serveEmbed(String frameJson) {
            try {
                org.json.JSONObject f = new org.json.JSONObject(frameJson == null ? "{}" : frameJson);
                String p = f.optString("path", "");
                org.json.JSONObject b = f.optJSONObject("body");
                if ("/api/native".equals(p)) return unwrapBody(webNative(b));
                if ("/api/http".equals(p))   return unwrapBody(webHttp(b));
                if ("/api/mirror".equals(p)) return unwrapBody(webMirror(b));
                if ("/api/asset".equals(p)) {
                    String name = b == null ? "" : b.optString("name", "");
                    org.json.JSONObject o = new org.json.JSONObject();
                    // 仅服务白名单形态的引擎资源名, 杜绝路径穿越。
                    if (!name.matches("[A-Za-z0-9_\\-]+\\.(html|js)")) { o.put("ok", false); o.put("error", "bad_name"); return o.toString(); }
                    String txt = readAsset("engine/" + name);
                    if (txt == null || txt.isEmpty() || "{}".equals(txt)) { o.put("ok", false); o.put("error", "not_found"); return o.toString(); }
                    o.put("ok", true);
                    o.put("ct", name.endsWith(".js") ? "application/javascript" : "text/html");
                    o.put("text", txt);
                    return o.toString();
                }
            } catch (Exception ignored) {}
            return "{\"ok\":false,\"error\":\"unhandled\"}";
        }

        // 网页控台 📥 下载悬浮窗: 列出手机下载 (脱敏) + 在手机本机执行项动作 (分享/打开/删除)。
        @JavascriptInterface public String listDownloads() {
            if (!remoteOpsEnabled) return "[]";
            MainActivity m = MainActivity.sInstance;
            if (m == null) return "[]";
            final String[] r = {"[]"};
            try { m.runOnUiThread(() -> { r[0] = m.ipcListDownloads(); synchronized(r){r.notifyAll();} });
                synchronized(r){ r.wait(3000); } } catch (Exception e) {}
            return r[0];
        }
        @JavascriptInterface public void downloadAction(int recIdx, String action) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcDownloadAction(recIdx, action));
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
            else wakeHost();   // 软件本体被后台杀 → 先冷启动拉起浏览器外壳, 调用方稍候重试即可开页
        }

        /** 把指定标签提到前台 (默认后台开页不打扰用户; Agent 需要"前端同步反映"时显式调用)。
         *  同时把软件本体提到前台 (后台/锁屏态时远程操控也能让前端可见)。 */
        @JavascriptInterface public void browseActivateTab(int tabIndex) {
            if (!remoteOpsEnabled) return;
            wakeHost();
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.ipcActivateTab(tabIndex);
        }

        /** 把软件本体(MainActivity)提到前台; 已被系统杀掉则冷启动拉起。
         *  解决「手机在后台/软件被杀后, 远程操控前端不可见、甚至操作不了」: 任意设备的远程操作可主动唤回本体。 */
        @JavascriptInterface public boolean appToFront() { return wakeHost(); }

        /** 「显示在其他应用上层」是否已授予 (后台唤回前台的关键权限)。 */
        @JavascriptInterface public boolean overlayGranted() { return KeepAlive.canDrawOverlays(RelayService.this); }
        /** 跳转授予「显示在其他应用上层」(让后台唤回前台稳定生效)。 */
        @JavascriptInterface public boolean requestOverlay() { return KeepAlive.requestOverlay(RelayService.this); }

        /** 把软件本体提到前台 / 冷启动拉起 (前台常驻服务发起 Activity, 多数 ROM 放行)。返回是否已发起。 */
        boolean wakeHost() {
            try {
                Intent it = new Intent(RelayService.this, MainActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(it);
                return true;
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface public void browseCloseTab(int tabIndex) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.ipcCloseTab(tabIndex);
        }

        // ── 在线自动更新 (云端经中继可直接推送更新; 不受 remoteOps 门禁, 安装仍需用户点一次确认) ──
        @JavascriptInterface public String appCheckUpdate() {
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.fetchUpdateInfo() : "{\"ok\":false,\"error\":\"浏览器外壳未就绪\"}";
        }
        @JavascriptInterface public String appInstallUpdate(String url) {
            MainActivity m = MainActivity.sInstance;
            return m != null ? m.startUpdate(url) : "{\"ok\":false,\"error\":\"浏览器外壳未就绪\"}";
        }
        /** 后台保活状态 (云端 Agent 经隧道可读: 机型 + 电池豁免 + 保活指引)。只读, 不依赖 Activity。 */
        @JavascriptInterface public String keepAliveStatus() { return KeepAlive.statusJson(RelayService.this); }

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

        // ── 系统级接管 (AccessibilityService: 手势/全局/读屏/截图) ──────────
        @JavascriptInterface public boolean phoneA11yReady() {
            return RtAccessibilityService.isReady();
        }
        @JavascriptInterface public void phoneOpenA11ySettings() {
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.runOnUiThread(() -> m.ipcOpenA11ySettings());
        }
        // 高保真控制: 有 Shizuku 时优先走 shell `input` (uid2000, 近 USB 级稳定, 不依赖无障碍服务);
        // 否则回退无障碍手势。scrcpy 的控制通道本质即 adb `input`/`screencap`, 此处等效打通。
        @JavascriptInterface public boolean phoneShizukuReady() { return ShizukuManager.hasPermission(); }
        @JavascriptInterface public String phoneShell(String cmd) {
            if (!remoteOpsEnabled) return "{\"ok\":false,\"error\":\"远程操控未启用\"}";
            if (cmd == null || cmd.isEmpty()) return "{\"ok\":false,\"error\":\"空命令\"}";
            if (!ShizukuManager.hasPermission()) return "{\"ok\":false,\"error\":\"Shizuku 未授权\"}";
            String[] r = ShizukuManager.exec(cmd);
            try { org.json.JSONObject o = new org.json.JSONObject();
                o.put("ok", "0".equals(r[0])); o.put("exit", r[0]); o.put("out", r.length > 1 ? r[1] : "");
                return o.toString(); } catch (Exception e) { return "{\"ok\":false}"; }
        }
        @JavascriptInterface public boolean phoneTap(int x, int y) {
            if (!remoteOpsEnabled) return false;
            if (ShizukuManager.hasPermission() && "0".equals(ShizukuManager.exec("input tap " + x + " " + y)[0])) return true;
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null && s.tap(x, y);
        }
        @JavascriptInterface public boolean phoneLongPress(int x, int y, int ms) {
            if (!remoteOpsEnabled) return false;
            if (ShizukuManager.hasPermission() && "0".equals(ShizukuManager.exec("input swipe " + x + " " + y + " " + x + " " + y + " " + ms)[0])) return true;
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null && s.longPress(x, y, ms);
        }
        @JavascriptInterface public boolean phoneSwipe(int x1, int y1, int x2, int y2, int ms) {
            if (!remoteOpsEnabled) return false;
            if (ShizukuManager.hasPermission() && "0".equals(ShizukuManager.exec("input swipe " + x1 + " " + y1 + " " + x2 + " " + y2 + " " + ms)[0])) return true;
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null && s.swipe(x1, y1, x2, y2, ms);
        }
        @JavascriptInterface public boolean phoneGlobalAction(String action) {
            if (!remoteOpsEnabled) return false;
            if (ShizukuManager.hasPermission() && action != null) {
                String key = null;
                switch (action) {
                    case "back": key = "KEYCODE_BACK"; break;
                    case "home": key = "KEYCODE_HOME"; break;
                    case "recents": key = "KEYCODE_APP_SWITCH"; break;
                    case "notifications": key = null; break; // 无对应 keyevent, 回退无障碍
                }
                if (key != null && "0".equals(ShizukuManager.exec("input keyevent " + key)[0])) return true;
            }
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null && s.globalAction(action);
        }
        @JavascriptInterface public String phoneDumpScreen() {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null ? s.dumpScreen() : "{\"error\":\"无障碍服务未开启\"}";
        }
        @JavascriptInterface public boolean phoneClickText(String text) {
            if (!remoteOpsEnabled) return false;
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null && s.clickText(text);
        }
        @JavascriptInterface public boolean phoneInputText(String text) {
            if (!remoteOpsEnabled) return false;
            if (ShizukuManager.hasPermission() && text != null) {
                // input text 把空格当分隔符, 需转义为 %s; 单引号防 shell 注入
                String esc = text.replace("\\", "\\\\").replace("'", "'\\''").replace(" ", "%s");
                if ("0".equals(ShizukuManager.exec("input text '" + esc + "'")[0])) return true;
            }
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null && s.inputText(text);
        }
        @JavascriptInterface public String phoneScreenCapture() {
            if (!remoteOpsEnabled) return "{\"error\":\"远程操控未启用\"}";
            // Shizuku 优先: screencap 经 base64 回传 (全屏真实像素, 不依赖无障碍/MediaProjection 授权)
            if (ShizukuManager.hasPermission()) {
                String[] r = ShizukuManager.exec("screencap -p | base64 | tr -d '\\n'");
                if ("0".equals(r[0]) && r.length > 1 && r[1] != null && r[1].length() > 100)
                    return "{\"ok\":true,\"base64\":\"" + r[1] + "\",\"via\":\"shizuku\"}";
            }
            RtAccessibilityService s = RtAccessibilityService.sInstance;
            return s != null ? s.takeScreenshotBase64() : "{\"error\":\"无障碍服务未开启\"}";
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

    /** 读 relay-config.json 的 e2eKey (端到端加密口令); 无则空串=不加密。 */
    private String e2eKeyVal() {
        try {
            String dyn = readUserFile("relay-config.json");
            if (dyn != null && dyn.length() > 5) return new org.json.JSONObject(dyn).optString("e2eKey", "");
        } catch (Exception ignored) {}
        return "";
    }
    /** 强制端到端加密开关 (默认关, 向后兼容明文驱动)。 */
    private boolean e2eRequiredFlag() { return "1".equals(readUserFile("e2e-required")); }

    /** AES-256-GCM + PBKDF2(SHA256,100k) 端到端加密。封套(base64): [ver=1][salt16][iv12][密文+tag]。
     *  与 tools/dao-e2e 参考实现(JS/Python)逐字节兼容 → 任意语言的授权驱动方均可解密。 */
    static final class E2E {
        private static javax.crypto.SecretKey deriveKey(String pass, byte[] salt) throws Exception {
            javax.crypto.SecretKeyFactory f = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            byte[] kb = f.generateSecret(new javax.crypto.spec.PBEKeySpec(pass.toCharArray(), salt, 100000, 256)).getEncoded();
            return new javax.crypto.spec.SecretKeySpec(kb, "AES");
        }
        static String seal(String pass, String plaintext) throws Exception {
            java.security.SecureRandom rnd = new java.security.SecureRandom();
            byte[] salt = new byte[16]; rnd.nextBytes(salt);
            byte[] iv = new byte[12]; rnd.nextBytes(iv);
            javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            c.init(javax.crypto.Cipher.ENCRYPT_MODE, deriveKey(pass, salt), new javax.crypto.spec.GCMParameterSpec(128, iv));
            byte[] ct = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[1 + 16 + 12 + ct.length];
            out[0] = 1; System.arraycopy(salt, 0, out, 1, 16); System.arraycopy(iv, 0, out, 17, 12);
            System.arraycopy(ct, 0, out, 29, ct.length);
            return android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP);
        }
        static String open(String pass, String b64) throws Exception {
            byte[] in = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
            if (in.length < 30 || in[0] != 1) throw new IllegalArgumentException("bad envelope");
            byte[] salt = java.util.Arrays.copyOfRange(in, 1, 17);
            byte[] iv = java.util.Arrays.copyOfRange(in, 17, 29);
            byte[] ct = java.util.Arrays.copyOfRange(in, 29, in.length);
            javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            c.init(javax.crypto.Cipher.DECRYPT_MODE, deriveKey(pass, salt), new javax.crypto.spec.GCMParameterSpec(128, iv));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
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

    /**
     * 对话追踪·全局系统通知 (引擎检测到会话卡住/待处理/结束时调用)。
     * 与常驻穿透通知分属不同频道: 高优先级、可弹出、点按拉起 App。tag 决定通知 id (同会话更新而非刷屏)。
     */
    public void postConvNotification(String tag, String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CONV_CH, "对话追踪提醒", NotificationManager.IMPORTANCE_HIGH);
                ch.setShowBadge(true);
                ch.enableVibration(true);
                nm.createNotificationChannel(ch);
            }
            PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = (Build.VERSION.SDK_INT >= 26) ? new Notification.Builder(this, CONV_CH) : new Notification.Builder(this);
            b.setContentTitle(title == null ? "Devin 对话提醒" : title)
                    .setContentText(text == null ? "" : text)
                    .setStyle(new Notification.BigTextStyle().bigText(text == null ? "" : text))
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH);
            int id = 0x7000_0000 | ((tag == null ? "" : tag).hashCode() & 0x0FFF_FFFF);
            nm.notify(id, b.build());
        } catch (Exception e) { android.util.Log.w("RTFlowEngine", "postConvNotification err " + e); }
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
    // ── 数据保险箱: 共享文件夹 Documents/DevinCloud (脱离应用沙箱, 卸载/重装/换机不丢) ──
    // 与 MainActivity.vaultDir() 同一目录, 引擎(中继驱动)侧也能持久化/回读账号, UI 未开也不丢。
    private File vaultDir() {
        File d = new File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOCUMENTS), "DevinCloud");
        if (!d.exists()) d.mkdirs();
        return d;
    }
    private void vaultWrite(String key, String data) {
        try { File f = new File(vaultDir(), safe(key) + ".json");
            java.io.FileOutputStream o = new java.io.FileOutputStream(f); o.write((data == null ? "" : data).getBytes("UTF-8")); o.close(); }
        catch (Exception ignored) {}
    }
    private String vaultRead(String key) {
        try { File f = new File(vaultDir(), safe(key) + ".json"); if (!f.exists()) return "";
            java.io.FileInputStream i = new java.io.FileInputStream(f); String r = slurp(i); i.close(); return r; }
        catch (Exception e) { return ""; }
    }
    private static String safe(String n) { return n == null ? "x" : n.replaceAll("[^A-Za-z0-9_.-]", "_"); }
    private static String slurp(InputStream is) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n); return bo.toString("UTF-8");
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }

    /** 用户从「最近任务」划掉本应用 → 部分 ROM 会连带杀掉常驻中继。这里立即重新拉起前台服务保活,
     *  使内网穿透 / 远控通道不因划任务而中断 (与 START_STICKY 协同, 双保险)。 */
    @Override public void onTaskRemoved(Intent rootIntent) {
        try {
            Intent restart = new Intent(getApplicationContext(), RelayService.class).setPackage(getPackageName());
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(restart); else startService(restart);
        } catch (Exception ignored) {}
        super.onTaskRemoved(rootIntent);
    }
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { instance = null; releaseWake(); stopTunnel(); if (engine != null) { engine.destroy(); engine = null; } super.onDestroy(); }
}
