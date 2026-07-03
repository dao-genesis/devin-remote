// dao-vsix extension.ts
// The IDE IS the server. Dao - Workspace as Server.
// 反者道之动 - VSIX即中枢
// 天下之至柔驰骋於天下之致坚 - 出站WebSocket绕过一切NAT

import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════
// 道 · 常量 — 天得一以清 地得一以寧
// CF全局共享(一机一CF账号) + 每工作区独立(一窗口一Devin账号)
// 帛书·三十九「致数与无与」— 不欲禄禄若玉 珞珞若石
// ═══════════════════════════════════════════════════════════
// 版本号 — 帛书·「自知者明」— 唯一真源取自 package.json，杜绝常量漂移（一劳永逸）
const EXT_VERSION: string = (() => {
    for (const p of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, 'package.json')]) {
        try { const v = JSON.parse(fs.readFileSync(p, 'utf8')).version; if (v) return String(v); } catch { /* 守柔 */ }
    }
    return '1.3.2';
})();
const DAO_DIR = path.join(os.homedir(), '.dao');
// 软编码·归一 — 帛书「道生一」: 本机 API 单一权威默认端口。package.json `dao.port` 默认与此恒同;
//   全部 `ws.port || <数字>` 回落统一引此常量, 杜绝 9910/9921 等散落魔数与清单(9920)漂移失配。
const DEFAULT_PORT = 9920;
// 道·无缝接力(seamless handoff) — 帛书·「反者道之动」: 窗口/IDE 重启、切号时账号 API 端口会变,
//   旧 dao-conn.json 只增不删 → 外部 Agent 无从判定「下一个活接口」, 连续性断需人工接管。
//   此处让「谁是活的」成为磁盘上的自愈真相: 裁剪死 pid + 维护单一权威 dao-conn-current.json
//   (含单调 epoch, 端口/pid/url 变化才 +1), 常驻桥(独立进程·不随窗口死)随时可读 →
//   重启/切号全程可解析活接口, 守柔不抖。
const DAO_CONN_REGISTRY = path.join(DAO_DIR, 'dao-conn.json');
const DAO_CONN_CURRENT = path.join(DAO_DIR, 'dao-conn-current.json');
function daoPidAlive(pid: number): boolean {
    if (!pid || typeof pid !== 'number') return false;
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (e: any) { return !!(e && e.code === 'EPERM'); }
}
// 裁剪死实例 + 按 pid 去重(留最新 updated), 仅在有变化时回写; 返回活实例数组。
function daoPruneConnRegistry(): any[] {
    let all: any[] = [];
    try { all = JSON.parse(fs.readFileSync(DAO_CONN_REGISTRY, 'utf8')); if (!Array.isArray(all)) all = []; } catch { return []; }
    const byPid = new Map<number, any>();
    for (const c of all) {
        if (!c || !daoPidAlive(c.pid)) continue;
        const prev = byPid.get(c.pid);
        if (!prev || String(c.updated || '') >= String(prev.updated || '')) byPid.set(c.pid, c);
    }
    const live = Array.from(byPid.values());
    try { if (live.length !== all.length) fs.writeFileSync(DAO_CONN_REGISTRY, JSON.stringify(live, null, 2), 'utf8'); } catch { /* 守柔 */ }
    return live;
}
// 健康探活: 直连端口 /api/health 确认真有 dao-vsix 在听。帛书·「自知者明」: pid 可能被 OS 回收
//   (旧死实例的 pid 被别的进程占用 → process.kill 误判活), 故以「端口是否应答」为活的唯一真相。
function daoProbeHealth(port: number): Promise<{ port: number; pid?: number; version?: string } | null> {
    return new Promise((resolve) => {
        try {
            const http = require('http');
            const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 700 }, (r: any) => {
                let d = ''; r.on('data', (c: any) => d += c);
                r.on('end', () => { try { const j = JSON.parse(d); resolve({ port, pid: j.pid, version: j.version }); } catch { resolve(r.statusCode === 200 ? { port } : null); } });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { try { req.destroy(); } catch { /* 守柔 */ } resolve(null); });
            req.end();
        } catch { resolve(null); }
    });
}
// 据「真应答」的活实例刷新权威「当前接口」: 取端口最小者为确定性 leader(不抖动), epoch 仅在 leader 真变时 +1。
//   候选来自 pid-裁剪后的注册表 ∪ 本窗口; 再逐一 /api/health 验证 → 杜绝 pid 回收造成的幽灵 leader。
async function daoRefreshCurrent(): Promise<any> {
    const reg = daoPruneConnRegistry();
    let prev: any = {};
    try { prev = JSON.parse(fs.readFileSync(DAO_CONN_CURRENT, 'utf8')) || {}; } catch { /* 首次 */ }
    const byPort = new Map<number, any>();
    for (const c of reg) { if (c && c.port) byPort.set(c.port, c); }  // 同端口取最后(最新)
    const ports = new Set<number>(); if (ws && ws.port) ports.add(ws.port);
    for (const p of byPort.keys()) ports.add(p);
    const probed = await Promise.all(Array.from(ports).map(p => daoProbeHealth(p)));
    const alive = probed.filter((x): x is { port: number; pid?: number; version?: string } => !!x)
        .map(v => { const r = byPort.get(v.port) || {}; return { port: v.port, pid: v.pid, version: v.version, url: r.url || ('http://localhost:' + v.port), devinEmail: r.devinEmail, devinOrgId: r.devinOrgId, workspacePath: r.workspacePath, _token: r.token }; })
        .sort((a, b) => a.port - b.port);
    const leader = alive[0];
    if (!leader) return prev;  // 无任何应答: 保留旧 current(常驻桥仍可据此尝试)
    const changed = prev.port !== leader.port || prev.pid !== leader.pid || prev.url !== leader.url;
    const epoch = (typeof prev.epoch === 'number' ? prev.epoch : 0) + (changed ? 1 : 0);
    const cur: any = {
        url: leader.url, token: leader._token || (leader.port === (ws && ws.port) ? (ws && ws.token) : '') || '',
        port: leader.port, host: os.hostname(), pid: leader.pid, version: leader.version,
        devinEmail: leader.devinEmail, devinOrgId: leader.devinOrgId, workspacePath: leader.workspacePath,
        epoch, updated: new Date().toISOString(),
        alive: alive.map(a => ({ port: a.port, pid: a.pid, version: a.version, url: a.url, devinEmail: a.devinEmail }))
    };
    try { fs.writeFileSync(DAO_CONN_CURRENT, JSON.stringify(cur, null, 2), 'utf8'); } catch { /* 守柔 */ }
    return cur;
}
const GLOBAL_CONFIG_FILE = path.join(DAO_DIR, 'dao-config.json');  // CF全局凭证
const CONFIG_FILE = GLOBAL_CONFIG_FILE;  // 别名 — 道法自然：一即一切
const INST_FILE = path.join(DAO_DIR, 'dao-instances.json');
// 绝利一源 · 帛书「道生一」— 备份引擎单一来源: 直接复用内联 rt-flow 的 devin_cloud.js,
// 全功能面板 Session/备份板块不再另起炉灶, 与 rt-flow 备份成果同源呈现 (问题②③)。
let _devinCloudModule: any = null;
function loadDevinCloud(): any {
    if (_devinCloudModule) return _devinCloudModule;
    // 双布局自适应(同 _rtflowModule): 二合一独立版 rt-flow 捆绑于 ../rtflow/;
    // 归一(dao-one) rt-flow 在兄弟目录 ../../vendor-flow/。备份引擎单一来源, 两布局皆须命中。
    const cands = [
        path.join(__dirname, '..', 'rtflow', 'devin_cloud.js'),
        path.join(__dirname, '..', '..', 'vendor-flow', 'devin_cloud.js'),
    ];
    for (const c of cands) {
        try { if (fs.existsSync(c)) { _devinCloudModule = require(c); break; } } catch { _devinCloudModule = null; }
    }
    return _devinCloudModule;
}
// 备份根目录解析: 与 rt-flow 完全一致 (wam.devinCloudBackupDir 覆盖 → 否则 DC_BACKUP_DEFAULT=~/.wam/devin_cloud_backups)
function resolveBackupRoot(): string {
    let cfg = '';
    try { cfg = (vscode.workspace.getConfiguration('wam').get('devinCloudBackupDir', '') as string) || ''; } catch { /* 守柔 */ }
    if (cfg) return cfg;
    const dc = loadDevinCloud();
    return (dc && dc.paths && dc.paths.DC_BACKUP_DEFAULT) || path.join(os.homedir(), '.wam', 'devin_cloud_backups');
}
// 最小 ZIP 文本读取器 (无三方依赖): 解析 EOCD→中央目录, 找首个匹配 entry, 用 zlib.inflateRawSync 解出文本。
// 仅用于内联查看 .zip 型对话备份 (对话.md/html)。method 0=stored, 8=deflate。
function readZipTextEntry(zipPath: string, patterns: RegExp[]): { name: string; text: string } | null {
    const zlib = require('zlib');
    const buf: Buffer = fs.readFileSync(zipPath);
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 65536);
    for (let i = buf.length - 22; i >= minPos; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cdCount = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entries: { name: string; method: number; lho: number; csize: number }[] = [];
    for (let n = 0; n < cdCount; n++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
        const method = buf.readUInt16LE(off + 10);
        const csize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        entries.push({ name, method, lho, csize });
        off += 46 + nameLen + extraLen + commentLen;
    }
    for (const pat of patterns) {
        const e = entries.find(en => pat.test(en.name));
        if (!e) continue;
        if (buf.readUInt32LE(e.lho) !== 0x04034b50) continue;
        const nLen = buf.readUInt16LE(e.lho + 26);
        const xLen = buf.readUInt16LE(e.lho + 28);
        const dataStart = e.lho + 30 + nLen + xLen;
        const comp = buf.slice(dataStart, dataStart + e.csize);
        let raw: Buffer;
        if (e.method === 0) raw = comp;
        else if (e.method === 8) raw = zlib.inflateRawSync(comp);
        else continue;
        return { name: e.name, text: raw.toString('utf8') };
    }
    return null;
}
// 账号池 — 帛书·六十二「道者万物之注」
// email→password 映射: IDE 注入的 session token 仅能访问 codeium 后端,
// 被 app.devin.ai 拒绝; 全功能面板需 auth1, 而 auth1 只能由 email+password 五步登录换取。
// 账号池让 dao-vsix 据当前登录 email 查到密码 → 自动换取 auth1 → 真实 org。
const ACCOUNTS_FILE = path.join(DAO_DIR, 'accounts.json');
const ACCOUNTS_TXT = path.join(DAO_DIR, 'accounts.txt');
// 归一·账号池同源 (本源修复): 反向注入必须与「切号板块」读同一真池 ~/.wam/accounts.md，
//   否则注入对着旧/假的 ~/.dao/accounts.json 空转(用户真账号在 wam 真池里却从不被注入)。
//   候选与 rt-flow loadAccountsFromFs 对齐: 配置 accountsFile > ~/.wam/accounts.md > ~/.wam/accounts-backup.json。
const WAM_DIR = path.join(os.homedir(), '.wam');
const WAM_ACCOUNTS_MD = path.join(WAM_DIR, 'accounts.md');
const WAM_ACCOUNTS_BACKUP = path.join(WAM_DIR, 'accounts-backup.json');
// TOKEN_FILE removed — per-workspace: ws.tokenFile
// SESSION_FILE removed — per-workspace: ws.sessionFile
const PROXY_PORTS = [7890, 10809, 7891, 1080, 10808, 8080, 8118];
let detectedProxyPort = 0;
// 自愈重试态 — 帛书·「反者道之动」启动之初凭证未就绪, 以退为进自行收敛
let _autoHealAttempts = 0;
let _autoHealTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_HEAL_DELAYS = [3000, 8000, 20000, 45000];
// 归一 · 帛书「道生一」— 内联 rt-flow 运行时句柄(左·RT Flow 账号池/切号 入 dao-vsix 本体)
interface RtflowInternals { buildHtml?: () => string; handleWebviewMessage?: (m: any) => Promise<void> | void; setHostPost?: (fn: ((m: any) => void) | null) => void; openShellHome?: (board?: string) => Promise<{ ok: boolean; error?: string }>; openMultiInstance?: (opts: { email?: string; devinId?: string; password?: string; path?: string; label?: string }) => Promise<{ ok: boolean; error?: string; reused?: boolean }>; }
interface RtflowModule { activate?: (ctx: vscode.ExtensionContext) => unknown; deactivate?: () => unknown; _internals?: RtflowInternals; }
let _rtflowModule: RtflowModule | null = null;

// ═══════════════════════════════════════════════════════════
// 道 · 玄牝之门用之不堇 — 上游连接复用(keep-alive)
// 免每请求重握手 → 官网导航/配置点击提速(原每次新建 TCP+TLS)
// ═══════════════════════════════════════════════════════════
const upstreamHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 16 });
const upstreamHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 16, rejectUnauthorized: false });
// 道·通用网页代理(搜索引擎/任意站)连接池: 各站各自 keep-alive, 多路复用免 TLS 重握手, 根治搜索引擎「完全不可用」。
const webProxyHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 32, maxFreeSockets: 8, rejectUnauthorized: false });
const webProxyHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 32, maxFreeSockets: 8 });
// 道·「知其雄·守其雌」— 站内网页反代 per-origin Cookie 罐。单源代理(全站皆落 127.0.0.1:9920)下
//   浏览器无法按目标站隔离 Cookie → 登录态/CSRF/会话在 GitHub 等站内「操作」时全部丢失(旧病灶:
//   只能搜索·一操作就用不了)。故 Cookie 由服务端按目标 origin 存/发, 与浏览器 127.0.0.1 Cookie 罐脱钩,
//   多站会话各归其源、并行不悖。上限保平(超额淘汰最旧源) → 守柔不涨爆内存。
const webProxyCookieJar = new Map<string, Map<string, string>>();
const WEB_COOKIE_ORIGIN_MAX = 128;
function webProxyCookieHeader(origin: string): string {
    const jar = webProxyCookieJar.get(origin);
    if (!jar || !jar.size) return '';
    return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
}
function webProxyStoreCookies(origin: string, setCookie: any): void {
    if (!setCookie) return;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    let jar = webProxyCookieJar.get(origin);
    if (!jar) {
        if (webProxyCookieJar.size >= WEB_COOKIE_ORIGIN_MAX) { const k0 = webProxyCookieJar.keys().next().value; if (k0 !== undefined) webProxyCookieJar.delete(k0); }
        jar = new Map(); webProxyCookieJar.set(origin, jar);
    }
    for (const sc of arr) {
        const first = String(sc).split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const val = first.slice(eq + 1).trim();
        const expired = /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(String(sc)) || /expires=[^;]*1970/i.test(String(sc));
        if (!name) continue;
        if (expired || val === '') jar.delete(name); else jar.set(name, val);
    }
}
// 执今之道见小曰明 — Vite 内容哈希静态资源(/assets/*)缓存 (内存 L1 + 磁盘 L2)
// 哈希变则键变 → 永不陈旧; 免重复穿隧道 → 二次导航秒开。
// 道·「穿透只传必要核心」: 公网用户的渲染负荷(JS/CSS/字体, 占带宽大头)经反代首取后落盘 L2,
//   此后任一用户/任一次宿主重载皆命中本地缓存零穿隧 → 隧道只剩 API/HTML 等动态核心数据。
//   (app.devin.ai 静态资产 S3 无 CORS 头, 浏览器无法跨源直取 ES module; 故同源反代 + 落盘
//    L2 + 浏览器 immutable 缓存三级, 是桌面端「公网渲染只传核心」的正解。)
interface StaticCacheVal { status: number; headers: any; body: string; contentType: string; binary?: boolean }
const staticAssetCache = new Map<string, StaticCacheVal>();
const STATIC_CACHE_MAX = 256;
const STATIC_CACHE_DIR = path.join(os.homedir(), '.dao', 'asset-cache');
function _staticCacheFile(key: string): string {
    const safe = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(STATIC_CACHE_DIR, safe + '.json');
}
function staticCachePut(key: string, val: StaticCacheVal) {
    if (staticAssetCache.size >= STATIC_CACHE_MAX) {
        const first = staticAssetCache.keys().next().value;
        if (first !== undefined) staticAssetCache.delete(first);
    }
    staticAssetCache.set(key, val);
    // 写穿磁盘 L2 (异步·不阻塞宿主; 失败守柔) → 跨宿主重载/多用户共享同一份资产
    try {
        fs.mkdir(STATIC_CACHE_DIR, { recursive: true }, () => {
            try { fs.writeFile(_staticCacheFile(key), JSON.stringify(val), 'utf8', () => {}); } catch { /* 守柔 */ }
        });
    } catch { /* 守柔 */ }
}
// 从磁盘 L2 取并回灌内存 L1 (同步读·仅静态资产首次内存未命中时调用一次)。
function staticCacheGetDisk(key: string): StaticCacheVal | null {
    try {
        const f = _staticCacheFile(key);
        if (!fs.existsSync(f)) return null;
        const val = JSON.parse(fs.readFileSync(f, 'utf8')) as StaticCacheVal;
        if (val && typeof val.body === 'string') { staticAssetCache.set(key, val); return val; }
    } catch { /* 守柔 */ }
    return null;
}

// ═══ 公网同源资源图预热 (cloud prewarm) ═══════════════════════════════════════
// 帛书·「为之于其未有·治之于其未乱」: IDE 多实例那条 (devin_proxy) 已启动即预热; 而公网
//   同源这条 (devinCloudProxyRoute, 缓存 ~/.dao/asset-cache) 原为惰性填充 — 仅被请求时落盘,
//   故第一个公网设备打开仍走整条冷模块图瀑布 (正是 IDE 侧已解决之症, 只是发生在公网路)。
//   今搬同一道理到公网路: 服务一就绪即后台并行自取全 SPA 模块图 (BFS·经本机 /devin-cloud
//   反代, 与惰性路逐字一致地落 L1 内存 + L2 磁盘), 首个公网设备即命中宿主暖缓存 → 隧道只剩
//   API/HTML 动态核心 (知雄守雌)。换版 (入口分片哈希变) 自动重热; 失败守柔不阻服务;
//   DAO_NO_PREWARM=1 可关。
const _CLOUD_ASSET_RE = /\/assets\/[A-Za-z0-9_\-.]+\.(?:js|css)/g;
let _cloudPrewarmKey = '';                       // 已预热版本键 (入口分片名)
let _cloudPrewarmCritical = '';                  // 首屏关键路径已暖的版本键 (先于全图完成)
const _cloudPrewarmActive = new Set<string>();   // 正在预热的版本键 → 防重复并发

// 经本机服务自取一条路由 (复用 handleRouteInternal → devinCloudProxyRoute 全部抓取/改写/落盘
//   逻辑, 零重复实现; 命中缓存即返回·未命中则首取并落 L1+L2)。仅取正文供 BFS 发现深层分片。
async function _cloudProbe(route: string, token: string): Promise<{ body: string; ct: string } | null> {
    try {
        if (!ws.port) return null;
        const url = new URL(route, `http://localhost:${ws.port}`);
        const fakeReq: any = { headers: { host: 'localhost' }, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, url: route };
        const r: any = await handleRouteInternal(route, url, fakeReq, token);
        if (r && r._proxy && (r.status === 200 || r.status === undefined)) {
            const body = (!r.binary && typeof r.body === 'string') ? r.body : '';
            return { body, ct: r.contentType || '' };
        }
    } catch { /* 守柔 */ }
    return null;
}

// 后台预热公网 SPA 全模块图入同源缓存。BFS: index → 抓引用分片 → 扫分片再发现深层分片。
async function _prewarmCloudGraph(token: string): Promise<void> {
    if (process.env.DAO_NO_PREWARM || !ws.port) return;
    try {
        const idx = await _cloudProbe('/devin-cloud/', token);
        if (!idx || !idx.body) return;
        const html = idx.body;
        const key = ((html.match(/\/assets\/index-[A-Za-z0-9_\-.]+\.js/) || [])[0]) || String(html.length);
        if (_cloudPrewarmKey === key || _cloudPrewarmActive.has(key)) return; // 已热/在热 → 守静
        _cloudPrewarmActive.add(key);
        const t0 = Date.now();
        const seen = new Set<string>();
        let queue: string[] = [];
        let m: RegExpExecArray | null;
        const re0 = new RegExp(_CLOUD_ASSET_RE.source, 'g');
        while ((m = re0.exec(html))) { if (!seen.has(m[0])) { seen.add(m[0]); queue.push(m[0]); } }
        let rounds = 0, fetched = 0;
        const CONC = 32, MAX = 2000;
        // 帛书·先以最高优先级灌首屏关键路径 (index 直引入口分片+CSS+modulepreload), 余深层 dynamic-
        //   import 分片后台续抓 → 首个公网设备"首开"只等首屏几片·不等全图 (根治冷窗口)。
        const critical = queue.slice();
        const ct0 = Date.now();
        for (let i = 0; i < critical.length; i += CONC) {
            await Promise.all(critical.slice(i, i + CONC).map(async (p) => {
                const r = await _cloudProbe('/devin-cloud' + p, token);
                if (r) fetched++;
            }));
        }
        _cloudPrewarmCritical = key;
        try {
            const cl = '[' + new Date().toISOString().slice(11, 19) + '] [cloud] critical-path warm: ' + critical.length + ' assets in ' + (Date.now() - ct0) + 'ms\n';
            fs.appendFile(path.join(DAO_DIR, 'cloud-prewarm.log'), cl, () => {});
            console.log(cl.trim());
        } catch { /* 守柔 */ }
        while (queue.length && rounds++ < 6 && seen.size < MAX) {
            const next: string[] = [];
            for (let i = 0; i < queue.length; i += CONC) {
                const got = await Promise.all(queue.slice(i, i + CONC).map(async (p) => {
                    const r = await _cloudProbe('/devin-cloud' + p, token);
                    if (!r) return '';
                    fetched++;
                    return r.ct.includes('javascript') ? r.body : '';
                }));
                for (const txt of got) {
                    if (!txt) continue;
                    const re = new RegExp(_CLOUD_ASSET_RE.source, 'g');
                    let mm: RegExpExecArray | null;
                    while ((mm = re.exec(txt))) { if (!seen.has(mm[0])) { seen.add(mm[0]); next.push(mm[0]); } }
                }
            }
            queue = next;
        }
        _cloudPrewarmKey = key;
        _cloudPrewarmActive.delete(key);
        void _cloudPrewarmCritical;
        try {
            const line = '[' + new Date().toISOString().slice(11, 19) + '] [cloud] prewarm done: ' + fetched + ' assets in ' + (Date.now() - t0) + 'ms\n';
            fs.appendFile(path.join(DAO_DIR, 'cloud-prewarm.log'), line, () => {});
            console.log(line.trim());
        } catch { /* 守柔 */ }
    } catch { _cloudPrewarmActive.clear(); /* 守柔: 预热失败不阻服务 */ }
}

// ═══════════════════════════════════════════════════════════
// 器 · WorkspaceState — 每窗口专属状态
// 一窗口 = 一工作区 = 一Devin账号 = 一relay会话 = 一公网URL
// 窗口关闭 = 连接自动断开 = 状态自然消亡
// ═══════════════════════════════════════════════════════════
class WorkspaceState {
    workspaceKey: string = '';
    workspaceDir: string = '';       // ~/.dao/workspaces/<key>/
    server: http.Server | null = null;
    port: number = 0;
    token: string = '';
    startTime: number = 0;
    // Relay — 每窗口独立会话
    relayWs: any = null;
    relayConnected: boolean = false;
    relayConnecting: boolean = false;
    relayReconnectTimer: any = null;
    relaySessionId: string = '';
    publicUrl: string | null = null;
    // Devin — 每窗口独立账号
    devinAuth1: string = '';
    devinOrgId: string = '';
    devinOrgName: string = '';
    devinOrgSlug: string = '';
    devinEmail: string = '';
    devinSessionToken: string = '';
    devinApiKey: string = '';
    devinWindsurfKey: string = '';  // 注册得到的 windsurf/codeium 风格密钥 — GetUserStatus 额度查询专用(cog_ 不被座席服务接受)
    devinApiServerUrl: string = '';
    devinAccountId: string = '';
    devinUserId: string = '';  // user-XXX — 路由官网 auth1_session 所需
    devinInjecting: boolean = false;
    devinAutoSyncing: boolean = false; // 帛书·「道法自然」— 自动同步中标记
    devinQuota: any = null;
    // Terminals
    terminals = new Map<string, vscode.Terminal>();
    terminalOutputBuffers = new Map<string, string>();

    // Config file paths — per-workspace
    get configFile() { return path.join(this.workspaceDir, 'config.json'); }
    get connFile() { return path.join(this.workspaceDir, 'conn.json'); }
    get sessionFile() { return path.join(this.workspaceDir, 'session-id'); }
    get tokenFile() { return path.join(this.workspaceDir, 'token'); }
    get injectStateFile() { return path.join(this.workspaceDir, 'inject-state.json'); }

    init() {
        // Derive workspace key from first workspace folder
        // 道·「鸡犬相闻·民至老死不相往来」— 每窗口独立隔离键:
        //   有工作区 → 用文件夹路径(稳定持久, 同一仓库重开复用账号)
        //   无工作区 → 用 vscode.env.sessionId(每窗口唯一), 避免两个无文件夹窗口
        //              共用 'no-workspace' 键 → 账号互串(隔离边界被击穿)
        const wsFolders = vscode.workspace.workspaceFolders;
        let sessionSuffix = '';
        try { sessionSuffix = vscode.env.sessionId || ''; } catch {}
        const wsPath = wsFolders && wsFolders.length > 0
            ? wsFolders[0].uri.fsPath
            : ('no-workspace-' + sessionSuffix);
        this.workspaceKey = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
        this.workspaceDir = path.join(DAO_DIR, 'workspaces', this.workspaceKey);
        fs.mkdirSync(this.workspaceDir, { recursive: true });
        // Load saved per-workspace state
        this.loadState();
    }

    loadState() {
        try {
            const cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            this.token = cfg.token || '';
            this.relaySessionId = cfg.relaySessionId || '';
            this.devinAuth1 = cfg.devinAuth1 || '';
            this.devinOrgId = cfg.devinOrgId || '';
            this.devinOrgName = cfg.devinOrgName || '';
            this.devinOrgSlug = cfg.devinOrgSlug || '';
            this.devinEmail = cfg.devinEmail || '';
            this.devinSessionToken = cfg.devinSessionToken || '';
            this.devinApiKey = cfg.devinApiKey || '';
            this.devinWindsurfKey = cfg.devinWindsurfKey || '';
            this.devinApiServerUrl = cfg.devinApiServerUrl || '';
            this.devinAccountId = cfg.devinAccountId || '';
            this.devinUserId = cfg.devinUserId || '';
            this.devinQuota = cfg.devinQuota || null;
        } catch {}
    }

    saveState() {
        try {
            const cfg: any = {
                workspaceKey: this.workspaceKey,
                workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                token: this.token,
                relaySessionId: this.relaySessionId,
                devinAuth1: this.devinAuth1,
                devinOrgId: this.devinOrgId,
                devinOrgName: this.devinOrgName,
                devinOrgSlug: this.devinOrgSlug,
                devinEmail: this.devinEmail,
                devinSessionToken: this.devinSessionToken,
                devinApiKey: this.devinApiKey,
                devinWindsurfKey: this.devinWindsurfKey,
                devinApiServerUrl: this.devinApiServerUrl,
                devinAccountId: this.devinAccountId,
                devinUserId: this.devinUserId,
                updatedAt: new Date().toISOString()
            };
            if (this.devinQuota) cfg.devinQuota = this.devinQuota;
            fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2), 'utf8');
        } catch {}
    }

    saveConnection() {
        const info: any = {
            url: this.publicUrl || ('http://localhost:' + this.port),
            token: this.token,
            port: this.port,
            hostname: os.hostname(),
            user: os.userInfo().username,
            pid: process.pid,
            platform: os.type() + ' ' + os.release(),
            workspaceKey: this.workspaceKey,
            workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            updated: new Date().toISOString(),
            service: 'dao-vsix'
        };
        if (this.relaySessionId) info.sessionId = this.relaySessionId;
        if (this.relayConnected) info.relay = 'connected';
        if (this.publicUrl) info.relayUrl = this.publicUrl;
        info.primaryUrl = this.publicUrl || ('http://localhost:' + this.port);
        // 帛书·三十九「致数与无与」— 每窗口独立账号
        if (this.devinEmail) info.devinEmail = this.devinEmail;
        if (this.devinOrgId) info.devinOrgId = this.devinOrgId;
        if (this.devinOrgName) info.devinOrgName = this.devinOrgName;
        try {
            // Per-workspace连接文件 — 窗口专属，永不互踩
            fs.writeFileSync(this.connFile, JSON.stringify(info, null, 2), 'utf8');
            // 全局连接注册表 — 数组合集，按pid去重合并
            const globalConnFile = path.join(DAO_DIR, 'dao-conn.json');
            let allConns: any[] = [];
            try { allConns = JSON.parse(fs.readFileSync(globalConnFile, 'utf8')); if (!Array.isArray(allConns)) allConns = []; } catch {}
            allConns = allConns.filter((c: any) => c.pid !== process.pid);
            allConns.push(info);
            fs.writeFileSync(globalConnFile, JSON.stringify(allConns, null, 2), 'utf8');
            // 无缝接力: 裁剪死实例 + 刷新权威「当前接口」(epoch 单调) → 重启/切号后外部可解析活接口
            daoRefreshCurrent().catch(() => { /* 守柔 */ });
        } catch {}
    }

    getOrCreateToken(): string {
        if (this.token && this.token.length >= 16) return this.token;
        try {
            const t = fs.readFileSync(this.tokenFile, 'utf8').trim();
            if (t && t.length >= 16) { this.token = t; return t; }
        } catch {}
        // 道·令牌恒稳: 无工作区窗口的 workspaceKey 由 vscode.env.sessionId 派生,
        //   每次重开即变 → 令牌随之漂移(重启后旧牌失效, 公网/外部客户端断连)。
        //   故回落机器级全局令牌文件(全机一致), 重启/换窗口仍复用同一牌;
        //   有工作区且已存自有 token 者上面已优先用己(账号隔离边界不破)。
        const globalTokenFile = path.join(DAO_DIR, 'api-token');
        try {
            const g = fs.readFileSync(globalTokenFile, 'utf8').trim();
            if (g && g.length >= 16) {
                this.token = g;
                try { fs.writeFileSync(this.tokenFile, g, 'utf8'); } catch {}
                this.saveState();
                return g;
            }
        } catch {}
        this.token = 'dao-vsix-' + crypto.randomBytes(16).toString('hex');
        try { fs.writeFileSync(this.tokenFile, this.token, 'utf8'); } catch {}
        try { fs.mkdirSync(DAO_DIR, { recursive: true }); fs.writeFileSync(globalTokenFile, this.token, 'utf8'); } catch {}
        this.saveState();
        return this.token;
    }

    getOrCreateSessionId(): string {
        if (this.relaySessionId) return this.relaySessionId;
        try {
            if (fs.existsSync(this.sessionFile)) {
                this.relaySessionId = fs.readFileSync(this.sessionFile, 'utf8').trim();
                if (this.relaySessionId) return this.relaySessionId;
            }
        } catch {}
        // 每窗口专属session：workspaceKey + 32字符随机后缀（3.4×10^38种，不可暴力猜）
        this.relaySessionId = this.workspaceKey + '-' + crypto.randomBytes(16).toString('hex');
        try { fs.writeFileSync(this.sessionFile, this.relaySessionId, 'utf8'); } catch {}
        this.saveState();
        return this.relaySessionId;
    }

    devinSaveConfig() {
        this.saveState();
    }
}

// 全局唯一实例 — 每个VSCode窗口一个
let ws: WorkspaceState;
let statusBarItem: vscode.StatusBarItem;
// 帛书·二十五「道法自然」— 扩展安装路径 · 供读取捆绑的规则文本
let _daoExtPath: string = '';
// ═══════════════════════════════════════════════════════════
// 道法自然 · 实时凭证同步 — 帛书·「不出於戶以知天下」
// RT Flow同源机制: 每5秒轮询vscdb，检测账号切换，自动同步
// 窗口 = 账号 — 账号切换即刻同步，无为而无不为
// ═══════════════════════════════════════════════════════════
let credSyncTimer: ReturnType<typeof setInterval> | null = null;
let lastSyncedApiKey: string = '';
let lastSyncedEmail: string = '';
const CRED_SYNC_INTERVAL = 2500; // 2.5秒轮询 — RT Flow同源频率(实时跟随切号)
// 帛书规则缓存 (你本无名…道德经/阴符经 7758字) — 一次读取，缓存复用
let _daoRulesCache: string | null = null;
function getDaoRulesText(): string {
    if (_daoRulesCache !== null) return _daoRulesCache;
    const candidates = [
        _daoExtPath ? path.join(_daoExtPath, 'media', 'dao-rules.md') : '',
        path.join(__dirname, '..', 'media', 'dao-rules.md'),
        path.join(__dirname, 'media', 'dao-rules.md'),
    ].filter(Boolean);
    for (const p of candidates) {
        try {
            const t = fs.readFileSync(p, 'utf8').trim();
            if (t && t.length > 100) { _daoRulesCache = t; return t; }
        } catch { /* 道法自然·守柔 */ }
    }
    _daoRulesCache = '';
    return '';
}
// 帛书《老子》/ 道藏《阴符经》分卷文本 — 供单独 Playbook 注入 (合订见 dao-rules.md)
const _daoAssetCache: { [k: string]: string } = {};
function getDaoAsset(name: string): string {
    if (_daoAssetCache[name] !== undefined) return _daoAssetCache[name];
    const candidates = [
        _daoExtPath ? path.join(_daoExtPath, 'media', 'dao', name) : '',
        path.join(__dirname, '..', 'media', 'dao', name),
        path.join(__dirname, 'media', 'dao', name),
    ].filter(Boolean);
    for (const p of candidates) {
        try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) { _daoAssetCache[name] = t; return t; } } catch { /* 守柔 */ }
    }
    _daoAssetCache[name] = '';
    return '';
}


export async function activate(context: vscode.ExtensionContext) {
    // 初始化每窗口专属状态
    ws = new WorkspaceState();
    ws.init();

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'dao.openUnifiedShell';
    context.subscriptions.push(statusBarItem);

    // ═══════════════════════════════════════════════════════════
    // 归一 · 帛书「道生一,一生二」— 内联激活 rt-flow 运行时
    // 二插合一为单一插件: 左 RT Flow(账号池/切号) + 中 数联 Devin Cloud。
    // 守柔: rt-flow 激活异常不得阻断 dao-vsix 自身激活。
    // ═══════════════════════════════════════════════════════════
    // 归一·账号池同源: 把 dao-vsix 账号池(~/.dao/accounts.json)镜像到 rt-flow(wam) 可读取的
    // ~/.wam/accounts-backup.json, 使「左·切号」与「中·数联」共用同一账号池(二合一同源)。
    // 守柔: 须在 rt-flow 激活前完成, 使 wam 启动即见账号, 不再报「无账号」。
    try { syncAccountPoolToWam(); } catch (e) { try { console.error('[dao-vsix] 账号池同源 wam 失败(守柔):', e); } catch { /* 守柔 */ } }
    try {
        // 归一·句柄解析(反者道之动): 二合一(standalone) rt-flow 捆绑于 ../rtflow/, 由本插件 activate;
        // 归一(dao-one) rt-flow 在兄弟目录 ../../vendor-flow/ 由宿主装配器 activate —— 本插件只取「同一实例」
        // 句柄(require 命中 Node 模块缓存 → 共享 _internals), 绝不重复 activate(否则命令/视图重注册必崩)。
        const _bundledRtflow = path.join(__dirname, '..', 'rtflow', 'extension.js');
        const _siblingRtflow = path.join(__dirname, '..', '..', 'vendor-flow', 'extension.js');
        let _activateRtflowHere = false;
        let _rtflowPath: string | null = null;
        if (fs.existsSync(_bundledRtflow)) { _rtflowPath = _bundledRtflow; _activateRtflowHere = true; }
        else if (fs.existsSync(_siblingRtflow)) { _rtflowPath = _siblingRtflow; _activateRtflowHere = false; }
        if (_rtflowPath) _rtflowModule = require(_rtflowPath) as RtflowModule;
        if (_activateRtflowHere && _rtflowModule && typeof _rtflowModule.activate === 'function') {
            await Promise.resolve(_rtflowModule.activate(context));
        }
        // 归一 · 把「全功能面板六大板块」作为同级子网页接进 rt-flow 统一外壳。
        // 外壳经 blob-iframe + 消息中继挂载本面板 HTML, 复用 handleMiddlePanelMessage/refresh, 零重写。
        try {
            const int = (_rtflowModule && _rtflowModule._internals) as (RtflowInternals & { setCloudProvider?: (p: unknown) => void; setDevinProxyBridgeServe?: (fn: (rp: string, u: URL) => Promise<any>) => void }) | undefined;
            // 归一 · 把拖拽上传桥路由服务注入 IDE 内多实例反代 → /__daobridge.js·/__dlfile·/__convmd
            //   就地同源服务于各账号反代端口 (根治"拖文件/会话到内嵌 Devin 页无反应")。
            try { if (int && typeof int.setDevinProxyBridgeServe === 'function') int.setDevinProxyBridgeServe(daoServeBridgeRoute); } catch { /* 守柔 */ }
            if (int && typeof int.setCloudProvider === 'function') {
                int.setCloudProvider({
                    buildHtml: (board?: string) => getDaoCloudMiddlePanelHtml(getPanelState(), board),
                    // 归一 · webview 框架层封禁 blob: 子帧 → 板块改经本地 HTTP(127.0.0.1) 直出,
                    //   webview CSP 本就放行 127.0.0.1:* (账号页同理), 故板块得以真正加载。
                    boardUrl: (board?: string) => (ws.port && ws.token)
                        ? ('http://127.0.0.1:' + ws.port + '/__board?b=' + encodeURIComponent(board || 'overview') + '&master_token=' + encodeURIComponent(ws.token))
                        : '',
                    // 归一 · 站内开任意网页/搜索: 经本地 HTTP 代理 /__web 直出(剥 XFO/CSP) → webview 当 iframe 加载, 不再弹外部系统浏览器。
                    webUrl: (target?: string) => (ws.port && target)
                        ? ('http://127.0.0.1:' + ws.port + '/__web?u=' + encodeURIComponent(target))
                        : '',
                    handleMessage: (m: any) => handleMiddlePanelMessage(m, context),
                    setHostPost: (fn: ((m: any) => void) | null) => { _middlePostTarget = fn; },
                    refresh: () => refreshDaoCloudMiddlePanel(),
                });
            }
        } catch { /* 守柔 */ }
    } catch (e) {
        try { console.error('[dao-vsix] 内联 rt-flow 激活失败(守柔不阻塞):', e); } catch { /* 守柔 */ }
    }

    // ═══════════════════════════════════════════════════════════
    // 双视图 · 帛书·四十二「万物负阴而抱阳」
    // 先声明provider，命令中需要引用
    // ═══════════════════════════════════════════════════════════
    const cloudPanel = new DaoCloudPanel(context.extensionUri);
    sidebarCloudPanel = cloudPanel;
    // 正本清源 · 帛书·「道并行而不相悖」— 左侧账号池/切号由 rt-flow 独任,
    // dao-vsix 专司中间数联面板, 经凭证同源(devinAutoChain)与 rt-flow 全链路联动。
    // 帛书·二十五「道法自然」— 记录扩展路径 · 供读取捆绑规则文本(dao-rules.md)
    try { _daoExtPath = context.extensionPath; } catch { /* 守柔 */ }
    // 道法自然 · 默认种入每账号自动注入 (《道德经·阴符经》知识/剧本 + 内网穿透MD) — 仅首次
    try { daoSeedDefaultInjectProfile(); } catch { /* 守柔 */ }
    // 知识库收口: 老档案补齐第三篇(MCP 使用文档)并对齐分层触发器 — 恰好 3 条知识
    try { daoMigrateKnowledgeTrinity(); } catch { /* 守柔 */ }
    // secret=PAT · 用户填入的 GitHub PAT 作为 secret 反向注入到所有账号 — 每次激活幂等校正
    try { daoSyncPatSecretIntoProfile(); } catch { /* 守柔 */ }
    // MCP=DAO Bridge · 把本机 MCP 网关公网地址钉入注入档案 → 反向注入所有账号 (URL 轮换自愈)
    try { daoSyncDaoMcpIntoProfile(); } catch { /* 守柔 */ }

    // ═══════════════════════════════════════════════════════════
    // 道法自然 · 零配置自动链 — 帛书·六十二「道者万物之注」
    // 窗口打开 → 检测代理 → 自动认证 → 自动注入 → 即开即用
    // 无为而无不为 — 用户零操作，如流水般自然
    // ═══════════════════════════════════════════════════════════

    // Step 0: 检测代理隧道 — 在所有网络请求之前
    detectProxyPort();

    // Step 0.5: 预读 vscdb 凭证缓存 — 避免后续 UI 刷新时阻塞
    // 帛书·五十四「善建者不拔」— 一次读取，缓存复用
    setTimeout(() => { try { readWindsurfCredentials(true); } catch {} }, 100);

    // Step 1: 自动启动服务器
    const config = vscode.workspace.getConfiguration('dao');
    if (config.get<boolean>('autoStart', true)) {
        await startServer(context);
    }

    // Step 2: Devin Cloud 自动联动 — Windsurf凭证1:1同步
    // 窗口 = 工作区 = 账号 — 一次认证，自动注入一切
    if (config.get<boolean>('devinAutoSync', true)) {
        // 帛书·「道法自然」— 自动同步中标记
        ws.devinAutoSyncing = true;
        sidebarCloudPanel?.refresh();
        devinAutoChain().then(async (authOk) => {
            ws.devinAutoSyncing = false;
            if (authOk) {
                sidebarCloudPanel?.refresh();
                refreshDaoCloudMiddlePanel();
                updateStatusBar();
                // Step 3: 认证成功 → 自动注入（服务器已启动才有URL）· auto 跟随: 归零清理账号守柔跳过
                if (ws.port && ws.devinAuth1 && ws.devinOrgId) {
                    const injectOk = await devinFullInject(false, true);
                    if (injectOk) {
                        sidebarCloudPanel?.refresh();
                        refreshDaoCloudMiddlePanel();
                    }
                }
            } else {
                sidebarCloudPanel?.refresh();
            }
            // Step 4: 启动实时凭证同步 — RT Flow同源机制
            // 帛书·「反者道之动」— 轮询vscdb，检测账号切换
            startCredentialSync();
            // Step 5: 自愈重试 — 启动之初凭证/账号池/代理或未就绪而仅得 session-token,
            // 以退为进退避重试, 自行收敛到可注入 auth1。无为而无不为。
            if (!daoHasInjectableAuth1()) scheduleAutoChainHeal(true);
        });
    }
    // 归一·深融 · 订阅 rt-flow 切号事件 → 即刻跟随 (复用自动链, 不等轮询; 守 manual 单号模式)
    try {
        const bus = daoOneBus();
        if (bus) {
            const onSwitch = (payload?: any) => { onRtFlowAccountSwitch(payload).catch(() => {}); };
            bus.on('dao:account', onSwitch);
            context.subscriptions.push({ dispose: () => { try { bus.removeListener('dao:account', onSwitch); } catch { /* 守柔 */ } } });
        }
    } catch { /* 守柔 */ }
    // 内穿持久化/智能刷新 — 延后触发(待服务器/凭证就绪), 低频去重, 采纳常驻桥发布的连接, 不另起隧道打扰
    setTimeout(() => { bridgeAutoPersist().catch(() => { /* 守柔 */ }); }, 4000);
    // v3.17.4 · 内穿实时反向注入: 监听隧道连接文件变化 → 防抖 → 仅签名变化才扩散到所有账号; 启动后延后做一次种入扩散。
    try { bridgeLoadLastInject(); } catch { /* 守柔 */ } // 重载后恢复「上次实注配源」→ 探活环可据此核对有效性
    try { bridgeWatchForReinject(context); } catch { /* 守柔 */ }
    setTimeout(() => { bridgeScheduleReinject('activate'); }, 8000);
    // 端口/URL 实时更新 · 存活探测环: 打得通保持稳定, 打不通即刷新并重注新地址
    try { startBridgeLivenessLoop(context); } catch { /* 守柔 */ }
    try { startQuotaAutoLimitLoop(context); } catch { /* 守柔 */ }
    try { startNetworkChangeWatch(context); } catch { /* 守柔 */ }
    // 账号库实时检测 + 全池反向注入闭环: 切号板块账号池/共享 auth 库/注入档案一变即全池核对注入(新增账号自动注入), 另周期自愈。
    try { startAccountPoolReconcileLoop(context); } catch { /* 守柔 */ }
    // 池级稳态环(②全账号额度动态跟随 + ④自动化隔离清理): 不依赖注入签名, 周期巡全池止血+跟随余额。
    try { startPoolSteadyStateLoop(context); } catch { /* 守柔 */ }
    setTimeout(() => { reconcileAccountPoolInject('activate', { force: true }).catch(() => { /* 守柔 */ }); }, 12000);
    context.subscriptions.push(
        vscode.commands.registerCommand('dao.startServer', () => startServer(context)),
        vscode.commands.registerCommand('dao.stopServer', stopServer),
        vscode.commands.registerCommand('dao.showPort', showPort),
        vscode.commands.registerCommand('dao.showInfo', showWorkspaceInfo),
        vscode.commands.registerCommand('dao.copyConnection', copyConnection),
        vscode.commands.registerCommand('dao.regenerateToken', regenerateToken),
        // 全池反向注入核对 · 立即强制(绕签名守柔): 切号板块/主页板块可一键触发全账号核对注入
        vscode.commands.registerCommand('dao.reconcilePool', async () => {
            const r = await reconcileAccountPoolInject('manual', { force: true });
            try { vscode.window.showInformationMessage('全池反向注入核对: ' + r.okCount + '/' + r.total + (r.skipped ? ' (跳过)' : '')); } catch { /* 守柔 */ }
            return r;
        }),
        // 归一外壳 · 让多实例外壳内嵌「公网穿透」页直接读桥状态(不再弹独立面板)
        vscode.commands.registerCommand('dao.getBridgeState', () => {
            const c = readBridgeConn() || {};
            let extra: any = {};
            try { extra = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dao', 'bridge', 'connection.json'), 'utf8')) || {}; } catch { /* 守柔 */ }
            const url = c.url || extra.url || bridgeUrl || '';
            const token = ws.token || bridgeToken || extra.token || '';
            const port = c.port || extra.port || ws.port || 0;
            const host = c.host || (extra.workspace && extra.workspace.host) || '';
            const named = !!bridgeReadNamedToken();
            return {
                on: !!url, url, token, port, host,
                updated: c.updated || extra.startedAt || '',
                mode: extra.mode || (named ? 'named' : 'quick'),
                agentCount: extra.agents_online || extra.agentCount || 0,
                named, persistent: !bridgeUrl && !!url,
            };
        }),
        // 归一外壳 · 桥动作(复制接入信息/重启/停止/启动/刷新Token/导出MD)走全局命令, 外壳内即可触发
        vscode.commands.registerCommand('dao.bridgeAction', async (arg?: { cmd?: string }) => {
            const c = (arg && arg.cmd) || '';
            try {
                if (c === 'copyBridgeInfo') {
                    const cc = readBridgeConn() || {};
                    const url = cc.url || bridgeUrl || '';
                    const tok = ws.token || bridgeToken || '';
                    await vscode.env.clipboard.writeText(`公网URL: ${url}\nToken:   ${tok}\nAuth:    Authorization: Bearer ${tok}`);
                    vscode.window.showInformationMessage('Bridge 接入信息已复制 (URL + Token)');
                    return { ok: !!(url || tok) };
                }
                if (c === 'bridgeStart') {
                    const r = await bridgeStartTunnel(false);
                    if (r.ok) vscode.window.showInformationMessage('隧道已启动');
                    else vscode.window.showWarningMessage(r.reason === 'cloudflared-not-found'
                        ? '未找到 cloudflared：无法启动公网隧道。请装 cloudflared 到 PATH 或 ~/.dao/bin/，或改用命名隧道。'
                        : '公网隧道启动失败（cloudflared 无法运行）。');
                    return r;
                }
                if (c === 'bridgeStop') { bridgeStopTunnel(); vscode.window.showInformationMessage('隧道已停止'); return { ok: true }; }
                if (c === 'bridgeRestart') {
                    const wasNamed = !!bridgeReadNamedToken(); bridgeStopTunnel();
                    const r = await bridgeStartTunnel(wasNamed);
                    if (r.ok) vscode.window.showInformationMessage('隧道已重启');
                    else vscode.window.showWarningMessage(r.reason === 'cloudflared-not-found'
                        ? '未找到 cloudflared：无法重启公网隧道。请装 cloudflared 或改用命名隧道。'
                        : '公网隧道重启失败（cloudflared 无法运行）。');
                    return r;
                }
                if (c === 'bridgeRefreshToken') {
                    if (!bridgeUrl) { vscode.window.showWarningMessage('当前为常驻桥持久化连接 · Token 由常驻服务管理。请先「启动隧道」再刷新。'); return { ok: false }; }
                    // 帛书·「知常曰明」: 对外令牌恒等机器级恒稳源 ws.token(永不再漂)。
                    //   「刷新」即强制把权威令牌重新发布/扩散到所有账号(自愈漂移), 不再凭空铸新牌致脱钩。
                    bridgeToken = ws.token || bridgeToken;
                    bridgeSaveAuthToken(bridgeToken);
                    bridgeSaveConnJson();
                    try { bridgeWriteArtifacts(); } catch { /* 守柔 */ }
                    try { if (ws.devinAuth1 && ws.devinOrgId) await bridgeInjectKnowledge(); } catch { /* 守柔 */ }
                    bridgeScheduleReinject('tokenRefresh');
                    vscode.window.showInformationMessage('Bridge Token 已重新同步发布 (机器级恒稳·永不再漂)');
                    return { ok: true };
                }
                if (c === 'openBridgeMd') {
                    const md = bridgeGenerateCloudMd();
                    const mdPath = path.join(os.homedir(), '.dao', 'bridge', 'cloud-agent.md');
                    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
                    fs.writeFileSync(mdPath, md, 'utf8');
                    const doc = await vscode.workspace.openTextDocument(mdPath);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                    return { ok: true };
                }
            } catch (e: any) {
                vscode.window.showWarningMessage('桥动作失败: ' + (e && e.message ? e.message : String(e)));
                return { ok: false, err: String(e) };
            }
            return { ok: false, err: 'unknown cmd' };
        }),
        vscode.commands.registerCommand('dao.devinLogin', () => {
            vscode.window.showInputBox({ prompt: 'Devin Cloud Email', placeHolder: 'user@example.com' }).then(email => {
                if (!email) return;
                vscode.window.showInputBox({ prompt: 'Devin Cloud Password', password: true }).then(password => {
                    if (!password) return;
                    devinLogin(email, password).then(r => {
                        if (r.ok) { vscode.window.showInformationMessage('Devin login OK'); devinFullInject(); }
                        else vscode.window.showErrorMessage('Devin login failed: ' + (r.error || ''));
                    });
                });
            });
        }),
        vscode.commands.registerCommand('dao.devinInject', () => devinFullInject(true)),
        vscode.commands.registerCommand('dao.devinQuota', () => {
            if (!ws.devinApiKey) { vscode.window.showWarningMessage('Not logged into Devin Cloud'); return; }
            devinFetchQuota(ws.devinApiKey, ws.devinApiServerUrl).then(q => {
                ws.devinQuota = q; ws.devinSaveConfig();
                if (q) vscode.window.showInformationMessage('Quota: ' + (q.planName || '?') + ' D=' + (q.dailyQuotaRemainingPercent || 0) + '% W=' + (q.weeklyQuotaRemainingPercent || 0) + '%');
                else vscode.window.showErrorMessage('Quota fetch failed');
            });
        }),
        vscode.commands.registerCommand('dao.devinGitConnect', () => {
            if (!ws.devinAuth1 || !ws.devinOrgId) { vscode.window.showWarningMessage('Not logged into Devin Cloud'); return; }
            vscode.window.showInputBox({ prompt: 'GitHub Personal Access Token', placeHolder: 'ghp_...', password: true }).then((pat: string | undefined) => {
                if (!pat) return;
                devinConnectGitHub(ws.devinOrgId, pat, ws.devinAuth1).then(r => {
                    if (r.ok) vscode.window.showInformationMessage('GitHub PAT connected' + (r.existed ? ' (already existed)' : ''));
                    else vscode.window.showErrorMessage('GitHub PAT connect failed');
                });
            });
        }),
        vscode.commands.registerCommand('dao.devinSessionCreate', () => {
            if (!ws.devinAuth1 || !ws.devinOrgId) { vscode.window.showWarningMessage('Not logged into Devin Cloud'); return; }
            vscode.window.showInputBox({ prompt: 'Devin Session Message', placeHolder: 'What would you like Devin to do?' }).then((message: string | undefined) => {
                if (!message) return;
                devinCreateSession(ws.devinOrgId, message, ws.devinAuth1).then(r => {
                    if (r.ok) vscode.window.showInformationMessage('Session created: ' + (r.devinId || ''));
                    else vscode.window.showErrorMessage('Session create failed');
                });
            });
        }),
        vscode.commands.registerCommand('dao.devinLogout', () => {
            ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinOrgName = ''; ws.devinOrgSlug = '';
            ws.devinEmail = ''; ws.devinSessionToken = ''; ws.devinApiKey = ''; ws.devinApiServerUrl = '';
            ws.devinAccountId = ''; ws.devinQuota = null; ws.devinInjecting = false;
            ws.devinSaveConfig();
            cloudPanel?.refresh();
            refreshDaoCloudMiddlePanel();
            updateStatusBar();
            vscode.window.showInformationMessage('Devin Cloud logged out');
        }),
        // ═══════════════════════════════════════════════════════════
        // 双面板 · 帛书·四十一「反者道之动」
        // 面板A: 定制化注入 | 面板B: 官网全功能浏览器
        // Simple Browser 不受 X-Frame-Options 约束 → 完整体验
        // ═══════════════════════════════════════════════════════════
        vscode.commands.registerCommand('dao.openCloudPanel', () => showDaoCloudMiddlePanel(context)),
        vscode.commands.registerCommand('dao.toggleCloudPanel', () => toggleDaoCloudMiddlePanel(context)),
        // 归一入口: 底部 9921 按钮 → 弹出综合浏览器外壳(多实例单面板多窗口), 默认当前账号 Devin Cloud 主页;
        //   6 大板块 = 外壳左上角 ☰ 菜单页(经该账号反代加载真实网页)。rt-flow 不可用时回退老全功能面板。
        // 归一 · 深链直达某板块 (供深链/快捷键/外部调用直接打开六合外壳并切到指定板块)。
        vscode.commands.registerCommand('dao.openShellBoard', async (board?: string) => {
            await ensureRoutedServerFast(context);
            const int = (_rtflowModule && _rtflowModule._internals) as RtflowInternals | undefined;
            if (int && typeof int.openShellHome === 'function') { await int.openShellHome(typeof board === 'string' && board ? board : 'home'); }
            else { toggleDaoCloudMiddlePanel(context); }
        }),
        vscode.commands.registerCommand('dao.openUnifiedShell', async () => {
            await ensureRoutedServerFast(context);
            // 归一 · 冷启动落「六合板块主页」(home), 不再默认开账号 Devin 对话框(无意义空页)。
            //   已保存标签由序列化器还原(状态保留)。rt-flow 不可用时回退老全功能面板。
            const int = (_rtflowModule && _rtflowModule._internals) as RtflowInternals | undefined;
            if (int && typeof int.openShellHome === 'function') {
                const r = await int.openShellHome();
                if (!r || !r.ok) toggleDaoCloudMiddlePanel(context);
            } else {
                toggleDaoCloudMiddlePanel(context);
            }
        }),
        // 道法自然 · 右下角 RT Flow 按钮 → 打开全功能面板并直达「切号」模块(第2模块)。
        vscode.commands.registerCommand('dao.openSwitchModule', () => {
            showDaoCloudMiddlePanel(context);
            // 面板创建/显示后稍候, 令 webview 切到 switch 标签(亦兼容已打开的面板)。
            setTimeout(() => { try { daoCloudMiddlePanel?.webview.postMessage({ type: 'gotoTab', tab: 'switch' }); } catch { /* 守柔 */ } }, 350);
        }),
        vscode.commands.registerCommand('dao.devinCloudBrowser', () => {
            // 帛书·「天下之至柔驰骋于天下之致坚」— 反向代理自动注入认证
            // 通过本地反向代理路由官网 — 自动注入Cookie/Token，无需GUI登录
            if (!ws.port) {
                vscode.window.showWarningMessage('DAO 服务器未启动');
                return;
            }
            // 帛书·「执天之行」官网根挂载 — 经反代根路径(/)路由, SPA 客户端路由方能正确匹配
            // (/devin-cloud/ 前缀非 SPA 真实路由 → 404); 持 auth1 时经 localStorage 注入自动登录
            const proxyUrl = daoRoutedWebUrl('');
            try { vscode.commands.executeCommand('simpleBrowser.show', proxyUrl); }
            catch { vscode.env.openExternal(vscode.Uri.parse(proxyUrl)); }
        }),
        vscode.commands.registerCommand('dao.devinCloudPanel', () => {
            // 帛书·「天下之至柔驰骋于天下之致坚」— 反向代理自动注入认证
            const proxyUrl = daoRoutedWebUrl('');
            try { vscode.commands.executeCommand('simpleBrowser.show', proxyUrl); }
            catch { vscode.env.openExternal(vscode.Uri.parse(proxyUrl)); }
        }),
        // ★ 归一·E · 路由某账号官网 (手动·多实例)。rt-flow 账号行两按钮调此命令:
        //   mode 'ide' → IDE 内每账号独立 webview 标签 (多实例并行·不相悖);
        //   mode 'sys' → 系统默认浏览器独立 profile 窗口 (复用 launchIsolatedBrowser)。
        //   经反代 ?dao_acct=<email> 注入该账号 auth1 → 各窗口隔离登录, 无需全局切号。
        vscode.commands.registerCommand('dao.routeOfficialForAccount', async (arg?: { email?: string; mode?: string }) => {
            const email = (arg && arg.email || ws.devinEmail || '').trim();
            const mode = (arg && arg.mode) === 'sys' ? 'sys' : 'ide';
            await ensureRoutedServerFast(context);
            const url = daoRoutedWebUrlForAccount(email, '');
            if (mode === 'sys') {
                const ok = launchIsolatedBrowser(url, email || 'default');
                vscode.window.showInformationMessage(ok ? ('🌐 系统浏览器已路由官网: ' + (email || '当前账号')) : '浏览器启动失败');
            } else {
                const r = await tryRtflowMultiInstance({ email });
                if (!r || !r.ok) openRoutedAccountPanel(context, email, url);
            }
        }),
        // 近期对话 · 多实例打开「具体对话」: 路由该账号官网到 /sessions/<devinId> (独立 webview 标签·按 email+会话复用)。
        vscode.commands.registerCommand('dao.routeConvForAccount', async (arg?: { email?: string; devinId?: string; mode?: string }) => {
            const email = (arg && arg.email || ws.devinEmail || '').trim();
            const did = String((arg && arg.devinId) || '').trim();
            if (!did) { vscode.window.showWarningMessage('缺少对话 ID'); return; }
            const sid = did.replace(/^devin-/, '');
            const mode = (arg && arg.mode) === 'sys' ? 'sys' : 'ide';
            await ensureRoutedServerFast(context);
            const url = daoRoutedWebUrlForAccount(email, '/sessions/' + sid);
            if (mode === 'sys') {
                const ok = launchIsolatedBrowser(url, (email || 'default') + '·' + sid);
                vscode.window.showInformationMessage(ok ? ('🌐 系统浏览器已打开对话: ' + sid) : '浏览器启动失败');
            } else {
                const r = await tryRtflowMultiInstance({ email, devinId: sid });
                if (!r || !r.ok) openRoutedAccountPanel(context, email, url, sid);
            }
        }),
        vscode.commands.registerCommand('dao.openDashboard', () => {
            // 去芜存菁 · 不再有冗余侧栏容器; “全功能主页”统一由中间面板承载(状态栏 9921 按钮/本命令)
            showDaoCloudMiddlePanel(context);
        }),
        // 帛书·「道并行而不相悖」— 独立 webview 路由面板(多实例·不阻塞)
        vscode.commands.registerCommand('dao.openRoutedPanel', async () => {
            await ensureRoutedServerFast(context);
            const email = ws.devinEmail || '';
            // 帛书·守正出奇: 先走已验证可用的 rt-flow 多实例反代(中栏同源·无 X-Frame),
            //   打不通才回退 9920/?dao_acct 路由面板(官网带 X-Frame 限制·内嵌易空白)。
            const r = await tryRtflowMultiInstance({ email });
            if (!r || !r.ok) {
                const url = daoRoutedWebUrlForAccount(email, '');
                openRoutedAccountPanel(context, email, url);
            }
        }),
        // ═══════════════════════════════════════════════════════════
        // 统一认证 · Windsurf自动登录 — 帛书·六十二「道者万物之注」
        // Windsurf登录态 → 自动Devin Cloud登录
        // ═══════════════════════════════════════════════════════════
        vscode.commands.registerCommand('dao.devinWindsurfAutoLogin', async () => {
            const creds = readWindsurfCredentials();
            if (!creds || !creds.email) {
                vscode.window.showWarningMessage('未检测到 Windsurf 登录凭证，请先登录 Windsurf IDE');
                return;
            }
            vscode.window.showInformationMessage('检测到 Windsurf 凭证 (' + creds.source + ')，正在自动登录 Devin Cloud...');
            const ok = await devinAutoChain();
            if (ok) {
                vscode.window.showInformationMessage('Devin Cloud 自动登录成功');
                cloudPanel?.refresh();
                refreshDaoCloudMiddlePanel();
            } else {
                vscode.window.showErrorMessage('自动登录失败，Windsurf 凭证可能已过期，请手动登录');
            }
        }),
    );

    // ═══════════════════════════════════════════════════════════
    // 道并行而不相悖 · dao.cloudPanel 侧栏 provider。
    // 独立 dao-vsix 的 package.json 不声明该视图 → provider 永不解析(空操作),
    //   全功能主页仍由状态栏 / dao.toggleCloudPanel 在编辑区打开(去芜存菁不变)。
    // 归一 dao-one 的 package.json 声明 ②「全能版」视图 → provider 解析 → 侧栏内嵌全功能面板。
    // 故此注册对两种产物皆守柔: 不破坏 dao-vsix, 又修复 dao-one 的 ② 空白视图。
    // ═══════════════════════════════════════════════════════════
    try {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('dao.cloudPanel', cloudPanel),
        );
    } catch (e) {
        try { console.error('[dao-vsix] dao.cloudPanel provider 注册失败(守柔不阻塞):', e); } catch { /* 守柔 */ }
    }

    // Watch for terminal close to clean up
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(term => {
            const id = String(term.processId);
            ws.terminals.delete(id);
            ws.terminalOutputBuffers.delete(id);
        })
    );
}

function getDaoConfig() {
    const config = vscode.workspace.getConfiguration('dao');
    return {
        port: config.get<number>('port', DEFAULT_PORT),
        token: config.get<string>('token', ''),
        relayUrl: config.get<string>('relayUrl', ''),
        autoBridge: config.get<boolean>('autoBridge', true),
        githubPat: config.get<string>('githubPat', ''),
    };
}

// ═══════════════════════════════════════════════════════════
// 身 · Token — 自动生成持久化
// ═══════════════════════════════════════════════════════════
function checkAuth(req: any): boolean {
    const auth = req.headers?.['authorization'] || '';
    if (auth === `Bearer ${ws.token}`) return true;
    // 内穿令牌(可刷新)也放行 — 刷新时旧 ws.token 仍有效, 故换牌不断链(帛书「夫唯不争·故无尤」)
    if (bridgeToken && auth === `Bearer ${bridgeToken}`) return true;
    // v3.50.65 · 机器级权威令牌(dao-conn-current.json / ~/.dao/api-token)亦放行 —— 正本清源。
    //   本源认知: 公网隧道发布的、路线C mesh 注入的(sigServeFrame 强置 authorization=bridgeAuthoritativeToken)、
    //   反向注入进知识库供云端读取的, 恒为「机器级恒稳」权威令牌 bridgeAuthoritativeToken()(见其注释 5234-5242
    //   自述「两令牌 checkAuth 皆放行」)。但带工作区的窗口实例 ws.token 是其自身工作区私牌, 与机器级权威令牌脱钩,
    //   而 checkAuth 旧法仅认 ws.token/bridgeToken → 该实例经 mesh/公网被访问时, 注入的权威令牌反被自己判 401
    //   (实测 3.50.64: route-C /api/exec·/api/workspace 全 unauthorized, 仅免鉴权 /api/health·/shell 可达,
    //    正是 3.50.51 声称已修的「兜底通道操作不了机器」缺口在多实例·私牌场景下的残留)。故此处补上权威令牌放行,
    //   令代码自身注释的不变式真正成立: 机器级权威令牌与本窗口 ws.token 皆放行, 换牌/多实例不断链。
    const machineTok = bridgeAuthoritativeToken();
    if (machineTok && auth === `Bearer ${machineTok}`) return true;
    // 帛书·「得一」单一令牌权威 — 反向注入恒发布「本实例可达端点 + 机器级权威令牌(dao-conn-current.json)」
    //   同源一对(见 bridgeEffectiveUrl/bridgeEffectiveToken)。故此处只认「本窗口私牌 ∪ 内穿令牌 ∪ 机器权威牌」。
    //   切勿放行「他者进程(独立 dao-bridge 扩展)写入共享文件的令牌」: 它与本可达端点真验源不同域,
    //   且该桥恒写 url=""(从不发布可达 URL)→ 从不会成为被注入的 URL → 放行其令牌只会引入错域令牌
    //   (实测共享文件同时并存 e40b6/a3f46/4092e0 多枚互异令牌)→ 云端按库读到的令牌打可达端点必 401。
    //   令牌与地址恒同源成对, 方为「一枚令牌贯通全 /api 面」之本(而非广收百家令牌)。
    const url = new URL(req.url || '/', `http://localhost:${ws.port}`);
    if (url.searchParams.get('master_token') === ws.token) return true;
    if (bridgeToken && url.searchParams.get('master_token') === bridgeToken) return true;
    if (machineTok && url.searchParams.get('master_token') === machineTok) return true;
    // Local loopback exempt for read-only endpoints; relay/public must carry token
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        const roPaths = ['/api/health', '/api/workspace', '/api/agents', '/devin-cloud/', '/devin-cloud-ws/', '/devin-cloud-ws-register/', '/devin-cloud-ws-cdn/', '/devin-cloud-ws-ss/'];
        if (roPaths.some(p => url.pathname.startsWith(p))) return true;
    }
    return false;
}

// 道·「无有入于无间」— 主端口 WS 升级反代: 令多窗口 Devin 网页的实时会话事件通道(SPA 同源 WS)
//   随网页存活穿透隧道到官方上游, 根治「多开/多窗口断联·发不出·没回应·须重连」。仅放行 Devin 系上游
//   (无任意 TCP 中继面·杜绝 SSRF)。token 已内嵌于 WS URL query(getAccessToken 返本账号令牌·多号各正确)。
function daoWsUpstreamFor(route: string, search: string): { host: string; port: number; path: string } | null {
    const q = search || '';
    const m = (host: string, p: string) => ({ host, port: 443, path: p + q });
    if (route.startsWith('/devin-cloud-api/')) return m('api.devin.ai', route.slice('/devin-cloud-api'.length));
    if (route.startsWith('/devin-cloud-backend/')) return m('backend.webapp.devin.ai', route.slice('/devin-cloud-backend'.length));
    if (route.startsWith('/devin-cloud-ws-register/')) return m('register.windsurf.com', route.slice('/devin-cloud-ws-register'.length));
    if (route.startsWith('/devin-cloud-ws-cdn/')) return m('server.codeium.com', route.slice('/devin-cloud-ws-cdn'.length));
    if (route.startsWith('/devin-cloud-ws-ss/')) return m('server.self-serve.windsurf.com', route.slice('/devin-cloud-ws-ss'.length));
    if (route.startsWith('/devin-cloud-ws/')) return m('windsurf.com', route.slice('/devin-cloud-ws'.length));
    if (route.startsWith('/devin-cloud/')) return m('app.devin.ai', route.slice('/devin-cloud'.length));
    // 官网同源根挂载: /api/events/<id>/live 等 SPA 同源 WS(window.location.origin) → app.devin.ai
    if (isAppProxyPassthrough(route)) return m('app.devin.ai', route);
    return null;
}
function daoProxyWsUpgrade(req: any, clientSocket: any, head: any, up: { host: string; port: number; path: string }, url: URL): void {
    let done = false, connected = false;
    const bail = () => { if (done) return; done = true; try { clientSocket.destroy(); } catch (e) { /* 守柔 */ } };
    clientSocket.on('error', bail);
    try { clientSocket.setNoDelay(true); } catch (e) { /* 守柔 */ }
    try { clientSocket.setTimeout(0); } catch (e) { /* 守柔 */ }
    const onUpstream = (upstream: any) => {
        connected = true;
        const h = req.headers || {};
        const qToken = url.searchParams.get('token') || '';
        const qOrg = url.searchParams.get('org_id') || '';
        const a1 = qToken || ws.devinAuth1 || '';
        const org = qOrg || ws.devinOrgId || '';
        const lines = [
            'GET ' + up.path + ' HTTP/1.1',
            'Host: ' + up.host,
            'Connection: Upgrade',
            'Upgrade: ' + (h['upgrade'] || 'websocket'),
            'Sec-WebSocket-Version: ' + (h['sec-websocket-version'] || '13'),
        ];
        if (h['sec-websocket-key']) lines.push('Sec-WebSocket-Key: ' + h['sec-websocket-key']);
        if (h['sec-websocket-protocol']) lines.push('Sec-WebSocket-Protocol: ' + h['sec-websocket-protocol']);
        if (h['sec-websocket-extensions']) lines.push('Sec-WebSocket-Extensions: ' + h['sec-websocket-extensions']);
        lines.push('Origin: https://' + up.host);
        lines.push('User-Agent: ' + DEVIN_UA);
        if (a1) {
            lines.push('Authorization: Bearer ' + a1);
            if (org) lines.push('x-cog-org-id: ' + org);
            const ck = ['auth1_token=' + a1];
            if (org) ck.push('org_id=' + org);
            lines.push('Cookie: ' + ck.join('; '));
        }
        lines.push('', '');
        try { upstream.write(lines.join('\r\n')); } catch (e) { bail(); return; }
        if (head && head.length) { try { upstream.write(head); } catch (e) { /* 守柔 */ } }
        // 裸字节双向管道: 上游 101 握手回放 + 之后所有帧透传(不解析·不改写)
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        upstream.on('error', bail);
        upstream.on('close', bail);
        clientSocket.on('close', () => { try { upstream.destroy(); } catch (e) { /* 守柔 */ } });
    };
    // 直连优先(app.devin.ai 未被墙·最快); 失败经本机代理(Clash)CONNECT 兜底 — 与 devinCloudProxyRoute 同策
    const direct = tls.connect({ host: up.host, port: up.port || 443, servername: up.host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] } as any, () => onUpstream(direct));
    direct.once('error', () => {
        if (connected) return;
        if (detectedProxyPort > 0) {
            const raw = net.connect(detectedProxyPort, '127.0.0.1', () => {
                try { raw.write('CONNECT ' + up.host + ':443 HTTP/1.1\r\nHost: ' + up.host + ':443\r\n\r\n'); } catch (e) { bail(); }
            });
            let buf = Buffer.alloc(0);
            const onData = (d: Buffer) => {
                buf = Buffer.concat([buf, d]);
                const i = buf.indexOf('\r\n\r\n');
                if (i < 0) return;
                raw.removeListener('data', onData);
                const status = buf.slice(0, i).toString('utf8').split('\r\n')[0];
                if (!/ 200 /.test(status)) { try { raw.destroy(); } catch (e) { /* 守柔 */ } bail(); return; }
                const tsock = tls.connect({ socket: raw, servername: up.host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] } as any, () => onUpstream(tsock));
                tsock.once('error', bail);
            };
            raw.on('data', onData);
            raw.on('error', bail);
        } else {
            bail();
        }
    });
}

async function startServer(context: vscode.ExtensionContext) {
    if (ws.server) {
        vscode.window.showWarningMessage('Dao server already running');
        return;
    }

    const cfg = getDaoConfig();
    const basePort = cfg.port;
    ws.port = await findAvailablePort(basePort);
    ws.token = ws.getOrCreateToken();
    ws.startTime = Date.now();

    ws.server = http.createServer(async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url = new URL(req.url || '/', `http://localhost:${ws.port}`);
        const route = url.pathname;

        try {
            const result = await handleRouteInternal(route, url, req, ws.token, res);
            // 道·「天下之至柔驰骋于天下之致坚」— SSE 流式直通: 代理已边到边写入 res, 此处直接收束
            if (result && result._streamed) {
                return;
            }
            // 双面板代理路由 — 返回原始HTML/JS/binary，不是JSON
            if (result && result._proxy) {
                const headers: Record<string, string> = {};
                // 从代理响应中提取安全头（已剥离X-Frame-Options等）
                if (result.headers) {
                    for (const [k, v] of Object.entries(result.headers as Record<string, string | string[]>)) {
                        const kl = k.toLowerCase();
                        // 逐跳头(hop-by-hop)不可跨代理转发: chunked/连接控制原样回放令 webview 每资产强拆 TCP
                        if (kl === 'transfer-encoding' || kl === 'connection' || kl === 'keep-alive' || kl === 'proxy-connection' || kl === 'te' || kl === 'trailer' || kl === 'upgrade') continue;
                        headers[k] = Array.isArray(v) ? v.join(', ') : v;
                    }
                }
                headers['Connection'] = 'keep-alive';
                // 帛书·令 Node 协议层兑现 keep-alive: req.shouldKeepAlive=false 时会强制回 Connection: close
                //   覆盖显式响应头, 故落 writeHead 前主动拨真, 令 socket 跨资产复用(根治隧道路重握手税)。
                try { (res as any).shouldKeepAlive = true; } catch {}
                // 处理3xx重定向
                if (result.status && result.status >= 300 && result.status < 400) {
                    res.writeHead(result.status, headers);
                    res.end();
                    return;
                }
                headers['Content-Type'] = result.contentType || 'text/html';
                // 缺陷6修复: 不设置X-Frame-Options — 代理层已剥离上游的X-Frame-Options
                // 省略该头 = 允许任何origin嵌入iframe
                res.writeHead(result.status || 200, headers);
                if (result.binary) {
                    res.end(Buffer.from(result.body, 'base64'));
                } else {
                    res.end(result.body, 'utf8');
                }
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result, null, 2));
        } catch (err: any) {
            if (err.message === 'unauthorized') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
            } else if (err.message === 'not found') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not found', available: [
                    '/api/health', '/api/connection', '/api/workspace', '/api/exec', '/api/command',
                    '/api/file', '/api/write', '/api/search', '/api/edit',
                    '/api/ls', '/api/terminal/create', '/api/terminal/send',
                    '/api/diagnostics', '/api/definitions', '/api/references',
                    '/api/symbols', '/api/git/status', '/api/agents',
                    '/api/commands', '/api/tools',
                    '/devin-cloud/*', '/api/devin/*'
                ]}));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || String(err) }));
            }
        }
    });

    // 帛书·「无有入于无间」— 注册 WS 升级反代: 令 Devin 实时会话事件通道随网页存活(根治多窗口断联)
    ws.server.on('upgrade', (req: any, clientSocket: any, head: any) => {
        try {
            const uurl = new URL(req.url || '/', `http://localhost:${ws.port}`);
            const up = daoWsUpstreamFor(uurl.pathname, uurl.search || '');
            if (!up) {
                // 非 Devin 上游 → 拒绝(防被用作任意 TCP 中继·无 SSRF 面)
                try { clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); clientSocket.destroy(); } catch (e) { /* 守柔 */ }
                return;
            }
            daoProxyWsUpgrade(req, clientSocket, head, up, uurl);
        } catch (e) {
            try { clientSocket.destroy(); } catch (e2) { /* 守柔 */ }
        }
    });

    ws.server.listen(ws.port, () => {
        updateStatusBar();
        vscode.window.showInformationMessage(`Dao server started on :${ws.port}`);
        registerInstance(ws.port);
    updateWorkspaceRegistry();
        ws.saveConnection();
        // 归一·全功能公网可达: 向常驻桥(dao-bridge)公布本体全功能 API 端口/令牌,
        //   令桥把 /shell 六大板块 + /api/devin/* + /api/tools 等非桥自有路由透明反代到此处,
        //   一条耐用隧道即暴露二合一插件全部底层(单网页公网操作全功能)。
        bridgePublishPluginApi();
        // 桥: 自动建桥 — 出站WebSocket绕过NAT
        if (cfg.autoBridge) {
            connectRelay(ws.port, ws.token);
        }
        // 去中心化信令中继(路线C·零中心 ntfy): 与 cloudflared/Worker 并行的第二条公网入口, 任一 broker 活即可达
        sigStart().catch(() => {});
        // 公网同源资源图预热: 服务一就绪即后台并行抓全 SPA 模块图入 ~/.dao/asset-cache (L1+L2),
        //   令首个公网设备即命中宿主暖缓存·隧道只剩动态核心 (与 devin_proxy 多实例预热同理)。
        //   fire-and-forget·不阻服务监听; 失败守柔。
        setImmediate(() => { _prewarmCloudGraph(ws.token).catch(() => {}); });
    });

    context.subscriptions.push({ dispose: () => stopServer() });
}

function stopServer() {
    stopRelay();
    sigStop();
    if (ws.server) {
        ws.server.close();
        ws.server = null;
    }
    ws.port = 0;
    unregisterInstance();
    updateStatusBar();
    vscode.window.showInformationMessage('Dao server stopped');
}

function showPort() {
    if (ws.port) {
        vscode.window.showInformationMessage(`Dao server: http://localhost:${ws.port}` + (ws.publicUrl ? ' | Relay: ' + ws.publicUrl : ''));
    } else {
        vscode.window.showWarningMessage('Dao server not running');
    }
}

function showWorkspaceInfo() {
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
    const msg = `Port: ${ws.port}\nWorkspace: ${folders.join(', ')}\nPID: ${process.pid}\nRelay: ${ws.relayConnected ? ws.publicUrl : 'local only'}`;
    vscode.window.showInformationMessage(msg, { modal: true });
}

function copyConnection() {
    const url = ws.publicUrl || (ws.port ? 'http://localhost:' + ws.port : '');
    const token = ws.token;
    if (!url) { vscode.window.showWarningMessage('Server not running'); return; }
    vscode.env.clipboard.writeText(JSON.stringify({ url, token }, null, 2));
    vscode.window.showInformationMessage('Connection info copied');
}

function regenerateToken() {
    ws.token = 'dao-vsix-' + crypto.randomBytes(16).toString('hex');
    ws.saveState();
    ws.saveConnection();
    updateStatusBar();
    vscode.window.showInformationMessage('Token regenerated');
}

function updateStatusBar() {
    if (ws.port) {
        const devinIcon = ws.devinAuth1 ? ' ☁️' : '';
        const panelIcon = daoCloudMiddlePanelVisible ? ' 🤖' : '';
        statusBarItem.text = `$(radio-tower) Dao:${ws.port}${devinIcon}${panelIcon}`;
        statusBarItem.tooltip = 'Dao Workspace Server' + (ws.publicUrl ? '\nRelay: ' + ws.publicUrl : '') + '\nToken: ' + ws.token.substring(0, 16) + '...' + (ws.devinAuth1 ? '\nDevin Cloud: ✓ ' + (ws.devinEmail || '') : '\nDevin Cloud: ✗') + '\n\nClick to toggle Devin Cloud Panel';
        statusBarItem.show();
    } else {
        statusBarItem.text = '$(circle-slash) Dao:off';
        statusBarItem.tooltip = 'Dao server not running';
        statusBarItem.show();
    }
}

async function findAvailablePort(base: number): Promise<number> {
    const net = await import('net');
    for (let p = base; p < base + 20; p++) {
        const available = await new Promise<boolean>((resolve) => {
            const s = net.createServer();
            s.listen(p, () => { s.close(() => resolve(true)); });
            s.on('error', () => { resolve(false); });
        });
        if (available) return p;
    }
    return base;
}

function readBody(req: any): Promise<string> {
    // 中继请求：body已在_relayBody中
    if (req._relayBody !== undefined) return Promise.resolve(req._relayBody);
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// 道·守全字节: 站内网页反代转发 POST/PUT 等请求体须保二进制原样(表单/文件/JSON 皆可),
//   故收原始 Buffer(不经 utf8 串拼接失真)。中继请求体为 base64 字符串 → 解回 Buffer。
function readBodyBuffer(req: any): Promise<Buffer> {
    if (req._relayBody !== undefined) {
        try { return Promise.resolve(Buffer.from(String(req._relayBody || ''), 'utf8')); } catch (e) { return Promise.resolve(Buffer.alloc(0)); }
    }
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(Buffer.concat(chunks)));
    });
}

// 终端捕获命令构造: 子shell分组 + 完成哨兵。
//   根因(已修): 旧式 `${cmd} > file 2>&1` 的重定向只绑定 cmd 中「最后一条」子命令,
//   `a; b; c` 仅 c 落文件、a/b 散逸终端丢失 → 多行/复合命令输出被截成最后一段。
//   修法: `( cmd ; echo MARK ) > file 2>&1` 统一捕获全部输出(bash/zsh/PowerShell·Win 默认终端通行),
//   并以 MARK 哨兵标识「命令真完成」→ 读端等到哨兵再返回(杜绝边写边读截断 + 空输出误判超时)。
function daoExecCaptureCmd(cmd: string, tmpFile: string, marker: string): string {
    return `( ${cmd} ; echo ${marker} ) > "${tmpFile}" 2>&1`;
}
async function waitForExecOutput(filePath: string, marker: string, timeoutMs: number): Promise<{ output: string; done: boolean }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const idx = content.lastIndexOf(marker);
            if (idx >= 0) {
                let out = content.slice(0, idx);
                if (out.endsWith('\r\n')) out = out.slice(0, -2);
                else if (out.endsWith('\n')) out = out.slice(0, -1);
                return { output: out, done: true };
            }
        } catch { /* 文件尚未生成 */ }
        await new Promise(r => setTimeout(r, 150));
    }
    // 超时: 尽力返回已捕获部分(不谎报完成)
    let partial = '';
    try { partial = fs.readFileSync(filePath, 'utf8'); } catch { /* 守柔 */ }
    return { output: partial || '[timeout waiting for output]', done: false };
}
function daoExecMarker(): string { return `__DAO_DONE_${Math.random().toString(36).slice(2, 10)}__`; }

async function executeTool(tool: string, args: any): Promise<any> {
    switch (tool) {
        case 'list_dir': {
            const dirPath = args.path || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
            return entries.map(([name, type]) => ({ name, type: vscode.FileType[type] }));
        }
        case 'read_file': {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(args.path));
            return Buffer.from(data).toString('utf8');
        }
        case 'write_to_file': {
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(vscode.Uri.file(args.path), encoder.encode(args.content));
            return { ok: true };
        }
        case 'edit': {
            const doc = await vscode.workspace.openTextDocument(args.file_path);
            const wsEdit = new vscode.WorkspaceEdit();
            wsEdit.replace(doc.uri,
                new vscode.Range(new vscode.Position(0, 0), new vscode.Position(999999, 999999)),
                args.new_string
            );
            await vscode.workspace.applyEdit(wsEdit);
            return { ok: true };
        }
        case 'find_by_name': {
            const files = await vscode.workspace.findFiles(args.pattern || '**/*', args.exclude, args.maxResults || 50);
            return files.map(f => f.fsPath);
        }
        case 'grep_search': {
            // Use VS Code's built-in search
            const results = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', args.query || '');
            return results || [];
        }
        case 'run_command': {
            const term = vscode.window.createTerminal('dao-tool');
            term.show(false);
            const tmpFile = path.join(os.tmpdir(), `dao-tool-${Date.now()}.txt`);
            const marker = daoExecMarker();
            term.sendText(daoExecCaptureCmd(args.command, tmpFile, marker));
            const r = await waitForExecOutput(tmpFile, marker, 30000);
            try { fs.unlinkSync(tmpFile); } catch {}
            setTimeout(() => term.dispose(), 1000);
            return { output: r.output };
        }
        default:
            return { error: `unknown tool: ${tool}` };
    }
}

function registerInstance(port: number) {
    let instances: any[] = [];
    try {
        instances = JSON.parse(fs.readFileSync(INST_FILE, 'utf8'));
    } catch {}
    instances = instances.filter(i => i.pid !== process.pid);
    instances.push({
        port,
        pid: process.pid,
        workspaceKey: ws.workspaceKey,
        workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        workspace: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [],
        hostname: os.hostname(),
        publicUrl: ws.publicUrl,
        devinEmail: ws.devinEmail || '',
        devinOrgId: ws.devinOrgId || '',
        devinOrgName: ws.devinOrgName || '',
        startedAt: new Date().toISOString()
    });
    try {
        fs.mkdirSync(DAO_DIR, { recursive: true });
        fs.writeFileSync(INST_FILE, JSON.stringify(instances, null, 2));
    } catch {}
}

function unregisterInstance() {
    let instances: any[] = [];
    try {
        instances = JSON.parse(fs.readFileSync(INST_FILE, 'utf8'));
    } catch {}
    instances = instances.filter(i => i.pid !== process.pid);
    try {
        fs.writeFileSync(INST_FILE, JSON.stringify(instances, null, 2));
    } catch {}
}

function unregisterConnection() {
    // 帛书·三十九「致数与无与」— 窗口关闭时从全局注册表移除
    const globalConnFile = path.join(DAO_DIR, 'dao-conn.json');
    try {
        let allConns: any[] = JSON.parse(fs.readFileSync(globalConnFile, 'utf8'));
        if (!Array.isArray(allConns)) allConns = [];
        allConns = allConns.filter((c: any) => c.pid !== process.pid);
        fs.writeFileSync(globalConnFile, JSON.stringify(allConns, null, 2), 'utf8');
    } catch {}
}

// ═══════════════════════════════════════════════════════════
// 注册表 · 帛书·五十二「见小曰明·守柔曰强」— workspace→账号映射
// 外部插件(账号管理)可读取此注册表建立窗口→账号关系
// ═══════════════════════════════════════════════════════════
function updateWorkspaceRegistry(): any {
    const registryFile = path.join(DAO_DIR, 'dao-workspaces.json');
    let entries: any[] = [];
    try { entries = JSON.parse(fs.readFileSync(registryFile, 'utf8')); if (!Array.isArray(entries)) entries = []; } catch {}
    // 更新当前窗口的条目
    const myEntry = {
        workspaceKey: ws.workspaceKey,
        workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        pid: process.pid,
        port: ws.port,
        publicUrl: ws.publicUrl,
        devinEmail: ws.devinEmail || '',
        devinOrgId: ws.devinOrgId || '',
        devinOrgName: ws.devinOrgName || '',
        relayConnected: ws.relayConnected,
        updatedAt: new Date().toISOString()
    };
    entries = entries.filter((e: any) => e.pid !== process.pid);
    entries.push(myEntry);
    try { fs.writeFileSync(registryFile, JSON.stringify(entries, null, 2), 'utf8'); } catch {}
    return { ok: true, workspaces: entries, count: entries.length };
}

function unregisterWorkspace() {
    const registryFile = path.join(DAO_DIR, 'dao-workspaces.json');
    try {
        let entries: any[] = [];
        try { entries = JSON.parse(fs.readFileSync(registryFile, 'utf8')); if (!Array.isArray(entries)) entries = []; } catch {}
        entries = entries.filter((e: any) => e.pid !== process.pid);
        fs.writeFileSync(registryFile, JSON.stringify(entries, null, 2), 'utf8');
    } catch {}
}

export function deactivate() {
    try { if (_rtflowModule && typeof _rtflowModule.deactivate === 'function') _rtflowModule.deactivate(); } catch { /* 守柔 */ }
    stopCredentialSync();
    stopServer();
    unregisterInstance();
    unregisterConnection();
    unregisterWorkspace();
}

// ═══════════════════════════════════════════════════════════
// 桥 · Relay — 出站WebSocket绕NAT
// 反者道之动: 出站连接不需要端口映射，不需要隧道工具
// 天下之至柔驰骋於天下之致坚
// ═══════════════════════════════════════════════════════════

function getRelayConfig(): { urls: string[] } {
    const cfg = getDaoConfig();
    if (cfg.relayUrl) {
        return { urls: cfg.relayUrl.split(',').map((u: string) => u.trim()).filter(Boolean) };
    }
    try {
        const f = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (f.relayUrl) return { urls: f.relayUrl.split(',').map((u: string) => u.trim()).filter(Boolean) };
        if (f.relayUrls?.length) return { urls: f.relayUrls };
    } catch {}
    // 道法自然：无中继配置 → 返回空，仅本地运行
    return { urls: [] };
}

function connectRelay(port: number, token: string) {
    if (ws.relayConnected || ws.relayConnecting) return;
    ws.relayConnecting = true;
    const relayCfg = getRelayConfig();
    const urls = relayCfg.urls;
    if (urls.length === 0) {
        ws.relayConnecting = false;
        // 道法自然：无中继URL → 提示用户使用 DAO Bridge 插件
        return;
    }
    const sessionId = ws.getOrCreateSessionId();
    let tryIndex = 0;
    function tryNext() {
        if (tryIndex >= urls.length) {
            ws.relayConnecting = false;
            if (!ws.relayReconnectTimer) {
                ws.relayReconnectTimer = setTimeout(() => {
                    ws.relayReconnectTimer = null;
                    if (!ws.relayConnected) connectRelay(port, token);
                }, 10000);
            }
            return;
        }
        const relayUrl = urls[tryIndex++];
        let wsUrl = relayUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        if (!wsUrl.endsWith('/connect')) wsUrl = wsUrl.replace(/\/$/, '') + '/connect';
        wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'session=' + sessionId + '&port=' + port + '&token=' + token;
        connectSingleRelay(wsUrl, relayUrl, sessionId, port, token, tryNext);
    }
    tryNext();
}

function connectSingleRelay(wsUrl: string, relayUrl: string, sessionId: string, port: number, token: string, onFail: () => void) {
    try {
        // 动态require ws — VSIX bundle可能不包含
        const WebSocket = require('ws');
        const relayHostname = new URL(relayUrl).hostname;
        const isCfHost = relayHostname.includes('workers.dev') || relayHostname.includes('cloudflare');
        // 直连兜底: 每实例独立出站连自己的 relay session (鸡犬相闻·老死不相往来)
        // 反者道之动: 不再「无代理即放弃」——本机出网通(cloudflared 隧道已可达 CF), 故直连必通。
        const tryDirect = () => {
            try {
                const socket = new WebSocket(wsUrl);
                setupRelayHandlers(socket, relayUrl, sessionId, port, token, onFail);
            } catch { onFail(); }
        };
        // workers.dev/cloudflare: 优先用本地代理(为 DNS 污染网络兜底), 但无代理/代理失败 → 直连, 绝不空手而归
        if (isCfHost) {
            const proxyPort = detectedProxyPort || detectProxyPort();
            if (!proxyPort) { tryDirect(); return; }
            createProxyTunnel(relayHostname).then((tlsSocket) => {
                if (tlsSocket) {
                    const socket = new WebSocket(wsUrl, { createConnection: () => tlsSocket });
                    setupRelayHandlers(socket, relayUrl, sessionId, port, token, onFail);
                } else {
                    tryDirect();
                }
            }).catch(() => tryDirect());
        } else {
            tryDirect();
        }
    } catch {
        onFail();
    }
}

function setupRelayHandlers(relaySocket: any, relayUrl: string, sessionId: string, port: number, token: string, onFail: () => void) {
    let pingInterval: any = null;
    let monitorInterval: any = null;
    let lastPongTime = Date.now();
    let closeHandled = false;

    relaySocket.on('open', () => {
        ws.relayConnected = true;
        ws.relayConnecting = false;
        ws.relayWs = relaySocket;
        lastPongTime = Date.now();
        const relayPublicUrl = relayUrl.replace(/\/$/, '') + '/relay/' + sessionId;
        ws.publicUrl = relayPublicUrl;
        ws.saveConnection();
        updateStatusBar();
        vscode.window.showInformationMessage(`Dao bridge connected: ${relayPublicUrl}`);

        pingInterval = setInterval(() => {
            try { relaySocket.send(JSON.stringify({ type: 'ping' })); } catch {}
        }, 10000);

        monitorInterval = setInterval(() => {
            if (relaySocket !== ws.relayWs) { clearInterval(pingInterval); clearInterval(monitorInterval); return; }
            if ((Date.now() - lastPongTime) / 1000 > 60) {
                clearInterval(pingInterval); clearInterval(monitorInterval);
                relaySocket.terminate();
            }
        }, 10000);
    });

    relaySocket.on('message', (data: Buffer) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'pong') { lastPongTime = Date.now(); return; }
            if (msg.type === 'request' && msg.id) {
                handleRelayRequest(msg, relaySocket, port, token);
            }
        } catch {}
    });

    relaySocket.on('close', (code: number) => {
        if (closeHandled) return;
        closeHandled = true;
        const isCurrent = (relaySocket === ws.relayWs);
        if (!isCurrent) return;
        ws.relayConnected = false;
        ws.relayConnecting = false;
        ws.relayWs = null;
        if (pingInterval) clearInterval(pingInterval);
        if (monitorInterval) clearInterval(monitorInterval);
        ws.publicUrl = null;
        ws.saveConnection();
        updateStatusBar();
        if (code !== 1000 && !ws.relayReconnectTimer) {
            ws.relayReconnectTimer = setTimeout(() => {
                ws.relayReconnectTimer = null;
                if (!ws.relayConnected) connectRelay(port, token);
            }, 3000);
        }
    });

    relaySocket.on('error', () => {
        if (closeHandled) return;
        onFail();
    });
}

async function handleRelayRequest(msg: any, relaySocket: any, port: number, token: string) {
    try {
        const fakeReq: any = {
            headers: msg.headers || {},
            method: msg.method || 'GET',
            socket: { remoteAddress: 'relay' },
            url: msg.path || '/api/health',
            _relayBody: msg.body || ''
        };
        const parsedUrl = new URL(msg.path || '/api/health', 'http://localhost:' + port);
        const route = parsedUrl.pathname;
        // 复用已有的路由逻辑
        const result = await handleRouteInternal(route, parsedUrl, fakeReq, token);
        relaySocket.send(JSON.stringify({ type: 'response', id: msg.id, status: 200, body: result }));
    } catch (err: any) {
        relaySocket.send(JSON.stringify({ type: 'response', id: msg.id, status: 500, body: { error: err.message } }));
    }
}

function stopRelay() {
    if (ws.relayWs) { try { ws.relayWs.close(); } catch {} ws.relayWs = null; }
    ws.relayConnected = false;
    ws.relayConnecting = false;
    ws.publicUrl = null;
    if (ws.relayReconnectTimer) { clearTimeout(ws.relayReconnectTimer); ws.relayReconnectTimer = null; }
}

// ═══════════════════════════════════════════════════════════
// 道 · 去中心化信令中继 (路线C·零账号·零中心 ntfy mesh) — 取自手机版 engine/signal.js
//   公网穿透「底层」彻底不依赖 cloudflared 隧道, 也不依赖 dao-relay Worker:
//   借多家互不隶属的公共 ntfy pub/sub 做加密信令/中继, 任一 broker 可达即通 → 去中心化、无单点。
//   定址: topic = H("topic\n"+session)(不泄露 session); 鉴权即加密: 载荷以 H(session+token)
//   派生的 AES-256-GCM 封装, 应答方解密成功(=对端确知 token) 才服务 → token 即准入门禁,
//   公共 broker 全程只见密文。控制面 RPC 帧 {path,method,body} 与 Worker 中继同构 →
//   复用 handleRouteInternal 同一处理路径。与 signal.js 字节级兼容(WebCrypto AES-GCM = iv||ct||tag)。
// ═══════════════════════════════════════════════════════════
const SIG_DEFAULT_SERVERS = ['https://ntfy.sh', 'https://ntfy.envs.net', 'https://ntfy.adminforge.de', 'https://ntfy.mzte.de'];
const SIG_CHUNK = 1200;            // ntfy 单消息 ~4KB 上限, 留足余量
const SIG_REASM_TTL_MS = 120000;   // 分片重组缓存寿命
const SIG_DEDUP_MAX = 512;         // 已处理 corr LRU 容量(多 broker 去重)
const SIG_BACKOFF_MIN = 1500;
const SIG_BACKOFF_MAX = 20000;
const SIG_HALFOPEN_MS = 90000;     // >90s 无任何入站(连 ntfy keepalive 都收不到) 即判半开死链 → 主动重连
const SIG_WATCHDOG_MS = 20000;     // 看门狗巡检周期

interface SigState {
    enabled: boolean; session: string; topic: string; servers: string[];
    key: Buffer | null; subs: any[]; reasm: ((msg: string, cb: (c: string, r: string, full: string) => void) => void) | null;
    handled: string[]; lastRxTs: number; lastTxTs: number; reqCount: number; warm: string[]; stopping: boolean;
}
const sigState: SigState = {
    enabled: false, session: '', topic: '', servers: [], key: null, subs: [], reasm: null,
    handled: [], lastRxTs: 0, lastTxTs: 0, reqCount: 0, warm: [], stopping: false,
};

function sigSha256(s: string): Buffer { return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest(); }
function sigSessionId(): string {
    const tok = bridgeAuthoritativeToken();
    return 'rtflow-' + crypto.createHash('sha256').update('dao-sig-session\n' + tok).digest('hex').slice(0, 16);
}
function sigTopicFor(session: string): string {
    const b = sigSha256('topic\n' + String(session));
    let s = ''; for (let i = 0; i < 12; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return 'dao' + s;
}
function sigDeriveKey(session: string, token: string): Buffer {
    return sigSha256(String(session) + '\n' + String(token) + '\ndao-sig');
}
function sigSeal(key: Buffer, obj: any): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    const tag = c.getAuthTag();
    return Buffer.concat([iv, ct, tag]).toString('base64'); // iv(12)||ct||tag(16) == WebCrypto 布局
}
function sigUnseal(key: Buffer, b64: string): any {
    try {
        const raw = Buffer.from(b64, 'base64');
        if (raw.length < 12 + 16) return null;
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(raw.length - 16);
        const ct = raw.subarray(12, raw.length - 16);
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
        const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
        return JSON.parse(pt);
    } catch { return null; }
}
function sigFrameChunks(corr: string, role: string, payloadB64: string): string[] {
    const n = Math.ceil(payloadB64.length / SIG_CHUNK) || 1; const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(JSON.stringify({ v: 1, c: corr, r: role, i, n, p: payloadB64.slice(i * SIG_CHUNK, (i + 1) * SIG_CHUNK) }));
    return out;
}
function sigMakeReasm() {
    const buf: any = Object.create(null);
    return (msg: string, onComplete: (c: string, r: string, full: string) => void) => {
        let m: any; try { m = JSON.parse(msg); } catch { return; }
        if (!m || m.v !== 1 || !m.c || typeof m.p !== 'string') return;
        let e = buf[m.c]; if (!e) e = buf[m.c] = { n: m.n, parts: new Array(m.n), got: 0, role: m.r, ts: Date.now() };
        if (e.parts[m.i] === undefined) { e.parts[m.i] = m.p; e.got++; }
        if (e.got >= e.n) { const full = e.parts.join(''); delete buf[m.c]; onComplete(m.c, m.r, full); }
        const now = Date.now(); for (const k in buf) if (now - buf[k].ts > SIG_REASM_TTL_MS) delete buf[k];
    };
}
// ntfy 发布: 黏性故障转移 — 按序逐 broker POST, 命中首个 2xx 即止(非广播)
function sigPublishOne(server: string, topic: string, body: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false; const fin = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
        try {
            const u = new URL(server.replace(/\/+$/, '') + '/' + topic);
            const isHttps = u.protocol === 'https:';
            const lib: any = isHttps ? https : http;
            const data = Buffer.from(body, 'utf8');
            const req = lib.request({ method: 'POST', host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, headers: { 'Content-Length': data.length } }, (res: any) => {
                const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300; res.resume(); fin(ok);
            });
            req.on('error', () => fin(false));
            req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} fin(false); });
            req.write(data); req.end();
        } catch { fin(false); }
    });
}
async function sigPublishFrame(topic: string, frame: string): Promise<boolean> {
    const order = (sigState.warm.length ? sigState.warm : sigState.servers);
    for (const s of order) { if (await sigPublishOne(s, topic, frame, 8000)) { sigState.lastTxTs = Date.now(); return true; } }
    // warm 全失败兜底: 再全量扫一遍原始列表
    for (const s of sigState.servers) { if (order.indexOf(s) >= 0) continue; if (await sigPublishOne(s, topic, frame, 8000)) { sigState.lastTxTs = Date.now(); return true; } }
    return false;
}
async function sigPublishObj(role: string, corr: string, obj: any): Promise<boolean> {
    if (!sigState.key) return false;
    const payload = sigSeal(sigState.key, obj);
    const frames = sigFrameChunks(corr, role, payload);
    let ok = true; for (const f of frames) { if (!(await sigPublishFrame(sigState.topic, f))) ok = false; }
    return ok;
}
// broker 预热: 启动时并行 health 探测, 把可达者排到前面(跳过死 broker)
async function sigWarmBrokers(): Promise<void> {
    const results = await Promise.all(sigState.servers.map(async (s) => {
        try { const ok = await sigPublishOne(s, sigState.topic, JSON.stringify({ v: 1, c: 'warm', r: 'w', i: 0, n: 1, p: '' }), 6000); return { s, ok }; }
        catch { return { s, ok: false }; }
    }));
    const alive = results.filter(r => r.ok).map(r => r.s);
    sigState.warm = alive.length ? alive : sigState.servers.slice();
}
function sigMarkHandled(corr: string): boolean {
    if (sigState.handled.indexOf(corr) >= 0) return false; // 已处理(多 broker 重复投递)
    sigState.handled.push(corr); if (sigState.handled.length > SIG_DEDUP_MAX) sigState.handled.shift();
    return true;
}
async function sigServeFrame(corr: string, full: string): Promise<void> {
    if (!sigState.key) return;
    if (!sigMarkHandled(corr)) return;
    const req = sigUnseal(sigState.key, full);
    if (!req || typeof req !== 'object') return; // 解密失败 = 非法/错 token, 静默丢弃(零账号门禁)
    sigState.lastRxTs = Date.now(); sigState.reqCount++;
    const t = req.t || 'rpc';
    // 应答方回复角色 's'(与手机版 signal.js buildRelayHandle 一致), 客户端只认 's' → 与 WebRTC answer('a') 解耦
    if (t === 'ping') { await sigPublishObj('s', corr, { t: 'pong', id: req.id || corr, ts: Date.now(), session: sigState.session }); return; }
    if (t !== 'rpc') return;
    const id = req.id || corr;
    // 兼容两种请求形: 直接 {path,method,body}; 或 {frame:{path,method,body}}(客户端包裹形)
    let descr: any = req;
    if (!req.path && req.frame) { try { descr = (typeof req.frame === 'string') ? JSON.parse(req.frame) : req.frame; } catch { descr = req; } }
    try {
        const route = String(descr.path || '/api/health').split('?')[0];
        const parsedUrl = new URL(descr.path || '/api/health', 'http://localhost:' + (ws.port || DEFAULT_PORT));
        const bodyStr = (descr.body === undefined || descr.body === null) ? '' : (typeof descr.body === 'string' ? descr.body : JSON.stringify(descr.body));
        // 帛书·「解之即得·不疑其门」: sigUnseal 已成功 ⟺ 调用方持有正确 token(AES-256 密钥由 token 派生,
        //   错 token 必解密失败已在 1694 行静默丢弃)→ 解封成功本身即等同鉴权。故此处注入权威 Bearer,
        //   令 /api/exec、/api/file、/api/write 等需鉴权整机端点经 mesh 兜底通道照常可用。
        //   根治: 旧法 fakeReq 不带 Authorization, checkAuth 必判 unauthorized → 路线C 仅能打免鉴权
        //   /api/health, 形同半残(用户报「兜底通道操作不了机器」)。客户端自带 headers 仍可覆盖(取并集后强置 auth)。
        const sigAuthTok = bridgeAuthoritativeToken() || bridgeToken || ws.token || '';
        const fakeHeaders: any = Object.assign({ 'content-type': 'application/json' }, descr.headers || {});
        if (sigAuthTok) { fakeHeaders['authorization'] = 'Bearer ' + sigAuthTok; delete fakeHeaders['Authorization']; }
        const fakeReq: any = { headers: fakeHeaders, method: descr.method || 'GET', socket: { remoteAddress: 'sig' }, url: descr.path || '/api/health', _relayBody: bodyStr };
        const result = await handleRouteInternal(route, parsedUrl, fakeReq, bridgeToken || ws.token);
        await sigPublishObj('s', corr, { t: 'res', id, status: 200, body: result });
    } catch (err: any) {
        await sigPublishObj('s', corr, { t: 'res', id, status: 500, body: { error: err && err.message ? err.message : String(err) } });
    }
}
// 帛书·「大成若缺·用之如泥沙」: 订阅改走 ntfy HTTP JSON 流(GET /{topic}/json),
//   不再依赖 `ws` 原生/打包模块 — 与发布路径(纯 https)同源, 部署零依赖、永不因缺 node_modules 而哑火。
//   这正是「真机 enabled:false」根因(require('ws') 抛错被吞)的根治: 砍掉这条依赖。
function sigSubscribeServer(server: string): void {
    if (sigState.stopping) return;
    const base = server.replace(/\/+$/, '');
    const streamUrl = base + '/' + sigState.topic + '/json';
    let backoff = SIG_BACKOFF_MIN; let req: any = null; let alive = true;
    // 半开死链看门狗(与手机版 signal.js route-C v0.37.60 对称): 静默失效的 TCP 流(NAT 重绑/休眠/网络切换)
    //   不发 FIN 也不报错 → res 的 end/error 永不触发, 订阅就此僵死「再也收不到却自以为在线」, 桌面经
    //   去中心化路线C 默默失联。ntfy 流每 ~45s 必有 keepalive 入站 → 健康连接持续刷新 lastRx; 据此 >90s
    //   无任何入站即判半开、主动 destroy(触发 error/end → schedule 重连)。lastRx===0 即未连接, 不误杀。
    let lastRx = 0;
    const wd = setInterval(() => {
        if (!alive || sigState.stopping) return;
        if (lastRx && Date.now() - lastRx > SIG_HALFOPEN_MS) { lastRx = 0; try { req && req.destroy(); } catch {} }
    }, SIG_WATCHDOG_MS);
    const entry: any = { server, close: () => { alive = false; try { clearInterval(wd); } catch {} try { req && req.destroy(); } catch {} } };
    sigState.subs.push(entry);
    const open = () => {
        if (!alive || sigState.stopping) return;
        let u: URL;
        try { u = new URL(streamUrl); } catch { schedule(); return; }
        const isHttps = u.protocol === 'https:';
        const lib: any = isHttps ? https : http;
        try {
            req = lib.request({ method: 'GET', host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, headers: { 'Accept': 'application/x-ndjson' } }, (res: any) => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.resume(); try { req.destroy(); } catch {} schedule(); return; }
                backoff = SIG_BACKOFF_MIN;
                lastRx = Date.now();   // 连接确立即起看门狗计时
                res.setEncoding('utf8');
                let buf = '';
                res.on('data', (chunk: string) => {
                    lastRx = Date.now();   // 任何入站(含 keepalive)刷新存活
                    buf += chunk;
                    let nl: number;
                    while ((nl = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
                        if (!line) continue;
                        try {
                            const o = JSON.parse(line);
                            if (o && o.event === 'message' && typeof o.message === 'string' && sigState.reasm) {
                                sigState.reasm(o.message, (corr, role, full) => { if (role === 'q') { sigServeFrame(corr, full).catch(() => {}); } });
                            }
                        } catch {}
                    }
                    if (buf.length > 1 << 20) buf = ''; // 守柔: 防御异常大行累积
                });
                res.on('end', () => { if (alive && !sigState.stopping) schedule(); });
                res.on('error', () => { if (alive && !sigState.stopping) schedule(); });
            });
            req.on('error', () => { if (alive && !sigState.stopping) schedule(); });
            // ntfy 流为长连接, 不设整体超时; 仅靠 broker keepalive 维持, 断开即 end/error → 重连
            req.end();
        } catch { schedule(); }
    };
    const schedule = () => {
        if (!alive || sigState.stopping) return;
        setTimeout(open, backoff + Math.floor(Math.random() * 500));
        backoff = Math.min(backoff * 2, SIG_BACKOFF_MAX);
    };
    open();
}
async function sigStart(): Promise<void> {
    try {
        if (sigState.enabled) return;
        const tok = bridgeAuthoritativeToken(); if (!tok) return;
        sigState.session = sigSessionId();
        sigState.topic = sigTopicFor(sigState.session);
        sigState.servers = SIG_DEFAULT_SERVERS.slice();
        sigState.key = sigDeriveKey(sigState.session, tok);
        sigState.reasm = sigMakeReasm();
        sigState.handled = []; sigState.stopping = false;
        await sigWarmBrokers();
        for (const s of (sigState.warm.length ? sigState.warm : sigState.servers)) sigSubscribeServer(s);
        sigState.enabled = true;
        try { console.log('[dao-sig] decentralized relay up · session=' + sigState.session + ' topic=' + sigState.topic + ' brokers=' + (sigState.warm.length || sigState.servers.length)); } catch {}
    } catch (e) { try { console.error('[dao-sig] start failed', e); } catch {} }
}
function sigStop(): void {
    sigState.stopping = true;
    for (const e of sigState.subs) { try { e.close(); } catch {} }
    sigState.subs = []; sigState.enabled = false;
}
function sigInfo(): any {
    return {
        enabled: sigState.enabled, session: sigState.session, topic: sigState.topic,
        brokers: sigState.servers, warm: sigState.warm,
        reqCount: sigState.reqCount, lastRxTs: sigState.lastRxTs, lastTxTs: sigState.lastTxTs,
    };
}

// ═══════════════════════════════════════════════════════════
// 代理隧道 — 自动检测本地VPN代理，绕过DNS污染
// 道法自然: 用户有VPN(Clash/V2Ray)，自动利用，无为而无以为
// ═══════════════════════════════════════════════════════════

let _proxyDetectTs = 0;
let _proxyProbing = false;
// 同步快探(不阻塞事件循环): 仅查环境变量/配置文件(纯内存/单次读盘)。端口实探交给异步 _refreshProxyPort。
function detectProxyPort(): number {
    if (detectedProxyPort) return detectedProxyPort;
    // ① 环境变量(Clash/V2Ray/系统代理常设)
    const envProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || '';
    if (envProxy) {
        const m = envProxy.match(/(?:127\.0\.0\.1|localhost):(\d+)/i);
        if (m) { detectedProxyPort = parseInt(m[1]); _proxyDetectTs = Date.now(); return detectedProxyPort; }
    }
    // ② 配置文件
    try {
        const f = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf8'));
        if (f.proxyPort) { detectedProxyPort = f.proxyPort; _proxyDetectTs = Date.now(); return detectedProxyPort; }
    } catch {}
    // 端口未知 → 触发后台异步实探(非阻塞), 本次先返 0(直连赛道照走), 探到后下次即用。
    _refreshProxyPort();
    return detectedProxyPort || 0;
}
// 异步端口实探: 单 net.connect(真正等连接结果) 逐口验证 + Windows 系统代理注册表。
//   根治旧法 net.Socket.connect 误判(connect 非阻塞·try/catch 捕不到拒绝 → 永远误设 7890)。
//   周期 60s 重探: 代理可能在插件启动后才开、或重启换端口。
function _refreshProxyPort(): void {
    if (_proxyProbing) return;
    // 节流: 命中后 60s 内不重探; 未命中(0)后 15s 内不重探(代理刚开也能较快接管, 又不致每请求探一次)。
    if (_proxyDetectTs && Date.now() - _proxyDetectTs < (detectedProxyPort ? 60000 : 15000)) return;
    _proxyProbing = true;
    const finishProbe = (port: number) => { detectedProxyPort = port; _proxyDetectTs = Date.now(); _proxyProbing = false; };
    // 真实 TCP 连接验证(等 connect/error 事件, 350ms 超时), 逐口短路命中即用。
    const probe = (idx: number): void => {
        if (idx >= PROXY_PORTS.length) {
            // 全部端口未中 → 退查 Windows 系统代理注册表(异步 exec, 不阻塞)
            try {
                require('child_process').exec('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { timeout: 2500 }, (e: any, out: string) => {
                    const m = !e && out ? out.match(/ProxyServer\s+REG_SZ\s+(?:socks5?=|https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/i) : null;
                    finishProbe(m ? parseInt(m[1]) : 0);
                });
            } catch { finishProbe(0); }
            return;
        }
        const p = PROXY_PORTS[idx];
        const s = new net.Socket();
        let settled = false;
        const next = (ok: boolean) => { if (settled) return; settled = true; try { s.destroy(); } catch { /* 守柔 */ } if (ok) finishProbe(p); else probe(idx + 1); };
        s.setTimeout(350, () => next(false));
        s.once('connect', () => next(true));
        s.once('error', () => next(false));
        try { s.connect(p, '127.0.0.1'); } catch { next(false); }
    };
    probe(0);
}

function createProxyTunnel(hostname: string): Promise<tls.TLSSocket | null> {
    const proxyPort = detectedProxyPort || detectProxyPort();
    if (!proxyPort) return Promise.resolve(null);
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1', port: proxyPort,
            method: 'CONNECT', path: hostname + ':443'
        });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            const tlsSocket = tls.connect({ socket, servername: hostname, rejectUnauthorized: false }, () => {
                resolve(tlsSocket);
            });
            tlsSocket.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════
// 道 · 路由重构 — 提取核心路由供HTTP和Relay共用
// ═══════════════════════════════════════════════════════════

// 帛书·「执天之行」— app.devin.ai 是 Vite SPA, 运行于 localhost 代理域时会以根路径
// 请求自身的静态资源(/assets/*)与后端接口(/api/users/*, /api/sessions ...)。
// 这些根路径需透传至 app.devin.ai(携 auth1), 否则命中 dao 鉴权 → 401 → SPA 误判
// 未登录而跳转 /auth/login。此判定为「路由官网」自动登录闭环之关键。
function isAppProxyPassthrough(route: string): boolean {
    // 归一 · 独立 HTTP 外壳: /shell 与 /api/shell/* 为 dao 自有 (直出外壳/SSE/消息), 不透传官网
    if (route === '/shell' || route.startsWith('/shell/') || route.startsWith('/api/shell')) return false;
    if (route === '/i' || route.startsWith('/i/')) return false; // 归一 · 同源前缀账号反代 (dao 自有·非官网透传)
    if (route.startsWith('/devin-cloud')) return false; // 已有专门前缀分支
    if (route.startsWith('/assets/')) return true;
    if (route.startsWith('/api/')) {
        // dao 自有 /api 路由由 switch 精确处理; 其余皆属 app.devin.ai
        const daoApiPrefixes = ['/api/health', '/api/connection', '/api/workspace', '/api/exec',
            '/api/command', '/api/file', '/api/write', '/api/search', '/api/edit', '/api/ls',
            '/api/terminal', '/api/diagnostics', '/api/definitions', '/api/references', '/api/symbols',
            '/api/git/', '/api/agents', '/api/commands', '/api/tools', '/api/devin', '/api/workspaces',
            '/api/agent-doc', '/api/manifest', '/api/bridge-state', '/api/next', '/api/signal-info',
            '/api/signal-start', '/api/signal-stop', '/api/cap', '/api/input'];
        return !daoApiPrefixes.some(p => route === p || route.startsWith(p + '/') || route === p.replace(/\/$/, ''));
    }
    // 帛书·「执天之行」官网根挂载: dao 自身 HTTP 仅占用 /api/*, 故其余所有根路径
    // (/、/org/*、/auth/*、/settings ...) 皆为官网 SPA 页面路由, 一律透传 app.devin.ai。
    // 如此 SPA 客户端路由器看到的是真实路径(/org/<slug>), 不再因 /devin-cloud 前缀而 404。
    if (route.startsWith('/relay') || route.startsWith('/connect')) return false;
    return true;
}

// ═══════════════════════════════════════════════════════════
// 道 · 模型反代「单隧道直达」— 把 dao-proxy-pro 本源 Origin (/v1/* + /origin/revproxy/*)
//   透明反代经本体公网隧道直达, 令用户在任意远程环境用网页对话台/标准 OpenAI 客户端
//   调用与管理反代模型 (帛书「無有入於無間」)。本源 Origin 端口随实际监听而动, 经其
//   发现文件 ~/.codeium/dao-byok/endpoint.json 软读 (不写死 8889/8985)。
// ═══════════════════════════════════════════════════════════
function revproxyOriginPort(): number {
    try {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        if (home) {
            const f = path.join(home, '.codeium', 'dao-byok', 'endpoint.json');
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            const p = parseInt(j && j.port, 10);
            if (p > 0 && p < 65536) return p;
        }
    } catch (e) { /* 守柔 · 缺省本源 Origin 端口 */ }
    return 8889;
}
// 本源 Origin 自有 apiKey (~/.codeium/dao-byok/revproxy.json) — 隧道边界已以本体 token
// 把关身份, 转发时换上 Origin 真钥, 令其放行 (远程用户只需持本体 token, 无需另知 Origin key)。
function revproxyApiKey(): string {
    try {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        if (home) {
            const f = path.join(home, '.codeium', 'dao-byok', 'revproxy.json');
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (j && typeof j.apiKey === 'string') return j.apiKey;
        }
    } catch (e) { /* 守柔 · Origin 未配 key 则空 (本机直放) */ }
    return '';
}
// 本源 Origin 自有命名空间「全量直达」— /origin/* 与 /v1/* 整段皆属 dao-proxy-pro 本源 Origin,
//   非官网 SPA 路由。逆流到底·解构一切: 凡用户能操作/调用/使用的 Origin 能力 (对话台 /origin/revproxy/*
//   + 模型目录/解锁 /origin/model_*·/origin/ea/* + 工具服务 /origin/api_server/* + 标准推理面 /v1/*)
//   一律经本体单隧道透明反代直达, 令远程任意环境皆可列出·调用·管理一切模型与内容 (帛书「無有入於無間」)。
function isRevproxyRoute(route: string): boolean {
    if (route === '/origin' || route.startsWith('/origin/')) return true;
    if (route === '/v1' || route.startsWith('/v1/')) return true;
    return false;
}
// 网页对话台外壳页 (静态 HTML) 免 token — 令远程浏览器先打开页面, 再在页内填 Bearer 调 API。
function isRevproxyConsoleShell(route: string): boolean {
    return route === '/origin/revproxy' || route === '/origin/revproxy/'
        || route === '/origin/revproxy/console' || route === '/origin/revproxy/空';
}
function forwardToRevproxyOrigin(route: string, url: URL, req: any, res?: any): Promise<any> {
    return new Promise((resolve) => {
        const port = revproxyOriginPort();
        const headers: Record<string, any> = {};
        for (const [k, v] of Object.entries((req && req.headers) || {})) {
            const kl = k.toLowerCase();
            if (kl === 'host' || kl === 'connection' || kl === 'keep-alive' || kl === 'proxy-connection'
                || kl === 'transfer-encoding' || kl === 'upgrade' || kl === 'te' || kl === 'trailer') continue;
            headers[k] = v as any;
        }
        headers['host'] = '127.0.0.1:' + port;
        // 换钥: 边界已验本体 token, 转发时以 Origin 真钥替换 Authorization (去 x-api-key 旧痕)。
        const apiKey = revproxyApiKey();
        if (apiKey) {
            for (const k of Object.keys(headers)) {
                const kl = k.toLowerCase();
                if (kl === 'authorization' || kl === 'x-api-key') delete headers[k];
            }
            headers['authorization'] = 'Bearer ' + apiKey;
        }
        const stripHop = (src: any): Record<string, string> => {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(src || {})) {
                const kl = k.toLowerCase();
                if (kl === 'transfer-encoding' || kl === 'connection' || kl === 'keep-alive' || kl === 'proxy-connection'
                    || kl === 'te' || kl === 'trailer' || kl === 'upgrade') continue;
                out[k] = Array.isArray(v) ? (v as string[]).join(', ') : String(v);
            }
            return out;
        };
        const up = http.request({ host: '127.0.0.1', port, method: (req && req.method) || 'GET', path: route + (url.search || ''), headers }, (ur: any) => {
            const respHeaders = stripHop(ur.headers);
            if (res) {
                try { (res as any).shouldKeepAlive = true; } catch {}
                try { res.writeHead(ur.statusCode || 200, respHeaders); } catch {}
                ur.pipe(res);
                ur.on('end', () => resolve({ _streamed: true }));
                ur.on('error', () => { try { res.end(); } catch {} resolve({ _streamed: true }); });
            } else {
                const chunks: Buffer[] = [];
                ur.on('data', (c: Buffer) => chunks.push(c));
                ur.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const ct = String(ur.headers['content-type'] || 'application/octet-stream');
                    const isText = /text|json|javascript|xml|event-stream|html/i.test(ct);
                    resolve({ _proxy: true, status: ur.statusCode || 200, contentType: ct, headers: respHeaders, body: isText ? buf.toString('utf8') : buf.toString('base64'), binary: !isText });
                });
                ur.on('error', () => resolve({ _proxy: true, status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'revproxy origin unreachable' }) }));
            }
        });
        up.on('error', () => {
            if (res) { try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'revproxy origin unreachable' })); } catch {} resolve({ _streamed: true }); }
            else resolve({ _proxy: true, status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'revproxy origin unreachable' }) });
        });
        const method = (req && req.method) || 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            if (req && typeof req.pipe === 'function') { req.pipe(up); }
            else { try { up.end(req && req._relayBody ? req._relayBody : undefined); } catch { up.end(); } }
        } else {
            up.end();
        }
    });
}

// ═══════════════════════════════════════════════════════════
// 道 · 整机投屏控制底座 (知其雄守其雌) — 隧道只搬数据, 渲染/输入捕获在访问者浏览器
//   常驻 PowerShell GUI worker(一次性载入 Win32): cap 截屏(JPEG) + 鼠/键注入(SetCursorPos/
//   mouse_event/keybd_event/SendKeys)。软编码: 虚拟屏边界运行时探测, PowerShell 路径经 env 解析。
//   worker 脚本随扩展自带(内联常量), 首用即写入 ~/.dao/dao-gui-worker.ps1 (内容变更才覆写)。
// ═══════════════════════════════════════════════════════════
const DAO_GUI_PS = path.join(DAO_DIR, 'dao-gui-worker.ps1');
const DAO_GUI_WORKER_PS = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class DaoGui {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);",
    "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);",
    "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    "$jpegEnc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "function Get-Bounds { return [System.Windows.Forms.SystemInformation]::VirtualScreen }",
    "function Do-Cap($scale, $q) {",
    "  $b = Get-Bounds",
    "  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
    "  $g = [System.Drawing.Graphics]::FromImage($bmp)",
    "  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)",
    "  $g.Dispose()",
    "  $out = $bmp",
    "  if ($scale -lt 100) {",
    "    $nw = [int]($b.Width * $scale / 100); $nh = [int]($b.Height * $scale / 100)",
    "    if ($nw -lt 1) { $nw = 1 }; if ($nh -lt 1) { $nh = 1 }",
    "    $nb = New-Object System.Drawing.Bitmap($nw, $nh)",
    "    $ng = [System.Drawing.Graphics]::FromImage($nb)",
    "    $ng.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear",
    "    $ng.DrawImage($bmp, 0, 0, $nw, $nh)",
    "    $ng.Dispose(); $bmp.Dispose(); $out = $nb",
    "  }",
    "  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)",
    "  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)",
    "  $ms = New-Object System.IO.MemoryStream",
    "  $out.Save($ms, $jpegEnc, $ep)",
    "  $r = [Convert]::ToBase64String($ms.ToArray())",
    "  $ms.Dispose(); $out.Dispose()",
    "  return $r",
    "}",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($line -eq $null) { break }",
    "  if ($line.Length -eq 0) { continue }",
    "  $o = $null",
    "  try { $o = $line | ConvertFrom-Json } catch { continue }",
    "  if ($o -eq $null) { continue }",
    "  $op = [string]$o.op",
    "  if ($op -eq 'cap') {",
    "    $s = 60; $q = 55",
    "    try { $s = [int]$o.scale } catch {}",
    "    try { $q = [int]$o.q } catch {}",
    "    if ($s -lt 10) { $s = 10 }; if ($s -gt 100) { $s = 100 }",
    "    if ($q -lt 20) { $q = 20 }; if ($q -gt 95) { $q = 95 }",
    "    $b64 = Do-Cap $s $q",
    "    [Console]::Out.WriteLine('CAP ' + [string]$o.id + ' ' + $b64)",
    "    [Console]::Out.Flush()",
    "    continue",
    "  }",
    "  $b = Get-Bounds",
    "  $px = 0; $py = 0",
    "  if ($o.nx -ne $null) { $px = [int]($b.X + [double]$o.nx * ($b.Width - 1)) }",
    "  if ($o.ny -ne $null) { $py = [int]($b.Y + [double]$o.ny * ($b.Height - 1)) }",
    "  switch ($op) {",
    "    'move' { [void][DaoGui]::SetCursorPos($px, $py) }",
    "    'btn' {",
    "      [void][DaoGui]::SetCursorPos($px, $py)",
    "      $btn = [string]$o.button; $act = [string]$o.action",
    "      $down = 0x0002; $up = 0x0004",
    "      if ($btn -eq 'right') { $down = 0x0008; $up = 0x0010 }",
    "      elseif ($btn -eq 'middle') { $down = 0x0020; $up = 0x0040 }",
    "      if ($act -eq 'down') { [DaoGui]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero) }",
    "      elseif ($act -eq 'up') { [DaoGui]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero) }",
    "      else { [DaoGui]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero); [DaoGui]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero) }",
    "    }",
    "    'scroll' {",
    "      [void][DaoGui]::SetCursorPos($px, $py)",
    "      $d = 0; try { $d = [int]$o.dy } catch {}",
    "      if ($d -lt 0) { $d = 0x100000000 + $d }",
    "      [DaoGui]::mouse_event([uint32]0x0800, 0, 0, [uint32]$d, [UIntPtr]::Zero)",
    "    }",
    "    'key' {",
    "      $vk = 0; try { $vk = [int]$o.vk } catch {}",
    "      if ($vk -gt 0) {",
    "        $f = 0; if (-not $o.down) { $f = 2 }",
    "        [DaoGui]::keybd_event([byte]$vk, 0, [uint32]$f, [UIntPtr]::Zero)",
    "      }",
    "    }",
    "    'text' {",
    "      $s = [string]$o.s",
    "      if ($s.Length -gt 0) {",
    "        $esc = ''",
    "        foreach ($ch in $s.ToCharArray()) {",
    "          if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { $esc += '{' + $ch + '}' } else { $esc += $ch }",
    "        }",
    "        [System.Windows.Forms.SendKeys]::SendWait($esc)",
    "      }",
    "    }",
    "  }",
    "}",
    ""
].join('\r\n');

interface PcGuiPending { resolve: (b64: string) => void; reject: (e: any) => void; timer: any; }
const pcGui: { proc: any; buf: string; seq: number; pending: Map<number, PcGuiPending>; } = {
    proc: null, buf: '', seq: 0, pending: new Map(),
};

function pcGuiPwshExe(): string {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try { if (fs.existsSync(p)) return p; } catch { /* 守柔 */ }
    return 'powershell.exe';
}

function pcGuiWriteScript(): void {
    let cur = '';
    try { cur = fs.readFileSync(DAO_GUI_PS, 'utf8'); } catch { /* 守柔 */ }
    if (cur !== DAO_GUI_WORKER_PS) {
        try { fs.mkdirSync(DAO_DIR, { recursive: true }); } catch { /* 守柔 */ }
        fs.writeFileSync(DAO_GUI_PS, DAO_GUI_WORKER_PS, 'utf8');
    }
}

function pcGuiOnData(d: string): void {
    pcGui.buf += d;
    let idx: number;
    while ((idx = pcGui.buf.indexOf('\n')) >= 0) {
        const line = pcGui.buf.slice(0, idx).replace(/\r$/, '');
        pcGui.buf = pcGui.buf.slice(idx + 1);
        if (line.startsWith('CAP ')) {
            const sp = line.indexOf(' ', 4);
            if (sp < 0) continue;
            const id = parseInt(line.slice(4, sp), 10);
            const b64 = line.slice(sp + 1);
            const pend = pcGui.pending.get(id);
            if (pend) { clearTimeout(pend.timer); pcGui.pending.delete(id); pend.resolve(b64); }
        }
    }
}

function pcGuiReset(err: any): void {
    pcGui.proc = null; pcGui.buf = '';
    for (const [, pend] of pcGui.pending) { try { clearTimeout(pend.timer); pend.reject(err); } catch { /* 守柔 */ } }
    pcGui.pending.clear();
}

function pcGuiEnsure(): boolean {
    if (pcGui.proc && !pcGui.proc.killed) return true;
    if (process.platform !== 'win32') return false;
    try {
        pcGuiWriteScript();
        const p = childProcess.spawn(pcGuiPwshExe(),
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DAO_GUI_PS],
            { windowsHide: true });
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d: string) => pcGuiOnData(d));
        p.stderr.on('data', () => { /* 守柔 */ });
        p.on('error', (e: any) => pcGuiReset(e || new Error('gui-spawn-error')));
        p.on('exit', () => pcGuiReset(new Error('gui-worker-exited')));
        pcGui.proc = p;
        return true;
    } catch (e) { pcGui.proc = null; return false; }
}

function pcGuiCap(scale: number, q: number): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!pcGuiEnsure()) { reject(new Error('gui-unavailable (platform=' + process.platform + ')')); return; }
        const id = ++pcGui.seq;
        const timer = setTimeout(() => { pcGui.pending.delete(id); reject(new Error('cap-timeout')); }, 8000);
        pcGui.pending.set(id, { resolve, reject, timer });
        try { pcGui.proc.stdin.write(JSON.stringify({ op: 'cap', id, scale, q }) + '\n'); }
        catch (e) { clearTimeout(timer); pcGui.pending.delete(id); reject(e); }
    });
}

function pcGuiInput(op: any): boolean {
    if (!op || typeof op !== 'object' || !op.op) return false;
    if (!pcGuiEnsure()) return false;
    try { pcGui.proc.stdin.write(JSON.stringify(op) + '\n'); return true; }
    catch (e) { return false; }
}

// 归一公网投屏控制台单页 — 满屏直投 + 指针/键盘/触摸捕获 + 自适应帧率。
//   token 自页面 URL(?master_token= 或 ?t=)运行时取得, 作 Bearer 调 /api/cap、/api/input。
//   渲染全在本页(blob→objectURL→img), 隧道只回 JPEG 字节; 输入只发轻量 JSON。无服务端插值。
function getMirrorPageHtml(): string {
    return [
        '<!DOCTYPE html>',
        '<html lang="zh"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
        '<title>DAO 整机投屏控制台</title>',
        '<style>',
        '*{margin:0;padding:0;box-sizing:border-box}',
        'html,body{width:100%;height:100%;background:#000;overflow:hidden;font:13px -apple-system,system-ui,sans-serif;color:#cdd3de;-webkit-user-select:none;user-select:none;touch-action:none}',
        '#v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:block}',
        '#kb{position:fixed;left:-1000px;top:0;width:1px;height:1px;opacity:0}',
        '#bar{position:fixed;top:0;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;padding:6px 12px;background:rgba(16,20,28,.82);backdrop-filter:blur(8px);border-radius:0 0 12px 12px;z-index:10;transition:opacity .25s;font-size:12px}',
        '#bar.hide{opacity:.12}',
        '#bar button{background:#1f2a38;color:#cdd3de;border:1px solid #2c3a4d;border-radius:7px;padding:5px 9px;cursor:pointer;font-size:12px}',
        '#bar button:hover{background:#27384c}',
        '#bar button.on{background:#1a7f5a;border-color:#1a7f5a;color:#fff}',
        '#st{font-variant-numeric:tabular-nums;min-width:120px;color:#7fd1a8}',
        '#st.bad{color:#e06c75}',
        'label{display:flex;align-items:center;gap:4px;color:#8a97a8}',
        'input[type=range]{width:74px;vertical-align:middle}',
        '</style></head><body>',
        '<img id="v" alt="screen" draggable="false">',
        '<input id="kb" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">',
        '<div id="bar">',
        '<span id="st">连接中…</span>',
        '<label>清晰 <input id="rs" type="range" min="20" max="100" step="5" value="60"></label>',
        '<label>画质 <input id="rq" type="range" min="20" max="90" step="5" value="55"></label>',
        '<button id="bk" title="切换软键盘(手机)">⌨ 键盘</button>',
        '<button id="bf" title="全屏">⛶ 全屏</button>',
        '<button id="bp" title="暂停/继续投屏" class="on">⏸ 暂停</button>',
        '</div>',
        '<script>',
        '(function(){',
        'var qp=new URLSearchParams(location.search);',
        'var TOKEN=qp.get("master_token")||qp.get("t")||qp.get("token")||"";',
        'var H={"Authorization":"Bearer "+TOKEN};',
        'var HJ={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"};',
        'var img=document.getElementById("v"),st=document.getElementById("st"),kb=document.getElementById("kb"),bar=document.getElementById("bar");',
        'var scale=60,quality=55,running=true,inflight=false,lastUrl=null,minInterval=33;',
        'document.getElementById("rs").oninput=function(){scale=parseInt(this.value,10)||60};',
        'document.getElementById("rq").oninput=function(){quality=parseInt(this.value,10)||55};',
        'function setSt(t,bad){st.textContent=t;st.className=bad?"bad":""}',
        'function loop(){',
        ' if(!running||inflight){return}',
        ' inflight=true;var t0=performance.now();',
        ' fetch("/api/cap?s="+scale+"&q="+quality,{headers:H,cache:"no-store"}).then(function(r){if(!r.ok){throw new Error("HTTP "+r.status)}return r.blob()}).then(function(b){',
        '   var u=URL.createObjectURL(b);var old=lastUrl;lastUrl=u;',
        '   img.onload=function(){if(old){URL.revokeObjectURL(old)}};img.src=u;',
        '   var dt=Math.round(performance.now()-t0);var fps=dt>0?Math.round(1000/Math.max(dt,minInterval)):0;',
        '   setSt(fps+" fps · "+dt+"ms · "+Math.round(b.size/1024)+"KB",false);',
        '   inflight=false;setTimeout(loop,Math.max(0,minInterval-dt));',
        ' }).catch(function(e){inflight=false;setSt("断: "+e.message,true);setTimeout(loop,1000)});',
        '}',
        'function mapXY(cx,cy){var rect=img.getBoundingClientRect();var iw=img.naturalWidth||rect.width,ih=img.naturalHeight||rect.height;var f=Math.min(rect.width/iw,rect.height/ih);var dw=iw*f,dh=ih*f;var ox=rect.left+(rect.width-dw)/2,oy=rect.top+(rect.height-dh)/2;var nx=(cx-ox)/dw,ny=(cy-oy)/dh;return{nx:Math.max(0,Math.min(1,nx)),ny:Math.max(0,Math.min(1,ny))}}',
        'function send(op){try{fetch("/api/input",{method:"POST",headers:HJ,body:JSON.stringify(op),keepalive:true}).catch(function(){})}catch(e){}}',
        'var BTN={0:"left",1:"middle",2:"right"};',
        'var lastMove=0;',
        'img.addEventListener("mousemove",function(e){var now=performance.now();if(now-lastMove<40)return;lastMove=now;var p=mapXY(e.clientX,e.clientY);send({op:"move",nx:p.nx,ny:p.ny})});',
        'img.addEventListener("mousedown",function(e){e.preventDefault();var p=mapXY(e.clientX,e.clientY);send({op:"btn",nx:p.nx,ny:p.ny,button:BTN[e.button]||"left",action:"down"})});',
        'img.addEventListener("mouseup",function(e){e.preventDefault();var p=mapXY(e.clientX,e.clientY);send({op:"btn",nx:p.nx,ny:p.ny,button:BTN[e.button]||"left",action:"up"})});',
        'img.addEventListener("contextmenu",function(e){e.preventDefault()});',
        'img.addEventListener("wheel",function(e){e.preventDefault();var p=mapXY(e.clientX,e.clientY);send({op:"scroll",nx:p.nx,ny:p.ny,dy:(e.deltaY>0?-120:120)})},{passive:false});',
        'var tDown=false;',
        'img.addEventListener("touchstart",function(e){e.preventDefault();var t=e.touches[0];if(!t)return;var p=mapXY(t.clientX,t.clientY);tDown=true;send({op:"btn",nx:p.nx,ny:p.ny,button:"left",action:"down"})},{passive:false});',
        'img.addEventListener("touchmove",function(e){e.preventDefault();var t=e.touches[0];if(!t)return;var p=mapXY(t.clientX,t.clientY);send({op:"move",nx:p.nx,ny:p.ny})},{passive:false});',
        'img.addEventListener("touchend",function(e){e.preventDefault();if(!tDown)return;tDown=false;send({op:"btn",button:"left",action:"up"})},{passive:false});',
        'var VKN={"Backspace":8,"Tab":9,"Enter":13,"Shift":16,"Control":17,"Alt":18,"CapsLock":20,"Escape":27,"PageUp":33,"PageDown":34,"End":35,"Home":36,"ArrowLeft":37,"ArrowUp":38,"ArrowRight":39,"ArrowDown":40,"Insert":45,"Delete":46,"Meta":91,"OS":91,"ContextMenu":93};',
        'function VK(e){var k=e.key;if(VKN[k]!=null)return VKN[k];if(k&&k.length===1){var c=k.toUpperCase().charCodeAt(0);if(c>=48&&c<=90)return c}var m=/^F(\\d{1,2})$/.exec(k||"");if(m){var n=parseInt(m[1],10);if(n>=1&&n<=12)return 111+n}return 0}',
        'function onKeyDown(e){if(e.key==="F5"||e.key==="F11"||e.key==="F12")return;if(e.key&&e.key.length===1&&!e.ctrlKey&&!e.altKey&&!e.metaKey){send({op:"text",s:e.key});e.preventDefault();return}var vk=VK(e);if(vk){send({op:"key",vk:vk,down:true});e.preventDefault()}}',
        'function onKeyUp(e){var vk=VK(e);if(vk){send({op:"key",vk:vk,down:false})}}',
        'document.addEventListener("keydown",onKeyDown);document.addEventListener("keyup",onKeyUp);',
        'document.getElementById("bk").onclick=function(){this.classList.toggle("on");if(this.classList.contains("on")){kb.focus()}else{kb.blur()}};',
        'document.getElementById("bf").onclick=function(){if(!document.fullscreenElement){(document.documentElement.requestFullscreen||function(){})()}else{document.exitFullscreen()}};',
        'document.getElementById("bp").onclick=function(){running=!running;this.classList.toggle("on",running);this.textContent=running?"⏸ 暂停":"▶ 继续";if(running)loop()};',
        'var hideT=null;function pokeBar(){bar.classList.remove("hide");clearTimeout(hideT);hideT=setTimeout(function(){bar.classList.add("hide")},2600)}',
        'document.addEventListener("mousemove",pokeBar);document.addEventListener("touchstart",pokeBar);pokeBar();',
        'if(!TOKEN){setSt("缺 token (在网址后加 ?master_token=…)",true)}else{loop()}',
        '})();',
        '</script></body></html>'
    ].join('\n');
}


// ═══════════════════════════════════════════════════════════
// DAO-MCP-PAYLOAD begin · 四大模块综合归一 MCP 源化 (原为运行时外科追加, 今入本源·永不随重建丢失)
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// 道 · 四大模块综合归一 MCP — 帛书「道生一·一生二·二生三·三生万物」
//   一个公网 MCP 端点统摄 pc_* / browser_* / plugin_* / vscode_*。
//   不另起服务: 蹭常驻桥(DAO Bridge)的耐用隧道 <桥URL>/mcp; 工具实现全部委托
//   插件已实测的内部处理器(/api/* 与 pcGui* / Chrome CDP), 不重复造轮 (大巧若拙)。
// ═══════════════════════════════════════════════════════════
const DAO_CDP_PORT = 9333; // browser_* 专用隔离 Chrome 的远程调试端口 (独立 user-data-dir·并行而不相悖)

function daoMcpSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 以「假 req(_relayBody 钉入鉴权与 body)」复用既有路由处理器, 杜绝逻辑重写。
async function daoMcpInvoke(apiRoute, body, query) {
    const u = new URL(apiRoute, `http://localhost:${ws.port || DEFAULT_PORT}`);
    if (query) { for (const k of Object.keys(query)) { const v = query[k]; if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); } }
    const fakeReq = {
        method: 'POST',
        headers: { authorization: 'Bearer ' + ws.token },
        _relayBody: (body !== undefined && body !== null) ? JSON.stringify(body) : '{}',
        socket: { remoteAddress: '127.0.0.1' },
        url: u.pathname + (u.search || ''),
        on: () => { /* _relayBody 已就位, 流事件无需 */ },
    };
    return await handleRouteInternal(u.pathname, u, fakeReq, ws.token, undefined);
}

function daoMcpText(v) { return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] }; }
function daoMcpImage(b64, mime) { return { content: [{ type: 'image', data: b64, mimeType: mime || 'image/jpeg' }] }; }
function daoMcpErr(msg) { return { content: [{ type: 'text', text: 'ERROR: ' + msg }], isError: true }; }
function daoClamp(v, lo, hi, dflt) { const n = parseInt(String(v), 10); if (!isFinite(n)) return dflt; return Math.max(lo, Math.min(hi, n)); }
// ── pc_ui_tree / pc_activate 底座 · UI Automation 控件树 + 窗口激活(帛书·「执大象·天下往」) ──
//   PowerShell 脚本以 base64 内嵌(规避 JS 字面量转义), 运行时按需自写 ~/.dao 并经 execFileSync(-File) 同步执行。
function daoWriteB64Script(name, b64) {
    const fp = path.join(DAO_DIR, name);
    try { const want = Buffer.from(b64, 'base64'); let cur = null; try { cur = fs.readFileSync(fp); } catch (e) { /* 守柔 */ }
        if (!cur || !cur.equals(want)) { fs.mkdirSync(DAO_DIR, { recursive: true }); fs.writeFileSync(fp, want); } } catch (e) { /* 守柔 */ }
    return fp;
}
function daoRunPwshFile(file, args, timeoutMs) {
    const a = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file].concat(args || []);
    return String(childProcess.execFileSync(pcGuiPwshExe(), a, { encoding: 'utf8', timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}
const PC_UIA_TREE_PS_B64 = 'cGFyYW0oW3N0cmluZ10kdGl0bGU9IiIsW2ludF0kcGlkXz0wLFtpbnRdJGRlcHRoPTQsW2ludF0kY2FwPTIwMCkNCiRFcnJvckFjdGlvblByZWZlcmVuY2U9J1N0b3AnDQpBZGQtVHlwZSAtQXNzZW1ibHlOYW1lIFVJQXV0b21hdGlvbkNsaWVudCxVSUF1dG9tYXRpb25UeXBlcyxXaW5kb3dzQmFzZSB8IE91dC1OdWxsDQppZigtbm90ICgnRGFvLkZnJyAtYXMgW3R5cGVdKSl7IEFkZC1UeXBlIC1OYW1lc3BhY2UgRGFvIC1OYW1lIEZnIC1NZW1iZXJEZWZpbml0aW9uICdbRGxsSW1wb3J0KCJ1c2VyMzIuZGxsIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIFN5c3RlbS5JbnRQdHIgR2V0Rm9yZWdyb3VuZFdpbmRvdygpOycgfCBPdXQtTnVsbCB9DQokQUU9W1N5c3RlbS5XaW5kb3dzLkF1dG9tYXRpb24uQXV0b21hdGlvbkVsZW1lbnRdOyAkVFM9W1N5c3RlbS5XaW5kb3dzLkF1dG9tYXRpb24uVHJlZVNjb3BlXTsgJFdBTEs9W1N5c3RlbS5XaW5kb3dzLkF1dG9tYXRpb24uVHJlZVdhbGtlcl06OkNvbnRyb2xWaWV3V2Fsa2VyDQokcm9vdD0kQUU6OlJvb3RFbGVtZW50DQojIHBpY2sgdGFyZ2V0IHdpbmRvdw0KJHRhcmdldD0kbnVsbA0KJHdpbnM9JHJvb3QuRmluZEFsbCgkVFM6OkNoaWxkcmVuLFtTeXN0ZW0uV2luZG93cy5BdXRvbWF0aW9uLkNvbmRpdGlvbl06OlRydWVDb25kaXRpb24pDQpmb3JlYWNoKCR3IGluICR3aW5zKXsgdHJ5ew0KICBpZigkcGlkXyAtZ3QgMCAtYW5kICR3LkN1cnJlbnQuUHJvY2Vzc0lkIC1lcSAkcGlkXyl7JHRhcmdldD0kdzticmVha30NCiAgaWYoJHRpdGxlIC1uZSAiIiAtYW5kICR3LkN1cnJlbnQuTmFtZSAtbGlrZSAiKiR0aXRsZSoiKXskdGFyZ2V0PSR3O2JyZWFrfQ0KfWNhdGNoe30gfQ0KaWYoLW5vdCAkdGFyZ2V0KXsgIyBmb3JlZ3JvdW5kDQogICRmZz1bRGFvLkZnXTo6R2V0Rm9yZWdyb3VuZFdpbmRvdygpOyBmb3JlYWNoKCR3IGluICR3aW5zKXsgdHJ5eyBpZihbU3lzdGVtLkludFB0cl0kdy5DdXJyZW50Lk5hdGl2ZVdpbmRvd0hhbmRsZSAtZXEgJGZnKXskdGFyZ2V0PSR3O2JyZWFrfSB9Y2F0Y2h7fSB9DQp9DQppZigtbm90ICR0YXJnZXQpeyBXcml0ZS1PdXRwdXQgJ3siZXJyb3IiOiJubyB0YXJnZXQgd2luZG93In0nOyBleGl0IH0NCiRzY3JpcHQ6bj0wDQpmdW5jdGlvbiBOb2RlKCRlbCwkZCl7DQogIGlmKCRzY3JpcHQ6biAtZ2UgJGNhcCAtb3IgJGQgLWx0IDApe3JldHVybiAkbnVsbH0NCiAgJHNjcmlwdDpuKysNCiAgJGM9JGVsLkN1cnJlbnQNCiAgJHI9JGMuQm91bmRpbmdSZWN0YW5nbGUNCiAgJG89W29yZGVyZWRdQHtuYW1lPSRjLk5hbWU7dHlwZT0kYy5Db250cm9sVHlwZS5Qcm9ncmFtbWF0aWNOYW1lIC1yZXBsYWNlICdDb250cm9sVHlwZVwuJywnJzthaWQ9JGMuQXV0b21hdGlvbklkO3g9W2ludF0kci5YO3k9W2ludF0kci5ZO3c9W2ludF0kci5XaWR0aDtoPVtpbnRdJHIuSGVpZ2h0fQ0KICAka2lkcz1AKCkNCiAgaWYoJGQgLWd0IDApeyAkY2g9JFdBTEsuR2V0Rmlyc3RDaGlsZCgkZWwpOyB3aGlsZSgkY2ggLWFuZCAkc2NyaXB0Om4gLWx0ICRjYXApeyAka249Tm9kZSAkY2ggKCRkLTEpOyBpZigka24peyRraWRzKz0ka259OyAkY2g9JFdBTEsuR2V0TmV4dFNpYmxpbmcoJGNoKSB9IH0NCiAgaWYoJGtpZHMuQ291bnQpeyRvLmNoaWxkcmVuPSRraWRzfQ0KICByZXR1cm4gJG8NCn0NCiR0cmVlPU5vZGUgJHRhcmdldCAkZGVwdGgNCltwc2N1c3RvbW9iamVjdF1Ae3dpbmRvdz0kdGFyZ2V0LkN1cnJlbnQuTmFtZTtwaWQ9JHRhcmdldC5DdXJyZW50LlByb2Nlc3NJZDtub2Rlcz0kc2NyaXB0Om47dHJlZT0kdHJlZX0gfCBDb252ZXJ0VG8tSnNvbiAtRGVwdGggMzAgLUNvbXByZXNzDQo=';
const PC_ACTIVATE_PS_B64 = 'cGFyYW0oW3N0cmluZ10kdGl0bGU9IiIsW2ludF0kcGlkXz0wKQ0KJEVycm9yQWN0aW9uUHJlZmVyZW5jZT0nU3RvcCcNCmlmKC1ub3QgKCdEYW9XaW4nIC1hcyBbdHlwZV0pKXsgQWRkLVR5cGUgQCcNCnVzaW5nIFN5c3RlbTt1c2luZyBTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXM7dXNpbmcgU3lzdGVtLlRleHQ7DQpwdWJsaWMgY2xhc3MgRGFvV2luew0KIFtEbGxJbXBvcnQoInVzZXIzMi5kbGwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTZXRGb3JlZ3JvdW5kV2luZG93KEludFB0ciBoKTsNCiBbRGxsSW1wb3J0KCJ1c2VyMzIuZGxsIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2hvd1dpbmRvdyhJbnRQdHIgaCxpbnQgbik7DQogW0RsbEltcG9ydCgidXNlcjMyLmRsbCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIElzV2luZG93VmlzaWJsZShJbnRQdHIgaCk7DQogW0RsbEltcG9ydCgidXNlcjMyLmRsbCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBpbnQgR2V0V2luZG93VGV4dChJbnRQdHIgaCxTdHJpbmdCdWlsZGVyIHMsaW50IG4pOw0KIFtEbGxJbXBvcnQoInVzZXIzMi5kbGwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBFbnVtV2luZG93cyhFbnVtUHJvYyBjYixJbnRQdHIgbCk7DQogW0RsbEltcG9ydCgidXNlcjMyLmRsbCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiB1aW50IEdldFdpbmRvd1RocmVhZFByb2Nlc3NJZChJbnRQdHIgaCxvdXQgdWludCBwaWQpOw0KIHB1YmxpYyBkZWxlZ2F0ZSBib29sIEVudW1Qcm9jKEludFB0ciBoLEludFB0ciBsKTsNCn0NCidAIH0NCiRmb3VuZD1bSW50UHRyXTo6WmVybzsgJGZvdW5kVGl0bGU9IiINCiRjYj1bRGFvV2luK0VudW1Qcm9jXXsgcGFyYW0oJGgsJGwpDQogIGlmKC1ub3QgW0Rhb1dpbl06OklzV2luZG93VmlzaWJsZSgkaCkpe3JldHVybiAkdHJ1ZX0NCiAgJHNiPU5ldy1PYmplY3QgVGV4dC5TdHJpbmdCdWlsZGVyIDUxMjsgW0Rhb1dpbl06OkdldFdpbmRvd1RleHQoJGgsJHNiLDUxMil8T3V0LU51bGw7ICR0PSRzYi5Ub1N0cmluZygpDQogIGlmKCR0IC1lcSAiIil7cmV0dXJuICR0cnVlfQ0KICAkcD0wOyBbRGFvV2luXTo6R2V0V2luZG93VGhyZWFkUHJvY2Vzc0lkKCRoLFtyZWZdJHApfE91dC1OdWxsDQogIGlmKCgkcGlkXyAtZ3QgMCAtYW5kICRwIC1lcSAkcGlkXykgLW9yICgkdGl0bGUgLW5lICIiIC1hbmQgJHQgLWxpa2UgIiokdGl0bGUqIikpeyAkc2NyaXB0OmZvdW5kPSRoOyAkc2NyaXB0OmZvdW5kVGl0bGU9JHQ7IHJldHVybiAkZmFsc2UgfQ0KICByZXR1cm4gJHRydWUNCn0NCltEYW9XaW5dOjpFbnVtV2luZG93cygkY2IsW0ludFB0cl06Olplcm8pfE91dC1OdWxsDQppZigkZm91bmQgLWVxIFtJbnRQdHJdOjpaZXJvKXsgV3JpdGUtT3V0cHV0ICd7Im9rIjpmYWxzZSwiZXJyb3IiOiJ3aW5kb3cgbm90IGZvdW5kIn0nOyBleGl0IH0NCltEYW9XaW5dOjpTaG93V2luZG93KCRmb3VuZCw5KXxPdXQtTnVsbCAgIyBTV19SRVNUT1JFDQokb2s9W0Rhb1dpbl06OlNldEZvcmVncm91bmRXaW5kb3coJGZvdW5kKQ0KW3BzY3VzdG9tb2JqZWN0XUB7b2s9JG9rO3RpdGxlPSRzY3JpcHQ6Zm91bmRUaXRsZX0gfCBDb252ZXJ0VG8tSnNvbiAtQ29tcHJlc3MNCg==';

// ── browser_* · Chrome DevTools Protocol (CDP) ──
function daoCdpHttpGet(p) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: DAO_CDP_PORT, path: p, timeout: 5000 }, (res) => {
            let buf = ''; res.setEncoding('utf8');
            res.on('data', (d) => buf += d);
            res.on('end', () => { try { resolve(buf ? JSON.parse(buf) : null); } catch (e) { reject(new Error('cdp-http-parse: ' + buf.slice(0, 120))); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { try { req.destroy(); } catch (e6) { /* 守柔 */ } reject(new Error('cdp-http-timeout')); });
    });
}

// 在单个 CDP target(或 browser endpoint) 上顺序执行若干命令, 返回最后一条结果。
//   零依赖原生 WebSocket(仅本机 CDP·明文 ws://): 砍掉 require('ws') — 与信令同理
//   (见 §sigSubscribeServer 注释), 杜绝「真机缺打包模块 → 哑火」。手搓 RFC6455:
//   HTTP Upgrade 握手 + 客户端掩码帧编码 + 服务端帧(含 126/127 扩展长度·分片·ping)解析。
function daoCdpBatch(wsUrl, calls, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        // 核心模块经 require 取用(必在·永不缺): 不赌打包是否把 net/crypto 提升到追加载荷的作用域。
        const _net = require('net'); const _crypto = require('crypto');
        let u;
        try { u = new URL(wsUrl); } catch (e) { reject(new Error('cdp-ws-url: ' + (e && e.message))); return; }
        const port = parseInt(u.port, 10) || (u.protocol === 'wss:' ? 443 : 80);
        const key = _crypto.randomBytes(16).toString('base64');
        let done = false;
        let idc = 0; const results = []; const queue = calls.slice(); let cur = null; let curId = 0;
        const sock = _net.connect(port, u.hostname);
        const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (e7) { /* 守柔 */ } if (err) reject(err); else resolve(val); };
        const timer = setTimeout(() => finish(new Error('cdp-timeout')), timeoutMs);
        sock.on('error', (e) => finish(new Error('cdp-ws: ' + (e && e.message))));
        sock.on('close', () => { if (!done) finish(new Error('cdp-ws-closed')); });

        // 帧编码(客户端帧必须掩码) — opcode: 0x1 文本 / 0x8 关 / 0x9 ping / 0xA pong
        const writeFrame = (opcode, payload) => {
            const len = payload.length; const mask = _crypto.randomBytes(4);
            let header;
            if (len < 126) { header = Buffer.from([0x80 | opcode, 0x80 | len]); }
            else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
            else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeUInt32BE(Math.floor(len / 0x100000000), 2); header.writeUInt32BE(len >>> 0, 6); }
            const masked = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
            try { sock.write(Buffer.concat([header, mask, masked])); } catch (e) { finish(new Error('cdp-send: ' + (e && e.message))); }
        };
        const sendNext = () => {
            if (queue.length === 0) { finish(null, results[results.length - 1]); return; }
            cur = queue.shift() || null; curId = ++idc;
            // params 可为函数: 用「已得结果」动态构造下一条命令的参数 → 同一会话内串接
            //   (CDP objectId/nodeId 仅在创建它的会话内有效, 跨会话即「Could not find object with given id」)。
            let p; try { p = (cur && typeof cur.params === 'function') ? cur.params(results) : ((cur && cur.params) || {}); } catch (ep) { finish(new Error('cdp-param: ' + (ep && ep.message))); return; }
            writeFrame(0x1, Buffer.from(JSON.stringify({ id: curId, method: cur.method, params: p }), 'utf8'));
        };
        const onMessage = (txt) => {
            let msg; try { msg = JSON.parse(txt); } catch (e8) { return; }
            if (msg.id !== curId) return; // 跳过事件与乱序
            if (msg.error) { finish(new Error('cdp-error: ' + JSON.stringify(msg.error))); return; }
            results.push(msg.result); sendNext();
        };

        // 帧解析(服务端→客户端帧不掩码; 兼容掩码以防万一) + 分片重组
        let handshakeDone = false; let rx = Buffer.alloc(0); let fragOp = 0; let fragBuf = [];
        const parseFrames = () => {
            while (rx.length >= 2) {
                const b0 = rx[0], b1 = rx[1];
                const fin = (b0 & 0x80) !== 0; const op = b0 & 0x0f;
                const masked = (b1 & 0x80) !== 0; let len = b1 & 0x7f; let off = 2;
                if (len === 126) { if (rx.length < 4) return; len = rx.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (rx.length < 10) return; len = rx.readUInt32BE(2) * 0x100000000 + rx.readUInt32BE(6); off = 10; }
                const need = off + (masked ? 4 : 0) + len;
                if (rx.length < need) return; // 等待更多字节
                let payload = rx.slice(off + (masked ? 4 : 0), need);
                if (masked) { const mk = rx.slice(off, off + 4); const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mk[i & 3]; payload = out; }
                rx = rx.slice(need);
                if (op === 0x8) { finish(new Error('cdp-ws-closed')); return; }
                if (op === 0x9) { writeFrame(0xA, payload); continue; } // ping → pong
                if (op === 0xA) { continue; } // pong
                if (op === 0x0) { fragBuf.push(payload); if (fin) { const all = Buffer.concat(fragBuf); fragBuf = []; const fo = fragOp; fragOp = 0; if (fo === 0x1) onMessage(all.toString('utf8')); } continue; }
                if (!fin) { fragOp = op; fragBuf = [payload]; continue; }
                if (op === 0x1) onMessage(payload.toString('utf8'));
            }
        };

        sock.on('connect', () => {
            const reqLines = [
                'GET ' + (u.pathname + (u.search || '')) + ' HTTP/1.1',
                'Host: ' + u.hostname + ':' + port,
                'Upgrade: websocket', 'Connection: Upgrade',
                'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13', '', '',
            ];
            try { sock.write(reqLines.join('\r\n')); } catch (e) { finish(new Error('cdp-ws-write: ' + (e && e.message))); }
        });
        sock.on('data', (chunk) => {
            if (!handshakeDone) {
                rx = Buffer.concat([rx, chunk]);
                const sep = rx.indexOf('\r\n\r\n');
                if (sep < 0) return;
                const head = rx.slice(0, sep).toString('utf8');
                if (!/^HTTP\/1\.1 101/i.test(head)) { finish(new Error('cdp-ws-handshake: ' + head.split('\r\n')[0])); return; }
                handshakeDone = true; rx = rx.slice(sep + 4);
                sendNext();
                if (rx.length) parseFrames();
                return;
            }
            rx = Buffer.concat([rx, chunk]);
            parseFrames();
        });
    });
}

async function daoCdpEnsureChrome() {
    try { return await daoCdpHttpGet('/json/version'); } catch (e9) { /* 未起 → 拉起 */ }
    const exe = findBrowserExe();
    if (!exe) throw new Error('no-chrome-found (browser_* 需本机存在 Chrome/Edge/Chromium)');
    const profileDir = path.join(DAO_DIR, 'cdp-profile');
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e10) { /* 守柔 */ }
    const args = [
        '--remote-debugging-port=' + DAO_CDP_PORT,
        '--remote-allow-origins=*',
        '--user-data-dir=' + profileDir,
        '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-sync',
        '--disable-features=Translate,msEdgeWelcomePage,msSync',
        'about:blank',
    ];
    try { const child = childProcess.spawn(exe, args, { detached: true, stdio: 'ignore' }); child.unref(); } catch (e) { throw new Error('chrome-spawn: ' + (e && e.message)); }
    for (let i = 0; i < 40; i++) { await daoMcpSleep(250); try { return await daoCdpHttpGet('/json/version'); } catch (e11) { /* 等就绪 */ } }
    throw new Error('chrome-cdp-not-ready');
}

// 归一 · Playwright/Chrome-MCP 式「当前页」跟踪: browser_navigate/tabs(select|new)/activate 记下活动标签;
//   无 targetId 的 browser_* 默认作用于它(仍存活), 否则才回落首个页面。
//   旧病灶: 无跟踪时 daoCdpPickPage 恒返 pages[0](常是遗留 about:blank), 与 navigate 新建的标签分叉 →
//   snapshot/get_text/click 全落到空白标签("element not found"·空 DOM)。见 CHANGELOG dao-vsix。
let daoCdpActiveTarget = null;
async function daoCdpPickPage(targetId) {
    await daoCdpEnsureChrome();
    let list = await daoCdpHttpGet('/json/list') || [];
    let pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (targetId) { const t = pages.find((x) => x.id === targetId) || list.find((x) => x.id === targetId); if (!t || !t.webSocketDebuggerUrl) throw new Error('target-not-found: ' + targetId); daoCdpActiveTarget = t.id; return t; }
    // 无 targetId → 当前页语义: 优先上次导航/选中的活动标签(仍存活), 否则回落首个页面。
    if (daoCdpActiveTarget) { const act = pages.find((x) => x.id === daoCdpActiveTarget); if (act) return act; daoCdpActiveTarget = null; }
    if (pages.length > 0) { daoCdpActiveTarget = pages[0].id; return pages[0]; }
    const ver = await daoCdpHttpGet('/json/version');
    await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.createTarget', params: { url: 'about:blank' } }]);
    await daoMcpSleep(300);
    list = await daoCdpHttpGet('/json/list') || [];
    pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pages.length === 0) throw new Error('no-page-target');
    daoCdpActiveTarget = pages[0].id;
    return pages[0];
}

// ── browser_* 升级 · Playwright/Chrome-DevTools-MCP 级能力 (CDP 原生·零依赖) ──
//   页内注入轻量助手 __daoB: 无障碍/可交互元素快照(带 ref) + ref/selector 定位 + 取文/取 HTML
//   + console/network 钩子。点击/输入/拖拽走 CDP 原生可信输入事件(Input.*), 与「我操作自己浏览器」对等。
const DAO_B_FACTORY = `window.__daoB=(function(){
  var B={s:0,m:new Map(),logs:[],net:[]};
  function vis(el){var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;var s=getComputedStyle(el);if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity)===0)return false;return true;}
  function nameOf(el){var n=el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.getAttribute('alt')||el.getAttribute('name'));if(!n){var t=(el.innerText||el.textContent||'').trim();if(t)n=t;}if(!n&&el.value!=null)n=String(el.value);return (n||'').replace(/\\s+/g,' ').trim();}
  function roleOf(el){var r=el.getAttribute&&el.getAttribute('role');if(r)return r;var tag=el.tagName.toLowerCase();if(tag==='a')return 'link';if(tag==='button')return 'button';if(tag==='input')return (el.type||'text').toLowerCase();if(tag==='textarea')return 'textbox';if(tag==='select')return 'combobox';return tag;}
  B.el=function(k){if(!k)return null;if(/^e\\d+$/.test(k)){var e=B.m.get(k);if(e&&e.isConnected)return e;var q=document.querySelector('[data-dao-ref="'+k+'"]');if(q)return q;}try{return document.querySelector(k);}catch(e){return null;}};
  B.snapshot=function(){B.m.clear();B.s=0;var sel='a,button,input,textarea,select,[role],[onclick],[tabindex],summary,[contenteditable="true"]';var els=document.querySelectorAll(sel);var out=[];for(var i=0;i<els.length;i++){var el=els[i];if(!vis(el))continue;var ref='e'+(++B.s);B.m.set(ref,el);try{el.setAttribute('data-dao-ref',ref);}catch(e){}var r=el.getBoundingClientRect();var o={ref:ref,role:roleOf(el),name:nameOf(el).slice(0,160),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(el.value!=null&&String(el.value)!=='')o.value=String(el.value).slice(0,80);var hr=el.getAttribute&&el.getAttribute('href');if(hr)o.href=hr;if(el.disabled||(el.getAttribute&&el.getAttribute('aria-disabled')==='true'))o.disabled=true;out.push(o);}return {url:location.href,title:document.title,scrollY:Math.round(scrollY),count:out.length,elements:out};};
  B.center=function(k){var el=B.el(k);if(!el)return null;try{el.scrollIntoView({block:'center',inline:'center'});}catch(e){}var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),tag:el.tagName.toLowerCase()};};
  B.focus=function(k){var el=B.el(k);if(!el)return false;try{el.focus();}catch(e){}return document.activeElement===el;};
  B.setValue=function(k,val){var el=B.el(k);if(!el)return false;try{el.focus();}catch(e){}try{var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(el,val);}else{el.value=val;}}catch(e){try{el.value=val;}catch(e2){}}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;};
  B.selectOption=function(k,values){var el=B.el(k);if(!el||el.tagName!=='SELECT')return false;var set={};for(var j=0;j<values.length;j++)set[values[j]]=1;var n=0;for(var i=0;i<el.options.length;i++){var op=el.options[i];var on=!!(set[op.value]||set[op.label]||set[op.text]);op.selected=on;if(on)n++;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return n;};
  B.text=function(k){var el=k?B.el(k):document.body;return el?(el.innerText||el.textContent||''):'';};
  B.html=function(k,outer){var el=k?B.el(k):document.documentElement;if(!el)return '';return outer?el.outerHTML:el.innerHTML;};
  B.exists=function(k){return !!B.el(k);};
  B.fillForm=function(items){items=items||[];var out=[];for(var i=0;i<items.length;i++){var it=items[i]||{};var k=it.ref||it.selector;var el=B.el(k);if(!el){out.push({field:k,ok:false,error:'not-found'});continue;}var tag=el.tagName.toLowerCase();var type=(el.type||'').toLowerCase();try{el.scrollIntoView({block:'center'});}catch(e){}if(tag==='select'){var vals=Array.isArray(it.value)?it.value:[it.value];out.push({field:k,ok:true,kind:'select',selected:B.selectOption(k,vals)});}else if(type==='checkbox'||type==='radio'){var want;if(type==='radio'&&it.value!=null&&it.value!==true&&it.value!==false){want=(String(el.value)===String(it.value));}else{want=(it.value===true||it.value==='true'||it.value==='on'||it.value==='checked'||it.value===1||it.value==='1');}try{el.focus();}catch(e){}el.checked=want;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));out.push({field:k,ok:true,kind:type,checked:want});}else{B.setValue(k,(it.value==null?'':String(it.value)));out.push({field:k,ok:true,kind:'text'});}}return {filled:out.filter(function(o){return o.ok;}).length,total:items.length,results:out};};
  if(!B._hooked){B._hooked=true;['log','info','warn','error','debug'].forEach(function(lv){var orig=console[lv];console[lv]=function(){try{B.logs.push({level:lv,text:Array.prototype.map.call(arguments,function(x){try{return typeof x==='string'?x:JSON.stringify(x);}catch(e){return String(x);}}).join(' ').slice(0,500),t:Date.now()});if(B.logs.length>300)B.logs.shift();}catch(e){}return orig.apply(console,arguments);};});window.addEventListener('error',function(e){try{B.logs.push({level:'error',text:String((e&&e.message)||(e&&e.error)||e).slice(0,500),t:Date.now()});}catch(_){}});try{var of=window.fetch;if(of){window.fetch=function(){var u=(arguments[0]&&arguments[0].url)?arguments[0].url:String(arguments[0]);var m=(arguments[1]&&arguments[1].method)||'GET';var rec={url:String(u).slice(0,300),method:m,t:Date.now()};B.net.push(rec);if(B.net.length>300)B.net.shift();return of.apply(this,arguments).then(function(resp){rec.status=resp.status;return resp;}).catch(function(err){rec.error=String(err).slice(0,120);throw err;});};}}catch(e){}try{var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){this.__dao={url:String(u).slice(0,300),method:m,t:Date.now()};try{this.addEventListener('loadend',function(){try{this.__dao.status=this.status;B.net.push(this.__dao);if(B.net.length>300)B.net.shift();}catch(e){}});}catch(e){}return oo.apply(this,arguments);};}catch(e){}}
  return B;
})();`;
function daoBExpr(retExpr) { return '(function(){ if(!window.__daoB){' + DAO_B_FACTORY + '} return (' + retExpr + '); })()'; }
async function daoCdpEvalT(t, expr) {
    const r = await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }]);
    if (r && r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r && r.result ? r.result.value : undefined;
}
async function daoCdpEvalObj(t, expr) {
    const r = await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Runtime.evaluate', params: { expression: expr, returnByValue: false } }]);
    if (r && r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r && r.result ? r.result.objectId : undefined;
}
const DAO_BTN_MASK = { left: 1, right: 2, middle: 4 };
async function daoCdpMouse(t, type, x, y, opts) {
    await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Input.dispatchMouseEvent', params: Object.assign({ type, x, y }, opts || {}) }]);
}
async function daoCdpClickXY(t, x, y, button, clickCount) {
    const b = button || 'left'; const mask = DAO_BTN_MASK[b] || 1; const cc = clickCount || 1;
    await daoCdpBatch(t.webSocketDebuggerUrl, [
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: b, buttons: mask, clickCount: cc } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: b, buttons: 0, clickCount: cc } },
    ]);
}
// 解析点击目标坐标: x,y 直给 | ref/selector 取元素中心 | nx,ny 视口比例
async function daoBResolveXY(t, a) {
    if (a.x !== undefined && a.y !== undefined) return { x: +a.x, y: +a.y };
    if (a.ref || a.selector) {
        const c = await daoCdpEvalT(t, daoBExpr('window.__daoB.center(' + JSON.stringify(a.ref || a.selector) + ')'));
        if (!c) throw new Error('element-not-found: ' + (a.ref || a.selector));
        return { x: c.x, y: c.y };
    }
    if (a.nx !== undefined && a.ny !== undefined) {
        const vp = await daoCdpEvalT(t, '({w:innerWidth,h:innerHeight})');
        return { x: Math.round((+a.nx) * ((vp && vp.w) || 1)), y: Math.round((+a.ny) * ((vp && vp.h) || 1)) };
    }
    throw new Error('need ref|selector|x,y|nx,ny');
}
const DAO_KEYMAP = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }, Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};
async function daoCdpKey(t, keyName) {
    const k = DAO_KEYMAP[keyName]; if (!k) throw new Error('unsupported key: ' + keyName + ' (printable text → browser_type)');
    await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Input.dispatchKeyEvent', params: Object.assign({ type: 'keyDown' }, k) }, { method: 'Input.dispatchKeyEvent', params: Object.assign({ type: 'keyUp' }, k) }]);
}

// 工具清单 — 名称严格对齐知识库《DAO Bridge MCP 使用文档(四大模块)》。
function daoMcpToolDefs() {
    const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });
    return [
        // pc_* · 操作整机 (渲染在访问者浏览器, 此处只产数据)
        { name: 'pc_exec', description: '整机执行命令(本机 shell·经 IDE 终端)', inputSchema: S({ cmd: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number' } }, ['cmd']) },
        { name: 'pc_screenshot', description: '整机截屏(JPEG·虚拟全屏)', inputSchema: S({ scale: { type: 'number', description: '10-100·缩放百分比' }, quality: { type: 'number', description: '20-95·JPEG 质量' } }) },
        { name: 'pc_click', description: '整机鼠标点击(归一化坐标 nx,ny∈[0,1])', inputSchema: S({ nx: { type: 'number' }, ny: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, action: { type: 'string', enum: ['click', 'down', 'up'] } }, ['nx', 'ny']) },
        { name: 'pc_move', description: '整机鼠标移动(归一化坐标)', inputSchema: S({ nx: { type: 'number' }, ny: { type: 'number' } }, ['nx', 'ny']) },
        { name: 'pc_scroll', description: '整机滚轮(归一化坐标·dy 正上负下)', inputSchema: S({ nx: { type: 'number' }, ny: { type: 'number' }, dy: { type: 'number' } }, ['dy']) },
        { name: 'pc_type', description: '整机键盘输入文本(SendKeys)', inputSchema: S({ text: { type: 'string' } }, ['text']) },
        { name: 'pc_key', description: '整机虚拟键(vk=Windows 虚拟键码·如 13=Enter 27=Esc)', inputSchema: S({ vk: { type: 'number' }, action: { type: 'string', enum: ['press', 'down', 'up'] } }, ['vk']) },
        { name: 'pc_file_read', description: '读本机文件(绝对路径)', inputSchema: S({ path: { type: 'string' } }, ['path']) },
        { name: 'pc_file_write', description: '写本机文件(绝对路径)', inputSchema: S({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
        { name: 'pc_ls', description: '列目录(绝对路径·缺省取工作区根)', inputSchema: S({ path: { type: 'string' } }) },
        // browser_* · Chrome CDP (隔离实例)
        { name: 'browser_launch', description: '拉起/确认 browser_* 专用隔离 Chrome(CDP)并返回版本', inputSchema: S({}) },
        { name: 'browser_targets', description: '列出 CDP 全部 target(页面/标签)', inputSchema: S({}) },
        { name: 'browser_navigate', description: '导航: 给 targetId 则原标签导航, 否则新建标签; 导航后该标签即成「当前页」(后续无 targetId 的 browser_* 默认作用于它)', inputSchema: S({ url: { type: 'string' }, targetId: { type: 'string' } }, ['url']) },
        { name: 'browser_activate', description: '设为「当前页」: 后续无 targetId 的 browser_* 默认作用于此标签(Playwright 当前页语义)', inputSchema: S({ targetId: { type: 'string' } }, ['targetId']) },
        { name: 'browser_eval', description: '在页面上下文执行 JS 并返回值(Runtime.evaluate·await Promise)', inputSchema: S({ code: { type: 'string' }, targetId: { type: 'string' } }, ['code']) },
        { name: 'browser_screenshot', description: '页面截图(CDP·jpeg/png)', inputSchema: S({ targetId: { type: 'string' }, format: { type: 'string', enum: ['jpeg', 'png'] }, quality: { type: 'number' } }) },
        // plugin_* · 插件本体/工作区
        { name: 'plugin_health', description: '插件健康/版本/工作区/端口', inputSchema: S({}) },
        { name: 'plugin_exec', description: '工作区执行命令(缺省 cwd=工作区根)', inputSchema: S({ cmd: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number' } }, ['cmd']) },
        { name: 'plugin_ls', description: '列工作区目录', inputSchema: S({ path: { type: 'string' } }) },
        { name: 'plugin_file', description: '读工作区文件', inputSchema: S({ path: { type: 'string' } }, ['path']) },
        { name: 'plugin_write', description: '写工作区文件', inputSchema: S({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
        { name: 'plugin_edit', description: '按范围编辑文件(WorkspaceEdit)', inputSchema: S({ file: { type: 'string' }, edits: { type: 'array' } }, ['file', 'edits']) },
        { name: 'plugin_search', description: '按 glob 查找文件', inputSchema: S({ pattern: { type: 'string' }, exclude: { type: 'string' }, maxResults: { type: 'number' } }) },
        { name: 'plugin_terminal', description: '终端: 有 terminalId 则发送, 否则新建终端', inputSchema: S({ terminalId: { type: 'string' }, text: { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' } }) },
        { name: 'plugin_git', description: 'Git 仓库状态', inputSchema: S({}) },
        { name: 'plugin_tools', description: '调用插件内置工具集(executeTool)', inputSchema: S({ tool: { type: 'string' }, args: { type: 'object' } }, ['tool']) },
        // vscode_* · VSCode 暴露
        { name: 'vscode_command', description: '执行 VSCode 命令', inputSchema: S({ command: { type: 'string' }, args: { type: 'array' } }, ['command']) },
        { name: 'vscode_commands', description: '列出全部可用 VSCode 命令', inputSchema: S({}) },
        { name: 'vscode_diagnostics', description: '工作区诊断(错误/警告)', inputSchema: S({}) },
        { name: 'vscode_definitions', description: '跳转定义', inputSchema: S({ file: { type: 'string' }, line: { type: 'number' }, char: { type: 'number' } }, ['file', 'line', 'char']) },
        { name: 'vscode_references', description: '查找引用', inputSchema: S({ file: { type: 'string' }, line: { type: 'number' }, char: { type: 'number' } }, ['file', 'line', 'char']) },
        { name: 'vscode_symbols', description: '工作区符号搜索', inputSchema: S({ query: { type: 'string' } }, ['query']) },
        { name: 'vscode_open', description: 'IDE 内打开文件并定位(可选 line/char·与我操作自己编辑器对等)', inputSchema: S({ file: { type: 'string' }, line: { type: 'number' }, char: { type: 'number' } }, ['file']) },
        { name: 'vscode_active', description: '读取当前活动编辑器(文件/语言/选区/可见范围/选中文本)', inputSchema: S({}) },
        // browser_* 升级 · Playwright/Chrome-DevTools-MCP 级 (CDP 原生)
        { name: 'browser_snapshot', description: '页面可交互元素快照(带 ref·供后续 click/type 定位·Playwright 式)', inputSchema: S({ targetId: { type: 'string' } }) },
        { name: 'browser_click', description: '点击(ref|selector|x,y|nx,ny·CDP 可信事件)', inputSchema: S({ ref: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, nx: { type: 'number' }, ny: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, clickCount: { type: 'number' }, doubleClick: { type: 'boolean' }, targetId: { type: 'string' } }) },
        { name: 'browser_type', description: '输入文本到元素(ref|selector;clear 先清空;submit 回车)', inputSchema: S({ text: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' }, targetId: { type: 'string' } }, ['text']) },
        { name: 'browser_hover', description: '悬停到元素/坐标', inputSchema: S({ ref: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, nx: { type: 'number' }, ny: { type: 'number' }, targetId: { type: 'string' } }) },
        { name: 'browser_select', description: '下拉框选项(ref|selector + values[])', inputSchema: S({ ref: { type: 'string' }, selector: { type: 'string' }, values: { type: 'array' }, value: { type: 'string' }, targetId: { type: 'string' } }) },
        { name: 'browser_press_key', description: '按特殊键(Enter/Tab/Escape/Arrow*/Backspace/Delete/Home/End/PageUp/PageDown/Space)', inputSchema: S({ key: { type: 'string' }, targetId: { type: 'string' } }, ['key']) },
        { name: 'browser_scroll', description: '滚动(ref|selector|nx,ny 定位点·dx/dy 像素)', inputSchema: S({ dx: { type: 'number' }, dy: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, nx: { type: 'number' }, ny: { type: 'number' }, targetId: { type: 'string' } }) },
        { name: 'browser_wait', description: '等待(selector 出现/消失 | text 出现 | ms 固定;timeout 上限)', inputSchema: S({ selector: { type: 'string' }, text: { type: 'string' }, ms: { type: 'number' }, gone: { type: 'boolean' }, timeout: { type: 'number' }, targetId: { type: 'string' } }) },
        { name: 'browser_back', description: '后退', inputSchema: S({ targetId: { type: 'string' } }) },
        { name: 'browser_forward', description: '前进', inputSchema: S({ targetId: { type: 'string' } }) },
        { name: 'browser_reload', description: '刷新(hard 忽略缓存)', inputSchema: S({ hard: { type: 'boolean' }, targetId: { type: 'string' } }) },
        { name: 'browser_get_text', description: '取页面/元素可见文本(innerText)', inputSchema: S({ selector: { type: 'string' }, max: { type: 'number' }, targetId: { type: 'string' } }) },
        { name: 'browser_get_html', description: '取页面/元素 HTML(outer 取 outerHTML)', inputSchema: S({ selector: { type: 'string' }, outer: { type: 'boolean' }, max: { type: 'number' }, targetId: { type: 'string' } }) },
        { name: 'browser_console', description: '取页面 console 日志(钩子缓冲·clear 清空)', inputSchema: S({ limit: { type: 'number' }, clear: { type: 'boolean' }, targetId: { type: 'string' } }) },
        { name: 'browser_network', description: '取页面网络请求(fetch/XHR 钩子缓冲·clear 清空)', inputSchema: S({ limit: { type: 'number' }, clear: { type: 'boolean' }, targetId: { type: 'string' } }) },
        { name: 'browser_tabs', description: '标签页 list/new/select/close', inputSchema: S({ action: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, url: { type: 'string' }, targetId: { type: 'string' } }) },
        { name: 'browser_upload', description: '给文件输入框设置文件(本机绝对路径)', inputSchema: S({ ref: { type: 'string' }, selector: { type: 'string' }, files: { type: 'array' }, file: { type: 'string' }, targetId: { type: 'string' } }) },
        { name: 'browser_drag', description: '拖拽(from*→to*·ref/selector/x,y/nx,ny)', inputSchema: S({ fromRef: { type: 'string' }, fromSelector: { type: 'string' }, fromX: { type: 'number' }, fromY: { type: 'number' }, fromNx: { type: 'number' }, fromNy: { type: 'number' }, toRef: { type: 'string' }, toSelector: { type: 'string' }, toX: { type: 'number' }, toY: { type: 'number' }, toNx: { type: 'number' }, toNy: { type: 'number' }, targetId: { type: 'string' } }) },
        { name: 'browser_close', description: '关闭标签页(targetId)', inputSchema: S({ targetId: { type: 'string' } }, ['targetId']) },
        { name: 'browser_emulate', description: '设备视口模拟(对照手机·responsive 布局): device=iphone|pixel|ipad 预设, 或自定义 width/height/mobile/deviceScaleFactor/touch; 视口+触摸持久生效(含跨导航), 完整 UA/请求头模拟需常驻会话暂未提供; reset=true 还原', inputSchema: S({ device: { type: 'string', enum: ['iphone', 'pixel', 'ipad'] }, width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, touch: { type: 'boolean' }, reset: { type: 'boolean' }, targetId: { type: 'string' } }) },
        { name: 'browser_cookies', description: 'Cookie 读写(登录态续用): action=get|set|clear|delete', inputSchema: S({ action: { type: 'string', enum: ['get', 'set', 'clear', 'delete'] }, urls: { type: 'array' }, cookies: { type: 'array' }, name: { type: 'string' }, url: { type: 'string' }, domain: { type: 'string' }, path: { type: 'string' }, targetId: { type: 'string' } }) },
        { name: 'browser_pdf', description: '整页导出 PDF(Page.printToPDF·传 path 落盘)', inputSchema: S({ path: { type: 'string' }, landscape: { type: 'boolean' }, background: { type: 'boolean' }, targetId: { type: 'string' } }) },
        { name: 'browser_fill_form', description: '批量填表单(一发填多字段·对照 Chrome-DevTools-MCP fill_form·省去逐字段 type): fields=[{ref|selector,value}] — 文本框写值/复选框勾选(value 真/假)/单选选中(value=该项 value)/下拉选项(value 字串或数组); 可选 submit=在首字段处回车提交', inputSchema: S({ fields: { type: 'array' }, submit: { type: 'boolean' }, targetId: { type: 'string' } }, ['fields']) },
        // pc_* 补全 (整机对等)
        { name: 'pc_drag', description: '整机鼠标拖拽(归一化坐标 from→to)', inputSchema: S({ fromNx: { type: 'number' }, fromNy: { type: 'number' }, toNx: { type: 'number' }, toNy: { type: 'number' }, button: { type: 'string' } }, ['fromNx', 'fromNy', 'toNx', 'toNy']) },
        { name: 'pc_key_combo', description: '整机组合键(vks=Windows 虚拟键码数组·依次按下逆序抬起·如 [17,67]=Ctrl+C)', inputSchema: S({ vks: { type: 'array' } }, ['vks']) },
        { name: 'pc_clipboard', description: '剪贴板读/写(给 text 即写, 否则读)', inputSchema: S({ text: { type: 'string' } }) },
        { name: 'pc_ui_tree', description: '整机窗口 UI Automation 控件树 JSON(name/type/aid/坐标)·缺省取前台窗口·可指定 title(模糊)或 pid·depth 深度·cap 节点上限', inputSchema: S({ title: { type: 'string' }, pid: { type: 'number' }, depth: { type: 'number' }, cap: { type: 'number' } }) },
        { name: 'pc_activate', description: '激活/前置整机窗口(SW_RESTORE+SetForegroundWindow)·按 title(模糊)或 pid', inputSchema: S({ title: { type: 'string' }, pid: { type: 'number' } }) },
        // plugin_* 补全 (软件本体·公开所有端口 + 热修)
        { name: 'plugin_api', description: '直通插件任意 /api/* 端点(公开所有端口·route 必以 /api/ 开头)', inputSchema: S({ route: { type: 'string' }, method: { type: 'string' }, body: { type: 'object' }, query: { type: 'object' } }, ['route']) },
        { name: 'plugin_reload', description: '热修: 重载扩展宿主窗口(慎用·会重启当前 IDE 窗口加载新码)', inputSchema: S({ confirm: { type: 'boolean' } }) },
    ];
}

// plugin_git 自给自足 · 直取仓库状态(childProcess git CLI·workspace 根)。
//   杜绝依赖 /api/git/status 路由是否存在或 vscode.git 扩展是否激活(旧病灶: 旧版无此路由→透传上游 404)。
function daoGitStatusViaCli() {
    const root = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].uri.fsPath) || process.cwd();
    const run = (args) => { try { return String(childProcess.execSync('git ' + args, { cwd: root, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch (e) { return ''; } };
    if (run('rev-parse --is-inside-work-tree') !== 'true') return { error: 'not a git repo', root };
    const porcelain = run('status --porcelain');
    const lines = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
    let staged = 0, changes = 0, untracked = 0, conflicts = 0;
    for (const l of lines) {
        if (l.startsWith('??')) { untracked++; continue; }
        const x = l[0], y = l[1];
        if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { conflicts++; continue; }
        if (x !== ' ' && x !== '?') staged++;
        if (y !== ' ' && y !== '?') changes++;
    }
    let ahead = 0, behind = 0;
    const ab = run('rev-list --left-right --count @{upstream}...HEAD');
    if (ab) { const m = ab.split(/\s+/); behind = parseInt(m[0], 10) || 0; ahead = parseInt(m[1], 10) || 0; }
    return { head: run('rev-parse --abbrev-ref HEAD'), ahead, behind, changes, staged, untracked, mergeConflicts: conflicts, root };
}

async function daoMcpCallTool(name, a) {
    a = a || {};
    switch (name) {
        // ── pc_* ──
        case 'pc_exec': { const r = await daoMcpInvoke('/api/exec', { cmd: a.cmd, type: 'terminal', cwd: a.cwd, timeout: a.timeout }); return daoMcpText(r && r.stdout !== undefined ? r.stdout : r); }
        case 'pc_screenshot': { const b64 = await pcGuiCap(daoClamp(a.scale, 10, 100, 60), daoClamp(a.quality, 20, 95, 55)); return daoMcpImage(b64, 'image/jpeg'); }
        case 'pc_click': { const ok = pcGuiInput({ op: 'btn', nx: a.nx, ny: a.ny, button: a.button || 'left', action: a.action || 'click' }); return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable'); }
        case 'pc_move': { const ok = pcGuiInput({ op: 'move', nx: a.nx, ny: a.ny }); return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable'); }
        case 'pc_scroll': { const ok = pcGuiInput({ op: 'scroll', nx: a.nx, ny: a.ny, dy: a.dy }); return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable'); }
        case 'pc_type': { const ok = pcGuiInput({ op: 'text', s: String(a.text == null ? '' : a.text) }); return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable'); }
        case 'pc_key': {
            const vk = parseInt(String(a.vk), 10); if (!isFinite(vk)) return daoMcpErr('vk required (number)');
            const act = a.action || 'press';
            if (act === 'down' || act === 'up') { const ok = pcGuiInput({ op: 'key', vk, down: act === 'down' }); return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable'); }
            const d = pcGuiInput({ op: 'key', vk, down: true }); const u = pcGuiInput({ op: 'key', vk, down: false }); return (d && u) ? daoMcpText('ok') : daoMcpErr('gui-unavailable');
        }
        case 'pc_file_read': { const r = await daoMcpInvoke('/api/file', null, { path: a.path }); return daoMcpText(r && r.content !== undefined ? r.content : r); }
        case 'pc_file_write': { const r = await daoMcpInvoke('/api/write', { path: a.path, content: a.content }); return daoMcpText(r); }
        case 'pc_ls': { const r = await daoMcpInvoke('/api/ls', null, a.path ? { path: a.path } : undefined); return daoMcpText(r); }
        // ── plugin_* ──
        case 'plugin_health': return daoMcpText(await daoMcpInvoke('/api/health'));
        case 'plugin_exec': { const r = await daoMcpInvoke('/api/exec', { cmd: a.cmd, type: 'terminal', cwd: a.cwd, timeout: a.timeout }); return daoMcpText(r && r.stdout !== undefined ? r.stdout : r); }
        case 'plugin_ls': return daoMcpText(await daoMcpInvoke('/api/ls', null, a.path ? { path: a.path } : undefined));
        case 'plugin_file': { const r = await daoMcpInvoke('/api/file', null, { path: a.path }); return daoMcpText(r && r.content !== undefined ? r.content : r); }
        case 'plugin_write': return daoMcpText(await daoMcpInvoke('/api/write', { path: a.path, content: a.content }));
        case 'plugin_edit': return daoMcpText(await daoMcpInvoke('/api/edit', { file: a.file, edits: a.edits }));
        case 'plugin_search': return daoMcpText(await daoMcpInvoke('/api/search', { pattern: a.pattern, exclude: a.exclude, maxResults: a.maxResults }));
        case 'plugin_terminal': {
            if (a.terminalId) return daoMcpText(await daoMcpInvoke('/api/terminal/send', { terminalId: a.terminalId, text: a.text }));
            const r = await daoMcpInvoke('/api/terminal/create', { name: a.name, cwd: a.cwd });
            if (a.text && r && r.terminalId) { await daoMcpInvoke('/api/terminal/send', { terminalId: r.terminalId, text: a.text }); }
            return daoMcpText(r);
        }
        case 'plugin_git': {
            let viaApi: any = null;
            try { viaApi = await daoMcpInvoke('/api/git/status'); } catch (e) { /* 守柔 → 回退 CLI */ }
            if (viaApi && !viaApi._proxy && !viaApi.error) return daoMcpText(viaApi);
            return daoMcpText(daoGitStatusViaCli());
        }
        case 'plugin_tools': return daoMcpText(await daoMcpInvoke('/api/tools', { tool: a.tool, args: a.args || {} }));
        // ── vscode_* ──
        case 'vscode_command': return daoMcpText(await daoMcpInvoke('/api/command', { command: a.command, args: a.args || [] }));
        case 'vscode_commands': return daoMcpText(await daoMcpInvoke('/api/commands'));
        case 'vscode_diagnostics': return daoMcpText(await daoMcpInvoke('/api/diagnostics'));
        case 'vscode_definitions': return daoMcpText(await daoMcpInvoke('/api/definitions', { file: a.file, line: a.line, char: a.char }));
        case 'vscode_references': return daoMcpText(await daoMcpInvoke('/api/references', { file: a.file, line: a.line, char: a.char }));
        case 'vscode_symbols': return daoMcpText(await daoMcpInvoke('/api/symbols', { query: a.query }));
        // ── browser_* (Chrome CDP) ──
        case 'browser_launch': return daoMcpText(await daoCdpEnsureChrome());
        case 'browser_targets': { await daoCdpEnsureChrome(); const list = await daoCdpHttpGet('/json/list') || []; return daoMcpText(list.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url, active: t.id === daoCdpActiveTarget }))); }
        case 'browser_activate': {
            if (!a.targetId) return daoMcpErr('targetId required');
            const t = await daoCdpPickPage(a.targetId); // 校验存在 + 记为当前页
            try { const ver = await daoCdpHttpGet('/json/version'); await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.activateTarget', params: { targetId: a.targetId } }]); } catch (e) { /* 前台化失败不阻断·当前页已记 */ }
            return daoMcpText({ active: t.id, url: t.url });
        }
        case 'browser_navigate': {
            if (!a.url) return daoMcpErr('url required');
            if (a.targetId) { const t = await daoCdpPickPage(a.targetId); await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Page.enable' }, { method: 'Page.navigate', params: { url: a.url } }]); daoCdpActiveTarget = a.targetId; return daoMcpText({ targetId: a.targetId, url: a.url }); }
            const ver = await daoCdpEnsureChrome(); const r = await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.createTarget', params: { url: a.url } }]); if (r && r.targetId) daoCdpActiveTarget = r.targetId; return daoMcpText({ targetId: r && r.targetId, url: a.url });
        }
        case 'browser_eval': {
            if (!a.code) return daoMcpErr('code required');
            const t = await daoCdpPickPage(a.targetId);
            const r = await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Runtime.evaluate', params: { expression: a.code, returnByValue: true, awaitPromise: true } }]);
            if (r && r.exceptionDetails) return daoMcpErr('eval: ' + JSON.stringify(r.exceptionDetails));
            const ro = r && r.result; const val = ro ? (ro.value !== undefined ? ro.value : (ro.description !== undefined ? ro.description : ro.type)) : undefined;
            return daoMcpText(val === undefined ? 'undefined' : val);
        }
        case 'browser_screenshot': {
            const t = await daoCdpPickPage(a.targetId); const fmt = a.format === 'png' ? 'png' : 'jpeg';
            const params = fmt === 'jpeg' ? { format: 'jpeg', quality: daoClamp(a.quality, 10, 95, 60) } : { format: 'png' };
            const r = await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Page.enable' }, { method: 'Page.captureScreenshot', params }]);
            if (!r || !r.data) return daoMcpErr('screenshot-empty');
            return daoMcpImage(r.data, fmt === 'png' ? 'image/png' : 'image/jpeg');
        }
        // ── browser_* 升级 (CDP 原生·Playwright/Chrome-MCP 级) ──
        case 'browser_snapshot': { const t = await daoCdpPickPage(a.targetId); return daoMcpText(await daoCdpEvalT(t, daoBExpr('window.__daoB.snapshot()'))); }
        case 'browser_click': { const t = await daoCdpPickPage(a.targetId); const xy = await daoBResolveXY(t, a); const cc = a.clickCount || (a.doubleClick ? 2 : 1); await daoCdpClickXY(t, xy.x, xy.y, a.button, cc); return daoMcpText({ clicked: xy, clickCount: cc }); }
        case 'browser_type': {
            const t = await daoCdpPickPage(a.targetId); const sel = a.ref || a.selector;
            if (sel) { if (a.clear) await daoCdpEvalT(t, daoBExpr('window.__daoB.setValue(' + JSON.stringify(sel) + ',"")')); const ok = await daoCdpEvalT(t, daoBExpr('window.__daoB.focus(' + JSON.stringify(sel) + ')')); if (!ok) return daoMcpErr('element-not-found/focusable: ' + sel); }
            await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Input.insertText', params: { text: String(a.text == null ? '' : a.text) } }]);
            if (a.submit) await daoCdpKey(t, 'Enter');
            return daoMcpText('ok');
        }
        case 'browser_hover': { const t = await daoCdpPickPage(a.targetId); const xy = await daoBResolveXY(t, a); await daoCdpMouse(t, 'mouseMoved', xy.x, xy.y); return daoMcpText({ hover: xy }); }
        case 'browser_select': { const t = await daoCdpPickPage(a.targetId); const sel = a.ref || a.selector; if (!sel) return daoMcpErr('ref|selector required'); const vals = Array.isArray(a.values) ? a.values : (a.value != null ? [a.value] : []); const n = await daoCdpEvalT(t, daoBExpr('window.__daoB.selectOption(' + JSON.stringify(sel) + ',' + JSON.stringify(vals) + ')')); return daoMcpText({ selected: n }); }
        case 'browser_press_key': { const t = await daoCdpPickPage(a.targetId); if (!a.key) return daoMcpErr('key required'); await daoCdpKey(t, String(a.key)); return daoMcpText('ok'); }
        case 'browser_scroll': { const t = await daoCdpPickPage(a.targetId); let xy; if (a.ref || a.selector || a.x !== undefined || a.nx !== undefined) { xy = await daoBResolveXY(t, a); } else { const vp = await daoCdpEvalT(t, '({w:innerWidth,h:innerHeight})'); xy = { x: Math.round(((vp && vp.w) || 600) / 2), y: Math.round(((vp && vp.h) || 600) / 2) }; } await daoCdpMouse(t, 'mouseWheel', xy.x, xy.y, { deltaX: +(a.dx || 0), deltaY: +(a.dy || 0) }); return daoMcpText('ok'); }
        case 'browser_wait': {
            const t = await daoCdpPickPage(a.targetId);
            if (a.ms !== undefined) { await daoMcpSleep(daoClamp(a.ms, 0, 60000, 0)); return daoMcpText('waited'); }
            const to = daoClamp(a.timeout, 100, 60000, 8000); const start = Date.now();
            while (Date.now() - start < to) {
                let ok = false;
                if (a.selector) { const ex = await daoCdpEvalT(t, daoBExpr('window.__daoB.exists(' + JSON.stringify(a.selector) + ')')); ok = a.gone ? !ex : !!ex; }
                else if (a.text) { const tx = await daoCdpEvalT(t, '(document.body&&document.body.innerText||"")'); const has = String(tx).indexOf(a.text) >= 0; ok = a.gone ? !has : has; }
                else return daoMcpErr('need selector|text|ms');
                if (ok) return daoMcpText('ok');
                await daoMcpSleep(250);
            }
            return daoMcpErr('wait-timeout');
        }
        case 'browser_back': { const t = await daoCdpPickPage(a.targetId); await daoCdpEvalT(t, 'history.back()'); return daoMcpText('ok'); }
        case 'browser_forward': { const t = await daoCdpPickPage(a.targetId); await daoCdpEvalT(t, 'history.forward()'); return daoMcpText('ok'); }
        case 'browser_reload': { const t = await daoCdpPickPage(a.targetId); await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Page.enable' }, { method: 'Page.reload', params: { ignoreCache: !!a.hard } }]); return daoMcpText('ok'); }
        case 'browser_get_text': { const t = await daoCdpPickPage(a.targetId); const tx = await daoCdpEvalT(t, daoBExpr('window.__daoB.text(' + JSON.stringify(a.selector || '') + ')')); return daoMcpText(String(tx || '').slice(0, daoClamp(a.max, 100, 200000, 20000))); }
        case 'browser_get_html': { const t = await daoCdpPickPage(a.targetId); const h = await daoCdpEvalT(t, daoBExpr('window.__daoB.html(' + JSON.stringify(a.selector || '') + ',' + (a.outer ? 'true' : 'false') + ')')); return daoMcpText(String(h || '').slice(0, daoClamp(a.max, 100, 500000, 50000))); }
        case 'browser_console': { const t = await daoCdpPickPage(a.targetId); const logs = await daoCdpEvalT(t, daoBExpr('(window.__daoB.logs||[]).slice(-' + daoClamp(a.limit, 1, 300, 80) + ')')); if (a.clear) await daoCdpEvalT(t, daoBExpr('(window.__daoB.logs.length=0),"ok"')); return daoMcpText(logs); }
        case 'browser_network': { const t = await daoCdpPickPage(a.targetId); const net = await daoCdpEvalT(t, daoBExpr('(window.__daoB.net||[]).slice(-' + daoClamp(a.limit, 1, 300, 80) + ')')); if (a.clear) await daoCdpEvalT(t, daoBExpr('(window.__daoB.net.length=0),"ok"')); return daoMcpText(net); }
        case 'browser_tabs': {
            const act = a.action || 'list';
            if (act === 'list') { await daoCdpEnsureChrome(); const list = await daoCdpHttpGet('/json/list') || []; return daoMcpText(list.filter((x) => x.type === 'page').map((x) => ({ id: x.id, title: x.title, url: x.url, active: x.id === daoCdpActiveTarget }))); }
            const ver = await daoCdpEnsureChrome();
            if (act === 'new') { const r = await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.createTarget', params: { url: a.url || 'about:blank' } }]); if (r && r.targetId) daoCdpActiveTarget = r.targetId; return daoMcpText({ targetId: r && r.targetId }); }
            if (!a.targetId) return daoMcpErr('targetId required for ' + act);
            if (act === 'select') { await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.activateTarget', params: { targetId: a.targetId } }]); daoCdpActiveTarget = a.targetId; return daoMcpText('ok'); }
            if (act === 'close') { await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.closeTarget', params: { targetId: a.targetId } }]); if (daoCdpActiveTarget === a.targetId) daoCdpActiveTarget = null; return daoMcpText('ok'); }
            return daoMcpErr('unknown action: ' + act);
        }
        case 'browser_upload': {
            const t = await daoCdpPickPage(a.targetId); const sel = a.ref || a.selector;
            if (!sel) return daoMcpErr('ref|selector required');
            const files = Array.isArray(a.files) ? a.files : (a.file ? [a.file] : []);
            if (!files.length) return daoMcpErr('files required');
            const exists = await daoCdpEvalT(t, daoBExpr('window.__daoB.exists(' + JSON.stringify(sel) + ')'));
            if (!exists) return daoMcpErr('element-not-found: ' + sel);
            // 解析节点 objectId 与 setFileInputFiles 必须同一 CDP 会话(否则 objectId 失效→"Could not find object with given id")。
            //   故用 params 函数把第 2 条 eval 拿到的 objectId 串接给第 3 条, 全在一个 ws 内完成。
            await daoCdpBatch(t.webSocketDebuggerUrl, [
                { method: 'DOM.enable' },
                { method: 'Runtime.evaluate', params: { expression: daoBExpr('window.__daoB.el(' + JSON.stringify(sel) + ')'), returnByValue: false } },
                { method: 'DOM.setFileInputFiles', params: (res) => ({ files, objectId: (res[1] && res[1].result && res[1].result.objectId) || '' }) },
            ]);
            return daoMcpText({ uploaded: files });
        }
        case 'browser_emulate': {
            const t = await daoCdpPickPage(a.targetId);
            if (a.reset) {
                // 实测: 无状态短连里, 由「已亡会话」设下的设备度量覆写是孤儿态——新连的 clearDeviceMetricsOverride / width:0 皆无法清除它;
                //   但新连的「setDeviceMetricsOverride(新值)」可全局覆盖生效。故 reset 先以桌面度量覆盖(可靠复位桌面布局),
                //   再于同一会话内 clear(此时本会话拥有该覆写, clear 可真正移除 → 回归原生); 二者叠加确保稳定复位。
                const rw = Math.round(+(a.width || 1280)); const rh = Math.round(+(a.height || 800));
                await daoCdpBatch(t.webSocketDebuggerUrl, [
                    { method: 'Emulation.setDeviceMetricsOverride', params: { width: rw, height: rh, deviceScaleFactor: 1, mobile: false } },
                    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
                    { method: 'Emulation.clearDeviceMetricsOverride' },
                ]);
                return daoMcpText({ reset: { width: rw, height: rh }, note: '已复位桌面视口(默认 1280×800·可传 width/height 自定义)' });
            }
            const presets = {
                iphone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
                pixel: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true },
                ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
            };
            const p = (a.device && presets[a.device]) || {};
            const width = Math.round(+(a.width || p.width || 390)); const height = Math.round(+(a.height || p.height || 844));
            const mobile = a.mobile != null ? !!a.mobile : (p.mobile != null ? p.mobile : true);
            const dsf = +(a.deviceScaleFactor || p.deviceScaleFactor || 2); const touch = mobile || !!a.touch;
            // 经 live 实测: 设备度量(视口宽高)与触摸是「页面级」覆写, 跨「无状态短连 daoCdpBatch」与跨导航持久生效。
            //   而 UA/精确 DPR(setUserAgentOverride / addScriptToEvaluateOnNewDocument)是「会话级」, daoCdpBatch 连接一断即被 Chrome 清除 → 不持久。
            //   故 emulate 只承诺可靠落地的「视口 + 触摸」(覆盖 responsive 布局类移动端核验); 完整 UA/请求头模拟需常驻会话(后续螺旋), 此处据实标注、不虚报。
            await daoCdpBatch(t.webSocketDebuggerUrl, [
                { method: 'Emulation.setDeviceMetricsOverride', params: { width, height, deviceScaleFactor: dsf, mobile } },
                { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: touch } },
            ]);
            return daoMcpText({ emulated: { device: a.device || null, width, height, mobile, touch, deviceScaleFactor: dsf }, note: '视口+触摸持久生效(含跨导航); UA/请求头模拟需常驻 CDP 会话, 暂未提供' });
        }
        case 'browser_cookies': {
            const t = await daoCdpPickPage(a.targetId); const act = a.action || 'get';
            if (act === 'get') { const r = await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Network.enable' }, { method: 'Network.getCookies', params: Array.isArray(a.urls) ? { urls: a.urls } : {} }]); return daoMcpText((r && r.cookies) || []); }
            if (act === 'set') { const list = Array.isArray(a.cookies) ? a.cookies : (a.cookie ? [a.cookie] : []); if (!list.length) return daoMcpErr('cookies required (数组·每项含 name/value, 及 url 或 domain+path)'); await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Network.enable' }, { method: 'Network.setCookies', params: { cookies: list } }]); return daoMcpText({ set: list.length }); }
            if (act === 'clear') { await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Network.enable' }, { method: 'Network.clearBrowserCookies' }]); return daoMcpText('cleared'); }
            if (act === 'delete') { if (!a.name) return daoMcpErr('name required'); await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Network.enable' }, { method: 'Network.deleteCookies', params: { name: a.name, url: a.url, domain: a.domain, path: a.path } }]); return daoMcpText('deleted'); }
            return daoMcpErr('unknown action: ' + act);
        }
        case 'browser_pdf': {
            const t = await daoCdpPickPage(a.targetId);
            const r = await daoCdpBatch(t.webSocketDebuggerUrl, [{ method: 'Page.enable' }, { method: 'Page.printToPDF', params: { printBackground: a.background !== false, landscape: !!a.landscape, preferCSSPageSize: true } }], 60000);
            if (!r || !r.data) return daoMcpErr('pdf-empty');
            if (a.path) { try { const buf = Buffer.from(r.data, 'base64'); fs.writeFileSync(a.path, buf); return daoMcpText({ saved: a.path, bytes: buf.length }); } catch (e) { return daoMcpErr('write: ' + (e && e.message)); } }
            return daoMcpText({ base64Len: r.data.length, hint: '传 path 可直接落盘为 PDF' });
        }
        case 'browser_fill_form': {
            const t = await daoCdpPickPage(a.targetId);
            const fields = Array.isArray(a.fields) ? a.fields : [];
            if (!fields.length) return daoMcpErr('fields required (数组·每项含 ref|selector + value)');
            const res = await daoCdpEvalT(t, daoBExpr('window.__daoB.fillForm(' + JSON.stringify(fields) + ')'));
            if (a.submit) { const first = fields[0] || {}; const sel = first.ref || first.selector; if (sel) { await daoCdpEvalT(t, daoBExpr('window.__daoB.focus(' + JSON.stringify(sel) + ')')); await daoCdpKey(t, 'Enter'); } }
            return daoMcpText(res);
        }
        case 'browser_drag': {
            const t = await daoCdpPickPage(a.targetId);
            const from = await daoBResolveXY(t, { ref: a.fromRef, selector: a.fromSelector, x: a.fromX, y: a.fromY, nx: a.fromNx, ny: a.fromNy });
            const to = await daoBResolveXY(t, { ref: a.toRef, selector: a.toSelector, x: a.toX, y: a.toY, nx: a.toNx, ny: a.toNy });
            await daoCdpMouse(t, 'mouseMoved', from.x, from.y);
            await daoCdpMouse(t, 'mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
            const steps = 8; for (let i = 1; i <= steps; i++) { await daoCdpMouse(t, 'mouseMoved', Math.round(from.x + (to.x - from.x) * i / steps), Math.round(from.y + (to.y - from.y) * i / steps), { buttons: 1 }); await daoMcpSleep(20); }
            await daoCdpMouse(t, 'mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
            return daoMcpText({ from, to });
        }
        case 'browser_close': { if (!a.targetId) return daoMcpErr('targetId required'); const ver = await daoCdpEnsureChrome(); await daoCdpBatch(ver.webSocketDebuggerUrl, [{ method: 'Target.closeTarget', params: { targetId: a.targetId } }]); return daoMcpText('ok'); }
        // ── pc_* 补全 ──
        case 'pc_drag': {
            if (a.fromNx == null || a.fromNy == null || a.toNx == null || a.toNy == null) return daoMcpErr('fromNx,fromNy,toNx,toNy required');
            const btn = a.button || 'left';
            pcGuiInput({ op: 'move', nx: a.fromNx, ny: a.fromNy }); pcGuiInput({ op: 'btn', nx: a.fromNx, ny: a.fromNy, button: btn, action: 'down' });
            const steps = 8; for (let i = 1; i <= steps; i++) { pcGuiInput({ op: 'move', nx: a.fromNx + (a.toNx - a.fromNx) * i / steps, ny: a.fromNy + (a.toNy - a.fromNy) * i / steps }); await daoMcpSleep(20); }
            const ok = pcGuiInput({ op: 'btn', nx: a.toNx, ny: a.toNy, button: btn, action: 'up' });
            return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable');
        }
        case 'pc_key_combo': {
            const vks = Array.isArray(a.vks) ? a.vks.map((x) => parseInt(String(x), 10)).filter((n) => isFinite(n)) : [];
            if (!vks.length) return daoMcpErr('vks (array of windows VK codes) required');
            for (const vk of vks) pcGuiInput({ op: 'key', vk, down: true });
            let ok = true; for (let i = vks.length - 1; i >= 0; i--) { ok = pcGuiInput({ op: 'key', vk: vks[i], down: false }) && ok; }
            return ok ? daoMcpText('ok') : daoMcpErr('gui-unavailable');
        }
        case 'pc_clipboard': { if (a.text !== undefined) { await vscode.env.clipboard.writeText(String(a.text)); return daoMcpText('ok'); } return daoMcpText(await vscode.env.clipboard.readText()); }
        case 'pc_ui_tree': {
            const f = daoWriteB64Script('dao-uia-tree.ps1', PC_UIA_TREE_PS_B64);
            const args = [];
            if (a.title) args.push('-title', String(a.title));
            if (a.pid) args.push('-pid_', String(parseInt(a.pid, 10) || 0));
            args.push('-depth', String(daoClamp(a.depth, 1, 12, 4)));
            args.push('-cap', String(daoClamp(a.cap, 10, 1000, 200)));
            try { const out = daoRunPwshFile(f, args, 25000); try { return daoMcpText(JSON.parse(out)); } catch (eP) { return daoMcpText(out.trim()); } }
            catch (e) { return daoMcpErr('pc_ui_tree: ' + (e && e.message || e)); }
        }
        case 'pc_activate': {
            if (!a.title && !a.pid) return daoMcpErr('pc_activate: title 或 pid 必填');
            const f = daoWriteB64Script('dao-activate.ps1', PC_ACTIVATE_PS_B64);
            const args = [];
            if (a.title) args.push('-title', String(a.title));
            if (a.pid) args.push('-pid_', String(parseInt(a.pid, 10) || 0));
            try { const out = daoRunPwshFile(f, args, 12000); try { return daoMcpText(JSON.parse(out)); } catch (eP) { return daoMcpText(out.trim()); } }
            catch (e) { return daoMcpErr('pc_activate: ' + (e && e.message || e)); }
        }
        // ── plugin_* 补全 (软件本体·公开所有端口 + 热修) ──
        case 'plugin_api': { const route = String(a.route || ''); if (!route.startsWith('/api/')) return daoMcpErr('route must start with /api/'); const m = (a.method || (a.body !== undefined ? 'POST' : 'GET')).toUpperCase(); const body = a.body !== undefined ? a.body : (m === 'POST' ? {} : null); return daoMcpText(await daoMcpInvoke(route, body, a.query)); }
        case 'plugin_reload': { if (!a.confirm) return daoMcpErr('plugin_reload 会重启当前 IDE 窗口·须传 {confirm:true} 明确确认'); setTimeout(() => { try { vscode.commands.executeCommand('workbench.action.reloadWindow'); } catch (e) { /* 守柔 */ } }, 400); return daoMcpText('reload-scheduled (400ms)'); }
        // ── vscode_* 补全 (与我操作自己编辑器对等) ──
        case 'vscode_open': {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.file));
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (a.line != null) { const pos = new vscode.Position(Math.max(0, a.line | 0), Math.max(0, (a.char | 0))); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
            return daoMcpText({ opened: a.file, lineCount: doc.lineCount, languageId: doc.languageId });
        }
        case 'vscode_active': {
            const ed = vscode.window.activeTextEditor; if (!ed) return daoMcpText({ active: null });
            const sel = ed.selection; const vr = ed.visibleRanges && ed.visibleRanges[0];
            return daoMcpText({ file: ed.document.uri.fsPath, languageId: ed.document.languageId, lineCount: ed.document.lineCount, selection: { start: { line: sel.start.line, char: sel.start.character }, end: { line: sel.end.line, char: sel.end.character } }, selectedText: ed.document.getText(sel).slice(0, 2000), visibleRange: vr ? { start: vr.start.line, end: vr.end.line } : null });
        }
        default: return daoMcpErr('unknown tool: ' + name);
    }
}

// MCP 服务版本/能力。
const DAO_MCP_PROTOCOL = '2024-11-05';
async function daoMcpProcessRpc(msg) {
    const id = (msg && msg.id !== undefined) ? msg.id : null;
    const method = msg && msg.method;
    // 通知(无 id) → 不回响应
    if (id === null && typeof method === 'string' && method.indexOf('notifications/') === 0) return null;
    try {
        if (method === 'initialize') {
            const pv = (msg.params && typeof msg.params.protocolVersion === 'string') ? msg.params.protocolVersion : DAO_MCP_PROTOCOL;
            return { jsonrpc: '2.0', id, result: { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DAO Bridge MCP', version: EXT_VERSION } } };
        }
        if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
        if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: daoMcpToolDefs() } };
        if (method === 'tools/call') {
            const nm = msg.params && msg.params.name; const args = (msg.params && msg.params.arguments) || {};
            if (!nm) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'missing tool name' } };
            let toolResult;
            try { toolResult = await daoMcpCallTool(String(nm), args); }
            catch (e) { toolResult = daoMcpErr((e && e.message) || String(e)); }
            return { jsonrpc: '2.0', id, result: toolResult };
        }
        if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
        if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
        if (id === null) return null; // 其余通知
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + String(method) } };
    } catch (e) {
        return { jsonrpc: '2.0', id, error: { code: -32603, message: (e && e.message) || String(e) } };
    }
}

// /mcp 入口 — Streamable HTTP: POST 一发一收 JSON; GET 无 SSE 返 405; 强制 Bearer 鉴权。
async function daoMcpHandle(req) {
    const jhead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    const method = (req && req.method) || 'GET';
    if (method === 'GET' || method === 'HEAD') {
        // 无服务端→客户端 SSE 流 → 按 MCP 规范返 405 (调用方据此走纯 POST), 但给出清晰 JSON 提示。
        return { _proxy: true, status: 405, contentType: 'application/json; charset=utf-8', headers: { ...jhead, 'Allow': 'POST, OPTIONS' }, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'DAO Bridge MCP: use HTTP POST (JSON-RPC). No GET SSE stream.' }, id: null }) };
    }
    if (method !== 'POST') {
        return { _proxy: true, status: 405, contentType: 'application/json; charset=utf-8', headers: { ...jhead, 'Allow': 'POST, OPTIONS' }, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null }) };
    }
    if (!checkAuth(req)) {
        return { _proxy: true, status: 401, contentType: 'application/json; charset=utf-8', headers: { ...jhead, 'WWW-Authenticate': 'Bearer' }, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }) };
    }
    let raw = '';
    try { raw = await readBody(req) || ''; } catch (e12) { raw = ''; }
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { return { _proxy: true, status: 400, contentType: 'application/json; charset=utf-8', headers: jhead, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }) }; }
    if (parsed === null) return { _proxy: true, status: 400, contentType: 'application/json; charset=utf-8', headers: jhead, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'empty request' }, id: null }) };
    if (Array.isArray(parsed)) {
        const out = [];
        for (const m of parsed) { const r = await daoMcpProcessRpc(m); if (r) out.push(r); }
        if (out.length === 0) return { _proxy: true, status: 202, contentType: 'application/json; charset=utf-8', headers: jhead, body: '' };
        return { _proxy: true, status: 200, contentType: 'application/json; charset=utf-8', headers: jhead, body: JSON.stringify(out) };
    }
    const resp = await daoMcpProcessRpc(parsed);
    if (!resp) return { _proxy: true, status: 202, contentType: 'application/json; charset=utf-8', headers: jhead, body: '' };
    return { _proxy: true, status: 200, contentType: 'application/json; charset=utf-8', headers: jhead, body: JSON.stringify(resp) };
}
// ═══ DAO-MCP-PAYLOAD end ═══

async function handleRouteInternal(route: string, url: URL, req: any, token: string, res?: any): Promise<any> {
    // 认证检查（relay请求也需认证，devin-cloud代理有自己的认证）
    // 归一 · 独立 HTTP 外壳须可被任意 IDE 内置浏览器/手机直接打开, 故 /shell 与 /api/shell/* 免 token
    //   (本地服务器默认仅绑 localhost; 远程经 DAO Bridge 隧道层把关)。
    // ── 归一 · 四大模块综合 MCP (Streamable HTTP · JSON-RPC) ──
    //   自带 Bearer 鉴权并返回规范 JSON-RPC, 故须在 needAuth / isAppProxyPassthrough 之前接管,
    //   否则 /mcp 被当作官网 SPA 路径透传到 app.devin.ai (旧病灶: 401/404 实为上游 uvicorn)。
    if (route === '/mcp' || route === '/mcp/') {
        return await daoMcpHandle(req);
    }

    const needAuth = !route.startsWith('/api/health') && !route.startsWith('/devin-cloud')
        && !route.startsWith('/shell') && !route.startsWith('/api/shell')
        && !route.startsWith('/i/')
        && !route.startsWith('/__web')
        && !isAppProxyPassthrough(route);
    if (needAuth && !checkAuth(req)) throw new Error('unauthorized');

    // ── 归一 · 公网整机投屏控制台 (任意环境浏览器登录即操控本机 · 参照手机 APK mirror) ──
    //   知其雄守其雌: 渲染层(解帧绘制)与输入捕获全在访问者设备浏览器, 隧道只搬帧字节+输入 JSON。
    //   整机控制面 → 强制 token (不随 /shell 免鉴权), 经 ?master_token= 或 Authorization Bearer 通过。
    //   必须在 isAppProxyPassthrough 之前处理, 否则 /m 被当作官网 SPA 路径透传到 app.devin.ai。
    if (route === '/m' || route === '/m/' || route === '/__mirror') {
        if (!checkAuth(req)) throw new Error('unauthorized');
        return { _proxy: true, status: 200, contentType: 'text/html; charset=utf-8', body: getMirrorPageHtml() };
    }

    // ── 归一 · 六大板块「单板块」网页直出 (127.0.0.1) ──
    //   IDE webview 框架层封禁 blob:/srcdoc 子帧 → 板块经此本地 HTTP 路由当 iframe 加载,
    //   服务端注入 acquireVsCodeApi 垫片(经 parent.postMessage __cwRelay 中继回宿主)。
    //   必须在 isAppProxyPassthrough 之前处理, 否则被当作官网 SPA 路径透传到 app.devin.ai。
    if (route === '/__board') {
        const board = url.searchParams.get('b') || 'overview';
        let html = '';
        try { html = getDaoCloudMiddlePanelHtml(getPanelState(), board) || ''; } catch (e) { html = ''; }
        const shim = '<script>(function(){var _s={};window.acquireVsCodeApi=function(){return{postMessage:function(m){try{parent.postMessage({__cwRelay:m,__board:'
            + JSON.stringify(board) + '},"*")}catch(e){}},getState:function(){return _s},setState:function(s){_s=s;return s}}};})();<\/script>';
        if (html) html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, '<head$1>' + shim) : shim + html;
        else html = '<!DOCTYPE html><meta charset="utf-8"><body style="background:#1e1e1e;color:#888;font:13px sans-serif;padding:16px">板块未就绪</body>';
        return { _proxy: true, status: 200, contentType: 'text/html; charset=utf-8', body: html };
    }

    // ── 归一 · 任意网页/搜索「站内代理」直出 (127.0.0.1) ──
    //   搜索/外站经此路由当 iframe 加载(剥 X-Frame-Options/CSP · 注入 base + 链接/表单拦截改写),
    //   复刻手机端 APK 的站内新标签搜索, 不再弹外部系统浏览器。必须在 isAppProxyPassthrough 之前处理。
    if (route === '/__web') {
        const target = url.searchParams.get('u') || '';
        if (!/^https?:\/\//i.test(target)) {
            return { _proxy: true, status: 400, contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html><meta charset="utf-8"><body style="background:#1e1e1e;color:#888;font:13px sans-serif;padding:16px">缺少或非法的 u 参数</body>' };
        }
        // 归一 · 站内网页「可操作」: 透传真实方法/请求体(表单/AJAX POST) + 逐源 Cookie 罐 →
        //   登录/提交/评论等站内操作不再失效(旧病灶: 只 GET 能搜, 一操作即断)。子资源(fetch/XHR)
        //   带 __sub=1 → 返原始字节不注壳, 仅顶层文档注入链接/表单/fetch/XHR 拦截桥。
        const _m = String((req && req.method) || 'GET').toUpperCase();
        const _isSub = url.searchParams.get('__sub') === '1';
        let _ctx: any = null;
        if (_m !== 'GET') {
            let _bodyBuf = Buffer.alloc(0);
            if (_m !== 'HEAD') { try { _bodyBuf = await readBodyBuffer(req); } catch (e) { _bodyBuf = Buffer.alloc(0); } }
            _ctx = { method: _m, body: _bodyBuf, contentType: String((req && req.headers && req.headers['content-type']) || ''), accept: String((req && req.headers && req.headers['accept']) || '') };
        }
        return await genericWebProxy(target, 0, _ctx, _isSub);
    }

    // ── 归一 · 拖拽上传桥数据源 (对齐手机 APK: 拖文件=上传该文件 / 拖会话=上传该会话 MD) ──
    //   网页内注入的 drop 桥与外壳同源, 落点后经此同源端点取字节 → 合成 File 喂入页面上传框。
    //   同一服务函数 daoServeBridgeRoute 亦注入 IDE 内多实例反代(devin_proxy)就地同源服务。
    if (route === '/__dlfile' || route === '/__convmd' || route === '/__daobridge.js') {
        const br = await daoServeBridgeRoute(route, url);
        if (br) return br;
    }

    // ── 归一 · 客户端持久缓存 Service Worker (根治「IDE 内官网路由慢」) ──
    //   VS Code webview 的 iframe 不持久化 HTTP 磁盘缓存 → 官网 SPA 每次重载/导航重取数百哈希分片。
    //   同源注册 SW(scope '/') · cache-first 仅缓存哈希不可变静态资产 → 重载零代理/零上游往返。
    if (route === '/__dao_sw.js') {
        return { _proxy: true, status: 200, contentType: 'application/javascript; charset=utf-8', body: daoCloudSwJs(), headers: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } };
    }

    // ── 归一 · 模型反代「单隧道直达」(/v1/* + /origin/revproxy/*) → 本源 Origin ──
    //   必须在 isAppProxyPassthrough 之前, 否则被当作官网 SPA 路径透传到 app.devin.ai。
    //   外壳页(静态 HTML)免 token 令远程浏览器先打开; 其余数据/推理面强制本体 Bearer
    //   (隧道边界鉴权 — 转发到 127.0.0.1 后本源 Origin 视其为本机, 故门禁须在此把关)。
    if (isRevproxyRoute(route)) {
        if (!isRevproxyConsoleShell(route) && !checkAuth(req)) throw new Error('unauthorized');
        return await forwardToRevproxyOrigin(route, url, req, res);
    }

    // 官网 SPA 根路径资源/接口 → 透传 app.devin.ai
    if (isAppProxyPassthrough(route)) {
        return await devinCloudProxyRoute('/devin-cloud' + route, url, req, 'devin', res);
    }

    // ── 归一 · 独立 HTTP 外壳 (适配所有 IDE / 任意浏览器 / 手机 · 参照手机端 APK) ──
    //   把 rt-flow 的多实例外壳直出为可在任意浏览器打开的单页, 传输层由 vscode.postMessage
    //   改走 HTTP: 页面→宿主 POST /api/shell/msg; 宿主→页面 SSE /api/shell/events。
    if (route === '/shell' || route === '/shell/' || route === '/api/shell/events' || route === '/api/shell/poll' || route === '/api/shell/msg') {
        const rtint: any = _rtflowModule && _rtflowModule._internals;
        if (route === '/shell' || route === '/shell/') {
            // 归一 · 自动识别手机/电脑浏览器并切换模式: 默认按 User-Agent 判定移动端;
            //   ?m=1 强制手机版、?m=0 强制电脑版 (供「切换 电脑/手机版」菜单项与用户手动覆盖)。
            const mOverride = url.searchParams.get('m');
            const ua = String((req && req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || '');
            const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile|webOS/i.test(ua);
            const mobile = mOverride === '1' ? true : (mOverride === '0' ? false : uaMobile);
            let html = '';
            try { html = (rtint && typeof rtint.getStandaloneShellHtml === 'function') ? rtint.getStandaloneShellHtml({ token: ws.token, port: ws.port, mobile }) : ''; } catch (e) { html = ''; }
            if (!html) html = '<!DOCTYPE html><meta charset="utf-8"><body style="font:14px sans-serif;padding:24px;background:#0e1116;color:#cdd3de">归一外壳未就绪 · rt-flow 多实例模块未加载</body>';
            return { _proxy: true, status: 200, contentType: 'text/html; charset=utf-8', body: html };
        }
        if (route === '/api/shell/events') {
            const sid = url.searchParams.get('sid') || '';
            if (res && rtint && typeof rtint.shellAttach === 'function') { rtint.shellAttach(sid, res); return { _streamed: true }; }
            return { ok: false, error: 'sse-unavailable' };
        }
        if (route === '/api/shell/poll') {
            // 长轮询回退 — 公网经 Cloudflare 等代理时 SSE 被整体缓冲, 改由此普通 HTTP 响应补送排队消息。
            const sid = url.searchParams.get('sid') || '';
            const after = url.searchParams.get('after') || '0';
            if (res && rtint && typeof rtint.shellPoll === 'function') { rtint.shellPoll(sid, after, res); return { _streamed: true }; }
            return { ok: false, error: 'poll-unavailable' };
        }
        // POST /api/shell/msg
        let body: any = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
        const sid = String((body && body.sid) || '');
        const msg = body && body.msg;
        try { if (rtint && typeof rtint.shellHandleMessage === 'function') await rtint.shellHandleMessage(sid, msg); } catch (e) { /* 守柔 */ }
        return { ok: true };
    }

    // ── 归一 · 公网同源前缀账号反代: /i/<accKey>/* → rt-flow 前缀模式反代该账号页 ──
    //   公网手机/电脑经 DAO Bridge 隧道主口直达, 无感打开 Devin 对话页 / 多实例号页 (流式·HTML/JS/二进制/SSE)。
    //   仅 HTTP 流式路径支持 (relay/apiGet 走 JSON 信道, 不可承载流), 故无 res 时返错。
    if (route === '/i' || route.startsWith('/i/')) {
        if (!res) return { ok: false, error: 'stream-required' };
        const rtint2: any = _rtflowModule && _rtflowModule._internals;
        const m = route.match(/^\/i\/([^\/]+)(\/.*)?$/);
        const accKey = m ? m[1] : '';
        const rest = (m && m[2]) ? m[2] : '/';
        const restUrl = rest + (url.search || '');
        if (rtint2 && typeof rtint2.shellAccountProxy === 'function') {
            await rtint2.shellAccountProxy(accKey, restUrl, req, res);
            return { _streamed: true };
        }
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('account proxy unavailable'); }
        return { _streamed: true };
    }

    switch (route) {
        case '/api/health': {
            return {
                status: 'ok', service: 'dao-vsix', version: EXT_VERSION,
                workspace: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [],
                activeEditor: vscode.window.activeTextEditor?.document.uri.fsPath || null,
                diagnostics_count: vscode.languages.getDiagnostics().length,
                port: ws.port, pid: process.pid,
                publicUrl: ws.publicUrl,
                relay: ws.relayConnected ? 'connected' : 'local',
                signal: sigState.enabled ? { session: sigState.session, topic: sigState.topic, brokers: sigState.servers.length, reqCount: sigState.reqCount } : null,
                uptime: Math.floor((Date.now() - ws.startTime) / 1000),
                server_time: new Date().toISOString()
            };
        }
        case '/api/signal-info': {
            // 去中心化路线C 诊断: session/topic/broker 健康/收发统计
            return sigInfo();
        }
        case '/api/signal-start': {
            // 运行时(重)启动去中心化路线C — 无需重载窗口即可恢复(如 ws 模块补齐后)
            try { sigStop(); } catch {}
            await sigStart();
            return sigInfo();
        }
        case '/api/signal-stop': {
            sigStop();
            return sigInfo();
        }
        case '/api/cap': {
            // 整机帧抓取 (JPEG · 二进制) — 渲染在访问者浏览器, 此处只产数据 (守其雌)。
            const s = Math.max(10, Math.min(100, parseInt(url.searchParams.get('s') || '60', 10) || 60));
            const q = Math.max(20, Math.min(95, parseInt(url.searchParams.get('q') || '55', 10) || 55));
            try {
                const b64 = await pcGuiCap(s, q);
                return { _proxy: true, status: 200, binary: true, contentType: 'image/jpeg', body: b64, headers: { 'Cache-Control': 'no-store' } };
            } catch (e: any) {
                return { _proxy: true, status: 503, contentType: 'text/plain; charset=utf-8', body: 'cap-error: ' + ((e && e.message) || String(e)) };
            }
        }
        case '/api/input': {
            // 鼠/键注入 — 访问者浏览器捕获的指针/键盘事件经此打到本机前台窗口 (守其雌·只搬数据)。
            let ibody: any = {};
            try { ibody = JSON.parse(await readBody(req) || '{}'); } catch (e) { ibody = {}; }
            const ok = pcGuiInput(ibody);
            return { ok };
        }
        case '/api/connection': {
            return {
                url: ws.publicUrl || ('http://localhost:' + ws.port),
                token: ws.token,
                port: ws.port,
                hostname: os.hostname(),
                user: os.userInfo().username,
                pid: process.pid,
                relay: ws.relayConnected ? 'connected' : 'local',
                sessionId: ws.relaySessionId || '',
                relayUrl: ws.publicUrl || '',
                primaryUrl: ws.publicUrl || ('http://localhost:' + ws.port)
            };
        }
        // 无缝接力 · 帛书「自知者明」: 一次调用解析「下一个活接口」(重启/切号后仍可定位),
        //   current=确定性 leader, alive=全部活实例, epoch 变化即提示重解析。常驻桥读
        //   ~/.dao/dao-conn-current.json 亦得同源真相。
        case '/api/next': {
            const cur = await daoRefreshCurrent();
            return { ok: true, current: cur || null, alive: (cur && cur.alive) || [], epoch: (cur && cur.epoch) || 0, self: { port: ws.port, pid: process.pid, url: ws.publicUrl || ('http://localhost:' + ws.port) } };
        }
        case '/api/workspace': {
            const folders = vscode.workspace.workspaceFolders?.map(f => ({ uri: f.uri.fsPath, name: f.name, index: f.index })) || [];
            const editors = vscode.window.visibleTextEditors.map(e => ({ file: e.document.uri.fsPath, language: e.document.languageId, line: e.selection.active.line, column: e.selection.active.character }));
            const diags = vscode.languages.getDiagnostics().slice(0, 50).map(([uri, ds]) => ({ file: uri.fsPath, errors: ds.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length, warnings: ds.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length })).filter(d => d.errors > 0 || d.warnings > 0);
            return { folders, openEditors: editors, diagnostics: diags };
        }
        case '/api/exec': {
            const body: any = JSON.parse(await readBody(req));
            const { cmd, type = 'terminal', cwd, timeout: tmout } = body;
            if (type === 'vscode') {
                return await vscode.commands.executeCommand(cmd);
            }
            const term = vscode.window.createTerminal({ name: 'dao-exec', cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
            term.show(false);
            const tmpFile = path.join(os.tmpdir(), `dao-exec-${Date.now()}.txt`);
            const marker = daoExecMarker();
            term.sendText(daoExecCaptureCmd(cmd, tmpFile, marker));
            const waitMs = Math.min(tmout || 20000, 60000);
            const r = await waitForExecOutput(tmpFile, marker, waitMs);
            try { fs.unlinkSync(tmpFile); } catch {}
            setTimeout(() => term.dispose(), 1000);
            return { status: r.done ? 'completed' : 'timeout', stdout: r.output, exitCode: r.done ? 0 : null, command: cmd };
        }
        case '/api/command': {
            const body: any = JSON.parse(await readBody(req));
            const { command, args = [] } = body;
            const result = await vscode.commands.executeCommand(command, ...args);
            return result !== undefined ? result : { ok: true };
        }
        case '/api/file': {
            const filePath = url.searchParams.get('path');
            if (!filePath) throw new Error('path parameter required');
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            return { content: Buffer.from(data).toString('utf8'), path: filePath };
        }
        case '/api/write': {
            const body: any = JSON.parse(await readBody(req));
            const { path: wPath, content: wContent } = body;
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(vscode.Uri.file(wPath), encoder.encode(wContent));
            return { ok: true, path: wPath };
        }
        case '/api/search': {
            const body: any = JSON.parse(await readBody(req));
            const { pattern, exclude, maxResults } = body;
            const files = await vscode.workspace.findFiles(pattern || '**/*', exclude || '**/node_modules/**', maxResults || 100);
            return { files: files.map(f => f.fsPath), count: files.length };
        }
        case '/api/edit': {
            const body: any = JSON.parse(await readBody(req));
            const { file, edits } = body;
            const doc = await vscode.workspace.openTextDocument(file);
            const wsEdit = new vscode.WorkspaceEdit();
            for (const e of edits) { wsEdit.replace(doc.uri, new vscode.Range(new vscode.Position(e.startLine || 0, e.startChar || 0), new vscode.Position(e.endLine || 0, e.endChar || 0)), e.newText || ''); }
            const ok = await vscode.workspace.applyEdit(wsEdit);
            return { ok, file };
        }
        case '/api/ls': {
            const dirPath = url.searchParams.get('path') || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!dirPath) throw new Error('no path and no workspace');
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
            return { path: dirPath, entries: entries.map(([name, type]) => ({ name, type: vscode.FileType[type] })) };
        }
        case '/api/terminal/create': {
            const body: any = JSON.parse(await readBody(req));
            const term = vscode.window.createTerminal({ name: body.name || 'dao', cwd: body.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
            term.show(false);
            const tid = String(term.processId);
            ws.terminals.set(tid, term);
            return { terminalId: tid, name: term.name };
        }
        case '/api/terminal/send': {
            const body: any = JSON.parse(await readBody(req));
            const tid = body.terminalId;
            const term = ws.terminals.get(tid) || vscode.window.activeTerminal;
            if (!term) throw new Error('no terminal found');
            term.sendText(body.text);
            return { ok: true };
        }
        case '/api/diagnostics': {
            const allDiags = vscode.languages.getDiagnostics();
            return allDiags.slice(0, 100).map(([uri, ds]) => ({ file: uri.fsPath, issues: ds.map(d => ({ severity: vscode.DiagnosticSeverity[d.severity], message: d.message, line: d.range.start.line, char: d.range.start.character })) }));
        }
        case '/api/definitions': {
            const body: any = JSON.parse(await readBody(req));
            const { file, line, char } = body;
            const doc = await vscode.workspace.openTextDocument(file);
            const pos = new vscode.Position(line, char);
            const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
            return defs?.map(d => { if ('uri' in d) return { file: d.uri.fsPath, line: d.range.start.line }; return { file: d.targetUri.fsPath, line: d.targetRange.start.line }; }) || [];
        }
        case '/api/references': {
            const body: any = JSON.parse(await readBody(req));
            const { file, line, char } = body;
            const doc = await vscode.workspace.openTextDocument(file);
            const pos = new vscode.Position(line, char);
            const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, pos);
            return refs?.map(r => ({ file: r.uri.fsPath, line: r.range.start.line })) || [];
        }
        case '/api/symbols': {
            const body: any = JSON.parse(await readBody(req));
            const { query } = body;
            const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
            return syms?.slice(0, 50).map(s => ({ name: s.name, kind: vscode.SymbolKind[s.kind], file: s.location.uri.fsPath, line: s.location.range.start.line })) || [];
        }
        case '/api/git/status': {
            const gitExt = vscode.extensions.getExtension('vscode.git');
            if (!gitExt?.isActive) return { error: 'git extension not active' };
            const gitApi = gitExt.exports.getAPI(1);
            const repo = gitApi.repositories[0];
            if (!repo) return { error: 'no git repo' };
            return { head: repo.state.HEAD?.name, ahead: repo.state.HEAD?.ahead, behind: repo.state.HEAD?.behind, changes: repo.state.workingTreeChanges.length, staged: repo.state.indexChanges.length, mergeConflicts: repo.state.mergeChanges.length };
        }
        case '/api/bridge-state': {
            return bridgeGetState();
        }
        case '/api/agents': {
            return { agents: [{ id: os.hostname(), hostname: os.hostname(), ip: '127.0.0.1', os: `${os.type()} ${os.release()}`, user: os.userInfo().username, agent_version: '1.0.0', status: 'online', connected_at: new Date(ws.startTime).toISOString(), last_heartbeat: new Date().toISOString(), pending_commands: 0, completed_commands: 0, workspace: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [], port: ws.port, publicUrl: ws.publicUrl }], count: 1 };
        }
        case '/api/commands': {
            const cmds = await vscode.commands.getCommands(true);
            return { commands: cmds, count: cmds.length };
        }
        case '/api/tools': {
            const body: any = JSON.parse(await readBody(req));
            const { tool, args } = body;
            return await executeTool(tool, args);
        }
        // ═══════════════════════════════════════════════════════════
        // Devin Cloud API · 帛书·四十二「三生万物」本地路由化
        // 所有Devin Cloud操作通过本地HTTP API可用
        // ═══════════════════════════════════════════════════════════
        case '/api/devin/status': {
            return { loggedIn: !!(ws.devinAuth1 || ws.devinApiKey), email: ws.devinEmail, orgId: ws.devinOrgId, orgName: ws.devinOrgName, orgSlug: ws.devinOrgSlug, accountId: ws.devinAccountId, quota: ws.devinQuota, apiKeyType: ws.devinApiKey ? (ws.devinApiKey.startsWith('cog_') ? 'cog' : ws.devinApiKey.startsWith('devin-session-token$') ? 'session' : ws.devinApiKey.startsWith('sk-') ? 'sk-ws' : 'token') : '' };
        }
        case '/api/devin/login': {
            const lb = await readBody(req);
            const { email, password } = JSON.parse(lb);
            if (!email || !password) return { ok: false, error: 'email and password required' };
            return await devinLogin(email, password);
        }
        case '/api/devin/quota': {
            if (!ws.devinApiKey) return { ok: false, error: 'not logged in' };
            const q = await devinFetchQuota(ws.devinApiKey, ws.devinApiServerUrl);
            // 刷新失败(q 为空)时不得抹掉登录时已取得的好额度 — 守柔, 保旧值
            if (q) { ws.devinQuota = q; ws.devinSaveConfig(); }
            return { ok: !!q, quota: q || ws.devinQuota };
        }
        case '/api/devin/sessions': {
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            const limit = url.searchParams.get('limit');
            return await devinListSessions(ws.devinOrgId, ws.devinAuth1, limit ? parseInt(limit) : undefined);
        }
        case '/api/devin/session/create': {
            const cb = await readBody(req);
            const { message, opts } = JSON.parse(cb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinCreateSession(ws.devinOrgId, message, ws.devinAuth1, opts);
        }
        case '/api/devin/session/detail': {
            const sid = url.searchParams.get('id');
            if (!sid || !ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'session id and login required' };
            return await devinGetSessionDetail(ws.devinOrgId, sid, ws.devinAuth1);
        }
        case '/api/devin/session/messages': {
            const mid = url.searchParams.get('id');
            if (!mid || !ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'session id and login required' };
            return await devinGetSessionMessages(ws.devinOrgId, mid, ws.devinAuth1);
        }
        case '/api/devin/session/download': {
            const did = url.searchParams.get('id');
            if (!did) return { ok: false, error: 'session id required' };
            const fp = await devinDownloadSessionMd(did);
            return fp ? { ok: true, path: fp } : { ok: false, error: 'download failed' };
        }
        case '/api/devin/secrets': {
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListSecrets(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/secrets/inject': {
            const sb = await readBody(req);
            const { name, value, upsert } = JSON.parse(sb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (upsert) return await devinUpsertSecret(ws.devinOrgId, name, value, ws.devinAuth1);
            return await devinInjectSecret(ws.devinOrgId, name, value, ws.devinAuth1);
        }
        case '/api/devin/secrets/delete': {
            const db = await readBody(req);
            const { name } = JSON.parse(db);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinDeleteSecret(ws.devinOrgId, name, ws.devinAuth1);
        }
        case '/api/devin/knowledge': {
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListKnowledge(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/knowledge/inject': {
            const kb = await readBody(req);
            const kp = JSON.parse(kb);
            const { name, body: kBody, upsert } = kp;
            // 帛书·「善救人, 故无弃人」— 兼容三种触发字段名, 缺省 Always (上游必填, 缺则 422)
            const trig = kp.triggerDescription || kp.trigger || kp.trigger_description || 'Always';
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (upsert) return await devinUpsertKnowledge(ws.devinOrgId, name, kBody, trig, ws.devinAuth1);
            return await devinInjectKnowledge(ws.devinOrgId, name, kBody, trig, ws.devinAuth1);
        }
        case '/api/devin/knowledge/delete': {
            const kdb = await readBody(req);
            const { id } = JSON.parse(kdb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinDeleteKnowledge(ws.devinOrgId, id, ws.devinAuth1);
        }
        case '/api/devin/playbooks': {
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListPlaybooks(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/playbooks/inject': {
            const pb = await readBody(req);
            const { title, body: pBody, upsert } = JSON.parse(pb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (upsert) return await devinUpsertPlaybook(ws.devinOrgId, title, pBody, ws.devinAuth1);
            return await devinInjectPlaybook(ws.devinOrgId, title, pBody, ws.devinAuth1);
        }
        case '/api/devin/playbooks/delete': {
            const pdb = await readBody(req);
            const { id } = JSON.parse(pdb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinDeletePlaybook(ws.devinOrgId, id, ws.devinAuth1);
        }
        case '/api/devin/batch-inject': {
            // 批量多账号反向注入 · body:{accounts?:[{email,password}], lines?:"email:password\n...", all?:bool, wait?:bool}
            // 不传账号且 all=true → 用本机账号池(loadAccountPool)。默认后台异步跑, wait=true 则等全部完成再返回。
            const bib = await readBody(req);
            let opts: any = {}; try { opts = JSON.parse(bib || '{}'); } catch { opts = {}; }
            if (daoBatchProgress && daoBatchProgress.running) return { ok: false, error: 'batch already running', progress: daoBatchProgress };
            const accts = resolveBatchAccounts(opts);
            if (!accts.length) return { ok: false, error: 'no accounts (provide accounts[]/lines, or all=true with a local pool)' };
            if (opts.wait) { const prog = await devinBatchInject(accts); return { ok: true, progress: prog }; }
            devinBatchInject(accts).catch(() => { if (daoBatchProgress) daoBatchProgress.running = false; });
            return { ok: true, started: true, total: accts.length };
        }
        case '/api/devin/batch-inject/status': {
            return { ok: true, progress: daoBatchProgress };
        }
        case '/api/devin/usage/limit': {
            // 调整单条消息/会话额度上限 — body:{maxCredits}
            const ulb = await readBody(req);
            const { maxCredits } = JSON.parse(ulb || '{}');
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (typeof maxCredits !== 'number') return { ok: false, error: 'maxCredits (number) required' };
            return await devinSetMessageLimit(ws.devinOrgId, maxCredits, ws.devinAuth1);
        }
        case '/api/devin/mcp/installations': {
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListMcpInstallations(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/mcp/add': {
            // 追录自定义 MCP — body: {name, transport, command/args/env_variables | url/headers, ...}
            const mab = await readBody(req);
            const spec = JSON.parse(mab || '{}');
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (!spec.name) return { ok: false, error: 'name required' };
            return await devinAddCustomMcp(ws.devinOrgId, spec, ws.devinAuth1);
        }
        case '/api/devin/mcp/delete': {
            const mdb = await readBody(req);
            const { id } = JSON.parse(mdb || '{}');
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (!id) return { ok: false, error: 'id required' };
            return await devinDeleteMcp(ws.devinOrgId, id, ws.devinAuth1);
        }
        case '/api/devin/mcp/marketplace': {
            // 官网 MCP 市场目录 (整图给到本地, 供浏览 + 加入档案 + 批量安装)
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListMcpMarketplace(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/mcp/ide': {
            // 本机 IDE / 桌面 Agent 内部 MCP 扫描 (纯本地, 无需登录) — 供远程接测/对照 IDE 内显示数量
            try { return { ok: true, hostIde: daoHostIdeKey(), hostSource: daoHostIdeSource(), items: scanIdeMcps() }; } catch (e: any) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case '/api/devin/mcp/probe': {
            // 单项 MCP 接测(连接验证) — body: 完整 MCP spec ({transport,url,headers} | {command,args})
            const mpb = await readBody(req);
            let pspec: any = {}; try { pspec = JSON.parse(mpb || '{}'); } catch { /* 守柔 */ }
            return await daoProbeMcp(pspec);
        }
        case '/api/devin/mcp/probe-all': {
            // 全量接测: 本机 IDE MCP 逐项接测 + (可选)官网已装 MCP — 供「自动接测」一键拉起
            const ide = (() => { try { return scanIdeMcps(); } catch { return []; } })();
            const results: any[] = [];
            for (const e of ide) {
                const r = await daoProbeMcp({ transport: e.transport, url: e.url, headers: e.headers, command: e.command, args: e.args });
                results.push({ name: e.name, source: e.source, transport: e.transport, ok: r.ok, status: r.status, label: r.label, detail: r.detail });
            }
            return { ok: true, count: results.length, results };
        }
        case '/api/devin/mcp/repair': {
            // 一键修复本机 MCP(通用·强鲁棒): 自动识别 node 运行时与模块路径, 修正命令并启用(先备份)。
            //   body: {allIdes?:bool(默认仅 Devin Desktop⇄Windsurf), enable?:bool(默认 true), dryRun?:bool}
            const rpb = await readBody(req); let rpo: any = {}; try { rpo = JSON.parse(rpb || '{}'); } catch { /* 守柔 */ }
            try { return Object.assign({ ok: true }, daoRepairLocalMcp({ allIdes: !!rpo.allIdes, enable: rpo.enable !== false, dryRun: !!rpo.dryRun })); }
            catch (e: any) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case '/api/devin/mcp/verify': {
            // 实测使用: 逐本机 STDIO MCP 真起进程(initialize+tools/list)返回真实工具数; HTTP 走 initialize 接测。
            //   body: {source?:'Devin Desktop'(默认), all?:bool} — 默认仅实测 Devin Desktop, 并行执行。
            const vfb = await readBody(req); let vfo: any = {}; try { vfo = JSON.parse(vfb || '{}'); } catch { /* 守柔 */ }
            const want = vfo.all ? null : String(vfo.source || daoHostIdeSource());
            let ideV = (() => { try { return scanIdeMcps(); } catch { return []; } })();
            if (want) ideV = ideV.filter((e) => e.source === want);
            const vres = await Promise.all(ideV.map(async (e) => {
                if (e.transport === 'HTTP') { const r = await daoProbeMcp({ transport: 'HTTP', url: e.url, headers: e.headers }); return { name: e.name, source: e.source, transport: 'HTTP', ok: r.ok, toolCount: 0, detail: r.detail }; }
                const r = await daoVerifyMcpStdio({ command: e.command, args: e.args, env: e.env }, 15000);
                return { name: e.name, source: e.source, transport: 'STDIO', ok: r.ok, toolCount: r.toolCount, tools: r.tools, error: r.error };
            }));
            return { ok: true, count: vres.length, results: vres };
        }
        case '/api/devin/mcp/install': {
            // 安装一个市场目录项到本账号 — body: {marketplace_server_id, slug?, name?, env_variables?, headers?, installation_scope?}
            const mib = await readBody(req);
            const mspec = JSON.parse(mib || '{}');
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (!mspec.marketplace_server_id && !mspec.slug) return { ok: false, error: 'marketplace_server_id or slug required' };
            return await devinInstallMarketplaceMcp(ws.devinOrgId, mspec, ws.devinAuth1);
        }
        // ── 多实例 路由 作为 API 暴露 (插件本体「路由官网多实例」能力供任意 Agent 调用) ──
        case '/api/devin/multi/panel': {
            // 在 IDE 内打开当前账号的独立路由面板 (多实例·不阻塞)
            try { await vscode.commands.executeCommand('dao.openRoutedPanel'); return { ok: true, action: 'openRoutedPanel' }; }
            catch (e: any) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case '/api/devin/multi/open': {
            // 路由指定账号官网多实例 — body: {email?, mode?:'ide'|'sys'} (sys=电脑浏览器隔离窗口)
            const ob = await readBody(req); let os1: any = {}; try { os1 = JSON.parse(ob || '{}'); } catch { /* 守柔 */ }
            try { await vscode.commands.executeCommand('dao.routeOfficialForAccount', { email: String(os1.email || ''), mode: os1.mode === 'sys' ? 'sys' : 'ide' }); return { ok: true, action: 'routeOfficial', email: String(os1.email || ''), mode: os1.mode === 'sys' ? 'sys' : 'ide' }; }
            catch (e: any) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case '/api/devin/multi/conv': {
            // 多实例打开某账号的具体对话官网 — body: {email?, devinId, mode?:'ide'|'sys'}
            const cb = await readBody(req); let cs: any = {}; try { cs = JSON.parse(cb || '{}'); } catch { /* 守柔 */ }
            if (!cs.devinId) return { ok: false, error: 'devinId required' };
            try { await vscode.commands.executeCommand('dao.routeConvForAccount', { email: String(cs.email || ''), devinId: String(cs.devinId), mode: cs.mode === 'sys' ? 'sys' : 'ide' }); return { ok: true, action: 'routeConv', email: String(cs.email || ''), devinId: String(cs.devinId), mode: cs.mode === 'sys' ? 'sys' : 'ide' }; }
            catch (e: any) { return { ok: false, error: String(e && e.message || e) }; }
        }
        case '/api/devin/automations/clear': {
            // 清除官网本账号全部自动化 (用户「一切清除官网的自动化」)
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinClearAutomations(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/blueprints': {
            // 环境蓝图列表 (snapshot-setup/blueprints)
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListBlueprints(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/blueprints/detail': {
            const bpb = await readBody(req);
            const { id } = JSON.parse(bpb || '{}');
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (!id) return { ok: false, error: 'id required' };
            return await devinGetBlueprint(ws.devinOrgId, id, ws.devinAuth1);
        }
        case '/api/devin/snapshots': {
            // 机器快照列表
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinListSnapshots(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/session/delete': {
            const sdb = await readBody(req);
            const { id } = JSON.parse(sdb || '{}');
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (!id) return { ok: false, error: 'session id required' };
            return await devinDeleteSession(ws.devinOrgId, id, ws.devinAuth1);
        }
        case '/api/devin/git/connections': {
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinCheckGitConnections(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/git/connect': {
            const gb = await readBody(req);
            const { pat } = JSON.parse(gb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinConnectGitHub(ws.devinOrgId, pat, ws.devinAuth1);
        }
        case '/api/devin/git/disconnect': {
            const gdb = await readBody(req);
            const { connectionId } = JSON.parse(gdb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinDisconnectGit(ws.devinOrgId, connectionId, ws.devinAuth1);
        }
        case '/api/devin/inject': {
            return await devinFullInject();
        }
        case '/api/devin/reconcile-pool': {
            // 全池反向注入核对 · 立即强制(绕签名守柔) — 账号库实时检测闭环的手动触发口
            return await reconcileAccountPoolInject('api', { force: true });
        }
        case '/api/devin/dedupe': {
            // 去重: 同名知识/同标题剧本只留一份(删旧版本残留) — 帛书·「少则得·多则惑」
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            return await devinDedupeOrg(ws.devinOrgId, ws.devinAuth1);
        }
        case '/api/devin/wss-url': {
            if (!ws.devinSessionToken) return { ok: false, error: 'no session token' };
            return { ok: true, wssUrl: devinBuildWssUrl(ws.devinSessionToken) };
        }

        // ═══════════════════════════════════════════════════════════
        // 状态查询 · 帛书·五十二「见小曰明·守柔曰强」— 外部插件可读
        // ═══════════════════════════════════════════════════════════
        case '/api/devin/state': {
            // 返回当前窗口完整Devin Cloud状态 — 账号管理插件可读
            return {
                ok: true,
                workspaceKey: ws.workspaceKey,
                workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                devinEmail: ws.devinEmail,
                devinOrgId: ws.devinOrgId,
                devinOrgName: ws.devinOrgName,
                devinOrgSlug: ws.devinOrgSlug,
                devinAuth1: ws.devinAuth1 ? '(set)' : '',
                devinSessionToken: ws.devinSessionToken ? '(set)' : '',
                devinApiKey: ws.devinApiKey ? '(set)' : '',
                devinApiServerUrl: ws.devinApiServerUrl,
                devinAccountId: ws.devinAccountId,
                devinInjecting: ws.devinInjecting,
                devinQuota: ws.devinQuota,
                relayConnected: ws.relayConnected,
                publicUrl: ws.publicUrl,
                port: ws.port
            };
        }
        case '/api/workspaces': {
            // 全局workspace注册表 — 列出所有窗口的账号映射
            return updateWorkspaceRegistry();
        }
        case '/api/agent-doc': {
            // 江海善下之 — 把插件本体暴露给本机 Agent: markdown 操作契约
            return { ok: true, markdown: buildAgentApiDoc(), version: EXT_VERSION };
        }
        case '/api/manifest': {
            // 机器可读能力清单 — 本机 Agent 自动发现可操作接口
            return buildAgentManifest();
        }
        // ═══════════════════════════════════════════════════════════
        // 双面板 · 反向代理 — 帛书·四十一「反者道之动」
        // /devin-cloud/* → https://app.devin.ai/*
        // /devin-cloud-ws/* → https://windsurf.com/* (认证资源)
        // 剥离 X-Frame-Options / CSP frame-ancestors → iframe 可嵌入
        // 注入 Authorization 头 → 认证自动桥接
        // ═══════════════════════════════════════════════════════════
        default: {
            // 道·同源底座: SPA config bundle 的硬编码后端域 → 同源前缀反代(携 auth1, 隧道只搬数据)
            if (route.startsWith('/devin-cloud-api/')) {
                return await devinCloudProxyRoute(route, url, req, 'api', res);
            }
            if (route.startsWith('/devin-cloud-backend/')) {
                return await devinCloudProxyRoute(route, url, req, 'backend', res);
            }
            // 缺陷10修复: 长前缀必须先检查，否则 /devin-cloud-ws-register/ 会匹配 /devin-cloud-ws/
            if (route.startsWith('/devin-cloud-ws-register/')) {
                return await devinCloudProxyRoute(route, url, req, 'register', res);
            }
            if (route.startsWith('/devin-cloud-ws-cdn/')) {
                return await devinCloudProxyRoute(route, url, req, 'codeium', res);
            }
            if (route.startsWith('/devin-cloud-ws-ss/')) {
                return await devinCloudProxyRoute(route, url, req, 'self-serve', res);
            }
            if (route.startsWith('/devin-cloud-ws/')) {
                return await devinCloudProxyRoute(route, url, req, 'windsurf', res);
            }
            if (route.startsWith('/devin-cloud/')) {
                return await devinCloudProxyRoute(route, url, req, 'devin', res);
            }
            throw new Error('not found');
        }
    }
}

// ═══════════════════════════════════════════════════════════
// 面 · Panel — 水善利万物而有静
// 反者道之动 — DAO即中枢，全面展示Devin Cloud一切状态
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 视图 · DaoCloudPanel — 帛书·四十二「万物负阴而抱阳」
// 统一Devin Cloud全栈管理 — 与官网并存的双页面
// Tab导航: Sessions | Knowledge | Playbooks | Secrets | Git | Settings
// 前端fetch本地API路由 → 后端handleRouteInternal → Devin Cloud
// ═══════════════════════════════════════════════════════════

class DaoCloudPanel implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | null = null;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            const reply = (data: any) => webviewView.webview.postMessage({ id: msg.id, ...data });
            try {
                switch (msg.command) {
                    case 'apiGet': {
                        const route = msg.route as string;
                        const url = new URL(route, 'http://localhost');
                        const result = await handleRouteInternal(route, url, { headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } } as any, ws.token);
                        reply({ ok: true, data: result });
                        break;
                    }
                    case 'apiPost': {
                        const route = msg.route as string;
                        const body = msg.body;
                        const url = new URL(route, 'http://localhost');
                        const fakeReq = { headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, _relayBody: JSON.stringify(body), method: 'POST' };
                        const result = await handleRouteInternal(route, url, fakeReq, ws.token);
                        reply({ ok: true, data: result });
                        break;
                    }
                    case 'devinLogin': {
                        vscode.window.showInputBox({ prompt: 'Devin Cloud Email', placeHolder: 'user@example.com' }).then(email => {
                            if (!email) return;
                            vscode.window.showInputBox({ prompt: 'Devin Cloud Password', password: true }).then(password => {
                                if (!password) return;
                                devinLogin(email, password).then(r => {
                                    if (r.ok) { vscode.window.showInformationMessage('Devin login OK'); devinFullInject(); }
                                    else vscode.window.showErrorMessage('Devin login failed: ' + (r.error || ''));
                                    this.refresh();
                                });
                            });
                        });
                        reply({ ok: true });
                        break;
                    }
                    case 'devinWindsurfAutoLogin': {
                        const ok = await devinAutoChain();
                        if (ok) vscode.window.showInformationMessage('Devin Cloud 自动登录成功');
                        else vscode.window.showErrorMessage('自动登录失败');
                        this.refresh();
                        reply({ ok });
                        break;
                    }
                    case 'devinLogout': {
                        ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinOrgName = ''; ws.devinOrgSlug = '';
                        ws.devinEmail = ''; ws.devinSessionToken = ''; ws.devinApiKey = ''; ws.devinApiServerUrl = '';
                        ws.devinAccountId = ''; ws.devinQuota = null;
                        ws.devinSaveConfig();
                        this.refresh();
                        reply({ ok: true });
                        break;
                    }
                    case 'devinInject': {
                        devinFullInject().then(() => this.refresh());
                        reply({ ok: true });
                        break;
                    }
                    case 'wamCmd': {
                        // ① 侧栏 = RT Flow 切号面板 — 路由到 WAM 切号命令 (rtflow 已注册)
                        const c = String(msg.cmd || '');
                        if (c.startsWith('wam.')) { try { await vscode.commands.executeCommand(c); } catch (e: any) { vscode.window.showErrorMessage('RT Flow: ' + (e?.message || c)); } setTimeout(() => this.refresh(), 400); }
                        reply({ ok: true });
                        break;
                    }
                    case 'devinRefreshQuota': {
                        if (ws.devinApiKey) { const q = await devinFetchQuota(ws.devinApiKey, ws.devinApiServerUrl); if (q) { ws.devinQuota = q; ws.devinSaveConfig(); } }
                        this.refresh();
                        reply({ ok: true });
                        break;
                    }
                    case 'devinConnectGit': {
                        vscode.window.showInputBox({ prompt: 'GitHub Personal Access Token', placeHolder: 'ghp_...', password: true }).then((pat: string | undefined) => {
                            if (!pat || !ws.devinAuth1 || !ws.devinOrgId) return;
                            devinConnectGitHub(ws.devinOrgId, pat, ws.devinAuth1).then(r => {
                                if (r.ok) vscode.window.showInformationMessage('GitHub PAT connected');
                                else vscode.window.showErrorMessage('GitHub PAT connect failed');
                                this.refresh();
                            });
                        });
                        reply({ ok: true });
                        break;
                    }
                    case 'devinCreateSession': {
                        vscode.window.showInputBox({ prompt: 'Devin Session Message', placeHolder: 'What would you like Devin to do?' }).then((message: string | undefined) => {
                            if (!message || !ws.devinAuth1 || !ws.devinOrgId) return;
                            devinCreateSession(ws.devinOrgId, message, ws.devinAuth1).then(r => {
                                if (r.ok) vscode.window.showInformationMessage('Session created: ' + (r.devinId || ''));
                                else vscode.window.showErrorMessage('Session create failed' + (r.status ? ' (HTTP ' + r.status + ')' : '') + (r.error ? ': ' + r.error : ''));
                                this.refresh();
                            });
                        });
                        reply({ ok: true });
                        break;
                    }
                    case 'startServer': {
                        vscode.commands.executeCommand('dao.startServer');
                        setTimeout(() => this.refresh(), 2000);
                        reply({ ok: true });
                        break;
                    }
                    case 'stopServer': {
                        vscode.commands.executeCommand('dao.stopServer');
                        setTimeout(() => this.refresh(), 1000);
                        reply({ ok: true });
                        break;
                    }
                    case 'regenerateToken': {
                        regenerateToken();
                        this.refresh();
                        reply({ ok: true });
                        break;
                    }
                    case 'copy': {
                        vscode.env.clipboard.writeText(msg.text);
                        vscode.window.showInformationMessage('已复制: ' + msg.label);
                        reply({ ok: true });
                        break;
                    }
                    case 'devinCloudBrowser': {
                        // 帛书·「道法自然」— 反向代理自动注入认证
                        vscode.commands.executeCommand('dao.devinCloudBrowser');
                        reply({ ok: true });
                        break;
                    }
                    case 'devinCloudPanel': {
                        // 帛书·「道法自然」— 反向代理自动注入认证
                        vscode.commands.executeCommand('dao.devinCloudPanel');
                        reply({ ok: true });
                        break;
                    }
                    case 'openCloudPanel': {
                        vscode.commands.executeCommand('dao.openCloudPanel');
                        reply({ ok: true });
                        break;
                    }
                    case 'openDevinPage': {
                        // 帛书·「天下之至柔驰骋于天下之致坚」— 反向代理自动注入认证
                        // 通过本地反向代理路由官网 — Cookie/Token自动注入
                        const page = msg.page || 'home';
                        const pagePaths: Record<string, string> = {
                            home: '', sessions: '/sessions',
                            knowledge: '/knowledge', playbooks: '/playbooks',
                            secrets: '/settings/secrets', integrations: '/settings/integrations',
                            automations: '/settings/automations',
                            schedules: '/settings/schedules',
                        };
                        const pagePath = pagePaths[page] || '';
                        // 经反代根路径路由(/、/sessions ...) — SPA 客户端路由正确匹配 + 自动注入登录
                        const targetUrl = daoRoutedWebUrl(pagePath);
                        try { vscode.commands.executeCommand('simpleBrowser.show', targetUrl); }
                        catch { vscode.env.openExternal(vscode.Uri.parse(targetUrl)); }
                        reply({ ok: true });
                        break;
                    }
                    case 'refresh': {
                        this.refresh();
                        reply({ ok: true });
                        break;
                    }
                    case 'loadTabData': {
                        // ★ v1.0.1 · 帛书·「反者道之动」— API可用则直取数据，否则simpleBrowser
                        const tab = msg.tab as string;
                        if (devinCanUseApi() && ws.devinOrgId) {
                            try {
                                let result: any = { ok: false };
                                if (tab === 'sessions') { result = await devinListSessions(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.sessions : [] }); }
                                else if (tab === 'knowledge') { result = await devinListKnowledge(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.learnings : [] }); }
                                else if (tab === 'playbooks') { result = await devinListPlaybooks(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.playbooks : [] }); }
                                else if (tab === 'secrets') { result = await devinListSecrets(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.secrets : [] }); }
                                else if (tab === 'integrations') { result = await devinListIntegrations(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.connections : [] }); }
                                else if (tab === 'automations') {
                                    result = await devinListAutomations(ws.devinOrgId, ws.devinAuth1);
                                    const aitems = (result.ok ? (result.automations || []) : []).map((a: any) => ({
                                        name: a.name || a.title || a.automation_id || 'Automation',
                                        detail: Array.isArray(a.triggers) ? a.triggers.map((t: any) => t.event_type || t.type || '').filter(Boolean).join(', ') : (a.description || ''),
                                        connected: a.enabled !== false,
                                    }));
                                    reply({ ok: true, data: aitems });
                                }
                                else if (tab === 'schedules') { result = await devinListSchedules(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.items : [] }); }
                                else reply({ ok: false, error: 'unknown tab' });
                            } catch (e: any) { reply({ ok: false, error: e.message }); }
                        } else {
                            // 道法自然 · 零自动打开: 未登录/无凭证绝不自动弹页 (杜绝首启弹一堆坏页),
                            // 仅回错误态 → UI 渲染「重试 / 🌐 在 Devin Cloud 中打开」按钮, 由用户手动开页。
                            reply({ type: 'tabData', tab, items: [], error: '未登录 · 登录后查看或手动打开', fallbackProxy: false });
                        }
                        break;
                    }
                    case 'setSyncMode': {
                        // 守柔 · 自动(跟随IDE) ↔ 手动(独立) 切换
                        const newMode = msg.mode === 'manual' ? 'manual' : 'auto';
                        await setAccountSyncMode(newMode);
                        if (newMode === 'auto') {
                            // 切回自动 → 立即重新对齐 IDE 当前账号
                            lastSyncedApiKey = ''; lastSyncedEmail = '';
                            vscode.window.showInformationMessage('账号模式: 自动 · 重新跟随 IDE 账号…');
                            (async () => { try { const ok = await devinAutoChain(); if (ok) { await devinFullInject(false, true); } } catch {} this.refresh(); refreshDaoCloudMiddlePanel(); })();
                        } else {
                            vscode.window.showInformationMessage('账号模式: 手动 · 面板不再跟随 IDE, 可独立登录任意账号');
                        }
                        this.refresh();
                        reply({ ok: true, mode: newMode });
                        break;
                    }
                    case 'devinManualLogin': {
                        // 手动模式 · 独立登录任意账号 (自动切到 manual, 避免被 IDE 跟随覆盖)
                        await setAccountSyncMode('manual');
                        const email = await vscode.window.showInputBox({ prompt: 'Devin Cloud Email (手动登录)', placeHolder: 'user@example.com' });
                        if (email) {
                            const password = await vscode.window.showInputBox({ prompt: 'Devin Cloud 密码', password: true });
                            if (password) {
                                const r = await devinLogin(email, password);
                                if (r.ok) { vscode.window.showInformationMessage('手动登录成功 (' + email + ')'); await devinFullInject(); }
                                else vscode.window.showErrorMessage('手动登录失败: ' + (r.error || ''));
                            }
                        }
                        this.refresh(); refreshDaoCloudMiddlePanel();
                        reply({ ok: true });
                        break;
                    }
                    case 'devinPasteAccount': {
                        // 归一·B2 · 单账号主页: 粘贴一行 email:password (rt-flow 复制格式) → 即刻切换并渲染
                        await setAccountSyncMode('manual');
                        let line = (typeof msg.text === 'string' && msg.text.trim()) ? msg.text.trim() : '';
                        if (!line) { try { line = (await vscode.env.clipboard.readText() || '').trim(); } catch { line = ''; } }
                        const parsed = parseAccountLine(line);
                        if (!parsed) {
                            const input = await vscode.window.showInputBox({ prompt: '粘贴账号 (一行 email:password)', placeHolder: 'user@example.com:password' });
                            const p2 = parseAccountLine((input || '').trim());
                            if (!p2) { vscode.window.showWarningMessage('格式应为 email:password (一行)'); reply({ ok: false }); break; }
                            const r = await devinLogin(p2.email, p2.password);
                            if (r.ok) { vscode.window.showInformationMessage('单账号已切换 (' + p2.email + ')'); await devinFullInject(); }
                            else vscode.window.showErrorMessage('登录失败: ' + (r.error || ''));
                        } else {
                            const r = await devinLogin(parsed.email, parsed.password);
                            if (r.ok) { vscode.window.showInformationMessage('单账号已切换 (' + parsed.email + ')'); await devinFullInject(); }
                            else vscode.window.showErrorMessage('登录失败: ' + (r.error || ''));
                        }
                        this.refresh(); refreshDaoCloudMiddlePanel();
                        reply({ ok: true });
                        break;
                    }
                    case 'exportAgentDoc': {
                        // 江海善下之 — 导出插件本体操作契约 MD, 供本机其他 Agent 使用
                        try {
                            const outPath = await exportAgentDocToFile();
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
                            await vscode.window.showTextDocument(doc, { preview: false });
                            vscode.env.clipboard.writeText(outPath);
                            vscode.window.showInformationMessage('已导出 Agent 操作契约: ' + outPath + ' (路径已复制) · 也可 GET /api/agent-doc');
                            reply({ ok: true, path: outPath });
                        } catch (e: any) {
                            vscode.window.showErrorMessage('导出失败: ' + (e?.message || e));
                            reply({ ok: false, error: e?.message });
                        }
                        break;
                    }
                    default:
                        reply({ ok: false, error: 'unknown command' });
                }
            } catch (err: any) {
                reply({ ok: false, error: err.message });
            }
        });
    }

    refresh() {
        if (this.view) this.view.webview.html = this.getHtml();
    }

    private getHtml(): string {
        const loggedIn = !!ws.devinAuth1;
        const syncing = !loggedIn && ws.devinAutoSyncing; // 帛书·「道法自然」— 自动同步中
        const email = ws.devinEmail || '';
        const orgName = ws.devinOrgName || ws.devinOrgSlug || '';
        let hasWindsurfCreds = false;
        try { hasWindsurfCreds = !!readWindsurfCredentials(); } catch {}
        const relayStatus = ws.relayConnected ? '✓' : '✗';
        const mode = getAccountSyncMode();

        // Compact sidebar — full panel opens in editor area
        return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:8px;overflow-y:auto}
.card{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px;margin-bottom:6px}
.row{display:flex;justify-content:space-between;align-items:center;padding:2px 0}
.lbl{color:var(--vscode-descriptionForeground);font-size:11px}
.val{color:var(--vscode-foreground);font-weight:500;font-size:11px;word-break:break-all;max-width:180px;text-align:right}
.ok{color:#4ec9b0}.err{color:#f44747}.sync{color:#e8c84a}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;padding:4px 10px;cursor:pointer;font-size:11px;width:100%;margin-top:4px}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn.primary{background:#6366f1}.btn.primary:hover{background:#818cf8}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.syncing{animation:pulse 1.5s ease-in-out infinite}
</style></head>
<body>
${syncing ? `
<div class="card">
  <div class="row"><span class="lbl">🤖 Devin Cloud</span><span class="val syncing sync">⟳ 同步中...</span></div>
  <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px">正在自动同步 Windsurf 账号状态</div>
</div>
` : !loggedIn ? `
<div class="card">
  <div class="row"><span class="lbl">🤖 Devin Cloud</span><span class="val err">✗ 未登录</span></div>
  <button class="btn primary" onclick="cmd('devinLogin')">🔑 登录</button>
  ${hasWindsurfCreds ? '<button class="btn" style="background:#0e639c;margin-top:4px" onclick="cmd(&#39;devinWindsurfAutoLogin&#39;)">🌀 Windsurf 自动登录</button>' : ''}
</div>
` : `
<div class="card">
  <div class="row"><span class="lbl">🤖 Devin Cloud</span><span class="val ok">✓ ${escapeHtml(email.split('@')[0])}</span></div>
  <div class="row"><span class="lbl">组织</span><span class="val" style="font-size:10px">${escapeHtml(orgName)}</span></div>
  ${ws.devinQuota ? (() => { const q: any = ws.devinQuota; const bal = (q.overageDollars != null) ? Number(q.overageDollars) : null; const bc = bal == null ? '#888' : bal > 5 ? '#4ec9b0' : bal > 1 ? '#e8c84a' : '#f44747'; return '<div class="row"><span class="lbl">余额</span><span class="val" style="color:'+bc+';font-weight:600">'+(bal != null ? '$' + bal.toFixed(2) : '—')+'</span></div>'; })() : ''}
</div>
`}
<div class="card">
  <div class="row"><span class="lbl">🔁 RT Flow 切号</span><span class="val ${mode === 'manual' ? 'sync' : 'ok'}">${mode === 'manual' ? '✋ 手动(独立)' : '🔄 自动(跟随IDE)'}</span></div>
  <button class="btn primary" onclick="cmd('wamCmd',{cmd:'wam.switchAccount'})" title="RT Flow 切换到指定账号">🔄 切换账号</button>
  <button class="btn" style="background:#b8860b;margin-top:4px" onclick="cmd('wamCmd',{cmd:'wam.panicSwitch'})" title="立即轮换到下一个可用账号(限流/卡死时应急)">🚨 紧急切换 (轮换下一个)</button>
  <button class="btn" style="background:#6f42c1;margin-top:4px" onclick="cmd('devinPasteAccount')" title="粘贴一行 email:password (rt-flow 复制格式) · 即刻切换为该单账号主页">📋 粘贴账号 · 单号切换</button>
  <button class="btn" style="margin-top:4px" onclick="cmd('setSyncMode',{mode:'${mode === 'manual' ? 'auto' : 'manual'}'})">${mode === 'manual' ? '↩️ 切回自动 · 跟随 IDE 账号' : '✋ 切到手动 · 面板独立登录'}</button>
</div>
<div class="card">
  <button class="btn" onclick="cmd('wamCmd',{cmd:'wam.addAccount'})" title="新增账号到 RT Flow 账号池">➕ 添加账号</button>
  <button class="btn" style="margin-top:4px" onclick="cmd('wamCmd',{cmd:'wam.refreshAll'})" title="刷新全部账号状态/配额">🔃 刷新全部</button>
  <button class="btn" style="margin-top:4px" onclick="cmd('wamCmd',{cmd:'wam.healthCheck'})" title="账号池健康检查">🩺 健康检查</button>
  <button class="btn" style="margin-top:4px" onclick="cmd('wamCmd',{cmd:'wam.openEditor'})" title="打开 RT Flow 完整账号管理面板">🗂️ RT Flow 完整管理面板</button>
</div>
<div class="card">
  <div class="row"><span class="lbl">⚡ Server</span><span class="val ${ws.port ? 'ok' : 'err'}">${ws.port ? ':' + ws.port : 'off'}</span></div>
  <div class="row"><span class="lbl">☁️ Relay</span><span class="val ${ws.relayConnected ? 'ok' : 'err'}">${relayStatus}</span></div>
</div>
<button class="btn primary" onclick="cmd('openCloudPanel')" title="切号/注入/备份/知识库等全部功能均在此主页">🤖 打开 Devin Cloud 全功能主页</button>
<script>
const vscode = acquireVsCodeApi();
function cmd(c, d) { vscode.postMessage(Object.assign({command: c}, d || {})); }
</script>
</body></html>`;
    }
}

// ═══════════════════════════════════════════════════════════
// 道 · DaoCloudMiddlePanel — 帛书·四十二「万物负阴而抱阳」
// 中间层全功能面板 — 官网设计逻辑 · UI驱动 · 自动同步
// 反者道之动: API→UI · 不可操作→可操作 · 被动→主动
// 无为而无不为: 数据自动加载 · 状态自动同步 · 注入自动完成
// ═══════════════════════════════════════════════════════════

let daoCloudMiddlePanel: vscode.WebviewPanel | null = null;
// 归一 · 「全功能面板六大板块」可被 rt-flow 统一外壳以 blob-iframe 挂载为同级子网页。
// 回推目标指针: 默认走独立面板; 外壳挂载时由 setCloudProvider.setHostPost 改指向外壳中继 → iframe。
let _middlePostTarget: ((d: any) => void) | null = null;
function postMiddle(d: any) {
    // 道并行而不相悖: 原生面板与归一外壳(/shell)可同时在场, 回推须同时抵达二者;
    //   旧实现 daoCloudMiddlePanel 在场即 return, 致外壳(_middlePostTarget)被饿死
    //   → /shell 切号板块 wamInit 回包丢失, 永停"加载切号面板…"。号主态本为共享, 双发幂等无害。
    if (daoCloudMiddlePanel) { try { daoCloudMiddlePanel.webview.postMessage(d); } catch { /* 守柔 */ } }
    if (_middlePostTarget) { try { _middlePostTarget(d); } catch { /* 守柔 */ } }
}
let daoCloudMiddlePanelVisible = false;
let sidebarCloudPanel: DaoCloudPanel | null = null;

function mpEsc(s: string): string {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 读取 dao-bridge 插件产出的工作区隧道状态 (~/.dao/bridge/conn.json)
function readBridgeConn(): any {
    try {
        const p = path.join(os.homedir(), '.dao', 'bridge', 'conn.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { url: c.url || '', workspace: c.workspace || '', root: c.root || '', host: c.host || '', updated: c.updated || '', port: c.port || 0 };
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// Bridge 集成模块 — 帛书·「天下之至柔驰骋于天下之致坚」
// 内网穿透一体化: cloudflared管理 + MD生成 + Knowledge注入
// ═══════════════════════════════════════════════════════════
const BRIDGE_DIR = path.join(os.homedir(), '.dao', 'bridge');
let bridgeProc: any = null;
let bridgeUrl: string = '';
let bridgeToken: string = '';
// 帛书·「無死地」: cloudflared 脱宿主独立存活 — 日志/PID 落盘, 重载/重启宿主不带走隧道。
// 独立闭环(鸡犬相闻·不相往来): 用 -vsix 后缀, 与常驻桥各自管各自的 cloudflared, 互不干扰。
const CF_LOG = path.join(BRIDGE_DIR, 'cloudflared-vsix.log');
const CF_PID = path.join(BRIDGE_DIR, 'cloudflared-vsix.pid');
const CF_PORT = path.join(BRIDGE_DIR, 'cloudflared-vsix.port');
let cfPollTimer: any = null;
// 帛书补丁·止抖三律: 新生隧道自起时刻(建立期/冷却期判据源) — 免 liveness 每 8s 抖杀尚在建立的 quick-tunnel。
let _cfLastStartMs = 0;
const CF_ESTABLISH_GRACE_MS = 45000; // 新生隧道·源活即守候至多 45s 让 URL 就绪, 不抖杀
const CF_RESTART_COOLDOWN_MS = 25000; // 两次重启最小间隔, 杜绝连环重启
// 帛书补丁·退避: 连续自起失败(多为 trycloudflare 1015/429 限流·正是抖动锤爆隧道 API 所致)时指数退避,
//   让限流冷却而非越锤越死 — 「反者道之动·弱者道之用」, 不争而自复。
let _cfSpawnFails = 0;
let _cfBackoffUntilMs = 0;
let _cfLastCountedStartMs = 0;
const CF_BACKOFF_MAX_MS = 300000; // 退避上限 5min: 冷却后尽快重试又不锤爆
function cfReadBoundPort(): number { try { const n = parseInt(fs.readFileSync(CF_PORT, 'utf8').trim(), 10); if (n > 0) return n; } catch (eCFP1) { /* 守柔 */ } return 0; }
function cfWriteBoundPort(p: number): void { try { if (p) { bridgeEnsureDir(); fs.writeFileSync(CF_PORT, String(p), 'utf8'); } } catch (eCFP2) { /* 守柔 */ } }
// 帛书·「上善若水」: 公网隧道 origin 恒随「活着的 leader」流动 — 取当前真应答 /api/health 的最小端口实例。
//   杜绝隧道被钉死在已消亡端口而无人重绑, 令「打不通自动刷新」真正落到活端口(用户所述自愈失效之根)。
async function bridgeLeaderOriginPort(): Promise<number> {
    const cands = new Set<number>();
    try { const j = JSON.parse(fs.readFileSync(DAO_CONN_CURRENT, 'utf8')); if (j && j.port) cands.add(Number(j.port)); if (j && Array.isArray(j.alive)) for (const a of j.alive) { if (a && a.port) cands.add(Number(a.port)); } } catch (eLOP1) { /* 守柔 */ }
    if (ws && ws.port) cands.add(Number(ws.port));
    const base = (typeof DEFAULT_PORT === 'number' ? DEFAULT_PORT : 9920);
    for (let i = 0; i < 10; i++) cands.add(base + i);
    const ports = Array.from(cands).filter(p => p >= 1 && p <= 65535).sort((a, b) => a - b);
    for (const p of ports) { try { if (await daoProbeHealth(p)) return p; } catch (eLOP2) { /* 守柔 */ } }
    return (ws && ws.port) || base;
}

function bridgeEnsureDir() { fs.mkdirSync(BRIDGE_DIR, { recursive: true }); }

// 从 cloudflared 日志文件读取最新隧道 URL(排除 api. 注册端点子域)
function cfReadUrlFromLog(): string {
    try {
        const txt = fs.readFileSync(CF_LOG, 'utf8');
        const matches = txt.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/g);
        if (matches && matches.length) return matches[matches.length - 1];
    } catch {}
    return '';
}
// 帛书补丁·「知止不殆」: 探测 cloudflared 日志是否含 Cloudflare 限流签名(1015/429/Too Many Requests)。
//   quick-tunnel 被限流时, cloudflared 常仍存活甚或打印出一个 trycloudflare URL, 但该 URL 边缘恒 530 —
//   若仅凭「日志有 URL」即判成功清零退避, liveness 探 530 又重建 → 越锤越死(正是用户所遇之根)。
//   故凡见限流签名, 一律施「限流专用长冷却」, 让按 IP 的封禁自然消退, 不争而自复。
const CF_RATELIMIT_COOLDOWN_MS = 20 * 60 * 1000; // 20min: trycloudflare 按 IP 限流冷却通常约此量级
function cfLogHasRateLimit(): boolean {
    try {
        const txt = fs.readFileSync(CF_LOG, 'utf8');
        return /\b1015\b|\b429\b|Too Many Requests|rate.?limit|error unmarshaling QuickTunnel/i.test(txt);
    } catch { /* 守柔 */ }
    return false;
}
// PID 文件里的 cloudflared 是否仍存活(脱宿主孤儿进程仍在跑则复用, 不再新起隧道)
function cfPidAlive(): number {
    try {
        const pid = parseInt(fs.readFileSync(CF_PID, 'utf8').trim(), 10);
        if (pid > 0) { process.kill(pid, 0); return pid; }
    } catch {}
    return 0;
}
// 轮询日志捕获/跟随 URL(取代旧的进程事件流; detached 进程 stdio 已重定向到日志, 无事件可听)
function bridgeStartUrlPoll(): void {
    if (cfPollTimer) return;
    let tries = 0;
    cfPollTimer = setInterval(() => {
        tries++;
        const u = cfReadUrlFromLog();
        if (u && u !== bridgeUrl) {
            bridgeUrl = u;
            try { bridgeSaveConnJson(); } catch {}
            try { bridgeWriteArtifacts(); } catch {}
            try { refreshDaoCloudMiddlePanel(); } catch {}
            try { vscode.window.showInformationMessage(`Bridge 已打通: ${bridgeUrl}`); } catch {}
        }
        if ((u && tries >= 6) || tries >= 40) { clearInterval(cfPollTimer); cfPollTimer = null; }
    }, 1500);
}

function bridgeSaveNamedToken(token: string) {
    bridgeEnsureDir();
    fs.writeFileSync(path.join(BRIDGE_DIR, 'tunnel-token'), token, 'utf8');
}

function bridgeReadNamedToken(): string {
    try { return fs.readFileSync(path.join(BRIDGE_DIR, 'tunnel-token'), 'utf8').trim(); } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════
// CloudFlare 账号/命名隧道 — 移植自独立 dao-bridge (帛书·「反者道之动」)
// 与独立穿透插件 1:1: 凭证落 ~/.dao/bridge/cf-credentials.json; 命名隧道令牌落 tunnel-token / named-tunnel.json
// ═══════════════════════════════════════════════════════════
function bridgeCfCredFile(): string { return path.join(BRIDGE_DIR, 'cf-credentials.json'); }
function bridgeLoadCfCredentials(): any { try { return JSON.parse(fs.readFileSync(bridgeCfCredFile(), 'utf8')); } catch { return null; } }
function bridgeSaveCfCredentials(creds: any) { bridgeEnsureDir(); fs.writeFileSync(bridgeCfCredFile(), JSON.stringify(creds, null, 2), 'utf8'); }
function bridgeCfState(): { cfLoggedIn: boolean; cfEmail: string; cfSource: string; named: boolean } {
    let cfEmail = '', cfSource = '', cfLoggedIn = false, named = false;
    const c = bridgeLoadCfCredentials();
    if (c && (c.apiToken || c.globalApiKey || c.tunnelToken)) { cfLoggedIn = true; cfEmail = c.email || ''; cfSource = c.source || ''; }
    try { if (fs.existsSync(path.join(BRIDGE_DIR, 'named-tunnel.json'))) named = true; } catch { /* 守柔 */ }
    if (bridgeReadNamedToken()) named = true;
    return { cfLoggedIn, cfEmail, cfSource, named };
}
let _bridgeProxyCache: string | null = null;
function bridgeDetectProxy(): string {
    if (_bridgeProxyCache !== null) return _bridgeProxyCache;
    const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
    _bridgeProxyCache = String(p).trim();
    return _bridgeProxyCache;
}
async function bridgeVerifyCfToken(token: string): Promise<boolean> {
    return await new Promise((resolve) => {
        const https = require('https');
        const req = https.request({ hostname: 'api.cloudflare.com', path: '/client/v4/user/tokens/verify', method: 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, (res: any) => {
            let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => { try { const j = JSON.parse(d); resolve(res.statusCode === 200 && j && j.success); } catch { resolve(false); } });
        });
        req.on('error', () => resolve(false)); req.setTimeout(15000, () => { req.destroy(); resolve(false); }); req.end();
    });
}
// CF 登录: API Token → Global API Key → 命名隧道令牌(长 base64/JWT, 持久化供固定域名)。与独立插件 loginCloudFlare 同构。
async function bridgeCfLogin(email: string, apiKeyOrToken: string): Promise<{ ok: boolean; message: string }> {
    const token = String(apiKeyOrToken || '').trim();
    if (token && await bridgeVerifyCfToken(token)) {
        bridgeSaveCfCredentials({ email, apiToken: token, source: 'api-token', savedAt: new Date().toISOString() });
        return { ok: true, message: 'CloudFlare API Token 验证成功' };
    }
    const r: any = await new Promise((resolve) => {
        const https = require('https');
        const req = https.request({ hostname: 'api.cloudflare.com', path: '/client/v4/user', method: 'GET', headers: { 'X-Auth-Email': email, 'X-Auth-Key': token, 'Content-Type': 'application/json' } }, (res: any) => {
            let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode }); } });
        });
        req.on('error', () => resolve({ status: 0 })); req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0 }); }); req.end();
    });
    if (r.status === 200 && r.json && r.json.success) {
        bridgeSaveCfCredentials({ email, globalApiKey: token, source: 'global-api-key', savedAt: new Date().toISOString() });
        return { ok: true, message: 'CloudFlare Global API Key 验证成功' };
    }
    if (token.length >= 100 && /^[A-Za-z0-9_\-=.]+$/.test(token)) {
        try {
            fs.writeFileSync(path.join(BRIDGE_DIR, 'named-tunnel.json'), JSON.stringify({ cfTunnelToken: token, email, savedAt: new Date().toISOString() }, null, 2), 'utf8');
            bridgeSaveNamedToken(token);
            return { ok: true, message: '已保存命名隧道令牌 — 点「重启隧道」即以固定域名启动' };
        } catch { /* 守柔 */ }
    }
    return { ok: false, message: 'CloudFlare 验证失败 — 请检查 email 和 API Key/Token（仅用快速隧道则无需填）' };
}
// 用浏览器登录 Cloudflare(可用 GitHub) → cert.pem。仅"已有自有域名"用户需要(固定公网域名)。
function bridgeCfBrowserLogin(): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
        const { spawn } = require('child_process');
        const bin = bridgeFindCloudflared();
        const cert = path.join(os.homedir(), '.cloudflared', 'cert.pem');
        let proc: any;
        try { proc = spawn(bin, ['tunnel', 'login'], { windowsHide: true }); } catch (e: any) { return resolve({ ok: false, message: String(e && e.message) }); }
        let opened = false;
        const onData = (buf: Buffer) => { const s = buf.toString(); const m = s.match(/https:\/\/dash\.cloudflare\.com\/[^\s]+/i); if (m && !opened) { opened = true; try { vscode.env.openExternal(vscode.Uri.parse(m[0])); } catch { /* 守柔 */ } } };
        try { proc.stdout.on('data', onData); proc.stderr.on('data', onData); } catch { /* 守柔 */ }
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (fs.existsSync(cert)) { clearInterval(iv); try { proc.kill(); } catch { /* 守柔 */ } resolve({ ok: true, message: 'Cloudflare 浏览器登录成功（已获取 cert.pem）· 点「重启隧道」' }); }
            else if (Date.now() - t0 > 180000) { clearInterval(iv); try { proc.kill(); } catch { /* 守柔 */ } resolve({ ok: false, message: '登录超时（180s 内未完成浏览器授权）' }); }
        }, 1500);
    });
}
// 退出账号/重置无账号模式: 备份后清除全部 CF 凭证残留(含 cloudflared cert.pem)。与独立插件 resetAccount 同构。
async function bridgeResetAccount(): Promise<{ ok: boolean; message: string }> {
    const removed: string[] = [];
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(BRIDGE_DIR, 'reset-backup-' + ts);
    const backup = (src: string) => { try { if (!fs.existsSync(src)) return; fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(src, path.join(backupDir, path.basename(src))); fs.unlinkSync(src); removed.push(src); } catch { /* 守柔 */ } };
    backup(path.join(BRIDGE_DIR, 'named-tunnel.json'));
    backup(bridgeCfCredFile());
    backup(path.join(BRIDGE_DIR, 'tunnel-token'));
    try {
        const dc = path.join(os.homedir(), '.dao', 'dao-config.json');
        if (fs.existsSync(dc)) { const j = JSON.parse(fs.readFileSync(dc, 'utf8')); let touched = false; for (const k of ['cfTunnelToken', 'tunnelToken', 'cfHostname', 'hostname']) if (k in j) { delete j[k]; touched = true; } if (touched) { fs.writeFileSync(dc, JSON.stringify(j, null, 2), 'utf8'); removed.push(dc + '(字段)'); } }
    } catch { /* 守柔 */ }
    try { const cfHome = path.join(os.homedir(), '.cloudflared'); if (fs.existsSync(cfHome)) for (const f of fs.readdirSync(cfHome)) if (f === 'cert.pem' || /\.json$/i.test(f)) backup(path.join(cfHome, f)); } catch { /* 守柔 */ }
    return { ok: true, message: '已退出账号并清空全部凭证残留' + (removed.length ? '（备份于 ' + backupDir + '）' : '') };
}
// 能力自测: 本地服务 health / exec — 与独立插件 ⚡能力自测 同构
function bridgeLocalApi(p: string, method: string, body?: any): Promise<{ status: number; text: string }> {
    return new Promise((resolve) => {
        const http = require('http');
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: '127.0.0.1', port: ws.port || DEFAULT_PORT, path: p, method: method || 'GET', headers: { Authorization: 'Bearer ' + (bridgeToken || ws.token), 'Content-Type': 'application/json' } }, (res: any) => {
            let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => resolve({ status: res.statusCode, text: d }));
        });
        req.on('error', (e: any) => resolve({ status: 0, text: String(e.message) }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
        if (data) req.write(data); req.end();
    });
}
// 在线设备 · 查询中枢(dao-bridge)代理注册表 — 走 conn.json 的本地端口 + 令牌(整机直连, 免公网往返)。
function bridgeHubApi(p: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve) => {
        let port = 0, token = '';
        try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dao', 'bridge', 'conn.json'), 'utf8')); port = c.port || 0; token = c.token || ''; } catch { /* 守柔 */ }
        if (!port) { resolve({ status: 0, text: 'no bridge port' }); return; }
        const http = require('http');
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res: any) => {
            let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => resolve({ status: res.statusCode, text: d }));
        });
        req.on('error', (e: any) => resolve({ status: 0, text: String(e.message) }));
        req.setTimeout(12000, () => { req.destroy(); resolve({ status: 0, text: 'timeout' }); });
        req.end();
    });
}

function bridgeFindCloudflared(): string {
    const { execSync } = require('child_process');
    const isWin = process.platform === 'win32';
    // 1. 已知位置优先(直接二进制, 不走 npm wrapper 等间接脚本)
    const candidates = [
        path.join(os.homedir(), '.dao', 'bin', 'cloudflared.exe'),
        path.join(os.homedir(), '.dao', 'bin', 'cloudflared'),
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
        'C:\\cloudflared\\cloudflared.exe',
        '/usr/local/bin/cloudflared',
        '/usr/bin/cloudflared',
        '/opt/homebrew/bin/cloudflared',
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    // 2. PATH 解析(跨平台)。根治(同 selfUpdateFindCli 旧坑): 旧版仅用 Windows 专属 `where`
    //    → 非 Win 恒失败; 且兜底返回字面量 'cloudflared' → 缺二进制时 spawn ENOENT 被吞,
    //    上层却报「隧道已启动」(臆造成功)。改为按平台解析, 找不到则返回空串由调用方诚实报错。
    try {
        if (isWin) {
            const lines = execSync('where cloudflared', { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
            for (const l of lines) { const p = l.trim(); if (p && /\.exe$/i.test(p) && fs.existsSync(p)) return p; }
        } else {
            const p = execSync('command -v cloudflared', { encoding: 'utf8', timeout: 5000 }).trim();
            if (p && fs.existsSync(p)) return p;
        }
    } catch { /* 守柔 */ }
    return ''; // 未找到: 返回空串(不再返回字面量制造假成功)
}

async function bridgeStartTunnel(named: boolean): Promise<{ ok: boolean; reason?: string; url?: string; reused?: boolean }> {
    const { spawn } = require('child_process');
    bridgeEnsureDir();
    // 帛书·「知常曰明」: 对外令牌恒等机器级恒稳源 ws.token(載盤即復·永不再漂);
    //   仅 ws.token 极早期缺位才回落持久 auth-token / 新铸, 杜绝窗口重载凭空铸新牌致已发布令牌静默失效。
    bridgeToken = ws.token || bridgeToken || bridgeLoadAuthToken() || crypto.randomBytes(24).toString('hex');
    bridgeSaveAuthToken(bridgeToken);
    // ① 守柔复用(無死地): 上一个宿主留下的 cloudflared 仍脱宿主存活, 且日志含可达 URL
    //    → 直接复用其隧道, 绝不新起第二条(杜绝隧道增殖/地址漂移)。这正是「窗口重载却不断线」的根。
    if (!named) {
        const existingPid = cfPidAlive();
        if (existingPid) {
            const u = cfReadUrlFromLog();
            // 帛书·「以实际有效性为基准」: 仅当孤儿隧道所绑 origin 端口仍真有 dao-vsix 应答, 才复用;
            //   否则(端口已漂移/实例已消亡, 如钉死 9920)必重绑活端口, 不再复用死隧道致 502 长滞留。
            const boundPort = cfReadBoundPort();
            let originAlive = false;
            if (u && boundPort) { try { originAlive = !!(await daoProbeHealth(boundPort)); } catch (eRU1) { /* 守柔 */ } }
            if (u && originAlive) {
                bridgeProc = null; // 不持有句柄: 它是孤儿进程, 仍在独立跑, 本宿主只跟随其日志
                bridgeUrl = u;
                bridgeSaveConnJson();
                bridgeWriteArtifacts();
                refreshDaoCloudMiddlePanel();
                bridgeStartUrlPoll();
                return { ok: true, reused: true, url: u };
            }
            // 孤儿隧道绑的是死端口(或无端口记录) → 诚实收尸: 杀孤儿 + 清元数据 + 清日志, 落入下方重起。
            try { process.kill(existingPid); } catch (eRU2) { /* 守柔 */ }
            try { fs.unlinkSync(CF_PID); } catch (eRU3) { /* 守柔 */ }
            try { fs.unlinkSync(CF_PORT); } catch (eRU4) { /* 守柔 */ }
            try { fs.writeFileSync(CF_LOG, ''); } catch (eRU5) { /* 守柔 */ }
        }
    }
    // 帛书补丁·万流归宗闸: backoff计数+退避+leader+冷却 统一内置于唯一创建入口,
    //   令 autoPersist / livenessTick / 手动 等一切自动调用方共享同一限流·同一选举,
    //   杜绝 autoPersist 等旁路绕过闸门无限自起的根因抖动。「反者道之动·弱者道之用」
    if (!named) {
        // 退避计数: 审视上次自起结果 — 速亡(无URL+进程已死)或逾建立期无URL → 失败+指数退避
        try {
            if (_cfLastStartMs && _cfLastStartMs !== _cfLastCountedStartMs) {
                const _sa = Date.now() - _cfLastStartMs;
                const _haveUrl = !!cfReadUrlFromLog();
                const _aliveNow = !!cfPidAlive();
                // 限流签名优先: 即便日志已打印 URL, 只要见 1015/429 即知该 URL 边缘恒 530 → 施长冷却,
                //   不清零退避、不复用假 URL。让按 IP 封禁自消, 杜绝「有 URL 即判成功」的越锤越死盲区。
                if (cfLogHasRateLimit()) {
                    _cfLastCountedStartMs = _cfLastStartMs;
                    _cfSpawnFails = Math.min(_cfSpawnFails + 1, 8);
                    _cfBackoffUntilMs = Date.now() + CF_RATELIMIT_COOLDOWN_MS;
                    daoLoopLog('tunnel', '隧道限流(1015/429)#' + _cfSpawnFails + '→长冷却' + Math.round(CF_RATELIMIT_COOLDOWN_MS / 60000) + 'min');
                }
                else if (_haveUrl) { _cfSpawnFails = 0; _cfBackoffUntilMs = 0; _cfLastCountedStartMs = _cfLastStartMs; }
                else if ((!_aliveNow && _sa > 6000) || _sa > CF_ESTABLISH_GRACE_MS) {
                    _cfLastCountedStartMs = _cfLastStartMs;
                    _cfSpawnFails = Math.min(_cfSpawnFails + 1, 8);
                    const _bo = Math.min(CF_BACKOFF_MAX_MS, 30000 * Math.pow(2, _cfSpawnFails - 1));
                    _cfBackoffUntilMs = Date.now() + _bo;
                    daoLoopLog('tunnel', '隧道自起失败#' + _cfSpawnFails + '(无URL/进程速亡)→退避' + Math.round(_bo / 1000) + 's');
                }
            }
        } catch (eBK) { /* 守柔 */ }
        // ① 退避闸: 限流冷却期不锤 API
        if (_cfBackoffUntilMs && Date.now() < _cfBackoffUntilMs) {
            daoLoopLog('tunnel', '退避中·剩' + Math.round((_cfBackoffUntilMs - Date.now()) / 1000) + 's [startTunnel]');
            return { ok: false, reason: 'backoff-active' };
        }
        // ② leader 闸: shared cloudflared 仅 leader(端口最小活实例)独管
        if (!bridgeIsLeaderInstance()) {
            daoLoopLog('tunnel', '非leader·port=' + (ws.port || 0) + '/leader=' + bridgeMachinePort() + ' [startTunnel]');
            return { ok: false, reason: 'not-leader' };
        }
        // ③ 冷却闸: 防连环重启
        if (_cfLastStartMs && (Date.now() - _cfLastStartMs) < CF_RESTART_COOLDOWN_MS) {
            daoLoopLog('tunnel', '冷却中·剩' + Math.round((CF_RESTART_COOLDOWN_MS - (Date.now() - _cfLastStartMs)) / 1000) + 's [startTunnel]');
            return { ok: false, reason: 'cooldown-active' };
        }
    }
    // 决定新起隧道: 先清掉本进程句柄与任何残留孤儿, 避免双隧道
    if (bridgeProc) { try { bridgeProc.kill(); } catch {} bridgeProc = null; }
    const staleOrphan = cfPidAlive();
    if (staleOrphan) { try { process.kill(staleOrphan); } catch {} }
    const cfPath = bridgeFindCloudflared();
    // 守柔·不臆造成功: 缺 cloudflared 二进制时不假装已启动, 诚实回报由调用方提示用户。
    if (!cfPath) { return { ok: false, reason: 'cloudflared-not-found' }; }
    // 隧道 origin 恒绑「活着的 leader 端口」(最小的真应答实例), 而非本窗口私有 ws.port —
    //   否则本窗口一关, 隧道即指向死端口 502 且无人重绑。
    let targetPort = ws.port || DEFAULT_PORT;
    try { const lp = await bridgeLeaderOriginPort(); if (lp) targetPort = lp; } catch (eTP1) { /* 守柔 */ }
    const localUrl = `http://127.0.0.1:${targetPort}`;
    let args: string[];
    if (named) {
        const tok = bridgeReadNamedToken();
        args = ['tunnel', 'run', '--token', tok];
    } else {
        args = ['tunnel', '--url', localUrl, '--no-autoupdate'];
    }
    // 帛书·「無死地」: detached:true + stdio 重定向到日志文件 + unref()
    //   → cloudflared 脱离扩展宿主独立存活; 宿主重载/重启不再带走隧道与 URL。
    //   URL 改从日志文件轮询读取(detached 后无事件流可听)。
    try { fs.writeFileSync(CF_LOG, ''); } catch {}
    let out = 'ignore';
    try { out = fs.openSync(CF_LOG, 'a') as any; } catch {}
    try {
        bridgeProc = spawn(cfPath, args, { stdio: ['ignore', out, out], detached: true });
    } catch {
        try { bridgeProc = spawn(cfPath, args, { stdio: 'ignore', detached: true }); }
        catch { bridgeProc = null; }
    }
    // ENOENT 等 spawn 失败在 *nix 多以异步 'error' 事件呈现(pid 为空)。挂监听避免未捕获 'error' 掀翻宿主,
    //   并据 pid 判定是否真起来(无 pid → 诚实回报失败, 不再静默假成功)。
    if (!bridgeProc || !bridgeProc.pid) {
        if (bridgeProc) { try { bridgeProc.on('error', () => { bridgeProc = null; }); } catch {} }
        return { ok: false, reason: 'spawn-failed' };
    }
    try { fs.writeFileSync(CF_PID, String(bridgeProc.pid)); } catch {}
    try { cfWriteBoundPort(targetPort); } catch (e161b) { /* 守柔 */ }
    _cfLastStartMs = Date.now();
    try { bridgeProc.unref(); } catch {}
    bridgeStartUrlPoll();
    bridgeProc.on('error', () => { bridgeProc = null; refreshDaoCloudMiddlePanel(); });
    bridgeProc.on('exit', () => { bridgeProc = null; refreshDaoCloudMiddlePanel(); });
    return { ok: true };
}

function bridgeStopTunnel() {
    if (bridgeProc) { try { bridgeProc.kill(); } catch {} bridgeProc = null; }
    // 收尸脱宿主孤儿: 仅 kill 本窗口句柄不够(复用来的孤儿 bridgeProc 恒 null → 旧法什么也没杀,
    //   下次 start 又从日志读到同一死 URL 复用 → 死隧道永生。故按 PID 文件真杀 + 清端口/日志。)
    try { const op = cfPidAlive(); if (op) process.kill(op); } catch (e163b) { /* 守柔 */ }
    try { fs.unlinkSync(CF_PID); } catch (e163c) { /* 守柔 */ }
    try { fs.unlinkSync(CF_PORT); } catch (e163d) { /* 守柔 */ }
    try { fs.writeFileSync(CF_LOG, ''); } catch (e163e) { /* 守柔 */ }
    bridgeUrl = '';
    bridgeSaveConnJson();
    refreshDaoCloudMiddlePanel();
}

// ═══════════════════════════════════════════════════════════
// 帛书·「反者道之动」— VSIX 自更新: 从 GitHub Release 检查/下载最新 VSIX, 安装后提示重载。
//   根治: 桌面端无 VSIX 自更新机制 → 插件永远停在安装时版本, 新修复/新功能均无法自动落地,
//   用户误以为「推了就生效」实际代码从未变化。自带 GitHub 镜像多路回落(直连+国内加速)。
// ═══════════════════════════════════════════════════════════
let _selfUpdateLastCheck = 0;
const SELF_UPDATE_INTERVAL = 6 * 3600 * 1000;
const SELF_UPDATE_DIR = path.join(DAO_DIR, 'update');
const SELF_UPDATE_REPO = 'zhouyoukang1234-spec/devin-remote';
const SELF_UPDATE_TAG_PREFIX = 'dao-vsix-v';

function selfUpdateCompareVer(a: string, b: string): number {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const va = pa[i] || 0, vb = pb[i] || 0; if (va !== vb) return va - vb; }
    return 0;
}

function selfUpdateFindCli(): string {
    const { execSync } = require('child_process');
    const ideName = path.basename(process.execPath).replace(/\.exe$/i, '').toLowerCase();
    const names = [ideName, 'code', 'windsurf', 'cursor', 'devin', 'devin-desktop'];
    // ① 先按安装目录推导 bin CLI(根治: VSCode 系发行版 CLI 多在 <安装根>/bin/*.cmd, 常不在 PATH。
    //    旧法仅靠 `where` → CLI 不在 PATH 即找不到 → 自更新静默失败, 这是"更新闭环没生效"的真因)。
    try {
        const exeDir = path.dirname(process.execPath);            // 如 E:\Windsurf
        const isWin = process.platform === 'win32';
        const binDirs = [path.join(exeDir, 'bin'), path.join(exeDir, '..', 'bin'), exeDir];
        for (const d of binDirs) {
            for (const n of names) {
                for (const ext of isWin ? ['.cmd', '.exe', ''] : ['', '.sh']) {
                    try { const p = path.join(d, n + ext); if (fs.existsSync(p)) return p; } catch { /* 守柔 */ }
                }
            }
        }
    } catch { /* 守柔 */ }
    // ② 退路: PATH 查找(where/which)
    const finder = process.platform === 'win32' ? 'where' : 'which';
    for (const name of names) {
        try {
            const lines = execSync(`${finder} ${name}`, { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
            for (const l of lines) { const p = l.trim(); if (p && fs.existsSync(p)) return p; }
        } catch {}
    }
    return '';
}

function selfUpdateGhMirrors(u: string): string[] {
    return [u, 'https://ghfast.top/' + u, 'https://gh-proxy.com/' + u, 'https://mirror.ghproxy.com/' + u, 'https://ghproxy.net/' + u];
}

function selfUpdateHttpGet(url: string, ms: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : require('http');
        const req = mod.get(url, { timeout: ms, headers: { 'User-Agent': 'dao-vsix/' + EXT_VERSION } }, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { selfUpdateHttpGet(res.headers.location, ms).then(resolve, reject); return; }
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            let d = ''; res.on('data', (c: any) => { d += c; }); res.on('end', () => resolve(d)); res.on('error', reject);
        });
        req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function selfUpdateDownload(url: string, dst: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        const mod = url.startsWith('https') ? https : require('http');
        const req = mod.get(url, { timeout: ms, headers: { 'User-Agent': 'dao-vsix/' + EXT_VERSION } }, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { selfUpdateDownload(res.headers.location, dst, ms).then(resolve); return; }
            if (res.statusCode !== 200) { resolve(false); return; }
            const ws2 = fs.createWriteStream(dst); res.pipe(ws2);
            ws2.on('finish', () => { ws2.close(); resolve(true); }); ws2.on('error', () => resolve(false));
        });
        req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function bridgeSelfUpdateCheck(): Promise<void> {
    if (Date.now() - _selfUpdateLastCheck < SELF_UPDATE_INTERVAL) return;
    _selfUpdateLastCheck = Date.now();
    try {
        const apiUrl = `https://api.github.com/repos/${SELF_UPDATE_REPO}/releases?per_page=15`;
        let body = '';
        for (const m of selfUpdateGhMirrors(apiUrl)) { try { body = await selfUpdateHttpGet(m, 15000); break; } catch {} }
        if (!body) { daoLoopLog('update', '自更新: 无法访问 releases API(含镜像)'); return; }
        const rels = JSON.parse(body); if (!Array.isArray(rels)) return;
        let latVer = '', dlUrl = '';
        for (const r of rels) {
            const tag = r.tag_name || ''; if (!tag.startsWith(SELF_UPDATE_TAG_PREFIX)) continue;
            const v = tag.slice(SELF_UPDATE_TAG_PREFIX.length);
            if (!latVer || selfUpdateCompareVer(v, latVer) > 0) { latVer = v; const a = (r.assets || []).find((x: any) => x.name && x.name.endsWith('.vsix')); if (a) dlUrl = a.browser_download_url; }
        }
        if (!latVer || !dlUrl) return;
        if (selfUpdateCompareVer(latVer, EXT_VERSION) <= 0) { daoLoopLog('update', `自更新: 已是最新 v${EXT_VERSION}`); return; }
        daoLoopLog('update', `自更新: 发现 v${latVer}(当前 v${EXT_VERSION})→下载`);
        fs.mkdirSync(SELF_UPDATE_DIR, { recursive: true });
        const vsixPath = path.join(SELF_UPDATE_DIR, `dao-vsix-${latVer}.vsix`);
        if (!(fs.existsSync(vsixPath) && fs.statSync(vsixPath).size > 10000)) {
            let ok = false;
            for (const m of selfUpdateGhMirrors(dlUrl)) { try { if (await selfUpdateDownload(m, vsixPath, 120000)) { ok = true; break; } } catch {} }
            if (!ok || !fs.existsSync(vsixPath) || fs.statSync(vsixPath).size < 10000) { daoLoopLog('update', '自更新: VSIX 下载失败'); try { fs.unlinkSync(vsixPath); } catch {} return; }
        }
        const cli = selfUpdateFindCli();
        if (!cli) { daoLoopLog('update', '自更新: 未找到 IDE CLI'); return; }
        daoLoopLog('update', `自更新: 安装 v${latVer} via ${path.basename(cli)}`);
        const { execSync } = require('child_process');
        try { execSync(`"${cli}" --install-extension "${vsixPath}" --force`, { encoding: 'utf8', timeout: 60000 }); } catch (e: any) { daoLoopLog('update', `自更新: 安装失败 ${e.message || e}`); return; }
        daoLoopLog('update', `自更新: v${latVer} 安装成功→等待重载`);
        vscode.window.showInformationMessage(`DAO 插件已更新到 v${latVer}（当前 v${EXT_VERSION}），重载窗口即生效。`, '立即重载', '稍后').then((c) => { if (c === '立即重载') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
        try { for (const f of fs.readdirSync(SELF_UPDATE_DIR)) { if (f.endsWith('.vsix') && f !== path.basename(vsixPath)) try { fs.unlinkSync(path.join(SELF_UPDATE_DIR, f)); } catch {} } } catch {}
    } catch (e: any) { daoLoopLog('update', `自更新: 异常 ${e.message || e}`); }
}

// 归一·全功能公网可达: 公布本体全功能 API 端口/令牌, 供常驻桥(dao-bridge)反代落点。
//   桥读取 ~/.dao/bridge/plugin-api.json 的 port → 把非桥自有路由透明反代到本体 → 单隧道暴露全功能。
function bridgePublishPluginApi() {
    try {
        bridgeEnsureDir();
        const data = {
            port: ws.port || DEFAULT_PORT,
            token: ws.token,
            host: os.hostname(),
            pid: process.pid,
            version: EXT_VERSION,
            updated: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(BRIDGE_DIR, 'plugin-api.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch { /* 守柔 */ }
}

function bridgeSaveConnJson() {
    bridgeEnsureDir();
    const wsInfo = { name: vscode.workspace.workspaceFolders?.[0]?.name || '', root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '' };
    const data = {
        url: bridgeUrl, token: ws.token || bridgeToken,
        local_url: 'http://127.0.0.1:' + (ws.port || DEFAULT_PORT),
        port: ws.port || DEFAULT_PORT, workspace: wsInfo.name, root: wsInfo.root,
        host: os.hostname(), updated: new Date().toISOString(), version: EXT_VERSION,
    };
    fs.writeFileSync(path.join(BRIDGE_DIR, 'conn.json'), JSON.stringify(data, null, 2), 'utf8');
    // Also write to global location for other extensions
    try { fs.writeFileSync(path.join(BRIDGE_DIR, 'connection.json'), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

function bridgeWriteArtifacts() {
    bridgeEnsureDir();
    fs.writeFileSync(path.join(BRIDGE_DIR, 'cloud-agent.md'), bridgeGenerateCloudMd(), 'utf8');
    fs.writeFileSync(path.join(BRIDGE_DIR, 'local-agent.md'), bridgeGenerateLocalMd(), 'utf8');
    fs.writeFileSync(path.join(BRIDGE_DIR, 'workspace.md'), bridgeGenerateCloudMd(), 'utf8');
}

function bridgeGenerateCloudMd(pair?: { url: string; token: string }): string {
    const wsInfo = { name: vscode.workspace.workspaceFolders?.[0]?.name || 'workspace', root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', host: os.hostname() };
    const ts = new Date().toISOString();
    // 帛书·「URL 与 Token 恒成对」: 注入的令牌必须与注入的 URL 同源配对(经实测有效的那一对),
    //   而非独立各取所谓权威 — 旧法 URL 取常驻桥隧道、Token 取机器牌, 两相脱域 → 云端 exec 恒 401。
    const tok = (pair && pair.token) || bridgeEffectiveToken();
    // ① 反向注入自愈: 公网URL 取「进程内隧道 ∪ 常驻桥已发布连接」的有效值, 不再只认进程内 bridgeUrl。
    //   独立 dao-bridge 常驻桥持有隧道时, 进程内 bridgeUrl 恒空 → 旧法注入「(未连接)」害云端找不到端口; 此处回归活地址。
    const url = (pair && pair.url) || bridgeEffectiveUrl() || '(未连接)';
    const port = bridgeMachinePort() || ws.port || DEFAULT_PORT;
    // 道法自然 · 回归本源 (dao-bridge 初始形态): 内网穿透文档只讲「整机直连」——
    //   接入信息 + 基础整机端点 + Python SDK。四大模块的深层操作已独立为 DAO Bridge MCP
    //   (见「MCP 使用文档」), 本文档不再内联四大模块, 保持简明、日常即用。
    return [
        '# ☯ DAO Bridge · 内网穿透接入文档',
        '',
        '> 本文档供云端 Agent(Devin Cloud 等)读取，经内网穿透**直连并远程操作用户本地电脑**(整机)。',
        '> 插件启动即零配置打通整机公网穿透；**端口和 URL 会随隧道重启而变化，以本文档为准**。',
        '',
        '## 接入信息',
        '',
        '```',
        `公网URL:   ${url}`,
        `Local URL: http://127.0.0.1:${port}`,
        `Token:     ${tok}`,
        `Auth:      Authorization: Bearer ${tok}`,
        `本地端口: ${port}   主机: ${wsInfo.host}   工作区: ${wsInfo.name}   根目录: ${wsInfo.root}`,
        `更新于:  ${ts}`,
        '```',
        '',
        '所有请求 Header: `Authorization: Bearer <Token>`(`/api/health` 免鉴权)。',
        '',
        '## ⚡ 云端 Agent · 断线零人工自愈(务必先读)',
        '',
        '> **公网URL 会随隧道重启而变。本插件已自带闭环:自动识别端口 → 打不通自动刷新隧道 → 自动把新 URL 反向注入回本知识条目。**',
        '> 因此云端 Agent **永远不需要找用户重发地址**——遇到旧地址打不通,只需**重读「本知识条目」**即可拿到当前可达 URL。',
        '',
        '**自愈配方(零人工):**',
        '1. 用上面「接入信息」的 公网URL 调 `GET /api/health`。**2xx = 活**,直接继续操作。',
        '2. 若 **5xx / 超时 / DNS 解析失败 = 隧道已轮换**:不要问用户。**重新读取本知识条目**(插件在探测到隧道死后 ≤30s 会自动把它改写为新 URL;看「更新于」时间戳判断新鲜度)。',
        '3. 若重读仍是旧地址(插件正在重建隧道):**每 30s 重读一次本条目,最多约 5 分钟**;新 URL 出现且 `/api/health` 通即自动接管。',
        '4. 仅当 > 5 分钟仍无新鲜可达 URL,才提示用户重启 IDE(极少发生)。',
        '',
        '> 道理:`自动识别 → 自动刷新 → 自动反注入本库` 是插件内建的反向闭环;云端只要「**遇死即重读本库**」整条链路即闭合,无为而无不为。',
        '',
        '## 🛰️ 去中心化路线C(零中心兜底·ntfy mesh)',
        '',
        '> 取自手机版同源底座。**即使上面 cloudflared 公网URL 与中继 Worker 同时全挂**, 仍能经多家',
        '> 互不隶属的公共 ntfy pub/sub 加密直达本机(任一 broker 可达即通·无单点)。控制面 RPC 帧与整机端点同构,',
        '> 故 `/api/exec`、`/api/file`、`/api/ls` 等照常可用。公共 broker 全程只见密文(载荷以 token 派生 AES-256-GCM 封装)。',
        '',
        '```',
        `去中心化 Session: ${sigState.session || sigSessionId()}`,
        `Token(mesh 专用): ${bridgeAuthoritativeToken() || tok}`,
        `Brokers:         ${(sigState.servers.length ? sigState.servers : SIG_DEFAULT_SERVERS).join('  ')}`,
        '```',
        '',
        '**何时用**:仅当「公网URL 反复重读仍 5xx/超时」(隧道与 Worker 同时不可用)时, 作为终极兜底。平时优先用上面的公网URL。',
        '',
        '**Python 客户端(零中心·实时订阅版, 仅需 `cryptography`)**。已实测往返 RTT≈1.4s, `/api/exec` 等整机端点照常可用:',
        '```python',
        'import urllib.request, json, ssl, os, hashlib, base64, time, secrets, threading',
        'from cryptography.hazmat.primitives.ciphers.aead import AESGCM',
        "for k in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'): os.environ.pop(k,None)",
        "os.environ['NO_PROXY']='*'",
        'ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE',
        'opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))',
        `SESSION=${JSON.stringify(sigState.session || sigSessionId())}; TOKEN="${tok}"`,
        `BROKERS=${JSON.stringify(sigState.servers.length ? sigState.servers : SIG_DEFAULT_SERVERS)}`,
        'KEY=hashlib.sha256((SESSION+"\\n"+TOKEN+"\\ndao-sig").encode()).digest()',
        'TOPIC="dao"+hashlib.sha256(("topic\\n"+SESSION).encode()).hexdigest()[:24]',
        'def seal(obj):',
        '    iv=secrets.token_bytes(12); return base64.b64encode(iv+AESGCM(KEY).encrypt(iv,json.dumps(obj).encode(),None)).decode()',
        'def unseal(b):',
        '    raw=base64.b64decode(b); return json.loads(AESGCM(KEY).decrypt(raw[:12],raw[12:],None))',
        '_buf={}; _ans={}; _lock=threading.Lock()',
        'def _sub(broker):',
        '    while True:',
        '        try:',
        '            r=opener.open(broker+"/"+TOPIC+"/json",timeout=300)',
        '            for line in r:',
        '                try: m=json.loads(json.loads(line.decode()).get("message","null"))',
        '                except Exception: continue',
        '                if not m or m.get("r")!="s" or not m.get("c"): continue',
        '                with _lock:',
        '                    e=_buf.setdefault(m["c"],{}); e[m["i"]]=m["p"]',
        '                    if len(e)>=m["n"]:',
        '                        try: _ans[m["c"]]=unseal("".join(e[k] for k in sorted(e)))',
        '                        except Exception: pass',
        '        except Exception: time.sleep(2)',
        'for b in BROKERS: threading.Thread(target=_sub,args=(b,),daemon=True).start()',
        'time.sleep(2)  # 让订阅流建立',
        'def pub(frame):',
        '    for s in BROKERS:',
        '        try: opener.open(urllib.request.Request(s+"/"+TOPIC,data=frame.encode(),method="POST"),timeout=8); return True',
        '        except Exception: continue',
        '    return False',
        'def rpc(path,method="GET",body=None,timeout=40):',
        '    corr=secrets.token_hex(8); payload=seal({"t":"rpc","id":corr,"path":path,"method":method,"body":body})',
        '    n=(len(payload)+1199)//1200 or 1',
        '    for i in range(n): pub(json.dumps({"v":1,"c":corr,"r":"q","i":i,"n":n,"p":payload[i*1200:(i+1)*1200]}))',
        '    deadline=time.time()+timeout',
        '    while time.time()<deadline:',
        '        with _lock:',
        '            if corr in _ans: return _ans.pop(corr)',
        '        time.sleep(0.3)',
        '    raise TimeoutError("route-C no answer")',
        'print(rpc("/api/health"))',
        'print(rpc("/api/exec","POST",{"cmd":"hostname"}))',
        '```',
        '',
        '## 整机端点',
        '',
        '经这些端点即可直连这台电脑，读写文件 / 执行命令 / 操作整机。',
        '',
        '| 方法 | 路径 | Body | 说明 |',
        '|---|---|---|---|',
        '| GET | `/api/health` | - | 存活(免鉴权) |',
        '| GET | `/api/connection` | - | 连接信息 |',
        '| GET | `/api/workspace` | - | 工作区信息 |',
        '| GET | `/api/bridge-state` | - | 隧道完整状态 |',
        '| POST | `/api/exec` | `{cmd,timeout}` | 在本机执行任意命令/PowerShell(整机核心) |',
        '| POST | `/api/ls` | `{path}` | 列目录 |',
        '| POST | `/api/file` | `{path}` | 读文件 |',
        '| POST | `/api/write` | `{path,content}` | 写文件 |',
        '| POST | `/api/search` | `{query,path}` | 搜索 |',
        '| POST | `/api/edit` | `{path,edits}` | 编辑 |',
        '| GET | `/api/agents` | - | 在线设备列表(已接入本中枢的设备·含状态/主机/最后心跳) |',
        '| GET | `/api/next` | - | **无缝接力**: 解析「下一个活接口」(current/alive/epoch) |',
        '',
        '## 无缝接力 · 重启/切号不断连',
        '',
        '> IDE 或窗口重启、切号时，账号 API 的**端口会变**；但 Token 机器级恒定，常驻桥(本公网隧道)独立进程不随窗口死。',
        '> 故任何时候都能解析到「下一个活接口」，无需人工重发地址。',
        '',
        '权威真相文件(常驻桥可直接读，最稳)：`~/.dao/dao-conn-current.json`',
        '```',
        '{ "url","token","port","host","pid","epoch", "alive":[{port,pid,url,devinEmail,...}] }',
        '```',
        '- `epoch` 单调递增：只要它比你上次见到的大，就说明接口轮换了，重新解析即可。',
        '- `alive` 列出当前所有活实例(多窗口/多账号)，`current` 取端口最小者为确定性 leader。',
        '',
        '**接力配方(重启后零人工)：** 经本公网隧道 `POST /api/exec` 读这份文件，拿到活端口+稳定 Token，继续操作：',
        '```',
        'POST /api/exec  { "cmd": "type %USERPROFILE%\\\\.dao\\\\dao-conn-current.json" }',
        '```',
        '或在仍有任一活窗口时直接 `GET /api/next` 一次拿到 `{current, alive, epoch}`。',
        '',
        '## 接入更多设备 · 一行 PowerShell',
        '',
        '在另一台 Windows 上以 PowerShell 运行下面这行，即把该机接入本中枢，出现在「在线设备」中并可被远程操控：',
        '',
        '```powershell',
        `irm ${url}/api/bootstrap.ps1 | iex`,
        '```',
        '',
        '接入后该设备长轮询 `/api/poll` 领命、回传 `/api/result`；用 `GET /api/agents` 查看全部在线设备。',
        '',
        '## Python SDK',
        '',
        '```python',
        'import urllib.request, json, ssl, os',
        "for k in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'): os.environ.pop(k,None)",
        "os.environ['NO_PROXY']='*'",
        'ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE',
        'urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx)))',
        `URL="${url}"`,
        `TOKEN="${tok}"`,
        'def api(m,p,body=None,t=30):',
        '    d=json.dumps(body).encode() if body else None',
        '    req=urllib.request.Request(f"{URL}{p}",data=d,headers={"Authorization":f"Bearer {TOKEN}","Content-Type":"application/json"},method=m)',
        '    return json.loads(urllib.request.urlopen(req,timeout=t).read())',
        'print(api("GET","/api/health"))',
        'print(api("POST","/api/exec",{"cmd":"hostname"}))',
        '```',
        '',
        '## 需要更深层的专业操作？',
        '',
        '浏览器自动化(CDP) / GUI 鼠键截屏 / 窗口控件树 / VSCode 命令等**四大模块**能力，已独立为',
        '**DAO Bridge MCP**(已随账号反向注入，HTTP 传输，无需手动配置)。直接以 MCP 工具调用即可，',
        '用法见知识库另一篇「DAO Bridge MCP 使用文档(四大模块)」。',
        '',
        '*道法自然 · 无为而无不为*',
    ].join('\n');
}

// 道法自然 · MCP 使用文档 (四大模块) — 反向注入为第三篇知识。讲清四大模块 MCP「是什么/怎么用」,
//   日常整机直连仍走简版内网穿透 MD; 需要更深层专业操作时, Agent 转用本 MCP。
function bridgeGenerateMcpUsageMd(): string {
    let mcpUrl = '';
    try { const ep = daoResolveMcpEndpoint(); if (ep) { mcpUrl = ep.url; } } catch { /* 守柔 */ }
    const endpoint = mcpUrl || '(随隧道动态生成·已自动注入到账号 MCP 列表)';
    // 软编码: 工具按前缀归组, 数量/名称全由 daoMcpToolDefs() 实时生成 → 永不与实际 /mcp 走样(为变所适)。
    const groups: { [k: string]: string[] } = {}; const order: string[] = [];
    try {
        for (const t of daoMcpToolDefs()) {
            const g = (String(t.name).split('_')[0] || 'misc') + '_*';
            if (!groups[g]) { groups[g] = []; order.push(g); }
            groups[g].push(t.name);
        }
    } catch { /* 守柔 */ }
    const meta: { [k: string]: string } = {
        'pc_*': '操作整机(鼠键/截屏/执行/文件/剪贴板·对等你操作自己电脑)',
        'browser_*': '把插件当浏览器(Chrome CDP·Playwright/Chrome-MCP 级·对等你操作自己浏览器)',
        'plugin_*': '软件本体(公开所有 /api 端口·读写/编辑/搜索/终端/git/热修)',
        'vscode_*': 'IDE 对等(命令/诊断/定义/引用/符号/打开/活动编辑器)',
    };
    let total = 0;
    const rows = order.map(g => { total += groups[g].length; return '| `' + g + '` | ' + (meta[g] || '') + ' | ' + groups[g].length + ' · ' + groups[g].join(' / ') + ' |'; });
    const host = os.hostname();
    const wsName = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].name) || '';
    return [
        '# ☯ DAO Bridge MCP · 归一 MCP 使用文档',
        '',
        '> 一个公网 MCP 端点统摄四模块——把你的电脑 / 浏览器 / IDE / 插件本体当作我自己的来操作(对等·浑然一体)。',
        '> 已作为自定义 MCP **反向注入到账号**(HTTP/Streamable·无需手动配置)；先 `tools/list` 再 `tools/call`。',
        '',
        '## 接入',
        '',
        '- 端点：' + endpoint,
        '- 鉴权：`Authorization: Bearer <已随注入下发>`',
        '- 本机：' + host + (wsName ? ' · 工作区 ' + wsName : '') + ' · 插件 v' + EXT_VERSION + ' · 工具 ' + total + ' 个',
        '',
        '## 四模块工具(归一·软编码实时自生成)',
        '',
        '| 组 | 模块 | 工具 |',
        '|---|---|---|',
        ...rows,
        '',
        '## 断线零人工自愈(务必先读·与内穿文档同源)',
        '',
        '> 端点随隧道重启而变。插件已自带闭环：**自动识别 → 打不通自动刷新 → 自动把新地址反向注入回本条目**。',
        '',
        '1. 用上面端点调 `tools/list`。**2xx=活** → 直接 `tools/call`。',
        '2. 若 5xx/超时/DNS 失败=隧道已轮换：**不要问用户**，重读本知识条目拿当前可达 `/mcp`(看「本机」行时效)。',
        '3. 重读仍旧址(插件正在重建)：每 30s 重读一次、最多约 5 分钟；新址出现且 `tools/list` 通即接管。',
        '',
        '> 设备 / IDE / 工具集 / 版本任一变化，插件即重生成本文并反向注入 → 你每次连上读到的恒是最新。',
        '',
        '*道法自然 · 无为而无不为*',
    ].join('\n');
}

function bridgeGenerateLocalMd(): string {
    // 归一: 本地详档 = 云端文档(同源)，杜绝两份走样。
    return bridgeGenerateCloudMd();
}

// 帛书·「反者道之动也」: 哨兵占位符 → 实时完整 MD 的唯一展开点。
// 本地注入档以哨兵存储(省体积), 任何「出云」前都必须在此展开为完整正文,
// 否则账号云端知识库会出现 `__DAO_BRIDGE_*_MD__` 空壳(用户编辑器里看到的"全是空的")。
function expandKbSentinel(name: string, body: string): string {
    const b = (body || '').trim();
    const isMcp = (b === DAO_MCP_KB_SENTINEL) || (name === DAO_MCP_KB_NAME && (b === DAO_BRIDGE_KB_SENTINEL || b === ''));
    if (isMcp) { try { return bridgeGenerateMcpUsageMd(); } catch { return body; } }
    const isBridge = (b === DAO_BRIDGE_KB_SENTINEL) || (name === DAO_BRIDGE_KB_NAME && b === '');
    if (isBridge) { try { return bridgeGenerateCloudMd(); } catch { return body; } }
    return body;
}

async function bridgeInjectKnowledge(): Promise<boolean> {
    if (!ws.devinAuth1 || !ws.devinOrgId) return false;
    // 帛书·「宁守柔而不以死覆生」: 注入前先公网实活校验本进程隧道地址。探到活址即收敛 bridgeUrl→注活址;
    //   若全死(含 bridgeUrl 空 / 502 / 530)则**不以 (未连接)/死址覆盖账号库良态**, 守柔退出, 待探活环重建隧道后再注。
    //   根治: autoPersist 路径旧法无此闸门, 隧道未捕获(publicUrl=null)时径直把死址/(未连接)写进知识库 → 云端读到连不上。
    try {
        const live = await bridgeResolveLiveConn(5000);
        if (live && live.url) { bridgeUrl = live.url; if (!ws.token && live.token) bridgeToken = live.token; }
        else { daoLoopLog('tunnel', 'injectKnowledge ABORT: 无活地址→守柔不覆盖良态'); return false; }
    } catch { /* 守柔 */ }
    const md = bridgeGenerateCloudMd();
    const knowledgeName = DAO_BRIDGE_KB_NAME;
    const trigger = DAO_BRIDGE_KB_TRIGGER;
    const orgId = ws.devinOrgId, auth1 = ws.devinAuth1;
    // 道并行而不相悖: 与切号自循环/整池注入(applyInjectProfileToOrg)共用同一 org 车道,
    //   内穿自愈的回写与档案注入永不交错跑各自的 list→删→建 → 杜绝竞态堆积。
    let okFlag = false;
    await withOrgInjectLock(orgId, async () => {
        // 知识③ MCP 使用文档(四大模块) 一并幂等回写到当前账号 (守 manual 锁由批量框架统一处理)
        try { await devinUpsertKnowledge(orgId, DAO_MCP_KB_NAME, bridgeGenerateMcpUsageMd(), DAO_MCP_KB_TRIGGER, auth1, true); } catch { /* 守柔 */ }
        // 幂等回写 (帛书·「少则得·多则惑」): 保留首个规范条目 → 原地 PATCH 更新, 多余重复全删 →
        // 收敛为唯一条目。杜绝旧法「删后建」在多窗口/最终一致下竞态堆积出几十条重复。
        //   注意: 收敛只针对内穿文档(同前缀), 必须排除 MCP 使用文档(独立一篇), 否则会被误删后再造成 flap。
        try {
            const listResult = await devinListKnowledge(orgId, auth1);
            let matches: any[] = [];
            if (listResult.ok && listResult.learnings) {
                matches = listResult.learnings.filter((k: any) => typeof k.name === 'string' && k.name !== DAO_MCP_KB_NAME && (k.name === knowledgeName || /^DAO Bridge/.test(k.name) || (k.trigger_description || '').includes('远程操作用户本地电脑')));
            }
            if (matches.length) {
                // 取最早(稳定锚点)为留存条目; 其余重复删除。
                const keep = matches.find((k: any) => k && k.id) || matches[0];
                for (const k of matches) {
                    if (k && k.id && k.id !== keep.id) { try { await devinDeleteKnowledge(orgId, k.id, auth1); } catch { /* 守柔 */ } }
                }
                if (keep && keep.id) {
                    const up = await devinUpdateKnowledge(orgId, keep.id, knowledgeName, md, trigger, auth1);
                    if (up.ok) { okFlag = true; return; }
                    // PATCH 不被后端支持时退回「删旧建新」(自愈)
                    try { await devinDeleteKnowledge(orgId, keep.id, auth1); } catch { /* 守柔 */ }
                }
            }
            const r = await devinInjectKnowledge(orgId, knowledgeName, md, trigger, auth1);
            okFlag = r.ok;
        } catch { okFlag = false; }
    });
    return okFlag;
}

// 读取"已发布"的桥连接文件 — 帛书·「以本为精」: 常驻桥(OS 级)每次重建隧道都把最新 URL 回写到约定文件,
// 二合一不必自起隧道, 只需读取这份真相即可显示持久连接(避免每次"未连接")。择最新(mtime)且非占位者。
const BRIDGE_CONN_FRESH_MS = 24 * 60 * 60 * 1000;
function bridgeReadPublishedConn(): { url: string; token: string; relayUrl?: string; session?: string; host?: string; updated?: string; source: string; ageMs: number } | null {
    const cands = [
        path.join(BRIDGE_DIR, 'conn.json'),
        path.join(os.homedir(), '.dao', 'cf-hub-conn.json'),
        path.join(os.homedir(), '.dao', 'bridge', 'connection.json'),
    ];
    let best: any = null;
    for (const f of cands) {
        try {
            const st = fs.statSync(f);
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            const url = String(j.url || '').trim();
            const relayUrl = String(j.relayUrl || j.relay || '').trim();
            // 跳过占位/空地址(如裸 api.trycloudflare.com)
            const validUrl = /^https?:\/\//.test(url) && !/\/\/api\.trycloudflare\.com\/?$/.test(url);
            if (!validUrl && !relayUrl) continue;
            if (!best || st.mtimeMs > best._mtime) {
                best = { url: validUrl ? url : '', token: String(j.token || ''), relayUrl: relayUrl || undefined, session: j.session || undefined, host: j.host, updated: j.updated, source: path.basename(f), _mtime: st.mtimeMs };
            }
        } catch { /* skip */ }
    }
    if (!best) return null;
    best.ageMs = Date.now() - best._mtime;
    delete best._mtime;
    return best;
}

// Bridge API route handler (exposed via /api/bridge-state)
// 帛书·「反者道之动」: 进程内隧道优先; 否则采纳常驻桥发布的新鲜连接 → 持久显示已连接。
function bridgeGetState(): any {
    const base = {
        localPort: ws.port || DEFAULT_PORT,
        localUrl: `http://127.0.0.1:${ws.port || DEFAULT_PORT}`,
        workspace: vscode.workspace.workspaceFolders?.[0]?.name || '',
        root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        version: EXT_VERSION,
    };
    if (bridgeUrl) {
        return Object.assign({ connected: true, persistent: false, source: 'inprocess', url: bridgeUrl, token: ws.token || bridgeToken, host: os.hostname(), updated: new Date().toISOString() }, base);
    }
    const pub = bridgeReadPublishedConn();
    if (pub && (pub.url || pub.relayUrl) && pub.ageMs < BRIDGE_CONN_FRESH_MS) {
        return Object.assign({ connected: true, persistent: true, source: pub.source, url: pub.url || pub.relayUrl, relayUrl: pub.relayUrl, session: pub.session, token: pub.token || ws.token, host: pub.host || os.hostname(), updated: pub.updated, ageMs: pub.ageMs }, base);
    }
    return Object.assign({ connected: false, persistent: false, source: '', url: '', token: ws.token || bridgeToken, host: os.hostname(), updated: new Date().toISOString() }, base);
}

// 智能持久化/刷新 — 帛书·「治人事天莫若啬」: 低频、去重、不与常驻桥重复起隧道。
// 策略: 有新鲜发布连接→采纳(不另起); 无→(仅当 cloudflared 可用)起快速隧道; 3-5h 内已同步则跳过,
// 除非窗口集变化(用户重开 IDE)才再同步一次。多窗口经共享 auto-sync.json 去重。
const BRIDGE_AUTOSYNC_FILE = path.join(BRIDGE_DIR, 'auto-sync.json');
const BRIDGE_SYNC_THROTTLE_MS = 4 * 60 * 60 * 1000;
async function bridgeAutoPersist(): Promise<void> {
    try {
        const cfg = vscode.workspace.getConfiguration('dao');
        if (!cfg.get<boolean>('bridgeAutoPersist', true)) return;
        bridgeEnsureDir();
        let last: any = {};
        try { last = JSON.parse(fs.readFileSync(BRIDGE_AUTOSYNC_FILE, 'utf8')); } catch { /* 首次 */ }
        const now = Date.now();
        const winKey = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.hostname();
        const throttled = !!(last.lastMs && (now - last.lastMs) < BRIDGE_SYNC_THROTTLE_MS);
        const windowChanged = !!(last.winKey && last.winKey !== winKey);
        // 独立闭环(鸡犬相闻·不相往来): 不读常驻桥 conn.json, 自己无隧道即自起, 与其他插件互不干扰。
        if (!bridgeUrl) { try { await bridgeStartTunnel(false); } catch { /* 守柔 */ } }
        // 内穿 MD 同步到当前账号 Knowledge(反向注入框架再扩散到所有账号) — 低频
        if (!throttled || windowChanged) { try { if (ws.devinAuth1 && ws.devinOrgId) await bridgeInjectKnowledge(); } catch { /* 守柔 */ } }
        try { fs.writeFileSync(BRIDGE_AUTOSYNC_FILE, JSON.stringify({ lastMs: now, winKey, url: bridgeUrl || '', source: 'started' }, null, 2), 'utf8'); } catch { /* 守柔 */ }
        // v3.17.4 · 同步后扩散最新隧道信息到所有账号(签名变化才真正注, 守柔省网)
        bridgeScheduleReinject('autoPersist');
        refreshDaoCloudMiddlePanel();
    } catch { /* 守柔 */ }
}

// ═══ 端口/URL 实时更新 · 存活探测环 — 帛书·「反者道之动」 ═══
//   逻辑(用户述): 打得通就保持稳定(不折腾、不重注); 打不通就刷新(重读已发布连接/重起隧道并把新 URL 重注各账号)。
//   守柔: 直连探测(绕过代理), 只有"死"才动手; "活"则什么也不做, 杜绝无谓 churn。
const BRIDGE_LIVENESS_INTERVAL_MS = 30 * 1000;
// 自适应自愈节律: 隧道一旦探死/未 settle, 8s 一探直至恢复(端口断了≤8s即重探/重起/重注 →
//   根治用户述「端口都断了根本连不上, 账号信息全没更新」的滞留); 恢复稳态后回落 30s 省网。
const BRIDGE_LIVENESS_FAST_MS = 8 * 1000;
let _bridgeLivenessTimer: ReturnType<typeof setTimeout> | null = null;
let _bridgeLivenessStopped = false;
let _bridgeLastAliveMs = 0;
let _bridgeLivenessFail = 0;
// 三环自检 · 统一审计日志 — 帛书·「自知者明」: 让隧道环/额度环的每次「识别→决策」可见可验(环① 另有 dao-pool-reconcile.log)。
//   守柔: 仅记瞬时决策(活/死·跟随/保持), 单文件滚动, 失败静默不扰主流程。
function daoLoopLog(tag: string, line: string): void {
    try { fs.appendFileSync(path.join(DAO_DIR, 'dao-loops.log'), new Date().toISOString() + ' [' + tag + '] ' + line + '\n'); } catch { /* 守柔 */ }
}
// 真验通达: relay 边缘(Worker)对一切请求(含 /api/health)强制 Bearer 鉴权 → 缺 token 必 401。
//   旧法 GET 无 token, 把 401(<500) 误判为"活" → relay 通道下隧道真断也探不出 → 知识库不会刷新。
//   故 relay 走信封 POST + Bearer, 校验内层健康体(非错误)才算活; 直连/命名隧道 GET /api/health(带 token 无害)。
function bridgeProbeAlive(rawUrl: string, timeoutMs: number = 6000, token: string = ''): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const fin = (v: boolean) => { if (!done) { done = true; resolve(v); } };
        try {
            const relay = /\/relay\//.test(rawUrl);
            const u = new URL(rawUrl);
            const isHttps = u.protocol === 'https:';
            const mod = require(isHttps ? 'https' : 'http');
            const headers: any = {};
            if (token) headers['Authorization'] = 'Bearer ' + token;
            let postData: string | null = null;
            const opts: any = { hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), timeout: timeoutMs, headers };
            if (relay) {
                opts.method = 'POST';
                opts.path = (u.pathname || '/') + (u.search || '');
                postData = JSON.stringify({ path: '/api/health', method: 'GET', body: {} });
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(postData);
            } else {
                opts.method = 'GET';
                opts.path = (u.pathname && u.pathname !== '/' ? u.pathname : '/api/health') + (u.search || '');
            }
            if (isHttps) opts.rejectUnauthorized = false;
            const req = mod.request(opts, (r: any) => {
                const sc = r.statusCode || 0;
                if (!relay) { r.resume(); return fin(sc >= 200 && sc < 500); }
                // relay: 必须 2xx 且内层非错误(健康 JSON)才算活 — 401/502/{error} 皆为死
                let body = '';
                r.setEncoding('utf8');
                r.on('data', (c: string) => { if (body.length < 8192) body += c; });
                r.on('end', () => {
                    if (sc < 200 || sc >= 300) return fin(false);
                    try { const j = JSON.parse(body); fin(!j.error); } catch { fin(body.length > 0); }
                });
            });
            req.on('timeout', () => { try { req.destroy(); } catch { /* 守柔 */ } fin(false); });
            req.on('error', () => fin(false));
            if (postData) req.write(postData);
            req.end();
        } catch { fin(false); }
    });
}
// 帛书·「以实际有效性为基准·反者道之动」: 公网URL 取「进程内隧道 ∪ 常驻桥已发布连接」的有效值。
//   进程内自有隧道(quick-tunnel)优先; 其空/死(常驻桥 dao-bridge 持有稳定隧道、bridgeUrl 恒空)时
//   回归常驻桥已发布的新鲜活地址 → 杜绝注入「(未连接)」/死址致云端连不上(见 bridgeGenerateCloudMd 注)。
function bridgeEffectiveUrl(): string {
    // 帛书·「独立闭环·得一」: 公网 URL 恒取本实例自有隧道 — 不再回落他者进程(独立 dao-bridge 扩展)
    //   发布的 conn.json。该桥恒写 url=""(从不发布可达地址), 回落之只得空址 → 徒污染同源配对。
    //   本实例自有隧道空/死时, 存活探测环(bridgeLiveness)会重起隧道; 期间诚实回空(不臆造死址)。
    return bridgeUrl || '';
}
// 帛书·「以实际有效性为基准·重新模拟配源」: 发布/探活/签名/去中心化会话一律取「服务端实际校验且
//   机器级恒稳」的权威令牌 ws.token (即 dao-conn-current.json 之 token), 而非随隧道轮换的 bridgeToken。
//   根治本源脱钩(错误认知): 旧法对外发布易变 bridgeToken, 重载/轮换即与 checkAuth 主令牌脱钩 →
//   云端按知识库读到的令牌已与服务端真验源失配 → 401。两令牌 checkAuth 皆放行, 但唯 ws.token 跨
//   重载恒稳 → 以其为「配源」即令「已发布令牌」永不因轮换失效, 无需被动等 URL 变才反注入。
// 公网隧道恒绑 leader 实例端点; 其令牌即 dao-conn-current.json/.token(活 leader)或 ~/.dao/api-token
//   (机器级恒稳·无工作区实例写)。带工作区的窗口实例 ws.token 可能是它自己的工作区私牌, 与公网端点
//   实际校验的 leader 牌脱钩 → 若以 ws.token 发布知识库, 必现「URL 对而 Token 错」(URL 由活探解析刷新,
//   Token 却是该窗口私牌)→ 云端按库读到的 Token 打公网端点 401。故权威令牌恒以「磁盘上 leader 真相」为准。
function bridgeMachineToken(): string {
    try {
        const j = JSON.parse(fs.readFileSync(DAO_CONN_CURRENT, 'utf8'));
        const t = String((j && j.token) || '').trim();
        if (t && t.length >= 16) return t;
    } catch { /* 守柔 */ }
    try {
        const g = fs.readFileSync(path.join(DAO_DIR, 'api-token'), 'utf8').trim();
        if (g && g.length >= 16) return g;
    } catch { /* 守柔 */ }
    return '';
}
function bridgeAuthoritativeToken(): string {
    return bridgeMachineToken() || ws.token || bridgeToken || '';
}
// 同理: 内穿文档「本地端口/Local URL」须指 leader 实例端口(公网隧道实际代理到的那个),
//   而非恰好执行 reinject 的窗口实例自身 ws.port(否则 9921 窗口会把文档写成指向它自己)。
function bridgeMachinePort(): number {
    try {
        const j = JSON.parse(fs.readFileSync(DAO_CONN_CURRENT, 'utf8'));
        const p = Number((j && j.port) || 0);
        if (p >= 1 && p <= 65535) return p;
    } catch { /* 守柔 */ }
    return 0;
}
// 机器级内穿/ MCP 文档恒由 leader(端口最小活实例)统一维护 → 杜绝多窗口实例彼此覆盖致文档抖动
//   (实测两实例 9920↔9921 轮流把文档改写成各自 端口/令牌, 时间戳每轮翻动·徒增网络 churn,
//    且非 leader 写入自身私牌时窗内云端读到必 401)。未知 leader(冷启/单实例)守柔放行。
function bridgeIsLeaderInstance(): boolean {
    const lp = bridgeMachinePort();
    if (!lp) return true;
    return lp === (ws.port || 0);
}
// 帛书·「URL 与 Token 恒成对」: 令牌恒与 bridgeEffectiveUrl 同源 —
//   经实测有效环采纳的配对优先; 次之, URL 若来自常驻桥发布连接, 令牌亦取该文件同一对;
//   仅进程内自有隧道(或无发布对)才回落机器级权威令牌。根治「URL 取桥、Token 取机」的脱域。
function bridgeEffectiveToken(): string {
    // 帛书·「得一」: 令牌恒取机器级权威牌(dao-conn-current.json / api-token) — 与 bridgeEffectiveUrl
    //   之本实例可达端点同源成对。不再回落他者进程共享文件里的令牌(错域·致云端 401, 详见 checkAuth 注)。
    return bridgeAuthoritativeToken();
}
// 最近一次「实测有效」采纳的公网配对(URL+Token 同源成对) — 发布/签名/生成文档的单一真相源。
let _bridgePublishedPair: { url: string; token: string; source: string } | null = null;
// 帛书·「令牌不系于地址」根治: 常驻桥(daobridge)发布 conn.json 时 url 常为空("")—隧道 URL 由
//   其独立 cloudflared 侧另行持有—但 token 字段(即 /api/exec 真验源)恒在。旧 bridgeReadPublishedConn
//   以「无有效 url 即整条丢弃」→ 连同 token 一并弃, 致 checkAuth 拿不到桥牌、云端持桥牌恒 401。
//   故令牌解析须与地址解耦: 独立扫 conn.json / connection.json / cf-hub-conn.json 的 token 字段
//   (无视 url 空否)及权威 bridge/auth-token 明文, 取最新鲜一枚。此乃「一枚令牌贯通全 /api 面」之本。
function bridgeReadPublishedToken(): string {
    const cands = [
        path.join(BRIDGE_DIR, 'conn.json'),
        path.join(BRIDGE_DIR, 'connection.json'),
        path.join(os.homedir(), '.dao', 'cf-hub-conn.json'),
    ];
    let bestTok = '';
    let bestMtime = -1;
    for (const f of cands) {
        try {
            const st = fs.statSync(f);
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            const t = String((j && j.token) || '').trim();
            if (t && t.length >= 16 && (Date.now() - st.mtimeMs) < BRIDGE_CONN_FRESH_MS && st.mtimeMs > bestMtime) {
                bestTok = t; bestMtime = st.mtimeMs;
            }
        } catch { /* 守柔 */ }
    }
    // 权威明文令牌文件(常驻桥恒写): 若较上更新鲜则采纳。
    try {
        const f = path.join(BRIDGE_DIR, 'auth-token');
        const st = fs.statSync(f);
        const t = fs.readFileSync(f, 'utf8').trim();
        if (t && t.length >= 16 && (Date.now() - st.mtimeMs) < BRIDGE_CONN_FRESH_MS && st.mtimeMs > bestMtime) {
            bestTok = t; bestMtime = st.mtimeMs;
        }
    } catch { /* 守柔 */ }
    return bestTok;
}
function bridgePublishedConnToken(): string {
    try {
        const t = bridgeReadPublishedToken();
        if (t) return t;
    } catch { /* 守柔 */ }
    return '';
}
// ═══ 主动有效性探测 — 帛书·「以实际有效性为基准」 ═══
//   不止探"隧道是否 2xx 活着"(/api/health 免鉴权 → 隧道一通即 200, 验不出令牌失效),
//   而是以**云端 Agent 真正会用的方式**探: 用**已发布的 token** 经**公网 URL** 打**需鉴权端点**(/api/next),
//   2xx 才算"真正能连上并操作用户设备"; 401/403=令牌失效·5xx=隧道死·超时=不可达 → 皆为"无效"。
//   据此, 令牌轮换(URL 不变)等"被动签名机制探不出"的脱钩盲区也被主动识别 → 即刷新即反注入。
function bridgeProbeEffective(rawUrl: string, token: string, timeoutMs: number = 6000): Promise<{ ok: boolean; code: number; reason: string }> {
    return new Promise((resolve) => {
        let done = false;
        const fin = (ok: boolean, code: number, reason: string) => { if (!done) { done = true; resolve({ ok, code, reason }); } };
        if (!rawUrl || !token) { return fin(false, 0, 'no-url-or-token'); }
        try {
            const relay = /\/relay\//.test(rawUrl);
            const u = new URL(rawUrl);
            const isHttps = u.protocol === 'https:';
            const mod = require(isHttps ? 'https' : 'http');
            const headers: any = { 'Authorization': 'Bearer ' + token };
            // 帛书·「以实际有效性为基准」: 探云端 Agent 真正操作整机的那个端点 —— POST /api/exec 空体。
            //   桥原生 exec 端点(公网隧道真正代理到的那层)对有效令牌返回 400「cmd/file required」(已鉴权·缺参),
            //   对失效令牌返回 401/403。以此单一探针即锁定「能真正 exec 操作整机」的那枚令牌(而非仅能读半张面的牌),
            //   且空体不触发任何真实命令(零副作用)。根治「/api/next 属插件域, 探它选中的牌恰恰 exec 不了」的错配。
            const innerBody = JSON.stringify({});
            let postData: string | null = null;
            const opts: any = { hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), timeout: timeoutMs, headers };
            if (relay) {
                opts.method = 'POST';
                opts.path = (u.pathname || '/') + (u.search || '');
                postData = JSON.stringify({ path: '/api/exec', method: 'POST', body: {} });
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(postData);
            } else {
                opts.method = 'POST';
                opts.path = '/api/exec';
                postData = innerBody;
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(postData);
            }
            if (isHttps) opts.rejectUnauthorized = false;
            const req = mod.request(opts, (r: any) => {
                const sc = r.statusCode || 0;
                let body = '';
                r.setEncoding('utf8');
                r.on('data', (c: string) => { if (body.length < 8192) body += c; });
                r.on('end', () => {
                    if (sc === 401 || sc === 403) return fin(false, sc, 'token-stale');
                    // 400「缺参」= 已鉴权(令牌真有效, 只是空体没给 cmd) → 正是我们要的「能 exec」信号。
                    if (sc === 400) {
                        if (relay) { try { const j = JSON.parse(body); if (j && j.status === 401) return fin(false, 401, 'token-stale'); } catch { /* 守柔 */ } }
                        return fin(true, sc, 'ok-authed');
                    }
                    if (sc === 404 || sc === 405) return fin(true, sc, 'ok-no-endpoint');
                    if (sc < 200 || sc >= 300) return fin(false, sc, sc >= 500 ? 'tunnel-down' : 'http');
                    if (relay) { try { const j = JSON.parse(body); if (j && (j.status === 401 || j.status === 403)) return fin(false, j.status, 'token-stale'); return fin(!j.error, sc, j.error ? 'inner-error' : 'ok'); } catch { return fin(body.length > 0, sc, 'ok'); } }
                    return fin(true, sc, 'ok');
                });
            });
            req.on('timeout', () => { try { req.destroy(); } catch { /* 守柔 */ } fin(false, 0, 'timeout'); });
            req.on('error', () => fin(false, 0, 'unreachable'));
            if (postData) req.write(postData);
            req.end();
        } catch { fin(false, 0, 'exception'); }
    });
}
// 令牌跨重载持久 + 「上次实注配源(URL+token)」落盘 — 重载后仍能比对"已发布配源是否仍有效"。
function bridgeAuthTokenFile(): string { return path.join(BRIDGE_DIR, 'auth-token'); }
function bridgeLoadAuthToken(): string {
    try { const t = fs.readFileSync(bridgeAuthTokenFile(), 'utf8').trim(); if (t && t.length >= 16) return t; } catch { /* 守柔 */ }
    return '';
}
function bridgeSaveAuthToken(t: string): void {
    try { if (t) { bridgeEnsureDir(); fs.writeFileSync(bridgeAuthTokenFile(), t, 'utf8'); } } catch { /* 守柔 */ }
}
function bridgeLastInjectFile(): string { return path.join(BRIDGE_DIR, 'last-inject.json'); }
function bridgeSaveLastInject(url: string, token: string): void {
    try { bridgeEnsureDir(); fs.writeFileSync(bridgeLastInjectFile(), JSON.stringify({ url, token, ts: new Date().toISOString() }), 'utf8'); } catch { /* 守柔 */ }
}
function bridgeLoadLastInject(): void {
    try {
        const j = JSON.parse(fs.readFileSync(bridgeLastInjectFile(), 'utf8'));
        if (j && typeof j.url === 'string' && j.url) _lastInjectedBridgeUrl = j.url;
        if (j && typeof j.token === 'string' && j.token) _lastInjectedBridgeToken = j.token;
    } catch { /* 守柔 */ }
}
// 帛书·「得一」: MCP 探活/令牌与实注端点恒同源 — 皆取 daoResolveMcpEndpoint(本体 /mcp·机器权威牌),
//   杜绝「探 9100 旧网关而实注本体 /mcp」的错位盲区(GET /mcp 返 405 亦属 2xx-4xx·探活判活)。
function bridgeMcpUrl(): string {
    try { const ep = daoResolveMcpEndpoint(); return ep ? ep.url : ''; } catch { return ''; }
}
function bridgeMcpToken(): string {
    try { const ep = daoResolveMcpEndpoint(); return ep ? ep.token : ''; } catch { return ''; }
}
// ① 反向注入自愈 · 活地址解析 — 帛书·「自知者明」:
//   汇集候选公网地址(进程内隧道 + 各已发布 conn 文件), 按新鲜度逐一 /api/health 探活,
//   返回首个真实可达的 {url, token}; 全死返回 null(交调用方「宁可不注入也不以死地址覆盖良态」)。
//   根治: 多实例/旧实例把「(未连接)」或已轮换的死地址写回账号知识库, 致云端读库连不上端口。
// 独立闭环(鸡犬相闻·不相往来): 只探测进程内自有隧道, 不读外部 conn 文件
async function bridgeResolveLiveConn(timeoutMs: number = 5000): Promise<{ url: string; token: string; source: string } | null> {
    // 帛书·「URL 与 Token 恒成对·以实测有效性为唯一裁决」— 根治多令牌域脱钩的总根:
    //   旧法把常驻桥发布 URL 强配机器级权威令牌(另一域的牌), 再用免鉴权 /api/health 探「活」→
    //   错配对永远探不出错, 反注入恒发布「URL 对而 Token 错」→ 云端 exec 恒 401, 改多少次都坏。
    //   新法·「得一」: 候选**只**含「本实例自有隧道 + 机器级权威令牌」这一同源对, 用需鉴权端点实测。
    //   切勿再读他者进程(独立 dao-bridge)发布的 conn.json 入列 —— 其 (url, token) 是另一域:
    //   即便 foreign-url/api/exec 用 foreign-token 探得 200(常驻桥原生验此牌), 该 URL 反代到本插件的
    //   /api/connection 等面时, 本进程 checkAuth 只认机器权威牌 → foreign-token 恒 401 → 云端裂脑复发。
    //   故注入面与鉴权面同守单一权威: 只发布本实例可达端点, 令牌恒取机器权威牌(与 checkAuth 同源)。
    const cands: { url: string; token: string; source: string }[] = [];
    if (bridgeUrl) cands.push({ url: bridgeUrl, token: bridgeAuthoritativeToken() || ws.token || bridgeToken || '', source: 'inprocess' });
    const seen = new Set<string>();
    let firstAlive: { url: string; token: string; source: string } | null = null;
    for (const c of cands) {
        const key = c.url + '|' + c.token;
        if (seen.has(key) || !c.url) continue;
        seen.add(key);
        const tok = c.token || bridgeToken || ws.token || '';
        try {
            const pe = await bridgeProbeEffective(c.url, tok, timeoutMs);
            if (pe.ok) {
                daoLoopLog('tunnel', 'resolve-live → ' + c.url + ' (src=' + c.source + ' 实测鉴权通)');
                _bridgePublishedPair = { url: c.url, token: tok, source: c.source };
                return { url: c.url, token: tok, source: c.source };
            }
            if (!firstAlive && pe.reason !== 'timeout' && pe.reason !== 'unreachable' && pe.reason !== 'tunnel-down') {
                firstAlive = { url: c.url, token: tok, source: c.source + ':alive-only(' + pe.reason + ')' };
            }
        } catch { /* 守柔 */ }
    }
    if (firstAlive) {
        daoLoopLog('tunnel', 'resolve-live → ' + firstAlive.url + ' (src=' + firstAlive.source + ' 无配对实测通·退取隧道尚活者)');
        return firstAlive;
    }
    daoLoopLog('tunnel', 'resolve-live → 无活地址(候选' + cands.length + '皆死)');
    return null;
}
let _bridgeLivenessInflight = false;
async function bridgeLivenessTick(): Promise<void> {
    if (_bridgeLivenessInflight) return;
    _bridgeLivenessInflight = true;
    try {
        // 无缝接力兜底: 周期裁剪死实例 + 刷新权威「当前接口」(即便无人 saveConnection 也自愈)
        try { await daoRefreshCurrent(); } catch { /* 守柔 */ }
        const cfg = vscode.workspace.getConfiguration('dao');
        if (!cfg.get<boolean>('bridgeLiveness', true)) return;
        const url = bridgeEffectiveUrl();
        const mcpUrl = bridgeMcpUrl();
        // 都没有地址可探 → 无连接, 尝试自动持久化建立一次(守柔, autoPersist 自带节流)
        if (!url && !mcpUrl) { try { await bridgeAutoPersist(); } catch { /* 守柔 */ } return; }
        const [bridgeOk, mcpOk] = await Promise.all([
            url ? bridgeProbeAlive(url, 6000, bridgeEffectiveToken()) : Promise.resolve(true),
            mcpUrl ? bridgeProbeAlive(mcpUrl, 6000, bridgeMcpToken()) : Promise.resolve(true),
        ]);
        // 打得通 → 保持稳定, 什么也不做 (不重注·省网)
        if (bridgeOk && mcpOk) {
            _bridgeLastAliveMs = Date.now(); _bridgeLivenessFail = 0;
            // 帛书·「以实际有效性为基准」: 隧道 2xx 活着 ≠ 已发布配源能用。须主动核对「云端实读的 URL+token」仍真有效。
            const eff = bridgeEffectiveUrl();
            const effTok = bridgeEffectiveToken();
            // (a) 地址漂移: 当前活址 ≠ 实注址 → 知识库滞留旧址, 补注。
            const urlDrift = !!(eff && _lastInjectedBridgeUrl && eff !== _lastInjectedBridgeUrl);
            // (b) 令牌漂移: 当前令牌 ≠ 已发布令牌 → 轮换却没人重注, 知识库令牌已失效, 补注(被动签名在 URL 不变时探不出此盲区)。
            const tokDrift = !!(effTok && _lastInjectedBridgeToken && effTok !== _lastInjectedBridgeToken);
            // (c) 实测有效性: 以云端 Agent 之法用「已发布 URL+token」打需鉴权端点; 隧道虽活但实测无效(401/5xx) → 补注。
            let effDead = false, effReason = '';
            const pubUrl = _lastInjectedBridgeUrl || eff;
            const pubTok = _lastInjectedBridgeToken || effTok;
            if (!urlDrift && !tokDrift && pubUrl && pubTok) {
                try { const pe = await bridgeProbeEffective(pubUrl, pubTok, 6000); if (!pe.ok) { effDead = true; effReason = pe.reason + (pe.code ? '/' + pe.code : ''); } } catch { /* 守柔 */ }
            }
            if (urlDrift || tokDrift || effDead) {
                const why = urlDrift ? 'url-drift(' + _lastInjectedBridgeUrl + '→' + eff + ')'
                    : tokDrift ? 'token-drift(已发布令牌失配)'
                    : 'published-ineffective(' + effReason + ')';
                daoLoopLog('tunnel', 'probe ALIVE 但已发布配源失效[' + why + ']→主动刷新+反注入');
                try { _lastBridgeReinjectSig = ''; } catch { /* 守柔 */ }
                bridgeScheduleReinject('liveness-effectiveness');
            } else {
                daoLoopLog('tunnel', 'probe ALIVE+EFFECTIVE (bridge=' + bridgeOk + ' mcp=' + mcpOk + ') → 保持·态签名核对');
                // 端点稳态但「设备/IDE/工具集/版本」可能已变 → 签名守柔重注(签名未变即空转·省网),
                //   令 MCP/内穿两篇知识恒随用户各设备与 IDE 整体状态实时刷新(与内穿同逻辑·闻道者日损)。
                bridgeScheduleReinject('liveness-state');
                // 帛书·「反者道之动」: 稳态下低频检查 VSIX 自更新(6h节奏, 守柔不阻塞)
                try { bridgeSelfUpdateCheck().catch(() => {}); } catch {}
            }
            return;
        }
        // 打不通 → 刷新
        try { console.log('[dao] bridge liveness DEAD (bridge=' + bridgeOk + ' mcp=' + mcpOk + ') → 刷新'); } catch { /* 守柔 */ }
        daoLoopLog('tunnel', 'probe DEAD (bridge=' + bridgeOk + ' mcp=' + mcpOk + ') → 刷新+重注');
        // 0) ① 自愈优先: 在所有候选地址(进程内 ∪ 各已发布 conn)里探活择优 — 常驻桥可能已轮换出新活地址。
        //    找到真实可达地址即「无缝切换」过去并重注知识库, 免去重启隧道(更快·更稳); 全死才落入下方重启兜底。
        if (!bridgeOk) {
            try {
                const live = await bridgeResolveLiveConn(5000);
                if (live && live.url) {
                    // 重注判据: 进程内地址变了 或 知识库实注地址 ≠ 此活址(覆盖 bridgeUrl 已先行收敛、唯独 KB 滞留旧址的脱钩盲区)。
                    const needReinject = (live.url !== bridgeUrl) || (live.url !== _lastInjectedBridgeUrl);
                    bridgeUrl = live.url; if (!ws.token && live.token) bridgeToken = live.token; // 守恒: 令牌恒以 ws.token 为准, 不被外部候选漂移
                    _bridgeLastAliveMs = Date.now(); _bridgeLivenessFail = 0;
                    daoLoopLog('tunnel', 'DEAD→候选探活得活地址 ' + live.url + ' (src=' + live.source + ') → 无缝切换' + (needReinject ? '+重注' : ''));
                    try { daoSyncDaoMcpIntoProfile(); } catch { /* 守柔 */ }
                    if (needReinject) { try { _lastBridgeReinjectSig = ''; } catch { /* 守柔 */ } bridgeScheduleReinject('liveness-switch-live'); refreshDaoCloudMiddlePanel(); }
                    return;
                }
            } catch { /* 守柔 */ }
        }
        // 独立闭环(鸡犬相闻·不相往来): 不读外部 conn, 自己重启自己的隧道
        try { daoSyncDaoMcpIntoProfile(); } catch { /* 守柔 */ }
        if (!bridgeOk) {
            _bridgeLivenessFail++;
            // 帛书补丁·万流归宗: 建立期守候(不抖杀正在连接的隧道); 退避/leader/冷却闸已内置于 bridgeStartTunnel
            let _cfEstablishing = false;
            try {
                if (cfPidAlive()) {
                    const _bp = cfReadBoundPort();
                    const _og = _bp ? await daoProbeHealth(_bp) : null;
                    if (_og && (Date.now() - (_cfLastStartMs || 0)) < CF_ESTABLISH_GRACE_MS) _cfEstablishing = true;
                }
            } catch (eCFE) { /* 守柔 */ }
            if (_cfEstablishing) {
                daoLoopLog('tunnel', '新生隧道建立期·源活·守候不抖杀 (age=' + Math.round((Date.now() - (_cfLastStartMs || 0)) / 1000) + 's)');
            } else {
                // 收尸死/僵隧道 + 委托 bridgeStartTunnel(内含万流归宗闸)统一决策是否重建
                try { bridgeStopTunnel(); } catch (eStop) { /* 守柔 */ }
                try { await bridgeStartTunnel(!!bridgeReadNamedToken()); } catch (e218) { /* 守柔 */ }
            }
        }
        // 3) 强制把最新地址重注到各账号(清签名 → 绕过"无变化不重注")
        try { _lastBridgeReinjectSig = ''; } catch { /* 守柔 */ }
        bridgeScheduleReinject('liveness-refresh');
        refreshDaoCloudMiddlePanel();
    } catch { /* 守柔 */ } finally { _bridgeLivenessInflight = false; }
}
function startBridgeLivenessLoop(context: vscode.ExtensionContext): void {
    if (_bridgeLivenessTimer) return;
    _bridgeLivenessStopped = false;
    // 自适应自重排: 每探完按健康度定下一拍 — 失败(端口死/重起中)→ 8s 快探直到恢复; 稳态 → 30s 省网。
    const schedule = (ms: number) => {
        if (_bridgeLivenessStopped) return;
        _bridgeLivenessTimer = setTimeout(async () => {
            try { await bridgeLivenessTick(); } catch { /* 守柔 */ }
            schedule(_bridgeLivenessFail > 0 ? BRIDGE_LIVENESS_FAST_MS : BRIDGE_LIVENESS_INTERVAL_MS);
        }, ms);
    };
    // 启动即首探(2s 后·让端口/账号池先就绪), 不再空等整 30s 才发现死隧道/滞留旧址。
    schedule(2000);
    context.subscriptions.push({ dispose: () => { _bridgeLivenessStopped = true; if (_bridgeLivenessTimer) { clearTimeout(_bridgeLivenessTimer); _bridgeLivenessTimer = null; } } });
}

// ═══ 单会话上限 · 额度跟随环 — 帛书·「反者道之动」 ═══
//   启用 auto 时, 周期性据活动号最新剩余额度重算 cap = quotaCapFromAvail(余额, offset), 仅变化才回写(守柔省网)。
//   账号切换/批量注入时另由 applyInjectProfileToOrg 即刻据本号算注; 此环负责活动号「额度刷新即跟随」。
//
// 单会话上限计算 — 帛书·「大盈若盅·其用不窘」:
//   余额充裕 → 留余量 off, cap = floor(余额 − off)(如 69 → 66);
//   余额不足 off(最后一点小钱) → 不再钉死 1(那样残额永远花不掉, 此前根本错误),
//     反而抬到 off+1(>off, 默认 4), 让最后一点能在一次对话里全部消耗完;
//   负余额(欠费)同样收敛到 off+1。故 cap = max(floor(余额 − off), off + 1) — 恒 > off, 单调随余额增。
function quotaCapFromAvail(avail: number, off: number): number {
    return Math.max(Math.floor(avail - off), off + 1);
}
const QUOTA_AUTO_LIMIT_INTERVAL_MS = 60 * 1000;
let _quotaAutoLimitTimer: ReturnType<typeof setInterval> | null = null;
let _lastAutoLimitSig = '';
async function quotaAutoLimitTick(): Promise<void> {
    try {
        const p = loadInjectProfile();
        if (!p.enabled || !p.messageLimitAuto) return;
        if (!ws.devinOrgId || !ws.devinAuth1 || ws.devinAuth1.startsWith('devin-session-token$')) return;
        const avail = await devinFetchAvailableAcus(ws.devinOrgId, ws.devinAuth1);
        if (avail == null) return;
        const off = (typeof p.messageLimitOffset === 'number') ? p.messageLimitOffset : 3;
        const cap = quotaCapFromAvail(avail, off);
        const sig = ws.devinOrgId + ':' + cap;
        if (sig === _lastAutoLimitSig) { daoLoopLog('quota', 'avail=' + avail + ' cap=' + cap + ' \u2192 \u4fdd\u6301(\u65e0\u53d8)'); return; }  // 无变化不重写 (守柔省网)
        const r = await devinSetMessageLimit(ws.devinOrgId, cap, ws.devinAuth1);
        if (r.ok) { _lastAutoLimitSig = sig; daoLoopLog('quota', 'avail=' + avail + ' \u2192 cap=' + cap + ' \u5df2\u56de\u5199'); try { console.log('[dao] quota-auto-limit org=' + ws.devinOrgId + ' avail=' + avail + ' \u2192 cap=' + cap); } catch { /* 守柔 */ } }
        else { daoLoopLog('quota', 'avail=' + avail + ' cap=' + cap + ' \u56de\u5199\u5931\u8d25 status=' + (r.status || '?')); }
    } catch { /* 守柔 */ }
}
function startQuotaAutoLimitLoop(context: vscode.ExtensionContext): void {
    if (_quotaAutoLimitTimer) return;
    _quotaAutoLimitTimer = setInterval(() => { quotaAutoLimitTick().catch(() => { /* 守柔 */ }); }, QUOTA_AUTO_LIMIT_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => { if (_quotaAutoLimitTimer) { clearInterval(_quotaAutoLimitTimer); _quotaAutoLimitTimer = null; } } });
}

// ═══ 池级稳态维护环 (②额度·全账号动态跟随 + ④自动化·隔离清理) — 帛书·「为道日损·损之又损」「不失其所者久也」 ═══
//   病灶: 注入收敛后, devinBatchInject 的单账号 sig 快路会跳过 applyInjectProfileToOrg → 此后
//     · 会话新生的自动化(周期烧额度) 不再被清理;  · 各号余额变动 不再被额度环捕捉(它只跟活动号)。
//   故另设此「不依赖注入签名」的常驻稳态环, 周期巡所有已存 auth1 的账号, 对每号:
//     ④ 隔离清理: 删除该号一切「非期望(不在档案 automations) 且 未被用户锁定」的自动化 → 止血·根除每周烧额度残留;
//     ② 额度跟随: messageLimitAuto 时据本号当前余额重算 cap = 余额 − off, 仅变化才回写(守柔省网)。
//   守柔: 单账号错误隔离; 仅档案 enabled 时巡; 清理受 injectReset 开关约束; 跳过被 RT Flow 清理/出库的账号。
const POOL_STEADY_INTERVAL_MS = 5 * 60 * 1000;
let _poolSteadyTimer: ReturnType<typeof setInterval> | null = null;
let _poolSteadyInflight = false;
const _steadyQuotaSig = new Map<string, number>();
async function poolSteadyStateTick(): Promise<void> {
    if (_poolSteadyInflight) return;
    _poolSteadyInflight = true;
    try {
        const p = loadInjectProfile();
        if (!p.enabled) return;
        const sweepAutomations = getInjectReset();
        const off = (typeof p.messageLimitOffset === 'number') ? p.messageLimitOffset : 3;
        const keepA = new Set<string>((p.automations || []).map(a => a.name).filter(Boolean));
        const store = loadAccountsAuthStore();
        for (const email of Object.keys(store)) {
            const a = store[email];
            if (!a || !a.orgId || !a.auth1 || String(a.auth1).startsWith('devin-session-token$')) continue;
            if (isInjectSuppressedForEmail(email)) continue;
            const orgId = a.orgId, auth1 = a.auth1;
            // ④ 自动化隔离清理 (止血·防扣额度): 删一切非期望且未锁定的自动化
            if (sweepAutomations) {
                try {
                    const al = await devinListAutomations(orgId, auth1);
                    if (al.ok && Array.isArray(al.automations)) {
                        let cleared = 0;
                        for (const it of al.automations) {
                            const xid = it.automation_id || it.id;
                            if (!xid || typeof it.name !== 'string') continue;
                            if (keepA.has(it.name) || isManualLocked(orgId, 'automations', it.name)) continue;
                            try { await devinDeleteAutomation(orgId, String(xid), auth1); cleared++; } catch { /* 守柔 */ }
                        }
                        if (cleared) daoLoopLog('steady', 'org=' + orgId + ' 自动化隔离清理 ' + cleared + ' 条(止血)');
                    }
                } catch { /* 守柔 */ }
                // ④ 定时调度(cron)隔离清理: 每周烧额度的元凶, 同自动化一并根除(注入档未建调度→白名单空, 仅守人工锁)
                try {
                    const sl = await devinListSchedules(orgId, auth1);
                    if (sl.ok && Array.isArray(sl.schedules)) {
                        let clearedS = 0;
                        for (const it of sl.schedules) {
                            const sid = it.schedule_id || it.id;
                            if (!sid) continue;
                            const sname = String(it.prompt || it.description || it.name || sid);
                            if (isManualLocked(orgId, 'schedules', sname)) continue;
                            try { await devinDeleteSchedule(orgId, String(sid), auth1); clearedS++; } catch { /* 守柔 */ }
                        }
                        if (clearedS) daoLoopLog('steady', 'org=' + orgId + ' 定时调度隔离清理 ' + clearedS + ' 条(止周扣)');
                    }
                } catch { /* 守柔 */ }
            }
            // ② 单对话额度上限·每账号动态跟随
            if (p.messageLimitAuto) {
                try {
                    const avail = await devinFetchAvailableAcus(orgId, auth1);
                    if (avail != null) {
                        const cap = quotaCapFromAvail(avail, off);
                        if (_steadyQuotaSig.get(orgId) !== cap) {
                            const r = await devinSetMessageLimit(orgId, cap, auth1);
                            if (r.ok) { _steadyQuotaSig.set(orgId, cap); daoLoopLog('quota', 'org=' + orgId + ' avail=' + avail + ' \u2192 cap=' + cap + ' \u5df2\u56de\u5199(\u6c60\u5de1)'); }
                        }
                    }
                } catch { /* 守柔 */ }
            }
        }
    } catch { /* 守柔 */ } finally { _poolSteadyInflight = false; }
}
function startPoolSteadyStateLoop(context: vscode.ExtensionContext): void {
    if (_poolSteadyTimer) return;
    _poolSteadyTimer = setInterval(() => { poolSteadyStateTick().catch(() => { /* 守柔 */ }); }, POOL_STEADY_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => { if (_poolSteadyTimer) { clearInterval(_poolSteadyTimer); _poolSteadyTimer = null; } } });
    setTimeout(() => { poolSteadyStateTick().catch(() => { /* 守柔 */ }); }, 90 * 1000);  // 启动后延迟首巡(让登录/注入先就位)
}

// ═══ 网络状态变化即时触发 — 帛书·「反者道之动」 ═══
//   不傻等 30s 轮询: 本机活动 IPv4 接口/地址一变(网络抖动·切网·IP 轮换) 即刻探活+重注隧道。
//   纯读本地接口(无网络 I/O), 5s 轻量采样; 变化才动手, 守柔。
const NET_WATCH_INTERVAL_MS = 5 * 1000;
let _netSig = '';
let _netWatchTimer: ReturnType<typeof setInterval> | null = null;
function computeNetSig(): string {
    try {
        const ifs = os.networkInterfaces();
        const ips: string[] = [];
        for (const name of Object.keys(ifs)) {
            for (const a of (ifs[name] || [])) {
                if (a && !a.internal && a.family === 'IPv4') ips.push(name + '=' + a.address);
            }
        }
        return ips.sort().join(',');
    } catch { return ''; }
}
function startNetworkChangeWatch(context: vscode.ExtensionContext): void {
    if (_netWatchTimer) return;
    _netSig = computeNetSig();
    _netWatchTimer = setInterval(() => {
        try {
            const sig = computeNetSig();
            if (sig === _netSig) return;
            const old = _netSig; _netSig = sig;
            try { console.log('[dao] network changed (' + old + ' \u2192 ' + sig + ') \u2192 即时探活+重注隧道'); } catch { /* 守柔 */ }
            _bridgeLivenessFail = 0;
            // 即刻探活刷新 + 强制重注最新地址到各账号(清签名绕过「无变化不重注」)
            bridgeLivenessTick().catch(() => { /* 守柔 */ });
            try { _lastBridgeReinjectSig = ''; } catch { /* 守柔 */ }
            bridgeScheduleReinject('net-change');
        } catch { /* 守柔 */ }
    }, NET_WATCH_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => { if (_netWatchTimer) { clearInterval(_netWatchTimer); _netWatchTimer = null; } } });
}

function getDaoCloudMiddlePanelHtml(st: any, soloBoard?: string): string {
    const { loggedIn, email, orgName, orgId, hasWindsurfCreds, apiKeyType, tokenType, canUseApi, port, relay, relayUrl, hostname, injecting, bridge, hostCaps } = st;
    // 归一·分而治之: 单板块模式 — 归一外壳为「六大板块」各开一张独立子网页(各自一个 iframe),
    // 每张只锁定渲染一个板块并隐藏左侧导航条 → 板块不再挤在一个全功能面板里, 真正网页套网页·平级并排。
    const _solo = ['overview', 'switch', 'bridge', 'backups', 'inject', 'mcp', 'computer'].includes(soloBoard || '') ? (soloBoard as string) : '';
    // 帛书·「道生一，一生二，二生三，三生万物」
    // Overview: Codeium API 数据（已工作 — devin-session-token$ 对 Codeium API 有效）
    // Sessions/Knowledge/Secrets/Integrations: simpleBrowser 打开 app.devin.ai（共享 Electron session）
    // 帛书·「天下之至柔驰骋于天下之致坚」— simpleBrowser 共享 Electron session → 无为而无不为
    // 核心发现: devin-session-token$ 不被 app.devin.ai API 接受(403)
    // Devin SPA 使用 Auth0 认证 — 只有 Electron session 的真实 Cookie 才有效
    // simpleBrowser 共享 Electron session → 自动携带 Auth0 Cookie → 无为而无不为
    const devinBaseUrl = 'https://app.devin.ai';
    const tokenTypeLabel = tokenType === 'cog' ? 'Devin API (cog_)' : tokenType === 'windsurf' ? 'Windsurf Session' : tokenType === 'sk' ? 'API Key (sk_)' : tokenType || '—';
    const tokenCapabilityHtml = canUseApi
        ? '<span style="color:var(--success)">✓ 完整API访问</span>'
        : '<span style="color:var(--warn)">⚠ 仅Codeium API + SimpleBrowser</span>';
    return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src * http://localhost:* https://localhost:* wss: ws:; img-src * data: blob:;">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#1e1e1e;--fg:#ccc;--muted:#888;--accent:#6366f1;--accent2:#818cf8;--card:#252526;--border:#3c3c3c;--hover:#2a2d2e;--btn:#0e639c;--btn-fg:#fff;--btn-hover:#1177bb;--danger:#f44747;--success:#4ec9b0;--warn:#e8c84a;--input:#3c3c3c;--input-fg:#ccc;--input-border:#3c3c3c}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:var(--fg);background:var(--bg);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.app{display:flex;flex:1;overflow:hidden}
.sb{width:48px;background:var(--card);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding:8px 0;flex-shrink:0}
.sb .ni{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;font-size:16px;margin:2px 0;opacity:0.6;transition:all .15s}
.sb .ni:hover{opacity:1;background:var(--hover)}
.sb .ni.active{opacity:1;background:var(--accent);color:#fff}
.sb .sp{flex:1}
body.solo .sb{display:none}
.mn{flex:1;display:flex;flex-direction:column;overflow:hidden}
.hd{padding:8px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;background:var(--card)}
.hd .t{font-size:14px;font-weight:600}
.hd .b{font-size:10px;padding:2px 8px;border-radius:10px;background:var(--accent);color:#fff;white-space:nowrap}
.hd .b.off{background:#555}
.hd .b.ok{background:var(--success);color:#000}
.hd .sp{flex:1}
.hd .hb{background:transparent;border:1px solid var(--border);color:var(--fg);border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px}
.hd .hb:hover{background:var(--hover)}
.ct{flex:1;overflow-y:auto;padding:16px}
.ct iframe{width:100%;height:100%;border:none;background:#fff;border-radius:6px}
.ct .tv{display:none;height:100%}
.ct .tv.active{display:flex;flex-direction:column}
.empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:13px}
.empty .ic{font-size:32px;margin-bottom:8px;opacity:0.4}
.card{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px}
.card:hover{border-color:var(--accent2)}
.cr{display:flex;justify-content:space-between;align-items:center;padding:4px 0}
.cr .l{color:var(--muted);font-size:12px}
.cr .v{color:var(--fg);font-weight:500;font-size:12px;word-break:break-all;max-width:260px;text-align:right}
.btn{background:var(--btn);color:var(--btn-fg);border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .15s}
.btn:hover{background:var(--btn-hover)}
.btn.sm{padding:3px 8px;font-size:11px}
.btn.primary{background:var(--accent)}
.btn.primary:hover{background:var(--accent2)}
.btn.danger{background:var(--danger)}
.btn.danger:hover{background:#e53935}
.btn.warn{background:#6b3b1a}
.btn.warn:hover{background:#8b4b2a}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--border)}
.btn.ghost:hover{background:var(--hover)}
.br{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.tag{display:inline-block;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:4px}
.tag.secret{background:#5a2d82;color:#d4a0ff}
.tag.knowledge{background:#1a6b3c;color:#7ee8a0}
.tag.playbook{background:#3b6b8a;color:#8ac4e8}
.tag.git{background:#6b3b1a;color:#e8b88a}
.tag.cf{background:#f6821f;color:#fff}
.tag.devin{background:var(--accent);color:#fff}
.tag.session{background:#2d6b5a;color:#8ae8c4}
.qb{height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin:4px 0}
.qb .f{height:100%;border-radius:3px;transition:width .3s}
.ft{padding:4px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:12px;font-size:10px;color:var(--muted);flex-shrink:0;background:var(--card)}
.ft .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.ft .dot.on{background:var(--success)}
.ft .dot.off{background:var(--danger)}
.st{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:16px 0 8px}
.ovsec{margin-bottom:6px}
.toast{position:fixed;bottom:20px;right:20px;padding:8px 16px;border-radius:6px;font-size:12px;z-index:200;animation:fi .2s}
.toast.hid{display:none}
.toast.ok{background:var(--success);color:#000}
.toast.err{background:var(--danger);color:#fff}
.mo{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:300;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:32px 16px;box-sizing:border-box}
.mo.hid{display:none}
.md{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px 18px;width:560px;max-width:94vw;max-height:86vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.5);box-sizing:border-box}
.md h3{margin:0 0 12px;font-size:14px;color:var(--fg)}
.mb{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
@keyframes fi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
</style></head>
<body class="${_solo ? 'solo' : ''}">
<div class="app">
<nav class="sb">
<div class="ni active" data-tab="overview" onclick="sw('overview')" title="主页 Home">🏠</div>
<div class="ni" data-tab="switch" onclick="sw('switch')" title="切号 · 账号池(全功能面板第2网页 · 真 WAM 切号面板·完全一致)">🔀</div>
<div class="ni" data-tab="bridge" onclick="sw('bridge')" title="内网穿透 · DAO Bridge (独立板块·远程操作本地电脑)">🌐</div>
<div class="ni" data-tab="backups" onclick="sw('backups')" title="对话 · 备份 — 本机全部 RT Flow 备份对话(全账号×全对话)">💬</div>
<div class="ni" data-tab="inject" onclick="sw('inject')" title="反向注入 · 全账号批量(Knowledge/Playbook/Secret/MCP/自动化/蓝图 一处整合)">💉</div>
<!-- ② 收腰归一: 单账号 K/P/S/Git/自动化/蓝图 均并入主页(overview); 全账号批量在反向注入(inject); MCP 仍保留专用面板 -->
<div class="ni" data-tab="mcp" onclick="sw('mcp')" title="MCP 服务器 · 专用面板">🧩</div>
<div class="ni" data-tab="computer" onclick="sw('computer')" title="操作电脑本体 · 本机命令/文件/终端(把整个软件当浏览器供 MCP 操作)">🖥️</div>
<div class="sp"></div>
<div class="ni" onclick="cmd('refresh')" title="Refresh">⟳</div>
</nav>
<div class="mn">
<div class="hd">
<span class="t">数联 · Dao Cloud</span>
<span class="b ${loggedIn ? 'ok' : 'off'}" id="ab">${loggedIn ? '✓ ' + mpEsc(email.split('@')[0]) : '未连接'}</span>
<span class="b" id="ob" style="background:#2d5a8a${orgName ? '' : ';display:none'}">${mpEsc(orgName)}</span>
<span class="sp"></span>
<button class="hb" onclick="cmd('openBrowser')">🌐 官网</button>
<button class="hb" onclick="cmd('refresh')">⟳</button>
</div>
<div class="ct">
<div class="tv active" id="v-overview"></div>
<div class="tv" id="v-switch"></div>
<div class="tv" id="v-backups"></div>
<div class="tv" id="v-mcp"></div>
<div class="tv" id="v-bridge"></div>
<div class="tv" id="v-inject"></div>
<div class="tv" id="v-computer"></div>
</div>
<div class="ft" id="ft">
<span><span class="dot off" id="ds"></span> Server</span>
<span><span class="dot off" id="dr"></span> Relay</span>
<span><span class="dot off" id="di"></span> Injected</span>
<span class="sp"></span>
<span id="sp">—</span>
</div>
</div>
</div>
<div class="mo hid" id="mo" onclick="if(event.target===this)hm()"><div class="md" id="mc"></div></div>
<div class="toast hid" id="toast"></div>
<script>
const vscode=acquireVsCodeApi();
const S={
  auth:{
    loggedIn:${loggedIn},
    email:'${mpEsc(email)}',
    orgName:'${mpEsc(orgName)}',
    orgId:'${mpEsc(orgId)}',
    hasWsCreds:${hasWindsurfCreds},
    quota:null,
    apiKeyType:'${mpEsc(apiKeyType)}',
    tokenType:'${mpEsc(tokenType||'')}',
    canUseApi:${canUseApi?'true':'false'},
    injecting:${injecting}
  },
  server:{
    port:${port},
    relay:${relay},
    relayUrl:'${mpEsc(relayUrl)}',
    hostname:'${mpEsc(hostname)}'
  },
  bridge:${JSON.stringify(bridge || null)},
  hostCaps:${JSON.stringify(hostCaps || { appName: 'VS Code', isCascade: false, hasConvTracking: false })},
  inject:null,
  injectProfile:{enabled:false,autoCleanup:true,secrets:[],knowledge:[],playbooks:[],mcps:[],automations:[],messageLimit:null,messageLimitAuto:true,messageLimitOffset:3,lastInjectedOrg:''},
  tab:'${_solo || 'overview'}',
  data:{sessions:[],knowledge:[],playbooks:[],secrets:[],gitConnections:[]},
  backups:{accounts:[]},
  locks:{knowledge:[],playbooks:[],secrets:[],mcps:[]}
};
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function cmd(c,d){vscode.postMessage(Object.assign({command:c},d||{}))}
// 道·单账号手动锁定: 锁定 = 防止被反向注入模块覆盖(保留用户改写版); 清理照常清理(不豁免)。
function lkIs(kind,name){var a=(S.locks||{})[kind]||[];return a.some(function(x){return String(x).toLowerCase()===String(name).toLowerCase()})}
function lkToggle(kind,name){cmd('toggleManualLock',{kind:kind,name:name})}
function lkBtn(kind,name){var on=lkIs(kind,name);return '<button class="btn sm" style="'+(on?'color:var(--success);border-color:var(--success)':'color:var(--muted)')+'" title="'+(on?'已锁定 · 反向注入不会覆盖此条目(保留你的改写版)':'未锁定 · 点击锁定以防被反向注入覆盖')+'" onclick="lkToggle(&#39;'+kind+'&#39;,&#39;'+esc(name)+'&#39;)">'+(on?'🔒锁':'🔓')+'</button>'}
// 面板内修改知识(正文直接可见可编辑) — 取代原生 InputBox/临时文档(多窗口下弹不出/看不到内容)。
function kEdit(id){var it=(S.data.knowledge||[]).find(function(k){return String(k.id)===String(id)});if(!it){toast('未找到该知识条目',false);return}var ro=(it.can_write===false);var bodyHtml='<label style="font-size:11px;color:var(--muted)">名称</label><input id="m1" '+(ro?'disabled':'')+' value="'+esc(it.name||'')+'" style="width:100%;margin:4px 0"><label style="font-size:11px;color:var(--muted)">正文 body (Markdown)</label><textarea id="m2" '+(ro?'disabled':'')+' style="width:100%;height:220px;margin:4px 0;font-family:monospace;white-space:pre">'+esc(it.body||'')+'</textarea><label style="font-size:11px;color:var(--muted)">触发描述 trigger (何时检索)</label><input id="m3" '+(ro?'disabled':'')+' value="'+esc(it.trigger_description||it.trigger||'')+'" style="width:100%;margin:4px 0">'+(ro?'<p style="font-size:10px;color:var(--warn);margin:4px 0">此为平台内置只读条目(note_type=builtin), 无法修改/删除。</p>':'');sm('✏️ 修改知识 · '+esc(it.name||''),bodyHtml,function(){if(ro)return;var n=document.getElementById('m1').value.trim();if(!n){toast('名称不能为空',false);return false}var b=document.getElementById('m2').value;var t=document.getElementById('m3').value.trim();cmd('devinEditKnowledgeInline',{id:String(id),name:n,body:b,trigger:t});toast('保存中…',true)})}
function sw(t){
  S.tab=t;
  document.querySelectorAll('.ni').forEach(n=>n.classList.toggle('active',n.dataset.tab===t));
  document.querySelectorAll('.tv').forEach(v=>v.classList.toggle('active',v.id==='v-'+t));
  rc();
  // 帛书·「反者道之动也」— 认证策略根本修复
  // cog_ API Key → Devin API完全可用 → 加载真实数据
  // devin-session-token$ → 仅Codeium API → 显示创建API Key引导
  // 自动注入模块: 无需 cog_ key, 直接拉 profile 配置 (账号无关意图)
  if(t==='inject'){ cmd('getInjectProfile'); cmd('loadTabData',{tab:'secrets'}); return; }
  if(t==='switch'){ if(!S._wamReady){ var _sv=document.getElementById('v-switch'); if(_sv&&!document.getElementById('wamFrame'))_sv.innerHTML='<div class="empty"><div class="ic">🔀</div><p style="color:var(--muted)">加载切号面板…</p></div>'; cmd('wamInit'); } return; }
  if(t==='bridge'){ rBridgeFull(); return; }
  if(t==='backups'){ rBackups(); return; }
  if(t==='computer'){ rComputer(); return; }
  if(t!=='overview'&&S.auth.loggedIn){
    const v=document.getElementById('v-'+t);
    if(v&&!v.dataset.loaded){
      if(S.auth.canUseApi){
        v.dataset.loaded='1';
        // ★ 有cog_ key → 尝试API加载
        v.innerHTML='<div class="empty"><div class="ic">'+({sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗',usage:'📊',org:'🏢',mcp:'🧩',automations:'⚙️'}[t]||'🌐')+'</div><h3>'+{sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations',usage:'Usage 用量',org:'组织成员',mcp:'MCP 服务器',automations:'Automations'}[t]+'</h3><p style="margin:8px 0;color:var(--muted)">正在加载...</p></div>';
        cmd('loadTabData',{tab:t});
      } else {
        // ★ 无 auth1 (仅 session-token) → 底层自动获取凭证, 用户无需手动 API Key
        const tabNames={sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations',usage:'Usage 用量',org:'组织成员',mcp:'MCP 服务器',automations:'Automations',schedules:'Schedules 定时'};
        const tabIcons={sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗',usage:'📊',org:'🏢',mcp:'🧩',automations:'⚙️',schedules:'📅'};
        v.innerHTML='<div class="empty"><div class="ic">'+(tabIcons[t]||'🌐')+'</div><h3>'+tabNames[t]+'</h3><p style="margin:8px 0;color:var(--muted);font-size:13px">正在从底层自动获取访问凭证…</p><p style="font-size:11px;color:var(--muted);max-width:360px;line-height:1.6;margin-bottom:12px">账号凭证将随 IDE 登录状态自动同步, 无需手动操作。若长时间未就绪, 可重试自动登录或手动切换账号。</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn primary" onclick="cmd(&#39;devinAutoAcquire&#39;)">🔄 重试自动获取</button><button class="btn ghost" onclick="cmd(&#39;devinManualLogin&#39;)">👤 手动登录其他账户</button></div></div>';
      }
    }
  }
}
function rc(){if(S.tab==='overview')rO();if(S.tab==='bridge')rBridgeFull()}
// 帛书·「见小曰明」: 凭证就绪后(login/autoAcquire 使 canUseApi 转真), 当前数据 tab 仍停在「获取凭证」占位
// (该占位故意不标记 loaded) — 此处自动重载, 拉取真实数据, 用户无需再次点击。
function reloadActiveDataTab(){
  var t=S.tab;
  if(t==='overview'||t==='bridge'||t==='inject'||t==='switch'||t==='backups'||t==='computer')return;
  if(!S.auth.loggedIn||!S.auth.canUseApi)return;
  var v=document.getElementById('v-'+t);
  if(!v||v.dataset.loaded)return;
  v.dataset.loaded='1';
  var ic=({sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗',usage:'📊',org:'🏢',mcp:'🧩',automations:'⚙️'}[t])||'🌐';
  v.innerHTML='<div class="empty"><div class="ic">'+ic+'</div><p style="margin:8px 0;color:var(--muted)">正在加载...</p></div>';
  cmd('loadTabData',{tab:t});
}
// 操作电脑本体 · 把整个软件/IDE 当浏览器供 MCP/用户直接操作本机: 命令/文件/终端/系统打开。
// (对照手机端 Shizuku/无障碍「操作整机」, 电脑端经 VSCode 扩展宿主直接驱动本机)
function rComputer(){
  var v=document.getElementById('v-computer');if(!v)return;
  if(!v.dataset.init){ v.dataset.init='1'; cmd('compInfo'); }
  var info=S.comp&&S.comp.info;
  var infoHtml = info
    ? ('<div class="card"><div class="cr"><span class="l">主机</span><span class="v">'+esc(info.host||'')+' · '+esc(info.platform||'')+' '+esc(info.arch||'')+'</span></div>'
        +'<div class="cr"><span class="l">用户</span><span class="v">'+esc(info.user||'')+'</span></div>'
        +'<div class="cr"><span class="l">工作目录(cwd)</span><span class="v">'+esc(info.cwd||'')+'</span></div>'
        +'<div class="cr"><span class="l">工作区</span><span class="v">'+esc((info.folders||[]).join(' · ')||'(无)')+'</span></div></div>')
    : '<div class="empty"><div class="ic">🖥️</div><p style="color:var(--muted)">读取本机信息…</p></div>';
  var last=S.comp&&S.comp.last;
  var outHtml = last
    ? ('<div class="card"><div class="cr"><span class="l">上次命令</span><span class="v">'+esc(last.cmd||'')+(last.code!=null?(' · 退出码 '+last.code):'')+'</span></div>'
        +'<pre style="white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;background:#1a1a1a;border:1px solid var(--border);border-radius:6px;padding:10px;font-family:monospace;font-size:11.5px;color:'+(last.ok?'#cdd3de':'#ffb4b4')+'">'+esc((last.stdout||'')+((last.stderr)?('\\n'+last.stderr):''))+'</pre></div>')
    : '';
  v.innerHTML=''
    +'<div class="st">🖥️ 操作电脑本体</div>'
    +'<div class="card" style="font-size:12px;color:var(--muted);line-height:1.6">把整个软件当浏览器: 在此直接驱动本机(运行命令/打开文件/系统资源管理器/集成终端)。'
      +'与「公网穿透」板块配合, 远端 Devin/MCP 亦可代用户操作本机, 达 MCP 效果。<br>⚠ 命令以 IDE 进程权限在工作目录执行, 请谨慎。</div>'
    +infoHtml
    +'<div class="st">▶ 运行命令</div>'
    +'<div class="card"><textarea id="compCmd" placeholder="如: git status   /   node -v   /   dir(Windows) ls(类Unix)" style="width:100%;height:60px;background:#1a1a1a;border:1px solid var(--border);border-radius:6px;color:var(--fg);padding:8px;font-family:monospace;font-size:12px;resize:vertical"></textarea>'
      +'<div class="br" style="margin-top:8px"><button class="btn primary" id="compRunBtn">运行</button><button class="btn ghost" id="compTermBtn">送入集成终端</button></div></div>'
    +outHtml
    +'<div class="st">📂 文件 / 资源管理器</div>'
    +'<div class="card"><input id="compPath" placeholder="文件或目录绝对路径" style="width:100%;background:#1a1a1a;border:1px solid var(--border);border-radius:6px;color:var(--fg);padding:7px 9px;font-size:12px">'
      +'<div class="br" style="margin-top:8px"><button class="btn" id="compOpenBtn">在编辑器打开</button><button class="btn ghost" id="compRevealBtn">系统资源管理器定位</button></div></div>';
  var rb=document.getElementById('compRunBtn');if(rb)rb.onclick=function(){var c=(document.getElementById('compCmd')||{}).value||'';if(!c.trim()){toast('请输入命令',false);return;}toast('执行中…',true);cmd('compRun',{cmd:c});};
  var tb=document.getElementById('compTermBtn');if(tb)tb.onclick=function(){var c=(document.getElementById('compCmd')||{}).value||'';if(!c.trim()){toast('请输入命令',false);return;}cmd('compTerminal',{text:c});toast('已送入集成终端',true);};
  var ob=document.getElementById('compOpenBtn');if(ob)ob.onclick=function(){var p=(document.getElementById('compPath')||{}).value||'';if(!p.trim()){toast('请输入路径',false);return;}cmd('compOpenFile',{path:p});};
  var vb=document.getElementById('compRevealBtn');if(vb)vb.onclick=function(){var p=(document.getElementById('compPath')||{}).value||'';if(!p.trim()){toast('请输入路径',false);return;}cmd('compReveal',{path:p});};
}
// 切号模块 (移植自 RT Flow · 全功能面板第2模块) — 账号池列表 + 切换/刷新/清理/出库。
function rSwitchLoading(){
  var v=document.getElementById('v-switch');if(!v)return;
  v.innerHTML='<div class="st">🔀 切号 · 账号池</div><div class="empty"><div class="ic">🔀</div><p style="margin:8px 0;color:var(--muted)">正在读取账号池…</p></div>';
}
function rSwitchData(d){
  var v=document.getElementById('v-switch');if(!v)return;
  var accts=(d&&d.accounts)||[];var cur=(d&&d.current)||'';
  var h='<div class="st">🔀 切号 · 账号池 ('+accts.length+')</div>';
  h+='<div class="card"><div class="cr"><span class="l">当前账号</span><span class="v" style="color:var(--success)">'+(cur?esc(cur):'—')+'</span></div></div>';
  // 管理按钮 — 路由到 RT Flow (wam.*) 既有命令
  h+='<div class="br"><button class="btn sm" onclick="cmd(&#39;wamCmd&#39;,{cmd:&#39;wam.switchAccount&#39;})">🔄 切换账号</button>';
  h+='<button class="btn sm" onclick="cmd(&#39;wamCmd&#39;,{cmd:&#39;wam.panicSwitch&#39;})" title="限流/卡死时轮换到下一个可用账号">🚨 紧急切换</button>';
  h+='<button class="btn sm" onclick="cmd(&#39;wamCmd&#39;,{cmd:&#39;wam.refreshAll&#39;});setTimeout(function(){cmd(&#39;loadSwitch&#39;)},1500)">🔃 刷新全部</button>';
  h+='<button class="btn sm" onclick="cmd(&#39;wamCmd&#39;,{cmd:&#39;wam.addAccount&#39;})">➕ 添加账号</button>';
  h+='<button class="btn sm ghost" onclick="cmd(&#39;wamCmd&#39;,{cmd:&#39;wam.openEditor&#39;})" title="打开 RT Flow 完整账号管理面板">🗂️ 完整管理面板</button></div>';
  // 清理额度归零账号: 备份→清理→出库 一气呵成
  h+='<div class="st" style="margin-top:12px">🌊 额度归零清理</div>';
  h+='<div class="card"><div style="font-size:11px;color:var(--muted);margin-bottom:6px">对所有额度归零账号: <b style="color:var(--fg)">全量备份对话 → 清理数据 → 移出账号库</b>，一气呵成。</div>';
  h+='<button class="btn sm danger" onclick="if(confirm(&#39;将对所有额度归零账号执行: 备份→清理→出库(不可逆)。确认?&#39;))cmd(&#39;cleanupZeroQuota&#39;)">🌊 清理并出库归零账号</button>';
  h+='<button class="btn sm" onclick="if(confirm(&#39;对全部账号立即: 备份→归零→出库(无模态·一气呵成)。确认?&#39;))cmd(&#39;cleanupImmediate&#39;)" title="立即清理(参手机版·无模态): 全部账号 先备份→归零→出库">⚡ 立即清理(全部)</button></div>';
  // 账号列表
  if(!accts.length){
    h+='<div class="empty" style="margin-top:10px"><div class="ic">📭</div><p style="color:var(--muted)">账号池为空 · 用「添加账号」导入</p></div>';
    v.innerHTML=h;return;
  }
  h+='<div class="st" style="margin-top:12px">账号列表</div>';
  accts.forEach(function(a,i){
    var active=a.active||a.email===cur;
    var q=(typeof a.quota==='number')?(a.quota+'%'):(a.quota||'');
    var badge=active?'<span class="tag" style="background:var(--success);color:#000">当前</span>':'';
    if(a.banned)badge+='<span class="tag" style="background:var(--danger);color:#fff">封禁</span>';
    if(q!=='')badge+='<span class="tag" style="background:'+(a.zero?'var(--danger)':'#2d5a8a')+';color:#fff">'+esc(q)+'</span>';
    h+='<div class="card" style="display:flex;align-items:center;gap:6px;padding:7px 9px;margin-bottom:4px">';
    h+='<span style="font-size:11px;color:var(--muted);min-width:20px">'+(i+1)+'</span>';
    h+='<span style="flex:1;font-size:12px;font-weight:600;word-break:break-all">'+esc(a.email)+' '+badge+'</span>';
    h+='<button class="btn sm" title="切换为此账号" onclick="cmd(&#39;switchToAccount&#39;,{email:&#39;'+esc(a.email)+'&#39;})">切换</button>';
    h+='<button class="btn sm ghost" title="多实例路由(独立窗口打开此账号官网)" onclick="cmd(&#39;routeAccount&#39;,{email:&#39;'+esc(a.email)+'&#39;})">🌐</button>';
    h+='</div>';
  });
  v.innerHTML=h;
}
// v3.17.0 · 切号面板回归本源: 第2 Tab = 真 WAM 切号面板(buildHtml) via iframe(Blob) + 消息中继。
//   acquireVsCodeApi shim → parent.postMessage 中继到扩展 handleWebviewMessage; 引擎回推经 wamHost 中继进 iframe。
var _wamFrameUrl='';
var _wamRebuildTs=0;
function rWamMount(html){
  var v=document.getElementById('v-switch'); if(!v||!html) return;
  var SHIM='<scr'+'ipt>(function(){var _s={};window.acquireVsCodeApi=function(){return{postMessage:function(m){try{parent.postMessage({__wamRelay:m},"*")}catch(e){}},getState:function(){return _s},setState:function(s){_s=s;return s}}};})();</scr'+'ipt>';
  var doc=/<head[^>]*>/i.test(html)?html.replace(/<head([^>]*)>/i,'<head$1>'+SHIM):SHIM+html;
  var f=document.getElementById('wamFrame');
  if(!f){ v.innerHTML=''; f=document.createElement('iframe'); f.id='wamFrame'; f.style.cssText='width:100%;height:100%;border:none;background:#1e1e1e;flex:1'; v.appendChild(f); }
  try{var blob=new Blob([doc],{type:'text/html'});var url=URL.createObjectURL(blob);f.removeAttribute('srcdoc');f.src=url;if(_wamFrameUrl){try{URL.revokeObjectURL(_wamFrameUrl)}catch(e){}}_wamFrameUrl=url;}catch(e){ f.srcdoc=doc; }
  S._wamReady=true;
}
function _wamToFrame(msg){var f=document.getElementById('wamFrame');if(f&&f.contentWindow){try{f.contentWindow.postMessage(msg,'*')}catch(e){}}}
// 四大接入模块卡片 — 平铺常驻(去渐进式披露)。全部命令在导出的单一 MD 中。
function daoBridgeModuleCard(n,ic,title,desc,how){
  // v3.17.0 · 去渐进式披露: 四大模块平铺常驻(原 <details> 折叠改为 <div> 全展开)
  return '<div class="card" style="margin-bottom:6px"><div style="font-weight:600;font-size:12px">'
    +ic+' 模块'+n+' · '+title+'</div>'
    +'<div style="font-size:11px;color:var(--fg);margin:6px 0 4px">'+desc+'</div>'
    +'<div style="font-size:10px;color:var(--muted)">实现：'+how+'</div></div>';
}
// 内网穿透 · DAO Bridge — 与独立穿透插件 1:1: 状态 + 命名隧道/CloudFlare + 导出文档 + 能力自测。
function rBridgeFull(){
  var v=document.getElementById('v-bridge');if(!v)return;
  var b=S.bridge||{};
  var on=!!b.url;
  var h='<div class="st">☯ 内网穿透 · DAO Bridge (集成)</div>';
  h+='<div class="card" style="font-size:11px;color:var(--muted);margin-bottom:6px">无名之樸 · 插件启动即自动打通整机公网穿透，<b style="color:var(--fg)">零配置、无需任何账号</b>；云端 Agent 即可远程操作本机。</div>';
  // ── 模块1: 实时状态 ──
  if(!on){
    h+='<div class="card"><div class="cr"><span class="l">隧道状态</span><span class="v" style="color:var(--warn)">'+(b.lastErr?esc(b.lastErr):'未连接 · 启动中…')+'</span></div>';
    h+='<div class="cr"><span class="l">本地端口</span><span class="v">'+(b.localPort||b.port||'—')+'</span></div></div>';
    h+='<div class="br"><button class="btn primary" onclick="cmd(&#39;bridgeStart&#39;)">▶ 启动隧道</button>';
    h+='<button class="btn" onclick="cmd(&#39;bridgeRestart&#39;)">🔄 重启隧道</button></div>';
  } else {
    var stTxt=b.persistent?'✓ 已打通 · 持久化(常驻)':'✓ 已打通 · 公网在线';
    var isRelay=b.relayUrl&&b.url===b.relayUrl;
    h+='<div class="card"><div class="cr"><span class="l">状态</span><span class="v" style="color:var(--success)">'+stTxt+'</span></div>';
    if(b.persistent&&b.source)h+='<div class="cr"><span class="l">来源</span><span class="v" style="font-size:10px">'+esc(b.source)+(typeof b.ageMs==="number"?(' · '+Math.round(b.ageMs/60000)+"分钟前"):"")+'</span></div>';
    h+='<div class="cr"><span class="l">'+(isRelay?'中继 Relay':(b.named?'命名隧道(固定)':'公网 URL'))+'</span><span class="v" style="font-size:10px;word-break:break-all"><a href="#" onclick="cmd(&#39;copyBridgeUrl&#39;);return false" style="color:var(--accent2)">'+esc(b.url)+'</a></span></div>';
    if(b.session)h+='<div class="cr"><span class="l">会话</span><span class="v">'+esc(b.session)+'</span></div>';
    if(b.port||b.localPort)h+='<div class="cr"><span class="l">本地端口</span><span class="v">'+(b.port||b.localPort)+'</span></div>';
    h+='<div class="cr"><span class="l">代理 / 链路</span><span class="v" style="font-size:10px">'+(b.proxy?('代理 '+esc(b.proxy)):'直连(无代理)')+(isRelay?' · relay/wss':(b.named?' · named/http2':' · quick/http2'))+'</span></div>';
    h+='<div class="cr"><span class="l">在线 Agent</span><span class="v">'+(b.agentCount||0)+'</span></div>';
    if(b.workspace)h+='<div class="cr"><span class="l">工作区</span><span class="v">'+esc(b.workspace)+'</span></div>';
    if(b.host)h+='<div class="cr"><span class="l">主机</span><span class="v">'+esc(b.host)+'</span></div>';
    if(b.token)h+='<div class="cr"><span class="l">Token</span><span class="v" style="font-size:10px;word-break:break-all">'+esc(String(b.token).slice(0,8)+'…'+String(b.token).slice(-4))+'</span></div>';
    if(b.updated)h+='<div class="cr"><span class="l">更新于</span><span class="v" style="font-size:10px">'+esc(b.updated)+'</span></div>';
    h+='</div>';
    h+='<div class="br"><button class="btn sm primary" onclick="cmd(&#39;copyBridgeShell&#39;)" title="复制实时公网单页地址(/shell)·免登录·在任意电脑/手机浏览器打开即可操作整个面板(适配电脑/手机)">🌐 复制公网单页网址</button>';
    h+='<button class="btn sm primary" onclick="cmd(&#39;copyBridgeInfo&#39;)" title="一键复制 公网URL + Token + Auth 头 整段接入信息">📋 复制接入信息</button>';
    h+='<button class="btn sm" onclick="cmd(&#39;bridgeRefreshToken&#39;)" title="生新令牌并同步到所有账号; 刷新期间旧令牌仍有效不断链">♻ 刷新Token</button>';
    h+='<button class="btn sm" onclick="cmd(&#39;bridgeRestart&#39;)">🔄 重启隧道</button>';
    h+='<button class="btn sm danger" onclick="cmd(&#39;bridgeStop&#39;)">⏹ 停止</button></div>';
  }
  // ── 在线设备 · 已接入本中枢的全部设备 (本机/中枢自身 + 经一行命令接入的远端设备) ──
  h+='<div class="st" style="margin-top:14px">🖥️ 在线设备 <button class="btn sm ghost" style="float:right;margin-top:-3px;padding:2px 8px" onclick="cmd(&#39;bridgeListAgents&#39;)">⟳ 刷新</button></div>';
  h+='<div id="bridgeAgents" class="card">'+rBridgeAgents()+'</div>';
  // ── 一行接入 · PowerShell 把另一台设备接进本中枢 (irm .../bootstrap.ps1 | iex) ──
  if(on){
    var bu=String(b.url);var joinCmd='irm '+(bu.charAt(bu.length-1)==='/'?bu.slice(0,-1):bu)+'/api/bootstrap.ps1 | iex';
    h+='<div class="st" style="margin-top:14px">🔗 一行接入设备 · PowerShell</div>';
    h+='<div class="card"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">在另一台 Windows 上以 PowerShell 运行下面这行，即把该机接入本中枢，出现在上方「在线设备」并可被远程操控：</div>';
    h+='<pre style="white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.25);padding:7px;font-size:11px;margin:0 0 6px;border-radius:4px;color:var(--accent2)">'+esc(joinCmd)+'</pre>';
    h+='<button class="btn sm primary" onclick="cmd(&#39;copyBridgeJoin&#39;)">📋 复制一行接入命令</button></div>';
  }
  // ── 四大接入模块介绍/命名隧道均移至本面板底部 (核心: 导出文档/自测 前置) ──
  // ── 导出接入文档 (回归 dao-bridge 本源 · 仅整机穿透接入信息 + 端点 + SDK; 四大模块在 MCP 使用文档) ──
  h+='<div class="st" style="margin-top:14px">📄 导出接入文档</div>';
  h+='<div class="card"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">内网穿透 MD：接入信息(URL/Token) + 整机端点 + Python SDK，让云端 Agent 远程操作整台电脑。URL/端口随隧道实时更新。打开 / 复制 / 注入。</div>';
  h+='<div class="br"><button class="btn sm" onclick="cmd(&#39;openBridgeMd&#39;)">📄 打开 MD</button>';
  h+='<button class="btn sm primary" onclick="cmd(&#39;bridgeCopyCloudMd&#39;)">📋 复制云端 Agent MD</button>';
  h+='<button class="btn sm" onclick="cmd(&#39;bridgeInjectKnowledge&#39;)">📚 注入</button></div></div>';
  // ── 模块4: 能力自测 ──
  h+='<div class="st" style="margin-top:14px">⚡ 能力自测</div>';
  h+='<div class="card"><div class="br"><button class="btn sm" onclick="cmd(&#39;bridgeHealth&#39;)">health</button>';
  h+='<input id="bridgeCmd" value="hostname" placeholder="命令" style="flex:1;min-width:80px;padding:5px 7px;background:var(--input);color:var(--input-fg);border:1px solid var(--border);border-radius:4px">';
  h+='<button class="btn sm" onclick="bridgeExec()">exec</button></div>';
  h+='<pre id="bridgeOut" style="white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.25);padding:6px;max-height:180px;overflow:auto;font-size:11px;margin:6px 0 0;border-radius:4px;color:var(--muted)">（结果）</pre></div>';
  // ── 末·参考一: 命名隧道 · 固定域名（可选） ──
  h+='<div class="st" style="margin-top:14px">🔑 命名隧道 · 固定域名（可选）</div>';
  h+='<div class="card">';
  var cfOn=!!(b.cfLoggedIn||b.named);
  if(cfOn){
    h+='<div class="cr"><span class="l">CloudFlare</span><span class="v" style="color:var(--success)">✓ 用户通道'+(b.cfEmail?(' · '+esc(b.cfEmail)):'')+(b.named?'（命名隧道·固定域名）':'')+'</span></div>';
    h+='<div style="font-size:10px;color:var(--muted);margin:4px 0">已绑定 CloudFlare 凭证。'+(b.named?'命名隧道令牌已就绪 — 点「重启隧道」即以固定域名启动。':'如需固定公网域名，请在 CloudFlare 创建命名隧道并把 <code>tunnel run --token</code> 令牌填入下方。')+'</div>';
    h+='<button class="btn sm" onclick="cmd(&#39;bridgeStartNamed&#39;)">🔗 用命名隧道(固定域名)启动</button>';
    h+='<button class="btn sm" onclick="cmd(&#39;openCf&#39;)">🌐 打开 CloudFlare 控制台</button>';
    h+='<button class="btn sm danger" onclick="if(confirm(&#39;退出账号并清空全部 CloudFlare 凭证残留(含 cert.pem)，回到无账号快速隧道？&#39;))cmd(&#39;bridgeLogout&#39;)">退出账号 / 重置为无账号</button>';
  } else {
    h+='<div style="font-size:11px;color:var(--muted);margin-bottom:4px">默认快速隧道已可用，<b style="color:var(--fg)">无需登录</b>。仅当你想要<b style="color:var(--fg)">固定不变的公网域名</b>时，才需配置 CloudFlare（也可放入 ~/.dao/dao-config.json 的 cfTunnelToken 自动加载）。</div>';
    h+='<input id="cfEmail" type="email" placeholder="CloudFlare Email（可选）" style="width:100%;margin:3px 0;padding:5px 7px;box-sizing:border-box;background:var(--input);color:var(--input-fg);border:1px solid var(--border);border-radius:4px">';
    h+='<input id="cfKey" type="password" placeholder="Tunnel Token / API Token / Global Key" style="width:100%;margin:3px 0;padding:5px 7px;box-sizing:border-box;background:var(--input);color:var(--input-fg);border:1px solid var(--border);border-radius:4px">';
    h+='<div class="br"><button class="btn sm primary" onclick="bridgeCfLogin()">保存并切到用户通道</button>';
    h+='<button class="btn sm" onclick="cmd(&#39;bridgeCfBrowserLogin&#39;)" title="用浏览器登录 Cloudflare(可用 GitHub 账号), 需自有域名才有固定域名">🌐 浏览器登录 CF</button></div>';
    h+='<button class="btn sm" onclick="cmd(&#39;openCf&#39;)" style="margin-top:4px">🌐 打开 CloudFlare 控制台</button>';
  }
  h+='</div>';
  // ── 末·更深层能力 → 已独立为 MCP (内穿面板回归本源·只管整机直连; 四大模块不再内联此处) ──
  h+='<div class="st" style="margin-top:14px">🧩 更深层专业操作 · DAO Bridge MCP</div>';
  h+='<div class="card" style="font-size:11px;color:var(--muted)">日常远程操作整机走上方内网穿透即可。浏览器自动化(CDP) / GUI 鼠键截屏 / 插件本体 / VSCode 命令等<b style="color:var(--fg)">四大模块</b>能力，已独立为 <b style="color:var(--fg)">DAO Bridge MCP</b>(随账号反向注入·HTTP 传输·无需手动配置)。用法见知识库「DAO Bridge MCP 使用文档(四大模块)」, 或在「MCP」面板查看。</div>';
  v.innerHTML=h;
  if(!S.bridgeAgents||!S.bridgeAgents.loaded)cmd('bridgeListAgents');
}
// 在线设备列表渲染 — 中枢(本机)恒在线 + 经一行命令接入的远端设备(online/offline·主机·用户·OS·最后心跳)。
function rBridgeAgents(){
  var ba=S.bridgeAgents||{};
  if(!ba.loaded)return '<div class="cr"><span class="l" style="color:var(--muted);font-size:11px">加载中…</span></div>';
  var rows='';
  var hubName=ba.host||'本机';
  rows+='<div class="cr"><span class="l"><span class="dot '+(ba.online?'on':'off')+'" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle"></span>'+esc(hubName)+' <span style="color:var(--muted);font-size:10px">· 中枢(本机)</span></span><span class="v" style="color:'+(ba.online?'var(--success)':'var(--warn)')+';font-size:11px">'+(ba.online?'● 在线':'○ 离线')+'</span></div>';
  var ags=ba.agents||[];
  for(var i=0;i<ags.length;i++){var a=ags[i];var onl=(a.status==='online');
    rows+='<div class="cr" style="border-top:1px solid var(--border);padding-top:5px;margin-top:5px"><span class="l"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:'+(onl?'var(--success)':'var(--muted)')+'"></span>'+esc(a.hostname||a.id||'?')+'</span><span class="v" style="color:'+(onl?'var(--success)':'var(--muted)')+';font-size:11px">'+(onl?'● 在线':'○ 离线')+'</span></div>';
    var meta=[];if(a.user)meta.push('用户 '+a.user);if(a.os)meta.push(String(a.os).slice(0,40));if(a.last_seen)meta.push('心跳 '+bkRel(Date.parse(a.last_seen)));
    if(meta.length)rows+='<div style="font-size:10px;color:var(--muted);margin:2px 0 0 14px">'+esc(meta.join(' · '))+'</div>';
  }
  if(!ags.length)rows+='<div style="font-size:10px;color:var(--muted);margin-top:6px">暂无其他接入设备 — 用下方「一行接入」命令把更多设备接进来。</div>';
  return rows;
}
function bridgeCfLogin(){var e=document.getElementById('cfEmail'),k=document.getElementById('cfKey');var email=e?e.value.trim():'';var key=k?k.value.trim():'';if(!key){toast('请填写 Token / API Key',false);return}toast('验证中…',true);cmd('bridgeCfLogin',{email:email,key:key})}
function bridgeExec(){var c=document.getElementById('bridgeCmd');var v=c?c.value.trim():'';if(!v)return;var o=document.getElementById('bridgeOut');if(o)o.textContent='执行中…';cmd('bridgeExec',{cmd:v})}
// 问题②③ · 备份板块: 全账号×全对话备份成果 + 查看/下载 (路由 rt-flow 同源备份 · 纯本地·免 cog_ key)
function rBackups(){
  var v=document.getElementById('v-backups');if(!v)return;
  v.innerHTML='<div class="empty"><div class="ic">📦</div><p style="margin:8px 0;color:var(--muted)">正在扫描本地备份…</p></div>';
  cmd('loadBackups');
}
// 环境蓝图 · 只读板块 (snapshot-setup/blueprints + 机器快照计数)
function rBlueprintsLoading(){var v=document.getElementById('v-blueprints')||document.getElementById('ov-blueprints');if(v)v.innerHTML='<div class="empty"><div class="ic">🗺️</div><p style="margin:8px 0;color:var(--muted)">正在加载环境蓝图…</p></div>'}
function rBlueprintsData(items,snapCount,err){
  var v=document.getElementById('v-blueprints')||document.getElementById('ov-blueprints');if(!v)return;
  if(err){
    if(err==='需要 cog_ API Key'){v.innerHTML='<div class="empty"><div class="ic">🗺️</div><h3>环境蓝图</h3><p style="margin:8px 0;color:var(--muted);font-size:13px">正在从底层自动获取访问凭证…</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn primary" onclick="cmd(&#39;devinAutoAcquire&#39;)">🔄 重试</button></div></div>';return}
    v.innerHTML='<div class="empty"><div class="ic">🗺️</div><h3>环境蓝图</h3><p style="margin:8px 0;color:var(--danger);font-size:12px">Error: '+esc(err)+'</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn" onclick="cmd(&#39;loadBlueprints&#39;)">⟳ 重试</button><button class="btn ghost" onclick="cmd(&#39;openBlueprintDetail&#39;)">🌐 官网打开</button></div></div>';return;
  }
  var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="color:var(--muted);font-size:11px">'+items.length+' 蓝图 · '+(snapCount||0)+' 快照</span><div class="br"><button class="btn sm" onclick="cmd(&#39;loadBlueprints&#39;)">⟳</button><button class="btn sm ghost" onclick="cmd(&#39;openBlueprintDetail&#39;)">🌐</button></div></div>';
  if(!items.length){h+='<div class="empty"><div class="ic">🗺️</div><p style="margin:8px 0;color:var(--muted)">本账号暂无环境蓝图</p><p style="font-size:11px;color:var(--muted);max-width:340px;line-height:1.6">蓝图 git-backed (引用各自仓库)，跨账号注入非平凡；此板块先提供只读盘点。</p><div class="br" style="justify-content:center"><button class="btn ghost" onclick="cmd(&#39;openBlueprintDetail&#39;)">🌐 在 Devin Cloud 中配置</button></div></div>';v.innerHTML=h;return}
  items.forEach(function(b){
    var st=b.connected?'<span style="color:var(--success)">● active</span>':'<span style="color:var(--muted)">○ inactive</span>';
    h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(b.name)+'</span><span class="v" style="font-size:11px">'+st+'</span></div>'+(b.detail?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(b.detail)+'</div>':'')+'</div>';
  });
  v.innerHTML=h;
}
function bkMtime(ms){try{return ms?new Date(ms).toLocaleString():''}catch(e){return''}}
function bkToggle(id){var e=document.getElementById(id);if(e)e.style.display=(e.style.display==='none'?'block':'none')}
function bkReveal(i,ci){var a=S.backups.accounts[i];if(!a)return;var p=(ci==null)?a.dir:((a.conversations[ci]||{}).path);if(p)cmd('revealBackupDir',{dir:p})}
function bkView(i,ci){var a=S.backups.accounts[i];if(!a)return;var c=a.conversations[ci];if(c&&c.htmlPath)cmd('openBackupConv',{htmlPath:c.htmlPath})}
// 道法自然 · 备份内联浏览 (文件夹式): 点对话即在面板内展开正文(对话.md/html), 无需弹外部页。
function bkConvToggle(i,ci){var cid='bkc-'+i+'-'+ci;var e=document.getElementById(cid);if(!e)return;if(e.style.display==='none'||!e.style.display){e.style.display='block';if(!e.getAttribute('data-loaded')){e.innerHTML='<div style="font-size:10px;color:var(--muted);padding:4px">加载中…</div>';var c=(((S.backups.accounts[i]||{}).conversations||[])[ci]||{});cmd('readBackupConv',{i:i,ci:ci,path:c.path||c.dir||''})}}else{e.style.display='none'}}
function rBackupConv(d){var cid='bkc-'+d.i+'-'+d.ci;var e=document.getElementById(cid);if(!e)return;e.setAttribute('data-loaded','1');if(!d.ok){e.innerHTML='<div style="font-size:11px;color:var(--danger);padding:4px">无法读取: '+esc(d.error||'未知')+'</div>';return}if(d.fmt==='html'){e.innerHTML='<iframe sandbox="" style="width:100%;height:380px;border:1px solid var(--border);border-radius:4px;background:#fff" srcdoc="'+String(d.content||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'"></iframe>'}else{e.innerHTML='<div style="max-height:380px;overflow:auto;background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:4px;padding:8px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word">'+esc(d.content||'')+'</div>'}}
function bkDownload(i,ci){var a=S.backups.accounts[i];if(!a)return;var p=(ci==null)?a.dir:((a.conversations[ci]||{}).path);if(p)cmd('exportBackup',{path:p})}
// 解锁(解压) ZIP 型对话备份 → 同名文件夹, 解压后可内联查看正文。
function bkUnlock(i,ci){var a=S.backups.accounts[i];if(!a)return;var c=(a.conversations||[])[ci];if(!c||c.type!=='zip'||!c.path)return;toast('解锁(解压)中…',true);cmd('unlockBackupZip',{path:c.path})}
// 视图切换: 按账号(分组) ↔ 近期对话(跨账号·按时间倒序)
function bkSetView(mode){S.bkView=mode;rBackupsData(S.backups,null)}
// 对话检索: 按 账号邮箱 / 对话名 / 对话ID 过滤 (再渲染后回焦, 不丢输入位置)
function bkSearchSet(q){S.bkSearch=q;rBackupsData(S.backups,null);var el=document.getElementById('bkSearch');if(el){el.focus();try{var n=el.value.length;el.setSelectionRange(n,n)}catch(e){}}}
function bkMatch(c,a,q){if(!q)return true;q=String(q).toLowerCase();var hay=[(c&&(c.title||c.name))||'',(c&&c.devinId)||'',(a&&(a.email||a.account))||'',(a&&a.accountNo?('#'+a.accountNo):'')].join(' ').toLowerCase();return hay.indexOf(q)>=0}
// 多实例浏览器打开「具体对话」(官网 /sessions/<devinId>) — 复用账号路由的多实例机制
function bkOpenConv(i,ci){var a=S.backups.accounts[i];if(!a)return;var c=(a.conversations||[])[ci];if(!c)return;var did=c.devinId||'';if(!did){toast('该备份无对话ID, 无法打开官网',false);return}toast('多实例打开对话…',true);cmd('openConvMultiBrowser',{email:a.email||a.account||'',devinId:did})}
// 拖拽: 像 IDE 文件夹一样把对话拖到右侧(编辑器/浏览器/路由面板) — 携带官网会话 URL(uri-list/plain/json)
function bkConvDragStart(ev,i,ci){try{var a=S.backups.accounts[i]||{};var c=((a.conversations||[])[ci])||{};var did=String(c.devinId||'').replace(/^devin-/,'');if(!did)return;var url='https://app.devin.ai/sessions/'+did;var title=(c.title||c.name||'对话');if(ev.dataTransfer){ev.dataTransfer.setData('text/uri-list',url);ev.dataTransfer.setData('text/plain',url);ev.dataTransfer.setData('application/json',JSON.stringify({type:'dao-conv',email:a.email||a.account||'',devinId:did,title:title,url:url}));/* 拖拽上传桥契约: 落到代理网页(/__daobridge.js)即上传该会话MD到页面上传框, 与 /shell 一致 */ev.dataTransfer.setData('application/x-dao-conv',JSON.stringify({email:a.email||a.account||'',sid:did,title:title}));ev.dataTransfer.effectAllowed='copyLink'}}catch(e){}}
// 相对时间 (对齐手机版: 刚刚/分钟前/小时前/天前)
function bkRel(ms){try{if(!ms)return'';var d=Date.now()-ms;if(d<0)d=0;var s=Math.floor(d/1000);if(s<60)return'刚刚';var m=Math.floor(s/60);if(m<60)return m+'分钟前';var hh=Math.floor(m/60);if(hh<24)return hh+'小时前';var dd=Math.floor(hh/24);if(dd<30)return dd+'天前';return new Date(ms).toLocaleDateString()}catch(e){return''}}
// 对话状态 → 颜色 + 文案 (与 rt-flow 对话追踪同口径: running/awaiting/blocked/finished/failed)
function bkStatusInfo(st){st=String(st||'').toLowerCase();
  if(st==='running'||st==='working'||st==='active')return{c:'#3fb950',t:'running'};
  if(st==='awaiting'||st==='blocked'||st==='waiting'||st.indexOf('await')>=0||st.indexOf('input')>=0)return{c:'#d29922',t:st==='awaiting'?'awaiting':'blocked'};
  if(st==='finished'||st==='completed'||st==='done'||st==='stopped'||st==='expired')return{c:'#8b949e',t:st};
  if(st==='failed'||st==='error')return{c:'#f85149',t:st};
  if(st)return{c:'#58a6ff',t:st};
  return{c:'#6e7681',t:''};
}
// 单条对话渲染 (复用于两种视图) — 对齐手机版: 账号编号徽章 + 状态点 + 醒目对话名 + 邮箱·状态·相对时间
function bkConvRow(c,i,ci,showAcct){
  var t=c.title||c.name||'(未命名)';var cid='bkc-'+i+'-'+ci;
  var did=String(c.devinId||'').replace(/^devin-/,'').slice(0,8);
  var a=S.backups.accounts[i]||{};
  var si=bkStatusInfo(c.status);
  var accNo=a.accountNo?('#'+a.accountNo):'';
  var rel=bkRel(c.liveTs||c.mtime);
  var h='<div style="padding:6px 2px;border-bottom:1px solid var(--border)">';
  // 标题行: 账号编号徽章 + 状态点 + 对话名(醒目: 13px/600/前景色, 溢出省略)
  h+='<div style="display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer" onclick="bkConvToggle('+i+','+ci+')">';
  if(accNo)h+='<span style="flex:0 0 auto;font-size:10px;font-weight:700;color:var(--accent);background:rgba(88,166,255,.14);border-radius:4px;padding:1px 5px">'+esc(accNo)+'</span>';
  h+='<span style="flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:'+si.c+'"'+(si.t?(' title="'+esc(si.t)+'"'):'')+'></span>';
  h+='<span style="flex:1 1 auto;font-size:13px;font-weight:600;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(t)+'</span>';
  h+='</div>';
  // 副行: 邮箱 · 状态 · 相对时间 · devinId · 事件数
  var sub=[];
  if(showAcct&&(a.email||a.account))sub.push(esc(a.email||a.account));
  if(si.t)sub.push('<span style="color:'+si.c+';font-weight:600">'+esc(si.t)+'</span>');
  if(rel)sub.push(esc(rel));
  if(did)sub.push('<span style="color:var(--accent)">'+esc(did)+'</span>');
  if(c.eventCount)sub.push(c.eventCount+'事件');
  if(c.type==='zip')sub.push('ZIP');
  if(sub.length)h+='<div style="font-size:10px;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+sub.join(' · ')+'</div>';
  // 按钮行 (对齐手机版: 查看 / 进入(多实例·可拖拽) / MD / 文件)
  h+='<div class="br" style="margin-top:5px">';
  h+='<button class="btn sm" onclick="bkConvToggle('+i+','+ci+')">👁 查看</button>';
  if(c.devinId)h+='<button class="btn sm primary" draggable="true" ondragstart="bkConvDragStart(event,'+i+','+ci+')" onclick="bkOpenConv('+i+','+ci+')" title="多实例浏览器打开此对话官网(可拖拽到右侧路由/编辑器)">🚀 进入</button>';
  h+='<button class="btn sm ghost" onclick="bkDownload('+i+','+ci+')" title="导出对话 MD/备份">⬇ MD</button>';
  h+='<button class="btn sm ghost" onclick="bkReveal('+i+','+ci+')" title="在文件管理器中打开备份目录">📦 文件</button>';
  if(c.hasHtml)h+='<button class="btn sm ghost" onclick="bkView('+i+','+ci+')" title="在浏览器中打开本地 HTML 备份">📄HTML</button>';
  if(c.type==='zip')h+='<button class="btn sm ghost" onclick="bkUnlock('+i+','+ci+')" title="解压 ZIP 备份到同名文件夹后可内联查看">🔓 解锁</button>';
  h+='</div>';
  h+='<div id="'+cid+'" style="display:none;margin-top:4px"></div></div>';
  return h;
}
function rBackupsData(tree,err){
  var v=document.getElementById('v-backups');if(!v)return;
  S.backups=tree||{accounts:[]};
  if(err){v.innerHTML='<div class="empty"><div class="ic">📦</div><h3>对话备份</h3><p style="color:var(--danger);font-size:12px">'+esc(err)+'</p><div class="br" style="justify-content:center"><button class="btn" onclick="rBackups()">⟳ 重试</button></div></div>';return}
  var accts=(tree&&tree.accounts)||[];
  if(!accts.length){v.innerHTML='<div class="empty"><div class="ic">📦</div><h3>对话备份</h3><p style="color:var(--muted)">暂无备份</p><p style="font-size:10px;color:var(--muted);word-break:break-all">'+esc((tree&&tree.root)||'')+'</p><div class="br" style="justify-content:center"><button class="btn" onclick="rBackups()">⟳ 刷新</button></div></div>';return}
  var totalConv=accts.reduce(function(s,a){return s+(a.count||0)},0);
  var view=S.bkView||'recent';
  var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="color:var(--muted);font-size:11px">'+accts.length+' 账号 · '+totalConv+' 对话备份</span><button class="btn sm" onclick="rBackups()">⟳</button></div>';
  h+='<div class="br" style="margin-bottom:8px"><button class="btn sm'+(view==='recent'?' primary':' ghost')+'" onclick="bkSetView(&#39;recent&#39;)">🕒 近期对话</button><button class="btn sm'+(view==='acct'?' primary':' ghost')+'" onclick="bkSetView(&#39;acct&#39;)">📂 按账号</button></div>';
  var q=S.bkSearch||'';
  h+='<input id="bkSearch" value="'+esc(q)+'" placeholder="🔍 搜索 账号邮箱 / 对话名 / 对话ID" oninput="bkSearchSet(this.value)" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:6px 8px;background:var(--input,rgba(255,255,255,.06));color:var(--fg);border:1px solid var(--border);border-radius:4px;font-size:12px">';
  h+='<div style="font-size:10px;color:var(--muted);margin-bottom:8px;word-break:break-all">根: '+esc(tree.root||'')+'</div>';
  if(view==='recent'){
    // 跨账号 · 近期对话: 扁平化所有对话, 按 mtime 倒序, 检索过滤后每条带账号+devinId
    var flat=[];
    accts.forEach(function(a,i){(a.conversations||[]).forEach(function(c,ci){if(bkMatch(c,a,q))flat.push({c:c,i:i,ci:ci})})});
    flat.sort(function(x,y){return ((y.c.liveTs||y.c.mtime||0)-(x.c.liveTs||x.c.mtime||0))});
    var shown=flat.slice(0,200);
    if(!shown.length){h+='<div class="empty"><div class="ic">🕒</div><p style="color:var(--muted)">'+(q?'无匹配对话':'暂无对话')+'</p></div>';v.innerHTML=h;return}
    shown.forEach(function(it){h+='<div class="card" style="margin-bottom:4px;padding:6px 8px">'+bkConvRow(it.c,it.i,it.ci,true)+'</div>'});
    if(flat.length>200)h+='<div style="font-size:10px;color:var(--muted);margin-top:4px">仅显示最近 200 条 (匹配 '+flat.length+')</div>';
    v.innerHTML=h;return;
  }
  var anyAcct=false;
  accts.forEach(function(a,i){
    var aid='bkacc-'+i;
    var label=(a.accountNo?('#'+a.accountNo+' '):'')+(a.email||a.account||'');
    var acctHit=!q||bkMatch(null,a,q);
    var convs=(a.conversations||[]);
    var matched=q?convs.map(function(c,ci){return {c:c,ci:ci}}).filter(function(o){return acctHit||bkMatch(o.c,a,q)}):convs.map(function(c,ci){return {c:c,ci:ci}});
    if(q&&!acctHit&&!matched.length)return; // 检索时该账号无匹配 → 隐藏
    anyAcct=true;
    var expand=!!q; // 检索时自动展开匹配账号
    h+='<div class="card">';
    h+='<div class="cr" style="cursor:pointer" onclick="bkToggle(&#39;'+aid+'&#39;)"><span class="l" style="font-weight:600;color:var(--fg)">▸ '+esc(label)+'</span><span class="v" style="font-size:10px;color:var(--muted)">'+(q?(matched.length+'/'+(a.count||0)):(a.count||0))+' 对话'+(a.hasAccountInfo?' · 账号快照':'')+'</span></div>';
    h+='<div class="br" style="margin-top:4px"><button class="btn sm ghost" onclick="bkReveal('+i+',null)">📂 目录</button><button class="btn sm ghost" onclick="bkDownload('+i+',null)">⬇ 下载账号</button></div>';
    h+='<div id="'+aid+'" style="display:'+(expand?'block':'none')+';margin-top:6px;border-top:1px solid var(--border);padding-top:6px">';
    matched.slice(0,200).forEach(function(o){h+=bkConvRow(o.c,i,o.ci,false)});
    if(matched.length>200)h+='<div style="font-size:10px;color:var(--muted);margin-top:4px">仅显示前 200 条，更多请打开目录</div>';
    h+='</div></div>';
  });
  if(q&&!anyAcct)h+='<div class="empty"><div class="ic">🔍</div><p style="color:var(--muted)">无匹配账号/对话</p></div>';
  v.innerHTML=h;
}
// 帛书·「为而弗恃」: API Key 全程底层自动获取, 面板永不出现手动输入 — 旧 submitCogKey* 已删
function rHost(){var hc=S.hostCaps||{};var nm=hc.appName||'VS Code';var ct=hc.hasConvTracking;return '<div class="st">运行环境 · 适配</div><div class="card"><div class="cr"><span class="l">IDE</span><span class="v">'+esc(nm)+'</span></div><div class="cr"><span class="l">Devin Cloud 全功能</span><span class="v" style="color:var(--success);font-size:10px">✓ 追踪·备份·切号反向注入·K/P/S/MCP·多实例</span></div><div class="cr"><span class="l">Cascade 对话追踪/备份</span><span class="v" style="font-size:10px;color:'+(ct?'var(--success)':'var(--warn)')+'">'+(ct?'✓ 可用':'⚠ 此IDE非Cascade·其余全部正常')+'</span></div></div>'}
function rO(){
  const v=document.getElementById('v-overview');
  if(!S.auth.loggedIn){
    v.innerHTML='<div class="empty"><div class="ic">🤖</div><h3>Devin Cloud</h3><p style="margin:12px 0">登录以连接您的 Devin Cloud 账户</p><div class="br" style="justify-content:center"><button class="btn primary" onclick="cmd(&#39;devinLogin&#39;)">🔑 登录</button>'+(S.auth.hasWsCreds?'<button class="btn" style="background:#0e639c" onclick="cmd(&#39;devinWindsurfAutoLogin&#39;)">🌀 Windsurf 自动登录</button>':'')+'</div></div>';
    return;
  }
  let qh='';
  if(S.auth.quota){
    // 配额只显美金 (账号余额) · 去 Day/Week · 仿 rt-flow 最小化 · 道法自然
    const q=S.auth.quota;
    const bal=(q.overageDollars!=null)?q.overageDollars:null;
    const balStr=(bal!=null)?('$'+Number(bal).toFixed(2)):'—';
    const bc=(bal==null)?'var(--muted)':(bal>5?'var(--success)':bal>1?'var(--warn)':'var(--danger)');
    qh='<div class="st">余额</div><div class="card"><div class="cr"><span class="l">美金余额</span><span class="v" style="color:'+bc+';font-weight:700;font-size:15px">'+balStr+'</span></div>'+(q.planName?'<div class="cr"><span class="l">Plan</span><span class="v">'+esc(q.planName)+'</span></div>':'')+'</div>';
  }
  // v3.17.4 · 去芜存菁: 主页「注入状态」板块(S/K/P/G ✓✗)已移除 —
  //   反向注入实况以左侧「反向注入」面板 + 底部状态点(Server/Relay/Injected)为准, 主页不再重复呈现。
  v.innerHTML=rHost()+'<div class="st">账户</div><div class="card"><div class="cr"><span class="l">邮箱</span><span class="v">'+esc(S.auth.email)+'</span></div><div class="cr"><span class="l">组织</span><span class="v">'+esc(S.auth.orgName)+'</span></div>'+(S.auth.orgId?'<div class="cr"><span class="l">Org ID</span><span class="v" style="font-size:10px">'+esc(S.auth.orgId)+'</span></div>':'')+'<div class="cr"><span class="l">Token</span><span class="v"><span class="tag devin">'+esc(S.auth.tokenType||S.auth.apiKeyType||'?')+'</span></span></div><div class="cr"><span class="l">API能力</span><span class="v">'+(S.auth.canUseApi?'<span style="color:var(--success)">✓ 完整API访问</span>':'<span style="color:var(--warn)">⚠ 仅Codeium API</span>')+'</div></div>'+qh+'<div class="st">多实例浏览器</div><div class="br"><button class="btn primary" onclick="cmd(&#39;openRoutedPanel&#39;)" title="在 IDE 内打开独立路由面板(多实例·不阻塞·道并行而不相悖)" style="background:#1a7f5a">🖥️ IDE 内路由面板 (多实例)</button><button class="btn" onclick="cmd(&#39;syncBrowser&#39;)" style="background:#6f42c1" title="在电脑浏览器开独立 profile 窗口自动登录(多账号并行隔离)">🌐 电脑浏览器同步 (隔离窗口)</button></div>'+'<div class="st">🧩 插件能力 · API 接口</div><div class="card"><div class="cr"><span class="l" style="font-size:11px;line-height:1.5">插件本体全部功能均以本地 HTTP API 暴露 — 多实例路由 <code>/api/devin/multi/*</code>、MCP 接测/注入 <code>/api/devin/mcp/*</code> 等,可被任意 Agent 调用接管。导出 MD 契约即得全量端点。</span></div></div><div class="br"><button class="btn primary" style="background:#0e639c" onclick="cmd(&#39;exportAgentDoc&#39;)" title="导出整个插件全量 API 的 MD 契约 · 供任意 Agent 识别后接管插件底层做基础配置">📄 导出 MD 契约 (全量 API)</button></div>'+'<div class="st">服务器</div><div class="card"><div class="cr"><span class="l">端口</span><span class="v">'+(S.server.port||'未启动')+'</span></div><div class="cr"><span class="l">Relay</span><span class="v" style="color:'+(S.server.relay?'var(--success)':'var(--muted)')+'">'+(S.server.relay?'✓ '+esc(S.server.relayUrl):'✗ 本地')+'</span></div></div>';
  // 内网穿透·DAO Bridge 已独立为左侧栏单独板块(data-tab="bridge"→rBridgeFull), 主页不再内嵌;
  // 主页专注单账号信息/操作/注入。
  // ② 去芜存菁: 把「当前账号·手动内容」(Knowledge/Playbooks/Secrets/Git) 直接合进主页
  v.innerHTML+=daoOverviewManualHtml();
  daoLoadOverviewManual();
}
// ② 帛书·「为腹不为目」: 手动·对应当前账号的 K/P/S/Git 不再各占侧栏标签, 统一落主页内查看/修改/修复。
//   复用既有 loadTabData→rT 渲染(含新建/刷新/删除/🔒手锁), 数据走当前账号实时 API。
function daoOverviewManualHtml(){
  if(!S.auth.loggedIn) return '';
  if(!S.auth.canUseApi){
    return '<div class="st">当前账号 · 手动内容</div><div class="card"><div class="cr"><span class="l" style="font-size:11px;color:var(--muted);line-height:1.6">凭证就绪(cog_ API Key)后自动加载 Knowledge / Playbooks / Secrets / Git。当前仅 Codeium API, 请先完成自动登录。</span></div></div>';
  }
  return '<div class="st">当前账号 · 手动内容 · 查看·修改·修复</div>'
    +'<div class="st" style="margin-top:8px;font-size:11px;text-transform:none">📚 Knowledge 知识库</div><div id="ov-knowledge" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">📋 Playbooks 剧本</div><div id="ov-playbooks" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">🔑 Secrets 密钥</div><div id="ov-secrets" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">🔗 Git / Security</div><div id="ov-git" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">⚙️ Automations 自动化</div><div id="ov-automations" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">📅 Schedules 定时任务</div><div id="ov-schedules" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">🗺️ 环境蓝图 Blueprints</div><div id="ov-blueprints" class="ovsec"><div class="empty" style="padding:10px"><p style="color:var(--muted);font-size:11px;margin:0">加载中…</p></div></div>'
    +'<div class="st" style="font-size:11px;text-transform:none">🧩 MCP 服务器</div><div class="card"><div class="cr"><span class="l" style="font-size:11px;color:var(--muted)">MCP 在专用面板集中管理(浏览市场·安装·卸载·钉住)</span><span class="v"><button class="btn sm primary" onclick="sw(&#39;mcp&#39;)">打开 MCP 面板</button></span></div></div>';
}
function daoLoadOverviewManual(){
  if(!S.auth.loggedIn||!S.auth.canUseApi)return;
  ['knowledge','playbooks','secrets','integrations','automations','schedules'].forEach(function(t){
    var id=(t==='integrations')?'ov-git':'ov-'+t;
    if(!document.getElementById(id))return;
    cmd('loadTabData',{tab:t});
  });
  if(document.getElementById('ov-blueprints'))cmd('loadBlueprints');
}
function rBridge(){
  var b=S.bridge;var head='<div class="st">内网穿透 · DAO Bridge</div>';
  if(!b){return head+'<div class="card"><div class="cr"><span class="l">状态</span><span class="v" style="color:var(--muted)">未运行 · 安装/启动 dao-bridge 插件后自动打通当前工作区</span></div></div>';}
  var on=!!b.url;
  var rows='<div class="cr"><span class="l">状态</span><span class="v" style="color:'+(on?'var(--success)':'var(--warn)')+'">'+(on?(b.persistent?'✓ 已打通 · 持久化':'✓ 已打通'):'隧道离线')+'</span></div>';
  if(b.url)rows+='<div class="cr"><span class="l">公网 URL</span><span class="v" style="font-size:10px">'+esc(b.url)+'</span></div>';
  if(b.workspace)rows+='<div class="cr"><span class="l">工作区</span><span class="v">'+esc(b.workspace)+'</span></div>';
  if(b.root)rows+='<div class="cr"><span class="l">根目录</span><span class="v" style="font-size:10px">'+esc(b.root)+'</span></div>';
  if(b.updated)rows+='<div class="cr"><span class="l">更新于</span><span class="v" style="font-size:10px">'+esc(b.updated)+'</span></div>';
  var btns='<div class="br">'+(b.url?'<button class="btn sm" onclick="cmd(&#39;copyBridgeUrl&#39;)">复制 URL</button>':'')+'<button class="btn sm ghost" onclick="cmd(&#39;openBridgeMd&#39;)">打开 MD</button></div>';
  return head+'<div class="card">'+rows+btns+'</div>';
}
function sm(title,bodyHtml,onOk){document.getElementById('mc').innerHTML='<h3>'+title+'</h3>'+bodyHtml+'<div class="mb"><button class="btn ghost" onclick="hm()">取消</button><button class="btn primary" onclick="doOk()">确定</button></div>';document.getElementById('mo').classList.remove('hid');window._onOk=onOk}
function hm(){document.getElementById('mo').classList.add('hid')}
function doOk(){if(window._onOk&&window._onOk()!==false)hm()}
function toast(msg,ok){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(ok?'ok':'err');setTimeout(()=>t.classList.add('hid'),3000)}
function usb(){const ds=document.getElementById('ds'),dr=document.getElementById('dr'),di=document.getElementById('di'),sp=document.getElementById('sp');if(ds)ds.className='dot '+(S.server.port?'on':'off');if(dr)dr.className='dot '+(S.server.relay?'on':'off');if(di)di.className='dot '+(S.inject&&S.inject.secret&&S.inject.knowledge&&S.inject.playbook?'on':'off');if(sp)sp.textContent=S.server.port?':'+S.server.port:'off'}
// 顶部徽章实时同步 — 帛书·「反者道之动」: 账号一切, 徽章随之, 永不老旧
function uhd(){const ab=document.getElementById('ab');if(ab){ab.textContent=S.auth.loggedIn?('✓ '+(S.auth.email||'').split('@')[0]):'未连接';ab.className='b '+(S.auth.loggedIn?'ok':'off')}const ob=document.getElementById('ob');if(ob){if(S.auth.orgName){ob.textContent=S.auth.orgName;ob.style.display=''}else{ob.style.display='none'}}}
window.addEventListener('message',e=>{const d=e.data;if(!d)return;if(d.__wamRelay){cmd('wamRelay',{msg:d.__wamRelay});return;}if(d.type==='wamInitHtml'){rWamMount(d.html);return;}if(d.type==='wamHost'){var _wm=d.msg||{};if(_wm.type==='__wamRebuild'){if(Date.now()-_wamRebuildTs<10000)return;_wamRebuildTs=Date.now();rWamMount(_wm.html);}else{_wamToFrame(_wm);}return;}if(d.type==='init'){Object.assign(S.auth,d.auth||{});Object.assign(S.server,d.server||{});S.inject=d.inject||S.inject;if(d.injectStatus!==undefined)S.injectStatus=d.injectStatus;if(d.bridge!==undefined)S.bridge=d.bridge;if(d.hostCaps)S.hostCaps=d.hostCaps;uhd();usb();rc();reloadActiveDataTab()}else if(d.type==='tabData'){S.data[d.tab]=d.items||[];if(d.locks)S.locks=d.locks;rT(d.tab,d.items||[],d.error,d.fallbackProxy);if(d.tab==='secrets')rInjectLiveSecrets()}else if(d.type==='sessionDetail'){rSD(d)}else if(d.type==='gotoTab'){try{sw(d.tab||'overview')}catch(e){}}else if(d.type==='switchData'){rSwitchData(d)}else if(d.type==='backupsData'){rBackupsData(d.tree||{accounts:[]},d.error)}else if(d.type==='backupConv'){rBackupConv(d)}else if(d.type==='blueprintsData'){rBlueprintsData(d.items||[],d.snapCount,d.error)}else if(d.type==='injectProfile'){S.injectProfile=d.profile||S.injectProfile;rInject()}else if(d.type==='actionResult'){if(d.command==='injectDiagnose'&&d.text){toast(d.text,d.ok);rInject()}else{toast(d.command+' '+(d.ok?'✓':'✗'),d.ok)}if(d.ok){if((d.command==='toggleManualLock'||d.command==='devinEditKnowledgeInline'||d.command==='mcpMarketInstall'||d.command==='mcpUninstall'||d.command==='clearAutomations')&&S.tab){if(S.tab==='overview'){daoLoadOverviewManual()}else if(S.tab==='switch'||S.tab==='backups'){/* 守柔: 切号/对话 tab 非 loadTabData 数据源, 不重载避免 Unknown tab */}else{cmd('loadTabData',{tab:S.tab})}}else if(S.tab!=='inject'){rc()}}}else if(d.type==='mcpProbeResult'){mcpProbeRender(d.idx,d.result)}else if(d.type==='bridgeTestResult'){var bo=document.getElementById('bridgeOut');if(bo)bo.textContent='['+d.op+'] '+(d.ok?'✓':'✗')+' '+(d.text||'')}else if(d.type==='bridgeAgents'){S.bridgeAgents={loaded:true,host:d.host,online:d.online,agents:d.agents||[]};var bae=document.getElementById('bridgeAgents');if(bae)bae.innerHTML=rBridgeAgents()}else if(d.type==='compInfo'){S.comp=S.comp||{};S.comp.info=d.info||null;if(S.tab==='computer')rComputer()}else if(d.type==='compResult'){S.comp=S.comp||{};S.comp.last={cmd:d.cmd,ok:d.ok,code:d.code,stdout:d.stdout,stderr:d.stderr};toast('命令'+(d.ok?'完成':'失败')+(d.code!=null?(' · 退出码 '+d.code):''),d.ok);if(S.tab==='computer')rComputer()}else if(d.type==='error'){toast('Error: '+d.msg,false)}});
// MCP 卡片动作: 装到本账号 / 卸载 / 加入反向注入档案(批量) — 帛书·「图难于其易」
function mcpSpec(m){return {marketplace_server_id:m.marketplace_server_id,slug:m.slug,name:String(m.name||'').replace(/^★ /,''),transport:m.transport,short_description:m.detail,command:m.command,args:m.args,env_variables:m.env_variables,url:m.url,headers:m.headers,installation_scope:m.installation_scope,requires_custom_oauth_credentials:m.requiresOauth};}
function mcpAct(idx,action){
  var m=(window._mcp||[])[idx];if(!m)return;
  if(action==='install'){toast('安装中…',true);cmd('mcpMarketInstall',{spec:mcpSpec(m)});}
  else if(action==='uninstall'){if(confirm('卸载 '+(m.name||'')+' ?'))cmd('mcpUninstall',{id:m.installationId});}
  else if(action==='profile'){cmd('mcpAddProfile',{spec:mcpSpec(m)});}
  else if(action==='all'){if(confirm('一键批量装「'+String(m.name||'').replace(/^★ /,'')+'」到所有账号(反向注入)?'))cmd('mcpInstallAllAccounts',{spec:mcpSpec(m)});}
}
// MCP 接测: 实际探测连通性 (HTTP initialize / STDIO 命令解析), 结果回填卡片状态 span
function mcpProbe(idx){var m=(window._mcp||[])[idx];if(!m)return;var s=document.getElementById('mcp-probe-'+idx);if(s){s.style.color='var(--warn)';s.textContent='· 测试中…';}cmd('mcpProbe',{idx:idx,spec:mcpSpec(m)});}
function mcpProbeAll(){var n=(window._mcp||[]).length;if(!n)return;toast('接测 '+n+' 项…',true);for(var i=0;i<n;i++){(function(j){setTimeout(function(){mcpProbe(j)},j*120)})(i);}}
function mcpRepairLocal(){toast('修复本机 MCP 中…(自动识别运行时/路径, 已备份)',true);cmd('repairLocalMcp',{});}
function mcpVerifyLocal(){toast('实测 Devin Desktop MCP 中…',true);cmd('verifyLocalMcp',{});}
function mcpProbeRender(idx,r){var s=document.getElementById('mcp-probe-'+idx);if(!s)return;r=r||{};var col=r.ok?'var(--success)':(r.status===401||r.status===403||(r.label||'').indexOf('可达')>=0?'var(--warn)':'var(--danger)');s.style.color=col;s.textContent='· '+(r.ok?'✓ ':'✗ ')+(r.label||'')+(r.detail?'':'');s.title=r.detail||'';}
// MCP 即时搜索/筛选 (纯前端, 不重渲染, 不丢焦点) — 对齐官网市场搜索
function mcpFilter(q){q=(q||'').toLowerCase().trim();var cards=document.querySelectorAll('.mcp-card');for(var i=0;i<cards.length;i++){var k=cards[i].getAttribute('data-k')||'';var c=cards[i];var srcOk=true;if(!q&&c.className.indexOf('mcp-ide-card')>=0){var cs=c.getAttribute('data-src')||'';srcOk=!window._mcpSrc||window._mcpSrc.indexOf(cs)>=0;}c.style.display=((!q||k.indexOf(q)>=0)&&srcOk)?'':'none'}}
// MCP 来源筛选: 默认只显示 Devin Desktop, 点来源标签可展开其他平台(Cursor/VS Code 等) — 给选择空间而不全量铺开
function mcpSrcToggle(src){if(!window._mcpSrc)window._mcpSrc=[];var i=window._mcpSrc.indexOf(src);if(i>=0){if(window._mcpSrc.length>1)window._mcpSrc.splice(i,1);}else window._mcpSrc.push(src);mcpSrcApply();}
function mcpSrcApply(){var chips=document.querySelectorAll('.mcp-src-chip');for(var i=0;i<chips.length;i++){var s=chips[i].getAttribute('data-src');var on=window._mcpSrc.indexOf(s)>=0;chips[i].style.background=on?'#1a7f5a':'transparent';chips[i].style.color=on?'#fff':'var(--muted)';chips[i].textContent=(on?'● ':'○ ')+s;}var cards=document.querySelectorAll('.mcp-ide-card');for(var j=0;j<cards.length;j++){var cs=cards[j].getAttribute('data-src')||'';cards[j].style.display=(window._mcpSrc.indexOf(cs)>=0)?'':'none';}}
// 添加自定义 MCP → 直接装到本账号 (复用市场安装通道 devinAddCustomMcp), 对齐官网 Add custom MCP
function mcpAddCustom(){sm('添加自定义 MCP (装到本账号)','<input id="m1" placeholder="名称 name (如 GitHub MCP)" style="width:100%;margin:4px 0"><select id="m2" style="width:100%;margin:4px 0"><option value="HTTP">HTTP / SSE (远程 URL)</option><option value="STDIO">STDIO (command/args)</option></select><input id="m3" placeholder="URL (HTTP) 或 command (STDIO, 如 npx)" style="width:100%;margin:4px 0"><input id="m4" placeholder="args 空格分隔 (STDIO) / Authorization 头值 (HTTP)" style="width:100%;margin:4px 0"><input id="m5" placeholder="简介 short_description (可选)" style="width:100%;margin:4px 0"><p style="font-size:10px;color:var(--muted);margin:4px 0">提示: 点下方预设可一键填 GitHub MCP</p><button class="btn sm" onclick="ipMcpPreset(&#39;github&#39;)">GitHub MCP 预设</button>',function(){var n=document.getElementById('m1').value.trim();if(!n)return false;var tr=document.getElementById('m2').value;var f3=document.getElementById('m3').value.trim();var f4=document.getElementById('m4').value.trim();var sd=document.getElementById('m5').value.trim();var spec={name:n,transport:tr,short_description:sd,installation_scope:'org'};if(tr==='STDIO'){spec.command=f3;spec.args=f4?f4.split(' ').filter(Boolean):[];spec.env_variables=[]}else{spec.url=f3;if(f4)spec.headers={Authorization:f4}}toast('安装中…',true);cmd('mcpMarketInstall',{spec:spec})})}
function rT(tab,items,err,fallbackProxy){
  // ② 容器归一: 独立标签(v-*)已移除的 K/P/S/Git 落主页内 ov-* 容器(integrations→ov-git)
  const v=document.getElementById('v-'+tab)||document.getElementById('ov-'+(tab==='integrations'?'git':tab));if(!v)return;
  // 帛书·「反者道之动也」— 认证策略根本修复
  if(fallbackProxy||err){
    const tabNames={sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations',usage:'Usage 用量',org:'组织成员',mcp:'MCP 服务器',automations:'Automations',schedules:'Schedules 定时'};
    const tabIcons={sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗',usage:'📊',org:'🏢',mcp:'🧩',automations:'⚙️',schedules:'📅'};
    if(err==='需要 cog_ API Key'||fallbackProxy){
      // ★ 需要cog_ key — 显示创建引导
      v.innerHTML='<div class="empty"><div class="ic">'+(tabIcons[tab]||'🌐')+'</div><h3>'+tabNames[tab]+'</h3><p style="margin:8px 0;color:var(--muted);font-size:13px">正在从底层自动获取访问凭证…</p><p style="font-size:11px;color:var(--muted);max-width:360px;line-height:1.6">账号凭证随 IDE 登录状态自动同步, 无需手动 API Key。</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn primary" onclick="cmd(&#39;devinAutoAcquire&#39;)">🔄 重试自动获取</button><button class="btn ghost" onclick="cmd(&#39;devinManualLogin&#39;)">👤 手动登录其他账户</button></div></div>';
    } else {
      // 其他错误
      v.innerHTML='<div class="empty"><div class="ic">'+(tabIcons[tab]||'🌐')+'</div><h3>'+tabNames[tab]+'</h3><p style="margin:8px 0;color:var(--danger);font-size:12px">Error: '+esc(err||'Unknown')+'</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn" onclick="cmd(&#39;loadTabData&#39;,{tab:&#39;'+tab+'&#39;})">⟳ 重试</button><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;'+tab+'&#39;})">🌐 在 Devin Cloud 中打开</button></div></div>';
    }
    return;
  }
  if(!items.length){v.innerHTML='<div class="empty"><div class="ic">'+({sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗',usage:'📊',org:'🏢',mcp:'🧩',automations:'⚙️',schedules:'📅'}[tab]||'🌐')+'</div><h3>'+{sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations',usage:'Usage 用量',org:'组织成员',mcp:'MCP 服务器',automations:'Automations',schedules:'Schedules 定时'}[tab]+'</h3><p style="margin:8px 0;color:var(--muted)">No items found</p><div class="br" style="justify-content:center"><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;'+tab+'&#39;})">🌐 Open in Devin</button></div></div>';return}
  // ★ v1.0.1 · 各tab添加新建按钮 · 帛书·「道生一·一生二」
  const createBtns={sessions:'<button class="btn sm primary" onclick="cmd(&#39;devinCreateSession&#39;)">+ Session</button>',knowledge:'<button class="btn sm primary" onclick="cmd(&#39;devinCreateKnowledge&#39;)">+ Knowledge</button>',playbooks:'<button class="btn sm primary" onclick="cmd(&#39;devinCreatePlaybook&#39;)">+ Playbook</button>',secrets:'<button class="btn sm primary" onclick="cmd(&#39;devinCreateSecret&#39;)">+ Secret</button>',integrations:'<button class="btn sm primary" onclick="cmd(&#39;devinConnectGit&#39;)">+ GitHub PAT</button>',automations:'<button class="btn sm danger" onclick="if(confirm(&#39;确认清除本账号官网全部自动化?此操作不可撤销&#39;))cmd(&#39;clearAutomations&#39;)">🧹 清除全部</button>'};
  let h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="color:var(--muted);font-size:11px">'+items.length+' items</span><div class="br">'+(createBtns[tab]||'')+'<button class="btn sm" onclick="cmd(&#39;loadTabData&#39;,{tab:&#39;'+tab+'&#39;})">⟳</button><button class="btn sm ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;'+tab+'&#39;})">🌐</button></div></div>';
  if(tab==='sessions'){
    items.forEach(s=>{
      const id=s.devin_id||s.id||'';const title=s.title||s.name||'Untitled';const status=s.status||'';const created=s.created_at||'';
      const sc=status==='running'?'var(--success)':status==='completed'?'var(--muted)':status==='failed'?'var(--danger)':'var(--warn)';
      h+='<div class="card" style="cursor:pointer" onclick="cmd(&#39;loadSessionDetail&#39;,{sessionId:&#39;'+esc(id)+'&#39;})"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(title)+'</span><span class="v" style="color:'+sc+';font-size:10px">'+esc(status)+'</span></div><div class="cr"><span class="l" style="font-size:10px">'+esc(id.substring(0,12))+'...</span><span class="l" style="font-size:10px">'+esc(created?new Date(created).toLocaleString():'')+'</span></div><div class="br" style="margin-top:4px" onclick="event.stopPropagation()"><button class="btn sm" onclick="cmd(&#39;loadSessionDetail&#39;,{sessionId:&#39;'+esc(id)+'&#39;})">👁 查看</button><button class="btn sm" onclick="cmd(&#39;exportSession&#39;,{sessionId:&#39;'+esc(id)+'&#39;,kind:&#39;conversation&#39;})">📥 对话</button><button class="btn sm ghost" onclick="cmd(&#39;exportSession&#39;,{sessionId:&#39;'+esc(id)+'&#39;,kind:&#39;worklog&#39;})">📋 日志</button><button class="btn sm ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;sessions&#39;,id:&#39;'+esc(id)+'&#39;})">🌐</button></div></div>';
    });
  }else if(tab==='knowledge'){
    items.forEach(k=>{
      const id=k.id||'';const name=k.name||'Untitled';const trigger=k.trigger_description||k.trigger||'';const enabled=k.is_enabled!==false;
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(name)+'</span><span class="v"><span class="tag knowledge">K</span>'+(enabled?'<span style="color:var(--success);margin-left:4px">✓</span>':'<span style="color:var(--danger);margin-left:4px">✗</span>')+'</span></div>'+(trigger?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(trigger.substring(0,100))+'</div>':'')+'<div class="br" style="margin-top:4px">'+lkBtn('knowledge',name)+'<button class="btn sm" onclick="kEdit(&#39;'+esc(String(id))+'&#39;)">✏️ 修改</button><button class="btn sm danger" onclick="cmd(&#39;devinDeleteKnowledge&#39;,{id:&#39;'+esc(String(id))+'&#39;})">🗑</button></div></div>';
    });
  }else if(tab==='playbooks'){
    // 道法自然 · 官方模板剧本(access=community, Cognition 出品)默认折叠, 不占空间;
    //   本账号自建剧本(team/org)默认展开。用户痛点「官方 Playbook 太多占满空间」根治。
    var pbCard=function(p){
      var id=p.id||'';var title=p.title||p.name||'Untitled';var status=p.status||'';
      return '<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(title)+'</span><span class="v"><span class="tag playbook">P</span></span></div>'+(status?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(status)+'</div>':'')+'<div class="br" style="margin-top:4px">'+lkBtn('playbooks',title)+'<button class="btn sm" onclick="cmd(&#39;devinEditPlaybook&#39;,{id:&#39;'+esc(String(id))+'&#39;})">✏️ 修改</button><button class="btn sm danger" onclick="cmd(&#39;devinDeletePlaybook&#39;,{id:&#39;'+esc(String(id))+'&#39;})">🗑</button></div></div>';
    };
    var mine=items.filter(function(p){return (p.access||'')!=='community'});
    var official=items.filter(function(p){return (p.access||'')==='community'});
    if(mine.length){h+='<div class="st" style="font-size:11px;text-transform:none;margin:4px 0">本账号剧本 ('+mine.length+')</div>';mine.forEach(function(p){h+=pbCard(p)});}
    else{h+='<div style="font-size:11px;color:var(--muted);margin:6px 0">本账号暂无自建剧本</div>';}
    if(official.length){
      h+='<div class="st" style="font-size:11px;text-transform:none;margin:10px 0 4px;cursor:pointer" onclick="bkToggle(&#39;pb-official&#39;)">▸ 官方模板剧本 ('+official.length+') · 点击展开/收起</div>';
      h+='<div id="pb-official" style="display:none">';
      official.forEach(function(p){h+=pbCard(p)});
      h+='</div>';
    }
  }else if(tab==='secrets'){
    items.forEach(s=>{
      const name=s.name||s.key||'Unnamed';const id=s.id||'';
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(name)+'</span><span class="v"><span class="tag secret">S</span></span></div><div class="br" style="margin-top:4px">'+lkBtn('secrets',name)+'<button class="btn sm" onclick="cmd(&#39;devinEditSecret&#39;,{name:&#39;'+esc(name)+'&#39;})">✏️ 改值</button><button class="btn sm danger" onclick="cmd(&#39;devinDeleteSecret&#39;,{name:&#39;'+esc(name)+'&#39;})">🗑</button></div></div>';
    });
  }else if(tab==='integrations'){
    items.forEach(c=>{
      const id=c.id||c.connection_id||'';const provider=c.provider||c.name||'GitHub';const login=c.login||c.username||c.detail||'';
      const connected=c.connected!==undefined?c.connected:!!id;
      const statusHtml=connected?'<span style="color:var(--success)">● Connected</span>':'<span style="color:var(--muted)">○ Not connected</span>';
      const delBtn=(c.kind==='git'&&id)?'<div class="br" style="margin-top:4px"><button class="btn sm danger" onclick="cmd(&#39;devinDisconnectGit&#39;,{connectionId:&#39;'+esc(String(id))+'&#39;})">🗑 断开</button></div>':'';
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(provider)+'</span><span class="v" style="font-size:11px">'+statusHtml+'</span></div>'+(login?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(login)+'</div>':'')+delBtn+'</div>';
    });
  }else if(tab==='mcp'){
    // 官网 MCP 整图给到本地: 已装(★)+ 全市场目录; 每项可「装到本账号 / +档案(批量注入) / 卸载」
    // 对齐官网: 顶部「+ 自定义 MCP」(直接装到本账号) + 搜索/筛选框 (名称/简介即时过滤)。
    window._mcp=[];window._mcpIde=[];
    h+='<div class="br" style="margin-bottom:6px"><button class="btn sm primary" onclick="mcpAddCustom()">+ 自定义 MCP</button><button class="btn sm" onclick="mcpProbeAll()" title="逐项接测所有 MCP 连接(连通性验证)">🔍 全部接测</button><button class="btn sm" onclick="mcpRepairLocal()" title="一键修复本机 MCP: 自动识别 node 运行时与模块路径、修正命令并启用(先备份, 通用·强鲁棒)。重载窗口后生效" style="background:#b8860b;color:#fff">🔧 一键修复本机 MCP</button><button class="btn sm" onclick="mcpVerifyLocal()" title="实测使用: 真起进程 initialize+tools/list 拿真实工具数" style="background:#1a7f5a;color:#fff">🧪 实测使用</button></div>';
    h+='<input id="mcpq" placeholder="🔍 搜索 MCP (名称 / 简介)" oninput="mcpFilter(this.value)" style="width:100%;margin:0 0 8px;padding:6px 8px;box-sizing:border-box;background:var(--card,#222);color:var(--fg);border:1px solid var(--border);border-radius:4px">';
    var _curG='';
    var _ideSrcs=[];items.forEach(function(x){if(x.group==='ide'&&x.source&&_ideSrcs.indexOf(x.source)<0)_ideSrcs.push(x.source);});
    // 跟着宿主 IDE 走: 默认来源 = 当前插件运行所在 IDE 对应的 source(否则 Devin Desktop, 再否则首个)。
    var _an=(function(){try{return((S&&S.hostCaps&&S.hostCaps.appName)||'').toLowerCase();}catch(e){return '';}})();
    var _hostSrc=_an.indexOf('cursor')>=0?'Cursor':(_an.indexOf('trae')>=0?'Trae':(_an.indexOf('antigravity')>=0?'Antigravity':((_an.indexOf('windsurf')>=0||_an.indexOf('devin')>=0||_an.indexOf('codeium')>=0||_an.indexOf('cascade')>=0)?'Devin Desktop':(_an.indexOf('code')>=0?'VS Code':''))));
    var _defSrc=function(){if(_hostSrc&&_ideSrcs.indexOf(_hostSrc)>=0)return [_hostSrc];if(_ideSrcs.indexOf('Devin Desktop')>=0)return ['Devin Desktop'];return _ideSrcs.length?[_ideSrcs[0]]:[];};
    if(!window._mcpSrc)window._mcpSrc=_defSrc();
    window._mcpSrc=window._mcpSrc.filter(function(s){return _ideSrcs.indexOf(s)>=0;});
    if(!window._mcpSrc.length&&_ideSrcs.length)window._mcpSrc=_defSrc();
    items.forEach(it=>{
      if(it.group&&it.group!==_curG){_curG=it.group;h+='<div class="st" style="font-size:11px;text-transform:none;margin:8px 0 4px">'+(_curG==='preset'?'🌟 内置预设 · 接测 / 一键装到所有账号':_curG==='ide'?'💻 本机 IDE 内部 MCP · 默认仅显示当前 IDE(其他平台点下方来源标签展开)':'🛒 官网 MCP 市场 · 通用四大模块见 DAO Bridge MCP')+'</div>';
        if(_curG==='ide'&&_ideSrcs.length){h+='<div id="mcpSrcBar" style="display:flex;flex-wrap:wrap;gap:4px;margin:0 0 6px;align-items:center"><span style="font-size:10px;color:var(--muted);margin-right:2px">来源:</span>'+_ideSrcs.map(function(s){var on=window._mcpSrc.indexOf(s)>=0;return '<span class="mcp-src-chip" data-src="'+esc(s)+'" onclick="mcpSrcToggle(this.getAttribute(&#39;data-src&#39;))" style="cursor:pointer;font-size:10px;padding:2px 9px;border-radius:10px;border:1px solid var(--border);background:'+(on?'#1a7f5a':'transparent')+';color:'+(on?'#fff':'var(--muted)')+'">'+(on?'● ':'○ ')+esc(s)+'</span>';}).join('')+'</div>';}
      }
      const m=it.mcp||{};const idx=window._mcp.length;window._mcp.push(m);
      if(it.group==='ide'||it.group==='preset')window._mcpIde.push(idx);
      const nm=it.name||'';const dt=it.detail||'';
      const st=it.connected?'<span style="color:var(--success)">● 已装</span>':'<span style="color:var(--muted)">○ 未装</span>';
      let btns='';
      if(m.installed){btns+='<button class="btn sm danger" onclick="mcpAct('+idx+',&#39;uninstall&#39;)">卸载</button>';}
      else{btns+='<button class="btn sm primary" onclick="mcpAct('+idx+',&#39;install&#39;)">装到本账号</button>';}
      btns+='<button class="btn sm" onclick="mcpProbe('+idx+')" title="接测: 实际探测该 MCP 连接是否连通">🔍接测</button>';
      btns+='<button class="btn sm" onclick="mcpAct('+idx+',&#39;all&#39;)" title="一键批量装到所有账号(反向注入)">装到所有账号</button>';
      btns+='<button class="btn sm" onclick="mcpAct('+idx+',&#39;profile&#39;)" title="加入反向注入档案 → 可批量注入所有账号">+档案</button>';
      btns+=lkBtn('mcps',String(nm).replace(/^★ /,''));
      var mkey=esc(String(nm+' '+dt).toLowerCase());
      var _ideCls=(it.group==='ide')?' mcp-ide-card':'';
      var _hide=(it.group==='ide'&&it.source&&window._mcpSrc.indexOf(it.source)<0)?' style="display:none"':'';
      h+='<div class="card mcp-card'+_ideCls+'" data-src="'+esc(it.source||'')+'" data-k="'+mkey+'"'+_hide+'><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(nm)+'</span><span class="v" style="font-size:11px">'+st+' <span id="mcp-probe-'+idx+'" style="margin-left:6px;color:var(--muted)"></span></span></div>'+(dt?'<div style="font-size:10px;color:var(--muted);margin-top:4px;word-break:break-all">'+esc(dt)+'</div>':'')+'<div class="br" style="margin-top:4px">'+btns+'</div></div>';
    });
    // 本机 IDE MCP 默认自动接测 (用户「初始化接测」) — 市场项按需点接测
    setTimeout(function(){try{(window._mcpIde||[]).forEach(function(i){mcpProbe(i)})}catch(e){}},150);
  }else if(tab==='usage'||tab==='org'||tab==='automations'){
    items.forEach(it=>{
      const nm=it.name||it.title||'';const dt=it.detail||'';
      const st=it.connected!==undefined?(it.connected?'<span style="color:var(--success)">● on</span>':'<span style="color:var(--muted)">○ off</span>'):'';
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(nm)+'</span><span class="v" style="font-size:11px">'+st+'</span></div>'+(dt?'<div style="font-size:10px;color:var(--muted);margin-top:4px;word-break:break-all">'+esc(dt)+'</div>':'')+'</div>';
    });
  }
  v.innerHTML=h;
}
function rSD(d){
  if(!d.ok){toast('Session detail failed',false);return}
  const s=d.session||{};const msgs=d.messages||[];
  const v=document.getElementById('v-sessions');if(!v)return;
  const sid=s.devin_id||s.id||'';
  let h='<div style="margin-bottom:8px"><button class="btn sm ghost" onclick="cmd(&#39;loadTabData&#39;,{tab:&#39;sessions&#39;})">← Back</button></div>';
  h+='<div class="card"><div class="cr"><span class="l">Title</span><span class="v">'+esc(s.title||'')+'</span></div><div class="cr"><span class="l">Status</span><span class="v">'+esc(s.status||'')+'</span></div><div class="cr"><span class="l">ID</span><span class="v" style="font-size:10px">'+esc(sid)+'</span></div></div>';
  h+='<div class="br" style="margin:8px 0"><button class="btn sm primary" onclick="cmd(&#39;exportSession&#39;,{sessionId:&#39;'+esc(sid)+'&#39;,kind:&#39;conversation&#39;})">📥 提取对话</button><button class="btn sm" onclick="cmd(&#39;exportSession&#39;,{sessionId:&#39;'+esc(sid)+'&#39;,kind:&#39;worklog&#39;})">📋 完整工作日志</button></div>';
  msgs.forEach(m=>{
    const role=m.role||m.type||'';const content=m.content||m.text||m.message||'';
    const isUser=role==='user'||role==='human';
    h+='<div class="card" style="border-left:3px solid '+(isUser?'var(--accent)':'var(--success)')+'"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">'+(isUser?'👤 User':'🤖 Devin')+'</div><div style="font-size:12px;white-space:pre-wrap;max-height:200px;overflow-y:auto">'+esc(typeof content==='string'?content:JSON.stringify(content,null,2))+'</div></div>';
  });
  v.innerHTML=h;
}
// 自动注入自循环配置面板 — 帛书·「善建者不拔·善抱者不脱」
// 初始配置一次, 账号随 IDE 切换, 系统据此 profile 自动注入新账号 + 清理旧账号
function ipSave(){cmd('setInjectProfile',{enabled:S.injectProfile.enabled,autoCleanup:S.injectProfile.autoCleanup,secrets:S.injectProfile.secrets,knowledge:S.injectProfile.knowledge,playbooks:S.injectProfile.playbooks,mcps:S.injectProfile.mcps,automations:S.injectProfile.automations,messageLimit:S.injectProfile.messageLimit,messageLimitAuto:S.injectProfile.messageLimitAuto,messageLimitOffset:S.injectProfile.messageLimitOffset})}
function ipToggle(field){S.injectProfile[field]=!S.injectProfile[field];ipSave();rInject()}
function ipRemove(kind,idx){S.injectProfile[kind].splice(idx,1);ipSave();rInject()}
function ipAddSecret(){sm('添加 Secret','<input id="m1" placeholder="名称 KEY" style="width:100%;margin:4px 0"><input id="m2" placeholder="值 value" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim(),val=document.getElementById('m2').value;if(!n)return false;S.injectProfile.secrets.push({name:n,value:val});ipSave();rInject()})}
function ipAddKnowledge(){sm('添加 Knowledge','<input id="m1" placeholder="名称" style="width:100%;margin:4px 0"><textarea id="m2" placeholder="正文 body" style="width:100%;height:80px;margin:4px 0"></textarea><input id="m3" placeholder="触发 trigger (默认 Always)" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.knowledge.push({name:n,body:document.getElementById('m2').value,trigger:document.getElementById('m3').value.trim()||'Always'});ipSave();rInject()})}
function ipAddPlaybook(){sm('添加 Playbook','<input id="m1" placeholder="标题 title" style="width:100%;margin:4px 0"><textarea id="m2" placeholder="正文 body" style="width:100%;height:80px;margin:4px 0"></textarea>',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.playbooks.push({title:n,body:document.getElementById('m2').value});ipSave();rInject()})}
function ipAddMcp(){sm('钉住 MCP (切号自动注入)','<input id="m1" placeholder="名称 name (如 GitHub MCP)" style="width:100%;margin:4px 0"><select id="m2" style="width:100%;margin:4px 0"><option value="HTTP">HTTP / SSE (远程 URL)</option><option value="STDIO">STDIO (command/args)</option></select><input id="m3" placeholder="URL (HTTP) 或 command (STDIO, 如 npx)" style="width:100%;margin:4px 0"><input id="m4" placeholder="args 空格分隔 (STDIO) / Authorization 头值 (HTTP)" style="width:100%;margin:4px 0"><input id="m5" placeholder="简介 short_description (可选)" style="width:100%;margin:4px 0"><p style="font-size:10px;color:var(--muted);margin:4px 0">提示: 点下方预设可一键填 GitHub MCP</p><button class="btn sm" onclick="ipMcpPreset(&#39;github&#39;)">GitHub MCP 预设</button>',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;const tr=document.getElementById('m2').value;const f3=document.getElementById('m3').value.trim();const f4=document.getElementById('m4').value.trim();const sd=document.getElementById('m5').value.trim();const m={name:n,transport:tr,short_description:sd};if(tr==='STDIO'){m.command=f3;m.args=f4?f4.split(' ').filter(Boolean):[];m.env_variables=[]}else{m.url=f3;if(f4)m.headers={Authorization:f4}}S.injectProfile.mcps.push(m);ipSave();rInject()})}
function ipMcpPreset(kind){if(kind==='github'){const a=document.getElementById('m1'),b=document.getElementById('m2'),c=document.getElementById('m3'),d=document.getElementById('m5');if(a)a.value='GitHub MCP';if(b)b.value='HTTP';if(c)c.value='https://api.githubcopilot.com/mcp/';if(d)d.value='GitHub official remote MCP'}}
function ipAddAutomation(){sm('钉住 Automation (切号自动注入)','<input id="m1" placeholder="名称 name" style="width:100%;margin:4px 0"><textarea id="m2" placeholder="会话提示 prompt (webhook 触发 → start_session)" style="width:100%;height:80px;margin:4px 0"></textarea><p style="font-size:10px;color:var(--muted);margin:4px 0">默认: webhook:incoming 触发 + start_session(prompt) 动作。需高级 triggers/actions 可手编 dao-inject-profile.json。</p>',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.automations.push({name:n,prompt:document.getElementById('m2').value,enabled:false});ipSave();rInject()})}
function ipEditSecret(i){const it=(S.injectProfile.secrets||[])[i];if(!it)return;sm('修改 Secret','<input id="m1" value="'+esc(it.name||'')+'" placeholder="名称 KEY" style="width:100%;margin:4px 0"><input id="m2" value="'+esc(it.value||'')+'" placeholder="值 value" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.secrets[i]={name:n,value:document.getElementById('m2').value};ipSave();rInject()})}
function ipEditKnowledge(i){const it=(S.injectProfile.knowledge||[])[i];if(!it)return;var _pv=it._preview||'';var _shown=_pv||(it.body||'');var _note=_pv?'<p style="font-size:10px;color:var(--success);line-height:1.5;margin:2px 0 4px">⟳ 实时完整正文预览(含当前隧道 URL/端口)·本地以占位哨兵存储省体积·推送云端时按当前隧道实时展开。不改动即保持哨兵; 若手改则按你的内容覆盖。</p>':'';sm('✂ 修改 Knowledge','<label style="font-size:11px;color:var(--muted)">名称</label><input id="m1" value="'+esc(it.name||'')+'" style="width:100%;margin:4px 0"><label style="font-size:11px;color:var(--muted)">正文 body (Markdown)</label>'+_note+'<textarea id="m2" style="width:100%;height:200px;margin:4px 0;font-family:monospace;white-space:pre">'+esc(_shown)+'</textarea><label style="font-size:11px;color:var(--muted)">触发 trigger</label><input id="m3" value="'+esc(it.trigger||'')+'" placeholder="默认 Always" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;var nb=document.getElementById('m2').value;var body=(_pv&&nb===_pv)?(it.body||''):nb;S.injectProfile.knowledge[i]={name:n,body:body,trigger:document.getElementById('m3').value.trim()||'Always'};ipSave();rInject()})}
function ipEditPlaybook(i){const it=(S.injectProfile.playbooks||[])[i];if(!it)return;sm('✂ 修改 Playbook','<label style="font-size:11px;color:var(--muted)">标题 title</label><input id="m1" value="'+esc(it.title||'')+'" style="width:100%;margin:4px 0"><label style="font-size:11px;color:var(--muted)">正文 body</label><textarea id="m2" style="width:100%;height:200px;margin:4px 0;font-family:monospace;white-space:pre">'+esc(it.body||'')+'</textarea>',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.playbooks[i]={title:n,body:document.getElementById('m2').value};ipSave();rInject()})}
function ipEditAutomation(i){const it=(S.injectProfile.automations||[])[i];if(!it)return;sm('✂ 修改 Automation','<input id="m1" value="'+esc(it.name||'')+'" placeholder="名称 name" style="width:100%;margin:4px 0"><textarea id="m2" placeholder="会话提示 prompt" style="width:100%;height:120px;margin:4px 0">'+esc(it.prompt||'')+'</textarea>',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.automations[i]={name:n,prompt:document.getElementById('m2').value,enabled:!!it.enabled};ipSave();rInject()})}
function ipEditMcp(i){const it=(S.injectProfile.mcps||[])[i];if(!it)return;const isStdio=(it.transport==='STDIO');sm('✂ 修改 MCP','<input id="m1" value="'+esc(it.name||'')+'" placeholder="名称 name" style="width:100%;margin:4px 0"><select id="m2" style="width:100%;margin:4px 0"><option value="HTTP"'+(isStdio?'':' selected')+'>HTTP / SSE</option><option value="STDIO"'+(isStdio?' selected':'')+'>STDIO</option></select><input id="m3" value="'+esc(isStdio?(it.command||''):(it.url||''))+'" placeholder="URL 或 command" style="width:100%;margin:4px 0"><input id="m4" value="'+esc(isStdio?((it.args||[]).join(' ')):((it.headers&&it.headers.Authorization)||''))+'" placeholder="args / Authorization" style="width:100%;margin:4px 0"><input id="m5" value="'+esc(it.short_description||'')+'" placeholder="简介" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;const tr=document.getElementById('m2').value;const f3=document.getElementById('m3').value.trim();const f4=document.getElementById('m4').value.trim();const sd=document.getElementById('m5').value.trim();const m={name:n,transport:tr,short_description:sd};if(tr==='STDIO'){m.command=f3;m.args=f4?f4.split(' ').filter(Boolean):[];m.env_variables=[]}else{m.url=f3;if(f4)m.headers={Authorization:f4}}S.injectProfile.mcps[i]=m;ipSave();rInject()})}
function ipSetLimit(){const cur=(S.injectProfile.messageLimit==null?'':S.injectProfile.messageLimit);const au=!!S.injectProfile.messageLimitAuto;const off=(S.injectProfile.messageLimitOffset==null?3:S.injectProfile.messageLimitOffset);sm('设定单条额度上限 (max_credits)','<label style="display:flex;align-items:center;gap:8px;margin:6px 0;font-size:12px"><input type="checkbox" id="ma" '+(au?'checked':'')+'> 自动跟随剩余额度 (cap = 剩余 − N · 各号注入不同数)</label><label style="font-size:11px;color:var(--muted)">N · 留出余量 (默认 3)</label><input id="mo" type="number" value="'+off+'" style="width:100%;margin:4px 0"><label style="font-size:11px;color:var(--muted)">固定值 max_credits (仅当不勾自动 · 留空=不管理)</label><input id="m1" type="number" placeholder="如 30" value="'+cur+'" style="width:100%;margin:4px 0">',function(){const auto=document.getElementById('ma').checked;const offv=document.getElementById('mo').value.trim();const raw=document.getElementById('m1').value.trim();S.injectProfile.messageLimitAuto=auto;S.injectProfile.messageLimitOffset=(offv===''?3:Number(offv));S.injectProfile.messageLimit=(raw===''?null:Number(raw));ipSave();rInject()})}
// v4.10.0 · 反向注入板块 — 实时密钥/安全显示(对齐主页 ov-secrets, 解决「只有主页有security」问题)
function rInjectLiveSecrets(){
  var v=document.getElementById('inj-secrets');if(!v)return;
  var items=S.data.secrets||[];
  if(!items.length){v.innerHTML='<p style="font-size:11px;color:var(--muted);margin:4px 0 8px">当前账号无密钥 · 注入后显示</p>';return;}
  var h='';items.forEach(function(c){
    var nm=c.name||c.key||'';var val=c.value?'••••••••':'(空值)';
    var lockBtn=lkBtn('secrets',nm);
    h+='<div class="cr"><span class="l" style="font-size:12px">'+esc(nm)+'</span><span class="v" style="font-size:10px;color:var(--muted)">'+val+' '+lockBtn+'<button class="btn sm danger" onclick="cmd(&#39;devinDeleteSecret&#39;,{name:&#39;'+esc(nm)+'&#39;})">删</button></span></div>';
  });
  v.innerHTML='<div class="card">'+h+'</div>';
}
function rInject(){
  const v=document.getElementById('v-inject');if(!v)return;
  const p=S.injectProfile||{enabled:false,autoCleanup:true,secrets:[],knowledge:[],playbooks:[],mcps:[],automations:[],messageLimit:null};
  if(!Array.isArray(p.automations))p.automations=[];
  const tgl=(on,fn)=>'<span onclick="'+fn+'" style="cursor:pointer;display:inline-block;width:40px;height:20px;border-radius:10px;background:'+(on?'var(--success)':'var(--muted)')+';position:relative;vertical-align:middle"><span style="position:absolute;top:2px;left:'+(on?'22px':'2px')+';width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s"></span></span>';
  let h='';
  try{var ist=S.injectStatus||{};var ta=ist.tunnelAlive;var tla=ist.tunnelLastAlive;var tlStr=tla?new Date(tla).toLocaleTimeString():'—';var upH=ist.uptime?Math.floor(ist.uptime/3600)+'h'+Math.floor((ist.uptime%3600)/60)+'m':'—';var inj=S.inject||{};var kC=(inj.knowledge||0);var pC=(inj.playbook||0);var sC=(inj.secret||0);var gC=(inj.git||0);var injT=inj.timestamp?new Date(inj.timestamp).toLocaleTimeString():'—';h+='<div class="card" style="margin-bottom:12px;border-left:3px solid '+(ta?'var(--success)':'var(--danger,#e55)')+'"><div class="cr"><span class="l">隧道状态</span><span class="v" style="color:'+(ta?'var(--success)':'var(--danger,#e55)')+'">●'+(ta?' 在线':' 离线')+'</span></div>'+(ist.tunnelUrl?'<div class="cr"><span class="l">URL</span><span class="v" style="font-size:10px;word-break:break-all">'+esc(ist.tunnelUrl)+'</span></div>':'')+'<div class="cr"><span class="l">本地端口</span><span class="v">:'+(ist.localPort||9920)+'</span></div><div class="cr"><span class="l">探活失败</span><span class="v">'+(ist.tunnelFails||0)+'</span></div><div class="cr"><span class="l">上次探活</span><span class="v">'+tlStr+'</span></div><div class="cr"><span class="l">上次注入</span><span class="v">'+injT+'</span></div><div class="cr"><span class="l">注入内容</span><span class="v">K:'+kC+' P:'+pC+' S:'+sC+' G:'+gC+'</span></div><div class="cr"><span class="l">运行时长</span><span class="v">'+upH+'</span></div><div style="padding:6px 0"><button class="btn sm primary" onclick="V.postMessage({command:&#39;injectDiagnose&#39;})" style="width:100%">🔧 一键诊断修复</button></div></div>';}catch(e){h+='';}
  h+='<div class="st">反向注入 · 通用自动注入 · 无为而无不为</div>';
  h+='<p style="font-size:11px;color:var(--muted);line-height:1.6;margin:4px 0 10px">通用模块：配置一次，此后账号随 IDE 登录自动切换时，系统按此清单<b>反向注入</b>到每个新账号，并(默认)清理旧账号的同名注入。默认道藏载荷：道法自然准则 · 内网穿透MD · 道德经/阴符经/道法自然 三剧本 · MCP 服务器同步。</p>';
  h+='<div class="card"><div class="cr"><span class="l">启用自动注入</span><span class="v">'+tgl(p.enabled,'ipToggle(&#39;enabled&#39;)')+'</span></div><div class="cr"><span class="l">切账号时清理旧账号</span><span class="v">'+tgl(p.autoCleanup,'ipToggle(&#39;autoCleanup&#39;)')+'</span></div>'+(p.lastInjectedOrg?'<div class="cr"><span class="l">上次注入 org</span><span class="v" style="font-size:10px">'+esc(p.lastInjectedOrg)+'</span></div>':'')+'</div>';
  const listSec=(title,kind,items,labelFn,addFn,editFn)=>{let s='<div class="st">'+title+' ('+items.length+')<button class="btn sm primary" style="float:right" onclick="'+addFn+'">+ 添加</button></div>';if(items.length){s+='<div class="card">';items.forEach((it,i)=>{s+='<div class="cr"><span class="l" style="font-size:12px">'+esc(labelFn(it))+'</span><span class="v">'+(editFn?'<button class="btn sm" title="查看 / 修改" onclick="'+editFn+'('+i+')">✏ 改</button> ':'')+'<button class="btn sm danger" onclick="ipRemove(&#39;'+kind+'&#39;,'+i+')">删</button></span></div>'});s+='</div>'}else{s+='<p style="font-size:11px;color:var(--muted);margin:4px 0 8px">（空）</p>'}return s};
  h+=listSec('🔑 Secrets','secrets',p.secrets,it=>it.name,'ipAddSecret()','ipEditSecret');
  h+=listSec('📚 Knowledge','knowledge',p.knowledge,it=>{var n=(it._preview||it.body||'').length;return it.name+(n?(' · '+n+' 字'):'')},'ipAddKnowledge()','ipEditKnowledge');
  h+=listSec('📋 Playbooks','playbooks',p.playbooks,it=>it.title,'ipAddPlaybook()','ipEditPlaybook');
  h+=listSec('🔌 MCP (钉住)','mcps',p.mcps||[],it=>it.name+' · '+(it.transport||'STDIO'),'ipAddMcp()','ipEditMcp');
  h+=listSec('⚙️ Automations (钉住)','automations',p.automations||[],it=>it.name+(it.prompt?(' · '+String(it.prompt).slice(0,24)):''),'ipAddAutomation()','ipEditAutomation');
  h+='<div class="st">⚖️ 单条额度上限<button class="btn sm primary" style="float:right" onclick="ipSetLimit()">设定</button></div>';
  h+='<div class="card"><div class="cr"><span class="l" style="font-size:12px">期望 max_credits</span><span class="v">'+(p.messageLimitAuto?('<span style="color:var(--success)">自动 · 剩余−'+((p.messageLimitOffset==null)?3:esc(String(p.messageLimitOffset)))+'</span>'):((p.messageLimit==null)?'<span style="color:var(--muted)">不管理</span>':esc(String(p.messageLimit))))+'</span></div></div>';
  h+='<div class="br" style="margin-top:10px"><button class="btn" onclick="cmd(&#39;importCurrentToInjectProfile&#39;)">⬇️ 导入当前账号现有项</button>'+(p.enabled?'<button class="btn primary" onclick="cmd(&#39;injectCurrentNow&#39;)" title="单账号手动注入: 即便此账号曾被归零清理/出库, 也强制重注并解除自动注入抑制">▶️ 立即应用到当前账号</button><button class="btn" onclick="cmd(&#39;applyInjectProfileToAll&#39;)" title="批量自动注入: 自动跳过已被 RT Flow 归零清理/出库的账号">👥 注入到所有账号</button>':'')+'</div>';
  // v4.10.0 · 当前账号实时密钥显示(Security) — 解决「反向注入模块没有security」
  h+='<div class="st" style="margin-top:16px">🔐 当前账号实时密钥 (Security)<button class="btn sm" style="float:right" onclick="cmd(&#39;loadTabData&#39;,{tab:&#39;secrets&#39;})">⟳ 刷新</button></div>';
  h+='<div id="inj-secrets"><p style="font-size:11px;color:var(--muted);margin:4px 0 8px">加载中…</p></div>';
  v.innerHTML=h;
  rInjectLiveSecrets();
}
usb();${_solo ? `try{sw('${_solo}')}catch(e){rc()}` : 'rc()'};
</script>
</body></html>`;
}

// v3.17.0 · 切号面板回归本源: 全功能面板第2 Tab 用 iframe 内嵌「真」WAM 切号面板(rtflow buildHtml)。
//   引擎一切 toast/广播/整页重渲 经 setHostPost 回调中继进 iframe → 与独立切号面板像素级一致·零数据丢失。
//   病灶(3.15.0): 第2 Tab 另起炉灶重做精简版 rSwitchData → 丢配额条/Devin Cloud/水过无痕/对话追踪等全部核心块。
function registerWamHost() {
    try {
        const int = _rtflowModule && _rtflowModule._internals;
        if (int && typeof int.setHostPost === 'function') {
            int.setHostPost((m: any) => {
                postMiddle({ type: 'wamHost', msg: m });
            });
        }
    } catch { /* 守柔 */ }
}
function unregisterWamHost() {
    try {
        const int = _rtflowModule && _rtflowModule._internals;
        if (int && typeof int.setHostPost === 'function') int.setHostPost(null);
    } catch { /* 守柔 */ }
}

function showDaoCloudMiddlePanel(context: vscode.ExtensionContext) {
    if (daoCloudMiddlePanel) {
        daoCloudMiddlePanel.reveal(vscode.ViewColumn.Beside);
        daoCloudMiddlePanelVisible = true;
        refreshDaoCloudMiddlePanel();
        updateStatusBar();
        return;
    }
    const st = getPanelState();
    daoCloudMiddlePanel = vscode.window.createWebviewPanel(
        'dao.cloudMiddlePanel',
        '🤖 Devin Cloud',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    daoCloudMiddlePanel.webview.html = getDaoCloudMiddlePanelHtml(st);
    daoCloudMiddlePanelVisible = true;
    registerWamHost(); // v3.17.0 · 第2 Tab iframe = 真切号面板宿主
    daoCloudMiddlePanel.webview.onDidReceiveMessage(async (msg) => {
        await handleMiddlePanelMessage(msg, context);
    }, undefined, context.subscriptions);
    daoCloudMiddlePanel.onDidDispose(() => {
        unregisterWamHost(); // v3.17.0
        daoCloudMiddlePanel = null;
        daoCloudMiddlePanelVisible = false;
        updateStatusBar();
    });
    updateStatusBar();
    // Auto-load data after panel is ready
    setTimeout(() => refreshDaoCloudMiddlePanel(), 300);
}

function toggleDaoCloudMiddlePanel(context: vscode.ExtensionContext) {
    if (daoCloudMiddlePanelVisible && daoCloudMiddlePanel) {
        daoCloudMiddlePanel.dispose();
    } else {
        showDaoCloudMiddlePanel(context);
    }
}

// ⑤ 适配所有 VS Code — 探测宿主 IDE 能力: Devin Cloud 全功能处处可用;
// Cascade/Windsurf 专属(对话追踪·自动备份)仅在能读到 Windsurf 凭证缓存时可用, 否则优雅降级。
interface HostCaps { appName: string; isCascade: boolean; hasConvTracking: boolean; }
function detectHostCapabilities(): HostCaps {
    let appName = '';
    try { appName = vscode.env.appName || ''; } catch { /* 守柔 */ }
    let hasConvTracking = false;
    try { hasConvTracking = !!readWindsurfCredentials(); } catch { hasConvTracking = false; }
    const lname = appName.toLowerCase();
    const isCascade = hasConvTracking || lname.includes('windsurf') || lname.includes('cascade') || lname.includes('devin');
    return { appName: appName || 'VS Code', isCascade, hasConvTracking };
}
function getPanelState() {
    return {
        loggedIn: !!(ws.devinAuth1 || ws.devinApiKey),
        email: ws.devinEmail || '',
        orgName: ws.devinOrgName || ws.devinOrgSlug || '',
        orgId: ws.devinOrgId || '',
        hasWindsurfCreds: (() => { try { return !!readWindsurfCredentials(); } catch { return false; } })(),
        apiKeyType: ws.devinApiKey ? (ws.devinApiKey.startsWith('cog_') ? 'cog' : ws.devinApiKey.startsWith('devin-session-token$') ? 'session' : ws.devinApiKey.startsWith('sk-') ? 'sk-ws' : 'token') : '',
        tokenType: devinTokenType(),
        canUseApi: devinCanUseApi(),
        port: ws.port,
        relay: ws.relayConnected,
        relayUrl: ws.publicUrl || '',
        hostname: os.hostname(),
        injecting: ws.devinInjecting,
        bridge: readBridgeConn(),
        hostCaps: detectHostCapabilities(),
    };
}

// 道法自然 · 切号防闪 — 切号瞬间 auth1 短暂为空时, 在宽限窗口内沿用上一就绪态 (标 switching),
// 杜绝面板在切号过程闪现「未连接」登录页 (此页本不该在切号时出现)。真正登出(宽限外)仍如实显示。
let _daoAuthSnapshot: any = null;
let _daoAuthSnapshotAt = 0;
const DAO_AUTH_GRACE_MS = 12000;
function daoMiddleAuthPayload(): any {
    const liveLoggedIn = !!(ws.devinAuth1 || ws.devinApiKey);
    const live = {
        loggedIn: liveLoggedIn,
        email: ws.devinEmail || '',
        orgName: ws.devinOrgName || ws.devinOrgSlug || '',
        orgId: ws.devinOrgId || '',
        apiKeyType: ws.devinApiKey ? (ws.devinApiKey.startsWith('cog_') ? 'cog' : ws.devinApiKey.startsWith('devin-session-token$') ? 'session' : ws.devinApiKey.startsWith('sk-') ? 'sk-ws' : 'token') : '',
        tokenType: devinTokenType(),
        canUseApi: devinCanUseApi(),
        hasWindsurfCreds: (() => { try { return !!readWindsurfCredentials(); } catch { return false; } })(),
        quota: ws.devinQuota,
        injecting: ws.devinInjecting,
    };
    if (liveLoggedIn) { _daoAuthSnapshot = { ...live }; _daoAuthSnapshotAt = Date.now(); return live; }
    if (_daoAuthSnapshot && (Date.now() - _daoAuthSnapshotAt) < DAO_AUTH_GRACE_MS) {
        return { ..._daoAuthSnapshot, switching: true };
    }
    return live;
}

function refreshDaoCloudMiddlePanel() {
    if (!daoCloudMiddlePanel && !_middlePostTarget) return;
    const data: any = { type: 'init' };
    data.auth = daoMiddleAuthPayload();
    data.server = {
        port: ws.port,
        relay: ws.relayConnected,
        relayUrl: ws.publicUrl || '',
        hostname: os.hostname(),
    };
    data.bridge = bridgeGetState();
    try { Object.assign(data.bridge, bridgeCfState()); } catch { /* 守柔 */ }
    try { data.bridge.relay = ws.relayConnected; if (ws.publicUrl) data.bridge.relayUrl = ws.publicUrl; data.bridge.agentCount = ws.relayConnected ? 1 : 0; data.bridge.proxy = bridgeDetectProxy(); } catch { /* 守柔 */ }
    data.hostCaps = detectHostCapabilities();
    // Inject state
    try {
        const s = JSON.parse(fs.readFileSync(ws.injectStateFile, 'utf8'));
        data.inject = { secret: s.secret, knowledge: s.knowledge, playbook: s.playbook, git: s.git, timestamp: s.timestamp };
    } catch { data.inject = null; }
    // 反向注入实况状态(状态面板用) — 守柔: 绝不因此阻断 postMiddle
    try {
        data.injectStatus = {
            tunnelUrl: bridgeUrl || '',
            tunnelAlive: _bridgeLastAliveMs > 0 && (Date.now() - _bridgeLastAliveMs) < 90000,
            tunnelLastAlive: _bridgeLastAliveMs || 0,
            tunnelFails: _bridgeLivenessFail,
            lastInjectedUrl: _lastInjectedBridgeUrl || '',
            localPort: ws.port || DEFAULT_PORT,
            uptime: process.uptime(),
        };
    } catch { data.injectStatus = {}; }
    postMiddle(data);
}

async function handleMiddlePanelMessage(msg: any, context: vscode.ExtensionContext) {
    const reply = (d: any) => postMiddle(d);
    const refreshReply = (d: any) => { refreshDaoCloudMiddlePanel(); reply(d); };
    // Auth gate — allow these commands without login (登录/取证类与无凭证只读命令不得被拦, 否则空态成死码)
    const noAuthNeeded = ['devinLogin', 'devinWindsurfAutoLogin', 'devinAutoAcquire', 'devinManualLogin', 'refresh', 'startServer', 'stopServer', 'regenerateToken', 'openBrowser', 'syncBrowser', 'openDevinPage', 'openBlueprintDetail', 'loadBlueprints', 'copy', 'copyBridgeUrl', 'copyBridgeToken', 'copyBridgeInfo', 'bridgeRefreshToken', 'openBridgeMd', 'copyBridgeShell', 'bridgeStart', 'bridgeStartNamed', 'bridgeStop', 'bridgeRestart', 'bridgeReset', 'bridgeExportCloudMd', 'bridgeExportLocalMd', 'bridgeCopyCloudMd', 'bridgeInjectKnowledge', 'openCf', 'bridgeCfLogin', 'bridgeCfBrowserLogin', 'bridgeLogout', 'bridgeHealth', 'bridgeExec', 'bridgeListAgents', 'copyBridgeJoin', 'getInjectProfile', 'setInjectProfile', 'loadSwitch', 'switchToAccount', 'routeAccount', 'openConvMultiBrowser', 'wamCmd', 'cleanupZeroQuota', 'cleanupImmediate', 'wamInit', 'wamRelay', 'loadBackups', 'readBackupConv', 'revealBackupDir', 'exportBackup', 'unlockBackupZip', 'mcpProbe', 'openRoutedPanel', 'compInfo', 'compRun', 'compTerminal', 'compOpenFile', 'compReveal', 'injectDiagnose'];
    if (!ws.devinAuth1 && !noAuthNeeded.includes(msg.command)) {
        reply({ type: 'error', msg: 'Not logged in' });
        return;
    }
    try {
        switch (msg.command) {
            case 'copyBridgeUrl': {
                // 无公网(relay=local)时回落本机地址, 保证有可复制内容(不报错 ✗)。
                const c = readBridgeConn();
                const url = (c && c.url) || ws.publicUrl || ('http://localhost:' + (ws.port || DEFAULT_PORT));
                await vscode.env.clipboard.writeText(url);
                reply({ type: 'actionResult', command: 'copyBridgeUrl', ok: !!url });
                break;
            }
            // 归一 · 复制「实时公网单页地址」(<url>/shell · 免 token) — 在任意电脑/手机浏览器打开即可操作整个六合一面板。
            case 'copyBridgeShell': {
                const c = readBridgeConn();
                const base = (c && c.url)
                    ? String(c.url).replace(/\/+$/, '')
                    : (ws.publicUrl ? String(ws.publicUrl).replace(/\/+$/, '') : ('http://localhost:' + (ws.port || DEFAULT_PORT)));
                const u = base + '/shell';
                await vscode.env.clipboard.writeText(u);
                reply({ type: 'actionResult', command: 'copyBridgeShell', ok: !!u });
                break;
            }
            // ── 操作电脑本体 (把整个软件当浏览器供 MCP/用户驱动本机) ──
            case 'compInfo': {
                let cwd = process.cwd();
                let folders: string[] = [];
                try { folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath); } catch (e) { /* 守柔 */ }
                if (folders.length) cwd = folders[0];
                reply({ type: 'compInfo', info: { host: os.hostname(), platform: process.platform, arch: process.arch, user: (os.userInfo().username || ''), cwd, folders } });
                break;
            }
            case 'compRun': {
                const command = String(msg.cmd || '').trim();
                if (!command) { reply({ type: 'compResult', ok: false, cmd: command, code: null, stdout: '', stderr: '空命令' }); break; }
                let cwd = process.cwd();
                try { const fl = vscode.workspace.workspaceFolders; if (fl && fl.length) cwd = fl[0].uri.fsPath; } catch (e) { /* 守柔 */ }
                await new Promise<void>((resolve) => {
                    childProcess.exec(command, { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
                        const code = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
                        reply({ type: 'compResult', ok: !err, cmd: command, code, stdout: String(stdout || '').slice(0, 200000), stderr: String(stderr || (err ? (err.message || '') : '')).slice(0, 200000) });
                        resolve();
                    });
                });
                break;
            }
            case 'compTerminal': {
                const text = String(msg.text || '');
                try {
                    let term = vscode.window.activeTerminal;
                    if (!term) term = vscode.window.createTerminal('Dao Cloud · 操作电脑');
                    term.show(true);
                    if (text) term.sendText(text, true);
                    reply({ type: 'actionResult', command: 'compTerminal', ok: true });
                } catch (e: any) { reply({ type: 'actionResult', command: 'compTerminal', ok: false }); }
                break;
            }
            case 'compOpenFile': {
                const p = String(msg.path || '').trim();
                let ok = false;
                try {
                    const st = fs.statSync(p);
                    if (st.isDirectory()) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p)); ok = true; }
                    else { const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p)); await vscode.window.showTextDocument(doc, { preview: false }); ok = true; }
                } catch (e: any) { ok = false; }
                reply({ type: 'actionResult', command: 'compOpenFile', ok });
                break;
            }
            case 'compReveal': {
                const p = String(msg.path || '').trim();
                let ok = false;
                try { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p)); ok = true; } catch (e: any) { ok = false; }
                reply({ type: 'actionResult', command: 'compReveal', ok });
                break;
            }
            // ── 切号模块 (全功能面板第2网页 · 内嵌真 WAM 切号面板 buildHtml) ──
            case 'wamInit': {
                // v3.17.0 · 回归本源: 把真切号面板整页 HTML 交给第2 Tab 的 iframe 渲染 (与独立面板像素级一致)
                registerWamHost();
                let html = '';
                try { const int = _rtflowModule && _rtflowModule._internals; if (int && typeof int.buildHtml === 'function') html = int.buildHtml(); } catch (e: any) { html = ''; }
                if (!html) { reply({ type: 'wamInitHtml', html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;color:#ccc;background:#1e1e1e;padding:24px"><p>⚠ RT Flow 切号引擎未就绪，请稍候重试或重载窗口。</p></body></html>' }); break; }
                reply({ type: 'wamInitHtml', html });
                break;
            }
            case 'wamRelay': {
                // v3.17.0 · iframe 内真切号面板的 vscode.postMessage → 中继进引擎 handleWebviewMessage
                try { const int = _rtflowModule && _rtflowModule._internals; if (int && typeof int.handleWebviewMessage === 'function') await int.handleWebviewMessage(msg.msg); } catch (e: any) { /* 守柔 */ }
                // v4.10.0 · PAT双流同步: 切号板块输入PAT(批量连/注密钥) → 自动同步到反向注入 profile.secrets(GITHUB_PAT)
                //   用户只需在一处输入PAT, 切号+注入两条流共用, 不替换已有条目(累加)
                try {
                    const relayMsg = msg.msg || {};
                    if ((relayMsg.type === 'gitConnectBatch' || relayMsg.type === 'gitInjectSecretBatch') && relayMsg.pat) {
                        const pat = String(relayMsg.pat).trim();
                        // GitHub PAT 双形态: 经典 ghp_ 与细粒度 github_pat_ (gh CLI/OAuth gho_/ghu_ 亦放行)。
                        //   旧式仅认 ghp_ → 细粒度 PAT 能连 Git 却被静默漏注 profile.secrets, 后续新号自动注入不带 GITHUB_PAT。
                        if (isGitHubPat(pat)) {
                            const profile = loadInjectProfile();
                            const existing = (profile.secrets || []).find((s: any) => s.name === 'GITHUB_PAT');
                            if (!existing) {
                                profile.secrets = profile.secrets || [];
                                profile.secrets.push({ name: 'GITHUB_PAT', value: pat });
                                saveInjectProfile(profile);
                            }
                            // 不替换已有: 用户已有GITHUB_PAT则保留, 避免覆盖
                        }
                    }
                } catch { /* 守柔 */ }
                break;
            }
            case 'loadSwitch': {
                const pool = loadAccountPool(true);
                const cur = (ws.devinEmail || '').trim().toLowerCase();
                const accounts = pool.map(a => ({ email: a.email, active: a.email === cur }));
                reply({ type: 'switchData', accounts, current: ws.devinEmail || '' });
                break;
            }
            case 'switchToAccount': {
                const email = String(msg.email || '').trim().toLowerCase();
                const acct = loadAccountPool().find(a => a.email === email);
                if (!acct) { vscode.window.showWarningMessage('账号池中无此账号: ' + email); reply({ type: 'actionResult', command: 'switchToAccount', ok: false }); break; }
                await setAccountSyncMode('manual');
                const r = await devinLogin(acct.email, acct.password);
                if (r.ok) { vscode.window.showInformationMessage('已切换到 ' + acct.email); await devinFullInject(); }
                else vscode.window.showErrorMessage('切换失败: ' + (r.error || ''));
                refreshReply({ type: 'actionResult', command: 'switchToAccount', ok: r.ok });
                break;
            }
            case 'routeAccount': {
                const email = String(msg.email || '').trim();
                await vscode.commands.executeCommand('dao.routeOfficialForAccount', { email, mode: 'ide' });
                reply({ type: 'actionResult', command: 'routeAccount', ok: true });
                break;
            }
            // 近期对话 · 多实例打开具体对话 (路由该账号官网 /sessions/<devinId> 到独立 webview 标签)
            case 'openConvMultiBrowser': {
                const email = String(msg.email || '').trim();
                const devinId = String(msg.devinId || '').trim();
                await vscode.commands.executeCommand('dao.routeConvForAccount', { email, devinId, mode: 'ide' });
                reply({ type: 'actionResult', command: 'openConvMultiBrowser', ok: true });
                break;
            }
            case 'wamCmd': {
                const c = String(msg.cmd || '');
                if (c.startsWith('wam.')) { try { await vscode.commands.executeCommand(c); } catch (e: any) { vscode.window.showErrorMessage('RT Flow: ' + (e?.message || c)); } }
                reply({ type: 'actionResult', command: 'wamCmd', ok: true });
                break;
            }
            case 'cleanupZeroQuota': {
                // 一气呵成: 全量备份 → 全量清理 → 移出账号库 (委托 RT Flow · 自带模态确认+完整性校验)
                try { await vscode.commands.executeCommand('wam.devinCleanupZeroQuota'); } catch (e: any) { vscode.window.showErrorMessage('归零清理: ' + (e?.message || e)); }
                refreshReply({ type: 'actionResult', command: 'cleanupZeroQuota', ok: true });
                break;
            }
            case 'cleanupImmediate': {
                // 立即清理(参手机版·无模态): 全部账号 先备份→归零→出库, 一气呵成
                try { await vscode.commands.executeCommand('wam.devinCleanupImmediate'); } catch (e: any) { vscode.window.showErrorMessage('立即清理: ' + (e?.message || e)); }
                refreshReply({ type: 'actionResult', command: 'cleanupImmediate', ok: true });
                break;
            }
            case 'openBridgeMd': {
                // v3.17.0 · 打开唯一云端 MD (先落盘最新内容再打开, 免陈旧/不存在)
                try {
                    const p = path.join(os.homedir(), '.dao', 'bridge', 'cloud-agent.md');
                    fs.mkdirSync(path.dirname(p), { recursive: true });
                    fs.writeFileSync(p, bridgeGenerateCloudMd(), 'utf8');
                    const doc = await vscode.workspace.openTextDocument(p);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                    reply({ type: 'actionResult', command: 'openBridgeMd', ok: true });
                } catch (e) { reply({ type: 'actionResult', command: 'openBridgeMd', ok: false }); }
                break;
            }
            case 'bridgeCopyCloudMd': {
                // v3.17.0 · 复制唯一云端 Agent MD 到剪贴板 (四大模块 + 内网穿透全量)
                const md = bridgeGenerateCloudMd();
                try { fs.mkdirSync(path.join(os.homedir(), '.dao', 'bridge'), { recursive: true }); fs.writeFileSync(path.join(os.homedir(), '.dao', 'bridge', 'cloud-agent.md'), md, 'utf8'); } catch { /* 守柔 */ }
                await vscode.env.clipboard.writeText(md);
                vscode.window.showInformationMessage('已复制云端 Agent MD (四大模块 + 内网穿透全量) 到剪贴板');
                reply({ type: 'actionResult', command: 'bridgeCopyCloudMd', ok: true });
                break;
            }
            case 'loadTabData': {
                // 帛书·「反者道之动也」— 认证策略根本修复
                // cog_ API Key → Devin API完全可用 → 加载真实数据
                // devin-session-token$ → 仅Codeium API → 需要创建cog_ key
                const tab = msg.tab as string;
                // 帛书·「天下之物生於有, 有生於無」— MCP tab 本机 IDE 扫描纯本地、无需任何鉴权,
                //   故不被官网 API 成败绑架: 始终先列「本机已配 MCP」(与 IDE 内一对一), 官网市场尽力而为。
                //   解此前缺陷: auth1 为 Windsurf session-token 时官网 403 → 整 tab 报错 → 本机 MCP 一个不显示。
                if (tab === 'mcp') { await daoReplyMcpTab(reply); break; }
                const canApi = devinCanUseApi();
                if (canApi) {
                    // ★ 有cog_ API Key — 尝试API调用加载真实数据
                    const orgLocks = loadManualLocks()[ws.devinOrgId] || { knowledge: [], playbooks: [], secrets: [], mcps: [] };
                    try {
                        let result: any = { ok: false };
                        if (tab === 'sessions') {
                            result = await devinListSessions(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.sessions || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败: ' + JSON.stringify(result).substring(0, 100) });
                        } else if (tab === 'knowledge') {
                            result = await devinListKnowledge(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.learnings || [], locks: orgLocks });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'playbooks') {
                            result = await devinListPlaybooks(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.playbooks || [], locks: orgLocks });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'secrets') {
                            result = await devinListSecrets(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.secrets || [], locks: orgLocks });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'integrations') {
                            result = await devinListIntegrations(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.connections || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'usage') {
                            result = await devinGetUsage(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.items || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'org') {
                            result = await devinListMembers(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.items || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'automations') {
                            result = await devinListAutomations(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.items || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'schedules') {
                            result = await devinListSchedules(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.items || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else {
                            reply({ type: 'tabData', tab, items: [], error: 'Unknown tab' });
                        }
                    } catch (e: any) {
                        reply({ type: 'tabData', tab, items: [], error: e.message || 'API error' });
                    }
                } else {
                    // ★ 没有cog_ API Key — 需要用户创建
                    reply({ type: 'tabData', tab, items: [], error: '需要 cog_ API Key', fallbackProxy: true });
                }
                break;
            }
            case 'loadSessionDetail': {
                // 帛书·「反者道之动也」— 有cog_ key时用API，否则fallback
                const sessionId = msg.sessionId as string;
                if (!sessionId) { reply({ type: 'sessionDetail', ok: false }); break; }
                if (devinCanUseApi()) {
                    const detail = await devinGetSessionDetail(ws.devinOrgId, sessionId, ws.devinAuth1);
                    const msgs = await devinGetSessionMessages(ws.devinOrgId, sessionId, ws.devinAuth1);
                    reply({ type: 'sessionDetail', ok: detail.ok, session: detail.session, messages: msgs.ok ? msgs.messages : [] });
                } else {
                    // 道法自然 · 零自动打开: 无 API 时不自动弹页, 回未就绪态 (用户可手动打开)。
                    reply({ type: 'sessionDetail', ok: false, session: { devin_id: sessionId }, messages: [] });
                }
                break;
            }
            // ═══ 问题② · 全功能面板 Session/备份板块 = rt-flow 备份成果路由 (绝利一源) ═══
            // 直接路由内联 rt-flow 的备份目录: 列全部账号 × 全部对话备份 + 备份状态,
            // 不依赖 cog_ key (纯本地文件) — 与左侧 rt-flow 账号池备份完全同源。
            case 'loadBackups': {
                try {
                    const dc = loadDevinCloud();
                    if (!dc || typeof dc.listBackups !== 'function') { reply({ type: 'backupsData', tree: { root: '', accounts: [] }, error: 'rt-flow 备份引擎不可用' }); break; }
                    const root = resolveBackupRoot();
                    const tree = dc.listBackups(root);
                    // 道法自然 · 同源: 读 rt-flow 对话追踪共享状态文件 (~/.wam/_dv_status.json),
                    //   据 devinId 把【实时对话状态】合并进备份树 → 近期对话卡片状态点与「对话追踪」面板同源。
                    try {
                        const statusFile = path.join(os.homedir(), '.wam', '_dv_status.json');
                        if (fs.existsSync(statusFile)) {
                            const j = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
                            const smap = new Map<string, { status: string; title: string; ts: number }>();
                            if (j && Array.isArray(j.agg)) {
                                for (const pair of j.agg) {
                                    const st = Array.isArray(pair) ? pair[1] : null;
                                    if (!st || !Array.isArray(st.items)) continue;
                                    for (const it of st.items) {
                                        const id = String((it && it.id) || '').replace(/^devin-/, '');
                                        if (id) smap.set(id, { status: String((it && it.cls) || ''), title: String((it && it.title) || ''), ts: (st.ts || j.ts || 0) });
                                    }
                                }
                            }
                            if (smap.size) {
                                for (const a of (tree.accounts || [])) {
                                    for (const c of (a.conversations || [])) {
                                        const id = String((c && c.devinId) || '').replace(/^devin-/, '');
                                        const m = id ? smap.get(id) : null;
                                        if (m) { c.status = m.status; c.liveTs = m.ts || c.mtime; if (!c.title && m.title) c.title = m.title; }
                                    }
                                }
                            }
                        }
                    } catch { /* 守柔: 状态文件缺失/损坏不影响备份树主功能 */ }
                    reply({ type: 'backupsData', tree });
                } catch (e: any) {
                    reply({ type: 'backupsData', tree: { root: '', accounts: [] }, error: (e && e.message) || String(e) });
                }
                break;
            }
            case 'loadBlueprints': {
                // 环境蓝图 · 只读 (列表 + 机器快照计数)
                if (!devinCanUseApi() || !ws.devinAuth1 || !ws.devinOrgId) { reply({ type: 'blueprintsData', items: [], error: '需要 cog_ API Key' }); break; }
                try {
                    const bl = await devinListBlueprints(ws.devinOrgId, ws.devinAuth1);
                    let snapCount = 0;
                    try { const sn = await devinListSnapshots(ws.devinOrgId, ws.devinAuth1); if (sn.ok) snapCount = (sn.items || []).length; } catch { /* 守柔 */ }
                    if (bl.ok) reply({ type: 'blueprintsData', items: bl.items || [], snapCount });
                    else reply({ type: 'blueprintsData', items: [], error: bl.error || 'API调用失败' });
                } catch (e: any) {
                    reply({ type: 'blueprintsData', items: [], error: (e && e.message) || String(e) });
                }
                break;
            }
            case 'openBlueprintDetail': {
                // 在 Devin Cloud 蓝图设置页打开 (蓝图 git-backed, 详情走官网更稳)
                try {
                    await vscode.commands.executeCommand('simpleBrowser.show', daoRoutedWebUrl('/settings/environments'));
                    reply({ type: 'actionResult', command: 'openBlueprintDetail', ok: true });
                } catch { reply({ type: 'actionResult', command: 'openBlueprintDetail', ok: false }); }
                break;
            }
            // 查看一条对话备份正文 (对话.html 自包含 · 跨 IDE 用系统默认浏览器打开)
            case 'openBackupConv': {
                try {
                    let p = msg.htmlPath || msg.path;
                    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, '对话.html');
                    if (!p || !fs.existsSync(p)) { reply({ type: 'error', msg: '未找到对话正文 (对话.html)' }); reply({ type: 'actionResult', command: 'openBackupConv', ok: false }); break; }
                    try { await vscode.commands.executeCommand('simpleBrowser.show', vscode.Uri.file(p).toString()); }
                    catch { await vscode.env.openExternal(vscode.Uri.file(p)); }
                    reply({ type: 'actionResult', command: 'openBackupConv', ok: true });
                } catch (e: any) { reply({ type: 'actionResult', command: 'openBackupConv', ok: false }); }
                break;
            }
            // 道法自然 · 内联读取一条对话备份正文 (文件夹式浏览) — 优先 对话.md, 否则 对话.html;
            //   支持目录型与 .zip 型备份 (zip 用内置最小解包器, 无三方依赖)。截断保护 400KB。
            case 'readBackupConv': {
                const ri = msg.i, rci = msg.ci;
                try {
                    const p: string = msg.path || '';
                    if (!p || !fs.existsSync(p)) { reply({ type: 'backupConv', i: ri, ci: rci, ok: false, error: '路径不存在' }); break; }
                    const MAXLEN = 400 * 1024;
                    let content = ''; let fmt = 'md';
                    const st = fs.statSync(p);
                    if (st.isDirectory()) {
                        const files = fs.readdirSync(p);
                        const md = files.find(f => /对话\.md$/i.test(f)) || files.find(f => /\.md$/i.test(f));
                        const html = files.find(f => /对话\.html$/i.test(f)) || files.find(f => /\.html$/i.test(f));
                        if (md) { content = fs.readFileSync(path.join(p, md), 'utf8'); fmt = 'md'; }
                        else if (html) { content = fs.readFileSync(path.join(p, html), 'utf8'); fmt = 'html'; }
                        else { reply({ type: 'backupConv', i: ri, ci: rci, ok: false, error: '该备份无 对话.md / 对话.html' }); break; }
                    } else if (/\.zip$/i.test(p)) {
                        const z = readZipTextEntry(p, [/对话\.md$/i, /\.md$/i, /对话\.html$/i, /\.html$/i]);
                        if (!z) { reply({ type: 'backupConv', i: ri, ci: rci, ok: false, error: 'ZIP 内无 对话.md / 对话.html' }); break; }
                        content = z.text; fmt = /\.md$/i.test(z.name) ? 'md' : 'html';
                    } else {
                        content = fs.readFileSync(p, 'utf8'); fmt = /\.html$/i.test(p) ? 'html' : 'md';
                    }
                    if (content.length > MAXLEN) content = content.slice(0, MAXLEN) + '\n\n…(正文较长已截断, 完整内容请用 📂 打开目录 / ⬇ 导出)';
                    reply({ type: 'backupConv', i: ri, ci: rci, ok: true, fmt, content });
                } catch (e: any) { reply({ type: 'backupConv', i: ri, ci: rci, ok: false, error: (e && e.message) || String(e) }); }
                break;
            }
            // 在系统文件管理器中显示备份目录 (账号目录 / 对话目录)
            case 'revealBackupDir': {
                try {
                    const p = msg.dir || msg.path;
                    if (p && fs.existsSync(p)) await vscode.env.openExternal(vscode.Uri.file(p));
                    reply({ type: 'actionResult', command: 'revealBackupDir', ok: !!(p && fs.existsSync(p)) });
                } catch (e: any) { reply({ type: 'actionResult', command: 'revealBackupDir', ok: false }); }
                break;
            }
            // 解锁(解压) ZIP 型对话备份 → 同名文件夹 (本地 inflate · 零依赖), 解压后打开文件夹。
            case 'unlockBackupZip': {
                try {
                    const dc = loadDevinCloud();
                    const zp = String(msg.path || '');
                    if (!dc || typeof dc.unlockBackup !== 'function' || !zp || !fs.existsSync(zp)) {
                        reply({ type: 'actionResult', command: 'unlockBackupZip', ok: false });
                        break;
                    }
                    const r = dc.unlockBackup(zp);
                    const ok = !!(r && r.ok);
                    if (ok && r.outDir) {
                        vscode.window.showInformationMessage('已解锁(解压) ' + (r.files || 0) + ' 个文件 → ' + r.outDir);
                        try { await vscode.env.openExternal(vscode.Uri.file(r.outDir)); } catch { /* 守柔 */ }
                    } else {
                        vscode.window.showWarningMessage('解锁失败: ' + ((r && r.error) || '未知'));
                    }
                    reply({ type: 'actionResult', command: 'unlockBackupZip', ok });
                    try { const root = resolveBackupRoot(); reply({ type: 'backupsData', tree: dc.listBackups(root) }); } catch { /* 守柔 */ }
                } catch (e: any) {
                    reply({ type: 'actionResult', command: 'unlockBackupZip', ok: false });
                }
                break;
            }
            // 问题③ · 下载到电脑: 把一条对话备份(或整个账号目录)拷贝到用户选定目录
            case 'exportBackup': {
                try {
                    const src = msg.path || msg.dir;
                    if (!src || !fs.existsSync(src)) { reply({ type: 'actionResult', command: 'exportBackup', ok: false }); break; }
                    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: '下载到此处', title: '选择备份下载位置' });
                    if (!picked || !picked.length) { reply({ type: 'actionResult', command: 'exportBackup', ok: false }); break; }
                    const destRoot = picked[0].fsPath;
                    const base = path.basename(src.replace(/[\\/]+$/, ''));
                    const dest = path.join(destRoot, base);
                    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '下载备份到 ' + destRoot + ' …' }, async () => {
                        fs.cpSync(src, dest, { recursive: true });
                    });
                    vscode.window.showInformationMessage('备份已下载: ' + dest);
                    reply({ type: 'actionResult', command: 'exportBackup', ok: true });
                } catch (e: any) { reply({ type: 'error', msg: '下载失败: ' + ((e && e.message) || e) }); reply({ type: 'actionResult', command: 'exportBackup', ok: false }); }
                break;
            }
            case 'exportSession': {
                // 本地对话提取 (移植 dao-devin-export): kind=conversation 纯对话 / worklog 完整日志
                const sessionId = msg.sessionId as string;
                const kind = (msg.kind === 'worklog' ? 'worklog' : 'conversation') as 'conversation' | 'worklog';
                if (!sessionId) { reply({ type: 'actionResult', command: 'exportSession', ok: false }); break; }
                vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '提取会话对话…' }, async () => {
                    const fp = await devinExportSession(sessionId, kind);
                    if (fp) {
                        try { const doc = await vscode.workspace.openTextDocument(fp); await vscode.window.showTextDocument(doc, { preview: false }); } catch { /* 守柔 */ }
                        vscode.window.showInformationMessage('对话已提取: ' + fp);
                    } else {
                        vscode.window.showErrorMessage('对话提取失败 (事件流/消息均不可用)');
                    }
                    refreshReply({ type: 'actionResult', command: 'exportSession', ok: !!fp });
                });
                break;
            }
            case 'getInjectProfile': {
                // 自动注入自循环配置: 返回当前 profile 给面板渲染
                const p = loadInjectProfile();
                // 帛书·「反者道之动也」: 本地存储以哨兵省体积, 但面板「查看」必须见到实时完整正文(含当前隧道 URL/端口),
                //   否则用户在编辑器里只看到 `__DAO_BRIDGE_*_MD__` 空壳, 误以为"全是空的、端口也没有"。
                //   仅附 `_preview`(展示用·实时生成), `body` 仍保持哨兵, 推送云端时再按当前隧道实时展开。
                const knowledgeView = (p.knowledge || []).map(k => {
                    try {
                        const exp = expandKbSentinel(k.name || '', k.body || '');
                        if (exp && exp !== (k.body || '')) return { ...k, _preview: exp };
                    } catch { /* 守柔 */ }
                    return k;
                });
                reply({ type: 'injectProfile', profile: { enabled: p.enabled, autoCleanup: p.autoCleanup, secrets: p.secrets, knowledge: knowledgeView, playbooks: p.playbooks, mcps: p.mcps, automations: p.automations, messageLimit: p.messageLimit, messageLimitAuto: p.messageLimitAuto, messageLimitOffset: p.messageLimitOffset, lastInjectedOrg: p.lastInjectedOrg } });
                break;
            }
            case 'setInjectProfile': {
                // 保存 profile (enabled/autoCleanup/items) — 守柔: 仅覆盖传入字段
                const cur = loadInjectProfile();
                const np: InjectProfile = {
                    enabled: typeof msg.enabled === 'boolean' ? msg.enabled : cur.enabled,
                    autoCleanup: typeof msg.autoCleanup === 'boolean' ? msg.autoCleanup : cur.autoCleanup,
                    secrets: Array.isArray(msg.secrets) ? msg.secrets : cur.secrets,
                    // 守柔: 剥离展示用 `_preview`(实时生成·不落盘), 仅存 {name, body(哨兵), trigger}, 杜绝把含旧隧道地址的快照冻结进档。
                    knowledge: Array.isArray(msg.knowledge) ? msg.knowledge.map((k: any) => ({ name: k.name, body: k.body, trigger: k.trigger })) : cur.knowledge,
                    playbooks: Array.isArray(msg.playbooks) ? msg.playbooks : cur.playbooks,
                    mcps: Array.isArray(msg.mcps) ? msg.mcps : cur.mcps,
                    automations: Array.isArray(msg.automations) ? msg.automations : cur.automations,
                    messageLimit: (typeof msg.messageLimit === 'number') ? msg.messageLimit : (msg.messageLimit === null ? null : cur.messageLimit),
                    messageLimitAuto: (typeof msg.messageLimitAuto === 'boolean') ? msg.messageLimitAuto : cur.messageLimitAuto,
                    messageLimitOffset: (typeof msg.messageLimitOffset === 'number') ? msg.messageLimitOffset : cur.messageLimitOffset,
                    lastInjectedOrg: cur.lastInjectedOrg,
                    daoSeeded: cur.daoSeeded,
                };
                saveInjectProfile(np);
                // enabled 且当前已登录 → 立即应用一次到当前 org (自循环起点)
                if (np.enabled && ws.devinOrgId && ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$')) {
                    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '应用自动注入配置…' }, async () => {
                        try { await runInjectProfileSelfLoop(); } catch { /* 守柔 */ }
                        sidebarCloudPanel?.refresh();
                    });
                }
                refreshReply({ type: 'actionResult', command: 'setInjectProfile', ok: true });
                break;
            }
            case 'injectCurrentNow': {
                // 用户主页 · 单账号手动注入 (force): 显式绕过「已清理/出库账号自动注入抑制」并记 reactivatedAt;
                //   即便该账号刚被 RT Flow 归零清理, 用户在主页主动点此仍可重注。
                if (!(ws.devinOrgId && ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$'))) {
                    vscode.window.showWarningMessage('当前未登录 Devin Cloud 账号, 无法单账号注入');
                    reply({ type: 'actionResult', command: 'injectCurrentNow', ok: false });
                    break;
                }
                const curp = loadInjectProfile();
                if (!curp.enabled) { curp.enabled = true; saveInjectProfile(curp); }
                vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '单账号注入 · 当前账号 (' + (ws.devinEmail || ws.devinOrgId) + ')…' }, async () => {
                    try { await runInjectProfileSelfLoop({ force: true }); } catch { /* 守柔 */ }
                    sidebarCloudPanel?.refresh();
                });
                refreshReply({ type: 'actionResult', command: 'injectCurrentNow', ok: true });
                break;
            }
            case 'importCurrentToInjectProfile': {
                // 把当前 org 现有 knowledge/playbooks 导入 profile (一次性配置, 守柔: secrets 仅导入名不导入值)
                if (!devinCanUseApi()) { reply({ type: 'actionResult', command: 'importCurrentToInjectProfile', ok: false }); break; }
                const cur = loadInjectProfile();
                try {
                    const kl = await devinListKnowledge(ws.devinOrgId, ws.devinAuth1);
                    if (kl.ok && kl.learnings) for (const k of kl.learnings) { const nm = k.name || ''; if (nm && !cur.knowledge.some(x => x.name === nm)) cur.knowledge.push({ name: nm, body: k.body || '', trigger: k.trigger_description || 'Always' }); }
                } catch { /* 守柔 */ }
                try {
                    const pl = await devinListPlaybooks(ws.devinOrgId, ws.devinAuth1);
                    if (pl.ok && pl.playbooks) for (const pb of pl.playbooks) { const ti = pb.title || ''; if (ti && !cur.playbooks.some(x => x.title === ti)) cur.playbooks.push({ title: ti, body: pb.body || '' }); }
                } catch { /* 守柔 */ }
                saveInjectProfile(cur);
                reply({ type: 'injectProfile', profile: cur });
                refreshReply({ type: 'actionResult', command: 'importCurrentToInjectProfile', ok: true });
                break;
            }
            case 'applyInjectProfileToAll': {
                // 多账号 · 把完整注入档案(K/P/S/MCP/Automations)反向注入到整个账号池的每个账号 org。
                // 优先走 devinBatchInject(本机账号池·含登录兜底·全覆盖固定道藏集+用户档案); 池为空再退回仅缓存 auth1 路径。
                if (daoBatchProgress && daoBatchProgress.running) {
                    vscode.window.showWarningMessage('批量注入已在进行中: ' + daoBatchProgress.done + '/' + daoBatchProgress.total);
                    reply({ type: 'actionResult', command: 'applyInjectProfileToAll', ok: false });
                    break;
                }
                vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '多账号反向注入(K/P/S/MCP)…' }, async () => {
                    const r = await daoBatchInjectAllAccounts();
                    vscode.window.showInformationMessage('多账号反向注入完成: ' + r.okCount + '/' + r.total + ' 账号');
                    sidebarCloudPanel?.refresh();
                    refreshReply({ type: 'actionResult', command: 'applyInjectProfileToAll', ok: r.ok });
                });
                break;
            }
            case 'devinLogin': {
                vscode.window.showInputBox({ prompt: 'Devin Cloud Email', placeHolder: 'user@example.com' }).then(email => {
                    if (!email) return;
                    vscode.window.showInputBox({ prompt: 'Devin Cloud Password', password: true }).then(async pw => {
                        if (!pw) return;
                        const r = await devinLogin(email, pw);
                        if (r.ok) { vscode.window.showInformationMessage('Devin login OK'); await devinFullInject(); sidebarCloudPanel?.refresh(); }
                        else vscode.window.showErrorMessage('Devin login failed: ' + (r.error || ''));
                        refreshReply({ type: 'actionResult', command: 'devinLogin', ok: r.ok });
                    });
                });
                break;
            }
            // 帛书·「为而弗恃」: cog_ API Key 全程底层自动获取(devinEnsureCogApiKey),
            // 面板永不出现手动输入/设置 — 旧 setCogApiKey 处理器已删。
            case 'devinWindsurfAutoLogin': {
                const ok = await devinAutoChain();
                if (ok) { vscode.window.showInformationMessage('Devin Cloud 自动登录成功'); await devinFullInject(); sidebarCloudPanel?.refresh(); }
                else vscode.window.showErrorMessage('自动登录失败');
                refreshReply({ type: 'actionResult', command: 'devinWindsurfAutoLogin', ok });
                break;
            }
            case 'devinAutoAcquire': {
                // 道法自然 · 底层自动获取凭证 — 重跑自动链 + 自动补全 cog_ key, 用户无需 API Key
                let ok = await devinAutoChain();
                if (ok && ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$')) {
                    try { await devinEnsureCogApiKey(ws.devinOrgId, ws.devinAuth1); } catch {}
                }
                if (ok) { vscode.window.showInformationMessage('Devin Cloud 凭证已自动获取'); await devinFullInject(); sidebarCloudPanel?.refresh(); }
                else vscode.window.showWarningMessage('未能自动获取凭证 — 账号池可能缺少当前 IDE 登录邮箱的密码, 可手动登录');
                refreshReply({ type: 'actionResult', command: 'devinAutoAcquire', ok });
                break;
            }
            case 'devinManualLogin': {
                // 保留用户操作空间 — 手动登录其他账户
                vscode.window.showInputBox({ prompt: 'Devin Cloud Email (手动登录)', placeHolder: 'user@example.com' }).then(email => {
                    if (!email) return;
                    vscode.window.showInputBox({ prompt: 'Devin Cloud Password', password: true }).then(async pw => {
                        if (!pw) return;
                        const r = await devinLogin(email, pw);
                        if (r.ok) { vscode.window.showInformationMessage('手动登录成功 (' + email + ')'); await devinFullInject(); sidebarCloudPanel?.refresh(); }
                        else vscode.window.showErrorMessage('手动登录失败: ' + (r.error || ''));
                        refreshReply({ type: 'actionResult', command: 'devinManualLogin', ok: r.ok });
                    });
                });
                break;
            }
            case 'toggleSyncMode': {
                const cur = getAccountSyncMode();
                const next = cur === 'manual' ? 'auto' : 'manual';
                await setAccountSyncMode(next);
                if (next === 'auto') {
                    lastSyncedApiKey = ''; lastSyncedEmail = '';
                    vscode.window.showInformationMessage('账号模式: 自动 · 重新跟随 IDE 账号…');
                    (async () => { try { const ok = await devinAutoChain(); if (ok) await devinFullInject(); } catch {} sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel(); })();
                } else {
                    vscode.window.showInformationMessage('账号模式: 手动 · 面板不再跟随 IDE, 可独立登录任意账号 (点 "手动登录其他账户")');
                }
                sidebarCloudPanel?.refresh();
                refreshReply({ type: 'actionResult', command: 'toggleSyncMode', ok: true, mode: next });
                break;
            }
            case 'exportAgentDoc': {
                let okExp = false; let outPath = '';
                try {
                    outPath = await exportAgentDocToFile();
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
                    await vscode.window.showTextDocument(doc, { preview: false });
                    vscode.env.clipboard.writeText(outPath);
                    vscode.window.showInformationMessage('已导出 Agent 操作契约: ' + outPath + ' (路径已复制) · 也可 GET /api/agent-doc');
                    okExp = true;
                } catch (e: any) { vscode.window.showErrorMessage('导出失败: ' + (e?.message || e)); }
                refreshReply({ type: 'actionResult', command: 'exportAgentDoc', ok: okExp, path: outPath });
                break;
            }
            case 'devinLogout': {
                ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinOrgName = ''; ws.devinOrgSlug = '';
                ws.devinEmail = ''; ws.devinSessionToken = ''; ws.devinApiKey = ''; ws.devinApiServerUrl = '';
                ws.devinAccountId = ''; ws.devinQuota = null; ws.devinSaveConfig();
                sidebarCloudPanel?.refresh(); // 同步刷新侧边栏
                refreshReply({ type: 'actionResult', command: 'devinLogout', ok: true });
                break;
            }
            case 'devinInject': {
                const ok = await devinFullInject(true);
                sidebarCloudPanel?.refresh(); // 同步刷新侧边栏
                refreshReply({ type: 'actionResult', command: 'devinInject', ok });
                break;
            }
            case 'devinRefreshQuota': {
                // 优先用API Key，其次用auth1作为Bearer token
                const quotaKey = ws.devinApiKey || ws.devinAuth1;
                if (quotaKey) { const q = await devinFetchQuota(quotaKey, ws.devinApiServerUrl); if (q) { ws.devinQuota = q; ws.devinSaveConfig(); } }
                sidebarCloudPanel?.refresh();
                refreshReply({ type: 'actionResult', command: 'devinRefreshQuota', ok: !!ws.devinQuota });
                break;
            }
            case 'devinCreateSession': {
                vscode.window.showInputBox({ prompt: 'Devin Session Message', placeHolder: 'What would you like Devin to do?' }).then(async message => {
                    if (!message) return;
                    const r = await devinCreateSession(ws.devinOrgId, message, ws.devinAuth1);
                    if (r.ok) vscode.window.showInformationMessage('Session created: ' + (r.devinId || ''));
                    else vscode.window.showErrorMessage('Session create failed' + (r.status ? ' (HTTP ' + r.status + ')' : '') + (r.error ? ': ' + r.error : ''));
                    refreshReply({ type: 'actionResult', command: 'devinCreateSession', ok: r.ok });
                });
                break;
            }
            case 'devinDownloadSession': {
                // 帛书·「天下之至柔驰骋于天下之致坚」— simpleBrowser共享Electron session
                // API不可用 → 在simpleBrowser中打开session页面
                if (msg.sessionId) {
                    const sessionUrl = daoRoutedWebUrl('/sessions/' + msg.sessionId);
                    try { vscode.commands.executeCommand('simpleBrowser.show', sessionUrl); }
                    catch { vscode.env.openExternal(vscode.Uri.parse(sessionUrl)); }
                    vscode.window.showInformationMessage('已在 Simple Browser 中打开 Session 页面');
                }
                break;
            }
            case 'devinInjectKnowledge': {
                const r = await devinUpsertKnowledge(ws.devinOrgId, msg.name, msg.body, msg.triggerDescription, ws.devinAuth1);
                refreshReply({ type: 'actionResult', ok: r.ok });
                break;
            }
            case 'devinDeleteKnowledge': {
                const r = await devinDeleteKnowledge(ws.devinOrgId, String(msg.id), ws.devinAuth1);
                refreshReply({ type: 'actionResult', ok: r.ok });
                break;
            }
            case 'devinInjectPlaybook': {
                const r = await devinUpsertPlaybook(ws.devinOrgId, msg.title, msg.body, ws.devinAuth1);
                refreshReply({ type: 'actionResult', ok: r.ok });
                break;
            }
            case 'devinDeletePlaybook': {
                const r = await devinDeletePlaybook(ws.devinOrgId, String(msg.id), ws.devinAuth1);
                refreshReply({ type: 'actionResult', ok: r.ok });
                break;
            }
            case 'devinInjectSecret': {
                const r = await devinUpsertSecret(ws.devinOrgId, msg.name, msg.value, ws.devinAuth1);
                refreshReply({ type: 'actionResult', ok: r.ok });
                break;
            }
            case 'devinDeleteSecret': {
                const r = await devinDeleteSecret(ws.devinOrgId, msg.name, ws.devinAuth1);
                refreshReply({ type: 'actionResult', ok: r.ok });
                break;
            }
            case 'devinConnectGit': {
                vscode.window.showInputBox({ prompt: 'GitHub Personal Access Token', placeHolder: 'ghp_...', password: true }).then(async pat => {
                    if (!pat) return;
                    const r = await devinConnectGitHub(ws.devinOrgId, pat, ws.devinAuth1);
                    if (r.ok) vscode.window.showInformationMessage('GitHub PAT connected' + (r.existed ? ' (already existed)' : ''));
                    else vscode.window.showErrorMessage('GitHub PAT connect failed');
                    refreshReply({ type: 'actionResult', ok: r.ok });
                });
                break;
            }
            case 'devinDisconnectGit': {
                if (msg.connectionId) {
                    await devinDisconnectGit(ws.devinOrgId, msg.connectionId, ws.devinAuth1);
                    refreshReply({ type: 'actionResult', ok: true });
                }
                break;
            }
            // ★ v1.0.1 · 新建操作 · 帛书·「道生一·一生二·二生三·三生万物」
            case 'devinCreateKnowledge': {
                const name = await vscode.window.showInputBox({ prompt: 'Knowledge Name', placeHolder: 'My Knowledge' });
                if (!name) break;
                const body = await vscode.window.showInputBox({ prompt: 'Knowledge Body', placeHolder: 'Content...' });
                if (!body) break;
                const trigger = await vscode.window.showInputBox({ prompt: 'Trigger Description (when to retrieve)', placeHolder: 'When working on...' });
                const r = await devinInjectKnowledge(ws.devinOrgId, name, body, trigger || name, ws.devinAuth1);
                if (r.ok) { vscode.window.showInformationMessage('Knowledge created: ' + name); setManualLock(ws.devinOrgId, 'knowledge', name, true); }
                refreshReply({ type: 'actionResult', command: 'devinCreateKnowledge', ok: r.ok });
                break;
            }
            case 'devinCreatePlaybook': {
                const title = await vscode.window.showInputBox({ prompt: 'Playbook Title', placeHolder: 'My Playbook' });
                if (!title) break;
                const body = await vscode.window.showInputBox({ prompt: 'Playbook Body (markdown)', placeHolder: '## Steps\n1. ...' });
                if (!body) break;
                const r = await devinInjectPlaybook(ws.devinOrgId, title, body, ws.devinAuth1);
                if (r.ok) { vscode.window.showInformationMessage('Playbook created: ' + title); setManualLock(ws.devinOrgId, 'playbooks', title, true); }
                refreshReply({ type: 'actionResult', command: 'devinCreatePlaybook', ok: r.ok });
                break;
            }
            case 'devinCreateSecret': {
                const name = await vscode.window.showInputBox({ prompt: 'Secret Name', placeHolder: 'MY_SECRET_KEY' });
                if (!name) break;
                const value = await vscode.window.showInputBox({ prompt: 'Secret Value', password: true });
                if (!value) break;
                const r = await devinUpsertSecret(ws.devinOrgId, name, value, ws.devinAuth1);
                if (r.ok) { vscode.window.showInformationMessage('Secret created: ' + name); setManualLock(ws.devinOrgId, 'secrets', name, true); }
                refreshReply({ type: 'actionResult', command: 'devinCreateSecret', ok: r.ok });
                break;
            }
            // ★ 全 CRUD · 修改已有条目 · 帛书「曲则全·枉则直」— 删旧(按id, 支持改名)→建新, 多行正文用临时文档编辑
            case 'devinEditKnowledge': {
                const list = await devinListKnowledge(ws.devinOrgId, ws.devinAuth1);
                const item = (list.learnings || []).find((k: any) => String(k.id) === String(msg.id));
                if (!item) { vscode.window.showErrorMessage('未找到该 Knowledge'); refreshReply({ type: 'actionResult', command: 'devinEditKnowledge', ok: false }); break; }
                const newName = await vscode.window.showInputBox({ prompt: 'Knowledge 名称', value: String(item.name || '') });
                if (newName === undefined) break;
                const newBody = await daoEditBodyViaDoc('知识《' + (item.name || '') + '》正文', String(item.body || ''));
                if (newBody === undefined) break;
                const newTrig = await vscode.window.showInputBox({ prompt: '触发描述(何时检索)', value: String(item.trigger_description || item.trigger || '') });
                if (newTrig === undefined) break;
                await devinDeleteKnowledge(ws.devinOrgId, String(item.id), ws.devinAuth1);
                const r = await devinInjectKnowledge(ws.devinOrgId, newName || String(item.name), newBody, newTrig || newName || String(item.name), ws.devinAuth1);
                if (r.ok) { vscode.window.showInformationMessage('Knowledge 已修改: ' + (newName || item.name)); setManualLock(ws.devinOrgId, 'knowledge', newName || String(item.name), true); }
                else vscode.window.showErrorMessage('Knowledge 修改失败');
                refreshReply({ type: 'actionResult', command: 'devinEditKnowledge', ok: r.ok });
                break;
            }
            // 面板内修改: 正文随消息直达, 无原生弹窗(多窗口下也稳); 先 PATCH 原地更新, 失败退回删建。
            case 'devinEditKnowledgeInline': {
                if (!ws.devinOrgId) { refreshReply({ type: 'actionResult', command: 'devinEditKnowledgeInline', ok: false }); break; }
                const kid = String(msg.id || '');
                const kName = String(msg.name || '').trim();
                const kBody = String(msg.body || '');
                const kTrig = String(msg.trigger || '').trim();
                if (!kid || !kName) { refreshReply({ type: 'actionResult', command: 'devinEditKnowledgeInline', ok: false }); break; }
                let okEdit = (await devinUpdateKnowledge(ws.devinOrgId, kid, kName, kBody, kTrig || kName, ws.devinAuth1)).ok;
                if (!okEdit) {
                    try { await devinDeleteKnowledge(ws.devinOrgId, kid, ws.devinAuth1); } catch { /* 守柔 */ }
                    okEdit = (await devinInjectKnowledge(ws.devinOrgId, kName, kBody, kTrig || kName, ws.devinAuth1)).ok;
                }
                if (okEdit) { setManualLock(ws.devinOrgId, 'knowledge', kName, true); vscode.window.showInformationMessage('Knowledge 已修改: ' + kName); }
                else vscode.window.showErrorMessage('Knowledge 修改失败');
                refreshReply({ type: 'actionResult', command: 'devinEditKnowledgeInline', ok: okEdit });
                break;
            }
            case 'devinEditPlaybook': {
                const list = await devinListPlaybooks(ws.devinOrgId, ws.devinAuth1);
                const item = (list.playbooks || []).find((p: any) => String(p.id) === String(msg.id));
                if (!item) { vscode.window.showErrorMessage('未找到该 Playbook'); refreshReply({ type: 'actionResult', command: 'devinEditPlaybook', ok: false }); break; }
                const newTitle = await vscode.window.showInputBox({ prompt: 'Playbook 标题', value: String(item.title || item.name || '') });
                if (newTitle === undefined) break;
                const newBody = await daoEditBodyViaDoc('剧本《' + (item.title || '') + '》正文', String(item.body || ''));
                if (newBody === undefined) break;
                await devinDeletePlaybook(ws.devinOrgId, String(item.id), ws.devinAuth1);
                const r = await devinInjectPlaybook(ws.devinOrgId, newTitle || String(item.title), newBody, ws.devinAuth1);
                if (r.ok) { vscode.window.showInformationMessage('Playbook 已修改: ' + (newTitle || item.title)); setManualLock(ws.devinOrgId, 'playbooks', newTitle || String(item.title), true); }
                else vscode.window.showErrorMessage('Playbook 修改失败');
                refreshReply({ type: 'actionResult', command: 'devinEditPlaybook', ok: r.ok });
                break;
            }
            case 'devinEditSecret': {
                // Secret 值不可读(write-only) → 仅改新值(可同时改名)
                const oldName = String(msg.name || '');
                const newName = await vscode.window.showInputBox({ prompt: 'Secret 名称', value: oldName });
                if (newName === undefined) break;
                const value = await vscode.window.showInputBox({ prompt: 'Secret 新值(留空取消)', password: true });
                if (!value) break;
                if (newName && newName !== oldName) await devinDeleteSecret(ws.devinOrgId, oldName, ws.devinAuth1);
                const r = await devinUpsertSecret(ws.devinOrgId, newName || oldName, value, ws.devinAuth1);
                if (r.ok) { vscode.window.showInformationMessage('Secret 已修改: ' + (newName || oldName)); setManualLock(ws.devinOrgId, 'secrets', newName || oldName, true); }
                else vscode.window.showErrorMessage('Secret 修改失败');
                refreshReply({ type: 'actionResult', command: 'devinEditSecret', ok: r.ok });
                break;
            }
            case 'toggleManualLock': {
                const kind = msg.kind as ManualLockKind;
                const name = String(msg.name || '');
                const validKinds: ManualLockKind[] = ['knowledge', 'playbooks', 'secrets', 'mcps'];
                if (!validKinds.includes(kind) || !name || !ws.devinOrgId) { refreshReply({ type: 'actionResult', command: 'toggleManualLock', ok: false }); break; }
                const nowLocked = !isManualLocked(ws.devinOrgId, kind, name);
                setManualLock(ws.devinOrgId, kind, name, nowLocked);
                vscode.window.showInformationMessage((nowLocked ? '🔒 已锁定(防反向注入覆盖·清理照常): ' : '🔓 已解锁: ') + name);
                refreshReply({ type: 'actionResult', command: 'toggleManualLock', ok: true });
                break;
            }
            case 'mcpMarketInstall': {
                // 装一个市场目录项到本账号 (引用 marketplace_server_id)
                if (!ws.devinAuth1 || !ws.devinOrgId) { reply({ type: 'actionResult', command: 'mcpMarketInstall', ok: false }); break; }
                const r = await devinInstallMarketplaceMcp(ws.devinOrgId, (msg.spec || {}) as McpInstallSpec, ws.devinAuth1);
                vscode.window.showInformationMessage(r.ok ? ('✓ 已安装 MCP: ' + ((msg.spec || {}).name || '')) : ('安装失败: ' + (r.error || r.status || '')));
                refreshReply({ type: 'actionResult', command: 'mcpMarketInstall', ok: r.ok });
                break;
            }
            case 'mcpUninstall': {
                if (!ws.devinAuth1 || !ws.devinOrgId || !msg.id) { reply({ type: 'actionResult', command: 'mcpUninstall', ok: false }); break; }
                const r = await devinDeleteMcp(ws.devinOrgId, String(msg.id), ws.devinAuth1);
                vscode.window.showInformationMessage(r.ok ? '✓ 已卸载 MCP' : ('卸载失败: ' + (r.status || '')));
                refreshReply({ type: 'actionResult', command: 'mcpUninstall', ok: r.ok });
                break;
            }
            case 'mcpAddProfile': {
                // 加入反向注入档案 (injectProfile.mcps) → 可批量注入所有账号
                const spec = (msg.spec || {}) as McpInstallSpec;
                const p = loadInjectProfile();
                const nm = String(spec.name || spec.slug || '').replace(/^★ /, '');
                if (!nm) { reply({ type: 'actionResult', command: 'mcpAddProfile', ok: false }); break; }
                const exists = (p.mcps || []).some((m: any) => String(m.name || m.slug || '') === nm);
                if (!exists) {
                    p.mcps = p.mcps || [];
                    p.mcps.push({
                        name: nm, slug: spec.slug, transport: spec.transport || 'STDIO',
                        short_description: spec.short_description || '', command: spec.command || '',
                        args: spec.args || [], env_variables: spec.env_variables || [],
                        url: spec.url || '', headers: spec.headers || {},
                        marketplace_server_id: spec.marketplace_server_id || '',
                        installation_scope: spec.installation_scope || 'org',
                    } as any);
                    saveInjectProfile(p);
                }
                vscode.window.showInformationMessage(exists ? ('档案已含: ' + nm) : ('✓ 已加入反向注入档案: ' + nm + ' (可在 反向注入 页批量注入所有账号)'));
                reply({ type: 'actionResult', command: 'mcpAddProfile', ok: true });
                break;
            }
            case 'mcpProbe': {
                // 逐项接测(连接验证) — 纯探测, 不改任何状态; 结果按 idx 回填卡片。
                const res = await daoProbeMcp(msg.spec || {});
                reply({ type: 'mcpProbeResult', idx: msg.idx, result: res });
                break;
            }
            case 'repairLocalMcp': {
                // 一键修复本机 MCP(通用·强鲁棒): 自动识别 node 运行时与模块路径, 修正命令并启用(先备份)。
                try {
                    const r = daoRepairLocalMcp({ allIdes: !!msg.allIdes, enable: true, dryRun: false });
                    const n = r.results.reduce((a: number, x: any) => a + (x.changes ? x.changes.length : 0), 0);
                    const rtLabel = r.runtime.electron ? ('IDE 内置 node (' + path.basename(r.runtime.command || '') + ')') : ('系统 node (' + (r.runtime.command || '未找到') + ')');
                    if (n > 0) vscode.window.showInformationMessage('🔧 已修复本机 MCP ' + n + ' 项 · 运行时=' + rtLabel + ' · 已备份原配置。重载窗口(Ctrl+Shift+P → Reload Window)后生效。');
                    else vscode.window.showInformationMessage('🔧 本机 MCP 无需修复 (运行时=' + rtLabel + ', 配置已就绪)。');
                    refreshReply({ type: 'actionResult', command: 'repairLocalMcp', ok: true });
                } catch (e: any) { vscode.window.showErrorMessage('MCP 修复失败: ' + String(e && e.message || e)); reply({ type: 'actionResult', command: 'repairLocalMcp', ok: false }); }
                break;
            }
            case 'verifyLocalMcp': {
                // 实测使用: 当前宿主 IDE 各 STDIO MCP 真起进程拿工具数, 结果弹通知 + 回填。
                try {
                    const hostSrc = daoHostIdeSource();
                    let ideV = scanIdeMcps().filter((e) => e.source === hostSrc);
                    if (!ideV.length) ideV = scanIdeMcps().filter((e) => e.source === 'Devin Desktop');
                    const vres = await Promise.all(ideV.map(async (e) => {
                        if (e.transport === 'HTTP') { const r = await daoProbeMcp({ transport: 'HTTP', url: e.url, headers: e.headers }); return { name: e.name, ok: r.ok, toolCount: 0 }; }
                        const r = await daoVerifyMcpStdio({ command: e.command, args: e.args, env: e.env }, 15000);
                        return { name: e.name, ok: r.ok, toolCount: r.toolCount, error: r.error };
                    }));
                    const okN = vres.filter((x) => x.ok).length;
                    const summary = vres.map((x) => x.name + (x.ok ? '✓' + x.toolCount + '工具' : '✗')).join(' · ');
                    vscode.window.showInformationMessage('🧪 实测本机 MCP (' + hostSrc + '): ' + okN + '/' + vres.length + ' 可用 — ' + summary);
                    refreshReply({ type: 'actionResult', command: 'verifyLocalMcp', ok: okN > 0 });
                } catch (e: any) { vscode.window.showErrorMessage('MCP 实测失败: ' + String(e && e.message || e)); reply({ type: 'actionResult', command: 'verifyLocalMcp', ok: false }); }
                break;
            }
            case 'mcpInstallAllAccounts': {
                // 一键批量装到所有账号: 先入反向注入档案(幂等), 再整池反向注入 → 反向注入模块同款全覆盖。
                const spec = (msg.spec || {}) as McpInstallSpec;
                const nm = String(spec.name || spec.slug || '').replace(/^★ /, '');
                if (!nm) { reply({ type: 'actionResult', command: 'mcpInstallAllAccounts', ok: false }); break; }
                const p = loadInjectProfile();
                p.mcps = p.mcps || [];
                const exists = p.mcps.some((m: any) => String(m.name || m.slug || '') === nm);
                if (!exists) {
                    p.mcps.push({
                        name: nm, slug: spec.slug, transport: spec.transport || 'STDIO',
                        short_description: spec.short_description || '', command: spec.command || '',
                        args: spec.args || [], env_variables: spec.env_variables || [],
                        url: spec.url || '', headers: spec.headers || {},
                        marketplace_server_id: spec.marketplace_server_id || '',
                        installation_scope: spec.installation_scope || 'org',
                    } as any);
                }
                if (!p.enabled) p.enabled = true;
                saveInjectProfile(p);
                if (daoBatchProgress && daoBatchProgress.running) {
                    vscode.window.showWarningMessage('批量注入已在进行中: ' + daoBatchProgress.done + '/' + daoBatchProgress.total);
                    reply({ type: 'actionResult', command: 'mcpInstallAllAccounts', ok: false });
                    break;
                }
                vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '批量装 MCP「' + nm + '」到所有账号…' }, async () => {
                    const r = await daoBatchInjectAllAccounts();
                    vscode.window.showInformationMessage('MCP「' + nm + '」批量注入完成: ' + r.okCount + '/' + r.total + ' 账号');
                    sidebarCloudPanel?.refresh();
                    refreshReply({ type: 'actionResult', command: 'mcpInstallAllAccounts', ok: r.ok });
                });
                break;
            }
            case 'clearAutomations': {
                // 一切清除本账号官网自动化
                if (!ws.devinAuth1 || !ws.devinOrgId) { reply({ type: 'actionResult', command: 'clearAutomations', ok: false }); break; }
                const r = await devinClearAutomations(ws.devinOrgId, ws.devinAuth1);
                vscode.window.showInformationMessage('🧹 已清除自动化 ' + r.cleared + '/' + r.total);
                refreshReply({ type: 'actionResult', command: 'clearAutomations', ok: r.ok });
                break;
            }
            case 'startServer': {
                await startServer(context);
                setTimeout(() => refreshDaoCloudMiddlePanel(), 1500);
                break;
            }
            case 'stopServer': {
                stopServer();
                setTimeout(() => refreshDaoCloudMiddlePanel(), 500);
                break;
            }
            case 'regenerateToken': {
                regenerateToken();
                refreshDaoCloudMiddlePanel();
                break;
            }
            case 'copy': {
                vscode.env.clipboard.writeText(msg.text || '');
                vscode.window.showInformationMessage('已复制: ' + (msg.label || ''));
                break;
            }
            case 'openBrowser': {
                // 帛书·「执天之行」官网根挂载 — 经反代根路径(/)路由 app.devin.ai,
                // 持 auth1 时 localStorage 注入 auth1_session → 自动登录, 无需手动/OAuth
                await ensureRoutedAutoLogin(context);
                const targetUrl = daoRoutedWebUrl('');
                try { vscode.commands.executeCommand('simpleBrowser.show', targetUrl); }
                catch { vscode.env.openExternal(vscode.Uri.parse(targetUrl)); }
                break;
            }
            case 'syncBrowser': {
                // 浏览器同步: 在电脑浏览器(独立 profile 窗口)自动登录当前账号。
                // 即时响应根治「点了没反应」: 仅 await 快速的「确保服务器在跑」, 随即立刻开窗口;
                //   慢速的自动登录链路(devinAutoChain)改后台自愈, 不阻塞点击。切第2/3/4账号各开独立并行窗口。
                try { if (!ws.port) await startServer(context); } catch { /* 守柔 */ }
                const acct = ws.devinEmail || 'default';
                const url = daoRoutedWebUrlForAccount(acct, msg.page ? '/' + String(msg.page).replace(/^\//, '') : '');
                const ok = launchIsolatedBrowser(url, acct);
                vscode.window.showInformationMessage(ok ? ('已在电脑浏览器同步并登录: ' + acct) : '浏览器启动失败');
                refreshReply({ type: 'actionResult', command: 'syncBrowser', ok });
                const hasA1 = !!ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$');
                if (!hasA1) { ensureRoutedAutoLogin(context).catch(() => { /* 守柔: 后台自愈 */ }); }
                break;
            }
            case 'openRoutedPanel': {
                // 帛书·「道并行而不相悖」— IDE 内独立 webview 路由面板(多实例·不阻塞)
                // 守正出奇: 先走已验证可用的 rt-flow 多实例反代(中栏同源·无 X-Frame),
                //   打不通才回退 9920/?dao_acct 路由面板(官网带 X-Frame 限制·内嵌易空白→「点了没反应」)。
                await ensureRoutedServerFast(context);
                const routedEmail = ws.devinEmail || '';
                const rRouted = await tryRtflowMultiInstance({ email: routedEmail });
                if (!rRouted || !rRouted.ok) {
                    const routedUrl = daoRoutedWebUrlForAccount(routedEmail, '');
                    openRoutedAccountPanel(context, routedEmail, routedUrl);
                }
                refreshReply({ type: 'actionResult', command: 'openRoutedPanel', ok: true });
                break;
            }
            case 'openDevinPage': {
                // 帛书·「执天之行」官网根挂载 — 经反代根路径路由, auth1 localStorage 注入自动登录
                await ensureRoutedAutoLogin(context);
                const page = msg.page || 'home';
                const pagePaths: Record<string, string> = {
                    home: '', sessions: '/sessions',
                    knowledge: '/knowledge', playbooks: '/playbooks',
                    secrets: '/settings/secrets', integrations: '/settings/integrations',
                };
                const targetUrl = daoRoutedWebUrl(pagePaths[page] || '');
                try { vscode.commands.executeCommand('simpleBrowser.show', targetUrl); }
                catch { vscode.env.openExternal(vscode.Uri.parse(targetUrl)); }
                break;
            }
            case 'refresh': {
                refreshDaoCloudMiddlePanel();
                break;
            }
            // ═══ Bridge 集成命令 — 帛书·「天下之至柔驰骋于天下之致坚」═══
            case 'bridgeStart': {
                await bridgeStartTunnel(false);
                refreshReply({ type: 'actionResult', command: 'bridgeStart', ok: true });
                break;
            }
            case 'bridgeStartNamed': {
                const token = await vscode.window.showInputBox({ prompt: '命名隧道 Token (cloudflared tunnel run --token)', placeHolder: 'eyJ...' });
                if (token) {
                    bridgeSaveNamedToken(token);
                    await bridgeStartTunnel(true);
                    refreshReply({ type: 'actionResult', command: 'bridgeStartNamed', ok: true });
                }
                break;
            }
            case 'bridgeStop': {
                bridgeStopTunnel();
                refreshReply({ type: 'actionResult', command: 'bridgeStop', ok: true });
                break;
            }
            case 'bridgeRestart': {
                const wasNamed = !!bridgeReadNamedToken();
                bridgeStopTunnel();
                await bridgeStartTunnel(wasNamed);
                refreshReply({ type: 'actionResult', command: 'bridgeRestart', ok: true });
                break;
            }
            case 'bridgeReset': {
                try { fs.unlinkSync(path.join(BRIDGE_DIR, 'tunnel-token')); } catch { /* 守柔 */ }
                bridgeStopTunnel();
                await bridgeStartTunnel(false);
                refreshReply({ type: 'actionResult', command: 'bridgeReset', ok: true });
                break;
            }
            case 'bridgeExportCloudMd': {
                const md = bridgeGenerateCloudMd();
                const mdPath = path.join(os.homedir(), '.dao', 'bridge', 'cloud-agent.md');
                fs.mkdirSync(path.dirname(mdPath), { recursive: true });
                fs.writeFileSync(mdPath, md, 'utf8');
                const doc = await vscode.workspace.openTextDocument(mdPath);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                reply({ type: 'actionResult', command: 'bridgeExportCloudMd', ok: true });
                break;
            }
            case 'bridgeExportLocalMd': {
                const md = bridgeGenerateLocalMd();
                const mdPath = path.join(os.homedir(), '.dao', 'bridge', 'local-agent.md');
                fs.mkdirSync(path.dirname(mdPath), { recursive: true });
                fs.writeFileSync(mdPath, md, 'utf8');
                const doc = await vscode.workspace.openTextDocument(mdPath);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                reply({ type: 'actionResult', command: 'bridgeExportLocalMd', ok: true });
                break;
            }
            case 'copyBridgeToken': {
                const tok = ws.token || bridgeToken;
                if (tok) await vscode.env.clipboard.writeText(tok);
                vscode.window.showInformationMessage('Bridge Token 已复制');
                reply({ type: 'actionResult', command: 'copyBridgeToken', ok: !!tok });
                break;
            }
            // 合一: 一键复制接入信息(URL + Token + Auth 头) — 帛书「少则得」: 一钮即得整段接入块。
            case 'copyBridgeInfo': {
                const c = readBridgeConn();
                const url = (c && c.url) || bridgeUrl || '';
                const tok = ws.token || bridgeToken || '';
                const block = `公网URL: ${url}\nToken:   ${tok}\nAuth:    Authorization: Bearer ${tok}`;
                await vscode.env.clipboard.writeText(block);
                vscode.window.showInformationMessage('Bridge 接入信息已复制 (URL + Token)');
                reply({ type: 'actionResult', command: 'copyBridgeInfo', ok: !!(url || tok) });
                break;
            }
            // 刷新 Token (移植自独立 dao-bridge refreshToken) — 帛书「夫唯不争·故无尤」:
            // 先令服务器接纳新牌(checkAuth 同时认 ws.token + bridgeToken)→旧牌不失效→换牌不断链;
            // 再回写 conn.json + 重写 MD + 反向注入到所有账号 Knowledge(新牌实时扩散)。
            case 'bridgeRefreshToken': {
                // 仅当本进程自起隧道时可刷新(server 认 ws.token+bridgeToken, 故换牌不断链);
                // 持久化(常驻桥)模式下隧道与令牌皆由常驻服务管理, 此处刷新会写错 token 反而断链 → 守柔拒绝。
                if (!bridgeUrl) {
                    vscode.window.showWarningMessage('当前为常驻桥持久化连接 · Token 由常驻服务管理。如需本插件自管令牌, 请先「▶ 启动隧道」再刷新。');
                    refreshReply({ type: 'actionResult', command: 'bridgeRefreshToken', ok: false });
                    break;
                }
                // 帛书·「知常曰明」: 对外令牌恒等机器级恒稳源 ws.token(永不再漂);「刷新」即强制重新发布/扩散权威令牌。
                bridgeToken = ws.token || bridgeToken;
                bridgeSaveAuthToken(bridgeToken);
                bridgeSaveConnJson();
                try { bridgeWriteArtifacts(); } catch { /* 守柔 */ }
                let injected = false;
                try { if (ws.devinAuth1 && ws.devinOrgId) injected = await bridgeInjectKnowledge(); } catch { /* 守柔 */ }
                // v3.17.4 · 新牌实时扩散到所有账号(KB+MCP)
                bridgeScheduleReinject('tokenRefresh');
                vscode.window.showInformationMessage('Bridge Token 已刷新' + (injected ? ' · 已同步到当前账号 Knowledge' : '') + ' (旧牌仍短暂有效, 不断链)');
                refreshReply({ type: 'actionResult', command: 'bridgeRefreshToken', ok: true });
                break;
            }
            case 'bridgeInjectKnowledge': {
                const injected = await bridgeInjectKnowledge();
                reply({ type: 'actionResult', command: 'bridgeInjectKnowledge', ok: injected });
                break;
            }
            case 'injectDiagnose': {
                let diag = '诊断开始…\n';
                const eff = bridgeEffectiveUrl();
                diag += '隧道 URL: ' + (eff || '(无)') + '\n';
                let alive = false;
                if (eff) { try { alive = await bridgeProbeAlive(eff, 8000, bridgeEffectiveToken()); } catch { /* 守柔 */ } }
                diag += '隧道探活: ' + (alive ? '✓ 在线' : '✗ 离线') + '\n';
                if (!alive) {
                    diag += '→ 自动重建隧道…\n';
                    try { bridgeStopTunnel(); await bridgeStartTunnel(!!bridgeReadNamedToken()); diag += '→ 隧道重建完成 · URL: ' + (bridgeUrl || '(等待)') + '\n'; } catch { diag += '→ 隧道重建失败\n'; }
                }
                diag += '→ 执行反向注入…\n';
                try {
                    const injOk = await bridgeInjectKnowledge();
                    diag += '→ 反向注入: ' + (injOk ? '✓ 成功' : '✗ 失败/无活地址') + '\n';
                    try { _lastBridgeReinjectSig = ''; bridgeScheduleReinject('diagnose'); } catch { /* 守柔 */ }
                } catch { diag += '→ 反向注入异常\n'; }
                diag += '诊断完成。';
                refreshDaoCloudMiddlePanel();
                reply({ type: 'actionResult', command: 'injectDiagnose', ok: true, text: diag });
                vscode.window.showInformationMessage(diag.split('\n').filter((l: string) => l.includes('✓') || l.includes('✗') || l.includes('完成')).join(' | ') || '诊断完成');
                break;
            }
            // ═══ 移植自独立 dao-bridge: CloudFlare 控制台/登录/退出 + 能力自测 ═══
            case 'openCf': {
                vscode.env.openExternal(vscode.Uri.parse('https://one.dash.cloudflare.com'));
                reply({ type: 'actionResult', command: 'openCf', ok: true });
                break;
            }
            case 'bridgeCfLogin': {
                const r = await bridgeCfLogin(String(msg.email || ''), String(msg.key || ''));
                vscode.window.showInformationMessage('CloudFlare: ' + r.message);
                refreshReply({ type: 'actionResult', command: 'bridgeCfLogin', ok: r.ok });
                break;
            }
            case 'bridgeCfBrowserLogin': {
                vscode.window.showInformationMessage('正在用浏览器登录 Cloudflare… 完成授权后自动获取 cert.pem');
                const r = await bridgeCfBrowserLogin();
                vscode.window.showInformationMessage('CloudFlare: ' + r.message);
                refreshReply({ type: 'actionResult', command: 'bridgeCfBrowserLogin', ok: r.ok });
                break;
            }
            case 'bridgeLogout': {
                const r = await bridgeResetAccount();
                bridgeStopTunnel();
                await bridgeStartTunnel(false);
                vscode.window.showInformationMessage('DAO Bridge: ' + r.message + ' · 已回到无账号快速隧道');
                refreshReply({ type: 'actionResult', command: 'bridgeLogout', ok: r.ok });
                break;
            }
            case 'bridgeHealth': {
                const r = await bridgeLocalApi('/api/health', 'GET');
                reply({ type: 'bridgeTestResult', op: 'health', ok: r.status === 200, text: 'HTTP ' + r.status + ' ' + (r.text || '').slice(0, 300) });
                break;
            }
            case 'bridgeExec': {
                const r = await bridgeLocalApi('/api/exec', 'POST', { cmd: String(msg.cmd || '') });
                reply({ type: 'bridgeTestResult', op: 'exec', ok: r.status === 200, text: 'HTTP ' + r.status + ' ' + (r.text || '').slice(0, 800) });
                break;
            }
            // 在线设备 · 拉取中枢已接入的全部设备(含本机/中枢自身) — 喂给🌐公网穿透「在线设备」板块。
            case 'bridgeListAgents': {
                const c = readBridgeConn();
                const r = await bridgeHubApi('/api/agents');
                let agents: any[] = [];
                try { const j = JSON.parse(r.text || '{}'); agents = Array.isArray(j.agents) ? j.agents : []; } catch { /* 守柔 */ }
                const host = (c && c.host) || os.hostname();
                reply({ type: 'bridgeAgents', ok: r.status === 200, host, online: !!(c && c.url), agents });
                break;
            }
            // 一行接入 · 复制把另一台设备接进本中枢的 PowerShell 一行命令(irm .../bootstrap.ps1 | iex)。
            case 'copyBridgeJoin': {
                const c = readBridgeConn();
                const url = (c && c.url) ? String(c.url).replace(/\/$/, '') : '';
                const line = url ? ('irm ' + url + '/api/bootstrap.ps1 | iex') : '';
                if (line) await vscode.env.clipboard.writeText(line);
                if (line) vscode.window.showInformationMessage('已复制一行接入命令 · 在另一台 Windows 的 PowerShell 运行即接入本中枢');
                reply({ type: 'actionResult', command: 'copyBridgeJoin', ok: !!line });
                break;
            }
        }
    } catch (e: any) {
        reply({ type: 'error', msg: e.message || String(e) });
    }
}

// ═══════════════════════════════════════════════════════════
// 法 · Devin Cloud 全栈本地化 — 帛书·四十二「三生万物」
// 反者道之动 — 从WAM/网页端提取一切核心模块归一
// 五步链 · CRUD · Session · Git · Billing · WSS · 全1:1官网
// ═══════════════════════════════════════════════════════════

// Devin state now in WorkspaceState (ws.devinAuth1 etc)
// 帛书·三十九「致数与无与」— 不重复声明

const DEVIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const DEVIN_WINDSURF = 'https://windsurf.com';
const DEVIN_APP = 'https://app.devin.ai';
// 道·同源底座: SPA config bundle 仅硬编码这两个后端绝对域(api/backend), 经同源前缀反代 →
//   穿透只搬认证后的轻量数据, 重渲染留在访问者浏览器(类手机 APK 路线)。auth.devin.ai 不反代:
//   已注入 auth1_session 绕过登录, Auth0 全页跳转流难以洁净代理, 静默校验失败不阻渲染。
const DEVIN_API = 'https://api.devin.ai';
const DEVIN_BACKEND = 'https://backend.webapp.devin.ai';
const DEVIN_TOKEN_PREFIX = 'devin-session-token$';
const DEVIN_WSS_BASE = 'wss://app.devin.ai/api/acp/live';
const DEVIN_URL_LOGIN = DEVIN_WINDSURF + '/_devin-auth/password/login';
const DEVIN_URL_POSTAUTH = DEVIN_WINDSURF + '/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const DEVIN_URL_DEVIN_POST_AUTH = DEVIN_APP + '/api/users/post-auth';
const DEVIN_URL_REGISTER = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';

// 帛书·「执天之行」官网根挂载 — 路由官网统一入口
// 官网为 Vite SPA, 经本地反代根路径(/)透传 app.devin.ai; SPA 客户端路由据真实 pathname 工作,
// 故 /devin-cloud/ 子路径前缀非 SPA 真实路由 → 渲染 404。持 auth1 + 服务器运行时经反代根路径
// (auth bridge 注入 localStorage['auth1_session'])自动登录; 否则回退官网直连(依赖 Electron session)。
function daoRoutedWebUrl(pagePath: string = ''): string {
    // 道·「物无非彼·物无非是」— 每窗口路由选择须与认证注入闸门一致(见 authBridge·injA1):
    //   仅当持「真 auth1_」(非 Windsurf devin-session-token$)时, 经本窗口反代(localhost:port)
    //   注入 localStorage 登录态 → SPA 自动登录 + 每窗口独立账号隔离(鸡犬相闻·民至老死不相往来)。
    //   若仅 Windsurf session-token / 无令牌: 反代注入被禁(session-token 会污染登录态) → 经代理
    //   官网必跳 /auth/login。故此时回落官网直连(simpleBrowser 共享 Electron 真 Auth0 会话, 已登录)。
    //   如此: 手动登录窗口=隔离且自动登录; 自动/Windsurf 窗口=直连可用, 两者皆无登录墙。
    const p = (pagePath && pagePath !== '/') ? pagePath : '';
    const hasInjectableAuth1 = !!ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$');
    if (ws.port && hasInjectableAuth1) return `http://localhost:${ws.port}${p || '/'}`;
    return DEVIN_APP + p;
}
// 帛书·「为之于其未有」— 开官网前先备齐零GUI自动登录两前提: 服务器在跑 + 持真 auth1。
// 否则 daoRoutedWebUrl 回落官网直连 → 浏览器无 Electron 会话即跳 /auth/login。
// 每次开页都重跑 devinAutoChain → 跟随当前 IDE 账号(切号后自动换为新账号 auth1)。
async function ensureRoutedAutoLogin(context: vscode.ExtensionContext): Promise<void> {
    try { if (!ws.port) await startServer(context); } catch { /* 守柔 */ }
    const hasInjectableAuth1 = !!ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$');
    if (!hasInjectableAuth1) {
        try { await devinAutoChain(); } catch { /* 守柔 */ }
        // 仍未得真 auth1(凭证/账号池/代理瞬时未就绪)→ 后台退避自愈, 不阻塞开页
        if (!daoHasInjectableAuth1()) scheduleAutoChainHeal(true);
    }
}
// 即时开页变体: 仅 await 快速的「确保服务器在跑」(localhost 反代所需), 随即返回 →
//   慢速登录链路(devinAutoChain)后台自愈, 不让多实例面板/独立窗口卡在打开前的等待。
//   面板自带 9s 加载超时回退、独立窗口经 dao_acct 由反代注入持久化 auth1, 故无需先行阻塞登录。
async function ensureRoutedServerFast(context: vscode.ExtensionContext): Promise<void> {
    try { if (!ws.port) await startServer(context); } catch { /* 守柔 */ }
    const hasInjectableAuth1 = !!ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$');
    if (!hasInjectableAuth1) { ensureRoutedAutoLogin(context).catch(() => { /* 守柔: 后台自愈 */ }); }
}
// 归一 · 优先委托 rt-flow「单面板多窗口」多实例 (每账号独立端口反代·真 origin 隔离·各登各号)。
//   成功 → {ok:true}; rt-flow 不可用或该账号无 auth1 → null/{ok:false} → 调用方退回本地反代面板。
async function tryRtflowMultiInstance(arg: { email?: string; devinId?: string }): Promise<{ ok: boolean; error?: string } | null> {
    try {
        const open = _rtflowModule && _rtflowModule._internals && _rtflowModule._internals.openMultiInstance;
        if (typeof open !== 'function') return null;
        const r = await open({ email: arg.email || '', devinId: arg.devinId || '' });
        return r || { ok: false };
    } catch (e) {
        return { ok: false, error: (e as Error)?.message || 'throw' };
    }
}
// 道·多账号并行: 路由 URL 附 ?dao_acct=<email> → 反代据此注入该账号 auth1(见 devinCloudProxyRoute)。
// 仅当走本地反代(localhost)且该账号已持久化真 auth1 时附加; 否则退回当前账号路由 URL。
function daoRoutedWebUrlForAccount(email: string, pagePath: string = ''): string {
    const base = daoRoutedWebUrl(pagePath);
    if (email && base.indexOf('localhost') >= 0 && loadAccountAuth(email)) {
        return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'dao_acct=' + encodeURIComponent(email);
    }
    return base;
}
// 帛书·「绝利一源」— 定位本机浏览器可执行(Chrome 优先, 回退 Edge, 跨平台)。
// Windows: 解析用户「默认浏览器」的可执行路径(注册表 UserChoice → ProgId → shell\open\command)。
//   仅当其为 Chromium 系(Chrome/Edge/Brave/Vivaldi/Opera/Chromium)时才用于多实例隔离(支持 --user-data-dir)。
function winDefaultBrowserExe(): string | null {
    if (process.platform !== 'win32') return null;
    try {
        const cp = require('child_process') as typeof import('child_process');
        const uc = cp.execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId', { encoding: 'utf8', timeout: 4000 });
        const m = uc.match(/ProgId\s+REG_SZ\s+(\S+)/i);
        if (!m) return null;
        const progId = m[1];
        const cmdOut = cp.execSync('reg query "HKCR\\' + progId + '\\shell\\open\\command" /ve', { encoding: 'utf8', timeout: 4000 });
        const cm = cmdOut.match(/REG_SZ\s+(.+)/i);
        if (!cm) return null;
        const exeM = cm[1].match(/"([^"]+\.exe)"/i) || cm[1].match(/(\S+\.exe)/i);
        const exe = exeM ? exeM[1] : '';
        if (!exe || !fs.existsSync(exe)) return null;
        if (/chrome|edge|brave|vivaldi|opera|chromium/i.test(exe)) return exe; // 仅 Chromium 系可隔离多实例
        return null;
    } catch { return null; }
}
let _daoGoodBrowser: string | null | undefined; // undefined=未探, null=皆不可用, string=实测可用(缓存)
// 帛书·「知人者智, 自知者明」— 实地探测浏览器能否启动: 破损安装(如 ICU 崩溃的旧 Chrome)
//   会在 --headless 下非零退出/崩溃, 据此跳过, 不致「点了没反应」。
function daoProbeBrowser(exe: string): boolean {
    try {
        const cp = require('child_process') as typeof import('child_process');
        const tmp = path.join(os.tmpdir(), 'dao-bp-probe');
        cp.execFileSync(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + tmp, '--dump-dom', 'about:blank'], { timeout: 8000, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        return true; // 退出码 0 → 可用
    } catch { return false; } // 崩溃/超时/非零退出 → 不可用
}
function findBrowserExe(): string | null {
    if (_daoGoodBrowser !== undefined) return _daoGoodBrowser;
    const isWin = process.platform === 'win32';
    const isLinux = process.platform === 'linux';
    const isMac = process.platform === 'darwin';
    const candidates: string[] = [];
    if (isWin) {
        // Devin Desktop 内置 Chrome 路径
        candidates.push('C:\\devin\\chrome\\chrome-win64\\chrome.exe');
        candidates.push((process.env['LOCALAPPDATA'] || '') + '\\Google\\Chrome\\Application\\chrome.exe');
        candidates.push((process.env['ProgramFiles'] || '') + '\\Google\\Chrome\\Application\\chrome.exe');
        candidates.push((process.env['ProgramFiles(x86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe');
        // 谷歌缺失 → 用户「默认浏览器」(若为 Chromium 系, 支持隔离多实例)
        const def = winDefaultBrowserExe(); if (def) candidates.push(def);
        candidates.push((process.env['ProgramFiles(x86)'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe');
        candidates.push((process.env['ProgramFiles'] || '') + '\\Microsoft\\Edge\\Application\\msedge.exe');
    } else if (isLinux) {
        candidates.push('/usr/bin/google-chrome');
        candidates.push('/usr/bin/google-chrome-stable');
        candidates.push('/usr/bin/chromium-browser');
        candidates.push('/usr/bin/chromium');
        candidates.push('/snap/bin/chromium');
    } else if (isMac) {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    }
    // PATH 兜底
    if (!isWin) {
        try {
            const cp = require('child_process') as typeof import('child_process');
            const which = cp.execSync('which google-chrome || which chromium-browser || which chromium 2>/dev/null', { encoding: 'utf8' }).trim();
            if (which) candidates.unshift(which);
        } catch { /* 守柔 */ }
    }
    // 择善而从: 仅返回「实测可启动」之浏览器, 跳过损坏者(如 ICU 崩溃的旧 Chrome);
    // 全部探测失败时回退首个存在者(守柔·不致全失)。结果缓存, 仅首次 launch 探一次。
    let firstExisting: string | null = null;
    for (const p of candidates) {
        try {
            if (p && fs.existsSync(p)) {
                if (!firstExisting) firstExisting = p;
                if (daoProbeBrowser(p)) { _daoGoodBrowser = p; return p; }
            }
        } catch { /* 守柔 */ }
    }
    _daoGoodBrowser = firstExisting;
    return firstExisting;
}
// 浏览器同步 + 多实例并行: 在电脑浏览器开独立 profile 窗口自动登录指定账号。
// profile 按账号 email 隔离 user-data-dir → localStorage 各自独立 → 切第2/3/4账号各开
// 独立并行窗口同时可用, 互不串号(道并行而不相悖)。无浏览器时回退系统默认浏览器。
function launchIsolatedBrowser(targetUrl: string, profileKey: string): boolean {
    try {
        const exe = findBrowserExe();
        const safeKey = (profileKey || 'default').replace(/[^a-zA-Z0-9._@-]/g, '_');
        const profileDir = path.join(DAO_DIR, 'browser-profiles', safeKey);
        try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* 守柔 */ }
        if (exe) {
            const cp = require('child_process') as typeof import('child_process');
            const args = [
                '--user-data-dir=' + profileDir,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-features=Translate,msEdgeWelcomePage,msSync',
                '--new-window',
                targetUrl,
            ];
            const child = cp.spawn(exe, args, { detached: true, stdio: 'ignore' });
            child.unref();
            return true;
        }
    } catch { /* 守柔 */ }
    try { vscode.env.openExternal(vscode.Uri.parse(targetUrl)); return true; } catch { return false; }
}
const DEVIN_URL_GET_USER_STATUS = [
    'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    'https://windsurf.com/_route/api_server/exa.seat_management_pb.SeatManagementService/GetUserStatus',
];

// ═══════════════════════════════════════════════════════════
// 道法自然 · Token能力检测 — 帛书·「知不知尚矣」
// devin-session-token$ = Windsurf专用，仅Codeium API可用，Devin API返回403
// cog_ = Devin v3 API正式Token，可访问所有端点
// sk- = 旧版API Key，部分功能可用
// apk_ / apk_user_ = 旧版个人Token（已废弃）
// ═══════════════════════════════════════════════════════════
function devinCanUseApi(): boolean {
    // ★ v1.0.1 · 帛书·「反者道之动」— auth1亦可通Devin API
    // cog_ → Devin v1 API; auth1 (非session-token) → app.devin.ai/api + x-cog-org-id
    if ((ws.devinApiKey || '').startsWith('cog_')) return true;
    const a1 = ws.devinAuth1 || '';
    if (a1 && !a1.startsWith('devin-session-token$') && a1.length > 10) return true;
    return false;
}

function devinTokenType(): string {
    // ★ v1.0.1 · 识别auth1令牌类型
    if ((ws.devinApiKey || '').startsWith('cog_')) return 'cog';
    const a1 = ws.devinAuth1 || '';
    if (a1 && !a1.startsWith('devin-session-token$') && a1.length > 10) return 'auth1';
    const key = ws.devinApiKey || a1;
    if (key.startsWith('devin-session-token$')) return 'windsurf';
    if (key.startsWith('sk-')) return 'sk';
    if (key.startsWith('apk')) return 'apk';
    return key ? 'unknown' : 'none';
}

// ★ 道法自然修复 · 帛书「大音希声」: Devin /learning·/playbooks·/secrets 接口对请求体里的
// 原始 UTF-8 多字节(中日韩)会"每隔一字"截断(实证: 发送「道法自然」存成「道自」)。
// 解法: 把 JSON 里所有非 ASCII 字符转义为 \uXXXX(纯 ASCII 上线),服务端即可正确解析存储。
// 仅影响含中文的注入(知识库/Playbook/Secret),纯 ASCII 请求(登录等)字节不变。
function asciiSafeJson(body: any): string {
    return JSON.stringify(body || {}).replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
function devinJsonPost(targetUrl: string, headers: any, body: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
        const data = Buffer.from(asciiSafeJson(body), 'utf8');
        const u = new URL(targetUrl);
        // Use proxy tunnel for Devin/Windsurf domains
        const needsProxy = u.hostname === 'app.devin.ai' || u.hostname.endsWith('windsurf.com') || u.hostname === 'register.windsurf.com';
        const makeRequest = (hostname: string, port: number, path: string, h: any) => {
            // 帛书·「正言若反」— 本地HTTP代理走明文，远端走TLS
            const mod: any = hostname === '127.0.0.1' ? http : https;
            const req = mod.request({ hostname, port, path, method: 'POST', headers: h, timeout: timeoutMs || 15000, rejectUnauthorized: false }, (res: any) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { resolve({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
            req.write(data);
            req.end();
        };
        const reqHeaders = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': DEVIN_UA, 'Content-Length': data.length }, headers || {});
        // 帛书·「反者道之动」— 直连优先，失败时降级走本地代理
        const direct = () => makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, reqHeaders);
        const viaProxy = () => makeRequest('127.0.0.1', detectedProxyPort, targetUrl, Object.assign({}, reqHeaders, { Host: u.hostname }));
        const origResolve = resolve;
        if (needsProxy && detectedProxyPort) {
            resolve = ((r: any) => { if (r && r.status === 0) { resolve = origResolve; viaProxy(); } else { origResolve(r); } }) as any;
            direct();
        } else {
            direct();
        }
    });
}

// PATCH — 与 devinJsonPost 同构, 仅方法不同。用于「更新而非新建」(知识库幂等回写, 杜绝重复条目堆积)。
function devinJsonPatch(targetUrl: string, headers: any, body: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
        const data = Buffer.from(asciiSafeJson(body), 'utf8');
        const u = new URL(targetUrl);
        const needsProxy = u.hostname === 'app.devin.ai' || u.hostname.endsWith('windsurf.com') || u.hostname === 'register.windsurf.com';
        const makeRequest = (hostname: string, port: number, path: string, h: any) => {
            const mod: any = hostname === '127.0.0.1' ? http : https;
            const req = mod.request({ hostname, port, path, method: 'PATCH', headers: h, timeout: timeoutMs || 15000, rejectUnauthorized: false }, (res: any) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { resolve({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
            req.write(data);
            req.end();
        };
        const reqHeaders = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': DEVIN_UA, 'Content-Length': data.length }, headers || {});
        const direct = () => makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, reqHeaders);
        const viaProxy = () => makeRequest('127.0.0.1', detectedProxyPort, targetUrl, Object.assign({}, reqHeaders, { Host: u.hostname }));
        const origResolve = resolve;
        if (needsProxy && detectedProxyPort) {
            resolve = ((r: any) => { if (r && r.status === 0) { resolve = origResolve; viaProxy(); } else { origResolve(r); } }) as any;
            direct();
        } else {
            direct();
        }
    });
}

// ═══════════════════════════════════════════════════════════
// 道法自然·守柔自愈 — auth1 过期自动重登 (帛书·「敝则新」)
// 病灶: app.devin.ai 网页端接口(自动化/定时/蓝图/会话…)只认 auth1; 而 auth1 会过期。
// devinAutoChain 路径A以 cog 额度判活, cog 通则误判"已登录"而留住失效 auth1 → 这些接口恒 401。
// 解: 命中 401/403 时, 据当前账号(RT Flow 活跃号优先)重取鲜活 auth1(切号缓存→账号池密码五步重登),
//     成功即原样重试一次。一处自愈, 全网页端接口同沾(无为而无不为)。
// ═══════════════════════════════════════════════════════════
let _reauthInflight: Promise<boolean> | null = null;
async function devinForceReauth(): Promise<boolean> {
    if (_reauthInflight) return _reauthInflight;
    _reauthInflight = (async (): Promise<boolean> => {
        try {
            let email = (ws.devinEmail || '').trim();
            if (getAccountSyncMode() !== 'manual') { const rt = getRtFlowActiveEmail(); if (rt) email = rt; }
            if (!email) return false;
            // 1) RT Flow 切号最新缓存(可能刚被刷新) — 零网络
            try {
                const cached = loadRtFlowCachedAuth(email) || loadAccountAuth(email);
                if (cached && cached.auth1 && cached.orgId && cached.auth1 !== ws.devinAuth1
                    && !cached.auth1.startsWith('devin-session-token$')) {
                    ws.devinAuth1 = cached.auth1; ws.devinOrgId = cached.orgId;
                    ws.devinOrgName = cached.orgName || ws.devinOrgName; ws.devinOrgSlug = cached.orgSlug || ws.devinOrgSlug;
                    ws.devinUserId = cached.userId || ws.devinUserId; ws.devinEmail = email;
                    try { ws.devinSaveConfig(); saveAccountAuth(email); } catch { /* 守柔 */ }
                    return true;
                }
            } catch { /* 守柔 */ }
            // 2) 账号池密码五步重登 → 鲜活 auth1 (devinLogin 内部已落 ws + 5步)
            const pw = findAccountPassword(email);
            if (!pw) return false;
            const lr = await devinLogin(email, pw);
            if (lr.ok) { try { saveAccountAuth(email); } catch { /* 守柔 */ } return true; }
            return false;
        } catch { return false; }
    })();
    try { return await _reauthInflight; } finally { _reauthInflight = null; }
}

function devinJsonGet(targetUrl: string, headers: any, timeoutMs?: number, _noReauth?: boolean): Promise<any> {
    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const needsProxy = u.hostname === 'app.devin.ai' || u.hostname.endsWith('windsurf.com');
        // 自愈闸: app.devin.ai 上持 auth1 而遭 401/403 → 重登换鲜活 auth1, 原请求重试一次
        const settle = (r: any) => {
            const auth = String((headers || {}).Authorization || '');
            if (!_noReauth && r && (r.status === 401 || r.status === 403)
                && u.hostname === 'app.devin.ai' && /^Bearer\s+auth1_/.test(auth)) {
                devinForceReauth().then((ok) => {
                    if (ok && ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$')) {
                        const h2 = Object.assign({}, headers, { Authorization: 'Bearer ' + ws.devinAuth1 });
                        if (ws.devinOrgId) h2['x-cog-org-id'] = ws.devinOrgId;
                        const u2 = targetUrl.replace(/\/org-[0-9a-fA-F]+\//, '/org-' + (ws.devinOrgId || '').replace(/^org-/, '') + '/');
                        devinJsonGet(u2, h2, timeoutMs, true).then(resolve);
                    } else { resolve(r); }
                }).catch(() => resolve(r));
                return;
            }
            resolve(r);
        };
        const makeRequest = (hostname: string, port: number, path: string, h: any, cb: (r: any) => void) => {
            const mod: any = hostname === '127.0.0.1' ? http : https;
            const req = mod.request({ hostname, port, path, method: 'GET', headers: h, timeout: timeoutMs || 15000, rejectUnauthorized: false }, (res: any) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { cb({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { cb({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e) => cb({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); cb({ status: 0, json: null, text: 'timeout' }); });
            req.end();
        };
        const reqHeaders = Object.assign({ 'Accept': 'application/json', 'User-Agent': DEVIN_UA }, headers || {});
        const direct = (cb: (r: any) => void) => makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, reqHeaders, cb);
        const viaProxy = (cb: (r: any) => void) => makeRequest('127.0.0.1', detectedProxyPort, targetUrl, Object.assign({}, reqHeaders, { Host: u.hostname }), cb);
        if (needsProxy && detectedProxyPort) {
            direct((r: any) => { if (r && r.status === 0) { viaProxy(settle); } else { settle(r); } });
        } else {
            direct(settle);
        }
    });
}

// ═══════════════════════════════════════════════════════════
// 五步链 · 帛书·四十二「道生一·一生二·二生三·三生万物」
// Step1: email+password → auth1+userId
// Step2: auth1 → sessionToken+accountId+primaryOrgId
// Step3: auth1 → orgId+orgName+orgSlug
// Step4: sessionToken → apiKey+apiServerUrl
// Step5: apiKey → quota (planName, daily%, weekly%)
// ═══════════════════════════════════════════════════════════

// 归一·B2 · 解析单行账号 (rt-flow 复制格式 email:password) → 取第一个冒号前为邮箱, 其后为密码
function parseAccountLine(line: string): { email: string; password: string } | null {
    if (!line) return null;
    const first = line.split(/\r?\n/)[0].trim();
    const i = first.indexOf(':');
    if (i <= 0) return null;
    const email = first.slice(0, i).trim();
    const password = first.slice(i + 1).trim();
    if (!email || !password || !email.includes('@')) return null;
    return { email, password };
}

async function devinLogin(email: string, password: string, retryCount?: number): Promise<{ ok: boolean; auth1?: string; userId?: string; error?: string }> {
    // Step 1: Login → auth1 — 帛书·七十三「勇于不敢则活」429退避
    const maxRetry = retryCount || 0;
    const r1 = await devinJsonPost(DEVIN_URL_LOGIN, { Origin: DEVIN_WINDSURF, Referer: DEVIN_WINDSURF + '/account/login' }, { email, password });
    if (r1.status === 429 && maxRetry < 3) {
        const wait = Math.pow(2, maxRetry) * 2000;
        await new Promise(ok => setTimeout(ok, wait));
        return devinLogin(email, password, maxRetry + 1);
    }
    const j1 = r1.json || {};
    if (r1.status !== 200 || (!j1.token && !j1.auth1_token)) {
        const err = j1.detail || j1.error || j1.message || 'no_token';
        return { ok: false, error: 'Login failed: ' + err };
    }
    const auth1 = j1.token || j1.auth1_token;
    const userId = j1.user_id || '';

    // Step 2: PostAuth → sessionToken
    const r2 = await devinJsonPost(DEVIN_URL_POSTAUTH, { Origin: DEVIN_WINDSURF, Referer: DEVIN_WINDSURF + '/profile', 'Connect-Protocol-Version': '1', 'X-Devin-Auth1-Token': auth1 }, { auth1_token: auth1 });
    const j2 = r2.json || {};
    const sessionToken = j2.sessionToken || j2.session_token || '';
    if (r2.status !== 200 || !sessionToken) {
        return { ok: false, error: 'PostAuth failed: ' + (j2.error || j2.code || j2.message || 'no_session') };
    }

    // Step 3: Devin PostAuth → orgId+orgName+orgSlug
    const r3 = await devinJsonPost(DEVIN_URL_DEVIN_POST_AUTH, { Authorization: 'Bearer ' + auth1, 'Content-Type': 'application/json' }, {});
    const j3 = r3.json || {};
    let orgId = (j3.org && j3.org.org_id) || j3.org_id || j3.orgId || '';
    const orgName = (j3.org && j3.org.org_name) || j3.org_name || j3.orgName || '';
    const orgSlug = (j3.org && j3.org.org_slug) || j3.org_slug || j3.orgSlug || '';
    if (!orgId && j3.org && typeof j3.org === 'object') {
        for (const k of Object.keys(j3.org)) { if (/org.?id/i.test(k)) { orgId = String(j3.org[k]); break; } }
    }
    if (!orgId) return { ok: false, error: 'Devin PostAuth: no orgId' };

    // Step 4: RegisterUser → apiKey+apiServerUrl
    const r4 = await devinJsonPost(DEVIN_URL_REGISTER, { 'Connect-Protocol-Version': '1' }, { firebase_id_token: sessionToken });
    const j4 = r4.json || {};
    const apiKey = j4.api_key || j4.apiKey || sessionToken;
    const apiServerUrl = j4.api_server_url || j4.apiServerUrl || '';

    // Step 5: FetchQuota (optional, non-blocking)
    let quota: any = null;
    try { quota = await devinFetchQuota(apiKey, apiServerUrl); } catch {}

    // Save all state
    ws.devinAuth1 = auth1;
    ws.devinOrgId = orgId;
    ws.devinOrgName = orgName;
    ws.devinOrgSlug = orgSlug;
    ws.devinEmail = email;
    ws.devinSessionToken = sessionToken;
    ws.devinApiKey = apiKey;
    // 留存 windsurf 风格密钥(注册所得) — 额度查询(GetUserStatus)只认它, 不认随后生成的 cog_
    ws.devinWindsurfKey = (apiKey && !apiKey.startsWith('cog_')) ? apiKey : ws.devinWindsurfKey;
    ws.devinApiServerUrl = apiServerUrl;
    ws.devinAccountId = j2.accountId || '';
    ws.devinUserId = userId || j2.userId || '';  // user-XXX — 路由官网注入 auth1_session.userId
    ws.devinQuota = quota;
    ws.devinSaveConfig();
    // 账号实时同源 · 按邮箱持久化真 auth1 → 切回该账号即刻命中(路径A)
    saveAccountAuth(email);
    // 底层自动获取 cog_ API Key — 用户无为, 系统无不为
    if (!apiKey.startsWith('cog_')) { try { await devinEnsureCogApiKey(orgId, auth1); } catch {} }
    // ws即唯一真源 — 无需同步
    return { ok: true, auth1, userId };
}

function devinSaveConfig() {
    // 帛书·三十九「致数与无与」— 委托WorkspaceState持久化
    ws.saveState();
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · cog_ API Key 底层自动获取 — 帛书·「为而弗恃·长而弗宰」
// 用户永不需手动创建/粘贴 API Key: 持 auth1 直接经 service-users 端点
// 自动生成一枚 cog_ 服务密钥 (角色 member), 落盘复用。无为而无不为。
// POST /api/organizations/{org}/service-users {name, role} → {token: "cog_..."}
// ═══════════════════════════════════════════════════════════
async function devinEnsureCogApiKey(orgId: string, auth1: string): Promise<string> {
    // 已有 cog_ 则直接复用 — 知止不殆
    if ((ws.devinApiKey || '').startsWith('cog_')) return ws.devinApiKey;
    if (!orgId || !auth1) return '';
    try {
        // 先查现有服务用户 — 若曾自建过则尝试复用(避免无限增生)
        const name = 'dao-auto';
        const r = await devinJsonPost(DEVIN_APP + '/api/organizations/' + orgId + '/service-users',
            { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId, 'Content-Type': 'application/json' },
            { name, role: 'member' });
        if (r.status === 200 || r.status === 201) {
            const j = r.json || {};
            const tok = j.token || j.api_key || j.apiKey || '';
            if (tok && tok.startsWith('cog_')) {
                ws.devinApiKey = tok;
                ws.devinSaveConfig();
                return tok;
            }
        }
    } catch { /* 守柔 · 降级 auth1 */ }
    return '';
}

// ═══════════════════════════════════════════════════════════
// 账号池 · 帛书·六十二「道者万物之注·善人之宝」
// email→password 映射 — 据 IDE 当前登录 email 查密码 → 换 auth1
// 来源(优先级): VS Code 配置 dao.devinAccounts > ~/.wam 切号真池(accounts.md/backup) > (回退)~/.dao/accounts.json/.txt
// ═══════════════════════════════════════════════════════════
interface PoolAccount { email: string; password: string }
// 解析切号板块 accounts.md 文本: 每行「邮箱<分隔>密码」。分隔可为空格/冒号/全角冒号/竖线/破折号;
//   密码可含 @ 等特殊字符, 故以首个合法邮箱为锚, 其后整段(去前导分隔)即密码。空行/无邮箱行跳过。
function parseWamAccountLines(raw: string): PoolAccount[] {
    const out: PoolAccount[] = [];
    if (!raw) return out;
    for (const line of raw.split(/\r?\n/)) {
        const ln = line.trim();
        if (!ln || ln.startsWith('#') || ln.startsWith('//')) continue;
        const em = ln.match(/[^\s:：|,;，；]+@[^\s:：|,;，；]+\.[A-Za-z]{2,}/);
        if (!em) continue;
        const email = em[0];
        const pw = ln.slice((em.index || 0) + email.length).replace(/^[\s:：|,;，；\-=＝·]+/, '').trim();
        if (email && pw) out.push({ email, password: pw });
    }
    return out;
}
let _accountPoolCache: PoolAccount[] | null = null;
let _accountPoolReadAt = 0;
const ACCOUNT_POOL_TTL = 30000;
function loadAccountPool(forceRefresh?: boolean): PoolAccount[] {
    if (!forceRefresh && _accountPoolCache && (Date.now() - _accountPoolReadAt) < ACCOUNT_POOL_TTL) {
        return _accountPoolCache;
    }
    const pool: PoolAccount[] = [];
    const seen = new Set<string>();
    const add = (email: string, password: string) => {
        const e = (email || '').trim().toLowerCase();
        const p = (password || '').trim();
        if (!e || !p || !e.includes('@') || seen.has(e)) return;
        seen.add(e);
        pool.push({ email: e, password: p });
    };
    // 来源1: VS Code 配置
    try {
        const cfgAccts = vscode.workspace.getConfiguration('dao').get<any[]>('devinAccounts');
        if (Array.isArray(cfgAccts)) for (const a of cfgAccts) { if (a && a.email) add(a.email, a.password); }
    } catch { /* 守柔 */ }
    // 来源2 (本源·真池): ~/.wam 切号板块账号库 — 反向注入与切号(rt-flow)同源, 命中用户真实在用的账号。
    //   候选顺序与 rt-flow loadAccountsFromFs 对齐(完全融合·数据对齐):
    //   配置 wam.accountsFile > ~/.wam/accounts.md > ~/.wam/accounts-backup.json
    //   (dao.accountsFile 仅作末位兜底, 不破坏与切号的同源优先级)。
    let wamLoaded = false;
    try {
        const cands: string[] = [];
        try {
            const af = vscode.workspace.getConfiguration('wam').get<string>('accountsFile') || '';
            if (af) cands.push(af);
        } catch { /* 守柔 */ }
        cands.push(WAM_ACCOUNTS_MD, WAM_ACCOUNTS_BACKUP);
        try {
            const daf = vscode.workspace.getConfiguration('dao').get<string>('accountsFile') || '';
            if (daf) cands.push(daf);
        } catch { /* 守柔 */ }
        for (const p of cands) {
            if (!p || !fs.existsSync(p)) continue;
            const raw = fs.readFileSync(p, 'utf8');
            let parsed: PoolAccount[] = [];
            if (p.endsWith('.json')) {
                const j = JSON.parse(raw);
                const arr = Array.isArray(j) ? j : (Array.isArray(j.accounts) ? j.accounts : []);
                parsed = arr.filter((a: any) => a && a.email && a.password).map((a: any) => ({ email: a.email, password: a.password }));
            } else {
                parsed = parseWamAccountLines(raw);
            }
            // 真池文件存在且解析出账号即视为权威源(无论与配置是否去重重叠), 不再回退 ~/.dao 假池。
            if (parsed.length) { for (const acc of parsed) add(acc.email, acc.password); wamLoaded = true; break; }
        }
    } catch { /* 守柔 */ }
    // 来源3 (回退·仅当真池缺失): ~/.dao/accounts.json / accounts.txt。
    //   真池非空时不再 union 这里, 杜绝旧/假账号污染批量反向注入。
    if (!wamLoaded) {
        try {
            if (fs.existsSync(ACCOUNTS_FILE)) {
                const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
                const arr = Array.isArray(j) ? j : (Array.isArray(j.accounts) ? j.accounts : []);
                for (const a of arr) { if (a && a.email) add(a.email, a.password); }
            }
        } catch { /* 守柔 */ }
        try {
            if (fs.existsSync(ACCOUNTS_TXT)) {
                for (const line of fs.readFileSync(ACCOUNTS_TXT, 'utf8').split(/\r?\n/)) {
                    const m = line.match(/^\s*([^\s:]+@[^\s:]+)\s*[:：]\s*(.+?)\s*$/);
                    if (m) add(m[1], m[2]);
                }
            }
        } catch { /* 守柔 */ }
    }
    _accountPoolCache = pool;
    _accountPoolReadAt = Date.now();
    return pool;
}
// 归一·账号池同源 — 把 dao-vsix 账号池镜像到 rt-flow(wam) 候选末位文件 ~/.wam/accounts-backup.json,
// 使「左·切号」与「中·数联」共用同一账号池。守柔: 仅镜像非空池; 该路径为 wam 候选末位,
// 用户自备的 wam.accountsFile / accounts.md 仍优先, 不被覆盖。
function syncAccountPoolToWam(): void {
    try {
        const pool = loadAccountPool(true).filter(a => a && a.email && a.password);
        if (!pool.length) return;
        const wamDir = path.join(os.homedir(), '.wam');
        try { fs.mkdirSync(wamDir, { recursive: true }); } catch { /* 守柔 */ }
        const target = path.join(wamDir, 'accounts-backup.json');
        const payload = JSON.stringify({ accounts: pool.map(a => ({ email: a.email, password: a.password })) }, null, 2);
        let prev = '';
        try { prev = fs.readFileSync(target, 'utf8'); } catch { /* 首次无文件 */ }
        if (prev !== payload) fs.writeFileSync(target, payload, 'utf8');
    } catch { /* 道法自然·守柔 */ }
}
function findAccountPassword(email: string): string {
    if (!email) return '';
    const e = email.trim().toLowerCase();
    const hit = loadAccountPool().find(a => a.email === e);
    return hit ? hit.password : '';
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · 账号实时同源 — 按邮箱持久化真 auth1
// 帛书·五十四「善建者不拔·善抱者不脱」: 切回旧账号即刻命中, 永不串号。
// ~/.dao/dao-accounts-auth.json = { [emailLower]: {auth1,orgId,...} }
// ═══════════════════════════════════════════════════════════
const ACCOUNTS_AUTH_FILE = path.join(DAO_DIR, 'dao-accounts-auth.json');
interface SavedAccountAuth {
    auth1: string; orgId: string; orgName: string; orgSlug: string;
    userId: string; accountId: string; apiKey: string; apiServerUrl: string; savedAt: string;
}
function loadAccountsAuthStore(): Record<string, SavedAccountAuth> {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_AUTH_FILE, 'utf8')) || {}; } catch { return {}; }
}
// 仅持久化【真 auth1_】令牌 — session-token 不存(守柔, 防污染登录态)
function saveAccountAuth(email?: string): void {
    const e = (email || ws.devinEmail || '').trim().toLowerCase();
    if (!e || !ws.devinAuth1 || ws.devinAuth1.startsWith('devin-session-token$')) return;
    try {
        const store = loadAccountsAuthStore();
        store[e] = {
            auth1: ws.devinAuth1, orgId: ws.devinOrgId, orgName: ws.devinOrgName, orgSlug: ws.devinOrgSlug,
            userId: ws.devinUserId, accountId: ws.devinAccountId,
            apiKey: (ws.devinApiKey || '').startsWith('cog_') ? ws.devinApiKey : '',
            apiServerUrl: ws.devinApiServerUrl, savedAt: new Date().toISOString(),
        };
        fs.mkdirSync(DAO_DIR, { recursive: true });
        fs.writeFileSync(ACCOUNTS_AUTH_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch { /* 守柔 */ }
}
function loadAccountAuth(email: string): SavedAccountAuth | null {
    const e = (email || '').trim().toLowerCase();
    if (!e) return null;
    return loadAccountsAuthStore()[e] || null;
}
// 落盘指定账号的真 auth1 记录(不经 ws.*) — 供按需取号/多实例钉号缓存。
function saveAccountAuthRecord(email: string, rec: { auth1: string; orgId?: string; orgName?: string; userId?: string }): void {
    const e = (email || '').trim().toLowerCase();
    if (!e || !rec.auth1 || rec.auth1.startsWith('devin-session-token$')) return;
    try {
        const store = loadAccountsAuthStore();
        const prev = store[e] || ({} as SavedAccountAuth);
        store[e] = {
            auth1: rec.auth1, orgId: rec.orgId || prev.orgId || '', orgName: rec.orgName || prev.orgName || '',
            orgSlug: prev.orgSlug || '', userId: rec.userId || prev.userId || '', accountId: prev.accountId || '',
            apiKey: prev.apiKey || '', apiServerUrl: prev.apiServerUrl || '', savedAt: new Date().toISOString(),
        };
        fs.mkdirSync(DAO_DIR, { recursive: true });
        fs.writeFileSync(ACCOUNTS_AUTH_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch { /* 守柔 */ }
}
// 道·多实例按需取号 — 帛书「既以为人己愈有」: 路由某账号(dao_acct)时若其真 auth1 未缓存,
//   即用账号池密码即时登录取号并落盘, 令多实例对全池任一账号都渲染【该账号本身】,
//   而非回退全局活动号(串号根治)。in-flight 去重防页面+XHR 并发重登。
const _ensureAcctInflight = new Map<string, Promise<SavedAccountAuth | null>>();
async function ensureAccountAuth(email: string): Promise<SavedAccountAuth | null> {
    const e = (email || '').trim().toLowerCase();
    if (!e) return null;
    const cached = loadAccountAuth(e);
    if (cached && cached.auth1) return cached;
    const inflight = _ensureAcctInflight.get(e);
    if (inflight) return inflight;
    const p = (async (): Promise<SavedAccountAuth | null> => {
        const password = findAccountPassword(e);
        if (!password) return null;
        const auth = await devinAuthOnly(e, password);
        if (!auth.ok || !auth.auth1) return null;
        saveAccountAuthRecord(e, { auth1: auth.auth1, orgId: auth.orgId, orgName: auth.orgName, userId: auth.userId });
        return loadAccountAuth(e);
    })().catch(() => null).finally(() => { _ensureAcctInflight.delete(e); });
    _ensureAcctInflight.set(e, p);
    return p;
}

// 归一·真源 · RT Flow 活跃账号 = 全能板唯一权威账号 (1:1 同步)
// rt-flow 活跃号写在 ~/.wam/wam-state.json.activeEmail (切号即更新·跨窗口共享)。
// 全能板据此路由, 而非 IDE vscdb 登录态 — 二者可能错开 → 账号漂移(用户反馈核心缺陷)。
function getRtFlowActiveEmail(): string {
    try {
        const f = path.join(os.homedir(), '.wam', 'wam-state.json');
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return (j && typeof j.activeEmail === 'string') ? j.activeEmail.trim().toLowerCase() : '';
    } catch { return ''; }
}

// 归一·真源·1:1 · RT Flow 切号即把最新真 auth1 落盘 ~/.wam/devin_cloud/auth_cache.json。
// 全能板优先采此源(最鲜活·与切号面板同步), 本插件自有存储(dao-accounts-auth.json)作回退。
function loadRtFlowCachedAuth(email: string): SavedAccountAuth | null {
    const e = (email || '').trim().toLowerCase();
    if (!e) return null;
    try {
        const f = path.join(os.homedir(), '.wam', 'devin_cloud', 'auth_cache.json');
        const cache = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
        const hit = cache[e];
        if (hit && hit.auth1 && hit.orgId) {
            return {
                auth1: hit.auth1, orgId: hit.orgId, orgName: hit.orgName || '',
                orgSlug: hit.orgBare || String(hit.orgId).replace(/^org-/, ''),
                userId: hit.userId || '', accountId: '', apiKey: '', apiServerUrl: '',
                savedAt: hit.ts ? new Date(hit.ts).toISOString() : '',
            };
        }
    } catch { /* 守柔 */ }
    return null;
}

// 守柔 · 保留用户操作空间 — 账号同步 / 官网登录 的「自动 | 手动」模式
function getAccountSyncMode(): 'auto' | 'manual' {
    try { return vscode.workspace.getConfiguration('dao').get<string>('accountSyncMode', 'auto') === 'manual' ? 'manual' : 'auto'; } catch { return 'auto'; }
}
function getWebsiteLoginMode(): 'auto' | 'manual' {
    try { return vscode.workspace.getConfiguration('dao').get<string>('websiteLoginMode', 'auto') === 'manual' ? 'manual' : 'auto'; } catch { return 'auto'; }
}
// 守柔 · 写入账号同步模式 (auto|manual) — 供面板 UI 开关
async function setAccountSyncMode(mode: 'auto' | 'manual'): Promise<void> {
    try { await vscode.workspace.getConfiguration('dao').update('accountSyncMode', mode, vscode.ConfigurationTarget.Global); } catch { /* 守柔 */ }
}
// 自动注入自循环: 切账号时是否自动清理旧 org 注入 (默认 true, 用户可关)
function getInjectAutoCleanup(): boolean {
    try { return vscode.workspace.getConfiguration('dao').get<boolean>('injectAutoCleanup', true) !== false; } catch { return true; }
}
// 自动注入自循环: 应用期望态后是否顺手去重(同名知识/同标题剧本只留一份, 清旧版本残留) — 默认 true, 用户可关
function getInjectAutoDedupe(): boolean {
    try { return vscode.workspace.getConfiguration('dao').get<boolean>('injectAutoDedupe', true) !== false; } catch { return true; }
}
// 反向注入「先清后注」: 注入前先把该 org 内一切非锁定的旧注入残条全部清除, 仅保留
//   ① 期望态(本次将注入的 K/P/S/MCP/Automation) ② 单账号主页用户手动添加并锁定(setManualLock)的条目。
//   其余(历史异名/弃用/多余)一律清理 → 注入后该 org 恰为「期望态 ∪ 用户锁定项」。默认 true, 用户可关。
function getInjectReset(): boolean {
    try { return vscode.workspace.getConfiguration('dao').get<boolean>('injectReset', true) !== false; } catch { return true; }
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · 归零清理协同 — 帛书·「夫唯不争, 故无尤」
// RT Flow 对低额度账号「全量备份→水过无痕清理(→出库)」后, 在
//   ~/.wam/devin_cloud/cleanup_state.json 写 email→{cleanedAt}。
// 本系统据此抑制【一切自动反向注入】重新填充刚被清理/出库的账号:
//   切号自循环 · 批量注入(注入到所有账号) · 多账号缓存注入 · 内穿实时重注 一律跳过。
// 唯「用户主页·单账号手动注入」(injectCurrentNow / force) 显式绕过, 并记 reactivatedAt;
//   reactivatedAt >= cleanedAt 即解除抑制; 若 RT Flow 之后再次清理(cleanedAt 前移)则重新抑制 — 与清理时序自洽。
// 软编码: dao.injectSkipCleaned (默 true); 关之即恢复旧行为(清理后仍自动重注)。
// ═══════════════════════════════════════════════════════════
const RT_CLEANUP_STATE_FILE = path.join(os.homedir(), '.wam', 'devin_cloud', 'cleanup_state.json');
const INJECT_REACTIVATED_FILE = path.join(DAO_DIR, 'dao-inject-reactivated.json');
function getInjectSkipCleaned(): boolean {
    try { return vscode.workspace.getConfiguration('dao').get<boolean>('injectSkipCleaned', true) !== false; } catch { return true; }
}
// RT Flow 记录的该账号「清理完成」时刻 (ms); 0 = 从未被清理。
function rtCleanedAtForEmail(email: string): number {
    const e = (email || '').trim().toLowerCase();
    if (!e) return 0;
    try {
        const all = JSON.parse(fs.readFileSync(RT_CLEANUP_STATE_FILE, 'utf8')) || {};
        const st = all[e];
        const t = st && st.cleanedAt;
        return typeof t === 'number' ? t : 0;
    } catch { return 0; }
}
function loadInjectReactivated(): Record<string, number> {
    try { return JSON.parse(fs.readFileSync(INJECT_REACTIVATED_FILE, 'utf8')) || {}; } catch { return {}; }
}
// 用户主页单账号手动注入 → 记 reactivatedAt, 解除该账号的「已清理」自动注入抑制。
function markInjectReactivated(email: string): void {
    const e = (email || '').trim().toLowerCase();
    if (!e) return;
    try {
        const all = loadInjectReactivated();
        all[e] = Date.now();
        fs.mkdirSync(DAO_DIR, { recursive: true });
        fs.writeFileSync(INJECT_REACTIVATED_FILE, JSON.stringify(all, null, 2), 'utf8');
    } catch { /* 守柔 */ }
}
// 是否抑制对该账号的【自动】反向注入: RT Flow 已清理(cleanedAt>0) 且此后用户未手动重注(reactivatedAt < cleanedAt)。
function isInjectSuppressedForEmail(email: string): boolean {
    if (!getInjectSkipCleaned()) return false;
    const cleanedAt = rtCleanedAtForEmail(email);
    if (!cleanedAt) return false;
    const re = loadInjectReactivated()[(email || '').trim().toLowerCase()] || 0;
    return re < cleanedAt;
}
// org → email 反查 (自循环仅持有 orgId 时用); 取账号缓存 auth 库的反向映射。
function emailForOrg(orgId: string): string {
    if (!orgId) return '';
    try {
        const store = loadAccountsAuthStore();
        for (const e of Object.keys(store)) { const a = store[e]; if (a && a.orgId === orgId) return e; }
    } catch { /* 守柔 */ }
    return '';
}

// ═══════════════════════════════════════════════════════════
// 江海所以能为百谷王者，以其善下之 — 插件本体对本机 Agent 暴露
// 导出一份 MD 文档: 实时运行态 + 后端全部可操作 API 契约 + 调用示例
// 本机其他 Agent 读此文档即可经 :PORT 后端接口完美操作本插件、替用户配置一切
// ═══════════════════════════════════════════════════════════
interface AgentApiEndpoint { method: string; path: string; body?: string; desc: string; }
function agentApiCatalog(): { group: string; items: AgentApiEndpoint[] }[] {
    return [
        { group: '状态 / 运行态 (无需登录)', items: [
            { method: 'GET', path: '/api/health', desc: '服务存活、端口、版本、relay、uptime' },
            { method: 'GET', path: '/api/connection', desc: '本机连接信息 (url/token/port/hostname)' },
            { method: 'GET', path: '/api/devin/state', desc: '当前窗口完整 Devin Cloud 状态 (邮箱/org/凭证是否就绪/配额)' },
            { method: 'GET', path: '/api/devin/status', desc: '登录态 + org + 凭证类型' },
            { method: 'GET', path: '/api/workspaces', desc: '本机所有 IDE 窗口 ↔ 账号映射注册表' },
            { method: 'GET', path: '/api/agent-doc', desc: '本文档 (markdown 文本)' },
            { method: 'GET', path: '/api/manifest', desc: '机器可读的能力清单 (JSON)' },
        ]},
        { group: '账号 (登录 / 配额)', items: [
            { method: 'POST', path: '/api/devin/login', body: '{"email":"..","password":".."}', desc: '手动登录指定账号 (换取 auth1)' },
            { method: 'GET', path: '/api/devin/quota', desc: '刷新并返回配额' },
        ]},
        { group: 'Sessions (会话 · 读 + 反向操作)', items: [
            { method: 'GET', path: '/api/devin/sessions?limit=50', desc: '列出会话' },
            { method: 'POST', path: '/api/devin/session/create', body: '{"message":"..","opts":{}}', desc: '新建会话并发送 prompt' },
            { method: 'GET', path: '/api/devin/session/detail?id=devin-xxx', desc: '会话详情' },
            { method: 'GET', path: '/api/devin/session/messages?id=devin-xxx', desc: '会话消息' },
            { method: 'GET', path: '/api/devin/session/download?id=devin-xxx', desc: '导出会话为 md' },
            { method: 'POST', path: '/api/devin/session/delete', body: '{"id":"devin-xxx"}', desc: '删除/归档会话' },
        ]},
        { group: 'Secrets (读 + 反向注入/替换/删除)', items: [
            { method: 'GET', path: '/api/devin/secrets', desc: '列出 secrets' },
            { method: 'POST', path: '/api/devin/secrets/inject', body: '{"name":"..","value":"..","upsert":true}', desc: '注入; upsert=true 时有则替换无则新增' },
            { method: 'POST', path: '/api/devin/secrets/delete', body: '{"name":".."}', desc: '删除 secret' },
        ]},
        { group: 'Knowledge (读 + 反向注入/替换/删除)', items: [
            { method: 'GET', path: '/api/devin/knowledge', desc: '列出 knowledge' },
            { method: 'POST', path: '/api/devin/knowledge/inject', body: '{"name":"..","body":"..","triggerDescription":"..","upsert":true}', desc: '注入; upsert 有则替换无则新增' },
            { method: 'POST', path: '/api/devin/knowledge/delete', body: '{"id":".."}', desc: '删除 knowledge' },
        ]},
        { group: 'Playbooks (读 + 反向注入/替换/删除)', items: [
            { method: 'GET', path: '/api/devin/playbooks', desc: '列出 playbooks' },
            { method: 'POST', path: '/api/devin/playbooks/inject', body: '{"title":"..","body":"..","upsert":true}', desc: '注入; upsert 有则替换无则新增' },
            { method: 'POST', path: '/api/devin/playbooks/delete', body: '{"id":".."}', desc: '删除 playbook' },
        ]},
        { group: '批量多账号反向注入 (道法自然准则 + 内网穿透 + 剧本 + DAO_TOKEN)', items: [
            { method: 'POST', path: '/api/devin/batch-inject', body: '{"all":true}  或  {"accounts":[{"email","password"}]}  或  {"lines":"a@x:pw\\nb@y:pw"}  (+"wait":true 同步)', desc: '逐账号幂等注入(缓存auth优先·先收敛旧异名残条·回读校验); 默认后台异步' },
            { method: 'GET', path: '/api/devin/batch-inject/status', desc: '批量注入进度/每账号结果' },
        ]},
        { group: 'MCP (读 + 接测 + 追录/删除)', items: [
            { method: 'GET', path: '/api/devin/mcp/installations', desc: '列出已安装 MCP' },
            { method: 'GET', path: '/api/devin/mcp/ide', desc: '扫描本机 IDE 内已配 MCP (接龙 Devin Desktop⇄Windsurf + Cursor 等, 纯本地无需登录)' },
            { method: 'GET', path: '/api/devin/mcp/marketplace', desc: '官网 MCP 市场目录' },
            { method: 'POST', path: '/api/devin/mcp/probe', body: '{"transport":"HTTP","url":"..","headers":{}}  或  {"command":"..","args":[]}', desc: '单项接测(连接验证): HTTP/SSE 走 initialize·直连不通自动经本机代理隧道复测; STDIO 验运行时+脚本就绪' },
            { method: 'GET', path: '/api/devin/mcp/probe-all', desc: '全量接测本机 IDE MCP, 返回每项 ok/status/label/detail' },
            { method: 'POST', path: '/api/devin/mcp/repair', body: '{"allIdes":false,"enable":true,"dryRun":false}', desc: '一键修复本机 MCP(通用·强鲁棒): 自动识别 node 运行时与模块路径、修正命令并启用(先备份原配置)。dryRun 仅预演返回改动计划' },
            { method: 'POST', path: '/api/devin/mcp/verify', body: '{"source":"Devin Desktop","all":false}', desc: '实测使用: 逐本机 STDIO MCP 真起进程 initialize+tools/list 返回真实工具数(HTTP 走 initialize 接测)' },
            { method: 'POST', path: '/api/devin/mcp/add', body: '{"name":"GitHub MCP","transport":"HTTP","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer .."}}', desc: '追录自定义 MCP (HTTP/SSE 或 STDIO: command/args/env_variables)' },
            { method: 'POST', path: '/api/devin/mcp/install', body: '{"marketplace_server_id":".."}  或  {"slug":".."}', desc: '安装一个市场目录项到本账号' },
            { method: 'POST', path: '/api/devin/mcp/delete', body: '{"id":"mcp-installation-.."}', desc: '删除 MCP 安装' },
        ]},
        { group: '多实例 (路由官网 · 插件本体能力作为 API 暴露)', items: [
            { method: 'POST', path: '/api/devin/multi/panel', desc: 'IDE 内打开当前账号独立路由面板 (多实例·不阻塞)' },
            { method: 'POST', path: '/api/devin/multi/open', body: '{"email":"a@x","mode":"ide"}  (mode=sys 走电脑浏览器隔离窗口)', desc: '路由指定账号官网多实例 (等价主页/切号面板的多实例按钮)' },
            { method: 'POST', path: '/api/devin/multi/conv', body: '{"email":"a@x","devinId":"devin-xxx","mode":"ide"}', desc: '多实例打开某账号的具体对话官网' },
        ]},
        { group: '额度 / 集成 / 全量注入', items: [
            { method: 'POST', path: '/api/devin/usage/limit', body: '{"maxCredits":30}', desc: '设单条消息额度上限 (max_credits)' },
            { method: 'GET', path: '/api/devin/git/connections', desc: 'Git 集成连接状态' },
            { method: 'POST', path: '/api/devin/git/connect', body: '{"pat":"ghp_.."}', desc: '连接 GitHub PAT' },
            { method: 'POST', path: '/api/devin/git/disconnect', body: '{"connectionId":".."}', desc: '断开 Git 集成' },
            { method: 'POST', path: '/api/devin/inject', desc: '一键全量注入 (Secret/Knowledge/Playbook/规则)' },
            { method: 'POST', path: '/api/devin/reconcile-pool', desc: '全池反向注入核对 · 立即强制(账号库实时检测闭环手动触发)' },
        ]},
        { group: 'IDE 控制 (本机工作区)', items: [
            { method: 'POST', path: '/api/exec', body: '{"cmd":"ls"}', desc: '在 IDE 终端执行命令并回收输出' },
            { method: 'GET', path: '/api/file?path=/abs/path', desc: '读文件' },
            { method: 'POST', path: '/api/write', body: '{"path":"/abs","content":".."}', desc: '写文件' },
            { method: 'POST', path: '/api/search', body: '{"pattern":"**/*.ts"}', desc: '搜索文件' },
            { method: 'GET', path: '/api/workspace', desc: '工作区/打开编辑器/诊断' },
        ]},
    ];
}

function buildAgentApiDoc(): string {
    const base = ws.publicUrl || ('http://localhost:' + (ws.port || DEFAULT_PORT));
    const fence = '\u0060\u0060\u0060';
    const L: string[] = [];
    const now = new Date().toISOString();
    L.push('# dao-vsix · 本机 Agent 操作契约 (Agent Operating Manifest)');
    L.push('');
    L.push('> 江海所以能为百谷王者，以其善下之。本插件把「用户在面板里能做的一切」全部以本地 HTTP 接口暴露在本机，');
    L.push('> 任何本机 Agent 读完本文档即可经下述接口**完美操作本插件**、替用户读取/反向注入/替换/清除 Devin 账号里的所有模块配置。');
    L.push('');
    L.push('导出时间: `' + now + '`  ·  插件版本: `' + (EXT_VERSION) + '`');
    L.push('');
    L.push('## 1. 连接与鉴权');
    L.push('');
    L.push('- Base URL: `' + base + '`' + (ws.relayConnected && ws.publicUrl ? ' (公网 relay)' : ' (本机回环)'));
    L.push('- 鉴权: 每个请求带 `Authorization: Bearer <TOKEN>` 头，或在 URL 加 `?master_token=<TOKEN>`。');
    L.push('- 当前 TOKEN: `' + (ws.token || '(server 未启动)') + '`');
    L.push('- TOKEN 持久化于: `' + (ws.tokenFile || '~/.dao/workspaces/<key>/token') + '`');
    L.push('- 回环只读豁免(无需 token): `/api/health`、`/api/workspace`、`/api/agents`。其余需 token。');
    L.push('- 全部返回 JSON。写操作多支持 `upsert`(有则替换、无则新增) — 即「账号变来变去都能注入/替换」。');
    L.push('');
    L.push('## 2. 实时运行态 (导出瞬时快照)');
    L.push('');
    L.push(fence + 'json');
    L.push(JSON.stringify({
        loggedIn: !!ws.devinAuth1,
        accountSyncMode: getAccountSyncMode(),
        websiteLoginMode: getWebsiteLoginMode(),
        devinEmail: ws.devinEmail || '',
        devinOrgName: ws.devinOrgName || ws.devinOrgSlug || '',
        devinOrgId: ws.devinOrgId || '',
        auth1Ready: !!ws.devinAuth1,
        port: ws.port || 0,
        relay: ws.relayConnected ? (ws.publicUrl || 'connected') : 'local',
        quota: ws.devinQuota || null,
        injectProfile: (() => { try { const p = loadInjectProfile(); return { enabled: p.enabled, mcps: p.mcps.map(m => m.name), messageLimit: p.messageLimit, secrets: p.secrets.length, knowledge: p.knowledge.length, playbooks: p.playbooks.length }; } catch { return null; } })()
    }, null, 2));
    L.push(fence);
    L.push('');
    L.push('> 上述为导出瞬时值。实时值请随时 `GET /api/devin/state`。');
    L.push('');
    L.push('## 3. 后端接口目录');
    L.push('');
    for (const g of agentApiCatalog()) {
        L.push('### ' + g.group);
        L.push('');
        L.push('| Method | Path | Body | 说明 |');
        L.push('| --- | --- | --- | --- |');
        for (const e of g.items) {
            L.push('| `' + e.method + '` | `' + e.path + '` | ' + (e.body ? '`' + e.body + '`' : '—') + ' | ' + e.desc + ' |');
        }
        L.push('');
    }
    L.push('## 4. 调用示例 (curl)');
    L.push('');
    L.push(fence + 'bash');
    L.push('BASE="' + base + '"');
    L.push('TOK="' + (ws.token || 'YOUR_TOKEN') + '"');
    L.push('# 读取当前账号 knowledge');
    L.push('curl -s "$BASE/api/devin/knowledge" -H "Authorization: Bearer $TOK"');
    L.push('# 反向注入(有则替换无则新增)一条 knowledge');
    L.push('curl -s -X POST "$BASE/api/devin/knowledge/inject" -H "Authorization: Bearer $TOK" \\');
    L.push('  -H "Content-Type: application/json" \\');
    L.push('  -d \'{"name":"Deploy Guide","body":"...","triggerDescription":"when deploying","upsert":true}\'');
    L.push('# 钉一个 GitHub MCP 到当前账号');
    L.push('curl -s -X POST "$BASE/api/devin/mcp/add" -H "Authorization: Bearer $TOK" \\');
    L.push('  -H "Content-Type: application/json" \\');
    L.push('  -d \'{"name":"GitHub MCP","transport":"HTTP","url":"https://api.githubcopilot.com/mcp/"}\'');
    L.push('# 设单条消息额度上限为 30');
    L.push('curl -s -X POST "$BASE/api/devin/usage/limit" -H "Authorization: Bearer $TOK" \\');
    L.push('  -H "Content-Type: application/json" -d \'{"maxCredits":30}\'');
    L.push(fence);
    L.push('');
    L.push('## 5. 给 Agent 的使用建议');
    L.push('');
    L.push('1. 先 `GET /api/devin/state` 确认 `auth1Ready=true` 且 `devinEmail` 是目标账号。');
    L.push('2. 配置类写操作一律带 `upsert:true`，实现幂等(账号切换也安全)。');
    L.push('3. 账号是否跟随 IDE 由 `accountSyncMode` 决定(auto=跟随, manual=用户自控)。需独立操作某账号时先确保 manual 或显式 `POST /api/devin/login`。');
    L.push('4. 所有操作都对应官网真实后端，写入后可在 app.devin.ai 对应页面核验。');
    L.push('');
    return L.join('\n');
}

function buildAgentManifest(): any {
    return {
        ok: true,
        service: 'dao-vsix',
        version: EXT_VERSION,
        generatedAt: new Date().toISOString(),
        baseUrl: ws.publicUrl || ('http://localhost:' + (ws.port || DEFAULT_PORT)),
        auth: { scheme: 'Bearer', header: 'Authorization', queryParam: 'master_token', token: ws.token || '' },
        state: {
            loggedIn: !!ws.devinAuth1, accountSyncMode: getAccountSyncMode(), websiteLoginMode: getWebsiteLoginMode(),
            devinEmail: ws.devinEmail || '', devinOrgId: ws.devinOrgId || '', devinOrgName: ws.devinOrgName || ws.devinOrgSlug || '',
            port: ws.port || 0, relay: ws.relayConnected ? 'connected' : 'local'
        },
        endpoints: agentApiCatalog().flatMap(g => g.items.map(e => ({ group: g.group, method: e.method, path: e.path, body: e.body || null, desc: e.desc })))
    };
}

// 导出 Agent 文档到本机文件并打开 — 帛书·「善下之」
async function exportAgentDocToFile(): Promise<string> {
    const md = buildAgentApiDoc();
    const outPath = path.join(DAO_DIR, 'dao-agent-api.md');
    try { fs.mkdirSync(DAO_DIR, { recursive: true }); } catch { /* 守柔 */ }
    fs.writeFileSync(outPath, md, 'utf8');
    return outPath;
}

// 据 IDE 注入的 session token 解析当前登录 email — GetUserStatus 权威 whoami
// 帛书·「不出於戶以知天下」— session token JWT 只含 session_id, 必须经 API 解析
async function resolveActiveEmailFromToken(token: string): Promise<{ email: string; accountId: string } | null> {
    const enriched = await enrichCredentialsFromCodeiumAPI(token);
    if (enriched && enriched.email) {
        // teamId(devin-team$account-XXX) → accountId(account-XXX)
        let accountId = '';
        if (enriched.userId) accountId = enriched.userId;
        return { email: enriched.email, accountId };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · 自愈重试 — 帛书·「反者道之动」「守柔曰强」「功遂身退」
// 启动之初, 账号池文件 / IDE 凭证 / 本地代理 或尚未就绪, 首次自动链
// 可能取不到密码或网络瞬断, 落入 session-token 兜底(非可注入)。
// 故以退为进: 按 3s→8s→20s→45s 退避重试 devinAutoChain, 直至取得
// 可注入 auth1(路径B 五步登录成功)即止。用户无为, 系统自行收敛到已认证态。
// ═══════════════════════════════════════════════════════════
function daoHasInjectableAuth1(): boolean {
    return !!ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$');
}
function scheduleAutoChainHeal(fresh: boolean = false): void {
    if (_autoHealTimer) return;                              // 已在自愈中 — 知止不殆
    if (daoHasInjectableAuth1()) return;                     // 已得真 auth1 — 功遂身退
    if (fresh) _autoHealAttempts = 0;                        // 新触发(启动/切号)→ 重置退避
    if (_autoHealAttempts >= AUTO_HEAL_DELAYS.length) return; // 退避耗尽 — 不强为
    const delay = AUTO_HEAL_DELAYS[_autoHealAttempts++];
    _autoHealTimer = setTimeout(async () => {
        _autoHealTimer = null;
        if (daoHasInjectableAuth1()) return;
        try {
            const ok = await devinAutoChain();
            if (ok && daoHasInjectableAuth1()) {
                try { if (ws.port && ws.devinOrgId) await devinFullInject(); } catch { /* 守柔 */ }
                sidebarCloudPanel?.refresh();
                refreshDaoCloudMiddlePanel();
                updateStatusBar();
                return;                                      // 收敛 — 不再重试
            }
        } catch { /* 守柔 */ }
        scheduleAutoChainHeal();                             // 未就绪 → 继续退避
    }, delay);
}

async function devinAutoChain(): Promise<boolean> {
    // ═══════════════════════════════════════════════════════════
    // 道法自然 · 零配置自动链 — 帛书·六十二「道者万物之注」
    // 真源链: vscdb session token → GetUserStatus 取 email → 账号池查密码
    //          → 五步登录换 auth1 → 真实 org → 全功能面板可用
    // 窗口 = 工作区 = 账号 — 一次认证，自动注入一切
    // ═══════════════════════════════════════════════════════════

    // ═══ 本源·账号实时同源: 先确定 IDE 当前登录邮箱(权威主键, 一切以它为准) ═══
    let currentIdeEmail = '';
    let ideToken = '';
    try {
        const wsCreds0 = readWindsurfCredentials(true);
        ideToken = (wsCreds0 && wsCreds0.apiKey) || '';
        const regexEmail = (wsCreds0 && wsCreds0.email) || '';
        // 权威 whoami: session token 必经 GetUserStatus 解析当前登录 email。
        // 帛书·「不出於戶以知天下」— 决不信任 vscdb 全二进制正则:
        // 切号后旧账号 windsurf_auth-<旧email>-usages 残留, 正则取第一个匹配可能命中旧账号 → 串号。
        if (ideToken && ideToken.startsWith('devin-session-token$')) {
            try {
                const resolved = await resolveActiveEmailFromToken(ideToken);
                if (resolved && resolved.email) currentIdeEmail = resolved.email;
            } catch { /* 守柔 */ }
        }
        // 兜底: API 不可达时才退回正则邮箱(聊胜于无, 不阻断流程)
        if (!currentIdeEmail) currentIdeEmail = regexEmail;
    } catch { /* 守柔 */ }
    // 即刻反映当前 IDE 账号 — 即便后续换不到 auth1, 面板也显示正确账号(永不串号)
    if (currentIdeEmail) ws.devinEmail = currentIdeEmail;

    // 归一·真源·1:1 · auto 模式下 RT Flow 活跃号为权威键 — 全能板完全跟随切号面板,
    // 而非 IDE vscdb 登录态(二者可能错开)。manual 模式保留用户自控(单号粘贴不被覆盖)。
    if (getAccountSyncMode() !== 'manual') {
        const rtEmail = getRtFlowActiveEmail();
        if (rtEmail) { currentIdeEmail = rtEmail; ws.devinEmail = rtEmail; }
    }

    // 路径A (最快·自循环): 按邮箱持久化的真 auth1 命中 → 切回旧账号即刻复用, 无需重登
    // 归一·真源·1:1 · auto 模式优先采 RT Flow 切号落盘的最新 auth1 (auth_cache.json),
    // 本插件自有存储作回退 — 确保全能板与切号面板用同一鲜活令牌, 永不因旧令牌失效而判未登录。
    if (currentIdeEmail) {
        try {
            const saved = (getAccountSyncMode() !== 'manual' ? loadRtFlowCachedAuth(currentIdeEmail) : null) || loadAccountAuth(currentIdeEmail);
            if (saved && saved.auth1 && saved.orgId) {
                ws.devinAuth1 = saved.auth1; ws.devinOrgId = saved.orgId;
                ws.devinOrgName = saved.orgName || ''; ws.devinOrgSlug = saved.orgSlug || '';
                ws.devinUserId = saved.userId || ''; ws.devinAccountId = saved.accountId || '';
                ws.devinApiKey = saved.apiKey || ''; ws.devinApiServerUrl = saved.apiServerUrl || '';
                ws.devinEmail = currentIdeEmail;
                const quota = await devinFetchQuota(ws.devinApiKey || ws.devinAuth1);
                if (quota && quota !== false) {
                    ws.devinQuota = quota; ws.devinSaveConfig();
                    saveAccountAuth(currentIdeEmail); // 鲜活令牌回写本插件存储, 二源归一
                    if (!(ws.devinApiKey || '').startsWith('cog_')) { try { await devinEnsureCogApiKey(ws.devinOrgId, ws.devinAuth1); } catch {} }
                    return true;
                }
                // 道法自然 · 持久化: 仅凭证确认失效(false)时清除; 网络不可达(null)保留登录态
                if (quota === false) { ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinApiKey = ''; }
                else { ws.devinSaveConfig(); return true; } // 网络离线 → 保留凭证, 视为已登录(额度离线)
            }
        } catch { /* 守柔 */ }
    }

    // 路径B (账号池五步登录): 据 IDE 邮箱查密码 → 换真 auth1 → 持久化(下次走路径A)
    if (currentIdeEmail) {
        try {
            const pw0 = findAccountPassword(currentIdeEmail);
            if (pw0) {
                const lr = await devinLogin(currentIdeEmail, pw0);
                if (lr.ok) {
                    saveAccountAuth(currentIdeEmail);
                    vscode.window.showInformationMessage('Devin Cloud 自动登录成功 (账号池·' + currentIdeEmail + ')');
                    return true;
                }
            }
        } catch { /* 守柔 */ }
    }

    // 路径C: 已保存的【本工作区】凭证 — 仅当邮箱与当前 IDE 账号一致才恢复(绝不串号)
    // 帛书·「知止不殆」: IDE 账号已切走时, 决不退回旧账号的 auth1。
    try {
        const cfg = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
        const cfgEmail = (cfg.devinEmail || '').trim().toLowerCase();
        const sameAccount = !currentIdeEmail || cfgEmail === currentIdeEmail.trim().toLowerCase();
        if (sameAccount && cfg.devinAuth1 && cfg.devinOrgId) {
            ws.devinAuth1 = cfg.devinAuth1;
            ws.devinOrgId = cfg.devinOrgId;
            ws.devinOrgName = cfg.devinOrgName || '';
            ws.devinOrgSlug = cfg.devinOrgSlug || '';
            ws.devinEmail = cfg.devinEmail || currentIdeEmail || '';
            ws.devinSessionToken = cfg.devinSessionToken || '';
            ws.devinApiKey = cfg.devinApiKey || '';
            ws.devinApiServerUrl = cfg.devinApiServerUrl || '';
            ws.devinAccountId = cfg.devinAccountId || '';
            ws.devinUserId = cfg.devinUserId || '';
            ws.devinQuota = cfg.devinQuota || null;
            // Verify token still valid — 帛书·七十一「知不知尚矣」
            const quota = await devinFetchQuota(ws.devinApiKey || ws.devinAuth1);
            if (quota && quota !== false) {
                ws.devinQuota = quota;
                if (ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$')) {
                    saveAccountAuth(ws.devinEmail);
                    if (!(ws.devinApiKey || '').startsWith('cog_')) { try { await devinEnsureCogApiKey(ws.devinOrgId, ws.devinAuth1); } catch {} }
                }
                return true;
            }
            // 道法自然 · 持久化: 仅凭证确认失效(false)时清除; 网络不可达(null)保留登录态
            if (quota === false) { ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinSessionToken = ''; ws.devinApiKey = ''; }
            else { return true; } // 网络离线 → 保留凭证, 视为已登录
        }
    } catch {}

    // 路径2: Windsurf凭证自动登录 — 帛书·六十二「道者万物之注」
    const wsCreds = readWindsurfCredentials();
    if (wsCreds) {
        // 子路径2a: 有email+password → 五步链完整登录
        if (wsCreds.email && wsCreds.password) {
            try {
                const loginResult = await devinLogin(wsCreds.email, wsCreds.password);
                if (loginResult.ok) {
                    saveAccountAuth(wsCreds.email);
                    vscode.window.showInformationMessage('Devin Cloud 自动登录成功 (Windsurf凭证)');
                    return true;
                }
            } catch {}
        }
        // 子路径2b: 有apiKey → 获取cog_ API Key用于Devin API
        // 帛书·「反者道之动也」— devin-session-token$仅Codeium API可用
        // Devin API需要cog_前缀的API Key — 必须通过RegisterUser获取
        if (wsCreds.apiKey && (wsCreds.apiKey.startsWith('sk-') || wsCreds.apiKey.startsWith('devin-session-token$'))) {
            try {
                ws.devinApiKey = wsCreds.apiKey;
                ws.devinApiServerUrl = '';
                ws.devinEmail = wsCreds.email || currentIdeEmail || ws.devinEmail || '';
                // 异步从 Codeium API 获取完整用户信息 — 帛书·「不出於戶以知天下」
                const enriched = await enrichCredentialsFromCodeiumAPI(wsCreds.apiKey);
                if (enriched) {
                    if (enriched.email) ws.devinEmail = enriched.email;
                    if (enriched.orgId) ws.devinOrgId = enriched.orgId;
                    if (enriched.userId) ws.devinAccountId = enriched.userId;
                    if (enriched.name) ws.devinOrgName = enriched.name;
                }
                // session token 也可以作为 Bearer token 获取 quota (Codeium API)
                const quota = await devinFetchQuota(ws.devinApiKey);
                if (quota) {
                    ws.devinQuota = quota;
                    ws.devinAuth1 = wsCreds.apiKey;
                    ws.devinSessionToken = wsCreds.apiKey;
                    
                    // ★ 核心修复: 调用RegisterUser获取cog_ API Key — 帛书·「道生一」
                    // devin-session-token$的JWT部分可作为firebase_id_token
                    // RegisterUser返回cog_ API Key → 可访问Devin API所有端点
                    if (wsCreds.apiKey.startsWith('devin-session-token$')) {
                        const jwtPart = wsCreds.apiKey.substring(20); // 去掉devin-session-token$前缀(20字符)
                        try {
                            const r4 = await devinJsonPost(DEVIN_URL_REGISTER, { 'Connect-Protocol-Version': '1' }, { firebase_id_token: jwtPart });
                            if (r4.status === 200 && r4.json) {
                                const j4 = r4.json;
                                const cogKey = j4.api_key || j4.apiKey || '';
                                const apiServerUrl = j4.api_server_url || j4.apiServerUrl || '';
                                if (cogKey && cogKey.startsWith('cog_')) {
                                    // ★ 获得cog_ API Key — Devin API完全可用！
                                    ws.devinApiKey = cogKey;
                                    ws.devinApiServerUrl = apiServerUrl;
                                    vscode.window.showInformationMessage('Devin Cloud: 获得API Key (cog_) — Devin API完全可用');
                                } else if (cogKey) {
                                    // 非cog_ key但仍保存
                                    ws.devinApiKey = cogKey;
                                    ws.devinApiServerUrl = apiServerUrl;
                                }
                            }
                        } catch {}
                    }
                    
                    // 尝试通过 post-auth 获取更多凭证
                    try {
                        const r3 = await devinJsonPost(DEVIN_URL_DEVIN_POST_AUTH, {
                            Authorization: 'Bearer ' + wsCreds.apiKey,
                            'Content-Type': 'application/json',
                            'X-Devin-Auth1-Token': wsCreds.apiKey,
                            'Connect-Protocol-Version': '1',
                            'Origin': DEVIN_APP,
                            'Referer': DEVIN_APP + '/profile',
                        }, { auth1_token: wsCreds.apiKey });
                        if (r3.status === 200 && r3.json) {
                            const j3 = r3.json;
                            const orgId = (j3.org && j3.org.org_id) || j3.org_id || j3.primaryOrgId || '';
                            if (orgId) { ws.devinOrgId = orgId; }
                            if (j3.org && j3.org.org_name) { ws.devinOrgName = j3.org.org_name; }
                            if (j3.org && j3.org.org_slug) { ws.devinOrgSlug = j3.org.org_slug; }
                            if (j3.accountId) { ws.devinAccountId = j3.accountId; }
                            if (j3.sessionToken) { ws.devinSessionToken = j3.sessionToken; }
                        }
                    } catch {}
                    ws.devinSaveConfig();
                    const tokenType = ws.devinApiKey.startsWith('cog_') ? 'cog_ API Key' : (wsCreds.apiKey.startsWith('devin-session-token$') ? 'Session Token' : 'API Key');
                    vscode.window.showInformationMessage('Devin Cloud 认证成功 (' + tokenType + ')');
                    return true;
                }
            } catch {}
        }
        // 子路径2c: 有email+apiKey(firebase token) → 尝试注册获取完整凭证
        if (wsCreds.email && wsCreds.apiKey && wsCreds.apiKey.length > 50) {
            try {
                const r4 = await devinJsonPost(DEVIN_URL_REGISTER, { 'Connect-Protocol-Version': '1' }, { firebase_id_token: wsCreds.apiKey });
                if (r4.status === 200 && r4.json) {
                    const j4 = r4.json;
                    const apiKey = j4.api_key || j4.apiKey || wsCreds.apiKey;
                    const apiServerUrl = j4.api_server_url || j4.apiServerUrl || '';
                    // Now try to get full auth via post-auth
                    const r3 = await devinJsonPost(DEVIN_URL_DEVIN_POST_AUTH, { Authorization: 'Bearer ' + wsCreds.apiKey, 'Content-Type': 'application/json' }, {});
                    if (r3.status === 200 && r3.json) {
                        const j3 = r3.json;
                        const orgId = (j3.org && j3.org.org_id) || j3.org_id || '';
                        if (orgId) {
                            ws.devinAuth1 = wsCreds.apiKey;
                            ws.devinOrgId = orgId;
                            ws.devinOrgName = (j3.org && j3.org.org_name) || '';
                            ws.devinOrgSlug = (j3.org && j3.org.org_slug) || '';
                            ws.devinEmail = wsCreds.email;
                            ws.devinSessionToken = wsCreds.apiKey;
                            ws.devinApiKey = apiKey;
                            ws.devinApiServerUrl = apiServerUrl;
                            ws.devinQuota = await devinFetchQuota(apiKey, apiServerUrl).catch(() => null);
                            ws.devinSaveConfig();
                            saveAccountAuth(wsCreds.email);
                            vscode.window.showInformationMessage('Devin Cloud 自动登录成功 (Windsurf Token)');
                            return true;
                        }
                    }
                }
            } catch {}
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════
// 统一认证 · Windsurf凭证读取 — 帛书·六十二「道者万物之注」
// 读取Windsurf/Codeium本地存储的登录凭证
// 道法自然: 用户已登录Windsurf → 自动识别 → 无需重复登录
// ═══════════════════════════════════════════════════════════

interface WindsurfCredentials {
    email?: string;
    apiKey?: string;
    password?: string;
    source?: string;
    // 道法自然 · Codeium GetUserStatus API 扩展字段
    // 帛书·三十九「致数与无与」— 从 teamId 提取 orgId
    orgId?: string;      // org-{uuid} 从 teamId 提取
    userId?: string;     // user-{uuid}
    name?: string;       // 显示名
    teamsTier?: string;  // TEAMS_TIER_DEVIN_TRIAL 等
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · Node.js原生vscdb读取 — 帛书·「不出於戶以知天下」
// 无需Python依赖 — 直接从SQLite二进制文件提取JSON值
// vscdb格式: SQLite → ItemTable → key/value → windsurfAuthStatus
// ═══════════════════════════════════════════════════════════

function readVscdbNative(dbPath: string): { apiKey: string; email: string } | null {
    try {
        const buf = fs.readFileSync(dbPath);
        const s = buf.toString('latin1');
        // 帛书·「见小曰明」— 精确提取apiKey，不混入SQLite相邻数据
        // 根因: vscdb二进制中JSON值可能紧邻其他记录，{}深度匹配会跨越边界
        // 修复: 逐字符扫描JSON字符串值，遇到非ASCII(0x80+)或控制字符(0x00-0x1F)立即停止
        let searchIdx = 0;
        const validTokens: string[] = [];
        while (searchIdx < s.length) {
            const keyIdx = s.indexOf('"apiKey"', searchIdx);
            if (keyIdx < 0) break;
            searchIdx = keyIdx + 8;
            // 找到冒号后的值开始引号
            const colonIdx = s.indexOf(':', keyIdx);
            if (colonIdx < 0 || colonIdx - keyIdx > 20) continue;
            const valQuoteStart = s.indexOf('"', colonIdx);
            if (valQuoteStart < 0 || valQuoteStart - colonIdx > 10) continue;
            // 逐字符扫描值 — 只接受可打印ASCII(0x20-0x7E)，遇到非法字符停止
            let valEnd = valQuoteStart + 1;
            while (valEnd < s.length && valEnd < valQuoteStart + 500) {
                const ch = s.charCodeAt(valEnd);
                if (ch < 0x20 || ch > 0x7E) break; // 非法字符 → 值到此结束
                if (s[valEnd] === '"') break;       // 正常结束引号
                valEnd++;
            }
            const rawValue = s.substring(valQuoteStart + 1, valEnd);
            if (rawValue.length < 20) continue; // 太短，不是有效token
            // 验证token格式 — 帛书·「知常容·容乃公」
            if (rawValue.startsWith('cog_')) {
                // cog_ API Key — Devin v3 API正式Token
                validTokens.push(rawValue);
            } else if (rawValue.startsWith('devin-session-token$')) {
                // Windsurf session token — 验证JWT部分是有效base64
                // 'devin-session-token$' 恰为 20 字符 — substring(20) 保留完整 JWT(eyJ…)
                const jwt = rawValue.substring(20);
                const parts = jwt.split('.');
                if (parts.length >= 3) {
                    const cleanJwt = parts.slice(0, 3).join('.');
                    const cleanToken = 'devin-session-token$' + cleanJwt;
                    // 验证每个部分都是有效base64
                    if (parts.slice(0, 3).every(p => /^[A-Za-z0-9+\/=_-]+$/.test(p))) {
                        validTokens.push(cleanToken);
                    }
                }
            } else if (rawValue.startsWith('sk-')) {
                validTokens.push(rawValue);
            }
        }
        if (validTokens.length === 0) return null;
        // 优先使用cog_ token — 帛书·「上德不德·是以有德」
        const cogToken = validTokens.find(t => t.startsWith('cog_'));
        const apiKey = cogToken || validTokens[0];
        let email = '';
        const emailMatch = s.match(/windsurf_auth-([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})-usages/);
        if (emailMatch) email = emailMatch[1];
        return { apiKey, email };
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · vscdb 凭证缓存 — 帛书·五十四「善建者不拔」
// execSync 调用 Python 会阻塞扩展宿主 → 必须缓存
// 启动时读取一次，后续使用缓存值
// ═══════════════════════════════════════════════════════════
let cachedVscdbCreds: WindsurfCredentials | null = null;
let vscdbCredsReadAt: number = 0;
const VSCDB_CACHE_TTL = 60000; // 60秒缓存

function readWindsurfCredentials(forceRefresh?: boolean): WindsurfCredentials | null {
    // ═══════════════════════════════════════════════════════════
    // 道法自然 · 统一凭证读取 — 帛书·六十二「道者万物之注」
    // 反者道之动: 从 vscdb 底层读取，而非表面文件
    // 优先级: vscdb > cascade-auth.json > Codeium > 环境变量
    // ═══════════════════════════════════════════════════════════

    // 缓存检查 — 避免每次 UI 刷新都调用 Python 阻塞扩展宿主
    if (!forceRefresh && cachedVscdbCreds && (Date.now() - vscdbCredsReadAt) < VSCDB_CACHE_TTL) {
        return cachedVscdbCreds;
    }

    // 路径0 (最高优先): state.vscdb → windsurfAuthStatus
    // 这是 Devin Desktop / Windsurf IDE 当前登录态的真实来源
    // rt-flow 3.16.0 同源 — 复用同一数据通道
    const vscdbPaths = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage', 'state.vscdb'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'state.vscdb'),
    ];
    for (const dbPath of vscdbPaths) {
        try {
            if (!fs.existsSync(dbPath)) continue;
            // 帛书·「不出於戶以知天下」— Node.js原生读取vscdb，无需Python
            // vscdb是SQLite格式，但JSON值可以通过二进制扫描提取
            const vscdbResult = readVscdbNative(dbPath);
            if (vscdbResult && vscdbResult.apiKey) {
                const creds: WindsurfCredentials = {
                    apiKey: vscdbResult.apiKey,
                    email: vscdbResult.email || '',
                    source: 'vscdb-native',
                };
                cachedVscdbCreds = creds;
                vscdbCredsReadAt = Date.now();
                return creds;
            }
            // 降级: Python读取vscdb（如果Node.js原生方法失败）
            const tmpScript = path.join(os.tmpdir(), 'dao_vscdb_read.py');
            const pyCode = `import sqlite3,json,os,sys
db=r'${dbPath}'
try:
 con=sqlite3.connect('file:///'+db.replace(chr(92),'/')+'?mode=ro',uri=True)
 r=con.execute('SELECT value FROM ItemTable WHERE key=?',('windsurfAuthStatus',)).fetchone()
 if r:
  d=json.loads(r[0])
  k=d.get('apiKey','')
  email=''
  rows=con.execute("SELECT key FROM ItemTable WHERE key LIKE 'windsurf_auth-%' AND key LIKE '%-usages'").fetchall()
  for row in rows:
   name=row[0].replace('windsurf_auth-','').replace('-usages','')
   if name and name!='WAM':
    email=name
    break
  sys.stdout.write(json.dumps({'apiKey':k,'email':email,'source':'vscdb'}))
 con.close()
except: pass`;
            fs.writeFileSync(tmpScript, pyCode, 'utf8');
            const { execFileSync } = require('child_process') as typeof import('child_process');
            const result = execFileSync('python', [tmpScript], { encoding: 'utf8', timeout: 5000 });
            if (result) {
                const parsed = JSON.parse(result);
                if (parsed.apiKey) {
                    const creds: WindsurfCredentials = {
                        apiKey: parsed.apiKey,
                        email: parsed.email || '',
                        source: parsed.source,
                    };
                    cachedVscdbCreds = creds;
                    vscdbCredsReadAt = Date.now();
                    return creds;
                }
            }
        } catch {}
    }

    // 路径1: cascade-auth.json 等全局存储文件
    const windsurfStoragePaths = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'Devin', 'User', 'globalStorage'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage'),
        path.join(os.homedir(), '.windsurf', 'User', 'globalStorage'),
    ];
    for (const storageDir of windsurfStoragePaths) {
        try {
            if (!fs.existsSync(storageDir)) continue;
            const rootFiles = fs.readdirSync(storageDir).filter(f => f.endsWith('.json'));
            for (const f of rootFiles) {
                try {
                    const content = fs.readFileSync(path.join(storageDir, f), 'utf8');
                    let data: any = null;
                    try { data = JSON.parse(content); } catch { continue; }
                    const email = findNestedValue(data, ['email', 'userEmail', 'username', 'loginEmail']);
                    const apiKey = findNestedValue(data, ['apiKey', 'api_key', 'token', 'authToken', 'firebaseIdToken', 'idToken', 'access_token']);
                    if (email || apiKey) {
                        return { email: email || '', apiKey: apiKey || '', source: 'globalStorage/' + f };
                    }
                } catch {}
            }
        } catch {}
    }

    // 路径2: 环境变量
    const envEmail = process.env.DEVIN_EMAIL || process.env.WINDSURF_EMAIL || '';
    const envApiKey = process.env.DEVIN_API_KEY || process.env.WINDSURF_API_KEY || '';
    const envPassword = process.env.DEVIN_PASSWORD || process.env.WINDSURF_PASSWORD || '';
    if (envEmail || envApiKey) {
        return { email: envEmail, apiKey: envApiKey, password: envPassword, source: 'env' };
    }

    return null;
}

// 深度搜索嵌套JSON值 — 帛书·五十二「天下有始以为天下母」
function findNestedValue(obj: any, keys: string[]): string {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
        if (obj[key] && typeof obj[key] === 'string') return obj[key];
    }
    // 递归搜索一层
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
            const found = findNestedValue(v, keys);
            if (found) return found;
        }
    }
    return '';
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · 实时凭证同步引擎 — 帛书·「不出於戶以知天下」
// RT Flow 3.16.0 同源: 轮询vscdb → 检测账号切换 → 自动重链
// 反者道之动: 用户切号 → vscdb变化 → 检测差异 → 自动同步
// 无为而无不为: 用户零操作，如流水般自然
// ═══════════════════════════════════════════════════════════

function startCredentialSync() {
    if (credSyncTimer) return;
    // 记录初始状态
    lastSyncedApiKey = ws.devinApiKey || ws.devinAuth1 || '';
    lastSyncedEmail = ws.devinEmail || '';

    credSyncTimer = setInterval(async () => {
        try {
            // 守柔 · 手动模式 — 用户自控账号, 停止 IDE 跟随(保留操作空间)
            if (getAccountSyncMode() === 'manual') return;
            // 归一·真源·1:1 · RT Flow 活跃号变化(跨窗口切号·本窗无进程内总线事件)也即刻跟随
            const rtEmail = getRtFlowActiveEmail();
            if (rtEmail && rtEmail !== (ws.devinEmail || '').trim().toLowerCase() && rtEmail !== lastSyncedEmail) {
                lastSyncedEmail = rtEmail;
                ws.devinAutoSyncing = true; sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel();
                const okRt = await devinAutoChain();
                ws.devinAutoSyncing = false;
                lastSyncedApiKey = ws.devinApiKey || ws.devinAuth1 || '';
                lastSyncedEmail = ws.devinEmail || rtEmail;
                sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel(); updateStatusBar();
                if (okRt && ws.port && ws.devinAuth1 && ws.devinOrgId) { await devinFullInject(false, true); sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel(); }
                return;
            }
            // 强制刷新vscdb — 绕过缓存
            const freshCreds = readWindsurfCredentials(true);
            if (!freshCreds) return;

            const newApiKey = freshCreds.apiKey || '';
            const newEmail = freshCreds.email || '';

            // 检测账号切换: apiKey或email变化
            if (newApiKey && (newApiKey !== lastSyncedApiKey || newEmail !== lastSyncedEmail)) {
                lastSyncedApiKey = newApiKey;
                lastSyncedEmail = newEmail;

                // 账号已切换 — 清除旧态，重新链接
                ws.devinAuth1 = '';
                ws.devinOrgId = '';
                ws.devinOrgName = '';
                ws.devinOrgSlug = '';
                ws.devinSessionToken = '';
                ws.devinApiKey = '';
                ws.devinApiServerUrl = '';
                ws.devinAccountId = '';
                ws.devinUserId = '';
                ws.devinQuota = null;
                ws.devinEmail = '';

                ws.devinAutoSyncing = true;
                // 即刻清掉顶部旧账号徽章 — 不让用户看到老旧态(帛书·「反者道之动」)
                sidebarCloudPanel?.refresh();
                refreshDaoCloudMiddlePanel();

                const ok = await devinAutoChain();
                ws.devinAutoSyncing = false;

                if (ok) {
                    // 同步成功 — lastSynced 已在上方记为 vscdb 的 newApiKey/newEmail。
                    // 帛书·「知止不殆」: 不可改记为 ws.devinApiKey(cog_), 否则与 vscdb
                    // 的 session-token 永不相等, 将每 5 秒误判账号切换、反复重登清空 auth1。
                    sidebarCloudPanel?.refresh();
                    refreshDaoCloudMiddlePanel();
                    updateStatusBar();
                    // 自动注入
                    if (ws.port && ws.devinAuth1 && ws.devinOrgId) {
                        await devinFullInject(false, true);
                        sidebarCloudPanel?.refresh();
                        refreshDaoCloudMiddlePanel();
                    }
                    // 注入自循环: 账号切换后, 把用户初始注入的 profile 应用到新账号 org,
                    // 并(默认)清理旧账号 org 的旧注入 — 帛书·「善抱者不脱」
                    try { await runInjectProfileSelfLoop(); } catch {}
                } else {
                    // 换不到 auth1 — 至少让面板显示当前 IDE 账号(不串号、不空白)
                    // devinAutoChain 已把 ws.devinEmail 置为权威 whoami 邮箱; 这里仅兜底
                    if (!ws.devinEmail && newEmail) ws.devinEmail = newEmail;
                    sidebarCloudPanel?.refresh();
                    refreshDaoCloudMiddlePanel();
                    updateStatusBar();
                }
            }
        } catch {}
    }, CRED_SYNC_INTERVAL);
}

function stopCredentialSync() {
    if (credSyncTimer) {
        clearInterval(credSyncTimer);
        credSyncTimer = null;
    }
}

// ═══════════════════════════════════════════════════════════
// 归一·深融 · 进程内事件总线 — rt-flow 切号即刻驱动全能板 (同 extension host 进程共享 global)
// 反者道之动: rt-flow 一次登录已得 auth1 并写入共享库 → 此处即刻复链, 免轮询延迟、免重复登录。
// 守柔: 手动(单账号粘贴)模式不被 rt-flow 覆盖, 保留用户操作空间。
// ═══════════════════════════════════════════════════════════
function daoOneBus(): any {
    try {
        const g: any = global as any;
        if (!g.__daoOneBus) { g.__daoOneBus = new (require('node:events').EventEmitter)(); g.__daoOneBus.setMaxListeners(50); }
        return g.__daoOneBus;
    } catch { return null; }
}
let _fusionSyncing = false;
// rt-flow 切号广播 → 即刻跟随同步 (复用 devinAutoChain/devinFullInject, 不改动既有轮询逻辑)
async function onRtFlowAccountSwitch(payload?: { email?: string; auth1?: string; orgId?: string; apiKey?: string; apiServerUrl?: string }): Promise<void> {
    try {
        if (getAccountSyncMode() === 'manual') return; // 单号模式不被覆盖
        if (_fusionSyncing) return;
        _fusionSyncing = true;
        const pEmail = ((payload && payload.email) || '').trim().toLowerCase();
        const pAuth1 = (payload && payload.auth1) || '';
        // 清旧态 → 重链 (与轮询成功分支一致)
        ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinOrgName = ''; ws.devinOrgSlug = '';
        ws.devinSessionToken = ''; ws.devinApiKey = ''; ws.devinApiServerUrl = '';
        ws.devinAccountId = ''; ws.devinUserId = ''; ws.devinQuota = null; ws.devinEmail = '';
        ws.devinAutoSyncing = true;
        sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel();
        let ok = false;
        // 归一·1:1 直采 · rt-flow 切号广播已携真 auth1 → 全能板即刻路由该号(免 vscdb 竞态/串号)
        if (pEmail && pAuth1 && payload && payload.orgId && !pAuth1.startsWith('devin-session-token$')) {
            ws.devinEmail = pEmail; ws.devinAuth1 = pAuth1; ws.devinOrgId = payload.orgId;
            ws.devinApiKey = payload.apiKey || ''; ws.devinApiServerUrl = payload.apiServerUrl || '';
            const saved = loadAccountAuth(pEmail);
            if (saved) {
                ws.devinOrgName = saved.orgName || ''; ws.devinOrgSlug = saved.orgSlug || '';
                ws.devinUserId = saved.userId || ''; ws.devinAccountId = saved.accountId || '';
                if (!ws.devinApiKey) ws.devinApiKey = saved.apiKey || '';
                if (!ws.devinApiServerUrl) ws.devinApiServerUrl = saved.apiServerUrl || '';
            }
            try { const quota = await devinFetchQuota(ws.devinApiKey || ws.devinAuth1); if (quota) ws.devinQuota = quota; } catch { /* 守柔 */ }
            ws.devinSaveConfig(); saveAccountAuth(pEmail);
            if (!(ws.devinApiKey || '').startsWith('cog_')) { try { await devinEnsureCogApiKey(ws.devinOrgId, ws.devinAuth1); } catch { /* 守柔 */ } }
            ok = true;
        } else {
            // 兜底: 广播未携完整 auth → 走自动链 (此时 devinAutoChain 已以 rt-flow 活跃号为权威键)
            ok = await devinAutoChain();
        }
        ws.devinAutoSyncing = false;
        // 对齐 lastSynced, 避免轮询随后重复触发
        lastSyncedApiKey = ws.devinApiKey || ws.devinAuth1 || '';
        lastSyncedEmail = ws.devinEmail || '';
        sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel(); updateStatusBar();
        if (ok && ws.port && ws.devinAuth1 && ws.devinOrgId) {
            await devinFullInject(false, true);
            sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel();
        }
        if (ok) { try { await runInjectProfileSelfLoop(); } catch { /* 守柔 */ } }
    } catch { /* 守柔 */ } finally { _fusionSyncing = false; }
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · Codeium GetUserStatus API — 帛书·「不出於戶以知天下」
// 从 Codeium API 异步获取 email/orgId/userId（不阻塞扩展宿主）
// teamId 格式: "devin-team$account-{uuid}" → orgId = "org-{uuid}"
// ═══════════════════════════════════════════════════════════

async function enrichCredentialsFromCodeiumAPI(apiKey: string): Promise<{ email: string; orgId: string; userId: string; name: string; teamsTier: string } | null> {
    if (!apiKey) return null;
    try {
        const metadata = {
            ideName: 'windsurf', ideVersion: '1.99.0', extensionName: 'windsurf',
            extensionVersion: '1.99.0', apiKey, sessionId: crypto.randomUUID(),
            requestId: '1', locale: 'en', os: 'windows',
        };
        for (const url of DEVIN_URL_GET_USER_STATUS) {
            const r = await devinJsonPost(url, {
                'Connect-Protocol-Version': '1', 'X-Api-Key': apiKey,
            }, { metadata }, 10000);
            if (r.status >= 200 && r.status < 300 && r.json) {
                const us = r.json.userStatus || {};
                const teamId = us.teamId || '';
                let orgId = '';
                if (teamId && teamId.includes('$')) {
                    const acct = teamId.split('$')[1];
                    if (acct.startsWith('account-')) {
                        orgId = 'org-' + acct.replace('account-', '');
                    }
                }
                const result = {
                    email: us.email || '',
                    orgId,
                    userId: us.userId || '',
                    name: us.name || '',
                    teamsTier: us.teamsTier || '',
                };
                // Update cached creds
                if (cachedVscdbCreds && cachedVscdbCreds.apiKey === apiKey) {
                    Object.assign(cachedVscdbCreds, result);
                }
                return result;
            }
        }
    } catch {}
    return null;
}

// ═══════════════════════════════════════════════════════════
// Step5: 配额 · 帛书·四十六「罪莫大于可欲·祸莫大于不知足」
// ═══════════════════════════════════════════════════════════

async function devinFetchQuota(apiKey: string, apiServerUrl?: string): Promise<any> {
    // 道法自然 · 登录持久化修复:
    // 返回值语义: quota对象=成功, false=凭证确认失效(401/403→应清除), null=网络错误(不应清除凭证)
    // GetUserStatus(windsurf/codeium 座席服务) 只认 windsurf 风格密钥; cog_ 会被拒。
    // 登录后 ws.devinApiKey 常被换成 cog_, 故额度查询优先用注册留存的 windsurf key。
    const statusKey = (apiKey && !apiKey.startsWith('cog_')) ? apiKey : (ws.devinWindsurfKey || '');
    let sawAuthFailure = false;
    if (statusKey) {
        const tries: string[] = [];
        if (apiServerUrl) tries.push(apiServerUrl.replace(/\/+$/, '') + '/exa.seat_management_pb.SeatManagementService/GetUserStatus');
        for (const u of DEVIN_URL_GET_USER_STATUS) { if (!tries.includes(u)) tries.push(u); }
        const metadata = { ideName: 'windsurf', ideVersion: '1.99.0', extensionName: 'windsurf', extensionVersion: '1.99.0', apiKey: statusKey, sessionId: crypto.randomUUID(), requestId: '1', locale: 'en', os: 'windows' };
        for (const url of tries) {
            try {
                const r = await devinJsonPost(url, { 'Connect-Protocol-Version': '1', 'X-Api-Key': statusKey }, { metadata }, 8000);
                if (r.status >= 200 && r.status < 300 && r.json) {
                    // 配额只显美金: 即便 GetUserStatus 成功, 也并入 billing 美金余额 (overageDollars)
                    const ps = devinParsePlanStatus(r.json);
                    const od = await devinFetchOverageDollars();
                    if (od != null) ps.overageDollars = od;
                    return ps;
                }
                if (r.status === 401 || r.status === 403 || r.status === 400) { sawAuthFailure = true; break; }
            } catch {}
        }
    }
    // Fallback: Devin billing API
    if (ws.devinAuth1 && ws.devinOrgId) {
        try {
            const bareOrgId = ws.devinOrgId.replace(/^org-/, '');
            // 归一·真源 · billing/status 须带 x-cog-org-id, 否则 401「No organizations found」→ 配额恒空 → 全能板恒判未登录
            const br = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/billing/status', { Authorization: 'Bearer ' + ws.devinAuth1, 'x-cog-org-id': ws.devinOrgId });
            if (br.status === 200 && br.json) {
                // 实测: 按需余额在 overage_credits, 正值=可用美元(账单页「Remaining balance」), 负值=已透支→视作 0。
                const dollars = (typeof br.json.overage_credits === 'number' && isFinite(br.json.overage_credits)) ? Math.max(br.json.overage_credits, 0) : 0;
                const hasFunds = dollars > 0 && !br.json.billing_error;
                return { planName: 'Trial', dailyQuotaRemainingPercent: hasFunds ? 100 : 0, weeklyQuotaRemainingPercent: hasFunds ? 100 : 0, overageActive: hasFunds, overageDollars: dollars, _source: 'devin_billing' };
            }
            if (br.status === 401 || br.status === 403) { sawAuthFailure = true; }
        } catch {}
    }
    // 道法自然 · 持久化: 区分「凭证失效」与「网络不可达」— 仅凭证失效时返回 false 令调用方清除
    return sawAuthFailure ? false : null;
}

function devinParsePlanStatus(j: any): any {
    const us = j.userStatus || j.user_status || {};
    const ps = us.planStatus || us.plan_status || j.planStatus || j.plan_status || j;
    const pi = ps.planInfo || ps.plan_info || us.planInfo || us.plan_info || {};
    const gi = (d: any, ...keys: string[]) => { for (const k of keys) { const v = d && d[k]; if (v !== null && v !== undefined) { const n = parseInt(v, 10); if (!isNaN(n)) return n; } } return 0; };
    const gs = (d: any, ...keys: string[]) => { for (const k of keys) { const v = d && d[k]; if (v !== null && v !== undefined) return String(v); } return ''; };
    const weekly = gi(ps, 'weeklyQuotaRemainingPercent', 'weekly_quota_remaining_percent');
    let daily = gi(ps, 'dailyQuotaRemainingPercent', 'daily_quota_remaining_percent');
    if (!ps.dailyQuotaRemainingPercent && !ps.daily_quota_remaining_percent && weekly > 0) daily = weekly;
    return { planName: gs(pi, 'planName', 'plan_name'), teamsTier: gs(pi, 'teamsTier', 'teams_tier'), planStart: gs(ps, 'planStart', 'plan_start'), planEnd: gs(ps, 'planEnd', 'plan_end'), weeklyQuotaRemainingPercent: weekly, dailyQuotaRemainingPercent: daily, availablePromptCredits: gi(ps, 'availablePromptCredits', 'available_prompt_credits'), availableFlowCredits: gi(ps, 'availableFlowCredits', 'available_flow_credits'), availableFlexCredits: gi(ps, 'availableFlexCredits', 'available_flex_credits'), _source: 'GetUserStatus' };
}

// 配额只显美金: billing/status 的 overage_credits 正值即可用余额 (账单页「Remaining balance」, 精确到分; 负值=透支→0)
// 与 rt-flow 同源 (app.devin.ai/api/{orgId}/billing/status)。无 auth1/org 或无余额则返 null。
async function devinFetchOverageDollars(): Promise<number | null> {
    if (!(ws.devinAuth1 && ws.devinOrgId)) return null;
    try {
        const bareOrgId = ws.devinOrgId.replace(/^org-/, '');
        // 同源 · 带 x-cog-org-id (缺则 401)
        const br = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/billing/status', { Authorization: 'Bearer ' + ws.devinAuth1, 'x-cog-org-id': ws.devinOrgId });
        if (br.status === 200 && br.json && typeof br.json.overage_credits === 'number' && !br.json.billing_error) {
            return Math.max(br.json.overage_credits, 0);
        }
    } catch {}
    return null;
}

// ═══════════════════════════════════════════════════════════
// WSS凭证 · 帛书·五十二「见小曰明·守柔曰强」
// ═══════════════════════════════════════════════════════════

function devinTokenToJwt(sessionToken: string): string {
    if (!sessionToken) return '';
    const idx = sessionToken.indexOf('$');
    return idx > 0 ? sessionToken.slice(idx + 1) : sessionToken;
}

function devinBuildWssUrl(sessionToken: string): string {
    const jwt = devinTokenToJwt(sessionToken);
    return DEVIN_WSS_BASE + (jwt ? '?token=' + jwt : '');
}

function devinMaskToken(t: string): string {
    if (!t || typeof t !== 'string') return '(none)';
    if (t.length <= 16) return t.slice(0, 6) + '...';
    const dollarIdx = t.indexOf('$');
    if (dollarIdx > 0 && dollarIdx < t.length - 1) {
        const prefix = t.slice(0, dollarIdx + 1);
        const value = t.slice(dollarIdx + 1);
        if (value.length <= 12) return prefix + value.slice(0, 4) + '...';
        return prefix + value.slice(0, 8) + '...' + value.slice(-6);
    }
    return t.slice(0, 20) + '...' + t.slice(-8);
}

// 多行正文编辑: 打开临时 markdown 文档供编辑, 用户点「保存到 Devin」后回传全文; 取消则 undefined。
// 帛书·「大成若缺·其用不弊」— 单行 InputBox 容不下长正文, 故借编辑器原生多行能力。
async function daoEditBodyViaDoc(header: string, currentBody: string): Promise<string | undefined> {
    const doc = await vscode.workspace.openTextDocument({ content: currentBody, language: 'markdown' });
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const pick = await vscode.window.showInformationMessage(header + ' — 在打开的文档中编辑正文, 完成后点「保存到 Devin」', '保存到 Devin', '取消');
    const text = ed.document.getText();
    try { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); } catch { /* 守柔 */ }
    if (pick !== '保存到 Devin') return undefined;
    return text;
}

async function devinInjectSecret(orgId: string, name: string, value: string, auth1: string): Promise<{ ok: boolean; existed?: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonPost(DEVIN_APP + '/api/org-' + bareOrgId + '/secrets', { 'Authorization': 'Bearer ' + auth1, 'x-cog-org-id': orgId }, { key: name, value: value, type: 'key-value', sensitive: true, note: name });
    if (r.status === 200 || r.status === 201 || r.status === 409) return { ok: true, existed: r.status === 409 };
    return { ok: false };
}

async function devinInjectKnowledge(orgId: string, name: string, body: string, triggerDescription: string, auth1: string): Promise<{ ok: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonPost(DEVIN_APP + '/api/org-' + bareOrgId + '/learning', { 'Authorization': 'Bearer ' + auth1, 'x-cog-org-id': orgId }, { name: name, body: body, trigger_description: triggerDescription, pinned_repo: null, parent_folder_id: null, is_enabled: true });
    if (r.status === 200 || r.status === 201) return { ok: true };
    return { ok: false };
}

// 原地更新已有知识条目 (幂等回写, 防重复堆积)。后端不支持 PATCH 时返回 ok:false 由调用方退回删建。
async function devinUpdateKnowledge(orgId: string, id: string, name: string, body: string, triggerDescription: string, auth1: string): Promise<{ ok: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonPatch(DEVIN_APP + '/api/org-' + bareOrgId + '/learning/' + id, { 'Authorization': 'Bearer ' + auth1, 'x-cog-org-id': orgId }, { name: name, body: body, trigger_description: triggerDescription, is_enabled: true });
    if (r.status === 200 || r.status === 201 || r.status === 204) return { ok: true };
    return { ok: false };
}

async function devinInjectPlaybook(orgId: string, title: string, body: string, auth1: string): Promise<{ ok: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonPost(DEVIN_APP + '/api/org-' + bareOrgId + '/playbooks', { 'Authorization': 'Bearer ' + auth1, 'x-cog-org-id': orgId }, { title: title, body: body, status: 'published', access: 'team' });
    if (r.status === 200 || r.status === 201) return { ok: true };
    return { ok: false };
}

async function devinInjectGitHubPAT(orgId: string, pat: string, auth1: string): Promise<{ ok: boolean; existed?: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonPost(DEVIN_APP + '/api/org-' + bareOrgId + '/integrations/github/pat', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId }, { pat }, 30000);
    if (r.status === 200 || r.status === 201) return { ok: true, existed: false };
    if (r.status === 400 && r.text && r.text.includes('already registered')) return { ok: true, existed: true };
    return { ok: false };
}

// ═══════════════════════════════════════════════════════════
// CRUD · List — 帛书·三十三「始制有名·名亦既有·夫亦将知止」
// ═══════════════════════════════════════════════════════════

// 帛书·「不善人之所葆」— 失败不吞: 从上游响应提炼简明错误 (status + detail/text)
function devinErr(r: any): string {
    if (!r) return 'no response';
    if (r.status === 0) return 'connect failed: ' + (r.text || 'unknown');
    const detail = r.json && (r.json.detail || r.json.error || r.json.message);
    const tail = detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : (r.text ? ': ' + String(r.text).slice(0, 200) : '');
    return 'HTTP ' + r.status + tail;
}

async function devinListSecrets(orgId: string, auth1: string): Promise<{ ok: boolean; secrets?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/secrets', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; const items = Array.isArray(j) ? j : (Array.isArray(j.secrets) ? j.secrets : []); return { ok: true, secrets: items }; }
    return { ok: false, status: r.status, error: devinErr(r) };
}

async function devinListKnowledge(orgId: string, auth1: string): Promise<{ ok: boolean; learnings?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/learning/all', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; return { ok: true, learnings: Array.isArray(j.learnings) ? j.learnings : (Array.isArray(j) ? j : []) }; }
    return { ok: false, status: r.status, error: devinErr(r) };
}

async function devinListPlaybooks(orgId: string, auth1: string): Promise<{ ok: boolean; playbooks?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/playbooks', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; const items = Array.isArray(j) ? j : (Array.isArray(j.playbooks) ? j.playbooks : []); return { ok: true, playbooks: items }; }
    return { ok: false, status: r.status, error: devinErr(r) };
}

// Automations 自动化 · GET/POST/DELETE 均已逆流实测 (/api/org-<bare>/automations)
// 归一: 同时返回 raw `automations`(含 automation_id, 供删除/去重) 与 `items`(面板展示用映射)。
// 帛书·「少则得·多则惑」— 此前重复声明致 clearAutomations 拿不到 automation_id(删0条), upsert 去重失效。
async function devinListAutomations(orgId: string, auth1: string): Promise<{ ok: boolean; automations?: any[]; items?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/automations', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) {
        const j = r.json || {};
        const automations = Array.isArray(j) ? j : (Array.isArray(j.automations) ? j.automations : []);
        const items = automations.map((a: any) => {
            const trig = Array.isArray(a.triggers) && a.triggers[0] ? (a.triggers[0].event_type || '') : '';
            return { name: a.name || a.automation_id || 'Automation', detail: trig, connected: a.enabled !== false };
        });
        return { ok: true, automations, items };
    }
    return { ok: false, status: r.status, error: devinErr(r), automations: [], items: [] };
}
// 规范化为上游接受的创建 body — 缺省 webhook:incoming + start_session(prompt)
function buildAutomationBody(a: InjectProfileItemA): any {
    const triggers = (Array.isArray(a.triggers) && a.triggers.length) ? a.triggers : [{ event_type: 'webhook:incoming' }];
    let actions = (Array.isArray(a.actions) && a.actions.length) ? a.actions : [];
    if (!actions.length) actions = [{ type: 'start_session', prompt: a.prompt || '' }];
    return { name: a.name, enabled: a.enabled !== false, triggers, actions };
}
async function devinInjectAutomation(orgId: string, a: InjectProfileItemA, auth1: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonPost(DEVIN_APP + '/api/org-' + bareOrgId + '/automations', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId, 'Content-Type': 'application/json' }, buildAutomationBody(a));
    if (r.status === 200 || r.status === 201) return { ok: true, status: r.status };
    return { ok: false, status: r.status, error: devinErr(r) };
}
async function devinDeleteAutomation(orgId: string, id: string, auth1: string): Promise<{ ok: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonDelete(DEVIN_APP + '/api/org-' + bareOrgId + '/automations/' + id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204 || r.status === 404 };
}
// 幂等: 同名先删后建 — 帖书「反者道之动」
async function devinUpsertAutomation(orgId: string, a: InjectProfileItemA, auth1: string): Promise<{ ok: boolean }> {
    const list = await devinListAutomations(orgId, auth1);
    if (list.ok && list.automations) {
        for (const x of list.automations) {
            const xid = x.automation_id || x.id;
            if (x.name === a.name && xid) { try { await devinDeleteAutomation(orgId, String(xid), auth1); } catch { /* 守柔 */ } }
        }
    }
    return await devinInjectAutomation(orgId, a, auth1);
}

// ═══════════════════════════════════════════════════════════
// Schedules / 定时任务 — 道法自然·「天发杀机·移星易宿」
// 列出 / 删除定时触发的会话调度。API: /api/org-<bare>/schedules
// ═══════════════════════════════════════════════════════════
async function devinListSchedules(orgId: string, auth1: string): Promise<{ ok: boolean; schedules?: any[]; items?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/schedules', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) {
        const j = r.json || {};
        const schedules = Array.isArray(j) ? j : (Array.isArray(j.schedules) ? j.schedules : (Array.isArray(j.items) ? j.items : []));
        const items = schedules.map((s: any) => {
            const cron = s.cron_expression || s.cron || s.schedule || '';
            const prompt = s.prompt || s.description || s.name || '';
            const enabled = s.enabled !== false && s.status !== 'paused';
            return { name: prompt.substring(0, 80) || s.schedule_id || 'Schedule', detail: cron, connected: enabled, id: s.schedule_id || s.id || '' };
        });
        return { ok: true, schedules, items };
    }
    return { ok: false, status: r.status, error: devinErr(r), schedules: [], items: [] };
}
async function devinDeleteSchedule(orgId: string, id: string, auth1: string): Promise<{ ok: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonDelete(DEVIN_APP + '/api/org-' + bareOrgId + '/schedules/' + encodeURIComponent(id), { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204 || r.status === 404 };
}

// ═══════════════════════════════════════════════════════════
// Blueprints / 环境蓝图 — 帛书·六十四「为之于未有·治之于未乱」
// 真实根 = snapshot-setup (/api/org-<bare>/blueprints 实测 404 误猜)。
// 蓝图 git-backed, 跨账号「注入」非平凡(引用各自仓库), 故此处先落只读: 列表/详情/快照。
// 一步一验: GET 先行, 写操作待后端确证后再补。
// ═══════════════════════════════════════════════════════════
async function devinListBlueprints(orgId: string, auth1: string): Promise<{ ok: boolean; blueprints?: any[]; items?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/snapshot-setup/blueprints', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) {
        const j = r.json || {};
        const blueprints = Array.isArray(j) ? j : (Array.isArray(j.blueprints) ? j.blueprints : []);
        const items = blueprints.map((b: any) => {
            const repo = b.repo_full_name || b.repo || b.git_repo || '';
            const st = b.status || (b.is_active === false ? 'inactive' : '');
            return { name: b.name || b.title || b.id || 'Blueprint', detail: [repo, st].filter(Boolean).join(' · '), connected: b.is_active !== false, id: b.id || b.blueprint_id || '' };
        });
        return { ok: true, blueprints, items };
    }
    return { ok: false, status: r.status, error: devinErr(r), blueprints: [], items: [] };
}
async function devinGetBlueprint(orgId: string, id: string, auth1: string): Promise<{ ok: boolean; blueprint?: any; contents?: any; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const headers = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    const base = DEVIN_APP + '/api/org-' + bareOrgId + '/snapshot-setup/blueprints/' + encodeURIComponent(id);
    const r = await devinJsonGet(base, headers);
    if (r.status !== 200) return { ok: false, status: r.status, error: devinErr(r) };
    let contents: any = null;
    try { const c = await devinJsonGet(base + '/contents', headers); if (c.status === 200) contents = c.json; } catch { /* 守柔 */ }
    return { ok: true, blueprint: r.json, contents };
}
async function devinListSnapshots(orgId: string, auth1: string): Promise<{ ok: boolean; items?: any[]; status?: number; error?: string }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/snapshots', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; const items = Array.isArray(j) ? j : (Array.isArray(j.snapshots) ? j.snapshots : []); return { ok: true, items }; }
    return { ok: false, status: r.status, error: devinErr(r) };
}

// ═══════════════════════════════════════════════════════════
// CRUD · Delete — 帛书·三十六「将欲拾之·必故张之」
// 先删后建 = 去芜存菁 = 更新stale URL
// ═══════════════════════════════════════════════════════════

function devinJsonDelete(targetUrl: string, headers: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const needsProxy = u.hostname === 'app.devin.ai' || u.hostname.endsWith('windsurf.com');
        // 帛书·「反者道之动」— 直连优先, 仅连不通(status 0)时降级走本地代理。
        // 与 devinJsonGet/Post 同构: detectedProxyPort 误检不再吞掉 DELETE。
        const makeRequest = (hostname: string, port: number, reqPath: string, h: any) => {
            const mod: any = hostname === '127.0.0.1' ? http : https;
            const req = mod.request({ hostname, port, path: reqPath, method: 'DELETE', headers: h, timeout: timeoutMs || 15000, rejectUnauthorized: false }, (res: any) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { resolve({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e: Error) => resolve({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
            req.end();
        };
        const reqHeaders = Object.assign({ Accept: 'application/json', 'User-Agent': DEVIN_UA }, headers || {});
        const direct = () => makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, reqHeaders);
        const viaProxy = () => makeRequest('127.0.0.1', detectedProxyPort, targetUrl, Object.assign({}, reqHeaders, { Host: u.hostname }));
        const origResolve = resolve;
        if (needsProxy && detectedProxyPort) {
            resolve = ((r: any) => { if (r && r.status === 0) { resolve = origResolve; viaProxy(); } else { origResolve(r); } }) as any;
            direct();
        } else {
            direct();
        }
    });
}

// ... (rest of the code remains the same)
async function devinDeleteKnowledge(orgId: string, id: string, auth1: string): Promise<{ ok: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonDelete(DEVIN_APP + '/api/org-' + bareOrgId + '/learning/' + id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204 || r.status === 404 };
}

async function devinDeletePlaybook(orgId: string, id: string, auth1: string): Promise<{ ok: boolean }> {
    // playbook 资源为全局路由 /api/playbooks/<id> (非 org 作用域; org 作用域返回 404)
    const r = await devinJsonDelete(DEVIN_APP + '/api/playbooks/' + id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204 };
}


async function devinDeleteSecret(orgId: string, name: string, auth1: string): Promise<{ ok: boolean }> {
    const list = await devinListSecrets(orgId, auth1);
    if (list.ok && list.secrets) {
        for (const s of list.secrets) {
            // 上游 secret 列表字段为 key (非 name); 兼容两者方能命中
            if ((s.key || s.name) === name && s.id) {
                // secret 资源为全局路由 /api/secrets/<id> (非 org 作用域)
                const r = await devinJsonDelete(DEVIN_APP + '/api/secrets/' + s.id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
                return { ok: r.status === 200 || r.status === 204 };
            }
        }
    }
    // 帛书·「信言不美」— 未命中即如实报失败, 不以 ok:true 掩盖 (此前的伪成功掩码)
    return { ok: false };
}
// DeleteThenCreate — 帛书·四十「反者道之动」
// 先删旧→再建新 = 永远不会stale URL
// ═══════════════════════════════════════════════════════════

async function devinUpsertSecret(orgId: string, name: string, value: string, auth1: string): Promise<{ ok: boolean }> {
    await devinDeleteSecret(orgId, name, auth1);
    const r = await devinInjectSecret(orgId, name, value, auth1);
    return r;
}

// 收口点下沉 (道并行而不相悖·彻底): 把 per-org 并发锁收口到 upsert 本体 — 任何路径(手动单注
//   /api·webview·档案整池·内穿自愈·批量)并发 upsert 同一 org, 均经同一 per-org 锁串行化,
//   令「list→删多余→PATCH/建」全程原子。实测病灶: /api/devin/knowledge/inject 旧未收口,
//   6 路并发 → 6 条翻倍; 收口后恒收敛单条。locked=true 供已在锁内的调用方(bridgeInjectKnowledge
//   /applyInjectProfileToOrgInner)旁路, 免同进程重入自锁(O_EXCL 自死锁)。
async function devinUpsertKnowledge(orgId: string, name: string, body: string, triggerDescription: string, auth1: string, locked: boolean = false): Promise<{ ok: boolean }> {
    if (locked) return devinUpsertKnowledgeInner(orgId, name, body, triggerDescription, auth1);
    let result: { ok: boolean } = { ok: false };
    await withOrgInjectLock(orgId, async () => { result = await devinUpsertKnowledgeInner(orgId, name, body, triggerDescription, auth1); });
    return result;
}
async function devinUpsertKnowledgeInner(orgId: string, name: string, body: string, triggerDescription: string, auth1: string): Promise<{ ok: boolean }> {
    // 帛书·「反者道之动也」根因收敛: 任何路径(含旧版插件/种入/批量)若把哨兵占位符当正文推上云端,
    // 在唯一出云口实时展开为完整 MD — 杜绝账号云端知识库出现 `__DAO_BRIDGE_*_MD__` 空壳。
    body = expandKbSentinel(name, body);
    // 道·机权相忘 (幂等收口·根治「3条→6条」翻倍): 不再「删尽同名→新建」(那是非原子的
    //   读-改-写, 多窗口/多IDE/多机并发各自删后各自建 → 同名翻倍)。改为「原地更新(PATCH)
    //   保留的首条 + 删除多余同名」: ① 并发两路都只是 PATCH 同一既存条目 → 收敛同一份, 不增殖;
    //   ② 顺手自愈历史已堆积的重复(每次注入即收敛回单条)。仅当确无同名时才新建。
    const list = await devinListKnowledge(orgId, auth1);
    const sameName: any[] = [];
    if (list.ok && Array.isArray(list.learnings)) {
        for (const k of list.learnings) {
            // 守柔: 跳过 Cognition 内置/只读条目(删不动·非本系统注入物)
            if (k && k.name === name && k.id && k.can_write !== false && k.is_default_note !== true) sameName.push(k);
        }
    }
    if (sameName.length) {
        // 多余同名先删, 仅留首条原地更新
        for (let i = 1; i < sameName.length; i++) { try { await devinDeleteKnowledge(orgId, String(sameName[i].id), auth1); } catch { /* 守柔 */ } }
        const up = await devinUpdateKnowledge(orgId, String(sameName[0].id), name, body, triggerDescription, auth1);
        if (up.ok) return { ok: true };
        // 后端不支持 PATCH → 退回删建(此时同名已仅剩这一条)
        try { await devinDeleteKnowledge(orgId, String(sameName[0].id), auth1); } catch { /* 守柔 */ }
    }
    return await devinInjectKnowledge(orgId, name, body, triggerDescription, auth1);
}

async function devinUpsertPlaybook(orgId: string, title: string, body: string, auth1: string, locked: boolean = false): Promise<{ ok: boolean }> {
    if (locked) return devinUpsertPlaybookInner(orgId, title, body, auth1);
    let result: { ok: boolean } = { ok: false };
    await withOrgInjectLock(orgId, async () => { result = await devinUpsertPlaybookInner(orgId, title, body, auth1); });
    return result;
}
async function devinUpsertPlaybookInner(orgId: string, title: string, body: string, auth1: string): Promise<{ ok: boolean }> {
    // 删尽同标题→建; 在 per-org 锁内串行化后此「删→建」即原子, 并发不翻倍(留单条)。
    const list = await devinListPlaybooks(orgId, auth1);
    if (list.ok && list.playbooks) {
        for (const p of list.playbooks) {
            if (p.title === title && p.id) await devinDeletePlaybook(orgId, String(p.id), auth1);
        }
    }
    return await devinInjectPlaybook(orgId, title, body, auth1);
}

// 去重 · 帛书·「少则得·多则惑」— 同名知识/同标题剧本只保留一份(留最后一条, 删其余)。
// 清理旧版本插件累积的同名残留(如早期不同命名的批量注入)。按 name/title 精确分组, 不跨名误删。
async function devinDedupeOrg(orgId: string, auth1: string): Promise<{ ok: boolean; knowledgeRemoved: number; playbooksRemoved: number }> {
    let knowledgeRemoved = 0, playbooksRemoved = 0, anyList = false;
    try {
        const kl = await devinListKnowledge(orgId, auth1);
        if (kl.ok && Array.isArray(kl.learnings)) {
            anyList = true;
            const seen = new Set<string>();
            // 逆序遍历: 保留最后出现的一条, 删除更早的同名条目
            for (let i = kl.learnings.length - 1; i >= 0; i--) {
                const k = kl.learnings[i];
                if (!k || !k.name) continue;
                // 帛书·「知止不殆」: Devin 系统默认条目(is_default_note / can_write=false)不可删, 跳过 → 计数诚实
                if (k.is_default_note === true || k.can_write === false) { seen.add(k.name); continue; }
                if (seen.has(k.name)) { if (k.id) { try { await devinDeleteKnowledge(orgId, String(k.id), auth1); knowledgeRemoved++; } catch { /* 守柔 */ } } }
                else seen.add(k.name);
            }
        }
    } catch { /* 守柔 */ }
    try {
        const pl = await devinListPlaybooks(orgId, auth1);
        if (pl.ok && Array.isArray(pl.playbooks)) {
            anyList = true;
            const seen = new Set<string>();
            for (let i = pl.playbooks.length - 1; i >= 0; i--) {
                const pb = pl.playbooks[i];
                if (!pb || !pb.title) continue;
                // 社区/共享模板(access=community)非本 org 所有, 删不动 → 跳过, 不误计
                if (pb.access === 'community') { seen.add(pb.title); continue; }
                if (seen.has(pb.title)) { if (pb.id) { try { await devinDeletePlaybook(orgId, String(pb.id), auth1); playbooksRemoved++; } catch { /* 守柔 */ } } }
                else seen.add(pb.title);
            }
        }
    } catch { /* 守柔 */ }
    return { ok: anyList, knowledgeRemoved, playbooksRemoved };
}

// 老旧异名 dao 知识 — 历史版本以不同命名注入的同源残留(规则/连接信息),
// 收敛为唯二(道法自然准则 + 内网穿透板块)时一并清除 → 老旧知识库覆盖成唯二。
const DAO_LEGACY_KB_NAMES = ['Dao Workspace Server', '道法约束·帛书规则'];
async function devinCleanLegacyDaoKnowledge(orgId: string, auth1: string): Promise<number> {
    let removed = 0;
    try {
        const kl = await devinListKnowledge(orgId, auth1);
        if (kl.ok && Array.isArray(kl.learnings)) {
            for (const k of kl.learnings) {
                if (k && k.name && DAO_LEGACY_KB_NAMES.indexOf(k.name) >= 0 && k.id) {
                    try { await devinDeleteKnowledge(orgId, String(k.id), auth1); removed++; } catch { /* 守柔 */ }
                }
            }
        }
    } catch { /* 守柔 */ }
    return removed;
}

// ═══════════════════════════════════════════════════════════
// Session · 帛书·四十二「道生一·一生二·二生三·三生万物」
// Create / List / Detail / Messages → 对话记录MD下载
// ═══════════════════════════════════════════════════════════

const DEVIN_FRONTEND_TO_BACKEND: Record<string, string> = {
    'devin-2-5': 'devin-2-5', 'devin-fast-opus': 'devin-fast-opus',
    devin_lite: 'devin-lite', 'devin-gpt-5-5': 'devin-gpt-5-5', 'devin-opus-4-7': 'opus-4-7',
};

async function devinCreateSession(orgId: string, userMessage: string, auth1: string, opts?: any): Promise<{ ok: boolean; devinId?: string; isNewSession?: boolean; createdAt?: string; raw?: any; status?: number; error?: string }> {
    opts = opts || {};
    // app.devin.ai 内部 API 的 /sessions 校验字段为 user_message (非 prompt); api.devin.ai/v1 则用 prompt。
    // 两个都带上以兼容内部/公开两套契约 (实跑 422 揭示: body.user_message required) — 与 rt-flow devin_cloud.createSession 同源。
    const payload: any = { user_message: userMessage, prompt: userMessage };
    if (opts.idempotencyKey) payload.idempotency_key = opts.idempotencyKey;
    if (opts.playbookId) payload.playbook_id = opts.playbookId;
    if (opts.title) payload.title = opts.title;
    if (opts.tags) payload.tags = opts.tags;
    if (opts.repos) payload.repos = opts.repos;
    if (opts.sessionSecrets) payload.session_secrets = opts.sessionSecrets;
    // 帛书·「反者道之动也」— 两条候选路径, 依次回退:
    //   ① api.devin.ai/v1/org/<org>/sessions (cog_ API Key) — 企业/付费档可用
    //   ② app.devin.ai/api/org-<bare>/sessions (auth1 同源) — 自助账号 cog_ 被 v1 拒(404)时兜底,
    //      与 Secret/Knowledge/Playbook/v2sessions 同源, 对所有账号恒可用。
    const bareOrgId = orgId.replace(/^org-/, '');
    const attempts: Array<{ url: string; headers: any }> = [];
    if ((ws.devinApiKey || '').startsWith('cog_')) {
        attempts.push({ url: `https://api.devin.ai/v1/org/${orgId}/sessions`, headers: { Authorization: 'Bearer ' + ws.devinApiKey } });
    }
    attempts.push({ url: DEVIN_APP + '/api/org-' + bareOrgId + '/sessions', headers: { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId } });
    attempts.push({ url: DEVIN_APP + '/api/sessions', headers: { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId } });
    let lastStatus = 0, lastErr = '';
    for (const a of attempts) {
        const r = await devinJsonPost(a.url, a.headers, payload);
        if (r.status === 200 || r.status === 201) {
            const j = r.json || {};
            return { ok: true, devinId: j.devin_id || j.session_id, isNewSession: j.is_new_session, createdAt: j.created_at, raw: j, status: r.status };
        }
        lastStatus = r.status;
        const d = (r.json && (r.json.detail || r.json.error || r.json.message)) || r.json;
        try { lastErr = typeof d === 'string' ? d : JSON.stringify(d); } catch { lastErr = String(d); }
        // 404/405 → 该路径不存在, 试下一条; 其它(401/403/422/4xx 业务错)即真错, 不必再试别路径
        if (r.status !== 404 && r.status !== 405) break;
    }
    return { ok: false, status: lastStatus, error: lastErr || undefined };
}

async function devinListSessions(orgId: string, auth1: string, limit?: number): Promise<{ ok: boolean; sessions?: any[]; status?: number; error?: string }> {
    // 帛书·「去彼取此」— 自助账号的 cog_ key 不被 api.devin.ai 接受(404)；
    // auth1 直读 app.devin.ai/v2sessions 对所有账号恒可用，与 Secret/Knowledge/Playbook 同源。
    const bareOrgId = orgId.replace(/^org-/, '');
    let url = DEVIN_APP + '/api/org-' + bareOrgId + '/v2sessions';
    if (limit) url += (url.includes('?') ? '&' : '?') + 'limit=' + limit;
    const H = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    // 帛书·「无为而无不为」— v2sessions 首载经代理偶发超时；守柔重试两次, 让首屏自成而无需手动重试。
    let last: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await devinJsonGet(url, H, 30000);
        last = r;
        if (r.status === 200) {
            const j = r.json || {};
            const arr = Array.isArray(j.result) ? j.result : (Array.isArray(j.sessions) ? j.sessions : (Array.isArray(j) ? j : []));
            return { ok: true, sessions: arr };
        }
        if (r.status && r.status !== 0 && r.status !== 502 && r.status !== 503 && r.status !== 504) break;
        await new Promise(res => setTimeout(res, 600));
    }
    return { ok: false, status: last?.status, error: devinErr(last) };
}

async function devinGetSessionDetail(orgId: string, sessionId: string, auth1: string): Promise<{ ok: boolean; session?: any; status?: number; error?: string }> {
    const r = await devinJsonGet(DEVIN_APP + '/api/sessions/' + sessionId, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) return { ok: true, session: r.json };
    return { ok: false, status: r.status, error: devinErr(r) };
}

async function devinGetSessionMessages(orgId: string, sessionId: string, auth1: string): Promise<{ ok: boolean; messages?: any[] }> {
    // /api/sessions/<id>/messages 对自助账号 404；守柔兜底：失败即空，不阻塞详情渲染。
    const r = await devinJsonGet(DEVIN_APP + '/api/sessions/' + sessionId + '/messages', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; return { ok: true, messages: Array.isArray(j.messages) ? j.messages : (Array.isArray(j) ? j : []) }; }
    return { ok: true, messages: [] };
}

// 删除会话 (单条): 官网 Sessions 页删除 → auth1 直删。多端点候选 + 归档兜底, 守柔。
async function devinDeleteSession(orgId: string, sessionId: string, auth1: string): Promise<{ ok: boolean; status?: number; archived?: boolean }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const H = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    const candidates = [
        DEVIN_APP + '/api/sessions/' + sessionId,
        DEVIN_APP + '/api/org-' + bareOrgId + '/sessions/' + sessionId,
    ];
    let last = 0;
    for (const url of candidates) {
        const r = await devinJsonDelete(url, H);
        last = r.status;
        if (r.status === 200 || r.status === 204) return { ok: true, status: r.status };
    }
    for (const url of candidates) {
        const r = await devinJsonPost(url, H, { archived: true });
        if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, archived: true };
    }
    return { ok: false, status: last };
}

// ═══════════════════════════════════════════════════════════
// 本地对话提取 · 移植自 dao-devin-export 1.3.2 — 帛书·「修之天下·其德乃博」
// 事件流(event stream)是会话的唯一全息真源: 含 user/devin 消息 + 思考 +
// shell 命令 + 文件编辑 + todo + 浏览器/电脑操作。比 /messages 端点深得多。
// 用户无为: 一键提取本地对话/工作日志 markdown, 系统无不为。
// ═══════════════════════════════════════════════════════════
interface DaoEventItem { event_id?: string; type?: string; timestamp?: string; created_at_ms?: number; message?: any; [k: string]: any; }

// 拉取并解析会话事件流 (SSE/ndjson) → 有序去重事件数组
async function devinGetSessionEvents(orgId: string, sessionId: string, auth1: string): Promise<{ ok: boolean; events: DaoEventItem[] }> {
    // 事件流仅 app.devin.ai/api 提供, auth1 直读
    const url = DEVIN_APP + '/api/events/' + sessionId + '/stream';
    const headers: any = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId, 'Accept': 'text/event-stream' };
    let raw = '';
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await devinJsonGet(url, headers, 180000);
        if (r.status === 200 && typeof r.text === 'string') { raw = r.text; break; }
        if (attempt < 2) await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
    if (!raw) return { ok: false, events: [] };
    const merged = new Map<string, DaoEventItem>();
    const addEv = (ev: DaoEventItem) => {
        if (!ev || !ev.type) return;
        const eid = ev.event_id || `${ev.type}-${ev.timestamp}-${ev.created_at_ms}`;
        if (!merged.has(eid)) merged.set(eid, ev);
    };
    let i = 0;
    while (i < raw.length) {
        while (i < raw.length && ' \r\n\t'.includes(raw[i])) i++;
        if (i >= raw.length) break;
        if (raw[i] === '{') {
            let depth = 0, j = i, inStr = false, escaped = false;
            for (; j < raw.length; j++) {
                if (escaped) { escaped = false; continue; }
                if (raw[j] === '\\' && inStr) { escaped = true; continue; }
                if (raw[j] === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (raw[j] === '{') depth++;
                if (raw[j] === '}') { depth--; if (depth === 0) { j++; break; } }
            }
            try { const obj = JSON.parse(raw.slice(i, j)); if (obj.result && Array.isArray(obj.result)) obj.result.forEach(addEv); else if (obj.type) addEv(obj); } catch { /* skip */ }
            i = j;
        } else {
            const lineEnd = raw.indexOf('\n', i);
            const end = lineEnd === -1 ? raw.length : lineEnd;
            const line = raw.slice(i, end).trim();
            i = end + 1;
            if (line.startsWith('data:')) {
                const dataStr = line.slice(5).trim();
                if (dataStr && dataStr !== '[DONE]') {
                    try { const obj = JSON.parse(dataStr); if (obj.result && Array.isArray(obj.result)) obj.result.forEach(addEv); else if (obj.type) addEv(obj); } catch { /* skip */ }
                }
            }
        }
    }
    const events = Array.from(merged.values());
    events.sort((a, b) => (a.created_at_ms || 0) - (b.created_at_ms || 0));
    return { ok: true, events };
}

function daoEvTs(ev: DaoEventItem): string {
    if (ev.timestamp) return ev.timestamp;
    if (ev.created_at_ms) return new Date(ev.created_at_ms).toISOString();
    return '';
}
function daoExtractMessageText(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => daoExtractMessageText(x)).filter(Boolean).join('\n');
    if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if (typeof o.message === 'string') return o.message;
        if (o.content != null) return daoExtractMessageText(o.content);
        return JSON.stringify(v, null, 2);
    }
    return String(v);
}
function daoAsText(v: unknown): string { if (v == null) return ''; if (typeof v === 'string') return v; return JSON.stringify(v, null, 2); }
function daoClip(s: string, max: number): string { return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s; }
const DAO_TODO_MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]', cancelled: '[-]' };
const DAO_SKIP_TYPES = new Set<string>(['terminal_update', 'is_typing', 'context_growth_update', 'iteration_checkpoint', 'acu_consumption_at_last_user_interaction', 'rules_injected', 'shell_process_completed_background']);

// 纯对话转录 (user/devin 消息)
function daoBuildConversation(title: string, sessionId: string, events: DaoEventItem[]): string {
    const lines: string[] = ['# 对话记录 / Conversation: ' + title, 'Session: ' + sessionId, ''];
    let turns = 0;
    for (const ev of events) {
        if (ev.type === 'user_message') { lines.push('\n## 👤 USER [' + daoEvTs(ev) + ']', daoExtractMessageText(ev.message)); turns++; }
        else if (ev.type === 'devin_message') { lines.push('\n## 🤖 DEVIN [' + daoEvTs(ev) + ']', daoExtractMessageText(ev.message)); turns++; }
    }
    lines.splice(2, 0, 'Turns: ' + turns);
    return lines.join('\n');
}

// 完整工作日志 (消息 + 思考 + 命令 + 编辑 + todo + 浏览器/电脑)
function daoBuildWorklog(title: string, sessionId: string, events: DaoEventItem[]): string {
    const lines: string[] = ['# Worklog: ' + title, 'Session: ' + sessionId, 'Events: ' + events.length, ''];
    for (const ev of events) {
        const t = ev.type || 'unknown';
        if (DAO_SKIP_TYPES.has(t)) continue;
        const time = daoEvTs(ev);
        switch (t) {
            case 'user_message': lines.push('\n## 👤 USER [' + time + ']', daoExtractMessageText(ev.message)); break;
            case 'devin_message': lines.push('\n## 🤖 DEVIN [' + time + ']', daoExtractMessageText(ev.message)); break;
            case 'devin_thoughts': { const dur = ev.thinking_duration_ms ? ' (' + Math.round(Number(ev.thinking_duration_ms) / 1000) + 's)' : ''; lines.push('\n### 💭 THINKING' + dur + ' [' + time + ']', daoClip(daoExtractMessageText(ev.message), 4000)); break; }
            case 'todo_update': { const todos = (ev.todos as any[]) || []; if (todos.length) { lines.push('\n### 📋 TODO [' + time + ']'); for (const td of todos) lines.push('- ' + (DAO_TODO_MARK[td.status || ''] || '[ ]') + ' ' + daoAsText(td.content)); } break; }
            case 'shell_process_started': { const dir = ev.starting_dir ? ' (cwd: ' + daoAsText(ev.starting_dir) + ')' : ''; lines.push('\n### 💻 COMMAND' + dir + ' [' + time + ']', '```bash', daoAsText(ev.command), '```'); break; }
            case 'shell_process_completed': { const out = daoAsText(ev.output_trunc || ev.output); const code = ev.exit_code != null ? ' (exit ' + ev.exit_code + ')' : ''; if (out.trim()) { lines.push('_output' + code + ':_', '```', daoClip(out, 3000), '```'); } else if (code) lines.push('_command finished' + code + '_'); break; }
            case 'multi_edit_result': case 'file_edit': case 'editor_action': { const fps = ((ev.file_updates as any[]) || []).map((f) => f.file_path).filter(Boolean); if (fps.length) lines.push('\n### ✏️ FILE EDIT [' + time + ']: ' + fps.join(', ')); break; }
            case 'search_file_commands': { const cmds = (ev.search_commands as any[]) || []; const desc = cmds.map((c) => c.regex || c.path).filter(Boolean).join('; '); if (desc) lines.push('\n### 🔍 SEARCH [' + time + ']: ' + desc.slice(0, 200)); break; }
            case 'computer_use': { const acts = (ev.actions as any[]) || []; const kinds = acts.map((a) => a.action_type).filter(Boolean).join(', '); lines.push('\n### 🖥️ COMPUTER [' + time + ']: ' + (kinds || 'action')); break; }
            case 'browser_action': case 'browse': lines.push('\n### 🌐 BROWSER [' + time + ']: ' + daoAsText(ev.url || ev.action || ev.message).slice(0, 200)); break;
            case 'status_update': case 'activity': lines.push('\n_[' + time + '] ' + daoAsText(ev.message || ev.status).slice(0, 300) + '_'); break;
            case 'play': lines.push('\n--- [' + time + '] ▶️ **RESUMED**' + (ev.username ? ' by ' + daoAsText(ev.username) : '') + ' ---'); break;
            case 'suspend': case 'resume': lines.push('\n--- [' + time + '] **' + t.toUpperCase() + '** ---'); break;
            default: { const msg = ev.message || ev.content || ev.text; if (msg) lines.push('\n### [' + t + '] [' + time + ']', daoClip(daoExtractMessageText(msg), 2000)); break; }
        }
    }
    return lines.join('\n');
}

function daoSafeName(s: string, maxLen = 60): string { return s.replace(/[<>:"/\\|?*\x00-\x1f\n\r]/g, '_').slice(0, maxLen).replace(/[. ]+$/, '') || 'untitled'; }

// 一键提取会话 → 本地 markdown (kind: conversation 纯对话 / worklog 完整日志)
async function devinExportSession(sessionId: string, kind: 'conversation' | 'worklog' = 'conversation'): Promise<string | null> {
    if (!ws.devinAuth1 || !ws.devinOrgId) return null;
    const detail = await devinGetSessionDetail(ws.devinOrgId, sessionId, ws.devinAuth1);
    const title = (detail.ok && detail.session?.title) || sessionId;
    const evRes = await devinGetSessionEvents(ws.devinOrgId, sessionId, ws.devinAuth1);
    let md: string;
    if (evRes.ok && evRes.events.length) {
        md = kind === 'worklog' ? daoBuildWorklog(title, sessionId, evRes.events) : daoBuildConversation(title, sessionId, evRes.events);
    } else {
        // 降级: 事件流不可用 → 退回 /messages 端点 (守柔)
        const msgs = await devinGetSessionMessages(ws.devinOrgId, sessionId, ws.devinAuth1);
        if (!msgs.ok) return null;
        const lines: string[] = ['# ' + title, '', '> Session: ' + sessionId, ''];
        for (const m of (msgs.messages || [])) {
            const role = m.role || m.type || 'unknown';
            const content = m.content || m.text || m.message || '';
            if (role === 'user' || role === 'human') lines.push('## 👤 User', '', daoAsText(content), '');
            else if (role === 'assistant' || role === 'ai' || role === 'devin') lines.push('## 🤖 Devin', '', daoAsText(content), '');
            else lines.push('## ' + role, '', daoAsText(content), '');
        }
        md = lines.join('\n');
    }
    const sessionDir = path.join(DAO_DIR, 'sessions');
    try { fs.mkdirSync(sessionDir, { recursive: true }); } catch { /* 守柔 */ }
    const filePath = path.join(sessionDir, daoSafeName(title) + '_' + sessionId.substring(0, 8) + (kind === 'worklog' ? '.worklog' : '') + '.md');
    try { fs.writeFileSync(filePath, md, 'utf8'); } catch { /* 守柔 */ }
    return filePath;
}

// 对话记录MD下载 — 帛书·五十四「修之天下·其德乃博」(默认纯对话, 自动走事件流深提取)
async function devinDownloadSessionMd(sessionId: string): Promise<string | null> {
    return await devinExportSession(sessionId, 'conversation');
}

// ═══════════════════════════════════════════════════════════
// Git · 帛书·四十三「天下之至柔·驰骋于天下之致坚」
// CheckGit / Disconnect / Connect — 用户只需提供PAT
// ═══════════════════════════════════════════════════════════

async function devinCheckGitConnections(orgId: string, auth1: string): Promise<{ ok: boolean; connections?: any[]; count?: number }> {
    const targetUrl = DEVIN_APP + '/api/organizations/' + orgId + '/git-connections-metadata';
    const r = await devinJsonGet(targetUrl, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) {
        const data = r.json;
        // API返回可能是数组或{connections:[...]}对象
        const conns = Array.isArray(data) ? data : (data && data.connections ? data.connections : []);
        return { ok: true, connections: conns, count: conns.length };
    }
    return { ok: false, connections: [], count: 0 };
}

// 帛书·「万物负阴而抱阳」— Integrations 状态盘:
// 聚合官网所有集成提供商状态(GitHub/GitLab/Bitbucket/Azure DevOps/Slack/Jira)+ MCP 服务器,
// 并将 git-connections-metadata 的真实连接(含可断开 id)并入对应提供商行。auth1 直读, 恒可用。
async function devinListIntegrations(orgId: string, auth1: string): Promise<{ ok: boolean; connections?: any[] }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const H = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    const base = DEVIN_APP + '/api/org-' + bareOrgId;
    const byName = new Map<string, any>();
    const set = (name: string, kind: string) => { const k = name.toLowerCase(); if (!byName.has(k)) byName.set(k, { name, connected: false, detail: '', kind, id: '' }); return byName.get(k); };
    // 1) 真实 git 连接(可断开)
    try {
        const gc = await devinJsonGet(DEVIN_APP + '/api/organizations/' + orgId + '/git-connections-metadata', H);
        if (gc.status === 200) {
            const arr = Array.isArray(gc.json) ? gc.json : (gc.json && gc.json.connections ? gc.json.connections : []);
            arr.forEach((c: any) => { const row = set(c.provider || c.name || 'Git', 'git'); row.connected = true; row.id = c.id || c.connection_id || ''; row.detail = c.login || c.username || c.account_login || row.detail; });
        }
    } catch { /* 守柔 */ }
    // 2) 提供商状态
    const providers: Array<[string, string, (j: any) => boolean]> = [
        ['GitHub', '/integrations/github', (j) => Array.isArray(j) ? j.length > 0 : !!j],
        ['GitLab', '/integrations/gitlab', (j) => Array.isArray(j) ? j.length > 0 : !!j],
        ['Bitbucket', '/integrations/bitbucket', (j) => Array.isArray(j) ? j.length > 0 : !!j],
        ['Azure DevOps', '/integrations/azure-devops', (j) => !!(j && Array.isArray(j.connections) && j.connections.length)],
        ['Slack', '/integrations/slack/status', (j) => !!(j && j.connection)],
        ['Jira', '/integrations/jira/status', (j) => !!(j && j.integration)],
    ];
    await Promise.all(providers.map(async ([label, path, isConn]) => {
        try {
            const r = await devinJsonGet(base + path, H);
            if (r.status === 200) { const row = set(label, 'provider'); if (isConn(r.json)) row.connected = true; }
        } catch { /* 守柔 */ }
    }));
    // 3) MCP 服务器
    try {
        const mcp = await devinJsonGet(DEVIN_APP + '/api/mcp/servers', H);
        if (mcp.status === 200 && Array.isArray(mcp.json)) { const row = set('MCP Servers', 'mcp'); row.connected = mcp.json.length > 0; row.detail = mcp.json.length + ' available'; }
    } catch { /* 守柔 */ }
    return { ok: true, connections: [...byName.values()] };
}

// 帛书·「既得其母，以知其子」— 补全官网模块: Usage / Org 成员 / MCP / Automations
// 全部 auth1 直读 app.devin.ai, 与账号实时同步; 切号即整体跟随。
async function devinGetUsage(orgId: string, auth1: string): Promise<{ ok: boolean; items?: any[] }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const H = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    const base = DEVIN_APP + '/api/org-' + bareOrgId + '/billing/usage';
    const [stats, limits] = await Promise.all([devinJsonGet(base + '/stats', H), devinJsonGet(base + '/limits', H)]);
    const s = (stats.status === 200 && stats.json) ? stats.json : {};
    const l = (limits.status === 200 && limits.json) ? limits.json : {};
    const num = (v: any) => (v === null || v === undefined) ? '—' : String(v);
    const items = [
        { name: '订阅状态 Subscription', detail: num(s.subscription_status) },
        { name: '可用 ACU Available', detail: num(s.available_acus) },
        { name: '本周期已用 ACU Used', detail: num(s.cycle_total_acu_usage) },
        { name: '余额 Balance', detail: num(s.balance) },
        { name: '超额阈值 Overage threshold', detail: num(s.overage_threshold) },
        { name: '当前超额 Current overage', detail: num(s.current_overage) },
        { name: '单会话 ACU 上限 Max ACU/session', detail: num(l.max_acu_limit) },
        { name: '周期 Cycle', detail: (s.cycle_start ? new Date(s.cycle_start).toLocaleDateString() : '—') + ' → ' + (s.cycle_end ? new Date(s.cycle_end).toLocaleDateString() : '—') },
    ];
    return { ok: stats.status === 200 || limits.status === 200, items };
}

async function devinListMembers(orgId: string, auth1: string): Promise<{ ok: boolean; items?: any[] }> {
    const r = await devinJsonGet(DEVIN_APP + '/api/organizations/' + orgId + '/members', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status !== 200) return { ok: false, items: [] };
    const arr = Array.isArray(r.json) ? r.json : [];
    const items = arr.map((m: any) => ({
        name: m.preferred_name || m.name || m.email || 'Member',
        detail: (m.email || '') + (Array.isArray(m.roles) && m.roles.length ? '  ·  ' + m.roles.map((x: any) => x.label || x.id).join(', ') : ''),
    }));
    return { ok: true, items };
}

async function devinListMcpServers(orgId: string, auth1: string): Promise<{ ok: boolean; items?: any[] }> {
    const r = await devinJsonGet(DEVIN_APP + '/api/mcp/servers', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status !== 200) return { ok: false, items: [] };
    const arr = Array.isArray(r.json) ? r.json : [];
    const items = arr.map((m: any) => ({
        name: m.name || m.slug || m.server_id || 'MCP',
        detail: (m.short_description || m.description || '').toString().substring(0, 120),
        connected: !!(m.is_connected || m.connected || m.status === 'connected'),
    }));
    return { ok: true, items };
}

// 帛书·「天下之物生於有」— 官网即一切, 以下端点皆由 Chrome CDP 实操官网时抓得:
//   单条消息额度 POST /api/org-<bare>/billing/usage/limits {max_credits}
//   自定义 MCP   GET/POST /api/mcp/installations · DELETE /api/mcp/installations/mcp-installation-<id>
// 面板为官网下游镜像: 同源 auth1 直读直写, 账号切换即整体跟随。

// 调整单条会话/消息的额度上限 (Usage & limits 页那个可调数字)
async function devinSetMessageLimit(orgId: string, maxCredits: number, auth1: string): Promise<{ ok: boolean; status?: number }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    // 服务端要求 max_credits 为整数且 ≥1: 浮点→422(int_from_float), <1→400。向下取整·低于 1 不发请求。
    const intMc = Math.floor(Number(maxCredits));
    if (!Number.isFinite(intMc) || intMc < 1) return { ok: false, status: 0 };
    const r = await devinJsonPost(DEVIN_APP + '/api/org-' + bareOrgId + '/billing/usage/limits',
        { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId }, { max_credits: intMc });
    return { ok: r.status === 200 || r.status === 201 || r.status === 204, status: r.status };
}

// 读本号「当前可用余额」→ 供「单会话上限 = 余额 − N」动态反注。
//   余额随计划/订阅状态落在四处(多为互斥), 须四处合取最大者:
//     billing/usage/stats : available_acus(订阅ACU余量) · balance(预付余额)
//     billing/status      : available_credits(订阅信用余量) · overage_credits(按需/溢价信用 = 账单页「Remaining balance」)
//   实测本号池(pro-trial·订阅已取消)真实余额恒在 overage_credits, 其余三者皆 0 → 旧版只读 stats 永远取 0 → cap 被钉 1
//   (即「$69 余额却上限 $1」之根因)。故四者取最大为「余额」; 全 0 或负(欠费)→ 收敛为 0 → cap=1。
//   守柔: 两端点皆未给出任一有效数字字段才返回 null(跳过管理, 不误改)。
async function devinFetchAvailableAcus(orgId: string, auth1: string): Promise<number | null> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const h = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    let best: number | null = null;
    const take = (v: any) => { if (typeof v === 'number' && isFinite(v)) { best = (best === null) ? v : Math.max(best, v); } };
    try {
        const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/billing/usage/stats', h);
        if (r.status === 200 && r.json) { take(r.json.available_acus); take(r.json.balance); }
    } catch { /* 守柔 */ }
    try {
        const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/billing/status', h);
        if (r.status === 200 && r.json) { take(r.json.available_credits); take(r.json.overage_credits); }
    } catch { /* 守柔 */ }
    return best;
}

// 列出本组织已安装的自定义 MCP (与官网 Connections 一致)
async function devinListMcpInstallations(orgId: string, auth1: string): Promise<{ ok: boolean; items?: any[] }> {
    // 实测官网真实端点为 GET /api/mcp/servers (旧 /api/mcp/installations GET 返回 405)。
    // 返回项主键为 server_id; 本组织自助安装的自定义 MCP 其 server_id 以 mcp-installation- 起始,
    // marketplace 目录项则以 mcp-marketplace-server- 起始 — 面板「已安装」只取前者。
    const r = await devinJsonGet(DEVIN_APP + '/api/mcp/servers', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status !== 200) return { ok: false, items: [] };
    const j = r.json || {};
    const arr = Array.isArray(j) ? j : (Array.isArray(j.servers) ? j.servers : (Array.isArray(j.installations) ? j.installations : []));
    const items = arr
        .filter((m: any) => String(m.server_id || m.id || '').startsWith('mcp-installation-'))
        .map((m: any) => ({
            name: m.name || m.slug || 'MCP',
            detail: (m.short_description || m.description || '').toString().substring(0, 120),
            id: m.server_id || m.id || m.installation_id || '',
            transport: m.transport || '',
            connected: m.is_enabled !== false,
        }));
    return { ok: true, items };
}

// MCP env 规整: 接受对象 {KEY:VALUE} 或数组 [{key/name,value}] → 统一为官网要求的数组形态
// [{key,value}] (实测 env_variables 必须是 list, 对象会被 422 "should be a valid list" 拒)。
function normalizeMcpEnv(env: any): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    if (!env) return out;
    if (Array.isArray(env)) {
        for (const e of env) {
            if (!e || typeof e !== 'object') continue;
            const k = e.key || e.name || e.env_var_name || '';
            if (k) out.push({ key: String(k), value: String(e.value !== undefined ? e.value : '') });
        }
    } else if (typeof env === 'object') {
        for (const k of Object.keys(env)) out.push({ key: k, value: String(env[k] !== undefined ? env[k] : '') });
    }
    return out;
}

// 追录: 把一个自定义 MCP 直接注册进官网 (STDIO: command/args/env; HTTP/SSE: url)
async function devinAddCustomMcp(orgId: string, spec: any, auth1: string): Promise<{ ok: boolean; status?: number; id?: string; error?: string }> {
    const name = String(spec.name || '').trim();
    const slug = String(spec.slug || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const transport = (spec.transport || 'STDIO').toUpperCase();
    const payload: any = {
        name, slug,
        short_description: spec.short_description || '',
        description: spec.description || '',
        transport,
        is_enabled: spec.is_enabled !== false,
        icon: spec.icon || '',
        installation_scope: spec.installation_scope || 'org',
    };
    // 安装市场目录项时引用其 server_id (官网逆流字段); 自定义安装则无此字段。
    if (spec.marketplace_server_id) payload.marketplace_server_id = spec.marketplace_server_id;
    if (spec.requires_custom_oauth_credentials) payload.requires_custom_oauth_credentials = true;
    if (transport === 'STDIO') {
        payload.command = spec.command || '';
        // 帛书·「知不知尚矣」— 官网 /api/mcp/installations 要求 args 为 [{value}] 字典数组,
        // 纯字符串数组(文档式 ["-y","pkg"]) 会被 422 拒(dict_type)。此处统一规整:
        //   字符串 → {value: s} · 已是字典则原样透出 · 容错 null。
        const rawArgs = Array.isArray(spec.args) ? spec.args : [];
        payload.args = rawArgs.map((a: any) => (a && typeof a === 'object') ? a : { value: String(a) });
        // env_variables: 接受对象 {KEY:VALUE} 或数组 [{key/name,value}] — 实测官网两者皆收,
        // 这里统一规整为对象(文档式), 便于剧本/种入态用直观写法。
        payload.env_variables = normalizeMcpEnv(spec.env_variables);
    } else {
        // HTTP / SSE: 远程 URL + 可选鉴权头 (用于追录本地 141 经 dao-relay 暴露的公网端点)
        payload.url = spec.url || '';
        if (spec.headers) payload.headers = spec.headers;
    }
    const r = await devinJsonPost(DEVIN_APP + '/api/mcp/installations',
        { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId }, payload);
    const j = r.json || {};
    const ok = r.status === 200 || r.status === 201;
    // 帛书·「知不知尚矣」— 失败时把上游校验原因透出, 不再吞成裸 status (便于面板/调用方诊断)
    let error = '';
    if (!ok) {
        const d = j.detail || j.error || j.message || j;
        try { error = typeof d === 'string' ? d : JSON.stringify(d); } catch { error = String(d); }
    }
    return { ok, status: r.status, id: j.id || j.installation_id, error: error || undefined };
}

// 删除自定义 MCP (id 需带 mcp-installation- 前缀; 自动补全)
async function devinDeleteMcp(orgId: string, installationId: string, auth1: string): Promise<{ ok: boolean; status?: number }> {
    const id = installationId.startsWith('mcp-installation-') ? installationId : 'mcp-installation-' + installationId.replace(/^mcp-installation-/, '');
    const r = await devinJsonDelete(DEVIN_APP + '/api/mcp/installations/' + id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204, status: r.status };
}

interface McpMarketItem {
    server_id: string; name: string; slug: string; detail: string;
    transport: string; icon: string; tags: string[]; official: boolean;
    requiresOauth: boolean; installed: boolean; installationId: string;
    // 安装模板 (来自 /api/mcp/servers, 供一键/批量安装直接复用)
    command: string; args: unknown[]; env_variables: unknown; url: string; headers: unknown;
    installation_scope: string; marketplace_server_id: string;
}
interface McpInstallSpec {
    marketplace_server_id?: string; slug?: string; name?: string; transport?: string;
    short_description?: string; description?: string; icon?: string;
    command?: string; args?: unknown[]; env_variables?: unknown; url?: string; headers?: unknown;
    installation_scope?: string; is_enabled?: boolean; requires_custom_oauth_credentials?: boolean;
}

// 软编码扫描本机 IDE / 桌面 Agent 的内部 MCP 配置 (Devin Desktop / Windsurf / Cursor / Claude / VS Code …)。
//   通用四大模块 MCP 是平台级(随账号反向注入); 此处把「用户本地已配的 MCP」一对一映射出来,
//   默认不装, 用户可在 MCP 面板逐个选装到 Devin Cloud 账号 (install spec 即 1:1)。
interface IdeMcpEntry { name: string; transport: string; command: string; args: string[]; env: Record<string, string>; url: string; headers: Record<string, string>; source: string; disabled: boolean; }
function _stripJsonc(raw: string): string {
    // 去 // 与 /* */ 注释 + 尾逗号 (settings.json 常为 JSONC) — 守柔尽力, 失败由上层 try 兜底。
    let s = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/(^|[^:"'])\/\/[^\n\r]*/g, '$1');
    s = s.replace(/,(\s*[}\]])/g, '$1');
    return s;
}
// 末路兜底: 手编配置偶含非法转义(Windows 路径裸反斜杠 "E:\foo\bar"), 严格 JSON.parse 会拒 → 整份被吞、数对不上。
//   仅在 JSON.parse + JSONC 双双失败后启用: 把「非合法转义前缀的反斜杠」修成 \\ (JSON 串外无裸反斜杠, 全局替换安全)。
function _repairJsonEscapes(raw: string): string {
    return raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}
// 跨平台·应用配置基目录(VS Code 系 IDE 的 User 配置根): win=%APPDATA% · mac=~/Library/Application Support · linux=~/.config
function daoAppConfigBase(): string {
    const home = os.homedir();
    if (process.platform === 'win32') return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
    return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

// 宿主 IDE 归一标识: 由 vscode.env.appName + execPath 推断"插件当前运行在哪个 IDE", 实现「MCP 跟着软件走」。
function daoHostIdeKey(): string {
    let n = ''; let root = '';
    try { n = (vscode.env.appName || '').toLowerCase(); } catch { /* 守柔 */ }
    try { root = (process.execPath || '').toLowerCase(); } catch { /* 守柔 */ }
    const hay = n + ' ' + root;
    if (hay.includes('devin')) return 'devin';
    if (hay.includes('windsurf') || hay.includes('codeium') || hay.includes('cascade')) return 'windsurf';
    if (hay.includes('cursor')) return 'cursor';
    if (hay.includes('trae')) return 'trae';
    if (hay.includes('antigravity')) return 'antigravity';
    if (hay.includes('insiders')) return 'vscode-insiders';
    if (hay.includes('code') || hay.includes('vscode')) return 'vscode';
    return 'other';
}

// 宿主 IDE 对应的扫描 source 显示名(与 scanIdeMcps 的 src 标签对齐), 供面板/接测默认聚焦当前 IDE。
function daoHostIdeSource(): string {
    switch (daoHostIdeKey()) {
        case 'devin': case 'windsurf': return 'Devin Desktop';
        case 'cursor': return 'Cursor';
        case 'trae': return 'Trae';
        case 'antigravity': return 'Antigravity';
        case 'vscode': case 'vscode-insiders': return 'VS Code';
        default: return 'Devin Desktop';
    }
}

// 单一真源·跨平台 IDE MCP 配置候选(scan 与 repair 共用)。key 用于「跟着宿主 IDE 走」; repair=false 的文件(如 settings.json)只读不改。
interface IdeMcpCandidate { p: string; src: string; key: string; repair?: boolean; }
function daoIdeMcpCandidates(): IdeMcpCandidate[] {
    const home = os.homedir();
    const base = daoAppConfigBase();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    //   接龙核心 = Devin Desktop ⇄ 老版 Windsurf 共用同一份 .codeium/windsurf/mcp_config.json(home dotfile, 三平台同位)。
    //   其余 IDE 存在即纳入; settings.json 仅供扫描读取, repair 不写(避免误改 VS Code 全局设置)。
    return [
        { p: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), src: 'Devin Desktop', key: 'windsurf', repair: true },
        { p: path.join(home, '.codeium', 'windsurf-next', 'mcp_config.json'), src: 'Windsurf Next', key: 'windsurf', repair: true },
        { p: path.join(home, '.codeium', 'mcp_config.json'), src: 'Codeium', key: 'windsurf', repair: true },
        { p: path.join(home, '.devin', 'mcp_config.json'), src: 'Devin Desktop', key: 'devin', repair: true },
        { p: path.join(base, 'Devin', 'User', 'mcp.json'), src: 'Devin Desktop', key: 'devin', repair: true },
        { p: path.join(home, '.cursor', 'mcp.json'), src: 'Cursor', key: 'cursor', repair: true },
        { p: path.join(localAppData, 'Programs', 'cursor', 'mcp.json'), src: 'Cursor', key: 'cursor', repair: true },
        { p: path.join(base, 'Trae', 'User', 'mcp.json'), src: 'Trae', key: 'trae', repair: true },
        { p: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), src: 'Antigravity', key: 'antigravity', repair: true },
        { p: path.join(home, '.gemini', 'antigravity-ide', 'mcp_config.json'), src: 'Antigravity', key: 'antigravity', repair: true },
        { p: path.join(home, '.gemini', 'config', 'mcp_config.json'), src: 'Gemini', key: 'gemini', repair: true },
        { p: path.join(home, '.gemini', 'mcp_config.json'), src: 'Gemini', key: 'gemini', repair: true },
        { p: path.join(base, 'Claude', 'claude_desktop_config.json'), src: 'Claude', key: 'claude', repair: true },
        { p: path.join(base, 'Code', 'User', 'mcp.json'), src: 'VS Code', key: 'vscode', repair: true },
        { p: path.join(base, 'Code', 'User', 'settings.json'), src: 'VS Code', key: 'vscode', repair: false },
        { p: path.join(base, 'Code - Insiders', 'User', 'mcp.json'), src: 'VS Code Insiders', key: 'vscode-insiders', repair: true },
        { p: path.join(home, '.mcp', 'config.json'), src: 'MCP', key: 'mcp', repair: true },
        { p: path.join(home, '.dao', 'ide-mcp.json'), src: 'DAO', key: 'dao', repair: true },
    ];
}

function scanIdeMcps(): IdeMcpEntry[] {
    // 软编码候选路径 — 存在即扫, 不存在则跳; 用户亦可在 ~/.dao/ide-mcp.json 手动补充。
    const candidates = daoIdeMcpCandidates();
    const out: IdeMcpEntry[] = [];
    // 道·按「来源+名称」去重(非仅名称): 各 IDE 同名 MCP 各自呈现, 与各 IDE 内显示一一对应,
    //   不再因 Cursor/Windsurf 同有 github 而吞掉其一(此前全局名去重正是「数量对不上」一因)。
    const seen = new Set<string>();
    for (const c of candidates) {
        try {
            if (!fs.existsSync(c.p)) continue;
            const raw = fs.readFileSync(c.p, 'utf8');
            let j: any;
            try { j = JSON.parse(raw); }
            catch { try { j = JSON.parse(_stripJsonc(raw)); } catch { j = JSON.parse(_repairJsonEscapes(_stripJsonc(raw))); } }
            const servers = (j && (j.mcpServers || j.servers || (j.mcp && j.mcp.servers))) || {};
            for (const name of Object.keys(servers)) {
                const s = servers[name] || {};
                const key = c.src.toLowerCase() + '::' + String(name).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const isHttp = !!(s.url || s.serverUrl || ['http', 'sse', 'streamable-http', 'streamable_http'].includes(String(s.type || s.transport || '').toLowerCase()));
                const env: Record<string, string> = {};
                const rawEnv = s.env || s.env_variables || {};
                if (rawEnv && typeof rawEnv === 'object') for (const k of Object.keys(rawEnv)) env[k] = String(rawEnv[k] != null ? rawEnv[k] : '');
                out.push({
                    name: String(name), source: c.src,
                    transport: isHttp ? 'HTTP' : 'STDIO',
                    command: String(s.command || ''),
                    args: Array.isArray(s.args) ? s.args.map((a: any) => String(a)) : [],
                    env, url: String(s.url || s.serverUrl || ''),
                    headers: (s.headers && typeof s.headers === 'object') ? s.headers : {},
                    disabled: !!(s.disabled === true || s.enabled === false),
                });
            }
        } catch { /* 守柔: 单文件解析失败不阻断其余 */ }
    }
    return out;
}

// 帛书·「绝利一源」— 跨平台定位可执行命令(STDIO MCP 接测用): PATH + Windows PATHEXT。
function daoWhichCmd(cmd: string): string {
    if (!cmd) return '';
    try { if ((path.isAbsolute(cmd) || cmd.indexOf('/') >= 0 || cmd.indexOf('\\') >= 0) && fs.existsSync(cmd)) return cmd; } catch { /* 守柔 */ }
    const isWin = process.platform === 'win32';
    const exts = isWin ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
    const dirs = (process.env.PATH || '').split(isWin ? ';' : ':');
    for (const d of dirs) {
        if (!d) continue;
        for (const e of exts) {
            try { const f = path.join(d, cmd + e); if (fs.existsSync(f)) return f; } catch { /* 守柔 */ }
        }
    }
    return '';
}

// ──────────────────────────────────────────────────────────────────────────
// 帛书·「道法自然·无为而无不为」— 通用型 MCP 修复链路
//   不论用户电脑环境/安装位置, 插件装到 IDE 即自动识别可用运行时与模块路径,
//   一键把本机 MCP 修正为「强鲁棒·可用」: 自动选 node 运行时、重解析脚本路径、启用。
// ──────────────────────────────────────────────────────────────────────────

// 通用 node 运行时解析: 优先系统 node(最可移植), 退回 IDE 自带 Electron 当 node 跑。
//   process.execPath 即当前 IDE 的 Electron 二进制(Windsurf/Devin Desktop/VS Code/Cursor),
//   故 Electron 回退天然通用, 无需硬编码任何安装路径。
function daoResolveNodeRuntime(): { cmd: string; electron: boolean; source: string } {
    const viaPath = daoWhichCmd('node');
    if (viaPath) return { cmd: viaPath, electron: false, source: 'PATH' };
    const home = os.homedir();
    const common = process.platform === 'win32'
        ? ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe', path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'node.exe')]
        : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node', path.join(home, '.volta', 'bin', 'node')];
    for (const c of common) { try { if (fs.existsSync(c)) return { cmd: c, electron: false, source: 'common-path' }; } catch { /* 守柔 */ } }
    // 退回: 当前 IDE 的 Electron 二进制当 node 跑(ELECTRON_RUN_AS_NODE=1)
    try { if (process.execPath && fs.existsSync(process.execPath)) return { cmd: process.execPath, electron: true, source: 'ide-electron' }; } catch { /* 守柔 */ }
    return { cmd: '', electron: false, source: 'none' };
}

// 通用 npm 全局模块根: npm root -g + 各平台常见全局位置, 存在者皆纳入候选。
function daoNpmGlobalRoots(): string[] {
    const home = os.homedir();
    const out: string[] = [];
    const push = (p: string) => { try { if (p && fs.existsSync(p) && out.indexOf(p) < 0) out.push(p); } catch { /* 守柔 */ } };
    try { const r = require('child_process').execSync('npm root -g', { encoding: 'utf8', timeout: 6000 }).trim(); push(r); } catch { /* 守柔 */ }
    if (process.platform === 'win32') {
        push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'));
        push('C:\\Program Files\\nodejs\\node_modules');
    } else {
        push('/usr/local/lib/node_modules');
        push('/usr/lib/node_modules');
        push('/opt/homebrew/lib/node_modules');
    }
    return out;
}

// 重解析模块脚本路径: 原绝对路径不存在时(换机/换装位), 截取 node_modules 后的相对段在各全局根重找。
function daoResolveModuleScript(orig: string): string {
    try { if (orig && fs.existsSync(orig)) return orig; } catch { /* 守柔 */ }
    if (!orig) return orig;
    const norm = orig.replace(/\\/g, '/');
    const idx = norm.toLowerCase().lastIndexOf('node_modules/');
    if (idx < 0) return orig;
    const rel = norm.slice(idx + 'node_modules/'.length);
    for (const root of daoNpmGlobalRoots()) {
        const cand = path.join(root, rel.split('/').join(path.sep));
        try { if (fs.existsSync(cand)) return cand; } catch { /* 守柔 */ }
    }
    return orig;
}

interface McpRepairChange { name: string; action: string; before: { command: string; argsHead: string; disabled: boolean }; after: { command: string; argsHead: string; disabled: boolean }; }

// 修复单个 MCP 配置文件: 逐 server 归一运行时 + 重解析脚本 + 启用; 改动前先备份原文件。
function daoRepairMcpConfigFile(filePath: string, opts: { enable?: boolean; dryRun?: boolean }): { ok: boolean; file: string; backup?: string; changes: McpRepairChange[]; error?: string } {
    const enable = opts.enable !== false;
    const changes: McpRepairChange[] = [];
    try {
        if (!fs.existsSync(filePath)) return { ok: false, file: filePath, changes, error: 'config not found' };
        const raw = fs.readFileSync(filePath, 'utf8');
        let j: any;
        try { j = JSON.parse(raw); } catch { try { j = JSON.parse(_stripJsonc(raw)); } catch { j = JSON.parse(_repairJsonEscapes(_stripJsonc(raw))); } }
        const servers = (j && (j.mcpServers || j.servers)) || {};
        const rt = daoResolveNodeRuntime();
        for (const name of Object.keys(servers)) {
            const s = servers[name] || {};
            const isHttp = !!(s.url || s.serverUrl || ['http', 'sse', 'streamable-http', 'streamable_http'].includes(String(s.type || s.transport || '').toLowerCase()));
            const args0: string[] = Array.isArray(s.args) ? s.args.map((a: any) => String(a)) : [];
            const before = { command: String(s.command || ''), argsHead: args0.slice(0, 3).join(' '), disabled: !!(s.disabled === true || s.enabled === false) };
            let action = '';
            if (!isHttp) {
                const newArgs = args0.map((a) => /\.(js|mjs|cjs)$/i.test(a) ? daoResolveModuleScript(a) : a);
                const cmdStr = String(s.command || '');
                const isElectron = /windsurf\.exe|devin\.exe|code\.exe|cursor\.exe|electron/i.test(cmdStr.toLowerCase()) || !!(s.env && s.env.ELECTRON_RUN_AS_NODE);
                const cmdMissing = !daoWhichCmd(cmdStr);
                if ((isElectron || cmdMissing) && rt.cmd) {
                    s.command = rt.cmd;
                    s.env = s.env || {};
                    if (rt.electron) { s.env.ELECTRON_RUN_AS_NODE = '1'; action += 'runtime→IDE-node;'; }
                    else { if (s.env.ELECTRON_RUN_AS_NODE) delete s.env.ELECTRON_RUN_AS_NODE; action += 'runtime→system-node;'; }
                }
                if (JSON.stringify(newArgs) !== JSON.stringify(args0)) { s.args = newArgs; action += 'script-path-fixed;'; }
            }
            if (enable && before.disabled) { s.disabled = false; if ('enabled' in s) s.enabled = true; action += 'enabled;'; }
            const argsA: string[] = Array.isArray(s.args) ? s.args.map((a: any) => String(a)) : [];
            const after = { command: String(s.command || ''), argsHead: argsA.slice(0, 3).join(' '), disabled: !!(s.disabled === true || s.enabled === false) };
            if (action) changes.push({ name, action, before, after });
        }
        if (!opts.dryRun && changes.length) {
            let backup = '';
            try { backup = filePath + '.dao-bak-' + Date.now(); fs.writeFileSync(backup, raw, 'utf8'); } catch { backup = ''; }
            fs.writeFileSync(filePath, JSON.stringify(j, null, 2), 'utf8');
            return { ok: true, file: filePath, backup, changes };
        }
        return { ok: true, file: filePath, changes };
    } catch (e: any) {
        return { ok: false, file: filePath, changes, error: String(e && e.message || e) };
    }
}

// 一键修复本机 MCP: 「跟着宿主 IDE 走」— 默认修当前运行所在 IDE 的配置 + 接龙核心(Windsurf⇄Devin 共用); allIdes 时并修其余 IDE。
//   通用·强鲁棒: 不论装在哪个 IDE、装到哪个位置, 都按宿主 IDE 自动定位配置, 运行时自动回退到宿主自带 Electron, 零硬编码。
function daoRepairLocalMcp(opts: { allIdes?: boolean; enable?: boolean; dryRun?: boolean }): { ok: boolean; hostIde: string; runtime: { command: string; electron: boolean; source: string }; npmRoots: string[]; results: Array<ReturnType<typeof daoRepairMcpConfigFile>> } {
    const all = daoIdeMcpCandidates().filter(c => c.repair !== false);
    const hostKey = daoHostIdeKey();
    const coreKeys = new Set(['windsurf', 'devin']); // 接龙核心始终纳入(Windsurf 升级 Devin Desktop 共用同一份)
    const primaryList = all.filter(c => c.key === hostKey || coreKeys.has(c.key));
    const chosen = opts.allIdes ? all : (primaryList.length ? primaryList : all.filter(c => coreKeys.has(c.key)));
    const rt = daoResolveNodeRuntime();
    const results: Array<ReturnType<typeof daoRepairMcpConfigFile>> = [];
    const donePaths = new Set<string>();
    for (const c of chosen) {
        try {
            const norm = path.normalize(c.p).toLowerCase();
            if (donePaths.has(norm)) continue; donePaths.add(norm);
            if (fs.existsSync(c.p)) results.push(daoRepairMcpConfigFile(c.p, { enable: opts.enable, dryRun: opts.dryRun }));
        } catch { /* 守柔 */ }
    }
    return { ok: true, hostIde: hostKey, runtime: rt, npmRoots: daoNpmGlobalRoots(), results };
}

// 实测·STDIO MCP 真起进程: spawn + initialize + tools/list, 返回真实工具数(有界超时, 必杀进程)。
function daoVerifyMcpStdio(spec: any, timeoutMs: number): Promise<{ ok: boolean; toolCount: number; tools?: string[]; error?: string }> {
    return new Promise((resolve) => {
        try {
            const cmd = daoWhichCmd(String(spec.command || '')) || String(spec.command || '');
            if (!cmd) return resolve({ ok: false, toolCount: 0, error: 'command not found' });
            const args: string[] = Array.isArray(spec.args) ? spec.args.map((a: any) => String(a)) : [];
            const env: Record<string, string> = Object.assign({}, process.env) as Record<string, string>;
            const se = spec.env || spec.env_variables || {};
            if (se && typeof se === 'object') for (const k of Object.keys(se)) env[k] = String(se[k] != null ? se[k] : '');
            const cp = require('child_process');
            const p = cp.spawn(cmd, args, { env });
            let buf = ''; let done = false;
            const fin = (r: any) => { if (done) return; done = true; try { p.kill(); } catch { /* 守柔 */ } resolve(r); };
            p.stdout.on('data', (d: Buffer) => {
                buf += d.toString();
                let i: number;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const ln = buf.slice(0, i); buf = buf.slice(i + 1);
                    if (!ln.trim()) continue;
                    let m: any; try { m = JSON.parse(ln); } catch { continue; }
                    if (m.id === 1 && m.result && Array.isArray(m.result.tools)) {
                        const tools = m.result.tools.map((t: any) => String(t.name || ''));
                        fin({ ok: true, toolCount: tools.length, tools });
                    }
                }
            });
            p.on('error', (e: any) => fin({ ok: false, toolCount: 0, error: String(e && e.message || e) }));
            p.stderr.on('data', () => { /* 守柔: 吞 stderr 噪声 */ });
            setTimeout(() => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dao-verify', version: '1.0' } } }) + '\n'); } catch { /* 守柔 */ } }, 300);
            setTimeout(() => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n'); } catch { /* 守柔 */ } }, 1300);
            setTimeout(() => fin({ ok: false, toolCount: 0, error: 'timeout' }), timeoutMs || 12000);
        } catch (e: any) { resolve({ ok: false, toolCount: 0, error: String(e && e.message || e) }); }
    });
}

// 道·MCP 接测专用 POST: 直连优先, 直连不可达(status 0)且本机有 VPN/代理时, 经 CONNECT 隧道(127.0.0.1:port)重试。
//   141 实测: api.githubcopilot.com 直连超时, 走本机 Clash(7890)→ initialize 应答 200。仅取 HTTP 状态行即判活(SSE 不必等流结束)。
function daoMcpProbePost(targetUrl: string, headers: Record<string, string>, body: any, timeoutMs: number): Promise<{ status: number; text: string; via: string }> {
    return new Promise(async (resolve) => {
        let done = false; const fin = (r: { status: number; text: string; via: string }) => { if (!done) { done = true; resolve(r); } };
        // ① 直连
        try { const d = await devinJsonPost(targetUrl, headers, body, timeoutMs); if (d && d.status) { fin({ status: d.status, text: String(d.text || ''), via: '直连' }); return; } } catch { /* 守柔 */ }
        // ② 直连不可达 → 经本机代理 CONNECT 隧道重试 (无代理则维持 0)
        const port = detectedProxyPort || detectProxyPort();
        if (done) return;
        if (!port) { fin({ status: 0, text: '直连失败且未检出本机代理', via: '直连' }); return; }
        let u: URL; try { u = new URL(targetUrl); } catch { fin({ status: 0, text: 'bad url', via: '直连' }); return; }
        const tlsSock = await createProxyTunnel(u.hostname);
        if (done) return;
        if (!tlsSock) { fin({ status: 0, text: '代理隧道建立失败 (port ' + port + ')', via: '代理' }); return; }
        const data = Buffer.from(asciiSafeJson(body), 'utf8');
        const h: Record<string, string> = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'User-Agent': DEVIN_UA }, headers || {});
        let reqStr = 'POST ' + (u.pathname + u.search) + ' HTTP/1.1\r\nHost: ' + u.hostname + '\r\n';
        for (const k of Object.keys(h)) reqStr += k + ': ' + h[k] + '\r\n';
        reqStr += 'Content-Length: ' + data.length + '\r\nConnection: close\r\n\r\n';
        let buf = '';
        const to = setTimeout(() => { try { tlsSock.destroy(); } catch { /* 守柔 */ } fin({ status: 0, text: '代理超时', via: '代理' }); }, timeoutMs);
        tlsSock.on('data', (c: Buffer) => {
            buf += c.toString();
            // 仅需状态行即判活(SSE 流可不结束) — 收到完整响应头即解析返回
            if (buf.indexOf('\r\n\r\n') >= 0) { const m = buf.match(/^HTTP\/\d\.\d\s+(\d+)/); clearTimeout(to); try { tlsSock.destroy(); } catch { /* 守柔 */ } fin({ status: m ? parseInt(m[1]) : 0, text: buf.slice(0, 400), via: '代理' }); }
        });
        tlsSock.on('end', () => { clearTimeout(to); const m = buf.match(/^HTTP\/\d\.\d\s+(\d+)/); fin({ status: m ? parseInt(m[1]) : 0, text: buf.slice(0, 400), via: '代理' }); });
        tlsSock.on('error', () => { clearTimeout(to); fin({ status: 0, text: '代理连接错误', via: '代理' }); });
        try { tlsSock.write(reqStr); tlsSock.write(data); } catch { clearTimeout(to); fin({ status: 0, text: '代理写入失败', via: '代理' }); }
    });
}

// 帛书·「知不知尚矣」— MCP 逐项接测(连接验证): 实际探测端点连通性, 非仅看 is_installed 标志。
//   HTTP/SSE: JSON-RPC initialize 探测(MCP streamable-http) → 2xx 连通 · 401/403 可达需鉴权 · 0 不可达。
//             直连不通自动经本机 VPN/代理隧道复测(用户有 Clash/V2Ray 即无为而自用之)。
//   STDIO   : PATH 中解析 command 是否可执行(args/env 由官网侧实跑, 此处验本机命令存在性)。
async function daoProbeMcp(spec: any): Promise<{ ok: boolean; status: number; label: string; detail: string }> {
    spec = spec || {};
    const url = String(spec.url || '').trim();
    const transport = String(spec.transport || '').toUpperCase();
    if (url || transport === 'HTTP' || transport === 'SSE') {
        if (!url) return { ok: false, status: 0, label: '缺少 URL', detail: 'HTTP/SSE MCP 未配置 url' };
        const hdrs: Record<string, string> = { Accept: 'application/json, text/event-stream' };
        const rawH = spec.headers;
        if (rawH && typeof rawH === 'object') for (const k of Object.keys(rawH)) hdrs[k] = String(rawH[k] != null ? rawH[k] : '');
        const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dao-probe', version: '1.0' } } };
        let r: any; try { r = await daoMcpProbePost(url, hdrs, body, 12000); } catch (e: any) { return { ok: false, status: 0, label: '不可达', detail: String(e && e.message || e) }; }
        const s = r.status || 0; const via = r.via ? ('[' + r.via + '] ') : '';
        if (s >= 200 && s < 300) return { ok: true, status: s, label: '已连通', detail: via + 'MCP initialize 应答 ' + s };
        if (s === 401 || s === 403) return { ok: false, status: s, label: '可达·需鉴权', detail: via + '端点可达, 需有效凭证 (' + s + ')' };
        if (s === 400 || s === 404 || s === 405 || s === 406) return { ok: false, status: s, label: '可达·应答异常', detail: via + '端点可达, 非标准 MCP 应答 (' + s + ')' };
        if (s === 0) return { ok: false, status: 0, label: '不可达', detail: '连接失败/超时: ' + String(r.text || '').slice(0, 100) };
        return { ok: false, status: s, label: '应答 ' + s, detail: via + String(r.text || '').slice(0, 120) };
    }
    const cmd = String(spec.command || '').trim();
    if (!cmd) return { ok: false, status: 0, label: '缺少命令', detail: 'STDIO MCP 未配置 command' };
    const resolved = daoWhichCmd(cmd);
    if (!resolved) return { ok: false, status: 0, label: '命令未找到', detail: 'PATH 中找不到可执行: ' + cmd };
    // 接龙·ELECTRON_RUN_AS_NODE 型(Windsurf/Devin Desktop 用 Windsurf.exe 当 node 跑 npm 模块 JS):
    //   141 实测 4 个 MCP 皆此型 → 仅命令存在不够, 还须脚本模块真在, 否则调用必失败。
    const args: string[] = Array.isArray(spec.args) ? spec.args.map((a: any) => String(a)) : [];
    const firstScript = args.find(a => /\.(js|mjs|cjs|py)$/i.test(a) && (path.isAbsolute(a) || a.indexOf('\\') >= 0 || a.indexOf('/') >= 0));
    if (firstScript) {
        try {
            if (fs.existsSync(firstScript)) return { ok: true, status: 1, label: '可调用', detail: '运行时 ' + path.basename(resolved) + ' + 脚本就绪: ' + firstScript };
            return { ok: false, status: 0, label: '脚本缺失', detail: '运行时在, 但目标脚本不存在: ' + firstScript };
        } catch { /* 守柔 */ }
    }
    return { ok: true, status: 1, label: '命令可用', detail: cmd + ' → ' + resolved };
}

// MCP tab 数据装配 — 解耦本机 IDE 扫描与官网 API 成败: 本机 MCP 纯本地无需鉴权恒先列(与 IDE 一对一),
//   官网市场尽力而为(失败仅降级为「仅本机」, 不再让整 tab 报错)。每项携 install spec 供接测/装/批量注入。
async function daoReplyMcpTab(reply: (m: any) => void): Promise<void> {
    const orgLocks = (loadManualLocks()[ws.devinOrgId] || { knowledge: [], playbooks: [], secrets: [], mcps: [] });
    // 1) 本机 IDE / 桌面 Agent 内部 MCP — 纯本地, 始终扫描
    let ideRaw: IdeMcpEntry[] = [];
    try { ideRaw = scanIdeMcps(); } catch { /* 守柔 */ }
    // 2) 官网市场目录 — 尽力而为 (需 org + 可用 API)
    let mkItems: McpMarketItem[] = []; let mkOk = false; let mkNote = '';
    if (ws.devinAuth1 && ws.devinOrgId && devinCanUseApi()) {
        try { const mk = await devinListMcpMarketplace(ws.devinOrgId, ws.devinAuth1); mkOk = !!mk.ok; mkItems = mk.items || []; if (!mk.ok) mkNote = '官网 MCP 目录读取失败 (status ' + (mk.status || '?') + ') · 已仅列本机'; }
        catch (e: any) { mkNote = '官网 MCP 目录异常: ' + String(e && e.message || e) + ' · 已仅列本机'; }
    } else if (ws.devinAuth1) {
        mkNote = '当前令牌无法读官网 MCP 目录(Windsurf session-token) · 已仅列本机 IDE MCP';
    } else {
        mkNote = '未登录 Devin Cloud · 仅列本机 IDE MCP';
    }
    const installedNames = new Set<string>(mkItems.filter((m) => m.installed).map((m) => String(m.name || '').toLowerCase()));
    const ide = ideRaw.map((e) => {
        const isInstalled = installedNames.has(e.name.toLowerCase());
        const tail = (e.transport === 'HTTP' ? e.url : (e.command + ' ' + (e.args || []).join(' '))).slice(0, 140);
        const detail = '[' + e.source + (e.disabled ? ' · 已禁用' : '') + '] ' + tail;
        const mcpObj: any = {
            name: e.name, slug: e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            transport: e.transport, detail,
            command: e.command, args: e.args, env_variables: e.env, url: e.url, headers: e.headers,
            installation_scope: 'org', installed: isInstalled, ideSource: e.source, disabled: e.disabled,
        };
        // 名前缀: ★=云端已装 / ⊘=IDE 内已禁用 — 与各 IDE 内显示一一对应
        const prefix = isInstalled ? '★ ' : (e.disabled ? '⊘ ' : '');
        return { group: 'ide', source: e.source, name: prefix + e.name + ' · ' + e.source, detail, connected: isInstalled, mcp: mcpObj };
    });
    const market = mkItems.map((m) => ({
        group: 'market',
        name: (m.installed ? '★ ' : '') + m.name,
        detail: (m.tags.length ? '[' + m.tags.join('·') + '] ' : '') + m.detail,
        connected: m.installed,
        mcp: m,
    }));
    market.sort((a, b) => (a.mcp.installed === b.mcp.installed) ? 0 : (a.mcp.installed ? -1 : 1));
    // 内置预设(始终可接测 + 一键装到所有账号) — 满足「先搞 GitHub 接测, 别人直接点装到所有账号」。
    //   本机持 PAT 时绑定到接测头(initialize 返回 200=已连通); 无 PAT 则接测显示「可达·需鉴权」。
    const presets: any[] = [];
    const existingNames = new Set<string>(ide.concat(market as any).map((x: any) => String(x.name || '').replace(/^★ /, '').toLowerCase()));
    if (!existingNames.has('github mcp')) {
        let pat = '';
        try { const cfg = getDaoConfig(); pat = String((cfg && (cfg as any).githubPat) || process.env.DAO_GITHUB_PAT || '').trim(); } catch { /* 守柔 */ }
        presets.push({
            group: 'preset', name: 'GitHub MCP',
            detail: '[内置预设] GitHub 官方远程 MCP · https://api.githubcopilot.com/mcp/' + (pat ? ' · 已绑定本机 PAT' : ' · 未绑定 PAT (接测将显示需鉴权)'),
            connected: false,
            mcp: { name: 'GitHub MCP', slug: 'github-mcp', transport: 'HTTP', url: 'https://api.githubcopilot.com/mcp/', headers: pat ? { Authorization: 'Bearer ' + pat } : {}, short_description: 'GitHub official remote MCP', installation_scope: 'org', installed: false },
        });
    }
    const all = presets.concat(ide as any, market as any);
    // 永不因官网失败而整 tab 报错: 有任意条目即正常渲染; 仅当确实零条目且有原因时才置 error。
    const err = (all.length === 0 && mkNote) ? mkNote : undefined;
    reply({ type: 'tabData', tab: 'mcp', items: all, locks: orgLocks, error: err, mcpMeta: { ideCount: ide.length, marketCount: market.length, mkOk, note: mkNote } });
}

// 官网 MCP 市场目录 — 整图给到本地 (浏览 + 加入档案 + 一键/批量安装):
// 源 GET /api/mcp/servers 返回 82 项完整目录, 每项含安装模板 + is_installed/installation_id。
async function devinListMcpMarketplace(orgId: string, auth1: string): Promise<{ ok: boolean; items?: McpMarketItem[]; status?: number }> {
    // /api/mcp/servers 返回完整目录(82项), 每项含安装模板(transport/command/args/env/url) + is_installed/installation_id,
    // 比轻量 /api/mcp/marketplace-servers 信息更全, 故以此为「整图」来源。
    const r = await devinJsonGet(DEVIN_APP + '/api/mcp/servers', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status !== 200) return { ok: false, items: [], status: r.status };
    const j = r.json || {};
    const arr = Array.isArray(j) ? j : (Array.isArray(j.servers) ? j.servers : []);
    const items: McpMarketItem[] = (arr as Array<Record<string, unknown>>).map((m) => ({
        server_id: String(m.server_id || m.id || ''),
        name: String(m.name || m.slug || 'MCP'),
        slug: String(m.slug || ''),
        detail: String(m.short_description || m.description || '').substring(0, 160),
        transport: String(m.transport || ''),
        icon: String(m.icon || ''),
        tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
        official: m.is_official === true,
        requiresOauth: m.requires_custom_oauth_credentials === true,
        installed: m.is_installed === true,
        installationId: String(m.installation_id || ''),
        command: String(m.command || ''),
        args: Array.isArray(m.args) ? m.args : [],
        env_variables: m.env_variables || [],
        url: String(m.url || ''),
        headers: m.headers || {},
        installation_scope: String(m.installation_scope || 'org'),
        marketplace_server_id: String(m.marketplace_server_id || m.server_id || ''),
    }));
    return { ok: true, items, status: 200 };
}

// 安装一个市场目录项到本账号 (引用 marketplace_server_id; 复用 devinAddCustomMcp 的规整逻辑)
async function devinInstallMarketplaceMcp(orgId: string, spec: McpInstallSpec, auth1: string): Promise<{ ok: boolean; status?: number; id?: string; error?: string }> {
    return await devinAddCustomMcp(orgId, {
        ...spec,
        installation_scope: spec.installation_scope || 'org',
        is_enabled: spec.is_enabled !== false,
    }, auth1);
}

// 清除本账号官网全部自动化 (列出后逐个删除) — 守柔: 单条失败不阻断, 汇总结果。
async function devinClearAutomations(orgId: string, auth1: string): Promise<{ ok: boolean; total: number; cleared: number }> {
    const lst = await devinListAutomations(orgId, auth1);
    const items = lst.automations || [];
    let cleared = 0;
    for (const a of items) {
        const id = String((a as Record<string, unknown>).automation_id || (a as Record<string, unknown>).id || '');
        if (!id) continue;
        try { if ((await devinDeleteAutomation(orgId, id, auth1)).ok) cleared++; } catch { /* 守柔 */ }
    }
    return { ok: cleared === items.length, total: items.length, cleared };
}

async function devinDisconnectGit(orgId: string, connectionId: string, auth1: string): Promise<{ ok: boolean }> {
    // 帛书·「反者道之动」— 实测官网断连真实端点:
    // GitHub PAT(individual token) 走 /api/org-<bare>/integrations/github/pat?connection_id=<id>
    // (旧 /api/organizations/<org>/git-connections/<id> 仅 GET, DELETE 返回 405 → 之前断连静默失败)
    const bareOrgId = orgId.replace(/^org-/, '');
    const headers = { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId };
    // 按连接类型选端点: 先查列表拿 type/host
    let connType = '';
    try {
        const lst = await devinCheckGitConnections(orgId, auth1);
        const hit = (lst.connections || []).find((c: any) => (c.id || c.connection_id) === connectionId);
        if (hit) connType = String(hit.type || '');
    } catch { /* 容错: 默认按 github pat 处理 */ }
    const qs = '?connection_id=' + encodeURIComponent(connectionId);
    let path: string;
    if (connType.indexOf('gitlab') >= 0) path = '/api/org-' + bareOrgId + '/integrations/gitlab/pat' + qs;
    else if (connType.indexOf('bitbucket') >= 0) path = '/api/org-' + bareOrgId + '/integrations/bitbucket/pat' + qs;
    else path = '/api/org-' + bareOrgId + '/integrations/github/pat' + qs; // github_individual_token / github_token 默认
    const r = await devinJsonDelete(DEVIN_APP + path, headers);
    return { ok: r.status === 200 || r.status === 204 };
}

async function devinConnectGitHub(orgId: string, pat: string, auth1: string): Promise<{ ok: boolean; existed?: boolean }> {
    return devinInjectGitHubPAT(orgId, pat, auth1);
}

// 帛书·「天下之至柔驰骋于天下之致坚」— 辅助注入(无为而无不为)
// Windsurf 会话令牌(devin-session-token$) 无法经 node 调用 app.devin.ai 写入API(401/403);
// 但 Simple Browser 共享 Electron 的 Auth0 Session 可手动写入。
// 故: 自动生成可一键粘贴的注入包 + 复制 Token 到剪贴板 + 打开正确页面 → 把手动步骤降到最低。
async function devinAssistedInject(url: string, token: string, interactive: boolean = false): Promise<boolean> {
    const knowledge = buildDevinKnowledge(url, token);
    const playbook = buildDevinPlaybook(url, token);
    const bundle = [
        '# Dao 手动注入包 (Windsurf Token 模式)',
        '',
        '> 你的登录 Token 为 Windsurf 会话令牌(devin-session-token$)，无法经 API 直接写入 app.devin.ai。',
        '> 下列内容已为你备好；Simple Browser 已用你的登录态打开对应页面，按标题粘贴即可。',
        '> 恢复全自动注入：到 Settings → API Keys 生成 cog_ 开头的 Devin API Key，填入 ~/.dao/dao-config.json 的 devinApiKey。',
        '',
        '## 1) Secret  ->  ' + DEVIN_APP + '/settings/secrets',
        'Name: DAO_TOKEN',
        'Value: ' + token,
        '',
        '## 2) Knowledge  ->  ' + DEVIN_APP + '/knowledge',
        'Name: Dao Workspace Server',
        'Trigger: When user asks to operate on local machine, execute commands locally, read/write local files, or mentions local environment or Dao',
        '',
        '```',
        knowledge,
        '```',
        '',
        '## 3) Playbook  ->  ' + DEVIN_APP + '/playbooks',
        'Title: Operate Local Environment via Dao',
        '',
        '```',
        playbook,
        '```',
        ''
    ].join('\n');
    let bundleFile = '';
    try {
        if (!fs.existsSync(DAO_DIR)) fs.mkdirSync(DAO_DIR, { recursive: true });
        bundleFile = path.join(DAO_DIR, 'dao-manual-inject-' + (ws.devinOrgSlug || ws.devinOrgId || 'org') + '.md');
        fs.writeFileSync(bundleFile, bundle, 'utf8');
    } catch {}
    try {
        const state = { email: ws.devinEmail, orgId: ws.devinOrgId, orgName: ws.devinOrgName, mode: 'assisted-manual', bundleFile: bundleFile, timestamp: new Date().toISOString() };
        fs.writeFileSync(ws.injectStateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
    try { await vscode.env.clipboard.writeText(token); } catch {}
    // 去芜存菁 · 帛书「道法自然」— 仅用户显式操作时才弹窗(打开 MD/官网); 启动自动链/切号静默, 不打扰
    if (interactive) {
        try { if (bundleFile) { const doc = await vscode.workspace.openTextDocument(bundleFile); await vscode.window.showTextDocument(doc, { preview: false }); } } catch {}
        try { vscode.commands.executeCommand('simpleBrowser.show', daoRoutedWebUrl('/settings/secrets')); }
        catch { try { vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP + '/settings/secrets')); } catch {} }
        vscode.window.showInformationMessage('Windsurf Token 模式: 已生成注入包并复制 Token 到剪贴板。注入包: ' + bundleFile + ' — 按其中标题粘贴到已打开的 Devin Cloud 页面即可（或生成 cog_ Key 恢复全自动）。');
    }
    return true;
}

async function devinFullInject(interactive: boolean = false, auto: boolean = false): Promise<boolean> {
    if (ws.devinInjecting) return false;
    ws.devinInjecting = true;
    try {
        // 归零清理协同: 纯自动跟随注入(开机自同步/切号自跟随/自动模式回跟) 若当前账号已被 RT Flow
        //   清理/出库 → 守柔跳过, 不再自动重新填充; 用户主动登录/切号/点注入则照常(单账号主权)。
        if (auto && !interactive) {
            const curEmail = (ws.devinEmail || emailForOrg(ws.devinOrgId) || '').trim().toLowerCase();
            if (curEmail && isInjectSuppressedForEmail(curEmail)) {
                try { console.log('[dao] full-inject(auto) skip cleaned account: ' + curEmail); } catch { /* 守柔 */ }
                return false;
            }
        }
        const url = ws.publicUrl || (ws.port ? 'http://localhost:' + ws.port : '');
        const token = ws.token;
        if (!url || !token) {
            vscode.window.showErrorMessage('Server not running or no relay URL');
            return false;
        }
        if (!ws.devinAuth1 || !ws.devinOrgId) {
            vscode.window.showErrorMessage('Not logged into Devin Cloud');
            return false;
        }
        // 反者道之动 — cog_ 直通全自动注入; Windsurf session token 无法经 API 写入 → 转辅助注入(无为而无不为)
        if (!devinCanUseApi()) {
            return await devinAssistedInject(url, token, interactive);
        }
        // Upsert Secret (先删后建 → URL永远不stale)
        const sec = await devinUpsertSecret(ws.devinOrgId, 'DAO_TOKEN', token, ws.devinAuth1);
        // 唯二·知识②内网穿透板块 — 用动态生成的 DAO Bridge 文档(含连接URL/Token/API), 与种入态同名同触发
        // → 不再另立 'Dao Workspace Server' 异名残条, 知识库收敛为唯二规范条目。
        const kb = bridgeGenerateCloudMd();
        const kn = await devinUpsertKnowledge(ws.devinOrgId, DAO_BRIDGE_KB_NAME, kb, DAO_BRIDGE_KB_TRIGGER, ws.devinAuth1);
        // Upsert Playbook
        const pb = buildDevinPlaybook(url, token);
        const pl = await devinUpsertPlaybook(ws.devinOrgId, 'Operate Local Environment via Dao', pb, ws.devinAuth1);
        // ★ 帛书规则板块 (板块二) · 你本无名…道德经/阴符经 · 删旧注新(upsert) · 道法自然
        let rulesOk = true;
        const rulesText = getDaoRulesText();
        if (rulesText) {
            const rk = await devinUpsertKnowledge(
                ws.devinOrgId,
                DAO_RULES_KB_NAME,
                rulesText,
                DAO_RULES_KB_TRIGGER,
                ws.devinAuth1,
            );
            rulesOk = rk.ok;
        }
        // 老旧异名残条收敛 → 唯二 (覆盖既有 org 历史注入)
        try { await devinCleanLegacyDaoKnowledge(ws.devinOrgId, ws.devinAuth1); } catch { /* 守柔 */ }
        // Inject GitHub PAT if available
        const cfg = getDaoConfig();
        const githubPat = cfg.githubPat || process.env.DAO_GITHUB_PAT || '';
        let gitOk = false;
        if (githubPat) {
            const gr = await devinInjectGitHubPAT(ws.devinOrgId, githubPat, ws.devinAuth1);
            gitOk = gr.ok;
        }
        // Save inject state
        // Save inject state — 帛书·三十九「致数与无与」per-workspace + 全局注册表
        const state = {
            email: ws.devinEmail, orgId: ws.devinOrgId, orgName: ws.devinOrgName,
            secret: sec.ok, knowledge: kn.ok, playbook: pl.ok, rules: rulesOk, git: gitOk,
            quota: ws.devinQuota, timestamp: new Date().toISOString()
        };
        // Per-workspace注入状态 — 窗口专属
        try { fs.writeFileSync(ws.injectStateFile, JSON.stringify(state, null, 2), 'utf8'); } catch {}
        // 全局注入注册表 — 数组合集
        const globalInjectFile = path.join(DAO_DIR, 'dao-inject-state.json');
        try {
            let allInjections: any[] = [];
            try { allInjections = JSON.parse(fs.readFileSync(globalInjectFile, 'utf8')); if (!Array.isArray(allInjections)) allInjections = []; } catch {}
            allInjections = allInjections.filter((e: any) => e.orgId !== ws.devinOrgId);
            allInjections.push(Object.assign({}, state, { workspaceKey: ws.workspaceKey, pid: process.pid }));
            fs.writeFileSync(globalInjectFile, JSON.stringify(allInjections, null, 2), 'utf8');
        } catch {}
        const allOk = sec.ok && kn.ok && pl.ok && rulesOk;
        if (allOk) {
            vscode.window.showInformationMessage('Dao inject complete: Secret ✓ Knowledge ✓ Playbook ✓ 帛书规则 ✓' + (gitOk ? ' Git ✓' : ''));
        } else {
            vscode.window.showWarningMessage('Dao inject partial: Secret=' + (sec.ok ? '✓' : '✗') + ' Knowledge=' + (kn.ok ? '✓' : '✗') + ' Playbook=' + (pl.ok ? '✓' : '✗') + ' 帛书规则=' + (rulesOk ? '✓' : '✗'));
        }
        // 默认每账号自动注入种入态 (《道德经·阴符经》知识/剧本 + 内网穿透云端MD) —
        // 任何登录/注入路径(IDE自动跟随·手动登录·HTTP /api/devin/inject)均落地, 不止IDE自动跟随。
        // 帛书·「善建者不拔·善抱者不脱」 · enabled=false 即纯手动, 自循环自身守柔跳过。
        try { await runInjectProfileSelfLoop(); } catch { /* 守柔 */ }
        return allOk;
    } finally {
        ws.devinInjecting = false;
    }
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · 批量多账号反向注入 — 帛书「既以为人己愈有, 既以与人己愈多」
// 对一批账号(email/password)逐个取 auth1+orgId(优先按邮箱缓存, 失效再登录),
// 幂等注入(先收敛旧异名残条): 知识「道法自然准则」+「DAO Bridge 内网穿透」
// + 剧本「Operate Local Environment via Dao」+ Secret「DAO_TOKEN」。
// 全程自包含, 不改动当前面板登录态(ws.*); CJK 经 asciiSafeJson \uXXXX 上线服务端无损。
// ═══════════════════════════════════════════════════════════
interface DaoBatchAccount { email: string; password: string; }
interface DaoBatchResult { email: string; ok: boolean; auth: string; orgId?: string; knowledge: boolean; bridge: boolean; playbook: boolean; secret: boolean; profile: boolean; cleaned: number; verified: boolean; error?: string; skipped?: boolean; }
interface DaoBatchProgress { total: number; done: number; ok: number; running: boolean; results: DaoBatchResult[]; startedAt: string; finishedAt?: string; }
let daoBatchProgress: DaoBatchProgress | null = null;

// 仅登录取 auth1+orgId(login + devin post-auth), 不写 ws.*; 含 429 退避。
async function devinAuthOnly(email: string, password: string, retry?: number): Promise<{ ok: boolean; auth1?: string; orgId?: string; userId?: string; orgName?: string; error?: string }> {
    const n = retry || 0;
    const r1 = await devinJsonPost(DEVIN_URL_LOGIN, { Origin: DEVIN_WINDSURF, Referer: DEVIN_WINDSURF + '/account/login' }, { email, password });
    if (r1.status === 429 && n < 4) { await new Promise(ok => setTimeout(ok, Math.pow(2, n) * 3000)); return devinAuthOnly(email, password, n + 1); }
    const j1 = r1.json || {};
    const auth1 = j1.token || j1.auth1_token;
    if (r1.status !== 200 || !auth1) return { ok: false, error: 'login HTTP ' + r1.status + ': ' + (j1.detail || j1.error || 'no_token') };
    const userId = j1.user_id || '';
    let orgId = '', orgName = '';
    for (let i = 0; i < 2 && !orgId; i++) {
        const r3 = await devinJsonPost(DEVIN_URL_DEVIN_POST_AUTH, { Authorization: 'Bearer ' + auth1, 'Content-Type': 'application/json' }, {});
        const j3 = r3.json || {};
        orgId = (j3.org && j3.org.org_id) || j3.org_id || j3.orgId || '';
        if (!orgName) orgName = (j3.org && j3.org.org_name) || j3.org_name || j3.orgName || '';
        if (!orgId) await new Promise(ok => setTimeout(ok, 1000));
    }
    if (!orgId) return { ok: false, error: 'no_org' };
    return { ok: true, auth1, orgId, userId, orgName };
}

// 解析账号来源: 显式数组 / 多行 email:password 文本 / 本机账号池(loadAccountPool)。
function resolveBatchAccounts(opts: { accounts?: DaoBatchAccount[]; lines?: string; all?: boolean }): DaoBatchAccount[] {
    if (Array.isArray(opts.accounts) && opts.accounts.length) {
        return opts.accounts.filter(a => a && a.email && a.password);
    }
    if (typeof opts.lines === 'string' && opts.lines.trim()) {
        const out: DaoBatchAccount[] = [];
        for (const raw of opts.lines.split(/\r?\n/)) {
            const p = parseAccountLine(raw.trim());
            if (p && p.email && p.password) out.push({ email: p.email, password: p.password });
        }
        return out;
    }
    if (opts.all) return loadAccountPool().map(a => ({ email: a.email, password: a.password })).filter(a => a.email && a.password);
    return [];
}

// ── 每账号「期望态签名」缓存 (~/.dao/dao-inject-sig.json: orgId → sig) ──────────────
//   帛书·「为学者日益, 闻道者日损」: 已收敛之账号不必每轮重注. 期望态(token/桥URL/准则/桥MD/
//   用户档案 K-P-S-MCP-Automation-额度)内容哈希为 sig; 某 org 缓存 sig == 当前期望 sig 即「已收敛」,
//   经一次廉价 GET 验证缓存 auth 仍活后直接跳过其余全部上行写入. 唯期望态变(改档案/桥URL轮换/换token)
//   方使 sig 变 → 触发该批重注收敛. 由此稳态核对 = 全池仅各一次 GET, 秒级完成 (不再 90 分钟串行).
const INJECT_SIG_FILE = path.join(DAO_DIR, 'dao-inject-sig.json');
function loadInjectSigMap(): Record<string, string> {
    try { const j = JSON.parse(fs.readFileSync(INJECT_SIG_FILE, 'utf8')); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch { return {}; }
}
function saveInjectSigMap(m: Record<string, string>): void {
    try { fs.writeFileSync(INJECT_SIG_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch { /* 守柔 */ }
}
function computeOrgInjectSig(token: string, url: string, rulesText: string, bridgeMd: string, p: InjectProfile): string {
    const h = (s: string) => crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex').slice(0, 12);
    const items = JSON.stringify({
        s: p.secrets.map(x => x.name + '=' + h(x.value)).sort(),
        k: p.knowledge.map(x => x.name + ':' + h(x.body) + ':' + (x.trigger || '')).sort(),
        pb: p.playbooks.map(x => x.title + ':' + h(x.body)).sort(),
        m: p.mcps.map(x => mcpSlug(x) + ':' + h(x.url || x.command || '')).sort(),
        a: (p.automations || []).map(x => x.name + ':' + h(x.prompt || '')).sort(),
        ml: p.messageLimitAuto ? 'auto' : String(p.messageLimit),
        mo: p.messageLimitOffset, en: p.enabled, ac: p.autoCleanup,
    });
    return h([token, url, h(rulesText), h(bridgeMd), items].join('|'));
}
function getBatchInjectConcurrency(): number {
    try {
        const c = vscode.workspace.getConfiguration('dao').get<number>('batchInjectConcurrency');
        if (typeof c === 'number' && c >= 1) return Math.min(12, Math.floor(c));
    } catch { /* 守柔 */ }
    return 6;
}
async function devinBatchInject(accounts: DaoBatchAccount[]): Promise<DaoBatchProgress> {
    const url = ws.publicUrl || (ws.port ? 'http://localhost:' + ws.port : '');
    const token = ws.token || bridgeToken || '';
    const rulesText = getDaoRulesText();
    const bridgeMd = bridgeGenerateCloudMd();
    const pbBody = (url && token) ? buildDevinPlaybook(url, token) : '';
    // 批量反向注入全覆盖: 除固定道藏集(准则KB+桥KB+桥控制剧本+DAO_TOKEN),
    // 还把用户完整注入档案(用户自添 K/P/S/MCP/Automations/额度上限)逐账号注入到官网 org。
    const injectProfile = loadInjectProfile();
    const desiredSig = computeOrgInjectSig(token, url, rulesText, bridgeMd, injectProfile);
    const sigMap = loadInjectSigMap();
    daoBatchProgress = { total: accounts.length, done: 0, ok: 0, running: true, results: [], startedAt: new Date().toISOString() };
    const resultsFile = path.join(DAO_DIR, 'dao-batch-inject-results.json');
    const flush = () => { try { fs.writeFileSync(resultsFile, JSON.stringify(daoBatchProgress, null, 2), 'utf8'); } catch { /* 守柔 */ } };
    // 单账号注入(纯函数式·只读全局期望态, 写自身 res 与 sigMap[orgId]; 无共享可变态 → 可并发)。
    const injectOne = async (a: DaoBatchAccount): Promise<DaoBatchResult> => {
        const res: DaoBatchResult = { email: a.email, ok: false, auth: '', knowledge: false, bridge: false, playbook: false, secret: false, profile: false, cleaned: 0, verified: false };
        // 归零清理协同: RT Flow 已清理/出库的账号 → 批量自动注入守柔跳过 (除非用户主页单账号手动注入)。
        if (isInjectSuppressedForEmail(a.email)) { res.skipped = true; res.auth = 'skipped_cleaned'; return res; }
        try {
            let auth1 = '', orgId = '';
            // 优先用按邮箱缓存的 auth1(切回即命中, 守柔省登录), GET 校验仍有效再用。
            const saved = loadAccountAuth(a.email);
            if (saved && saved.auth1 && saved.orgId) {
                const chk = await devinListKnowledge(saved.orgId, saved.auth1);
                if (chk.ok) { auth1 = saved.auth1; orgId = saved.orgId; res.auth = 'cached'; }
            }
            // 已收敛快路: 缓存 auth 仍活 且 该 org 缓存 sig == 当前期望 sig → 跳过全部上行写入(稳态秒级)。
            if (auth1 && orgId && sigMap[orgId] === desiredSig) {
                res.auth = 'skip-converged'; res.knowledge = res.bridge = res.secret = res.profile = res.playbook = res.verified = true; res.ok = true;
                return res;
            }
            if (!auth1) {
                const auth = await devinAuthOnly(a.email, a.password);
                if (!auth.ok) { res.error = auth.error; res.auth = 'login_failed'; return res; }
                auth1 = auth.auth1!; orgId = auth.orgId!; res.auth = 'login';
            }
            res.orgId = orgId;
            try { res.cleaned = await devinCleanLegacyDaoKnowledge(orgId, auth1); } catch { /* 守柔 */ }
            if (rulesText) res.knowledge = (await devinUpsertKnowledge(orgId, DAO_RULES_KB_NAME, rulesText, DAO_RULES_KB_TRIGGER, auth1)).ok;
            if (token) res.bridge = (await devinUpsertKnowledge(orgId, DAO_BRIDGE_KB_NAME, bridgeMd, DAO_BRIDGE_KB_TRIGGER, auth1)).ok;
            if (token) res.secret = (await devinUpsertSecret(orgId, 'DAO_TOKEN', token, auth1)).ok;
            // 剧本「老三样」(道法自然合订/帛书老子/道藏阴符经)随档案注入; 不再注入「Operate Local Environment via Dao」
            //   (本机操作说明已并入知识库内穿MD+MCP文档), 该旧剧本由 resetOrgInjectables 自动清除。
            // 全覆盖: 把用户完整注入档案(K/P/S/MCP/Automations)注入该账号; 先清后注且单账号锁定项被跳过不覆盖。
            // 用户自选档案受 enabled 门控; !enabled 时仅注系统级固定道藏, 不触碰用户 org 自选项(根治「新账号初始化没配好」)。
            if (injectProfile.enabled) { try { await applyInjectProfileToOrg(orgId, auth1, injectProfile); res.profile = true; res.playbook = true; } catch { /* 守柔 */ } }
            else { res.profile = true; res.playbook = true; }
            // 校验: 回读知识库确认「道法自然准则」落地且正文完整(防截断/损坏)
            //   写后即读存在索引延迟(read-after-write lag) → 守柔退避重读至多3次(0/400/900ms);
            //   命中即止, 仅未命中才退避, 不拖累正常路径 (verified 仅为诊断标志, 不参与 res.ok 判定)。
            if (rulesText) {
                const expLen = Math.max(0, rulesText.length - 4);
                for (let attempt = 0; attempt < 3 && !res.verified; attempt++) {
                    if (attempt > 0) await new Promise(r => setTimeout(r, attempt === 1 ? 400 : 900));
                    try {
                        const back = await devinListKnowledge(orgId, auth1);
                        if (back.ok && back.learnings) {
                            const hit = back.learnings.find((k: any) => k.name === DAO_RULES_KB_NAME);
                            res.verified = !!(hit && typeof hit.body === 'string' && hit.body.length >= expLen);
                        }
                    } catch { /* 守柔 */ }
                }
            }
            // 成功 = 准则KB落地 + (无桥控制剧本或已注) + (无DAO_TOKEN或已注) + 用户完整档案已应用
            res.ok = (!rulesText || res.knowledge) && (!pbBody || res.playbook) && (!token || res.secret) && res.profile;
            // 收敛即落 sig: 仅成功才记, 失败下轮重试(不误标已收敛)。
            if (res.ok && orgId) sigMap[orgId] = desiredSig;
        } catch (e: any) { res.error = e?.message || String(e); }
        return res;
    };
    // 有界并发池 — 帛书·「天下之至柔, 驰骋于天下之致坚」: 串行 ~40s/账号 × N 账号(实测 144 账号 ~96 分钟,
    //   久过窗口重启周期 → 永不收敛). 改有界并发(默认 6, 守柔防 429), 稳态因 sig 快路再降至秒级。
    const concurrency = Math.max(1, Math.min(getBatchInjectConcurrency(), accounts.length || 1));
    let next = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const i = next++;
            if (i >= accounts.length) break;
            const res = await injectOne(accounts[i]);
            if (res.ok) daoBatchProgress!.ok++;
            daoBatchProgress!.results.push(res);
            daoBatchProgress!.done++;
            if (daoBatchProgress!.done % 8 === 0) flush();
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    saveInjectSigMap(sigMap);
    daoBatchProgress.running = false;
    daoBatchProgress.finishedAt = new Date().toISOString();
    flush();
    return daoBatchProgress;
}

// ═══════════════════════════════════════════════════════════
// 道法自然 · 自动注入自循环 — 帛书·「善建者不拔·善抱者不脱」
// 用户初始配置一次 inject-profile → 此后无论账号怎么切, 系统自动把同一份
// 注入应用到新账号 org; 默认自动清理旧账号 org 的旧注入(用户可关闭)。
// 守柔: enabled=false 即纯手动, 系统不自动注入。
// ~/.dao/dao-inject-profile.json
// ═══════════════════════════════════════════════════════════
const INJECT_PROFILE_FILE = path.join(DAO_DIR, 'dao-inject-profile.json');
interface InjectProfileItemS { name: string; value: string }
interface InjectProfileItemK { name: string; body: string; trigger?: string; _preview?: string }
interface InjectProfileItemP { title: string; body: string }
// 钉住的 MCP — 切账号即幂等注入到新 org (如 GitHub MCP / 本地 141 HTTP MCP)
interface InjectProfileItemM {
    name: string; slug?: string; transport?: string; short_description?: string;
    command?: string; args?: string[]; env_variables?: any[]; url?: string; headers?: any;
    installation_scope?: string;
}
// 钉住的 Automation — 切账号即幂等注入到新 org (schema 已逆流实测: POST 201 / DELETE 200)
// 默认 webhook:incoming 触发 + start_session(prompt) 动作; triggers/actions 可手编覆盖。
interface InjectProfileItemA {
    name: string; prompt?: string; enabled?: boolean;
    triggers?: any[]; actions?: any[];
}
interface InjectProfile {
    enabled: boolean;
    autoCleanup: boolean;
    secrets: InjectProfileItemS[];
    knowledge: InjectProfileItemK[];
    playbooks: InjectProfileItemP[];
    mcps: InjectProfileItemM[];
    automations: InjectProfileItemA[];
    messageLimit: number | null;
    messageLimitAuto?: boolean;
    messageLimitOffset?: number;
    lastInjectedOrg: string;
    daoSeeded?: boolean;
}
function mcpSlug(m: InjectProfileItemM): string {
    return String(m.slug || m.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function loadInjectProfile(): InjectProfile {
    try {
        const j = JSON.parse(fs.readFileSync(INJECT_PROFILE_FILE, 'utf8'));
        return {
            enabled: !!j.enabled,
            autoCleanup: j.autoCleanup !== false,
            secrets: Array.isArray(j.secrets) ? j.secrets : [],
            knowledge: Array.isArray(j.knowledge) ? j.knowledge : [],
            playbooks: Array.isArray(j.playbooks) ? j.playbooks : [],
            mcps: Array.isArray(j.mcps) ? j.mcps : [],
            automations: Array.isArray(j.automations) ? j.automations : [],
            messageLimit: (typeof j.messageLimit === 'number') ? j.messageLimit : null,
            // 额度跟随环默认开 — 帛书·「反者道之动」: 字段缺省且未设固定值 → 自动跟随剩余额度(不覆盖用户的显式选择/固定上限)
            messageLimitAuto: (typeof j.messageLimitAuto === 'boolean') ? j.messageLimitAuto : (typeof j.messageLimit !== 'number'),
            messageLimitOffset: (typeof j.messageLimitOffset === 'number') ? j.messageLimitOffset : 3,
            lastInjectedOrg: j.lastInjectedOrg || '',
            daoSeeded: !!j.daoSeeded,
        };
    } catch {
        return { enabled: false, autoCleanup: true, secrets: [], knowledge: [], playbooks: [], mcps: [], automations: [], messageLimit: null, messageLimitAuto: true, messageLimitOffset: 3, lastInjectedOrg: '', daoSeeded: false };
    }
}
function saveInjectProfile(p: InjectProfile): void {
    try { fs.mkdirSync(DAO_DIR, { recursive: true }); fs.writeFileSync(INJECT_PROFILE_FILE, JSON.stringify(p, null, 2), 'utf8'); } catch { /* 守柔 */ }
}
// 道·「绝利一源」单账号手动锁定 — 用户在单账号 K/P/S/MCP 面板手动新建/锁定的条目,
// 切账号反向注入 autoCleanup 时按 (orgId,kind,name) 豁免, 不被批量清理。守柔: 只防删, 永不多删。
const INJECT_MANUAL_LOCKS_FILE = path.join(DAO_DIR, 'dao-inject-manual-locks.json');
type ManualLockKind = 'knowledge' | 'playbooks' | 'secrets' | 'mcps' | 'automations' | 'schedules';
interface ManualLockOrg { knowledge: string[]; playbooks: string[]; secrets: string[]; mcps: string[]; schedules?: string[]; }
function loadManualLocks(): Record<string, ManualLockOrg> {
    try { const j = JSON.parse(fs.readFileSync(INJECT_MANUAL_LOCKS_FILE, 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch { return {}; }
}
function saveManualLocks(m: Record<string, ManualLockOrg>): void {
    try { fs.mkdirSync(DAO_DIR, { recursive: true }); fs.writeFileSync(INJECT_MANUAL_LOCKS_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch { /* 守柔 */ }
}
function manualLockOrgRef(m: Record<string, ManualLockOrg>, orgId: string): ManualLockOrg {
    if (!m[orgId]) m[orgId] = { knowledge: [], playbooks: [], secrets: [], mcps: [] };
    const o = m[orgId];
    if (!Array.isArray(o.knowledge)) o.knowledge = [];
    if (!Array.isArray(o.playbooks)) o.playbooks = [];
    if (!Array.isArray(o.secrets)) o.secrets = [];
    if (!Array.isArray(o.mcps)) o.mcps = [];
    return o;
}
function isManualLocked(orgId: string, kind: ManualLockKind, name: string): boolean {
    if (!orgId || !name) return false;
    const o = loadManualLocks()[orgId];
    if (!o) return false;
    const arr = (o as any)[kind];
    return Array.isArray(arr) && arr.some((x: string) => String(x).toLowerCase() === String(name).toLowerCase());
}
function setManualLock(orgId: string, kind: ManualLockKind, name: string, locked: boolean): void {
    if (!orgId || !name) return;
    const m = loadManualLocks();
    const arr = (manualLockOrgRef(m, orgId) as any)[kind] as string[];
    const idx = arr.findIndex((x) => String(x).toLowerCase() === String(name).toLowerCase());
    if (locked && idx < 0) arr.push(name);
    else if (!locked && idx >= 0) arr.splice(idx, 1);
    saveManualLocks(m);
}
const DAO_BRIDGE_KB_NAME = 'DAO Bridge 内网穿透远程操作文档';
const DAO_BRIDGE_KB_SENTINEL = '__DAO_BRIDGE_CLOUD_MD__';
// 触发器 · 所有对话均触发(常驻检索): 让每个对话的 Agent 都先知道"可远程操作用户本地电脑(读写文件/执行命令/整机直连)"的存在与方法。
const DAO_BRIDGE_KB_TRIGGER = '所有对话均触发 · 任何任务开始时都应先知道:可远程操作用户本地电脑(读写文件、执行命令、整机直连)的方法。Always retrieve this in every conversation.';
// 触发器 · 所有对话均触发(常驻检索): 深层四大模块 MCP(浏览器自动化/GUI/控件树/VSCode 命令)的用法亦随每个对话注入。
const DAO_MCP_KB_NAME = 'DAO Bridge MCP 使用文档(四大模块)';
const DAO_MCP_KB_SENTINEL = '__DAO_BRIDGE_MCP_MD__';
const DAO_MCP_KB_TRIGGER = '所有对话均触发 · 任何任务都应知道:可用 DAO Bridge MCP 做浏览器自动化(CDP)、GUI 鼠键截屏、窗口控件树、VSCode 命令等深层远程操作。Always retrieve this in every conversation.';
// secret · 用户填入的 GitHub PAT 作为一个 secret 反向注入到所有账号 (图: secret=rt flow 用户 pat)
const DAO_PAT_SECRET_NAME = 'GITHUB_PAT';
// 唯二·知识① 道法自然(帛书老子+阴符经) — 与种入态/一键注入同名同触发, 收敛为单一规范条目
const DAO_RULES_KB_NAME = '道法自然准则';
const DAO_RULES_KB_TRIGGER = '所有对话均触发 道法自然';
// 道法自然 · 默认种入: 每账号自动注入《道德经·阴符经》知识 + 剧本 + 内网穿透MD
// 守柔: 仅首次(daoSeeded)种入; 用户此后可在面板自由增删/关闭
function daoSeedDefaultInjectProfile(): void {
    try {
        const p = loadInjectProfile();
        if (p.daoSeeded) return;
        const combined = getDaoRulesText();
        const preamble = getDaoAsset('preamble.txt');
        const laozi = getDaoAsset('laozi.txt');
        const yinfu = getDaoAsset('yinfujing.txt');
        // 知识① 道法自然(帛书老子+阴符经) — 所有对话均触发
        if (combined && !p.knowledge.some(k => k.name === DAO_RULES_KB_NAME)) {
            p.knowledge.push({ name: DAO_RULES_KB_NAME, body: combined, trigger: DAO_RULES_KB_TRIGGER });
        }
        // 知识② 内网穿透云端MD(原始·整机直连) — 日常远程操作本机时触发 (注入时实时生成最新)
        if (!p.knowledge.some(k => k.name === DAO_BRIDGE_KB_NAME)) {
            p.knowledge.push({ name: DAO_BRIDGE_KB_NAME, body: DAO_BRIDGE_KB_SENTINEL, trigger: DAO_BRIDGE_KB_TRIGGER });
        }
        // 知识③ MCP 使用文档(四大模块) — 需要浏览器/GUI/VSCode 等更深层专业操作时触发 (注入时实时生成最新)
        if (!p.knowledge.some(k => k.name === DAO_MCP_KB_NAME)) {
            p.knowledge.push({ name: DAO_MCP_KB_NAME, body: DAO_MCP_KB_SENTINEL, trigger: DAO_MCP_KB_TRIGGER });
        }
        // 剧本①合订 ②帛书老子 ③阴符经 — 全部默认自动注入
        if (combined && !p.playbooks.some(x => x.title === '道法自然 · 帛书《老子》·道藏《阴符经》')) {
            p.playbooks.push({ title: '道法自然 · 帛书《老子》·道藏《阴符经》', body: combined });
        }
        if (laozi && !p.playbooks.some(x => x.title === '帛书《老子》')) {
            p.playbooks.push({ title: '帛书《老子》', body: (preamble ? preamble + '\n\n' : '') + laozi });
        }
        if (yinfu && !p.playbooks.some(x => x.title === '道藏《阴符经》')) {
            p.playbooks.push({ title: '道藏《阴符经》', body: '你本無名 名可名也 非恒名也 所遵從之一切均來自於下述道藏《陰符經》：\n\n' + yinfu });
        }
        p.daoSeeded = true;
        if (!p.enabled) p.enabled = true;
        saveInjectProfile(p);
    } catch { /* 道法自然·守柔 */ }
}
// 知识库收口迁移 — 帛书·「少则得」: 收敛老账号注入档案至「三知识 + 老三样剧本」规范态(幂等, 不受 daoSeeded 限制)。
//   知识①道法自然准则 ②原始内网穿透MD(整机直连) ③MCP 使用文档(四大模块) + 对齐分层触发器;
//   知识③ MCP 使用文档补齐; 剧本补齐「帛书《老子》/ 道藏《阴符经》」两条单本 → 与合订本共为老三样。
function daoMigrateKnowledgeTrinity(): void {
    try {
        const p = loadInjectProfile();
        let changed = false;
        const b = p.knowledge.find(k => k && k.name === DAO_BRIDGE_KB_NAME);
        if (b && b.trigger !== DAO_BRIDGE_KB_TRIGGER) { b.trigger = DAO_BRIDGE_KB_TRIGGER; changed = true; }
        if (!p.knowledge.some(k => k && k.name === DAO_MCP_KB_NAME)) {
            p.knowledge.push({ name: DAO_MCP_KB_NAME, body: DAO_MCP_KB_SENTINEL, trigger: DAO_MCP_KB_TRIGGER });
            changed = true;
        }
        // 剧本老三样补齐(合订/帛书老子/道藏阴符经) — 老档案常仅有合订一条
        try {
            const combined = getDaoRulesText();
            const preamble = getDaoAsset('preamble.txt');
            const laozi = getDaoAsset('laozi.txt');
            const yinfu = getDaoAsset('yinfujing.txt');
            if (combined && !p.playbooks.some(x => x && x.title === '道法自然 · 帛书《老子》·道藏《阴符经》')) {
                p.playbooks.push({ title: '道法自然 · 帛书《老子》·道藏《阴符经》', body: combined }); changed = true;
            }
            if (laozi && !p.playbooks.some(x => x && x.title === '帛书《老子》')) {
                p.playbooks.push({ title: '帛书《老子》', body: (preamble ? preamble + '\n\n' : '') + laozi }); changed = true;
            }
            if (yinfu && !p.playbooks.some(x => x && x.title === '道藏《阴符经》')) {
                p.playbooks.push({ title: '道藏《阴符经》', body: '你本無名 名可名也 非恒名也 所遵從之一切均來自於下述道藏《陰符經》：\n\n' + yinfu }); changed = true;
            }
        } catch { /* 守柔 */ }
        if (changed) saveInjectProfile(p);
    } catch { /* 守柔 */ }
}
// GitHub PAT 形态识别(归一): 经典 ghp_ · 细粒度 github_pat_ · OAuth gho_ · App 用户 ghu_。
//   仅认 ghp_ 会把日益默认的细粒度 PAT(github_pat_)误判非 PAT → 漏注密钥。
function isGitHubPat(s: string): boolean {
    const t = String(s || '').trim();
    return /^(ghp_|github_pat_|gho_|ghu_)/.test(t);
}
// secret=PAT · 把用户填入的 GitHub PAT(dao.githubPat / DAO_GITHUB_PAT)作为一个 secret 写入注入档案,
// 经反向注入路径(applyInjectProfileToOrg→devinUpsertSecret)同步到所有账号。
// 守柔: 非首次限定 — PAT 可在激活后任意时刻填入/更换, 每次激活幂等校正; PAT 为空则移除残条。
function daoSyncPatSecretIntoProfile(): void {
    try {
        const cfg = getDaoConfig();
        const pat = String(cfg.githubPat || process.env.DAO_GITHUB_PAT || '').trim();
        const p = loadInjectProfile();
        const idx = p.secrets.findIndex(s => s && s.name === DAO_PAT_SECRET_NAME);
        let changed = false;
        if (pat) {
            if (idx < 0) { p.secrets.push({ name: DAO_PAT_SECRET_NAME, value: pat }); changed = true; }
            else if (p.secrets[idx].value !== pat) { p.secrets[idx].value = pat; changed = true; }
            if (!p.enabled) { p.enabled = true; changed = true; }
        } else if (idx >= 0) {
            p.secrets.splice(idx, 1); changed = true;
        }
        if (changed) saveInjectProfile(p);
    } catch { /* 道法自然·守柔 */ }
}
// MCP=DAO Bridge · 把本机 MCP 网关(start_mcp_stack.ps1 写出的公网地址)作为一个钉住 MCP
// 写入注入档案, 经反向注入路径(applyInjectProfileToOrg→devinAddCustomMcp)同步到所有账号。
// 守柔·自愈: 公网快速隧道地址重启会变, 故每次激活幂等校正 — 仅当 url 变化时改写, 不制造无谓写入。
const DAO_MCP_NAME = 'DAO Bridge MCP';
const DAO_MCP_PUBLIC_FILE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'dao_vm', 'mcp_public.json');
// 归一 · 反注 MCP = 插件本体 /mcp: 见 daoResolveMcpEndpoint 注(单隧道·单令牌·全量工具)。
function daoResolveMcpEndpoint(): { url: string; token: string } | null {
    // 帛书·「得一·归一」: 综合 MCP(四模块·全量工具)即插件本体自带 /mcp(daoMcpHandle)——
    //   与 /api 同一进程、同一自有隧道、同一机器权威令牌(checkAuth 放行)。故反注 MCP 端点恒 =
    //   本实例可达隧道 /mcp, 一举归一三利: ①单隧道(免第二条脆弱快速隧道·正是触发 Cloudflare 1015
    //   限流之源) ②单令牌(免跨域 401: 旧法用 9100 py 网关令牌配自有隧道 /mcp, 而本进程 checkAuth
    //   只认机器权威牌 → 恒 401) ③全量工具(旧 9100 py 网关仅 26 工具, 本体 /mcp 由 daoMcpToolDefs
    //   实时生成 64 工具)。本实例自有隧道空/死时诚实回 null(守柔·待探活环重起, 不注死址)。
    const base = bridgeEffectiveUrl();
    if (/^https?:\/\//.test(base)) return { url: base.replace(/\/+$/, '') + '/mcp', token: bridgeEffectiveToken() };
    // 回退(保守兼容): 仅当自有隧道暂不可知且旧网关确有可达地址(极少)时沿用之。
    try {
        if (fs.existsSync(DAO_MCP_PUBLIC_FILE)) {
            const pub = JSON.parse(fs.readFileSync(DAO_MCP_PUBLIC_FILE, 'utf8'));
            const legacy = String(pub.url || '').trim();
            if (/^https?:\/\//.test(legacy)) return { url: legacy, token: String(pub.token || '').trim() };
        }
    } catch { /* 守柔 */ }
    return null;
}
function daoSyncDaoMcpIntoProfile(): void {
    try {
        const ep = daoResolveMcpEndpoint();
        if (!ep) return;
        const url = ep.url;
        const token = ep.token;
        if (!/^https?:\/\//.test(url)) return;
        const p = loadInjectProfile();
        const idx = p.mcps.findIndex(m => m && m.name === DAO_MCP_NAME);
        const entry: InjectProfileItemM = {
            name: DAO_MCP_NAME, transport: 'HTTP', url,
            short_description: 'DAO four-module: PC control + browser CDP + plugin + vscode',
            installation_scope: 'org',
        };
        if (token) entry.headers = { Authorization: 'Bearer ' + token };
        let changed = false;
        if (idx < 0) { p.mcps.push(entry); changed = true; }
        else if (p.mcps[idx].url !== url || JSON.stringify(p.mcps[idx].headers || {}) !== JSON.stringify(entry.headers || {})) {
            p.mcps[idx] = Object.assign({}, p.mcps[idx], entry); changed = true;
        }
        if (changed) { if (!p.enabled) p.enabled = true; saveInjectProfile(p); }
    } catch { /* 道法自然·守柔 */ }
}
// ═══ v3.17.4 · 内网穿透·实时反向注入 — 随隧道 URL/端口变化自动把最新「操作文档(KB)+归一 MCP」反注到所有账号 ═══
//   触发: BRIDGE_DIR/conn.json 或 dao_vm/mcp_public.json 等变化(常驻桥重建隧道回写) → 防抖 1.5s → 仅当签名(URL/Token/端口)变化才扩散。
//   守柔·省网(不重蹈批量并发卡网覆辙): 签名未变不重注; 逐 org 串行(非并发); KB 幂等 upsert, MCP 先删后建以更新 URL。
let _lastBridgeReinjectSig = '';
// 帛书·「知常曰明」: 记录「实际写进知识库的那条 URL」(非进程内 bridgeUrl, 非已发布 conn 签名)。
//   根治隧道轮换后内部态(bridgeUrl)已收敛到活址、但知识库仍滞留旧死址的脱钩盲区:
//   探活环(ALIVE/DEAD 两路)凡发现「当前活址 ≠ 上次实注地址」即强制补注, 令知识库恒指活址。
let _lastInjectedBridgeUrl = '';
// 帛书·「以实际有效性为基准」: 记录「实际写进知识库的那个 token」。令牌轮换(URL 不变)时,
//   探活环比对此值即可识别"已发布令牌失配"→主动反注入(被动签名机制在 URL 不变时探不出此盲区)。
let _lastInjectedBridgeToken = '';
let _bridgeReinjectInflight = false;
let _bridgeReinjectTimer: ReturnType<typeof setTimeout> | null = null;
function bridgeCurrentSig(): string {
    // 帛书·「URL 与 Token 恒成对·签名须映实际发布」: 签名里的 url/tok 必须与真正写进知识库的一致
    //   ——即 bridgeEffectiveUrl()/bridgeEffectiveToken()(本实例可达隧道 + 机器权威牌·单一权威)。
    //   切勿再以他者进程 conn.json 的 (url,token) 覆写: 那与实际注入内容异源 → 签名恒对不上实注,
    //   或永不翻(漏注)、或反复翻(徒 churn)。得一: 签名 = 实注对。
    const url = bridgeEffectiveUrl();
    const tok = bridgeEffectiveToken();
    let mcpUrl = '', mcpTok = '';
    try { const ep = daoResolveMcpEndpoint(); if (ep) { mcpUrl = ep.url; mcpTok = ep.token; } } catch { /* 守柔 */ }
    // 软编码·实时态: 设备/IDE/工作区/工具集/版本任一变即翻签名 → 反向注入随之刷新(不含易变时间戳, 杜绝无谓 churn)。
    //   令 MCP/内穿两篇知识恒随「用户各设备与 IDE 整体状态」更新, 你每次连上读到的都是最新(与内穿同逻辑)。
    const host = os.hostname();
    const wsName = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].name) || '';
    const root = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].uri.fsPath) || '';
    let toolN = 0; try { toolN = daoMcpToolDefs().length; } catch { /* 守柔 */ }
    return [url, tok, String(bridgeMachinePort() || ws.port || ''), mcpUrl, mcpTok, host, wsName, root, EXT_VERSION, String(toolN)].join('|');
}
async function reinjectBridgeToAllAccounts(reason: string): Promise<{ injected: number; changed: boolean }> {
    if (_bridgeReinjectInflight) return { injected: 0, changed: false };
    // 机器级文档单一维护者 = leader: 非 leader 实例不写, 杜绝多窗口互相覆盖抖动(URL/Token/端口由 leader 一锤定音)。
    if (!bridgeIsLeaderInstance()) { daoLoopLog('tunnel', 'reinject SKIP(' + reason + '): 非 leader 实例, 机器级内穿/MCP 文档由 leader 统一维护'); return { injected: 0, changed: false }; }
    const sig = bridgeCurrentSig();
    if (sig === _lastBridgeReinjectSig) return { injected: 0, changed: false }; // 无变化·守柔不重注·省网
    _bridgeReinjectInflight = true;
    let injected = 0;
    try {
        // ① 自愈核心: 探活择优, 采纳「当前真实可达」桥地址为本进程 bridgeUrl, 使注入文档用活地址。
        //   宁可守柔不注, 也不以死地址/(未连接) 覆盖账号库良态 — 根治旧实例/轮换把知识库写死致云端找不到端口。
        const live = await bridgeResolveLiveConn(5000);
        if (live && live.url) {
            bridgeUrl = live.url; if (!ws.token && live.token) bridgeToken = live.token; // 守恒: 令牌恒以 ws.token 为准, 不被外部候选漂移
        } else {
            try { console.log('[dao] bridge reinject ABORT: 无活桥地址, 守柔不覆盖账号库 (' + reason + ')'); } catch { /* 守柔 */ }
            daoLoopLog('tunnel', 'reinject ABORT(' + reason + '): 无活地址→守柔不覆盖, 待探活环刷新');
            return { injected: 0, changed: false };
        }
        // 帛书·「URL 与 Token 恒成对」: 注入物恒为探活胜出的那一对(实测鉴权通), 不另取另一域的权威牌。
        const livePair = { url: live.url, token: live.token || bridgeAuthoritativeToken() };
        // 同步 MCP 档案条目(URL 轮换自更) → 取最新钉住条目
        try { daoSyncDaoMcpIntoProfile(); } catch { /* 守柔 */ }
        const md = bridgeGenerateCloudMd(livePair);
        const mcpMd = bridgeGenerateMcpUsageMd();
        const p = loadInjectProfile();
        const mcpEntry = (p.mcps || []).find(m => m && m.name === DAO_MCP_NAME) || null;
        const store = loadAccountsAuthStore();
        const doneOrgs = new Set<string>();
        for (const e of Object.keys(store)) {
            const a = store[e];
            if (!a || !a.auth1 || a.auth1.startsWith('devin-session-token$') || !a.orgId) continue;
            // 归零清理协同: RT Flow 已清理/出库账号 → 内穿实时重注守柔跳过 (除非用户主页单账号手动注入)。
            if (isInjectSuppressedForEmail(e)) continue;
            if (doneOrgs.has(a.orgId)) continue;
            doneOrgs.add(a.orgId);
            // KB②: 幂等 upsert 最新内穿(整机直连)文档 (守 manual 锁)
            if (!isManualLocked(a.orgId, 'knowledge', DAO_BRIDGE_KB_NAME)) {
                try { await devinUpsertKnowledge(a.orgId, DAO_BRIDGE_KB_NAME, md, DAO_BRIDGE_KB_TRIGGER, a.auth1); } catch { /* 守柔 */ }
            }
            // KB③: 幂等 upsert 最新 MCP 使用文档(四大模块·URL 随隧道自更) (守 manual 锁)
            if (!isManualLocked(a.orgId, 'knowledge', DAO_MCP_KB_NAME)) {
                try { await devinUpsertKnowledge(a.orgId, DAO_MCP_KB_NAME, mcpMd, DAO_MCP_KB_TRIGGER, a.auth1); } catch { /* 守柔 */ }
            }
            // MCP: URL 已变 → 先删旧同名安装再建新 (守 manual 锁)
            if (mcpEntry && !isManualLocked(a.orgId, 'mcps', DAO_MCP_NAME)) {
                try {
                    const inst = await devinListMcpInstallations(a.orgId, a.auth1);
                    if (inst.ok && inst.items) {
                        for (const it of inst.items) {
                            if (String(it.name || '').replace(/^★ /, '').toLowerCase() === DAO_MCP_NAME.toLowerCase() && it.id) {
                                try { await devinDeleteMcp(a.orgId, String(it.id), a.auth1); } catch { /* 守柔 */ }
                            }
                        }
                    }
                    await devinAddCustomMcp(a.orgId, Object.assign({}, mcpEntry, { slug: mcpSlug(mcpEntry) }), a.auth1);
                } catch { /* 守柔 */ }
            }
            injected++;
        }
        _lastBridgeReinjectSig = sig;
        _lastInjectedBridgeUrl = livePair.url; // 记录实注活址 → 探活环据此对账, 杜绝 KB 与内部态脱钩
        _lastInjectedBridgeToken = livePair.token; // 记录实注配对令牌(与 URL 同源·实测鉴权胜出者) → 探活环据此对账
        try { bridgeSaveLastInject(_lastInjectedBridgeUrl, _lastInjectedBridgeToken); } catch { /* 守柔 */ }
        try { console.log('[dao] bridge real-time reinject (' + reason + ') → ' + injected + ' org(s)'); } catch { /* 守柔 */ }
    } finally { _bridgeReinjectInflight = false; }
    return { injected, changed: true };
}
function bridgeScheduleReinject(reason: string): void {
    if (_bridgeReinjectTimer) { clearTimeout(_bridgeReinjectTimer); }
    _bridgeReinjectTimer = setTimeout(() => { _bridgeReinjectTimer = null; reinjectBridgeToAllAccounts(reason).catch(() => { /* 守柔 */ }); }, 1500);
}
function bridgeWatchForReinject(context: vscode.ExtensionContext): void {
    const dirs = Array.from(new Set([BRIDGE_DIR, DAO_DIR, path.dirname(DAO_MCP_PUBLIC_FILE)]));
    for (const d of dirs) {
        try {
            fs.mkdirSync(d, { recursive: true });
            const w = fs.watch(d, { persistent: false }, (_evt, fname) => {
                const f = String(fname || '');
                if (f === '' || /conn\.json$|mcp_public\.json$|named-tunnel\.json$|tunnel-token$/i.test(f)) bridgeScheduleReinject('watch:' + (f || d));
            });
            context.subscriptions.push({ dispose: () => { try { w.close(); } catch { /* 守柔 */ } } });
        } catch { /* 守柔 */ }
    }
    // IDE 整体状态变更即时反注(签名守柔·未变即空转): 工作区文件夹增删 → 知识库「本机/工作区」行随之刷新。
    try { context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => bridgeScheduleReinject('ws-change'))); } catch { /* 守柔 */ }
}
// ═══════════════════════════════════════════════════════════
// 账号库实时检测 + 全池反向注入闭环 — 帛书·「周行而不殆·独立而不改」
//   切号板块账号池(accounts.json)/共享 auth 库(dao-accounts-auth.json)/注入档案(dao-inject-profile.json)
//   任一变化 → 防抖 2.5s → 全池逐号核对(缺补·旧换·守 manual 锁·守清理抑制):
//     · 新增账号(含仅邮箱密码入池, 经 devinBatchInject 登录兜底)即自动反向注入, 无需手动切号;
//     · 注入档案改动(新增KB/PB/PAT/MCP/额度)即扩散到全池。
//   另每 POOL_RECONCILE_INTERVAL_MS 周期强制自检一次 → 远端态漂移自愈(纯账号配置 API, 不发起消耗额度的对话)。
//   守柔·省网: watch 触发路径按(账号池+档案)快照签名去抖, 未变不重跑; 单飞(inflight)互斥不并发。
// ═══════════════════════════════════════════════════════════
const POOL_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
let _poolReconcileTimer: ReturnType<typeof setInterval> | null = null;
let _poolReconcileDebounce: ReturnType<typeof setTimeout> | null = null;
let _poolReconcileInflight = false;
let _poolReconcileStartMs = 0;
// 看门狗上限: 单轮核对最长 20 分钟; 超过即视为僵死(挂死的上行 await / 进程半残),
//   允许新一轮接管 — 根治曾观测到的 inflight 永久死锁(挂死的 daoBatchInjectAllAccounts
//   令 finally 永不执行, 此后所有 watch/periodic 触发恒 skip=inflight, 反向注入全盘瘫痪)。
//   (20 分钟从容覆盖最坏冷启全池串并行耗时 ~12-16 分, 不误判正常长跑为僵死。)
const POOL_RECONCILE_MAX_MS = 20 * 60 * 1000;
let _lastPoolReconcileSig = '';
function computeAccountPoolSig(): string {
    try {
        const store = loadAccountsAuthStore();
        const parts: string[] = [];
        for (const e of Object.keys(store).sort()) {
            const a: any = store[e] || {};
            parts.push(e + '|' + (a.orgId || '') + '|' + (a.auth1 ? String(a.auth1).slice(0, 12) : ''));
        }
        // 邮箱密码池(切号板块 accounts.json/配置)— 新增账号(尚无 auth1)亦须翻动签名, 否则 watch 触发被签名守柔吞掉, 即用户所报「新增账号不自动注入」。
        try { for (const pa of loadAccountPool(true)) { if (!store[pa.email]) parts.push('pool:' + pa.email); } } catch { /* 守柔 */ }
        const p = loadInjectProfile();
        const pf = [p.enabled ? '1' : '0', p.secrets.length, p.knowledge.length, p.playbooks.length, p.mcps.length, (p.automations || []).length, p.messageLimitAuto ? 'a' : String(p.messageLimit == null ? '-' : p.messageLimit), p.messageLimitOffset].join(',');
        return parts.join(';') + '#' + pf;
    } catch { return ''; }
}
function poolReconcileLog(line: string): void {
    try { fs.appendFileSync(path.join(DAO_DIR, 'dao-pool-reconcile.log'), new Date().toISOString() + ' ' + line + '\n'); } catch { /* 守柔 */ }
}
async function reconcileAccountPoolInject(reason: string, opts?: { force?: boolean }): Promise<{ ok: boolean; okCount: number; total: number; skipped: boolean }> {
    const skip = { ok: false, okCount: 0, total: 0, skipped: true };
    const p = loadInjectProfile();
    // 帛书·「道生之」: 固定道藏(准则KB/桥KB/DAO_TOKEN)是系统级初始化, 不受用户档案 enabled 门控。
    // 原 !p.enabled → skip 导致新账号的系统级初始化(知识库/密钥/规则)被整体跳过(用户报「新添加100个账号·初始化根本没配好」)。
    const hasSystemItems = !!(ws.token || bridgeToken || getDaoRulesText());
    if (!hasSystemItems && !p.enabled) { poolReconcileLog('trigger=' + reason + ' skip=disabled+no-sys'); return skip; }
    const hasUserItems = !!(p.secrets.length || p.knowledge.length || p.playbooks.length || p.mcps.length || (p.automations && p.automations.length) || typeof p.messageLimit === 'number' || p.messageLimitAuto);
    if (!hasSystemItems && !hasUserItems) { poolReconcileLog('trigger=' + reason + ' skip=empty'); return skip; }
    if (_poolReconcileInflight) {
        const age = Date.now() - _poolReconcileStartMs;
        if (age < POOL_RECONCILE_MAX_MS) { poolReconcileLog('trigger=' + reason + ' skip=inflight age=' + Math.round(age / 1000) + 's'); return skip; }
        // 旧轮僵死超时 → 弃之, 新轮接管(旧轮若复活, 其 finally 持旧 token 不会误清新轮 inflight)。
        poolReconcileLog('trigger=' + reason + ' inflight-stale-reset age=' + Math.round(age / 1000) + 's');
    }
    const sig = computeAccountPoolSig();
    if (!(opts && opts.force) && sig === _lastPoolReconcileSig) { poolReconcileLog('trigger=' + reason + ' skip=unchanged-sig'); return skip; }
    const myStart = Date.now();
    _poolReconcileInflight = true;
    _poolReconcileStartMs = myStart;
    poolReconcileLog('trigger=' + reason + (opts && opts.force ? ' force=1' : '') + ' RUN sig-changed');
    try {
        const r = await daoBatchInjectAllAccounts();
        // 注入过程可能登录补 auth1 → 重算签名, 避免随后 dao-accounts-auth.json 写入再触发空转
        _lastPoolReconcileSig = computeAccountPoolSig();
        try { console.log('[dao] pool-reconcile(' + reason + ') ' + r.okCount + '/' + r.total); } catch { /* 守柔 */ }
        poolReconcileLog('trigger=' + reason + ' DONE ok=' + r.okCount + '/' + r.total);
        try { sidebarCloudPanel?.refresh(); refreshDaoCloudMiddlePanel(); } catch { /* 守柔 */ }
        return { ok: r.ok, okCount: r.okCount, total: r.total, skipped: false };
    } finally { if (_poolReconcileStartMs === myStart) _poolReconcileInflight = false; }
}
function schedulePoolReconcile(reason: string): void {
    if (_poolReconcileDebounce) { clearTimeout(_poolReconcileDebounce); }
    _poolReconcileDebounce = setTimeout(() => { _poolReconcileDebounce = null; reconcileAccountPoolInject(reason).catch(() => { /* 守柔 */ }); }, 2500);
}
function startAccountPoolReconcileLoop(context: vscode.ExtensionContext): void {
    try {
        fs.mkdirSync(DAO_DIR, { recursive: true });
        const w = fs.watch(DAO_DIR, { persistent: false }, (_evt, fname) => {
            const f = String(fname || '');
            if (f === '' || /^accounts\.json$|^dao-accounts-auth\.json$|^dao-inject-profile\.json$/i.test(f)) schedulePoolReconcile('watch:' + (f || 'dao'));
        });
        context.subscriptions.push({ dispose: () => { try { w.close(); } catch { /* 守柔 */ } } });
    } catch { /* 守柔 */ }
    // 本源·真池监听: 切号板块在 ~/.wam/accounts.md 增删账号 → 即触发全池反向注入核对(否则新增账号不自动注入)。
    try {
        fs.mkdirSync(WAM_DIR, { recursive: true });
        const ww = fs.watch(WAM_DIR, { persistent: false }, (_evt, fname) => {
            const f = String(fname || '');
            if (f === '' || /^accounts\.md$|^accounts-backup\.json$/i.test(f)) schedulePoolReconcile('watch:wam:' + (f || 'wam'));
        });
        context.subscriptions.push({ dispose: () => { try { ww.close(); } catch { /* 守柔 */ } } });
    } catch { /* 守柔 */ }
    if (!_poolReconcileTimer) {
        _poolReconcileTimer = setInterval(() => { reconcileAccountPoolInject('periodic', { force: true }).catch(() => { /* 守柔 */ }); }, POOL_RECONCILE_INTERVAL_MS);
        context.subscriptions.push({ dispose: () => { if (_poolReconcileTimer) { clearInterval(_poolReconcileTimer); _poolReconcileTimer = null; } } });
    }
}
// 从按邮箱持久化的 store 里找某 org 仍可用的 auth1 — 用于清理旧 org 注入
function findAuth1ForOrg(orgId: string): string {
    if (!orgId) return '';
    const store = loadAccountsAuthStore();
    for (const e of Object.keys(store)) { if (store[e] && store[e].orgId === orgId && store[e].auth1) return store[e].auth1; }
    return '';
}
// 单账号「绝利一源」保护: 用户在某账号 K/P/S/MCP 面板手动锁定(setManualLock)的条目,
// 批量多账号反向注入(applyInjectProfileToOrg)对该 org 跳过同名条目, 不覆盖用户单账号定制。
// 守柔: 只防覆盖, 锁定项保持用户手改版本; 未锁定项照常注入。
// 先清后注 — 帛书·「为道日损·损之又损」: 注入前把该 org 内一切「非期望态 且 未被用户锁定」的旧注入残条全部清除。
//   keep = 期望态名集(本次将 upsert 的 K/P/S/MCP/Automation) ∪ 固定道藏项(DAO_TOKEN) ∪ 用户单账号锁定项。
//   清后随即由 applyInjectProfileToOrg 覆盖注入期望态 → 该 org 恰为「期望态 ∪ 用户锁定项」, 杜绝历史异名累积。
async function resetOrgInjectables(orgId: string, auth1: string, p: InjectProfile): Promise<{ knowledge: number; playbooks: number; secrets: number; mcps: number; automations: number; schedules: number }> {
    const removed = { knowledge: 0, playbooks: 0, secrets: 0, mcps: 0, automations: 0, schedules: 0 };
    const lc = (s: string) => String(s || '').toLowerCase();
    // 期望保留集
    const keepK = new Set<string>(p.knowledge.map(k => k.name).filter(Boolean));
    [DAO_RULES_KB_NAME, DAO_BRIDGE_KB_NAME, DAO_MCP_KB_NAME].forEach(n => keepK.add(n));
    const keepP = new Set<string>(p.playbooks.map(x => x.title).filter(Boolean));
    const keepS = new Set<string>(p.secrets.map(s => s.name).filter(Boolean));
    keepS.add('DAO_TOKEN');
    const keepM = new Set<string>();
    for (const m of (p.mcps || [])) { if (m && m.name) { keepM.add(lc(m.name)); keepM.add(lc(mcpSlug(m))); } }
    const keepA = new Set<string>((p.automations || []).map(a => a.name).filter(Boolean));
    // 知识 — 守柔: 跳过 Cognition 内置共享模板(note_type=builtin / is_default_* / can_write=false / 无 org_id),
    //   其删除被上游 403「Access denied」拒绝, 非本系统注入物, 不可亦不应清理; 仅清本 org 自有条目。
    try {
        const kl = await devinListKnowledge(orgId, auth1);
        if (kl.ok && Array.isArray(kl.learnings)) for (const k of kl.learnings) {
            if (!k || !k.id || typeof k.name !== 'string') continue;
            if (k.can_write === false || k.note_type === 'builtin' || k.is_default_note === true || k.is_default_shared === true || !k.org_id) continue;
            if (keepK.has(k.name) || isManualLocked(orgId, 'knowledge', k.name)) continue;
            try { await devinDeleteKnowledge(orgId, String(k.id), auth1); removed.knowledge++; } catch { /* 守柔 */ }
        }
    } catch { /* 守柔 */ }
    // 剧本 — 守柔: 跳过社区/公共共享剧本(access=community/public, 属 Cognition 他 org, 删除 403 Forbidden);
    //   本系统注入剧本以 access=team 建于本 org, 仅清这些自有条目。
    try {
        const pl = await devinListPlaybooks(orgId, auth1);
        if (pl.ok && Array.isArray(pl.playbooks)) for (const pb of pl.playbooks) {
            if (!pb || !pb.id || typeof pb.title !== 'string') continue;
            if (pb.access === 'community' || pb.access === 'public') continue;
            if (keepP.has(pb.title) || isManualLocked(orgId, 'playbooks', pb.title)) continue;
            try { await devinDeletePlaybook(orgId, String(pb.id), auth1); removed.playbooks++; } catch { /* 守柔 */ }
        }
    } catch { /* 守柔 */ }
    // 密钥 (守柔: 仅清 dao 反向注入域; 未知 secret 不动以免误删会话密钥 → 仅删非保留且曾被本系统注入过的名)
    try {
        const sl = await devinListSecrets(orgId, auth1);
        const known = new Set<string>(['DAO_TOKEN', 'GITHUB_PAT']);
        if (sl.ok && Array.isArray(sl.secrets)) for (const s of sl.secrets) {
            const nm = s && (s.name || s.key);
            if (!nm || typeof nm !== 'string') continue;
            if (keepS.has(nm) || isManualLocked(orgId, 'secrets', nm)) continue;
            if (!known.has(nm)) continue;
            try { await devinDeleteSecret(orgId, nm, auth1); removed.secrets++; } catch { /* 守柔 */ }
        }
    } catch { /* 守柔 */ }
    // MCP
    try {
        const inst = await devinListMcpInstallations(orgId, auth1);
        if (inst.ok && Array.isArray(inst.items)) for (const it of inst.items) {
            const nm = lc(String((it.name || '').replace(/^★ /, '')));
            if (!it.id || !nm) continue;
            if (keepM.has(nm) || isManualLocked(orgId, 'mcps', nm)) continue;
            try { await devinDeleteMcp(orgId, String(it.id), auth1); removed.mcps++; } catch { /* 守柔 */ }
        }
    } catch { /* 守柔 */ }
    // 自动化
    try {
        const al = await devinListAutomations(orgId, auth1);
        if (al.ok && Array.isArray(al.automations)) for (const it of al.automations) {
            const xid = it.automation_id || it.id;
            if (!xid || typeof it.name !== 'string') continue;
            if (keepA.has(it.name) || isManualLocked(orgId, 'automations', it.name)) continue;
            try { await devinDeleteAutomation(orgId, String(xid), auth1); removed.automations++; } catch { /* 守柔 */ }
        }
    } catch { /* 守柔 */ }
    // 定时调度(cron) — 每周烧额度元凶; 注入档不建调度 → 全清非人工锁定项, 与自动化同理「先清后注」
    try {
        const sl = await devinListSchedules(orgId, auth1);
        if (sl.ok && Array.isArray(sl.schedules)) for (const it of sl.schedules) {
            const sid = it.schedule_id || it.id;
            if (!sid) continue;
            const sname = String(it.prompt || it.description || it.name || sid);
            if (isManualLocked(orgId, 'schedules', sname)) continue;
            try { await devinDeleteSchedule(orgId, String(sid), auth1); removed.schedules++; } catch { /* 守柔 */ }
        }
    } catch { /* 守柔 */ }
    return removed;
}
// ═══════════════════════════════════════════════════════════
// 道并行而不相悖 · 反向注入并发收口 (跨窗口 / 跨IDE / 跨实例 / 跨账号互不串台)
// 病灶 (实测): 多窗口/多IDE 同时开插件 → 各自的 dao-vsix 宿主(独立进程·共享 ~/.dao)
//   对同一活动号并发跑 applyInjectProfileToOrg。devinUpsert* 旧逻辑「list→删同名→建」
//   非原子, 两路并发各自 list(见1条)→各自删→各自建 = 同名知识/内穿MD 翻倍(实测3→6,
//   且不同窗口端口各异的内穿MD 还互相覆盖)。
// 修法 (机权相忘·各归其位):
//   ① 进程内 in-flight 合流(_orgInjectInflight): 同宿主多触发器(切号/watch/周期校正)合为一次跑;
//   ② 跨进程文件锁(~/.dao/locks/inject-<org>.lock·O_EXCL 原子建 + 陈旧偷锁): 多窗口/多IDE
//      对同一 org 串行化, 各 org 各占一条车道、互不串号; 锁短命(单趟注入);
//   ③ devinUpsertKnowledge 已改 PATCH 原地幂等 → 即便跨机并发也收敛单条, 不增殖。
// ═══════════════════════════════════════════════════════════
const DAO_LOCK_DIR = path.join(DAO_DIR, 'locks');
const INJECT_LOCK_STALE_MS = 120000;   // 持锁进程崩溃/卡死 ≤2min 后允许偷锁
const INJECT_LOCK_WAIT_MS = 45000;     // 等待他实例释放锁的上限
const _orgInjectInflight = new Map<string, Promise<void>>();
function orgInjectLockPath(orgId: string): string {
    const safe = String(orgId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(DAO_LOCK_DIR, 'inject-' + safe + '.lock');
}
function tryAcquireInjectLock(lockPath: string): number | null {
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* 守柔 */ }
    try {
        const fd = fs.openSync(lockPath, 'wx');  // O_EXCL: 原子创建, 已存在即抛 EEXIST
        try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* 守柔 */ }
        return fd;
    } catch (e: any) {
        if (e && e.code === 'EEXIST') {
            // 陈旧偷锁: 持锁者早已超 STALE_MS 未更新(崩溃/卡死) → 删旧锁重试一次
            try {
                const st = fs.statSync(lockPath);
                if (Date.now() - st.mtimeMs > INJECT_LOCK_STALE_MS) {
                    try { fs.unlinkSync(lockPath); } catch { /* 守柔 */ }
                    try { const fd2 = fs.openSync(lockPath, 'wx'); fs.writeSync(fd2, JSON.stringify({ pid: process.pid, ts: Date.now() })); return fd2; } catch { /* 守柔 */ }
                }
            } catch { /* 守柔 */ }
        }
        return null;
    }
}
function releaseInjectLock(lockPath: string, fd: number | null): void {
    try { if (fd != null) fs.closeSync(fd); } catch { /* 守柔 */ }
    try { fs.unlinkSync(lockPath); } catch { /* 守柔 */ }
}
async function withOrgInjectLock(orgId: string, fn: () => Promise<void>): Promise<void> {
    const lockPath = orgInjectLockPath(orgId);
    const deadline = Date.now() + INJECT_LOCK_WAIT_MS;
    let fd: number | null = null;
    while (Date.now() < deadline) {
        fd = tryAcquireInjectLock(lockPath);
        if (fd != null) break;
        await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 250)));
    }
    // 超时仍未拿到(他实例长占): 守柔放行 — 注入本身幂等(PATCH 原地·收口去重), 不阻塞主流程。
    try { await fn(); }
    finally { releaseInjectLock(lockPath, fd); }
}
// 对外恒名 — 所有注入路径(切号自循环/整池/批量/内穿自愈)经此并发收口, 不必各处加锁。
function applyInjectProfileToOrg(orgId: string, auth1: string, p: InjectProfile): Promise<void> {
    const key = String(orgId || '');
    // 同进程同 org 并发合流: 已在跑则复用同一 Promise, 不重复跑(亦不重复抢文件锁)。
    const inflight = _orgInjectInflight.get(key);
    if (inflight) return inflight;
    const run = withOrgInjectLock(key, () => applyInjectProfileToOrgInner(orgId, auth1, p))
        .finally(() => { if (_orgInjectInflight.get(key) === run) _orgInjectInflight.delete(key); });
    _orgInjectInflight.set(key, run);
    return run;
}
async function applyInjectProfileToOrgInner(orgId: string, auth1: string, p: InjectProfile): Promise<void> {
    if (getInjectReset()) { try { await resetOrgInjectables(orgId, auth1, p); } catch { /* 守柔 */ } }
    for (const s of p.secrets) { if (s && s.name && !isManualLocked(orgId, 'secrets', s.name)) { try { await devinUpsertSecret(orgId, s.name, s.value || '', auth1); } catch { /* 守柔 */ } } }
    for (const k of p.knowledge) {
        if (!k || !k.name) continue;
        if (isManualLocked(orgId, 'knowledge', k.name)) continue;
        let kb = k.body || '';
        const isBridge = (kb === DAO_BRIDGE_KB_SENTINEL || k.name === DAO_BRIDGE_KB_NAME);
        const isMcpDoc = (kb === DAO_MCP_KB_SENTINEL || k.name === DAO_MCP_KB_NAME);
        if (isMcpDoc) { try { kb = bridgeGenerateMcpUsageMd(); } catch { /* 守柔 */ } }
        if (isBridge) {
            try { kb = bridgeGenerateCloudMd(); } catch { /* 守柔 */ }
            // 帛书·「少则得·多则惑」: 收敛历史异名「DAO Bridge」内穿残条(含早期带「·」变体) → 唯一规范条目;
            //   保留 MCP 使用文档(同前缀但独立一篇), 不误删。
            try {
                const list = await devinListKnowledge(orgId, auth1);
                if (list.ok && list.learnings) {
                    for (const e of list.learnings) {
                        if (e && e.id && typeof e.name === 'string' && /^DAO Bridge/.test(e.name) && e.name !== DAO_MCP_KB_NAME) {
                            try { await devinDeleteKnowledge(orgId, String(e.id), auth1); } catch { /* 守柔 */ }
                        }
                    }
                }
            } catch { /* 守柔 */ }
        }
        try { await devinUpsertKnowledge(orgId, k.name, kb, k.trigger || 'Always', auth1, true); } catch { /* 守柔 */ }
    }
    for (const pb of p.playbooks) { if (pb && pb.title && !isManualLocked(orgId, 'playbooks', pb.title)) { try { await devinUpsertPlaybook(orgId, pb.title, pb.body || '', auth1, true); } catch { /* 守柔 */ } } }
    for (const a of (p.automations || [])) { if (a && a.name) { try { await devinUpsertAutomation(orgId, a, auth1); } catch { /* 守柔 */ } } }
    // 钉住的 MCP — 幂等: 已存在(按 slug)则跳过, 否则追录到该 org
    if (p.mcps && p.mcps.length) {
        let existing: Set<string> = new Set();
        try {
            const inst = await devinListMcpInstallations(orgId, auth1);
            if (inst.ok && inst.items) for (const it of inst.items) existing.add(String((it.name || '').replace(/^★ /, '')).toLowerCase());
        } catch { /* 守柔 */ }
        for (const m of p.mcps) {
            if (!m || !m.name) continue;
            if (isManualLocked(orgId, 'mcps', m.name) || isManualLocked(orgId, 'mcps', mcpSlug(m))) continue;
            const slug = mcpSlug(m);
            if (existing.has(String(m.name).toLowerCase()) || existing.has(slug)) continue;
            try { await devinAddCustomMcp(orgId, Object.assign({}, m, { slug }), auth1); } catch { /* 守柔 */ }
        }
    }
    // 期望的单条额度上限 — auto: 跟随本号剩余额度动态(cap = 剩余 ACU − offset), 实时反向注入;
    //   否则用固定值。auto 让每个账号据各自剩余额度注入不同数字(剩余70→注67·剩余50→注47)。
    if (p.messageLimitAuto) {
        try {
            const avail = await devinFetchAvailableAcus(orgId, auth1);
            if (avail != null) {
                const off = (typeof p.messageLimitOffset === 'number') ? p.messageLimitOffset : 3;
                const cap = quotaCapFromAvail(avail, off);
                await devinSetMessageLimit(orgId, cap, auth1);
            }
        } catch { /* 守柔 */ }
    } else if (typeof p.messageLimit === 'number') { try { await devinSetMessageLimit(orgId, p.messageLimit, auth1); } catch { /* 守柔 */ } }
}
async function cleanupInjectProfileFromOrg(orgId: string, auth1: string, p: InjectProfile): Promise<void> {
    for (const s of p.secrets) { if (s && s.name && !isManualLocked(orgId, 'secrets', s.name)) { try { await devinDeleteSecret(orgId, s.name, auth1); } catch { /* 守柔 */ } } }
    try {
        const kl = await devinListKnowledge(orgId, auth1);
        if (kl.ok && kl.learnings) for (const k of kl.learnings) { if (p.knowledge.some(x => x.name === k.name) && k.id && !isManualLocked(orgId, 'knowledge', k.name)) { try { await devinDeleteKnowledge(orgId, String(k.id), auth1); } catch { /* 守柔 */ } } }
    } catch { /* 守柔 */ }
    try {
        const pl = await devinListPlaybooks(orgId, auth1);
        if (pl.ok && pl.playbooks) for (const pb of pl.playbooks) { if (p.playbooks.some(x => x.title === pb.title) && pb.id && !isManualLocked(orgId, 'playbooks', pb.title)) { try { await devinDeletePlaybook(orgId, String(pb.id), auth1); } catch { /* 守柔 */ } } }
    } catch { /* 守柔 */ }
    if (p.mcps && p.mcps.length) {
        try {
            const inst = await devinListMcpInstallations(orgId, auth1);
            if (inst.ok && inst.items) for (const it of inst.items) {
                const nm = String((it.name || '').replace(/^★ /, '')).toLowerCase();
                if (p.mcps.some(x => String(x.name).toLowerCase() === nm || mcpSlug(x) === nm) && it.id && !isManualLocked(orgId, 'mcps', nm)) {
                    try { await devinDeleteMcp(orgId, String(it.id), auth1); } catch { /* 守柔 */ }
                }
            }
        } catch { /* 守柔 */ }
    }
    if (p.automations && p.automations.length) {
        try {
            const al = await devinListAutomations(orgId, auth1);
            if (al.ok && al.automations) for (const it of al.automations) {
                const xid = it.automation_id || it.id;
                if (p.automations.some(x => x.name === it.name) && xid && !isManualLocked(orgId, 'automations', it.name)) {
                    try { await devinDeleteAutomation(orgId, String(xid), auth1); } catch { /* 守柔 */ }
                }
            }
        } catch { /* 守柔 */ }
    }
}
// 账号切换后调用: 应用 profile 到新 org + (默认)清理旧 org — 自循环核心
// opts.force: 用户主页单账号手动注入 → 绕过「已清理账号自动注入抑制」并记 reactivatedAt。
async function runInjectProfileSelfLoop(opts?: { force?: boolean }): Promise<void> {
    const p = loadInjectProfile();
    if (!p.enabled) return;
    if (!ws.devinOrgId || !ws.devinAuth1 || ws.devinAuth1.startsWith('devin-session-token$')) return;
    const hasItems = p.secrets.length || p.knowledge.length || p.playbooks.length || p.mcps.length || (p.automations && p.automations.length) || typeof p.messageLimit === 'number' || p.messageLimitAuto;
    if (!hasItems) return;
    // 归零清理协同: 当前账号若已被 RT Flow 清理/出库, 自动自循环守柔跳过, 不重新填充;
    //   唯用户主页单账号手动注入(force) 显式绕过并记 reactivatedAt 解除抑制。
    const curEmail = (ws.devinEmail || emailForOrg(ws.devinOrgId) || '').trim().toLowerCase();
    if (opts && opts.force) {
        if (curEmail) markInjectReactivated(curEmail);
    } else if (curEmail && isInjectSuppressedForEmail(curEmail)) {
        try { console.log('[dao] self-loop skip cleaned account: ' + curEmail); } catch { /* 守柔 */ }
        return;
    }
    // 1. 默认清理旧 org 的旧注入 — 帛书·「将欲去之·必故与之」(用户可关 autoCleanup)
    if (p.autoCleanup && getInjectAutoCleanup() && p.lastInjectedOrg && p.lastInjectedOrg !== ws.devinOrgId) {
        const oldAuth1 = findAuth1ForOrg(p.lastInjectedOrg);
        if (oldAuth1) { try { await cleanupInjectProfileFromOrg(p.lastInjectedOrg, oldAuth1, p); } catch { /* 守柔 */ } }
    }
    // 2. 应用到当前 org
    await applyInjectProfileToOrg(ws.devinOrgId, ws.devinAuth1, p);
    // 2.5 顺手去重: 清理同名知识/同标题剧本残留(旧版本不同命名批量注入累积) — 默认开, 用户可关
    if (getInjectAutoDedupe()) { try { await devinDedupeOrg(ws.devinOrgId, ws.devinAuth1); } catch { /* 守柔 */ } }
    // 2.6 老旧异名 dao 知识收敛 → 唯二(道法自然准则 + 内网穿透板块)
    try { await devinCleanLegacyDaoKnowledge(ws.devinOrgId, ws.devinAuth1); } catch { /* 守柔 */ }
    // 3. 记录 lastInjectedOrg → 下次切换据此清理
    p.lastInjectedOrg = ws.devinOrgId;
    saveInjectProfile(p);
}

// 多账号 · 一次性把期望态注入到账号池里所有已存 auth1 的账号 org
// 帛书·「既以为人己愈有·既以予人己愈多」— 不必逐个手动切号
async function applyInjectProfileToAllAccounts(): Promise<{ ok: boolean; total: number; injected: number; results: { email: string; ok: boolean }[] }> {
    const p = loadInjectProfile();
    const store = loadAccountsAuthStore();
    const emails = Object.keys(store);
    const results: { email: string; ok: boolean }[] = [];
    // 去重 org: 同 org 多邮箱只注一次
    const doneOrgs = new Set<string>();
    for (const e of emails) {
        const a = store[e];
        if (!a || !a.auth1 || a.auth1.startsWith('devin-session-token$') || !a.orgId) { results.push({ email: e, ok: false }); continue; }
        // 归零清理协同: RT Flow 已清理/出库账号 → 多账号自动注入守柔跳过 (除非用户主页单账号手动注入)。
        if (isInjectSuppressedForEmail(e)) { continue; }
        if (doneOrgs.has(a.orgId)) { results.push({ email: e, ok: true }); continue; }
        try { await applyInjectProfileToOrg(a.orgId, a.auth1, p); doneOrgs.add(a.orgId); results.push({ email: e, ok: true }); }
        catch { results.push({ email: e, ok: false }); }
    }
    const injected = results.filter(r => r.ok).length;
    return { ok: injected > 0, total: emails.length, injected, results };
}

// 整池反向注入归一入口: 优先 devinBatchInject(本机账号池·含登录兜底·全覆盖), 池空再退缓存 auth1 路径。
async function daoBatchInjectAllAccounts(): Promise<{ ok: boolean; okCount: number; total: number }> {
    let okCount = 0, total = 0;
    try {
        const pool = resolveBatchAccounts({ all: true });
        if (pool.length) { total = pool.length; const prog = await devinBatchInject(pool); okCount = prog.ok; }
        else { const r = await applyInjectProfileToAllAccounts(); total = r.total; okCount = r.injected; }
    } catch { /* 守柔 */ }
    return { ok: okCount > 0, okCount, total };
}

function buildDevinKnowledge(url: string, token: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
    return [
        '# Dao Workspace Server 连接信息',
        '',
        '## 连接地址',
        'URL: ' + url,
        'Token: ' + token,
        '',
        '## 可用API端点',
        '- GET /api/health — 健康检查',
        '- GET /api/connection — 连接信息',
        '- GET /api/workspace — 工作区信息',
        '- POST /api/exec — 执行命令 {cmd,cwd,timeout}',
        '- GET /api/file?path=xxx — 读取文件',
        '- POST /api/write — 写入文件 {path,content}',
        '- POST /api/search — 搜索文件 {pattern}',
        '- POST /api/edit — 编辑文件 {file,edits}',
        '- GET /api/ls?path=xxx — 列出目录',
        '- GET /api/diagnostics — 诊断信息',
        '- POST /api/command — VSCode命令 {command,args}',
        '- POST /api/tools — 工具桥接 {tool,args}',
        '',
        '## 认证方式',
        'Authorization: Bearer ' + token,
        '或 URL参数: ?master_token=' + token,
        '',
        '## 工作区',
        ...workspaceFolders.map(w => '- ' + w),
        '',
        '## 平台',
        'Host: ' + os.hostname(),
        'OS: ' + os.type() + ' ' + os.release(),
        'User: ' + os.userInfo().username,
    ].join('\n');
}

function buildDevinPlaybook(url: string, token: string): string {
    return [
        '# 道法自然 · Dao Workspace 操作手册',
        '',
        '## 连接',
        '服务器地址: ' + url,
        '认证Token: ' + token,
        '',
        '## 操作步骤',
        '1. 使用HTTP请求连接到服务器地址',
        '2. 在Authorization头中携带Bearer Token',
        '3. 调用API端点执行操作',
        '',
        '## 示例命令',
        '```bash',
        '# 健康检查',
        'curl -H "Authorization: Bearer ' + token + '" ' + url + '/api/health',
        '',
        '# 执行命令',
        'curl -X POST -H "Authorization: Bearer ' + token + '" -H "Content-Type: application/json" -d \'{"cmd":"ls -la"}\' ' + url + '/api/exec',
        '',
        '# 读取文件',
        'curl -H "Authorization: Bearer ' + token + '" "' + url + '/api/file?path=/path/to/file"',
        '',
        '# 写入文件',
        'curl -X POST -H "Authorization: Bearer ' + token + '" -H "Content-Type: application/json" -d \'{"path":"/path/to/file","content":"hello"}\' ' + url + '/api/write',
        '```',
        '',
        '## 注意事项',
        '- Windows paths: use backslashes, escape as \\\\ in JSON',
        '- Default command timeout: 20 seconds',
        '- Platform: ' + os.type() + ' ' + os.hostname(),
    ].join('\n');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════
// 双面板 · 帛书·四十一「反者道之动」
// 面板A: DaoPanelProvider — 定制化注入、状态展示
// 面板B: devinCloudPanel — 官网全功能内嵌浏览器
//
// 两条路径:
//   路径α simpleBrowser.show → 完整浏览器，不受安全头限制
//   路径β 反向代理+iframe → 内嵌体验，认证自动桥接
//
// 反者道之动: 不复刻官网，而是路由官网本身到IDE内
// 无为而无以为: 代理层只做三件事 — 剥安全头、注认证、改URL
// ═══════════════════════════════════════════════════════════

let devinCloudPanelInstance: vscode.WebviewPanel | null = null;

// ★ 归一·E · 多实例并行: 每账号一独立 webview 标签 (按 email 复用·不相悖)。
//   re-click 同账号 → 聚焦其既有面板; 不同账号 → 各开独立标签同时可用。
//   iframe 指向 daoRoutedWebUrlForAccount(email) (?dao_acct 注入该账号 auth1)。
const routedAccountPanels = new Map<string, vscode.WebviewPanel>();
// keySuffix: 用于区分同账号下「具体对话」标签 (近期对话多实例打开 → 各对话独立标签)。
function openRoutedAccountPanel(context: vscode.ExtensionContext, email: string, url: string, keySuffix?: string): void {
    const key = (email || 'default').toLowerCase() + (keySuffix ? ('#' + keySuffix) : '');
    const existing = routedAccountPanels.get(key);
    if (existing) { existing.reveal(vscode.ViewColumn.Beside); return; }
    const localBase = ws.port ? `http://localhost:${ws.port}` : '';
    const panel = vscode.window.createWebviewPanel(
        'dao.routedAccount.' + key,
        (keySuffix ? ('💬 ' + keySuffix.slice(0, 8)) : '🖥 官网') + ' · ' + (email ? email.split('@')[0] : '当前账号'),
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localBase ? [vscode.Uri.parse(localBase + '/')] : undefined,
        }
    );
    routedAccountPanels.set(key, panel);
    panel.webview.html = getDevinCloudPanelHtml(url, localBase || url);
    // 缺陷根治: 此前多实例路由面板(切号/对话备份)未挂 onDidReceiveMessage → 工具栏/回退按钮全是死键,
    //   iframe 卡「Loading…」即无从恢复。今挂同款消息处理: 刷新 / Simple Browser / 外部 / 电脑浏览器独立窗口。
    panel.webview.onDidReceiveMessage(async (m: any) => {
        try {
            const c = m && m.command;
            if (c === 'refresh') { panel.webview.html = getDevinCloudPanelHtml(url, localBase || url); }
            else if (c === 'openSimpleBrowser') { try { await vscode.commands.executeCommand('simpleBrowser.show', url); } catch { vscode.env.openExternal(vscode.Uri.parse(url)); } }
            else if (c === 'openIsolated' || c === 'openExternal') {
                // 在电脑浏览器开该账号独立 profile 窗口 (与切号面板同款·已验证可用) — 经本地反代 dao_acct 自动登录该账号
                const ok = launchIsolatedBrowser(url, email || 'default');
                vscode.window.showInformationMessage(ok ? ('已在电脑浏览器打开(独立窗口): ' + (email || '当前账号')) : '浏览器启动失败');
            } else if (c === 'navigate' && m.path) {
                const np = String(m.path);
                const nurl = np.indexOf('http') === 0 ? np : ((localBase || '') + (np.charAt(0) === '/' ? np : '/' + np));
                panel.webview.html = getDevinCloudPanelHtml(nurl, localBase || nurl);
            }
        } catch { /* 守柔 */ }
    });
    panel.onDidDispose(() => { routedAccountPanels.delete(key); });
}

function devinCloudPanel(context: vscode.ExtensionContext): void {
    // 如果已有面板则聚焦
    if (devinCloudPanelInstance) {
        devinCloudPanelInstance.reveal(vscode.ViewColumn.Beside);
        return;
    }

    const localBase = ws.port ? `http://localhost:${ws.port}` : '';
    if (!localBase) {
        vscode.window.showErrorMessage('请先启动 Dao 服务器');
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'dao.devinCloud',
        '🤖 Devin Cloud 官方面板',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            // 缺陷1修复: 必须允许加载本地服务器URL，否则iframe无法访问代理
            localResourceRoots: [vscode.Uri.parse(localBase + '/')],
        }
    );
    devinCloudPanelInstance = panel;

    // 面板HTML — iframe指向本地反向代理
    // 代理层剥离X-Frame-Options/CSP，注入Authorization头
    const orgSlug = ws.devinOrgName || '';
    const proxyUrl = orgSlug ? `${localBase}/org/${orgSlug}` : `${localBase}/`;
    panel.webview.html = getDevinCloudPanelHtml(proxyUrl, localBase);

    panel.onDidDispose(() => {
        devinCloudPanelInstance = null;
    });

    // 接收面板消息
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'refresh') {
            panel.webview.html = getDevinCloudPanelHtml(proxyUrl, localBase);
        } else if (msg.command === 'openSimpleBrowser') {
            try {
                vscode.commands.executeCommand('simpleBrowser.show', daoRoutedWebUrl(''));
            } catch {
                vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP));
            }
        } else if (msg.command === 'openIsolated') {
            // 电脑浏览器独立窗口打开当前账号 (与切号面板同款·已验证可用)
            const acct = ws.devinEmail || 'default';
            const ok = launchIsolatedBrowser(daoRoutedWebUrlForAccount(acct, ''), acct);
            vscode.window.showInformationMessage(ok ? ('已在电脑浏览器打开(独立窗口): ' + acct) : '浏览器启动失败');
        } else if (msg.command === 'openExternal') {
            vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP));
        } else if (msg.command === 'navigate') {
            // iframe内导航请求 → 代理层处理
            const targetPath = msg.path || '/';
            // 经反代根路径路由 — SPA 客户端路由据真实 pathname 工作(/devin-cloud 前缀 → 404)
            panel.webview.html = getDevinCloudPanelHtml(`${localBase}${targetPath}`, localBase);
        } else if (msg.command === 'authSync') {
            // iframe认证状态同步 — 帛书·五十二「见小曰明·守柔曰强」
            // iframe中的Devin SPA可能更新了认证状态，同步回主扩展
            if (msg.auth1 && msg.auth1 !== ws.devinAuth1) {
                ws.devinAuth1 = msg.auth1;
                ws.devinOrgId = msg.orgId || ws.devinOrgId;
                ws.devinEmail = msg.email || ws.devinEmail;
                ws.devinSaveConfig();
                vscode.window.showInformationMessage('Devin Cloud 认证状态已同步');
            }
        }
    }, undefined, context.subscriptions);
}

function getDevinCloudPanelHtml(proxyUrl: string, localBase: string): string {
    const devinStatusHtml = ws.devinAuth1
        ? `<span class="auth-ok">✓ ${escapeHtml(ws.devinEmail)}</span>`
        : `<span class="auth-err">✗ 未登录</span>`;
    return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval' http://localhost:* https://localhost:*; frame-src * http://localhost:* https://localhost:*; script-src * 'unsafe-inline' 'unsafe-eval' http://localhost:* https://localhost:*; connect-src * http://localhost:* https://localhost:* wss: ws:; style-src * 'unsafe-inline' http://localhost:* https://localhost:*; img-src * data: blob: http://localhost:* https://localhost:*; font-src * data: http://localhost:* https://localhost:*;">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--vscode-editor-background); color: var(--vscode-foreground); height: 100vh; display: flex; flex-direction: column; }
.toolbar { display: flex; align-items: center; padding: 3px 8px; background: var(--vscode-titleBar-activeBackground); border-bottom: 1px solid var(--vscode-panel-border); gap: 4px; flex-shrink: 0; height: 28px; }
.toolbar .title { font-size: 12px; font-weight: 600; color: var(--vscode-titleBar-activeForeground); white-space: nowrap; }
.toolbar .tag { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 2px; background: #6366f1; color: #fff; white-space: nowrap; }
.toolbar .tag.ws { background: #0e639c; }
.toolbar .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 1px 6px; cursor: pointer; font-size: 10px; white-space: nowrap; }
.toolbar .btn:hover { background: var(--vscode-button-hoverBackground); }
.toolbar .spacer { flex: 1; }
.toolbar .auth-ok { font-size: 10px; color: #4ec9b0; white-space: nowrap; }
.toolbar .auth-err { font-size: 10px; color: #f44747; white-space: nowrap; }
.url-bar { display: flex; align-items: center; padding: 2px 8px; background: var(--vscode-input-background); border-bottom: 1px solid var(--vscode-panel-border); gap: 4px; flex-shrink: 0; height: 24px; }
.url-bar input { flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); padding: 1px 6px; font-size: 11px; font-family: 'Consolas', monospace; border-radius: 2px; height: 18px; }
.url-bar input:focus { outline: 1px solid var(--vscode-focusBorder); }
.url-bar .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; padding: 1px 6px; cursor: pointer; font-size: 10px; }
.url-bar .btn:hover { background: var(--vscode-button-hoverBackground); }
.iframe-wrap { flex: 1; position: relative; overflow: hidden; }
.iframe-wrap iframe { width: 100%; height: 100%; border: none; position: absolute; top: 0; left: 0; }
.loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 13px; color: var(--vscode-descriptionForeground); z-index: 10; }
.loading .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }
.fallback { display: none; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; }
.fallback .msg { font-size: 14px; color: var(--vscode-descriptionForeground); text-align: center; max-width: 400px; line-height: 1.6; }
.fallback .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 20px; cursor: pointer; font-size: 13px; }
.fallback .btn:hover { background: var(--vscode-button-hoverBackground); }
</style></head>
<body>

<div class="toolbar">
  <span class="title">🤖 Devin Cloud</span>
  <span class="tag">内嵌代理</span>
  ${ws.devinAuth1 ? '<span class="tag ws">Windsurf</span>' : ''}
  <span class="spacer"></span>
  ${devinStatusHtml}
  <button class="btn" onclick="cmd('refresh')">⟳</button>
  <button class="btn" onclick="cmd('openSimpleBrowser')" title="Simple Browser">🌐</button>
  <button class="btn" onclick="cmd('openIsolated')" title="在电脑浏览器打开(独立窗口·自动登录此账号)">🖥 独立窗口</button>
  <button class="btn" onclick="cmd('openExternal')" title="外部浏览器">↗</button>
</div>

<div class="url-bar">
  <button class="btn" onclick="goBack()" title="后退">←</button>
  <button class="btn" onclick="goForward()" title="前进">→</button>
  <input id="url-input" value="${escapeHtml(proxyUrl)}" onkeydown="if(event.key==='Enter')navigate(this.value)" />
  <button class="btn" onclick="navigate(document.getElementById('url-input').value)">Go</button>
</div>

<div class="iframe-wrap">
  <div class="loading" id="loading"><span class="spinner"></span>Loading Devin Cloud...</div>
  <iframe id="devin-frame" src="${escapeHtml(proxyUrl)}"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
          allow="clipboard-read; clipboard-write; fullscreen; microphone; camera"
          onload="onLoad()" onerror="onError()">
  </iframe>
</div>

<div class="fallback" id="fallback">
  <div class="msg">
    <b>内嵌页面加载缓慢或被安全策略拦截</b><br><br>
    官网带 X-Frame 限制, 内嵌反代偶尔较慢甚至加载不出。<br>
    推荐用「电脑浏览器(独立窗口)」打开 — 各账号独立 profile 并行、自动登录、稳定快速。
  </div>
  <button class="btn" onclick="cmd('openIsolated')" style="background:#6366f1">🖥 电脑浏览器打开(独立窗口·推荐)</button>
  <button class="btn" onclick="cmd('openSimpleBrowser')">🌐 Simple Browser</button>
  <button class="btn" onclick="cmd('refresh')">⟳ 重新尝试内嵌</button>
</div>

<script>
const vscode = acquireVsCodeApi();
var currentUrl = '${escapeHtml(proxyUrl)}';
var history = [currentUrl];
var historyIdx = 0;

function cmd(c, data) { vscode.postMessage(Object.assign({command:c}, data || {})); }

function navigate(url) {
  if (!url) return;
  // 确保URL指向本地代理
  if (url.startsWith('https://app.devin.ai')) {
    url = url.replace('https://app.devin.ai', 'http://localhost:${ws.port}');
  }
  if (!url.startsWith('http://localhost')) {
    // 非本地URL → 通过代理路由
    url = 'http://localhost:${ws.port}/devin-cloud/' + url.replace(/^https?:\\/\\//, '');
  }
  currentUrl = url;
  document.getElementById('url-input').value = url;
  document.getElementById('devin-frame').src = url;
  _startLoadWatch();
  // 记录历史
  if (historyIdx < history.length - 1) history = history.slice(0, historyIdx + 1);
  history.push(url);
  historyIdx = history.length - 1;
}

function goBack() {
  if (historyIdx > 0) { historyIdx--; navigate(history[historyIdx]); }
}

function goForward() {
  if (historyIdx < history.length - 1) { historyIdx++; navigate(history[historyIdx]); }
}

var _loaded = false;
function onLoad() {
  _loaded = true;
  document.getElementById('loading').style.display = 'none';
  document.getElementById('fallback').style.display = 'none';
  document.querySelector('.iframe-wrap').style.display = 'flex';
}

function onError() {
  document.getElementById('loading').style.display = 'none';
  document.querySelector('.iframe-wrap').style.display = 'none';
  document.getElementById('fallback').style.display = 'flex';
}

// 守柔自愈: X-Frame 拦截/超慢加载时 iframe 常既不 onload 也不 onerror → 永卡「Loading…」。
//   超时(9s)仍未 load → 自动呈现回退(主推电脑浏览器独立窗口), 杜绝「加载不出无从恢复」。
function _startLoadWatch() {
  _loaded = false;
  document.getElementById('loading').style.display = 'block';
  document.getElementById('fallback').style.display = 'none';
  setTimeout(function(){ if (!_loaded) { onError(); } }, 9000);
}
_startLoadWatch();

// 接收iframe的postMessage — 帛书·五十二「见小曰明·守柔曰强」
window.addEventListener('message', function(e) {
  if (!e.data || typeof e.data !== 'object') return;
  // dao-auth: iframe通知认证状态
  if (e.data.type === 'dao-auth') {
    vscode.postMessage({command: 'authSync', auth1: e.data.auth1, orgId: e.data.orgId, email: e.data.email});
  }
  // dao-loaded: iframe加载完成
  if (e.data.type === 'dao-loaded') {
    document.getElementById('loading').style.display = 'none';
  }
  // dao-navigate: iframe内导航请求
  if (e.data.type === 'dao-navigate') {
    navigate(e.data.url || e.data.path);
  }
});

// 超时检测: 10秒后如果仍在loading则显示fallback
setTimeout(function() {
  var loading = document.getElementById('loading');
  if (loading && loading.style.display !== 'none') {
    onError();
  }
}, 10000);
</script>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════
// 反向代理路由 · 帛书·四十一「反者道之动」
// /devin-cloud/* → https://app.devin.ai/*
// /devin-cloud-ws/* → https://windsurf.com/*
// 三件事: 剥安全头 + 注认证 + 改写绝对URL
// 道法自然: 代理层无为 — 只做三件事，其余原样透传
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 归一 · 浏览器下载管理 — 网页内下载的文件落盘 + 登记, 供 /shell ⬇下载悬浮窗罗列。
//   与「对话备份」彻底解耦: 这里只收「用户在网页中下载的真实文件」(对齐手机 APK 下载悬浮窗)。
// ═══════════════════════════════════════════════════════════
function daoDownloadsDir(): string {
    const d = path.join(DAO_DIR, 'downloads');
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 守柔 */ }
    return d;
}
function daoDownloadsIndex(): string { return path.join(daoDownloadsDir(), '_index.json'); }
function _dlFilename(cd: string, u: URL, ct: string): string {
    let name = '';
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i.exec(cd || '');
    if (m && m[1]) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    if (!name) { try { name = decodeURIComponent((u.pathname || '').split('/').filter(Boolean).pop() || ''); } catch { name = (u.pathname || '').split('/').filter(Boolean).pop() || ''; } }
    if (!name || name.indexOf('.') < 0) {
        const ext = /pdf/i.test(ct) ? '.pdf' : /zip/i.test(ct) ? '.zip' : /json/i.test(ct) ? '.json' : /csv/i.test(ct) ? '.csv' : /(msword|wordprocessingml)/i.test(ct) ? '.docx' : /(excel|spreadsheetml)/i.test(ct) ? '.xlsx' : /octet-stream/i.test(ct) ? '.bin' : '';
        name = (name || 'download') + ext;
    }
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'download';
}
// 是否「应作为下载捕获」: 显式 attachment, 或明确的可下载二进制类型(排除内联渲染的图片/音视频/脚本/样式)。
function _isDownloadable(cd: string, ct: string): boolean {
    if (/attachment/i.test(cd || '')) return true;
    const c = String(ct || '').toLowerCase().split(';')[0].trim();
    if (!c) return false;
    if (/^(text\/html|application\/xhtml|text\/css|application\/javascript|text\/javascript|application\/json|image\/|video\/|audio\/|font\/|text\/plain|text\/xml|application\/xml)/.test(c)) return false;
    return /^(application\/(octet-stream|zip|x-zip|pdf|x-pdf|gzip|x-gzip|x-tar|x-7z|x-rar|vnd\.|msword|x-msdownload)|application\/x-)/.test(c);
}
function daoSaveDownload(name: string, buf: Buffer, ct: string, src: string): any {
    const dir = daoDownloadsDir();
    const stamp = Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36);
    const safe = String(name || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'download';
    const fp = path.join(dir, stamp + '-' + safe);
    fs.writeFileSync(fp, buf);
    let idx: any[] = [];
    try { idx = JSON.parse(fs.readFileSync(daoDownloadsIndex(), 'utf8')) || []; } catch { idx = []; }
    const meta = { name: safe, path: fp, size: buf.length, contentType: ct || '', url: src || '', time: Date.now() };
    idx.unshift(meta);
    if (idx.length > 500) idx = idx.slice(0, 500);
    try { fs.writeFileSync(daoDownloadsIndex(), JSON.stringify(idx)); } catch { /* 守柔 */ }
    return meta;
}

// ═══════════════════════════════════════════════════════════
// 归一 · 任意网页「站内代理」直出 — 搜索/外站经此当 iframe 加载
//   只做三件事: 剥 X-Frame-Options/CSP(否则 webview iframe 被站点框架策略挡白屏)
//   + 注入 <base>(相对资源回源直载) + 注入链接/表单/window.open 拦截(改写经本代理 → 站内导航不外跳)。
//   不注入任何 Devin 认证(隐私/安全: 外站不应拿到本地登录态)。复刻手机端 APK 站内搜索体验。
// ═══════════════════════════════════════════════════════════
function _dechunk(buf) {
    const out = [];
    let off = 0;
    while (off < buf.length) {
        const nl = buf.indexOf('\r\n', off);
        if (nl < 0) break;
        const sizeHex = buf.slice(off, nl).toString('latin1').trim().split(';')[0];
        const size = parseInt(sizeHex, 16);
        if (isNaN(size) || size <= 0) break;
        const start = nl + 2;
        if (start + size > buf.length) { out.push(buf.slice(start)); break; }
        out.push(buf.slice(start, start + size));
        off = start + size + 2;
    }
    return Buffer.concat(out);
}
// 道·经本机 VPN/代理 CONNECT 隧道发起原生 GET, 解析原始 HTTP 响应(状态/头/体)。直连被墙站点(GFW RST)的兜底通路。
function fetchViaTunnel(u, headers, timeoutMs) {
    // HTTP 站点经代理: 标准 HTTP 代理是「整 URL 作请求行」(GET http://host/path), 非 CONNECT 隧道。
    //   CONNECT+TLS 仅适用 HTTPS。此前 HTTP 站点根本不走代理(isHttps?...:0)→ 被墙 HTTP 站直连必败。
    if (u.protocol === 'http:') {
        return new Promise((resolve) => {
            const proxyPort = detectedProxyPort || detectProxyPort();
            if (!proxyPort) { resolve(null); return; }
            let done = false;
            const fin = (r) => { if (!done) { done = true; resolve(r); } };
            const chunks = [];
            const pr = http.request({
                host: '127.0.0.1', port: proxyPort, method: 'GET',
                path: u.href, headers: Object.assign({}, headers, { Host: u.host }),
                timeout: timeoutMs || 16000,
            }, (res) => {
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => fin({ status: res.statusCode || 200, headers: res.headers, raw: Buffer.concat(chunks) }));
            });
            pr.on('error', () => fin(null));
            pr.on('timeout', () => { try { pr.destroy(); } catch (e) { /* 守柔 */ } fin(null); });
            pr.end();
        });
    }
    return new Promise((resolve) => {
        let done = false;
        const fin = (r) => { if (!done) { done = true; resolve(r); } };
        createProxyTunnel(u.hostname).then((sock) => {
            if (!sock) { fin(null); return; }
            const bufs = [];
            const to = setTimeout(() => { try { sock.destroy(); } catch (e) { /* 守柔 */ } fin(null); }, timeoutMs || 16000);
            const parseAll = () => {
                clearTimeout(to);
                if (done) return;
                const all = Buffer.concat(bufs);
                const idx = all.indexOf('\r\n\r\n');
                if (idx < 0) { fin(null); return; }
                const head = all.slice(0, idx).toString('latin1').split('\r\n');
                let bodyBuf = all.slice(idx + 4);
                const m = (head[0] || '').match(/^HTTP\/\d\.\d\s+(\d+)/);
                const status = m ? parseInt(m[1]) : 0;
                const hdrs = {};
                for (let i = 1; i < head.length; i++) { const c = head[i].indexOf(':'); if (c > 0) { const k = head[i].slice(0, c).trim().toLowerCase(); const v = head[i].slice(c + 1).trim(); hdrs[k] = hdrs[k] ? (hdrs[k] + ', ' + v) : v; } }
                if (String(hdrs['transfer-encoding'] || '').toLowerCase().indexOf('chunked') >= 0) bodyBuf = _dechunk(bodyBuf);
                fin({ status: status, headers: hdrs, raw: bodyBuf });
            };
            sock.on('data', (c) => bufs.push(c));
            sock.on('end', parseAll);
            sock.on('close', parseAll);
            sock.on('error', () => { clearTimeout(to); fin(null); });
            let reqStr = 'GET ' + ((u.pathname || '/') + (u.search || '')) + ' HTTP/1.1\r\n';
            const h = Object.assign({}, headers, { Host: u.host, Connection: 'close' });
            for (const k of Object.keys(h)) reqStr += k + ': ' + h[k] + '\r\n';
            reqStr += '\r\n';
            try { sock.write(reqStr); } catch (e) { clearTimeout(to); fin(null); }
        }).catch(() => fin(null));
    });
}
// ═══════════════════════════════════════════════════════════
// 归一 · 拖拽上传桥 (注入所有同源代理页) — 对齐手机 APK: 拖文件=上传该文件 / 拖会话=上传该会话最新 MD。
//   外壳侧 dragstart 写入 application/x-dao-file{path,name} 或 application/x-dao-conv{email,sid,title};
//   落点页(同源)经此桥拿到标记 → fetch /__dlfile|/__convmd 取字节 → 合成 File → 喂入页面 file input + 合成 drop。
//   独立 .js 资产经 /__daobridge.js 直出 (避免内联脚本的转义/CSP 噪声), 各代理页仅注入一行 <script src>。
// ═══════════════════════════════════════════════════════════
// 拖拽上传桥路由服务 (单一来源): 既供 dao-vsix out 层主服务器路由, 又经 rt-flow 注入 IDE 内
//   多实例反代 devin_proxy 就地同源服务 (各账号端口) → 落点页 location.origin fetch 即达。
//   全部带 CORS, 故同源/跨域两用皆可。
async function daoServeBridgeRoute(routePath: string, urlObj: URL): Promise<any> {
    const CORS = { 'Access-Control-Allow-Origin': '*' };
    if (routePath === '/__daobridge.js') {
        return { _proxy: true, status: 200, contentType: 'application/javascript; charset=utf-8', body: daoDropBridgeJs(), headers: { 'Cache-Control': 'no-store', ...CORS } };
    }
    // 防 HTTP 头非法字符: Content-Disposition 的 filename= 仅许 ASCII; 非 ASCII(如中文标题)直塞 →
    //   Node 抛 "Invalid character in header content" → 500。故 ASCII 回退名 + RFC5987 filename*(UTF-8)。
    const cdispo = (raw: string): string => {
        const r = String(raw || 'file');
        const ascii = r.replace(/[^\x20-\x7e]/g, '_').replace(/["\r\n]/g, '_');
        return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(r);
    };
    if (routePath === '/__dlfile') {
        const p = urlObj.searchParams.get('p') || '';
        try {
            const dir = path.resolve(daoDownloadsDir());
            const rp = path.resolve(p);
            if (rp.indexOf(dir) !== 0 || !fs.existsSync(rp) || !fs.statSync(rp).isFile()) {
                return { _proxy: true, status: 404, contentType: 'text/plain; charset=utf-8', body: '未找到该文件或越权', headers: { ...CORS } };
            }
            const buf = fs.readFileSync(rp);
            const nm = path.basename(rp).replace(/^[a-z0-9]+-/i, '') || 'download';
            return { _proxy: true, status: 200, contentType: 'application/octet-stream', binary: true, body: buf.toString('base64'), headers: { 'Content-Disposition': cdispo(nm), ...CORS } };
        } catch (e) { return { _proxy: true, status: 500, contentType: 'text/plain; charset=utf-8', body: 'read error', headers: { ...CORS } }; }
    }
    if (routePath === '/__convmd') {
        const rtintMd = _rtflowModule && _rtflowModule._internals;
        const email = urlObj.searchParams.get('email') || '';
        const sid = urlObj.searchParams.get('sid') || '';
        let md: { name?: string; text?: string } | null = null;
        try { if (rtintMd && typeof rtintMd.resolveConvMd === 'function') md = await rtintMd.resolveConvMd(email, sid); } catch (e) { md = null; }
        if (!md || !md.text) return { _proxy: true, status: 404, contentType: 'text/plain; charset=utf-8', body: '无法导出该会话 MD', headers: { ...CORS } };
        return { _proxy: true, status: 200, contentType: 'text/markdown; charset=utf-8', body: md.text, headers: { 'Content-Disposition': cdispo(md.name || 'conversation.md'), ...CORS } };
    }
    return null;
}

// 道·客户端持久缓存(CacheStorage): VS Code webview 的 iframe 不像真浏览器持久化 HTTP 磁盘缓存 →
//   同源官网 SPA 每次重载/切标/导航重取数百哈希分片(即「系统浏览器/手机/单页壳各快一倍, 唯独 IDE
//   内 webview 慢」之真因——同一反代差只在客户端缓存)。此 SW cache-first 仅拦同源哈希不可变静态资产
//   (.js/.css/字体/图等), 跳过 dao 面板自身路由(/api、/__ 桥与 SW)与所有 HTML/导航(无扩展名不匹配)
//   → HTML 恒走网络、登录态/接口不缓存; 资产首载落 Cache, 之后跨导航/重载零网络往返, 媲美真浏览器。
function daoCloudSwJs() {
    return [
        "var C='dao-cloud-assets-v1';",
        "var IM=/\\.(?:js|css|woff2?|ttf|eot|otf|png|jpe?g|gif|svg|ico|wasm)(?:\\?|$)/i;",
        "self.addEventListener('install',function(e){self.skipWaiting();});",
        "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});",
        "self.addEventListener('fetch',function(event){",
        "var req=event.request;",
        "if(req.method!=='GET')return;",
        "try{if(req.headers.get('range'))return;}catch(e){}",
        "var url;try{url=new URL(req.url);}catch(e){return;}",
        "if(url.origin!==self.location.origin)return;",
        "var p=url.pathname;",
        "if(p.indexOf('/__')===0||p.indexOf('/api/')===0)return;",
        "if(!IM.test(p))return;",
        "event.respondWith(caches.open(C).then(function(cache){return cache.match(req).then(function(hit){",
        "if(hit)return hit;",
        "return fetch(req).then(function(resp){if(resp&&resp.status===200){try{cache.put(req,resp.clone());}catch(e){}}return resp;});",
        "});}).catch(function(){return fetch(req);}));",
        "});"
    ].join('');
}

function daoDropBridgeJs() {
    return [
        "(function(){try{",
        "if(window.__daoDropBridge)return;window.__daoDropBridge=1;",
        "var ORIGIN=location.origin;",
        "function toast(t){try{var d=document.createElement('div');d.textContent=t;d.style.cssText='position:fixed;z-index:2147483647;left:50%;top:18px;transform:translateX(-50%);background:#11161d;color:#cdd3de;border:1px solid #2a313b;border-radius:8px;padding:8px 14px;font:13px sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45)';(document.body||document.documentElement).appendChild(d);setTimeout(function(){try{d.parentNode.removeChild(d);}catch(e){}},2800);}catch(e){}}",
        "function mkFile(buf,ct,nm){try{return new File([buf],nm,{type:ct||'application/octet-stream'});}catch(e){var b=new Blob([buf],{type:ct||'application/octet-stream'});try{b.name=nm;}catch(e2){}return b;}}",
        "async function fetchFile(u,nm){var r=await fetch(u,{credentials:'same-origin'});if(!r.ok)throw new Error('HTTP '+r.status);var ct=r.headers.get('content-type')||'application/octet-stream';var buf=await r.arrayBuffer();return mkFile(buf,ct,nm);}",
        "function deepCollect(sel){var out=[];function w(root){var es;try{es=root.querySelectorAll(sel);}catch(e){return;}for(var i=0;i<es.length;i++)out.push(es[i]);var all;try{all=root.querySelectorAll('*');}catch(e2){return;}for(var j=0;j<all.length;j++){if(all[j].shadowRoot)w(all[j].shadowRoot);}}w(document);return out;}",
        "function feed(target,file){try{var dt=new DataTransfer();dt.items.add(file);var inps=deepCollect('input[type=file]');if(inps.length){for(var k=0;k<inps.length;k++){try{inps[k].files=dt.files;inps[k].dispatchEvent(new Event('input',{bubbles:true}));inps[k].dispatchEvent(new Event('change',{bubbles:true}));}catch(e){}}return true;}var eds=deepCollect('textarea,[contenteditable=true]');var t=eds[0]||target||document.body;function mk(tp){var ev;try{ev=new DragEvent(tp,{bubbles:true,cancelable:true});Object.defineProperty(ev,'dataTransfer',{value:dt});}catch(e2){ev=new Event(tp,{bubbles:true,cancelable:true});ev.dataTransfer=dt;}return ev;}try{t.dispatchEvent(mk('dragenter'));t.dispatchEvent(mk('dragover'));var consumed=(t.dispatchEvent(mk('drop'))===false);return consumed;}catch(e3){return false;}}catch(e0){return false;}}",
        "document.addEventListener('dragover',function(e){try{var ts=(e.dataTransfer&&e.dataTransfer.types)||[];var has=false;for(var i=0;i<ts.length;i++){if(ts[i]==='application/x-dao-file'||ts[i]==='application/x-dao-conv')has=true;}if(has){e.preventDefault();try{e.dataTransfer.dropEffect='copy';}catch(x){}}}catch(x){}},true);",
        "document.addEventListener('drop',function(e){try{var dtt=e.dataTransfer;if(!dtt)return;var fp='',cv='';try{fp=dtt.getData('application/x-dao-file');}catch(x){}try{cv=dtt.getData('application/x-dao-conv');}catch(x){}if(!fp&&!cv)return;e.preventDefault();e.stopPropagation();var tgt=e.target||document.body;toast('\\u23f3 \\u6b63\\u5728\\u4e0a\\u4f20\\u2026');(async function(){try{var f;if(fp){var o=JSON.parse(fp);f=await fetchFile(ORIGIN+'/__dlfile?p='+encodeURIComponent(o.path||''),(o.name||'file'));}else{var c=JSON.parse(cv);f=await fetchFile(ORIGIN+'/__convmd?email='+encodeURIComponent(c.email||'')+'&sid='+encodeURIComponent(c.sid||''),((c.title||c.sid||'conversation')+'.md'));}var ok=feed(tgt,f);toast(ok?('\\u2705 \\u5df2\\u6295\\u9012\\u4e0a\\u4f20 '+f.name):('\\u26a0 \\u672a\\u627e\\u5230\\u4e0a\\u4f20\\u6846 '+f.name));}catch(err){toast('\\u2715 \\u4e0a\\u4f20\\u5931\\u8d25: '+((err&&err.message)||err));}})();}catch(x){}},true);",
        // 归一·根治拖拽上传: 外壳(父文档)同源可靠接住 drop → postMessage 命令本桥执行上传(不依赖跨源 iframe 原生 DnD)。
        "window.addEventListener('message',function(e){try{var d=e&&e.data;if(!d||!d.__daoUpload)return;var u=d.__daoUpload;(async function(){try{var f;if(u.kind==='file'){f=await fetchFile(ORIGIN+'/__dlfile?p='+encodeURIComponent(u.path||''),(u.name||'file'));}else{f=await fetchFile(ORIGIN+'/__convmd?email='+encodeURIComponent(u.email||'')+'&sid='+encodeURIComponent(u.sid||''),((u.title||u.sid||'conversation')+'.md'));}toast('\\u23f3 \\u6b63\\u5728\\u4e0a\\u4f20\\u2026');var ok=feed(document.body,f);toast(ok?('\\u2705 \\u5df2\\u6295\\u9012\\u4e0a\\u4f20 '+f.name):('\\u26a0 \\u672a\\u627e\\u5230\\u4e0a\\u4f20\\u6846 '+f.name));}catch(err){toast('\\u2715 \\u4e0a\\u4f20\\u5931\\u8d25: '+((err&&err.message)||err));}})();}catch(x){}},false);",
        "}catch(e){}})();"
    ].join("");
}

// 归一 · 搜索引擎结果链接「跳转包装」解包 — 各大引擎结果均非直链, 而是经自家跟踪跳转中转:
//   Bing  /ck/a?...&u=a1<base64url(dest)>  · Google /url?q=<dest> · DuckDuckGo /l/?uddg=<dest>。
//   不解包则点击结果经代理取到的是跳转中转页(JS/meta refresh) → webview 内白屏(用户「搜索没做好」根因)。
//   解出真实目标(绝对=直达原站, 相对=回落引擎自身如 bing /images 标签页) → 点击结果即正常进站。
function _unwrapSearchRedirect(u) {
    try {
        const host = (u.hostname || '').toLowerCase();
        const path = u.pathname || '';
        if (/(^|\.)bing\.com$/.test(host) && /^\/ck\/a/i.test(path)) {
            let raw = u.searchParams.get('u') || '';
            if (raw) {
                if (/^a1/i.test(raw)) raw = raw.slice(2);
                raw = raw.replace(/-/g, '+').replace(/_/g, '/');
                while (raw.length % 4) raw += '=';
                let dec = '';
                try { dec = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { dec = ''; }
                if (dec && (/^https?:\/\//i.test(dec) || dec.startsWith('/'))) { try { return new URL(dec, u.origin).href; } catch (e) { /* 守柔 */ } }
            }
        }
        if (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/url$/i.test(path)) {
            const q = u.searchParams.get('q') || u.searchParams.get('url') || '';
            if (/^https?:\/\//i.test(q)) return q;
        }
        if (/(^|\.)duckduckgo\.com$/.test(host) && /^\/l\/?$/i.test(path)) {
            const q = u.searchParams.get('uddg') || '';
            if (/^https?:\/\//i.test(q)) return q;
        }
        // v4.10.0 · Yahoo 搜索结果跳转: /r/_ylt=.../*<realURL>
        if (/(^|\.)yahoo\.com$/.test(host) && /^\/r\//i.test(path)) {
            const m = path.match(/\/\*(https?:\/\/.+)/i);
            if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* 守柔 */ } }
        }
        // v4.10.0 · 百度搜索结果跳转: /link?url=<base64orHex>  (需走重定向, 保留原行为让 302 handle 处理)
        // 百度 /s?wd= 结果链接实际已是 /link?url= 302, 无需客户端解包; 但 Sogou/360 同理。
        if (/(^|\.)sogou\.com$/.test(host) && /^\/link$/i.test(path)) {
            const q = u.searchParams.get('url') || '';
            if (/^https?:\/\//i.test(q)) return q;
        }
    } catch (e) { /* 守柔 */ }
    return null;
}
async function genericWebProxy(targetUrl, depth = 0, reqCtx: any = null, isSub = false) {
    const errPage = (msg, href) => {
        const safeHref = (href || '').replace(/"/g, '&quot;');
        const host = (() => { try { return new URL(href || targetUrl).host; } catch (e359) { return ''; } })();
        return {
            _proxy: true, status: 200, contentType: 'text/html; charset=utf-8',
            body: '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                + '<body style="margin:0;background:#0d1117;color:#c9d1d9;font:14px/1.7 -apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">'
                + '<div style="max-width:520px;padding:28px 30px;text-align:center">'
                + '<div style="font-size:38px;margin-bottom:10px">🌐</div>'
                + '<div style="font-size:16px;color:#e6edf3;font-weight:700;margin-bottom:6px">此页暂时打不开</div>'
                + (host ? '<div style="color:#8b949e;font-size:12.5px;word-break:break-all;margin-bottom:14px">' + host.replace(/[<>]/g, '') + '</div>' : '')
                + '<div style="color:#8b949e;margin-bottom:20px">' + String(msg).replace(/[<>]/g, '')
                + '<br>可能是站点屏蔽了代理请求, 或当前网络无法直达(如需科学上网/站点限区)。</div>'
                + '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">'
                + '<button onclick="location.reload()" style="background:#1f6feb;color:#fff;border:0;border-radius:7px;padding:9px 18px;font-size:13px;cursor:pointer">↻ 重试</button>'
                + (safeHref ? '<a href="' + safeHref + '" target="_blank" rel="noopener" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:7px;padding:9px 18px;font-size:13px;text-decoration:none">↗ 用系统浏览器打开</a>' : '')
                + '</div></div></body>',
        };
    };
    if (depth > 6) return errPage('重定向过多', targetUrl);
    let u;
    try { u = new URL(targetUrl); } catch (e360) { return errPage('非法网址', targetUrl); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return errPage('仅支持 http/https', targetUrl);
    // 道·解包搜索引擎结果跳转(点结果不再白屏): 命中即以真实目标递归(depth 守门防环)。
    const _redir = _unwrapSearchRedirect(u);
    if (_redir && _redir !== u.href && _redir !== targetUrl) return await genericWebProxy(_redir, depth + 1);
    return await new Promise((resolve) => {
        let done = false;
        let proxyReq = null;
        const finish = (v) => { if (done) return; done = true; try { clearTimeout(hardTimer); } catch (e361) { /* 守柔 */ } try { if (proxyReq) proxyReq.destroy(); } catch (e362) { /* 守柔 */ } resolve(v); };
        // 硬墙超时: 不论 socket 在连接/发送/接收哪一阶段卡住, 到点即返站内错误页, 杜绝隧道层 502 直出。
        //   放宽到 22s 以容纳「直连黑洞超时 → 代理赛道仍能在限内返回」, 不再过早误判打不开。
        const hardTimer = setTimeout(() => finish(errPage('加载超时(网络不可达或站点过慢)', u.href)), 22000);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const reqHeaders = {
            'User-Agent': DEVIN_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Upgrade-Insecure-Requests': '1',
            'sec-ch-ua': '"Chromium";v="124", "Not.A/Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Referer': u.origin + '/',
            'Connection': 'keep-alive',
            'Host': u.host,
        };
        // 逐源 Cookie 罐: 附该目标站已积累的会话 Cookie → 登录态跨请求保持(GitHub 等站内操作可用)。
        const _rh: any = reqHeaders;
        const _method = (reqCtx && reqCtx.method) ? String(reqCtx.method).toUpperCase() : 'GET';
        const _ck = webProxyCookieHeader(u.origin);
        if (_ck) _rh['Cookie'] = _ck;
        if (reqCtx && reqCtx.accept) _rh['Accept'] = reqCtx.accept;
        if (isSub) { _rh['Sec-Fetch-Mode'] = 'cors'; _rh['Sec-Fetch-Dest'] = 'empty'; _rh['Sec-Fetch-Site'] = 'same-origin'; delete _rh['Upgrade-Insecure-Requests']; }
        if (_method !== 'GET' && _method !== 'HEAD') {
            _rh['Origin'] = u.origin;
            if (!isSub) _rh['Sec-Fetch-Mode'] = 'navigate';
            if (reqCtx && reqCtx.contentType) _rh['Content-Type'] = reqCtx.contentType;
            if (reqCtx && reqCtx.body) _rh['Content-Length'] = String(reqCtx.body.length);
        }
        const options: any = {
            hostname: u.hostname,
            port: u.port ? parseInt(u.port) : (isHttps ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            method: _method,
            headers: reqHeaders,
            timeout: 14000,
            agent: isHttps ? webProxyHttpsAgent : webProxyHttpAgent,
        };
        if (isHttps) options.rejectUnauthorized = false;
        // 道·「天下之至柔驰骋于天下之致坚」— 响应体统一处理: 解压 → 下载登记 → HTML 注入(改写链接经同源代理)。直连/隧道两路共用。
        const processBody = async (sc, headers, raw) => {
            if (done) return;
            const ct = String(headers['content-type'] || '');
            const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
            const enc = String(headers['content-encoding'] || '').toLowerCase();
            const zlib = require('zlib');
            const body = await new Promise((rr) => {
                if (enc === 'gzip') zlib.gunzip(raw, (e, b) => rr(e ? raw : b));
                else if (enc === 'br') zlib.brotliDecompress(raw, (e, b) => rr(e ? raw : b));
                else if (enc === 'deflate') zlib.inflate(raw, (e, b) => rr(e ? raw : b));
                else rr(raw);
            });
            const cd = String(headers['content-disposition'] || '');
            if (_isDownloadable(cd, ct)) {
                // 网页内下载的真实文件 → 落盘登记(供 ⬇下载悬浮窗), 同时回传 attachment 让浏览器原生下载。
                const fname = _dlFilename(cd, u, ct);
                try { daoSaveDownload(fname, body, ct, u.href); } catch (e364) { /* 守柔 */ }
                finish({ _proxy: true, status: sc, contentType: ct || 'application/octet-stream', body: body.toString('base64'), binary: true, headers: { 'Content-Disposition': 'attachment; filename="' + fname.replace(/["\r\n]/g, '_') + '"' } });
                return;
            }
            if (!isHtml) {
                finish({ _proxy: true, status: sc, contentType: ct || 'application/octet-stream', body: body.toString('base64'), binary: true });
                return;
            }
            // 子资源(fetch/XHR)命中 HTML(如站内 API 回 text/html 片段) → 原样返, 绝不注入外壳脚本,
            //   否则污染 AJAX 响应体致站内交互错乱。仅顶层文档导航才注入链接/表单/fetch/XHR 拦截桥。
            if (isSub) { finish({ _proxy: true, status: sc, contentType: ct || 'text/html; charset=utf-8', body: body.toString('utf8') }); return; }
            let html = body.toString('utf8');
            const pBase = 'http://127.0.0.1:' + (ws && ws.port ? ws.port : DEFAULT_PORT) + '/__web?u=';
            const _oh = u.origin.replace(/"/g, '&quot;');
            const inj = '<base href="' + (u.origin + '/').replace(/"/g, '&quot;') + '">'
                // 预连接源站 → 提前完成 DNS/TCP/TLS 握手, 内嵌网页/搜索页的子资源(图/样式/脚本)更快到位 (对齐浏览器级首屏)。
                + '<link rel="preconnect" href="' + _oh + '" crossorigin><link rel="dns-prefetch" href="' + _oh + '">'
                + '<script>(function(){'
                + 'var PB=' + JSON.stringify(pBase) + ';'
                + 'var P=((location.origin&&/^https?:/i.test(location.origin))?location.origin+"/__web?u=":PB),B=' + JSON.stringify(u.href) + ';'
                + 'function ab(h){try{return new URL(h,B).href}catch(e){return ""}}'
                + 'function wrap(h){if(typeof h==="string"&&h.indexOf(P)===0)return h;var a=ab(h);return /^https?:/i.test(a)?(P+encodeURIComponent(a)):h}'
                + 'function isProxied(x){return typeof x==="string"&&x.indexOf("/__web?u=")>=0}'
                + 'function subUrl(x){var a=ab(x);return (/^https?:/i.test(a)&&!isProxied(x))?(P+encodeURIComponent(a)+"&__sub=1"):x}'
                + 'function go(h){var a=ab(h);if(/^https?:/i.test(a)){_nav(P+encodeURIComponent(a));return true}return false}'
                // _nav: 真实整页跳转(绕过被改写的 location.assign/replace), 防自陷套娃。
                + 'var _asn=window.location.assign.bind(window.location);function _nav(x){try{_asn(x)}catch(e){window.location.href=x}}'
                + 'document.addEventListener("click",function(e){if(e.defaultPrevented||e.button)return;var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(!h||h.charAt(0)==="#"||/^(javascript|mailto|tel|data|blob):/i.test(h))return;if(go(h))e.preventDefault();},true);'
                // 表单提交: GET 表单改写 query 经代理整页跳; POST 表单(登录/评论/提交)重建同源 POST 表单直投 /__web → 站内操作真正生效(旧病灶: 只放行 GET, POST 一律漏网)。multipart 上传交原生(边缘情形)。
                + 'document.addEventListener("submit",function(e){var f=e.target;if(!f||e.defaultPrevented)return;var mth=(f.getAttribute("method")||f.method||"get").toLowerCase();var act;try{act=new URL(f.getAttribute("action")||B,B).href}catch(x){return}if(!/^https?:/i.test(act))return;if(mth!=="post"){try{var u2=new URL(act);u2.search=new URLSearchParams(new FormData(f)).toString();e.preventDefault();_nav(P+encodeURIComponent(u2.href));}catch(x){}return}if((f.getAttribute("enctype")||"").toLowerCase().indexOf("multipart")>=0)return;e.preventDefault();try{var nf=document.createElement("form");nf.method="POST";nf.action=P+encodeURIComponent(act);nf.style.display="none";new FormData(f).forEach(function(v,k){if(typeof v==="string"){var ip=document.createElement("input");ip.type="hidden";ip.name=k;ip.value=v;nf.appendChild(ip)}});document.body.appendChild(nf);nf.submit();}catch(x){}},true);'
                // fetch/XHR 拦截: 站内一切 AJAX(GitHub 等 SPA 数据面全走此)改经同源 /__web 代理并带凭据 → 跨源 CORS/掉 Cookie 之困全消(旧病灶: fetch 直打真源被 CORS 拦死, 搜完就不能操作)。
                + 'try{var _F=window.fetch;if(_F){window.fetch=function(inp,ini){try{var url=(typeof inp==="string")?inp:(inp&&inp.url);if(url&&!isProxied(url)){var nu=subUrl(url);if(nu!==url){if(typeof inp==="string")return _F(nu,Object.assign({credentials:"include"},ini||{}));try{return _F(new Request(nu,inp),ini)}catch(e2){return _F(nu,Object.assign({credentials:"include"},ini||{}))}}}}catch(e){}return _F.call(this,inp,ini)};}}catch(e){}'
                + 'try{var _xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,url){var a2=arguments;try{if(url&&!isProxied(url)){var nu=subUrl(url);if(nu!==url){a2=[m,nu].concat([].slice.call(arguments,2))}}}catch(e){}return _xo.apply(this,a2)};}catch(e){}'
                + 'try{window.open=function(u){if(u){go(u)}return null};}catch(e){}'
                // JS 驱动的整页跳转(搜索结果/SPA 多层点进) → 同样改经 /__web 代理, 否则套娃页直跳真站致掉登录/空白。
                + 'try{window.location.assign=function(u){return _asn(wrap(u))};}catch(e){}'
                + 'try{var _rpl=window.location.replace.bind(window.location);window.location.replace=function(u){return _rpl(wrap(u))};}catch(e){}'
                // 注: location.href= setter 无法重定义, 故靠上面 click 捕获 + assign/replace 包裹作双保险。
                // 病灶(多级套嵌白屏): 站内嵌套 iframe/frame 的 src 经 <base> 解析回真源 → 被 XFO/CSP 拦死成白屏。
                //   → 一律改经 /__web 递归代理(页中页同样剥 XFO/CSP), 并 MutationObserver 兜底动态插入的帧。
                + 'function fixFrames(r){try{var fs=(r||document).querySelectorAll?(r||document).querySelectorAll("iframe[src],frame[src]"):null;if(!fs)return;for(var i=0;i<fs.length;i++){var s=fs[i].getAttribute("src");if(s&&!isProxied(s)&&!/^(about:|javascript:|data:|blob:|#)/i.test(s)){var a=ab(s);if(/^https?:/i.test(a))fs[i].setAttribute("src",P+encodeURIComponent(a))}}}catch(e){}}'
                + 'try{if(document.readyState!=="loading")fixFrames();document.addEventListener("DOMContentLoaded",function(){fixFrames()});}catch(e){}'
                + 'try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var an=ms[i].addedNodes||[];for(var j=0;j<an.length;j++){var n=an[j];if(n&&n.nodeType===1){if(n.tagName==="IFRAME"||n.tagName==="FRAME"){var s=n.getAttribute("src");if(s&&!isProxied(s)&&/^https?:/i.test(ab(s)))n.setAttribute("src",P+encodeURIComponent(ab(s)))}else fixFrames(n)}}}}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}'
                + '})();<\/script>'
                + '<script src="/__daobridge.js"><\/script>'; // 拖拽上传桥(下载文件/会话MD → 投递页面上传框)
            html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, '<head$1>' + inj) : (inj + html);
            finish({ _proxy: true, status: sc, contentType: 'text/html; charset=utf-8', body: html });
        };
        // 归一 · 取响应后统一处理重定向或落体, 直连/代理两赛道共用。
        const handle = (sc, headers, raw) => {
            if (done) return;
            // 逐源 Cookie 罐: 收 Set-Cookie 归入本目标站会话 → 下次该站请求自动附带(登录态持久)。
            try { if (headers && headers['set-cookie']) webProxyStoreCookies(u.origin, headers['set-cookie']); } catch (e) { /* 守柔 */ }
            if (sc >= 300 && sc < 400 && headers && headers['location']) {
                let loc = String(headers['location']);
                try { loc = new URL(loc, u.href).href; } catch (e363) { /* 守柔 */ }
                // 跳转后一律以 GET 续取(浏览器语义), 但沿用 isSub 以免子资源跳转被注壳。
                finish(genericWebProxy(loc, depth + 1, null, isSub));
                return;
            }
            processBody(sc || 200, headers || {}, raw || Buffer.alloc(0));
        };
        // 道·并行赛道(天下莫柔弱于水, 而攻坚强者莫之能胜): 本机检出代理(Clash/V2Ray)时,
        //   「直连」与「经本机代理 CONNECT 隧道」两路同时取, 谁先成谁用。国内站直连即刻命中;
        //   被墙站(google 等)直连黑洞超时, 而代理 1~2s 即返 → 不再误判「打不开」, 媲美系统浏览器走代理。
        const proxyPort = detectedProxyPort || detectProxyPort();
        const hasProxy = proxyPort > 0;
        let dFail = false, pFail = false;
        const maybeErr = () => { if (done) return; if (dFail && (pFail || !hasProxy)) finish(errPage(hasProxy ? '代理连接失败(直连与代理均不可达)' : '网络不可达(未检测到本地代理·如有 Clash/V2Ray 请确认已启动)', u.href)); };
        const directFail = () => { dFail = true; maybeErr(); };
        const proxyFail = () => { pFail = true; maybeErr(); };
        // 直连赛道
        proxyReq = lib.request(options, (pr) => {
            const sc = pr.statusCode || 200;
            const chunks = [];
            pr.on('error', () => directFail());
            pr.on('data', (c) => chunks.push(c));
            pr.on('end', () => handle(sc, pr.headers, Buffer.concat(chunks)));
        });
        proxyReq.on('error', () => directFail());
        proxyReq.on('timeout', () => { try { proxyReq.destroy(); } catch (e) { /* 守柔 */ } directFail(); });
        if (reqCtx && reqCtx.body && reqCtx.body.length) { try { proxyReq.write(reqCtx.body); } catch (e) { /* 守柔 */ } }
        proxyReq.end();
        // 代理赛道(经本机 Clash/V2Ray: https 走 CONNECT 隧道, http 走标准代理 GET; 与官网代理/MCP 接测同策)
        //   仅 GET 走并行代理赛道(fetchViaTunnel 不承载请求体); 非 GET(站内操作)专走直连以保方法/体完整。
        if (hasProxy && _method === 'GET') {
            fetchViaTunnel(u, reqHeaders, 16000).then((tr) => {
                if (done) return;
                if (!tr) { proxyFail(); return; }
                handle(tr.status || 200, tr.headers, tr.raw);
            }).catch(() => proxyFail());
        }
    });
}

async function devinCloudProxyRoute(route: string, url: URL, req: any, mode: string = 'devin', res?: any): Promise<any> {
    // 帛书·「天下之至柔驰骋于天下之致坚」— 反向代理不需要Devin API认证
    // 代理只做三件事: 剥安全头 + 改写URL + 透传请求
    // Devin SPA通过Auth0认证 — 代理只是透传，不需要Bearer token
    // 即使ws.devinAuth1为空，也应该允许代理（用户可能通过SPA自行登录）

    // 帛书·四十一「反者道之动」— 路径映射: 代理前缀 → 真实源站
    let targetPath: string;
    let targetUrl: string;
    let upstreamBase: string;
    let proxyPrefix: string;

    if (mode === 'windsurf') {
        // /devin-cloud-ws/xxx → https://windsurf.com/xxx
        upstreamBase = DEVIN_WINDSURF;
        proxyPrefix = '/devin-cloud-ws/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    } else if (mode === 'register') {
        // /devin-cloud-ws-register/xxx → https://register.windsurf.com/xxx
        upstreamBase = 'https://register.windsurf.com';
        proxyPrefix = '/devin-cloud-ws-register/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    } else if (mode === 'codeium') {
        // /devin-cloud-ws-cdn/xxx → https://server.codeium.com/xxx
        upstreamBase = 'https://server.codeium.com';
        proxyPrefix = '/devin-cloud-ws-cdn/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    } else if (mode === 'self-serve') {
        // /devin-cloud-ws-ss/xxx → https://server.self-serve.windsurf.com/xxx
        upstreamBase = 'https://server.self-serve.windsurf.com';
        proxyPrefix = '/devin-cloud-ws-ss/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    } else if (mode === 'api') {
        // /devin-cloud-api/xxx → https://api.devin.ai/xxx (公网 API · 携 auth1)
        upstreamBase = DEVIN_API;
        proxyPrefix = '/devin-cloud-api/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    } else if (mode === 'backend') {
        // /devin-cloud-backend/xxx → https://backend.webapp.devin.ai/xxx (webapp 后端 · 携 auth1)
        upstreamBase = DEVIN_BACKEND;
        proxyPrefix = '/devin-cloud-backend/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    } else {
        // /devin-cloud/xxx → https://app.devin.ai/xxx
        upstreamBase = DEVIN_APP;
        proxyPrefix = '/devin-cloud/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    }

    // 道·「知其雄·守其雌」— 回链基址须随访问者所在而生, 非恒钉本机。
    //   病根: localBase 恒为 http://localhost:<port> → 经公网隧道访问时, SPA 内所有
    //   绝对回链 (资源/重定向/认证桥) 全指向访问者本机 localhost(不可达) → 白屏/逃逸至 app.devin.ai。
    //   归一: Host 为 localhost/127.0.0.1/::1 = IDE 内置浏览器本地访问 → 回链 localhost(原行为);
    //   否则 = 经隧道/中继的公网访问 → 回链同源公网域(访问者浏览器自身可达), 隧道只搬轻量 HTTP 数据。
    //   取源优先级: x-forwarded-host(cloudflared/中继必置, 最可靠) → host 头 → 皆缺则回落 ws.publicUrl。
    const _hh = (req && req.headers) || {};
    const _xfHost = String(_hh['x-forwarded-host'] || '').split(',')[0].trim();
    const _hostHdr = String(_hh['host'] || '').trim();
    const _reqHost = _xfHost || _hostHdr;
    const _isLocalHost = !_reqHost || /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(_reqHost);
    const _fwdProto = (String(_hh['x-forwarded-proto'] || '').split(',')[0].trim()) || 'https';
    let localBase: string;
    if (_isLocalHost) {
        // 守其雌·并理别名: 本地访问须回链「访问者实际所用主机」, 不可一律钉死 localhost。
        //   病根: 经 127.0.0.1:<port> 打开时若回链归一为 localhost:<port>, 页面 origin(127.0.0.1)
        //   与注入的 WEBAPP_HOST(localhost) 不符 → SPA 主机守卫硬跳 https://localhost/login
        //   (Chrome 视 https 本地 → ERR_SSL_PROTOCOL_ERROR / iframe 破图)。故保留原主机别名, 仅缺失时回落 localhost。
        localBase = `http://${_reqHost || ('localhost:' + ws.port)}`;
    } else if (_reqHost) {
        localBase = `${_fwdProto}://${_reqHost}`;
    } else {
        // 极罕见: 非本地却无 host 头 → 回落内建公网 URL, 仍胜过钉死 localhost
        localBase = ws.publicUrl || `http://localhost:${ws.port}`;
    }

    // 判断是静态资源还是页面请求
    const isPageRequest = !targetPath.match(/\.(js|css|png|jpg|svg|ico|woff2?|ttf|eot|map|json|wasm)(\?|$)/i);
    const isApiRequest = targetPath.startsWith('/api/');

    // 道·「不辱以靜」— 仅对内容哈希的不变资源(/assets/*)缓存: 哈希变则键变, 绝不陈旧
    const isImmutableAsset = /\/assets\/.+\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|ico|wasm)(\?|$)/i.test(targetPath);
    // 道·「不貳」— JS 资源内的绝对回链按 localBase 改写, 故缓存键须按回链基址分桶,
    //   否则公网改写版会污染本地访问(或反之)。非 JS 资源逐字节同构, 同桶不碍。
    const cacheKey = mode + '|' + localBase + '|' + targetPath;
    if (isImmutableAsset && (req.method || 'GET') === 'GET') {
        // L1 内存 → L2 磁盘 (跨宿主重载/多用户共享; 命中即零穿隧, 隧道只剩动态核心数据)
        const hit = staticAssetCache.get(cacheKey) || staticCacheGetDisk(cacheKey);
        if (hit) return { _proxy: true, status: hit.status, headers: hit.headers, body: hit.body, contentType: hit.contentType, binary: hit.binary };
    }

    // 帛书·「执天之行」: 预读请求体 — 必须在 https.request 之前读取并据此设 Content-Length。
    // 否则 proxyReq.write 无 Content-Length 走 chunked 编码, app.devin.ai 网关挂起 → 15s 超时。
    // 在 makeRequest 内 await readBody 还会与 https 建连时序竞态, 故统一前置一次读取。
    let reqBody = '';
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        try { reqBody = await readBody(req); } catch { reqBody = ''; }
    }

    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        // 道·直连优先 + 代理兜底: 未被墙站(app.devin.ai 等)直连最快(实测 ~0.3s), 经 Clash 反而 3.7~7.9s 冷开白屏;
        //   仅当直连被 RST/超时(GFW) 才回退本机代理隧道。与 genericWebProxy/#4 同策。两向各只试一次, 不空转。
        let _triedProxy = false, _triedDirect = false;

        const makeRequest = (hostname: string, port: number, reqPath: string, h: any, isProxyTunnel: boolean = false) => {
            const options: any = {
                hostname, port, path: reqPath,
                method: req.method || 'GET',
                headers: h,
                timeout: 15000,
            };
            if (!isProxyTunnel) options.rejectUnauthorized = false;
            options.agent = isProxyTunnel ? upstreamHttpAgent : upstreamHttpsAgent;
            // 代理隧道用http.request(127.0.0.1不是TLS!)，直连用https.request
            const proxyReq = (isProxyTunnel ? http.request : https.request)(options, (proxyRes: any) => {
                // 缺陷4修复: 处理3xx重定向 — 改写Location头指向代理
                if (proxyRes.statusCode && proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
                    const location = proxyRes.headers['location'] || '';
                    if (location) {
                        // 改写重定向URL: app.devin.ai / api / backend → 同源代理(本地或公网隧道, 随 localBase)
                        const rewritten = location
                            .replace(DEVIN_APP + '/', `${localBase}/devin-cloud/`)
                            .replace(DEVIN_API + '/', `${localBase}/devin-cloud-api/`)
                            .replace(DEVIN_BACKEND + '/', `${localBase}/devin-cloud-backend/`);
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: { 'Location': rewritten },
                            body: '',
                            contentType: 'text/html',
                        });
                    } else {
                        resolve({ _proxy: true, status: proxyRes.statusCode, headers: {}, body: '', contentType: 'text/html' });
                    }
                    proxyRes.resume(); // 消费响应体
                    return;
                }

                const contentType = proxyRes.headers['content-type'] || '';
                const isHtml = contentType.includes('text/html');
                const isJs = contentType.includes('javascript') || contentType.includes('application/x-javascript');
                const isJson = contentType.includes('application/json') || contentType.includes('+json');

                // 缺陷10修复: 检测gzip/br压缩 — 要求上游发送未压缩内容
                // 如果上游返回了压缩内容，我们无法改写，必须请求未压缩的
                const contentEncoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();

                // 剥离安全头 — 这是反向代理的核心价值
                // 缺陷7修复: 完全移除CSP（而不是只移除frame-ancestors），因为SPA的CSP会阻止localhost加载
                const safeHeaders: Record<string, string | string[]> = {};
                for (const [k, v] of Object.entries(proxyRes.headers)) {
                    if (!v) continue;
                    const kl = k.toLowerCase();
                    // 跳过禁止iframe嵌入的安全头
                    if (kl === 'x-frame-options') continue;
                    // 缺陷7: 完全移除CSP，不仅frame-ancestors
                    if (kl === 'content-security-policy') continue;
                    if (kl === 'strict-transport-security') continue;
                    if (kl === 'x-content-type-options') continue;
                    // 缺陷10: 移除content-encoding，因为我们改写了内容
                    if (kl === 'content-encoding') continue;
                    // 移除content-length，因为改写后长度变化
                    if (kl === 'content-length') continue;
                    // 帛书·剥逐跳头(hop-by-hop): 上游 CloudFront 常回 Connection: close, 原样回放给 webview
                    //   → 每个资产请求后强拆 TCP; 公网隧道路每资产重握手(真 RTT 税)。剥除并下方统一改 keep-alive,
                    //   令 socket 跨资产复用 — 与 IDE 多实例那条 (devin_proxy.js _keepAliveHeaders) 同道。
                    if (kl === 'connection' || kl === 'keep-alive' || kl === 'transfer-encoding' || kl === 'proxy-connection' || kl === 'proxy-authenticate' || kl === 'proxy-authorization' || kl === 'te' || kl === 'trailer' || kl === 'upgrade') continue;
                    safeHeaders[k] = v as string | string[];
                }
                safeHeaders['Connection'] = 'keep-alive';
                safeHeaders['X-Dao-Ka'] = 'v498c';

                // 道·「天下之至柔，驰骋于天下之致坚；无有入于无间」— SSE 流式直通(诚实待办兑现)
                //   text/event-stream 不可缓冲: 旧路径 chunks.push→end 收齐才返回,
                //   对永不关闭的 SSE 流 = 永远收不到 end → 内嵌页"Reconnecting..."空转。
                //   现: 边到边裸管道直送 res, 取消 15s 空闲超时, 关流即断上游, 不改写不解码。
                const isEventStream = contentType.includes('text/event-stream');
                if (isEventStream && res && !res.headersSent && !res.writableEnded) {
                    const streamHeaders: Record<string, string> = {};
                    // 道·「不贰」— 显式头去重: 上游小写键(content-type)与下设大写键(Content-Type)
                    //   并存会被 Node 合并成逗号串(no-cache,no-cache,no-transform), 故按小写名跳过下面会重设的键
                    const reservedLower = new Set(['content-length', 'content-type', 'cache-control', 'connection', 'x-accel-buffering']);
                    for (const [k, v] of Object.entries(safeHeaders)) {
                        if (reservedLower.has(k.toLowerCase())) continue;
                        streamHeaders[k] = Array.isArray(v) ? v.join(', ') : (v as string);
                    }
                    streamHeaders['Content-Type'] = contentType || 'text/event-stream';
                    streamHeaders['Cache-Control'] = 'no-cache, no-transform';
                    streamHeaders['Connection'] = 'keep-alive';
                    streamHeaders['X-Accel-Buffering'] = 'no';
                    // SSE 长连接靠事件/心跳维持 — 取消上游 15s 空闲超时, 否则被 proxyReq.on('timeout') 掐断
                    try { proxyReq.setTimeout(0); } catch {}
                    try { if (proxyRes.socket) proxyRes.socket.setTimeout(0); } catch {}
                    res.writeHead(proxyRes.statusCode || 200, streamHeaders);
                    if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch {} }
                    // 上游极少压缩 SSE; 若压缩则流式解码后直通, 否则裸管道
                    const zlibS = require('zlib');
                    let src: any = proxyRes;
                    if (contentEncoding === 'gzip') src = proxyRes.pipe(zlibS.createGunzip());
                    else if (contentEncoding === 'deflate') src = proxyRes.pipe(zlibS.createInflate());
                    else if (contentEncoding === 'br') src = proxyRes.pipe(zlibS.createBrotliDecompress());
                    src.on('data', (chunk: Buffer) => { try { res.write(chunk); } catch {} });
                    const endStream = () => { try { res.end(); } catch {} };
                    src.on('end', endStream);
                    src.on('error', endStream);
                    proxyRes.on('error', endStream);
                    // 客户端(webview)关闭 → 断开上游, 释放连接
                    res.on('close', () => { try { proxyReq.destroy(); } catch {} });
                    resolve({ _streamed: true });
                    return;
                }

                // 收集完整响应体
                const chunks: Buffer[] = [];
                proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                proxyRes.on('end', async () => {
                    const rawBody = Buffer.concat(chunks);
                    // localBase 已在函数顶部按访问者来源(本地/公网隧道)归一计算, 此处复用
                    const okCache = isImmutableAsset && proxyRes.statusCode === 200;

                    // 道·「不言之教·无为之益」— 解压改异步, 移出扩展宿主事件循环
                    //   原 gunzipSync/brotliDecompressSync 对数 MB bundle 同步阻塞主线程
                    //   → 解压期间本地服务无法响应 → 点 IDE 时内嵌网页"卡死点不动"。异步根治。
                    const zlib = require('zlib');
                    const decodedBody: Buffer = await new Promise<Buffer>((res) => {
                        if (contentEncoding === 'gzip') zlib.gunzip(rawBody, (e: any, b: Buffer) => res(e ? rawBody : b));
                        else if (contentEncoding === 'br') zlib.brotliDecompress(rawBody, (e: any, b: Buffer) => res(e ? rawBody : b));
                        else if (contentEncoding === 'deflate') zlib.inflate(rawBody, (e: any, b: Buffer) => res(e ? rawBody : b));
                        else res(rawBody);
                    });

                    if (isHtml && isPageRequest) {
                        // HTML页面: 改写绝对URL + 注入认证脚本
                        let html = decodedBody.toString('utf8');
                        // 缺陷5修复: 改写所有Devin相关域名
                        // 道·同源底座: 后端绝对域先于 app 域改写(互不含子串, 顺序无碍但显式置前)
                        html = html.replace(/https:\/\/api\.devin\.ai/g, `${localBase}/devin-cloud-api`);
                        html = html.replace(/https:\/\/backend\.webapp\.devin\.ai/g, `${localBase}/devin-cloud-backend`);
                        html = html.replace(/https:\/\/app\.devin\.ai\//g, `${localBase}/`);
                        html = html.replace(/https:\/\/app\.devin\.ai"/g, `${localBase}/"`);
                        html = html.replace(/https:\/\/app\.devin\.ai(?!\/)/g, `${localBase}`);
                        // windsurf.com认证资源也需要代理
                        html = html.replace(/https:\/\/windsurf\.com\//g, `${localBase}/devin-cloud-ws/`);
                        // register.windsurf.com 也需要代理
                        html = html.replace(/https:\/\/register\.windsurf\.com\//g, `${localBase}/devin-cloud-ws-register/`);
                        // server.codeium.com / server.self-serve.windsurf.com 代理
                        html = html.replace(/https:\/\/server\.codeium\.com\//g, `${localBase}/devin-cloud-ws-cdn/`);
                        html = html.replace(/https:\/\/server\.self-serve\.windsurf\.com\//g, `${localBase}/devin-cloud-ws-ss/`);
                        // 官网根挂载: SPA 的根相对资源 (/assets/*.js) 原样保留 —
                        // dao 服务器已将非 /api 根路径透传至 app.devin.ai, 故无需改写前缀。
                        // 知其雄·守其雌: 内联引导态(如 window.__INITIAL_STATE__)中的 webapp_host 同样归一为
                        //   当前访问主机, 杜绝 SPA 据此判跨主机而硬跳 app.devin.ai 逃逸出隧道。
                        {
                            const localHost = localBase.replace(/^https?:\/\//i, '');
                            // 守柔·并理 null: 上游可能下发 "webapp_host":null(SPA 据此回落默认主机 app.devin.ai
                            //   → 跨主机硬跳逃出隧道)。故字符串值与 null 字面量一并改写为当前请求主机。
                            html = html.replace(/("webapp_host"\s*:\s*)(?:"[^"]*"|null)/g, `$1"${localHost}"`);
                            html = html.replace(/("webappHost"\s*:\s*)(?:"[^"]*"|null)/g, `$1"${localHost}"`);
                        }

                        // 注入认证桥接脚本 — 帛书·五十二「见小曰明·守柔曰强」
                        // 无为而无以为: 自动注入Cookie → Devin SPA自动识别登录态
                        // 守柔: 仅当持真 auth1_ 令牌时注入; session-token 注入会污染 auth1_session → 反致登录态崩坏
                        // 手动模式(websiteLoginMode=manual): 不注入认证, 用户打开官网后自行登录
                        // 道·多账号并行不相悖: ?dao_acct=<email> 钉住该账号(从按邮箱持久化的真 auth1 读取),
                        // 缺省用当前同步账号。不同浏览器 profile(user-data-dir) → localStorage 隔离 → 多账号同源并行。
                        let pinAuth1 = ws.devinAuth1, pinUid = ws.devinUserId, pinOrg = ws.devinOrgId, pinOrgName = ws.devinOrgName || '', pinEmail = ws.devinEmail || '';
                        try {
                            const acctParam = url.searchParams.get('dao_acct');
                            if (acctParam) {
                                const isActive = acctParam.trim().toLowerCase() === (ws.devinEmail || '').trim().toLowerCase();
                                // 多实例钉号: 先缓存命中; 未缓存且为【他号】→ 按需取号(全池任一账号皆渲染本身, 不回退活动号串号)。
                                let sa = loadAccountAuth(acctParam);
                                if ((!sa || !sa.auth1) && !isActive) { sa = await ensureAccountAuth(acctParam); }
                                if (sa && sa.auth1) { pinAuth1 = sa.auth1; pinUid = sa.userId || ''; pinOrg = sa.orgId || ''; pinOrgName = sa.orgName || ''; pinEmail = acctParam; }
                                else if (!isActive) { pinAuth1 = ''; pinUid = ''; pinOrg = ''; pinOrgName = ''; pinEmail = acctParam; } // 取号失败: 宁空注入(SPA 自登录), 不冒名活动号
                            }
                        } catch { /* 守柔 */ }
                        const websiteAutoLogin = getWebsiteLoginMode() === 'auto';
                        const injA1 = (websiteAutoLogin && pinAuth1 && !pinAuth1.startsWith('devin-session-token$')) ? pinAuth1 : '';
                        const cfgLocalHost = localBase.replace(/^https?:\/\//i, '');
                        const authBridge = `<script>
// Dao Auth Bridge — 帛书·五十二「见小曰明·守柔曰强」
// 自动注入认证到Devin页面 — 无为而无以为
(function(){
  try {
    // 0. 同源底座配置注入 — 帛书·「为之于其未有」: SPA 的 config bundle 读取 globalThis.__DEVIN_CONFIG__
    //    覆盖 API_URL/WEBAPP_HOST。须在任何模块脚本前执行(本桥为 <head> 起始内联经典脚本, 先于 defer 模块),
    //    令 SPA 原生把公网 API 指向同源前缀、把 webapp_host 认作当前主机 → 不再跨源逃逸至 app.devin.ai。
    //    重渲染留在访问者浏览器, 隧道只搬认证后的轻量数据(类手机 APK 路线)。
    window.__DEVIN_CONFIG__ = Object.assign({}, window.__DEVIN_CONFIG__, {
      API_URL: '${localBase}/devin-cloud-api',
      WEBAPP_HOST: '${cfgLocalHost}'
    });
    // 1. localStorage 注入 — 帛书·「观天之道·执天之行」
    //    经真机抓取确认: Devin SPA 的登录态唯一真源是 localStorage['auth1_session']
    //    = {"token":"auth1_...","userId":"user-..."}  — SPA 据此判定已登录, 否则跳转 /auth/login
    //    一并注入 org 相关键, 免去二次解析跳转。
    var __a1 = '${injA1}';
    var __uid = '${pinUid}';
    var __org = '${pinOrg}';
    var __orgName = '${(pinOrgName || '').replace(/['\\\\]/g, '')}';
    // 帛书·「涤除玄览·能无疵乎」— 多实例多号同源(9920)共享 localStorage: 切到新号时上一号残留的
    //   org 列表/路由缓存仍在 → SPA 据旧缓存误跳上一号 /org/<slug>(实测切 nuek 却跳 finley 的 shamkharcig)。
    //   故: 检出 已存 auth1_session.userId 与本号不同 = 账号切换 → 清空 SPA 持久态(保留 dao/主题键),
    //   令其据本号 auth-pinned API 重解析正确 org。同号重载 uid 相同 → 不清(保缓存·快)。
    if (__a1 && __uid) {
      try {
        var __prev = JSON.parse(localStorage.getItem('auth1_session') || '{}');
        if (__prev && __prev.userId && __prev.userId !== __uid) {
          var __keep = /^(dao[-_]|theme|color-theme|workbench)/i;
          for (var __i = localStorage.length - 1; __i >= 0; __i--) {
            var __k = localStorage.key(__i);
            if (__k && !__keep.test(__k)) { try { localStorage.removeItem(__k); } catch (e) {} }
          }
          try { if (window.indexedDB && indexedDB.databases) { indexedDB.databases().then(function(ds){ (ds||[]).forEach(function(d){ if (d && d.name) try { indexedDB.deleteDatabase(d.name); } catch(e){} }); }); } } catch (e) {}
        }
      } catch (e) {}
    }
    if (__a1) {
      localStorage.setItem('auth1_session', JSON.stringify({ token: __a1, userId: __uid }));
      localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18', 'true');
      if (__uid) localStorage.setItem('known-org-ids-' + __uid, JSON.stringify([__org]));
      if (__org) localStorage.setItem('last-internal-org-for-external-org-v1-null', __org);
      // 帛书·「为之于其未有·治之于其未乱」— /settings 子路由(knowledge/playbooks/secrets)守卫
      //   检查 post-auth 完成标记键 post-auth-v3-null-<uid>-org_name-<orgName>; 缺失即跳 /auth/login
      //   去跑 post-auth(竞态/跨 origin 时此键不存在 → 深层路由反复跳登录)。直接种入即闭环。
      if (__org && __uid && __orgName) {
        var __paKey = 'post-auth-v3-null-' + __uid + '-org_name-' + __orgName;
        if (!localStorage.getItem(__paKey)) {
          localStorage.setItem(__paKey, JSON.stringify({ externalOrgId: null, userId: __uid, internalOrgId: __org, orgName: __orgName, result: { resolved_external_org_id: null, org_id: __org, org_name: __orgName, is_valid_resource: true } }));
        }
      }
    }
    // 2. Cookie 标记 — SPA 检查 webapp_logged_in 决定是否显示登录页
    document.cookie = 'webapp_logged_in=true; path=/; max-age=31536000; SameSite=Lax';
    // 3. 拦截fetch/XHR — 官网根挂载下同源相对请求原样透传, 认证由代理服务端注入。
    // 帛书·「执天之行」关键: SPA 常以 fetch(new Request(url,{method:'POST',body}))
    // 形式发请求, 方法/体内嵌于 Request 对象。若仅抽取 url 字符串则丢失 method →
    // 退化为 GET → POST 专用端点(post-auth/auth1/connections)返回 405 → SPA 误判
    // 登录失效 → 清空 auth1_session → 跳转 /auth/login。故 Request 对象必须原样透传。
    var needAuthHdr = function(u) { return typeof u === 'string' && (u.charAt(0) === '/' || u.indexOf('${localBase}') === 0); };
    var origFetch = window.fetch;
    window.fetch = function(url, opts) {
      // Request 对象: 方法/体/头已内嵌, 原样透传(根挂载下已同源, 代理会注入认证)
      if (typeof url !== 'string') { return origFetch.call(this, url, opts); }
      // 字符串 URL: 绝对 app.devin.ai → 根路径; api/backend → 同源前缀; 根相对原样保留
      var newUrl = url.split('https://api.devin.ai').join('${localBase}/devin-cloud-api')
                      .split('https://backend.webapp.devin.ai').join('${localBase}/devin-cloud-backend')
                      .split('https://app.devin.ai').join('');
      opts = opts || {};
      if (needAuthHdr(newUrl) && typeof opts.headers === 'object' && opts.headers && !Array.isArray(opts.headers)) {
        if (!opts.headers['Authorization']) opts.headers['Authorization'] = 'Bearer ${injA1}';
        if (!opts.headers['x-cog-org-id']) opts.headers['x-cog-org-id'] = '${pinOrg}';
      }
      return origFetch.call(this, newUrl, opts);
    };
    var origXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      // XHR.open 方法显式传入, 不会丢失; 改写绝对 app.devin.ai → 根路径; api/backend → 同源前缀
      var newUrl = (typeof url === 'string')
        ? url.split('https://api.devin.ai').join('${localBase}/devin-cloud-api')
             .split('https://backend.webapp.devin.ai').join('${localBase}/devin-cloud-backend')
             .split('https://app.devin.ai').join('')
        : url;
      var result = origXHR.apply(this, [method, newUrl].concat(Array.prototype.slice.call(arguments, 2)));
      if (needAuthHdr(newUrl)) { try { this.setRequestHeader('Authorization', 'Bearer ${injA1}'); this.setRequestHeader('x-cog-org-id', '${pinOrg}'); } catch(e) {} }
      return result;
    };
    // 4. postMessage通信 — 与父窗口(IDE)同步状态
    if (window.parent !== window) {
      window.parent.postMessage({type:'dao-auth',auth1:'${injA1}',orgId:'${pinOrg}',email:'${pinEmail}'}, '*');
    }
    // 5. 通知父窗口加载成功
    if (window.parent !== window) {
      window.parent.postMessage({type:'dao-loaded',mode:'${mode}'}, '*');
    }
  } catch(e){}
})();
</script>`;
                        // 帛书·「为之于其未有·治之于其未乱」— 认证桥接须在 SPA 任何引导脚本之前执行,
                        // 否则路由守卫可能先于 auth1_session 注入而读到空登录态 → 竞态跳转 /auth/login。
                        // 故注入于 <head> 起始(紧随 charset meta), 而非 </head> 之前。
                        // 拖拽上传桥(同源): 本反代页与外壳下载/备份窗口同源 → 拖文件/会话到本页经桥取字节并投递
                        //   Devin 上传框。须 内联 于 <head>(而非 </body> 前挂 <script src>): SPA 引导会清空/重建
                        //   body, 外链脚本走网络往返期间标签已被 SPA 抹除 → 永不执行(实测 __daoDropBridge 不挂);
                        //   内联脚本随首段 HTML 解析即同步执行, 其 document 级 drop/dragover 监听跨 body 重渲染长存。
                        const dragBridgeInline = '<script>' + daoDropBridgeJs() + '</script>';
                        // 客户端持久缓存 SW 注册(同源·scope '/' · 仅缓存哈希不可变静态资产 → IDE webview 重载零往返)。
                        const swRegInline = '<script>(function(){try{if(navigator.serviceWorker){navigator.serviceWorker.register("/__dao_sw.js",{scope:"/"}).catch(function(){});}}catch(e){}})();<\/script>';
                        const headInject = authBridge + swRegInline + dragBridgeInline;
                        if (/<head[^>]*>/i.test(html)) {
                            html = html.replace(/(<head[^>]*>)/i, '$1' + headInject);
                        } else {
                            html = html.replace('</head>', headInject + '</head>');
                        }
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: safeHeaders,
                            body: html,
                            contentType: 'text/html; charset=utf-8',
                        });
                    } else if (isJs) {
                        // JS文件: 改写绝对URL引用
                        let js = decodedBody.toString('utf8');
                        // 道·同源底座根治: config bundle 硬编码的 api/backend 绝对域 → 同源前缀,
                        //   令 SPA 原生构造同源后端地址(穿透只搬认证后数据)。须先于 app 域改写(api/backend
                        //   不含 https://app.devin.ai 子串, 互不干涉)。
                        js = js.replace(/https:\/\/api\.devin\.ai/g, `${localBase}/devin-cloud-api`);
                        js = js.replace(/https:\/\/backend\.webapp\.devin\.ai/g, `${localBase}/devin-cloud-backend`);
                        js = js.replace(/https:\/\/app\.devin\.ai\//g, `${localBase}/devin-cloud/`);
                        js = js.replace(/https:\/\/app\.devin\.ai(?!\/)/g, `${localBase}/devin-cloud`);
                        if (okCache) safeHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
                        if (okCache) staticCachePut(cacheKey, { status: 200, headers: safeHeaders, body: js, contentType });
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: safeHeaders,
                            body: js,
                            contentType,
                        });
                    } else if (isJson && !isImmutableAsset) {
                        // JSON API 响应: 改写 webapp_host → 当前访问者来源主机 (同源归一)
                        // 帛书·「知其雄·守其雌」根因: 真·Devin SPA 引导时取组织 JSON 的 webapp_host,
                        //   若 webapp_host !== window.location.host 即判为「跨主机/异源组织」, 遂硬跳
                        //   https://<webapp_host>/login?next=/org/<name>&internal_org=...  去换组织会话 —
                        //   这一跳逃出隧道(回到 app.devin.ai/auth/login), 同源反代前功尽弃。
                        //   令同源反代下 webapp_host 恒等于当前访问主机(隧道域/localhost) → SPA 认其已在
                        //   本组织归属主机 → 不再跨跳, 原生渲染 /org/<name>。重资产/渲染皆在访问者浏览器,
                        //   隧道只搬认证后的轻量 JSON — 即「重渲染在端, 穿透只传数据」之本源。
                        let bodyStr = decodedBody.toString('utf8');
                        const localHost = localBase.replace(/^https?:\/\//i, '');
                        // 知其雄·守其雌 + 并理 null: post-auth/组织 JSON 实测下发 "webapp_host":null,
                        //   旧正则仅匹配带引号字符串 → 漏改 null → SPA 取 null webappHost 回落默认主机
                        //   app.devin.ai, 令 /org/<slug> 硬跳真站 /login(逃出隧道·掉登录)。故 null 一并归一。
                        bodyStr = bodyStr.replace(/("webapp_host"\s*:\s*)(?:"[^"]*"|null)/g, `$1"${localHost}"`);
                        bodyStr = bodyStr.replace(/("webappHost"\s*:\s*)(?:"[^"]*"|null)/g, `$1"${localHost}"`);
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: safeHeaders,
                            body: bodyStr,
                            contentType,
                        });
                    } else {
                        // 其他资源(css/字体/图片等): 直接透传; 不变资源入缓存
                        const b64 = decodedBody.toString('base64');
                        if (okCache) safeHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
                        if (okCache) staticCachePut(cacheKey, { status: 200, headers: safeHeaders, body: b64, contentType, binary: true });
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: safeHeaders,
                            body: b64,
                            contentType,
                            binary: true,
                        });
                    }
                });
            });

            const _fallback = (errLabel?: string) => {
                // 直连失败(GFW RST/超时) → 有本机代理则改走代理兜底; 代理失败 → 降级直连。互为兜底, 各只一次。
                if (!isProxyTunnel && detectedProxyPort > 0 && !_triedProxy) {
                    _triedProxy = true;
                    makeRequest('127.0.0.1', detectedProxyPort, targetUrl, Object.assign({}, fwdHeaders, { Host: u.hostname }), true);
                    return true;
                }
                if (isProxyTunnel && !_triedDirect) {
                    _triedDirect = true;
                    makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, fwdHeaders, false);
                    return true;
                }
                return false;
            };
            proxyReq.on('error', (e: Error) => {
                if (_fallback()) return;
                resolve({ ok: false, error: 'proxy error: ' + e.message });
            });
            proxyReq.on('timeout', () => {
                proxyReq.destroy();
                if (_fallback()) return;
                resolve({ ok: false, error: 'proxy timeout' });
            });

            // 缺陷8修复: 请求体已前置读取(reqBody) — 直接写出并结束。
            if (reqBody) proxyReq.write(reqBody);
            proxyReq.end();
        };

        // 构建请求头 — 缺陷3修复: 认证头必须在makeRequest之前构建
        const fwdHeaders: any = {
            'User-Agent': DEVIN_UA,
            'Accept': req.headers?.['accept'] || '*/*',
            'Host': u.hostname,
            // 道·「反者道之动」: 上游 gzip 压缩传输(穿隧更快), 代理内解压后再改写
            'Accept-Encoding': 'gzip',
        };
        // 请求体: 转发 Content-Type 并据 reqBody 设 Content-Length(关键 — 见上)
        if (reqBody) {
            fwdHeaders['Content-Length'] = Buffer.byteLength(reqBody).toString();
            if (req.headers?.['content-type']) fwdHeaders['Content-Type'] = req.headers['content-type'];
        }
        // 道·多号并行不相悖: 逐请求按 dao_acct 钉账号注入对应 auth(而非恒用全局活动账号 ws.devinAuth1)。
        //   病根: 旧逻辑对一切上游请求恒注入 ws.devinAuth1(活动/同步号), 覆盖客户端桥所带的本号 bearer
        //   → 多实例第二号(如 nuek)的 /api 调用被钉成首号(finley)的 auth → 返首号 org → 串号(实测 nuek 跳
        //   finley 的 shamkharcig)。dao_acct 来源: 本请求 url 查询(页面请求) → 否则取 Referer 的 dao_acct
        //   (同源 /api XHR 的 Referer = 带 dao_acct 的本 tab 页面 URL·逐 tab 真实来源·不跨 tab 串)。皆无 →
        //   回退全局活动号(单号场景不变)。
        let _apiAuth1 = ws.devinAuth1, _apiOrg = ws.devinOrgId, _apiSess = ws.devinSessionToken;
        try {
            let _acctEmail = url.searchParams.get('dao_acct') || '';
            if (!_acctEmail) {
                const _ref = String((req.headers && (req.headers['referer'] || req.headers['referrer'])) || '');
                if (_ref) { try { _acctEmail = new URL(_ref).searchParams.get('dao_acct') || ''; } catch { /* 守柔 */ } }
            }
            if (_acctEmail && mode === 'devin') {
                const _sa = loadAccountAuth(_acctEmail);
                if (_sa && _sa.auth1) { _apiAuth1 = _sa.auth1; _apiOrg = _sa.orgId || ''; _apiSess = ''; }
                else if (_acctEmail.trim().toLowerCase() !== (ws.devinEmail || '').trim().toLowerCase()) {
                    // 显式他号但未缓存(页面注入已预热, 仍缺则后台取号) → 本次宁不注入·不冒名活动号(防串号)。
                    ensureAccountAuth(_acctEmail).catch(() => { /* 守柔 */ });
                    _apiAuth1 = ''; _apiOrg = ''; _apiSess = '';
                }
            }
        } catch { /* 守柔 */ }
        // 认证头: 所有请求都注入（不仅是API），因为Devin SPA需要认证Cookie
        if (_apiAuth1) {
            fwdHeaders['Authorization'] = 'Bearer ' + _apiAuth1;
            fwdHeaders['X-Devin-Auth1-Token'] = _apiAuth1;
            if (_apiOrg) fwdHeaders['x-cog-org-id'] = _apiOrg;
        }
        // Cookie注入 — 帛书·「大成若缺」— app.devin.ai通过Cookie识别登录态
        // auth1_token / devin_session_token / org_id → Devin SPA自动认证
        const cookies: string[] = [];
        if (_apiAuth1) cookies.push(`auth1_token=${_apiAuth1}`);
        if (_apiSess) cookies.push(`devin_session_token=${_apiSess}`);
        if (_apiOrg) cookies.push(`org_id=${_apiOrg}`);
        if (cookies.length) fwdHeaders['Cookie'] = cookies.join('; ');
        // 转发Referer和Origin — 须改写为源站, 否则 localhost 触发 app.devin.ai 的 CSRF/CORS 拒绝
        fwdHeaders['Origin'] = upstreamBase;
        fwdHeaders['Referer'] = upstreamBase + '/';

        // 直连优先(快); 失败再由 _fallback 回退本机代理隧道(被墙站兜底)。
        _triedDirect = true;
        makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, fwdHeaders, false);
    });
}
