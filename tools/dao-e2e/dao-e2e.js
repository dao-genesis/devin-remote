"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// dao-e2e · RPC 载荷端到端加密 (JS 参考实现 · Node 与浏览器双用)
//
// 与设备端 (RelayService.java 的 E2E 内部类) 及 dao_e2e.py 逐字节兼容:
//   · 密钥派生: PBKDF2-HMAC-SHA256(passphrase, salt, 100000, 32B)
//   · 对称加密: AES-256-GCM (128-bit tag 附于密文尾)
//   · 信封(base64): [ver=1 (1B)][salt (16B)][iv (12B)][ciphertext+tag]
//
// 请求 body → {"__e2e__":1,"c":seal(JSON.stringify(realBody))}
// 响应 body → {"__e2e__":1,"c":"<密文>"}，用同 key open 还原。中继只见密文。
// ═══════════════════════════════════════════════════════════════════════════

const VERSION = 1, ITERS = 100000;

// ── Node 实现 (require('crypto')) ──
function nodeCrypto() { try { return require("crypto"); } catch (e) { return null; } }

function sealNode(crypto, passphrase, plaintext) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, ITERS, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), salt, iv, ct, tag]).toString("base64");
}
function openNode(crypto, passphrase, b64) {
  const raw = Buffer.from(b64, "base64");
  if (raw.length < 30 || raw[0] !== VERSION) throw new Error("bad envelope");
  const salt = raw.slice(1, 17), iv = raw.slice(17, 29);
  const body = raw.slice(29), ct = body.slice(0, body.length - 16), tag = body.slice(body.length - 16);
  const key = crypto.pbkdf2Sync(passphrase, salt, ITERS, 32, "sha256");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ── 浏览器实现 (WebCrypto, 需安全上下文) ──
async function deriveWeb(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function b64enc(buf) { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function b64dec(b64) { const s = atob(b64), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
async function sealWeb(passphrase, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWeb(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(1 + 16 + 12 + ct.length);
  out[0] = VERSION; out.set(salt, 1); out.set(iv, 17); out.set(ct, 29);
  return b64enc(out);
}
async function openWeb(passphrase, b64) {
  const raw = b64dec(b64);
  if (raw.length < 30 || raw[0] !== VERSION) throw new Error("bad envelope");
  const salt = raw.slice(1, 17), iv = raw.slice(17, 29), ct = raw.slice(29);
  const key = await deriveWeb(passphrase, salt);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

// ── 统一导出: Node 同步返回 string; 浏览器返回 Promise<string> ──
const _node = nodeCrypto();
function seal(passphrase, plaintext) { return _node ? sealNode(_node, passphrase, plaintext) : sealWeb(passphrase, plaintext); }
function open(passphrase, b64) { return _node ? openNode(_node, passphrase, b64) : openWeb(passphrase, b64); }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { seal, open, VERSION, ITERS };
  if (require.main === module) {
    const k = "test-passphrase-0123456789";
    const msg = JSON.stringify({ cmd: "getState", note: "账号密码不应明文过中继" });
    const env = seal(k, msg);
    if (open(k, env) !== msg) { console.error("round-trip FAILED"); process.exit(1); }
    console.log("self-test ok · envelope=", env.slice(0, 48), "...");
  }
} else if (typeof window !== "undefined") {
  window.DaoE2E = { seal, open, VERSION, ITERS };
}
