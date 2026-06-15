"use strict";
// 纯数测：termux-device 降级 + core.handleRoute 的 handleExtra 扩展路由。
// 运行：node test/device.test.js
const assert = require('assert');
const device = require('../termux-device.js');
const core = require('../../dao-bridge/core.js');

let pass = 0, fail = 0;
function t(name, fn) {
  Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); },
    (e) => { fail++; console.log('  FAIL ' + name + ' :: ' + (e && e.message || e)); });
}

t('baseInfo 含平台/arch/node 字段', () => {
  const b = device.baseInfo();
  assert.ok(b.platform && b.arch && b.node, 'base 字段缺失');
  assert.strictEqual(typeof b.cpus, 'number');
});

t('collect 在无 termux-api 时优雅降级（termux_api=false，仍返回 base）', async () => {
  const out = await device.collect({});
  assert.ok(out.base, 'base 缺失');
  assert.strictEqual(typeof out.termux_api, 'boolean');
});

t('handleExtra: /api/device 经 core.handleRoute 鉴权后返回设备信息', async () => {
  const TOKEN = 'test-token-123';
  const host = {
    workspaceRoot: () => process.cwd(),
    handleExtra: async (route, method, body) => {
      if (route === '/api/device') return { status: 200, body: await device.collect(body) };
      return null;
    },
  };
  const headers = { authorization: 'Bearer ' + TOKEN };
  const r = await core.handleRoute(host, '/api/device', 'POST', headers, '{}', TOKEN);
  assert.strictEqual(r.status, 200, '状态应 200');
  assert.ok(r.body.base, '应含 base');
});

t('handleExtra: 未鉴权应 401（扩展路由不绕过鉴权）', async () => {
  const host = { workspaceRoot: () => process.cwd(), handleExtra: async () => ({ status: 200, body: { leak: true } }) };
  const r = await core.handleRoute(host, '/api/device', 'POST', {}, '{}', 'real-token');
  assert.strictEqual(r.status, 401, '无 Bearer 应 401');
});

t('未知路由仍 404（handleExtra 返回 null 时）', async () => {
  const host = { workspaceRoot: () => process.cwd(), handleExtra: async () => null };
  const r = await core.handleRoute(host, '/api/nope', 'GET', { authorization: 'Bearer x' }, '', 'x');
  assert.strictEqual(r.status, 404);
});

setTimeout(() => {
  console.log(`\ndevice.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 2000);
