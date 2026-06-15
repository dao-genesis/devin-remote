#!/usr/bin/env python3
"""
dao_export_all.py — 道法自然 · 一键导出全部对话数据与产出成果

用法:
  python dao_export_all.py --email EMAIL --password PASSWORD [--output DIR]
  python dao_export_all.py --accounts accounts.md [--output DIR] [--filter KEYWORD]
  python dao_export_all.py --token auth1_xxx --org org-xxx [--output DIR]

三种模式:
  1. 邮箱+密码 → 自动登录获取 token → 列出所有 session → 导出全部
  2. accounts.md 文件 → 批量登录所有账号 → 导出全部
  3. 直接提供 token + org → 跳过登录 → 导出

导出内容:
  - 每个 session 的完整对话事件流 (events.json)
  - 对话工作日志 (worklog.md) — 可读的 Markdown
  - 所有编辑过的文件快照 (cloud_files/)
  - 文件变更最终态 (changes/)
  - 会话元数据 (session_info.json, file_manifest.json)
  - 账号级汇总: secrets, playbooks, knowledge, git-connections

道法自然 · 无为而无不为
"""

import urllib.request, urllib.error, json, ssl, os, sys, time, re, socket
import hashlib, argparse, traceback, io, zlib, gzip, threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

DOWNLOAD_WORKERS = 16   # 并发下载线程数
PRESIGN_WORKERS = 6     # presigned-url 批量解析并发数
DOWNLOAD_RETRIES = 3    # 单文件下载重试次数

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# === SSL + 软适配代理 ===
# 代理策略（软编码，适配一切环境）：
#   --proxy URL  → 强制走指定代理
#   --no-proxy   → 强制直连
#   默认        → 自动检测系统/环境代理（Windows 注册表 + HTTPS_PROXY 等环境变量），有则用、无则直连
_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE

def setup_network(proxy=None, no_proxy=False):
    """软适配网络层：按用户环境自动选择直连/代理。"""
    if no_proxy:
        ph = urllib.request.ProxyHandler({})
        mode = "直连 (强制)"
    elif proxy:
        ph = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        mode = f"代理 {proxy}"
    else:
        detected = urllib.request.getproxies()  # 环境变量 + Windows 注册表自动检测
        ph = urllib.request.ProxyHandler(detected if detected else {})
        mode = f"自动检测到代理 {detected}" if detected else "直连 (未检测到代理)"
    opener = urllib.request.build_opener(ph, urllib.request.HTTPSHandler(context=_ctx))
    urllib.request.install_opener(opener)
    return mode

setup_network()  # 默认先装自动检测模式，main() 解析参数后可覆盖

# === Constants ===
LOGIN_URL = "https://windsurf.com/_devin-auth/password/login"
API_BASE = "https://app.devin.ai/api"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

EVENT_LABELS = {
    "initial_user_message": "用户(初始)",
    "user_message": "用户",
    "devin_message": "Devin",
    "devin_thoughts": "Devin思考",
    "status_update": "状态更新",
    "todo_update": "待办更新",
    "user_question_answered": "用户回答",
    "multi_edit_result": "文件操作",
    "shell_process_started": "执行命令",
    "shell_process_completed": "命令完成",
    "devin_suspended": "已暂停",
    "web_get_contents": "读取网页",
    "mcp_tool_call_started": "MCP调用开始",
    "mcp_tool_call": "MCP调用结果",
    "git_action": "Git操作",
    "browser_action": "浏览器操作",
    "file_action": "文件操作",
}

# ========== HTTP helpers ==========

