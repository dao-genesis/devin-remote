// ═══════════════════════════════════════════════════════════════════════════
// devin_web.js · v4.8.0 · 浏览器多实例隔离 + 账号注入 (自足·不赖 dao-vsix)
// ───────────────────────────────────────────────────────────────────────────
// 帛书·「鸡犬相闻·民至老死不相往来」: 每账号独立 --user-data-dir profile →
//   localStorage 各自隔离 → 隔离用户默认浏览器认证, 多账号同源并行不相悖。
// 帛书·「观天之道·执天之行」: 经真机抓取确认 Devin SPA 登录态唯一真源是
//   localStorage['auth1_session'] = {token, userId}。CDP addScriptToEvaluateOnNewDocument
//   在 app.devin.ai 真源加载前种入 → SPA 自判已登录, 无需 GUI/OAuth, 无需反向代理。
// 零外部依赖: 仅 Node 内建 net/http/crypto/child_process。WS/CDP 客户端手写最小实现。
// ═══════════════════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const cp = require("child_process");

const WAM_DIR = path.join(os.homedir(), ".wam");
const PROFILES_DIR = path.join(WAM_DIR, "browser-profiles");

const DEVIN_APP = "https://app.devin.ai";

// 帛书·「绝利一源」— 定位本机浏览器 (Chrome 优先, 回退 Edge)。
function findBrowserExe() {
  const PF = process.env["ProgramFiles"] || "C:\\Program Files";
  const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const LAD = process.env["LOCALAPPDATA"] || "";
  const candidates = [
    PF + "\\Google\\Chrome\\Application\\chrome.exe",
    PF86 + "\\Google\\Chrome\\Application\\chrome.exe",
    LAD + "\\Google\\Chrome\\Application\\chrome.exe",
    PF86 + "\\Microsoft\\Edge\\Application\\msedge.exe",
    PF + "\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function safeKey(s) {
  return String(s || "default").replace(/[^a-zA-Z0-9._@-]/g, "_");
}

function profileDirFor(email) {
  const dir = path.join(PROFILES_DIR, safeKey(email));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

// 取一个空闲本地端口 (CDP remote-debugging-port 用)。
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on("error", () => resolve(0));
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address() && srv.address().port;
      srv.close(() => resolve(p || 0));
    });
  });
}

