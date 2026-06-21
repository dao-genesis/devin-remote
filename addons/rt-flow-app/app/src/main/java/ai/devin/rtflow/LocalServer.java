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
 * LocalServer · 去中心化直连的本地入站 HTTP server (绑 0.0.0.0 = 回环 + 局域网)。
 *
 *  两种直连均经本 server, 完全不经任何共享 Worker:
 *   ① 局域网直连 (无感等效内网穿透): 控制端与手机同一 Wi-Fi/热点时, 直接 http://<手机局域网IP>:<port>
 *      连本机 —— 零中继、零隧道、零云依赖, 真·直连「我当前设备」。
 *   ② 设备自带 cloudflared 快速隧道把本 server 暴露成 https://xxx.trycloudflare.com (跨网络兜底)。
 *
 *  协议与 dao-relay Worker 完全一致 (driver 工具无需改动):
 *    POST /relay/<session>   Authorization: Bearer <token>
 *    body = {"path":"/api/...","method":"POST","body":{...}}   (body 可为 E2E 信封)
 *    → 经 RelayService.dispatchLocal() 进引擎 serveLocal(E2E 解密→RPC→重封)
 *    → HTTP 响应体 = out.body, 状态 = out.status (与 Worker 的 json(out.body) 等价)。
 *    GET /health 免鉴权探活。
 */
public final class LocalServer {
    public interface Dispatcher {
        /** 当前会话 token (与 relay-config 一致); 用于 Bearer 鉴权。 */
        String token();
        /** 把 frame JSON {"path","method","body"} 喂给引擎, 阻塞返回 serveLocal 结果 {"status","bodyText"}。 */
        String dispatch(String frameJson) throws Exception;
        /** GET 静态页 (浏览器控制台 webshell): 返回 HTML 文本; null = 该路径无静态页 (走 404)。 */
        default String staticHtml(String path) { return null; }
        /** GET 静态资源: 返回 {contentType, body}; null = 无此资源 (走 404)。
         *  用于把 APK 自身的真实页面 (switch/tunnel/cloud/…) 与其 JS 资源原样服务给浏览器。 */
        default String[] staticAsset(String path) { return null; }
        /** 反向代理外站: 原生抓取 url → 剥 X-Frame-Options/CSP → 注入 <base> → 同源回服。
         *  返回 {contentType, html}; null = 失败。破除「外站禁止被 iframe 内嵌」, 让外壳能嵌真实外站。 */
        default String[] embedDoc(String url) { return null; }
        /** 凭证转发 + 全量重写反向代理 (/px/<acct>/<absurl>): 原生抓取(代账号注入 Bearer auth1)→
         *  顶层 HTML 注入 <base>+登录态种子+fetch/XHR 改写垫片 → 同源回服, 子资源/API 全经本代理同源直取。
         *  破除 X-Frame-Options + CORS + 跨域鉴权三重限制, 使外站(含 app.devin.ai 登录态)能在外壳内渲染。
         *  返回 {contentType, payload, encoding("text"|"b64"), status}; null = 失败。 */
        default String[] embedProxy(String method, String url, String acct, String body, String reqContentType, String reqHost) { return null; }
        /** 为 (目标站 origin, 账号) 分配/复用一个根挂载透明代理端口 → 返回端口号 (>0); -1 失败。
         *  根挂载: 该端口的根 / 即源站根, 真实路径逐字一致 → 重型 SPA(TanStack 路由+auth0+Connect-RPC, 含
         *  app.devin.ai 登录态)零改写完整渲染 (路径前缀代理因污染 location 致路由错乱/chunk 404, 故须独立端口根挂载)。
         *  绑 0.0.0.0 → 同机(APK 自身 app.html 外壳经 localhost)+ 局域网浏览器可达; 公网单隧道场景外壳回退 /px。 */
        default int proxyPort(String target, String acct) { return -1; }
        /** 公网根挂载: 为 (源站,账号) 的根挂载端口再起一条专属 cloudflared 快速隧道 → 返回 https 公网 URL。
         *  公网任意浏览器据此 iframe 内嵌即享根挂载(真实路径逐字一致, 不必回退 /px); 失败返回 ""。 */
        default String proxyPublicUrl(String target, String acct) { return ""; }
    }

