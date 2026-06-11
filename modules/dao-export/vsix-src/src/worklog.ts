/**
 * Worklog builder — converts an event stream into readable markdown,
 * and extracts changes (final file states).
 */
import { EventItem } from './api';

function ts(ev: EventItem): string {
  if (ev.timestamp) { return ev.timestamp; }
  if (ev.created_at_ms) { return new Date(ev.created_at_ms).toISOString(); }
  return '';
}

function asText(v: any): string {
  if (v == null) { return ''; }
  if (typeof v === 'string') { return v; }
  return JSON.stringify(v, null, 2);
}

export function buildWorklog(title: string, devinId: string, events: EventItem[]): string {
  const lines: string[] = [];
  lines.push(`# Worklog: ${title}`);
  lines.push(`Session: ${devinId}`);
  lines.push(`Events: ${events.length}`);
  lines.push('');

  for (const ev of events) {
    const t = ev.type || 'unknown';
    const time = ts(ev);

    switch (t) {
      case 'user_message':
        lines.push(`\n## 👤 USER [${time}]`);
        lines.push(asText(ev.message));
        break;
      case 'devin_message':
        lines.push(`\n## 🤖 DEVIN [${time}]`);
        lines.push(asText(ev.message));
        break;
      case 'plan_update':
      case 'plan':
        lines.push(`\n### 📋 PLAN [${time}]`);
        lines.push(asText(ev.plan || ev.message || ev.steps));
        break;
      case 'command':
      case 'shell_command':
        lines.push(`\n### 💻 COMMAND [${time}]`);
        lines.push('```bash');
        lines.push(asText(ev.command || ev.message));
        lines.push('```');
        break;
      case 'command_output':
      case 'shell_output': {
        const out = asText(ev.output || ev.message);
        if (out.trim()) {
          lines.push('```');
          lines.push(out.length > 3000 ? out.slice(0, 3000) + '\n...[truncated]' : out);
          lines.push('```');
        }
        break;
      }
      case 'file_edit':
      case 'editor_action': {
        const fps = (ev.file_updates || []).map((f: any) => f.file_path).filter(Boolean);
        if (fps.length) {
          lines.push(`\n### ✏️ FILE EDIT [${time}]: ${fps.join(', ')}`);
        }
        break;
      }
      case 'browser_action':
      case 'browse':
        lines.push(`\n### 🌐 BROWSER [${time}]: ${asText(ev.url || ev.action || ev.message).slice(0, 200)}`);
        break;
      case 'status_update':
      case 'activity':
        lines.push(`\n_[${time}] ${asText(ev.status || ev.message).slice(0, 300)}_`);
        break;
      case 'suspend':
      case 'resume':
        lines.push(`\n--- [${time}] **${t.toUpperCase()}** ---`);
        break;
      default: {
        // Generic: include message-bearing events
        const msg = ev.message || ev.content || ev.text;
        if (msg) {
          lines.push(`\n### [${t}] [${time}]`);
          const s = asText(msg);
          lines.push(s.length > 2000 ? s.slice(0, 2000) + '\n...[truncated]' : s);
        }
        break;
      }
    }
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
