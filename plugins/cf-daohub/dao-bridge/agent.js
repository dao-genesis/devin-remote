// dao-bridge 独立后端 Agent（纯 Node，无 VS Code 依赖）
// 反者道之动：本机主动出站连公网 Worker+DurableObject 中继，云端经稳定 *.workers.dev URL 直达本机。
// 配置优先级：环境变量 > 同目录 conn.json > 默认值。token 不入库，仅存本机 conn.json。
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require('./core.js');

const DIR = __dirname;
const CONN = path.join(DIR, 'conn.json');

function loadConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONN, 'utf8')); } catch {}
  return {
    relayUrl: process.env.DAO_RELAY || c.relayUrl || 'https://dao-relay-do.zhouyoukang.workers.dev',
    session: process.env.DAO_SESSION || c.session || os.hostname(),
    token: process.env.DAO_TOKEN || c.token || '',
    port: Number(process.env.DAO_PORT || c.port || 9920),
    root: process.env.DAO_ROOT || c.root || os.homedir(),
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
    // 形如 host:port 或 http=...;https=...
    if (val.includes('=')) {
      const hit = val.split(';').map(s => s.trim()).find(s => /^https?=/.test(s));
      val = hit ? hit.split('=')[1] : '';
    }
    return val ? ('http://' + val.replace(/^https?:\/\//, '')) : '';
  } catch { return ''; }
}

(async () => {
  const conf = loadConf();
  if (!conf.token) { console.error('[dao-bridge] 缺 token：设 DAO_TOKEN 或在 conn.json 写 token'); process.exit(1); }
  conf.proxy = detectProxy(conf);
  const host = {
    workspaceRoot: () => conf.root,
    info: () => ({ host: os.hostname(), platform: process.platform, workspace: [conf.root] }),
    log: (m) => console.log('[dao-bridge] ' + m),
  };
  const server = await core.startServer(host, { port: conf.port, token: conf.token });
  const bridge = core.connectRelay(host, { relayUrl: conf.relayUrl, sessionId: conf.session, token: conf.token, proxy: conf.proxy || undefined });
  if (conf.proxy) console.log('[dao-bridge] proxy=' + conf.proxy);

  const endpoint = conf.relayUrl.replace(/\/$/, '') + '/relay/' + conf.session;
  const persist = () => {
    try {
      fs.writeFileSync(CONN, JSON.stringify({
        relayUrl: conf.relayUrl, session: conf.session, token: conf.token,
        port: server.port, root: conf.root, host: os.hostname(),
        connected: bridge.isConnected(), publicEndpoint: endpoint,
        updated: new Date().toISOString(),
      }, null, 2));
    } catch {}
  };
  persist();
  setInterval(persist, 5000);

  console.log('[dao-bridge] host=' + os.hostname() + ' port=' + server.port);
  console.log('[dao-bridge] 出站桥 -> ' + conf.relayUrl + '  session=' + conf.session);
  console.log('[dao-bridge] 云端入口: POST ' + endpoint + '  (Authorization: Bearer <token>)');
  setInterval(() => { if (!bridge.isConnected()) console.log('[dao-bridge] reconnecting...'); }, 15000);
  process.stdin.resume();
})();
