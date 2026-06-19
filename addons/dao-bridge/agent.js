// dao-bridge 独立后端 Agent（纯 Node，无 VS Code 依赖）
// 道法自然 · 去中心化：本机起服务 + cloudflared 快速隧道，云端经 *.trycloudflare.com 直达本机。
// 配置优先级：环境变量 > 同目录 conn.json > 默认值。token 不入库，仅存本机 conn.json。
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require('./core.js');

const DIR = __dirname;
const CONN = path.join(DIR, 'conn.json');
const TRY_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function loadConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONN, 'utf8')); } catch {}
  return {
    token: process.env.DAO_TOKEN || c.token || '',
    port: Number(process.env.DAO_PORT || c.port || 9920),
    root: process.env.DAO_ROOT || c.root || os.homedir(),
    cloudflared: process.env.DAO_CLOUDFLARED || c.cloudflared || 'cloudflared',
    proxy: process.env.DAO_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || c.proxy || '',
  };
}

// 通用适配:无显式代理时,在 Windows 上探测系统代理(很多内网/翻墙机走本地代理才能出网)
function detectProxy(conf) {
  if (conf.proxy) return conf.proxy;
  if (process.platform !== 'win32') return '';
  try {
    const base = 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ';
    const en = cp.execSync(base + 'ProxyEnable', { encoding: 'utf8' });
    if (!/0x1\b/.test(en)) return '';
    const sv = cp.execSync(base + 'ProxyServer', { encoding: 'utf8' });
    const m = sv.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!m) return '';
    let val = m[1].trim();
    if (val.includes('=')) {
      const hit = val.split(';').map(s => s.trim()).find(s => /^https?=/.test(s));
      val = hit ? hit.split('=')[1] : '';
    }
    return val ? ('http://' + val.replace(/^https?:\/\//, '')) : '';
  } catch { return ''; }
}

// 启动 cloudflared 快速隧道（零账号、临时 URL），回调拿到公网 URL。断开自动重启。
function startQuickTunnel(conf, port, onUrl) {
  let proc = null, stopped = false, url = '';
  const env = Object.assign({}, process.env);
  delete env.NO_PROXY; delete env.no_proxy;
  if (conf.proxy) { env.HTTPS_PROXY = conf.proxy; env.HTTP_PROXY = conf.proxy; env.https_proxy = conf.proxy; env.http_proxy = conf.proxy; }
  const spawn = () => {
    if (stopped) return;
    const args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:' + port];
    try { proc = cp.spawn(conf.cloudflared, args, { windowsHide: true, env }); }
    catch (e) { console.error('[dao-bridge] cloudflared 启动失败: ' + (e && e.message)); setTimeout(spawn, 5000); return; }
    const onData = (buf) => {
      const m = buf.toString().match(TRY_RE);
      if (m && m[0] !== url) { url = m[0]; onUrl(url); }
    };
    if (proc.stdout) proc.stdout.on('data', onData);
    if (proc.stderr) proc.stderr.on('data', onData);
    proc.on('exit', () => { url = ''; if (!stopped) { console.log('[dao-bridge] 隧道断开，5s 后重连…'); setTimeout(spawn, 5000); } });
  };
  spawn();
  return { stop() { stopped = true; try { proc && proc.kill(); } catch {} }, currentUrl: () => url };
}

(async () => {
  const conf = loadConf();
  if (!conf.token) { console.error('[dao-bridge] 缺 token：设 DAO_TOKEN 或在 conn.json 写 token'); process.exit(1); }
  conf.proxy = detectProxy(conf);
  let publicUrl = '';
  const host = {
    workspaceRoot: () => conf.root,
    info: () => ({ host: os.hostname(), platform: process.platform, workspace: [conf.root] }),
    publicUrl: () => publicUrl,
    log: (m) => console.log('[dao-bridge] ' + m),
  };
  const server = await core.startServer(host, { port: conf.port, token: conf.token });
  if (conf.proxy) console.log('[dao-bridge] proxy=' + conf.proxy);

  const persist = () => {
    try {
      fs.writeFileSync(CONN, JSON.stringify({
        token: conf.token, port: server.port, root: conf.root, host: os.hostname(),
        publicUrl, updated: new Date().toISOString(),
      }, null, 2));
    } catch {}
  };

  const tunnel = startQuickTunnel(conf, server.port, (u) => {
    publicUrl = u;
    persist();
    console.log('[dao-bridge] 公网入口: ' + u + '  (Authorization: Bearer <token>)');
  });

  persist();
  setInterval(persist, 5000);

  console.log('[dao-bridge] host=' + os.hostname() + ' port=' + server.port);
  console.log('[dao-bridge] cloudflared 快速隧道启动中… 拿到 URL 后即打印公网入口');
  process.on('SIGINT', () => { tunnel.stop(); process.exit(0); });
  process.stdin.resume();
})();
