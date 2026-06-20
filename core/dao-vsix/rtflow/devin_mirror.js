// ═══════════════════════════════════════════════════════════════════════════
// devin_mirror.js · 归一网页「投屏兜底」· 宿主真·官网本体 CDP 截帧 + 输入回传
// ───────────────────────────────────────────────────────────────────────────
// 道并行而不相悖: dao 自渲染为主干(轻量·Auth0 免疫); 投屏作长尾/回信兜底——
//   宿主以 devin_web 注入 auth1 启隔离 profile 真·登录态官网本体(实测整窗不受
//   Auth0 墙限), 经 CDP 截 JPEG 帧推同源前缀、归一化坐标回传输入 → 公网隧道
//   主口直达, 任意设备零移植拿到官网 100% 功能(含回信/Automations/Review/Wiki)。
// 令牌只在服务端: 浏览器只见像素与归一化输入, auth1 绝不下发。
// 零外部依赖: 复用 devin_web 的最小 CDP/WS 客户端 (Node 内建)。
// ═══════════════════════════════════════════════════════════════════════════
"use strict";

const web = require("./devin_web");

// 固定布局视口 → 帧尺寸恒定, 归一化坐标 (nx,ny ∈ [0,1]) 可精确映射回像素。
const VW = 1280;
const VH = 800;

const SESS = new Map(); // accKey → { email, port, cdp, send, alive, lastUse, navigating }

// CDP 消息泵: id→resolver, 文本帧 JSON 解析 (截图 base64 走单文本帧)。
function makePump(cdp) {
  const pending = new Map();
  let _id = 0;
  cdp.onText((txt) => {
    let m;
    try { m = JSON.parse(txt); } catch { return; }
    if (m.id != null && pending.has(m.id)) {
      const fn = pending.get(m.id);
      pending.delete(m.id);
      fn(m);
    }
  });
  function send(method, params, timeoutMs) {
    const id = ++_id;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      try {
        cdp.sendText(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        pending.delete(id);
        resolve({ error: { message: String((e && e.message) || e) } });
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); }
      }, timeoutMs || 8000);
    });
  }
  return { send };
}


// 确保某账号有一个登录态宿主浏览器 + 活 CDP 会话 (惰性·首帧/首导航时建)。
//   auth: { email, auth1, userId, orgId, orgName }
//   自管生命周期: 持 child 句柄 → close() 真正杀进程, 不残留占 profile 致下次启动夺端口失败。
async function ensure(accKey, auth, opts) {
  opts = opts || {};
  const log = typeof opts.log === "function" ? opts.log : () => {};
  let s = SESS.get(accKey);
  if (s && s.alive) { s.lastUse = Date.now(); return s; }
  if (!auth || !auth.auth1) throw new Error("no auth1 for mirror");

  const port = await web.pickFreePort();
  if (!port) throw new Error("no free port");
  // 先开 about:blank (带调试端口), 注入 auth1_session 后导航官网 → 整窗登录态 (实测不受 Auth0 墙限)。
  const r = web.launchIsolatedBasic("about:blank", auth.email, port);
  if (!r.child) throw new Error("spawn failed (no browser exe?)");
  const child = r.child;

  let cdp;
  try {
    const wsUrl = await web.waitForPageTarget(port, 12000);
    if (!wsUrl) throw new Error("no CDP page target on port " + port);
    cdp = await web.cdpConnect(wsUrl);
    const { send } = makePump(cdp);
    const src = web.buildInjectSource(auth.auth1, auth.userId, auth.orgId, auth.orgName);
    const target = web.DEVIN_APP + (opts.pagePath ? "/" + String(opts.pagePath).replace(/^\/+/, "") : "");
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: src });
    await send("Page.navigate", { url: target });
    await new Promise((x) => setTimeout(x, 700));
    await send("Runtime.evaluate", { expression: src });
    await send("Page.reload", {});
    await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    s = {
      accKey, email: auth.email, port, child,
      cdp, send, alive: true, lastUse: Date.now(), navigating: false,
    };
    try { child.unref(); } catch {}
    SESS.set(accKey, s);
    log("mirror: 宿主会话就绪 " + auth.email + " port=" + port);
    return s;
  } catch (e) {
    try { cdp && cdp.close(); } catch {}
    try { child.kill(); } catch {}
    throw e;
  }
}

