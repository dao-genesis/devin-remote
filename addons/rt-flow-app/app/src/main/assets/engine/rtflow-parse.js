// rtflow-parse.js · 万法识号 v2.7 解析器 · 自 core/dao-vsix/rtflow/extension.js (4386-4901) verbatim 移植
// 纯正则/字符串, 无 Node 依赖。导出 parseAccountText(content) → { accounts:[{email,password}], tokens:[string] }
(function(global){
function _isValidEmail(s) {
  if (!s || typeof s !== "string") return false;
  s = s.trim();
  if (s.length < 5 || s.length > 254) return false;
  if (/[\s|;,，；\t]/.test(s)) return false; // 分隔符即非法
  // local 段 RFC 宽放: A-Z a-z 0-9 . _ + -
  // domain 段必须有点且 TLD 字母 ≥2
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(
    s,
  );
}

// 行尾提示剥离 · 微信常附 "(无任何空格)" "(去掉点)" 等于真账号行尾 · 弱者道之用
// 不整行跳过 · 仅剥尾 · 留真主之身
function _stripWxHints(ln) {
  if (!ln) return ln;
  // 反复剥尾 · 直到稳定
  let prev;
  do {
    prev = ln;
    ln = ln
      // 微信反屏蔽提示
      .replace(
        /[（(]\s*(?:无任何空格|去掉点|去点|去掉空格|无空格)\s*[）)]/g,
        "",
      )
      // 含 URL 的"账号管理器:"等子串 (整行嗅探漏过的中段)
      .replace(/\s+账号管理器\s*[:：=＝]\s*\S+/, "")
      .trim();
  } while (ln !== prev && ln.length > 0);
  return ln;
}

// 噪声行嗅探 · 微信/广告/订单 模板文 · 静默跳过
// 守一: 仅识"整行明显是模板文"者跳过 · 真账号行不在此列 (剥尾后另判)
function _isNoiseLine(ln) {
  if (!ln) return true;
  // 订单编号 · 自动发货 · 您的订单 等模板 (开头明确)
  if (
    /^(?:您的|您好|自动发货|订单编号|订单号|交易号|发货时间|订单时间|发货成功|交易成功|尊敬的)/.test(
      ln,
    )
  )
    return true;
  // 纯日期时间行 (无其他实质内容)
  if (/^\s*\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2}[\s\d:：年月日时分秒]*$/.test(ln))
    return true;
  // 整行就是「账号管理器」类含 URL · 不是真账号
  // (注: 必须开头即此标签 · 否则可能是真账号行的尾巴 · 已由 _stripWxHints 剥)
  if (
    /^(?:账号管理器|管理面板|管理后台|官网|官方网站|官方地址|商城|售后|客服|发货)\s*[:：=＝]/.test(
      ln,
    )
  )
    return true;
  return false;
}

// ═══ v3.0.4 水无常形·万格通吃 · 账密解析全量增强 ═══
// 标签词典 MID版 (非行首锁定) · 用于行内搜索双标签同行 / bracket兼容
const _RE_EMAIL_LABEL_MID =
  /(?:\[|【)?(?:邮箱|邮件|账号|账户|帐号|帐户|用户名称?|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i;
const _RE_PASS_LABEL_MID =
  /(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i;
// _stripAnyLabel: 剥首标签+数字序号 · tryPair双侧调用 · 密码含"密码："前缀自动净化
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
// _stripPassTrail · 密码尾部注释净化 · 一劳永逸之本
// 密码永远没有格式 · 但人们常在密码后追加备注 【首次登录需修改】(备注:xxx) 等
// 凡此类尾部中文括号注释 · 全剥 · 还密码本真
function _stripPassTrail(s) {
  if (!s) return s;
  let prev;
  do {
    prev = s;
    // 尾部 【...】 （...） (...)
    s = s.replace(/[\s　]*[【（(][^】）)]{0,60}[】）)][\s　]*$/, "").trim();
    // 尾部 备注:xxx / 提示:xxx / 注意:xxx
    s = s.replace(/[\s　]*(?:备注|提示|注意|说明)\s*[:：].{0,60}$/, "").trim();
    // 尾部 首次登录/请修改/需修改 等动词提示
    s = s
      .replace(
        /[\s　]*(?:首次登录|请.*?修改|需.*?修改|初始密码|默认密码).{0,40}$/,
        "",
      )
      .trim();
  } while (s !== prev && s.length > 0);
  return s;
}
// _stripPassCandLabel · 密码候选侧保守剥 · v3.0.5 一劳永逸根治
// 哲学: 密码无结构 · 只有"确定无歧义"的标签才能被剥取 · 不能剥短歧义词(pass/key/secret/pwd)
//   _stripAnyLabel 含 pass(?:word|wd)? 使裸 pass 也匹配 → user@x.com:pass:word123 被污染为 word123
//   此函数专用于密码候选侧 · 只剥中文标签(无歧义) + 全英长词(>= 8char · 无歧义)
//   保留: pass:xxx / key:xxx / pwd:xxx / secret:xxx 等短英文 → 不再被误剥
function _stripPassCandLabel(s) {
  s = (s || "").trim();
  // 中文标签: 语义明确 无歧义 可安全剥
  s = s
    .replace(
      /^(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i,
      "",
    )
    .trim();
  // 全英长词(>=8字符): password/passphrase/passwd 无歧义可安全剥 · 不含 pass/key/pwd/secret
  s = s
    .replace(/^(?:password|passphrase|passwd)\s*\d*\s*[:：=＝]\s*/i, "")
    .trim();
  return s;
}
// _emailAnchorExtract · 邮箱锚定通吃法 · 真正一劳永逸之本源
// 哲学: 邮箱是唯一有确定结构的字段 · 密码=行内去除邮箱+标签+噪声后的一切剩余
// 覆盖一切分隔符失效、未知格式、未来格式 — 永久兜底
// v3.0.5: 密码候选改用 _stripPassCandLabel (保守剥) · 不再用 _stripAnyLabel (可污染密码)
const _RE_EMAIL_SCAN =
  /[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/;
function _emailAnchorExtract(ln) {
  const m = _RE_EMAIL_SCAN.exec(ln);
  if (!m) return null;
  const email = m[0];
  const before = ln
    .substring(0, m.index)
    .replace(/[-\s|,;，；=＝：:·#*（(【>]+$/, "")
    .trim();
  const after = ln
    .substring(m.index + email.length)
    .replace(/^[-\s|,;，；=＝：:·#*）)】<]+/, "")
    .trim();
  // v3.0.5: 保守剥 · 密码侧不再使用 _stripAnyLabel
  const passCand = _stripPassTrail(_stripPassCandLabel(after || before));
  if (!passCand || !_isValidEmail(email)) return null;
  return { email, password: passCand };
}

// _parseDualLabelLine: 双标签同行通吃 · 水无常形 · 任意顺序·任意分隔
// 覆盖: 邮箱：email----密码：pass / 邮箱：email 密码：pass / 密码：pass 邮箱：email
//       【邮箱】email【密码】pass / email:xxx password:yyy 等所有双标签同行格式
function _parseDualLabelLine(ln) {
  const em = _RE_EMAIL_LABEL_MID.exec(ln);
  const pm = _RE_PASS_LABEL_MID.exec(ln);
  if (!em || !pm) return null;
  let emailPart, passPart;
  if (em.index <= pm.index) {
    const afterEmail = ln.substring(em.index + em[0].length);
    const pm2 = _RE_PASS_LABEL_MID.exec(afterEmail);
    if (!pm2) return null;
    emailPart = afterEmail
      .substring(0, pm2.index)
      .replace(/[-\s|,;，；=＝：:·]+$/, "")
      .trim();
    passPart = afterEmail.substring(pm2.index + pm2[0].length).trim();
  } else {
    const afterPass = ln.substring(pm.index + pm[0].length);
    const em2 = _RE_EMAIL_LABEL_MID.exec(afterPass);
    if (!em2) return null;
    passPart = afterPass
      .substring(0, em2.index)
      .replace(/[-\s|,;，；=＝：:·]+$/, "")
      .trim();
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

  // v3.0.4+ · JSON 数组整体解析 (批量导出 [{email,password},...] 格式优先尝试)
  const _tc = content.trim();
  if (_tc.startsWith("[")) {
    try {
      const _ja = JSON.parse(_tc);
      if (Array.isArray(_ja)) {
        for (const _j of _ja) {
          if (!_j || typeof _j !== "object") continue;
          const _je = String(
            _j.email ||
              _j.username ||
              _j.account ||
              _j.user ||
              _j.mail ||
              _j.login ||
              "",
          ).trim();
          const _jp = String(
            _j.password || _j.pass || _j.pwd || _j.passwd || _j.secret || "",
          ).trim();
          if (_je && _jp && _isValidEmail(_je))
            accounts.push({ email: _je, password: _jp });
          const _jt = String(
            _j.token ||
              _j.sessionToken ||
              _j.session_token ||
              _j.authToken ||
              _j.access_token ||
              "",
          ).trim();
          if (_jt) tokens.push(_jt);
        }
        if (accounts.length || tokens.length) return { accounts, tokens };
      }
    } catch {}
  }

  // 标签词典 · 大方无隅 · 标签后兼容 \d* 数字编号 (卡号1: / 账号2: / Email3:)
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
    // 长 base64-ish · 60+ chars · 仅 [A-Za-z0-9_-.$/+=]
    if (s.length >= 60 && /^[A-Za-z0-9_\-\.\$\/+=]+$/.test(s)) return true;
    return false;
  }

  // tryPair · v3.0.5 两阶段 · 邮箱先锚密码取余 · 像AI一样 · 一劳永逸
  // 第一阶: 裸检(不剥标签) · 保留原始密码值 · 覆盖: 无标签分隔格式、密码含:=等特殊字符
  // 第二阶: 邮箱侧剥标签后再检 · 覆盖: 邮箱有标签前缀(邮箱：xxx / email:xxx) 的情形
  // 密码侧永远使用 _stripPassCandLabel(保守剥) · 永不使用 _stripAnyLabel · 根治 pass:xxx 污染
  function tryPair(a, b) {
    a = (a || "").trim();
    b = (b || "").trim();
    if (!a || !b) return null;
    // 第一阶: 裸检 (无任何剥取) — 原始值最可信 · 密码含:=等不被误剥
    const aIsEmailRaw = _isValidEmail(a);
    const bIsEmailRaw = _isValidEmail(b);
    if (aIsEmailRaw && !bIsEmailRaw)
      return { email: a, password: _stripPassTrail(_stripPassCandLabel(b)) };
    if (bIsEmailRaw && !aIsEmailRaw)
      return { email: b, password: _stripPassTrail(_stripPassCandLabel(a)) };
    if (aIsEmailRaw && bIsEmailRaw)
      return { email: a, password: _stripPassTrail(b) };
    // 第二阶: 邮箱侧剥标签 (处理 "邮箱：xxx" / "email:xxx" 等有标签前缀的邮箱)
    // 密码侧 b/a 同样只用 _stripPassCandLabel (保守) · 不用 _stripAnyLabel
    const aStripped = _stripAnyLabel(a);
    const bStripped = _stripAnyLabel(b);
    if (!aStripped && !bStripped) return null;
    const aIsEmailSt = _isValidEmail(aStripped);
    const bIsEmailSt = _isValidEmail(bStripped);
    if (aIsEmailSt && !bIsEmailSt)
      return {
        email: aStripped,
        password: _stripPassTrail(_stripPassCandLabel(b)),
      };
    if (bIsEmailSt && !aIsEmailSt)
      return {
        email: bStripped,
        password: _stripPassTrail(_stripPassCandLabel(a)),
      };
    if (aIsEmailSt && bIsEmailSt)
      return { email: aStripped, password: _stripPassTrail(b) };
    return null;
  }

  function parseSingleLine(ln) {
    // 0. 双标签同行通吃 (邮箱：email----密码：pass · 任意顺序·任意分隔)
    const _dlr = _parseDualLabelLine(ln);
    if (_dlr) return _dlr;
    // 0b. 行内密码标签: email@x.com密码：pass / email@x.com 密码：pass
    const _inPm = _RE_PASS_LABEL_MID.exec(ln);
    if (_inPm && _inPm.index > 0) {
      const _ec = ln
        .substring(0, _inPm.index)
        .replace(/[-\s|,;，；=＝：:·]+$/, "")
        .trim();
      const _pc = ln.substring(_inPm.index + _inPm[0].length).trim();
      if (_isValidEmail(_ec) && _pc) return { email: _ec, password: _pc };
    }
    // 0c. 行内邮箱标签: pass 邮箱：email / pass----邮箱：email (密码在前邮箱在后)
    const _inEm = _RE_EMAIL_LABEL_MID.exec(ln);
    if (_inEm && _inEm.index > 0) {
      const _pc2 = _stripAnyLabel(
        ln
          .substring(0, _inEm.index)
          .replace(/[-\s|,;，；=＝：:·]+$/, "")
          .trim(),
      );
      const _ec2 = ln.substring(_inEm.index + _inEm[0].length).trim();
      if (_isValidEmail(_ec2) && _pc2) return { email: _ec2, password: _pc2 };
    }
    // 1. ---- (4+ dashes)
    if (/----+/.test(ln)) {
      const i = ln.search(/----+/);
      const m = ln.substring(i).match(/^----+/);
      const r = tryPair(ln.substring(0, i), ln.substring(i + m[0].length));
      if (r) return r;
    }
    // 2. tab
    if (ln.includes("\t")) {
      const i = ln.indexOf("\t");
      const r = tryPair(ln.substring(0, i), ln.substring(i + 1));
      if (r) return r;
    }
    // 3. colon (ASCII / 全角 / =) · 取首个分隔 · 排除 URL
    if (!/^https?:\/\//i.test(ln)) {
      const ci = ln.search(/[:：=＝]/);
      if (ci !== -1) {
        const r = tryPair(ln.substring(0, ci), ln.substring(ci + 1));
        if (r) return r;
      }
    }
    // 4. pipe
    if (ln.includes("|")) {
      const i = ln.indexOf("|");
      const r = tryPair(ln.substring(0, i), ln.substring(i + 1));
      if (r) return r;
    }
    // 5. comma · 分号 (仅 2 段)
    for (const sep of [",", ";", "，", "；"]) {
      if (ln.includes(sep)) {
        const p = ln.split(sep);
        if (p.length === 2) {
          const r = tryPair(p[0], p[1]);
          if (r) return r;
        }
      }
    }
    // 6. 空白 · 唯需一段为合法 email · 另一段为非空非 email 即认
    const ws = ln.match(/^(\S+)\s+(\S.*?)\s*$/);
    if (ws) {
      const r = tryPair(ws[1], ws[2]);
      if (r) return r;
    }
    // 7. 邮箱锚定通吃法 · 一劳永逸终极兜底 · 凡上述分隔符皆失效时仍可解
    //    原理: 邮箱是唯一有确定结构的字段，密码=行内去除邮箱+标签+噪声后的一切剩余
    //    覆盖: 未知分隔符·未来格式·任意语言注释混入·永不失效
    const _eae = _emailAnchorExtract(ln);
    if (_eae) return _eae;
    return null;
  }

  // 词法 · 把每一行归类为 email | pass | pair | token
  const items = [];
  for (const raw of content.split(/\r?\n/)) {
    let ln = raw.trim();
    if (!ln || ln.startsWith("#") || ln.startsWith("//")) continue;

    // 0a. 剥行尾微信提示 ((无任何空格)/(去掉点)/中段"账号管理器:URL")
    //     弱者道之用 · 不整行弃 · 留真主之身
    ln = _stripWxHints(ln);
    if (!ln) continue;

    // 0b. 噪声行 · 静默跳过 (微信广告模板/订单/账号管理器整行等)
    if (_isNoiseLine(ln)) continue;

    // 0b. 整行就是 token
    if (looksLikeToken(ln)) {
      items.push({ type: "token", raw: ln });
      continue;
    }

    // 1. JSON 单行
    if (ln.startsWith("{") && ln.endsWith("}")) {
      try {
        const j = JSON.parse(ln);
        const e =
          j.email || j.username || j.account || j.user || j.mail || j.login;
        const p = j.password || j.pass || j.pwd || j.passwd || j.secret;
        if (e && p && _isValidEmail(String(e).trim())) {
          items.push({
            type: "pair",
            email: String(e).trim(),
            password: String(p).trim(),
          });
          continue;
        }
        const tk =
          j.token ||
          j.sessionToken ||
          j.session_token ||
          j.authToken ||
          j.access_token;
        if (tk) {
          items.push({ type: "token", raw: String(tk).trim() });
          continue;
        }
      } catch {}
    }

    // 2. 标签前缀 · 密码 · 守一不退: 标签明确即定锚 · 内容含 @ 仍为密码
    const passM = ln.match(RE_LABEL_PASS);
    if (passM) {
      // v3.0.4+ · 双标签同行优先 (密码：pass----邮箱：email 逆序形 · 水无常形)
      const _dlrP = _parseDualLabelLine(ln);
      if (_dlrP) {
        items.push({
          type: "pair",
          email: _dlrP.email,
          password: _dlrP.password,
        });
        continue;
      }
      const v = _stripPassTrail(ln.substring(passM[0].length).trim());
      if (v) {
        // 标签即锚 · 不再以 含@ 排除 (修病二: uuCO4@7hukcO 不再误判)
        if (looksLikeToken(v)) items.push({ type: "token", raw: v });
        else items.push({ type: "pass", password: v });
        continue;
      }
      // v 为空 · 罕 · 跳过即可
      continue;
    }

    // 3. 标签前缀 · 邮箱 · 守一: 必须 isValidEmail 才认 (修病四: '账号管理器:URL' 不再误伤)
    const emailM = ln.match(RE_LABEL_EMAIL);
    if (emailM) {
      // v3.0.4+ · 双标签同行优先 (邮箱：email----密码：pass · 水无常形)
      const _dlrE = _parseDualLabelLine(ln);
      if (_dlrE) {
        items.push({
          type: "pair",
          email: _dlrE.email,
          password: _dlrE.password,
        });
        continue;
      }
      const v = ln.substring(emailM[0].length).trim();
      if (_isValidEmail(v)) {
        items.push({ type: "email", email: v });
        continue;
      }
      // 非合法 email · 可能是 "账号: foo@bar.com password" 之同行带密码
      // 剥前缀后让 parseSingleLine 处理
      ln = v || ln;
    }

    // 4. 组合行 (各种分隔符)
    const pair = parseSingleLine(ln);
    if (pair) {
      items.push({
        type: "pair",
        email: pair.email,
        password: pair.password,
      });
      continue;
    }

    // 5. 兜底: 整行就是合法邮箱 (待与下一行密码配对)
    if (_isValidEmail(ln)) {
      items.push({ type: "email", email: ln });
      continue;
    }

    // 6. 仍然像 token (放宽阈值 40+)
    if (
      ln.length >= 40 &&
      /^[A-Za-z0-9_\-\.\$\/+=]+$/.test(ln) &&
      !ln.includes("@")
    ) {
      items.push({ type: "token", raw: ln });
      continue;
    }
    // 不可识别 · 静默跳过
  }

  // 序列配对 · 双向 · 顺逆皆通
  let pendingEmail = null;
  let pendingPass = null;
  for (const it of items) {
    if (it.type === "pair") {
      if (it.email && it.password && _isValidEmail(it.email))
        accounts.push({ email: it.email, password: it.password });
      pendingEmail = null;
      pendingPass = null;
    } else if (it.type === "email") {
      if (pendingPass) {
        // 反序: 先 pass 后 email
        accounts.push({ email: it.email, password: pendingPass });
        pendingPass = null;
        pendingEmail = null;
      } else {
        // 已有 pendingEmail 而无 pass · 新 email 覆盖 (前者孤立 · 弃)
        pendingEmail = it.email;
      }
    } else if (it.type === "pass") {
      if (pendingEmail) {
        accounts.push({ email: pendingEmail, password: it.password });
        pendingEmail = null;
      } else {
        // 反序: pass 在前 · 缓存等下一 email
        pendingPass = it.password;
      }
    } else if (it.type === "token") {
      tokens.push(it.raw);
    }
  }

  return { accounts, tokens };
}
  global.parseAccountText = parseAccountText;
})(typeof window!=='undefined'?window:this);
