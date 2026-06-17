/**
 * Worklog builder — converts an event stream into readable markdown,
 * and extracts changes (final file states) + a clean conversation transcript.
 *
 * Event-type names mirror the real app.devin.ai event stream (devin_thoughts,
 * shell_process_started/completed, multi_edit_result, computer_use, todo_update,
 * ...), NOT guessed names — otherwise meaningful content is silently dropped.
 */
import { EventItem } from './api';

function ts(ev: EventItem): string {
  if (ev.timestamp) { return ev.timestamp; }
  if (ev.created_at_ms) { return new Date(ev.created_at_ms).toISOString(); }
  return '';
}

/**
 * Robustly pull human-readable text out of a message-like value. Devin messages
 * are usually plain strings, but defend against structured shapes
 * ({text}, {content}, [{type:'text', text}]) so we never dump raw JSON at a user.
 */
export function extractMessageText(v: unknown): string {
  if (v == null) { return ''; }
  if (typeof v === 'string') { return v; }
  if (Array.isArray(v)) {
    return v.map((x) => extractMessageText(x)).filter(Boolean).join('\n');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') { return o.text; }
    if (typeof o.message === 'string') { return o.message; }
    if (o.content != null) { return extractMessageText(o.content); }
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

function asText(v: unknown): string {
  if (v == null) { return ''; }
  if (typeof v === 'string') { return v; }
  return JSON.stringify(v, null, 2);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s;
}

interface TodoItem { status?: string; content?: string; }
interface ComputerAction { action_type?: string; }
interface SearchCommand { path?: string; regex?: string; }

const TODO_MARK: Record<string, string> = {
  completed: '[x]', in_progress: '[~]', pending: '[ ]', cancelled: '[-]',
};

/** Event types that are pure machine noise for a human-readable worklog. */
const SKIP_TYPES = new Set<string>([
  'terminal_update', 'is_typing', 'context_growth_update', 'iteration_checkpoint',
  'acu_consumption_at_last_user_interaction', 'rules_injected',
  'shell_process_completed_background',
]);

export function buildWorklog(title: string, devinId: string, events: EventItem[]): string {
  const lines: string[] = [];
  lines.push(`# Worklog: ${title}`);
  lines.push(`Session: ${devinId}`);
  lines.push(`Events: ${events.length}`);
  lines.push('');

  for (const ev of events) {
    const t = ev.type || 'unknown';
    if (SKIP_TYPES.has(t)) { continue; }
    const time = ts(ev);

    switch (t) {
      case 'user_message':
        lines.push(`\n## 👤 USER [${time}]`);
        lines.push(extractMessageText(ev.message));
        break;
      case 'devin_message':
        lines.push(`\n## 🤖 DEVIN [${time}]`);
        lines.push(extractMessageText(ev.message));
        break;
      case 'devin_thoughts': {
        const dur = ev.thinking_duration_ms ? ` (${Math.round(Number(ev.thinking_duration_ms) / 1000)}s)` : '';
        lines.push(`\n### 💭 THINKING${dur} [${time}]`);
        lines.push(clip(extractMessageText(ev.message), 4000));
        break;
      }
      case 'todo_update': {
        const todos = (ev.todos as TodoItem[]) || [];
        if (todos.length) {
          lines.push(`\n### 📋 TODO [${time}]`);
          for (const td of todos) {
            lines.push(`- ${TODO_MARK[td.status || ''] || '[ ]'} ${asText(td.content)}`);
          }
        }
        break;
      }
      case 'shell_process_started': {
        const dir = ev.starting_dir ? ` (cwd: ${asText(ev.starting_dir)})` : '';
        lines.push(`\n### 💻 COMMAND${dir} [${time}]`);
        lines.push('```bash');
        lines.push(asText(ev.command));
        lines.push('```');
        break;
      }
      case 'shell_process_completed': {
        const out = asText(ev.output_trunc || ev.output);
        const code = ev.exit_code != null ? ` (exit ${ev.exit_code})` : '';
        if (out.trim()) {
          lines.push(`_output${code}:_`);
          lines.push('```');
          lines.push(clip(out, 3000));
          lines.push('```');
        } else if (code) {
          lines.push(`_command finished${code}_`);
        }
        break;
      }
      case 'multi_edit_result':
      case 'file_edit':
      case 'editor_action': {
        const fps = (ev.file_updates || []).map((f) => f.file_path).filter(Boolean);
        if (fps.length) {
          lines.push(`\n### ✏️ FILE EDIT [${time}]: ${fps.join(', ')}`);
        }
        break;
      }
      case 'search_file_commands': {
        const cmds = (ev.search_commands as SearchCommand[]) || [];
        const desc = cmds.map((c) => c.regex || c.path).filter(Boolean).join('; ');
        if (desc) { lines.push(`\n### 🔍 SEARCH [${time}]: ${desc.slice(0, 200)}`); }
        break;
      }
      case 'computer_use': {
        const acts = (ev.actions as ComputerAction[]) || [];
        const kinds = acts.map((a) => a.action_type).filter(Boolean).join(', ');
        lines.push(`\n### 🖥️ COMPUTER [${time}]: ${kinds || 'action'}`);
        break;
      }
      case 'browser_action':
      case 'browse':
        lines.push(`\n### 🌐 BROWSER [${time}]: ${asText(ev.url || ev.action || ev.message).slice(0, 200)}`);
        break;
      case 'status_update':
      case 'activity':
        lines.push(`\n_[${time}] ${asText(ev.message || ev.status).slice(0, 300)}_`);
        break;
      case 'play':
        lines.push(`\n--- [${time}] ▶️ **RESUMED**${ev.username ? ` by ${asText(ev.username)}` : ''} ---`);
        break;
      case 'suspend':
      case 'resume':
        lines.push(`\n--- [${time}] **${t.toUpperCase()}** ---`);
        break;
      default: {
        // Generic: include any other message-bearing event.
        const msg = ev.message || ev.content || ev.text;
        if (msg) {
          lines.push(`\n### [${t}] [${time}]`);
          lines.push(clip(extractMessageText(msg), 2000));
        }
        break;
      }
    }
  }

  return lines.join('\n');
}

export interface ConversationTurn {
  role: 'user' | 'devin';
  time: string;
  text: string;
}

/** Pull the user's text out of a user_question_answered event (free text or picks). */
export function userAnswerText(ev: EventItem): string {
  const answers = (ev.answers as Array<Record<string, unknown>>) || [];
  return answers.map((a) => {
    if (!a) { return ''; }
    if (typeof a.other_text === 'string' && a.other_text) { return a.other_text; }
    if (Array.isArray(a.selected)) { return a.selected.join('; '); }
    if (typeof a.text === 'string') { return a.text; }
    return '';
  }).filter(Boolean).join('\n');
}

/**
 * Extract the conversation turns — the pure transcript.
 * IMPORTANT: includes `initial_user_message` (the original/first prompt — the most
 * important turn, previously dropped) and `user_question_answered` (the user's
 * answers to Devin's questions), not just `user_message`/`devin_message`.
 */
export function extractConversation(events: EventItem[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const ev of events) {
    if (ev.type === 'initial_user_message' || ev.type === 'user_message') {
      turns.push({ role: 'user', time: ts(ev), text: extractMessageText(ev.message) });
    } else if (ev.type === 'user_question_answered') {
      const text = userAnswerText(ev);
      if (text) { turns.push({ role: 'user', time: ts(ev), text }); }
    } else if (ev.type === 'devin_message') {
      turns.push({ role: 'devin', time: ts(ev), text: extractMessageText(ev.message) });
    }
  }
  return turns;
}

/**
 * Compact, collapsible summary of what Devin did between two messages — so the
 * transcript reads like the official session page (messages prominent, the work
 * in-between summarized and collapsed) instead of a wall of raw events.
 */
function summarizeActivity(evs: EventItem[]): string {
  const cmds: string[] = [];
  const edited = new Set<string>();
  const searches: string[] = [];
  const webSearches: string[] = [];
  let thoughts = 0;
  let computer = 0;
  let todoSnapshot: EventItem | undefined;

  for (const ev of evs) {
    switch (ev.type) {
      case 'shell_process_started':
        if (ev.command) { cmds.push(asText(ev.command).split('\n')[0].trim().slice(0, 120)); }
        break;
      case 'multi_edit_result':
      case 'file_edit':
      case 'editor_action':
        for (const f of ev.file_updates || []) {
          if (f.file_path && f.action_type !== 'open') { edited.add(f.file_path); }
        }
        break;
      case 'computer_use':
        computer += Array.isArray(ev.actions) ? ev.actions.length : 1;
        break;
      case 'search_file_commands':
        for (const c of (ev.search_commands as SearchCommand[]) || []) {
          const d = c.regex || c.path;
          if (d) { searches.push(String(d).slice(0, 80)); }
        }
        break;
      case 'devin_thoughts':
        thoughts++;
        break;
      case 'web_search':
        if (ev.query) { webSearches.push(String(ev.query).slice(0, 100)); }
        break;
      case 'todo_update':
        todoSnapshot = ev;
        break;
    }
  }

  const head: string[] = [];
  if (thoughts) { head.push(`💭 思考 ${thoughts}`); }
  if (cmds.length) { head.push(`💻 命令 ${cmds.length}`); }
  if (edited.size) { head.push(`✏️ 编辑 ${edited.size}`); }
  if (computer) { head.push(`🖥️ 计算机 ${computer}`); }
  if (searches.length) { head.push(`🔍 搜索 ${searches.length}`); }
  if (webSearches.length) { head.push(`🌐 联网 ${webSearches.length}`); }
  if (!head.length) { return ''; }

  const body: string[] = [];
  if (cmds.length) {
    body.push('**命令 / Commands:**');
    body.push(...cmds.slice(0, 12).map((c) => '- `' + c + '`'));
    if (cmds.length > 12) { body.push(`- …(+${cmds.length - 12})`); }
  }
  if (edited.size) {
    body.push('', '**编辑文件 / Files edited:**');
    body.push(...Array.from(edited).slice(0, 15).map((f) => '- ' + f));
    if (edited.size > 15) { body.push(`- …(+${edited.size - 15})`); }
  }
  if (webSearches.length) {
    body.push('', '**联网搜索 / Web searches:**');
    body.push(...webSearches.slice(0, 6).map((q) => '- ' + q));
  }
  if (todoSnapshot) {
    const todos = (todoSnapshot.todos as TodoItem[]) || [];
    if (todos.length) {
      body.push('', '**TODO 进度:**');
      body.push(...todos.map((td) => `- ${TODO_MARK[td.status || ''] || '[ ]'} ${asText(td.content)}`));
    }
  }

  return `<details>\n<summary>🛠️ 这一步 Devin 做了：${head.join(' · ')}</summary>\n\n${body.join('\n')}\n\n</details>`;
}

/**
 * Render the conversation as a clean, human-readable transcript that reads like
 * the official session page: user & Devin messages in order, with the work done
 * in-between folded into a collapsible activity summary.
 */
export function buildConversation(title: string, devinId: string, events: EventItem[]): string {
  const turns = extractConversation(events);
  const lines: string[] = [];
  lines.push(`# 对话记录 / Conversation — ${title}`);
  lines.push('');
  lines.push(`> Session: \`${devinId}\` · 消息轮次 ${turns.length} · 在线查看: https://app.devin.ai/sessions/${devinId.replace('devin-', '')}`);
  lines.push('');

  let bucket: EventItem[] = [];
  const flush = () => {
    if (bucket.length) {
      const s = summarizeActivity(bucket);
      if (s) { lines.push(s, ''); }
      bucket = [];
    }
  };

  for (const ev of events) {
    const t = ev.type || '';
    if (t === 'initial_user_message' || t === 'user_message') {
      flush();
      lines.push(`## 👤 用户 · ${ts(ev)}`, '', extractMessageText(ev.message).trim() || '_(空)_', '');
    } else if (t === 'user_question_answered') {
      const txt = userAnswerText(ev);
      if (txt) { flush(); lines.push(`## 👤 用户（回答）· ${ts(ev)}`, '', txt.trim(), ''); }
    } else if (t === 'devin_message') {
      flush();
      lines.push(`## 🤖 Devin · ${ts(ev)}`, '', extractMessageText(ev.message).trim() || '_(空)_', '');
    } else if (!SKIP_TYPES.has(t)) {
      bucket.push(ev);
    }
  }
  flush();
  return lines.join('\n');
}

export interface ChangeFile {
  path: string;
  contentsKey: string;
}

/** Walk all events, find final state of each touched file (last contents_key wins). */
export function extractChanges(events: EventItem[]): ChangeFile[] {
  const finalState = new Map<string, string>();

  function walk(obj: any) {
    if (!obj || typeof obj !== 'object') { return; }
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (obj.file_path && obj.contents_key) {
      finalState.set(obj.file_path, obj.contents_key);
    }
    for (const v of Object.values(obj)) { walk(v); }
  }

  for (const ev of events) { walk(ev); }

  return Array.from(finalState.entries()).map(([path, contentsKey]) => ({ path, contentsKey }));
}

export function safeName(s: string, maxLen = 30): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f\n\r]/g, '_').slice(0, maxLen).replace(/[. ]+$/, '') || 'untitled';
}

