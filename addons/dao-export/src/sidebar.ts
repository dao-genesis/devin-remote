/**
 * Sidebar webview — login form + session list, mirroring app.devin.ai's session panel.
 */
import * as vscode from 'vscode';
import * as api from './api';

export interface SidebarCallbacks {
  onLogin(email: string, password: string): Promise<void>;
  onLogout(): Promise<void>;
  onRefresh(): Promise<void>;
  onOpenSession(devinId: string): Promise<void>;
  onExportSession(devinId: string, title: string): Promise<void>;
  onExportAgentDoc(): Promise<void>;
  getState(): { auth?: api.AuthState; sessions: api.SessionInfo[] };
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
        case 'login':
          await this.cb.onLogin(msg.email, msg.password);
          break;
        case 'logout':
          await this.cb.onLogout();
          break;
        case 'refresh':
          await this.cb.onRefresh();
          break;
        case 'open':
          await this.cb.onOpenSession(msg.devinId);
          break;
        case 'export':
          await this.cb.onExportSession(msg.devinId, msg.title);
          break;
        case 'exportAgentDoc':
          await this.cb.onExportAgentDoc();
          break;
        case 'ready':
          this.update();
          break;
      }
    });
  }

  setStatus(text: string): void {
    this.view?.webview.postMessage({ command: 'status', text });
  }

  update(): void {
    const state = this.cb.getState();
    this.view?.webview.postMessage({
      command: 'state',
      loggedIn: !!state.auth,
      email: state.auth?.email || '',
      orgName: state.auth?.orgName || '',
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
  .login-box { padding: 12px; }
  .login-box input {
    width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 3px;
  }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; width: 100%;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .md-btn { margin-top: 6px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .toolbar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
  .toolbar .acct { flex: 1; font-size: 11px; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toolbar button { width: auto; padding: 3px 8px; font-size: 11px; }
  .search { padding: 6px 12px; }
  .search input {
    width: 100%; box-sizing: border-box; padding: 4px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 3px;
  }
  .session {
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer;
  }
  .session:hover { background: var(--vscode-list-hoverBackground); }
  .session .title { font-weight: 500; font-size: 13px; margin-bottom: 3px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session .meta { font-size: 11px; opacity: 0.7; display: flex; gap: 8px; align-items: center; }
  .badge { padding: 1px 6px; border-radius: 8px; font-size: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.running { background: #2d7d46; color: white; }
  .badge.blocked { background: #b8860b; color: white; }
  .exp-btn {
    float: right; width: auto !important; padding: 2px 8px !important; font-size: 10px !important;
    margin-left: 6px;
  }
  .status { padding: 8px 12px; font-size: 11px; opacity: 0.7; }
  .count { padding: 4px 12px; font-size: 11px; opacity: 0.6; }
  h3 { margin: 8px 0; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const vscode = acquireVsCodeApi();
let state = { loggedIn: false, sessions: [], email: '', orgName: '' };
let filter = '';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  const app = document.getElementById('app');
  if (!state.loggedIn) {
    app.innerHTML = \`
      <div class="login-box">
        <h3>道法自然 · Devin Export</h3>
        <input id="email" type="email" placeholder="Devin AI 邮箱" autocomplete="username">
        <input id="password" type="password" placeholder="密码" autocomplete="current-password">
        <button onclick="doLogin()">登录</button>
        <button class="md-btn" onclick="vscode.postMessage({command:'exportAgentDoc'})" title="实时生成 Agent 接入文档，粘贴给本地 Agent 即可接入插件全部功能">📄 导出MD (Agent接入文档)</button>
        <div class="status" id="status"></div>
      </div>\`;
    return;
  }

  const filtered = state.sessions.filter(s =>
    !filter || (s.title || '').toLowerCase().includes(filter.toLowerCase()));

  let html = \`
    <div class="toolbar">
      <span class="acct" title="\${esc(state.email)}">\${esc(state.email)} · \${esc(state.orgName)}</span>
      <button onclick="vscode.postMessage({command:'refresh'})">⟳</button>
      <button onclick="vscode.postMessage({command:'exportAgentDoc'})" title="实时生成 Agent 接入文档，粘贴给本地 Agent 即可接入插件全部功能">📄 MD</button>
      <button onclick="vscode.postMessage({command:'logout'})">退出</button>
    </div>
    <div class="search"><input placeholder="搜索 sessions..." value="\${esc(filter)}" oninput="filter=this.value;renderList()"></div>
    <div class="count" id="count">\${filtered.length} / \${state.sessions.length} sessions</div>
    <div id="list"></div>
    <div class="status" id="status"></div>\`;
  app.innerHTML = html;
  renderList();
}

function renderList() {
  const list = document.getElementById('list');
  if (!list) return;
  const filtered = state.sessions.filter(s =>
    !filter || (s.title || '').toLowerCase().includes(filter.toLowerCase()));
  const cnt = document.getElementById('count');
  if (cnt) { cnt.textContent = filtered.length + ' / ' + state.sessions.length + ' sessions'; }
  list.innerHTML = filtered.map(s => {
    const statusClass = /run|work/i.test(s.status) ? 'running' : (/block|wait/i.test(s.status) ? 'blocked' : '');
    return \`
    <div class="session" onclick="vscode.postMessage({command:'open', devinId:'\${esc(s.devin_id)}'})">
      <div class="title">
        <button class="exp-btn" onclick="event.stopPropagation();vscode.postMessage({command:'export', devinId:'\${esc(s.devin_id)}', title:'\${esc(s.title).replace(/'/g, '')}'})">⬇ ZIP</button>
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

function doLogin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) return;
  document.getElementById('status').textContent = '登录中...';
  vscode.postMessage({ command: 'login', email, password });
}

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
vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