def _headers(token=None, org=None, accept="application/json", ct=None):
    h = {"Accept": accept, "User-Agent": UA, "Accept-Encoding": "gzip"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if org:
        h["x-cog-org-id"] = org
    if ct:
        h["Content-Type"] = ct
    return h

def _read_body(resp):
    data = resp.read()
    if resp.headers.get("Content-Encoding", "") == "gzip":
        data = gzip.decompress(data)
    return data

def http_get(url, token=None, org=None, accept="application/json", timeout=40, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=_headers(token, org, accept))
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.status, _read_body(resp)
        except Exception as e:
            last = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last

def http_post(url, body, token=None, org=None, timeout=40, retries=2):
    data = json.dumps(body).encode("utf-8")
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url, data=data, method="POST",
                headers=_headers(token, org, ct="application/json"),
            )
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.status, _read_body(resp)
        except urllib.error.HTTPError:
            raise
        except Exception as e:
            last = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last

# ========== Auth ==========

def login(email, password):
    """Login via windsurf.com → return auth1 token."""
    print(f"  登录 {email} ...", flush=True)
    try:
        status, body = http_post(LOGIN_URL, {"email": email, "password": password}, timeout=30)
        d = json.loads(body)
        token = d.get("token") or d.get("access_token") or d.get("auth_token")
        if token:
            print(f"  ✓ 登录成功, token={token[:20]}...", flush=True)
            return token
        # Some responses put token in nested structure
        if "data" in d and isinstance(d["data"], dict):
            token = d["data"].get("token") or d["data"].get("access_token")
            if token:
                print(f"  ✓ 登录成功, token={token[:20]}...", flush=True)
                return token
        print(f"  ✗ 登录响应异常: {json.dumps(d, ensure_ascii=False)[:300]}")
        return None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else str(e)
        print(f"  ✗ 登录失败 HTTP {e.code}: {body[:300]}")
        return None
    except Exception as e:
        print(f"  ✗ 登录异常: {e}")
        return None

def get_org(token):
    """POST /api/users/post-auth → {orgId, orgName}"""
    try:
        status, body = http_post(f"{API_BASE}/users/post-auth", {}, token=token, timeout=20)
        d = json.loads(body)
        org_id = d.get("orgId") or d.get("org_id")
        org_name = d.get("orgName") or d.get("org_name") or ""
        if org_id:
            # Extract bare org id (remove "org-" prefix for v2sessions endpoint)
            bare = org_id.replace("org-", "") if org_id.startswith("org-") else org_id
            return org_id, bare, org_name
    except Exception as e:
        print(f"  ✗ 获取 org 失败: {e}")
    return None, None, None

# ========== Session listing ==========

def list_sessions(token, org_id, org_bare):
    """List all sessions for this org."""
    sessions = []
    # Try v2sessions endpoint
    url = f"{API_BASE}/org-{org_bare}/v2sessions"
    try:
        status, body = http_get(url, token=token, org=org_id, timeout=30)
        d = json.loads(body)
        result = d.get("result") or d.get("sessions") or d.get("data") or []
        if isinstance(result, list):
            sessions = result
            print(f"  ✓ v2sessions 返回 {len(sessions)} 个会话", flush=True)
    except Exception as e:
        print(f"  ⚠ v2sessions 失败: {e}, 尝试备用端点...", flush=True)

    # If v2sessions empty, try listing from /sessions
    if not sessions:
        try:
            url2 = f"{API_BASE}/sessions"
            status, body = http_get(url2, token=token, org=org_id, timeout=30)
            d = json.loads(body)
            sessions = d if isinstance(d, list) else d.get("result", [])
            print(f"  ✓ /sessions 返回 {len(sessions)} 个会话", flush=True)
        except Exception as e:
            print(f"  ✗ /sessions 也失败: {e}")

    return sessions

# ========== Event stream capture ==========

