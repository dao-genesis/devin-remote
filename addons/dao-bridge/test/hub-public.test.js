// hub-public.test.js — 验证公网中枢入口 hub.js（VPS/服务器形态）
//   端到端(真 HTTP)：boot hub.js → /api/health → 被控端 /api/connect 登记 →
//   /api/agents(master token) 可见 → exec-sync SELF 本机执行 → bootstrap.ps1 注入公网 URL。
// 运行: node test/hub-public.test.js
'use strict';
const assert = require('assert');
const http = require('http');
const cp = require('child_process');
const path = require('path');

const PORT = 9938;
const TOKEN = 'hubpubtest-' + Math.random().toString(16).slice(2);
const BASE = 'http://127.0.0.1:' + PORT;

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(BASE + p, { method, headers, timeout: 8000 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = buf; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'hub.js')], {
    env: Object.assign({}, process.env, {
      DAO_PORT: String(PORT), DAO_BIND: '127.0.0.1', DAO_TOKEN: TOKEN,
      DAO_PUBLIC_URL: BASE,
    }),
    stdio: 'ignore',
  });
  let passed = 0;
  const ok = (n) => { console.log('  PASS  ' + n); passed++; };
  try {
    // 等待监听
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/api/health'); if (h.status === 200) break; } catch {} await sleep(100); }
    const h = await req('GET', '/api/health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.service, 'dao-bridge');
    ok('hub.js 公网监听 · /api/health 200');

    // 被控端登记（免鉴权）
    const conn = await req('POST', '/api/connect', { sysinfo: { hostname: 'PUB-BOX', platform: 'win32' } });
    assert.strictEqual(conn.status, 200);
    assert.strictEqual(conn.body.agent_id, 'PUB-BOX');
    assert.ok(conn.body.token && conn.body.token.length >= 16);
    ok('被控端 /api/connect 登记 → agent_id + per-agent token');

    // /api/agents 需 master token；无 token 401
    const noAuth = await req('GET', '/api/agents');
    assert.strictEqual(noAuth.status, 401, 'agents 无 token 拒绝');
    const list = await req('GET', '/api/agents', null, TOKEN);
    assert.ok(list.body.agents.some((a) => a.id === 'PUB-BOX' && a.status === 'online'));
    ok('/api/agents master token 鉴权 · 被控端在线可见');

    // exec-sync SELF（空 agent_id → 中枢本机执行）
    const self = await req('POST', '/api/exec-sync', { cmd: process.platform === 'win32' ? 'echo self-ok' : 'echo self-ok' }, TOKEN);
    assert.strictEqual(self.status, 200);
    assert.ok(/self-ok/.test(self.body.result.stdout), 'SELF exec 输出');
    ok('exec-sync SELF 中枢本机执行');

    // 远程 exec-sync 三明治：发→被控端 poll→result→解析
    const execP = req('POST', '/api/exec-sync', { agent_id: 'PUB-BOX', cmd: 'whoami', timeout: 10 }, TOKEN);
    await sleep(50);
    const poll = await req('POST', '/api/poll', { id: 'PUB-BOX', token: conn.body.token, timeout: 1 });
    assert.strictEqual(poll.body.commands.length, 1, '被控端 poll 取到一条命令');
    await req('POST', '/api/result', { agent_id: 'PUB-BOX', token: conn.body.token, cmd_id: poll.body.commands[0].cmd_id, result: { stdout: 'PUB-REMOTE', exit_code: 0 } });
    const execR = await execP;
    assert.strictEqual(execR.body.result.stdout, 'PUB-REMOTE', 'operator→hub→agent 三明治闭环');
    ok('远程 exec-sync 三明治(operator→hub→被控端→result)');

    // bootstrap.ps1 注入公网 URL
    const boot = await req('GET', '/api/bootstrap.ps1');
    assert.ok(String(boot.body).includes(BASE), 'bootstrap 注入公网入口 URL');
    ok('/api/bootstrap.ps1 注入 DAO_PUBLIC_URL');

    // install.ps1 持久化(计划任务) 注入公网 URL + 崩溃自愈
    const inst = await req('GET', '/api/install.ps1');
    const instS = String(inst.body);
    assert.ok(instS.includes(BASE), 'install.ps1 注入公网入口 URL');
    assert.ok(instS.includes('Register-ScheduledTask') && instS.includes('DaoHubAgent'), 'install.ps1 注册持久化计划任务');
    assert.ok(instS.includes('RestartCount'), 'install.ps1 崩溃自愈');
    ok('/api/install.ps1 持久化接入(计划任务·自启·自愈)');

    // install.sh 持久化(systemd --user / cron @reboot)
    const instSh = String((await req('GET', '/api/install.sh')).body);
    assert.ok(instSh.includes('dao-hub-agent') && (instSh.includes('systemctl --user') && instSh.includes('@reboot')), 'install.sh systemd/cron 持久化');
    ok('/api/install.sh 持久化接入(systemd --user / cron @reboot)');

    console.log('\nALL ' + passed + ' TESTS PASSED');
    child.kill();
    process.exit(0);
  } catch (e) {
    child.kill();
    console.error('\nTEST FAILED:', (e && e.stack) || e);
    process.exit(1);
  }
})();
