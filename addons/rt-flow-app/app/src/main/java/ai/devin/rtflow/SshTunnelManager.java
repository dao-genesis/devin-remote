package ai.devin.rtflow;

import android.content.Context;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * SshTunnelManager · 扩展 · 独立于 cloudflared 的第二条去中心化公网隧道后端。
 *
 *  拉起设备自带的纯 Go SSH 反向隧道客户端 (打包成 libsshtun.so, 解压到 nativeLibraryDir 执行,
 *  与 cloudflared 同样绕开 Android 10+ 数据目录 exec 限制)。该客户端无账号连接公共 SSH 边缘
 *  (localhost.run / serveo / pinggy), 请求远端 80 端口反向转发, 把本地 LocalServer 暴露成
 *  https://xxx.lhr.life 之类的公网 URL —— 不经 Cloudflare、不经用户 Worker, 真正去中心化。
 *
 *  价值: 当 cloudflared/trycloudflare 被整体封锁时, 这条独立后端仍能提供公网入口 → 冗余兜底。
 *  协议对外完全一致 (同一 LocalServer/relay 协议), driver/curl 零改动。
 *  生命周期同形逻辑见基类 {@link NativeTunnel}。
 */
public final class SshTunnelManager extends NativeTunnel {
    /** 无账号公共 SSH 反向隧道边缘 (按序兜底; 任一通即可)。 */
    public static final String[] EDGES = { "localhost.run:22", "serveo.net:22", "a.pinggy.io:443" };

    // lhr.life(localhost.run) / serveo.net / pinggy 的公网 URL 形态。
    private static final Pattern URL_RE =
            Pattern.compile("https://[a-zA-Z0-9._-]+\\.(?:lhr\\.life|serveo\\.net|pinggy\\.link)");

    private final String edge;     // host:port

    public SshTunnelManager(Context ctx, int localPort, String edge, Callback cb) {
        super(ctx, localPort, cb);
        this.edge = edge;
    }

    public String edge() { return edge; }

    @Override protected String libName() { return "libsshtun.so"; }
    @Override protected Pattern urlPattern() { return URL_RE; }
    @Override protected String tag() { return "ssh"; }

    @Override protected List<String> command(File bin) {
        List<String> cmd = new ArrayList<>();
        cmd.add(bin.getAbsolutePath());
        cmd.add("-host"); cmd.add(edge);
        cmd.add("-user"); cmd.add("nokey");      // 无账号匿名 → 随机公网子域
        cmd.add("-local"); cmd.add(String.valueOf(localPort));
        return cmd;
    }
}
