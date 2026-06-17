/**
 * 万法识号 — Universal account-text parser.
 *
 * Ported from core/rt-flow (parseAccountText) into the standalone dao-export
 * plugin so it can recognise accounts pasted in ANY format and feed the
 * multi-account store. Zero runtime deps (pure string work) — works the same on
 * Windows / macOS / Linux and in any VS Code-compatible editor.
 *
 * Input: arbitrary text (WeChat 发货消息 / email / JSON / CSV / token panel /
 *        卡号卡密 / order message …).
 * Output: { accounts: [{email, password}], tokens: [string] }.
 *
 * 道法自然 · 大方无隅 · 同出异名
 */

export interface ParsedAccount { email: string; password: string; }
export interface ParseResult { accounts: ParsedAccount[]; tokens: string[]; }

/** 合法邮箱严判 · 大象无形 而有定准 (not just includes('@')). */
export function isValidEmail(s: unknown): boolean {
  if (!s || typeof s !== 'string') { return false; }
  s = s.trim();
  const v = s as string;
  if (v.length < 5 || v.length > 254) { return false; }
  if (/[\s|;,，；\t]/.test(v)) { return false; }
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(v);
}

/** 行尾微信提示剥离 · 不整行弃 · 仅剥尾 · 留真主之身 */
function stripWxHints(ln: string): string {
  if (!ln) { return ln; }
  let prev: string;
  do {
    prev = ln;
    ln = ln
      .replace(/[（(]\s*(?:无任何空格|去掉点|去点|去掉空格|无空格)\s*[）)]/g, '')
      .replace(/\s+账号管理器\s*[:：=＝]\s*\S+/, '')
      .trim();
  } while (ln !== prev && ln.length > 0);
  return ln;
}

/** 噪声行嗅探 · 微信/广告/订单模板文 · 静默跳过 */
function isNoiseLine(ln: string): boolean {
  if (!ln) { return true; }
  if (/^(?:您的|您好|自动发货|订单编号|订单号|交易号|发货时间|订单时间|发货成功|交易成功|尊敬的)/.test(ln)) { return true; }
  if (/^\s*\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2}[\s\d:：年月日时分秒]*$/.test(ln)) { return true; }
  if (/^(?:账号管理器|管理面板|管理后台|官网|官方网站|官方地址|商城|售后|客服|发货)\s*[:：=＝]/.test(ln)) { return true; }
  return false;
}

