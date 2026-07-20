"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// standalone-runner.js — 反代常驻守护 (开机先于 IDE 持有 :8957)
//
// 反者道之动·根因(实证于 zhoumac 20260721T000011 逐毫秒时序):
//   ① 正常关窗时扩展清锚 → settings 无 api_server_url 覆盖;
//   ② 下次启动 codeium.windsurf 秒激活(activationEvent '*') · t+19s 即 spawn LS
//      指向官方 server.codeium.com; 而 dao-one 束大 require 慢 · 代理 t+68s 才绑定;
//   ③ 该机直连官方被墙/极慢 → 首个 LS 从进程起到监听耗 64s → 扩展 60s 启动超时
//      → 「Timed out waiting for language server start」→ wedge → 每次启动必卡。
//   修修补补(死后自愈)永不治此 —— 根治 = 反代生命周期与 IDE 窗口解耦:
//   开机任务先起本守护 · :8957 从第 0 秒就有人服务 · 锚点得以常驻 →
//   首个 LS 出生即连上本地反代 · 永不再撞「官方直连 64s 黑洞」。
//
// 行为(柔弱胜刚强 · 不争):
//   - 扫描全部已装扩展目录 · 取最新版 vendor source.js;
//   - :8957 已有健康 dao 反代(如 IDE 内扩展自绑) → 蛰伏轮询 · 绝不相争;
//   - 端口空闲 → 以 ORIGIN_PORT=8957 子进程直跑 source.js(CLI 路径·全功能);
//   - 子进程亡(含被新版扩展 /_quit 让位) → 重扫最新源 · 退避重生;
//   - 本文件由扩展 activate 时装入 %USERPROFILE%\.dao\ 并注册开机任务(见 extension.js)。
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cp = require("child_process");

const PORT = parseInt(process.env.DAO_STANDALONE_PORT || "8957", 10);
const POLL_MS = 15000; // 蛰伏轮询
const RESPAWN_MS = 3000; // 子亡退避

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(path.join(os.homedir(), ".dao", "dao-proxy-standalone.log"), line);
  } catch {}
}

// ── 扫全部 IDE 扩展安装目录 · 取最新版 source.js ──
function scanNewestSource() {
  const home = os.homedir();
  const roots = [".devin", ".windsurf", ".codeium", ".vscode"].map((d) =>
    path.join(home, d, "extensions"),
  );
  const rel = [
    ["vendor-proxy", "vendor", "bundled-origin", "source.js"], // dao-one 内折布局
    ["vendor", "bundled-origin", "source.js"], // 独立 dao-proxy-pro 布局
  ];
  let best = null; // { ver:[x,y,z], file }
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/\.(obsolete|disabled|preinstall|backup|bak)/i.test(name)) continue;
      const m = name.match(/^(?:dao\.dao-one|dao-agi\.dao-proxy-(?:pro|min))-(\d+)\.(\d+)\.(\d+)/);
      if (!m) continue;
      const ver = [+m[1], +m[2], +m[3]];
      for (const parts of rel) {
        const f = path.join(root, name, ...parts);
        if (!fs.existsSync(f)) continue;
        if (!best || cmpVer(ver, best.ver) > 0) best = { ver, file: f };
      }
    }
  }
  return best;
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function pingProxy(cb) {
  const req = http.get(
    { host: "127.0.0.1", port: PORT, path: "/origin/ping", timeout: 2000 },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          cb(!!(j && j.ok && (j.mode === "invert" || j.mode === "passthrough" || j.mode === "custom")));
        } catch {
          cb(false);
        }
      });
    },
  );
  req.on("error", () => cb(false));
  req.on("timeout", () => {
    req.destroy();
    cb(false);
  });
}

let _child = null;

function spawnProxy() {
  const best = scanNewestSource();
  if (!best) {
    log("no installed source.js found · retry later");
    return setTimeout(tick, POLL_MS);
  }
  const env = Object.assign({}, process.env, {
    ORIGIN_PORT: String(PORT),
    ELECTRON_RUN_AS_NODE: "1",
  });
  log(`spawn v${best.ver.join(".")} · ${best.file}`);
  _child = cp.spawn(process.execPath, [best.file], { env, stdio: "ignore" });
  _child.on("exit", (code) => {
    log(`child exit code=${code} · respawn in ${RESPAWN_MS}ms`);
    _child = null;
    setTimeout(tick, RESPAWN_MS); // 让位/崩溃皆重走 tick(端口被占则蛰伏)
  });
}

function tick() {
  if (_child) return setTimeout(tick, POLL_MS);
  pingProxy((alive) => {
    if (alive) return setTimeout(tick, POLL_MS); // 他人在服 · 蛰伏不争
    spawnProxy();
  });
}

if (require.main === module) {
  log(`standalone runner start · port=${PORT} · exec=${process.execPath}`);
  tick();
}

module.exports = { scanNewestSource, cmpVer };