// 帛书·「观天之道」— SPA 登录态注入脚本 (运行于 app.devin.ai 真源·页面脚本前)。
function buildInjectSource(auth1, userId, orgId, orgName) {
  const a1 = JSON.stringify(String(auth1 || ""));
  const uid = JSON.stringify(String(userId || ""));
  const org = JSON.stringify(String(orgId || ""));
  const oname = JSON.stringify(String((orgName || "").replace(/['\\]/g, "")));
  return (
    "(function(){try{" +
    "var __a1=" + a1 + ";var __uid=" + uid + ";var __org=" + org + ";var __orgName=" + oname + ";" +
    "if(__a1){" +
    "localStorage.setItem('auth1_session',JSON.stringify({token:__a1,userId:__uid}));" +
    "localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18','true');" +
    "if(__uid)localStorage.setItem('known-org-ids-'+__uid,JSON.stringify([__org]));" +
    "if(__org)localStorage.setItem('last-internal-org-for-external-org-v1-null',__org);" +
    "if(__org&&__uid&&__orgName){var __k='post-auth-v3-null-'+__uid+'-org_name-'+__orgName;" +
    "if(!localStorage.getItem(__k))localStorage.setItem(__k,JSON.stringify({externalOrgId:null,userId:__uid,internalOrgId:__org,orgName:__orgName,result:{resolved_external_org_id:null,org_id:__org,org_name:__orgName,is_valid_resource:true}}));}" +
    "}}catch(e){}})();"
  );
}

function httpGetJson(port, p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: timeoutMs || 2000 },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

// 轮询 CDP /json 找到 type=page 的目标 (含 webSocketDebuggerUrl)。
async function waitForPageTarget(port, maxMs) {
  const deadline = Date.now() + (maxMs || 8000);
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson(port, "/json", 1500);
      if (Array.isArray(list)) {
        const pg = list.find(
          (t) => t.type === "page" && t.webSocketDebuggerUrl,
        );
        if (pg) return pg.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// 最小 WebSocket 客户端 (仅本地 CDP 用·客户端帧需掩码)。
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(wsUrl);
    } catch (e) {
      return reject(e);
    }
    const port = parseInt(u.port || "80", 10);
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(port, u.hostname, () => {
      const req =
        "GET " + u.pathname + (u.search || "") + " HTTP/1.1\r\n" +
        "Host: " + u.hostname + ":" + port + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n";
      sock.write(req);
    });
    let handshakeDone = false;
    let recvBuf = Buffer.alloc(0);
    const handlers = { onText: null };
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      if (!handshakeDone) {
        const idx = recvBuf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = recvBuf.slice(0, idx).toString("utf8");
        if (!/101/.test(head.split("\r\n")[0])) {
          return reject(new Error("ws handshake failed: " + head.split("\r\n")[0]));
        }
        handshakeDone = true;
        recvBuf = recvBuf.slice(idx + 4);
        resolve(client);
      }
      // 解析服务端帧 (无掩码)
      while (recvBuf.length >= 2) {
        const b1 = recvBuf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (recvBuf.length < 4) break;
          len = recvBuf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (recvBuf.length < 10) break;
          len = Number(recvBuf.readBigUInt64BE(2));
          off = 10;
        }
        if (recvBuf.length < off + len) break;
        const opcode = recvBuf[0] & 0x0f;
        const payload = recvBuf.slice(off, off + len);
        recvBuf = recvBuf.slice(off + len);
        // 仅处理文本帧(1)与延续帧(0); 忽略 ping/pong/close。
        if (opcode !== 0x1 && opcode !== 0x0) continue;
        if (handlers.onText) {
          try {
            handlers.onText(payload.toString("utf8"));
          } catch {}
        }
      }
    });

    function sendText(str) {
      const payload = Buffer.from(str, "utf8");
      const len = payload.length;
      let header;
      const mask = crypto.randomBytes(4);
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      header[0] = 0x81; // FIN + text
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      sock.write(Buffer.concat([header, mask, masked]));
    }

    const client = {
      sendText,
      onText: (fn) => (handlers.onText = fn),
      close: () => {
        try {
          sock.end();
          sock.destroy();
        } catch {}
      },
    };
  });
}

