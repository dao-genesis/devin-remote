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
import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════
// 道 · 常量 — 天得一以清 地得一以寧
// CF全局共享(一机一CF账号) + 每工作区独立(一窗口一Devin账号)
// 帛书·三十九「致数与无与」— 不欲禄禄若玉 珞珞若石
// ═══════════════════════════════════════════════════════════
const DAO_DIR = path.join(os.homedir(), '.dao');
const GLOBAL_CONFIG_FILE = path.join(DAO_DIR, 'dao-config.json');  // CF全局凭证
const CONFIG_FILE = GLOBAL_CONFIG_FILE;  // 别名 — 道法自然：一即一切
const INST_FILE = path.join(DAO_DIR, 'dao-instances.json');
// 账号池 — 帛书·六十二「道者万物之注」
// email→password 映射: IDE 注入的 session token 仅能访问 codeium 后端,
// 被 app.devin.ai 拒绝; 全功能面板需 auth1, 而 auth1 只能由 email+password 五步登录换取。
// 账号池让 dao-vsix 据当前登录 email 查到密码 → 自动换取 auth1 → 真实 org。
const ACCOUNTS_FILE = path.join(DAO_DIR, 'accounts.json');
const ACCOUNTS_TXT = path.join(DAO_DIR, 'accounts.txt');
// TOKEN_FILE removed — per-workspace: ws.tokenFile
// SESSION_FILE removed — per-workspace: ws.sessionFile
const PROXY_PORTS = [7890, 10809, 7891, 1080, 10808, 8080, 8118];
let detectedProxyPort = 0;

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
        const wsFolders = vscode.workspace.workspaceFolders;
        const wsPath = wsFolders && wsFolders.length > 0
            ? wsFolders[0].uri.fsPath
            : 'no-workspace';
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
        } catch {}
    }

    getOrCreateToken(): string {
        if (this.token && this.token.length >= 16) return this.token;
        try {
            const t = fs.readFileSync(this.tokenFile, 'utf8').trim();
            if (t && t.length >= 16) { this.token = t; return t; }
        } catch {}
        this.token = 'dao-vsix-' + crypto.randomBytes(16).toString('hex');
        try { fs.writeFileSync(this.tokenFile, this.token, 'utf8'); } catch {}
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


export async function activate(context: vscode.ExtensionContext) {
    // 初始化每窗口专属状态
    ws = new WorkspaceState();
    ws.init();

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'dao.toggleCloudPanel';
    context.subscriptions.push(statusBarItem);

    // ═══════════════════════════════════════════════════════════
    // 双视图 · 帛书·四十二「万物负阴而抱阳」
    // 先声明provider，命令中需要引用
    // ═══════════════════════════════════════════════════════════
    const cloudPanel = new DaoCloudPanel(context.extensionUri);
    sidebarCloudPanel = cloudPanel;
    // 帛书·二十五「道法自然」— 记录扩展路径 · 供读取捆绑规则文本(dao-rules.md)
    try { _daoExtPath = context.extensionPath; } catch { /* 守柔 */ }

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
                // Step 3: 认证成功 → 自动注入（服务器已启动才有URL）
                if (ws.port && ws.devinAuth1 && ws.devinOrgId) {
                    const injectOk = await devinFullInject();
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
        });
    }
    context.subscriptions.push(
        vscode.commands.registerCommand('dao.startServer', () => startServer(context)),
        vscode.commands.registerCommand('dao.stopServer', stopServer),
        vscode.commands.registerCommand('dao.showPort', showPort),
        vscode.commands.registerCommand('dao.showInfo', showWorkspaceInfo),
        vscode.commands.registerCommand('dao.copyConnection', copyConnection),
        vscode.commands.registerCommand('dao.regenerateToken', regenerateToken),
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
        vscode.commands.registerCommand('dao.devinInject', () => devinFullInject()),
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
        vscode.commands.registerCommand('dao.devinCloudBrowser', () => {
            // 帛书·「天下之至柔驰骋于天下之致坚」— 反向代理自动注入认证
            // 通过本地反向代理路由官网 — 自动注入Cookie/Token，无需GUI登录
            if (!ws.port) {
                vscode.window.showWarningMessage('DAO 服务器未启动');
                return;
            }
            const proxyUrl = `http://localhost:${ws.port}/devin-cloud/`;
            try {
                if (ws.devinAuth1) {
                    // 已认证 — 通过反向代理路由，自动注入Cookie
                    vscode.commands.executeCommand('simpleBrowser.show', proxyUrl);
                } else {
                    // 未认证 — 直接打开，依赖Electron session
                    vscode.commands.executeCommand('simpleBrowser.show', DEVIN_APP);
                }
            }
            catch { vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP)); }
        }),
        vscode.commands.registerCommand('dao.devinCloudPanel', () => {
            // 帛书·「天下之至柔驰骋于天下之致坚」— 反向代理自动注入认证
            if (ws.port && ws.devinAuth1) {
                const proxyUrl = `http://localhost:${ws.port}/devin-cloud/`;
                try { vscode.commands.executeCommand('simpleBrowser.show', proxyUrl); }
                catch { vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP)); }
            } else {
                try { vscode.commands.executeCommand('simpleBrowser.show', DEVIN_APP); }
                catch { vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP)); }
            }
        }),
        vscode.commands.registerCommand('dao.openDashboard', () => {
            vscode.commands.executeCommand('workbench.view.extension.devin-cloud-container');
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
    // 统一视图 · DaoCloudPanel — 万物负阴而抱阳
    // Tab导航: Sessions | Knowledge | Playbooks | Secrets | Git | Settings
    // ═══════════════════════════════════════════════════════════
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('dao.cloudPanel', cloudPanel)
    );

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
        port: config.get<number>('port', 9910),
        token: config.get<string>('token', ''),
        relayUrl: config.get<string>('relayUrl', ''),
        autoBridge: config.get<boolean>('autoBridge', true),
    };
}

// ═══════════════════════════════════════════════════════════
// 身 · Token — 自动生成持久化
// ═══════════════════════════════════════════════════════════
function checkAuth(req: any): boolean {
    const auth = req.headers?.['authorization'] || '';
    if (auth === `Bearer ${ws.token}`) return true;
    const url = new URL(req.url || '/', `http://localhost:${ws.port}`);
    if (url.searchParams.get('master_token') === ws.token) return true;
    // Local loopback exempt for read-only endpoints; relay/public must carry token
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        const roPaths = ['/api/health', '/api/workspace', '/api/agents', '/devin-cloud/', '/devin-cloud-ws/', '/devin-cloud-ws-register/', '/devin-cloud-ws-cdn/', '/devin-cloud-ws-ss/'];
        if (roPaths.some(p => url.pathname.startsWith(p))) return true;
    }
    return false;
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
            const result = await handleRouteInternal(route, url, req, ws.token);
            // 双面板代理路由 — 返回原始HTML/JS/binary，不是JSON
            if (result && result._proxy) {
                const headers: Record<string, string> = {};
                // 从代理响应中提取安全头（已剥离X-Frame-Options等）
                if (result.headers) {
                    for (const [k, v] of Object.entries(result.headers as Record<string, string | string[]>)) {
                        if (k.toLowerCase() === 'transfer-encoding') continue; // 跳过chunked
                        headers[k] = Array.isArray(v) ? v.join(', ') : v;
                    }
                }
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

    ws.server.listen(ws.port, () => {
        updateStatusBar();
        vscode.window.showInformationMessage(`Dao server started on :${ws.port}`);
        registerInstance(ws.port);
    updateWorkspaceRegistry();
        ws.saveConnection();
        // 桥: 自动建桥 — 出站WebSocket绕过NAT
        if (cfg.autoBridge) {
            connectRelay(ws.port, ws.token);
        }
    });

    context.subscriptions.push({ dispose: () => stopServer() });
}