/** Map every contents_key → its most recent file_path, so cloud files can be
 *  named/located meaningfully instead of by opaque hash. */
export function mapKeysToPaths(events: EventItem[]): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') { return; }
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (obj.contents_key && obj.file_path) { m.set(obj.contents_key, obj.file_path); }
    for (const v of Object.values(obj)) { walk(v); }
  };
  events.forEach(walk);
  return m;
}

export interface SessionStats {
  events: number;
  userMessages: number;
  devinMessages: number;
  commands: number;
  edits: number;
  computerActions: number;
  searches: number;
  webSearches: number;
  recordings: Array<{ title: string; summary: string; url: string }>;
  blockers: Array<{ headline: string; impact: string; recommended_action: string }>;
  todos: TodoItem[];
}

/** Aggregate the whole stream into headline stats + notable artifacts. */
export function summarize(events: EventItem[]): SessionStats {
  const s: SessionStats = {
    events: events.length, userMessages: 0, devinMessages: 0, commands: 0, edits: 0,
    computerActions: 0, searches: 0, webSearches: 0, recordings: [], blockers: [], todos: [],
  };
  const editedFiles = new Set<string>();
  for (const ev of events) {
    switch (ev.type) {
      case 'initial_user_message':
      case 'user_message':
        s.userMessages++; break;
      case 'devin_message':
        s.devinMessages++; break;
      case 'shell_process_started':
        s.commands++; break;
      case 'multi_edit_result':
      case 'file_edit':
      case 'editor_action':
        for (const f of ev.file_updates || []) {
          if (f.file_path && f.action_type !== 'open') { editedFiles.add(f.file_path); }
        }
        break;
      case 'computer_use':
        s.computerActions += Array.isArray(ev.actions) ? ev.actions.length : 1; break;
      case 'search_file_commands':
        s.searches++; break;
      case 'web_search':
        s.webSearches++; break;
      case 'recording_stopped':
        s.recordings.push({
          title: asText(ev.title), summary: asText(ev.summary),
          url: asText(ev.clean_video_url || ev.video_path),
        });
        break;
      case 'report_blocker':
        s.blockers.push({
          headline: asText(ev.headline), impact: asText(ev.impact),
          recommended_action: asText(ev.recommended_action),
        });
        break;
      case 'todo_update':
        s.todos = (ev.todos as TodoItem[]) || s.todos; break;
    }
  }
  s.edits = editedFiles.size;
  return s;
}