// 标签词典 MID版 (非行首锁定) · 用于行内搜索双标签同行
const RE_EMAIL_LABEL_MID =
  /(?:\[|【)?(?:邮箱|邮件|账号|账户|帐号|帐户|用户名称?|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i;
const RE_PASS_LABEL_MID =
  /(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i;

/** 剥首标签+数字序号 (卡号1: / 账号2: / Email3:) */
function stripAnyLabel(s: string): string {
  s = (s || '').trim();
  s = s.replace(/^(?:#\s*)?\(?\d+[.):\-、，]\s*/, '').trim();
  s = s.replace(/^(?:\[|【)?(?:邮箱|邮件|账号|账户|帐号|帐户|用户名称?|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i, '').trim();
  s = s.replace(/^(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i, '').trim();
  return s;
}

/** 密码尾部注释净化 (备注/提示/首次登录需修改 等) */
function stripPassTrail(s: string): string {
  if (!s) { return s; }
  let prev: string;
  do {
    prev = s;
    s = s.replace(/[\s　]*[【（(][^】）)]{0,60}[】）)][\s　]*$/, '').trim();
    s = s.replace(/[\s　]*(?:备注|提示|注意|说明)\s*[:：].{0,60}$/, '').trim();
    s = s.replace(/[\s　]*(?:首次登录|请.*?修改|需.*?修改|初始密码|默认密码).{0,40}$/, '').trim();
  } while (s !== prev && s.length > 0);
  return s;
}

/** 密码候选侧保守剥 · 只剥无歧义中文标签 + 全英长词 (不剥 pass/key/pwd/secret) */
function stripPassCandLabel(s: string): string {
  s = (s || '').trim();
  s = s.replace(/^(?:\[|【)?(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌)(?:\]|】)?\s*\d*\s*[:：=＝]\s*/i, '').trim();
  s = s.replace(/^(?:password|passphrase|passwd)\s*\d*\s*[:：=＝]\s*/i, '').trim();
  return s;
}

const RE_EMAIL_SCAN =
  /[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/;

/** 邮箱锚定通吃法 · 一劳永逸终极兜底: 邮箱是唯一有确定结构的字段, 密码=去除邮箱+标签+噪声后的剩余 */
function emailAnchorExtract(ln: string): ParsedAccount | null {
  const m = RE_EMAIL_SCAN.exec(ln);
  if (!m) { return null; }
  const email = m[0];
  const before = ln.substring(0, m.index).replace(/[-\s|,;，；=＝：:·#*（(【>]+$/, '').trim();
  const after = ln.substring(m.index + email.length).replace(/^[-\s|,;，；=＝：:·#*）)】<]+/, '').trim();
  const passCand = stripPassTrail(stripPassCandLabel(after || before));
  if (!passCand || !isValidEmail(email)) { return null; }
  return { email, password: passCand };
}

/** 双标签同行通吃 · 任意顺序·任意分隔 (邮箱：x----密码：y / 密码：y 邮箱：x …) */
function parseDualLabelLine(ln: string): ParsedAccount | null {
  const em = RE_EMAIL_LABEL_MID.exec(ln);
  const pm = RE_PASS_LABEL_MID.exec(ln);
  if (!em || !pm) { return null; }
  let emailPart: string; let passPart: string;
  if (em.index <= pm.index) {
    const afterEmail = ln.substring(em.index + em[0].length);
    const pm2 = RE_PASS_LABEL_MID.exec(afterEmail);
    if (!pm2) { return null; }
    emailPart = afterEmail.substring(0, pm2.index).replace(/[-\s|,;，；=＝：:·]+$/, '').trim();
    passPart = afterEmail.substring(pm2.index + pm2[0].length).trim();
  } else {
    const afterPass = ln.substring(pm.index + pm[0].length);
    const em2 = RE_EMAIL_LABEL_MID.exec(afterPass);
    if (!em2) { return null; }
    passPart = afterPass.substring(0, em2.index).replace(/[-\s|,;，；=＝：:·]+$/, '').trim();
    emailPart = afterPass.substring(em2.index + em2[0].length).trim();
  }
  emailPart = emailPart.replace(/^[-\s·]+/, '').trim();
  passPart = passPart.replace(/^[-\s·]+/, '').trim();
  if (!isValidEmail(emailPart) || !passPart) { return null; }
  return { email: emailPart, password: passPart };
}

interface Item { type: 'email' | 'pass' | 'pair' | 'token'; email?: string; password?: string; raw?: string; }

/**
 * Parse arbitrary account text into structured accounts + raw tokens.
 * 守道之要 · 反者: isValidEmail 严判 · 标签即定锚守一不退 · 双向配对顺逆皆通.
 */
export function parseAccountText(content: string): ParseResult {
  const accounts: ParsedAccount[] = [];
  const tokens: string[] = [];
  if (!content || typeof content !== 'string') { return { accounts, tokens }; }

  // JSON 数组整体解析 (批量导出 [{email,password},...])
  const tc = content.trim();
  if (tc.startsWith('[')) {
    try {
      const ja = JSON.parse(tc);
      if (Array.isArray(ja)) {
        for (const j of ja) {
          if (!j || typeof j !== 'object') { continue; }
          const je = String(j.email || j.username || j.account || j.user || j.mail || j.login || '').trim();
          const jp = String(j.password || j.pass || j.pwd || j.passwd || j.secret || '').trim();
          if (je && jp && isValidEmail(je)) { accounts.push({ email: je, password: jp }); }
          const jt = String(j.token || j.sessionToken || j.session_token || j.authToken || j.access_token || '').trim();
          if (jt) { tokens.push(jt); }
        }
        if (accounts.length || tokens.length) { return { accounts, tokens }; }
      }
    } catch { /* fall through to line parsing */ }
  }

  const RE_LABEL_EMAIL =
    /^\s*(?:邮箱|邮件|账号|账户|帐号|帐户|用户名|用户名称|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)\s*\d*\s*[:：=＝]\s*/i;
  const RE_LABEL_PASS =
    /^\s*(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key|token|access(?:[\-_]?token)?)\s*\d*\s*[:：=＝]\s*/i;
  const RE_TOKEN_PREFIX = /^(devin-session-token\$|auth1_|sk-)/i;
  const RE_JWT = /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/;

  function looksLikeToken(s: string): boolean {
    if (!s) { return false; }
    if (s.includes('@')) { return false; }
    if (/[\s|]|----/.test(s)) { return false; }
    if (RE_TOKEN_PREFIX.test(s)) { return true; }
    if (RE_JWT.test(s)) { return true; }
    if (s.length >= 60 && /^[A-Za-z0-9_\-.$/+=]+$/.test(s)) { return true; }
    return false;
  }

  // tryPair · 两阶段: 裸检 → 邮箱侧剥标签后再检; 密码侧永远保守剥
  function tryPair(a: string, b: string): ParsedAccount | null {
    a = (a || '').trim();
    b = (b || '').trim();
    if (!a || !b) { return null; }
    const aIsEmailRaw = isValidEmail(a);
    const bIsEmailRaw = isValidEmail(b);
    if (aIsEmailRaw && !bIsEmailRaw) { return { email: a, password: stripPassTrail(stripPassCandLabel(b)) }; }
    if (bIsEmailRaw && !aIsEmailRaw) { return { email: b, password: stripPassTrail(stripPassCandLabel(a)) }; }
    if (aIsEmailRaw && bIsEmailRaw) { return { email: a, password: stripPassTrail(b) }; }
    const aStripped = stripAnyLabel(a);
    const bStripped = stripAnyLabel(b);
    if (!aStripped && !bStripped) { return null; }
    const aIsEmailSt = isValidEmail(aStripped);
    const bIsEmailSt = isValidEmail(bStripped);
    if (aIsEmailSt && !bIsEmailSt) { return { email: aStripped, password: stripPassTrail(stripPassCandLabel(b)) }; }
    if (bIsEmailSt && !aIsEmailSt) { return { email: bStripped, password: stripPassTrail(stripPassCandLabel(a)) }; }
    if (aIsEmailSt && bIsEmailSt) { return { email: aStripped, password: stripPassTrail(b) }; }
    return null;
  }

  function parseSingleLine(ln: string): ParsedAccount | null {
    const dlr = parseDualLabelLine(ln);
    if (dlr) { return dlr; }
    const inPm = RE_PASS_LABEL_MID.exec(ln);
    if (inPm && inPm.index > 0) {
      const ec = ln.substring(0, inPm.index).replace(/[-\s|,;，；=＝：:·]+$/, '').trim();
      const pc = ln.substring(inPm.index + inPm[0].length).trim();
      if (isValidEmail(ec) && pc) { return { email: ec, password: pc }; }
    }
    const inEm = RE_EMAIL_LABEL_MID.exec(ln);
    if (inEm && inEm.index > 0) {
      const pc2 = stripAnyLabel(ln.substring(0, inEm.index).replace(/[-\s|,;，；=＝：:·]+$/, '').trim());
      const ec2 = ln.substring(inEm.index + inEm[0].length).trim();
      if (isValidEmail(ec2) && pc2) { return { email: ec2, password: pc2 }; }
    }
    if (/----+/.test(ln)) {
      const i = ln.search(/----+/);
      const m = ln.substring(i).match(/^----+/);
      const r = m && tryPair(ln.substring(0, i), ln.substring(i + m[0].length));
      if (r) { return r; }
    }
    if (ln.includes('\t')) {
      const i = ln.indexOf('\t');
      const r = tryPair(ln.substring(0, i), ln.substring(i + 1));
      if (r) { return r; }
    }
    if (!/^https?:\/\//i.test(ln)) {
      const ci = ln.search(/[:：=＝]/);
      if (ci !== -1) {
        const r = tryPair(ln.substring(0, ci), ln.substring(ci + 1));
        if (r) { return r; }
      }
    }
    if (ln.includes('|')) {
      const i = ln.indexOf('|');
      const r = tryPair(ln.substring(0, i), ln.substring(i + 1));
      if (r) { return r; }
    }
    for (const sep of [',', ';', '，', '；']) {
      if (ln.includes(sep)) {
        const p = ln.split(sep);
        if (p.length === 2) {
          const r = tryPair(p[0], p[1]);
          if (r) { return r; }
        }
      }
    }
    const ws = ln.match(/^(\S+)\s+(\S.*?)\s*$/);
    if (ws) {
      const r = tryPair(ws[1], ws[2]);
      if (r) { return r; }
    }
    const eae = emailAnchorExtract(ln);
    if (eae) { return eae; }
    return null;
  }

  // 词法 · 把每一行归类为 email | pass | pair | token
  const items: Item[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let ln = raw.trim();
    if (!ln || ln.startsWith('#') || ln.startsWith('//')) { continue; }
    ln = stripWxHints(ln);
    if (!ln) { continue; }
    if (isNoiseLine(ln)) { continue; }
    if (looksLikeToken(ln)) { items.push({ type: 'token', raw: ln }); continue; }

    if (ln.startsWith('{') && ln.endsWith('}')) {
      try {
        const j = JSON.parse(ln);
        const e = j.email || j.username || j.account || j.user || j.mail || j.login;
        const p = j.password || j.pass || j.pwd || j.passwd || j.secret;
        if (e && p && isValidEmail(String(e).trim())) {
          items.push({ type: 'pair', email: String(e).trim(), password: String(p).trim() });
          continue;
        }
        const tk = j.token || j.sessionToken || j.session_token || j.authToken || j.access_token;
        if (tk) { items.push({ type: 'token', raw: String(tk).trim() }); continue; }
      } catch { /* not JSON */ }
    }

    const passM = ln.match(RE_LABEL_PASS);
    if (passM) {
      const dlrP = parseDualLabelLine(ln);
      if (dlrP) { items.push({ type: 'pair', email: dlrP.email, password: dlrP.password }); continue; }
      const v = stripPassTrail(ln.substring(passM[0].length).trim());
      if (v) {
        if (looksLikeToken(v)) { items.push({ type: 'token', raw: v }); }
        else { items.push({ type: 'pass', password: v }); }
        continue;
      }
      continue;
    }

    const emailM = ln.match(RE_LABEL_EMAIL);
    if (emailM) {
      const dlrE = parseDualLabelLine(ln);
      if (dlrE) { items.push({ type: 'pair', email: dlrE.email, password: dlrE.password }); continue; }
      const v = ln.substring(emailM[0].length).trim();
      if (isValidEmail(v)) { items.push({ type: 'email', email: v }); continue; }
      ln = v || ln;
    }

    const pair = parseSingleLine(ln);
    if (pair) { items.push({ type: 'pair', email: pair.email, password: pair.password }); continue; }

    if (isValidEmail(ln)) { items.push({ type: 'email', email: ln }); continue; }

    if (ln.length >= 40 && /^[A-Za-z0-9_\-.$/+=]+$/.test(ln) && !ln.includes('@')) {
      items.push({ type: 'token', raw: ln });
      continue;
    }
  }

  // 序列配对 · 双向 · 顺逆皆通
  let pendingEmail: string | null = null;
  let pendingPass: string | null = null;
  for (const it of items) {
    if (it.type === 'pair') {
      if (it.email && it.password && isValidEmail(it.email)) { accounts.push({ email: it.email, password: it.password }); }
      pendingEmail = null;
      pendingPass = null;
    } else if (it.type === 'email') {
      if (pendingPass) {
        accounts.push({ email: it.email!, password: pendingPass });
        pendingPass = null;
        pendingEmail = null;
      } else {
        pendingEmail = it.email!;
      }
    } else if (it.type === 'pass') {
      if (pendingEmail) {
        accounts.push({ email: pendingEmail, password: it.password! });
        pendingEmail = null;
      } else {
        pendingPass = it.password!;
      }
    } else if (it.type === 'token') {
      tokens.push(it.raw!);
    }
  }

  return { accounts, tokens };
}
