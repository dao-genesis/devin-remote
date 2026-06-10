// dao-bridge 独立后端 Agent（纯 Node，无 VS Code 依赖）
// 反者道之动：本机主动出站连公网 Worker+DurableObject 中继，云端经稳定 *.workers.dev URL 直达本机。
// 配置优先级：环境变量 > 同目录 conn.json > 默认值。token 不入库，仅存本机 conn.json。
const os = require('os');
const fs = require('fs');
const path = require('path');
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
  };
}

(async () => {
  const conf = loadConf();
  if (!conf.token) { console.error('[dao-bridge] 缺 token：设 DAO_TOKEN 或在 conn.json 写 token'); process.exit(1); }
  const host = {
    workspaceRoot: () => conf.root,
    info: () => ({ host: os.hostname(), platform: process.platform, workspace: [conf.root] }),
    log: (m) => console.log('[dao-bridge] ' + m),
  };
  const server = await core.startServer(host, { port: conf.port, token: conf.token });
  const bridge = core.connectRelay(host, { relayUrl: conf.relayUrl, sessionId: conf.session, token: conf.token });

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