def capture_stream(devin_id, token, org_id, idle=8.0, hard=600.0, max_bytes=512_000_000):
    """Read SSE/ndjson event stream. Return merged events list.

    长对话优化: 大块读取(1MB) + 列表拼接(避免 O(n^2) bytes 累加) +
    更高的硬上限(默认10分钟/512MB), 并打印进度。
    """
    url = f"{API_BASE}/events/{devin_id}/stream"
    headers = _headers(token, org_id, "text/event-stream")
    headers.pop("Accept-Encoding", None)  # 流式响应不要 gzip, 便于增量读取
    req = urllib.request.Request(url, headers=headers)
    try:
        r = urllib.request.urlopen(req, timeout=30)
    except Exception as e:
        print(f"    stream open fail: {e}")
        return []

    try:
        r.fp.raw._sock.settimeout(idle)
    except Exception:
        pass

    parts = []
    total = 0
    t0 = time.time()
    last_report = t0
    while True:
        try:
            chunk = r.read(1048576)
        except socket.timeout:
            break
        except Exception:
            break
        if not chunk:
            break
        parts.append(chunk)
        total += len(chunk)
        now = time.time()
        if now - last_report > 5:
            print(f"    ...已接收 {total/1048576:.1f} MB ({now-t0:.0f}s)", flush=True)
            last_report = now
        if now - t0 > hard or total > max_bytes:
            print(f"    ⚠ 达到上限({total/1048576:.1f}MB/{now-t0:.0f}s), 截断流", flush=True)
            break
    buf = b"".join(parts)

    # Parse all concatenated JSON objects (stream sends sequential pages)
    dec = json.JSONDecoder()
    i = 0
    raw = buf.decode("utf-8", "replace")
    merged = {}
    order = []

    while i < len(raw):
        while i < len(raw) and raw[i] in " \r\n\t":
            i += 1
        if i >= len(raw):
            break
        try:
            obj, end = dec.raw_decode(raw, i)
            i = end
        except Exception:
            # Try SSE format: data: {...}
            line_end = raw.find('\n', i)
            if line_end == -1:
                break
            line = raw[i:line_end].strip()
            i = line_end + 1
            if line.startswith("data:"):
                data_str = line[5:].strip()
                if data_str and data_str != "[DONE]":
                    try:
                        obj = json.loads(data_str)
                    except Exception:
                        continue
                else:
                    continue
            else:
                continue

        if isinstance(obj, dict):
            if "result" in obj:
                for ev in obj["result"]:
                    eid = ev.get("event_id") or f"{ev.get('type','')}-{ev.get('timestamp','')}-{ev.get('created_at_ms','')}"
                    if eid not in merged:
                        merged[eid] = ev
                        order.append(eid)
            elif "type" in obj:
                # Single event
                eid = obj.get("event_id") or f"{obj.get('type','')}-{obj.get('timestamp','')}"
                if eid not in merged:
                    merged[eid] = obj
                    order.append(eid)

    evs = [merged[k] for k in order]
    try:
        evs.sort(key=lambda e: e.get("created_at_ms") or 0)
    except Exception:
        pass
    return evs

def capture_first_load(devin_id, token, org_id):
    """GET /api/events/first-load/devin-xxx → key events (~50-74)."""
    url = f"{API_BASE}/events/first-load/{devin_id}"
    try:
        status, body = http_get(url, token=token, org=org_id, timeout=30)
        d = json.loads(body)
        return d.get("result") or d.get("events") or (d if isinstance(d, list) else [])
    except Exception as e:
        print(f"    first-load fail: {e}")
        return []

# ========== File download ==========

def resolve_presigned(devin_id, keys, token, org_id, chunk=40):
    """Resolve S3 presigned URLs for file keys (批量并发解析)."""
    out = {}
    url = f"{API_BASE}/presigned-url/batch/{devin_id}"

    def one_batch(part):
        status, body = http_post(url, {"s3_key_list": part}, token=token, org=org_id, timeout=30)
        d = json.loads(body)
        return part, d.get("urls_list", []), d.get("headers_list", [])

    batches = [keys[i:i + chunk] for i in range(0, len(keys), chunk)]
    with ThreadPoolExecutor(max_workers=PRESIGN_WORKERS) as ex:
        futs = [ex.submit(one_batch, b) for b in batches]
        for fut in as_completed(futs):
            try:
                part, urls, hdrs = fut.result()
                for k, u, h in zip(part, urls, hdrs):
                    out[k] = (u, h or {})
            except Exception as e:
                print(f"    presigned batch fail: {e}")
    return out

