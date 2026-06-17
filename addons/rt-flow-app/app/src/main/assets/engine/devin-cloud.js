"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// devin-cloud.js · 手机版 Devin Cloud / Git / Knowledge 全功能 (复刻桌面 extension.ts)
//   P3 会话: 列表(v2sessions) / 详情 / 事件流深提取 / 对话·工作日志 MD / 删除 / 备份
//   P4 集成: Secret / Knowledge / Playbook 注入与列举 + GitHub PAT 连接 + Git 连接盘点
//   全部经 DaoCore.httpReq (原生桥, auth1 直读 app.devin.ai/api) → 隔隧道可热修。
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  var C = root.DaoCore;
  if (!C) { console.error("devin-cloud: DaoCore 未加载"); return; }
  var APP = C.APP || "https://app.devin.ai";
  function bare(orgId) { return String(orgId || "").replace(/^org-/, ""); }
  function H(acc) { return { Authorization: "Bearer " + acc.auth1, "x-cog-org-id": acc.orgId }; }
  function errOf(r) {
    if (!r) return "no response";
    if (r.status === 0) return "connect failed: " + (r.error || r.text || "unknown");
    var d = r.json && (r.json.detail || r.json.error || r.json.message);
    return "HTTP " + r.status + (d ? ": " + (typeof d === "string" ? d : JSON.stringify(d)) : (r.text ? ": " + String(r.text).slice(0, 160) : ""));
  }
  async function jget(url, acc) { return await C.devinJsonGet(url, H(acc)); }
  async function jpost(url, acc, body) { return await C.devinJsonPost(url, H(acc), body); }
  async function reqRaw(method, url, acc) {
    var res = await C.httpReq(method, url, H(acc), "");
    var j = null; try { j = JSON.parse(res.text || ""); } catch (e) {}
    return { status: res.status || 0, json: j, text: res.text || "", error: res.error };
  }

  // ── P3 会话列表 / 详情 / 事件流 ────────────────────────────────────────────
  async function listSessions(acc, limit) {
    if (!acc || !acc.auth1 || !acc.orgId) return { ok: false, error: "需先登录(auth1)" };
    var url = APP + "/api/org-" + bare(acc.orgId) + "/v2sessions";
    if (limit) url += "?limit=" + limit;
    var last = null;
    for (var i = 0; i < 3; i++) {
      var r = await jget(url, acc); last = r;
      if (r.status === 200) {
        var j = r.json || {};
        var arr = Array.isArray(j.result) ? j.result : (Array.isArray(j.sessions) ? j.sessions : (Array.isArray(j) ? j : []));
        return { ok: true, sessions: arr };
      }
      if (r.status && r.status !== 0 && r.status !== 502 && r.status !== 503 && r.status !== 504) break;
      await new Promise(function (k) { setTimeout(k, 600); });
    }
    return { ok: false, status: last && last.status, error: errOf(last) };
  }
  async function sessionDetail(acc, sid) {
    var r = await jget(APP + "/api/sessions/" + sid, acc);
    if (r.status === 200) return { ok: true, session: r.json };
    return { ok: false, status: r.status, error: errOf(r) };
  }
  async function sessionMessages(acc, sid) {
    var r = await jget(APP + "/api/sessions/" + sid + "/messages", acc);
    if (r.status === 200) { var j = r.json || {}; return { ok: true, messages: Array.isArray(j.messages) ? j.messages : (Array.isArray(j) ? j : []) }; }
    return { ok: true, messages: [] };
  }

  // 事件流 (SSE/ndjson) → 有序去重事件 (会话全息真源)
  async function sessionEvents(acc, sid) {
    var url = APP + "/api/events/" + sid + "/stream";
    var headers = Object.assign(H(acc), { Accept: "text/event-stream" });
    var raw = "";
    for (var a = 0; a < 3; a++) {
      var res = await C.httpReq("GET", url, headers, "");
      if (res.status === 200 && typeof res.text === "string") { raw = res.text; break; }
      if (a < 2) await new Promise(function (k) { setTimeout(k, 1500 * (a + 1)); });
    }
    if (!raw) return { ok: false, events: [] };
    var merged = new Map();
    function add(ev) { if (!ev || !ev.type) return; var id = ev.event_id || (ev.type + "-" + ev.timestamp + "-" + ev.created_at_ms); if (!merged.has(id)) merged.set(id, ev); }
    var i = 0;
    while (i < raw.length) {
      while (i < raw.length && " \r\n\t".indexOf(raw[i]) >= 0) i++;
      if (i >= raw.length) break;
      if (raw[i] === "{") {
        var depth = 0, j = i, inStr = false, esc = false;
        for (; j < raw.length; j++) {
          var ch = raw[j];
          if (esc) { esc = false; continue; }
          if (ch === "\\" && inStr) { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === "{") depth++;
          if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
        }
        try { var o = JSON.parse(raw.slice(i, j)); if (o.result && Array.isArray(o.result)) o.result.forEach(add); else if (o.type) add(o); } catch (e) {}
        i = j;
      } else {
        var le = raw.indexOf("\n", i); var end = le === -1 ? raw.length : le;
        var line = raw.slice(i, end).trim(); i = end + 1;
        if (line.indexOf("data:") === 0) { var ds = line.slice(5).trim(); if (ds && ds !== "[DONE]") { try { var o2 = JSON.parse(ds); if (o2.result && Array.isArray(o2.result)) o2.result.forEach(add); else if (o2.type) add(o2); } catch (e) {} } }
      }
    }
    var events = Array.from(merged.values());
    events.sort(function (x, y) { return (x.created_at_ms || 0) - (y.created_at_ms || 0); });
    return { ok: true, events: events };
  }

  // ── MD 构建 (对话 / 工作日志) ──────────────────────────────────────────────
  // 与桌面 dao-vsix (core/dao-vsix/rtflow/devin_cloud.js) 的 classifyEvent /
  // buildConversationMd 完全对齐 → 手机版导出 = 电脑版全量, 四类气泡无缺。
  function evTs(ev) { var ms = ev.created_at_ms || (ev.timestamp ? Date.parse(ev.timestamp) : 0); return ms ? new Date(ms).toISOString() : ""; }
  function msgText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(msgText).filter(Boolean).join("\n");
    if (typeof v === "object") { if (typeof v.text === "string") return v.text; if (typeof v.message === "string") return v.message; if (v.content != null) return msgText(v.content); return JSON.stringify(v, null, 2); }
    return String(v);
  }
  function asText(v) { if (v == null) return ""; if (typeof v === "string") return v; return JSON.stringify(v, null, 2); }
  function clip(s, m) { return s.length > m ? s.slice(0, m) + "\n...[truncated]" : s; }
  var TODO_MARK = { completed: "[x]", in_progress: "[~]", pending: "[ ]", cancelled: "[-]" };
  var SKIP = { terminal_update: 1, is_typing: 1, context_growth_update: 1, iteration_checkpoint: 1, acu_consumption_at_last_user_interaction: 1, rules_injected: 1, shell_process_completed_background: 1 };

  function userAnswerText(ev) {
    var answers = ev.answers || [];
    return answers.map(function (a) {
      if (!a) return "";
      if (a.other_text) return a.other_text;
      if (Array.isArray(a.selected)) return a.selected.join("; ");
      if (typeof a.text === "string") return a.text;
      return "";
    }).filter(Boolean).join("\n");
  }

  // 事件归类 → 四类气泡 (👤用户 / 🤖Devin / 💭思考 / 🔧工具) · 移植自桌面 classifyEvent
  function classifyEvent(ev) {
    if (!ev || typeof ev !== "object") return null;
    var t = ev.type;
    switch (t) {
      case "initial_user_message":
      case "user_message":
        return { kind: "user", role: "用户", text: msgText(ev.message).replace(/^User:\s*/, "") };
      case "user_question_answered": {
        var txt = userAnswerText(ev);
        return txt ? { kind: "user", role: "用户(回答)", text: txt } : null;
      }
      case "devin_message":
        return { kind: "devin", role: "Devin", text: msgText(ev.message) };
      case "devin_thoughts": {
        var tt = msgText(ev.message);
        return tt ? { kind: "think", role: "思考", text: tt } : null;
      }
      case "one_line_thoughts": {
        var ot = ev.short || ev.summary || "";
        return ot ? { kind: "think", role: "思考", text: String(ot) } : null;
      }
      case "shell_process_started":
        return { kind: "tool", role: "🖥️ shell", detail: String(ev.command || "") };
      case "shell_process_completed":
      case "shell_process_completed_background": {
        var code = ev.exit_code == null ? "" : String(ev.exit_code);
        if (code && code !== "0") return { kind: "tool", role: "🖥️ shell · 退出码 " + code, detail: String(ev.output_trunc || "") };
        return null;
      }
      case "multi_edit_result": {
        var files = (ev.file_updates || []).map(function (f) { return (f.action_type || "edit") + " " + (f.file_path || ""); }).join("\n");
        return { kind: "tool", role: "✏️ 文件编辑", detail: files };
      }
      case "computer_use": {
        var acts = (ev.actions || []).map(function (a) { return a && a.action_type; }).filter(Boolean).join(", ");
        return { kind: "tool", role: "🖱️ 电脑操作", detail: acts };
      }
      case "mcp_tool_call": {
        var d = String(ev.tool_input || "");
        if (ev.output_trunc) d += (d ? "\n→ " : "") + String(ev.output_trunc);
        return { kind: "tool", role: "🔌 " + (ev.tool_name || ev.server || "mcp"), detail: d };
      }
      case "search_file_commands": {
        var cmds = (ev.search_commands || []).map(function (c) { return (c.command_name || "search") + ": " + (c.regex || c.query || "") + (c.path ? " @ " + c.path : ""); }).join("\n");
        return { kind: "tool", role: "🔍 文件搜索", detail: cmds };
      }
      case "web_search":
        return { kind: "tool", role: "🌐 网络搜索", detail: String(ev.query || "") + ((ev.result_urls || []).length ? "\n" + ev.result_urls.join("\n") : "") };
      case "web_get_contents":
        return { kind: "tool", role: "🌐 抓取网页", detail: (ev.urls || []).join("\n") };
      case "todo_update": {
        var todos = (ev.todos || []).map(function (td) { return "- [" + (td.status === "completed" ? "x" : " ") + "] " + (td.content || ""); }).join("\n");
        return { kind: "tool", role: "📋 待办更新", detail: todos };
      }
      default:
        return null;
    }
  }

  // 对话转录 (人看的·全量) — 与桌面 buildConversationMd 逐字对齐
  function buildConversation(title, sid, events) {
    var lines = ["# 对话: " + title, "", "- Session: `" + sid + "`", "- 事件数: " + events.length, ""];
    events.forEach(function (ev) {
      var c = classifyEvent(ev);
      if (!c) return;
      var ts = evTs(ev);
      if (c.kind === "user") lines.push("## 👤 " + c.role + "  " + ts, "", c.text || "", "");
      else if (c.kind === "devin") lines.push("## 🤖 Devin  " + ts, "", c.text || "", "");
      else if (c.kind === "think") lines.push("### 💭 思考  " + ts, "", "> " + String(c.text || "").replace(/\n/g, "\n> "), "");
      else if (c.kind === "tool") lines.push("### " + c.role + "  " + ts, "", c.detail ? "```\n" + String(c.detail).slice(0, 4000) + "\n```" : "", "");
    });
    return lines.join("\n");
  }
  function buildWorklog(title, sid, events) {
    var lines = ["# Worklog: " + title, "Session: " + sid, "Events: " + events.length, ""];
    events.forEach(function (ev) {
      var t = ev.type || "unknown"; if (SKIP[t]) return; var time = evTs(ev);
      switch (t) {
        case "user_message": lines.push("\n## 👤 USER [" + time + "]", msgText(ev.message)); break;
        case "devin_message": lines.push("\n## 🤖 DEVIN [" + time + "]", msgText(ev.message)); break;
        case "devin_thoughts": { var dur = ev.thinking_duration_ms ? " (" + Math.round(Number(ev.thinking_duration_ms) / 1000) + "s)" : ""; lines.push("\n### 💭 THINKING" + dur + " [" + time + "]", clip(msgText(ev.message), 4000)); break; }
        case "todo_update": { var td = ev.todos || []; if (td.length) { lines.push("\n### 📋 TODO [" + time + "]"); td.forEach(function (x) { lines.push("- " + (TODO_MARK[x.status || ""] || "[ ]") + " " + asText(x.content)); }); } break; }
        case "shell_process_started": { var dir = ev.starting_dir ? " (cwd: " + asText(ev.starting_dir) + ")" : ""; lines.push("\n### 💻 COMMAND" + dir + " [" + time + "]", "```bash", asText(ev.command), "```"); break; }
        case "shell_process_completed": { var out = asText(ev.output_trunc || ev.output); var code = ev.exit_code != null ? " (exit " + ev.exit_code + ")" : ""; if (out.trim()) lines.push("_output" + code + ":_", "```", clip(out, 3000), "```"); else if (code) lines.push("_command finished" + code + "_"); break; }
        case "multi_edit_result": case "file_edit": case "editor_action": { var fps = (ev.file_updates || []).map(function (f) { return f.file_path; }).filter(Boolean); if (fps.length) lines.push("\n### ✏️ FILE EDIT [" + time + "]: " + fps.join(", ")); break; }
        case "search_file_commands": { var cmds = (ev.search_commands || []).map(function (c) { return c.regex || c.path; }).filter(Boolean).join("; "); if (cmds) lines.push("\n### 🔍 SEARCH [" + time + "]: " + cmds.slice(0, 200)); break; }
        case "computer_use": { var kinds = (ev.actions || []).map(function (a) { return a.action_type; }).filter(Boolean).join(", "); lines.push("\n### 🖥️ COMPUTER [" + time + "]: " + (kinds || "action")); break; }
        case "browser_action": case "browse": lines.push("\n### 🌐 BROWSER [" + time + "]: " + asText(ev.url || ev.action || ev.message).slice(0, 200)); break;
        case "status_update": case "activity": lines.push("\n_[" + time + "] " + asText(ev.message || ev.status).slice(0, 300) + "_"); break;
        case "play": lines.push("\n--- [" + time + "] ▶️ RESUMED" + (ev.username ? " by " + asText(ev.username) : "") + " ---"); break;
        case "suspend": case "resume": lines.push("\n--- [" + time + "] " + t.toUpperCase() + " ---"); break;
        default: { var msg = ev.message || ev.content || ev.text; if (msg) lines.push("\n### [" + t + "] [" + time + "]", clip(msgText(msg), 2000)); }
      }
    });
    return lines.join("\n");
  }

  // 一键导出会话 MD (kind: conversation | worklog), 事件流为先, /messages 兜底
  async function exportSession(acc, sid, kind) {
    kind = kind || "conversation";
    var detail = await sessionDetail(acc, sid);
    var title = (detail.ok && detail.session && detail.session.title) || sid;
    var ev = await sessionEvents(acc, sid);
    if (ev.ok && ev.events.length) return { ok: true, title: title, md: kind === "worklog" ? buildWorklog(title, sid, ev.events) : buildConversation(title, sid, ev.events), events: ev.events.length };
    var msgs = await sessionMessages(acc, sid);
    var lines = ["# " + title, "", "> Session: " + sid, ""];
    (msgs.messages || []).forEach(function (m) {
      var role = m.role || m.type || "unknown"; var content = m.content || m.text || m.message || "";
      if (role === "user" || role === "human") lines.push("## 👤 User", "", asText(content), "");
      else if (role === "assistant" || role === "ai" || role === "devin") lines.push("## 🤖 Devin", "", asText(content), "");
      else lines.push("## " + role, "", asText(content), "");
    });
    return { ok: true, title: title, md: lines.join("\n"), events: 0, fallback: true };
  }

  async function deleteSession(acc, sid) {
    var cands = [APP + "/api/sessions/" + sid, APP + "/api/org-" + bare(acc.orgId) + "/sessions/" + sid];
    var last = 0;
    for (var i = 0; i < cands.length; i++) { var r = await reqRaw("DELETE", cands[i], acc); last = r.status; if (r.status === 200 || r.status === 204) return { ok: true, status: r.status }; }
    return { ok: false, status: last };
  }

  // 备份单号: 列出会话 → 逐条导出对话 MD → 汇总
  async function backupAccount(acc, kind) {
    var ls = await listSessions(acc, 200);
    if (!ls.ok) return { ok: false, error: ls.error };
    var out = [];
    for (var i = 0; i < ls.sessions.length; i++) {
      var s = ls.sessions[i]; var sid = s.devin_id || s.session_id || s.id; if (!sid) continue;
      try { var e = await exportSession(acc, sid, kind); out.push({ sid: sid, title: e.title, md: e.md }); } catch (er) {}
    }
    return { ok: true, count: out.length, sessions: out };
  }

  // ── P4 Secret / Knowledge / Playbook / Git ────────────────────────────────
  async function listSecrets(acc) { var r = await jget(APP + "/api/org-" + bare(acc.orgId) + "/secrets", acc); if (r.status === 200) { var j = r.json || {}; return { ok: true, secrets: Array.isArray(j) ? j : (j.secrets || []) }; } return { ok: false, error: errOf(r) }; }
  async function listKnowledge(acc) { var r = await jget(APP + "/api/org-" + bare(acc.orgId) + "/learning/all", acc); if (r.status === 200) { var j = r.json || {}; return { ok: true, learnings: Array.isArray(j.learnings) ? j.learnings : (Array.isArray(j) ? j : []) }; } return { ok: false, error: errOf(r) }; }
  async function listPlaybooks(acc) { var r = await jget(APP + "/api/org-" + bare(acc.orgId) + "/playbooks", acc); if (r.status === 200) { var j = r.json || {}; return { ok: true, playbooks: Array.isArray(j) ? j : (j.playbooks || []) }; } return { ok: false, error: errOf(r) }; }
  async function injectSecret(acc, name, value) { var r = await jpost(APP + "/api/org-" + bare(acc.orgId) + "/secrets", acc, { key: name, value: value, type: "key-value", sensitive: true, note: name }); return { ok: r.status === 200 || r.status === 201 || r.status === 409, existed: r.status === 409, error: (r.status >= 400 && r.status !== 409) ? errOf(r) : undefined }; }
  async function injectKnowledge(acc, name, body, trigger) { var r = await jpost(APP + "/api/org-" + bare(acc.orgId) + "/learning", acc, { name: name, body: body, trigger_description: trigger || "", pinned_repo: null, parent_folder_id: null, is_enabled: true }); return { ok: r.status === 200 || r.status === 201, error: r.status >= 400 ? errOf(r) : undefined }; }
  async function injectPlaybook(acc, title, body) { var r = await jpost(APP + "/api/org-" + bare(acc.orgId) + "/playbooks", acc, { title: title, body: body, status: "published", access: "team" }); return { ok: r.status === 200 || r.status === 201, error: r.status >= 400 ? errOf(r) : undefined }; }
  async function injectGitHubPAT(acc, pat) {
    var r = await jpost(APP + "/api/org-" + bare(acc.orgId) + "/integrations/github/pat", acc, { pat: pat });
    if (r.status === 200 || r.status === 201) return { ok: true, existed: false };
    if (r.status === 400 && r.text && r.text.indexOf("already registered") >= 0) return { ok: true, existed: true };
    return { ok: false, error: errOf(r) };
  }
  async function checkGit(acc) {
    var r = await jget(APP + "/api/organizations/" + acc.orgId + "/git-connections-metadata", acc);
    if (r.status === 200) { var d = r.json; var conns = Array.isArray(d) ? d : (d && d.connections ? d.connections : []); return { ok: true, connections: conns, count: conns.length }; }
    return { ok: false, connections: [], count: 0, error: errOf(r) };
  }

  // ── 会话创建 / 中停 / 归档 (复刻桌面 createSession/stopSession, 端点经桌面实跑确证) ──
  async function createSession(acc, prompt, opts) {
    opts = opts || {};
    if (!acc || !acc.auth1 || !acc.orgId) return { ok: false, error: "需先登录(auth1)" };
    var payload = { user_message: String(prompt || ""), prompt: String(prompt || "") };
    if (opts.title) payload.title = opts.title;
    if (opts.tags) payload.tags = opts.tags;
    if (opts.playbookId) payload.playbook_id = opts.playbookId;
    if (opts.repos) payload.repos = opts.repos;
    if (opts.sessionSecrets) payload.session_secrets = opts.sessionSecrets;
    var r = await jpost(APP + "/api/sessions", acc, payload);
    if (r.status === 200 || r.status === 201) { var j = r.json || {}; return { ok: true, devinId: j.devin_id || j.session_id || j.id, isNewSession: j.is_new_session, createdAt: j.created_at, raw: j }; }
    return { ok: false, status: r.status, error: errOf(r) };
  }
  async function archiveSession(acc, sid) { var r = await jpost(APP + "/api/sessions/" + sid + "/archive", acc, {}); return { ok: r.status >= 200 && r.status < 300, status: r.status }; }
  async function stopSession(acc, sid) {
    var cands = ["/sessions/" + sid + "/archive", "/sessions/" + sid + "/stop", "/sessions/" + sid + "/pause", "/sessions/" + sid + "/sleep", "/sessions/" + sid + "/cancel"];
    var tried = [];
    for (var i = 0; i < cands.length; i++) { var r = await jpost(APP + "/api" + cands[i], acc, {}); tried.push({ url: cands[i], status: r.status }); if (r.status >= 200 && r.status < 300) return { ok: true, stopped: true, endpoint: cands[i], status: r.status, tried: tried }; }
    return { ok: false, stopped: false, tried: tried, error: "无可用中停端点 (全部非 2xx)" };
  }

  // ── 删除接口全集 (水过无痕底层; 端点取自桌面真跑确证) ──────────────────────
  function okDelete(s) { return s === 200 || s === 202 || s === 204 || s === 404; }
  async function deleteKnowledge(acc, id) { var r = await reqRaw("DELETE", APP + "/api/org-" + bare(acc.orgId) + "/learning/" + id, acc); return { ok: okDelete(r.status), status: r.status }; }
  async function deletePlaybook(acc, id) {
    var r = await reqRaw("DELETE", APP + "/api/playbooks/" + id, acc);
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    var r2 = await reqRaw("DELETE", APP + "/api/org-" + bare(acc.orgId) + "/playbooks/" + id, acc);
    if (r2.status >= 200 && r2.status < 300) return { ok: true, status: r2.status };
    if (r.status === 404 && r2.status === 404) return { ok: true, status: 404 };
    return { ok: false, status: r.status };
  }
  async function deleteSecret(acc, idOrName) {
    var id = idOrName;
    if (!/^[a-z]+-/.test(String(idOrName))) {
      var list = await listSecrets(acc);
      var hit = (list.secrets || []).find(function (s) { return s.name === idOrName || s.id === idOrName; });
      if (!hit) return { ok: true, status: 404 };
      id = hit.id;
    }
    var r = await reqRaw("DELETE", APP + "/api/secrets/" + id, acc);
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    var r2 = await reqRaw("DELETE", APP + "/api/org-" + bare(acc.orgId) + "/secrets/" + id, acc);
    if (r2.status >= 200 && r2.status < 300) return { ok: true, status: r2.status };
    if (r.status === 404 && r2.status === 404) return { ok: true, status: 404 };
    return { ok: false, status: r.status };
  }

  // ── 单条消息额度上限 (On-demand / Message usage limit) ───────────────────
  //  GET  → max_credits (当前每条消息可用的 on-demand 美金上限)
  //  POST {max_credits} → 设定 (与官网 Settings·Usage&limits 同源, auth1 直写)
  async function getMessageLimit(acc) {
    if (!acc || !acc.auth1 || !acc.orgId) return { ok: false, error: "需先登录(auth1)" };
    var r = await jget(APP + "/api/org-" + bare(acc.orgId) + "/billing/usage/limits", acc);
    if (r.status === 200) { var j = r.json || {}; var v = (typeof j.max_credits === "number") ? j.max_credits : (typeof j.max_acu_limit === "number" ? j.max_acu_limit : null); return { ok: true, max: v, raw: j }; }
    return { ok: false, status: r.status, error: errOf(r) };
  }
  async function setMessageLimit(acc, maxCredits) {
    if (!acc || !acc.auth1 || !acc.orgId) return { ok: false, error: "需先登录(auth1)" };
    if (typeof maxCredits !== "number" || !isFinite(maxCredits)) return { ok: false, error: "maxCredits 须为数字" };
    var r = await jpost(APP + "/api/org-" + bare(acc.orgId) + "/billing/usage/limits", acc, { max_credits: maxCredits });
    return { ok: r.status === 200 || r.status === 201 || r.status === 204, status: r.status, error: r.status >= 400 ? errOf(r) : undefined };
  }

  // ── 集成盘点 (Git/密钥/知识库/剧本 一次拉齐) ──────────────────────────────
  async function listIntegrations(acc) {
    if (!acc || !acc.auth1 || !acc.orgId) return { ok: false, error: "需先登录(auth1)" };
    var git = await checkGit(acc), sec = await listSecrets(acc), kn = await listKnowledge(acc), pb = await listPlaybooks(acc);
    return {
      ok: true,
      git: { count: git.count || 0, connections: git.connections || [] },
      secrets: { count: (sec.secrets || []).length, list: sec.secrets || [] },
      knowledge: { count: (kn.learnings || []).length, list: kn.learnings || [] },
      playbooks: { count: (pb.playbooks || []).length, list: pb.playbooks || [] }
    };
  }

  // ── 水过无痕: 先全量备份(可选)→ 删全部知识库/密钥/剧本 + 归档全部对话 ──────────
  async function wipeAccount(acc, opts) {
    opts = opts || {};
    if (!opts.confirm) return { ok: false, error: "危险操作: 需 confirm:true (将删除该号全部知识库/密钥/剧本; archiveSessions:true 则一并归档对话)" };
    var report = { knowledge: 0, secrets: 0, playbooks: 0, archived: 0, fails: [] };
    if (opts.backupFirst) { try { var b = await backupAccount(acc, "conversation"); report.backup = b.count || 0; } catch (e) { if (!opts.force) return { ok: false, error: "备份失败, 已中止 (force:true 可跳过)" }; } }
    try { var kn = await listKnowledge(acc); var kl = kn.learnings || []; for (var i = 0; i < kl.length; i++) { var k = kl[i]; if (k.is_builtin || k.builtin) continue; var rr = await deleteKnowledge(acc, k.id); if (rr.ok) report.knowledge++; else report.fails.push("kn:" + k.id); } } catch (e) {}
    try { var sec = await listSecrets(acc); var sl = sec.secrets || []; for (var j = 0; j < sl.length; j++) { var s = sl[j]; var rs = await deleteSecret(acc, s.id || s.name); if (rs.ok) report.secrets++; else report.fails.push("sec:" + (s.id || s.name)); } } catch (e) {}
    try { var pb = await listPlaybooks(acc); var pl = pb.playbooks || []; for (var p = 0; p < pl.length; p++) { var rp = await deletePlaybook(acc, pl[p].id); if (rp.ok) report.playbooks++; else report.fails.push("pb:" + pl[p].id); } } catch (e) {}
    if (opts.archiveSessions) { try { var ls = await listSessions(acc, 200); var ss = ls.sessions || []; for (var q = 0; q < ss.length; q++) { var sid = ss[q].devin_id || ss[q].session_id || ss[q].id; if (!sid) continue; var ra = await archiveSession(acc, sid); if (ra.ok) report.archived++; } } catch (e) {} }
    return { ok: true, report: report };
  }

  // ── 会话产出文件 (下载ZIP全部包括文件夹) · 复刻桌面 extractAllKeys/mapKeysToPaths/resolvePresignedUrls ──
  // 事件流里每个产出文件都带 contents_key (+ file_path), 经 /api/presigned-url/batch 换直链 → 二进制下载。
  function extractAllKeys(events) {
    var keys = {};
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      for (var k in o) { if (!Object.prototype.hasOwnProperty.call(o, k)) continue; var v = o[k];
        if (k === "contents_key" && typeof v === "string" && v) keys[v] = 1; else walk(v); }
    })(events);
    return Object.keys(keys).sort();
  }
  function mapKeysToPaths(events) {
    var m = {};
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.contents_key && o.file_path) m[o.contents_key] = o.file_path;
      for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k]); }
    })(events);
    return m;
  }
  async function resolvePresignedUrls(acc, sid, keys) {
    var result = {};
    var CHUNK = 100;
    for (var i = 0; i < keys.length; i += CHUNK) {
      var batch = keys.slice(i, i + CHUNK);
      var r = await jpost(APP + "/api/presigned-url/batch/" + sid, acc, { s3_key_list: batch });
      if (r.status === 200 && r.json) {
        var urls = r.json.urls_list || [], hdrs = r.json.headers_list || [];
        for (var j = 0; j < batch.length; j++) if (urls[j]) result[batch[j]] = { url: urls[j], headers: hdrs[j] || {} };
      }
    }
    return result;
  }
  // 取回某会话全部产出文件 → [{path, file, b64, size}] (b64 = 二进制 base64, 供 ZIP 无损打包)
  async function collectSessionFiles(acc, sid, events, onProgress) {
    var ev = events;
    if (!ev) { var e = await sessionEvents(acc, sid); ev = (e.ok && e.events) || []; }
    var keys = extractAllKeys(ev);
    var keyToPath = mapKeysToPaths(ev);
    if (!keys.length) return { ok: true, files: [], index: [] };
    var urlMap = await resolvePresignedUrls(acc, sid, keys);
    var files = [], index = [], done = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i]; var info = urlMap[key];
      var path = keyToPath[key] || null;
      if (!info) { index.push({ key: key, path: path, error: "no presigned url" }); continue; }
      try {
        var res = await C.httpReqB64("GET", info.url, info.headers || {}, "");
        if (res && res.status >= 200 && res.status < 300 && typeof res.b64 === "string") {
          files.push({ path: path, key: key, b64: res.b64, size: res.size || 0 });
          index.push({ key: key, path: path, size: res.size || 0 });
        } else { index.push({ key: key, path: path, error: "HTTP " + (res && res.status) }); }
      } catch (er) { index.push({ key: key, path: path, error: String(er) }); }
      done++; if (onProgress) try { onProgress(done, keys.length); } catch (e2) {}
    }
    return { ok: true, files: files, index: index, total: keys.length };
  }

  // ── 纯 JS ZIP (STORE 存储法·零依赖·复刻桌面 ZipWriter 的可读结构: 对话md + 工作日志md + files/) ──
  //   桌面用 Node Buffer+zlib deflate; 手机 WebView 无 zlib, 改用 STORE(method 0) — 同样是合法 ZIP, 任意解压器可开。
  var _crcTab = (function () { var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = _crcTab[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(str == null ? "" : str));
    var u = unescape(encodeURIComponent(String(str == null ? "" : str))); var a = new Uint8Array(u.length); for (var i = 0; i < u.length; i++) a[i] = u.charCodeAt(i) & 0xFF; return a;
  }
  function b64ToBytes(b64) { var bin = atob(b64 || ""); var a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i) & 0xFF; return a; }
  function bytesToB64(bytes) { var bin = "", CH = 0x8000; for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(bin); }
  function _w16(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >>> 8) & 0xFF; }
  function _w32(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >>> 8) & 0xFF; a[o + 2] = (v >>> 16) & 0xFF; a[o + 3] = (v >>> 24) & 0xFF; }
  // entries: [{name, bytes:Uint8Array}] → Uint8Array(完整 zip)
  function buildZip(entries) {
    var locals = [], centrals = [], offset = 0, n = entries.length;
    for (var i = 0; i < n; i++) {
      var nameB = utf8Bytes(String(entries[i].name).replace(/\\/g, "/")), data = entries[i].bytes, crc = crc32(data);
      var lh = new Uint8Array(30 + nameB.length);
      _w32(lh, 0, 0x04034b50); _w16(lh, 4, 20); _w16(lh, 6, 0x0800); _w16(lh, 8, 0); _w16(lh, 10, 0); _w16(lh, 12, 0x21);
      _w32(lh, 14, crc); _w32(lh, 18, data.length); _w32(lh, 22, data.length); _w16(lh, 26, nameB.length); _w16(lh, 28, 0); lh.set(nameB, 30);
      locals.push(lh, data);
      var ch = new Uint8Array(46 + nameB.length);
      _w32(ch, 0, 0x02014b50); _w16(ch, 4, 20); _w16(ch, 6, 20); _w16(ch, 8, 0x0800); _w16(ch, 10, 0); _w16(ch, 12, 0); _w16(ch, 14, 0x21);
      _w32(ch, 16, crc); _w32(ch, 20, data.length); _w32(ch, 24, data.length); _w16(ch, 28, nameB.length);
      _w16(ch, 30, 0); _w16(ch, 32, 0); _w16(ch, 34, 0); _w16(ch, 36, 0); _w32(ch, 38, 0); _w32(ch, 42, offset); ch.set(nameB, 46);
      centrals.push(ch); offset += lh.length + data.length;
    }
    var centralStart = offset, centralSize = 0; centrals.forEach(function (c) { centralSize += c.length; });
    var eocd = new Uint8Array(22);
    _w32(eocd, 0, 0x06054b50); _w16(eocd, 4, 0); _w16(eocd, 6, 0); _w16(eocd, 8, n); _w16(eocd, 10, n); _w32(eocd, 12, centralSize); _w32(eocd, 16, centralStart); _w16(eocd, 20, 0);
    var out = new Uint8Array(offset + centralSize + 22), p = 0;
    locals.forEach(function (b) { out.set(b, p); p += b.length; });
    centrals.forEach(function (b) { out.set(b, p); p += b.length; });
    out.set(eocd, p);
    return out;
  }
  // 取某对话完整内容(对话md + 工作日志md + _meta.json + files/产出文件) → 打成单个 ZIP 的 base64 (含文件夹)。
  //   仅读历史, 不消耗额度; 额度耗尽账号亦可。复刻桌面「下载对话内容(ZIP)」的产物结构。
  async function exportSessionZip(acc, sid, onProgress) {
    var conv = await exportSession(acc, sid, "conversation");
    if (!conv || !conv.ok) return { ok: false, error: (conv && conv.error) || "对话导出失败" };
    var wl = null; try { wl = await exportSession(acc, sid, "worklog"); } catch (e) {}
    var ev = null; try { var er = await sessionEvents(acc, sid); ev = (er.ok && er.events) || []; } catch (e) {}
    var col = { files: [], index: [] };
    try { col = await collectSessionFiles(acc, sid, ev, onProgress); } catch (e) {}
    var title = conv.title || sid;
    var entries = [];
    entries.push({ name: "对话_人类可读.md", bytes: utf8Bytes(conv.md || conv.content || "") });
    if (wl && (wl.md || wl.content)) entries.push({ name: "工作日志.md", bytes: utf8Bytes(wl.md || wl.content) });
    entries.push({ name: "_meta.json", bytes: utf8Bytes(JSON.stringify({
      sessionId: sid, title: title, account: acc.email || acc.id, events: conv.events || 0,
      fileCount: (col.files || []).length, files: col.index || []
    }, null, 2)) });
    (col.files || []).forEach(function (f) {
      var rel = String(f.path || f.key || "file").replace(/^\/+/, "");
      entries.push({ name: "files/" + rel, bytes: b64ToBytes(f.b64 || "") });
    });
    return { ok: true, title: title, fileCount: (col.files || []).length, entries: entries.length, b64: bytesToB64(buildZip(entries)) };
  }

  root.DaoCloud = {
    buildZip: buildZip, bytesToB64: bytesToB64, utf8Bytes: utf8Bytes, exportSessionZip: exportSessionZip,
    listSessions: listSessions, sessionDetail: sessionDetail, sessionMessages: sessionMessages,
    sessionEvents: sessionEvents, exportSession: exportSession, deleteSession: deleteSession,
    extractAllKeys: extractAllKeys, mapKeysToPaths: mapKeysToPaths,
    resolvePresignedUrls: resolvePresignedUrls, collectSessionFiles: collectSessionFiles,
    backupAccount: backupAccount, buildConversation: buildConversation, buildWorklog: buildWorklog,
    listSecrets: listSecrets, listKnowledge: listKnowledge, listPlaybooks: listPlaybooks,
    injectSecret: injectSecret, injectKnowledge: injectKnowledge, injectPlaybook: injectPlaybook,
    injectGitHubPAT: injectGitHubPAT, checkGit: checkGit,
    createSession: createSession, archiveSession: archiveSession, stopSession: stopSession,
    deleteKnowledge: deleteKnowledge, deletePlaybook: deletePlaybook, deleteSecret: deleteSecret,
    listIntegrations: listIntegrations, wipeAccount: wipeAccount,
    getMessageLimit: getMessageLimit, setMessageLimit: setMessageLimit
  };
})(window);
