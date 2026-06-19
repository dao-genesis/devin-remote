/* ─────────────────────────────────────────────────────────────────────────
 * remote-native (rn) shim — 让 APK 自身的真实页面 (switch/tunnel/cloud/vpn/…)
 * 原样跑在任意浏览器里。页面零改动: 它们调用的 window.Native.* 在这里被替换为
 *   · 数据/配置 读写  → 同步打回手机 LocalServer /relay/<session> 的 /api/native
 *   · 网络请求         → 异步打回手机 /api/http (手机侧执行, 绕 CORS, 用账号 auth1)
 *   · 输出到"人"的动作 (复制/下载/看文本) → 直接落到使用者自己的浏览器/设备 (更合理)
 * 于是浏览器里的页面"表层(同一份 HTML/CSS/JS) + 底层(同一套手机方法)"与 APK 完全一致。
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.__rnReady) return; window.__rnReady = true;
  function qp(k) { try { return new URLSearchParams(location.search).get(k) || ""; } catch (e) { return ""; } }

  var SESSION = qp("session") || localStorage.getItem("rtflow.rn.session") || "";
  var TOKEN = qp("token") || qp("t") || localStorage.getItem("rtflow.rn.token") || "";
  var ENDPOINT = (qp("endpoint") || location.origin).replace(/\/+$/, "");
  if (SESSION) localStorage.setItem("rtflow.rn.session", SESSION);
  if (TOKEN) localStorage.setItem("rtflow.rn.token", TOKEN);
  var RELAY = ENDPOINT + "/relay/" + encodeURIComponent(SESSION);

  function frame(path, body) { return JSON.stringify({ path: path, method: "POST", body: body }); }

  // 值返回型 Native 方法 → 同步请求 (保住页面对"同步桥"的预期, 页面无需改写)
  function syncCall(m, args) {
    try {
      var x = new XMLHttpRequest();
      x.open("POST", RELAY, false);
      x.setRequestHeader("Content-Type", "application/json");
      if (TOKEN) x.setRequestHeader("Authorization", "Bearer " + TOKEN);
      x.send(frame("/api/native", { m: m, a: args || [] }));
      if (x.status >= 400) return null;
      var d = JSON.parse(x.responseText || "{}");
      return d && Object.prototype.hasOwnProperty.call(d, "r") ? d.r : null;
    } catch (e) { try { console.error("[rn] " + m, e); } catch (_) {} return null; }
  }
  function rpc(m) { return function () { return syncCall(m, Array.prototype.slice.call(arguments)); }; }

  // 异步 HTTP 桥: 手机侧发起请求 (无 CORS, 可带账号 auth1/Origin), 回灌 window.__httpCb
  function httpBridge(b64) {
    return function (reqId, method, url, headersJson, body) {
      var headers = {}; try { headers = JSON.parse(headersJson || "{}"); } catch (e) {}
      fetch(RELAY, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
        body: frame("/api/http", { b64: !!b64, method: method || "GET", url: url, headers: headers, body: body == null ? "" : body })
      }).then(function (r) { return r.text(); })
        .then(function (t) { var res; try { res = JSON.parse(t); } catch (e) { res = { status: 0, error: "bad_json" }; }
          try { window.__httpCb && window.__httpCb(reqId, res); } catch (e) {} })
        .catch(function (e) { try { window.__httpCb && window.__httpCb(reqId, { status: 0, error: String(e) }); } catch (_) {} });
    };
  }

  // ── 输出到使用者自己的浏览器/设备 (比落到手机更符合"远程用网页"的语义) ──
  function _toast(msg) {
    try {
      var el = document.getElementById("__rn_toast");
      if (!el) { el = document.createElement("div"); el.id = "__rn_toast";
        el.style.cssText = "position:fixed;left:50%;bottom:42px;transform:translateX(-50%);background:#222;color:#fff;padding:9px 15px;border-radius:9px;font:13px sans-serif;z-index:2147483647;opacity:0;transition:.2s;max-width:80%";
        (document.body || document.documentElement).appendChild(el); }
      el.textContent = String(msg == null ? "" : msg); el.style.opacity = "1";
      clearTimeout(el._t); el._t = setTimeout(function () { el.style.opacity = "0"; }, 2000);
    } catch (e) {}
  }
  function _clip(t) {
    var s = String(t == null ? "" : t);
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s); return; } } catch (e) {}
    try { var ta = document.createElement("textarea"); ta.value = s; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand("copy"); ta.remove(); } catch (e) {}
  }
  function _download(name, data, isB64, mime) {
    try {
      var blob;
      if (isB64) { var bin = atob(data || ""), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr], { type: mime || "application/octet-stream" }); }
      else blob = new Blob([data == null ? "" : data], { type: mime || "text/plain;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name || "download";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return name || "download";
    } catch (e) { return ""; }
  }
  function _openText(title, content) {
    try { var w = window.open("", "_blank");
      if (w) { w.document.title = title || "text"; var pre = w.document.createElement("pre");
        pre.style.cssText = "white-space:pre-wrap;word-break:break-word;padding:16px;font:13px/1.5 monospace";
        pre.textContent = content == null ? "" : content; w.document.body.appendChild(pre); }
      else _toast(content); } catch (e) { _toast(content); }
  }
  function _open(u) { try { window.open(u || "https://app.devin.ai/", "_blank"); } catch (e) {} }

  var Native = {
    // 网络 (异步回灌 __httpCb)
    httpReq: httpBridge(false), httpReqB64: httpBridge(true),
    // 输出到使用者的浏览器/设备
    clip: _clip, setClip: _clip,
    share: function (t) { try { if (navigator.share) { navigator.share({ text: String(t || "") }); } else _clip(t); } catch (e) { _clip(t); } },
    saveTextFile: function (name, content) { return _download(name, content, false); },
    saveBase64File: function (name, b64) { return _download(name, b64, true); },
    openText: _openText,
    openTab: _open, openUrlTab: _open,
    openAccountTab: function () { _open("https://app.devin.ai/"); },
    openEntryNewTab: function () { _open("https://app.devin.ai/"); },
    openAccountSession: function (accJson, sid) { _open("https://app.devin.ai/sessions/" + (sid || "")); },
    reopenAccount: function () { _open("https://app.devin.ai/"); },
    notify: _toast, toast: _toast,
    vibrate: function (ms) { try { navigator.vibrate && navigator.vibrate(ms || 30); } catch (e) {} },
    log: function (s) { try { console.log("[app]", s); } catch (e) {} },
    parse: function (s) { try { return JSON.parse(s); } catch (e) { return null; } },
    stringify: function (o) { try { return JSON.stringify(o); } catch (e) { return ""; } },
    // 纯设备/原生 UI (浏览器里无意义) → 安全空操作
    setTabStatus: function () {}, setTabDollars: function () {}, startConvDrag: function () {},
    menu: function () {}, report: function () {}, share2: function () {}
  };

  // 其余皆走手机 (同步): 状态读取 / 隧道·E2E·配置 读写 / 金库读写 / 用户脚本 等
  var R = ["conn", "relayStatus", "tunnelStat", "isTunnelEnabled", "setTunnelEnabled", "lanDirect", "isLanDirect",
    "setLanDirect", "e2eEnabled", "e2eRequired", "setE2eRequired", "e2eSeal", "e2eOpen", "saveRelayConfig",
    "relayRestart", "rotateRelayToken", "keepAliveStatus", "requestBatteryOpt", "openAutoStart",
    "openBatterySettings", "phoneA11yReady", "phoneEnsureControl", "isRemoteOpsEnabled", "setRemoteOps",
    "appCheckUpdate", "appInstallUpdate", "appToFront", "overlayGranted", "requestOverlay",
    "vpnStatus", "detectProxy", "currentProxy", "applyProxy", "clearProxy",
    "openVpnSettings", "launchApp", "shizukuStatus", "shizukuRequest", "shizukuGrantAll", "shizukuShell",
    "shizukuOpenManager", "vaultSave", "vaultLoad", "vaultSaveBackup", "vaultSaveBackupB64", "vaultListBackups",
    "vaultReadBackup", "vaultListBackupAccounts", "vaultReadBackupB64", "usList", "usGetSource", "usSaveCode",
    "usInstall", "usDelete", "usToggle", "gmGet", "gmSet", "gmDel", "gmList"];
  R.forEach(function (m) { if (!(m in Native)) Native[m] = rpc(m); });

  window.Native = Native;

  // 用手机金库里的真实数据水合本浏览器 localStorage → 真实页面渲染真实账号
  try {
    if (SESSION && TOKEN && !localStorage.getItem("rtflow.accounts")) {
      var acc = syncCall("vaultLoad", ["accounts"]);
      if (acc && typeof acc === "string" && acc.length > 2) localStorage.setItem("rtflow.accounts", acc);
    }
  } catch (e) {}
})();
