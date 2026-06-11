/**
 * DAO Devin Export — VS Code Extension entry.
 * 道法自然 无为而无不为
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as api from './api';
import { exportSessionToZip } from './exporter';
import { buildWorklog, extractChanges, safeName } from './worklog';
import { SessionsViewProvider } from './sidebar';
import { getDetailHtml } from './detailPanel';
import { AgentBridge } from './bridge';

let auth: api.AuthState | undefined;
let sessionsCache: api.SessionInfo[] = [];
let sidebarProvider: SessionsViewProvider;
let bridge: AgentBridge | undefined;

function applyConfig() {
  const cfg = vscode.workspace.getConfiguration('daoDevin');
  api.applySettings({
    loginUrl: cfg.get<string>('loginUrl') || undefined,
    apiBase: cfg.get<string>('apiBase') || undefined,
    downloadConcurrency: cfg.get<number>('downloadConcurrency') || undefined,
    presignConcurrency: cfg.get<number>('presignConcurrency') || undefined,
    downloadRetries: cfg.get<number>('downloadRetries') || undefined,
    downloadTimeout: cfg.get<number>('downloadTimeoutMs') || undefined,
  });
  // 软适配代理：优先 daoDevin.proxy 设置，其次 VS Code http.proxy，再其次环境变量；都没有则直连
  const proxy = cfg.get<string>('proxy') || vscode.workspace.getConfiguration('http').get<string>('proxy') || '';
  if (proxy && !process.env.HTTPS_PROXY && !process.env.https_proxy) {
    process.env.HTTPS_PROXY = proxy;
  }
}

export function activate(context: vscode.ExtensionContext) {
  applyConfig();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('daoDevin') || e.affectsConfiguration('http.proxy')) { applyConfig(); }
  }));

  sidebarProvider = new SessionsViewProvider(context, {
    onLogin: doLogin,
    onLogout: doLogout,
    onRefresh: refreshSessions,
    onOpenSession: openSessionDetail,
    onExportSession: exportSession,
    onExportAgentDoc: async () => { await exportAgentDoc(); },
    getState: () => ({ auth, sessions: sessionsCache }),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('daoDevinSessions', sidebarProvider),
    vscode.commands.registerCommand('daoDevin.login', () => promptLogin()),
    vscode.commands.registerCommand('daoDevin.logout', () => doLogout()),
    vscode.commands.registerCommand('daoDevin.refresh', () => refreshSessions().catch((e) => {
      sidebarProvider.update();
      sidebarProvider.setStatus(`获取会话失败（点 ⟳ 重试）: ${e}`);
      vscode.window.showErrorMessage(`获取会话失败: ${e}`);
    })),
    vscode.commands.registerCommand('daoDevin.exportSession', () => pickAndExport()),
    vscode.commands.registerCommand('daoDevin.exportAll', () => exportAllSessions()),
    vscode.commands.registerCommand('daoDevin.startBridge', () => startBridge(true)),
    vscode.commands.registerCommand('daoDevin.stopBridge', () => stopBridge()),
    vscode.commands.registerCommand('daoDevin.exportAgentDoc', () => exportAgentDoc()),
  );

  // Agent Bridge: 插件运行即启动本地 HTTP 接口层，供其他 Agent 接入
  startBridge(false).catch((e) => console.error('bridge start fail:', e));

  // Restore saved auth. A transient session-fetch failure should NOT silently wipe
  // the saved login — keep the user logged in and show the error so they can retry.
  const saved = context.globalState.get<api.AuthState>('daoDevinAuth');
  if (saved && saved.token) {
    auth = saved;
    refreshSessions().catch((e) => {
      sidebarProvider.update();
      sidebarProvider.setStatus(`会话获取失败（点 ⟳ 重试）: ${e}`);
    });
  }

  async function promptLogin() {
    const email = await vscode.window.showInputBox({
      prompt: 'Devin AI 邮箱', placeHolder: 'email@example.com', ignoreFocusOut: true,
    });
    if (!email) { return; }
    const password = await vscode.window.showInputBox({
      prompt: 'Devin AI 密码', password: true, ignoreFocusOut: true,
    });
    if (!password) { return; }
    await doLogin(email, password);
  }

  async function doLogin(email: string, password: string) {
    try {
      sidebarProvider.setStatus('登录中...');
      auth = await api.login(email, password);
      await context.globalState.update('daoDevinAuth', auth);
      vscode.window.showInformationMessage(`已登录: ${email} (${auth.orgName})`);
    } catch (e) {
      vscode.window.showErrorMessage(`登录失败: ${e}`);
      sidebarProvider.setStatus(`登录失败: ${e}`);
      return;
    }
    // Login succeeded. Fetch sessions separately so a session-fetch failure is
    // reported as such (not as a login failure) and the user stays logged in.
    try {
      await refreshSessions();
    } catch (e) {
      vscode.window.showErrorMessage(`已登录，但获取会话失败: ${e}`);
      sidebarProvider.setStatus(`已登录，但获取会话失败（点 ⟳ 重试）: ${e}`);
    }
  }

  async function doLogout() {
    auth = undefined;
    sessionsCache = [];
    await context.globalState.update('daoDevinAuth', undefined);
    sidebarProvider.update();
  }

  async function refreshSessions() {
    if (!auth) { sidebarProvider.update(); return; }
    sidebarProvider.setStatus('同步 sessions...');
    sessionsCache = await api.listSessions(auth);
    sessionsCache.sort((a, b) =>
      (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
    sidebarProvider.update();
  }

  async function openSessionDetail(devinId: string) {
    if (!auth) { return; }
    const session = sessionsCache.find((s) => s.devin_id === devinId)
      || { devin_id: devinId, title: devinId } as api.SessionInfo;

    const panel = vscode.window.createWebviewPanel(
      'daoDevinDetail',
      `Devin: ${(session.title || devinId).slice(0, 40)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.webview.html = getDetailHtml(session);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!auth) { return; }
      try {
        switch (msg.command) {
          case 'load': {
            let eventsError: string | undefined;
            const [info, evts] = await Promise.all([
              api.getSessionInfo(auth, devinId).catch((e) => ({ error: String(e) })),
              (async () => {
                // Try the stream, then first-load. Fall back on EMPTY too, not just on
                // a thrown error: a dead/proxied base can return a 200 HTML page that
                // parses to zero events without throwing. Only when BOTH yield nothing
                // AND at least one errored do we surface eventsError — silently
                // swallowing both was the core "no conversation records" bug.
                let streamErr: unknown; let firstErr: unknown;
                let evts: api.EventItem[] = [];
                try { evts = await api.getEventStream(auth, devinId); } catch (e) { streamErr = e; }
                if (evts.length === 0) {
                  try {
                    const fl = await api.getFirstLoad(auth, devinId);
                    if (fl.length) { evts = fl; }
                  } catch (e) { firstErr = e; }
                }
                if (evts.length === 0 && (streamErr || firstErr)) {
                  eventsError = `事件流获取失败: ${streamErr ? String(streamErr) : '返回空'} / first-load: ${firstErr ? String(firstErr) : '返回空'}`;
                }
                return evts;
              })(),
            ]);
            const worklog = buildWorklog(session.title || devinId, devinId, evts);
            const changes = extractChanges(evts);
            const cloudKeys = api.extractAllKeys(evts);
            panel.webview.postMessage({
              command: 'data',
              info, events: evts, worklog, eventsError,
              changes: changes.map((c) => c.path),
              cloudFilesCount: cloudKeys.length,
            });
            break;
          }
          case 'export':
            await exportSession(devinId, session.title || devinId);
            break;
          case 'openExternal':
            vscode.env.openExternal(vscode.Uri.parse(`https://app.devin.ai/sessions/${devinId.replace('devin-', '')}`));
            break;
        }
      } catch (e) {
        panel.webview.postMessage({ command: 'error', message: String(e) });
      }
    });
  }

  async function exportSession(devinId: string, title: string) {
    if (!auth) {
      vscode.window.showWarningMessage('请先登录');
      return;
    }

    const defaultName = `${safeName(title, 40)}_${devinId.replace('devin-', '').slice(0, 8)}.zip`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(getDownloadsDir(), defaultName)),
      filters: { 'ZIP Archive': ['zip'] },
    });
    if (!uri) { return; }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `导出 ${title.slice(0, 30)}`,
      cancellable: false,
    }, async (prog) => {
      const zipBuf = await exportSessionToZip(auth!, devinId, title,
        (message, increment) => prog.report({ message, increment }));
      fs.writeFileSync(uri.fsPath, zipBuf);
      const mb = (zipBuf.length / 1024 / 1024).toFixed(1);
      const open = await vscode.window.showInformationMessage(
        `导出完成: ${path.basename(uri.fsPath)} (${mb} MB)`, '打开文件夹');
      if (open) {
        vscode.commands.executeCommand('revealFileInOS', uri);
      }
    });
  }

  async function pickAndExport() {
    if (!auth || sessionsCache.length === 0) {
      vscode.window.showWarningMessage('请先登录并加载 sessions');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessionsCache.map((s) => ({
        label: s.title || s.devin_id,
        description: `${s.status || ''} · ${(s.created_at || '').slice(0, 10)}`,
        devinId: s.devin_id,
      })),
      { placeHolder: '选择要导出的 session' },
    );
    if (pick) {
      await exportSession(pick.devinId, pick.label);
    }
  }

  async function exportAllSessions() {
    if (!auth || sessionsCache.length === 0) {
      vscode.window.showWarningMessage('请先登录并加载 sessions');
      return;
    }
    const folderUri = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      title: '选择导出目录',
    });
    if (!folderUri || folderUri.length === 0) { return; }
    const dir = folderUri[0].fsPath;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `导出全部 ${sessionsCache.length} 个 sessions`,
      cancellable: true,
    }, async (prog, token) => {
      let done = 0;
      for (const s of sessionsCache) {
        if (token.isCancellationRequested) { break; }
        const title = s.title || s.devin_id;
        prog.report({ message: `[${done + 1}/${sessionsCache.length}] ${title.slice(0, 30)}` });
        try {
          const zipBuf = await exportSessionToZip(auth!, s.devin_id, title, () => { /* inner progress suppressed */ });
          const fname = `${String(done + 1).padStart(3, '0')}_${safeName(title, 40)}_${s.devin_id.replace('devin-', '').slice(0, 8)}.zip`;
          fs.writeFileSync(path.join(dir, fname), zipBuf);
        } catch (e) {
          console.error(`Export failed for ${s.devin_id}:`, e);
        }
        done++;
        prog.report({ increment: 100 / sessionsCache.length });
      }
      vscode.window.showInformationMessage(`全部导出完成: ${done} 个 sessions → ${dir}`);
    });
  }

  function getDownloadsDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || '.';
    const dl = path.join(home, 'Downloads');
    return fs.existsSync(dl) ? dl : home;
  }

  async function startBridge(notify: boolean) {
    if (!bridge) {
      bridge = new AgentBridge({
        getAuth: () => auth,
        setAuth: async (a) => {
          auth = a;
          await context.globalState.update('daoDevinAuth', a);
          if (!a) { sessionsCache = []; }
          sidebarProvider.update();
        },
        getSessions: () => sessionsCache,
        refreshSessions: async () => { await refreshSessions(); return sessionsCache; },
        version: (context.extension.packageJSON.version as string) || '0.0.0',
      });
    }
    if (!bridge.running) {
      const savedToken = context.globalState.get<string>('daoDevinBridgeToken');
      const preferredPort = vscode.workspace.getConfiguration('daoDevin').get<number>('bridgePort') || 7848;
      const { port, token } = await bridge.start(preferredPort, savedToken);
      await context.globalState.update('daoDevinBridgeToken', token);
      if (notify) {
        vscode.window.showInformationMessage(`Agent Bridge 运行中: http://127.0.0.1:${port} （用 “DAO: Export Agent Bridge Doc” 导出接入文档）`);
      }
    } else if (notify) {
      vscode.window.showInformationMessage(`Agent Bridge 已在运行: http://127.0.0.1:${bridge.port}`);
    }
  }

  function stopBridge() {
    bridge?.stop();
    vscode.window.showInformationMessage('Agent Bridge 已停止');
  }

  async function exportAgentDoc() {
    await startBridge(false);
    const md = bridge!.buildAgentDoc();
    const out = path.join(getDownloadsDir(), 'DAO_AGENT_BRIDGE.md');
    fs.writeFileSync(out, md, 'utf-8');
    const doc = await vscode.workspace.openTextDocument(out);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Agent 接入文档已导出: ${out}（粘贴给任意 Agent 即可接入本插件全部功能）`);
    return out;
  }
}

export function deactivate() { bridge?.stop(); }
