"use strict";
/* 用户脚本 (油猴 Tampermonkey 兼容) 运行时: 提供 GM_* API 工厂。
 * 由 MainActivity.injectUserScripts 在每个匹配页面注入一次 (幂等)。
 * 跨域请求/存储经原生桥 window.__dcus 完成, 绕开页面 CSP/同源。 */
(function () {
  if (window.__dcMakeGM) return;

  function b64ToUtf8(b64) {
    try {
      return decodeURIComponent(Array.prototype.map.call(atob(b64), function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
    } catch (e) { return ""; }
  }
  window.__dcB64d = function (b64) { try { return JSON.parse(b64ToUtf8(b64)); } catch (e) { return {}; } };

  var XHRCB = (window.__dcusXhrReg = window.__dcusXhrReg || {});
  window.__dcusXhrCb = function (reqId, status, bodyB64, hdrsB64) {
    var cb = XHRCB[reqId]; if (!cb) return; delete XHRCB[reqId];
    var body = b64ToUtf8(bodyB64);
    var headers = {}; try { headers = JSON.parse(b64ToUtf8(hdrsB64)) || {}; } catch (e) {}
    cb(status, body, headers);
  };

  var seq = 0;

  window.__dcMakeGM = function (sid, meta) {
    meta = meta || {};

    var GM_setValue = function (k, v) { try { window.__dcus.gmSet(sid, String(k), JSON.stringify(v)); } catch (e) {} };
    var GM_getValue = function (k, d) {
      try { var s = window.__dcus.gmGet(sid, String(k)); if (s === "" || s == null) return d; return JSON.parse(s); }
      catch (e) { return d; }
    };
    var GM_deleteValue = function (k) { try { window.__dcus.gmDel(sid, String(k)); } catch (e) {} };
    var GM_listValues = function () { try { return JSON.parse(window.__dcus.gmList(sid) || "[]"); } catch (e) { return []; } };
    var GM_addStyle = function (css) {
      try { var s = document.createElement("style"); s.textContent = css;
        (document.head || document.documentElement).appendChild(s); return s; } catch (e) { return null; }
    };
    var GM_log = function () { try { window.__dcus.log(Array.prototype.join.call(arguments, " ")); } catch (e) {} };
    var GM_openInTab = function (url) { try { window.__dcus.openTab(String(url)); } catch (e) {} return { close: function () {} }; };
    var GM_setClipboard = function (t) { try { window.__dcus.setClip(String(t)); } catch (e) {} };
    var GM_notification = function (o) { try { window.__dcus.notify((o && o.text) ? o.text : String(o)); } catch (e) {} };
    var GM_registerMenuCommand = function (cap, fn) {
      try { window.__dcus.menu(sid, String(cap), ""); } catch (e) {}
      (window.__dcusMenus = window.__dcusMenus || []).push({ caption: cap, fn: fn });
      return cap;
    };
    var GM_getResourceText = function () { return ""; };   // v1: @resource 未实现
    var GM_getResourceURL = function () { return ""; };
    var GM_xmlhttpRequest = function (opt) {
      opt = opt || {};
      try {
        var id = "x" + (++seq) + "_" + Date.now();
        XHRCB[id] = function (status, body, headers) {
          var resp = {
            status: status, statusText: "" + status, readyState: 4,
            responseText: body, response: body, finalUrl: opt.url,
            responseHeaders: Object.keys(headers).map(function (k) { return k + ": " + headers[k]; }).join("\r\n")
          };
          if (opt.responseType === "json") { try { resp.response = JSON.parse(body); } catch (e) {} }
          try { if (status >= 200 && status < 400) { if (opt.onload) opt.onload(resp); }
                else if (status === 0) { if (opt.onerror) opt.onerror(resp); }
                else { if (opt.onload) opt.onload(resp); } } catch (e) {}
          if (opt.onreadystatechange) try { opt.onreadystatechange(resp); } catch (e) {}
        };
        var payload = { method: opt.method || "GET", url: opt.url, headers: opt.headers || {}, data: opt.data || "" };
        window.__dcus.xhr(id, JSON.stringify(payload));
      } catch (e) { if (opt.onerror) opt.onerror({ status: 0, error: String(e) }); }
      return { abort: function () {} };
    };

    var GM = {
      setValue: function (k, v) { return Promise.resolve(GM_setValue(k, v)); },
      getValue: function (k, d) { return Promise.resolve(GM_getValue(k, d)); },
      deleteValue: function (k) { return Promise.resolve(GM_deleteValue(k)); },
      listValues: function () { return Promise.resolve(GM_listValues()); },
      xmlHttpRequest: GM_xmlhttpRequest, addStyle: GM_addStyle, openInTab: GM_openInTab,
      setClipboard: GM_setClipboard, notification: GM_notification,
      registerMenuCommand: GM_registerMenuCommand, log: GM_log, info: null
    };
    var GM_info = {
      script: {
        name: meta.name || "", namespace: meta.namespace || "", version: meta.version || "",
        description: meta.description || "", matches: meta.matches || [], includes: meta.includes || [],
        excludes: meta.excludes || [], grant: meta.grants || [], "run-at": meta.runAt || "document-end"
      },
      scriptHandler: "DevinCloud", version: "1.0", scriptMetaStr: ""
    };
    GM.info = GM_info;

    return {
      GM: GM, GM_info: GM_info, GM_setValue: GM_setValue, GM_getValue: GM_getValue,
      GM_deleteValue: GM_deleteValue, GM_listValues: GM_listValues, GM_xmlhttpRequest: GM_xmlhttpRequest,
      GM_addStyle: GM_addStyle, GM_openInTab: GM_openInTab, GM_setClipboard: GM_setClipboard,
      GM_registerMenuCommand: GM_registerMenuCommand, GM_notification: GM_notification,
      GM_getResourceText: GM_getResourceText, GM_getResourceURL: GM_getResourceURL, GM_log: GM_log
    };
  };
})();
