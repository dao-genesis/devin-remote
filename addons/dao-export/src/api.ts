/**
 * Devin API Client — 道法自然 · 水善利万物而有静
 * Handles auth, session listing, event streaming, file resolution.
 * Proxy-aware: automatically detects HTTPS_PROXY / HTTP_PROXY env vars.
 */
import * as https from 'https';
import * as http from 'http';
import * as url from 'url';
import * as zlib from 'zlib';
import * as tls from 'tls';
import * as net from 'net';

let LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
let API_BASE = 'https://app.devin.ai/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
// 导出 ZIP 是「用户主动点击」的一次性前台动作 (无后台周期轮询叠加), 故默认放开
// 并发抢下载速度; 家用弱网仍可在设置 daoDevin.downloadConcurrency 调低。
// (maxSockets = max(DL,PRESIGN)+4)。
let DOWNLOAD_CONCURRENCY = 16;
let PRESIGN_CONCURRENCY = 8;
let DOWNLOAD_RETRIES_CFG = 2;
let DOWNLOAD_TIMEOUT_CFG = 30000;

/**
 * 连接复用 (HTTP keep-alive) —— 高延迟链路下的根本性能杠杆。
 * 旧版每个文件都新建 TCP+TLS 连接，在国内→AWS 这类高 RTT 链路上，光
 * TLS 握手就要多个往返；几百个文件的握手开销线性叠加 → 卡到几分钟甚至更久。
 * 复用连接后，整批下载只付出 (并发数) 次握手，其余请求走已暖的连接，几乎只剩传输时间。
 */
let directHttpsAgent: https.Agent | null = null;
let directHttpAgent: http.Agent | null = null;
const proxyTunnelAgents = new Map<string, https.Agent>();

function agentMaxSockets(): number {
  return Math.max(DOWNLOAD_CONCURRENCY, PRESIGN_CONCURRENCY) + 4;
}

/** Reset pooled agents so a settings change (concurrency) takes effect. */
function resetAgents(): void {
  directHttpsAgent?.destroy();
  directHttpAgent?.destroy();
  proxyTunnelAgents.forEach((a) => a.destroy());
  directHttpsAgent = null;
  directHttpAgent = null;
  proxyTunnelAgents.clear();
}

function directAgent(isHttps: boolean): https.Agent | http.Agent {
  if (isHttps) {
    if (!directHttpsAgent) {
      directHttpsAgent = new https.Agent({
        keepAlive: true, keepAliveMsecs: 15000,
        maxSockets: agentMaxSockets(), scheduling: 'lifo',
      });
    }
    return directHttpsAgent;
  }
  if (!directHttpAgent) {
    directHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: agentMaxSockets() });
  }
  return directHttpAgent;
}

/**
 * Keep-alive HTTPS agent that tunnels through an HTTP proxy via CONNECT and then
 * pools the established TLS sockets for reuse (keyed per target host by the base
 * Agent). This brings connection reuse to the proxied path too — the common
 * "local proxy (clash/v2ray) → AWS" setup — not just direct connections.
 */
class ProxyTunnelAgent extends https.Agent {
  proxyHost: string;
  proxyPort: number;
  constructor(proxyHost: string, proxyPort: number, opts: https.AgentOptions) {
    super(opts);
    this.proxyHost = proxyHost;
    this.proxyPort = proxyPort;
  }
}
// Assigned on the prototype (not as a typed override) because Node's Agent
// createConnection callback signature isn't structurally compatible with our
// net.Socket-typed callback — the runtime contract is identical.
(ProxyTunnelAgent.prototype as unknown as {
  createConnection: (options: { host?: string; port?: number }, cb: (err: Error | null, socket?: net.Socket) => void) => void;
}).createConnection = function (this: ProxyTunnelAgent, options, cb) {
  const targetHost = options.host || '';
  const targetPort = options.port || 443;
  const connectReq = http.request({
    host: this.proxyHost, port: this.proxyPort, method: 'CONNECT',
    path: `${targetHost}:${targetPort}`, headers: { Host: `${targetHost}:${targetPort}` },
  });
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) { socket.destroy(); cb(new Error(`proxy CONNECT ${res.statusCode}`)); return; }
    const tlsSocket = tls.connect(
      { socket, servername: targetHost, rejectUnauthorized: false },
      () => cb(null, tlsSocket),
    );
    tlsSocket.on('error', (e) => cb(e));
  });
  connectReq.on('error', cb);
  connectReq.on('timeout', () => { connectReq.destroy(); cb(new Error('proxy connect timeout')); });
  connectReq.end();
};

