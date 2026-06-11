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

/** Extract just the user/devin message turns — the pure conversation transcript. */
export function extractConversation(events: EventItem[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const ev of events) {
    if (ev.type === 'user_message') {
      turns.push({ role: 'user', time: ts(ev), text: extractMessageText(ev.message) });
    } else if (ev.type === 'devin_message') {
      turns.push({ role: 'devin', time: ts(ev), text: extractMessageText(ev.message) });
    }
  }
  return turns;
}

/** Render the conversation turns as a clean readable markdown transcript. */
export function buildConversation(title: string, devinId: string, events: EventItem[]): string {
  const turns = extractConversation(events);
  const lines: string[] = [];
  lines.push(`# 对话记录 / Conversation: ${title}`);
  lines.push(`Session: ${devinId}`);
  lines.push(`Turns: ${turns.length}`);
  lines.push('');
  for (const turn of turns) {
    lines.push(turn.role === 'user' ? `\n## 👤 USER [${turn.time}]` : `\n## 🤖 DEVIN [${turn.time}]`);
    lines.push(turn.text);
  }
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
