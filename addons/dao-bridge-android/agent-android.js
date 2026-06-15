// dao-bridge-android · 独立后台 Agent（Android/Termux 形态，复用 ../dao-bridge/core.js）
// 与桌面 dao-bridge 同一套 core：本地 HTTP server + 出站 WSS 中继桥（穿 NAT，稳定 *.workers.dev URL）。
// 额外提供 /api/device（termux-api 设备信息）。仅用于你自己 / 已明确授权的设备。
//
// 配置优先级：环境变量 > 同目录 conn.json > 默认值。token 不入库，仅落本地 conn.json。
// 本地直连模式：设 DAO_NO_RELAY=1 时只起 127.0.0.1 本地 server，不连云端中继（适合本机调试 / PoC）。
const os = require('os');
const fs = require('fs');
const path = require('path');
const core = require('../dao-bridge/core.js');
const device = require('./termux-device.js');

const DIR = __dirname;
const CONN = path.join(DIR, 'conn.json');

function loadConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONN, 'utf8')); } catch {}
  return {
    relayUrl: process.env.DAO_RELAY || c.relayUrl || 'https://dao-relay-do.zhouyoukang.workers.dev',
    session: process.env.DAO_SESSION || c.session || ('android-' + os.hostname()),
    token: process.env.DAO_TOKEN || c.token || '',
    port: Number(process.env.DAO_PORT || c.port || 9920),
    root: process.env.DAO_ROOT || c.root || process.env.HOME || os.homedir(),
    proxy: process.env.DAO_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || c.proxy || '',
    noRelay: /^(1|true|yes)$/i.test(String(process.env.DAO_NO_RELAY || c.noRelay || '')),
  };
}

(async () => {
  const conf = loadConf();
  if (!conf.token) {
    console.error('[dao-bridge-android] 缺 token：设 DAO_TOKEN 或在 conn.json 写 token');
    process.exit(1);
  }
  const host = {
    workspaceRoot: () => conf.root,
    info: () => ({
      host: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      flavor: 'android',
      workspace: [conf.root],
    }),
    log: (m) => console.log('[dao-bridge-android] ' + m),
    // 扩展路由：/api/device — 通过 termux-api 采集设备信息（已通过 core 的 Bearer 鉴权）
    handleExtra: async (route, method, body) => {
      if (route === '/api/device') {
        try {
          return { status: 200, body: await device.collect(body) };
        } catch (e) {
          return { status: 500, body: { error: String((e && e.message) || e) } };
        }
      }
      return null;
    },
  };

  const server = await core.startServer(host, { port: conf.port, token: conf.token });
  console.log('[dao-bridge-android] host=' + os.hostname() + ' port=' + server.port + ' root=' + conf.root);

  let bridge = null;
  let endpoint = null;
  if (conf.noRelay) {
    console.log('[dao-bridge-android] DAO_NO_RELAY=1 → 本地直连模式，仅 http://127.0.0.1:' + server.port);
  } else {
    bridge = core.connectRelay(host, {
      relayUrl: conf.relayUrl,
      sessionId: conf.session,
      token: conf.token,
      proxy: conf.proxy || undefined,
    });
    endpoint = conf.relayUrl.replace(/\/$/, '') + '/relay/' + conf.session;
    console.log('[dao-bridge-android] 出站桥 -> ' + conf.relayUrl + '  session=' + conf.session);
    console.log('[dao-bridge-android] 云端入口: POST ' + endpoint + '  (Authorization: Bearer <token>)');
  }

  const persist = () => {
    try {
      fs.writeFileSync(CONN, JSON.stringify({
        relayUrl: conf.relayUrl, session: conf.session, token: conf.token,
        port: server.port, root: conf.root, host: os.hostname(),
        flavor: 'android', noRelay: conf.noRelay,
        connected: bridge ? bridge.isConnected() : false,
        publicEndpoint: endpoint, updated: new Date().toISOString(),
      }, null, 2));
    } catch {}
  };
  persist();
  setInterval(persist, 5000);

  if (bridge) {
    setInterval(() => { if (!bridge.isConnected()) console.log('[dao-bridge-android] reconnecting...'); }, 15000);
  }
  process.stdin.resume();
})();
