"use strict";
// 解析 GitHub 登录 / 2FA / OAuth 授权 / App 安装这些普通 <form> 页面。
// 对应 Python github_api_login.py 里的 _FormParser / _find_form / _otp_field_name。
// 只认 <input>/<button> 的 name/value（GitHub 隐藏字段都是 input），够用。
Object.defineProperty(exports, "__esModule", { value: true });
exports.htmlUnescape = htmlUnescape;
exports.parseForms = parseForms;
exports.findForm = findForm;
exports.otpFieldName = otpFieldName;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
function parseAttrs(tag) {
    const out = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(tag)) !== null) {
        const key = m[1].toLowerCase();
        const val = m[3] ?? m[4] ?? m[5] ?? "";
        out[key] = val;
    }
    return out;
}
/** 还原 HTML 实体：&amp; &lt; &gt; &quot; &#39; &#x..; &#..; 。 */
function htmlUnescape(s) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}
/** 把 HTML 里所有 <form> 连同其 <input>/<button> 的 name/value 抠出来。 */
function parseForms(html) {
    const forms = [];
    const formOpenRe = /<form\b([^>]*)>/gi;
    let m;
    while ((m = formOpenRe.exec(html)) !== null) {
        const attrs = parseAttrs(m[1]);
        const start = formOpenRe.lastIndex;
        const closeIdx = html.toLowerCase().indexOf("</form>", start);
        const inner = closeIdx === -1 ? html.slice(start) : html.slice(start, closeIdx);
        const inputs = {};
        const fieldRe = /<(input|button)\b([^>]*?)\/?>/gi;
        let fm;
        while ((fm = fieldRe.exec(inner)) !== null) {
            const a = parseAttrs(fm[2]);
            const name = a["name"];
            if (!name) {
                continue;
            }
            const hasValue = a["value"] !== undefined && a["value"] !== "";
            // 多个同名：保留最后一个「有值」的；没有值的不覆盖已存在的值。
            if (!(name in inputs) || hasValue) {
                inputs[name] = htmlUnescape(a["value"] ?? "");
            }
        }
        forms.push({
            action: htmlUnescape(attrs["action"] ?? ""),
            method: (attrs["method"] || "get").toLowerCase(),
            inputs,
        });
    }
    return forms;
}
/** 从 HTML 里挑一个表单：按 action 子串 / 含某字段筛，取第一个匹配。 */
function findForm(html, opts = {}) {
    for (const form of parseForms(html)) {
        if (opts.actionContains !== undefined && !form.action.includes(opts.actionContains)) {
            continue;
        }
        if (opts.hasField !== undefined && !(opts.hasField in form.inputs)) {
            continue;
        }
        return form;
    }
    return null;
}
/** GitHub 2FA 表单验证码字段名随方式而变（app_otp / otp / sms_otp …），优先 app_otp。 */
function otpFieldName(inputs) {
    const otpFields = Object.keys(inputs).filter((k) => k.toLowerCase().includes("otp"));
    if (otpFields.length === 0) {
        return null;
    }
    for (const pref of ["app_otp", "otp"]) {
        if (otpFields.includes(pref)) {
            return pref;
        }
    }
    return otpFields[0];
}
//# sourceMappingURL=forms.js.map