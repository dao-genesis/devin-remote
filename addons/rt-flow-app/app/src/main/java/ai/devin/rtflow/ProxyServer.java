package ai.devin.rtflow;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ProxyServer · 透明根挂载反向代理 (单端口 = 单 (目标站, 账号))。
 *
 *  ── 鱼与熊掌的「熊掌」: 让重型 SPA (app.devin.ai · TanStack 路由 + auth0 + Connect-RPC) 带登录态完整渲染。
 *  为何要独立端口根挂载 (而非主server 的 /px/<acct>/ 路径前缀代理):
 *    SPA 客户端路由用 history.pushState 改写 location 为根路径 (/org/x、/auth/login), 且 location.pathname
 *    必须 = 源站真实路径路由才匹配。路径前缀代理会让前缀污染 location → 路由错乱、懒加载 chunk 解析到根而 404。
 *    根挂载: 本端口的根 / 即源站根 → 真实路径逐字一致, 0 改写, 路由/chunk/api 全自然命中 (实测登录态秒开)。
 *
 *  绑 0.0.0.0 → 同机 (APK 自身 app.html 外壳, 经 localhost) 与局域网浏览器均可达。
 *  公网 cloudflared 单隧道仅暴露主端口 → 该场景外壳回退主server 的 /px 路径前缀代理 (诚实降级)。
 *
 *  鉴权: 由 Fetcher (RelayService) 代该账号注入 Bearer auth1 + x-cog-org-id 回打源站; 顶层 HTML 注入登录态种子。
 */
public final class ProxyServer {
    public interface Fetcher {
        /** 抓取 url (代 acct 注入鉴权), 顶层 HTML 注入种子/剥 CSP。返回 {contentType, payload, encoding("text"|"b64"), status}; null=失败。 */
        String[] fetch(String method, String url, String acct, String body, String reqContentType, String accept);
    }

    private final String target;   // 源站 origin, 如 https://app.devin.ai
    private final String acct;
    private final Fetcher fetcher;
    private volatile ServerSocket server;
    private volatile int port = -1;
    private volatile boolean running = false;
    private Thread acceptThread;
    private final ExecutorService pool = Executors.newFixedThreadPool(16, r -> {
        Thread t = new Thread(r, "rtflow-proxy-w"); t.setDaemon(true); return t;
    });

    public ProxyServer(String target, String acct, Fetcher fetcher) {
        this.target = target.replaceAll("/+$", ""); this.acct = acct; this.fetcher = fetcher;
    }

    public int getPort() { return port; }
    public boolean isRunning() { return running; }
    public String target() { return target; }
    public String acct() { return acct; }

    public synchronized int start() throws Exception {
        if (running) return port;
        server = new ServerSocket(0, 128, InetAddress.getByName("0.0.0.0"));
        port = server.getLocalPort();
        running = true;
        acceptThread = new Thread(this::acceptLoop, "rtflow-proxy"); acceptThread.setDaemon(true); acceptThread.start();
        return port;
    }

    public synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        server = null; port = -1;
    }

    private void acceptLoop() {
        while (running) {
            final Socket sock;
            try { sock = server.accept(); } catch (Exception e) { if (running) continue; else break; }
            pool.submit(() -> handle(sock));
        }
    }

    private void handle(Socket sock) {
        try {
            sock.setSoTimeout(65000);
            BufferedInputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();
            String reqLine = readLine(in);
            if (reqLine == null || reqLine.isEmpty()) { sock.close(); return; }
            String[] rl = reqLine.split(" ");
            String method = rl.length > 0 ? rl[0] : "GET";
            String path = rl.length > 1 ? rl[1] : "/";

            int contentLength = 0; String ctype = "", accept = "";
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':'); if (c <= 0) continue;
                String k = line.substring(0, c).trim().toLowerCase(); String v = line.substring(c + 1).trim();
                if (k.equals("content-length")) { try { contentLength = Integer.parseInt(v); } catch (Exception ignored) {} }
                else if (k.equals("content-type")) ctype = v;
                else if (k.equals("accept")) accept = v;
            }
            if (method.equalsIgnoreCase("OPTIONS")) { writeCors(out); sock.close(); return; }

            String body = "";
            if (contentLength > 0) body = new String(readBody(in, contentLength), StandardCharsets.UTF_8);

            String url = target + path;
            String[] r = fetcher.fetch(method, url, acct, body, ctype, accept);
            if (r == null) { writeHead(out, 502, "text/plain", 11); out.write("proxy_fail".getBytes()); out.flush(); sock.close(); return; }
            int st = 200; try { st = Integer.parseInt(r[3]); } catch (Exception ignored) {}
            if ("b64".equals(r[2])) {
                byte[] b = android.util.Base64.decode(r[1], android.util.Base64.DEFAULT);
                writeHead(out, st, r[0], b.length); out.write(b);
            } else {
                byte[] b = r[1] == null ? new byte[0] : r[1].getBytes(StandardCharsets.UTF_8);
                writeHead(out, st, r[0], b.length); out.write(b);
            }
            out.flush(); sock.close();
        } catch (Exception e) { try { sock.close(); } catch (Exception ignored) {} }
    }

    private static void writeHead(OutputStream out, int status, String ct, int len) throws Exception {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(status >= 200 && status < 300 ? "OK" : "S").append("\r\n");
        h.append("Content-Type: ").append(ct == null ? "application/octet-stream" : ct).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Content-Length: ").append(len).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
    }
    private static void writeCors(OutputStream out) throws Exception {
        out.write(("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }
    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); int prev = -1, c;
        while ((c = in.read()) != -1) { if (c == '\n') break; if (prev == '\r') bo.write('\r'); if (c != '\r') bo.write(c); prev = c; }
        if (c == -1 && bo.size() == 0) return null;
        return bo.toString("UTF-8");
    }
    private static byte[] readBody(InputStream in, int len) throws Exception {
        if (len <= 0) return new byte[0];
        byte[] buf = new byte[len]; int off = 0, n;
        while (off < len && (n = in.read(buf, off, len - off)) > 0) off += n;
        if (off == len) return buf;
        byte[] cut = new byte[off]; System.arraycopy(buf, 0, cut, 0, off); return cut;
    }
}