function proxyTunnelAgent(proxy: url.URL): https.Agent {
  const key = `${proxy.hostname}:${proxy.port || 80}`;
  let agent = proxyTunnelAgents.get(key);
  if (!agent) {
    agent = new ProxyTunnelAgent(proxy.hostname, parseInt(proxy.port || '80', 10), {
      keepAlive: true, keepAliveMsecs: 15000, maxSockets: agentMaxSockets(), scheduling: 'lifo',
    });
    proxyTunnelAgents.set(key, agent);
  }
  return agent;
}

/** Apply soft-coded settings from VS Code configuration or env. */
export function applySettings(cfg?: {
  loginUrl?: string; apiBase?: string;
  downloadConcurrency?: number; presignConcurrency?: number;
  downloadRetries?: number; downloadTimeout?: number;
}): void {
  if (cfg?.loginUrl) { LOGIN_URL = cfg.loginUrl; }
  if (cfg?.apiBase) { API_BASE = cfg.apiBase; }
  if (cfg?.downloadConcurrency && cfg.downloadConcurrency > 0) { DOWNLOAD_CONCURRENCY = cfg.downloadConcurrency; }
  if (cfg?.presignConcurrency && cfg.presignConcurrency > 0) { PRESIGN_CONCURRENCY = cfg.presignConcurrency; }
  if (cfg?.downloadRetries && cfg.downloadRetries > 0) { DOWNLOAD_RETRIES_CFG = cfg.downloadRetries; }
  if (cfg?.downloadTimeout && cfg.downloadTimeout > 0) { DOWNLOAD_TIMEOUT_CFG = cfg.downloadTimeout; }
  // Concurrency may have changed → rebuild pooled agents with the new maxSockets.
  resetAgents();
}

export function getSettings() {
  return { LOGIN_URL, API_BASE, DOWNLOAD_CONCURRENCY, PRESIGN_CONCURRENCY, DOWNLOAD_RETRIES: DOWNLOAD_RETRIES_CFG, DOWNLOAD_TIMEOUT: DOWNLOAD_TIMEOUT_CFG };
}

/** Detect proxy from environment (HTTPS_PROXY, HTTP_PROXY, etc). */
function getProxyForUrl(targetUrl: string): url.URL | null {
  const isHttps = targetUrl.startsWith('https:');
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim().toLowerCase());
  if (!raw) { return null; }
  try {
    const target = new URL(targetUrl);
    if (noProxy.some(np => np === '*' || target.hostname.endsWith(np) || target.hostname === np)) { return null; }
    const proxy = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
    return proxy;
  } catch { return null; }
}

export interface AuthState {
  token: string;
  orgId: string;
  orgBare: string;
  orgName: string;
  email: string;
}

export interface SessionInfo {
  devin_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  activity_status?: string;
  current_activity?: string;
  tags?: string[];
  pull_requests?: any[];
  [key: string]: any;
}

export interface EventItem {
  event_id?: string;
  type: string;
  timestamp?: string;
  created_at_ms?: number;
  message?: string;
  file_updates?: FileUpdate[];
  [key: string]: any;
}

export interface FileUpdate {
  file_path: string;
  contents_key?: string;
  action_type?: string;
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; buf: Buffer; }

/**
 * Single low-level request path used by BOTH json requests and binary file
 * downloads. Always routes through a pooled keep-alive agent (direct or
 * proxy-tunnel) so connections are reused across the whole export — the core
 * fix for "many files = many TLS handshakes = minutes" on high-latency links.
 */
