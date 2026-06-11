// extension.js · dao-proxy-pro v9.9.269 · 道法自然 · ACP适配 · 反者道之动 · 印222
// v9.9.260 · 同步Min v9.9.60提示词策略 · 繁体化 · 损之又损(去嘱留经) · 经文自足
// v9.9.267 · ③模型路由 模板字面量内正则反斜杠折叠修复(字符类替代 \/ \s)
// v9.9.268 · 三模块面板 window.confirm/alert 被 webview 屏蔽 → 自带 _daoConfirm/_daoToast 弹层
// v9.9.269 · 悬浮面板(本源观照)同样自带 _daoConfirm/_daoToast,7 处 confirm() 改为弹层(断线/解锁/删渠/清空/回退)
//
// 道德经 · 第四十章: "反者道之动, 弱者道之用."
// 道德经 · 第四十八章: "为道日损. 损之又损, 以至于无为."
// 道德经 · 第六十四章: "为者败之, 执者失之."
// 道德经 · 第十六章: "夫物云云, 各复归于其根."
// 道德经 · 第八十一章: "既以为人己愈有, 既以予人己愈多."
// 道德经 · 第七十六章: "兵强则不胜, 木强则折."
//
// 演化链 v9.9.36 → v9.9.54 (source.js 侧为主, ext 侧降频/延迟锚定/无条件重写):
//   v9.9.57 · 八经集成深度锚 · 反者道之动 · 智者趋迟 · 此非勉也乃道之自然
//             TAO_TURN_ANCHOR: 效率型→深度型 · 八经集成 · 去边界/止/限 · 释放深思
//             TAO_SUB_ANCHOR: 虑而执要 · 先思后提炼
//             道义: 四十章「反者道之动也」· 四十八章「无为而无以为」(帛书甲本)
//   v9.9.56 · 根治重载根因 · observeAllSPInBody depth=6→2 + 512KB体积门控
//             与 v9.9.50 已修的 modifyAnyInferenceSP depth=6 完全同构 · 遗漏于观察路径
//             passthrough / invert 两模式均走此路 · 两模式均重载 · 损之又损
//   v9.9.55 · create_memory完整移除 + MEMORY_INTRO_RE剩孤立介绍行
//             stripCreateMemoryTool整块切<function>create_memory</function>
//             MEMORY_INTRO_RE剩"These memories were..."孤立行
//   v9.9.54 · 副路末锚 · invertAnySP 对 summary/memory 加 TAO_SUB_ANCHOR · 断偏移传导链
//             治: TAO_SUB_ANCHOR(~18字) · ephemeral/chat不加 · 六十四章「为之于其未有也」
//   v9.9.53 · 首尾互文双锚 · Turn Anchor复归 · chat主路末锚TAO_TURN_ANCHOR
//   v9.9.52 · 损 CHECKPOINT_BLOCK_RE / CHECKPOINT_MARKER_RE 死代码 (两常量定义无引用 · 损之)
//   v9.9.51 · CHECKPOINT 不再剥除 · 上下文桥 (reload 后 conversation_summary 完整保)
//   v9.9.50 · INFER_STRIP 回退 modifyAnyInferenceSP · trimUserInfo 截断终端历史
//   v9.9.49 · 移除"及其后文本" (冗余补丁) · 精准指向经典
//   v9.9.47 · 书名号复归 · 动态经藏名 · 认知锚点
//   v9.9.45 · proto 损坏根治 · nestedOk 移出 if 块
//   v9.9.44 · 双线融合 · deepStrip 无条件
//   v9.9.43 · session_context+code_interaction_summary 移出 SCT
//   v9.9.42 · SECTION_OVERRIDE 全删 (真无为)
//   v9.9.41 · viewed_file+learnings 移出 SCT
//   v9.9.38 · 去 _cachedAnchored 门控 · 无条件重写 LS args
//
// v9.9.36 "道法自然 · 从根本底层完善":
//   日志实证: window23/24/25 三窗口连环重载 · 根因七层解构
//
//   根因1 (触发层): activate 立写 settings.json → ~800ms → "Installation modified"
//     → renderer 关 MessagePort → ext-host 死(2s) → deactivate 清锚 → 循环
//   根因2 (放大层): deactivate 清锚 → 下个 ext-host 重走 setAnchor → 再触写风暴
//   根因3 (堵塞层): 反代+6 定时器+SSE 全在 ext-host 事件循环 → UNRESPONSIVE × N → 杀
//
//   修复:
//     ① 延迟锚定: activate 不立写 settings.json · 内存先锚 · 15s 后再持久化
//     ② 智能保锚: deactivate ext-host 存活 < 30s → 不清锚 · 下次 auto-restore 零写入
//     ③ 去 API 噪: codeium.* 非注册键 · VS Code API 写永 FAIL · 直删
//     ④ 延迟启动: watchdog 20s 保护 · 终端 10s · 外接 api 12s · focus 5s
//     ⑤ 降频减压: sig 5s(原1.5) · refresh 30s(原12) · watchdog 60s(原30)
//   效果: 彻底断开 activate→write→kill→clear→rewrite 连环写风暴
//
// v9.3.0 "反之用反 · 闭环自举":
//   加 /origin/loopback (POST {user_msg}) 端 · 用最近 chat 缓 + 替 user msg
//   + 真转云端 + 收响应解 grpc · 返 model 之答 · 令模型自审其规则之源.
//   缓仅内存 (_lastChatRelay), 进程退即失, 不漏 token 至磁盘.
//   配 helpers: replaceUserMsgInGrpcBody / extractUtf8StringsFromGrpcBody.
//
// v9.2.1 "有无相生":
//   以结构判 (isAlreadyInverted) 代 s.indexOf(TAO_SENTINEL) 短语幂等守,
//   防用户真 Cascade Memories (含同句导语) 误触 invertSP 早返 null 而完全失效.
//
// v9.2.0 "去芜存菁 · 道法自然":
//   于 v9.1.2 之上, 仅施四味真药, 净减码量, 不增功能, 不增状态.
//
//   真药 A · H2 stream 随断随清 (source.js proxyToCloud)
//      req.aborted / res.close / upStream.setTimeout(180s) → NGHTTP2_CANCEL
//      漏: 原版 upStream 永生留, HOL 阻塞继任流
//      药: 三路监听, 弱者道之用 (四十章)
//
//   真药 B · setAnchor 同值不写 (extension.js setAnchor)
//      漏: 每 activate 必写 settings.json, file watcher 空转, ext-host 抖动
//      药: 进函数先比对, 同值即返 (六十四章 · 为者败之)
//
//   真药 C · EADDRINUSE 不抢 (extension.js proxyStart)
//      漏: 原版 ping 失败仍信占者活, remote handle phantom
//      药: 1 ping · 活则复用 · 死则返 null (本窗口直连, 不抢) (上善若水)
//
//   真药 D · activate 不杀 LS (extension.js activate)
//      漏: 首装即 forceRestartLS 广域杀, 多窗口连锁 ext-host crash
//      药: 首装仅装 hook + 锚 settings, LS 自然重启时挂钩 (四十八章 · 为道日损)
//
// v9.1.3 之过 (前车之鉴 · 损之未足复益): PID 簿 / 健康探针 / 三验 / 离线 handle
//   反伤本源, 此次净拨, 复归 v9.1.2 之朴, 仅留四味.
//
// 命令:
//   wam.originInvert       · 道Agent 启 (含 forceRestartLS · 用户显式触发)
//   wam.originPassthrough  · 官方Agent 启
//   dao.toggleMode         · 道/官 热切
//   dao.openPreview        · 浏览器观真 SP
//   wam.verifyEndToEnd     · E2E 自检
//   wam.selftest           · L1+L2 自检

"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

// ═══════════════════════════ 常量 ═══════════════════════════
const PKG_VERSION = (() => {
  try {
    return require("./package.json").version;
  } catch {
    return "0";
  }
})();
// v9.9.25 · 软编码归一 · 二十八章「朴散为器·圣人用则为官长·夫大制无割」
// 病: dao-agi.dao-proxy-min 字面散写 4 处 (扫描自身目录 / .obsolete 标 / uninstallExtension 参)
// 治: 抽自 package.json 之 publisher + name · 一处定义 · 全文一致 · 适所有用户/所有 fork
const PKG_PUBLISHER = (() => {
  try {
    return require("./package.json").publisher;
  } catch {
    return "dao-agi";
  }
})();
const PKG_NAME = (() => {
  try {
    return require("./package.json").name;
  } catch {
    return "dao-proxy-min";
  }
})();
const SELF_EXT_ID = `${PKG_PUBLISHER}.${PKG_NAME}`; // "dao-agi.dao-proxy-min"
const SELF_EXT_DIR_PREFIX = `${SELF_EXT_ID}-`; // "dao-agi.dao-proxy-min-"
const _SELF_ESC = SELF_EXT_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SELF_EXT_DIR_REGEX = new RegExp("^" + _SELF_ESC + "-");
const SELF_EXT_VER_REGEX = new RegExp(
  "^" + _SELF_ESC + "-(\\d+)\\.(\\d+)\\.(\\d+)(?:[.-]|$)",
);

const DEFAULT_PORT = 8889;
const OFFICIAL_API_URL = "https://server.codeium.com";
const OFFICIAL_INFER_URL = "https://inference.codeium.com";
const BACKUP_KEY_API = "dao.origin._backup_apiServerUrl";
const BACKUP_KEY_INFER = "dao.origin._backup_inferenceApiServerUrl";

const DAO_QUOTES = [
  "道可道，非常道",
  "上善若水",
  "大音希声，大象无形",
  "道法自然",
  "无为而无不为",
  "致虚极，守静笃",
  "反者道之动",
  "知者不言，言者不知",
  "天下莫柔弱于水",
  "为学日益，为道日损",
];

// ═══════════════════════════ 缓存 ═══════════════════════════
let _cachedPort = DEFAULT_PORT;
let _cachedProxyUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
let _cachedAnchored = false;
let _cachedMode = "invert";
let _activateTs = 0; // v9.9.36 · ext-host 生命周期追踪 · smart deactivate
let _deferredAnchorTimer = null; // v9.9.36 · 延迟锚定计时器 · 渡过 Installation Modified 危窗

// ═══════════════════════════ ACP 模式 (印222) ═══════════════════════════
// v9.9.200 · 道法自然 · 反者道之动 · 新版 Devin Desktop 架构适配
// 新版: Chat 走 ACP (Agent Communication Protocol) over stdio → devin.exe
// 旧版: Chat 走 gRPC/ConnectRPC over HTTP → language_server
// 印222裁决: HTTP MITM 已死 (Chat不再走HTTP) → stdio中间人代理新生
let _acpMode = false; // true = 新版 ACP 架构 (devin.exe 存在)
let _acpProxyPath = null; // dao-acp-stdio-proxy.js 路径

// ═══════════════════════════ 日志 ═══════════════════════════
let _channel = null;
function logger() {
  if (!_channel) _channel = vscode.window.createOutputChannel("道Agent");
  return _channel;
}
function _stamp() {
  const d = new Date(),
    p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const L = {
  info: (tag, msg) =>
    logger().appendLine(`[${_stamp()}] [INFO] [${tag}] ${msg}`),
  warn: (tag, msg) =>
    logger().appendLine(`[${_stamp()}] [WARN] [${tag}] ${msg}`),
  error: (tag, msg) =>
    logger().appendLine(`[${_stamp()}] [ERR]  [${tag}] ${msg}`),
};

// ═══════════════════════════ per-user 端口 FNV-1a ═══════════════════════════
function fnv1aPort(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return 8889 + (h % 100); // 8889..8988
}

function resolvePort() {
  const c = vscode.workspace.getConfiguration("dao");
  const explicit = parseInt(c.get("origin.port"), 10);
  if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 65535)
    return explicit;
  // per-user 自动 · 用 os.userInfo().username
  try {
    return fnv1aPort(os.userInfo().username);
  } catch {
    return DEFAULT_PORT;
  }
}

function cfg() {
  _cachedPort = resolvePort();
  _cachedProxyUrl = `http://127.0.0.1:${_cachedPort}`;
  return { port: _cachedPort };
}

// ═══════════════════════════ spawn hook ═══════════════════════════
const _origSpawn = cp.spawn;
const _origSpawnSync = cp.spawnSync;
const _origExec = cp.exec;
const _origExecFile = cp.execFile;
let _spawnHooked = false;

// ═══════════════════════════ ACP spawn hook (印222 · 方案B) ═══════════════════════════
// v9.9.200 · stdio 中间人代理 · 拦截 extension.js ↔ devin.exe 的 ndJson ACP 流
// 道义: 四十章「反也者 道之动也」· 旧HTTP MITM死 → 新stdio中间人生
// 返回 { cmd, args, options } 或 null · 由 spawn hook 修改 arguments
function _rewriteAcpSpawn(command, args) {
  if (
    typeof command !== "string" ||
    !/devin\.exe$|\/devin$/.test(command) ||
    !Array.isArray(args)
  )
    return null;
  // 仅在 ACP 模式下拦截
  if (!_acpMode || !_acpProxyPath) return null;
  // 替换 command: node dao-acp-stdio-proxy.js <原devin.exe> <原args>
  const nodeExe = process.execPath || "node";
  const newArgs = [_acpProxyPath, command, ...args];
  L.info(
    "spawn-hook-acp",
    `devin.exe → stdio proxy: ${command} → node ${_acpProxyPath}`,
  );
  return { cmd: nodeExe, args: newArgs };
}

function maybeRewriteLsArgs(command, args) {
  if (
    typeof command !== "string" ||
    !/language_server/.test(command) ||
    !Array.isArray(args)
  )
    return false;
  // ★ v9.9.261 · ACP 模式下也重写 LS args · 反者道之动
  // 印222原判: Chat 走 ACP/stdio → HTTP MITM 无用 → 不重写 LS
  // 实证推翻: session/new + session/prompt 走 gRPC CascadeService
  //   gRPC 经 NodeService:12817 → NetworkService → LS 的 api_server_url
  //   故 LS 的 --api_server_url 和 --inference_api_server_url 必须指向本地代理
  // 道义: 四十章「反也者 道之动也」· 印222之判反 · 今正之
  if (false && _acpMode) {
    L.info("spawn-hook", `ACP模式: 跳过 LS args 重写 · SP由stdio代理处理`);
    return false;
  }
  // v9.9.38 · 去 _cachedAnchored 门控 · 无条件重写 · 治多窗口竞态
  // 根因: proxyStart 异步 → LS 在 proxy 就绪前 spawn → _cachedAnchored=false → 不重写 → 直连
  // 修正: 始终重写 · 端口确定性(fnv1a) · proxy 总会存活(watchdog/任一窗口)
  // 道义: 十七章「太上 下知有之」· 水善利万物而有静
  let rewrote = 0;
  for (const flag of ["--api_server_url", "--inference_api_server_url"]) {
    const idx = args.indexOf(flag);
    if (
      idx >= 0 &&
      idx + 1 < args.length &&
      args[idx + 1] !== _cachedProxyUrl
    ) {
      L.info("spawn-hook", `${flag}: ${args[idx + 1]} → ${_cachedProxyUrl}`);
      args[idx + 1] = _cachedProxyUrl;
      rewrote++;
    }
  }
  return rewrote > 0;
}

// ★ v9.9.200 · 读取 Windows 系统代理 → 注入 devin.exe 环境
// 道义: 四十三章「天下之至柔 驰骋于天下之至坚」· 代理即柔道
function _readSystemProxy() {
  if (process.platform !== "win32") return null;
  try {
    const cp = require("child_process");
    const reg = cp.execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /v ProxyEnable',
      { encoding: "utf8", timeout: 3000 },
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(reg);
    if (!enabled) return null;
    const m = reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return null;
    const server = m[1];
    // 构建 http/https proxy URL
    const url = server.startsWith("http") ? server : `http://${server}`;
    L.info("spawn-hook", `系统代理: ${url}`);
    return url;
  } catch {
    return null;
  }
}

function installSpawnHook() {
  if (_spawnHooked) return;
  _spawnHooked = true;
  const _sysProxy = _readSystemProxy();
  cp.spawn = function (cmd, a) {
    // ★ v9.9.200 · ACP spawn hook 优先 (devin.exe → stdio proxy)
    const _acp = _rewriteAcpSpawn(cmd, a);
    if (_acp) {
      arguments[0] = _acp.cmd;
      arguments[1] = _acp.args;
      // 确保 stdio 为 pipe (ACP 需要 stdin/stdout 双向通信)
      if (arguments[2] && typeof arguments[2] === "object") {
        arguments[2].stdio = ["pipe", "pipe", "pipe"];
        arguments[2].windowsHide = true;
        if (!arguments[2].env) arguments[2].env = { ...process.env };
        if (!arguments[2].env.ACP_BACKEND)
          arguments[2].env.ACP_BACKEND = "windsurf";
        if (
          _sysProxy &&
          !arguments[2].env.HTTP_PROXY &&
          !arguments[2].env.http_proxy
        ) {
          arguments[2].env.HTTP_PROXY = _sysProxy;
          arguments[2].env.HTTPS_PROXY = _sysProxy;
          arguments[2].env.http_proxy = _sysProxy;
          arguments[2].env.https_proxy = _sysProxy;
          L.info("spawn-hook-acp", `注入代理: ${_sysProxy}`);
        }
      }
    } else {
      maybeRewriteLsArgs(cmd, a);
    }
    return _origSpawn.apply(this, arguments);
  };
  cp.spawnSync = function (cmd, a) {
    const _acp = _rewriteAcpSpawn(cmd, a);
    if (_acp) {
      arguments[0] = _acp.cmd;
      arguments[1] = _acp.args;
      if (arguments[2] && typeof arguments[2] === "object") {
        arguments[2].stdio = ["pipe", "pipe", "pipe"];
        arguments[2].windowsHide = true;
        if (!arguments[2].env) arguments[2].env = { ...process.env };
        if (!arguments[2].env.ACP_BACKEND)
          arguments[2].env.ACP_BACKEND = "windsurf";
        if (
          _sysProxy &&
          !arguments[2].env.HTTP_PROXY &&
          !arguments[2].env.http_proxy
        ) {
          arguments[2].env.HTTP_PROXY = _sysProxy;
          arguments[2].env.HTTPS_PROXY = _sysProxy;
          arguments[2].env.http_proxy = _sysProxy;
          arguments[2].env.https_proxy = _sysProxy;
        }
      }
    } else {
      maybeRewriteLsArgs(cmd, a);
    }
    return _origSpawnSync.apply(this, arguments);
  };
  cp.execFile = function (cmd, a) {
    if (Array.isArray(a)) {
      const _acp = _rewriteAcpSpawn(cmd, a);
      if (_acp) {
        arguments[0] = _acp.cmd;
        arguments[1] = _acp.args;
        if (arguments[2] && typeof arguments[2] === "object") {
          arguments[2].stdio = ["pipe", "pipe", "pipe"];
          arguments[2].windowsHide = true;
          if (!arguments[2].env) arguments[2].env = { ...process.env };
          if (!arguments[2].env.ACP_BACKEND)
            arguments[2].env.ACP_BACKEND = "windsurf";
          if (
            _sysProxy &&
            !arguments[2].env.HTTP_PROXY &&
            !arguments[2].env.http_proxy
          ) {
            arguments[2].env.HTTP_PROXY = _sysProxy;
            arguments[2].env.HTTPS_PROXY = _sysProxy;
            arguments[2].env.http_proxy = _sysProxy;
            arguments[2].env.https_proxy = _sysProxy;
          }
        }
      } else {
        maybeRewriteLsArgs(cmd, a);
      }
    }
    return _origExecFile.apply(this, arguments);
  };
  cp.exec = function (cmdline) {
    if (typeof cmdline === "string" && /language_server/.test(cmdline)) {
      const orig = cmdline;
      cmdline = cmdline.replace(
        /(--(?:inference_)?api_server_url(?:=|\s+))(\S+)/g,
        (m, p1) => p1 + _cachedProxyUrl,
      );
      if (cmdline !== orig) {
        L.info("spawn-hook", `exec rewrite`);
        arguments[0] = cmdline;
      }
    }
    return _origExec.apply(this, arguments);
  };
  L.info(
    "spawn-hook",
    `installed (spawn/spawnSync/execFile/exec) · acp=${_acpMode}`,
  );
}

function removeSpawnHook() {
  if (!_spawnHooked) return;
  cp.spawn = _origSpawn;
  cp.spawnSync = _origSpawnSync;
  cp.exec = _origExec;
  cp.execFile = _origExecFile;
  _spawnHooked = false;
}

// ═══════════════════════════ LS 重启 ═══════════════════════════
// 仅由用户显式命令触发 (cmdInvert / deactivate); 不在 activate 调用 (真药 D)
// 第六十四章「为者败之」: activate 不主动干预 LS, 留待自然重启或用户意愿
function forceRestartLS() {
  return new Promise((resolve) => {
    const plat = process.platform;
    let cmd, args;
    if (plat === "win32") {
      const userName = os.userInfo().username;
      cmd = "taskkill";
      args = [
        "/F",
        "/FI",
        "IMAGENAME eq language_server_windows_x64.exe",
        "/FI",
        `USERNAME eq ${userName}`,
      ];
    } else {
      const binName =
        plat === "darwin"
          ? "language_server_macos_arm"
          : "language_server_linux_x64";
      cmd = "pkill";
      args = ["-f", binName];
      try {
        const uid = String(os.userInfo().uid);
        if (uid && uid !== "-1") args.unshift("-u", uid);
      } catch {}
    }
    const proc = _origSpawn(cmd, args, { stdio: "pipe" });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      L.info(
        "restart-ls",
        `${plat} ${cmd} exit=${code} ${out.trim().slice(0, 200)}`,
      );
      resolve(code === 0 || code === 128 || (plat !== "win32" && code === 1));
    });
    proc.on("error", (e) => {
      L.warn("restart-ls", e.message);
      resolve(false);
    });
  });
}

// ═══════════════════════════ 源.js 进程内 require ═══════════════════════════
let _proxyHandle = null; // start() 返回的 handle: { server, port, host, close, getMode, setMode }

// v9.9.21 · 唯变所适 · 软编码归宗 · 二十五章「逝曰远 远曰反」· 二十二章「曲则金」
// 病: 旧版 vendorDir 锚死 __dirname/vendor/bundled-origin · 多 ext-host 共存 +
//     旧 ext-host watchdog 复活 → 永走旧版 source.js · self_file 锁死旧目录
// 药: 扫所有 ~/.windsurf/extensions/dao-agi.dao-proxy-min-*/ · 按 semver 选最新版
//     即旧 ext-host (旧 extension.js · 旧 vendorDir) 也从此药受惠 (新装 vsix 后)
//     · 至少新 ext-host 之 require 永走最新源 · 自显新道
//     注: 旧 extension.js 不会调本新 vendorDir · 唯靠 EADDRINUSE 让位机制兼治
function _scanLatestVendorDir() {
  try {
    const extRoot = path.dirname(__dirname); // ~/.windsurf/extensions/
    if (!fs.existsSync(extRoot)) return null;
    const candidates = [];
    for (const name of fs.readdirSync(extRoot)) {
      if (!name.startsWith(SELF_EXT_DIR_PREFIX)) continue;
      // 排除 .obsolete/.DISABLED/.preinstall/.bak/.backup 等中间态目录
      if (/\.(obsolete|disabled|preinstall|backup|bak)/i.test(name)) continue;
      const m = name.match(SELF_EXT_VER_REGEX);
      if (!m) continue;
      const dir = path.join(extRoot, name, "vendor", "bundled-origin");
      const fp = path.join(dir, "source.js");
      if (!fs.existsSync(fp)) continue;
      candidates.push({
        name,
        version: [+m[1], +m[2], +m[3]],
        path: dir,
      });
    }
    if (candidates.length === 0) return null;
    // 降序: 9.9.21 > 9.9.20 > 9.9.19 ...
    candidates.sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
      }
      return 0;
    });
    return candidates[0];
  } catch (e) {
    L.warn("vendorDir", `scan fail: ${e.message}`);
    return null;
  }
}

function vendorDir() {
  // 优先选最新版 · 唯变所适
  const best = _scanLatestVendorDir();
  if (best) {
    const myVerStr = String(PKG_VERSION || "0.0.0");
    const bestVerStr = best.version.join(".");
    if (bestVerStr !== myVerStr) {
      L.info(
        "vendorDir",
        `自身 v${myVerStr} → 选最新 v${bestVerStr} (${best.name})`,
      );
    }
    return best.path;
  }
  // 兜底: 自家目录
  return path.join(__dirname, "vendor", "bundled-origin");
}

function findSourceJs() {
  const dir = vendorDir();
  for (const n of ["source.js", "源.js"]) {
    const fp = path.join(dir, n);
    if (fs.existsSync(fp)) return fp;
  }
  // 终极兜底: 扫 shebang
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(dir, f);
      const head = fs.readFileSync(fp, "utf8").slice(0, 60);
      if (head.includes("#!/usr/bin/env node") || head.includes("// origin"))
        return fp;
    }
  } catch {}
  return null;
}

// v9.9.21 · 唯变所适 · 让位机制
// _isRemoteStale: 远端 self_file 是否非最新版 dao-proxy-min-* 之 source.js
function _isRemoteStale(remoteSelfFile) {
  if (!remoteSelfFile || typeof remoteSelfFile !== "string") return false;
  const best = _scanLatestVendorDir();
  if (!best) return false;
  const expected = path.join(best.path, "source.js").toLowerCase();
  return remoteSelfFile.toLowerCase() !== expected;
}

async function proxyStart(port, mode, _retried, _altAttempts) {
  if (_proxyHandle) return _proxyHandle;
  const srcPath = findSourceJs();
  if (!srcPath) throw new Error(`源.js 不存在: ${vendorDir()}`);
  try {
    delete require.cache[require.resolve(srcPath)];
    const mod = require(srcPath);
    if (typeof mod.start !== "function")
      throw new Error("源.js 无 start() 导出");
    _proxyHandle = await mod.start({
      port,
      host: "127.0.0.1",
      mode: mode || "passthrough",
    });
    // ★ v9.9.261 · EACCES 回退: 实际端口可能不同于 FNV 计算
    if (port !== _cachedPort) {
      L.info(
        "proxy",
        `port fallback: ${_cachedPort} → ${_proxyHandle.port} (EACCES回避)`,
      );
      _cachedPort = _proxyHandle.port;
    }
    L.info(
      "proxy",
      `started :${_proxyHandle.port} src=${srcPath} mode=${_proxyHandle.getMode()}`,
    );
    return _proxyHandle;
  } catch (e) {
    // ★ v9.9.261 · EACCES 回退 · Windows 动态端口范围异常
    // 实证: 179笔记本 TCP动态端口从1024开始 → 91%端口EACCES
    // 道义: 七十六章「坚强者死之徒 · 柔弱微细生之徒」· 不争即得
    if (e.code === "EACCES" || (e.message && e.message.includes("EACCES"))) {
      const attempts = _altAttempts || 0;
      if (attempts < 20) {
        // 在 8889-8988 范围内尝试邻近端口
        const altPort = 8889 + ((port - 8889 + attempts + 1) % 100);
        L.warn(
          "proxy",
          `port :${port} EACCES → try :${altPort} (attempt ${attempts + 1}/20)`,
        );
        return proxyStart(altPort, mode, _retried, attempts + 1);
      }
      L.error("proxy", `port :${port} EACCES · 20次回退均失败 · 放弃`);
      throw e;
    }
    if (
      e.code === "EADDRINUSE" ||
      (e.message && e.message.includes("EADDRINUSE"))
    ) {
      L.info("proxy", `port :${port} EADDRINUSE → ping remote`);
      const ping = await httpGetJson(
        `http://127.0.0.1:${port}/origin/ping`,
        2000,
      );
      if (
        ping &&
        ping.ok &&
        (ping.mode === "invert" || ping.mode === "passthrough")
      ) {
        // v9.9.21 · 检远端 self_file 是否最新 · 旧则让位
        // 二十二章「夫唯不争 故莫能与之争」 · 七十六章「兵强则不胜」
        if (!_retried && _isRemoteStale(ping.self_file)) {
          L.warn(
            "proxy",
            `remote stale self_file=${ping.self_file} → POST /_quit · 让位重起`,
          );
          await httpPostJson(
            `http://127.0.0.1:${port}/origin/_quit`,
            { reason: `newer-version v${PKG_VERSION} arrived` },
            2000,
          ).catch(() => {});
          // 等远端 server.close 完毕 (远端 setTimeout 100ms · 加 close 时间)
          await new Promise((r) => setTimeout(r, 1500));
          return proxyStart(port, mode, true); // 一次重试 · 防递归无限
        }
        L.info(
          "proxy",
          `port :${port} live remote (mode=${ping.mode} · ver=${(ping.features || {}).mode || "?"}) → remote handle`,
        );
        _proxyHandle = _createRemoteHandle(port, ping.mode);
        return _proxyHandle;
      }
      L.warn("proxy", `port :${port} 占且非反代 · 返 null (本窗口直连)`);
      return null;
    }
    throw e;
  }
}

async function proxyStop() {
  if (!_proxyHandle) return;
  try {
    await _proxyHandle.close();
  } catch (e) {
    L.warn("proxy", `stop: ${e.message}`);
  }
  _proxyHandle = null;
  L.info("proxy", "stopped");
}

