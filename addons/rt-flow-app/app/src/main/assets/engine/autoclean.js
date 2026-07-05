"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// 归零账号 备份→清理→移出库 · 共用引擎 (道法自然·正本清源)
//   此逻辑过去只内联在 switch.html(切号板)且由可见性门控的额度心跳间接驱动:
//   用户不在切号板/切后台 → 心跳冻结 → 自动清理/归零移出**从不触发**(用户实测全失效)。
//   今抽出为共用模块: 切号板(可见时)与常驻后台引擎(engine.html·永不休眠)同源同一套
//   备份/清理/移出流水线 → 无论切号板在不在前台, 归零账号都会被 备份→清痕→移出库。
//
//   机制不变(与原 switch.html 内联版逐字对齐):
//   ① 自动备份始终增量备份; 备份=每对话「完整文件夹ZIP」+清单。
//   ② 清理=对话级: 仅「账号额度<阈值 且 该对话24h内无更新」的对话才自动清理。
//   ③ 清理=真删(水过无痕), 且必须先验证该对话已完整备份。
//   ④ 仅当用户勾选「归零移出库」且额度归零、且**全部对话都已 24h 无更新**, 才备份后移出。
//
//   deps (依赖注入·两端各自供给):
//     N            原生桥 (vaultReadBackup/vaultSaveBackup/vaultSaveBackupB64/vaultDeleteBackup)
//     DaoCloud     云接口 (listSessions/exportSessionZip/exportSession/buildAccessGuide/listIntegrations/purgeSession)
//     cfg(k,d)     配置读取 (rtflow.cfg.*)
//     hasAuth(a)   是否已登录
//     ovDollars(q) 美金余额
//     loadAcc/saveAcc  账号库读写
//     autoDlBlocked()  计费网络下自动重下载是否暂缓
//     onRemoved(a) 账号移出后回调 (UI 清理/大字提醒; 可空)
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  function create(deps) {
    var N = deps.N, DaoCloud = deps.DaoCloud;
    var cfg = deps.cfg, hasAuth = deps.hasAuth, ovDollars = deps.ovDollars;
    var loadAcc = deps.loadAcc, saveAcc = deps.saveAcc;
    var autoDlBlocked = deps.autoDlBlocked || function () { return false; };
    var onRemoved = deps.onRemoved || function () {};
    var relogin = deps.relogin || null;      // 可选: async(a)→重登成功返回最新账号对象, 失败返回 null (auth 过期自愈)
    var _reloginTs = {};                     // id → 上次尝试重登时间 (10min 节流·防对失效号每轮打登录接口)
    async function _tryRelogin(a) {
      if (!relogin || !a || !a.email || !a.password) return null;
      if (Date.now() - (_reloginTs[a.id] || 0) < 600000) return null;
      _reloginTs[a.id] = Date.now();
      try { var na = await relogin(a); if (na && hasAuth(na)) return na; } catch (e) {}
      return null;
    }
    var _cleanTs = {};                     // id → 上次清理时间 (节流)
    var CLEAN_STALE_MS = 24 * 3600 * 1000; // 24h 无更新才允许清理
    // 终态会话(内容已定格·无人在跑): 平台会周期性触碰其 updated_at, 不能据此判「活跃」
    var _TERM_ST = { suspended: 1, expired: 1, stopped: 1, finished: 1, archived: 1, interrupted: 1, deleted: 1 };
    function _dormant(s) { var st = String((s && (s.status_enum || s.status)) || "").toLowerCase(); return !!_TERM_ST[st]; }

    function _acctFolder(a) { return String((a && (a.email || a.id)) || "acc").split("@")[0].replace(/[^a-zA-Z0-9_\-]/g, "_") || "acc"; }
    function loadBackupManifest(a) {
      try { if (N.vaultReadBackup) { var t = N.vaultReadBackup(_acctFolder(a), "manifest.json"); if (t) { var m = JSON.parse(t); if (m && typeof m === "object") { if (!m.sessions) m.sessions = {}; return m; } } } } catch (e) {}
      return { account: { id: a.id, email: a.email || "", orgId: a.orgId || "" }, updatedAt: 0, sessions: {} };
    }
    function saveBackupManifest(a, man) {
      man.account = { id: a.id, email: a.email || "", orgId: a.orgId || "" }; man.updatedAt = Date.now();
      try { if (N.vaultSaveBackup) return !!N.vaultSaveBackup(_acctFolder(a), "manifest.json", JSON.stringify(man)); } catch (e) {}
      return false;
    }
    // 增量备份单条对话: 名称/更新时间未变且已备份 → 跳过; 否则备份「单文件整包 sess-<sid>.zip」并更新清单。
    //   增量同步本源: 能跳过的前提是列表真的带了更新时间(ts>0) —— 无时间字段的会话无从判新旧,
    //   一律重新备份(宁多备不漏备), 否则 ZIP 永远停在首次备份的旧内容。
    async function backupSessionFull(a, s, man) {
      var sid = s.devin_id || s.session_id || s.id; if (!sid) return { skipped: true };
      var title = s.title || s.name || s.prompt || sid; var ts = DaoCloud.sessTs(s) || 0;
      var prev = man.sessions[sid];
      if (prev && prev.backedUpAt && !prev.deleted && ts > 0 && prev.ts === ts && prev.title === title && prev.complete !== false) {
        if (!prev.guide && !prev.zip) { try { var g0 = DaoCloud.buildAccessGuide(a, sid, title); if (g0 && N.vaultSaveBackup && N.vaultSaveBackup(_acctFolder(a), "指引-" + sid + ".md", g0)) prev.guide = "指引-" + sid + ".md"; } catch (e) {} }
        return { skipped: true, sid: sid };
      }
      var folder = _acctFolder(a); var convOk = false, zipOk = false, guideOk = false, hasFiles = 0, evCnt = 0;
      try {
        var z = await DaoCloud.exportSessionZip(a, sid);
        if (z && z.ok && z.b64) { evCnt = z.events || 0; hasFiles = z.fileCount || 0; zipOk = !!(N.vaultSaveBackupB64 && N.vaultSaveBackupB64(folder, "sess-" + sid + ".zip", z.b64)); }
      } catch (e) {}
      if (zipOk) {
        try { if (N.vaultDeleteBackup) { N.vaultDeleteBackup(folder, "conv-" + sid + ".md"); N.vaultDeleteBackup(folder, "指引-" + sid + ".md"); } } catch (e) {}
      } else {
        try {
          var c = await DaoCloud.exportSession(a, sid, "conversation");
          if (c && c.ok && c.fallback) { try { var c2 = await DaoCloud.exportSession(a, sid, "conversation"); if (c2 && c2.ok && !c2.fallback) c = c2; } catch (e) {} }
          if (c && c.ok) { evCnt = c.events || 0; convOk = !!(N.vaultSaveBackup && N.vaultSaveBackup(folder, "conv-" + sid + ".md", c.md || c.content || "")); }
        } catch (e) {}
        try { var g = DaoCloud.buildAccessGuide(a, sid, title); if (g) guideOk = !!(N.vaultSaveBackup && N.vaultSaveBackup(folder, "指引-" + sid + ".md", g)); } catch (e) {}
      }
      if (!convOk && !zipOk) return { failed: true, sid: sid };
      man.sessions[sid] = { sid: sid, title: title, ts: ts, backedUpAt: Date.now(), md: convOk ? ("conv-" + sid + ".md") : null, guide: guideOk ? ("指引-" + sid + ".md") : null, zip: zipOk ? ("sess-" + sid + ".zip") : null, hasFiles: hasFiles, events: evCnt, complete: (evCnt > 0), deleted: false };
      return { backedUp: true, sid: sid };
    }
    // 账号全量备份(增量·完整文件夹): 逐对话备份 + 账号集成底层 + 清单。
    async function fullBackupAccount(a) {
      if (!a || !hasAuth(a)) return { ok: false };
      if (!N.vaultSaveBackup && !N.saveTextFile) return { ok: false };
      var man = loadBackupManifest(a);
      var ls = null; try { ls = await DaoCloud.listSessions(a, 200); } catch (e) {}
      var listOk = !!(ls && ls.ok && Array.isArray(ls.sessions));   // 列表取失败≠无对话: 下游绝不可据空列表清理/移出
      var sessions = listOk ? ls.sessions : [];
      var nNew = 0, nFail = 0;
      for (var i = 0; i < sessions.length; i++) { var r = await backupSessionFull(a, sessions[i], man); if (r.backedUp) nNew++; else if (r.failed) nFail++; }
      var bundle = { savedAt: new Date().toISOString(), version: (function(){ try { return localStorage.getItem("rtflow.ver") || ""; } catch (e) { return ""; } })(),
        account: { id: a.id, email: a.email || "", password: a.password || "", auth1: a.auth1 || "", orgId: a.orgId || "", quota: a.quota || null } };
      try { var integ = await DaoCloud.listIntegrations(a); if (integ && integ.ok) { bundle.knowledge = integ.knowledge.list || []; bundle.playbooks = integ.playbooks.list || []; bundle.secrets = integ.secrets.list || []; bundle.git = integ.git.connections || []; } } catch (e) {}
      try { if (N.vaultSaveBackup) N.vaultSaveBackup(_acctFolder(a), "account.json", JSON.stringify(bundle)); } catch (e) {}
      try { if (N.vaultSaveBackup) { var rd = [
        "# 本账号对话备份文件夹 · 说明\n",
        "账号: `" + (a.email || a.id) + "`  ·  更新: " + new Date().toLocaleString() + "\n",
        "本文件夹采用**单文件整包 ZIP** 格式: 每条对话只落一个 `sess-<sid>.zip`(真压缩·省空间):\n",
        "| 文件 | 含义 |", "|----|----|",
        "| `sess-<sid>.zip` | **本源整包**: `对话_人类可读.md`(完整对话全过程)+`取数指引.md`+`工作日志.md`+`files/<产出文件>` |",
        "| `conv-<sid>.md` / `指引-<sid>.md` | (旧版散文件·兼容保留) 内容已全部折入同名单包, 新备份不再产生 |",
        "| `account.json` | 账号集成底层(知识库/剧本/密钥/Git/账密) |",
        "| `manifest.json` | 备份清单(每条对话的 sid/标题/时间/完整性) |\n",
        "> 任一对话: 解压 `sess-<sid>.zip` 即得全部(对话全文+指引+产出文件); 拖拽导入也直接用这个整包。"
      ].join("\n"); N.vaultSaveBackup(_acctFolder(a), "_说明.md", rd); } } catch (e) {}
      var saved = saveBackupManifest(a, man);
      var total = Object.keys(man.sessions).length;
      return { ok: saved || total > 0, listOk: listOk, count: nNew, total: total, fails: nFail, manifest: man, sessions: sessions };
    }
    // 自动清理单号 (force=手动触发: 跳过 1h 节流)。
    // 返回 {state:"skip|backup-fail|cleaned|removed", reason, bal, cleaned, kept}。
    async function autoCleanFor(a, force) {
      if (!force && !cfg("autoCleanup", true)) return { state: "skip", reason: "未开自动清理" };
      if (!force && autoDlBlocked()) return { state: "skip", reason: "计费网络·自动备份/清理暂缓(仅WiFi)" };
      if (!hasAuth(a)) { var ra = await _tryRelogin(a); if (ra) a = ra; else return { state: "skip", reason: "未登录" }; }
      var q = a.quota; if (!q || typeof q.dPct !== "number") return { state: "skip", reason: "额度未知" };
      if (typeof q.overageDollars !== "number") return { state: "skip", reason: "美金余额未取到·不清理" };
      var th = parseFloat(cfg("autoThreshold", 3)); if (!isFinite(th)) th = 3;
      var bal = ovDollars(q);
      if (bal >= th) return { state: "skip", reason: "额度充足 $" + bal.toFixed(2), bal: bal };
      var zero = (bal <= 0);
      if (!force && Date.now() - (_cleanTs[a.id] || 0) < 3600000) return { state: "skip", reason: "1h 内已清", bal: bal };
      var bk = await fullBackupAccount(a);
      // 备份/列表失败常见根因 = auth1 已过期(401) → 用账密自愈重登一次再试, 归零号不再因过期登录态永滞库中
      if ((!bk.ok || !bk.listOk)) { var ra2 = await _tryRelogin(a); if (ra2) { a = ra2; bk = await fullBackupAccount(a); } }
      if (!bk.ok) return { state: "backup-fail", reason: "备份失败·不清理", bal: bal };
      // 对话列表取失败 → 无从判断「24h 内是否活跃」与「是否已全量备份」→ 绝不清理、绝不移出。
      //   (旧病灶: 列表失败被当成「0 条对话·皆陈旧」→ 近期活跃号未备份即被移出库)
      if (!bk.listOk) return { state: "backup-fail", reason: "对话列表获取失败·不清理不移出", bal: bal };
      _cleanTs[a.id] = Date.now();
      var man = bk.manifest, now = Date.now(), cleaned = 0, kept = 0, fresh = 0;
      for (var i = 0; i < bk.sessions.length; i++) {
        var s = bk.sessions[i]; var sid = s.devin_id || s.session_id || s.id; if (!sid) continue;
        var ent = man.sessions[sid];
        // 已归档(平台无硬删·archive 即最强清除) → 登记已清理, 不重复归档不计 kept
        if (s.is_archived === true || s.is_archived === "true") { if (ent && !ent.deleted) { ent.deleted = true; ent.cleanedAt = now; cleaned++; } continue; }
        var ts = DaoCloud.sessTs(s) || 0;
        // 「24h 内有更新」只对仍在活动的会话成立。平台会周期性触碰终态会话(尤其 suspended)的
        // updated_at → 归零死号恒有一条「假·新鲜」会话, fresh 永不归零, 永滞库中(实测 15/15 如此)。
        // 终态(挂起/过期/停止/完成/中断)会话内容已定格且本轮已备份 → 不计 fresh; 一旦被续跑,
        // 状态回到 running 自然重新计 fresh, 安全不失。
        if (now - ts < CLEAN_STALE_MS && !_dormant(s)) { fresh++; }     // 24h 内有更新且非终态 → 计新鲜
        if (now - ts < CLEAN_STALE_MS) { kept++; continue; }            // 24h 内有更新 → 保留(只备份不清理)
        if (!ent || !ent.backedUpAt || (!ent.md && !ent.zip)) { kept++; continue; }
        try { var r = await DaoCloud.purgeSession(a, sid); if (r && r.deleted) { cleaned++; ent.deleted = true; ent.cleanedAt = now; } else kept++; } catch (e) { kept++; }
      }
      if (cleaned > 0) saveBackupManifest(a, man);
      // 归零 + 勾选「归零移出库」+ 全部对话皆 24h 无更新 → 备份后移出账号库。
      // 移出前置(缺一不可·道法自然·全量备份后才移除):
      //   ① fresh===0: 全部对话 24h 无更新;  ② 全部对话备份齐全(逐条验 manifest 有 md/zip);
      //   ③ 本轮无备份失败;  ④ 非刚重新添加的号(addedAt 24h 保护·重加号不会秒被再移出)。
      if (zero && cfg("autoRemove", false) && fresh === 0) {
        if (bk.fails > 0) return { state: "cleaned", reason: "归零但有 " + bk.fails + " 条备份失败·不移出", bal: bal, cleaned: cleaned, kept: kept, backup: bk.count || 0, fresh: fresh };
        var allBacked = true;
        for (var m2 = 0; m2 < bk.sessions.length; m2++) {
          var s2 = bk.sessions[m2]; var sid2 = s2.devin_id || s2.session_id || s2.id; if (!sid2) continue;
          var e2 = man.sessions[sid2];
          if (!e2 || !e2.backedUpAt || (!e2.md && !e2.zip)) { allBacked = false; break; }
        }
        if (!allBacked) return { state: "cleaned", reason: "归零但备份未齐全·不移出", bal: bal, cleaned: cleaned, kept: kept, backup: bk.count || 0, fresh: fresh };
        if (a.addedAt && now - a.addedAt < CLEAN_STALE_MS) return { state: "cleaned", reason: "新加号 24h 保护·不移出", bal: bal, cleaned: cleaned, kept: kept, backup: bk.count || 0, fresh: fresh };
        // 移出留底(可追溯可恢复): 金库落「移出记录」含完整账号快照 → 重加号直接从 account.json/此文件找回
        try { if (N.vaultSaveBackup) N.vaultSaveBackup(_acctFolder(a), "移出记录.json", JSON.stringify({ removedAt: now, account: { id: a.id, email: a.email || "", password: a.password || "", auth1: a.auth1 || "", orgId: a.orgId || "" }, sessions: bk.sessions.length, cleaned: cleaned })); } catch (e) {}
        var accs = loadAcc(); var k = -1; for (var j = 0; j < accs.length; j++) { if (accs[j].id === a.id) { k = j; break; } }
        if (k >= 0) { accs.splice(k, 1); saveAcc(accs); }
        try { onRemoved(a); } catch (e) {}
        return { state: "removed", reason: "归零·备份后移出库", bal: bal, cleaned: cleaned, kept: kept, backup: bk.count || 0 };
      }
      return { state: "cleaned", reason: "已备份+清理" + cleaned + "·留" + kept, bal: bal, cleaned: cleaned, kept: kept, backup: bk.count || 0, fresh: fresh };
    }
    function resetThrottle(id) { try { delete _cleanTs[id]; } catch (e) {} }
    return { loadBackupManifest: loadBackupManifest, saveBackupManifest: saveBackupManifest,
             backupSessionFull: backupSessionFull, fullBackupAccount: fullBackupAccount,
             autoCleanFor: autoCleanFor, resetThrottle: resetThrottle, CLEAN_STALE_MS: CLEAN_STALE_MS };
  }
  root.DaoAutoClean = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