function doRequest(targetUrl: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const proxy = getProxyForUrl(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const method = options.method || 'GET';
    const hdrs: Record<string, string> = { ...(options.headers || {}) };
    const tout = options.timeout || 30000;

    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    };

    let req: http.ClientRequest;
    if (proxy && !isHttps) {
      // Plain (non-TLS) target through proxy — rare; keep direct proxy request.
      req = http.request({
        host: proxy.hostname, port: parseInt(proxy.port || '80', 10),
        path: targetUrl, method, headers: hdrs, timeout: tout,
      }, onResponse);
    } else {
      // Direct or proxied HTTPS — both go through a pooled keep-alive agent.
      const agent = (proxy && isHttps) ? proxyTunnelAgent(proxy) : directAgent(isHttps);
      const mod = isHttps ? https : http;
      req = mod.request({
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method, headers: hdrs, timeout: tout,
        agent, rejectUnauthorized: false,
      } as https.RequestOptions, onResponse);
    }
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (options.body) { req.write(options.body); }
    req.end();
  });
}

function request(targetUrl: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<{ status: number; body: string }> {
  return doRequest(targetUrl, options).then(({ status, headers, buf }) => {
    // Some proxies/CDNs compress responses even when we don't ask. Decompress
    // so JSON.parse downstream doesn't silently choke on binary and return [].
    const enc = String(headers['content-encoding'] || '').toLowerCase();
    let out = buf;
    try {
      if (enc === 'gzip') { out = zlib.gunzipSync(buf); }
      else if (enc === 'deflate') { out = zlib.inflateSync(buf); }
      else if (enc === 'br') { out = zlib.brotliDecompressSync(buf); }
    } catch { /* fall back to raw bytes */ }
    return { status, body: out.toString('utf-8') };
  });
}

export async function login(email: string, password: string): Promise<AuthState> {
  const resp = await request(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ email, password }),
  });

  if (resp.status !== 200) {
    throw new Error(`Login failed (${resp.status}): ${resp.body.slice(0, 200)}`);
  }

  const data = JSON.parse(resp.body);
  const token = data.token || data.access_token;
  if (!token) {
    throw new Error(`No token in response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Get org info
  const orgResp = await request(`${API_BASE}/users/post-auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': UA,
    },
    body: '{}',
  });

  const orgData = JSON.parse(orgResp.body);
  const orgId = orgData.org_id || orgData.orgId;
  const orgBare = orgId?.replace('org-', '') || '';
  const orgName = orgData.org_name || orgData.orgName || '';

  return { token, orgId, orgBare, orgName, email };
}

function authHeaders(auth: AuthState, extra?: Record<string, string>): Record<string, string> {
  return {
    'Authorization': `Bearer ${auth.token}`,
    'x-cog-org-id': auth.orgId,
    'User-Agent': UA,
    'Accept': 'application/json',
    ...extra,
  };
}

function parseSessionList(body: string): SessionInfo[] | null {
  let data: any;
  try { data = JSON.parse(body); } catch { return null; }
  if (Array.isArray(data)) { return data; }
  const list = data.result || data.sessions || data.data;
  return Array.isArray(list) ? list : null;
}

/**
 * List all sessions for the org.
 * Mirrors dao_export_all.py: primary `org-{bare}/v2sessions`, then falls back to
 * `/sessions` when the primary errors OR returns an unexpected/empty shape. A hard
 * failure throws a descriptive error instead of silently returning [] — otherwise a
 * proxy/network/parse hiccup looks identical to "account has zero sessions".
 */
