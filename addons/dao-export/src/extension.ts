/**
 * DAO Devin Export — VS Code Extension entry.
 * 道法自然 无为而无不为
 *
 * Multi-account (万法识号) + single-conversation Markdown export. The active
 * account's AuthState drives session listing/export; switching is lazy-verified.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as api from './api';
import { exportSessionToZip, exportSessionToMarkdown } from './exporter';
import { safeName } from './worklog';
import { SessionsViewProvider } from './sidebar';
import { getDetailHtml } from './detailPanel';
import { AgentBridge } from './bridge';
import { AccountStore } from './accountStore';
import { buildWorklog, extractChanges } from './worklog';

let store: AccountStore;
let sessionsCache: api.SessionInfo[] = [];
let sidebarProvider: SessionsViewProvider;
let bridge: AgentBridge | undefined;

function activeAuth(): api.AuthState | undefined { return store.activeAuth(); }

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

  store = new AccountStore({
    get: <T>(k: string) => context.globalState.get<T>(k),
    update: (k: string, v: unknown) => context.globalState.update(k, v),
  });
  store.load();

  sidebarProvider = new SessionsViewProvider(context, {
    onAddAccounts: addAccounts,
    onSwitchAccount: switchAccount,
    onVerifyAccount: verifyAccount,
    onVerifyAll: verifyAllAccounts,
    onRemoveAccount: removeAccount,
    onClearAccounts: clearAccounts,
    onRefresh: refreshSessions,
    onOpenSession: openSessionDetail,
    onExportSession: exportSession,
    onExportSessionMd: exportSessionMd,
    onExportAllMd: exportAllMd,
    onExportAgentDoc: async () => { await exportAgentDoc(); },
    getState: () => ({ accounts: store.views(), sessions: sessionsCache }),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('daoDevinSessions', sidebarProvider),
    vscode.commands.registerCommand('daoDevin.addAccounts', () => promptAddAccounts()),
    vscode.commands.registerCommand('daoDevin.login', () => promptAddAccounts()),
    vscode.commands.registerCommand('daoDevin.logout', () => clearAccounts()),
    vscode.commands.registerCommand('daoDevin.verifyAll', () => verifyAllAccounts()),
    vscode.commands.registerCommand('daoDevin.refresh', () => refreshSessions().catch((e) => {
      sidebarProvider.update();
      sidebarProvider.setStatus(`获取会话失败（点 ⟳ 重试）: ${e}`);
      vscode.window.showErrorMessage(`获取会话失败: ${e}`);
    })),
    vscode.commands.registerCommand('daoDevin.exportSession', () => pickAndExport('zip')),
    vscode.commands.registerCommand('daoDevin.exportSessionMd', () => pickAndExport('md')),
    vscode.commands.registerCommand('daoDevin.exportAll', () => exportAllSessions()),
    vscode.commands.registerCommand('daoDevin.exportAllMd', () => exportAllMd()),
    vscode.commands.registerCommand('daoDevin.startBridge', () => startBridge(true)),
    vscode.commands.registerCommand('daoDevin.stopBridge', () => stopBridge()),
    vscode.commands.registerCommand('daoDevin.exportAgentDoc', () => exportAgentDoc()),
  );

  // Agent Bridge: 插件运行即启动本地 HTTP 接口层，供其他 Agent 接入
  startBridge(false).catch((e) => console.error('bridge start fail:', e));

  // Restore: if an active account already has cached auth, load its sessions.
  if (activeAuth()) {
    refreshSessions().catch((e) => {
      sidebarProvider.update();
      sidebarProvider.setStatus(`会话获取失败（点 ⟳ 重试）: ${e}`);
    });
  }

  async function promptAddAccounts() {
    const text = await vscode.window.showInputBox({
      prompt: '粘贴账号（万法识号：email password / email:pass / email----pass / 卡号卡密 / JSON / token 直登 …）',
      placeHolder: 'a@b.com pass1   或   a@b.com:pass1   或   token 直接粘贴',
      ignoreFocusOut: true,
    });
    if (!text) { return; }
    await addAccounts(text);
  }

  async function addAccounts(text: string) {
    const r = await store.addFromText(text);
    sidebarProvider.update();
    sidebarProvider.setStatus(`已识别 ${r.emails} 个账号 + ${r.tokens} 个 token，新增 ${r.added}（重复 ${r.dupes}）`);
    if (r.added === 0 && r.emails === 0 && r.tokens === 0) {
      vscode.window.showWarningMessage('未识别到任何账号/凭据，请检查粘贴内容');
    } else {
      vscode.window.showInformationMessage(`新增 ${r.added} 个账号（识别 ${r.emails} 邮箱 + ${r.tokens} token，重复 ${r.dupes}）`);
    }
  }

  async function switchAccount(id: string) {
    try {
      sidebarProvider.setStatus('切换并验证账号...');
      await store.setActive(id);
      sidebarProvider.update();
      await refreshSessions();
    } catch (e) {
      sidebarProvider.update();
      sidebarProvider.setStatus(`切号失败: ${e}`);
      vscode.window.showErrorMessage(`切号失败: ${e}`);
    }
  }

  async function verifyAccount(id: string) {
    try {
      sidebarProvider.setStatus('验证中...');
      await store.verify(id);
      sidebarProvider.update();
      sidebarProvider.setStatus('验证成功');
    } catch (e) {
      sidebarProvider.update();
      sidebarProvider.setStatus(`验证失败: ${e}`);
    }
  }

  async function verifyAllAccounts() {
    if (store.isEmpty()) { vscode.window.showWarningMessage('还没有账号，先添加'); return; }
    sidebarProvider.setStatus('批量验证全部账号...');
    const r = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: '批量验证账号',
      cancellable: false,
    }, async () => store.verifyAll(4));
    sidebarProvider.update();
    sidebarProvider.setStatus(`批量验证完成: 成功 ${r.ok} · 失败 ${r.fail}`);
    vscode.window.showInformationMessage(`批量验证完成: 成功 ${r.ok} · 失败 ${r.fail}`);
    if (activeAuth()) { await refreshSessions().catch(() => { /* status already shown */ }); }
  }

  async function removeAccount(id: string) {
    await store.remove(id);
    if (!activeAuth()) { sessionsCache = []; }
    sidebarProvider.update();
  }

  async function clearAccounts() {
    await store.clear();
    sessionsCache = [];
    sidebarProvider.update();
  }

  async function refreshSessions() {
    const auth = activeAuth();
    if (!auth) { sessionsCache = []; sidebarProvider.update(); return; }
    sidebarProvider.setStatus('同步 sessions...');
    sessionsCache = await api.listSessions(auth);
    sessionsCache.sort((a, b) =>
      (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
    sidebarProvider.update();
  }

  async function openSessionDetail(devinId: string) {
    const auth = activeAuth();
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
      const a = activeAuth();
      if (!a) { return; }
      try {
        switch (msg.command) {
          case 'load': {
            let eventsError: string | undefined;
            const [info, evts] = await Promise.all([
              api.getSessionInfo(a, devinId).catch((e) => ({ error: String(e) })),
              (async () => {
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
          case 'exportMd':
            await exportSessionMd(devinId, session.title || devinId);
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
    const auth = activeAuth();
    if (!auth) {
      vscode.window.showWarningMessage('请先添加并验证账号');
      return;
    }

    const defaultName = `${safeName(title, 40)}_${devinId.replace('devin-', '').slice(0, 8)}.zip`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(getDownloadsDir(), defaultName)),
      filters: { 'ZIP Archive': ['zip'] },
    });
    if (!uri) { return; }

    const bytes = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `导出 ${title.slice(0, 30)}`,
      cancellable: false,
    }, async (prog) => {
      const zipBuf = await exportSessionToZip(auth, devinId, title,
        (message, increment) => prog.report({ message, increment }));
      prog.report({ message: '写入磁盘...' });
      fs.writeFileSync(uri.fsPath, zipBuf);
      return zipBuf.length;
    });
    const mb = (bytes / 1024 / 1024).toFixed(1);
    const open = await vscode.window.showInformationMessage(
      `导出完成: ${path.basename(uri.fsPath)} (${mb} MB)`, '打开文件夹');
    if (open) {
      vscode.commands.executeCommand('revealFileInOS', uri);
    }
  }

  async function exportSessionMd(devinId: string, title: string) {
    const auth = activeAuth();
    if (!auth) {
      vscode.window.showWarningMessage('请先添加并验证账号');
      return;
    }

    const defaultName = `${safeName(title, 40)}_${devinId.replace('devin-', '').slice(0, 8)}.md`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(getDownloadsDir(), defaultName)),
      filters: { 'Markdown': ['md'] },
    });
    if (!uri) { return; }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `导出对话 MD: ${title.slice(0, 30)}`,
      cancellable: false,
    }, async (prog) => {
      prog.report({ message: '拉取对话事件流...' });
      const md = await exportSessionToMarkdown(auth, devinId, title);
      prog.report({ message: '写入磁盘...' });
      fs.writeFileSync(uri.fsPath, md, 'utf-8');
    });
    const open = await vscode.window.showInformationMessage(
      `单对话 MD 导出完成: ${path.basename(uri.fsPath)}`, '打开文件', '打开文件夹');
    if (open === '打开文件') {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } else if (open === '打开文件夹') {
      vscode.commands.executeCommand('revealFileInOS', uri);
    }
  }

  async function pickAndExport(kind: 'zip' | 'md') {
    if (!activeAuth() || sessionsCache.length === 0) {
      vscode.window.showWarningMessage('请先添加/验证账号并加载 sessions');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessionsCache.map((s) => ({
        label: s.title || s.devin_id,
        description: `${s.status || ''} · ${(s.created_at || '').slice(0, 10)}`,
        devinId: s.devin_id,
      })),
      { placeHolder: `选择要导出的 session（${kind === 'md' ? '单文件 MD' : 'ZIP'}）` },
    );
    if (pick) {
      if (kind === 'md') { await exportSessionMd(pick.devinId, pick.label); }
      else { await exportSession(pick.devinId, pick.label); }
    }
  }

  async function exportAllSessions() {
    const auth = activeAuth();
    if (!auth || sessionsCache.length === 0) {
      vscode.window.showWarningMessage('请先添加/验证账号并加载 sessions');
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
          const zipBuf = await exportSessionToZip(auth, s.devin_id, title, () => { /* inner progress suppressed */ });
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

  async function exportAllMd() {
    const auth = activeAuth();
    if (!auth || sessionsCache.length === 0) {
      vscode.window.showWarningMessage('请先添加/验证账号并加载 sessions');
      return;
    }
    const folderUri = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      title: '选择 MD 导出目录',
    });
    if (!folderUri || folderUri.length === 0) { return; }
    const dir = folderUri[0].fsPath;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `导出全部 ${sessionsCache.length} 个对话 MD`,
      cancellable: true,
    }, async (prog, token) => {
      let done = 0;
      for (const s of sessionsCache) {
        if (token.isCancellationRequested) { break; }
        const title = s.title || s.devin_id;
        prog.report({ message: `[${done + 1}/${sessionsCache.length}] ${title.slice(0, 30)}` });
        try {
          const md = await exportSessionToMarkdown(auth, s.devin_id, title);
          const fname = `${String(done + 1).padStart(3, '0')}_${safeName(title, 40)}_${s.devin_id.replace('devin-', '').slice(0, 8)}.md`;
          fs.writeFileSync(path.join(dir, fname), md, 'utf-8');
        } catch (e) {
          console.error(`MD export failed for ${s.devin_id}:`, e);
        }
        done++;
        prog.report({ increment: 100 / sessionsCache.length });
      }
      vscode.window.showInformationMessage(`全部对话 MD 导出完成: ${done} 个 → ${dir}`);
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
        store,
        getAuth: () => activeAuth(),
        getSessions: () => sessionsCache,
        refreshSessions: async () => { await refreshSessions(); return sessionsCache; },
        onChanged: () => sidebarProvider.update(),
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
