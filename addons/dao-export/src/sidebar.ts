/**
 * Sidebar webview — multi-account manager (万法识号) + session list.
 *
 * Top: paste-any-format account box + account list (switch / verify / remove).
 * Bottom: the active account's sessions, each exportable as ZIP or single MD.
 */
import * as vscode from 'vscode';
import * as api from './api';
import { AccountView } from './accountStore';

export interface SidebarCallbacks {
  onAddAccounts(text: string): Promise<void>;
  onSwitchAccount(id: string): Promise<void>;
  onVerifyAccount(id: string): Promise<void>;
  onVerifyAll(): Promise<void>;
  onRemoveAccount(id: string): Promise<void>;
  onClearAccounts(): Promise<void>;
  onRefresh(): Promise<void>;
  onOpenSession(devinId: string): Promise<void>;
  onExportSession(devinId: string, title: string): Promise<void>;
  onExportSessionMd(devinId: string, title: string): Promise<void>;
  onExportAllMd(): Promise<void>;
  onExportAgentDoc(): Promise<void>;
  getState(): { accounts: AccountView[]; sessions: api.SessionInfo[] };
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private context: vscode.ExtensionContext,
    private cb: SidebarCallbacks,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'addAccounts': await this.cb.onAddAccounts(msg.text); break;
        case 'switchAccount': await this.cb.onSwitchAccount(msg.id); break;
        case 'verifyAccount': await this.cb.onVerifyAccount(msg.id); break;
        case 'verifyAll': await this.cb.onVerifyAll(); break;
        case 'removeAccount': await this.cb.onRemoveAccount(msg.id); break;
        case 'clearAccounts': await this.cb.onClearAccounts(); break;
        case 'refresh': await this.cb.onRefresh(); break;
        case 'open': await this.cb.onOpenSession(msg.devinId); break;
        case 'export': await this.cb.onExportSession(msg.devinId, msg.title); break;
        case 'exportMd': await this.cb.onExportSessionMd(msg.devinId, msg.title); break;
        case 'exportAllMd': await this.cb.onExportAllMd(); break;
        case 'exportAgentDoc': await this.cb.onExportAgentDoc(); break;
        case 'ready': this.update(); break;
      }
    });
  }

  setStatus(text: string): void {
    this.view?.webview.postMessage({ command: 'status', text });
  }

  update(): void {
    const state = this.cb.getState();
    const active = state.accounts.find((a) => a.active);
    this.view?.webview.postMessage({
      command: 'state',
      accounts: state.accounts,
      activeEmail: active?.email || '',
      activeStatus: active?.status || '',
      hasActiveAuth: !!active && active.status === 'ok',
      sessions: state.sessions.map((s) => ({
        devin_id: s.devin_id,
        title: s.title || s.devin_id,
        status: s.status || s.status_enum || '',
        created_at: s.created_at || '',
        updated_at: s.updated_at || '',
        tags: s.tags || [],
        prs: (s.pull_requests || []).length,
      })),
    });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
  .pad { padding: 10px 12px; }
  textarea, input {
    width: 100%; box-sizing: border-box; padding: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: var(--vscode-font-family);
  }
  textarea { min-height: 54px; resize: vertical; font-size: 12px; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .row { display: flex; gap: 6px; align-items: center; }
  .row.wrap { flex-wrap: wrap; }
  .mt6 { margin-top: 6px; }
  .sechead { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; padding: 8px 12px 2px; }
  .acct {
    padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; align-items: center; gap: 8px;
  }
  .acct.active { background: var(--vscode-list-activeSelectionBackground); }
  .acct .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: #888; }
  .acct .dot.ok { background: #2d7d46; }
  .acct .dot.fail { background: #c4314b; }
  .acct .dot.unverified { background: #b8860b; }
  .acct .info { flex: 1; min-width: 0; }
  .acct .em { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct .sub { font-size: 10px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct .acts button { padding: 2px 7px; font-size: 10px; }
  .toolbar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; flex-wrap: wrap; }
  .toolbar .grow { flex: 1; }
  .search { padding: 6px 12px; }
  .session { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .session:hover { background: var(--vscode-list-hoverBackground); }
  .session .title { font-weight: 500; font-size: 13px; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session .meta { font-size: 11px; opacity: 0.7; display: flex; gap: 8px; align-items: center; }
  .badge { padding: 1px 6px; border-radius: 8px; font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.running { background: #2d7d46; color: white; }
  .badge.blocked { background: #b8860b; color: white; }
  .exp-btn { float: right; padding: 2px 7px !important; font-size: 10px !important; margin-left: 6px; }
  .status { padding: 8px 12px; font-size: 11px; opacity: 0.75; white-space: pre-wrap; }
  .count { padding: 4px 12px; font-size: 11px; opacity: 0.6; }
  .hint { font-size: 10px; opacity: .55; margin-top: 4px; line-height: 1.4; }
  h3 { margin: 8px 0; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const vscode = acquireVsCodeApi();
let state = { accounts: [], sessions: [], activeEmail: '', activeStatus: '', hasActiveAuth: false };
let filter = '';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function accountsHtml() {
  if (!state.accounts.length) {
    return '<div class="status">还没有账号 — 在上方粘贴任意格式账号后点「添加」。</div>';
  }
  return state.accounts.map(a => {
    const cls = a.status === 'ok' ? 'ok' : (a.status === 'fail' ? 'fail' : 'unverified');
    const sub = a.status === 'fail' ? ('验证失败: ' + (a.lastError || '').slice(0, 80))
      : (a.orgName ? a.orgName : (a.kind === 'token' ? 'token 登录' : '未验证'));
    return \`
    <div class="acct \${a.active ? 'active' : ''}">
      <span class="dot \${cls}" title="\${esc(a.status)}"></span>
      <div class="info">
        <div class="em">\${a.active ? '★ ' : ''}\${esc(a.email)}</div>
        <div class="sub">\${esc(sub)}</div>
      </div>
      <div class="acts row">
        \${a.active ? '' : '<button class="sec" onclick="send(\\'switchAccount\\',{id:\\'' + esc(a.id) + '\\'})">切换</button>'}
        <button class="sec" onclick="send('verifyAccount',{id:'\${esc(a.id)}'})">验证</button>
        <button class="sec" onclick="send('removeAccount',{id:'\${esc(a.id)}'})">✕</button>
      </div>
    </div>\`;
  }).join('');
}

function sessionsHtml() {
  const filtered = state.sessions.filter(s =>
    !filter || (s.title || '').toLowerCase().includes(filter.toLowerCase()));
  let html = \`
    <div class="count">\${filtered.length} / \${state.sessions.length} sessions · 当前账号 \${esc(state.activeEmail)}</div>
    <div id="list"></div>\`;
  return html;
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = \`
    <div class="pad">
      <h3>道法自然 · Devin Export</h3>
      <textarea id="addInput" placeholder="万法识号 · 任意格式批量粘贴：&#10;email password / email:pass / email----pass / email|pass&#10;邮箱:x@y.com 密码:abc / 卡号1:x 卡密1:y（含@亦可）&#10;{&quot;email&quot;:&quot;x&quot;,&quot;password&quot;:&quot;y&quot;} / devin-session-token$… / eyJ…JWT / auth1_…"></textarea>
      <div class="row mt6">
        <button class="grow" style="flex:1" onclick="doAdd()">添加账号（万法识号）</button>
      </div>
      <div class="hint">支持一文混万法、多行批量、重复自动跳过。token 可直登。</div>
    </div>
    <div class="toolbar">
      <button class="sec" onclick="send('verifyAll',{})">批量验证</button>
      <button class="sec" onclick="send('refresh',{})">⟳ 刷新</button>
      <button class="sec" onclick="send('exportAgentDoc',{})" title="生成 Agent 接入文档">📄 接入MD</button>
      <span class="grow"></span>
      <button class="sec" onclick="if(confirm('清空全部账号?'))send('clearAccounts',{})">清空</button>
    </div>
    <div class="sechead">账号（\${state.accounts.length}）</div>
    <div id="accts">\${accountsHtml()}</div>
    \${state.hasActiveAuth ? \`
      <div class="sechead row" style="display:flex;align-items:center">
        <span class="grow" style="flex:1">Sessions</span>
        <button class="sec" style="padding:2px 7px;font-size:10px" onclick="send('exportAllMd',{})">全部导出MD</button>
      </div>
      <div class="search"><input id="search" placeholder="搜索 sessions..." value="\${esc(filter)}" oninput="onSearch(this.value)"></div>
      \${sessionsHtml()}
    \` : '<div class="status">切换/验证一个账号后，这里显示其 sessions。</div>'}
    <div class="status" id="status"></div>\`;
  if (state.hasActiveAuth) { renderList(); }
}

function renderList() {
  const list = document.getElementById('list');
  if (!list) return;
  const filtered = state.sessions.filter(s =>
    !filter || (s.title || '').toLowerCase().includes(filter.toLowerCase()));
  list.innerHTML = filtered.map(s => {
    const statusClass = /run|work/i.test(s.status) ? 'running' : (/block|wait/i.test(s.status) ? 'blocked' : '');
    const t = esc(s.title).replace(/'/g, '');
    return \`
    <div class="session" onclick="send('open',{devinId:'\${esc(s.devin_id)}'})">
      <div class="title">
        <button class="exp-btn sec" onclick="event.stopPropagation();send('export',{devinId:'\${esc(s.devin_id)}',title:'\${t}'})" title="导出全量 ZIP">⬇ ZIP</button>
        <button class="exp-btn" onclick="event.stopPropagation();send('exportMd',{devinId:'\${esc(s.devin_id)}',title:'\${t}'})" title="导出单文件 Markdown（整段对话）">⬇ MD</button>
        \${esc(s.title)}
      </div>
      <div class="meta">
        <span class="badge \${statusClass}">\${esc(s.status || '—')}</span>
        <span>\${esc((s.created_at || '').slice(0, 10))}</span>
        \${s.prs ? '<span>PR×' + s.prs + '</span>' : ''}
      </div>
    </div>\`;
  }).join('');
}

function onSearch(v) { filter = v; renderList(); }

function doAdd() {
  const el = document.getElementById('addInput');
  const text = (el.value || '').trim();
  if (!text) return;
  send('addAccounts', { text });
  el.value = '';
}

function send(command, extra) { vscode.postMessage(Object.assign({ command }, extra || {})); }

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.command === 'state') {
    state = msg;
    render();
  } else if (msg.command === 'status') {
    const el = document.getElementById('status');
    if (el) el.textContent = msg.text;
  }
});

render();
send('ready');
</script>
</body>
</html>`;
  }
}
