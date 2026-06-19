package ai.devin.rtflow;

import android.content.Context;
import android.content.pm.ApplicationInfo;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SshTunnelManager · 路线A 扩展 · 独立于 cloudflared 的第二条去中心化公网隧道后端。
 *
 *  拉起设备自带的纯 Go SSH 反向隧道客户端 (打包成 libsshtun.so, 解压到 nativeLibraryDir 执行,
 *  与 cloudflared 同样绕开 Android 10+ 数据目录 exec 限制)。该客户端无账号连接公共 SSH 边缘
 *  (localhost.run / serveo / pinggy), 请求远端 80 端口反向转发, 把本地 LocalServer 暴露成
 *  https://xxx.lhr.life 之类的公网 URL —— 不经 Cloudflare、不经用户 Worker, 真正去中心化。
 *
 *  价值: 当 cloudflared/trycloudflare 被整体封锁时, 这条独立后端仍能提供公网入口 → 冗余兜底。
 *  协议对外完全一致 (同一 LocalServer/relay 协议), driver/curl 零改动。
 */
public final class SshTunnelManager {
    public interface Callback {
        void onUrl(String url);
        void onLog(String line);
        void onExit(int code);
    }

    /** 无账号公共 SSH 反向隧道边缘 (按序兜底; 任一通即可)。 */
    public static final String[] EDGES = { "localhost.run:22", "serveo.net:22", "a.pinggy.io:443" };

    private final Context ctx;
    private final int localPort;
    private final String edge;     // host:port
    private final Callback cb;
    private volatile Process proc;
    private volatile String publicUrl = "";
    private volatile boolean stopped = false;
    private Thread reader;

    // lhr.life(localhost.run) / serveo.net / pinggy 的公网 URL 形态。
    private static final Pattern URL_RE =
            Pattern.compile("https://[a-zA-Z0-9._-]+\\.(?:lhr\\.life|serveo\\.net|pinggy\\.link)");

    public SshTunnelManager(Context ctx, int localPort, String edge, Callback cb) {
        this.ctx = ctx; this.localPort = localPort; this.edge = edge; this.cb = cb;
    }

    public String getUrl() { return publicUrl; }
    public String edge() { return edge; }
    public boolean isAlive() { Process p = proc; return p != null && p.isAlive(); }
    public boolean hasUrl() { return !publicUrl.isEmpty(); }

    /** 打包的 SSH 隧道客户端路径 (nativeLibraryDir/libsshtun.so); 不存在返回 null。 */
    public File binary() {
        try {
            ApplicationInfo ai = ctx.getApplicationInfo();
            File f = new File(ai.nativeLibraryDir, "libsshtun.so");
            return f.exists() ? f : null;
        } catch (Exception e) { return null; }
    }

    /** 起 SSH 隧道客户端并异步解析公网 URL。返回 false = 二进制缺失 (该 ABI 未打包)。 */
    public synchronized boolean start() {
        File bin = binary();
        if (bin == null) { cb.onLog("sshtun 二进制缺失 (该设备 ABI 未打包)"); return false; }
        stopped = false; publicUrl = "";
        try {
            List<String> cmd = new ArrayList<>();
            cmd.add(bin.getAbsolutePath());
            cmd.add("-host"); cmd.add(edge);
            cmd.add("-user"); cmd.add("nokey");      // 无账号匿名 → 随机公网子域
            cmd.add("-local"); cmd.add(String.valueOf(localPort));
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            pb.environment().put("HOME", ctx.getFilesDir().getAbsolutePath());
            pb.environment().put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
            proc = pb.start();
            reader = new Thread(this::readLoop, "rtflow-ssh-reader");
            reader.setDaemon(true);
            reader.start();
            return true;
        } catch (Exception e) {
            cb.onLog("sshtun 启动失败: " + e.getMessage());
            return false;
        }
    }

    private void readLoop() {
        Process p = proc;
        if (p == null) return;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                cb.onLog(line);
                if (publicUrl.isEmpty()) {
                    Matcher m = URL_RE.matcher(line);
                    if (m.find()) { publicUrl = m.group(); cb.onUrl(publicUrl); }
                }
            }
        } catch (Exception ignored) {}
        int code = -1;
        try { code = p.waitFor(); } catch (Exception ignored) {}
        if (!stopped) cb.onExit(code);
    }

    public synchronized void stop() {
        stopped = true;
        Process p = proc;
        if (p != null) { try { p.destroy(); } catch (Exception ignored) {} }
        proc = null; publicUrl = "";
    }
}
