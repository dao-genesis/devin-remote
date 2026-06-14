"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// parse.js · rt-flow 浏览器版 · 万法识号 v2.7.0 (与 rt-flow 本体 parseAccountText 一脉)
//
// 反者道之动 · 弱之胜强 柔之胜刚 · 唯变所适 · 适应万法之格式 · 无为而无不为
//   输入: 任意文本 (粘贴自微信/邮件/JSON/CSV/Token面板/卡号卡密/订单消息)
//   输出: { accounts: [{email, password}], tokens: [string] }
//
// 纯字符串/正则 · 无任何 Node/vscode 依赖 → service worker / popup / 单测皆可直取。
// 端口自 plugins/rt-flow/extension.js §万法识号 v2.7.0 (逐字对齐 · 仅去 fs/vscode 外壳)。
// ═══════════════════════════════════════════════════════════════════════════
const DaoParse = (() => {
  // 合法邮箱严判 · 大象无形 而有定准
  function _isValidEmail(s) {
    if (!s || typeof s !== "string") return false;
    s = s.trim();
    if (s.length < 5 || s.length > 254) return false;
    if (/[\s|;,，；\t]/.test(s)) return false; // 分隔符即非法
    return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(
      s,
    );
  }

  // 行尾提示剥离 · 微信常附 "(无任何空格)" "(去掉点)" 等于真账号行尾 · 弱者道之用
  function _stripWxHints(ln) {
    if (!ln) return ln;
    let prev;
    do {
      prev = ln;
      ln = ln
        .replace(/[（(]\s*(?:无任何空格|去掉点|去点|去掉空格|无空格)\s*[）)]/g, "")
        .replace(/\s+账号管理器\s*[:：=＝]\s*\S+/, "")
        .trim();
    } while (ln !== prev && ln.length > 0);
    return ln;
  }

  // 噪声行嗅探 · 微信/广告/订单 模板文 · 静默跳过
  function _isNoiseLine(ln) {
    if (!ln) return true;
    if (/^(?:您的|您好|自动发货|订单编号|订单号|交易号|发货时间|订单时间|发货成功|交易成功|尊敬的)/.test(ln)) return true;
    if (/^\s*\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2}[\s\d:：年月日时分秒]*$/.test(ln)) return true;
    if (/^(?:账号管理器|管理面板|管理后台|官网|官方网站|官方地址|商城|售后|客服|发货)\s*[:：=＝]/.test(ln)) return true;
    return false;
  }

  // 标签词典 MID版 (非行首锁定) · 用于行内搜索双标签同行 / bracket兼容
  const _RE_EMAIL_LABEL_MID =
    /(?:\[|【)?(?:邮箱|邮件|账号|账户|帐号|帐户|用户名称?|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i;
  const _RE_PASS_LABEL_MID =
    /(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i;

  function _stripAnyLabel(s) {
    s = (s || "").trim();
    s = s.replace(/^(?:#\s*)?\(?\d+[.):\-、，]\s*/, "").trim();
    s = s
      .replace(
        /^(?:\[|【)?(?:邮箱|邮件|账号|账户|帐号|帐户|用户名称?|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i,
        "",
      )
      .trim();
    s = s
      .replace(
        /^(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i,
        "",
      )
      .trim();
    return s;
  }

  function _stripPassTrail(s) {
    if (!s) return s;
    let prev;
    do {
      prev = s;
      s = s.replace(/[\s　]*[【（(][^】）)]{0,60}[】）)][\s　]*$/, "").trim();
      s = s.replace(/[\s　]*(?:备注|提示|注意|说明)\s*[:：].{0,60}$/, "").trim();
      s = s
        .replace(/[\s　]*(?:首次登录|请.*?修改|需.*?修改|初始密码|默认密码).{0,40}$/, "")
        .trim();
    } while (s !== prev && s.length > 0);
    return s;
  }

  function _stripPassCandLabel(s) {
    s = (s || "").trim();
    s = s
      .replace(
        /^(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i,
        "",
      )
      .trim();
    s = s.replace(/^(?:password|passphrase|passwd)\s*\d*\s*[:：=＝]\s*/i, "").trim();
    return s;
  }

  const _RE_EMAIL_SCAN =
    /[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/;
  function _emailAnchorExtract(ln) {
    const m = _RE_EMAIL_SCAN.exec(ln);
    if (!m) return null;
    const email = m[0];
    const before = ln.substring(0, m.index).replace(/[-\s|,;，；=＝：:·#*（(【>]+$/, "").trim();
    const after = ln.substring(m.index + email.length).replace(/^[-\s|,;，；=＝：:·#*）)】<]+/, "").trim();
    const passCand = _stripPassTrail(_stripPassCandLabel(after || before));
    if (!passCand || !_isValidEmail(email)) return null;
    return { email, password: passCand };
  }

  function _parseDualLabelLine(ln) {
    const em = _RE_EMAIL_LABEL_MID.exec(ln);
    const pm = _RE_PASS_LABEL_MID.exec(ln);
    if (!em || !pm) return null;
    let emailPart, passPart;
    if (em.index <= pm.index) {
      const afterEmail = ln.substring(em.index + em[0].length);
      const pm2 = _RE_PASS_LABEL_MID.exec(afterEmail);
      if (!pm2) return null;
      emailPart = afterEmail.substring(0, pm2.index).replace(/[-\s|,;，；=＝：:·]+$/, "").trim();
      passPart = afterEmail.substring(pm2.index + pm2[0].length).trim();
    } else {
      const afterPass = ln.substring(pm.index + pm[0].length);
      const em2 = _RE_EMAIL_LABEL_MID.exec(afterPass);
      if (!em2) return null;
      passPart = afterPass.substring(0, em2.index).replace(/[-\s|,;，；=＝：:·]+$/, "").trim();
      emailPart = afterPass.substring(em2.index + em2[0].length).trim();
    }
    emailPart = emailPart.replace(/^[-\s·]+/, "").trim();
    passPart = passPart.replace(/^[-\s·]+/, "").trim();
    if (!_isValidEmail(emailPart) || !passPart) return null;
    return { email: emailPart, password: passPart };
  }

  function parseAccountText(content) {
    const accounts = [];
    const tokens = [];
    if (!content || typeof content !== "string") return { accounts, tokens };

    // JSON 数组整体解析
    const _tc = content.trim();
    if (_tc.startsWith("[")) {
      try {
        const _ja = JSON.parse(_tc);
        if (Array.isArray(_ja)) {
          for (const _j of _ja) {
            if (!_j || typeof _j !== "object") continue;
            const _je = String(_j.email || _j.username || _j.account || _j.user || _j.mail || _j.login || "").trim();
            const _jp = String(_j.password || _j.pass || _j.pwd || _j.passwd || _j.secret || "").trim();
            if (_je && _jp && _isValidEmail(_je)) accounts.push({ email: _je, password: _jp });
            const _jt = String(_j.token || _j.sessionToken || _j.session_token || _j.authToken || _j.access_token || "").trim();
            if (_jt) tokens.push(_jt);
          }
          if (accounts.length || tokens.length) return { accounts, tokens };
        }
      } catch {}
    }

    const RE_LABEL_EMAIL =
      /^\s*(?:邮箱|邮件|账号|账户|帐号|帐户|用户名|用户名称|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)\s*\d*\s*[:：=＝]\s*/i;
    const RE_LABEL_PASS =
      /^\s*(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key|token|access(?:[\-_]?token)?)\s*\d*\s*[:：=＝]\s*/i;
    const RE_TOKEN_PREFIX = /^(devin-session-token\$|auth1_|sk-)/i;
    const RE_JWT = /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/;

    function looksLikeToken(s) {
      if (!s) return false;
      if (s.includes("@")) return false;
      if (/[\s\|]|----/.test(s)) return false;
      if (RE_TOKEN_PREFIX.test(s)) return true;
      if (RE_JWT.test(s)) return true;
      if (s.length >= 60 && /^[A-Za-z0-9_\-\.\$\/+=]+$/.test(s)) return true;
      return false;
    }

    function tryPair(a, b) {
      a = (a || "").trim();
      b = (b || "").trim();
      if (!a || !b) return null;
      const aIsEmailRaw = _isValidEmail(a);
      const bIsEmailRaw = _isValidEmail(b);
      if (aIsEmailRaw && !bIsEmailRaw) return { email: a, password: _stripPassTrail(_stripPassCandLabel(b)) };
      if (bIsEmailRaw && !aIsEmailRaw) return { email: b, password: _stripPassTrail(_stripPassCandLabel(a)) };
      if (aIsEmailRaw && bIsEmailRaw) return { email: a, password: _stripPassTrail(b) };
      const aStripped = _stripAnyLabel(a);
      const bStripped = _stripAnyLabel(b);
      if (!aStripped && !bStripped) return null;
      const aIsEmailSt = _isValidEmail(aStripped);
      const bIsEmailSt = _isValidEmail(bStripped);
      if (aIsEmailSt && !bIsEmailSt) return { email: aStripped, password: _stripPassTrail(_stripPassCandLabel(b)) };
      if (bIsEmailSt && !aIsEmailSt) return { email: bStripped, password: _stripPassTrail(_stripPassCandLabel(a)) };
      if (aIsEmailSt && bIsEmailSt) return { email: aStripped, password: _stripPassTrail(b) };
      return null;
    }

    function parseSingleLine(ln) {
      const _dlr = _parseDualLabelLine(ln);
      if (_dlr) return _dlr;
      const _inPm = _RE_PASS_LABEL_MID.exec(ln);
      if (_inPm && _inPm.index > 0) {
        const _ec = ln.substring(0, _inPm.index).replace(/[-\s|,;，；=＝：:·]+$/, "").trim();
        const _pc = ln.substring(_inPm.index + _inPm[0].length).trim();
        if (_isValidEmail(_ec) && _pc) return { email: _ec, password: _pc };
      }
      const _inEm = _RE_EMAIL_LABEL_MID.exec(ln);
      if (_inEm && _inEm.index > 0) {
        const _pc2 = _stripAnyLabel(ln.substring(0, _inEm.index).replace(/[-\s|,;，；=＝：:·]+$/, "").trim());
        const _ec2 = ln.substring(_inEm.index + _inEm[0].length).trim();
        if (_isValidEmail(_ec2) && _pc2) return { email: _ec2, password: _pc2 };
      }
      if (/----+/.test(ln)) {
        const i = ln.search(/----+/);
        const m = ln.substring(i).match(/^----+/);
        const r = tryPair(ln.substring(0, i), ln.substring(i + m[0].length));
        if (r) return r;
      }
      if (ln.includes("\t")) {
        const i = ln.indexOf("\t");
        const r = tryPair(ln.substring(0, i), ln.substring(i + 1));
        if (r) return r;
      }
      if (!/^https?:\/\//i.test(ln)) {
        const ci = ln.search(/[:：=＝]/);
        if (ci !== -1) {
          const r = tryPair(ln.substring(0, ci), ln.substring(ci + 1));
          if (r) return r;
        }
      }
      if (ln.includes("|")) {
        const i = ln.indexOf("|");
        const r = tryPair(ln.substring(0, i), ln.substring(i + 1));
        if (r) return r;
      }
      for (const sep of [",", ";", "，", "；"]) {
        if (ln.includes(sep)) {
          const p = ln.split(sep);
          if (p.length === 2) {
            const r = tryPair(p[0], p[1]);
            if (r) return r;
          }
        }
      }
      const ws = ln.match(/^(\S+)\s+(\S.*?)\s*$/);
      if (ws) {
        const r = tryPair(ws[1], ws[2]);
        if (r) return r;
      }
      const _eae = _emailAnchorExtract(ln);
      if (_eae) return _eae;
      return null;
    }

    const items = [];
    for (const raw of content.split(/\r?\n/)) {
      let ln = raw.trim();
      if (!ln || ln.startsWith("#") || ln.startsWith("//")) continue;
      ln = _stripWxHints(ln);
      if (!ln) continue;
      if (_isNoiseLine(ln)) continue;
      if (looksLikeToken(ln)) { items.push({ type: "token", raw: ln }); continue; }

      if (ln.startsWith("{") && ln.endsWith("}")) {
        try {
          const j = JSON.parse(ln);
          const e = j.email || j.username || j.account || j.user || j.mail || j.login;
          const p = j.password || j.pass || j.pwd || j.passwd || j.secret;
          if (e && p && _isValidEmail(String(e).trim())) {
            items.push({ type: "pair", email: String(e).trim(), password: String(p).trim() });
            continue;
          }
          const tk = j.token || j.sessionToken || j.session_token || j.authToken || j.access_token;
          if (tk) { items.push({ type: "token", raw: String(tk).trim() }); continue; }
        } catch {}
      }

      const passM = ln.match(RE_LABEL_PASS);
      if (passM) {
        const _dlrP = _parseDualLabelLine(ln);
        if (_dlrP) { items.push({ type: "pair", email: _dlrP.email, password: _dlrP.password }); continue; }
        const v = _stripPassTrail(ln.substring(passM[0].length).trim());
        if (v) {
          if (looksLikeToken(v)) items.push({ type: "token", raw: v });
          else items.push({ type: "pass", password: v });
          continue;
        }
        continue;
      }

      const emailM = ln.match(RE_LABEL_EMAIL);
      if (emailM) {
        const _dlrE = _parseDualLabelLine(ln);
        if (_dlrE) { items.push({ type: "pair", email: _dlrE.email, password: _dlrE.password }); continue; }
        const v = ln.substring(emailM[0].length).trim();
        if (_isValidEmail(v)) { items.push({ type: "email", email: v }); continue; }
        ln = v || ln;
      }

      const pair = parseSingleLine(ln);
      if (pair) { items.push({ type: "pair", email: pair.email, password: pair.password }); continue; }

      if (_isValidEmail(ln)) { items.push({ type: "email", email: ln }); continue; }

      if (ln.length >= 40 && /^[A-Za-z0-9_\-\.\$\/+=]+$/.test(ln) && !ln.includes("@")) {
        items.push({ type: "token", raw: ln });
        continue;
      }
    }

    // 序列配对 · 双向 · 顺逆皆通
    let pendingEmail = null;
    let pendingPass = null;
    for (const it of items) {
      if (it.type === "pair") {
        if (it.email && it.password && _isValidEmail(it.email)) accounts.push({ email: it.email, password: it.password });
        pendingEmail = null;
        pendingPass = null;
      } else if (it.type === "email") {
        if (pendingPass) {
          accounts.push({ email: it.email, password: pendingPass });
          pendingPass = null;
          pendingEmail = null;
        } else pendingEmail = it.email;
      } else if (it.type === "pass") {
        if (pendingEmail) {
          accounts.push({ email: pendingEmail, password: it.password });
          pendingEmail = null;
        } else pendingPass = it.password;
      } else if (it.type === "token") {
        tokens.push(it.raw);
      }
    }

    return { accounts, tokens };
  }

  // 账号池导出为「万法皆归」可再粘贴文本 (一键导出 · email password 每行一个 · 可被本解析器原样回收)
  function exportAccountsText(accounts) {
    return (accounts || [])
      .filter((a) => a && a.email && a.password)
      .map((a) => a.email + " " + a.password)
      .join("\n");
  }

  return { parseAccountText, exportAccountsText, isValidEmail: _isValidEmail };
})();

if (typeof self !== "undefined") self.DaoParse = DaoParse;
if (typeof globalThis !== "undefined") globalThis.DaoParse = DaoParse;
if (typeof module !== "undefined" && module.exports) module.exports = DaoParse;
