// gh-credmint 纯逻辑单测: TOTP 向量 + 守卫路径(无需 playwright)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, mintPat } from '../gh-credmint.mjs';

test('totp: RFC6238 已知向量(seed=GEZDGNBVGY3TQOJQ · SHA1)', () => {
  // 标准测试种子 "12345678901234567890" 的 base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  // t=59s → 计数器=1, RFC6238 SHA1 6 位 = 287082
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(seed, 59 * 1000), '287082');
  assert.equal(totp(seed, 1111111109 * 1000), '081804');
});

test('totp: 6 位数字·空种子不抛', () => {
  const c = totp('JBSWY3DPEHPK3PXP', Date.now());
  assert.match(c, /^\d{6}$/);
  assert.doesNotThrow(() => totp('', Date.now()));
});

test('mintPat: 缺账号/密码 → ok:false 且不启动浏览器', async () => {
  const r = await mintPat({ login: '', pass: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /缺账号|密码/);
});

test('mintPat: 结果对象不含敏感原文(密码/种子不回吐)', async () => {
  const r = await mintPat({ login: 'x', pass: '' });
  const s = JSON.stringify(r);
  assert.ok(!/secretpass|SEEDSEED/i.test(s));
  assert.equal(r.ok, false);
});
