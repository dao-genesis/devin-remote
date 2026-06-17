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
 * LocalServer · 路线B 去中心化隧道的本地入站 HTTP server (仅绑 127.0.0.1)。
 *
 *  设备自带的 cloudflared 快速隧道把本 server 暴露成 https://xxx.trycloudflare.com,
 *  外部驱动 (A群) 直连该 URL —— 完全不经任何共享 Worker, 每设备一条独立免费隧道。
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
    }

    private final Dispatcher disp;
    private volatile ServerSocket server;
    private volatile int port = -1;
    private volatile boolean running = false;
    private Thread acceptThread;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public LocalServer(Dispatcher disp) { this.disp = disp; }

    public int getPort() { return port; }
    public boolean isRunning() { return running; }

    /** 绑 127.0.0.1 临时端口并起 accept 线程。失败抛异常。 */
    public synchronized int start() throws Exception {
        if (running) return port;
        server = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
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
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c <= 0) continue;
                String k = line.substring(0, c).trim().toLowerCase();
                String v = line.substring(c + 1).trim();
                if (k.equals("content-length")) { try { contentLength = Integer.parseInt(v); } catch (Exception ignored) {} }
                else if (k.equals("authorization")) auth = v;
            }

            // CORS 预检
            if (method.equalsIgnoreCase("OPTIONS")) { writeCors(out); sock.close(); return; }

            // 健康探活 (免鉴权)
            if ((path.equals("/") || path.equals("/health")) && method.equalsIgnoreCase("GET")) {
                write(out, 200, "{\"status\":\"ok\",\"service\":\"rtflow-local-tunnel\"}");
                sock.close(); return;
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