def download_file(url, headers=None, timeout=60, retries=DOWNLOAD_RETRIES):
    """Download a single file with retries."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers or {})
            return urllib.request.urlopen(req, timeout=timeout).read()
        except Exception as e:
            last = e
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise last

def download_files_parallel(resolved, keys, save_fn, workers=None, label=""):
    """并发下载 resolved 中的所有 key, 通过 save_fn(key, data) 落盘。

    返回 (成功数, 失败列表)。卡死防护: 单文件超时+重试, 整体并发不被单文件阻塞。
    """
    if workers is None:
        workers = DOWNLOAD_WORKERS
    ok = 0
    failed = []
    lock = threading.Lock()
    total = sum(1 for k in keys if resolved.get(k, (None, None))[0])
    done = [0]

    def fetch(k):
        u, h = resolved.get(k, (None, None))
        if not u:
            return k, None, "no presigned url"
        try:
            return k, download_file(u, h, timeout=45), None
        except Exception as e:
            return k, None, str(e)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(fetch, k) for k in keys]
        for fut in as_completed(futs):
            k, data, err = fut.result()
            with lock:
                done[0] += 1
                if data is not None:
                    try:
                        save_fn(k, data)
                        ok += 1
                    except Exception as e:
                        failed.append((k, f"save: {e}"))
                elif err != "no presigned url":
                    failed.append((k, err))
                if done[0] % 25 == 0 or done[0] == total:
                    print(f"    {label}下载进度 {done[0]}/{total}", flush=True)
    return ok, failed

def deep_extract_keys(obj, out):
    """Recursively extract all contents_key values from events."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "contents_key" and isinstance(v, str) and v:
                out.add(v)
            else:
                deep_extract_keys(v, out)
    elif isinstance(obj, list):
        for v in obj:
            deep_extract_keys(v, out)

# ========== Worklog markdown generation ==========

def sanitize_path(p):
    p = p.replace("/", os.sep)
    p = re.sub(r'^[A-Za-z]:\\', '', p)
    p = p.replace("..", "_").strip(os.sep)
    return p or "unnamed"

def build_worklog_md(evs, session_info):
    """Generate a readable Markdown worklog from events."""
    lines = []
    sid = session_info.get("devin_id", "unknown")
    title = session_info.get("title", "")
    status = session_info.get("status", "")
    created = session_info.get("created_at", "")
    updated = session_info.get("updated_at", "")

    lines.append(f"# Devin 会话完整工作日志 · {sid}")
    lines.append("")
    lines.append(f"- **标题**: {title}")
    lines.append(f"- **状态**: {status}")
    lines.append(f"- **创建**: {created}  **更新**: {updated}")
    lines.append(f"- **事件总数**: {len(evs)}")
    lines.append("")
    lines.append("---")
    lines.append("")

    for e in evs:
        t = e.get("type", "")
        ts = (e.get("timestamp") or "")[:19].replace("T", " ")

        if t in ("initial_user_message", "user_message"):
            label = EVENT_LABELS.get(t, t)
            msg = e.get("message", "")
            lines.append(f"### 🧑 {label} · {ts}\n\n{msg}\n")

        elif t == "devin_message":
            msg = e.get("message", "")
            lines.append(f"### 🤖 Devin · {ts}\n\n{msg}\n")

        elif t == "devin_thoughts":
            dur = e.get("duration_seconds") or e.get("duration") or ""
            thoughts = e.get("thoughts") or e.get("message", "")
            lines.append(f"<details><summary>💭 Devin思考 · {ts} · {dur}s</summary>\n\n{thoughts}\n\n</details>\n")

        elif t == "status_update":
            st = e.get("status_enum") or e.get("enum") or e.get("status", "")
            msg = e.get("message") or e.get("reason", "")
            lines.append(f"`{ts}` ⚡ 状态: **{st}** — {msg}\n")

        elif t == "todo_update":
            items = e.get("todos") or e.get("items") or []
            lines.append(f"**✅ 待办更新** · {ts}")
            for it in items:
                st = it.get("status", "")
                mk = {"completed": "x", "in_progress": "~"}.get(st, " ")
                lines.append(f"- [{mk}] {it.get('content', '')}")
            lines.append("")

        elif t == "user_question_answered":
            ans = e.get("answer") or e.get("message", "")
            lines.append(f"`{ts}` 🧑 用户回答: {ans}\n")

        elif t == "multi_edit_result":
            for fu in (e.get("file_updates") or []):
                lines.append(f"`{ts}` 📝 {fu.get('action_type', 'edit')}: `{fu.get('file_path', '')}`")
            lines.append("")

        elif t in ("shell_process_started", "shell_process_completed"):
            cmd = e.get("command") or ""
            output = e.get("output") or ""
            if cmd:
                lines.append(f"`{ts}` ⌨ `{cmd[:500]}`")
                if output and t == "shell_process_completed":
                    lines.append(f"```\n{output[:2000]}\n```")
                lines.append("")

        elif t == "devin_suspended":
            reason = e.get("reason", "")
            lines.append(f"`{ts}` ⏸ 已暂停: {reason}\n")

        else:
            # Generic event
            msg = e.get("message") or e.get("description") or ""
            if msg:
                label = EVENT_LABELS.get(t, t)
                lines.append(f"`{ts}` [{label}] {str(msg)[:500]}\n")

    return "\n".join(lines)

