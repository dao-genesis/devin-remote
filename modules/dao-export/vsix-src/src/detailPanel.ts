/**
 * Session detail webview — mirrors the official session page:
 * Overview / Conversation / Worklog / Changes tabs + Export button.
 */
import { SessionInfo } from './api';

export function getDetailHtml(session: SessionInfo): string {
  const title = (session.title || session.devin_id).replace(/</g, '&lt;');
  const devinId = session.devin_id;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 0; }
  .header { padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border);
    display: flex; align-items: center; gap: 12px; }
  .header h2 { margin: 0; flex: 1; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); padding: 0 16px; }
  .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 13px; }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .content { padding: 16px; overflow-y: auto; }
  .loading { padding: 40px; text-align: center; opacity: 0.6; }
  .msg { margin-bottom: 14px; padding: 10px 14px; border-radius: 8px; max-width: 90%; white-space: pre-wrap; word-break: break-word; }
  .msg.user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); margin-left: auto; }
  .msg.devin { background: var(--vscode-editor-inactiveSelectionBackground); }
  .msg .who { font-size: 11px; opacity: 0.6; margin-bottom: 4px; }
  .evt { font-size: 12px; opacity: 0.75; margin: 4px 0 4px 20px; padding: 3px 8px;
    border-left: 2px solid var(--vscode-panel-border); white-space: pre-wrap; word-break: break-word; }
  .evt.cmd { font-family: var(--vscode-editor-font-family); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
    overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td, th { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .stat { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .stat .num { font-size: 22px; font-weight: 700; }
  .stat .lbl { font-size: 11px; opacity: 0.6; }
  .file-item { padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border); }
  .error { color: var(--vscode-errorForeground); padding: 16px; }
  .markdown { line-height: 1.6; font-size: 13px; }
</style>
</head>
<body>
<div class="header">
  <h2 title="${title}">${title}</h2>
  <button class="secondary" onclick="vscode.postMessage({command:'openExternal'})">官网打开</button>
  <button onclick="vscode.postMessage({command:'export'})">⬇ 导出 ZIP (一切底层数据)</button>
</div>
<div class="tabs">
  <div class="tab active" data-tab="overview" onclick="switchTab('overview')">概览</div>
  <div class="tab" data-tab="conversation" onclick="switchTab('conversation')">对话</div>
  <div class="tab" data-tab="worklog" onclick="switchTab('worklog')">Worklog</div>
  <div class="tab" data-tab="changes" onclick="switchTab('changes')">Changes</div>
  <div class="tab" data-tab="raw" onclick="switchTab('raw')">原始数据</div>
</div>
<div class="content" id="content">
  <div class="loading">加载 session 数据中... (拉取完整事件流)</div>
</div>
<script>
const vscode = acquireVsCodeApi();
const devinId = ${JSON.stringify(devinId)};
let data = null;
let currentTab = 'overview';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  render();
}

function render() {
  const el = document.getElementById('content');
  if (!data) {
    el.innerHTML = '<div class="loading">加载中...</div>';
    return;
  }
  if (currentTab === 'overview') { renderOverview(el); }
  else if (currentTab === 'conversation') { renderConversation(el); }
  else if (currentTab === 'worklog') { renderWorklog(el); }
  else if (currentTab === 'changes') { renderChanges(el); }
  else { renderRaw(el); }
}

function renderOverview(el) {
  const info = data.info || {};
  const userMsgs = data.events.filter(e => e.type === 'user_message' || e.type === 'initial_user_message' || e.type === 'user_question_answered').length;
  const devinMsgs = data.events.filter(e => e.type === 'devin_message').length;
  let html = '<div class="stat-grid">';
  html += stat(data.events.length, '总事件数');
  html += stat(userMsgs, '用户消息');
  html += stat(devinMsgs, 'Devin 消息');
  html += stat(data.changes.length, '变更文件');
  html += stat(data.cloudFilesCount, '云端产出文件');
  html += '</div>';
  html += '<table>';
  const fields = ['devin_id', 'title', 'status', 'status_enum', 'created_at', 'updated_at',
    'activity_status', 'current_activity', 'snapshot_id', 'playbook_id'];
  for (const f of fields) {
    if (info[f] != null && typeof info[f] !== 'object') {
      html += '<tr><th>' + esc(f) + '</th><td>' + esc(info[f]) + '</td></tr>';
    }
  }
  if (info.pull_requests && info.pull_requests.length) {
    html += '<tr><th>pull_requests</th><td>' + info.pull_requests.map(p =>
      '<div>' + esc(p.url || JSON.stringify(p)) + '</div>').join('') + '</td></tr>';
  }
  if (info.tags && info.tags.length) {
    html += '<tr><th>tags</th><td>' + esc(info.tags.join(', ')) + '</td></tr>';
  }
  html += '</table>';
  el.innerHTML = html;
}

function stat(num, lbl) {
  return '<div class="stat"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(lbl) + '</div></div>';
}

function renderConversation(el) {
  let html = '';
  if (data.eventsError) {
    html += '<div class="evt" style="border-left:3px solid #e06c75;background:rgba(224,108,117,.08)">'
      + '⚠️ 事件流获取失败，无法显示对话记录：<br>' + esc(String(data.eventsError))
      + '<br><br>常见原因：网络/代理无法访问 app.devin.ai，或事件流端点超时。'
      + '可在插件设置 daoDevin.proxy 配置代理后点 ⟳ 重试。</div>';
  }
  for (const ev of data.events) {
    const t = ev.type || '';
    const time = ev.timestamp || (ev.created_at_ms ? new Date(ev.created_at_ms).toISOString() : '');
    if (t === 'user_message' || t === 'initial_user_message') {
      html += '<div class="msg user"><div class="who">👤 USER · ' + esc(time) + '</div>' + esc(msgText(ev)) + '</div>';
    } else if (t === 'user_question_answered') {
      const ans = (ev.answers || []).map(a => (a && (a.other_text || (Array.isArray(a.selected) ? a.selected.join('; ') : '') || a.text)) || '').filter(Boolean).join('\\n');
      if (ans) { html += '<div class="msg user"><div class="who">👤 USER（回答）· ' + esc(time) + '</div>' + esc(ans) + '</div>'; }
    } else if (t === 'devin_message') {
      html += '<div class="msg devin"><div class="who">🤖 DEVIN · ' + esc(time) + '</div>' + esc(msgText(ev)) + '</div>';
    } else if (t === 'devin_thoughts') {
      const dur = ev.thinking_duration_ms ? ' (' + Math.round(Number(ev.thinking_duration_ms) / 1000) + 's)' : '';
      html += '<div class="evt">💭 ' + esc(msgText(ev).slice(0, 600)) + esc(dur) + '</div>';
    } else if (t === 'todo_update' && ev.todos && ev.todos.length) {
      const marks = { completed: '✓', in_progress: '⟳', pending: '·', cancelled: '✗' };
      html += '<div class="evt">📋 ' + ev.todos.map(td =>
        (marks[td.status] || '·') + ' ' + esc(String(td.content || ''))).join('<br>') + '</div>';
    } else if (t === 'shell_process_started') {
      html += '<div class="evt cmd">$ ' + esc(String(ev.command || '').slice(0, 500)) + '</div>';
    } else if (t === 'search_file_commands' && ev.search_commands) {
      const d = ev.search_commands.map(c => c.regex || c.path).filter(Boolean).join('; ');
      html += '<div class="evt">🔍 ' + esc(d.slice(0, 200)) + '</div>';
    } else if (t === 'computer_use' && ev.actions) {
      html += '<div class="evt">🖥️ ' + esc(ev.actions.map(a => a.action_type).filter(Boolean).join(', ')) + '</div>';
    } else if ((t === 'multi_edit_result' || t === 'file_edit') && ev.file_updates && ev.file_updates.length) {
      html += '<div class="evt">✏️ ' + esc(ev.file_updates.map(f => f.file_path).join(', ').slice(0, 300)) + '</div>';
    }
  }
  el.innerHTML = html || '<div class="loading">无对话事件</div>';
}

function msgText(ev) {
  return extractText(ev.message);
}

function extractText(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(extractText).filter(Boolean).join('\\n');
  if (typeof m === 'object') {
    if (typeof m.text === 'string') return m.text;
    if (typeof m.message === 'string') return m.message;
    if (m.content != null) return extractText(m.content);
    return JSON.stringify(m);
  }
  return String(m);
}

function renderWorklog(el) {
  el.innerHTML = '<pre class="markdown">' + esc(data.worklog) + '</pre>';
}

function renderChanges(el) {
  if (!data.changes.length) {
    el.innerHTML = '<div class="loading">无文件变更 (导出 ZIP 可获取全部云端文件)</div>';
    return;
  }
  el.innerHTML = '<p>' + data.changes.length + ' 个最终变更文件 (导出 ZIP 获取实际内容):</p>'
    + data.changes.map(p => '<div class="file-item">' + esc(p) + '</div>').join('');
}

function renderRaw(el) {
  el.innerHTML = '<p>完整原始事件流 (' + data.events.length + ' 事件) — 导出 ZIP 包含全部:</p><pre>'
    + esc(JSON.stringify(data.events.slice(0, 100), null, 2))
    + (data.events.length > 100 ? '\\n\\n...[显示前100条, 完整数据请导出ZIP]' : '') + '</pre>';
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.command === 'data') {
    data = msg;
    render();
  } else if (msg.command === 'error') {
    document.getElementById('content').innerHTML = '<div class="error">' + esc(msg.message) + '</div>';
  }
});

vscode.postMessage({ command: 'load' });
</script>
</body>
</html>`;
}
