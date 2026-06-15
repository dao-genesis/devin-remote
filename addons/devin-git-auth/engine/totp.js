"use strict";
// GitHub 风格 TOTP 密钥的小工具。
//
// Python 后端用 `pyotp`；这里改用 Node 内置 `crypto`（HMAC-SHA1）自实现，
// 避免引入额外 npm 依赖。算法与 pyotp 默认一致：SHA1 / 6 位 / 30s 步长，
// 所以同一个密钥两边算出的码相同。
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSecret = normalizeSecret;
exports.currentCode = currentCode;
exports.codesForTime = codesForTime;
const crypto = __importStar(require("crypto"));
const OTPAUTH_SECRET_RE = /secret=([A-Z2-7=]+)/i;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 接收 base32 原文或完整 `otpauth://` URI，返回去掉空白的 base32 密钥。 */
function normalizeSecret(raw) {
    let value = (raw || "").trim();
    if (!value) {
        return "";
    }
    if (value.toLowerCase().startsWith("otpauth://")) {
        const match = OTPAUTH_SECRET_RE.exec(value);
        if (!match) {
            throw new Error("otpauth URI 里没找到 'secret=' 参数");
        }
        value = match[1];
    }
    return value.replace(/ /g, "").replace(/-/g, "").toUpperCase();
}
function base32Decode(secret) {
    const clean = secret.replace(/=+$/, "").toUpperCase();
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx === -1) {
            throw new Error(`非法 base32 字符：'${ch}'`);
        }
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}
function hotp(key, counter, digits = 6) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return (code % 10 ** digits).toString().padStart(digits, "0");
}
function totpAt(secret, forTime, step = 30, digits = 6) {
    const cleaned = normalizeSecret(secret);
    if (!cleaned) {
        throw new Error("TOTP 密钥为空");
    }
    let key;
    try {
        key = base32Decode(cleaned);
    }
    catch (err) {
        throw new Error(`TOTP 密钥不合法：${String(err)}`);
    }
    if (key.length === 0) {
        throw new Error("TOTP 密钥不合法：解码后为空");
    }
    const counter = Math.floor(forTime / step);
    return hotp(key, counter, digits);
}
/** 返回 `secret` 当前的 6 位 TOTP 验证码。密钥为空 / 非法时抛错。 */
function currentCode(secret) {
    return totpAt(secret, Date.now() / 1000);
}
/**
 * 按 `forTime`（unix 秒）及其相邻时间窗口算出一串候选码，用来对抗轻微时钟漂移。
 * 返回值去重、按 `offsetsS` 顺序排列。密钥为空 / 非法时抛错。
 */
function codesForTime(secret, forTime, offsetsS = [0, -30, 30]) {
    const out = [];
    for (const off of offsetsS) {
        const code = totpAt(secret, Math.floor(forTime) + off);
        if (!out.includes(code)) {
            out.push(code);
        }
    }
    return out;
}
//# sourceMappingURL=totp.js.map