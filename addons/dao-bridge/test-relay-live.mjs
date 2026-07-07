// 持久通道连接器 · 实机自测（打真·已部署 Worker）
// 起本地 echo 服务 → 连接器出站挂 Worker 固定 (session,token) → 公网 POST /relay/<session> → 期望原样 echo。
import http from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { startRelayConnector } = require('./relay.js');

const WORKER = process.env.DAO_RELAY_URL || 'https://dao-relay-do.zhouyoukang.workers.dev';
const SESSION = 'dao-selftest-' + Math.random().toString(36).slice(2, 10);
const TOKEN = 'selftest-' + Math.random().toString(36).slice(2, 10);
const LOCAL_PORT = 39244;
const LOCAL_TOKEN = 'local-secret';

// 本地被代理服务：回显收到的 path/method/body + 校验 Authorization
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const auth = req.headers['authorization'] || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echo: true, path: req.url, method: req.method, gotAuth: auth === 'Bearer ' + LOCAL_TOKEN, body: (() => { try { return JSON.parse(b); } catch { return b; } })() }));
  });
});

function post(url, token, frame) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(frame);
    const u = new URL(url);
    const r = http.request; // https below
    import('https').then(({ default: https }) => {
      const req = https.request({ host: u.host, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(d) } }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(buf); } catch { return buf; } })() }));
      });
      req.on('error', reject);
      req.write(d);
      req.end();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => srv.listen(LOCAL_PORT, '127.0.0.1', r));
  const conn = startRelayConnector({ relayUrl: WORKER, session: SESSION, relayToken: TOKEN, localPort: LOCAL_PORT, localToken: LOCAL_TOKEN }, (s) => console.log('[state]', JSON.stringify(s)));
  await sleep(4000); // 等出站 WSS 挂上

  let ok = true;
  const r1 = await post(WORKER + '/relay/' + SESSION, TOKEN, { path: '/api/exec', method: 'POST', body: { cmd: 'hi' } });
  console.log('POST /relay =>', r1.status, JSON.stringify(r1.body));
  if (r1.status !== 200 || !r1.body || !r1.body.echo || r1.body.path !== '/api/exec' || !r1.body.gotAuth || !r1.body.body || r1.body.body.cmd !== 'hi') ok = false;

  // 错误 token 必须 no_agent（配对隔离）
  const r2 = await post(WORKER + '/relay/' + SESSION, 'wrong-token', { path: '/api/health', method: 'GET' });
  console.log('POST /relay wrong-token =>', r2.status, JSON.stringify(r2.body));
  if (r2.status === 200) ok = false;

  conn.stop();
  srv.close();
  console.log(ok ? 'SELFTEST_PASS' : 'SELFTEST_FAIL');
  process.exit(ok ? 0 : 1);
})();
