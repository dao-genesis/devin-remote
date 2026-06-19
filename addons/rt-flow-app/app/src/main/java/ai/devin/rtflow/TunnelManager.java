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
 * TunnelManager · 路线B 去中心化隧道: 拉起设备自带的 cloudflared 进程, 建立免费快速隧道。
 *
 *  cloudflared 以 jniLibs 形式打包成 libcloudflared.so → 解压到 nativeLibraryDir (该目录
 *  可执行, 绕开 Android 10+ 禁止从应用数据目录 exec 的限制)。该二进制由 NDK cgo 交叉编译
 *  (GOOS=android), 使用 Android 系统 DNS 解析器 — 故能在普通手机/平板解析 trycloudflare。
 *
 *  把本地 LocalServer (127.0.0.1:port) 暴露成 https://xxx.trycloudflare.com:
 *    cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate --protocol http2 --edge-ip-version 4
 *  无需 Cloudflare 账号、无需登录、每设备一条独立隧道 → 真正去中心化、免费。
 *  注: 快速隧道 URL 每次重启会变 (这是 trycloudflare 的设计), 故每次启动后回调上报新 URL。
 */
public final class TunnelManager {
    public interface Callback {
        void onUrl(String url);
        void onLog(String line);
        void onExit(int code);
    }

    private final Context ctx;
    private final int localPort;
    private final Callback cb;
    private volatile Process proc;
    private volatile String publicUrl = "";
    private volatile boolean stopped = false;
    private Thread reader;

    private static final Pattern URL_RE = Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com");

    public TunnelManager(Context ctx, int localPort, Callback cb) {
        this.ctx = ctx; this.localPort = localPort; this.cb = cb;
    }

    public String getUrl() { return publicUrl; }
    public boolean isAlive() { Process p = proc; return p != null && p.isAlive(); }
    public boolean hasUrl() { return !publicUrl.isEmpty(); }

    /** 返回打包的 cloudflared 可执行文件路径 (nativeLibraryDir/libcloudflared.so), 不存在返回 null。 */
    public File binary() {
        try {
            ApplicationInfo ai = ctx.getApplicationInfo();
            File f = new File(ai.nativeLibraryDir, "libcloudflared.so");
            return f.exists() ? f : null;
        } catch (Exception e) { return null; }
    }

    /** 起 cloudflared 进程并异步解析快速隧道 URL。返回 false = 二进制缺失 (该 ABI 未打包)。 */
    public synchronized boolean start() {
        File bin = binary();
        if (bin == null) { cb.onLog("cloudflared 二进制缺失 (该设备 ABI 未打包)"); return false; }
        stopped = false; publicUrl = "";
        try {
            List<String> cmd = new ArrayList<>();
            cmd.add(bin.getAbsolutePath());
            cmd.add("tunnel");
            cmd.add("--url"); cmd.add("http://127.0.0.1:" + localPort);
            cmd.add("--no-autoupdate");
            cmd.add("--protocol"); cmd.add("http2");      // QUIC/UDP 常被运营商/模拟器 NAT 拦 → 强制 http2(TCP) 更稳
            cmd.add("--edge-ip-version"); cmd.add("4");
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            // 给 cloudflared 一个可写 HOME (避免它往不可写目录写日志/状态)
            File home = ctx.getFilesDir();
            pb.environment().put("HOME", home.getAbsolutePath());
            pb.environment().put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
            proc = pb.start();
            reader = new Thread(this::readLoop, "rtflow-cf-reader");
            reader.setDaemon(true);
            reader.start();
            return true;
        } catch (Exception e) {
            cb.onLog("cloudflared 启动失败: " + e.getMessage());
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