function stopServer() {
    stopRelay();
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

async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.length > 0) return content;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return '[timeout waiting for output]';
}

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
            const captureCmd = process.platform === 'win32'
                ? `${args.command} > "${tmpFile}" 2>&1`
                : `${args.command} > "${tmpFile}" 2>&1`;
            term.sendText(captureCmd);
            const output = await waitForFile(tmpFile, 30000);
            try { fs.unlinkSync(tmpFile); } catch {}
            setTimeout(() => term.dispose(), 1000);
            return { output };
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
        const needsProxy = relayHostname.includes('workers.dev') || relayHostname.includes('cloudflare');
        if (needsProxy) {
            createProxyTunnel(relayHostname).then((tlsSocket) => {
                if (tlsSocket) {
                    const socket = new WebSocket(wsUrl, { createConnection: () => tlsSocket });
                    setupRelayHandlers(socket, relayUrl, sessionId, port, token, onFail);
                } else {
                    onFail();
                }
            }).catch(() => onFail());
        } else {
            const socket = new WebSocket(wsUrl);
            setupRelayHandlers(socket, relayUrl, sessionId, port, token, onFail);
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
// 代理隧道 — 自动检测本地VPN代理，绕过DNS污染
// 道法自然: 用户有VPN(Clash/V2Ray)，自动利用，无为而无以为
// ═══════════════════════════════════════════════════════════

function detectProxyPort(): number {
    if (detectedProxyPort) return detectedProxyPort;
    const envProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || '';
    if (envProxy) {
        const m = envProxy.match(/127\.0\.0\.1:(\d+)/);
        if (m) { detectedProxyPort = parseInt(m[1]); return detectedProxyPort; }
    }
    try {
        const f = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf8'));
        if (f.proxyPort) { detectedProxyPort = f.proxyPort; return detectedProxyPort; }
    } catch {}
    for (const p of PROXY_PORTS) {
        try {
            const s = new net.Socket();
            s.connect(p, '127.0.0.1');
            s.destroy();
            detectedProxyPort = p;
            return p;
        } catch {}
    }
    return 0;
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
    if (route.startsWith('/devin-cloud')) return false; // 已有专门前缀分支
    if (route.startsWith('/assets/')) return true;
    if (route.startsWith('/api/')) {
        // dao 自有 /api 路由由 switch 精确处理; 其余皆属 app.devin.ai
        const daoApiPrefixes = ['/api/health', '/api/connection', '/api/workspace', '/api/exec',
            '/api/command', '/api/file', '/api/write', '/api/search', '/api/edit', '/api/ls',
            '/api/terminal', '/api/diagnostics', '/api/definitions', '/api/references', '/api/symbols',
            '/api/git/', '/api/agents', '/api/commands', '/api/tools', '/api/devin', '/api/workspaces'];
        return !daoApiPrefixes.some(p => route === p || route.startsWith(p + '/') || route === p.replace(/\/$/, ''));
    }
    // 帛书·「执天之行」官网根挂载: dao 自身 HTTP 仅占用 /api/*, 故其余所有根路径
    // (/、/org/*、/auth/*、/settings ...) 皆为官网 SPA 页面路由, 一律透传 app.devin.ai。
    // 如此 SPA 客户端路由器看到的是真实路径(/org/<slug>), 不再因 /devin-cloud 前缀而 404。
    if (route.startsWith('/relay') || route.startsWith('/connect')) return false;
    return true;
}

async function handleRouteInternal(route: string, url: URL, req: any, token: string): Promise<any> {
    // 认证检查（relay请求也需认证，devin-cloud代理有自己的认证）
    const needAuth = !route.startsWith('/api/health') && !route.startsWith('/devin-cloud/') && !isAppProxyPassthrough(route);
    if (needAuth && !checkAuth(req)) throw new Error('unauthorized');

    // 官网 SPA 根路径资源/接口 → 透传 app.devin.ai
    if (isAppProxyPassthrough(route)) {
        return await devinCloudProxyRoute('/devin-cloud' + route, url, req, 'devin');
    }

    switch (route) {
        case '/api/health': {
            return {
                status: 'ok', service: 'dao-vsix', version: '1.0.0',
                workspace: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [],
                activeEditor: vscode.window.activeTextEditor?.document.uri.fsPath || null,
                diagnostics_count: vscode.languages.getDiagnostics().length,
                port: ws.port, pid: process.pid,
                publicUrl: ws.publicUrl,
                relay: ws.relayConnected ? 'connected' : 'local',
                uptime: Math.floor((Date.now() - ws.startTime) / 1000),
                server_time: new Date().toISOString()
            };
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
            const captureCmd = process.platform === 'win32' ? `${cmd} > "${tmpFile}" 2>&1` : `${cmd} > "${tmpFile}" 2>&1`;
            term.sendText(captureCmd);
            const waitMs = Math.min(tmout || 20000, 60000);
            const output = await waitForFile(tmpFile, waitMs);
            try { fs.unlinkSync(tmpFile); } catch {}
            setTimeout(() => term.dispose(), 1000);
            return { status: 'completed', stdout: output, exitCode: 0, command: cmd };
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
            ws.devinQuota = q; ws.devinSaveConfig();
            return { ok: !!q, quota: q };
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
            const { name, body: kBody, triggerDescription, upsert } = JSON.parse(kb);
            if (!ws.devinAuth1 || !ws.devinOrgId) return { ok: false, error: 'not logged in' };
            if (upsert) return await devinUpsertKnowledge(ws.devinOrgId, name, kBody, triggerDescription, ws.devinAuth1);
            return await devinInjectKnowledge(ws.devinOrgId, name, kBody, triggerDescription, ws.devinAuth1);
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
        // ═══════════════════════════════════════════════════════════
        // 双面板 · 反向代理 — 帛书·四十一「反者道之动」
        // /devin-cloud/* → https://app.devin.ai/*
        // /devin-cloud-ws/* → https://windsurf.com/* (认证资源)
        // 剥离 X-Frame-Options / CSP frame-ancestors → iframe 可嵌入
        // 注入 Authorization 头 → 认证自动桥接
        // ═══════════════════════════════════════════════════════════
        default: {
            // 缺陷10修复: 长前缀必须先检查，否则 /devin-cloud-ws-register/ 会匹配 /devin-cloud-ws/
            if (route.startsWith('/devin-cloud-ws-register/')) {
                return await devinCloudProxyRoute(route, url, req, 'register');
            }
            if (route.startsWith('/devin-cloud-ws-cdn/')) {
                return await devinCloudProxyRoute(route, url, req, 'codeium');
            }
            if (route.startsWith('/devin-cloud-ws-ss/')) {
                return await devinCloudProxyRoute(route, url, req, 'self-serve');
            }
            if (route.startsWith('/devin-cloud-ws/')) {
                return await devinCloudProxyRoute(route, url, req, 'windsurf');
            }
            if (route.startsWith('/devin-cloud/')) {
                return await devinCloudProxyRoute(route, url, req, 'devin');
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
                    case 'devinRefreshQuota': {
                        if (ws.devinApiKey) { const q = await devinFetchQuota(ws.devinApiKey, ws.devinApiServerUrl); ws.devinQuota = q; ws.devinSaveConfig(); }
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
                                else vscode.window.showErrorMessage('Session create failed');
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
                        };
                        const pagePath = pagePaths[page] || '';
                        let targetUrl: string;
                        if (ws.port && ws.devinAuth1) {
                            // 已认证 + 服务器运行 → 走反向代理路由(自动注入Cookie)
                            targetUrl = `http://localhost:${ws.port}/devin-cloud${pagePath}`;
                        } else {
                            targetUrl = DEVIN_APP + pagePath;
                        }
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
                                else if (tab === 'integrations') { result = await devinCheckGitConnections(ws.devinOrgId, ws.devinAuth1); reply({ ok: true, data: result.ok ? result.connections : [] }); }
                                else reply({ ok: false, error: 'unknown tab' });
                            } catch (e: any) { reply({ ok: false, error: e.message }); }
                        } else {
                            const urls: Record<string, string> = { sessions: '/sessions', knowledge: '/knowledge', playbooks: '/playbooks', secrets: '/settings/secrets', integrations: '/settings/integrations' };
                            const targetUrl = DEVIN_APP + (urls[tab] || '');
                            try { vscode.commands.executeCommand('simpleBrowser.show', targetUrl); } catch { vscode.env.openExternal(vscode.Uri.parse(targetUrl)); }
                            reply({ type: 'tabData', tab, items: [], error: '已通过 Simple Browser 打开', fallbackProxy: false });
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
  ${ws.devinQuota ? (() => { const q = ws.devinQuota; const d = q.dailyQuotaRemainingPercent; const dc = d > 20 ? '#4ec9b0' : d > 5 ? '#e8c84a' : '#f44747'; return '<div class="row"><span class="lbl">Daily</span><span class="val" style="color:'+dc+'">'+d+'%</span></div>'; })() : ''}
</div>
`}
<div class="card">
  <div class="row"><span class="lbl">⚡ Server</span><span class="val ${ws.port ? 'ok' : 'err'}">${ws.port ? ':' + ws.port : 'off'}</span></div>
  <div class="row"><span class="lbl">☁️ Relay</span><span class="val ${ws.relayConnected ? 'ok' : 'err'}">${relayStatus}</span></div>
</div>
<button class="btn primary" onclick="cmd('openCloudPanel')">🤖 打开 Devin Cloud 全功能面板</button>
${loggedIn ? '<button class="btn" onclick="cmd(&#39;devinCloudPanel&#39;)" style="margin-top:4px;background:#0e639c">🌐 打开 Devin 官网</button>' : ''}
${loggedIn ? '<button class="btn" onclick="cmd(&#39;devinInject&#39;)" style="margin-top:4px">💉 一键注入</button>' : ''}
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

function getDaoCloudMiddlePanelHtml(st: any): string {
    const { loggedIn, email, orgName, orgId, hasWindsurfCreds, apiKeyType, tokenType, canUseApi, port, relay, relayUrl, hostname, injecting, bridge } = st;
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
.toast{position:fixed;bottom:20px;right:20px;padding:8px 16px;border-radius:6px;font-size:12px;z-index:200;animation:fi .2s}
.toast.hid{display:none}
.toast.ok{background:var(--success);color:#000}
.toast.err{background:var(--danger);color:#fff}
@keyframes fi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
</style></head>
<body>
<div class="app">
<nav class="sb">
<div class="ni active" data-tab="overview" onclick="sw('overview')" title="Overview">🏠</div>
<div class="ni" data-tab="sessions" onclick="sw('sessions')" title="Sessions">💬</div>
<div class="ni" data-tab="knowledge" onclick="sw('knowledge')" title="Knowledge">📚</div>
<div class="ni" data-tab="playbooks" onclick="sw('playbooks')" title="Playbooks">📋</div>
<div class="ni" data-tab="secrets" onclick="sw('secrets')" title="Secrets">🔑</div>
<div class="ni" data-tab="integrations" onclick="sw('integrations')" title="Integrations">🔗</div>
<div class="ni" data-tab="inject" onclick="sw('inject')" title="自动注入 Auto-Inject">💉</div>
<div class="sp"></div>
<div class="ni" onclick="cmd('refresh')" title="Refresh">⟳</div>
</nav>
<div class="mn">
<div class="hd">
<span class="t">Devin Cloud</span>
<span class="b ${loggedIn ? 'ok' : 'off'}" id="ab">${loggedIn ? '✓ ' + mpEsc(email.split('@')[0]) : '未连接'}</span>
<span class="b" id="ob" style="background:#2d5a8a${orgName ? '' : ';display:none'}">${mpEsc(orgName)}</span>
<span class="sp"></span>
<button class="hb" onclick="cmd('openBrowser')">🌐 官网</button>
<button class="hb" onclick="cmd('refresh')">⟳</button>
</div>
<div class="ct">
<div class="tv active" id="v-overview"></div>
<div class="tv" id="v-sessions"></div>
<div class="tv" id="v-knowledge"></div>
<div class="tv" id="v-playbooks"></div>
<div class="tv" id="v-secrets"></div>
<div class="tv" id="v-integrations"></div>
<div class="tv" id="v-inject"></div>
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
  inject:null,
  injectProfile:{enabled:false,autoCleanup:true,secrets:[],knowledge:[],playbooks:[],lastInjectedOrg:''},
  tab:'overview',
  data:{sessions:[],knowledge:[],playbooks:[],secrets:[],gitConnections:[]}
};
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function cmd(c,d){vscode.postMessage(Object.assign({command:c},d||{}))}
function sw(t){
  S.tab=t;
  document.querySelectorAll('.ni').forEach(n=>n.classList.toggle('active',n.dataset.tab===t));
  document.querySelectorAll('.tv').forEach(v=>v.classList.toggle('active',v.id==='v-'+t));
  rc();
  // 帛书·「反者道之动也」— 认证策略根本修复
  // cog_ API Key → Devin API完全可用 → 加载真实数据
  // devin-session-token$ → 仅Codeium API → 显示创建API Key引导
  // 自动注入模块: 无需 cog_ key, 直接拉 profile 配置 (账号无关意图)
  if(t==='inject'){ cmd('getInjectProfile'); return; }
  if(t!=='overview'&&S.auth.loggedIn){
    const v=document.getElementById('v-'+t);
    if(v&&!v.dataset.loaded){
      v.dataset.loaded='1';
      if(S.auth.canUseApi){
        // ★ 有cog_ key → 尝试API加载
        v.innerHTML='<div class="empty"><div class="ic">'+({sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗'}[t]||'🌐')+'</div><h3>'+{sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations'}[t]+'</h3><p style="margin:8px 0;color:var(--muted)">正在加载...</p></div>';
        cmd('loadTabData',{tab:t});
      } else {
        // ★ 无 auth1 (仅 session-token) → 底层自动获取凭证, 用户无需手动 API Key
        const tabNames={sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations'};
        const tabIcons={sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗'};
        v.innerHTML='<div class="empty"><div class="ic">'+(tabIcons[t]||'🌐')+'</div><h3>'+tabNames[t]+'</h3><p style="margin:8px 0;color:var(--muted);font-size:13px">正在从底层自动获取访问凭证…</p><p style="font-size:11px;color:var(--muted);max-width:360px;line-height:1.6;margin-bottom:12px">账号凭证将随 IDE 登录状态自动同步, 无需手动操作。若长时间未就绪, 可重试自动登录或手动切换账号。</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn primary" onclick="cmd(&#39;devinAutoAcquire&#39;)">🔄 重试自动获取</button><button class="btn ghost" onclick="cmd(&#39;devinManualLogin&#39;)">👤 手动登录其他账户</button></div></div>';
      }
    }
  }
}
function rc(){if(S.tab==='overview')rO()}
// 帛书·「为而弗恃」: API Key 全程底层自动获取, 面板永不出现手动输入 — 旧 submitCogKey* 已删
function rO(){
  const v=document.getElementById('v-overview');
  if(!S.auth.loggedIn){
    v.innerHTML='<div class="empty"><div class="ic">🤖</div><h3>Devin Cloud</h3><p style="margin:12px 0">登录以连接您的 Devin Cloud 账户</p><div class="br" style="justify-content:center"><button class="btn primary" onclick="cmd(&#39;devinLogin&#39;)">🔑 登录</button>'+(S.auth.hasWsCreds?'<button class="btn" style="background:#0e639c" onclick="cmd(&#39;devinWindsurfAutoLogin&#39;)">🌀 Windsurf 自动登录</button>':'')+'</div></div>';
    return;
  }
  let qh='';
  if(S.auth.quota){
    const q=S.auth.quota,plan=q.planName||'?',dp=q.dailyQuotaRemainingPercent,wp=q.weeklyQuotaRemainingPercent;
    const dc=dp>20?'var(--success)':dp>5?'var(--warn)':'var(--danger)';
    const wc=wp>20?'var(--success)':wp>5?'var(--warn)':'var(--danger)';
    qh='<div class="st">配额</div><div class="card"><div class="cr"><span class="l">Plan</span><span class="v">'+plan+'</span></div><div class="cr"><span class="l">Daily</span><span class="v" style="color:'+dc+'">'+(dp!=null?dp+'%':'—')+'</span></div><div class="qb"><div class="f" style="width:'+(dp||0)+'%;background:'+dc+'"></div></div><div class="cr"><span class="l">Weekly</span><span class="v" style="color:'+wc+'">'+(wp!=null?wp+'%':'—')+'</span></div><div class="qb"><div class="f" style="width:'+(wp||0)+'%;background:'+wc+'"></div></div>'+(q.availablePromptCredits!=null?'<div class="cr"><span class="l">Prompt Credits</span><span class="v">'+q.availablePromptCredits+'</span></div>':'')+(q.availableFlowCredits!=null?'<div class="cr"><span class="l">Flow Credits</span><span class="v">'+q.availableFlowCredits+'</span></div>':'')+'</div>';
  }
  let ih='';
  if(S.inject){
    const i=S.inject;
    ih='<div class="st">注入状态</div><div class="card"><div class="cr"><span class="l"><span class="tag secret">S</span> Secret</span><span class="v" style="color:'+(i.secret?'var(--success)':'var(--danger)')+'">'+(i.secret?'✓':'✗')+'</span></div><div class="cr"><span class="l"><span class="tag knowledge">K</span> Knowledge</span><span class="v" style="color:'+(i.knowledge?'var(--success)':'var(--danger)')+'">'+(i.knowledge?'✓':'✗')+'</span></div><div class="cr"><span class="l"><span class="tag playbook">P</span> Playbook</span><span class="v" style="color:'+(i.playbook?'var(--success)':'var(--danger)')+'">'+(i.playbook?'✓':'✗')+'</span></div><div class="cr"><span class="l"><span class="tag git">G</span> Git</span><span class="v" style="color:'+(i.git?'var(--success)':'var(--danger)')+'">'+(i.git?'✓':'✗')+'</span></div></div>';
  }
  v.innerHTML='<div class="st">账户</div><div class="card"><div class="cr"><span class="l">邮箱</span><span class="v">'+esc(S.auth.email)+'</span></div><div class="cr"><span class="l">组织</span><span class="v">'+esc(S.auth.orgName)+'</span></div>'+(S.auth.orgId?'<div class="cr"><span class="l">Org ID</span><span class="v" style="font-size:10px">'+esc(S.auth.orgId)+'</span></div>':'')+'<div class="cr"><span class="l">Token</span><span class="v"><span class="tag devin">'+esc(S.auth.tokenType||S.auth.apiKeyType||'?')+'</span></span></div><div class="cr"><span class="l">API能力</span><span class="v">'+(S.auth.canUseApi?'<span style="color:var(--success)">✓ 完整API访问</span>':'<span style="color:var(--warn)">⚠ 仅Codeium API</span>')+'</div></div>'+qh+ih+'<div class="st">服务器</div><div class="card"><div class="cr"><span class="l">端口</span><span class="v">'+(S.server.port||'未启动')+'</span></div><div class="cr"><span class="l">Relay</span><span class="v" style="color:'+(S.server.relay?'var(--success)':'var(--muted)')+'">'+(S.server.relay?'✓ '+esc(S.server.relayUrl):'✗ 本地')+'</span></div></div><div class="st">快捷操作</div><div class="br">'+(S.auth.canUseApi?'<button class="btn primary" onclick="cmd(&#39;devinInject&#39;)">💉 一键注入</button>':'')+'<button class="btn" onclick="cmd(&#39;devinRefreshQuota&#39;)">📊 刷新配额</button><button class="btn" style="background:#0e639c" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;home&#39;})">🌐 打开 Devin Cloud</button>'+'<button class="btn danger" onclick="cmd(&#39;devinLogout&#39;)">登出</button></div><div class="st">Devin Cloud 页面</div><div class="br"><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;sessions&#39;})">💬 Sessions</button><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;knowledge&#39;})">📚 Knowledge</button><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;secrets&#39;})">🔑 Secrets</button><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;integrations&#39;})">🔗 Integrations</button></div>';
  try{v.innerHTML+=rBridge();}catch(e){}
}
function rBridge(){
  var b=S.bridge;var head='<div class="st">内网穿透 · DAO Bridge</div>';
  if(!b){return head+'<div class="card"><div class="cr"><span class="l">状态</span><span class="v" style="color:var(--muted)">未运行 · 安装/启动 dao-bridge 插件后自动打通当前工作区</span></div></div>';}
  var on=!!b.url;
  var rows='<div class="cr"><span class="l">状态</span><span class="v" style="color:'+(on?'var(--success)':'var(--warn)')+'">'+(on?'✓ 已打通':'隧道离线')+'</span></div>';
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
window.addEventListener('message',e=>{const d=e.data;if(!d)return;if(d.type==='init'){Object.assign(S.auth,d.auth||{});Object.assign(S.server,d.server||{});S.inject=d.inject||S.inject;if(d.bridge!==undefined)S.bridge=d.bridge;uhd();usb();rc()}else if(d.type==='tabData'){S.data[d.tab]=d.items||[];rT(d.tab,d.items||[],d.error,d.fallbackProxy)}else if(d.type==='sessionDetail'){rSD(d)}else if(d.type==='injectProfile'){S.injectProfile=d.profile||S.injectProfile;rInject()}else if(d.type==='actionResult'){toast(d.command+' '+(d.ok?'✓':'✗'),d.ok);if(d.ok&&S.tab!=='inject')rc()}else if(d.type==='error'){toast('Error: '+d.msg,false)}});
function rT(tab,items,err,fallbackProxy){
  const v=document.getElementById('v-'+tab);if(!v)return;
  // 帛书·「反者道之动也」— 认证策略根本修复
  if(fallbackProxy||err){
    const tabNames={sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations'};
    const tabIcons={sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗'};
    if(err==='需要 cog_ API Key'||fallbackProxy){
      // ★ 需要cog_ key — 显示创建引导
      v.innerHTML='<div class="empty"><div class="ic">'+(tabIcons[tab]||'🌐')+'</div><h3>'+tabNames[tab]+'</h3><p style="margin:8px 0;color:var(--muted);font-size:13px">正在从底层自动获取访问凭证…</p><p style="font-size:11px;color:var(--muted);max-width:360px;line-height:1.6">账号凭证随 IDE 登录状态自动同步, 无需手动 API Key。</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn primary" onclick="cmd(&#39;devinAutoAcquire&#39;)">🔄 重试自动获取</button><button class="btn ghost" onclick="cmd(&#39;devinManualLogin&#39;)">👤 手动登录其他账户</button></div></div>';
    } else {
      // 其他错误
      v.innerHTML='<div class="empty"><div class="ic">'+(tabIcons[tab]||'🌐')+'</div><h3>'+tabNames[tab]+'</h3><p style="margin:8px 0;color:var(--danger);font-size:12px">Error: '+esc(err||'Unknown')+'</p><div class="br" style="justify-content:center;margin-top:8px"><button class="btn" onclick="cmd(&#39;loadTabData&#39;,{tab:&#39;'+tab+'&#39;})">⟳ 重试</button><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;'+tab+'&#39;})">🌐 在 Devin Cloud 中打开</button></div></div>';
    }
    return;
  }
  if(!items.length){v.innerHTML='<div class="empty"><div class="ic">'+({sessions:'💬',knowledge:'📚',playbooks:'📋',secrets:'🔑',integrations:'🔗'}[tab]||'🌐')+'</div><h3>'+{sessions:'Sessions',knowledge:'Knowledge',playbooks:'Playbooks',secrets:'Secrets',integrations:'Integrations'}[tab]+'</h3><p style="margin:8px 0;color:var(--muted)">No items found</p><div class="br" style="justify-content:center"><button class="btn ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;'+tab+'&#39;})">🌐 Open in Devin</button></div></div>';return}
  // ★ v1.0.1 · 各tab添加新建按钮 · 帛书·「道生一·一生二」
  const createBtns={sessions:'<button class="btn sm primary" onclick="cmd(&#39;devinCreateSession&#39;)">+ Session</button>',knowledge:'<button class="btn sm primary" onclick="cmd(&#39;devinCreateKnowledge&#39;)">+ Knowledge</button>',playbooks:'<button class="btn sm primary" onclick="cmd(&#39;devinCreatePlaybook&#39;)">+ Playbook</button>',secrets:'<button class="btn sm primary" onclick="cmd(&#39;devinCreateSecret&#39;)">+ Secret</button>',integrations:'<button class="btn sm primary" onclick="cmd(&#39;devinConnectGit&#39;)">+ GitHub PAT</button>'};
  let h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="color:var(--muted);font-size:11px">'+items.length+' items</span><div class="br">'+(createBtns[tab]||'')+'<button class="btn sm" onclick="cmd(&#39;loadTabData&#39;,{tab:&#39;'+tab+'&#39;})">⟳</button><button class="btn sm ghost" onclick="cmd(&#39;openDevinPage&#39;,{page:&#39;'+tab+'&#39;})">🌐</button></div></div>';
  if(tab==='sessions'){
    items.forEach(s=>{
      const id=s.devin_id||s.id||'';const title=s.title||s.name||'Untitled';const status=s.status||'';const created=s.created_at||'';
      const sc=status==='running'?'var(--success)':status==='completed'?'var(--muted)':status==='failed'?'var(--danger)':'var(--warn)';
      h+='<div class="card" style="cursor:pointer" onclick="cmd(&#39;loadSessionDetail&#39;,{sessionId:&#39;'+esc(id)+'&#39;})"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(title)+'</span><span class="v" style="color:'+sc+';font-size:10px">'+esc(status)+'</span></div><div class="cr"><span class="l" style="font-size:10px">'+esc(id.substring(0,12))+'...</span><span class="l" style="font-size:10px">'+esc(created?new Date(created).toLocaleString():'')+'</span></div></div>';
    });
  }else if(tab==='knowledge'){
    items.forEach(k=>{
      const id=k.id||'';const name=k.name||'Untitled';const trigger=k.trigger_description||k.trigger||'';const enabled=k.is_enabled!==false;
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(name)+'</span><span class="v"><span class="tag knowledge">K</span>'+(enabled?'<span style="color:var(--success);margin-left:4px">✓</span>':'<span style="color:var(--danger);margin-left:4px">✗</span>')+'</span></div>'+(trigger?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(trigger.substring(0,100))+'</div>':'')+'<div class="br" style="margin-top:4px"><button class="btn sm danger" onclick="cmd(&#39;devinDeleteKnowledge&#39;,{id:&#39;'+esc(String(id))+'&#39;})">🗑</button></div></div>';
    });
  }else if(tab==='playbooks'){
    items.forEach(p=>{
      const id=p.id||'';const title=p.title||p.name||'Untitled';const status=p.status||'';
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(title)+'</span><span class="v"><span class="tag playbook">P</span></span></div>'+(status?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(status)+'</div>':'')+'<div class="br" style="margin-top:4px"><button class="btn sm danger" onclick="cmd(&#39;devinDeletePlaybook&#39;,{id:&#39;'+esc(String(id))+'&#39;})">🗑</button></div></div>';
    });
  }else if(tab==='secrets'){
    items.forEach(s=>{
      const name=s.name||s.key||'Unnamed';const id=s.id||'';
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(name)+'</span><span class="v"><span class="tag secret">S</span></span></div><div class="br" style="margin-top:4px"><button class="btn sm danger" onclick="cmd(&#39;devinDeleteSecret&#39;,{name:&#39;'+esc(name)+'&#39;})">🗑</button></div></div>';
    });
  }else if(tab==='integrations'){
    items.forEach(c=>{
      const id=c.id||c.connection_id||'';const provider=c.provider||c.name||'GitHub';const login=c.login||c.username||'';
      h+='<div class="card"><div class="cr"><span class="l" style="font-weight:500;color:var(--fg)">'+esc(provider)+'</span><span class="v"><span class="tag git">G</span></span></div>'+(login?'<div style="font-size:10px;color:var(--muted);margin-top:4px">'+esc(login)+'</div>':'')+'<div class="br" style="margin-top:4px"><button class="btn sm danger" onclick="cmd(&#39;devinDisconnectGit&#39;,{connectionId:&#39;'+esc(String(id))+'&#39;})">🗑</button></div></div>';
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
function ipSave(){cmd('setInjectProfile',{enabled:S.injectProfile.enabled,autoCleanup:S.injectProfile.autoCleanup,secrets:S.injectProfile.secrets,knowledge:S.injectProfile.knowledge,playbooks:S.injectProfile.playbooks})}
function ipToggle(field){S.injectProfile[field]=!S.injectProfile[field];ipSave();rInject()}
function ipRemove(kind,idx){S.injectProfile[kind].splice(idx,1);ipSave();rInject()}
function ipAddSecret(){sm('添加 Secret','<input id="m1" placeholder="名称 KEY" style="width:100%;margin:4px 0"><input id="m2" placeholder="值 value" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim(),val=document.getElementById('m2').value;if(!n)return false;S.injectProfile.secrets.push({name:n,value:val});ipSave();rInject()})}
function ipAddKnowledge(){sm('添加 Knowledge','<input id="m1" placeholder="名称" style="width:100%;margin:4px 0"><textarea id="m2" placeholder="正文 body" style="width:100%;height:80px;margin:4px 0"></textarea><input id="m3" placeholder="触发 trigger (默认 Always)" style="width:100%;margin:4px 0">',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.knowledge.push({name:n,body:document.getElementById('m2').value,trigger:document.getElementById('m3').value.trim()||'Always'});ipSave();rInject()})}
function ipAddPlaybook(){sm('添加 Playbook','<input id="m1" placeholder="标题 title" style="width:100%;margin:4px 0"><textarea id="m2" placeholder="正文 body" style="width:100%;height:80px;margin:4px 0"></textarea>',function(){const n=document.getElementById('m1').value.trim();if(!n)return false;S.injectProfile.playbooks.push({title:n,body:document.getElementById('m2').value});ipSave();rInject()})}
function rInject(){
  const v=document.getElementById('v-inject');if(!v)return;
  const p=S.injectProfile||{enabled:false,autoCleanup:true,secrets:[],knowledge:[],playbooks:[]};
  const tgl=(on,fn)=>'<span onclick="'+fn+'" style="cursor:pointer;display:inline-block;width:40px;height:20px;border-radius:10px;background:'+(on?'var(--success)':'var(--muted)')+';position:relative;vertical-align:middle"><span style="position:absolute;top:2px;left:'+(on?'22px':'2px')+';width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s"></span></span>';
  let h='<div class="st">自动注入自循环 · 无为而无不为</div>';
  h+='<p style="font-size:11px;color:var(--muted);line-height:1.6;margin:4px 0 10px">初始配置一次, 此后账号随 IDE 登录自动切换时, 系统按此清单自动注入新账号, 并(默认)清理旧账号的同名注入。</p>';
  h+='<div class="card"><div class="cr"><span class="l">启用自动注入</span><span class="v">'+tgl(p.enabled,'ipToggle(&#39;enabled&#39;)')+'</span></div><div class="cr"><span class="l">切账号时清理旧账号</span><span class="v">'+tgl(p.autoCleanup,'ipToggle(&#39;autoCleanup&#39;)')+'</span></div>'+(p.lastInjectedOrg?'<div class="cr"><span class="l">上次注入 org</span><span class="v" style="font-size:10px">'+esc(p.lastInjectedOrg)+'</span></div>':'')+'</div>';
  const listSec=(title,kind,items,labelFn,addFn)=>{let s='<div class="st">'+title+' ('+items.length+')<button class="btn sm primary" style="float:right" onclick="'+addFn+'">+ 添加</button></div>';if(items.length){s+='<div class="card">';items.forEach((it,i)=>{s+='<div class="cr"><span class="l" style="font-size:12px">'+esc(labelFn(it))+'</span><span class="v"><button class="btn sm danger" onclick="ipRemove(&#39;'+kind+'&#39;,'+i+')">删</button></span></div>'});s+='</div>'}else{s+='<p style="font-size:11px;color:var(--muted);margin:4px 0 8px">（空）</p>'}return s};
  h+=listSec('🔑 Secrets','secrets',p.secrets,it=>it.name,'ipAddSecret()');
  h+=listSec('📚 Knowledge','knowledge',p.knowledge,it=>it.name,'ipAddKnowledge()');
  h+=listSec('📋 Playbooks','playbooks',p.playbooks,it=>it.title,'ipAddPlaybook()');
  h+='<div class="br" style="margin-top:10px"><button class="btn" onclick="cmd(&#39;importCurrentToInjectProfile&#39;)">⬇️ 导入当前账号现有项</button>'+(p.enabled?'<button class="btn primary" onclick="cmd(&#39;setInjectProfile&#39;,{enabled:true})">▶️ 立即应用到当前账号</button>':'')+'</div>';
  v.innerHTML=h;
}
usb();rc();
</script>
</body></html>`;
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
    daoCloudMiddlePanel.webview.onDidReceiveMessage(async (msg) => {
        await handleMiddlePanelMessage(msg, context);
    }, undefined, context.subscriptions);
    daoCloudMiddlePanel.onDidDispose(() => {
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
    };
}

function refreshDaoCloudMiddlePanel() {
    if (!daoCloudMiddlePanel) return;
    const data: any = { type: 'init' };
    data.auth = {
        loggedIn: !!(ws.devinAuth1 || ws.devinApiKey),
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
    data.server = {
        port: ws.port,
        relay: ws.relayConnected,
        relayUrl: ws.publicUrl || '',
        hostname: os.hostname(),
    };
    data.bridge = readBridgeConn();
    // Inject state
    try {
        const s = JSON.parse(fs.readFileSync(ws.injectStateFile, 'utf8'));
        data.inject = { secret: s.secret, knowledge: s.knowledge, playbook: s.playbook, git: s.git, timestamp: s.timestamp };
    } catch { data.inject = null; }
    daoCloudMiddlePanel.webview.postMessage(data);
}

async function handleMiddlePanelMessage(msg: any, context: vscode.ExtensionContext) {
    const reply = (d: any) => daoCloudMiddlePanel?.webview.postMessage(d);
    const refreshReply = (d: any) => { refreshDaoCloudMiddlePanel(); reply(d); };
    // Auth gate — allow these commands without login
    const noAuthNeeded = ['devinLogin', 'devinWindsurfAutoLogin', 'refresh', 'startServer', 'stopServer', 'regenerateToken', 'openBrowser', 'openDevinPage', 'copy', 'copyBridgeUrl', 'openBridgeMd'];
    if (!ws.devinAuth1 && !noAuthNeeded.includes(msg.command)) {
        reply({ type: 'error', msg: 'Not logged in' });
        return;
    }
    try {
        switch (msg.command) {
            case 'copyBridgeUrl': {
                const c = readBridgeConn();
                await vscode.env.clipboard.writeText((c && c.url) || '');
                reply({ type: 'actionResult', command: 'copyBridgeUrl', ok: !!(c && c.url) });
                break;
            }
            case 'openBridgeMd': {
                try {
                    const p = path.join(os.homedir(), '.dao', 'bridge', 'workspace.md');
                    const doc = await vscode.workspace.openTextDocument(p);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                    reply({ type: 'actionResult', command: 'openBridgeMd', ok: true });
                } catch (e) { reply({ type: 'actionResult', command: 'openBridgeMd', ok: false }); }
                break;
            }
            case 'loadTabData': {
                // 帛书·「反者道之动也」— 认证策略根本修复
                // cog_ API Key → Devin API完全可用 → 加载真实数据
                // devin-session-token$ → 仅Codeium API → 需要创建cog_ key
                const tab = msg.tab as string;
                const canApi = devinCanUseApi();
                if (canApi) {
                    // ★ 有cog_ API Key — 尝试API调用加载真实数据
                    try {
                        let result: any = { ok: false };
                        if (tab === 'sessions') {
                            result = await devinListSessions(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.sessions || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败: ' + JSON.stringify(result).substring(0, 100) });
                        } else if (tab === 'knowledge') {
                            result = await devinListKnowledge(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.learnings || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'playbooks') {
                            result = await devinListPlaybooks(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.playbooks || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'secrets') {
                            result = await devinListSecrets(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.secrets || [] });
                            else reply({ type: 'tabData', tab, items: [], error: 'API调用失败' });
                        } else if (tab === 'integrations') {
                            result = await devinCheckGitConnections(ws.devinOrgId, ws.devinAuth1);
                            if (result.ok) reply({ type: 'tabData', tab, items: result.connections || [] });
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
                    const sessionUrl = DEVIN_APP + '/sessions/' + sessionId;
                    try { vscode.commands.executeCommand('simpleBrowser.show', sessionUrl); }
                    catch { vscode.env.openExternal(vscode.Uri.parse(sessionUrl)); }
                    reply({ type: 'sessionDetail', ok: true, session: { devin_id: sessionId }, messages: [] });
                }
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
                reply({ type: 'injectProfile', profile: { enabled: p.enabled, autoCleanup: p.autoCleanup, secrets: p.secrets, knowledge: p.knowledge, playbooks: p.playbooks, lastInjectedOrg: p.lastInjectedOrg } });
                break;
            }
            case 'setInjectProfile': {
                // 保存 profile (enabled/autoCleanup/items) — 守柔: 仅覆盖传入字段
                const cur = loadInjectProfile();
                const np: InjectProfile = {
                    enabled: typeof msg.enabled === 'boolean' ? msg.enabled : cur.enabled,
                    autoCleanup: typeof msg.autoCleanup === 'boolean' ? msg.autoCleanup : cur.autoCleanup,
                    secrets: Array.isArray(msg.secrets) ? msg.secrets : cur.secrets,
                    knowledge: Array.isArray(msg.knowledge) ? msg.knowledge : cur.knowledge,
                    playbooks: Array.isArray(msg.playbooks) ? msg.playbooks : cur.playbooks,
                    lastInjectedOrg: cur.lastInjectedOrg,
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
            case 'devinLogout': {
                ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinOrgName = ''; ws.devinOrgSlug = '';
                ws.devinEmail = ''; ws.devinSessionToken = ''; ws.devinApiKey = ''; ws.devinApiServerUrl = '';
                ws.devinAccountId = ''; ws.devinQuota = null; ws.devinSaveConfig();
                sidebarCloudPanel?.refresh(); // 同步刷新侧边栏
                refreshReply({ type: 'actionResult', command: 'devinLogout', ok: true });
                break;
            }
            case 'devinInject': {
                const ok = await devinFullInject();
                sidebarCloudPanel?.refresh(); // 同步刷新侧边栏
                refreshReply({ type: 'actionResult', command: 'devinInject', ok });
                break;
            }
            case 'devinRefreshQuota': {
                // 优先用API Key，其次用auth1作为Bearer token
                const quotaKey = ws.devinApiKey || ws.devinAuth1;
                if (quotaKey) { const q = await devinFetchQuota(quotaKey, ws.devinApiServerUrl); ws.devinQuota = q; ws.devinSaveConfig(); }
                sidebarCloudPanel?.refresh();
                refreshReply({ type: 'actionResult', command: 'devinRefreshQuota', ok: !!ws.devinQuota });
                break;
            }
            case 'devinCreateSession': {
                vscode.window.showInputBox({ prompt: 'Devin Session Message', placeHolder: 'What would you like Devin to do?' }).then(async message => {
                    if (!message) return;
                    const r = await devinCreateSession(ws.devinOrgId, message, ws.devinAuth1);
                    if (r.ok) vscode.window.showInformationMessage('Session created: ' + (r.devinId || ''));
                    else vscode.window.showErrorMessage('Session create failed');
                    refreshReply({ type: 'actionResult', command: 'devinCreateSession', ok: r.ok });
                });
                break;
            }
            case 'devinDownloadSession': {
                // 帛书·「天下之至柔驰骋于天下之致坚」— simpleBrowser共享Electron session
                // API不可用 → 在simpleBrowser中打开session页面
                if (msg.sessionId) {
                    const sessionUrl = DEVIN_APP + '/sessions/' + msg.sessionId;
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
                if (r.ok) vscode.window.showInformationMessage('Knowledge created: ' + name);
                refreshReply({ type: 'actionResult', command: 'devinCreateKnowledge', ok: r.ok });
                break;
            }
            case 'devinCreatePlaybook': {
                const title = await vscode.window.showInputBox({ prompt: 'Playbook Title', placeHolder: 'My Playbook' });
                if (!title) break;
                const body = await vscode.window.showInputBox({ prompt: 'Playbook Body (markdown)', placeHolder: '## Steps\n1. ...' });
                if (!body) break;
                const r = await devinInjectPlaybook(ws.devinOrgId, title, body, ws.devinAuth1);
                if (r.ok) vscode.window.showInformationMessage('Playbook created: ' + title);
                refreshReply({ type: 'actionResult', command: 'devinCreatePlaybook', ok: r.ok });
                break;
            }
            case 'devinCreateSecret': {
                const name = await vscode.window.showInputBox({ prompt: 'Secret Name', placeHolder: 'MY_SECRET_KEY' });
                if (!name) break;
                const value = await vscode.window.showInputBox({ prompt: 'Secret Value', password: true });
                if (!value) break;
                const r = await devinUpsertSecret(ws.devinOrgId, name, value, ws.devinAuth1);
                if (r.ok) vscode.window.showInformationMessage('Secret created: ' + name);
                refreshReply({ type: 'actionResult', command: 'devinCreateSecret', ok: r.ok });
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
                // 帛书·「天下之至柔驰骋于天下之致坚」— simpleBrowser共享Electron session
                // 直接用simpleBrowser打开app.devin.ai — 自动携带Auth0 Cookie
                try { vscode.commands.executeCommand('simpleBrowser.show', DEVIN_APP); }
                catch { vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP)); }
                break;
            }
            case 'openDevinPage': {
                // 帛书·「天下之至柔驰骋于天下之致坚」— simpleBrowser共享Electron session
                // 直接打开 app.devin.ai — simpleBrowser 自动携带 Electron 的 Auth0 Cookie
                // 不再通过反向代理（代理注入的 devin-session-token$ Cookie 无效）
                const page = msg.page || 'home';
                const urls: Record<string, string> = {
                    home: DEVIN_APP, sessions: DEVIN_APP + '/sessions',
                    knowledge: DEVIN_APP + '/knowledge', playbooks: DEVIN_APP + '/playbooks',
                    secrets: DEVIN_APP + '/settings/secrets', integrations: DEVIN_APP + '/settings/integrations',
                };
                const targetUrl = urls[page] || DEVIN_APP;
                try { vscode.commands.executeCommand('simpleBrowser.show', targetUrl); }
                catch { vscode.env.openExternal(vscode.Uri.parse(targetUrl)); }
                break;
            }
            case 'refresh': {
                refreshDaoCloudMiddlePanel();
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
const DEVIN_TOKEN_PREFIX = 'devin-session-token$';
const DEVIN_WSS_BASE = 'wss://app.devin.ai/api/acp/live';
const DEVIN_URL_LOGIN = DEVIN_WINDSURF + '/_devin-auth/password/login';
const DEVIN_URL_POSTAUTH = DEVIN_WINDSURF + '/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const DEVIN_URL_DEVIN_POST_AUTH = DEVIN_APP + '/api/users/post-auth';
const DEVIN_URL_REGISTER = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';
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

function devinJsonPost(targetUrl: string, headers: any, body: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
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

function devinJsonGet(targetUrl: string, headers: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const needsProxy = u.hostname === 'app.devin.ai' || u.hostname.endsWith('windsurf.com');
        const makeRequest = (hostname: string, port: number, path: string, h: any) => {
            const mod: any = hostname === '127.0.0.1' ? http : https;
            const req = mod.request({ hostname, port, path, method: 'GET', headers: h, timeout: timeoutMs || 15000, rejectUnauthorized: false }, (res: any) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { resolve({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
            req.end();
        };
        const reqHeaders = Object.assign({ 'Accept': 'application/json', 'User-Agent': DEVIN_UA }, headers || {});
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
// 五步链 · 帛书·四十二「道生一·一生二·二生三·三生万物」
// Step1: email+password → auth1+userId
// Step2: auth1 → sessionToken+accountId+primaryOrgId
// Step3: auth1 → orgId+orgName+orgSlug
// Step4: sessionToken → apiKey+apiServerUrl
// Step5: apiKey → quota (planName, daily%, weekly%)
// ═══════════════════════════════════════════════════════════

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
// 来源(优先级): VS Code 配置 dao.devinAccounts > ~/.dao/accounts.json > ~/.dao/accounts.txt
// ═══════════════════════════════════════════════════════════
interface PoolAccount { email: string; password: string }
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
    // 来源2: ~/.dao/accounts.json  ({accounts:[{email,password}]} 或 直接数组)
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            const arr = Array.isArray(j) ? j : (Array.isArray(j.accounts) ? j.accounts : []);
            for (const a of arr) { if (a && a.email) add(a.email, a.password); }
        }
    } catch { /* 守柔 */ }
    // 来源3: ~/.dao/accounts.txt  (email:password 每行一条)
    try {
        if (fs.existsSync(ACCOUNTS_TXT)) {
            for (const line of fs.readFileSync(ACCOUNTS_TXT, 'utf8').split(/\r?\n/)) {
                const m = line.match(/^\s*([^\s:]+@[^\s:]+)\s*[:：]\s*(.+?)\s*$/);
                if (m) add(m[1], m[2]);
            }
        }
    } catch { /* 守柔 */ }
    _accountPoolCache = pool;
    _accountPoolReadAt = Date.now();
    return pool;
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

// 守柔 · 保留用户操作空间 — 账号同步 / 官网登录 的「自动 | 手动」模式
function getAccountSyncMode(): 'auto' | 'manual' {
    try { return vscode.workspace.getConfiguration('dao').get<string>('accountSyncMode', 'auto') === 'manual' ? 'manual' : 'auto'; } catch { return 'auto'; }
}
function getWebsiteLoginMode(): 'auto' | 'manual' {
    try { return vscode.workspace.getConfiguration('dao').get<string>('websiteLoginMode', 'auto') === 'manual' ? 'manual' : 'auto'; } catch { return 'auto'; }
}
// 自动注入自循环: 切账号时是否自动清理旧 org 注入 (默认 true, 用户可关)
function getInjectAutoCleanup(): boolean {
    try { return vscode.workspace.getConfiguration('dao').get<boolean>('injectAutoCleanup', true) !== false; } catch { return true; }
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

    // 路径A (最快·自循环): 按邮箱持久化的真 auth1 命中 → 切回旧账号即刻复用, 无需重登
    if (currentIdeEmail) {
        try {
            const saved = loadAccountAuth(currentIdeEmail);
            if (saved && saved.auth1 && saved.orgId) {
                ws.devinAuth1 = saved.auth1; ws.devinOrgId = saved.orgId;
                ws.devinOrgName = saved.orgName || ''; ws.devinOrgSlug = saved.orgSlug || '';
                ws.devinUserId = saved.userId || ''; ws.devinAccountId = saved.accountId || '';
                ws.devinApiKey = saved.apiKey || ''; ws.devinApiServerUrl = saved.apiServerUrl || '';
                ws.devinEmail = currentIdeEmail;
                const quota = await devinFetchQuota(ws.devinApiKey || ws.devinAuth1);
                if (quota) {
                    ws.devinQuota = quota; ws.devinSaveConfig();
                    if (!(ws.devinApiKey || '').startsWith('cog_')) { try { await devinEnsureCogApiKey(ws.devinOrgId, ws.devinAuth1); } catch {} }
                    return true;
                }
                // 该邮箱的 auth1 已失效 → 清除, 继续走登录换新
                ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinApiKey = '';
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
            if (quota) {
                ws.devinQuota = quota;
                if (ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$')) {
                    saveAccountAuth(ws.devinEmail);
                    if (!(ws.devinApiKey || '').startsWith('cog_')) { try { await devinEnsureCogApiKey(ws.devinOrgId, ws.devinAuth1); } catch {} }
                }
                return true;
            }
            // Token expired → 清除，尝试其他路径
            ws.devinAuth1 = ''; ws.devinOrgId = ''; ws.devinSessionToken = ''; ws.devinApiKey = '';
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
                        await devinFullInject();
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
    if (!apiKey) return null;
    const tries: string[] = [];
    if (apiServerUrl) tries.push(apiServerUrl.replace(/\/+$/, '') + '/exa.seat_management_pb.SeatManagementService/GetUserStatus');
    for (const u of DEVIN_URL_GET_USER_STATUS) { if (!tries.includes(u)) tries.push(u); }
    const metadata = { ideName: 'windsurf', ideVersion: '1.99.0', extensionName: 'windsurf', extensionVersion: '1.99.0', apiKey, sessionId: crypto.randomUUID(), requestId: '1', locale: 'en', os: 'windows' };
    for (const url of tries) {
        try {
            const r = await devinJsonPost(url, { 'Connect-Protocol-Version': '1', 'X-Api-Key': apiKey }, { metadata }, 8000);
            if (r.status >= 200 && r.status < 300 && r.json) return devinParsePlanStatus(r.json);
            if (r.status === 401 || r.status === 400) break;
        } catch {}
    }
    // Fallback: Devin billing API
    if (ws.devinAuth1 && ws.devinOrgId) {
        try {
            const bareOrgId = ws.devinOrgId.replace(/^org-/, '');
            const br = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/billing/status', { Authorization: 'Bearer ' + ws.devinAuth1 });
            if (br.status === 200 && br.json) {
                const hasFunds = typeof br.json.overage_credits === 'number' && br.json.overage_credits < 0 && !br.json.billing_error;
                return { planName: 'Trial', dailyQuotaRemainingPercent: hasFunds ? 100 : 0, weeklyQuotaRemainingPercent: hasFunds ? 100 : 0, overageActive: hasFunds, overageDollars: hasFunds ? Math.abs(br.json.overage_credits) : 0, _source: 'devin_billing' };
            }
        } catch {}
    }
    return null;
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

async function devinListSecrets(orgId: string, auth1: string): Promise<{ ok: boolean; secrets?: any[] }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/secrets', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; const items = Array.isArray(j) ? j : (Array.isArray(j.secrets) ? j.secrets : []); return { ok: true, secrets: items }; }
    return { ok: false };
}

async function devinListKnowledge(orgId: string, auth1: string): Promise<{ ok: boolean; learnings?: any[] }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/learning/all', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; return { ok: true, learnings: Array.isArray(j.learnings) ? j.learnings : (Array.isArray(j) ? j : []) }; }
    return { ok: false };
}

async function devinListPlaybooks(orgId: string, auth1: string): Promise<{ ok: boolean; playbooks?: any[] }> {
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonGet(DEVIN_APP + '/api/org-' + bareOrgId + '/playbooks', { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    if (r.status === 200) { const j = r.json || {}; const items = Array.isArray(j) ? j : (Array.isArray(j.playbooks) ? j.playbooks : []); return { ok: true, playbooks: items }; }
    return { ok: false };
}

// ═══════════════════════════════════════════════════════════
// CRUD · Delete — 帛书·三十六「将欲拾之·必故张之」
// 先删后建 = 去芜存菁 = 更新stale URL
// ═══════════════════════════════════════════════════════════

function devinJsonDelete(targetUrl: string, headers: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const needsProxy = u.hostname === 'app.devin.ai' || u.hostname.endsWith('windsurf.com');
        const makeDirectRequest = (hostname: string, port: number, reqPath: string, h: any) => {
            const req = https.request({ hostname, port, path: reqPath, method: 'DELETE', headers: h, timeout: timeoutMs || 15000, rejectUnauthorized: false }, (res) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { resolve({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
            req.end();
        };
        const makeProxyRequest = (proxyPort: number, fullUrl: string, h: any) => {
            // 代理隧道: http.request → 127.0.0.1 HTTP代理 (不是TLS!)
            const req = http.request({ hostname: '127.0.0.1', port: proxyPort, path: fullUrl, method: 'DELETE', headers: h, timeout: timeoutMs || 15000 }, (res) => {
                let d = '';
                res.on('data', (c: Buffer) => d += c.toString());
                res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d), text: d }); } catch { resolve({ status: res.statusCode, json: null, text: d }); } });
            });
            req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
            req.end();
        };
        const reqHeaders = Object.assign({ Accept: 'application/json', 'User-Agent': DEVIN_UA }, headers || {});
        if (needsProxy && detectedProxyPort) {
            makeProxyRequest(detectedProxyPort, targetUrl, Object.assign({}, reqHeaders, { Host: u.hostname }));
        } else {
            makeDirectRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, reqHeaders);
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
    const bareOrgId = orgId.replace(/^org-/, '');
    const r = await devinJsonDelete(DEVIN_APP + '/api/org-' + bareOrgId + '/playbooks/' + id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204 || r.status === 404 };
}


async function devinDeleteSecret(orgId: string, name: string, auth1: string): Promise<{ ok: boolean }> {
    const list = await devinListSecrets(orgId, auth1);
    if (list.ok && list.secrets) {
        for (const s of list.secrets) {
            if (s.name === name && s.id) {
                const bareOrgId = orgId.replace(/^org-/, '');
                const r = await devinJsonDelete(DEVIN_APP + '/api/org-' + bareOrgId + '/secrets/' + s.id, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
                return { ok: r.status === 200 || r.status === 204 || r.status === 404 };
            }
        }
    }
    return { ok: true };
}
// DeleteThenCreate — 帛书·四十「反者道之动」
// 先删旧→再建新 = 永远不会stale URL
// ═══════════════════════════════════════════════════════════

async function devinUpsertSecret(orgId: string, name: string, value: string, auth1: string): Promise<{ ok: boolean }> {
    await devinDeleteSecret(orgId, name, auth1);
    const r = await devinInjectSecret(orgId, name, value, auth1);
    return r;
}

async function devinUpsertKnowledge(orgId: string, name: string, body: string, triggerDescription: string, auth1: string): Promise<{ ok: boolean }> {
    // Find existing by name → delete → create
    const list = await devinListKnowledge(orgId, auth1);
    if (list.ok && list.learnings) {
        for (const k of list.learnings) {
            if (k.name === name && k.id) await devinDeleteKnowledge(orgId, String(k.id), auth1);
        }
    }
    return await devinInjectKnowledge(orgId, name, body, triggerDescription, auth1);
}

async function devinUpsertPlaybook(orgId: string, title: string, body: string, auth1: string): Promise<{ ok: boolean }> {
    // Find existing by title → delete → create
    const list = await devinListPlaybooks(orgId, auth1);
    if (list.ok && list.playbooks) {
        for (const p of list.playbooks) {
            if (p.title === title && p.id) await devinDeletePlaybook(orgId, String(p.id), auth1);
        }
    }
    return await devinInjectPlaybook(orgId, title, body, auth1);
}

// ═══════════════════════════════════════════════════════════
// Session · 帛书·四十二「道生一·一生二·二生三·三生万物」
// Create / List / Detail / Messages → 对话记录MD下载
// ═══════════════════════════════════════════════════════════

const DEVIN_FRONTEND_TO_BACKEND: Record<string, string> = {
    'devin-2-5': 'devin-2-5', 'devin-fast-opus': 'devin-fast-opus',
    devin_lite: 'devin-lite', 'devin-gpt-5-5': 'devin-gpt-5-5', 'devin-opus-4-7': 'opus-4-7',
};

async function devinCreateSession(orgId: string, userMessage: string, auth1: string, opts?: any): Promise<{ ok: boolean; devinId?: string; isNewSession?: boolean; createdAt?: string; raw?: any }> {
    opts = opts || {};
    // 帛书·「反者道之动也」— Devin API需要cog_ API Key
    // api.devin.ai/v1/ 是正确的API端点（非app.devin.ai/api/）
    const useV1Api = (ws.devinApiKey || '').startsWith('cog_');
    const apiKey = useV1Api ? ws.devinApiKey : auth1;
    const payload: any = { prompt: userMessage };
    if (opts.idempotencyKey) payload.idempotency_key = opts.idempotencyKey;
    if (opts.playbookId) payload.playbook_id = opts.playbookId;
    if (opts.title) payload.title = opts.title;
    if (opts.tags) payload.tags = opts.tags;
    if (opts.repos) payload.repos = opts.repos;
    if (opts.sessionSecrets) payload.session_secrets = opts.sessionSecrets;
    const apiUrl = useV1Api ? `https://api.devin.ai/v1/org/${orgId}/sessions` : DEVIN_APP + '/api/sessions';
    const headers: any = { Authorization: 'Bearer ' + apiKey };
    if (!useV1Api) headers['x-cog-org-id'] = orgId;
    const r = await devinJsonPost(apiUrl, headers, payload);
    if (r.status === 200 || r.status === 201) {
        const j = r.json || {};
        return { ok: true, devinId: j.devin_id || j.session_id, isNewSession: j.is_new_session, createdAt: j.created_at, raw: j };
    }
    return { ok: false };
}

async function devinListSessions(orgId: string, auth1: string, limit?: number): Promise<{ ok: boolean; sessions?: any[] }> {
    // ★ v1.0.2 · 帛书·「反者道之动也」— v2sessions端点（auth1可用）
    const useV1Api = (ws.devinApiKey || '').startsWith('cog_');
    const apiKey = useV1Api ? ws.devinApiKey : auth1;
    const bareOrgId = orgId.replace(/^org-/, '');
    let url = useV1Api ? `https://api.devin.ai/v1/org/${orgId}/sessions` : DEVIN_APP + '/api/org-' + bareOrgId + '/v2sessions';
    if (limit) url += (url.includes('?') ? '&' : '?') + 'limit=' + limit;
    const headers: any = { Authorization: 'Bearer ' + apiKey };
    if (!useV1Api) headers['x-cog-org-id'] = orgId;
    const r = await devinJsonGet(url, headers);
    if (r.status === 200) {
        const j = r.json || {};
        // v2sessions returns {result:[...]}; v1 returns {sessions:[...]}
        const arr = Array.isArray(j.result) ? j.result : (Array.isArray(j.sessions) ? j.sessions : (Array.isArray(j) ? j : []));
        return { ok: true, sessions: arr };
    }
    return { ok: false };
}

async function devinGetSessionDetail(orgId: string, sessionId: string, auth1: string): Promise<{ ok: boolean; session?: any }> {
    const useV1Api = (ws.devinApiKey || '').startsWith('cog_');
    const apiKey = useV1Api ? ws.devinApiKey : auth1;
    const url = useV1Api ? `https://api.devin.ai/v1/org/${orgId}/sessions/${sessionId}` : DEVIN_APP + '/api/sessions/' + sessionId;
    const headers: any = { Authorization: 'Bearer ' + apiKey };
    if (!useV1Api) headers['x-cog-org-id'] = orgId;
    const r = await devinJsonGet(url, headers);
    if (r.status === 200) return { ok: true, session: r.json };
    return { ok: false };
}

async function devinGetSessionMessages(orgId: string, sessionId: string, auth1: string): Promise<{ ok: boolean; messages?: any[] }> {
    const useV1Api = (ws.devinApiKey || '').startsWith('cog_');
    const apiKey = useV1Api ? ws.devinApiKey : auth1;
    const url = useV1Api ? `https://api.devin.ai/v1/org/${orgId}/sessions/${sessionId}/messages` : DEVIN_APP + '/api/sessions/' + sessionId + '/messages';
    const headers: any = { Authorization: 'Bearer ' + apiKey };
    if (!useV1Api) headers['x-cog-org-id'] = orgId;
    const r = await devinJsonGet(url, headers);
    if (r.status === 200) { const j = r.json || {}; return { ok: true, messages: Array.isArray(j.messages) ? j.messages : (Array.isArray(j) ? j : []) }; }
    return { ok: false };
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

async function devinDisconnectGit(orgId: string, connectionId: string, auth1: string): Promise<{ ok: boolean }> {
    const r = await devinJsonDelete(DEVIN_APP + '/api/organizations/' + orgId + '/git-connections/' + connectionId, { Authorization: 'Bearer ' + auth1, 'x-cog-org-id': orgId });
    return { ok: r.status === 200 || r.status === 204 || r.status === 404 };
}

async function devinConnectGitHub(orgId: string, pat: string, auth1: string): Promise<{ ok: boolean; existed?: boolean }> {
    return devinInjectGitHubPAT(orgId, pat, auth1);
}

// 帛书·「天下之至柔驰骋于天下之致坚」— 辅助注入(无为而无不为)
// Windsurf 会话令牌(devin-session-token$) 无法经 node 调用 app.devin.ai 写入API(401/403);
// 但 Simple Browser 共享 Electron 的 Auth0 Session 可手动写入。
// 故: 自动生成可一键粘贴的注入包 + 复制 Token 到剪贴板 + 打开正确页面 → 把手动步骤降到最低。
async function devinAssistedInject(url: string, token: string): Promise<boolean> {
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
    try { if (bundleFile) { const doc = await vscode.workspace.openTextDocument(bundleFile); await vscode.window.showTextDocument(doc, { preview: false }); } } catch {}
    try { vscode.commands.executeCommand('simpleBrowser.show', DEVIN_APP + '/settings/secrets'); }
    catch { try { vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP + '/settings/secrets')); } catch {} }
    vscode.window.showInformationMessage('Windsurf Token 模式: 已生成注入包并复制 Token 到剪贴板。注入包: ' + bundleFile + ' — 按其中标题粘贴到已打开的 Devin Cloud 页面即可（或生成 cog_ Key 恢复全自动）。');
    return true;
}

async function devinFullInject(): Promise<boolean> {
    if (ws.devinInjecting) return false;
    ws.devinInjecting = true;
    try {
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
            return await devinAssistedInject(url, token);
        }
        // Upsert Secret (先删后建 → URL永远不stale)
        const sec = await devinUpsertSecret(ws.devinOrgId, 'DAO_TOKEN', token, ws.devinAuth1);
        // Upsert Knowledge
        const kb = buildDevinKnowledge(url, token);
        const kn = await devinUpsertKnowledge(ws.devinOrgId, 'Dao Workspace Server', kb, 'When user asks to operate on local machine, execute commands locally, read/write local files, or mentions local environment or Dao', ws.devinAuth1);
        // Upsert Playbook
        const pb = buildDevinPlaybook(url, token);
        const pl = await devinUpsertPlaybook(ws.devinOrgId, 'Operate Local Environment via Dao', pb, ws.devinAuth1);
        // ★ 帛书规则板块 (板块二) · 你本无名…道德经/阴符经 · 删旧注新(upsert) · 道法自然
        let rulesOk = true;
        const rulesText = getDaoRulesText();
        if (rulesText) {
            const rk = await devinUpsertKnowledge(
                ws.devinOrgId,
                '道法约束·帛书规则',
                rulesText,
                'Always — 你本无名 名可名也 非恒名也 所遵从之一切均来自下述帛书《老子》道藏《阴符经》',
                ws.devinAuth1,
            );
            rulesOk = rk.ok;
        }
        // Inject GitHub PAT if available
        const cfg = getDaoConfig();
        const githubPat = (cfg as any).githubPat || process.env.DAO_GITHUB_PAT || '';
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
        return allOk;
    } finally {
        ws.devinInjecting = false;
    }
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
interface InjectProfileItemK { name: string; body: string; trigger?: string }
interface InjectProfileItemP { title: string; body: string }
interface InjectProfile {
    enabled: boolean;
    autoCleanup: boolean;
    secrets: InjectProfileItemS[];
    knowledge: InjectProfileItemK[];
    playbooks: InjectProfileItemP[];
    lastInjectedOrg: string;
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
            lastInjectedOrg: j.lastInjectedOrg || '',
        };
    } catch {
        return { enabled: false, autoCleanup: true, secrets: [], knowledge: [], playbooks: [], lastInjectedOrg: '' };
    }
}
function saveInjectProfile(p: InjectProfile): void {
    try { fs.mkdirSync(DAO_DIR, { recursive: true }); fs.writeFileSync(INJECT_PROFILE_FILE, JSON.stringify(p, null, 2), 'utf8'); } catch { /* 守柔 */ }
}
// 从按邮箱持久化的 store 里找某 org 仍可用的 auth1 — 用于清理旧 org 注入
function findAuth1ForOrg(orgId: string): string {
    if (!orgId) return '';
    const store = loadAccountsAuthStore();
    for (const e of Object.keys(store)) { if (store[e] && store[e].orgId === orgId && store[e].auth1) return store[e].auth1; }
    return '';
}
async function applyInjectProfileToOrg(orgId: string, auth1: string, p: InjectProfile): Promise<void> {
    for (const s of p.secrets) { if (s && s.name) { try { await devinUpsertSecret(orgId, s.name, s.value || '', auth1); } catch { /* 守柔 */ } } }
    for (const k of p.knowledge) { if (k && k.name) { try { await devinUpsertKnowledge(orgId, k.name, k.body || '', k.trigger || 'Always', auth1); } catch { /* 守柔 */ } } }
    for (const pb of p.playbooks) { if (pb && pb.title) { try { await devinUpsertPlaybook(orgId, pb.title, pb.body || '', auth1); } catch { /* 守柔 */ } } }
}
async function cleanupInjectProfileFromOrg(orgId: string, auth1: string, p: InjectProfile): Promise<void> {
    for (const s of p.secrets) { if (s && s.name) { try { await devinDeleteSecret(orgId, s.name, auth1); } catch { /* 守柔 */ } } }
    try {
        const kl = await devinListKnowledge(orgId, auth1);
        if (kl.ok && kl.learnings) for (const k of kl.learnings) { if (p.knowledge.some(x => x.name === k.name) && k.id) { try { await devinDeleteKnowledge(orgId, String(k.id), auth1); } catch { /* 守柔 */ } } }
    } catch { /* 守柔 */ }
    try {
        const pl = await devinListPlaybooks(orgId, auth1);
        if (pl.ok && pl.playbooks) for (const pb of pl.playbooks) { if (p.playbooks.some(x => x.title === pb.title) && pb.id) { try { await devinDeletePlaybook(orgId, String(pb.id), auth1); } catch { /* 守柔 */ } } }
    } catch { /* 守柔 */ }
}
// 账号切换后调用: 应用 profile 到新 org + (默认)清理旧 org — 自循环核心
async function runInjectProfileSelfLoop(): Promise<void> {
    const p = loadInjectProfile();
    if (!p.enabled) return;
    if (!ws.devinOrgId || !ws.devinAuth1 || ws.devinAuth1.startsWith('devin-session-token$')) return;
    const hasItems = p.secrets.length || p.knowledge.length || p.playbooks.length;
    if (!hasItems) return;
    // 1. 默认清理旧 org 的旧注入 — 帛书·「将欲去之·必故与之」(用户可关 autoCleanup)
    if (p.autoCleanup && getInjectAutoCleanup() && p.lastInjectedOrg && p.lastInjectedOrg !== ws.devinOrgId) {
        const oldAuth1 = findAuth1ForOrg(p.lastInjectedOrg);
        if (oldAuth1) { try { await cleanupInjectProfileFromOrg(p.lastInjectedOrg, oldAuth1, p); } catch { /* 守柔 */ } }
    }
    // 2. 应用到当前 org
    await applyInjectProfileToOrg(ws.devinOrgId, ws.devinAuth1, p);
    // 3. 记录 lastInjectedOrg → 下次切换据此清理
    p.lastInjectedOrg = ws.devinOrgId;
    saveInjectProfile(p);
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
            // 降级到路径α
            try {
                vscode.commands.executeCommand('simpleBrowser.show', DEVIN_APP);
            } catch {
                vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP));
            }
        } else if (msg.command === 'openExternal') {
            vscode.env.openExternal(vscode.Uri.parse(DEVIN_APP));
        } else if (msg.command === 'navigate') {
            // iframe内导航请求 → 代理层处理
            const targetPath = msg.path || '/';
            panel.webview.html = getDevinCloudPanelHtml(`${localBase}/devin-cloud${targetPath}`, localBase);
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
          allow="clipboard-read; clipboard-write; fullscreen"
          onload="onLoad()" onerror="onError()">
  </iframe>
</div>

<div class="fallback" id="fallback">
  <div class="msg">
    <b>iframe 代理加载失败</b><br><br>
    可能原因: 网络连接问题 / 代理配置 / 安全头限制<br>
    请尝试 Simple Browser 或外部浏览器获得完整体验。
  </div>
  <button class="btn" onclick="cmd('openSimpleBrowser')">🌐 打开 Simple Browser</button>
  <button class="btn" onclick="cmd('openExternal')">↗ 打开外部浏览器</button>
  <button class="btn" onclick="cmd('refresh')">⟳ 重新尝试</button>
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
  document.getElementById('loading').style.display = 'block';
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

function onLoad() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('fallback').style.display = 'none';
  document.querySelector('.iframe-wrap').style.display = 'flex';
}

function onError() {
  document.getElementById('loading').style.display = 'none';
  document.querySelector('.iframe-wrap').style.display = 'none';
  document.getElementById('fallback').style.display = 'flex';
}

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

async function devinCloudProxyRoute(route: string, url: URL, req: any, mode: string = 'devin'): Promise<any> {
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
    } else {
        // /devin-cloud/xxx → https://app.devin.ai/xxx
        upstreamBase = DEVIN_APP;
        proxyPrefix = '/devin-cloud/';
        targetPath = route.replace(proxyPrefix, '/') + (url.search || '');
        targetUrl = upstreamBase + targetPath;
    }

    // 判断是静态资源还是页面请求
    const isPageRequest = !targetPath.match(/\.(js|css|png|jpg|svg|ico|woff2?|ttf|eot|map|json|wasm)(\?|$)/i);
    const isApiRequest = targetPath.startsWith('/api/');

    // 帛书·「执天之行」: 预读请求体 — 必须在 https.request 之前读取并据此设 Content-Length。
    // 否则 proxyReq.write 无 Content-Length 走 chunked 编码, app.devin.ai 网关挂起 → 15s 超时。
    // 在 makeRequest 内 await readBody 还会与 https 建连时序竞态, 故统一前置一次读取。
    let reqBody = '';
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        try { reqBody = await readBody(req); } catch { reqBody = ''; }
    }

    return new Promise((resolve) => {
        const u = new URL(targetUrl);
        const needsProxy = detectedProxyPort > 0;

        const makeRequest = (hostname: string, port: number, reqPath: string, h: any, isProxyTunnel: boolean = false) => {
            const options: any = {
                hostname, port, path: reqPath,
                method: req.method || 'GET',
                headers: h,
                timeout: 15000,
            };
            if (!isProxyTunnel) options.rejectUnauthorized = false;
            // 代理隧道用http.request(127.0.0.1不是TLS!)，直连用https.request
            const proxyReq = (isProxyTunnel ? http.request : https.request)(options, (proxyRes: any) => {
                // 缺陷4修复: 处理3xx重定向 — 改写Location头指向代理
                if (proxyRes.statusCode && proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
                    const location = proxyRes.headers['location'] || '';
                    if (location) {
                        // 改写重定向URL: app.devin.ai → 本地代理
                        const rewritten = location.replace(DEVIN_APP + '/', `http://localhost:${ws.port}/devin-cloud/`);
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
                    safeHeaders[k] = v as string | string[];
                }

                // 收集完整响应体
                const chunks: Buffer[] = [];
                proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                proxyRes.on('end', () => {
                    const rawBody = Buffer.concat(chunks);
                    const localBase = `http://localhost:${ws.port}`;

                    // 缺陷10: 如果内容被压缩，尝试解压gzip
                    let decodedBody: Buffer;
                    if (contentEncoding === 'gzip') {
                        try {
                            const zlib = require('zlib');
                            decodedBody = zlib.gunzipSync(rawBody);
                        } catch { decodedBody = rawBody; }
                    } else if (contentEncoding === 'br') {
                        try {
                            const zlib = require('zlib');
                            decodedBody = zlib.brotliDecompressSync(rawBody);
                        } catch { decodedBody = rawBody; }
                    } else if (contentEncoding === 'deflate') {
                        try {
                            const zlib = require('zlib');
                            decodedBody = zlib.inflateSync(rawBody);
                        } catch { decodedBody = rawBody; }
                    } else {
                        decodedBody = rawBody;
                    }

                    if (isHtml && isPageRequest) {
                        // HTML页面: 改写绝对URL + 注入认证脚本
                        let html = decodedBody.toString('utf8');
                        // 缺陷5修复: 改写所有Devin相关域名
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

                        // 注入认证桥接脚本 — 帛书·五十二「见小曰明·守柔曰强」
                        // 无为而无以为: 自动注入Cookie → Devin SPA自动识别登录态
                        // 守柔: 仅当持真 auth1_ 令牌时注入; session-token 注入会污染 auth1_session → 反致登录态崩坏
                        // 手动模式(websiteLoginMode=manual): 不注入认证, 用户打开官网后自行登录
                        const websiteAutoLogin = getWebsiteLoginMode() === 'auto';
                        const injA1 = (websiteAutoLogin && ws.devinAuth1 && !ws.devinAuth1.startsWith('devin-session-token$')) ? ws.devinAuth1 : '';
                        const authBridge = `<script>
// Dao Auth Bridge — 帛书·五十二「见小曰明·守柔曰强」
// 自动注入认证到Devin页面 — 无为而无以为
(function(){
  try {
    // 1. localStorage 注入 — 帛书·「观天之道·执天之行」
    //    经真机抓取确认: Devin SPA 的登录态唯一真源是 localStorage['auth1_session']
    //    = {"token":"auth1_...","userId":"user-..."}  — SPA 据此判定已登录, 否则跳转 /auth/login
    //    一并注入 org 相关键, 免去二次解析跳转。
    var __a1 = '${injA1}';
    var __uid = '${ws.devinUserId}';
    var __org = '${ws.devinOrgId}';
    if (__a1) {
      localStorage.setItem('auth1_session', JSON.stringify({ token: __a1, userId: __uid }));
      localStorage.setItem('migrated-to-unscoped-auth0-token-2025-12-18', 'true');
      if (__uid) localStorage.setItem('known-org-ids-' + __uid, JSON.stringify([__org]));
      if (__org) localStorage.setItem('last-internal-org-for-external-org-v1-null', __org);
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
      // 字符串 URL: 绝对 app.devin.ai → 根路径; 根相对原样保留
      var newUrl = url.split('https://app.devin.ai').join('');
      opts = opts || {};
      if (needAuthHdr(newUrl) && typeof opts.headers === 'object' && opts.headers && !Array.isArray(opts.headers)) {
        if (!opts.headers['Authorization']) opts.headers['Authorization'] = 'Bearer ${injA1}';
        if (!opts.headers['x-cog-org-id']) opts.headers['x-cog-org-id'] = '${ws.devinOrgId}';
      }
      return origFetch.call(this, newUrl, opts);
    };
    var origXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      // XHR.open 方法显式传入, 不会丢失; 仅改写绝对 app.devin.ai → 根路径
      var newUrl = (typeof url === 'string') ? url.split('https://app.devin.ai').join('') : url;
      var result = origXHR.apply(this, [method, newUrl].concat(Array.prototype.slice.call(arguments, 2)));
      if (needAuthHdr(newUrl)) { try { this.setRequestHeader('Authorization', 'Bearer ${injA1}'); this.setRequestHeader('x-cog-org-id', '${ws.devinOrgId}'); } catch(e) {} }
      return result;
    };
    // 4. postMessage通信 — 与父窗口(IDE)同步状态
    if (window.parent !== window) {
      window.parent.postMessage({type:'dao-auth',auth1:'${injA1}',orgId:'${ws.devinOrgId}',email:'${ws.devinEmail}'}, '*');
    }
    // 5. 通知父窗口加载成功
    if (window.parent !== window) {
      window.parent.postMessage({type:'dao-loaded',mode:'${mode}'}, '*');
    }
  } catch(e){}
})();
</script>`;
                        html = html.replace('</head>', authBridge + '</head>');
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
                        js = js.replace(/https:\/\/app\.devin\.ai\//g, `${localBase}/devin-cloud/`);
                        js = js.replace(/https:\/\/app\.devin\.ai(?!\/)/g, `${localBase}/devin-cloud`);
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: safeHeaders,
                            body: js,
                            contentType,
                        });
                    } else {
                        // 其他资源: 直接透传
                        resolve({
                            _proxy: true,
                            status: proxyRes.statusCode,
                            headers: safeHeaders,
                            body: decodedBody.toString('base64'),
                            contentType,
                            binary: true,
                        });
                    }
                });
            });

            proxyReq.on('error', (e: Error) => {
                // 帛书·「反者道之动」— 隧道不通则直连。本机多为直连环境,
                // detectedProxyPort 误检会致 ECONNREFUSED, 故降级直连源站。
                if (isProxyTunnel) {
                    makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, fwdHeaders, false);
                    return;
                }
                resolve({ ok: false, error: 'proxy error: ' + e.message });
            });
            proxyReq.on('timeout', () => {
                proxyReq.destroy();
                // 隧道超时同样降级直连源站
                if (isProxyTunnel) {
                    makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, fwdHeaders, false);
                    return;
                }
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
            // 缺陷10修复: 要求上游发送未压缩内容，否则无法改写
            'Accept-Encoding': 'identity',
        };
        // 请求体: 转发 Content-Type 并据 reqBody 设 Content-Length(关键 — 见上)
        if (reqBody) {
            fwdHeaders['Content-Length'] = Buffer.byteLength(reqBody).toString();
            if (req.headers?.['content-type']) fwdHeaders['Content-Type'] = req.headers['content-type'];
        }
        // 认证头: 所有请求都注入（不仅是API），因为Devin SPA需要认证Cookie
        if (ws.devinAuth1) {
            fwdHeaders['Authorization'] = 'Bearer ' + ws.devinAuth1;
            fwdHeaders['X-Devin-Auth1-Token'] = ws.devinAuth1;
            if (ws.devinOrgId) fwdHeaders['x-cog-org-id'] = ws.devinOrgId;
        }
        // Cookie注入 — 帛书·「大成若缺」— app.devin.ai通过Cookie识别登录态
        // auth1_token / devin_session_token / org_id → Devin SPA自动认证
        const cookies: string[] = [];
        if (ws.devinAuth1) cookies.push(`auth1_token=${ws.devinAuth1}`);
        if (ws.devinSessionToken) cookies.push(`devin_session_token=${ws.devinSessionToken}`);
        if (ws.devinOrgId) cookies.push(`org_id=${ws.devinOrgId}`);
        if (cookies.length) fwdHeaders['Cookie'] = cookies.join('; ');
        // 转发Referer和Origin — 须改写为源站, 否则 localhost 触发 app.devin.ai 的 CSRF/CORS 拒绝
        fwdHeaders['Origin'] = upstreamBase;
        fwdHeaders['Referer'] = upstreamBase + '/';

        if (needsProxy) {
            makeRequest('127.0.0.1', detectedProxyPort, targetUrl, Object.assign({}, fwdHeaders, { Host: u.hostname }), true);
        } else {
            makeRequest(u.hostname, parseInt(u.port) || 443, u.pathname + u.search, fwdHeaders, false);
        }
    });
}
