"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// 整页翻译引擎 (内容脚本) · 照搬 Edge 浏览器内置翻译
//   · 遍历可见文本节点 → 经原生桥 __dcTr 调微软 Edge 免费翻译 API (无 key, 国内可直连)
//   · 原生桥做 HTTP → 绕开页面 CSP/跨域 (扩展用后台页, 我们用原生桥, 等效)
//   · 译文回填文本节点, 保留原文 (node.__dcOrig) 以便一键恢复
//   · MutationObserver 增量翻译动态加载内容 (无限滚动/SPA)
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  var S = (window.__dcTrans = window.__dcTrans || {});
  if (S.active) { return; }            // 已在翻译态 → 幂等
  S.active = true;
  S.seq = S.seq || 0;
  S.cbs = S.cbs || {};
  var TO = window.__dcTransTo || "zh-Hans";

  // ── 原生回灌 (Java → JS), 结果为 UTF-8 JSON 的 base64, 避免一切转义问题 ──
  window.__dcTrCb = function (reqId, b64) {
    var cb = S.cbs[reqId]; if (!cb) return; delete S.cbs[reqId];
    var arr = null;
    try {
      var json = decodeURIComponent(Array.prototype.map.call(atob(b64), function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      arr = JSON.parse(json);
    } catch (e) { arr = null; }
    cb(arr);
  };

  function nativeTranslate(texts) {
    return new Promise(function (resolve) {
      var id = "t" + (++S.seq) + "_" + Date.now();
      var done = false;
      S.cbs[id] = function (arr) { if (done) return; done = true; resolve(arr); };
      setTimeout(function () { if (done) return; done = true; delete S.cbs[id]; resolve(null); }, 20000);
      try {
        if (!window.__dcTr || !window.__dcTr.translate) { done = true; resolve(null); return; }
        window.__dcTr.translate(id, JSON.stringify(texts), TO);
      } catch (e) { done = true; resolve(null); }
    });
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, SVG: 1, CANVAS: 1, MATH: 1 };
  // 至少含一个字母 (拉丁/拉丁扩展/西里尔/希腊/假名/谚文) → 跳过纯数字/标点/纯中文
  var HAS_LETTER = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0370-\u03FF\u3040-\u30FF\uAC00-\uD7AF]/;

  function rejectByParent(n) {
    var p = n.parentNode;
    while (p && p.nodeType === 1) {
      if (SKIP[p.tagName]) return true;
      if (p.isContentEditable) return true;
      var tr = p.getAttribute && p.getAttribute("translate");
      if (tr === "no") return true;
      var cls = (p.className && p.className.baseVal !== undefined) ? p.className.baseVal : p.className;
      if (typeof cls === "string" && /(^|\s)notranslate(\s|$)/.test(cls)) return true;
      p = p.parentNode;
    }
    return false;
  }

  function collect(root) {
    var out = [];
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.__dcOrig !== undefined) return NodeFilter.FILTER_REJECT;   // 已译
        var t = n.nodeValue;
        if (!t) return NodeFilter.FILTER_REJECT;
        var s = t.trim();
        if (s.length < 2 || !HAS_LETTER.test(s)) return NodeFilter.FILTER_REJECT;
        if (rejectByParent(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n; while ((n = w.nextNode())) out.push(n);
    return out;
  }

  // 分批: 每批 ≤ 64 段且 ≤ 7000 字符 (微软单请求上限 5万字/1000段, 取保守值)
  function batch(nodes) {
    var batches = [], cur = [], chars = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      if (cur.length && (cur.length >= 64 || chars + len > 7000)) { batches.push(cur); cur = []; chars = 0; }
      cur.push(nodes[i]); chars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  function runOnce(root) {
    var nodes = collect(root || document.body || document.documentElement);
    if (!nodes.length) return Promise.resolve(0);
    var batches = batch(nodes), bi = 0, done = 0;
    return new Promise(function (resolve) {
      function next() {
        if (bi >= batches.length) { resolve(done); return; }
        var grp = batches[bi++];
        var texts = grp.map(function (n) { return n.nodeValue; });
        nativeTranslate(texts).then(function (tr) {
          if (tr && tr.length) {
            for (var i = 0; i < grp.length; i++) {
              var v = tr[i];
              if (v != null && v !== "" && v !== grp[i].nodeValue) {
                grp[i].__dcOrig = grp[i].nodeValue;
                grp[i].nodeValue = v;
                done++;
              } else if (v != null) {
                grp[i].__dcOrig = grp[i].nodeValue;   // 标记已处理, 避免重复请求
              }
            }
          }
          next();
        });
      }
      next();
    });
  }

  function observe() {
    if (S.obs) return;
    try {
      S.obs = new MutationObserver(function () {
        clearTimeout(S.debounce);
        S.debounce = setTimeout(function () { if (S.active) runOnce(document.body); }, 700);
      });
      S.obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  // 一键恢复原文
  window.__dcTransRestore = function () {
    try {
      S.active = false;
      if (S.obs) { S.obs.disconnect(); S.obs = null; }
      var w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, null);
      var n; while ((n = w.nextNode())) {
        if (n.__dcOrig !== undefined) { n.nodeValue = n.__dcOrig; delete n.__dcOrig; }
      }
    } catch (e) {}
  };

  // 启动: 整页翻译一遍, 再开增量观察
  runOnce(document.body || document.documentElement).then(function (c) {
    try { if (window.__dcTr && window.__dcTr.report) window.__dcTr.report(c); } catch (e) {}
    observe();
  });
})();
