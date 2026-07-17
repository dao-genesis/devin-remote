package ai.devin.rtflow;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 主线程卡顿黑匣子 (打字/键盘卡死之根因取证器 · 只观测不干预):
 *   独立看门线程每秒往主线程投递心跳; 主线程超过 STALL_MS 未消化 = 正在卡死 →
 *   当场抓取主线程真实堆栈 + 内存水位, 以 JSON 行落盘 files/jank-log.jsonl。
 *   卡顿解除时再补一条 end 记录(含总时长)。日志环形封顶, 可经 RPC readFile /
 *   Native.jankLog() 远程取证 —— 卡死复现即有第一现场, 不再盲修。
 */
final class JankWatch {
    private static final long TICK_MS = 1000;      // 看门心跳周期
    private static final long STALL_MS = 2000;     // 判卡阈值: 主线程 2s 未消化即视为卡死
    private static final long MAX_LOG_BYTES = 262144;   // 日志封顶 256KB, 超限对折保尾

    private static volatile JankWatch sInstance;
    private final File logFile;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile long lastBeat = SystemClock.uptimeMillis();
    private volatile boolean inStall = false;
    private volatile long stallStart = 0;
    private volatile boolean stackDumped = false;

    static void start(File filesDir) {
        if (sInstance != null) return;
        synchronized (JankWatch.class) {
            if (sInstance == null) sInstance = new JankWatch(filesDir);
        }
    }

    static String readLog() {
        JankWatch w = sInstance;
        if (w == null) return "";
        try {
            byte[] b = java.nio.file.Files.readAllBytes(w.logFile.toPath());
            return new String(b, StandardCharsets.UTF_8);
        } catch (Exception e) { return ""; }
    }

    private JankWatch(File filesDir) {
        logFile = new File(filesDir, "jank-log.jsonl");
        final Runnable beat = () -> lastBeat = SystemClock.uptimeMillis();
        HandlerThread ht = new HandlerThread("jank-watch", Thread.MIN_PRIORITY);
        ht.start();
        new Handler(ht.getLooper()).post(new Runnable() {
            @Override public void run() {
                long now = SystemClock.uptimeMillis();
                long silent = now - lastBeat;
                if (silent >= STALL_MS) {
                    if (!inStall) { inStall = true; stallStart = lastBeat; stackDumped = false; }
                    if (!stackDumped) { stackDumped = true; dump("stall", now - stallStart, true); }
                    else if (silent >= STALL_MS * 4 && (silent % (STALL_MS * 4)) < TICK_MS) {
                        dump("stall_ongoing", now - stallStart, true);   // 长卡每 8s 再取一帧堆栈(观察演化)
                    }
                } else if (inStall) {
                    inStall = false;
                    dump("stall_end", now - stallStart, false);
                }
                main.post(beat);
                new Handler(Looper.myLooper()).postDelayed(this, TICK_MS);
            }
        });
    }

    private void dump(String kind, long durMs, boolean withStack) {
        try {
            StringBuilder sb = new StringBuilder(512);
            sb.append("{\"t\":").append(System.currentTimeMillis())
              .append(",\"kind\":\"").append(kind)
              .append("\",\"durMs\":").append(durMs);
            Runtime rt = Runtime.getRuntime();
            sb.append(",\"heapUsedMb\":").append((rt.totalMemory() - rt.freeMemory()) / 1048576)
              .append(",\"heapMaxMb\":").append(rt.maxMemory() / 1048576)
              .append(",\"nativeHeapMb\":").append(android.os.Debug.getNativeHeapAllocatedSize() / 1048576);
            if (withStack) {
                StackTraceElement[] st = Looper.getMainLooper().getThread().getStackTrace();
                sb.append(",\"mainStack\":[");
                int n = Math.min(st.length, 24);
                for (int i = 0; i < n; i++) {
                    if (i > 0) sb.append(',');
                    sb.append('"').append(st[i].toString().replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
                }
                sb.append(']');
            }
            sb.append("}\n");
            appendCapped(sb.toString());
        } catch (Throwable ignore) {}
    }

    private synchronized void appendCapped(String line) {
        try {
            if (logFile.length() > MAX_LOG_BYTES) {   // 对折保尾: 留最近一半, 老记录让位
                byte[] all = java.nio.file.Files.readAllBytes(logFile.toPath());
                int from = all.length / 2;
                while (from < all.length && all[from] != '\n') from++;
                try (FileOutputStream fo = new FileOutputStream(logFile, false)) {
                    fo.write(all, Math.min(from + 1, all.length), all.length - Math.min(from + 1, all.length));
                }
            }
            try (FileOutputStream fo = new FileOutputStream(logFile, true)) {
                fo.write(line.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignore) {}
    }
}
