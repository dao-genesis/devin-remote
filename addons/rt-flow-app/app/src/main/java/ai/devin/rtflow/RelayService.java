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
    /** 把 cloudflared 转发来的 frame 喂给引擎 serveLocal, 阻塞拿回 {status,bodyText} (≤60s)。 */
    String dispatchLocal(String frameJson) throws Exception {
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
                            cfHealthRestarts = 0; cfHealthFails = 0;
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
        }

        /** 把指定标签提到前台 (默认后台开页不打扰用户; Agent 需要"前端同步反映"时显式调用)。 */
        @JavascriptInterface public void browseActivateTab(int tabIndex) {
            if (!remoteOpsEnabled) return;
            MainActivity m = MainActivity.sInstance;
            if (m != null) m.ipcActivateTab(tabIndex);
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
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { instance = null; releaseWake(); stopTunnel(); if (engine != null) { engine.destroy(); engine = null; } super.onDestroy(); }
}
