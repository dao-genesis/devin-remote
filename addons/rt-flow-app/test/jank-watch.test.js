"use strict";
// 主线程卡顿黑匣子 (打字/键盘卡死根因取证器) 源级护栏:
//   用户实报: 244/245 版打字/拉键盘卡死数十秒~分钟级(后台全清仍复现), 当前版未复现 →
//   不盲修, 先布第一现场取证: 独立看门线程测主线程心跳, 卡死(>2s)即抓主线程真实堆栈+
//   内存水位落盘 jank-log.jsonl(环形封顶), 经 Native.jankLog()/RPC jankLog 远程取证。
// 无框架: 直接 node test/jank-watch.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app", "src", "main");
const jankSrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "JankWatch.java"), "utf8");
const relaySrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "RelayService.java"), "utf8");
const engineSrc = fs.readFileSync(path.join(APP, "assets", "engine", "engine.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 看门本体: 独立线程 + 主线程心跳 + 卡死抓真堆栈 ──
ok(/HandlerThread\("jank-watch", Thread\.MIN_PRIORITY\)/.test(jankSrc),
   "看门跑独立最低优先级线程 (绝不自己成为卡顿源)");
ok(/STALL_MS = 2000/.test(jankSrc), "判卡阈值 2s (键盘/打字级冻结必命中)");
ok(/Looper\.getMainLooper\(\)\.getThread\(\)\.getStackTrace\(\)/.test(jankSrc),
   "卡死现场抓主线程真实堆栈 (根因不靠猜)");
ok(/getNativeHeapAllocatedSize/.test(jankSrc) && /heapUsedMb/.test(jankSrc),
   "记录 Java/Native 内存水位 (辨内存压力型卡死)");
ok(/stall_end/.test(jankSrc) && /stall_ongoing/.test(jankSrc),
   "卡顿始/中/末三态记录 (长卡每 8s 再取帧观察演化)");
ok(/MAX_LOG_BYTES = 262144/.test(jankSrc) && /appendCapped/.test(jankSrc),
   "日志环形封顶 256KB (对折保尾·绝不撑爆存储)");

// ── 接线: 服务起即布防 (不依赖 Activity), 远程可取证 ──
ok(/JankWatch\.start\(getFilesDir\(\)\)/.test(relaySrc),
   "RelayService.onCreate 即启动看门 (随服务常驻·不依赖前台)");
ok(/@JavascriptInterface public String jankLog\(\) \{ return JankWatch\.readLog\(\); \}/.test(relaySrc),
   "Native.jankLog() 桥接日志只读");
ok(/jankLog: async function\(\)\{ try\{ return \{ok:true, log: N\.jankLog\?N\.jankLog\(\):""\}; \}/.test(engineSrc),
   "RPC cmd jankLog 暴露 (云端经 mesh/Worker 远程取证)");

if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
console.log("jank-watch: all passed");