export async function listSessions(auth: AuthState): Promise<SessionInfo[]> {
  let primaryErr: string | undefined;

  try {
    const resp = await request(`${API_BASE}/org-${auth.orgBare}/v2sessions`, {
      headers: authHeaders(auth),
      timeout: 60000,
    });
    if (resp.status === 200) {
      const list = parseSessionList(resp.body);
      if (list && list.length) { return list; }
      // 200 but empty/unparseable → try the fallback before trusting "empty".
      primaryErr = list ? 'v2sessions 返回空列表' : `v2sessions 响应无法解析: ${resp.body.slice(0, 120)}`;
    } else {
      primaryErr = `v2sessions HTTP ${resp.status}: ${resp.body.slice(0, 120)}`;
    }
  } catch (e) {
    primaryErr = `v2sessions 请求失败: ${String(e)}`;
  }

  try {
    const resp = await request(`${API_BASE}/sessions`, {
      headers: authHeaders(auth),
      timeout: 60000,
    });
    if (resp.status === 200) {
      const list = parseSessionList(resp.body);
      if (list) { return list; }
    }
    // Fallback reachable but unusable. If the primary at least said "empty", trust empty.
    if (primaryErr && primaryErr.includes('空列表')) { return []; }
    throw new Error(`/sessions HTTP ${resp.status}`);
  } catch (e) {
    if (primaryErr && primaryErr.includes('空列表')) { return []; }
    throw new Error(`列出会话失败 (主端点: ${primaryErr}; 备用端点: ${String(e)})`);
  }
}

export async function getSessionInfo(auth: AuthState, devinId: string): Promise<SessionInfo> {
  const url = `${API_BASE}/sessions/${devinId}`;
  const resp = await request(url, { headers: authHeaders(auth) });
  return JSON.parse(resp.body);
}

export async function getEventStream(auth: AuthState, devinId: string): Promise<EventItem[]> {
  const url = `${API_BASE}/events/${devinId}/stream`;
  // Retry: streaming endpoints are the most fragile over slow/proxied links.
  let resp: { status: number; body: string } | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await request(url, {
        headers: { ...authHeaders(auth), 'Accept': 'text/event-stream' },
        timeout: 180000,
      });
      if (resp.status === 200) { break; }
      lastErr = new Error(`event stream HTTP ${resp.status}`);
      resp = undefined;
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  if (!resp) { throw new Error(`事件流获取失败: ${String(lastErr)}`); }

  // Parse SSE/ndjson stream
  const merged = new Map<string, EventItem>();
  const raw = resp.body;

  // Try JSON objects
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && ' \r\n\t'.includes(raw[i])) { i++; }
    if (i >= raw.length) { break; }

    // Try to find a JSON object
    if (raw[i] === '{') {
      let depth = 0;
      let j = i;
      let inStr = false;
      let escaped = false;
      for (; j < raw.length; j++) {
        if (escaped) { escaped = false; continue; }
        if (raw[j] === '\\' && inStr) { escaped = true; continue; }
        if (raw[j] === '"') { inStr = !inStr; continue; }
        if (inStr) { continue; }
        if (raw[j] === '{') { depth++; }
        if (raw[j] === '}') { depth--; if (depth === 0) { j++; break; } }
      }

      try {
        const obj = JSON.parse(raw.slice(i, j));
        if (obj.result && Array.isArray(obj.result)) {
          for (const ev of obj.result) {
            const eid = ev.event_id || `${ev.type}-${ev.timestamp}-${ev.created_at_ms}`;
            if (!merged.has(eid)) { merged.set(eid, ev); }
          }
        } else if (obj.type) {
          const eid = obj.event_id || `${obj.type}-${obj.timestamp}`;
          if (!merged.has(eid)) { merged.set(eid, obj); }
        }
      } catch { /* skip malformed */ }
      i = j;
    } else {
      // SSE line: data: {...}
      const lineEnd = raw.indexOf('\n', i);
      const end = lineEnd === -1 ? raw.length : lineEnd;
      const line = raw.slice(i, end).trim();
      i = end + 1;

      if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const obj = JSON.parse(dataStr);
            if (obj.result && Array.isArray(obj.result)) {
              for (const ev of obj.result) {
                const eid = ev.event_id || `${ev.type}-${ev.timestamp}`;
                if (!merged.has(eid)) { merged.set(eid, ev); }
              }
            } else if (obj.type) {
              const eid = obj.event_id || `${obj.type}-${obj.timestamp}`;
              if (!merged.has(eid)) { merged.set(eid, obj); }
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  const events = Array.from(merged.values());
  events.sort((a, b) => (a.created_at_ms || 0) - (b.created_at_ms || 0));
  return events;
}

export async function getFirstLoad(auth: AuthState, devinId: string): Promise<EventItem[]> {
  const url = `${API_BASE}/events/first-load/${devinId}`;
  const resp = await request(url, { headers: authHeaders(auth) });
  const data = JSON.parse(resp.body);
  return data.result || data.events || [];
}

export async function resolvePresignedUrls(
  auth: AuthState, devinId: string, keys: string[]
): Promise<Map<string, { url: string; headers: Record<string, string> }>> {
  const result = new Map<string, { url: string; headers: Record<string, string> }>();
  const CHUNK = 40;

  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    batches.push(keys.slice(i, i + CHUNK));
  }

  const url = `${API_BASE}/presigned-url/batch/${devinId}`;
  const resolveBatch = async (batch: string[]) => {
    const resp = await request(url, {
      method: 'POST',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3_key_list: batch }),
      timeout: 30000,
    });
    try {
      const data = JSON.parse(resp.body);
      const urls = data.urls_list || [];
      const hdrs = data.headers_list || [];
      for (let j = 0; j < batch.length; j++) {
        if (urls[j]) {
          result.set(batch[j], { url: urls[j], headers: hdrs[j] || {} });
        }
      }
    } catch { /* skip batch */ }
  };

  await runPool(batches, PRESIGN_CONCURRENCY, resolveBatch);
  return result;
}