// 截一帧 JPEG (base64, 不含 data: 前缀)。
async function frame(accKey, auth, opts) {
  opts = opts || {};
  const s = await ensure(accKey, auth, opts);
  s.lastUse = Date.now();
  const q = Math.max(20, Math.min(90, parseInt(opts.quality, 10) || 55));
  const r = await s.send("Page.captureScreenshot", { format: "jpeg", quality: q }, 9000);
  if (r && r.result && r.result.data) return { ok: true, jpeg: r.result.data, w: VW, h: VH };
  return { ok: false, error: (r && (r.timeout ? "timeout" : (r.error && r.error.message))) || "no frame" };
}

// 归一化输入 → CDP Input 事件下发。evt.action: click|scroll|settext|key|reload|back
async function input(accKey, auth, evt) {
  const s = await ensure(accKey, auth, {});
  s.lastUse = Date.now();
  evt = evt || {};
  const a = String(evt.action || "");
  const X = (nx) => Math.round(Math.max(0, Math.min(1, Number(nx) || 0)) * VW);
  const Y = (ny) => Math.round(Math.max(0, Math.min(1, Number(ny) || 0)) * VH);
  if (a === "click") {
    const x = X(evt.nx), y = Y(evt.ny);
    await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return { ok: true };
  }
  if (a === "scroll") {
    const x = X(evt.nx == null ? 0.5 : evt.nx), y = Y(evt.ny == null ? 0.5 : evt.ny);
    await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(evt.dx) || 0, deltaY: Number(evt.dy) || 0 });
    return { ok: true };
  }
  if (a === "settext" || a === "type") {
    await s.send("Input.insertText", { text: String(evt.text || "") });
    return { ok: true };
  }
  if (a === "key") {
    const key = String(evt.key || "");
    const MAP = {
      Enter: { windowsVirtualKeyCode: 13, key: "Enter", text: "\r" },
      Backspace: { windowsVirtualKeyCode: 8, key: "Backspace" },
      Tab: { windowsVirtualKeyCode: 9, key: "Tab" },
      Escape: { windowsVirtualKeyCode: 27, key: "Escape" },
    };
    const k = MAP[key] || { key };
    await s.send("Input.dispatchKeyEvent", Object.assign({ type: "keyDown" }, k));
    if (k.text) await s.send("Input.dispatchKeyEvent", Object.assign({ type: "char" }, k));
    await s.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, k));
    return { ok: true };
  }
  if (a === "reload") { await s.send("Page.reload", {}); return { ok: true }; }
  if (a === "back") { await s.send("Runtime.evaluate", { expression: "history.back()" }); return { ok: true }; }
  return { ok: false, error: "unknown action: " + a };
}

// 导航宿主本体到官网某路径 (如 /sessions/<id>)。
async function navigate(accKey, auth, pathPart) {
  const s = await ensure(accKey, auth, {});
  s.lastUse = Date.now();
  let p = String(pathPart || "");
  p = p ? "/" + p.replace(/^\/+/, "") : "";
  // 官网会话 URL 去 devin- 前缀: dao 内部 id 为 devin-<uuid>, 官网路由为 /sessions/<uuid>。
  p = p.replace(/^\/sessions\/devin-/, "/sessions/");
  const url = web.DEVIN_APP + p;
  await s.send("Page.navigate", { url });
  return { ok: true, url };
}

function close(accKey) {
  const s = SESS.get(accKey);
  if (s) {
    try { s.cdp.close(); } catch {}
    try { if (s.child) s.child.kill(); } catch {}
    s.alive = false;
    SESS.delete(accKey);
  }
}

function closeAll() { for (const k of [...SESS.keys()]) close(k); }

module.exports = { ensure, frame, input, navigate, close, closeAll, VW, VH, _sessions: SESS };