    private final Dispatcher disp;
    private volatile ServerSocket server;
    private volatile int port = -1;
    private volatile boolean running = false;
    private Thread acceptThread;
    // 有界线程池: 入站请求会阻塞等引擎 dispatch (≤60s), 引擎本身串行; 固定 12 线程足够且杜绝线程暴涨。
    private final ExecutorService pool = Executors.newFixedThreadPool(12, r -> {
        Thread t = new Thread(r, "rtflow-localsrv-w");
        t.setDaemon(true);
        return t;
    });

    public LocalServer(Dispatcher disp) { this.disp = disp; }

    public int getPort() { return port; }
    public boolean isRunning() { return running; }

    /** 绑 0.0.0.0 (回环 + 局域网) 临时端口并起 accept 线程。失败抛异常。
     *  绑全网卡使局域网内控制端可直连本机 (Bearer + E2E 双重保护); cloudflared 仍可经回环接入。 */
    public synchronized int start() throws Exception {
        if (running) return port;
        server = new ServerSocket(0, 128, InetAddress.getByName("0.0.0.0"));
        port = server.getLocalPort();
        running = true;
        acceptThread = new Thread(this::acceptLoop, "rtflow-localsrv");
        acceptThread.setDaemon(true);
        acceptThread.start();
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
            try { sock = server.accept(); }
            catch (Exception e) { if (running) continue; else break; }
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
            String method = rl.length > 0 ? rl[0] : "";
            String path = rl.length > 1 ? rl[1] : "/";

            int contentLength = 0;
            String auth = "";
            String reqCtype = "";
            String reqHost = "";
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c <= 0) continue;
                String k = line.substring(0, c).trim().toLowerCase();
                String v = line.substring(c + 1).trim();
                if (k.equals("content-length")) { try { contentLength = Integer.parseInt(v); } catch (Exception ignored) {} }
                else if (k.equals("authorization")) auth = v;
                else if (k.equals("content-type")) reqCtype = v;
                else if (k.equals("host")) reqHost = v;
            }

            // CORS 预检
            if (method.equalsIgnoreCase("OPTIONS")) { writeCors(out); sock.close(); return; }

            // 凭证转发全量重写代理 /px/<acct>/<absurl> (任意 method): 子资源/API 全同源经此代理直取。
            // 破 X-Frame-Options + CORS + 跨域鉴权 → 外站(含 app.devin.ai 登录态)在外壳内渲染。免页面鉴权
            // (拿外站内容不涉本机金库读写; 代理仅按 acct 注入该号 Bearer 回打源站)。
            if (path.startsWith("/px/")) {
                String afterPx = path.substring(4);
                int sl = afterPx.indexOf('/');
                String acct = "", target = "";
                if (sl >= 0) {
                    acct = urlDecode(afterPx.substring(0, sl));
                    target = afterPx.substring(sl + 1);   // 完整绝对 URL (含其 query)
                }
                String reqBody = "";
                if (contentLength > 0) reqBody = new String(readBody(in, contentLength), StandardCharsets.UTF_8);
                String[] r = target.isEmpty() ? null : disp.embedProxy(method, target, acct, reqBody, reqCtype, reqHost);
                if (r != null) {
                    int st = 200; try { st = Integer.parseInt(r[3]); } catch (Exception ignored) {}
                    if ("b64".equals(r[2])) writeBytes(out, st, r[0], android.util.Base64.decode(r[1], android.util.Base64.DEFAULT));
                    else writeAsset(out, st, r[0], r[1]);
                    sock.close(); return;
                }
                write(out, 502, "{\"error\":\"proxy_failed\"}"); sock.close(); return;
            }

            if (method.equalsIgnoreCase("GET")) {
                // 健康探活 (免鉴权; cloudflared/relay 存活探测专用)
                if (path.equals("/health")) {
                    write(out, 200, "{\"status\":\"ok\",\"service\":\"rtflow-local-tunnel\"}");
                    sock.close(); return;
                }
                // 反向代理外站 (破 X-Frame-Options): /embed?u=<urlencoded> → 原生抓取后同源回服, 可被 iframe 内嵌。
                String pe = path; int qe = pe.indexOf('?'); String qs = qe >= 0 ? pe.substring(qe + 1) : "";
                if (qe >= 0 ? pe.substring(0, qe).equals("/embed") : pe.equals("/embed")) {
                    String u = queryParam(qs, "u");
                    String[] doc = u.isEmpty() ? null : disp.embedDoc(u);
                    if (doc != null) { writeHtml(out, 200, doc[1]); sock.close(); return; }
                    write(out, 502, "{\"error\":\"embed_failed\"}"); sock.close(); return;
                }
                // 根挂载透明代理端口分配 /pxport?target=<enc>&acct=<enc> → {"port":N}。app.html Devin 标签据此
                // 以独立端口根挂载源站 (真实路径逐字一致 → 登录态 SPA 完整渲染); 同机/局域网可达, 公网回退 /px。
                if (qe >= 0 ? pe.substring(0, qe).equals("/pxport") : pe.equals("/pxport")) {
                    String target = urlDecode(queryParam(qs, "target"));
                    String acct = urlDecode(queryParam(qs, "acct"));
                    int pp = target.isEmpty() ? -1 : disp.proxyPort(target, acct);
                    write(out, pp > 0 ? 200 : 502, pp > 0 ? "{\"port\":" + pp + "}" : "{\"error\":\"proxy_port_failed\"}");
                    sock.close(); return;
                }
                // 公网根挂载 /pxpublic?target=<enc>&acct=<enc> → {"url":"https://xxx.trycloudflare.com"}。为该根挂载
                // 端口起专属快速隧道 → 公网 https 独立 origin(根即源站根)→ 公网任意浏览器也享根挂载登录态渲染。
                if (qe >= 0 ? pe.substring(0, qe).equals("/pxpublic") : pe.equals("/pxpublic")) {
                    String target = urlDecode(queryParam(qs, "target"));
                    String acct = urlDecode(queryParam(qs, "acct"));
                    String pu = target.isEmpty() ? "" : disp.proxyPublicUrl(target, acct);
                    write(out, (pu != null && !pu.isEmpty()) ? 200 : 502,
                          (pu != null && !pu.isEmpty()) ? "{\"url\":" + HttpBridge.jsonStr(pu) + "}" : "{\"error\":\"proxy_public_failed\"}");
                    sock.close(); return;
                }
                // 浏览器: 原样拿 APK 真实页面与其 JS 资源 (免鉴权拿页面; 页面内每个 RPC 仍需 Bearer Token)。
                // 去掉 query (?session=...) 再匹配。
                String p = path; int q = p.indexOf('?'); if (q >= 0) p = p.substring(0, q);
                String[] asset = disp.staticAsset(p);
                if (asset != null) { writeAsset(out, 200, asset[0], asset[1]); sock.close(); return; }
                String html = disp.staticHtml(p);
                if (html != null) { writeHtml(out, 200, html); sock.close(); return; }
                write(out, 404, "{\"error\":\"not_found\"}"); sock.close(); return;
            }

            if (!path.startsWith("/relay/")) { write(out, 404, "{\"error\":\"not_found\"}"); sock.close(); return; }
            if (!method.equalsIgnoreCase("POST")) { write(out, 405, "{\"error\":\"method_not_allowed\"}"); sock.close(); return; }

            // Bearer 鉴权: 知道 session(URL)+token 即凭证 (与 Worker 配对模型一致)。
            String tok = auth.startsWith("Bearer ") ? auth.substring(7) : "";
            String want = disp.token();
            if (want == null || want.isEmpty() || !want.equals(tok)) {
                write(out, 401, "{\"error\":\"unauthorized\"}"); sock.close(); return;
            }

            byte[] bodyBytes = readBody(in, contentLength);
            String frameJson = new String(bodyBytes, StandardCharsets.UTF_8);
            if (frameJson.trim().isEmpty()) frameJson = "{}";

            String result;
            try { result = disp.dispatch(frameJson); }
            catch (Exception e) { write(out, 504, "{\"error\":\"agent_timeout\",\"detail\":" + HttpBridge.jsonStr(String.valueOf(e.getMessage())) + "}"); sock.close(); return; }

            // result = {"status":200,"bodyText":"...已序列化的响应体..."}
            int status = 200; String bodyText = "{}";
            try {
                org.json.JSONObject r = new org.json.JSONObject(result);
                status = r.optInt("status", 200);
                bodyText = r.optString("bodyText", "{}");
            } catch (Exception ignored) { bodyText = result; }
            write(out, status, bodyText);
            sock.close();
        } catch (Exception e) {
            try { sock.close(); } catch (Exception ignored) {}
        }
    }

    private static String urlDecode(String s) {
        if (s == null || s.isEmpty()) return "";
        try { return java.net.URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /** 从 query string 取参数并 URL 解码 (供 /embed?u= 使用)。 */
    private static String queryParam(String qs, String key) {
        if (qs == null || qs.isEmpty()) return "";
        for (String kv : qs.split("&")) {
            int eq = kv.indexOf('=');
            String k = eq >= 0 ? kv.substring(0, eq) : kv;
            if (k.equals(key)) {
                String v = eq >= 0 ? kv.substring(eq + 1) : "";
                try { return java.net.URLDecoder.decode(v, "UTF-8"); } catch (Exception e) { return v; }
            }
        }
        return "";
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int prev = -1, c;
        while ((c = in.read()) != -1) {
            if (c == '\n') { break; }
            if (prev == '\r') bo.write('\r');
            if (c != '\r') bo.write(c);
            prev = c;
        }
        if (c == -1 && bo.size() == 0) return null;
        return bo.toString("UTF-8");
    }

    private static byte[] readBody(InputStream in, int len) throws Exception {
        if (len <= 0) return new byte[0];
        byte[] buf = new byte[len];
        int off = 0, n;
        while (off < len && (n = in.read(buf, off, len - off)) > 0) off += n;
        if (off == len) return buf;
        byte[] cut = new byte[off]; System.arraycopy(buf, 0, cut, 0, off); return cut;
    }

    private static void write(OutputStream out, int status, String body) throws Exception {
        byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        h.append("Content-Type: application/json\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Content-Length: ").append(b.length).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }

    private static void writeHtml(OutputStream out, int status, String body) throws Exception {
        byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        h.append("Content-Type: text/html; charset=utf-8\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Content-Length: ").append(b.length).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }

    private static void writeAsset(OutputStream out, int status, String contentType, String body) throws Exception {
        byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        h.append("Content-Type: ").append(contentType == null ? "text/plain; charset=utf-8" : contentType).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Cache-Control: no-cache\r\n");
        h.append("Content-Length: ").append(b.length).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }

    /** 二进制回服 (字体/图片/wasm 等代理子资源): 原样写字节, 不经 UTF-8 损坏。 */
    private static void writeBytes(OutputStream out, int status, String contentType, byte[] b) throws Exception {
        if (b == null) b = new byte[0];
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        h.append("Content-Type: ").append(contentType == null ? "application/octet-stream" : contentType).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Cache-Control: max-age=300\r\n");
        h.append("Content-Length: ").append(b.length).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }

    private static void writeCors(OutputStream out) throws Exception {
        String h = "HTTP/1.1 204 No Content\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Authorization, Content-Type\r\n"
                + "Content-Length: 0\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static String statusText(int s) {
        switch (s) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 504: return "Gateway Timeout";
            default: return "OK";
        }
    }
}
