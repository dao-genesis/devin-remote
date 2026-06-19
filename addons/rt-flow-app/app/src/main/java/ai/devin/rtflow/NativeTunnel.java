package ai.devin.rtflow;

import android.content.Context;
import android.content.pm.ApplicationInfo;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * NativeTunnel · 去中心化公网隧道后端的共同本源 (减法: 提炼 cloudflared 与 SSH 反向隧道的同形部分)。
 *
 *  两条后端 (TunnelManager·cloudflared / SshTunnelManager·SSH 反向) 的生命周期完全同形:
 *  把打包进 nativeLibraryDir 的可执行 .so 当子进程拉起 (绕开 Android 10+ 数据目录 exec 限制),
 *  逐行读其输出、正则匹出公网 URL 回报、退出时回调。差异仅三处, 由子类给出:
 *    ① libName()    打包的 .so 名      ② command(bin) 启动参数     ③ urlPattern() 公网 URL 形态
 *  对外契约 (Callback / start / stop / isAlive / hasUrl / getUrl) 完全一致 → driver/curl 零感知。
 */
public abstract class NativeTunnel {
    public interface Callback {
        void onUrl(String url);
        void onLog(String line);
        void onExit(int code);
    }

    protected final Context ctx;
    protected final int localPort;
    private final Callback cb;
    private volatile Process proc;
    private volatile String publicUrl = "";
    private volatile boolean stopped = false;

    protected NativeTunnel(Context ctx, int localPort, Callback cb) {
        this.ctx = ctx; this.localPort = localPort; this.cb = cb;
    }

    /** 打包的可执行 .so 名 (位于 nativeLibraryDir, 该目录可 exec)。 */
    protected abstract String libName();
    /** 子进程启动参数 (含可执行路径)。 */
    protected abstract List<String> command(File bin);
    /** 从进程输出里匹配公网 URL 的正则。 */
    protected abstract Pattern urlPattern();
    /** 日志/线程名标签 (如 "cf" / "ssh")。 */
    protected abstract String tag();

    public String getUrl() { return publicUrl; }
    public boolean isAlive() { Process p = proc; return p != null && p.isAlive(); }
    public boolean hasUrl() { return !publicUrl.isEmpty(); }

    /** 返回打包的可执行文件 (nativeLibraryDir/<libName>), 不存在返回 null (该 ABI 未打包)。 */
    public File binary() {
        try {
            ApplicationInfo ai = ctx.getApplicationInfo();
            File f = new File(ai.nativeLibraryDir, libName());
            return f.exists() ? f : null;
        } catch (Exception e) { return null; }
    }

    /** 起隧道子进程并异步解析公网 URL。返回 false = 二进制缺失 (该 ABI 未打包)。 */
    public synchronized boolean start() {
        File bin = binary();
        if (bin == null) { cb.onLog(tag() + " 二进制缺失 (该设备 ABI 未打包)"); return false; }
        stopped = false; publicUrl = "";
        try {
            ProcessBuilder pb = new ProcessBuilder(command(bin));
            pb.redirectErrorStream(true);
            // 给子进程一个可写 HOME/TMPDIR (避免它往不可写目录写日志/状态)。
            pb.environment().put("HOME", ctx.getFilesDir().getAbsolutePath());
            pb.environment().put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
            proc = pb.start();
            Thread reader = new Thread(this::readLoop, "rtflow-" + tag() + "-reader");
            reader.setDaemon(true);
            reader.start();
            return true;
        } catch (Exception e) {
            cb.onLog(tag() + " 启动失败: " + e.getMessage());
            return false;
        }
    }

    private void readLoop() {
        Process p = proc;
        if (p == null) return;
        Pattern re = urlPattern();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                cb.onLog(line);
                if (publicUrl.isEmpty()) {
                    Matcher m = re.matcher(line);
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
