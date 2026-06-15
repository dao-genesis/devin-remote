/**
 * Session exporter — fetches everything for a session and packs into a ZIP.
 * 底层之底层: events + worklog + all cloud files + final changes.
 */
import * as api from './api';
import { ZipWriter } from './zip';
import {
  buildWorklog, buildConversation, extractConversation, extractChanges, safeName,
  mapKeysToPaths, buildReadme, buildSessionJson, ProducedFile,
} from './worklog';

export interface ExportProgress {
  (message: string, increment?: number): void;
}

function downloadConcurrency(): number { return api.getSettings().DOWNLOAD_CONCURRENCY; }

export async function exportSessionToZip(
  auth: api.AuthState,
  devinId: string,
  title: string,
  progress: ExportProgress
): Promise<Buffer> {
  const zip = new ZipWriter();
  const base = `${safeName(title, 40)}_${devinId.replace('devin-', '').slice(0, 8)}`;

  // 1. Session info
  progress('获取 session 信息...', 5);
  let sessionInfo: any = {};
  try {
    sessionInfo = await api.getSessionInfo(auth, devinId);
  } catch (e) {
    sessionInfo = { error: String(e) };
  }
  zip.addFile(`${base}/session_info.json`, JSON.stringify(sessionInfo, null, 2));

  // 2. Full event stream
  progress('拉取完整事件流...', 15);
  let events: api.EventItem[] = [];
  try {
    events = await api.getEventStream(auth, devinId);
  } catch { /* fall through to first-load */ }
  if (events.length === 0) {
    try {
      events = await api.getFirstLoad(auth, devinId);
    } catch { /* keep empty */ }
  }
  zip.addFile(`${base}/events.json`, JSON.stringify(events, null, 2));
  progress(`已获取 ${events.length} 个事件`, 10);

  // 3. All cloud files (every contents_key ever seen)
  progress('解析所有云端文件 key...', 5);
  const allKeys = api.extractAllKeys(events);
  const keyToPath = mapKeysToPaths(events);

  // Cache downloaded buffers by contents_key so the changes pass (a subset of
  // these keys) reuses them instead of downloading the same bytes twice.
  const downloaded = new Map<string, Buffer>();
  const cloudIndex: any[] = [];

  if (allKeys.length > 0) {
    progress(`解析 ${allKeys.length} 个文件的下载地址...`, 10);
    const urlMap = await api.resolvePresignedUrls(auth, devinId, allKeys);

    let done = 0;
    const entries = Array.from(urlMap.entries());
    await api.runPool(entries, downloadConcurrency(), async ([key, info]) => {
      try {
        const data = await api.downloadFileWithRetry(info.url, info.headers);
        downloaded.set(key, data);
        // Name cloud files after their real path basename when known (instead of
        // an opaque hash), so the folder is navigable; keep an 8-char prefix to
        // avoid collisions. _index.json carries the full key→path mapping.
        const known = keyToPath.get(key);
        const baseName = safeName((known || key).split(/[\\/]/).pop() || key, 80);
        const prefix = key.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
        const file = `${prefix}_${baseName}`;
        zip.addFile(`${base}/cloud_files/${file}`, data);
        cloudIndex.push({ key, path: known || null, file, size: data.length });
      } catch (e) {
        cloudIndex.push({ key, path: keyToPath.get(key) || null, error: String(e) });
      }
      done++;
      if (done % 10 === 0 || done === entries.length) {
        progress(`下载文件 ${done}/${entries.length}...`, Math.floor(30 * 10 / entries.length));
      }
    });
    zip.addFile(`${base}/cloud_files/_index.json`, JSON.stringify(cloudIndex, null, 2));
  }

  // 5. Final changes (last state of each touched file)
  progress('提取最终变更文件...', 10);
  const changes = extractChanges(events);
  const produced: ProducedFile[] = [];
  if (changes.length > 0) {
    // Only resolve presigned URLs for keys we didn't already download above.
    const missingKeys = changes
      .map((c) => c.contentsKey)
      .filter((k) => k && !downloaded.has(k));
    const urlMap = missingKeys.length
      ? await api.resolvePresignedUrls(auth, devinId, missingKeys)
      : new Map<string, { url: string; headers: Record<string, string> }>();
    const changeIndex: any[] = [];

    const writeChange = (ch: { path: string }, data: Buffer) => {
      const rel = ch.path.replace(/^[A-Za-z]:[\\/]/, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const parts = rel.split('/').map((p) => safeName(p, 60)).join('/');
      zip.addFile(`${base}/changes/${parts}`, data);
      changeIndex.push({ path: ch.path, file: parts, size: data.length });
      produced.push({ path: ch.path, file: parts, size: data.length });
    };

    await api.runPool(changes, downloadConcurrency(), async (ch) => {
      const cached = downloaded.get(ch.contentsKey);
      if (cached) { writeChange(ch, cached); return; }
      const info = urlMap.get(ch.contentsKey);
      if (!info) {
        changeIndex.push({ path: ch.path, error: 'no presigned url' });
        return;
      }
      try {
        writeChange(ch, await api.downloadFileWithRetry(info.url, info.headers));
      } catch (e) {
        changeIndex.push({ path: ch.path, error: String(e) });
      }
    });
    zip.addFile(`${base}/changes/_index.json`, JSON.stringify(changeIndex, null, 2));
  }

  // 5. Human + Agent facing docs — built last so they can index produced files.
  progress('生成可读文档 (README / 对话 / worklog / session.json)...', 5);
  const conversationTurns = extractConversation(events);
  zip.addFile(`${base}/README.md`, buildReadme(sessionInfo, devinId, events, produced));
  zip.addFile(`${base}/conversation.md`, buildConversation(title, devinId, events));
  zip.addFile(`${base}/conversation.json`, JSON.stringify(conversationTurns, null, 2));
  zip.addFile(`${base}/worklog.md`, buildWorklog(title, devinId, events));
  zip.addFile(`${base}/session.json`, buildSessionJson(sessionInfo, devinId, events, produced, cloudIndex));

  // 6. Export manifest
  zip.addFile(`${base}/EXPORT_MANIFEST.json`, JSON.stringify({
    devin_id: devinId,
    title,
    exported_at: new Date().toISOString(),
    events_count: events.length,
    conversation_turns: conversationTurns.length,
    cloud_files_count: allKeys.length,
    changes_count: changes.length,
    produced_files: produced.length,
    exporter: 'DAO Devin Export VSIX',
  }, null, 2));

  progress('打包 ZIP...', 10);
  return zip.toBuffer();
}