/** Run async tasks over items with bounded concurrency. */
export async function runPool<T>(
  items: T[], concurrency: number, worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  });
  await Promise.all(lanes);
}

export async function downloadFileWithRetry(
  url: string, headers?: Record<string, string>, retries?: number
): Promise<Buffer> {
  const maxRetries = retries ?? DOWNLOAD_RETRIES_CFG;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await downloadFile(url, headers);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export async function downloadFile(targetUrl: string, headers?: Record<string, string>): Promise<Buffer> {
  const { status, buf } = await doRequest(targetUrl, {
    method: 'GET', headers: headers || {}, timeout: DOWNLOAD_TIMEOUT_CFG,
  });
  // S3/CloudFront errors (expired URL, 403, 5xx) come back with an XML/HTML body
  // and HTTP 200 was previously assumed — so error pages got saved AS the file and
  // never retried. Reject on non-2xx so downloadFileWithRetry can actually retry.
  if (status < 200 || status >= 300) {
    throw new Error(`download HTTP ${status}: ${buf.slice(0, 200).toString('utf-8')}`);
  }
  return buf;
}

export function extractAllKeys(events: EventItem[]): string[] {
  const keys = new Set<string>();
  function walk(obj: any) {
    if (!obj || typeof obj !== 'object') { return; }
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'contents_key' && typeof v === 'string' && v) {
        keys.add(v);
      } else {
        walk(v);
      }
    }
  }
  walk(events);
  return Array.from(keys).sort();
}

// Account-level data
export async function getPlaybooks(auth: AuthState): Promise<any[]> {
  const resp = await request(`${API_BASE}/org-${auth.orgBare}/playbooks`, {
    headers: authHeaders(auth),
  });
  return JSON.parse(resp.body);
}

export async function getKnowledge(auth: AuthState): Promise<any> {
  const resp = await request(`${API_BASE}/org-${auth.orgBare}/learning/all`, {
    headers: authHeaders(auth),
  });
  return JSON.parse(resp.body);
}

export async function getSecrets(auth: AuthState): Promise<any[]> {
  const resp = await request(`${API_BASE}/org-${auth.orgBare}/secrets`, {
    headers: authHeaders(auth),
  });
  return JSON.parse(resp.body);
}

export async function getOrgSettings(auth: AuthState): Promise<any> {
  const resp = await request(`${API_BASE}/organizations/${auth.orgId}`, {
    headers: authHeaders(auth),
  });
  return JSON.parse(resp.body);
}
