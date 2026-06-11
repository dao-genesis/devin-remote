/**
 * Session exporter — fetches everything for a session and packs into a ZIP.
 * 底层之底层: events + worklog + all cloud files + final changes.
 */
import * as api from './api';
import { ZipWriter } from './zip';
import { buildWorklog, buildConversation, extractConversation, extractChanges, safeName } from './worklog';

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

  // 3. Worklog (full activity) + clean conversation transcript
  const worklog = buildWorklog(title, devinId, events);
  zip.addFile(`${base}/worklog.md`, worklog);
  const conversationTurns = extractConversation(events);
  zip.addFile(`${base}/conversation.md`, buildConversation(title, devinId, events));
  zip.addFile(`${base}/conversation.json`, JSON.stringify(conversationTurns, null, 2));

  // 4. All cloud files (every contents_key ever seen)
  progress('解析所有云端文件 key...', 5);
  const allKeys = api.extractAllKeys(events);

  if (allKeys.length > 0) {
    progress(`解析 ${allKeys.length} 个文件的下载地址...`, 10);
    const urlMap = await api.resolvePresignedUrls(auth, devinId, allKeys);

    let done = 0;
    const fileIndex: any[] = [];
    const entries = Array.from(urlMap.entries());
    await api.runPool(entries, downloadConcurrency(), async ([key, info]) => {
      try {
        const data = await api.downloadFileWithRetry(info.url, info.headers);
        const fname = safeName(key.split('/').pop() || key, 80);
        const prefix = key.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
        zip.addFile(`${base}/cloud_files/${prefix}_${fname}`, data);
        fileIndex.push({ key, file: `${prefix}_${fname}`, size: data.length });
      } catch (e) {
        fileIndex.push({ key, error: String(e) });
      }
      done++;
      if (done % 10 === 0 || done === entries.length) {
        progress(`下载文件 ${done}/${entries.length}...`, Math.floor(30 * 10 / entries.length));
      }
    });
    zip.addFile(`${base}/cloud_files/_index.json`, JSON.stringify(fileIndex, null, 2));
  }

  // 5. Final changes (last state of each touched file)
  progress('提取最终变更文件...', 10);
  const changes = extractChanges(events);
  if (changes.length > 0) {
    const changeKeys = changes.map((c) => c.contentsKey);
    const urlMap = await api.resolvePresignedUrls(auth, devinId, changeKeys);
    const changeIndex: any[] = [];

    await api.runPool(changes, downloadConcurrency(), async (ch) => {
      const info = urlMap.get(ch.contentsKey);
      if (!info) {
        changeIndex.push({ path: ch.path, error: 'no presigned url' });
        return;
      }
      try {
        const data = await api.downloadFileWithRetry(info.url, info.headers);
        // Preserve directory structure under changes/
        const rel = ch.path.replace(/^[A-Za-z]:[\\/]/, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
        const parts = rel.split('/').map((p) => safeName(p, 60)).join('/');
        zip.addFile(`${base}/changes/${parts}`, data);
        changeIndex.push({ path: ch.path, size: data.length });
      } catch (e) {
        changeIndex.push({ path: ch.path, error: String(e) });
      }
    });
    zip.addFile(`${base}/changes/_index.json`, JSON.stringify(changeIndex, null, 2));
  }

  // 6. Export manifest
  zip.addFile(`${base}/EXPORT_MANIFEST.json`, JSON.stringify({
    devin_id: devinId,
    title,
    exported_at: new Date().toISOString(),
    events_count: events.length,
    conversation_turns: conversationTurns.length,
    cloud_files_count: allKeys.length,
    changes_count: changes.length,
    exporter: 'DAO Devin Export VSIX v1.3.2',
  }, null, 2));

  progress('打包 ZIP...', 10);
  return zip.toBuffer();
}
