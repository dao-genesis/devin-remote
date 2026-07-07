// dao-bridge 持久 Worker 中继连接器（不依赖 IDE · 固定公网地址）
// 道法自然 · 守柔：出站 WSS 挂到用户自有的持久 Worker（dao-relay）一个固定 (session, token)
// 命名空间；公网侧 POST <worker>/relay/<session>（同 token）即恒达本机，地址固定不随快速隧道轮换。
// 与快速隧道并行互补：快速隧道兜底、持久通道置顶。由独立 dao-bridge agent 常驻拉起，IDE 不开也在。
//
// 协议（与 addons/dao-relay/worker.js 对齐）：
//   出站   GET  <ws>/connect?session=<s>&token=<t>   → WebSocket
//   下发   {type:'request', id, path, method, body}   ← 公网 POST /relay/<s> 驱动
//   回包   {type:'response', id, status, body}         → 原样作为 HTTP 响应返回
//   心跳   每 15s 发 {type:'ping'}，Worker 自动回 {type:'pong'}
//
// 零依赖：优先用 Node18+ 内置全局 WebSocket；缺失时回落到 ws 包（若已安装）。
const http = require('http');

function getWS() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try { return require('ws'); } catch (e) { return null; }
}

// 本地转发：把中继下发的 {path, method, body} 打到本机 core 服务（同 Bearer token）。
function localRequest(port, token, reqPath, method, body) {
  return new Promise((resolve) => {
    let data = '';
    try { data = (body === undefined || body === null) ? '' : (typeof body === 'string' ? body : JSON.stringify(body)); } catch (e) { data = ''; }
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: port, path: reqPath || '/api/health', method: method || 'GET', headers: headers, timeout: 55000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch (e) { /* 非 JSON 原样回 */ }
        resolve({ status: res.statusCode || 200, body: parsed });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 504, body: { error: 'local_timeout' } }); });
    req.on('error', (e) => resolve({ status: 502, body: { error: 'local_unreachable', detail: String((e && e.message) || e) } }));
    if (data) req.write(data);
    req.end();
  });
}

// conf: { relayUrl, session, relayToken, localPort, localToken }
function startRelayConnector(conf, onState) {
  const WS = getWS();
  const origin = String(conf.relayUrl || '').replace(/\/+$/, '');
  if (!origin) return { stop() {}, publicUrl: () => '' };
  if (!WS) { console.error('[dao-relay] 无 WebSocket 实现（Node<18 且未装 ws），持久通道跳过'); return { stop() {}, publicUrl: () => '' }; }
  if (!conf.session) return { stop() {}, publicUrl: () => '' };

  const relayToken = conf.relayToken || conf.localToken || '';
  const wsUrl = origin.replace(/^http/, 'ws') + '/connect?session=' + encodeURIComponent(conf.session) + '&token=' + encodeURIComponent(relayToken);
  const publicUrl = origin + '/relay/' + encodeURIComponent(conf.session);

  let ws = null, stopped = false, pingTimer = null, reconnectTimer = null, backoff = 1000;

  const clearTimers = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };
  const schedule = () => {
    clearTimers();
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  const onOpen = () => {
    backoff = 1000;
    console.log('[dao-relay] 持久通道已连（IDE 无关）: ' + publicUrl + '  (Authorization: Bearer <relayToken>)');
    if (onState) try { onState({ connected: true, publicUrl: publicUrl }); } catch (e) {}
    clearTimers();
    pingTimer = setInterval(() => { try { ws && ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {} }, 15000);
  };
  const onMsg = async (raw) => {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'pong') return;
    if (m.type !== 'request' || !m.id) return;
    const r = await localRequest(conf.localPort, conf.localToken, m.path, m.method, m.body);
    try { ws && ws.send(JSON.stringify({ type: 'response', id: m.id, status: r.status, body: r.body })); } catch (e) {}
  };
  const onClose = () => { if (onState) try { onState({ connected: false, publicUrl: publicUrl }); } catch (e) {} schedule(); };

  function connect() {
    if (stopped) return;
    let sock;
    try { sock = new WS(wsUrl); } catch (e) { schedule(); return; }
    ws = sock;
    if (typeof sock.addEventListener === 'function') {
      // 全局 WebSocket（浏览器式 API）
      sock.addEventListener('open', onOpen);
      sock.addEventListener('message', (ev) => onMsg(ev.data));
      sock.addEventListener('close', onClose);
      sock.addEventListener('error', () => { try { sock.close(); } catch (e) {} });
    } else {
      // ws 包（EventEmitter API）
      sock.on('open', onOpen);
      sock.on('message', (d) => onMsg(d));
      sock.on('close', onClose);
      sock.on('error', () => { /* close 随后触发重连 */ });
    }
  }

  connect();
  return {
    stop() { stopped = true; clearTimers(); clearTimeout(reconnectTimer); try { ws && ws.close(); } catch (e) {} },
    publicUrl: () => publicUrl,
  };
}

module.exports = { startRelayConnector, localRequest };