export interface ProducedFile { path: string; file: string; size: number; }

/**
 * README.md — the orientation/index doc placed at the session root. Serves both
 * a human (readable overview, like a session homepage) and an Agent (structured
 * front-matter + an explicit map to every other artifact in the export).
 */
export function buildReadme(
  info: Record<string, any>, devinId: string, events: EventItem[], produced: ProducedFile[],
): string {
  const stats = summarize(events);
  const turns = extractConversation(events);
  const firstUser = turns.find((t) => t.role === 'user');
  const lastDevin = [...turns].reverse().find((t) => t.role === 'devin');
  const sid = devinId.replace('devin-', '');
  const L: string[] = [];

  L.push(`# ${info.title || '(untitled session)'}`);
  L.push('');
  L.push('> 本目录是一次 Devin 会话的完整导出。下方先给人看的「概览」，再给 Agent 看的「文件地图」。');
  L.push('');
  // Machine-readable front matter (agents parse this first).
  L.push('```yaml');
  L.push(`devin_id: ${devinId}`);
  L.push(`status: ${info.status || ''}`);
  L.push(`created_at: ${info.created_at || ''}`);
  L.push(`updated_at: ${info.updated_at || ''}`);
  L.push(`online_url: https://app.devin.ai/sessions/${sid}`);
  L.push(`counts: { messages_user: ${stats.userMessages}, messages_devin: ${stats.devinMessages}, commands: ${stats.commands}, files_edited: ${stats.edits}, files_produced: ${produced.length}, computer_actions: ${stats.computerActions}, web_searches: ${stats.webSearches} }`);
  L.push('```');
  L.push('');

  L.push('## 🧭 概览 / Overview');
  L.push('');
  L.push(`- **状态 Status:** ${info.status || '—'}`);
  L.push(`- **时间 Time:** ${info.created_at || '—'} → ${info.updated_at || '—'}`);
  L.push(`- **在线查看 Online:** https://app.devin.ai/sessions/${sid}`);
  L.push(`- **规模 Scale:** 用户消息 ${stats.userMessages} · Devin 消息 ${stats.devinMessages} · 命令 ${stats.commands} · 编辑文件 ${stats.edits} · 产出文件 ${produced.length} · 计算机操作 ${stats.computerActions}`);
  L.push('');

  if (firstUser) {
    L.push('## 🎯 原始需求 / Original Request');
    L.push('');
    L.push(clip(firstUser.text.trim(), 2000));
    L.push('');
  }

  const prs = (info.pull_requests as Array<Record<string, any>>) || [];
  if (prs.length) {
    L.push('## 🔀 产出的 PR / Pull Requests');
    L.push('');
    for (const p of prs) { L.push(`- ${p.title ? p.title + ' — ' : ''}${p.url || JSON.stringify(p)}`); }
    L.push('');
  }

  if (stats.recordings.length) {
    L.push('## 🎬 录屏 / Recordings');
    L.push('');
    for (const r of stats.recordings) {
      L.push(`- **${r.title || 'recording'}** ${r.url ? `— ${r.url}` : ''}`);
      if (r.summary) { L.push(`  > ${clip(r.summary, 400).replace(/\n/g, ' ')}`); }
    }
    L.push('');
  }

  if (produced.length) {
    L.push('## 📦 产出文件 / Produced Files');
    L.push('');
    L.push('| 文件 File | 大小 Size | 导出路径 Path |');
    L.push('| --- | --- | --- |');
    for (const f of produced.slice(0, 200)) {
      L.push(`| ${f.path} | ${fmtSize(f.size)} | \`changes/${f.file}\` |`);
    }
    if (produced.length > 200) { L.push(`| …(+${produced.length - 200} more) | | 见 \`changes/_index.json\` |`); }
    L.push('');
  }

  if (stats.todos.length) {
    L.push('## ✅ 最终 TODO / Final TODO');
    L.push('');
    for (const td of stats.todos) { L.push(`- ${TODO_MARK[td.status || ''] || '[ ]'} ${asText(td.content)}`); }
    L.push('');
  }

  if (stats.blockers.length) {
    L.push('## ⛔ 阻塞 / Blockers');
    L.push('');
    for (const b of stats.blockers) {
      L.push(`- **${b.headline}** (${b.impact})${b.recommended_action ? ` — 建议: ${b.recommended_action}` : ''}`);
    }
    L.push('');
  }

  if (lastDevin) {
    L.push('## 🏁 最后回复 / Final Reply');
    L.push('');
    L.push(clip(lastDevin.text.trim(), 1500));
    L.push('');
  }

  L.push('## 🗂️ 文件地图 / File Map');
  L.push('');
  L.push('| 文件 | 给谁看 | 内容 |');
  L.push('| --- | --- | --- |');
  L.push('| `README.md` | 人 + Agent | 本概览与索引 |');
  L.push('| `conversation.md` | 人 | 像官网一样的对话记录（消息 + 折叠的过程） |');
  L.push('| `session.json` | Agent | 结构化全量：消息、产出、PR、录屏、阻塞、文件索引 |');
  L.push('| `worklog.md` | 人 + Agent | 完整活动明细（每条命令/编辑/操作） |');
  L.push('| `changes/` | 人 + Agent | 每个被改文件的最终内容（保留目录结构）+ `_index.json` |');
  L.push('| `cloud_files/` | Agent | 会话期间一切云端文件原件 + `_index.json`（key→path 映射） |');
  L.push('| `events.json` | Agent | 原始事件流（最底层数据） |');
  L.push('');
  L.push('---');
  L.push('*道法自然 · 导出即闭环：人读如官网，Agent 读如数据库。*');
  return L.join('\n');
}