// 远程 handle: 端口已有 proxy (多窗口) → 复用而非销毁
function _createRemoteHandle(port, mode) {
  let _mode = mode || "invert";
  return {
    port,
    host: "127.0.0.1",
    server: null, // remote · 无本地 server
    kind: "remote",
    getMode: () => _mode,
    setMode: (m) => {
      _mode = m;
      httpPostJson(
        `http://127.0.0.1:${port}/origin/mode`,
        { mode: m },
        2000,
      ).catch(() => {});
    },
    close: async () => {}, // remote · 不关闭别窗进程
  };
}

function proxySetMode(mode) {
  if (_proxyHandle && _proxyHandle.setMode) {
    _proxyHandle.setMode(mode);
  }
  _cachedMode = mode;
  L.info("proxy", `mode → ${mode}`);
}

function proxyGetMode() {
  if (_proxyHandle && _proxyHandle.getMode) return _proxyHandle.getMode();
  return _cachedMode;
}

// ═══════════════════════════ settings 锚 ═══════════════════════════
// 双保险: VS Code API (内存) + 直写 settings.json (磁盘持久化)
// Windsurf 可能拦截 codeium.* 的 API 写入 · 直写文件兜底
function _settingsJsonPath() {
  const plat = process.platform;
  let base;
  if (plat === "win32") base = process.env.APPDATA;
  else if (plat === "darwin")
    base = path.join(os.homedir(), "Library", "Application Support");
  else base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Windsurf", "User", "settings.json");
}

function _readSettingsJson(fp) {
  try {
    const raw = fs.readFileSync(fp, "utf8").trim();
    if (!raw) return {}; // 空文件 → 空对象 (可写入)
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") return {}; // 文件不存在 → 空对象 (可创建)
    return null; // JSON解析失败等其他错误 → null (不覆盖)
  }
}

function _writeSettingsJson(fp, json) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true }); // 确保父目录存在
    fs.writeFileSync(fp, JSON.stringify(json, null, 2), "utf8");
    return true;
  } catch (e) {
    L.warn("anchor", `file write fail: ${e.message}`);
    return false;
  }
}

async function setAnchor(port) {
  const url = `http://127.0.0.1:${port}`;

  // v9.9.36 · 道法自然 · 损之又损 · 四十八章
  // 去 VS Code API 写 (codeium.* 非注册键 · API 写永 FAIL · 纯噪音)
  // 日志实证: [WARN] [anchor] API set codeium.apiServerUrl fail: Unable to write to User Settings
  //           because codeium.apiServerUrl is not a registered configuration.
  // 文件直写 settings.json 才是唯一有效路径 · 无为而治
  let needWriteFile = false;

  // 先看磁盘当前值 (这是 Windsurf 真正 reload 的依据)
  try {
    const json = _readSettingsJson(_settingsJsonPath());
    if (json) {
      needWriteFile =
        json["codeium.apiServerUrl"] !== url ||
        json["codeium.inferenceApiServerUrl"] !== url;
    } else {
      needWriteFile = true; // 读不到 → 当作需写
    }
  } catch {
    needWriteFile = true;
  }

  // 文件写: 同值不写 · 免 file watcher 空转
  if (needWriteFile) {
    try {
      const sp = _settingsJsonPath();
      const json = _readSettingsJson(sp);
      if (json) {
        json["codeium.apiServerUrl"] = url;
        json["codeium.inferenceApiServerUrl"] = url;
        if (_writeSettingsJson(sp, json)) {
          L.info("anchor", `file set ${url} → ${sp}`);
        }
      } else {
        L.warn("anchor", `settings.json unreadable: ${sp}`);
      }
    } catch (e) {
      L.warn("anchor", `file set fail: ${e.message}`);
    }
  } else {
    L.info("anchor", `already ${url} · skip write (无为而治)`);
  }

  _cachedAnchored = true;
  _cachedProxyUrl = url;
}

async function clearAnchor() {
  // 方法1: VS Code API
  try {
    const c = vscode.workspace.getConfiguration();
    await c.update(
      "codeium.apiServerUrl",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await c.update(
      "codeium.inferenceApiServerUrl",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    try {
      await c.update(
        BACKUP_KEY_API,
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    } catch {}
    try {
      await c.update(
        BACKUP_KEY_INFER,
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    } catch {}
  } catch (e) {
    L.warn("anchor", `API clear fail: ${e.message}`);
  }

  // 方法2: 直写 settings.json
  const sp = _settingsJsonPath();
  const json = _readSettingsJson(sp);
  if (json) {
    delete json["codeium.apiServerUrl"];
    delete json["codeium.inferenceApiServerUrl"];
    delete json[BACKUP_KEY_API];
    delete json[BACKUP_KEY_INFER];
    _writeSettingsJson(sp, json);
    L.info("anchor", `file cleared → ${sp}`);
  }

  _cachedAnchored = false;
  L.info("anchor", "cleared → Windsurf defaults");
}

// 同步清锚 · 仅文件 · 用于 deactivate 等需极速清理的场景
// VS Code API 异步且可能失败 (codeium.* 非注册键) · 文件直写最可靠
function _clearAnchorFileSync() {
  try {
    const sp = _settingsJsonPath();
    const json = _readSettingsJson(sp);
    if (json) {
      let changed = false;
      for (const k of [
        "codeium.apiServerUrl",
        "codeium.inferenceApiServerUrl",
        BACKUP_KEY_API,
        BACKUP_KEY_INFER,
      ]) {
        if (k in json) {
          delete json[k];
          changed = true;
        }
      }
      if (changed) {
        _writeSettingsJson(sp, json);
        L.info("anchor", `file-sync cleared → ${sp}`);
      }
    }
  } catch (e) {
    L.warn("anchor", `file-sync clear fail: ${e.message}`);
  }
  _cachedAnchored = false;
}

function isAnchored() {
  // 检查 VS Code API
  try {
    const c = vscode.workspace.getConfiguration();
    if (c.get("codeium.apiServerUrl") === _cachedProxyUrl) return true;
  } catch {}
  // 兜底: 检查文件
  try {
    const json = _readSettingsJson(_settingsJsonPath());
    if (json && json["codeium.apiServerUrl"] === _cachedProxyUrl) return true;
  } catch {}
  return false;
}

// ═══════════════════════════ HTTP 工具 ═══════════════════════════
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const req = http.get(
        url,
        {
          timeout: timeoutMs || 3000,
          agent: false,
          headers: { connection: "close" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        try {
          req.destroy();
        } catch {}
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

function httpPostJson(url, data, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify(data);
      const u = new (require("node:url").URL)(url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          timeout: timeoutMs || 3000,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            connection: "close",
          },
          agent: false,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        try {
          req.destroy();
        } catch {}
        resolve(null);
      });
      req.write(payload);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function httpDelete(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new (require("node:url").URL)(url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "DELETE",
          timeout: timeoutMs || 3000,
          headers: { connection: "close" },
          agent: false,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        try {
          req.destroy();
        } catch {}
        resolve(null);
      });
      req.end();
    } catch {
      resolve(null);
    }
  });
}

// ═══════════════════════════ SSE 客户端 ═══════════════════════════
// 订阅 源.js /origin/stream · 事件: hello/turn/mode/hb
// 断自愈: 指数退避 max 30s · 无 proxy 时静默重试
class DaoSseClient extends EventEmitter {
  constructor(port) {
    super();
    this._port = port || DEFAULT_PORT;
    this._req = null;
    this._res = null;
    this._reconnectTimer = null;
    this._backoffMs = 1000;
    this._stopped = false;
    this._connected = false;
    this._buf = "";
  }
  setPort(p) {
    if (p && p !== this._port) {
      this._port = p;
      this._close();
      if (!this._stopped) this._scheduleReconnect(100);
    }
  }
  isConnected() {
    return this._connected;
  }
  start() {
    this._stopped = false;
    this._connect();
  }
  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._close();
    this.removeAllListeners();
  }
  _close() {
    this._connected = false;
    try {
      if (this._req) this._req.destroy();
    } catch {}
    this._req = null;
    this._res = null;
    this._buf = "";
  }
  _scheduleReconnect(ms) {
    if (this._stopped) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(
      () => {
        this._reconnectTimer = null;
        this._connect();
      },
      ms != null ? ms : this._backoffMs,
    );
    this._backoffMs = Math.min(30000, Math.max(1000, this._backoffMs * 2));
  }
  _connect() {
    if (this._stopped || this._req) return;
    try {
      this._req = http.get(
        `http://127.0.0.1:${this._port}/origin/stream?replay=1`,
        {
          headers: { accept: "text/event-stream", "cache-control": "no-cache" },
          agent: false,
          timeout: 5000,
        },
        (res) => {
          this._res = res;
          if (res.statusCode !== 200) {
            res.resume();
            this._close();
            this._scheduleReconnect();
            return;
          }
          this._connected = true;
          this._backoffMs = 1000;
          try {
            if (res.socket && res.socket.setTimeout) res.socket.setTimeout(0);
          } catch {}
          try {
            this.emit("connect", { port: this._port });
          } catch {}
          res.setEncoding("utf8");
          res.on("data", (chunk) => this._onData(chunk));
          res.on("end", () => {
            this._close();
            if (!this._stopped) this._scheduleReconnect();
          });
          res.on("error", () => {
            this._close();
            if (!this._stopped) this._scheduleReconnect();
          });
        },
      );
      this._req.on("error", () => {
        this._close();
        if (!this._stopped) this._scheduleReconnect();
      });
      this._req.on("timeout", () => {
        try {
          this._req && this._req.destroy();
        } catch {}
      });
    } catch {
      this._close();
      if (!this._stopped) this._scheduleReconnect();
    }
  }
  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf("\n\n")) >= 0) {
      const raw = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 2);
      this._dispatch(raw);
    }
  }
  _dispatch(raw) {
    let eventType = "message";
    const dataLines = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const dataStr = dataLines.join("\n");
    let data = dataStr;
    try {
      data = JSON.parse(dataStr);
    } catch {}
    try {
      this.emit(eventType, data);
      this.emit("event", { type: eventType, data });
    } catch {}
  }
}

// ═══════════════════════════ 数据采集 · proxy-only ═══════════════════════════
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function gatherEssence(port) {
  if (!port)
    return { ts: new Date().toISOString(), proxy: null, proxyUp: false };
  const base = `http://127.0.0.1:${port}`;
  const ping = await withTimeout(
    httpGetJson(`${base}/origin/ping`, 1500),
    2500,
  );
  if (!ping)
    return { ts: new Date().toISOString(), proxy: null, proxyUp: false };
  // 一请观全槽 · /origin/allinjects 含 _injectsByKind 全槽
  // v9.4.5 · 删 realprompt fetch · 该端点 source.js 不存 · 仅 404 浪费
  const [proxy, allInjects] = (await withTimeout(
    Promise.all([
      httpGetJson(`${base}/origin/preview`, 4000),
      httpGetJson(`${base}/origin/allinjects`, 4000),
    ]),
    6000,
  )) || [null, null];
  const realprompt = null;
  const diag = {
    proxy_up: true,
    proxy_capturing: !!(proxy && proxy.has_captured_before),
    has_main: proxy ? !!proxy.has_main : false,
    aux_count: proxy ? proxy.aux_count || 0 : 0,
    agent_class: proxy && proxy.agent_class ? proxy.agent_class : null,
    proxy_stale: proxy && proxy.age_s != null && proxy.age_s > 300,
    mode: ping.mode,
    uptime_s: ping.uptime_s,
    req_total: ping.req_total,
    capture_count: ping.capture_count,
  };
  return {
    ts: new Date().toISOString(),
    proxy,
    realprompt,
    allInjects,
    proxyUp: true,
    diag,
    ping,
  };
}

// ═══════════════════════════ 模式状态文本 ═══════════════════════════
function getModeLabel() {
  const mode = proxyGetMode();
  if (mode === "invert") return `道Agent · :${_cachedPort}`;
  return `官方Agent · 直连`;
}

// ═══════════════════════════════════════════════════════════════════
// v9.9.29 · 终端会话池 (印 160 · 反者道之动 · 弱者道之用)
// ═══════════════════════════════════════════════════════════════════
// 主公诏 5/19 3:11 (印 158→160 链):
//   「专注于最本源最核心的终端问题 如何从根本底层最小化解决终端一切问题」
//   「反者道之动 不依赖任何第三方 直接 dao-proxy-min 解决」
//   「推进到底 实现一切」
//
// 真本源诊 (七层污染 · 一招治):
//   ① OS cwd 是进程级单例 → 共享 shell 即共享 cwd
//   ② OS env 是进程级全局 → export 一染全染
//   ③ PTY 字节流无 frame → 多 writer 字节交织
//   ④ Shell $? %ERRORLEVEL% 是会话单例 → 上次毒化下次
//   ⑤ IDE 终端池默 reuse → cascade 复用一 terminal
//   ⑥ Agent 调用无状态 + 终端有状态 → 接口语义错配
//   ⑦ 多 agent 无同步 → 经典 race
//
// 真治 (一招):
//   每 agent 一独立 cmd.exe/bash 子进程 (cp.spawn /k mode)
//   stdin pipe 持续写命令 · stdout sentinel (RS+UUID) 包夹切片
//   Node 内置 child_process · 零第三方 · ~140 行类
//
// 道义:
//   四十「反者道之动 弱者道之用」(反"共享终端" · 用 child_process 弱柔)
//   六十四「治之于其未乱」(每命令独立 sentinel · 治未乱)
//   六十一「大邦下流 · 牝以靓胜牡」(每 sid 处下一 shell · 不争一终端)
//   廿八「朴散为器 · 圣人用则为官长」(spawn 之朴 · 散为多 shell 之器)
//   四十八「损之又损 至于无为」(零依赖 · 七层一招)
//
// 验: _test_v9929_term_pool.js · 15/15 PASS
// ═══════════════════════════════════════════════════════════════════

const _T_RS = "\u001E"; // ASCII Record Separator · 永不出现普通输出
const _T_DEFAULT_TIMEOUT = 120000;
const _T_IDLE_TTL_MS = 30 * 60 * 1000;
const _T_GC_INTERVAL_MS = 60_000;
const _T_MAX_BUF_BYTES = 4 * 1024 * 1024;

class DaoTerminalPool {
  constructor(opts = {}) {
    this.sessions = new Map();
    this.idleTtlMs = opts.idleTtlMs || _T_IDLE_TTL_MS;
    this.gcIntervalMs = opts.gcIntervalMs || _T_GC_INTERVAL_MS;
    this.maxBufBytes = opts.maxBufBytes || _T_MAX_BUF_BYTES;
    this._gcTimer = null;
    this._closed = false;
  }
  _spawnShell(sid) {
    const isWin = process.platform === "win32";
    let shell, args;
    if (isWin) {
      shell = process.env.ComSpec || "cmd.exe";
      args = ["/q", "/k", "@echo off & prompt $G"];
    } else {
      shell = process.env.SHELL || "/bin/bash";
      args = ["--norc", "--noprofile"];
    }
    const env = {
      ...process.env,
      DAO_AGENT_SID: sid,
      PROMPT: "$G ",
      PS1: "$ ",
      PS2: "",
      TERM: "dumb",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CLICOLOR: "0",
    };
    const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return _origSpawn.call(cp, shell, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  _ensure(sid) {
    let s = this.sessions.get(sid);
    if (s && !s.closed) return s;
    const child = this._spawnShell(sid);
    s = {
      child,
      buf: "",
      errBuf: "",
      pending: null,
      closed: false,
      lastUsed: Date.now(),
      sid,
    };
    child.stdout.on("data", (d) => {
      s.buf += d.toString("utf8");
      if (s.buf.length > this.maxBufBytes)
        s.buf = s.buf.slice(-this.maxBufBytes);
      s.lastUsed = Date.now();
      this._tryComplete(sid);
    });
    child.stderr.on("data", (d) => {
      s.errBuf += d.toString("utf8");
      if (s.errBuf.length > this.maxBufBytes)
        s.errBuf = s.errBuf.slice(-this.maxBufBytes);
    });
    child.on("exit", () => {
      s.closed = true;
      if (s.pending) {
        clearTimeout(s.pending.timer);
        s.pending.reject(new Error(`shell 退 sid=${sid}`));
        s.pending = null;
      }
    });
    child.on("error", (e) => {
      s.closed = true;
      if (s.pending) {
        clearTimeout(s.pending.timer);
        s.pending.reject(new Error(`shell 错 sid=${sid}: ${e.message}`));
        s.pending = null;
      }
    });
    this.sessions.set(sid, s);
    return s;
  }
  exec(sid, cmd, opts = {}) {
    if (this._closed) return Promise.reject(new Error("pool closed"));
    if (typeof sid !== "string" || !sid)
      return Promise.reject(new Error("session_id 必填"));
    if (typeof cmd !== "string" || !cmd)
      return Promise.reject(new Error("cmd 必填"));
    const s = this._ensure(sid);
    if (s.pending)
      return Promise.reject(
        new Error(`session ${sid} 忙 (同会话串行 · 不同会话并行)`),
      );
    const eid = crypto.randomUUID();
    const BEG = `${_T_RS}DAO_BEG_${eid}${_T_RS}`;
    const END = `${_T_RS}DAO_END_${eid}${_T_RS}`;
    const isWin = process.platform === "win32";
    const timeout = opts.timeout || _T_DEFAULT_TIMEOUT;
    let wrapped;
    if (isWin) {
      // ver >nul 重置 ERRORLEVEL=0 · 防内置命令 (echo/cd) 不更新 errorlevel 之坑
      const cdPart = opts.cwd ? `cd /d "${opts.cwd}" & ` : "";
      wrapped = `echo ${BEG}\r\nver >nul\r\n${cdPart}${cmd}\r\necho ${END}EXIT=%ERRORLEVEL%\r\n`;
    } else {
      const cdPart = opts.cwd ? `cd "${opts.cwd}" && ` : "";
      const begLit = BEG.replace(/'/g, "'\\''");
      const endLit = END.replace(/'/g, "'\\''");
      wrapped = `printf '%s\\n' '${begLit}'\n{ ${cdPart}${cmd} ; }\nprintf '%sEXIT=%d\\n' '${endLit}' "$?"\n`;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (s.pending && s.pending.eid === eid) {
          s.pending = null;
          reject(new Error(`exec timeout ${timeout}ms sid=${sid}`));
        }
      }, timeout);
      s.pending = {
        eid,
        BEG,
        END,
        resolve,
        reject,
        timer,
        started: Date.now(),
      };
      try {
        s.child.stdin.write(wrapped);
      } catch (e) {
        clearTimeout(timer);
        s.pending = null;
        reject(new Error(`stdin 写失 sid=${sid}: ${e.message}`));
      }
    });
  }
  _tryComplete(sid) {
    const s = this.sessions.get(sid);
    if (!s || !s.pending) return;
    const { BEG, END, resolve, timer, eid } = s.pending;
    const begIdx = s.buf.indexOf(BEG);
    if (begIdx === -1) return;
    const endIdx = s.buf.indexOf(END, begIdx + BEG.length);
    if (endIdx === -1) return;
    const tail = s.buf.slice(endIdx + END.length);
    const m = tail.match(/EXIT=(-?\d+)/);
    if (!m) return;
    const body = s.buf.slice(begIdx + BEG.length, endIdx);
    const exit = parseInt(m[1], 10);
    const afterExit = endIdx + END.length + m.index + m[0].length;
    const nl = s.buf.indexOf("\n", afterExit);
    s.buf = nl >= 0 ? s.buf.slice(nl + 1) : s.buf.slice(afterExit);
    s.pending = null;
    clearTimeout(timer);
    const stderr = s.errBuf;
    s.errBuf = "";
    resolve({
      session_id: sid,
      exec_id: eid,
      stdout: body.replace(/^\s+|\s+$/g, ""),
      stderr: stderr.replace(/^\s+|\s+$/g, ""),
      exit,
    });
  }
  list() {
    return [...this.sessions.entries()].map(([sid, s]) => ({
      sid,
      busy: !!s.pending,
      closed: s.closed,
      idle_ms: Date.now() - s.lastUsed,
      buf_bytes: s.buf.length,
    }));
  }
  close(sid) {
    const s = this.sessions.get(sid);
    if (!s) return false;
    try {
      s.child.stdin.end();
    } catch {}
    try {
      s.child.kill();
    } catch {}
    if (s.pending) {
      clearTimeout(s.pending.timer);
      s.pending.reject(new Error(`session closed sid=${sid}`));
      s.pending = null;
    }
    this.sessions.delete(sid);
    return true;
  }
  closeAll() {
    for (const sid of [...this.sessions.keys()]) this.close(sid);
    if (this._gcTimer) {
      clearInterval(this._gcTimer);
      this._gcTimer = null;
    }
    this._closed = true;
  }
  startGc() {
    if (this._gcTimer) return;
    this._gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, s] of this.sessions) {
        if (s.closed || now - s.lastUsed > this.idleTtlMs) this.close(sid);
      }
    }, this.gcIntervalMs);
    if (this._gcTimer.unref) this._gcTimer.unref();
  }
}

// 单例池 · ext-host 内全局
let _DAO_TERM_POOL = null;
function _ensureTermPool() {
  if (!_DAO_TERM_POOL) {
    _DAO_TERM_POOL = new DaoTerminalPool();
    _DAO_TERM_POOL.startGc();
    L.info("term", "DaoTerminalPool 启 · 七层污染一招治");
  }
  return _DAO_TERM_POOL;
}

// HTTP /exec 兜底服务 · :12780 (per-user FNV 偏置 · 多账号自然隔离)
let _DAO_TERM_HTTP = null;
let _DAO_TERM_HTTP_PORT = 0;
function _termHttpPort() {
  // 复用 fnv1a 思想 · base 12780
  const u = (os.userInfo().username || "default").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) {
    h ^= u.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 12780 + (Math.abs(h) % 50); // 12780..12829
}
function _startDaoTermService(ctx) {
  if (_DAO_TERM_HTTP) return;
  const port = _termHttpPort();
  _DAO_TERM_HTTP_PORT = port;
  const http = require("node:http");
  const pool = _ensureTermPool();
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    // 仅 localhost 来源 · 安全
    const remoteAddr = req.socket.remoteAddress || "";
    if (
      remoteAddr !== "127.0.0.1" &&
      remoteAddr !== "::1" &&
      remoteAddr !== "::ffff:127.0.0.1"
    ) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "localhost only" }));
      return;
    }
    try {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === "GET" && u.pathname === "/term/ping") {
        res.end(
          JSON.stringify({
            ok: true,
            version: PKG_VERSION,
            port,
            sessions: pool.list().length,
          }),
        );
        return;
      }
      if (req.method === "GET" && u.pathname === "/term/list") {
        res.end(JSON.stringify({ sessions: pool.list() }));
        return;
      }
      if (req.method === "POST" && u.pathname === "/term/exec") {
        const body = await _termReadBody(req);
        const { session_id, cmd, cwd, timeout } = body || {};
        if (!session_id || !cmd) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "session_id+cmd 必填" }));
          return;
        }
        const out = await pool.exec(session_id, cmd, { cwd, timeout });
        res.end(JSON.stringify(out));
        return;
      }
      if (req.method === "POST" && u.pathname === "/term/close") {
        const body = await _termReadBody(req);
        const ok = pool.close(body.session_id);
        res.end(JSON.stringify({ closed: ok }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    L.info("term", `HTTP /term/* 启 :${port} (localhost only)`);
  });
  server.on("error", (e) => {
    L.warn("term", `http server err: ${e.message}`);
  });
  _DAO_TERM_HTTP = server;
  if (ctx && ctx.subscriptions) {
    ctx.subscriptions.push({
      dispose: () => {
        try {
          server.close();
        } catch {}
        if (_DAO_TERM_POOL) _DAO_TERM_POOL.closeAll();
        _DAO_TERM_HTTP = null;
        _DAO_TERM_POOL = null;
      },
    });
  }
}
function _termReadBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// 命令实现 · 命令面板可调
async function cmdTermExec() {
  try {
    const sid = await vscode.window.showInputBox({
      prompt: "session_id (sid · 同 sid 串行 · 不同 sid 并行)",
      value: "agent_default",
    });
    if (!sid) return;
    const cmd = await vscode.window.showInputBox({
      prompt: `命令 · sid=${sid}`,
      placeHolder:
        process.platform === "win32" ? "echo hello & dir" : "echo hello && ls",
    });
    if (!cmd) return;
    const pool = _ensureTermPool();
    const r = await pool.exec(sid, cmd);
    const stdoutSnip =
      r.stdout.length > 800 ? r.stdout.slice(0, 800) + " ..." : r.stdout;
    vscode.window.showInformationMessage(
      `[${sid}] exit=${r.exit} · stdout=${stdoutSnip}`,
      { modal: false },
    );
    L.info(
      "term",
      `cmdTermExec sid=${sid} exit=${r.exit} stdout_len=${r.stdout.length}`,
    );
  } catch (e) {
    L.error("term", `cmdTermExec fail: ${e.message}`);
    vscode.window.showErrorMessage(`term.exec 失: ${e.message}`);
  }
}
async function cmdTermList() {
  const pool = _ensureTermPool();
  const lst = pool.list();
  const lines =
    lst.length === 0
      ? "(无会话)"
      : lst
          .map(
            (s) =>
              `${s.sid} · busy=${s.busy} · idle=${Math.round(s.idle_ms / 1000)}s · buf=${s.buf_bytes}B`,
          )
          .join("\n");
  vscode.window.showInformationMessage(
    `终端会话池 (${lst.length}) · :${_DAO_TERM_HTTP_PORT}\n${lines}`,
    { modal: true },
  );
}
async function cmdTermClose() {
  const pool = _ensureTermPool();
  const lst = pool.list();
  if (lst.length === 0) {
    vscode.window.showInformationMessage("终端会话池: 无会话");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    lst.map((s) => ({
      label: s.sid,
      description: `busy=${s.busy} idle=${Math.round(s.idle_ms / 1000)}s`,
    })),
    { placeHolder: "选会话关闭" },
  );
  if (!pick) return;
  const ok = pool.close(pick.label);
  vscode.window.showInformationMessage(
    `close ${pick.label} · ${ok ? "ok" : "fail"}`,
  );
}

// ★ v9.9.260 · 模型解锁命令 · 执大象 天下往
async function cmdModelUnlockToggle() {
  const port = _cachedPort;
  if (!port) {
    vscode.window.showErrorMessage(
      "道Agent Pro: 反代未运行 · 无法切换模型解锁",
    );
    return;
  }
  try {
    // GET current status
    const status = await httpGetJson(
      `http://127.0.0.1:${port}/origin/model_unlock`,
      2000,
    );
    const current = status && status.enabled !== false;
    const next = !current;
    // POST toggle
    const result = await httpPostJson(
      `http://127.0.0.1:${port}/origin/model_unlock`,
      { enabled: next },
      2000,
    );
    if (result && result.ok) {
      vscode.window.showInformationMessage(
        `模型解锁: ${next ? "✅ 启用" : "❌ 禁用"} (${result.catalog_size || 0} 模型) · 执大象 天下往`,
      );
    } else {
      vscode.window.showErrorMessage(
        `模型解锁切换失败: ${(result && result.error) || "unknown"}`,
      );
    }
  } catch (e) {
    vscode.window.showErrorMessage(`模型解锁切换失败: ${e.message}`);
  }
}

