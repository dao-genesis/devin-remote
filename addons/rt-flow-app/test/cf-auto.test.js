"use strict";
// cf-auto.js 纯函数切片实测: base32/TOTP(RFC6238 官方向量)/页面分类/Token 抓取/灌入回退。
const assert = require("assert");
const path = require("path");
const CFAUTO = require(path.join(__dirname, "..", "app/src/main/assets/engine/cf-auto.js"));

let pass = 0;
function t(name, fn) { return fn().then(() => { pass++; console.log("  ok -", name); }, e => { console.error("  FAIL -", name, "\n   ", e && e.message || e); process.exitCode = 1; }); }
function ts(name, fn) { return t(name, async () => fn()); }

(async () => {
  // ── base32 ──
  await ts("base32Decode 空白/填充/小写归一", () => {
    const a = CFAUTO.base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    // "12345678901234567890" (RFC6238 SHA1 seed) 的 base32
    assert.strictEqual(Buffer.from(a).toString(), "12345678901234567890");
    assert.deepStrictEqual(Array.from(CFAUTO.base32Decode("mzxw6===")), Array.from(Buffer.from("foo")));
  });

  // ── TOTP RFC6238 官方测试向量 (SHA1, 8 位, seed=12345678901234567890) ──
  const seed32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const vecs = [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]];
  for (const [sec, expect] of vecs) {
    await t("TOTP RFC6238 @" + sec + " => " + expect, async () => {
      const code = await CFAUTO.totp(seed32, sec * 1000, { digits: 8, step: 30 });
      assert.strictEqual(code, expect);
    });
  }
  await t("TOTP 默认 6 位", async () => {
    const c = await CFAUTO.totp(seed32, 59 * 1000);
    assert.strictEqual(c, "287082");  // 8 位向量取后 6 位
  });

  // ── classifyPage ──
  await ts("classify github 登录/2FA/oauth", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login", { ghLogin: true }), "gh_login");
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/sessions/two-factor/app", { gh2fa: true }), "gh_2fa");
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login/oauth/authorize", { ghOauth: true }), "gh_oauth");
  });
  await ts("classify cloudflare 建token/结果", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/profile/api-tokens", { cfContinue: true }), "cf_continue");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/profile/api-tokens", { cfCreate: true }), "cf_create");
    assert.strictEqual(CFAUTO.classifyPage("https://dash.cloudflare.com/x", { cfTokenText: "a".repeat(40) }), "cf_token_result");
  });
  await ts("classify 人机验证/硬件密钥优先停手", () => {
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/login", { ghLogin: true, captcha: true }), "captcha");
    assert.strictEqual(CFAUTO.classifyPage("https://github.com/x", { webauthn: true }), "webauthn");
    assert.strictEqual(CFAUTO.classifyPage("https://example.com", {}), "unknown");
  });

  // ── scrapeToken ──
  await ts("scrapeToken 独占值/句中/排除URL", () => {
    const tk = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    assert.strictEqual(CFAUTO.scrapeToken([tk]), tk);
    assert.strictEqual(CFAUTO.scrapeToken(["your token: " + tk + " keep it safe"]), tk);
    assert.strictEqual(CFAUTO.scrapeToken(["https://x/" + tk]), null);   // URL 噪声排除
    assert.strictEqual(CFAUTO.scrapeToken(["nothing here"]), null);
  });

  // ── feedToken 回退到下一个 base ──
  await t("feedToken 首 base 失败自动回退且带鉴权头", async () => {
    const seen = [];
    const xhr = (opt) => { seen.push(opt); return Promise.resolve({ status: seen.length === 1 ? 502 : 200, responseText: "{\"started\":true}" }); };
    const r = await CFAUTO.feedToken(["http://127.0.0.1:9/", "https://t.example/"], "sess-1", "relaytok", "TOK", xhr);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1].url, "https://t.example/relay/sess-1");
    assert.strictEqual(seen[0].headers.Authorization, "Bearer relaytok");
    assert.ok(JSON.parse(seen[0].data).body.token === "TOK" && JSON.parse(seen[0].data).path === "/api/cf-provision");
  });
  await t("feedToken 全失败抛错", async () => {
    const xhr = () => Promise.resolve({ status: 500 });
    let threw = false;
    try { await CFAUTO.feedToken(["http://a/"], "s", "t", "K", xhr); } catch (e) { threw = true; }
    assert.strictEqual(threw, true);
  });

  console.log("\ncf-auto.test.js: " + pass + " assertions passed");
})();
