/**
 * Agent Bridge — local HTTP API exposing all plugin capabilities.
 * Any agent (or human) can drive the running plugin via this API.
 * Zero deps: Node stdlib http only. 道法自然 无为而无不为
 */
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as api from './api';
import { exportSessionToZip } from './exporter';
import { buildWorklog, extractChanges, safeName } from './worklog';

export interface BridgeHost {
  getAuth(): api.AuthState | undefined;
  setAuth(a: api.AuthState | undefined): Promise<void>;
  getSessions(): api.SessionInfo[];
  refreshSessions(): Promise<api.SessionInfo[]>;
  version: string;
}

export class AgentBridge {
  private server?: http.Server;
  public port = 0;
  public token = '';

  constructor(private host: BridgeHost) {}

  get running(): boolean { return !!this.server; }

  async start(preferredPort = 7848, token?: string): Promise<{ port: number; token: string }> {
    if (this.server) { return { port: this.port, token: this.token }; }
    this.token = token || crypto.randomBytes(16).toString('hex');

    for (let p = preferredPort; p < preferredPort + 20; p++) {
      try {
        await this.listen(p);
        this.port = p;
        return { port: p, token: this.token };
      } catch { /* port busy, try next */ }
    }
    throw new Error('no free port for Agent Bridge');
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        this.server = srv;
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const send = (code: number, body: any, ct = 'application/json; charset=utf-8') => {
      const data = typeof body === 'string' || Buffer.isBuffer(body)
        ? body : JSON.stringify(body, null, 2);
      res.writeHead(code, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    };

    try {
      // auth check (all endpoints except /api/ping)
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        || url.searchParams.get('token') || '';
      if (url.pathname === '/api/ping') { return send(200, { ok: true, service: 'dao-devin-export bridge' }); }
      if (given !== this.token) { return send(401, { error: 'invalid token' }); }

      const body = await readBody(req);
      const auth = this.host.getAuth();
      const m = req.method || 'GET';
      const p = url.pathname;

      if (p === '/api/status') {
        return send(200, {
          version: this.host.version, loggedIn: !!auth,
          email: auth?.email, org: auth?.orgName, orgId: auth?.orgId,
          sessionsCached: this.host.getSessions().length,
          endpoints: ENDPOINTS,
        });
      }

      if (p === '/api/login' && m === 'POST') {
        const { email, password } = JSON.parse(body || '{}');
        const a = await api.login(email, password);
        await this.host.setAuth(a);
        await this.host.refreshSessions();
        return send(200, { ok: true, email: a.email, org: a.orgName });
      }

      if (p === '/api/logout' && m === 'POST') {
        await this.host.setAuth(undefined);
        return send(200, { ok: true });
      }

      if (!auth) { return send(401, { error: 'not logged in; POST /api/login first' }); }

      if (p === '/api/sessions') {
        const list = url.searchParams.get('refresh') === '1'
          ? await this.host.refreshSessions() : (this.host.getSessions().length
            ? this.host.getSessions() : await this.host.refreshSessions());
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const out = q ? list.filter((s) =>
          (s.title || '').toLowerCase().includes(q) || s.devin_id.includes(q)) : list;
        return send(200, out);
      }

      const sess = p.match(/^\/api\/session\/(devin-[0-9a-f]+)(\/.*)?$/);
      if (sess) {
        const devinId = sess[1];
        const sub = sess[2] || '';
        if (sub === '' || sub === '/') {
          return send(200, await api.getSessionInfo(auth, devinId));
        }
        if (sub === '/events') {
          return send(200, await loadEvents(auth, devinId));
        }
        if (sub === '/worklog') {
          const evs = await loadEvents(auth, devinId);
          const title = this.titleOf(devinId);
          return send(200, buildWorklog(title, devinId, evs), 'text/markdown; charset=utf-8');
        }
        if (sub === '/changes') {
          const evs = await loadEvents(auth, devinId);
          return send(200, extractChanges(evs));
        }
        if (sub === '/keys') {
          const evs = await loadEvents(auth, devinId);
          return send(200, api.extractAllKeys(evs));
        }
        if (sub === '/file') {
          const key = url.searchParams.get('key') || '';
          if (!key) { return send(400, { error: 'missing ?key=' }); }
          const urlMap = await api.resolvePresignedUrls(auth, devinId, [key]);
          const info = urlMap.get(key);
          if (!info) { return send(404, { error: 'presigned url not found for key' }); }
          const data = await api.downloadFileWithRetry(info.url, info.headers);
          return send(200, data, 'application/octet-stream');
        }
        if (sub === '/export' && m === 'POST') {
          const opts = JSON.parse(body || '{}');
          const title = this.titleOf(devinId);
          const zipBuf = await exportSessionToZip(auth, devinId, title, () => { /* silent */ });
          const out = opts.outputPath
            || path.join(os.homedir(), 'Downloads', `${safeName(title, 40)}_${devinId.replace('devin-', '').slice(0, 8)}.zip`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, zipBuf);
          return send(200, { ok: true, path: out, bytes: zipBuf.length });
        }
      }

      if (p === '/api/account/playbooks') { return send(200, await api.getPlaybooks(auth)); }
      if (p === '/api/account/knowledge') { return send(200, await api.getKnowledge(auth)); }
      if (p === '/api/account/secrets') { return send(200, await api.getSecrets(auth)); }
      if (p === '/api/account/org') { return send(200, await api.getOrgSettings(auth)); }

      if (p === '/api/doc') {
        return send(200, this.buildAgentDoc(), 'text/markdown; charset=utf-8');
      }

      return send(404, { error: 'unknown endpoint', endpoints: ENDPOINTS });
    } catch (e) {
      return send(500, { error: String(e) });
    }

    function readBody(r: http.IncomingMessage): Promise<string> {
      return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
    }

    async function loadEvents(a: api.AuthState, devinId: string): Promise<api.EventItem[]> {
      // Fall back on EMPTY too (a dead/proxied base can return 200 HTML → zero
      // events without throwing). Throw a real error when BOTH yield nothing AND
      // at least one errored, so the bridge returns 500 with the cause instead of
      // a misleading empty 200.
      let streamErr: unknown; let firstErr: unknown;
      let evts: api.EventItem[] = [];
      try { evts = await api.getEventStream(a, devinId); } catch (e) { streamErr = e; }
      if (evts.length === 0) {
        try {
          const fl = await api.getFirstLoad(a, devinId);
          if (fl.length) { evts = fl; }
        } catch (e) { firstErr = e; }
      }
      if (evts.length === 0 && (streamErr || firstErr)) {
        throw new Error(`事件流获取失败: ${streamErr ? String(streamErr) : '返回空'} / first-load: ${firstErr ? String(firstErr) : '返回空'}`);
      }
      return evts;
    }
  }

  private titleOf(devinId: string): string {
    const s = this.host.getSessions().find((x) => x.devin_id === devinId);
    return s?.title || devinId;
  }

  /** Live agent access doc — regenerated每次按当前端口/token/登录态. */
  buildAgentDoc(): string {
    const auth = this.host.getAuth();
    const base = `http://127.0.0.1:${this.port}`;
    const tok = this.token;
    return `# DAO Devin Export — Agent Bridge 接入文档 (实时生成)

> 生成时间: ${new Date().toISOString()}
> 插件版本: ${this.host.version} | Bridge 运行中: ${base}
> 登录状态: ${auth ? `已登录 ${auth.email} (${auth.orgName})` : '未登录 — 先调用 POST /api/login'}

只要 VS Code 窗口开着、插件在运行，任何 Agent 即可通过下面的 HTTP 接口调用本插件全部底层功能（无需任何其他文档/依赖）。

## 鉴权

所有请求带 Header \`Authorization: Bearer ${tok}\`（或 \`?token=${tok}\`）。

## 接口总览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/ping | 探活（免鉴权） |
| GET | /api/status | 插件/登录状态 + 全部端点 |
| POST | /api/login | body: {"email","password"} |
| POST | /api/logout | 登出 |
| GET | /api/sessions | 全部会话；?q=关键词 过滤；?refresh=1 强制刷新 |
| GET | /api/session/{devin_id} | 会话元数据 |
| GET | /api/session/{devin_id}/events | 完整事件流（去重合并 JSON） |
| GET | /api/session/{devin_id}/worklog | 可读工作日志 markdown |
| GET | /api/session/{devin_id}/changes | 最终变更文件列表 (path + contents_key) |
| GET | /api/session/{devin_id}/keys | 全部云端文件 s3 key |
| GET | /api/session/{devin_id}/file?key=K | 下载单个云端文件内容 |
| POST | /api/session/{devin_id}/export | 一键导出全量 ZIP；body 可选 {"outputPath":"..."} |
| GET | /api/account/playbooks | 账号 playbooks |
| GET | /api/account/knowledge | 账号 knowledge |
| GET | /api/account/secrets | 账号 secrets 元数据 |
| GET | /api/account/org | org 设置 |
| GET | /api/doc | 本文档（实时再生成） |

## 示例

\`\`\`bash
# 探活
curl ${base}/api/ping
# 状态
curl -H "Authorization: Bearer ${tok}" ${base}/api/status
# 登录（如未登录）
curl -X POST -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \\
  -d '{"email":"xxx@gmail.com","password":"***"}' ${base}/api/login
# 会话列表
curl -H "Authorization: Bearer ${tok}" "${base}/api/sessions?q=导出"
# 导出某会话全量 ZIP
curl -X POST -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \\
  -d '{"outputPath":"D:/exports/session.zip"}' ${base}/api/session/devin-xxxx/export
\`\`\`

\`\`\`powershell
# PowerShell
$h = @{ Authorization = "Bearer ${tok}" }
Invoke-RestMethod "${base}/api/status" -Headers $h
(Invoke-RestMethod "${base}/api/sessions" -Headers $h) | Select-Object devin_id, title, status
Invoke-RestMethod "${base}/api/session/devin-xxxx/export" -Method Post -Headers $h -Body '{}' -ContentType 'application/json'
\`\`\`

## 说明

- Bridge 仅监听 127.0.0.1，token 每次启动自动生成并持久化，可通过命令 \`DAO: Export Agent Bridge Doc (MD)\` 或侧边栏「📄 导出MD」按钮随时导出最新文档。
- 全部软编码可配置（VS Code 设置 daoDevin.*）：bridgePort（默认 7848，占用自动顺延）、proxy（留空自动依次尝试 http.proxy → HTTPS_PROXY 环境变量 → 直连）、apiBase、loginUrl、并发/重试/超时。
- 高速下载引擎：12 路并发 + 每文件 3 次重试；323 文件会话约 3 秒导出。
- ZIP 内容: session_info.json / events.json / worklog.md / cloud_files/ / changes/ / EXPORT_MANIFEST.json。

无为而无不为 道法自然
`;
  }
}

const ENDPOINTS = [
  'GET /api/ping', 'GET /api/status', 'POST /api/login', 'POST /api/logout',
  'GET /api/sessions?q=&refresh=1',
  'GET /api/session/{devin_id}', 'GET /api/session/{devin_id}/events',
  'GET /api/session/{devin_id}/worklog', 'GET /api/session/{devin_id}/changes',
  'GET /api/session/{devin_id}/keys', 'GET /api/session/{devin_id}/file?key=',
  'POST /api/session/{devin_id}/export',
  'GET /api/account/playbooks', 'GET /api/account/knowledge',
  'GET /api/account/secrets', 'GET /api/account/org', 'GET /api/doc',
];