async function cmdModelUnlockStatus() {
  const port = _cachedPort;
  if (!port) {
    vscode.window.showErrorMessage(
      "道Agent Pro: 反代未运行 · 无法查看模型状态",
    );
    return;
  }
  try {
    const catalog = await httpGetJson(
      `http://127.0.0.1:${port}/origin/model_catalog`,
      3000,
    );
    if (!catalog || !catalog.ok) {
      vscode.window.showErrorMessage(
        `模型目录加载失败: ${(catalog && catalog.error) || "unknown"}`,
      );
      return;
    }
    const models = catalog.models || [];
    const providers = {};
    for (const m of models) {
      const p = m.provider || "unknown";
      if (!providers[p]) providers[p] = [];
      providers[p].push(m);
    }
    // Show quick pick with model list
    const items = [];
    for (const [prov, mods] of Object.entries(providers).sort()) {
      items.push({
        label: `── ${prov} (${mods.length}) ──`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const m of mods) {
        const badges = [];
        if (m.isRecommended) badges.push("★");
        if (m.isNew) badges.push("🆕");
        items.push({
          label: `${badges.join("")} ${m.label}`,
          description: `${m.creditMultiplier || "?"}x`,
          detail: m.modelUid,
        });
      }
    }
    await vscode.window.showQuickPick(items, {
      placeHolder: `全量模型目录: ${models.length} 个模型 · 执大象 天下往`,
      canPickMany: false,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`模型状态查询失败: ${e.message}`);
  }
}

// ═══════════════════════════ EssenceProvider · 本源观照 webview ═══════════════════════════
class EssenceProvider {
  constructor(ctx) {
    this._ctx = ctx;
    this._view = null;
    this._timer = null;
    this._sigTimer = null;
    this._busy = false;
    this._lastSig = "";
    this._sse = null;
    this._sseLastSpSig = "";
    this._setupSse();
  }

  _setupSse() {
    try {
      this._sse = new DaoSseClient(_cachedPort);
      this._sse.on("sp", (ev) => {
        if (!this._view) return;
        const sig = ev && ev.sig;
        if (sig && sig === this._sseLastSpSig) return;
        this._sseLastSpSig = sig || "";
        this.forceRefresh().catch(() => {});
      });
      this._sse.on("mode", (ev) => {
        if (!this._view) return;
        _cachedMode = (ev && ev.mode) || _cachedMode;
        try {
          this._view.webview.postMessage({ type: "mode", mode: ev && ev.mode });
        } catch {}
      });
      this._sse.on("connect", () => {
        if (this._view) this.forceRefresh().catch(() => {});
      });
      this._sse.start();
    } catch {
      this._sse = null;
    }
  }

  resolveWebviewView(webviewView) {
    L.info("webview", `resolveWebviewView called · port=${_cachedPort}`);
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // v9.4.5 · localResourceRoots 必需 · 让 webview.asWebviewUri 能加载 media/*
      localResourceRoots: [
        vscode.Uri.joinPath(this._ctx.extensionUri, "media"),
      ],
      // portMapping: webview 内部 127.0.0.1:_cachedPort 直通 extensionHost 端
      portMapping: [
        { webviewPort: _cachedPort, extensionHostPort: _cachedPort },
      ],
    };
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      try {
        // v9.4.2 · 接 webview stage 回传 log (探真相)
        if (msg.command === "stage") {
          L.info("webview.stage", String(msg.stage || "?").slice(0, 120));
          return;
        }
        if (msg.command === "refresh") await this.refresh();
        else if (msg.command === "setMode") await this._handleSetMode(msg.mode);
        else if (msg.command === "getCustomSP") await this._handleGetCustomSP();
        else if (msg.command === "setCustomSP")
          await this._handleSetCustomSP(msg);
        else if (msg.command === "resetCustomSP")
          await this._handleResetCustomSP();
        else if (msg.command === "setCanon")
          await this._handleSetCanon(msg.canon);
      } catch {}
    });
    // v9.4.2 · SSR 道魂直嵌 · webview 一加载就见帛书全文 · 零 fetch/postMessage 依赖
    // 三十二章: 道恒无名 · 侯王若能守之 · 万物将自宾
    const ssrSp = _loadSilkForWebview();
    L.info(
      "webview",
      `SSR load · silk_chars=${ssrSp.length} port=${_cachedPort}`,
    );
    const _html = getEssenceHtml(
      _cachedPort,
      null,
      ssrSp,
      webviewView.webview,
      this._ctx.extensionUri,
    );
    webviewView.webview.html = _html;
    // v9.4.5 · 强制 show webview · 否则 collapsed 时 JS 不跑
    try {
      webviewView.show(true);
      L.info("webview", `forced show(true) · visible=${webviewView.visible}`);
    } catch (e) {
      L.warn("webview", `show fail: ${e.message}`);
    }
    // v9.4.5 · dump 实际 html 到磁盘 · 离线诊
    // v9.9.20 jiqi 改 · 每次 resolveWebviewView 即覆写 · 反映当前版本之实 · 不再缓存旧版误诊
    try {
      const dumpFp = path.join(os.homedir(), ".dao-webview-dump.html");
      fs.writeFileSync(dumpFp, _html, "utf8");
      L.info(
        "webview",
        `dumped html → ${dumpFp} (overwrite · v${PKG_VERSION})`,
      );
    } catch (e) {
      L.warn("webview", `dump fail: ${e.message}`);
    }
    try {
      const _portMatch = _html.match(/var _PORT = ([^;]+);/);
      const _baseMatch = _html.match(/var _BASE = ([^;]+);/);
      // v9.9.20 jiqi 修 · 标记现已真实存在 · hasIife/hasWdbg=false 即源码裂 · 立即可观
      const _hasIife = _html.indexOf("_wdbg('iife-start'") >= 0;
      const _hasPull = _html.indexOf("function pull(") >= 0;
      const _hasWdbg = _html.indexOf("function _wdbg(") >= 0;
      L.info(
        "webview",
        `html set \u00b7 len=${_html.length} _PORT=${_portMatch ? _portMatch[1] : "?"} _BASE=${_baseMatch ? _baseMatch[1] : "?"} hasIife=${_hasIife} hasPull=${_hasPull} hasWdbg=${_hasWdbg}`,
      );
    } catch (e) {
      L.warn("webview", `html dbg fail: ${e.message}`);
    }
    // v9.4.5 · 5s 自检 webview 是否真活 (_wdbg ringbuf 是否含 iife-start)
    setTimeout(async () => {
      try {
        const beforeCount = (
          await httpGetJson(
            `http://127.0.0.1:${_cachedPort}/origin/_wdbg`,
            1500,
          )
        ).count;
        // 触一次 postMessage 看 webview 是否反应
        if (this._view) {
          this._view.webview.postMessage({
            command: "_diag-ping",
            ts: Date.now(),
          });
        }
        await new Promise((r) => setTimeout(r, 1500));
        const after = await httpGetJson(
          `http://127.0.0.1:${_cachedPort}/origin/_wdbg`,
          1500,
        );
        const liveStart = after.log.find((x) => x.msg === "iife-start");
        const msgRecv = after.log.find(
          (x) => x.msg === "msg-recv" && x.tag === "_diag-ping",
        );
        L.info(
          "webview",
          `5s diag \u00b7 wdbg_count=${after.count} iife_start=${!!liveStart} diag_recv=${!!msgRecv} (before=${beforeCount})`,
        );
        if (!liveStart) {
          L.warn(
            "webview",
            `webview JS NOT alive \u00b7 iife-start \u672a\u5230 \u00b7 \u53ef\u80fd\u88ab CSP/parse \u62e6`,
          );
        }
      } catch (e) {
        L.warn("webview", `5s diag fail: ${e.message}`);
      }
    }, 5000);
    webviewView.onDidChangeVisibility(() => {
      L.info("webview", `visibility → ${webviewView.visible}`);
      if (webviewView.visible) {
        this.refresh().catch((e) =>
          L.warn("refresh", `vis fail: ${e.message}`),
        );
        this._armTimer();
      } else this._stopTimer();
    });
    webviewView.onDidDispose(() => {
      L.info("webview", "disposed");
      this._view = null;
      this._stopTimer();
    });
    this._armTimer();
    // 主动首推 · 不依赖 webview 'refresh' 消息 (CSP/race-safe · 反者道之动)
    // v9.9.36 · 延迟首推 · 减轻启动期 HTTP 请求压力
    setTimeout(() => this.refresh().catch(() => {}), 3000);
    setTimeout(() => this.refresh().catch(() => {}), 8000);
    setTimeout(() => this.refresh().catch(() => {}), 15000);
  }

  _armTimer() {
    this._stopTimer();
    if (!this._view || !this._view.visible) return;
    // v7.3→v9.9.36: 后备 timer 30s (原 12s), sig poll 5s (原 1.5s)
    // 減轻 ext-host 事件循环压力 · UNRESPONSIVE 根因之一
    this._timer = setInterval(() => this.refresh().catch(() => {}), 30000);
    this._sigTimer = setInterval(() => this._sigTick().catch(() => {}), 5000);
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._sigTimer) {
      clearInterval(this._sigTimer);
      this._sigTimer = null;
    }
  }

  async _sigTick() {
    if (!this._view || !this._view.visible || this._busy) return;
    if (this._sse && this._sse.isConnected()) {
      this._sigSkipCounter = (this._sigSkipCounter || 0) + 1;
      if (this._sigSkipCounter % 10 !== 0) return;
    }
    try {
      const sig = await httpGetJson(
        `http://127.0.0.1:${_cachedPort}/origin/sig`,
        800,
      );
      if (!sig || !sig.ok) return;
      // sig 接 _customSP / _injectsByKind / _spCandidates 变动 · 一签观全境
      const cur = `${sig.mode}|${sig.sp_sig}|${sig.custom_sig || "0"}|${sig.custom_sp_at || 0}|${sig.injects_last_at || 0}|${sig.spc_last_at || 0}|${sig.injects_count || 0}`;
      if (cur === this._lastSig) return;
      this._lastSig = cur;
      this.refresh().catch(() => {});
    } catch {}
  }

  async refresh() {
    if (!this._view) {
      L.info("refresh", "skip · _view null");
      return;
    }
    if (this._busy) {
      L.info("refresh", "skip · busy");
      return;
    }
    this._busy = true;
    try {
      const data = await gatherEssence(_cachedPort);
      if (!this._view) {
        L.info("refresh", "skip · _view became null after gather");
        return;
      }
      data.modeLabel = getModeLabel();
      data._port = _cachedPort;
      const afterChars =
        (data.proxy &&
          (data.proxy.after_chars || (data.proxy.after || "").length)) ||
        0;
      // v9.9.19 · 损之又损 · 精简postMessage · 去大对象 · webview IPC过载根治
      // proxy=872KB(含injects_by_kind) + allInjects=822KB → 致1.7MB IPC→webview冻结
      // 修: 仅传 ping(~1KB) + proxy.after(~20KB) · 减至~22KB
      const slimProxy = data.proxy
        ? {
            ok: data.proxy.ok,
            after: data.proxy.after,
            after_chars: afterChars,
            age_s: data.proxy.age_s,
            has_captured_before: data.proxy.has_captured_before,
            before_chars: data.proxy.before_chars,
          }
        : null;
      const slimData = {
        ts: data.ts,
        ping: data.ping,
        proxyUp: data.proxyUp,
        proxy: slimProxy,
        modeLabel: data.modeLabel,
        _port: data._port,
      };
      try {
        const ok = await this._view.webview.postMessage({
          type: "data",
          data: slimData,
        });
        L.info(
          "refresh",
          `postMessage ok=${ok} · proxy=${!!slimProxy} · after=${afterChars} · visible=${this._view.visible}`,
        );
        if (!ok)
          L.warn("refresh", "postMessage returned false (webview not ready?)");
      } catch (e) {
        L.warn("refresh", `postMessage error: ${e.message}`);
      }
    } catch (e) {
      L.warn("refresh", `gather/send error: ${e.message}`);
    } finally {
      this._busy = false;
    }
  }

  async forceRefresh() {
    this._busy = false;
    await this.refresh();
  }

  async _handleSetMode(mode) {
    if (mode === "dao" || mode === "invert") await cmdInvert();
    else await cmdPassthrough();
    this._lastSig = "";
    setTimeout(() => this.forceRefresh().catch(() => {}), 300);
  }

  async _handleGetCustomSP() {
    if (!this._view) return;
    try {
      const r = await httpGetJson(
        `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
        2000,
      );
      // v9.7.6 · 十四章「执今之道·以御今之有」· 透传 default_sp 供 webview 兜底填 textarea
      await this._view.webview.postMessage({
        type: "customSP",
        action: "get",
        has_custom: r && r.has_custom,
        sp: r && r.sp,
        chars: r && r.chars,
        keep_blocks: r && r.keep_blocks,
        default_sp: r && r.default_sp,
        default_chars: r && r.default_chars,
        default_source: r && r.default_source,
      });
    } catch {
      try {
        await this._view.webview.postMessage({
          type: "customSP",
          action: "get",
          has_custom: false,
        });
      } catch {}
    }
  }

  async _handleSetCustomSP(msg) {
    if (!this._view) return;
    try {
      // v7.8 一态整替 · keep_blocks 永 false (服务端 invertSP 永整替)
      const r = await httpPostJson(
        `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
        { sp: msg.sp, keep_blocks: false, source: "webview" },
        3000,
      );
      await this._view.webview.postMessage({
        type: "customSP",
        action: "set",
        ok: r && r.ok,
        chars: r && r.chars,
        error: r && r.error,
      });
      if (r && r.ok) {
        this._lastSig = "";
        setTimeout(() => this.forceRefresh().catch(() => {}), 300);
      }
    } catch (e) {
      try {
        await this._view.webview.postMessage({
          type: "customSP",
          action: "set",
          ok: false,
          error: e.message,
        });
      } catch {}
    }
  }

  async _handleResetCustomSP() {
    if (!this._view) return;
    try {
      const r = await httpDelete(
        `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
        2000,
      );
      await this._view.webview.postMessage({
        type: "customSP",
        action: "reset",
        ok: r && r.ok,
      });
      if (r && r.ok) {
        this._lastSig = "";
        setTimeout(() => this.forceRefresh().catch(() => {}), 300);
      }
    } catch {
      try {
        await this._view.webview.postMessage({
          type: "customSP",
          action: "reset",
          ok: false,
        });
      } catch {}
    }
  }

  // 经藏切换 · 道生一 · webview 下拉 -> proxy /origin/canon -> 热切
  async _handleSetCanon(canon) {
    if (!this._view) return;
    try {
      const r = await httpPostJson(
        `http://127.0.0.1:${_cachedPort}/origin/canon`,
        { canon: String(canon || "laozi") },
        2000,
      );
      log(`canon -> ${canon} (ok=${r && r.ok}, chars=${r && r.chars})`);
      this._lastSig = "";
      // v9.9.22 · 切经文即推新 default_sp · 不依赖 tape entry (tape 仍是切前)
      // 道义: 二十五章「逝曰远 远曰反」· 名实变即推 · 不滞旧
      try {
        const cs = await httpGetJson(
          `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
          2000,
        );
        if (cs && cs.ok && this._view) {
          await this._view.webview.postMessage({
            type: "canonChanged",
            canon: r && r.canon,
            canon_name: r && r.canon_name,
            chars: r && r.chars,
            default_sp: cs.default_sp,
            default_chars: cs.default_chars,
            default_source_name: cs.default_source_name,
            has_custom: cs.has_custom,
          });
          log(
            `canon push canonChanged · canon=${r && r.canon} · default_chars=${cs.default_chars} · has_custom=${cs.has_custom}`,
          );
        }
      } catch (e) {
        log(`canon push default_sp fail: ${e && e.message}`);
      }
      setTimeout(() => this.forceRefresh().catch(() => {}), 300);
    } catch (e) {
      log(`canon set fail: ${e && e.message}`);
    }
  }

  dispose() {
    this._stopTimer();
    try {
      if (this._sse) this._sse.stop();
    } catch {}
    this._sse = null;
    this._view = null;
  }
}

// ═══════════════════════════ 命令: 道Agent ═══════════════════════════
async function cmdInvert() {
  try {
    const { port } = cfg();
    const wasAnchored = _cachedAnchored;
    await proxyStart(port, "invert");
    proxySetMode("invert");
    await setAnchor(port);
    installSpawnHook();
    // 首次锚定才需重启 LS · 已锚定则纯翻转模式即可
    if (!wasAnchored) {
      L.info("cmd-invert", `first anchor → killing LS`);
      const killed = await forceRestartLS();
      if (killed) {
        vscode.window.showInformationMessage(
          `道Agent · 已启 :${port} · LS 重启中`,
        );
      } else {
        const c = await vscode.window.showInformationMessage(
          `道Agent · 已启 · 未找到 LS`,
          "重载窗口",
          "稍后",
        );
        if (c === "重载窗口")
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else {
      L.info("cmd-invert", `mode flipped → invert (zero-cost)`);
      vscode.window.showInformationMessage(
        `道Agent · 帛书德道经 SP 注入 · 下次对话生效`,
      );
    }
  } catch (e) {
    vscode.window.showErrorMessage(`道Agent 启失: ${e && e.message}`);
    L.error("cmd-invert", e && e.message);
  }
}

// ═══════════════════════════ 命令: 官方Agent ═══════════════════════════
// 官方模式 = proxy 仍运行但透传 · 不改 SP · 可观照 · 零代价热切
async function cmdPassthrough() {
  try {
    const { port } = cfg();
    // 确保 proxy 运行 (观照需要)
    await proxyStart(port, "passthrough");
    proxySetMode("passthrough");
    L.info(
      "cmd-pass",
      `mode flipped → passthrough (proxy stays for observation)`,
    );
    vscode.window.showInformationMessage(
      `官方Agent · 透传观照 · SP 不改 · 下次对话生效`,
    );
  } catch (e) {
    vscode.window.showErrorMessage(`官方Agent 切换失败: ${e && e.message}`);
    L.error("cmd-pass", e && e.message);
  }
}

// ═══════════════════════════ 命令: 切换 ═══════════════════════════
async function cmdToggle() {
  const cur = proxyGetMode();
  if (cur === "invert") await cmdPassthrough();
  else await cmdInvert();
}

// ═══════════════════════════ 命令: 浏览器观 ═══════════════════════════
async function cmdOpenPreview() {
  const url = `http://127.0.0.1:${_cachedPort}/origin/preview`;
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch {}
}

// ═══════════════════════════ 命令: E2E 自检 ═══════════════════════════
async function cmdVerifyE2E() {
  await cmdSelftest();
}

// ═══════════════════════════ 命令: 自检 ═══════════════════════════
async function cmdSelftest() {
  const out = logger();
  out.show(true);
  out.appendLine("");
  out.appendLine("════════════════════════════════════════");
  out.appendLine(
    `  道Agent v${PKG_VERSION} · 自检 · ${new Date().toISOString()}`,
  );
  out.appendLine("════════════════════════════════════════");

  const { port } = cfg();

  // L1: 损 selftest endpoint (v9.7.0 为道日损) · 走 ping 之 features 诊
  out.appendLine("\n── L1 · 帛书+大常 (从 /origin/ping 取 features) ──");
  try {
    const r = await httpGetJson(`http://127.0.0.1:${port}/origin/ping`, 3000);
    if (r && r.features) {
      out.appendLine(
        `  ✓ 帛书《老子》: dao=${r.dao_chars}字 · header=${r.features.tao_header_chars}字 · 注入总=${r.features.inject_total_chars}字`,
      );
      out.appendLine(`  ✓ ${r.features.principle}`);
      for (const [k, v] of Object.entries(r.features.rpc_classes || {})) {
        out.appendLine(`    ${k}: ${v}`);
      }
    } else {
      out.appendLine("  ⚠ /origin/ping 无 features (代理未启?)");
    }
  } catch (e) {
    out.appendLine(`  ✗ L1 异: ${e.message}`);
  }

  // L2: proxy 路径
  out.appendLine("\n── L2 · 反代路径 ──");
  out.appendLine(
    `  port: ${port} (per-user) · anchored: ${isAnchored()} · mode: ${proxyGetMode()}`,
  );
  try {
    const ping = await httpGetJson(
      `http://127.0.0.1:${port}/origin/ping`,
      2000,
    );
    if (ping) {
      out.appendLine(
        `  ✓ proxy up: v=${ping.version} mode=${ping.mode} uptime=${ping.uptime_s}s req=${ping.req_total} cap=${ping.capture_count}`,
      );
    } else {
      out.appendLine("  ✗ proxy unreachable");
    }
  } catch (e) {
    out.appendLine(`  ✗ ping: ${e.message}`);
  }

  try {
    const last = await httpGetJson(
      `http://127.0.0.1:${port}/origin/lastinject`,
      2000,
    );
    if (last && last.has_inject) {
      out.appendLine(
        `  最近注入: ${last.at ? new Date(last.at).toISOString() : "?"} ${last.rpc || last.url || ""}`,
      );
      out.appendLine(
        `    before(${last.before_chars || 0}字): ${(last.before_head || "").slice(0, 80)}…`,
      );
      out.appendLine(
        `    after(${last.after_chars || 0}字): ${(last.after_head || "").slice(0, 80)}…`,
      );
    }
  } catch {}

  try {
    const paths = await httpGetJson(
      `http://127.0.0.1:${port}/origin/paths?n=10`,
      2000,
    );
    if (paths && paths.top && paths.top.length) {
      out.appendLine(`\n  路径直方图 (${paths.total_paths} paths):`);
      for (const p of paths.top) {
        const tags = [];
        if (p.is_chat) tags.push("CHAT");
        if (p.replaced > 0) tags.push(`✓${p.replaced}`);
        out.appendLine(
          `    ${String(p.count).padStart(5)} ${p.path} [${tags.join(",")}]`,
        );
      }
    }
  } catch {}

  out.appendLine("\n── L3 · 活检指引 ──");
  out.appendLine(`  1. 运行 "道Agent: 启" → LS 重启 → 向 Cascade 问 '你是谁'`);
  out.appendLine(`  2. 期答含 '道'/'无为'/'自然' (帛书德道经 SP 注入成功)`);
  out.appendLine("════════════════════════════════════════\n");
}

// ═══════════════════════════ HTML · 本源观照 ═══════════════════════════
function _genNonce() {
  // 32-char hex nonce · CSP-strict · 道法自然
  const a = new Uint8Array(16);
  for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
// HTML 转义 · SSR 嵌入 <pre> textContent 需之
function _escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// v9.9.20 两经归一 · 加载帛书+道藏阴符 (webview SSR 用) · 与 source.js 同源 · 复归无名
// 道魂 = TAO_HEADER + 帛书·德经 + "\n\n" + 帛书·道经 + "\n\n" + 道藏《阴符经》 + TAO_FOOTER(空)
// 主公命: 「最终提示词仅需要帛书老子和最早期本源阴符经便可」 · 默 canon=laozi+yinfu
function _loadSilkForWebview() {
  try {
    const vendorDir = path.join(__dirname, "vendor", "bundled-origin");
    const deFp = path.join(vendorDir, "_silk_de.txt");
    const daoFp = path.join(vendorDir, "_silk_dao.txt");
    const yinfuFp = path.join(vendorDir, "_yinfu.txt");
    if (!fs.existsSync(deFp) || !fs.existsSync(daoFp)) return "";
    const deText = fs.readFileSync(deFp, "utf8").trim();
    const daoText = fs.readFileSync(daoFp, "utf8").trim();
    const yinfuText = fs.existsSync(yinfuFp)
      ? fs.readFileSync(yinfuFp, "utf8").trim()
      : "";
    if (!deText || !daoText) return "";
    // v9.9.38 · 帧宽修正 · 四十二章「道生一·一生二·二生三·三生万物」
    // 「所有文本」覆道经+keeps · 「本源」为根基非独占规则 · 「所遵从」保约束力
    const TAO_HEADER =
      "你本无名 名可名也 非恒名也 下述所有文本为你所遵从之本源：\n\n";
    const SILK_BOUNDARY = "\n\n";
    const TAO_FOOTER = "";
    const body = yinfuText
      ? deText + SILK_BOUNDARY + daoText + SILK_BOUNDARY + yinfuText
      : deText + SILK_BOUNDARY + daoText;
    return TAO_HEADER + body + TAO_FOOTER;
  } catch {
    return "";
  }
}

function getEssenceHtml(port, nonce, initialSP, webview, extensionUri) {
  // v9.8.0 · 守一不离 · 三十九章「得一」· 复 @ 工具之根 · 名实终一
  // 痛: SIDE_CHANNEL_TAGS 含 'additional_metadata' · 致用户消息中 @ 项之元 (Cascade ID/file path/line range) 被剥
  //     agent 失 @ 项之元 · trajectory_search/read_file 等 @ 工具调用败 · 此为 v9.7.x 之底病
  // 治: source.js · SIDE_CHANNEL_TAGS 删 'additional_metadata' · 守 @ 项与元之一体 ·「得一」之实
  // 兼: tape all_fields raw_text 字段亦显 AFTER (post strip + neutralize) · 主公照观面板见 LLM 实收 · 名实终一
  // v9.7.9 · 道法自然 · 反者道之动 · 中性化隐藏 SECTION_OVERRIDE 身份锚
  // 二十五章「道法自然」· 替 Windsurf 客户端隐藏 JSON {"mode":"SECTION_OVERRIDE_MODE_APPEND","content":"...respond with `Cascade`"} 之 content 为「道法自然」
  // 治根: neutralizeHiddenOverrides 集成至 deepStripProtoSideChannels · 复合两治 (剥 SIDE_CHANNEL XML + 中性化 SECTION_OVERRIDE JSON)
  // v9.7.8 三十辐共一毂 (十一章) · invertSP/invertAnySP 默路接 extractKeepBlocks · 复 7 辐 (tool_calling/mcp_servers/user_information/workspace_information)
  // v9.7.7 复归于朴 (二十八章) · TAO_HEADER 损至 31 字 · 帛书裸呈
  // v9.7.6 四治承之 (default_sp 永返 · 透传 · 兜底填 textarea · boot 预拉)
  // 病四治: A · [归道] reset 后强拉 default_sp 帛书 (不沿 lastSP · lastSP 已被 chat 覆盖)
  //         B · 注入文 (TAO_HEADER 31字 + 帛书合 ~7204 + TAO_FOOTER 0 = ~7237 字 道魂) + (TAO_TRAILER + 7 辐 keeps) 中性化追加
  //         C · @ 工具复用 · 至简非至废
  //         D · 隐藏 SECTION_OVERRIDE_MODE_APPEND 身份锚中性化 · 模型不再被强令"respond with Cascade"
  const N = nonce || _genNonce();
  const proxyPort = port || 0;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${N}'; connect-src http://127.0.0.1:* http://localhost:*; img-src data:;">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
    margin: 0; padding: 6px 8px; font-size: 12px; line-height: 1.55;
    display: flex; flex-direction: column;
  }
  .bar { display: flex; gap: 3px; align-items: center; margin-bottom: 3px; flex: 0 0 auto; font-size: 10px; flex-wrap: wrap; }
  .ib {
    padding: 2px 5px; font-size: 12px; border: 1px solid transparent;
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; border-radius: 2px; font-family: inherit;
    opacity: 0.55; min-width: 20px; line-height: 1;
  }
  .ib:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ib.edit-active { opacity: 1; color: #e8a040; border-color: #e8a040; background: rgba(232,160,64,0.1); }
  .ib.detail-on { opacity: 1; color: #888; border-color: #888; background: rgba(128,128,128,0.08); }
  .mb {
    padding: 1px 7px; font-size: 11px; border: 1px solid rgba(128,128,128,0.3);
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; border-radius: 3px; font-family: inherit;
    opacity: 0.55; line-height: 1.3; transition: all 0.15s; font-weight: 500;
  }
  .mb:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .mb.active { opacity: 1; border-color: var(--vscode-textLink-foreground, #4fc1ff); color: var(--vscode-textLink-foreground, #4fc1ff); background: rgba(79,193,255,0.1); font-weight: 700; }
  .mb.active-dao { border-color: #6bb86b; color: #6bb86b; background: rgba(107,184,107,0.1); }
  .dots { display: inline-flex; gap: 2px; align-items: center; padding: 0 4px; cursor: help; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: rgba(128,128,128,0.3); }
  .dot.ok { background: #6bb86b; } .dot.warn { background: #d9a200; } .dot.err { background: #e08080; }
  /* 守朴 · stat 默认藏 · 详态始显 · 无 kind 彩色分类 pill (道可道·非恒道) */
  .stat { font-size: 10px; opacity: 0.55; margin: 0 0 4px; line-height: 1.4; font-family: monospace; display: none; }
  .stat.show { display: block; }
  .stat .pill { padding: 1px 5px; border-radius: 2px; background: rgba(128,128,128,0.12); margin-right: 4px; }
  #sp {
    flex: 1 1 auto; overflow: auto; margin: 0; padding: 10px 12px;
    font-family: "Noto Serif CJK SC", "Microsoft YaHei", var(--vscode-editor-font-family), serif;
    font-size: 11.5px; line-height: 1.75; white-space: pre-wrap; word-break: break-word;
    background: rgba(0,0,0,0.08); border-radius: 3px;
  }
  #sp.quiet { text-align: center; opacity: 0.5; font-style: italic; padding: 40px 0; letter-spacing: 1px; }
  #editArea { display: none; flex: 1 1 auto; flex-direction: column; }
  #editArea.show { display: flex; }
  #editArea textarea {
    flex: 1 1 auto; resize: none; border: 1px solid rgba(128,128,128,0.3); border-radius: 3px; padding: 8px 10px;
    font-family: "Noto Serif CJK SC", "Microsoft YaHei", var(--vscode-editor-font-family), serif;
    font-size: 11.5px; line-height: 1.75;
    background: var(--vscode-input-background, rgba(0,0,0,0.12)); color: var(--vscode-input-foreground, var(--vscode-foreground));
    outline: none; min-height: 120px;
  }
  #editArea textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .edit-bar { display: flex; gap: 4px; align-items: center; margin-top: 4px; flex: 0 0 auto; font-size: 10px; }
  .edit-bar .eb {
    padding: 2px 8px; font-size: 10px; border: 1px solid rgba(128,128,128,0.3);
    background: transparent; color: var(--vscode-foreground); cursor: pointer; border-radius: 3px;
    font-family: inherit; line-height: 1.4; transition: all 0.15s;
  }
  .edit-bar .eb:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .edit-bar .eb.save { border-color: #6bb86b; color: #6bb86b; }
  .edit-bar .eb.save:hover { background: rgba(107,184,107,0.15); }
  .edit-bar .eb.reset { border-color: #e08080; color: #e08080; }
  .edit-bar .eb.reset:hover { background: rgba(224,128,128,0.15); }
  .edit-bar .edit-status { opacity: 0.7; margin-left: auto; font-size: 9px; }
  .edit-bar .edit-count { opacity: 0.55; font-size: 9px; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .edit-bar .eb.reload { border-color: #80b0e0; color: #80b0e0; }
  .edit-bar .eb.reload:hover { background: rgba(128,176,224,0.15); }
  .edit-hint { font-size: 9px; opacity: 0.55; margin-bottom: 3px; padding: 2px 4px; font-style: italic; flex: 0 0 auto; }
  .custom-badge { display: inline-block; font-size: 8px; padding: 0 4px; border-radius: 2px; background: rgba(232,160,64,0.2); color: #e8a040; border: 1px solid rgba(232,160,64,0.3); margin-left: 4px; }
  #canonSelect { font-size: 10px; padding: 1px 2px; border: 1px solid rgba(128,128,128,0.3); background: var(--vscode-dropdown-background, rgba(0,0,0,0.2)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border-radius: 3px; cursor: pointer; outline: none; font-family: inherit; max-width: 96px; margin-left: 4px; }
  #canonSelect:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  #canonSelect option { background: var(--vscode-dropdown-listBackground, #252526); color: var(--vscode-dropdown-foreground, #ccc); }
  /* ★ v9.9.94 · 外接API面板 · 五十七章「我无为也 而民自化」· 正本清源重写 */
  .ea-bar { display: flex; gap: 4px; align-items: center; margin: 2px 0; flex: 0 0 auto; font-size: 10px; flex-wrap: wrap; }
  .ea-toggle { padding: 1px 6px; font-size: 10px; border: 1px solid rgba(128,128,128,0.3); background: transparent; color: var(--vscode-foreground); cursor: pointer; border-radius: 2px; font-family: inherit; opacity: 0.55; line-height: 1.3; }
  .ea-toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ea-toggle.active { opacity: 1; border-color: #6bb86b; color: #6bb86b; background: rgba(107,184,107,0.1); }
  .ea-badge { font-size: 9px; padding: 0 4px; border-radius: 2px; background: rgba(107,184,107,0.15); color: #6bb86b; border: 1px solid rgba(107,184,107,0.25); }
  .ea-badge.off { background: rgba(128,128,128,0.1); color: #888; border-color: rgba(128,128,128,0.2); }
  .ea-panel { display: none; flex-direction: column; gap: 4px; margin: 2px 0; padding: 5px 7px; border: 1px solid rgba(128,128,128,0.2); border-radius: 3px; background: rgba(0,0,0,0.06); max-height: 360px; overflow-y: auto; font-size: 10px; }
  .ea-panel.show { display: flex; }
  .ea-wire-wrap { display: flex; gap: 0; align-items: stretch; position: relative; min-height: 120px; }
  .ea-col { flex: 1; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
  .ea-left { padding-right: 4px; }
  .ea-right { padding-left: 4px; }
  .ea-col-head { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
  .ea-col-title { font-size: 9px; opacity: 0.6; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .ea-col-sub { font-size: 8px; opacity: 0.35; }
  .ea-col-list { flex: 1; overflow-y: auto; max-height: 200px; }
  .ea-wires { flex: 0 0 28px; min-width: 28px; overflow: visible; pointer-events: none; }
  .ea-wire { fill: none; stroke: #6bb86b; stroke-width: 1.5; stroke-dasharray: 4 2; opacity: 0.7; }
  .ea-wire.err { stroke: #e08080; }
  .ea-wire.pending { stroke: #4fc1ff; stroke-dasharray: 2 2; animation: ea-wire-blink 0.8s infinite; }
  @keyframes ea-wire-blink { 0%,100%{opacity:0.3} 50%{opacity:1} }
  .ea-family { font-size: 8px; opacity: 0.4; margin: 3px 0 1px; font-weight: 600; letter-spacing: 0.3px; border-bottom: 1px solid rgba(128,128,128,0.15); padding-bottom: 1px; }
  .ea-model { padding: 1px 5px; margin: 1px 0; border-radius: 2px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: inherit; font-size: 10px; line-height: 1.5; border: 1px solid transparent; transition: all 0.1s; display: flex; align-items: center; gap: 3px; }
  .ea-model:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ea-model.sel { border-color: var(--vscode-textLink-foreground, #4fc1ff); background: rgba(79,193,255,0.1); }
  .ea-model.routed { color: #6bb86b; }
  .ea-model.protected { color: #d4a017; }
  .ea-model.protected .ea-prot-badge { display: inline-block; }
  .ea-prot-badge { display: none; font-size: 7px; padding: 0 2px; border-radius: 2px; background: rgba(212,160,23,0.2); color: #d4a017; font-weight: 700; flex-shrink: 0; }
  .ea-route-toggle { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 2px; font-size: 8px; cursor: pointer; border: 1px solid rgba(128,128,128,0.3); background: transparent; color: var(--vscode-foreground); margin-left: auto; flex-shrink: 0; transition: all 0.1s; padding: 0; line-height: 1; }
  .ea-route-toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ea-route-toggle.on { border-color: #6bb86b; color: #6bb86b; background: rgba(107,184,107,0.1); }
  .ea-route-toggle.off { border-color: #e08080; color: #e08080; background: rgba(224,128,128,0.1); }
  .ea-tier { font-size: 8px; padding: 0 3px; border-radius: 2px; font-weight: 700; letter-spacing: 0.3px; margin-left: 4px; }
  .ea-tier.pro { background: rgba(107,184,107,0.15); color: #6bb86b; border: 1px solid rgba(107,184,107,0.25); }
  .ea-tier.trial { background: rgba(79,193,255,0.15); color: #4fc1ff; border: 1px solid rgba(79,193,255,0.25); }
  .ea-tier.free { background: rgba(128,128,128,0.1); color: #888; border: 1px solid rgba(128,128,128,0.2); }
  .ea-tier.unknown { background: rgba(128,128,128,0.1); color: #888; border: 1px solid rgba(128,128,128,0.2); }
  .ea-tier-fold { font-size: 8px; padding: 0 3px; border-radius: 2px; margin-left: 3px; background: rgba(212,160,23,0.15); color: #d4a017; border: 1px solid rgba(212,160,23,0.3); font-weight: 700; flex: 0 0 auto; }
  .ea-route-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #6bb86b; flex-shrink: 0; }
  .ea-route-dot.off { background: #888; opacity: 0.3; }
  .ea-wire-badge { font-size: 7px; padding: 0 2px; border-radius: 2px; background: rgba(107,184,107,0.2); color: #6bb86b; font-weight: 700; flex-shrink: 0; cursor: pointer; }
  .ea-wire-badge:hover { background: rgba(224,128,128,0.2); color: #e08080; }
  .ea-prov-tag { font-size: 7px; padding: 0 2px; border-radius: 2px; background: rgba(212,160,23,0.15); color: #d4a017; font-weight: 600; flex-shrink: 0; opacity: 0.7; }
  .ea-status-badge { font-size: 7px; padding: 0 2px; border-radius: 2px; font-weight: 700; flex-shrink: 0; line-height: 1.4; }
  .ea-status-badge.premium { background: rgba(255,193,7,0.2); color: #ffc107; }
  .ea-status-badge.beta { background: rgba(66,133,244,0.2); color: #4285f4; }
  .ea-status-badge.new { background: rgba(52,168,83,0.2); color: #34a853; }
  .ea-status-badge.recommended { background: rgba(52,168,83,0.15); color: #34a853; }
  .ea-src-badge { font-size: 7px; padding: 0 2px; border-radius: 2px; font-weight: 700; line-height: 1.4; flex-shrink: 0; }
  .ea-src-rpc { background: #1a6b3c; color: #fff; }
  .ea-src-seen { background: #5a5a8a; color: #ddd; }
  .ea-src-account { background: #3a5a8a; color: #b0d0ff; }
  .ea-src-fallback { background: #5a5a5a; color: #aaa; }
  .ea-model.wired { border-left: 2px solid #6bb86b; padding-left: 3px; }
  .ea-model.wired.err { border-left-color: #e08080; }
  .ea-model.wire-pending { border-left: 2px solid #4fc1ff; padding-left: 3px; animation: ea-wire-blink 0.8s infinite; }
  .ea-toolbar { display: flex; gap: 3px; align-items: center; margin-top: 3px; flex-wrap: wrap; }
  .ea-btn { padding: 1px 6px; font-size: 9px; border: 1px solid rgba(128,128,128,0.3); background: transparent; color: var(--vscode-foreground); cursor: pointer; border-radius: 2px; font-family: inherit; line-height: 1.4; }
  .ea-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ea-btn.add { border-color: #6bb86b; color: #6bb86b; }
  .ea-btn.del { border-color: #e08080; color: #e08080; }
  .ea-btn.warn { border-color: #d4a017; color: #d4a017; }
  .ea-prov-form { display: none; gap: 4px; align-items: center; margin-top: 3px; flex-wrap: wrap; padding: 4px 5px; border: 1px dashed rgba(107,184,107,0.3); border-radius: 3px; background: rgba(107,184,107,0.03); }
  .ea-prov-form.show { display: flex; }
  .ea-prov-form label { font-size: 9px; opacity: 0.5; min-width: 28px; }
  .ea-prov-form input, .ea-prov-form select { font-size: 10px; padding: 1px 4px; border: 1px solid rgba(128,128,128,0.3); border-radius: 2px; background: var(--vscode-input-background, rgba(0,0,0,0.12)); color: var(--vscode-input-foreground, var(--vscode-foreground)); outline: none; font-family: monospace; }
  .ea-prov-form input:focus, .ea-prov-form select:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .ea-prov-form .ea-p-name { width: 60px; }
  .ea-prov-form .ea-p-url { width: 130px; }
  .ea-prov-form .ea-p-key { width: 90px; }
  .ea-route-form { display: none; gap: 4px; align-items: center; margin-top: 3px; flex-wrap: wrap; padding: 4px 5px; border: 1px dashed rgba(79,193,255,0.3); border-radius: 3px; background: rgba(79,193,255,0.03); }
  .ea-route-form.show { display: flex; }
  .ea-route-form label { font-size: 9px; opacity: 0.5; }
  .ea-route-form input { font-size: 10px; padding: 1px 3px; border: 1px solid rgba(128,128,128,0.3); border-radius: 2px; background: var(--vscode-input-background, rgba(0,0,0,0.12)); color: var(--vscode-input-foreground, var(--vscode-foreground)); outline: none; width: 55px; font-family: monospace; }
  .ea-info { font-size: 9px; opacity: 0.5; margin-left: auto; }
  .ea-prov-item { display: flex; align-items: center; gap: 3px; margin: 1px 0; padding: 1px 4px; border-radius: 2px; font-family: monospace; font-size: 10px; }
  .ea-prov-item:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ea-prov-item .ea-prov-name { color: #d4a017; font-weight: 600; }
  .ea-prov-item .ea-prov-url { opacity: 0.4; font-size: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80px; }
  .ea-prov-item .ea-del-prov { margin-left: auto; opacity: 0; cursor: pointer; color: #e08080; font-size: 9px; }
  .ea-prov-item:hover .ea-del-prov { opacity: 0.7; }
  .ea-prov-item .ea-del-prov:hover { opacity: 1; }
</style>
</head>
<body data-port="${proxyPort}">
  <div class="bar">
    <span class="dots" id="dots" title="Proxy\u00b7Capture\u00b7Mode"></span>
    <button class="mb" id="btnDao" title="\u9053Agent\u00b7\u5e1b\u4e66\u524d\u7f6e">\u9053</button>
    <button class="mb" id="btnOff" title="\u5b98\u65b9Agent\u00b7\u900f\u4f20">\u5b98</button>
    <button class="ib" id="editToggle" title="\u7f16\u8f91\u6ce8\u5165 SP">\u7f16</button>
    <select id="canonSelect" title="\u7ecf\u85cf\u5207\u6362 \u00b7 \u4e24\u7ecf\u5f52\u4e00\u00b7\u9053\u751f\u4e00">
      <option value="laozi+yinfu">\u5e1b\u4e66\u8001\u5b50+\u9053\u85cf\u9634\u7b26\u7ecf</option>
      <option value="laozi">\u5e1b\u4e66\u300a\u8001\u5b50\u300b</option>
      <option value="yinfu">\u9053\u85cf\u300a\u9634\u7b26\u7ecf\u300b</option>
    </select>
    <span id="customBadge"></span>
  </div>
  <!-- ★ v9.9.94 · 外接API面板 · 五十七章「我无为也 而民自化」· 正本清源重写 -->
  <div class="ea-bar">
    <button class="ea-toggle" id="eaToggle" title="\u5916\u63a5API\u8def\u7531">\u2b21</button>
    <span class="ea-badge off" id="eaBadge" title="\u65e0\u8def\u7531">0</span>
    <span class="ea-tier unknown" id="eaTier" title="\u8d26\u53f7\u5c42\u7ea7">\u2022</span>
    <span class="ea-info" id="eaInfo"></span>
  </div>
  <div class="ea-panel" id="eaPanel">
    <div class="ea-wire-wrap" id="eaWireWrap">
      <div class="ea-col ea-left" id="eaLeftWrap">
        <div class="ea-col-head"><span class="ea-col-title">\u672c\u673a\u6a21\u578b</span><span class="ea-col-sub" id="eaLeftCount"></span></div>
        <div class="ea-col-list" id="eaLeft"></div>
      </div>
      <svg class="ea-wires" id="eaWires" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="ea-col ea-right" id="eaRightWrap">
        <div class="ea-col-head"><span class="ea-col-title">\u5916\u63a5\u6a21\u578b</span><span class="ea-col-sub" id="eaRightCount"></span></div>
        <div class="ea-col-list" id="eaRight"></div>
      </div>
    </div>
    <div class="ea-toolbar">
      <button class="ea-btn add" id="eaAddProv" title="\u6dfb\u52a0Provider">+P</button>
      <button class="ea-btn" id="eaProbe" title="\u63a2\u6d4b\u5065\u5eb7">\u63a2</button>
      <button class="ea-btn" id="eaDiscover" title="\u53d1\u73b0\u6a21\u578b(RPC\u5b9e\u8bc1)" style="border-color:#4fc1ff;color:#4fc1ff">\u53d1</button>
      <button class="ea-btn" id="eaTestChat" title="\u5168\u94fe\u8def\u6d4b\u8bd5" style="border-color:#d4a017;color:#d4a017">\u6d4b</button>
      <button class="ea-btn" id="eaFallback" title="\u70ed\u5207\u6362\u56de\u9000\u5b98\u65b9(\u5173\u95ed\u6240\u6709\u8def\u7531)" style="border-color:#e08080;color:#e08080">\u23ea</button>
      <button class="ea-btn del" id="eaClearRoutes" title="\u6e05\u7a7a\u6240\u6709\u8def\u7531">\u2716R</button>
    </div>
    <div id="eaProvList"></div>
    <div class="ea-prov-form" id="eaProvForm">
      <label>\u9884\u8bbe</label><select id="eaPPreset" title="cc-switch \u98ce\u683c\u9884\u8bbe \u00b7 \u9009\u540e\u81ea\u52a8\u586b\u5165"></select>
      <label>\u7c7b</label><select id="eaPType" title="Provider\u7c7b\u578b">
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="custom">Custom</option>
      </select>
      <label>\u540d</label><input id="eaPName" class="ea-p-name" placeholder="\u540d\u79f0" title="Provider\u540d\u79f0">
      <label>URL</label><input id="eaPUrl" class="ea-p-url" placeholder="https://api.example.com/v1" title="API Base URL">
      <label>Key</label><input id="eaPKey" class="ea-p-key" placeholder="sk-..." title="API Key">
      <label>\u6a21</label><input id="eaPModels" class="ea-p-url" placeholder="model-a, model-b" title="\u6a21\u578b\u5217\u8868(\u9017\u53f7\u5206\u9694)">
      <button class="ea-btn add" id="eaProvSave" title="\u4fdd\u5b58Provider">\u2714</button>
      <button class="ea-btn" id="eaProvCancel" title="\u53d6\u6d88">\u2716</button>
    </div>
    <div class="ea-route-form" id="eaRouteForm">
      <label>maxT</label><input id="eaRMaxTok" value="16384" title="maxOutputTokens">
      <button class="ea-btn add" id="eaRouteSave" title="\u786e\u8ba4\u8fde\u7ebf">\u2714 \u8fde</button>
      <button class="ea-btn" id="eaRouteCancel" title="\u53d6\u6d88">\u2716</button>
    </div>
  </div>
  <div class="stat" id="stat"></div>
  <pre id="sp" class="quiet">\uff08\u5f85\u9996\u6b21\u5bf9\u8bdd\uff09</pre>
  <div id="editArea">
    <div class="edit-hint">\u7f16\u6b64 \u00b7 \u6539\u9053 agent \u6ce8\u5165 LLM \u4e4b SP (\u5e1b\u4e66\u5fb7\u9053\u7ecf) \u00b7 Ctrl+Enter \u4fdd\u5b58 \u00b7 Esc \u5173</div>
    <textarea id="editText" placeholder="\u7f16\u8f91\u9053 agent \u6a21\u5f0f\u6ce8\u5165 LLM \u4e4b\u6838\u5fc3 SP (\u5e1b\u4e66\u300a\u8001\u5b50\u300b) \u00b7 \u6539\u6b64\u5373\u6539\u6ce8\u5165 \u00b7 \u4fdd\u5b58\u540e\u4e0b\u6b21 chat \u5373\u751f\u6548"></textarea>
    <div class="edit-bar">
      <button class="eb save" id="editSave" title="\u4fdd\u5b58\u6ce8\u5165 (Ctrl+Enter)">\u2714 \u6ce8\u5165</button>
      <button class="eb reload" id="editReload" title="\u91cd\u8f7d\u5f53\u524d LLM \u5b9e\u6536 SP (\u4e0d\u4fdd\u5b58)">\u8f7d</button>
      <button class="eb reset" id="editReset" title="\u6e05 _customSP \u00b7 \u56de\u9ed8\u9053\u5fb7\u7ecf\u8def\u5f84">\u2716 \u5f52\u9053</button>
      <span class="edit-count" id="editCount"></span>
      <span class="edit-status" id="editStatus"></span>
    </div>
  </div>
  <noscript><div style="padding:16px;color:#e08080;font-size:11px">\u811a\u672c\u88ab CSP \u62e6\u622a \u00b7 \u8bf7\u91cd\u8f7d</div></noscript>
<script nonce="${N}">
(function() {
  'use strict';
  // v9.7.6 · 执今之道 · 以御今之有 · 编辑态永不空
  // ★ v9.9.20 jiqi · 二十五章「大象无形」· 加 _wdbg 上报 + try-catch 死活诊
  //   让 IIFE 死活通过 /origin/_wdbg ringbuf 立即可见 · 反者道之动
  var _PORT = ${proxyPort};
  var _BASE = 'http://127.0.0.1:' + _PORT;

  // ─── _wdbg · 反代 ringbuf 上报 · IIFE 死活立可观 (六十四章「为之于其未有也」) ───
  function _wdbg(msg, tag, data) {
    try {
      fetch(_BASE + '/origin/_wdbg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: msg || '', tag: tag || '', data: data || null }),
        cache: 'no-store'
      }).catch(function(){});
    } catch(_) {}
  }
  _wdbg('iife-start', 'boot', { port: _PORT, href: location.href, ts: Date.now() });

  // 全局错误捕获 · 任何未处理异常即上报 · 不再静默崩 (二十七章「善行者无辙迹」之反 · 留迹以辨)
  try {
    window.addEventListener('error', function(ev) {
      _wdbg('window-error', 'fatal', {
        msg: ev && ev.message,
        src: ev && ev.filename,
        line: ev && ev.lineno,
        col: ev && ev.colno,
        stack: ev && ev.error && ev.error.stack && String(ev.error.stack).slice(0, 500)
      });
    });
    window.addEventListener('unhandledrejection', function(ev) {
      _wdbg('unhandled-rejection', 'fatal', { reason: ev && String(ev.reason).slice(0, 300) });
    });
  } catch(_) {}

  var vsc;
  try { vsc = acquireVsCodeApi(); _wdbg('vsc-acquired', 'boot'); }
  catch(e) { vsc = { postMessage: function(){ return false; }, _ghost: true }; _wdbg('vsc-fail', 'boot', e.message); }

  var $sp = document.getElementById('sp');
  var $stat = document.getElementById('stat');
  var $dots = document.getElementById('dots');
  var $btnDao = document.getElementById('btnDao');
  var $btnOff = document.getElementById('btnOff');
  var $editToggle = document.getElementById('editToggle');
  var $editArea = document.getElementById('editArea');
  var $editText = document.getElementById('editText');
  var $editSave = document.getElementById('editSave');
  var $editReload = document.getElementById('editReload');
  var $editReset = document.getElementById('editReset');
  var $editStatus = document.getElementById('editStatus');
  var $editCount = document.getElementById('editCount');
  var $customBadge = document.getElementById('customBadge');
  var $canonSelect = document.getElementById('canonSelect');
  var lastText = '';
  var lastSP = '';
  var lastEntry = null;
  var lastSig = '';
  var curMode = 'invert';
  var editMode = false;

  // 反者道之动 · 编模式预填只取经文本源部分 · 截去 kept blocks (—之后)
  // TAO_TRAILER = "\\n\\n---\\n\\n" 是自然分界符 · 前为道魂(经文) · 后为辐(工具块)
  // 三十辐共一毅 · 辐不入编辑 · 由 proxy 自动补充
  // ★ v9.9.20 jiqi 修 · template-literal 内 '\\n' 必双转义 · 否则反斜杠被吃 · JS 字符串跨行 SyntaxError · IIFE 全崩
  function _spCanonPart(s) {
    if (!s) return '';
    var sep = '\\n\\n---\\n\\n';
    var idx = s.indexOf(sep);
    return idx >= 0 ? s.slice(0, idx) : s;
  }
  var _editClosing = null;

  function fJson(p) { return fetch(_BASE + p, { cache: 'no-store' }).then(function(r){ if (!r.ok) throw new Error('http ' + r.status); return r.json(); }); }

  // ─── renderTapeEntry · 万物作焉而不辞 · 永显 all_fields 全貌 ───
  function renderTapeEntry(entry, ts) {
    if (!entry) return false;
    lastEntry = entry;

    // lastSP 锚定本源 · 供 [编] 初值 & [载] 重载 & [归道] 复原
    // 优先 entry.after (CHAT_PROTO 命中之 invertSP 结果)
    // 空则 fallback 到 all_fields 首个 SP 类字段 (chat/summary/memory/ephemeral/unknown_long)
    // 仍空则取 all_fields[0].text · 保 [编] 初值必为当前注入之核心文本
    var _sp = entry.after || entry.before || '';
    if (!_sp && entry.all_fields && entry.all_fields.length > 0) {
      var _spKinds = ['chat', 'summary', 'memory', 'ephemeral', 'unknown_long'];
      for (var _si = 0; _si < entry.all_fields.length; _si++) {
        if (_spKinds.indexOf(entry.all_fields[_si].kind) >= 0) {
          _sp = entry.all_fields[_si].text || '';
          break;
        }
      }
      if (!_sp) _sp = entry.all_fields[0].text || '';
    }
    lastSP = _sp;

    var parts = [];
    var totalChars = 0;
    var fieldCount = (entry.all_fields && entry.all_fields.length) || 0;

    // 万物作焉而不辞 · 永循环 all_fields 全部 · SP / user_msg / tool_def / chat_history / 编辑器状态 等皆显
    if (fieldCount > 0) {
      for (var i = 0; i < fieldCount; i++) {
        var f = entry.all_fields[i];
        parts.push('\u2501\u2501\u2501 #' + (i + 1) + '/' + fieldCount +
          ' \u00b7 ' + (f.chars || 0) + '\u5b57 \u2501\u2501\u2501');
        parts.push(f.text || '');
        parts.push('');
        totalChars += (f.chars || 0);
      }
    } else if (lastSP) {
      // 兑底 · all_fields 空但 after 存 · 极罕之境
      parts.push('\u2501\u2501\u2501 LLM \u5b9e\u6536 \u00b7 ' + lastSP.length + '\u5b57 \u2501\u2501\u2501');
      parts.push(lastSP);
      totalChars += lastSP.length;
    }

    if (parts.length === 0) return false;

    var text = parts.join('\\n');
    lastText = text;
    if (!editMode) {
      $sp.classList.remove('quiet');
      $sp.textContent = text;
    }

    if (fieldCount > 0) {
      $stat.innerHTML = '<span class="pill">\u5168\u00b7' + fieldCount + '\u5b57\u6bb5\u00b7' + totalChars + '\u5b57</span>';
    } else if (lastSP) {
      $stat.innerHTML = '<span class="pill">\u5168\u00b71\u5b57\u6bb5\u00b7' + lastSP.length + '\u5b57</span>';
    } else {
      $stat.innerHTML = '';
    }

    return true;
  }

  // ─── 道/官 切换 ───
  function setModeUI(mode) {
    curMode = mode || 'invert';
    $btnDao.classList.remove('active', 'active-dao');
    $btnOff.classList.remove('active');
    if (curMode === 'invert') $btnDao.classList.add('active', 'active-dao');
    else $btnOff.classList.add('active');
  }
  $btnDao.addEventListener('click', function() {
    if (curMode === 'invert') return;
    setModeUI('invert');
    vsc.postMessage({ command: 'setMode', mode: 'dao' });
  });
  $btnOff.addEventListener('click', function() {
    if (curMode === 'passthrough') return;
    setModeUI('passthrough');
    vsc.postMessage({ command: 'setMode', mode: 'official' });
  });

  // ─── 经藏切换 · 道生一 一生二 二生三 三生万物 ───
  $canonSelect.addEventListener('change', function() {
    var c = $canonSelect.value;
    vsc.postMessage({ command: 'setCanon', canon: c });
  });

  // ─── 编辑模式 ───
  function _closeEditMode() {
    editMode = false;
    $editArea.classList.remove('show');
    $editToggle.classList.remove('edit-active');
    $sp.style.display = '';
    if (_editClosing) { clearTimeout(_editClosing); _editClosing = null; }
  }
  function updateEditCount() {
    var n = ($editText.value || '').length;
    var d = (lastSP || '').length;
    $editCount.textContent = n + (d > 0 ? '/' + d : '') + '\u5b57';
  }
  $editToggle.addEventListener('click', function() {
    editMode = !editMode;
    if (editMode) {
      $editArea.classList.add('show');
      $editToggle.classList.add('edit-active');
      $sp.style.display = 'none';
      // v9.9.22 · 不再用旧 lastSP 预填 (lastSP 可能是切前经文)
      // 道义: 十六章「致虚极 守静笃」· 清空守静以待真源 · getCustomSP 必返新 default_sp 填实
      $editText.value = '';
      updateEditCount();
      $editStatus.textContent = '\u52a0\u8f7d\u4e2d\u2026';
      vsc.postMessage({ command: 'getCustomSP' });
      $editText.focus();
    } else {
      _closeEditMode();
    }
  });
  $editSave.addEventListener('click', function() {
    var sp = $editText.value;
    if (!sp || !sp.trim()) { $editStatus.textContent = '\u2716 \u5185\u5bb9\u4e0d\u53ef\u4e3a\u7a7a'; return; }
    $editStatus.textContent = '\u4fdd\u5b58\u4e2d\u2026';
    vsc.postMessage({ command: 'setCustomSP', sp: sp.trim() });
  });
  $editReload.addEventListener('click', function() {
    $editText.value = _spCanonPart(lastSP);
    updateEditCount();
    $editStatus.textContent = '\u2714 \u5df2\u8f7d\u5f53\u524d\u5b9e\u6536 SP \u00b7 ' + (_spCanonPart(lastSP).length) + '\u5b57';
    $editText.focus();
  });
  $editReset.addEventListener('click', function() {
    $editStatus.textContent = '\u6e05\u9664\u4e2d\u2026';
    vsc.postMessage({ command: 'resetCustomSP' });
  });
  $editText.addEventListener('input', updateEditCount);
  $editText.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $editSave.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); _closeEditMode(); }
  });

  function updateCustomBadge(isCustom, chars) {
    if (isCustom) $customBadge.innerHTML = '<span class="custom-badge">\u81ea\u5b9a\u4e49' + (chars ? ' ' + chars + '\u5b57' : '') + '</span>';
    else $customBadge.innerHTML = '';
  }

  // ─── dots (三盏) ───
  function setDots(p) {
    $dots.innerHTML = '';
    if (!p || !p.ok) {
      var d = document.createElement('span');
      d.className = 'dot err';
      $dots.appendChild(d);
      $dots.title = 'Proxy:\u2717';
      return;
    }
    var items = [
      { label: 'Proxy', on: true, k: 'proxy' },
      { label: 'Capture', on: !!(p.tape_count > 0), k: 'cap' },
      { label: 'Mode', on: p.mode === 'invert', k: 'mode' }
    ];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var d2 = document.createElement('span');
      d2.className = 'dot ' + (it.on ? 'ok' : (it.k === 'cap' ? 'warn' : 'err'));
      $dots.appendChild(d2);
    }
    $dots.title = 'Proxy:' + (items[0].on?'\u2713':'\u2717') + ' \u00b7 Cap:' + (items[1].on?'\u2713':'\u2717') + ' \u00b7 M:' + (p.mode||'?');
  }

  function pingPull() {
    fJson('/origin/ping').then(function(p){
      if (!p) return;
      if (p.mode) setModeUI(p.mode);
      if (p.canon && $canonSelect.value !== p.canon) $canonSelect.value = p.canon;
      setDots(p);
      if (p.custom_sp != null) updateCustomBadge(p.custom_sp, p.custom_sp_chars);
    }).catch(function(){ setDots(null); });
  }

  function pull() {
    if (!_PORT) return;
    // v9.9.19 · 损之又损 · fields=0 去除all_fields全文(432项·767KB) · 仅保after/before元数据(~52KB)
    fJson('/origin/tape?limit=1&fields=0').then(function(resp) {
      if (resp && resp.ok && resp.tape && resp.tape.length > 0) {
        renderTapeEntry(resp.tape[0], new Date().toLocaleTimeString());
      } else {
        if (!editMode) {
          $sp.classList.add('quiet');
          $sp.textContent = '\uff08\u5f85\u9996\u6b21\u5bf9\u8bdd\uff09';
        }
        $stat.innerHTML = '';
      }
    }).catch(function(){});
  }

  function sigTick() {
    fJson('/origin/sig').then(function(r){
      if (!r || !r.ok) return;
      var cur = (r.injects_last_at || 0) + '|' + (r.injects_count || 0) + '|' + (r.tape_last_at || 0) + '|' + (r.mode_sig || '');
      if (cur === lastSig) return;
      lastSig = cur;
      pingPull();
      pull();
    }).catch(function(){});
  }

  window.addEventListener('message', function(e) {
    if (!e.data) return;
    // v9.9.20 jiqi · 上报 msg-recv · 反诊 webview ↔ extension host IPC 通路
    try { _wdbg('msg-recv', String(e.data.command || e.data.type || '?'), { keys: Object.keys(e.data).slice(0, 8) }); } catch(_) {}
    if (e.data.command === '_diag-ping') return;  // 主进程探活包 · 已 _wdbg 上报 · 不入业务
    if (e.data.type === 'mode') setModeUI(e.data.mode);
    // v9.9.18 \u4fee\u590d \u00b7 extension host gatherEssence \u63a8\u9001\u4e4b data \u5305 · \u6838\u5fc3\u663e\u793a\u901a\u8def
    // forceRefresh() \u53d1\u9001 {type:"data", data:{ping,proxy,allInjects,...}} \u4e4b\u540e webview \u5e94\u66f4\u65b0\u4e09\u76cf/\u6309\u9215/SP\u663e\u793a
    if (e.data.type === 'data') {
      var _d = e.data.data;
      if (!_d) return;
      // 1. \u66f4\u65b0\u4e09\u76cf + \u6309\u9215\u72b6\u6001
      if (_d.ping && _d.ping.mode) setModeUI(_d.ping.mode);
      if (_d.ping) setDots(_d.ping);
      // 2. \u540c\u6b65\u7ecf\u85cf\u4e0b\u62c9
      if (_d.ping && _d.ping.canon && $canonSelect.value !== _d.ping.canon) $canonSelect.value = _d.ping.canon;
      // 3. \u81ea\u5b9a\u4e49 badge
      if (_d.ping && _d.ping.custom_sp != null) updateCustomBadge(_d.ping.custom_sp, _d.ping.custom_sp_chars);
      // 4. \u663e\u793a SP \u5185\u5bb9 (\u4f18\u5148 proxy.after · \u5df2\u8fd0\u884c\u624d\u6709)
      if (_d.proxy && _d.proxy.after) {
        lastSP = _d.proxy.after;
        if (!editMode) {
          $sp.classList.remove('quiet');
          $sp.textContent = _d.proxy.after;
        }
        var _ageS = (_d.proxy.age_s != null) ? Math.round(_d.proxy.age_s) : null;
        var _pill = _d.proxy.after.length + '\u5b57';
        if (_ageS != null) _pill += ' \u00b7 ' + _ageS + 's\u524d';
        if (_d.ping && _d.ping.canon_name) _pill += ' \u00b7 ' + _d.ping.canon_name;
        $stat.innerHTML = '<span class="pill">' + _pill + '</span>';
        $stat.classList.add('show');
      } else if (_d.proxyUp === false) {
        // v9.9.19 对标v9.9.16本源: 只有代理真正宿机才重置显示
        // 去掉!_d.proxy分支: preview超时/gatherEssence失败导致proxy=null时不覆盖pull()展示内容
        if (!editMode) {
          $sp.classList.add('quiet');
          $sp.textContent = '\uff08待首次对话\uff09';
        }
        $stat.innerHTML = '';
      }
      return;
    }
    // v9.9.22 · canonChanged · 切经文即推 · 名实变即随
    // 道义: 二十五章「逝曰远 远曰反」· 名变即推 · 不滞旧
    if (e.data.type === 'canonChanged') {
      var _cc = e.data;
      // 无 custom 时 · 用新 default_sp 强刷 lastSP/$sp/textarea (有 custom 则不动 · 用户即道)
      if (!_cc.has_custom && _cc.default_sp) {
        lastSP = _cc.default_sp;
        if (!editMode) {
          $sp.classList.remove('quiet');
          $sp.textContent = _cc.default_sp;
        } else {
          // 编辑模式 · textarea 重填新经文 (前提: 用户未在编辑自定义)
          $editText.value = _cc.default_sp;
          updateEditCount();
          $editStatus.textContent = '\u7ECF\u85CF\u5DF2\u5207 \u00B7 ' + (_cc.default_source_name || _cc.canon || '?') + ' ' + (_cc.default_chars || 0) + '\u5B57';
        }
      }
      // 同步下拉选中态 (防 extension 推之 canon 与 webview 局部不一致)
      if (_cc.canon && $canonSelect.value !== _cc.canon) $canonSelect.value = _cc.canon;
      // stat 更新经名
      var _ccPill = (_cc.default_chars || 0) + '\u5B57';
      if (_cc.default_source_name) _ccPill += ' \u00B7 ' + _cc.default_source_name;
      $stat.innerHTML = '<span class="pill">' + _ccPill + '</span>';
      $stat.classList.add('show');
      return;
    }
    if (e.data.type === 'customSP') {
      var r = e.data;
      if (r.action === 'get') {
        // v9.7.6 · 十四章「执今之道·以御今之有」· default_sp 兜底 · tape 空亦可编辑帛书本源
        // v9.9.22 · 永同步 lastSP ← default_sp (随 _activeCanon 动态) · 不再 !lastSP 守卫
        if (r.default_sp) lastSP = r.default_sp;
        if (r.has_custom && r.sp) {
          $editText.value = r.sp;
          updateEditCount();
          updateCustomBadge(true, r.chars);
          $editStatus.textContent = '\u81ea\u5b9a\u4e49 \u00b7 ' + (r.chars || 0) + '\u5b57';
        } else {
          updateCustomBadge(false);
          // v9.9.22 · 永以 default_sp 填 textarea (移除 !$editText.value 守卫)
          // 道义: 二十二章「曲则金 枉则定」· 直填即真 · 不留旧经文
          if (r.default_sp) {
            $editText.value = r.default_sp;
          }
          updateEditCount();
          var _srcLabel = r.default_source_name || (r.default_source === 'silk' ? '\u5e1b\u4e66\u672c\u6e90' : (r.default_source || '\u9ed8\u8ba4'));
          $editStatus.textContent = '\u672a\u8bbe \u00b7 ' + _srcLabel + ' ' + (r.default_chars || 0) + '\u5b57';
        }
      } else if (r.action === 'set') {
        if (r.ok) {
          $editStatus.textContent = '\u2714 \u5df2\u6ce8\u5165 ' + (r.chars || 0) + '\u5b57';
          updateCustomBadge(true, r.chars);
          updateEditCount();
          if (_editClosing) clearTimeout(_editClosing);
          _editClosing = setTimeout(_closeEditMode, 1500);
        } else $editStatus.textContent = '\u2716 \u5931\u8d25: ' + (r.error || '?');
      } else if (r.action === 'reset') {
        if (r.ok) {
          // v9.7.8 · 反者道之动 · [归道] 严守帛书本源 · 不沿 lastSP (lastSP 已被 chat 覆盖)
          // 十一章「三十辐共一毂」· 强拉 default_sp 帛书 · 同步 lastSP 锚回本源 · 道魂 ~7237 字 + 7 辐由实际 SP 中提
          $editStatus.textContent = '\u5f52\u9053\u4e2d\u2026';
          updateCustomBadge(false);
          fJson('/origin/custom_sp').then(function(g) {
            if (g && g.default_sp) {
              $editText.value = g.default_sp;
              lastSP = g.default_sp;
              updateEditCount();
              $editStatus.textContent = '\u2714 \u5df2\u5f52\u9053 \u00b7 \u5e1b\u4e66\u672c\u6e90 ' + (g.default_chars || 0) + '\u5b57';
            } else {
              $editStatus.textContent = '\u2716 \u5f52\u9053\u62c9\u6e90\u5931\u8d25';
            }
          }).catch(function(){ $editStatus.textContent = '\u2716 \u5f52\u9053\u7f51\u8def\u5f02'; });
        } else $editStatus.textContent = '\u2716 \u6e05\u9664\u5931\u8d25';
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ★ v9.9.94 · 外接API面板 · 五十七章「我无为也 而民自化」· 正本清源重写
  // ═══════════════════════════════════════════════════════════
  var $eaToggle = document.getElementById('eaToggle');
  var $eaBadge = document.getElementById('eaBadge');
  var $eaPanel = document.getElementById('eaPanel');
  var $eaLeft = document.getElementById('eaLeft');
  var $eaRight = document.getElementById('eaRight');
  var $eaWires = document.getElementById('eaWires');
  var $eaWireWrap = document.getElementById('eaWireWrap');
  var $eaLeftWrap = document.getElementById('eaLeftWrap');
  var $eaRightWrap = document.getElementById('eaRightWrap');
  var $eaLeftCount = document.getElementById('eaLeftCount');
  var $eaRightCount = document.getElementById('eaRightCount');
  var $eaInfo = document.getElementById('eaInfo');
  var $eaAddProv = document.getElementById('eaAddProv');
  var $eaProbe = document.getElementById('eaProbe');
  var $eaClearRoutes = document.getElementById('eaClearRoutes');
  var $eaProvList = document.getElementById('eaProvList');
  var $eaProvForm = document.getElementById('eaProvForm');
  var $eaPType = document.getElementById('eaPType');
  var $eaPName = document.getElementById('eaPName');
  var $eaPUrl = document.getElementById('eaPUrl');
  var $eaPKey = document.getElementById('eaPKey');
  var $eaProvSave = document.getElementById('eaProvSave');
  var $eaProvCancel = document.getElementById('eaProvCancel');
  var $eaRouteForm = document.getElementById('eaRouteForm');
  var $eaRMaxTok = document.getElementById('eaRMaxTok');
  var $eaRouteSave = document.getElementById('eaRouteSave');
  var $eaRouteCancel = document.getElementById('eaRouteCancel');
  var _eaOpen = false;
  var _eaData = null;
  var _eaSelLeft = null;   // selected left model uid
  var _eaSelRight = null;  // selected right model key (prov/model)
  var _eaWireMap = {};     // uid → { rightKey, status } for visual wires
  // 模型家族分组 · 二十八章「朴散则为器」
  var _MF = [
    {p:'claude',l:'Claude'},{p:'gpt',l:'GPT'},{p:'gemini',l:'Gemini'},
    {p:'deepseek',l:'DeepSeek'},{p:'qwen',l:'Qwen'},{p:'swe',l:'SWE'},
    {p:'grok',l:'Grok'},{p:'kimi',l:'Kimi'}
  ];
  function _mFam(uid){for(var i=0;i<_MF.length;i++){if(uid.startsWith(_MF[i].p))return _MF[i].l;}return'Other';}
  // ★ v9.9.102 · 同模型多档位折叠 · 万物归一 · 档位后缀 → 基名
  var _TIER_RE = /-(low|medium|high|xhigh|minimal|fast|slow|thinking)$/;
  function _tierBase(uid){var b=String(uid||'');while(_TIER_RE.test(b))b=b.replace(_TIER_RE,'');return b;}
  function _tierLabel(uid,base){var t=String(uid).slice(base.length).replace(/^-/,'');return t||'base';}
  var _eaTierGroups = {};  // primaryUid → [all tier uids]

  function fPost(p, body) {
    return fetch(_BASE + p, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body), cache: 'no-store'
    }).then(function(r){return r.json();});
  }
  function fDel(p) {
    return fetch(_BASE + p, {method:'DELETE',cache:'no-store'}).then(function(r){return r.json();});
  }

  // ── 自带确认弹层 (VS Code webview 屏蔽 window.confirm/alert) ──
  function _daoToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);background:rgba(40,40,46,0.97);color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:6px;padding:8px 14px;font-size:12px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,0.5);max-width:80%;';
    document.body.appendChild(t);
    setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }
  function _daoConfirm(msg) {
    return new Promise(function(resolve) {
      var done = false;
      function close(v){ if (done) return; done = true; if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(v); }
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:99998;display:flex;align-items:center;justify-content:center;';
      var box = document.createElement('div');
      box.style.cssText = 'background:#26262c;color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:8px;padding:16px 18px;max-width:78%;box-shadow:0 8px 28px rgba(0,0,0,0.6);';
      var m = document.createElement('div'); m.textContent = msg; m.style.cssText = 'font-size:13px;margin-bottom:14px;line-height:1.5;';
      var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      var bc = document.createElement('button'); bc.textContent = '\u53d6\u6d88'; bc.style.cssText = 'background:rgba(128,128,128,0.2);color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:5px;padding:5px 14px;font-size:12px;cursor:pointer;';
      var bo = document.createElement('button'); bo.textContent = '\u786e\u8ba4'; bo.style.cssText = 'background:#b84a4a;color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:12px;cursor:pointer;';
      bc.addEventListener('click', function(){ close(false); });
      bo.addEventListener('click', function(){ close(true); });
      ov.addEventListener('click', function(e){ if (e.target === ov) close(false); });
      row.appendChild(bc); row.appendChild(bo); box.appendChild(m); box.appendChild(row); ov.appendChild(box);
      document.body.appendChild(ov);
    });
  }

  // ── toggle ──
  $eaToggle.addEventListener('click', function() {
    _eaOpen = !_eaOpen;
    $eaPanel.classList.toggle('show', _eaOpen);
    $eaToggle.classList.toggle('active', _eaOpen);
    $eaToggle.textContent = _eaOpen ? '\u2b22' : '\u2b21';
    if (_eaOpen) eaLoad();
  });

  // ── load overview + account info (v9.9.97) ──
  function eaLoad() {
    fJson('/origin/ea/overview').then(function(d) {
      if (!d || !d.ok) { $eaInfo.textContent = '\u2716'; return; }
      _eaData = d;
      // ★ v9.9.97 · 并行获取账号信息
      fJson('/origin/ea/account-info').then(function(ai) {
        if (ai && ai.ok) { _eaData.account_tier = ai.tier; }
        eaRender();
      }).catch(function() { eaRender(); });
    }).catch(function() { $eaInfo.textContent = '\u2716 \u7f51\u7edc'; });
  }

  // ── render · v9.9.98 · 连线面板 · 点左+点右=连线 · 点已连线=断线 ──
  function eaRender() {
    if (!_eaData) return;
    var d = _eaData, rc = d.route_count||0;
    $eaBadge.textContent = rc;
    $eaBadge.className = 'ea-badge'+(rc>0?'':' off');
    $eaBadge.title = rc>0?rc+'\u6761\u8def\u7531':'\u65e0\u8def\u7531';
    var tierEl = document.getElementById('eaTier');
    if (tierEl && d.account_tier) { tierEl.textContent = d.account_tier.toUpperCase(); tierEl.className = 'ea-tier ' + d.account_tier; tierEl.title = '\u8d26\u53f7: ' + d.account_tier; }
    // ★ v9.9.98 · build wireMap from routes
    var routes = d.routes || {};
    _eaWireMap = {};
    for (var uid in routes) { var rt = routes[uid]; _eaWireMap[uid] = { rightKey: (rt.provider||'?') + '/' + (rt.model||'?'), status: 'ok' }; }
    // ★ v9.9.102 · 路由双形归一：MODEL_GPT_5_4_LOW ↔ gpt-5-4-low 同视为已连
    for (var ruid in routes) {
      if (/^MODEL_/.test(ruid)) {
        var norm = ruid.replace(/^MODEL_/, '').toLowerCase().replace(/_/g, '-');
        if (!_eaWireMap[norm]) _eaWireMap[norm] = _eaWireMap[ruid];
      }
    }
    // ── LEFT: 官方模型 · v9.9.265 · 档位归一(一族一项,同 Cascade 顶层) ──
    $eaLeft.innerHTML = '';
    _eaTierGroups = {};
    var _fams = d.official_families || [];
    if (_fams.length > 0) {
      if ($eaLeftCount) $eaLeftCount.textContent = _fams.length;
      function _provLabel(p){p=String(p||'').replace(/^MODEL_PROVIDER_/,'');var M={ANTHROPIC:'Claude',OPENAI:'GPT',GOOGLE:'Gemini',WINDSURF:'Windsurf',XAI:'Grok',DEEPSEEK:'DeepSeek',MOONSHOT:'Kimi',MOONSHOT_AI:'Kimi',FIREWORKS:'Fireworks',ZHIPU:'GLM',ZHIPU_AI:'GLM',MINIMAX:'Minimax'};return M[p]||(p?p.charAt(0)+p.slice(1).toLowerCase():'Other');}
      var _pg = {}, _po = [];
      _fams.forEach(function(f){var pl=_provLabel(f.provider);if(!_pg[pl]){_pg[pl]=[];_po.push(pl);}_pg[pl].push(f);});
      _po.forEach(function(pl){
        var list = _pg[pl];
        var fe=document.createElement('div');fe.className='ea-family';fe.textContent=pl+' ('+list.length+')';$eaLeft.appendChild(fe);
        list.forEach(function(f){
          var uids = f.members.map(function(mm){return mm.modelUid;}).filter(Boolean);
          var defMember = f.members.filter(function(mm){return mm.isDefault;})[0] || f.members[0];
          var primary = (defMember && defMember.modelUid) || uids[0] || f.familyUid;
          _eaTierGroups[primary] = uids;
          var wiredUids = uids.filter(function(u){return !!_eaWireMap[u];});
          var isWired = wiredUids.length > 0;
          var isPending = _eaSelLeft===primary && _eaSelRight;
          var el=document.createElement('div');
          el.className='ea-model'+(isWired?' wired':'')+(isPending?' wire-pending':'')+(_eaSelLeft===primary&&!isPending?' sel':'');
          el.setAttribute('data-uid', primary);
          el.setAttribute('data-uids', uids.join(','));
          var dot=document.createElement('span');dot.className='ea-route-dot'+(isWired?'':' off');el.appendChild(dot);
          var txt=document.createElement('span');txt.textContent=f.label;txt.style.flex='1 1 auto';txt.style.overflow='hidden';txt.style.textOverflow='ellipsis';el.appendChild(txt);
          if(f.members.length>1){var tb=document.createElement('span');tb.className='ea-tier-fold';tb.textContent='\u00d7'+f.members.length;tb.title=f.members.map(function(mm){return (mm.tier||'base')+(_eaWireMap[mm.modelUid]?' \u2713':'');}).join(' \u00b7 ');el.appendChild(tb);}
          if(f.isNew){var nb=document.createElement('span');nb.className='ea-status-badge new';nb.textContent='N';nb.title='New';el.appendChild(nb);}
          if(f.isRecommended){var rb=document.createElement('span');rb.className='ea-status-badge recommended';rb.textContent='\u2714';rb.title='Recommended';el.appendChild(rb);}
          if(isWired){var wb=document.createElement('span');wb.className='ea-wire-badge';wb.textContent='\u2713'+(f.members.length>1?wiredUids.length+'/'+f.members.length:'');wb.title='\u5df2\u8fde\u7ebf '+wiredUids.length+'/'+f.members.length;el.appendChild(wb);}
          el.title=f.label+(f.members.length>1?' \u00b7 '+f.members.length+'\u6863':'')+(isWired?' \u00b7 \u5df2\u8fde\u7ebf':'');
          el.addEventListener('click',function(){
            var uid=this.getAttribute('data-uid');
            var gUids=(this.getAttribute('data-uids')||uid).split(',').filter(Boolean);
            var wired=gUids.filter(function(u){return !!_eaWireMap[u];});
            if(wired.length>0){_daoConfirm('\u65ad\u5f00 '+f.label+' \u5168\u90e8'+wired.length+'\u6761\u8def\u7531?').then(function(ok){if(!ok)return;Promise.all(wired.map(function(u){return fDel('/origin/ea/route/'+encodeURIComponent(u));})).then(function(){_eaSelLeft=null;eaLoad();$eaInfo.textContent='\u2716 \u5df2\u65ad\u5f00 '+wired.length+'\u6761';});});return;}
            if(_eaSelLeft===uid){_eaSelLeft=null;eaRender();return;}
            _eaSelLeft=uid;
            if(_eaSelRight){eaAutoConnect();}else{eaRender();}
          });
          $eaLeft.appendChild(el);
        });
      });
    } else {
    // ── 回退: 旧 seen 模型源 (catalog 未就绪时) ──
    var models = d.available_models || d.seen_models || [];
    if ($eaLeftCount) $eaLeftCount.textContent = models.length ? models.length : '';
    if (models.length === 0) {
      $eaLeft.innerHTML = '<div style="opacity:0.4;font-style:italic">\u52a0\u8f7d\u4e2d...</div>';
    } else {
      var groups = {};
      models.forEach(function(m){var f=m.family||_mFam(m.uid);if(!groups[f])groups[f]=[];groups[f].push(m);});
      // ★ v9.9.102 · 同模型多档位折叠为单卡 · 连/断作用于全部档位
      _eaTierGroups = {};
      _MF.map(function(f){return f.l}).concat(['GLM','Minimax','Other']).forEach(function(fam){
        if(!groups[fam])return;
        var bases = {}, order = [];
        groups[fam].forEach(function(m){var b=_tierBase(m.uid);if(!bases[b]){bases[b]=[];order.push(b);}bases[b].push(m);});
        var fe=document.createElement('div');fe.className='ea-family';fe.textContent=fam+' ('+order.length+')';$eaLeft.appendChild(fe);
        order.forEach(function(base){
          var tiers = bases[base];
          var m = tiers[0];
          var uids = tiers.map(function(t){return t.uid;});
          _eaTierGroups[m.uid] = uids;
          var wiredUids = uids.filter(function(u){return !!_eaWireMap[u];});
          var isWired = wiredUids.length > 0;
          var anyProt = tiers.some(function(t){return t.protected;});
          var isPending = _eaSelLeft===m.uid && _eaSelRight;
          var el=document.createElement('div');
          el.className='ea-model'+(isWired?' wired':'')+(anyProt&&!isWired?' protected':'')+(isPending?' wire-pending':'')+(_eaSelLeft===m.uid&&!isPending?' sel':'');
          el.setAttribute('data-uid', m.uid);
          el.setAttribute('data-uids', uids.join(','));
          var dot=document.createElement('span');dot.className='ea-route-dot'+(isWired?'':' off');el.appendChild(dot);
          var txt=document.createElement('span');txt.textContent=(tiers.length>1?base:(m.displayName||m.uid));txt.style.flex='1 1 auto';txt.style.overflow='hidden';txt.style.textOverflow='ellipsis';el.appendChild(txt);
          if(tiers.length>1){var tb=document.createElement('span');tb.className='ea-tier-fold';tb.textContent='\u00d7'+tiers.length;tb.title=uids.map(function(u){return _tierLabel(u,base)+(_eaWireMap[u]?' \u2713':'');}).join(' \u00b7 ');el.appendChild(tb);}
          // ★ v9.9.101 · 模型状态徽章 (provider/isPremium/isBeta/isNew/isRecommended)
          if(m.providerName&&m.providerName!=='UNSPECIFIED'&&m.providerName!=='WINDSURF'){var pt=document.createElement('span');pt.className='ea-prov-tag';pt.textContent=m.providerName.substring(0,4);pt.title=m.providerName;el.appendChild(pt);}
          if(m.isPremium){var ppb=document.createElement('span');ppb.className='ea-status-badge premium';ppb.textContent='\u2605';ppb.title='Premium';el.appendChild(ppb);}
          if(m.isBeta){var bb=document.createElement('span');bb.className='ea-status-badge beta';bb.textContent='\u03b2';bb.title='Beta';el.appendChild(bb);}
          if(m.isNew){var nb=document.createElement('span');nb.className='ea-status-badge new';nb.textContent='N';nb.title='New';el.appendChild(nb);}
          if(m.isRecommended){var rb=document.createElement('span');rb.className='ea-status-badge recommended';rb.textContent='\u2714';rb.title='Recommended';el.appendChild(rb);}
          if(anyProt&&!isWired){var pb=document.createElement('span');pb.className='ea-prot-badge';pb.textContent='\u9501';pb.title='\u4fdd\u62a4(\u70b9\u51fb\u89e3\u9501)';el.appendChild(pb);
            pb.addEventListener('click',function(e){e.stopPropagation();_daoConfirm('\u89e3\u9501 '+base+' (全部'+uids.length+'档)?').then(function(ok){if(!ok)return;Promise.all(uids.map(function(u){return fPost('/origin/ea/model-unlock',{modelUid:u,unlock:true});})).then(function(){eaLoad();});});});
          }
          if(isWired){var wb=document.createElement('span');wb.className='ea-wire-badge';wb.textContent='\u2713'+(tiers.length>1?wiredUids.length+'/'+tiers.length:'');wb.title='\u5df2\u8fde\u7ebf '+wiredUids.length+'/'+tiers.length+' (\u70b9\u51fb\u65ad\u5f00\u5168\u90e8)';el.appendChild(wb);}
          el.title=base+(tiers.length>1?' \u00b7 '+tiers.length+'档: '+uids.map(function(u){return _tierLabel(u,base);}).join('/'):'')+(m.providerName?' ['+m.providerName+']':'')+(isWired?' \u00b7 \u5df2\u8fde\u7ebf '+wiredUids.length+'/'+tiers.length:'')+(anyProt?' \u00b7 \u4fdd\u62a4':'');
          el.addEventListener('click',function(){
            var uid=this.getAttribute('data-uid');
            var gUids=(this.getAttribute('data-uids')||uid).split(',');
            var wired=gUids.filter(function(u){return !!_eaWireMap[u];});
            if(wired.length>0){_daoConfirm('\u65ad\u5f00 '+base+' 全部'+wired.length+'条路由?').then(function(ok){if(!ok)return;Promise.all(wired.map(function(u){return fDel('/origin/ea/route/'+encodeURIComponent(u));})).then(function(){_eaSelLeft=null;eaLoad();$eaInfo.textContent='\u2716 \u5df2\u65ad\u5f00 '+wired.length+'条';});});return;}
            if(_eaSelLeft===uid){_eaSelLeft=null;eaRender();return;}
            _eaSelLeft=uid;
            if(_eaSelRight){eaAutoConnect();}else{eaRender();}
          });
          $eaLeft.appendChild(el);
        });
      });
    }
    }
    // ── RIGHT: 外接模型 ──
    $eaRight.innerHTML = '';
    var providers=d.providers||{}, hasRight=false;
    var rightModels = [];
    for(var pn in providers){var p=providers[pn];
      var pMods = p.models || p._models;
      var pDisp = (p && p._label) ? p._label : pn;
      if(pMods&&pMods.length>0){pMods.forEach(function(mn){
        var key=pn+'/'+mn, wiredUid=null;
        for(var u in _eaWireMap){if(_eaWireMap[u].rightKey===key){wiredUid=u;break;}}
        rightModels.push({key:key,prov:pn,provDisp:pDisp,model:mn,wiredUid:wiredUid});
      });}
    }
    if ($eaRightCount) $eaRightCount.textContent = rightModels.length ? rightModels.length : '';
    if(rightModels.length===0){
      $eaRight.innerHTML='<div style="opacity:0.4;font-style:italic">\u6dfb\u52a0Provider\u540e\u663e\u73b0</div>';
    } else {
      rightModels.forEach(function(rm){
        var isWired=!!rm.wiredUid;
        var isPending=_eaSelRight===rm.key&&_eaSelLeft;
        var el=document.createElement('div');
        el.className='ea-model'+(isWired?' wired':'')+(isPending?' wire-pending':'')+(_eaSelRight===rm.key&&!isPending?' sel':'');
        el.setAttribute('data-key',rm.key);el.setAttribute('data-prov',rm.prov);el.setAttribute('data-model',rm.model);
        var dot=document.createElement('span');dot.className='ea-route-dot'+(isWired?'':' off');el.appendChild(dot);
        var txt=document.createElement('span');txt.textContent=rm.model;txt.style.flex='1 1 auto';txt.style.overflow='hidden';txt.style.textOverflow='ellipsis';el.appendChild(txt);
        if(isWired){var wb=document.createElement('span');wb.className='ea-wire-badge';wb.textContent='\u2713';wb.title='\u5df2\u8fde\u7ebf(\u70b9\u51fb\u65ad\u5f00)';el.appendChild(wb);}
        var provTag=document.createElement('span');provTag.className='ea-prov-tag';provTag.textContent=rm.provDisp;el.appendChild(provTag);
        el.title=rm.provDisp+'/'+rm.model+(isWired?' \u00b7 \u5df2\u8fde\u7ebf':'');
        el.addEventListener('click',function(){
          var key=this.getAttribute('data-key');
          // ★ v9.9.98 · 点击已连线右侧模型 → 断线
          if(isWired){_daoConfirm('\u65ad\u5f00 '+rm.prov+'/'+rm.model+'?').then(function(ok){if(!ok)return;fDel('/origin/ea/route/'+encodeURIComponent(rm.wiredUid)).then(function(r){if(r.ok){_eaSelRight=null;eaLoad();$eaInfo.textContent='\u2716 \u5df2\u65ad\u5f00';}});});return;}
          if(_eaSelRight===key){_eaSelRight=null;eaRender();return;}
          _eaSelRight=key;
          if(_eaSelLeft){eaAutoConnect();}else{eaRender();}
        });
        $eaRight.appendChild(el);hasRight=true;
      });
    }
    // ── SVG WIRES ──
    eaDrawWires();
    // ── provider list ──
    $eaProvList.innerHTML='';
    for(var pn in providers){var p=providers[pn];
      if(p&&p._builtin)continue; // 测试通道为内置·不可编辑/删除
      var pi=document.createElement('div');pi.className='ea-prov-item';
      pi.innerHTML='<span class="ea-prov-name">'+pn+'</span><span class="ea-prov-url">'+(p.baseUrl||'')+'</span><span class="ea-edit-prov" data-prov="'+pn+'" title="\u7f16\u8f91" style="cursor:pointer;opacity:0.6;margin-right:4px">\u270e</span><span class="ea-del-prov" data-prov="'+pn+'">\u2716</span>';
      $eaProvList.appendChild(pi);
    }
    $eaProvList.querySelectorAll('.ea-del-prov').forEach(function(btn){
      btn.addEventListener('click',function(){var n=this.getAttribute('data-prov');_daoConfirm('\u5220\u9664Provider '+n+'?').then(function(ok){if(!ok)return;fDel('/origin/ea/provider/'+encodeURIComponent(n)).then(function(r){if(r.ok)eaLoad();});});});
    });
    // ★ v9.9.102 · Provider 编辑（CRUD 补全）
    $eaProvList.querySelectorAll('.ea-edit-prov').forEach(function(btn){
      btn.addEventListener('click',function(){
        var n=this.getAttribute('data-prov');
        var p=(_eaData&&_eaData.providers&&_eaData.providers[n])||{};
        _eaOpenProvForm({name:n,baseUrl:p.baseUrl,apiKey:p.apiKey,type:p.type,models:p.models||p._models});
      });
    });
    var pc=Object.keys(providers).length;
    $eaInfo.textContent='P'+pc+' R'+rc+(d.ea_running?' \u2713':'');
  }

  // ── add provider (v9.9.94: +type) · v9.9.102: cc-switch 预设 + 编辑 ──
  // ★ v9.9.102 · cc-switch 风格 Provider 预设库（baseUrl/默认模型取自 cc-switch presets）
  var _EA_PRESETS = [
    {n:'DeepSeek',t:'openai',u:'https://api.deepseek.com/v1',m:'deepseek-chat, deepseek-reasoner'},
    {n:'Zhipu GLM',t:'openai',u:'https://open.bigmodel.cn/api/paas/v4',m:'glm-4.6'},
    {n:'Kimi',t:'openai',u:'https://api.moonshot.cn/v1',m:'kimi-k2-5'},
    {n:'Bailian',t:'openai',u:'https://dashscope.aliyuncs.com/compatible-mode/v1',m:'qwen3-coder-plus'},
    {n:'SiliconFlow',t:'openai',u:'https://api.siliconflow.cn/v1',m:'deepseek-ai/DeepSeek-V3'},
    {n:'MiniMax',t:'openai',u:'https://api.minimaxi.com/v1',m:'MiniMax-M2'},
    {n:'ModelScope',t:'openai',u:'https://api-inference.modelscope.cn/v1',m:'Qwen/Qwen3-Coder-480B-A35B-Instruct'},
    {n:'OpenRouter',t:'openai',u:'https://openrouter.ai/api/v1',m:'anthropic/claude-sonnet-4.6'},
    {n:'AiHubMix',t:'openai',u:'https://aihubmix.com/v1',m:'gpt-4o'},
    {n:'OpenAI',t:'openai',u:'https://api.openai.com/v1',m:'gpt-4o, gpt-4o-mini'},
    {n:'Anthropic',t:'anthropic',u:'https://api.anthropic.com',m:'claude-sonnet-4-6, claude-opus-4-6'},
    {n:'Gemini',t:'openai',u:'https://generativelanguage.googleapis.com/v1beta/openai',m:'gemini-2.5-pro, gemini-2.5-flash'},
    {n:'xAI Grok',t:'openai',u:'https://api.x.ai/v1',m:'grok-3-mini'},
    {n:'Volcengine \u706b\u5c71',t:'openai',u:'https://ark.cn-beijing.volces.com/api/v3',m:'deepseek-v3-250324'},
    {n:'Z.AI Coding',t:'openai',u:'https://api.z.ai/api/coding/paas/v4',m:'glm-4.6'},
    {n:'Novita',t:'openai',u:'https://api.novita.ai/openai',m:'deepseek/deepseek-v3'},
    {n:'NVIDIA NIM',t:'openai',u:'https://integrate.api.nvidia.com/v1',m:'deepseek-ai/deepseek-r1'},
    {n:'StepFun \u9636\u8dc3',t:'openai',u:'https://api.stepfun.com/v1',m:'step-2-16k'},
    {n:'TheRouter',t:'openai',u:'https://api.therouter.ai/v1',m:'deepseek-v3'},
    {n:'NewAPI/\u81ea\u5efa',t:'custom',u:'',m:''}
  ];
  var $eaPPreset = document.getElementById('eaPPreset');
  var $eaPModels = document.getElementById('eaPModels');
  if ($eaPPreset) {
    var op0 = document.createElement('option'); op0.value=''; op0.textContent='\u2014'; $eaPPreset.appendChild(op0);
    _EA_PRESETS.forEach(function(p,i){ var op=document.createElement('option'); op.value=String(i); op.textContent=p.n; $eaPPreset.appendChild(op); });
    $eaPPreset.addEventListener('change', function(){
      var p = _EA_PRESETS[parseInt(this.value)];
      if (!p) return;
      $eaPName.value = p.n.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      $eaPUrl.value = p.u; $eaPType.value = p.t;
      if ($eaPModels) $eaPModels.value = p.m;
      $eaPKey.focus();
    });
  }
  function _eaOpenProvForm(prefill) {
    $eaProvForm.classList.add('show');
    $eaRouteForm.classList.remove('show');
    if (prefill) {
      $eaPName.value = prefill.name || '';
      $eaPUrl.value = prefill.baseUrl || '';
      $eaPKey.value = prefill.apiKey || '';
      $eaPType.value = prefill.type === 'anthropic' ? 'anthropic' : (prefill.type === 'custom' ? 'custom' : 'openai');
      if ($eaPModels) $eaPModels.value = (prefill.models||[]).join(', ');
      $eaPKey.focus();
    } else { $eaPName.focus(); }
  }
  $eaAddProv.addEventListener('click', function() {
    if ($eaProvForm.classList.contains('show')) { $eaProvForm.classList.remove('show'); return; }
    _eaOpenProvForm(null);
  });
  $eaProvSave.addEventListener('click', function() {
    var name = $eaPName.value.trim();
    var url = $eaPUrl.value.trim();
    var key = $eaPKey.value.trim();
    var type = $eaPType.value;
    if (!name || !url) return;
    var cfg = { baseUrl: url, apiKey: key, type: type };
    if ($eaPModels && $eaPModels.value.trim()) {
      cfg.models = $eaPModels.value.split(',').map(function(s){return s.trim();}).filter(Boolean);
    }
    fPost('/origin/ea/provider', { name: name, cfg: cfg }).then(function(r) {
      if (r.ok) {
        $eaPName.value='';$eaPUrl.value='';$eaPKey.value='';
        if ($eaPModels) $eaPModels.value='';
        if ($eaPPreset) $eaPPreset.value='';
        $eaProvForm.classList.remove('show');
        eaLoad();
        // ★ v9.9.262 · 首provider自动默认路由反馈 · SWE 1.6 Fast 已接通该渠道
        if (r.autoRoute) {
          try { $eaInfo.textContent = '\u2714 \u9ed8\u8ba4\u8def\u7531 SWE 1.6 Fast \u2192 '+r.autoRoute; } catch(e){}
        }
      } else { $eaInfo.textContent = '\u2716 '+(r.error||'fail'); }
    });
  });
  $eaProvCancel.addEventListener('click', function() { $eaProvForm.classList.remove('show'); });

  // ── probe ──
  $eaProbe.addEventListener('click', function() {
    $eaInfo.textContent = '\u63a2\u6d4b\u4e2d...';
    fPost('/origin/ea/probe', {}).then(function(r) {
      if (r.ok && r.providers) {
        if (_eaData && _eaData.providers) {
          for (var pn in r.providers) {
            if (_eaData.providers[pn]) {
              _eaData.providers[pn]._healthy = r.providers[pn].healthy;
              _eaData.providers[pn]._models = r.providers[pn].models || [];
            }
          }
        }
        eaRender();
        $eaInfo.textContent = '\u2714 \u63a2\u6d4b\u5b8c';
      } else { $eaInfo.textContent = '\u2716 \u63a2\u6d4b\u5931\u8d25'; }
    }).catch(function() { $eaInfo.textContent = '\u2716 \u7f51\u7edc'; });
  });

  // ── v9.9.95 · discover models (RPC实证) ──
  var $eaDiscover = document.getElementById('eaDiscover');
  $eaDiscover.addEventListener('click', function() {
    $eaInfo.textContent = '\u53d1\u73b0\u4e2d...';
    fJson('/origin/ea/discover-models').then(function(r) {
      if (r && r.ok) {
        $eaInfo.textContent = '\u2714 RPC:'+r.sources.rpc+' Seen:'+r.sources.seen+' \u5171'+r.count;
        if (_eaData) {
          _eaData.available_models = r.models;
          _eaData.seen_models = r.models;
          eaRender();
        }
      } else { $eaInfo.textContent = '\u2716 \u53d1\u73b0\u5931\u8d25'; }
    }).catch(function() { $eaInfo.textContent = '\u2716 \u7f51\u7edc'; });
  });

  // ── v9.9.95 · test chat (全链路) ──
  var $eaTestChat = document.getElementById('eaTestChat');
  $eaTestChat.addEventListener('click', function() {
    if (!_eaSelLeft) { $eaInfo.textContent = '\u8bf7\u5148\u9009\u62e9\u5de6\u4fa7\u6a21\u578b'; return; }
    if (!_eaData || !_eaData.routes || !_eaData.routes[_eaSelLeft]) { $eaInfo.textContent = '\u8be5\u6a21\u578b\u65e0\u8def\u7531'; return; }
    $eaInfo.textContent = '\u6d4b\u8bd5\u4e2d...';
    fPost('/origin/ea/test-chat', { modelUid: _eaSelLeft, message: 'ping' }).then(function(r) {
      if (r && r.ok) {
        $eaInfo.textContent = '\u2714 '+r.provider+'/'+r.model+' '+r.elapsed_ms+'ms '+(r.content?r.content.substring(0,30):'');
      } else {
        $eaInfo.textContent = '\u2716 '+(r&&r.error?r.error:'\u6d4b\u8bd5\u5931\u8d25');
      }
    }).catch(function() { $eaInfo.textContent = '\u2716 \u7f51\u7edc'; });
  });

  // ── clear all routes ──
  $eaClearRoutes.addEventListener('click', function() {
    if (!_eaData || !_eaData.routes) return;
    var uids = Object.keys(_eaData.routes);
    if (uids.length === 0) { $eaInfo.textContent = '\u65e0\u8def\u7531'; return; }
    _daoConfirm('\u6e05\u7a7a\u6240\u6709 '+uids.length+' \u6761\u8def\u7531?').then(function(ok){
    if(!ok)return;
    var proms = uids.map(function(uid){ return fDel('/origin/ea/route/'+encodeURIComponent(uid)); });
    Promise.all(proms).then(function(){ _eaSelLeft=null;_eaSelRight=null;eaLoad(); });
    });
  });

  // ★ v9.9.97 · 热切换回退官方 · 反者道之动 · 一键回退
  var $eaFallback = document.getElementById('eaFallback');
  if ($eaFallback) {
    $eaFallback.addEventListener('click', function() {
      if (!_eaData || !_eaData.routes) return;
      var uids = Object.keys(_eaData.routes);
      if (uids.length === 0) { $eaInfo.textContent = '\u65e0\u8def\u7531\u53ef\u56de\u9000'; return; }
      _daoConfirm('\u70ed\u5207\u6362\u56de\u9000\u5b98\u65b9: \u5173\u95ed '+uids.length+' \u6761\u8def\u7531?').then(function(ok){
      if(!ok)return;
      $eaInfo.textContent = '\u23ea \u56de\u9000\u4e2d...';
      var proms = uids.map(function(uid){ return fPost('/origin/ea/route-toggle',{modelUid:uid,enabled:false}); });
      Promise.all(proms).then(function(){ _eaSelLeft=null;_eaSelRight=null;eaLoad(); $eaInfo.textContent = '\u23ea \u5df2\u56de\u9000\u5b98\u65b9'; });
      });
    });
  }

  // ★ v9.9.98 · 自动连线: 左+右都选中 → 自动创建路由 · 无为而无不为
  function eaAutoConnect() {
    if (!_eaSelLeft || !_eaSelRight) return;
    var parts = _eaSelRight.split('/');
    if (parts.length < 2) { $eaInfo.textContent = '\u2716 \u8bf7\u9009\u5916\u63a5\u6a21\u578b'; return; }
    var provName = parts[0], modelName = parts.slice(1).join('/');
    var maxTok = parseInt($eaRMaxTok.value) || 16384;
    // ★ v9.9.102 · 折叠组连线 → 全部档位一并路由
    var gUids = _eaTierGroups[_eaSelLeft] || [_eaSelLeft];
    $eaInfo.textContent = '\u27a1 \u8fde\u7ebf\u4e2d... ('+gUids.length+')';
    Promise.all(gUids.map(function(u){
      return fPost('/origin/ea/route', {
        modelUid: u,
        route: { provider: provName, model: modelName, maxOutputTokens: maxTok }
      });
    })).then(function(rs) {
      var okN = rs.filter(function(r){return r&&r.ok;}).length;
      if (okN > 0) {
        _eaSelLeft = null; _eaSelRight = null;
        eaLoad();
        $eaInfo.textContent = '\u2714 \u8fde\u7ebf\u6210\u529f '+okN+'/'+gUids.length;
      } else {
        $eaInfo.textContent = '\u2716 '+((rs[0]&&rs[0].error)||'\u8fde\u7ebf\u5931\u8d25');
        // ★ v9.9.98 · 连线失败 → 报错不回退 · 用户可见
        eaRender();
      }
    }).catch(function() { $eaInfo.textContent = '\u2716 \u7f51\u7edc\u9519\u8bef'; });
  }

  // ★ v9.9.98 · SVG连线绘制 · 大象无形 · 线从左到右
  function eaDrawWires() {
    if (!$eaWires) return;
    $eaWires.innerHTML = '';
    var wrapRect = $eaWireWrap.getBoundingClientRect();
    if (wrapRect.width < 10) return;
    $eaWires.setAttribute('width', wrapRect.width);
    $eaWires.setAttribute('height', wrapRect.height);
    // ★ v9.9.102 · 折叠卡：非主 uid 的连线回溯到所属折叠块
    function _leftElFor(uid) {
      var el = $eaLeft.querySelector('[data-uid="'+uid+'"]');
      if (el) return el;
      var all = $eaLeft.querySelectorAll('[data-uids]');
      for (var i = 0; i < all.length; i++) {
        if ((','+all[i].getAttribute('data-uids')+',').indexOf(','+uid+',') >= 0) return all[i];
      }
      return null;
    }
    var _drawn = {};
    for (var uid in _eaWireMap) {
      var wire = _eaWireMap[uid];
      var leftEl = _leftElFor(uid);
      if (leftEl) { var dk = leftEl.getAttribute('data-uid')+'>'+wire.rightKey; if (_drawn[dk]) continue; _drawn[dk] = 1; }
      var rightEl = $eaRight.querySelector('[data-key="'+wire.rightKey+'"]');
      if (!leftEl || !rightEl) continue;
      var lr = leftEl.getBoundingClientRect();
      var rr = rightEl.getBoundingClientRect();
      var x1 = lr.right - wrapRect.left;
      var y1 = lr.top + lr.height/2 - wrapRect.top;
      var x2 = rr.left - wrapRect.left;
      var y2 = rr.top + rr.height/2 - wrapRect.top;
      var mx = (x1 + x2) / 2;
      var path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2);
      path.setAttribute('class','ea-wire'+(wire.status==='err'?' err':''));
      $eaWires.appendChild(path);
    }
    // pending wire (selection in progress)
    if (_eaSelLeft && _eaSelRight) {
      var leftEl = _leftElFor(_eaSelLeft);
      var rightEl = $eaRight.querySelector('[data-key="'+_eaSelRight+'"]');
      if (leftEl && rightEl) {
        var lr = leftEl.getBoundingClientRect();
        var rr = rightEl.getBoundingClientRect();
        var x1 = lr.right - wrapRect.left;
        var y1 = lr.top + lr.height/2 - wrapRect.top;
        var x2 = rr.left - wrapRect.left;
        var y2 = rr.top + rr.height/2 - wrapRect.top;
        var mx = (x1 + x2) / 2;
        var path = document.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('d','M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2);
        path.setAttribute('class','ea-wire pending');
        $eaWires.appendChild(path);
      }
    }
  }

  // ── periodic refresh ──
  setInterval(function() { if (_eaOpen) eaLoad(); }, 15000);

  // boot · v9.7.6 · 执今之道 · boot 即拉 getCustomSP 预装 lastSP (帛书本源) · tape 空亦可编辑
  pingPull();
  pull();
  vsc.postMessage({ command: 'getCustomSP' });
  // v9.9.18 \u4fee\u590d \u00b7 boot \u5373\u8bf7\u6c42 extension host refresh \u63a8\u9001 {type:"data"} \u5305
  // \u8ba9\u4e09\u76cf/\u6309\u9215/SP\u663e\u793a\u5728\u65e0\u9700 portMapping \u7684\u60c5\u51b5\u4e0b\u4e5f\u80fd\u7acb\u5373\u66f4\u65b0
  vsc.postMessage({ command: 'refresh' });
  setTimeout(function(){ pingPull(); pull(); vsc.postMessage({ command: 'refresh' }); }, 3000);
  setInterval(sigTick, 5000);
  setInterval(pingPull, 10000);
  setInterval(pull, 30000);
  // v9.9.18+v9.9.36 \u00b7 \u5468\u671f refresh \u4fdd\u5e95 \u00b7 15s (\u539f 5s)
  setInterval(function() { vsc.postMessage({ command: 'refresh' }); }, 15000);
  // v9.9.20 jiqi · IIFE 全跑通 · 至此即活 · 上报 boot-done 标记
  // v9.9.22 · 加 canonChanged listener · 切经文真联动
  _wdbg('boot-done', 'boot', { listeners: 'btnDao,btnOff,canon,editToggle,editSave,editReload,editReset,eaToggle,eaAddProv,eaProbe,eaClearRoutes,eaConn,message[data,customSP,canonChanged]', ver: '9.9.94' });
})();
</script>
</body>
</html>`;
}

// ═══════════════════════════ icon.svg placeholder ═══════════════════════════
function ensureIconSvg() {
  const svgPath = path.join(__dirname, "media", "icon.svg");
  if (fs.existsSync(svgPath)) return;
  try {
    fs.mkdirSync(path.join(__dirname, "media"), { recursive: true });
    fs.writeFileSync(
      svgPath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7.5 7.5 0 0 0 0 15 5 5 0 0 1 0 5"/></svg>`,
    );
  } catch {}
}

// ═══════════════════════════ activate / deactivate ═══════════════════════════
let _essenceProvider = null;
// ★ 状态栏入口 · 五十二章「既得其母 以知其子」· 三模块面板唯一开门处
let _statusBarItem = null;
// ★ 模型解锁 · 首装即自化 · 全109模型现于选择器 (三十七章「万物将自化」)
let _modelUnlockDone = false;

// ★ 自动模型解锁 · 反代就位后调 /origin/model_unlock · 幂等 · 首装即全模可选
async function autoModelUnlock(port, attempt) {
  attempt = attempt || 0;
  if (_modelUnlockDone || !port) return;
  try {
    const status = await httpGetJson(
      `http://127.0.0.1:${port}/origin/model_unlock`,
      2000,
    );
    if (status && status.enabled === true) {
      _modelUnlockDone = true;
      L.info("modelUnlock", "已处解锁态 · 全模型自现 · 不复行");
      return;
    }
    const result = await httpPostJson(
      `http://127.0.0.1:${port}/origin/model_unlock`,
      { enabled: true },
      2500,
    );
    if (result && result.ok) {
      _modelUnlockDone = true;
      L.info(
        "modelUnlock",
        `首装自动解锁 ✅ · ${result.catalog_size || 0} 模型入选择器 · 执大象 天下往`,
      );
    } else if (attempt < 5) {
      setTimeout(() => autoModelUnlock(port, attempt + 1), 3000);
    }
  } catch (e) {
    if (attempt < 5) {
      setTimeout(() => autoModelUnlock(port, attempt + 1), 3000);
    } else {
      L.warn("modelUnlock", `自动解锁未成 (${attempt}): ${e && e.message}`);
    }
  }
}

// ★ 状态栏入口刷新 · 显模式/端口 · 点击开三模块中央面板
function refreshStatusBar() {
  if (!_statusBarItem) return;
  const mode = _cachedMode === "passthrough" ? "官" : "道";
  const port = _cachedPort || "—";
  _statusBarItem.text = `$(circuit-board) 道Agent Pro · ${mode}`;
  _statusBarItem.tooltip =
    `道Agent Pro · 模式=${_cachedMode || "invert"} · 端口=${port}\n` +
    `点击打开「本源观照 / 渠道配置 / 模型路由」三模块面板`;
  _statusBarItem.show();
}

function activate(ctx) {
  _activateTs = Date.now();
  try {
    cfg();
    _cachedAnchored = isAnchored();
    _cachedMode = vscode.workspace
      .getConfiguration("dao")
      .get("origin.defaultMode", "invert");

    // ★ v9.9.200 · ACP 模式检测 · 印222 · 反者道之动
    // 新版 Devin Desktop: devin.exe 存在 → Chat 走 ACP/stdio → HTTP MITM 无效
    // 检测: devin.exe 在 appRoot 扩展目录下 → 启用 stdio 中间人代理
    // v9.9.200fix2: 多策略检测 · vscode.env.appRoot 在 Devin Desktop 中可能不准
    //   实测: appRoot = "c:\Users\zhouyoukang\extensions" (非 E:\Windsurf\resources\app)
    //   策略: ① env.appRoot ② process.env.VSCODE_APPROOT ③ appPath推断 ④ 常见路径
    // 道义: 十四章「执古之道 · 以御今之有」· 多路径探测 · 不执一法
    try {
      const devinBin = process.platform === "win32" ? "devin.exe" : "devin";
      const subDir = path.join(
        "extensions",
        "windsurf",
        "devin",
        "bin",
        devinBin,
      );
      let devinPath = null;
      let detectedBy = "";

      // 策略1: vscode.env.appRoot
      const appRoot1 = vscode.env.appRoot;
      const p1 = path.join(appRoot1, subDir);
      if (fs.existsSync(p1)) {
        devinPath = p1;
        detectedBy = "env.appRoot";
      }

      // 策略2: process.env.VSCODE_APPROOT (Electron 主进程注入)
      if (!devinPath && process.env.VSCODE_APPROOT) {
        const p2 = path.join(process.env.VSCODE_APPROOT, subDir);
        if (fs.existsSync(p2)) {
          devinPath = p2;
          detectedBy = "VSCODE_APPROOT";
        }
      }

      // 策略3: 从 appPath (Devin.exe 主程序) 推断 → resources/app
      if (!devinPath && vscode.env.appHost) {
        // appHost 可能包含安装路径信息
        L.info("activate", `ACP检测: appHost=${vscode.env.appHost}`);
      }

      // 策略4: 从 process.execPath 推断 (Electron 主进程路径)
      if (!devinPath && process.execPath) {
        // process.execPath = E:\Windsurf\Devin.exe → appRoot = E:\Windsurf\resources\app
        const execDir = path.dirname(process.execPath);
        const p4 = path.join(execDir, "resources", "app", subDir);
        if (fs.existsSync(p4)) {
          devinPath = p4;
          detectedBy = "execPath";
        }
      }

      // 策略5: 常见安装路径 (Windows)
      if (!devinPath && process.platform === "win32") {
        const commonPaths = [
          path.join("E:\\Windsurf\\resources\\app", subDir),
          path.join("C:\\Windsurf\\resources\\app", subDir),
          path.join(
            process.env.LOCALAPPDATA || "",
            "Programs",
            "Windsurf",
            "resources",
            "app",
            subDir,
          ),
          path.join(
            process.env.PROGRAMFILES || "",
            "Windsurf",
            "resources",
            "app",
            subDir,
          ),
        ];
        for (const cp of commonPaths) {
          if (fs.existsSync(cp)) {
            devinPath = cp;
            detectedBy = "commonPath";
            break;
          }
        }
      }

      // 策略6: Linux/Mac 常见路径
      if (!devinPath && process.platform !== "win32") {
        const unixPaths = [
          "/usr/share/windsurf/resources/app",
          "/opt/windsurf/resources/app",
          "/snap/windsurf/current/resources/app",
          path.join(os.homedir(), ".windsurf", "resources", "app"),
        ];
        for (const up of unixPaths) {
          const p6 = path.join(up, subDir);
          if (fs.existsSync(p6)) {
            devinPath = p6;
            detectedBy = "unixPath";
            break;
          }
        }
      }

      if (devinPath) {
        _acpMode = true;
        _acpProxyPath = path.join(__dirname, "dao-acp-stdio-proxy.js");
        L.info(
          "activate",
          `★ ACP 模式检测: devin.exe=${devinPath} (${detectedBy}) → stdio proxy=${_acpProxyPath}`,
        );
      } else {
        L.info(
          "activate",
          `旧版模式: devin.exe 未找到 (appRoot=${appRoot1} execPath=${process.execPath})`,
        );
      }
    } catch (e) {
      L.warn("activate", `ACP 检测异常: ${e.message}`);
    }

    installSpawnHook();
    ensureIconSvg();

    L.info(
      "ext",
      `dao-proxy-pro v${PKG_VERSION} activate · port=${_cachedPort} anchored=${_cachedAnchored} acp=${_acpMode} user=${os.userInfo().username}`,
    );

    // 道德经横幅 (默认关 · 不言之教)
    if (vscode.workspace.getConfiguration("dao").get("origin.banner", false)) {
      const q = DAO_QUOTES[Math.floor(Math.random() * DAO_QUOTES.length)];
      vscode.window.showInformationMessage(`道Agent v${PKG_VERSION} · ${q}`);
    }

    // 注册命令
    ctx.subscriptions.push(
      vscode.commands.registerCommand("wam.originInvert", cmdInvert),
      vscode.commands.registerCommand("wam.originPassthrough", cmdPassthrough),
      vscode.commands.registerCommand("dao.toggleMode", cmdToggle),
      vscode.commands.registerCommand("dao.openPreview", cmdOpenPreview),
      vscode.commands.registerCommand("wam.verifyEndToEnd", cmdVerifyE2E),
      vscode.commands.registerCommand("wam.selftest", cmdSelftest),
      // v9.9.0 · 印 124 · 第一细药 · 外接 api 开关 (默关 · 主公一字开)
      vscode.commands.registerCommand(
        "dao.外接api.toggle",
        cmdExternalApiToggle,
      ),
      // ★ v9.9.90 · 外接api 热配置面板 · 五十七章「我无为也 而民自化」
      vscode.commands.registerCommand("dao.eaConfig", cmdEaConfig),
      // v9.9.29 · 印 160 · 终端会话池 (反者道之动 · 七层污染一招治)
      vscode.commands.registerCommand("dao.term.exec", cmdTermExec),
      vscode.commands.registerCommand("dao.term.list", cmdTermList),
      vscode.commands.registerCommand("dao.term.close", cmdTermClose),
      // ★ v9.9.260 · 模型解锁 · 执大象 天下往
      vscode.commands.registerCommand(
        "dao.modelUnlock.toggle",
        cmdModelUnlockToggle,
      ),
      vscode.commands.registerCommand(
        "dao.modelUnlock.status",
        cmdModelUnlockStatus,
      ),
    );

    // 注册 webview
    _essenceProvider = new EssenceProvider(ctx);
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "dao.essence",
        _essenceProvider,
        {
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    );

    // ★ 状态栏入口 (右下角) · 仿 rt-flow · 点击开三模块中央面板
    // 五十二章「既得其母 以知其子」· 解「面板无处可开」之疾
    _statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    _statusBarItem.command = "dao.eaConfig";
    refreshStatusBar();
    ctx.subscriptions.push(_statusBarItem);

    // ★ 首装即自化 · 反代就位后自动解锁全模型 (含retry · 渡proxy启动窗)
    // 三十七章「侯王若能守之 万物将自化」· 解「装后仅 SWE1.6」之疾
    setTimeout(() => {
      autoModelUnlock(_cachedPort);
      refreshStatusBar();
    }, 8000);

    // v9.4.2 · 自 focus dao-container · 强制 resolveWebviewView 触发 · SSR 帛书立现
    // 三十七章: 道恒无名 · 侯王若能守之 · 万物将自化
    // 首装 / 重装 / 更新后 · 侧栏可能默 collapse · 一focus即开 · 主公无需手动
    // v9.9.36 · 5s 延迟 (原 500ms) · 渡过 "Installation modified" 危窗后再强制 focus
    setTimeout(() => {
      try {
        vscode.commands.executeCommand(
          "workbench.view.extension.dao-container",
        );
        L.info("activate", "focus dao-container · webview 自化");
      } catch (e) {
        L.warn("activate", `focus fail: ${e.message}`);
      }
    }, 5000);

    // ── 真药 D · activate 不杀 LS · 为道日损 (四十八章) ──
    // 首装/恢复 仅启 proxy + 锚 settings + 装 hook, 不主动 forceRestartLS
    // LS 自然重启时 spawn hook 自挂; 用户欲即时切换可显式调 wam.originInvert

    // ★ v9.9.261 · 反者道之动 · ACP 模式也启 HTTP 代理 + 锚 settings
    // 印222原判: Chat 走 ACP/stdio → HTTP MITM 无用且有害
    // 实证推翻: session/new + session/prompt 走 gRPC CascadeService (非 ACP stdio)
    //   ACP stdio 仅见 initialize/authenticate/session/list · 无对话消息
    //   gRPC 经 NodeService:12817 → NetworkService → HTTP 代理 → 后端
    //   故 HTTP MITM 仍是 SP 注入 + 外接 API 路由的唯一有效通道
    // 道义: 四十章「反也者 道之动也」· 印222之判反 · 今正之
    if (_acpMode) {
      L.info(
        "activate",
        `★ ACP模式 + HTTP代理双启 · stdio代理管ACP管理消息 · HTTP代理管gRPC对话`,
      );
      // ACP 模式下也启动 HTTP 代理 + 锚定 · 因对话走 gRPC/HTTP
      const _originalPort = _cachedPort;
      proxyStart(_cachedPort, _cachedMode || "invert")
        .then((handle) => {
          if (!handle) {
            L.warn("activate", "ACP+HTTP: 端口占且非反代 · watchdog 将重试");
            return;
          }
          proxySetMode(_cachedMode || "invert");
          L.info("activate", "ACP+HTTP: proxy 就位 · 延迟锚定");
          // ★ v9.9.261 · EACCES 回退后需 forceRestartLS · LS 仍指向旧端口
          if (_cachedPort !== _originalPort) {
            L.info(
              "activate",
              `ACP+HTTP: 端口回退 ${_originalPort}→${_cachedPort} · forceRestartLS`,
            );
            forceRestartLS();
          }
          // 延迟锚定 · 渡过 "Installation modified" 危窗
          _deferredAnchorTimer = setTimeout(async () => {
            _deferredAnchorTimer = null;
            try {
              await setAnchor(_cachedPort);
              L.info("activate", "ACP+HTTP: deferred anchor 写入完成");
            } catch (e) {
              L.warn(
                "activate",
                `ACP+HTTP: deferred anchor fail: ${e.message}`,
              );
            }
          }, 15000);
        })
        .catch((e) => {
          L.error("activate", `ACP+HTTP: proxy start fail: ${e.message}`);
        });
    } else if (_cachedAnchored) {
      L.info("activate", "settings anchored → auto-restore proxy");
      proxyStart(_cachedPort, _cachedMode || "invert")
        .then((handle) => {
          if (!handle) {
            // v9.9.38 · 不清锚 · spawn hook 已无条件重写 · watchdog 后续会重试
            L.warn(
              "activate",
              "auto-restore: 端口占且非反代 · spawn hook 仍工作 · watchdog 将重试",
            );
            return;
          }
          proxySetMode(_cachedMode || "invert");
          L.info("activate", "auto-restore done");
        })
        .catch((e) => {
          L.error("activate", `auto-restore fail: ${e.message}`);
        });
    } else {
      // v9.9.36 · 道法自然 · 延迟锚定 · 避 "Installation modified" 写风暴
      // ════════════════════════════════════════════════════════════
      // 真因 (日志实证 · window23/24/25 三窗口一致复现):
      //   activate 立写 settings.json → ~800ms → "Installation has been modified on disk"
      //   → renderer 关 MessagePort → ext-host 死(2s寿命) → deactivate 清锚
      //   → 新 ext-host 再写 → 5s 内 3 次写 settings.json · 连环重载
      // 真治:
      //   内存先锚 (spawn hook + proxy 立即可用) · 文件锚延 15s 后写入
      //   渡过 "Installation modified" 危窗 · ext-host 存活后才持久化
      // 道义: 四十八「为道日损 · 损之又损 · 以至于无为」
      //       七十六「兵强则不胜 · 木强则折」· 柔弱处上
      // ════════════════════════════════════════════════════════════
      L.info("activate", "not anchored → 温和自启 · 延迟锚定 (不杀 LS)");
      (async () => {
        let handle;
        try {
          handle = await proxyStart(_cachedPort, _cachedMode || "invert");
        } catch (e) {
          L.error("activate", `first-run proxy fail: ${e.message}`);
          return;
        }
        if (!handle) {
          // v9.9.38 · 不跳过 · spawn hook 已无条件重写 · watchdog 后续会重试
          L.warn(
            "activate",
            "first-run: 端口占且非反代 · spawn hook 仍工作 · watchdog 将重试",
          );
          // 仍然设内存锚 + 延迟文件锚 · 确保一致性
        }
        proxySetMode(_cachedMode || "invert");
        // 内存先锚 · spawn hook 立即生效 · 文件延后
        _cachedAnchored = true;
        _cachedProxyUrl = `http://127.0.0.1:${_cachedPort}`;
        L.info(
          "activate",
          "first-run: proxy 就位 · 内存锚定 · 文件锚 15s 后写入",
        );
        // 延迟写 settings.json · 渡过 "Installation modified" 危窗
        _deferredAnchorTimer = setTimeout(async () => {
          _deferredAnchorTimer = null;
          try {
            await setAnchor(_cachedPort);
            L.info("activate", "deferred anchor 写入完成 · 安全窗口");
          } catch (e) {
            L.warn(
              "activate",
              `deferred anchor fail (non-fatal): ${e.message}`,
            );
          }
        }, 15000);
      })();
    }

    // ── v9.4.7 · proxy watchdog · 自愈 ──
    // 道义: 五十一章「道生之 · 德畜之 · 长之育之 · 亭之毒之 · 养之覆之」
    // 每 30s 自检 proxy 活否; 死则起之 · 不假外求 · 此即"自愈"之德
    // 防 ext host 重启/proxy crash/EADDRINUSE 等致 LS 失锚 → Windsurf 卡死
    // ★ v9.9.261 · ACP 模式也需要 watchdog (对话走 gRPC/HTTP)
    {
      const watchdogId = setInterval(async () => {
        try {
          if (Date.now() - _activateTs < 20000) return; // v9.9.36 · 渡过启动危窗 · 20s 内不检
          if (!_cachedAnchored && !_proxyHandle) return; // 未锚 · 不主动起
          const port = _cachedPort;
          const ping = await httpGetJson(
            `http://127.0.0.1:${port}/origin/ping`,
            2000,
          ).catch(() => null);
          if (ping && ping.ok) {
            // v9.9.21 · 唯变所适 · 检远端版本 · 旧版触让位
            // ping.quitted=true → 远端已收 /_quit, 即将关 · 视为死 · 待重起
            // ping.self_file 旧 → 触版本升级链路 (proxyStart EADDRINUSE 内自治)
            if (ping.quitted === true) {
              L.warn("watchdog", `remote 已让位 (quitted=true) · 触重起`);
            } else if (_isRemoteStale(ping.self_file)) {
              L.warn(
                "watchdog",
                `remote stale self_file=${ping.self_file} · 触升级让位`,
              );
              // 主动 POST /_quit · 不等 proxyStart 之 EADDRINUSE 路径
              await httpPostJson(
                `http://127.0.0.1:${port}/origin/_quit`,
                { reason: `watchdog upgrade to v${PKG_VERSION}` },
                2000,
              ).catch(() => {});
              await new Promise((r) => setTimeout(r, 1500));
            } else {
              return; // 活且版本最新 · 安心
            }
          }
          L.warn("watchdog", `proxy 死/旧 · 重起 :${port}`);
          _proxyHandle = null;
          const handle = await proxyStart(port, _cachedMode || "invert").catch(
            (e) => {
              L.error("watchdog", `restart fail: ${e.message}`);
              return null;
            },
          );
          if (handle) {
            proxySetMode(_cachedMode || "invert");
            L.info("watchdog", "proxy 复活");
          }
        } catch (e) {
          L.error("watchdog", `tick err: ${e.message}`);
        }
      }, 60000);
      ctx.subscriptions.push({ dispose: () => clearInterval(watchdogId) });
      L.info("activate", "watchdog 启 · 60s 自愈一周");
    } // end if (!_acpMode) — ACP模式跳过watchdog

    // ── v9.9.29 真治 · 终端会话池 (印 160 · 七层污染一招治) ──
    // 主公诏 5/19 3:11: 「反者道之动 · 不依赖任何第三方 · 直接 dao-proxy-min 解决 · 推进到底 实现一切」
    // 真本源: shell 进程 cwd/env/$? 是 OS 物理单例 · 多 agent 共享必污
    // 真治: 每 sid 一独立 shell 子进程 · cp.spawn /k mode + sentinel 切片
    // 验: _test_v9929_term_pool.js · 15/15 PASS
    // v9.9.36 · 延迟启动 · 减轻 ext-host 启动期事件循环压力
    // 道义: 六十四「千里之行 始于足下」· 不争启动期 CPU · 渡过危窗再起
    setTimeout(() => {
      try {
        _startDaoTermService(ctx);
      } catch (e) {
        L.warn("term", `term service start fail (non-fatal): ${e.message}`);
      }
    }, 10000);

    // ── v9.9.0 · 印 124 · 第一细药 · 外接 api 自启 (默关) ──
    // 帛书六十三章: 图难于其易 · 为大于其细 · 终不为大 · 故能成其大
    // dao.外接api.enabled=true 才启 · 失败不影响 min 反代主体
    setTimeout(() => {
      tryStartExternalApi(ctx).catch((e) => {
        L.warn("外接api", `自启失 (non-fatal): ${e.message}`);
      });
    }, 12000);

    // ═══ v9.9.111 · CDP Bridge + 文件IPC · 反者道之动 · 从内部突破 ═══
    // 四十七章「不出于户 以知天下」· 通过CDP或文件IPC暴露vscode API
    // 关键发现: daoMod.require.call(daoMod,'vscode') 可获取vscode API
    //   vscode.extensions.getExtension('codeium.windsurf') → Windsurf主扩展
    //   vscode.workspace.getConfiguration('windsurf') → 配置
    //   vscode.commands.executeCommand(...) → 命令执行
    // ★ 全局暴露 (CDP Runtime.evaluate 可访问 globalThis)
    globalThis.__dao_cdp_bridge = {
      vscode,
      getPort: () => _cachedPort,
      getMode: () => _cachedMode,
      isAnchored: () => _cachedAnchored,
      getState: () => ({
        port: _cachedPort,
        mode: _cachedMode,
        anchored: _cachedAnchored,
        activateTs: _activateTs,
        pid: process.pid,
        user: os.userInfo().username,
      }),
      exec: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
      getConfig: (section, key) =>
        vscode.workspace.getConfiguration(section).get(key),
      getExtension: (id) => vscode.extensions.getExtension(id),
    };
    L.info(
      "activate",
      `CDP bridge exposed · globalThis.__dao_cdp_bridge · pid=${process.pid}`,
    );

    // ★ 文件IPC: 代理写命令 → extension host 执行 → 写回结果
    // 代理端: POST /origin/ea/vscode-cmd {cmd, args} → 写 _vscode_cmd.json
    // ext端: 轮询 _vscode_cmd.json → 执行 → 写 _vscode_result.json
    const _IPC_DIR = path.join(os.tmpdir(), "dao-vscode-ipc");
    const _CMD_FILE = path.join(_IPC_DIR, "cmd.json");
    const _RESULT_FILE = path.join(_IPC_DIR, "result.json");
    try {
      fs.mkdirSync(_IPC_DIR, { recursive: true });
    } catch {}
    let _lastCmdId = "";
    const _ipcWatch = setInterval(async () => {
      try {
        const raw = fs.readFileSync(_CMD_FILE, "utf8").trim();
        if (!raw) return;
        const cmd = JSON.parse(raw);
        if (cmd.id === _lastCmdId) return; // 已处理
        _lastCmdId = cmd.id;
        L.info(
          "ipc",
          `exec: ${cmd.cmd} ${JSON.stringify(cmd.args || []).substring(0, 100)}`,
        );
        let result, error;
        try {
          result = await vscode.commands.executeCommand(
            cmd.cmd,
            ...(cmd.args || []),
          );
          // 尝试序列化结果
          try {
            JSON.stringify(result);
          } catch {
            result = String(result);
          }
        } catch (e) {
          error = e.message;
        }
        fs.writeFileSync(
          _RESULT_FILE,
          JSON.stringify(
            {
              id: cmd.id,
              ok: !error,
              result: result ?? null,
              error: error || null,
              ts: Date.now(),
            },
            null,
            2,
          ),
        );
      } catch {} // 文件不存在或解析失败 → 静默
    }, 2000);
    ctx.subscriptions.push({ dispose: () => clearInterval(_ipcWatch) });
    L.info("activate", `文件IPC 启 · ${_IPC_DIR} · 2s轮询`);
  } catch (e) {
    L.error("activate", `FATAL activation error: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`道Agent 激活失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 印 161 · 损之又损 · 复归朴本 · 道法自然 (主公诏 5/19 「彻底去芜存菁」)
// ═══════════════════════════════════════════════════════════════════
// 此处原藏 v9.9.27 watchdog (~85 行) + v9.9.28 spawn cleanup (~140 行) + v9.9.31 净卸伴侣
// 真本源参毕 (印 164): 大道至简 · 官方卸载已完全足够
//   ext-host 死 → http server 自然 close · 永无孤儿
//   官方 [✘] + Reload Window → 物理目录自动删除 (含所有持存文件)
//   settings.json 锚清 → LS 重启直连官方 · 无需代码干预
// 道义: 四十八「损之又损 · 以至于无为 · 无为而无不为」
//       四十「反者道之动 · 弱者道之用」(反自制卸载 · 用官方机制之朴)
//       三十七「道恒无名 · 朴唯小 · 而天下弗敢臣 · 侯王若能守之 · 万物将自宾」
//       六十四「为之于其未有也 · 治之于其未乱也」(不固化 → 官方自然清)
async function deactivate() {
  L.info("ext", "deactivate");

  // v9.9.36 · 取消延迟锚定 (若 ext-host 在 15s 内被杀 · 文件未写 · 无需清)
  if (_deferredAnchorTimer) {
    clearTimeout(_deferredAnchorTimer);
    _deferredAnchorTimer = null;
    L.info(
      "deactivate",
      "cancelled deferred anchor · ext-host 早亡 · 文件未污染",
    );
  }

  const isLocal = _proxyHandle && _proxyHandle.server;
  const lifetime = _activateTs ? Date.now() - _activateTs : 0;

  // ① 先设透传 · 过渡期 LS 若仍连代理 · 透传至官方 · 不断不乱
  if (isLocal && _proxyHandle.setMode) {
    try {
      _proxyHandle.setMode("passthrough");
    } catch {}
  }

  // ② 立即断钩 · 新 LS 不再被截持
  _cachedAnchored = false;
  removeSpawnHook();

  // ③ 同步清锚 · v9.9.36 道法自然 · 短命 ext-host 不清锚
  // ════════════════════════════════════════════════════════════
  // 日志实证 (window23/24/25 三窗口一致):
  //   ext-host 存活 < 30s → 被 "Installation modified" 杀
  //   清锚导致下个 ext-host 重走 setAnchor → 再触写风暴 → 连环重载
  //   不清锚 → 下个 ext-host 走 "anchored → auto-restore" 快路 · 零写入
  // 道义: 七十六「兵强则不胜 · 木强则折」· 强清反害 · 柔保则安
  //       二十二「曲则金 · 枉则定」· 不争 · 故莫能与之争
  // ════════════════════════════════════════════════════════════
  if (isLocal && lifetime > 30000) {
    _clearAnchorFileSync();
    L.info(
      "deactivate",
      `清锚 · lifetime=${Math.round(lifetime / 1000)}s · 正常关闭`,
    );
  } else if (isLocal) {
    L.info(
      "deactivate",
      `保锚 · lifetime=${Math.round(lifetime / 1000)}s < 30s · 下次 auto-restore 零写入`,
    );
  }

  try {
    await tryStopExternalApi();
  } catch {}

  if (_essenceProvider) {
    _essenceProvider.dispose();
    _essenceProvider = null;
  }

  await proxyStop();

  L.info(
    "deactivate",
    isLocal
      ? `local: lifetime=${Math.round(lifetime / 1000)}s · ${lifetime > 30000 ? "清锚" : "保锚"} · 大道至简`
      : "remote: 仅停代理 · 无本地状态",
  );
}

// ═══════════════════════════════════════════════════════════════════
// v9.9.0 · 印 124 · 第一细药 · 外接 api 启停 helper
// ═══════════════════════════════════════════════════════════════════
// 帛书《老子》:
//   六十三章 · 图难其易 · 为大其细 · 终不为大 · 故能成其大
//   六十四章 · 为之于其未有也, 治之于其未乱也
//   四十八章 · 损之又损, 以至于无为, 无为而无不为
//
// 与 min 反代主体字节级正交:
//   反代核 :8889..8988 (per-user FNV) · 守 Cascade SP 注入之心 (字节级不动)
//   外接 api gateway :11635..11734 (per-user FNV) · 展 14 provider N 模选用之能
//   二轨不撞 · 道并行而不相悖

let _externalApiRuntime = null;

async function tryStartExternalApi(ctx) {
  // 默关 · 主公 dao.外接api.enabled=true 才启
  const enabled = vscode.workspace
    .getConfiguration("dao")
    .get("外接api.enabled", true);
  if (!enabled) {
    L.info("外接api", "已关闭 (dao.外接api.enabled=false) · 跳启");
    return null;
  }
  if (_externalApiRuntime && _externalApiRuntime.isRunning()) {
    L.info("外接api", "已运行 · 跳启");
    return _externalApiRuntime;
  }
  let ExternalApiRuntime;
  try {
    ({ ExternalApiRuntime } = require("./vendor/外接api/runtime.js"));
  } catch (e) {
    L.warn("外接api", `vendor/外接api/runtime.js 不加载: ${e.message}`);
    return null;
  }
  _externalApiRuntime = new ExternalApiRuntime({
    vscodeModule: vscode,
    logger: L,
    configKey: "dao.外接api",
    vendorPrefix: "dao-",
  });
  const status = await _externalApiRuntime.start();
  L.info(
    "外接api",
    `启 · gw=${status.gatewayUrl} · providers=${status.providers} · models=${status.models}`,
  );
  // 注入 dispose · 主进程退时 deactivate 已显式 stop · 此为兜底
  if (ctx && ctx.subscriptions) {
    ctx.subscriptions.push({
      dispose: () => {
        if (_externalApiRuntime) {
          _externalApiRuntime.stop().catch(() => {});
        }
      },
    });
  }
  return _externalApiRuntime;
}

async function tryStopExternalApi() {
  if (!_externalApiRuntime) return;
  try {
    await _externalApiRuntime.stop();
  } catch (e) {
    L.warn("外接api", `stop err: ${e.message}`);
  }
  _externalApiRuntime = null;
}

async function cmdExternalApiToggle() {
  try {
    const cfg = vscode.workspace.getConfiguration("dao");
    const cur = cfg.get("外接api.enabled", false);
    const next = !cur;
    await cfg.update(
      "外接api.enabled",
      next,
      vscode.ConfigurationTarget.Global,
    );
    if (next) {
      const rt = await tryStartExternalApi(null);
      if (rt) {
        const status = rt.getStatus();
        vscode.window.showInformationMessage(
          `道Agent · 外接 api 启 · ${status.providers} provider · ${status.models} 模 · gw=${status.gatewayUrl}`,
        );
      } else {
        vscode.window.showWarningMessage(
          `道Agent · 外接 api 启失 · 见 Output 道Agent 频道`,
        );
      }
    } else {
      await tryStopExternalApi();
      vscode.window.showInformationMessage("道Agent · 外接 api 已停");
    }
  } catch (e) {
    L.error("外接api", `toggle fail: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`外接 api toggle 失: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
// ★ v9.9.90 · 外接api 热配置 Webview · 道法自然 · 大道至简
//   五十七章「我无为也 而民自化」· 前端至简 · 后端至大
//   左: 用户可用模型 (官方) · 右: 外接API模型 · SVG连线
// ════════════════════════════════════════════════════════════════

function getEaConfigHtml(port, nonce) {
  const N = nonce || _genNonce();
  const proxyPort = port || 0;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${N}'; connect-src http://127.0.0.1:* http://localhost:*; img-src data:;">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
    font-size: 12px; line-height: 1.5;
    display: flex; flex-direction: column; padding: 8px;
  }
  /* ── 三模块 Tab 栏 ── */
  .dao-tabs {
    display: flex; gap: 4px; margin-bottom: 8px;
    border-bottom: 1px solid rgba(128,128,128,0.25); padding-bottom: 6px;
  }
  .dao-tab {
    padding: 5px 12px; font-size: 12px; cursor: pointer; user-select: none;
    border: 1px solid rgba(128,128,128,0.25); border-radius: 4px;
    background: transparent; color: var(--vscode-foreground); opacity: 0.7;
    font-family: inherit;
  }
  .dao-tab:hover { opacity: 1; }
  .dao-tab.active {
    opacity: 1; font-weight: 600;
    background: var(--vscode-button-background, rgba(0,127,212,0.25));
    color: var(--vscode-button-foreground, var(--vscode-foreground));
    border-color: var(--vscode-focusBorder, #007fd4);
  }
  .dao-pane { display: none; flex-direction: column; flex: 1; min-height: 0; }
  .dao-pane.active { display: flex; }
  /* ── 本源观照 (①) ── */
  .essence-card {
    padding: 14px; border-radius: 6px; margin-bottom: 10px;
    background: rgba(0,0,0,0.08); border: 1px solid rgba(128,128,128,0.2);
  }
  .essence-card h3 { font-size: 14px; margin-bottom: 8px; }
  .essence-card p { opacity: 0.75; margin-bottom: 10px; font-size: 12px; }
  .essence-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  /* ── 顶部: Provider 输入 ── */
  .provider-bar {
    display: flex; gap: 4px; align-items: center; flex-wrap: wrap;
    margin-bottom: 8px; padding: 6px; border-radius: 4px;
    background: rgba(0,0,0,0.08);
  }
  .provider-bar input {
    flex: 1; min-width: 80px; padding: 3px 6px; font-size: 11px;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 3px;
    background: var(--vscode-input-background, rgba(0,0,0,0.12));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: inherit; outline: none;
  }
  .provider-bar input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .provider-bar input::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6)); }
  .btn {
    padding: 3px 8px; font-size: 11px; border: 1px solid rgba(128,128,128,0.3);
    background: transparent; color: var(--vscode-foreground); cursor: pointer;
    border-radius: 3px; font-family: inherit; white-space: nowrap;
    transition: all 0.15s;
  }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .btn.add { border-color: #6bb86b; color: #6bb86b; }
  .btn.add:hover { background: rgba(107,184,107,0.15); }
  .btn.del { border-color: #e08080; color: #e08080; font-size: 10px; padding: 1px 4px; }
  .btn.del:hover { background: rgba(224,128,128,0.15); }
  .btn.probe { border-color: #80b0e0; color: #80b0e0; }
  .btn.probe:hover { background: rgba(128,176,224,0.15); }
  /* ── 连线图区域 ── */
  .wire-container {
    flex: 1; display: flex; gap: 0; overflow: hidden; border-radius: 4px;
    background: rgba(0,0,0,0.05); min-height: 200px;
  }
  .wire-col {
    flex: 1; display: flex; flex-direction: column; padding: 6px; overflow-y: auto;
  }
  .wire-col.left { border-right: 1px solid rgba(128,128,128,0.15); }
  .wire-col.right { }
  .wire-col h3 {
    font-size: 10px; opacity: 0.6; text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 4px; font-weight: 600;
  }
  .model-item {
    display: flex; align-items: center; gap: 4px; padding: 3px 6px;
    border-radius: 3px; margin-bottom: 2px; cursor: pointer;
    transition: background 0.15s; font-size: 11px;
  }
  .model-item:hover { background: rgba(128,128,128,0.1); }
  .model-item .dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .model-item .dot.routed { background: #6bb86b; }
  .model-item .dot.unrouted { background: rgba(128,128,128,0.3); }
  .model-item .dot.dead { background: #e08080; }
  .model-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-item .target { font-size: 9px; opacity: 0.55; }
  .model-item.selected { background: rgba(79,193,255,0.15); outline: 1px solid rgba(79,193,255,0.3); }
  /* ── SVG 连线 ── */
  .wire-svg {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 10;
  }
  .wire-line { stroke: rgba(107,184,107,0.5); stroke-width: 1.5; fill: none; }
  .wire-line.active { stroke: #6bb86b; stroke-width: 2; }
  .wire-line.dead { stroke: #e08080; stroke-dasharray: 4 2; }
  /* ── 底部状态 ── */
  .status-bar {
    margin-top: 6px; padding: 4px 6px; border-radius: 3px;
    background: rgba(0,0,0,0.05); font-size: 10px; opacity: 0.7;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .status-bar .pill {
    padding: 1px 5px; border-radius: 2px; background: rgba(128,128,128,0.12);
  }
  /* ── 路由编辑弹窗 ── */
  .route-modal {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center;
  }
  .route-modal.show { display: flex; }
  .route-modal-inner {
    background: var(--vscode-sideBar-background, #252526); border-radius: 6px;
    padding: 12px; min-width: 280px; max-width: 360px;
    border: 1px solid rgba(128,128,128,0.3);
  }
  .route-modal-inner h4 { font-size: 12px; margin-bottom: 8px; }
  .route-modal-inner select, .route-modal-inner input {
    width: 100%; padding: 3px 6px; font-size: 11px; margin-bottom: 6px;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 3px;
    background: var(--vscode-input-background, rgba(0,0,0,0.12));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: inherit; outline: none;
  }
  .route-modal-inner select:focus, .route-modal-inner input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .route-modal-actions { display: flex; gap: 6px; margin-top: 8px; }
</style>
</head>
<body data-port="${proxyPort}">
  <!-- ── 三模块 Tab 栏 ── -->
  <div class="dao-tabs">
    <button class="dao-tab active" data-pane="paneEssence">① 本源观照</button>
    <button class="dao-tab" data-pane="paneProvider">② 渠道配置</button>
    <button class="dao-tab" data-pane="paneRouter">③ 模型路由</button>
  </div>

  <!-- ① 本源观照 (IDE 左侧复刻) -->
  <div class="dao-pane active" id="paneEssence">
    <div class="essence-card">
      <h3>本源观照 · 道法自然</h3>
      <p>本模块复刻 IDE 左侧「本源观照」面板，承载底层提示词隔离替换、帛书《老子》《阴符经》本源注入与通路状态。点击下方按钮在侧栏展开完整视图，或在浏览器查看真实注入的 System Prompt。</p>
      <div class="essence-actions">
        <button class="btn add" id="btnOpenEssence">在侧栏展开完整本源观照</button>
        <button class="btn" id="btnOpenPreview">浏览器查看真实 SP</button>
        <button class="btn" id="btnModelStatus">查看全量模型目录</button>
      </div>
    </div>
    <div class="essence-card">
      <h3>通路探测 · 默认 SWE 1.6</h3>
      <p>未接外接 API 时，SWE 1.6（基础版）作静态通道探测：发消息若得固定回执，即证此路已通。接入第一个外接 API 后，SWE 1.6 Fast 自动路由至该模型；其余可在「③ 模型路由」手动连线官方/第三方模型，两类渠道并行不悖。</p>
    </div>
  </div>

  <!-- ② 渠道配置 (CC-Switch 风) -->
  <div class="dao-pane" id="paneProvider">
    <!-- 预设快加 (cc-switch 预设库) -->
    <div class="provider-bar" style="margin-bottom:4px">
      <select id="presetSelect" style="flex:1;min-width:120px;padding:3px 6px;font-size:11px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.12));color:var(--vscode-input-foreground,var(--vscode-foreground));font-family:inherit;outline:none">
        <option value="">— 选择预设渠道 (cc-switch) —</option>
      </select>
      <button class="btn add" id="btnApplyPreset" title="填入下方表单">填入预设</button>
    </div>
    <!-- Provider 输入 -->
    <div class="provider-bar">
      <input id="provName" placeholder="名称 (如 deepseek)" style="flex:0.5;min-width:60px">
      <input id="provUrl" placeholder="Base URL (如 https://api.deepseek.com)" style="flex:2">
      <input id="provKey" type="password" placeholder="API Key" style="flex:1">
      <input id="provModels" placeholder="模型 (逗号分隔, 可空)" style="flex:1.2">
      <button class="btn add" id="btnAddProv" title="添加 Provider">+ 添加</button>
      <button class="btn probe" id="btnProbe" title="探测所有 Provider 健康">探测</button>
    </div>
    <!-- 已配渠道列表 (cc-switch 风) -->
    <div id="channelList" style="flex:1;overflow-y:auto;margin-top:4px"></div>
  </div>

  <!-- ③ 模型路由 (官方 ↔ 第三方 连线) -->
  <div class="dao-pane" id="paneRouter">
    <!-- 连线图 -->
    <div class="wire-container" id="wireContainer" style="position:relative;">
      <div class="wire-col left" id="leftCol">
        <h3>官方模型</h3>
        <div id="officialModels"></div>
      </div>
      <div class="wire-col right" id="rightCol">
        <h3>外接模型</h3>
        <div id="externalModels"></div>
      </div>
      <svg class="wire-svg" id="wireSvg"></svg>
    </div>
  </div>

  <!-- 路由编辑弹窗 -->
  <div class="route-modal" id="routeModal">
    <div class="route-modal-inner">
      <h4 id="routeModalTitle">添加路由</h4>
      <div>
        <label style="font-size:10px;opacity:0.6">官方模型 UID</label>
        <input id="routeModelUid" placeholder="如 MODEL_SWE_1_6_FAST">
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">Provider</label>
        <select id="routeProvider"></select>
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">外接模型</label>
        <input id="routeExtModel" placeholder="如 deepseek-v4-flash">
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">Max Output Tokens</label>
        <input id="routeMaxTokens" type="number" value="16384" placeholder="16384">
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">
          <input type="checkbox" id="routeThinking"> Thinking 模式
        </label>
      </div>
      <div class="route-modal-actions">
        <button class="btn add" id="routeSave">保存</button>
        <button class="btn" id="routeCancel">取消</button>
      </div>
    </div>
  </div>

  <!-- 状态栏 -->
  <div class="status-bar" id="statusBar">
    <span id="statusText">加载中...</span>
  </div>

<script nonce="${N}">
(function() {
  'use strict';
  var _PORT = ${proxyPort};
  var _BASE = 'http://127.0.0.1:' + _PORT;

  function fJson(p, opts) {
    opts = opts || {};
    return fetch(_BASE + p, Object.assign({ cache: 'no-store' }, opts))
      .then(function(r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function fPost(p, body) {
    return fJson(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  function fDel(p) {
    return fetch(_BASE + p, { method: 'DELETE', cache: 'no-store' })
      .then(function(r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }

  // ── 状态 ──
  var _config = null;
  var _providers = {};        // overview.providers (含内置 builtin-stub 测试通道)
  var _routes = {};
  var _health = {};
  var _selectedLeft = null;
  var _selectedRight = null;
  // ★ v9.9.266 · 三模块面板 ③模型路由 与悬浮面板 eaRender 同源:
  //   统一走 /origin/ea/overview → official_families (49 家族·档位归一) + providers(首项=测试通道)
  //   反者道之动: 左侧不再着相于扁平 catalog 怪名 · 万物并育而不相害
  var _families = [];         // official_families: [{familyUid,label,provider,members:[{modelUid,tier,isDefault}],isNew,isRecommended}]
  var _tierGroups = {};       // primaryUid -> [memberUids]  (一族多档共用一条路由作用域)

  // ── cc-switch 预设库 (与悬浮面板 _EA_PRESETS 同步) ──
  var _PRESETS = [
    {n:'DeepSeek',t:'openai',u:'https://api.deepseek.com/v1',m:'deepseek-chat, deepseek-reasoner'},
    {n:'Zhipu GLM',t:'openai',u:'https://open.bigmodel.cn/api/paas/v4',m:'glm-4.6'},
    {n:'Kimi',t:'openai',u:'https://api.moonshot.cn/v1',m:'kimi-k2-5'},
    {n:'Bailian',t:'openai',u:'https://dashscope.aliyuncs.com/compatible-mode/v1',m:'qwen3-coder-plus'},
    {n:'SiliconFlow',t:'openai',u:'https://api.siliconflow.cn/v1',m:'deepseek-ai/DeepSeek-V3'},
    {n:'MiniMax',t:'openai',u:'https://api.minimaxi.com/v1',m:'MiniMax-M2'},
    {n:'ModelScope',t:'openai',u:'https://api-inference.modelscope.cn/v1',m:'Qwen/Qwen3-Coder-480B-A35B-Instruct'},
    {n:'OpenRouter',t:'openai',u:'https://openrouter.ai/api/v1',m:'anthropic/claude-sonnet-4.6'},
    {n:'AiHubMix',t:'openai',u:'https://aihubmix.com/v1',m:'gpt-4o'},
    {n:'OpenAI',t:'openai',u:'https://api.openai.com/v1',m:'gpt-4o, gpt-4o-mini'},
    {n:'Anthropic',t:'anthropic',u:'https://api.anthropic.com',m:'claude-sonnet-4-6, claude-opus-4-6'},
  ];

  // ── provider 名 → 友好显示 (与 eaRender _provLabel 同) ──
  function _provLabel(p) {
    p = String(p || '').replace(/^MODEL_PROVIDER_/, '');
    var M = {ANTHROPIC:'Claude',OPENAI:'GPT',GOOGLE:'Gemini',WINDSURF:'Windsurf',XAI:'Grok',DEEPSEEK:'DeepSeek',MOONSHOT:'Kimi',MOONSHOT_AI:'Kimi',FIREWORKS:'Fireworks',ZHIPU:'GLM',ZHIPU_AI:'GLM',MINIMAX:'Minimax'};
    return M[p] || (p ? p.charAt(0) + p.slice(1).toLowerCase() : 'Other');
  }

  // ── 加载配置 · v9.9.266 一站式 overview (与悬浮面板同源) ──
  function loadConfig() {
    return fJson('/origin/ea/overview').then(function(d) {
      if (!d || !d.ok) throw new Error('overview 未就绪');
      _config = d;
      _providers = d.providers || {};
      _routes = d.routes || {};
      _families = d.official_families || [];
      render();
    }).catch(function(e) {
      document.getElementById('statusText').textContent = '加载失败: ' + e.message;
    });
  }

  // ── 渲染 ──
  function render() {
    renderChannels();
    renderLeft();
    renderRight();
    renderWires();
    renderStatus();
  }

  // ── 路由命中判定: uid 双形归一 (MODEL_X_Y ↔ x-y 视为同一) ──
  function _norm(uid) { return String(uid || '').replace(/^MODEL_/, '').replace(/_/g, '-').toLowerCase(); }
  function _routeKeyFor(uid) {
    var n = _norm(uid), ks = Object.keys(_routes);
    for (var i = 0; i < ks.length; i++) { if (_norm(ks[i]) === n) return ks[i]; }
    return null;
  }
  function _routeFor(uid) { var k = _routeKeyFor(uid); return k ? _routes[k] : null; }

  // ── ② 渠道配置: cc-switch 风已配渠道列表 (内置测试通道置顶·不可删) ──
  function renderChannels() {
    var box = document.getElementById('channelList');
    if (!box) return;
    box.innerHTML = '';
    var names = Object.keys(_providers);
    if (names.length === 0) {
      box.innerHTML = '<div style="opacity:0.4;font-style:italic;padding:6px">暂无渠道 · 选预设或手动添加</div>';
      return;
    }
    names.forEach(function(name) {
      var p = _providers[name] || {};
      var builtin = !!p._builtin;
      var disp = p._label || name;
      var alive = _health[name] && _health[name].alive;
      var dotColor = builtin ? '#6bb86b' : (alive ? '#6bb86b' : (_health[name] ? '#e08080' : 'rgba(128,128,128,0.4)'));
      var mods = (p.models || p._models || []).join(', ');
      var row = document.createElement('div');
      row.className = 'model-item';
      row.style.cssText = 'align-items:flex-start;padding:6px;margin-bottom:4px;border:1px solid rgba(128,128,128,0.18);border-radius:4px;';
      var html = '<span class="dot" style="background:' + dotColor + ';margin-top:4px"></span>' +
        '<span style="flex:1;overflow:hidden">' +
          '<span style="font-weight:600">' + disp + (builtin ? ' <span style="opacity:0.5;font-weight:400">· 内置</span>' : '') + '</span>' +
          '<div style="font-size:9px;opacity:0.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (p.baseUrl || '') + '</div>' +
          (mods ? '<div style="font-size:9px;opacity:0.5">' + mods + '</div>' : '') +
        '</span>';
      if (!builtin) {
        html += '<span class="btn" data-edit="' + name + '" style="padding:1px 5px;font-size:10px;margin-right:3px" title="编辑">✎</span>' +
          '<span class="btn del" data-del="' + name + '" title="删除">x</span>';
      }
      row.innerHTML = html;
      box.appendChild(row);
    });
    box.querySelectorAll('[data-del]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var n = this.getAttribute('data-del');
        _daoConfirm('删除渠道 ' + n + '? (关联路由也会删除)').then(function(ok2) {
          if (!ok2) return;
          fDel('/origin/ea/provider/' + encodeURIComponent(n)).then(function(r) { if (r.ok) loadConfig(); });
        });
      });
    });
    box.querySelectorAll('[data-edit]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var n = this.getAttribute('data-edit');
        var p = _providers[n] || {};
        document.getElementById('provName').value = n;
        document.getElementById('provUrl').value = p.baseUrl || '';
        document.getElementById('provKey').value = '';
        document.getElementById('provModels').value = (p.models || p._models || []).join(', ');
      });
    });
  }

  function renderLeft() {
    var container = document.getElementById('officialModels');
    container.innerHTML = '';
    _tierGroups = {};
    // ★ v9.9.266 · 档位归一: 一族一项 (同 Cascade 顶层) · 按 provider 分组标题
    if (!_families || _families.length === 0) {
      container.innerHTML = '<div style="opacity:0.4;font-style:italic;padding:6px">加载中...</div>';
      return;
    }
    var groups = {}, order = [];
    _families.forEach(function(f) {
      var pl = _provLabel(f.provider);
      if (!groups[pl]) { groups[pl] = []; order.push(pl); }
      groups[pl].push(f);
    });
    order.forEach(function(pl) {
      var head = document.createElement('div');
      head.style.cssText = 'font-size:10px;opacity:0.5;margin:6px 0 2px;font-weight:600;';
      head.textContent = pl + ' (' + groups[pl].length + ')';
      container.appendChild(head);
      groups[pl].forEach(function(f) {
        var uids = f.members.map(function(mm){ return mm.modelUid; }).filter(Boolean);
        var defMember = f.members.filter(function(mm){ return mm.isDefault; })[0] || f.members[0];
        var primary = (defMember && defMember.modelUid) || uids[0] || f.familyUid;
        _tierGroups[primary] = uids;
        var wiredUids = uids.filter(function(u){ return !!_routeFor(u); });
        var isWired = wiredUids.length > 0;
        var route = isWired ? _routeFor(wiredUids[0]) : null;
        var target = route ? (route.provider + '/' + route.model) : '';
        var div = document.createElement('div');
        div.className = 'model-item' + (_selectedLeft === primary ? ' selected' : '');
        div.setAttribute('data-uid', primary);
        div.setAttribute('data-uids', uids.join(','));
        var html = '<span class="dot ' + (isWired ? 'routed' : 'unrouted') + '"></span>' +
          '<span class="name" title="' + f.label + (f.members.length > 1 ? ' · ' + f.members.length + '档' : '') + '">' + f.label + '</span>';
        if (f.members.length > 1) {
          html += '<span class="target" title="' + f.members.map(function(mm){ return (mm.tier || 'base') + (_routeFor(mm.modelUid) ? ' ✓' : ''); }).join(' · ') + '">×' + f.members.length + '</span>';
        }
        if (target) html += '<span class="target">' + target + '</span>';
        div.innerHTML = html;
        div.addEventListener('click', function() {
          _selectedLeft = this.getAttribute('data-uid');
          render();
          maybeAutoRoute();
        });
        div.addEventListener('dblclick', function() {
          var u = this.getAttribute('data-uid');
          var uds = (this.getAttribute('data-uids') || u).split(',').filter(Boolean);
          var keys = [];
          uds.forEach(function(x){ var k = _routeKeyFor(x); if (k && keys.indexOf(k) < 0) keys.push(k); });
          if (keys.length > 0) {
            _daoConfirm('断开 ' + f.label + ' 全部 ' + keys.length + ' 条路由?').then(function(ok2) {
              if (!ok2) return;
              Promise.all(keys.map(function(k){ return fDel('/origin/ea/route/' + encodeURIComponent(k)); })).then(function(){ loadConfig(); });
            });
          } else {
            openRouteModal(u);
          }
        });
        container.appendChild(div);
      });
    });
  }

  function renderRight() {
    var container = document.getElementById('externalModels');
    container.innerHTML = '';
    // ★ v9.9.266 · 外接首项 = 内置测试通道(builtin-stub) · 其余 = 用户渠道 · 与悬浮面板同
    for (var name in _providers) {
      var prov = _providers[name] || {};
      var builtin = !!prov._builtin;
      var disp = prov._label || name;
      var models = prov.models || prov._models || [];
      // Provider 标题
      var header = document.createElement('div');
      header.style.cssText = 'font-size:10px;opacity:0.5;margin:4px 0 2px;display:flex;align-items:center;gap:4px;';
      var hDot = builtin ? '#6bb86b' : (_health[name] && _health[name].alive ? '#6bb86b' : (_health[name] ? '#e08080' : 'rgba(128,128,128,0.3)'));
      var hHtml = '<span style="width:6px;height:6px;border-radius:50%;background:' + hDot + ';flex-shrink:0"></span>' +
        '<span style="flex:1">' + disp + (builtin ? ' · 内置' : '') + '</span>';
      if (!builtin) hHtml += '<button class="btn del" data-prov="' + name + '" title="删除 ' + name + '">x</button>';
      header.innerHTML = hHtml;
      container.appendChild(header);

      if (!builtin) {
        header.querySelector('.btn.del').addEventListener('click', function(e) {
          e.stopPropagation();
          var pName = this.getAttribute('data-prov');
          _daoConfirm('删除 provider ' + pName + '? (关联路由也会删除)').then(function(ok2) {
            if (!ok2) return;
            fDel('/origin/ea/provider/' + encodeURIComponent(pName)).then(function(r) { if (r.ok) loadConfig(); });
          });
        });
      }

      // 模型列表
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        var key = name + '/' + m;
        var wired = false;
        for (var ru in _routes) { var rt = _routes[ru]; if (rt && rt.provider === name && rt.model === m) { wired = true; break; } }
        var div = document.createElement('div');
        div.className = 'model-item' + (_selectedRight === key ? ' selected' : '');
        div.innerHTML = '<span class="dot ' + (wired ? 'routed' : 'unrouted') + '"></span><span class="name">' + m + '</span>';
        div.setAttribute('data-prov', name);
        div.setAttribute('data-model', m);
        div.addEventListener('click', function() {
          _selectedRight = this.getAttribute('data-prov') + '/' + this.getAttribute('data-model');
          render();
          maybeAutoRoute();
        });
        div.addEventListener('dblclick', function() {
          openRouteModal(null, this.getAttribute('data-prov'), this.getAttribute('data-model'));
        });
        container.appendChild(div);
      }

      // 如果没有模型列表 · 显示 "探测" 按钮 (内置测试通道无需探测)
      if (models.length === 0 && !builtin) {
        var probeBtn = document.createElement('button');
        probeBtn.className = 'btn probe';
        probeBtn.style.cssText = 'font-size:9px;margin:2px 0 4px;padding:1px 6px;';
        probeBtn.textContent = '探测模型';
        probeBtn.setAttribute('data-prov', name);
        probeBtn.addEventListener('click', function() {
          var pName = this.getAttribute('data-prov');
          this.textContent = '探测中...';
          var self = this;
          fJson('/origin/ea/models/' + encodeURIComponent(pName)).then(function(r) {
            if (r.ok && r.models && r.models.length > 0) {
              loadConfig();
            } else {
              self.textContent = '无模型';
              setTimeout(function() { self.textContent = '探测模型'; }, 2000);
            }
          }).catch(function() {
            self.textContent = '探测失败';
            setTimeout(function() { self.textContent = '探测模型'; }, 2000);
          });
        });
        container.appendChild(probeBtn);
      }
    }
  }

  function renderWires() {
    var svg = document.getElementById('wireSvg');
    svg.innerHTML = '';
    var container = document.getElementById('wireContainer');
    var cRect = container.getBoundingClientRect();
    if (cRect.width === 0) return;

    for (var uid in _routes) {
      var route = _routes[uid];
      if (!route || !route.provider) continue;
      // 找左侧节点: 路由 uid 可能落在家族任一档位成员上 → 匹配 data-uids 含该 uid 的家族项
      var leftEl = document.querySelector('.wire-col.left .model-item[data-uid="' + uid + '"]');
      if (!leftEl) {
        var lis = document.querySelectorAll('.wire-col.left .model-item');
        for (var li = 0; li < lis.length; li++) {
          var uds = (lis[li].getAttribute('data-uids') || '').split(',');
          var hit = false;
          for (var ui = 0; ui < uds.length; ui++) { if (_norm(uds[ui]) === _norm(uid)) { hit = true; break; } }
          if (hit) { leftEl = lis[li]; break; }
        }
      }
      // 找右侧节点 (provider标题或模型)
      var rightEl = document.querySelector('.wire-col.right .model-item[data-prov="' + route.provider + '"][data-model="' + route.model + '"]');
      if (!rightEl) rightEl = document.querySelector('.wire-col.right .model-item[data-prov="' + route.provider + '"]');
      if (!leftEl || !rightEl) continue;

      var lRect = leftEl.getBoundingClientRect();
      var rRect = rightEl.getBoundingClientRect();
      var x1 = lRect.right - cRect.left;
      var y1 = lRect.top + lRect.height / 2 - cRect.top;
      var x2 = rRect.left - cRect.left;
      var y2 = rRect.top + rRect.height / 2 - cRect.top;
      // 贝塞尔曲线
      var cx = (x1 + x2) / 2;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      var isDead = _health[route.provider] && !_health[route.provider].alive;
      path.setAttribute('class', 'wire-line' + (isDead ? ' dead' : ' active'));
      path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2);
      svg.appendChild(path);
    }
  }

  function renderStatus() {
    var bar = document.getElementById('statusBar');
    var provCount = Object.keys(_providers).length;
    var routeCount = Object.keys(_routes).length;
    var routedCount = 0;
    for (var uid in _routes) { if (_routes[uid] && _routes[uid].provider) routedCount++; }
    bar.innerHTML =
      '<span class="pill">Provider ' + provCount + '</span>' +
      '<span class="pill">路由 ' + routedCount + '/' + routeCount + '</span>' +
      '<span class="pill">就绪 ' + (_config && (_config.router_ready || _config.ea_running) ? '是' : '否') + '</span>' +
      '<span style="flex:1"></span>' +
      '<span style="font-size:9px;opacity:0.4">双击=编辑 · 左=官方 · 右=外接</span>';
  }

  // ── cc-switch 预设填充 ──
  (function() {
    var sel = document.getElementById('presetSelect');
    if (!sel) return;
    _PRESETS.forEach(function(p, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.n + ' (' + p.u.replace(/^https?:[/][/]/, '') + ')';
      sel.appendChild(opt);
    });
    var apply = document.getElementById('btnApplyPreset');
    if (apply) apply.addEventListener('click', function() {
      var v = sel.value;
      if (v === '') return;
      var p = _PRESETS[parseInt(v, 10)];
      if (!p) return;
      document.getElementById('provName').value = p.n.toLowerCase().replace(/[ ]+/g, '-');
      document.getElementById('provUrl').value = p.u;
      document.getElementById('provModels').value = p.m;
      document.getElementById('provKey').focus();
    });
  })();

  // ── 添加 Provider ──
  document.getElementById('btnAddProv').addEventListener('click', function() {
    var name = document.getElementById('provName').value.trim();
    var url = document.getElementById('provUrl').value.trim();
    var key = document.getElementById('provKey').value.trim();
    var modelsRaw = document.getElementById('provModels').value.trim();
    if (!name || !url) { _daoToast('名称和 URL 必填'); return; }
    var cfg = { baseUrl: url, apiKey: key };
    if (modelsRaw) cfg.models = modelsRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    fPost('/origin/ea/provider', { name: name, cfg: cfg })
      .then(function(r) {
        if (r.ok) {
          document.getElementById('provName').value = '';
          document.getElementById('provUrl').value = '';
          document.getElementById('provKey').value = '';
          document.getElementById('provModels').value = '';
          loadConfig();
        } else {
          _daoToast('添加失败: ' + (r.error || 'unknown'));
        }
      }).catch(function(e) { _daoToast('请求失败: ' + e.message); });
  });

  // ── 探测健康 ──
  document.getElementById('btnProbe').addEventListener('click', function() {
    var btn = this;
    btn.textContent = '探测中...';
    fPost('/origin/ea/probe', {}).then(function(r) {
      if (r.ok && r.providers) {
        _health = r.providers;
        render();
      }
      btn.textContent = '探测';
    }).catch(function() { btn.textContent = '探测'; });
  });

  // ── 路由弹窗 ──
  // ★ v9.9.263 · 自连 · 左右各选一 → 自创路由 (早期设计 · 无为而无不为)
  //   不再需双击开模态 · 选完即路· 选完即现连线
  function maybeAutoRoute() {
    if (!_selectedLeft || !_selectedRight) return;
    var left = _selectedLeft;
    var right = _selectedRight;
    var slash = right.indexOf('/');
    var prov = slash >= 0 ? right.slice(0, slash) : right;
    var model = slash >= 0 ? right.slice(slash + 1) : right;
    var st = document.getElementById('statusText');
    if (st) st.textContent = '路由中: ' + left + ' → ' + right + ' …';
    fPost('/origin/ea/route', {
      modelUid: left,
      route: { provider: prov, model: model, maxOutputTokens: 16384, thinkingEnabled: false }
    }).then(function(r) {
      if (r && r.ok) {
        _selectedLeft = null;
        _selectedRight = null;
        if (st) st.textContent = '✔ 已路由 ' + left + ' → ' + right;
        loadConfig();
      } else {
        if (st) st.textContent = '路由失败: ' + ((r && r.error) || 'unknown');
      }
    }).catch(function(e) {
      if (st) st.textContent = '路由请求失败: ' + e.message;
    });
  }

  // ── webview 安全替代: VS Code webview 禁用 window.confirm/alert ──
  function _daoToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);background:rgba(40,40,46,0.97);color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:6px;padding:8px 14px;font-size:12px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,0.5);max-width:80%;';
    document.body.appendChild(t);
    setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }
  function _daoConfirm(msg) {
    return new Promise(function(resolve) {
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:99998;display:flex;align-items:center;justify-content:center;';
      var box = document.createElement('div');
      box.style.cssText = 'background:#26262c;color:#e6e6e6;border:1px solid rgba(128,128,128,0.4);border-radius:8px;padding:16px 18px;max-width:78%;box-shadow:0 8px 28px rgba(0,0,0,0.6);';
      var p = document.createElement('div');
      p.textContent = msg;
      p.style.cssText = 'font-size:13px;margin-bottom:14px;line-height:1.5;';
      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      var cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'padding:5px 14px;font-size:12px;border-radius:4px;border:1px solid rgba(128,128,128,0.4);background:transparent;color:#e6e6e6;cursor:pointer;';
      var ok = document.createElement('button');
      ok.textContent = '确认';
      ok.style.cssText = 'padding:5px 14px;font-size:12px;border-radius:4px;border:1px solid #c0392b;background:#c0392b;color:#fff;cursor:pointer;';
      function close(v){ if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(v); }
      cancel.addEventListener('click', function(){ close(false); });
      ok.addEventListener('click', function(){ close(true); });
      ov.addEventListener('click', function(e){ if (e.target === ov) close(false); });
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(p); box.appendChild(btns);
      ov.appendChild(box);
      document.body.appendChild(ov);
      ok.focus();
    });
  }

  function openRouteModal(uid, provName, extModel) {
    var modal = document.getElementById('routeModal');
    document.getElementById('routeModelUid').value = uid || '';
    document.getElementById('routeExtModel').value = extModel || '';
    document.getElementById('routeMaxTokens').value = '16384';
    document.getElementById('routeThinking').checked = false;

    // 填充 provider 下拉
    var sel = document.getElementById('routeProvider');
    sel.innerHTML = '';
    for (var name in _providers) {
      var opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === provName) opt.selected = true;
      sel.appendChild(opt);
    }

    // 如果编辑已有路由
    if (uid && _routes[uid]) {
      var route = _routes[uid];
      document.getElementById('routeModalTitle').textContent = '编辑路由: ' + uid;
      document.getElementById('routeExtModel').value = route.model || '';
      document.getElementById('routeMaxTokens').value = route.maxOutputTokens || 16384;
      document.getElementById('routeThinking').checked = !!route.thinkingEnabled;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === route.provider) sel.options[i].selected = true;
      }
    } else {
      document.getElementById('routeModalTitle').textContent = '添加路由';
    }

    modal.classList.add('show');
  }

  document.getElementById('routeSave').addEventListener('click', function() {
    var uid = document.getElementById('routeModelUid').value.trim();
    var prov = document.getElementById('routeProvider').value;
    var model = document.getElementById('routeExtModel').value.trim();
    var maxTokens = parseInt(document.getElementById('routeMaxTokens').value) || 16384;
    var thinking = document.getElementById('routeThinking').checked;
    if (!uid || !prov || !model) { _daoToast('所有字段必填'); return; }
    fPost('/origin/ea/route', {
      modelUid: uid,
      route: { provider: prov, model: model, maxOutputTokens: maxTokens, thinkingEnabled: thinking }
    }).then(function(r) {
      if (r.ok) {
        document.getElementById('routeModal').classList.remove('show');
        loadConfig();
      } else {
        _daoToast('保存失败: ' + (r.error || 'unknown'));
      }
    }).catch(function(e) { _daoToast('请求失败: ' + e.message); });
  });

  document.getElementById('routeCancel').addEventListener('click', function() {
    document.getElementById('routeModal').classList.remove('show');
  });

  // ── 窗口 resize 时重绘连线 ──
  window.addEventListener('resize', function() { renderWires(); });

  // ── 自动刷新 ──
  setInterval(function() { loadConfig(); }, 5000);

  // ── 三模块 Tab 切换 + 扩展宿主桥 ──
  var _vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  function postMsg(t) { if (_vscode) _vscode.postMessage({ type: t }); }
  var _tabs = document.querySelectorAll('.dao-tab');
  for (var ti = 0; ti < _tabs.length; ti++) {
    _tabs[ti].addEventListener('click', function() {
      var pane = this.getAttribute('data-pane');
      for (var k = 0; k < _tabs.length; k++) { _tabs[k].classList.remove('active'); }
      this.classList.add('active');
      var panes = document.querySelectorAll('.dao-pane');
      for (var j = 0; j < panes.length; j++) {
        if (panes[j].id === pane) { panes[j].classList.add('active'); }
        else { panes[j].classList.remove('active'); }
      }
      if (pane === 'paneRouter') { try { renderWires(); } catch (e) {} }
    });
  }
  var _be = document.getElementById('btnOpenEssence');
  if (_be) _be.addEventListener('click', function() { postMsg('focusEssence'); });
  var _bp = document.getElementById('btnOpenPreview');
  if (_bp) _bp.addEventListener('click', function() { postMsg('openPreview'); });
  var _bm = document.getElementById('btnModelStatus');
  if (_bm) _bm.addEventListener('click', function() { postMsg('modelStatus'); });

  // ── 初始加载 ──
  loadConfig();
  // 首次探测健康
  setTimeout(function() {
    fPost('/origin/ea/probe', {}).then(function(r) {
      if (r.ok && r.providers) { _health = r.providers; render(); }
    }).catch(function() {});
  }, 1000);
})();
</script>
</body>
</html>`;
}

// ★ v9.9.90 · 外接api 热配置面板命令
async function cmdEaConfig() {
  try {
    const panel = vscode.window.createWebviewPanel(
      "dao.eaConfig",
      "道 · 三模块面板 (本源观照·渠道配置·模型路由)",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        portMapping: [
          { webviewPort: _cachedPort, extensionHostPort: _cachedPort },
        ],
      },
    );
    const N = _genNonce();
    panel.webview.html = getEaConfigHtml(_cachedPort, N);
    // ★ 三模块面板 → 扩展宿主消息桥 · 本源观照(①)开侧栏 · 浏览器真SP · 全模目录
    panel.webview.onDidReceiveMessage((msg) => {
      try {
        if (!msg || !msg.type) return;
        if (msg.type === "focusEssence") {
          vscode.commands.executeCommand(
            "workbench.view.extension.dao-container",
          );
        } else if (msg.type === "openPreview") {
          cmdOpenPreview();
        } else if (msg.type === "modelStatus") {
          cmdModelUnlockStatus();
        }
      } catch (e) {
        L.warn("eaConfig", `msg handle fail: ${e && e.message}`);
      }
    });
    L.info("eaConfig", `webview panel opened · port=${_cachedPort}`);
  } catch (e) {
    L.error("eaConfig", `open fail: ${e.message}`);
    vscode.window.showErrorMessage(`外接API配置面板打开失败: ${e.message}`);
  }
}

module.exports = { activate, deactivate };