// 基础隔离启动 (清洁 profile·不注入) — 注入失败时的回退。
function launchIsolatedBasic(targetUrl, email, debugPort) {
  const exe = findBrowserExe();
  const dir = profileDirFor(email);
  if (exe) {
    const args = [
      "--user-data-dir=" + dir,
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (debugPort) args.push("--remote-debugging-port=" + debugPort);
    args.push("--new-window", targetUrl);
    const child = cp.spawn(exe, args, { detached: true, stdio: "ignore" });
    return { child, exe, profileDir: dir };
  }
  return { child: null, exe: null, profileDir: dir };
}

// ★ 主入口: 隔离 profile 启动 + CDP 注入 auth1_session → 自动登录。
//   opts: { email, auth1, userId, orgId, orgName, pagePath, log }
//   返回 { ok, injected, exe, profileDir, error }
async function launchAccountBrowser(opts) {
  opts = opts || {};
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const email = opts.email || "default";
  const page = opts.pagePath
    ? "/" + String(opts.pagePath).replace(/^\//, "")
    : "";
  const targetUrl = DEVIN_APP + page;
  const exe = findBrowserExe();

  // 无浏览器 → 系统默认浏览器兜底 (无隔离·至少能用)。
  if (!exe) {
    log("devin_web: 未找到 Chrome/Edge · 回退默认浏览器");
    return { ok: false, injected: false, exe: null, error: "no-browser" };
  }

  // 无可注入 auth1 → 仅隔离启动 (清洁 profile·用户首次手动登录一次)。
  if (!opts.auth1) {
    const r = launchIsolatedBasic(targetUrl, email);
    try {
      r.child && r.child.unref();
    } catch {}
    log("devin_web: 隔离启动(无 auth1·未注入) · " + email);
    return { ok: !!r.child, injected: false, exe, profileDir: r.profileDir };
  }

  // 有 auth1 → 带 CDP 调试端口启动, 注入 auth1_session 后导航至官网。
  let child = null;
  let cdp = null;
  try {
    const port = await pickFreePort();
    if (!port) throw new Error("no free port");
    // 先开 about:blank, 注入 init script 后再导航 (确保种入早于 SPA 读取)。
    const r = launchIsolatedBasic("about:blank", email, port);
    child = r.child;
    if (!child) throw new Error("spawn failed");

    const wsUrl = await waitForPageTarget(port, 9000);
    if (!wsUrl) throw new Error("no CDP page target");

    cdp = await cdpConnect(wsUrl);
    const src = opts.injectOverride || buildInjectSource(
      opts.auth1,
      opts.userId,
      opts.orgId,
      opts.orgName,
    );

    // ── CDP 消息泵: id→resolver 关联 + Page 事件订阅 (loadEventFired)。
    const pending = new Map();
    const loadWaiters = [];
    cdp.onText((txt) => {
      let m;
      try {
        m = JSON.parse(txt);
      } catch {
        return;
      }
      if (m.id != null && pending.has(m.id)) {
        const fn = pending.get(m.id);
        pending.delete(m.id);
        fn(m);
      } else if (m.method === "Page.loadEventFired") {
        while (loadWaiters.length) loadWaiters.shift()();
      }
    });
    let _id = 0;
    function send(method, params) {
      const id = ++_id;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        cdp.sendText(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve({ timeout: true });
          }
        }, 6000);
      });
    }
    function waitLoad(capMs) {
      return new Promise((resolve) => {
        let done = false;
        const fin = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        loadWaiters.push(fin);
        setTimeout(fin, capMs || 6000);
      });
    }

    await send("Page.enable");
    // addScript 让任何后续(含 reload)新文档都自动种入; 但 navigate 提交与脚本
    //   注册存在竞态 → 故再于 load 后显式 evaluate + reload 兜底, 确保 SPA 启动即见 auth。
    await send("Page.addScriptToEvaluateOnNewDocument", { source: src });
    const nav = await send("Page.navigate", { url: targetUrl });
    const navOk = !!(nav && !nav.error && !nav.timeout);
    await waitLoad(6000);
    // 显式写入 (幂等) — 防 addScript 竞态漏种。
    await send("Runtime.evaluate", { expression: src });
    // 重载 → SPA 以已存在的 auth 重新启动 → 自动登录。
    await send("Page.reload", {});
    await waitLoad(6000);

    try {
      cdp.close();
    } catch {}
    try {
      child.unref();
    } catch {}
    log(
      "devin_web: 隔离启动+注入" +
        (navOk ? "成功" : "(导航未确认)") +
        " · " +
        email,
    );
    return {
      ok: true,
      injected: true,
      exe,
      profileDir: r.profileDir,
      debugPort: port,
    };
  } catch (e) {
    log("devin_web: 注入失败回退隔离启动 · " + (e && e.message));
    try {
      cdp && cdp.close();
    } catch {}
    // 回退: 已开的 about:blank 窗口直接导航不可控 → 杀掉重开干净隔离窗口。
    try {
      child && child.kill();
    } catch {}
    const r2 = launchIsolatedBasic(targetUrl, email);
    try {
      r2.child && r2.child.unref();
    } catch {}
    return {
      ok: !!r2.child,
      injected: false,
      exe,
      profileDir: r2.profileDir,
      error: e && e.message,
    };
  }
}

module.exports = {
  findBrowserExe,
  profileDirFor,
  buildInjectSource,
  launchAccountBrowser,
  PROFILES_DIR,
  DEVIN_APP,
};
