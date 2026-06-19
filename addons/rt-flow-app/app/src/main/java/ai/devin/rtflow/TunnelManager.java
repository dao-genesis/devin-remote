package ai.devin.rtflow;

import android.content.Context;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * TunnelManager · 主后端去中心化隧道: 拉起设备自带的 cloudflared 进程, 建立免费快速隧道。
 *
 *  cloudflared 以 jniLibs 形式打包成 libcloudflared.so → 解压到 nativeLibraryDir (该目录
 *  可执行, 绕开 Android 10+ 禁止从应用数据目录 exec 的限制)。该二进制由 NDK cgo 交叉编译
 *  (GOOS=android), 使用 Android 系统 DNS 解析器 — 故能在普通手机/平板解析 trycloudflare。
 *
 *  把本地 LocalServer (127.0.0.1:port) 暴露成 https://xxx.trycloudflare.com:
 *    cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate --protocol http2 --edge-ip-version 4
 *  无需 Cloudflare 账号、无需登录、每设备一条独立隧道 → 真正去中心化、免费。
 *  注: 快速隧道 URL 每次重启会变 (这是 trycloudflare 的设计), 故每次启动后回调上报新 URL。
 *  生命周期 (进程拉起/读 URL/退出回调) 同形逻辑见基类 {@link NativeTunnel}。
 */
public final class TunnelManager extends NativeTunnel {
    private static final Pattern URL_RE = Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com");

    public TunnelManager(Context ctx, int localPort, Callback cb) { super(ctx, localPort, cb); }

    @Override protected String libName() { return "libcloudflared.so"; }
    @Override protected Pattern urlPattern() { return URL_RE; }
    @Override protected String tag() { return "cf"; }

    @Override protected List<String> command(File bin) {
        List<String> cmd = new ArrayList<>();
        cmd.add(bin.getAbsolutePath());
        cmd.add("tunnel");
        cmd.add("--url"); cmd.add("http://127.0.0.1:" + localPort);
        cmd.add("--no-autoupdate");
        cmd.add("--protocol"); cmd.add("http2");      // QUIC/UDP 常被运营商/模拟器 NAT 拦 → 强制 http2(TCP) 更稳
        cmd.add("--edge-ip-version"); cmd.add("4");
        return cmd;
    }
}