function fmtSize(n: number): string {
  if (!n && n !== 0) { return '—'; }
  if (n < 1024) { return n + ' B'; }
  if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * session.json — the single structured artifact an Agent reads to understand the
 * whole session: meta, the original request, every message turn, headline stats,
 * produced files (with their in-zip paths), PRs, recordings, blockers.
 */
export function buildSessionJson(
  info: Record<string, any>, devinId: string, events: EventItem[],
  produced: ProducedFile[], cloudIndex: Array<Record<string, any>>,
): string {
  const stats = summarize(events);
  const turns = extractConversation(events);
  const sid = devinId.replace('devin-', '');
  const payload = {
    schema: 'dao-export/session@2',
    meta: {
      devin_id: devinId,
      title: info.title || '',
      status: info.status || '',
      created_at: info.created_at || '',
      updated_at: info.updated_at || '',
      online_url: `https://app.devin.ai/sessions/${sid}`,
      tags: info.tags || [],
    },
    original_request: turns.find((t) => t.role === 'user')?.text || '',
    stats: {
      events: stats.events,
      messages_user: stats.userMessages,
      messages_devin: stats.devinMessages,
      commands: stats.commands,
      files_edited: stats.edits,
      files_produced: produced.length,
      computer_actions: stats.computerActions,
      searches: stats.searches,
      web_searches: stats.webSearches,
    },
    messages: turns.map((t) => ({ role: t.role, time: t.time, text: t.text })),
    final_todo: stats.todos,
    pull_requests: info.pull_requests || [],
    recordings: stats.recordings,
    blockers: stats.blockers,
    produced_files: produced.map((f) => ({ path: f.path, size: f.size, export_path: `changes/${f.file}` })),
    cloud_files: cloudIndex,
    artifacts: {
      conversation: 'conversation.md',
      worklog: 'worklog.md',
      events: 'events.json',
      changes_dir: 'changes/',
      cloud_files_dir: 'cloud_files/',
    },
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * buildSessionMarkdown — the WHOLE session as ONE self-contained markdown file.
 *
 * The ZIP export gives a folder (events.json + cloud_files/ + changes/ …) which
 * is overkill when another Agent just needs to read the conversation. This packs
 * everything text-shaped — metadata header, full conversation transcript, a
 * readable worklog, and the final-changes file list — into a single .md with no
 * folder, so it can be pasted/ingested directly. No binaries are downloaded.
 */
export function buildSessionMarkdown(
  info: Record<string, any>, title: string, devinId: string, events: EventItem[],
): string {
  const stats = summarize(events);
  const changes = extractChanges(events);
  const sid = devinId.replace('devin-', '');
  const L: string[] = [];

  L.push(`# ${info.title || title || '(untitled session)'}`);
  L.push('');
  L.push('> 由 DAO Devin Export 单对话整段导出（单文件 Markdown · 无需文件夹）');
  L.push('');
  L.push('| 字段 | 值 |');
  L.push('|---|---|');
  L.push(`| Session | \`${devinId}\` |`);
  L.push(`| 在线查看 | https://app.devin.ai/sessions/${sid} |`);
  if (info.status) { L.push(`| 状态 | ${asText(info.status)} |`); }
  if (info.created_at) { L.push(`| 创建 | ${asText(info.created_at)} |`); }
  if (info.updated_at) { L.push(`| 更新 | ${asText(info.updated_at)} |`); }
  L.push(`| 事件 | ${stats.events}（用户 ${stats.userMessages} · Devin ${stats.devinMessages} · 命令 ${stats.commands} · 改文件 ${stats.edits}） |`);
  const prs = (info.pull_requests || []) as Array<Record<string, any>>;
  if (prs.length) {
    const urls = prs.map((p) => asText(p.url || p.html_url || p.pr_url)).filter(Boolean);
    L.push(`| PR | ${urls.length ? urls.join(' · ') : prs.length} |`);
  }
  L.push(`| 导出时间 | ${new Date().toISOString()} |`);
  L.push('');

  if (stats.blockers.length) {
    L.push('## ⚠ Blockers');
    L.push('');
    for (const b of stats.blockers) {
      L.push(`- **${b.headline || '(blocker)'}** — ${b.impact || ''}${b.recommended_action ? ` · 建议: ${b.recommended_action}` : ''}`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  // 完整对话流（含活动折叠摘要）。buildConversation 自带标题, 故此处不再重复一级标题。
  L.push(buildConversation(title, devinId, events));
  L.push('');

  if (changes.length) {
    L.push('---');
    L.push('');
    L.push(`## 📦 最终变更文件（${changes.length}）`);
    L.push('');
    for (const c of changes) { L.push(`- \`${c.path}\``); }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('<details><summary>📝 完整 Worklog（含命令/输出/思考）</summary>');
  L.push('');
  L.push(buildWorklog(title, devinId, events));
  L.push('');
  L.push('</details>');
  L.push('');
  L.push('无为而无不为 · 道法自然');
  return L.join('\n');
}