# ========== Account-level data export ==========

def export_account_data(token, org_id, org_bare, output_dir):
    """Export ALL account-level data: secrets, playbooks, knowledge, org info, members, automations, etc."""
    account_dir = os.path.join(output_dir, "_account_data")
    os.makedirs(account_dir, exist_ok=True)

    endpoints = {
        "secrets": f"{API_BASE}/org-{org_bare}/secrets",
        "playbooks": f"{API_BASE}/org-{org_bare}/playbooks",
        "knowledge": f"{API_BASE}/org-{org_bare}/learning/all",
        "git_connections": f"{API_BASE}/organizations/{org_id}/git-connections-metadata",
        "org_settings": f"{API_BASE}/organizations/{org_id}",
        "members": f"{API_BASE}/organizations/{org_id}/members",
        "automations": f"{API_BASE}/org-{org_bare}/automations",
        "schedules": f"{API_BASE}/org-{org_bare}/schedules",
        "snapshots": f"{API_BASE}/org-{org_bare}/snapshots",
    }

    for name, url in endpoints.items():
        try:
            status, body = http_get(url, token=token, org=org_id, timeout=30)
            d = json.loads(body)
            path = os.path.join(account_dir, f"{name}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=2)
            if isinstance(d, list):
                count = len(d)
            elif isinstance(d, dict):
                for k in ('result', 'data', 'items', 'learnings'):
                    if k in d and isinstance(d[k], list):
                        count = len(d[k]); break
                else:
                    count = len(d)
            print(f"  ✓ {name}: {count} 条记录", flush=True)
        except Exception as e:
            print(f"  ⚠ {name} 导出失败: {e}", flush=True)

# ========== Single session export ==========

def export_session(session, token, org_id, output_dir, index):
    """Export a single session: events + files + worklog."""
    devin_id = session.get("devin_id") or session.get("id") or ""
    if not devin_id:
        return None

    sid_short = devin_id.replace("devin-", "")[:8]
    title = (session.get("title") or "untitled")[:60]
    # Clean title for directory name
    safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f\n\r]', '_', title)[:30].rstrip('. ')
    folder_name = f"{index:03d}_{sid_short}_{safe_title}"
    base = os.path.join(output_dir, folder_name)

    # 断点续传: 已有完整 manifest 的会话直接跳过
    done_mark = os.path.join(base, "file_manifest.json")
    if os.path.exists(done_mark):
        print(f"\n[{folder_name}] 已导出, 跳过 (删除 file_manifest.json 可强制重导)", flush=True)
        return None

    cf_dir = os.path.join(base, "cloud_files")
    ch_dir = os.path.join(base, "changes")
    wl_dir = os.path.join(base, "worklog")
    for d in (cf_dir, ch_dir, wl_dir):
        os.makedirs(d, exist_ok=True)

    print(f"\n[{folder_name}]", flush=True)

    # 1. Session info
    try:
        status, body = http_get(f"{API_BASE}/sessions/{devin_id}", token=token, org=org_id, timeout=20)
        info = json.loads(body)
    except Exception as e:
        info = dict(session)
        info["_fetch_error"] = str(e)
    with open(os.path.join(base, "session_info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    # 2. Capture event stream
    print(f"  捕获事件流...", flush=True)
    evs = capture_stream(devin_id, token, org_id, idle=10, hard=600)

    # If stream returned few events, supplement with first-load
    if len(evs) < 20:
        print(f"  事件较少({len(evs)}), 补充 first-load...", flush=True)
        fl_evs = capture_first_load(devin_id, token, org_id)
        # Merge
        existing_ids = {e.get("event_id") for e in evs if e.get("event_id")}
        for e in fl_evs:
            eid = e.get("event_id")
            if eid and eid not in existing_ids:
                evs.append(e)
                existing_ids.add(eid)
        try:
            evs.sort(key=lambda e: e.get("created_at_ms") or 0)
        except Exception:
            pass

    print(f"  事件总数: {len(evs)}", flush=True)

    # Save raw events
    with open(os.path.join(wl_dir, "events.json"), "w", encoding="utf-8") as f:
        json.dump({"result": evs, "count": len(evs)}, f, ensure_ascii=False)

    # 3. Generate worklog markdown
    md = build_worklog_md(evs, info)
    with open(os.path.join(wl_dir, "worklog.md"), "w", encoding="utf-8") as f:
        f.write(md)

    # 4. Extract file keys and download
    keys = set()
    deep_extract_keys(evs, keys)
    keys = sorted(keys)

    # Track file updates
    fu_all = []
    latest = {}  # path -> (ts, key, action)
    for e in evs:
        ts = e.get("timestamp", "")
        for fu in (e.get("file_updates") or []):
            p = fu.get("file_path")
            k = fu.get("contents_key")
            a = fu.get("action_type")
            fu_all.append({"ts": ts, "action": a, "path": p, "key": k})
            if p and k:
                if p not in latest or ts > latest[p][0]:
                    latest[p] = (ts, k, a)

    print(f"  文件更新: {len(fu_all)}, 不同key: {len(keys)}", flush=True)

    keymap = {}
    if keys:
        resolved = resolve_presigned(devin_id, keys, token, org_id, chunk=40)

        def save(k, data):
            name = k.split("/")[-1]
            with open(os.path.join(cf_dir, name), "wb") as f:
                f.write(data)
            keymap[k] = {"saved": os.path.join("cloud_files", name), "bytes": len(data)}

        dl_ok, dl_failed = download_files_parallel(resolved, keys, save)
        print(f"  下载: {dl_ok} 成功, {len(dl_failed)} 失败", flush=True)
        for k, err in dl_failed[:5]:
            print(f"    ✗ {k[-40:]}: {err[:80]}", flush=True)

    # 5. Write final content per changed path into changes/
    changed = []
    for p, (ts, k, a) in latest.items():
        if a not in ("create", "edit", "write", "overwrite", "str_replace", "insert", "append"):
            continue
        info_k = keymap.get(k)
        if not info_k:
            continue
        src = os.path.join(base, info_k["saved"])
        rel = sanitize_path(p)
        dst = os.path.join(ch_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        try:
            with open(src, "rb") as sf:
                content = sf.read()
            with open(dst, "wb") as df:
                df.write(content)
            changed.append({"path": p, "action": a, "ts": ts, "saved": os.path.join("changes", rel)})
        except Exception as e:
            pass

    print(f"  变更文件: {len(changed)}", flush=True)

    # 6. File manifest
    manifest = {
        "file_updates": fu_all,
        "keymap": keymap,
        "changed_final": changed,
    }
    with open(os.path.join(base, "file_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    return {
        "folder": folder_name,
        "devin_id": devin_id,
        "title": info.get("title", ""),
        "status": info.get("status", ""),
        "events": len(evs),
        "file_updates": len(fu_all),
        "keys": len(keys),
        "downloaded": len(keymap),
        "changed_files": len(changed),
    }

# ========== Main export orchestrator ==========

def export_all(token, org_id, org_bare, org_name, output_dir, session_filter=None):
    """Export everything for one account."""
    print(f"\n{'='*60}", flush=True)
    print(f"导出账号: {org_name} ({org_id})", flush=True)
    print(f"输出目录: {output_dir}", flush=True)
    print(f"{'='*60}", flush=True)

    os.makedirs(output_dir, exist_ok=True)

    # Account-level data
    print("\n[1/3] 导出账号级数据 (secrets/playbooks/knowledge)...", flush=True)
    export_account_data(token, org_id, org_bare, output_dir)

    # List sessions
    print("\n[2/3] 列出所有会话...", flush=True)
    sessions = list_sessions(token, org_id, org_bare)

    if session_filter:
        before = len(sessions)
        sessions = [s for s in sessions if session_filter.lower() in json.dumps(s, ensure_ascii=False).lower()]
        print(f"  过滤: {before} → {len(sessions)} 个会话 (关键词: {session_filter})", flush=True)

    # Save session list
    with open(os.path.join(output_dir, "_sessions_list.json"), "w", encoding="utf-8") as f:
        json.dump(sessions, f, ensure_ascii=False, indent=2)

    # Export each session
    print(f"\n[3/3] 导出 {len(sessions)} 个会话的完整数据...", flush=True)
    summary = {}
    for i, sess in enumerate(sessions):
        try:
            result = export_session(sess, token, org_id, output_dir, i + 1)
            if result:
                summary[result["folder"]] = result
        except Exception as e:
            sid = (sess.get("devin_id") or "?")[:16]
            print(f"  ✗ 会话 {sid} 导出异常: {e}", flush=True)
            traceback.print_exc()

    # Write summary
    with open(os.path.join(output_dir, "_export_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # Generate summary README
    readme_lines = [
        f"# DAO Export Summary — {org_name}",
        f"",
        f"- **Org ID**: {org_id}",
        f"- **导出时间**: {datetime.now().isoformat()}",
        f"- **会话总数**: {len(sessions)}",
        f"- **成功导出**: {len(summary)}",
        f"",
        f"## 会话列表",
        f"",
        f"| # | Session ID | 标题 | 状态 | 事件 | 文件 | 变更 |",
        f"|---|---|---|---|---|---|---|",
    ]
    for folder, info in sorted(summary.items()):
        readme_lines.append(
            f"| {info.get('folder','')} | {info.get('devin_id','')[:20]} | "
            f"{info.get('title','')[:40]} | {info.get('status','')} | "
            f"{info.get('events',0)} | {info.get('downloaded',0)} | "
            f"{info.get('changed_files',0)} |"
        )
    readme_lines.extend(["", "---", "道法自然 · 无为而无不为"])

    with open(os.path.join(output_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(readme_lines))

    print(f"\n{'='*60}", flush=True)
    print(f"✓ 导出完成! {len(summary)}/{len(sessions)} 个会话", flush=True)
    print(f"  输出: {output_dir}", flush=True)
    print(f"{'='*60}", flush=True)

    return summary

# ========== Accounts file parser ==========

def parse_accounts_file(path):
    """Parse accounts.md: each line = 'email:password' or 'email password'."""
    accounts = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if " " in line:
                parts = line.split()
            elif ":" in line:
                parts = line.split(":", 1)
            else:
                continue
            if len(parts) >= 2 and "@" in parts[0]:
                accounts.append((parts[0].strip(), parts[1].strip()))
    return accounts

# ========== CLI ==========

def main():
    global DOWNLOAD_WORKERS
    parser = argparse.ArgumentParser(
        description="道法自然 · 一键导出 Devin 全部对话数据与产出成果",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 单账号导出
  python dao_export_all.py --email user@gmail.com --password mypass

  # 批量账号导出
  python dao_export_all.py --accounts C:\\path\\to\\accounts.md

  # 直接用 token
  python dao_export_all.py --token auth1_xxx --org org-xxx

  # 过滤特定会话
  python dao_export_all.py --email user@gmail.com --password mypass --filter "proxy"

道法自然 · 无为而无不为
        """,
    )
    parser.add_argument("--email", help="登录邮箱")
    parser.add_argument("--password", help="登录密码")
    parser.add_argument("--accounts", help="accounts.md 文件路径 (批量模式)")
    parser.add_argument("--token", help="直接提供 auth1 token (跳过登录)")
    parser.add_argument("--org", help="直接提供 org ID")
    parser.add_argument("--output", default="dao_export", help="输出目录 (默认: dao_export)")
    parser.add_argument("--filter", help="过滤会话关键词")
    parser.add_argument("--max-sessions", type=int, default=0, help="最大导出会话数 (0=全部)")
    parser.add_argument("--workers", type=int, default=DOWNLOAD_WORKERS, help=f"并发下载线程数 (默认 {DOWNLOAD_WORKERS})")
    parser.add_argument("--proxy", help="强制使用代理 (如 http://127.0.0.1:7890)；留空自动检测系统/环境代理")
    parser.add_argument("--no-proxy", action="store_true", help="强制直连，忽略一切代理")

    args = parser.parse_args()

    mode = setup_network(args.proxy, args.no_proxy)
    print(f"网络模式: {mode}", flush=True)

    DOWNLOAD_WORKERS = max(1, args.workers)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    if args.token and args.org:
        # Mode 3: Direct token
        org_id = args.org
        org_bare = org_id.replace("org-", "") if org_id.startswith("org-") else org_id
        out = os.path.join(args.output, f"direct_{timestamp}")
        export_all(args.token, org_id, org_bare, "direct", out, args.filter)

    elif args.email and args.password:
        # Mode 1: Single account
        token = login(args.email, args.password)
        if not token:
            print("登录失败, 退出。")
            sys.exit(1)
        org_id, org_bare, org_name = get_org(token)
        if not org_id:
            print("获取 org 失败, 退出。")
            sys.exit(1)
        safe_email = args.email.split("@")[0]
        out = os.path.join(args.output, f"{safe_email}_{timestamp}")
        export_all(token, org_id, org_bare, org_name or safe_email, out, args.filter)

    elif args.accounts:
        # Mode 2: Batch accounts
        if not os.path.exists(args.accounts):
            print(f"文件不存在: {args.accounts}")
            sys.exit(1)
        accounts = parse_accounts_file(args.accounts)
        print(f"读取到 {len(accounts)} 个账号", flush=True)

        for email, password in accounts:
            try:
                token = login(email, password)
                if not token:
                    continue
                org_id, org_bare, org_name = get_org(token)
                if not org_id:
                    print(f"  {email}: 获取 org 失败, 跳过")
                    continue
                safe_email = email.split("@")[0]
                out = os.path.join(args.output, f"{safe_email}_{timestamp}")
                export_all(token, org_id, org_bare, org_name or safe_email, out, args.filter)
            except Exception as e:
                print(f"  {email}: 导出异常 {e}")
                traceback.print_exc()

    else:
        parser.print_help()
        print("\n错误: 请提供 --email/--password 或 --accounts 或 --token/--org")
        sys.exit(1)

if __name__ == "__main__":
    main()
