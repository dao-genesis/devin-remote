"use strict";
// 实测「归零账号 备份→清理→移出库」共用引擎 (问题: 该流水线过去只由切号板可见性门控的
// 心跳驱动 → 用户不在切号板时从不触发·实测全失效):
//   直接加载真代码 autoclean.js (DaoAutoClean), 注入 mock N/DaoCloud, 断言:
//   1) 归零 + 勾选「归零移出库」+ 全部对话 24h 无更新 → 先备份 → 移出账号库 → onRemoved;
//   2) 备份失败 → backup-fail, 绝不清理/移出;
//   3) 有 24h 内更新的对话 → 只清理陈旧对话, 账号保留 (不移出);
//   4) 额度充足 → skip, 零网络调用;
//   5) 1h 节流 (force 可跳过);
//   6) 源级护栏: engine.html 与 switch.html 皆引入 autoclean.js 并接入同一流水线;
//      engine tick 调 bgAutoCleanTick (常驻后台·不受切号板可见性门控);
//      RelayService 桥暴露 vaultReadBackup/vaultSaveBackup/vaultSaveBackupB64/vaultDeleteBackup/netInfo;
//   7) 退格护栏 (左右两侧同删修复): MainActivity 有 installBackspaceGuard 且在
//      onPageFinished + doUpdateVisitedHistory(SPA 路由) 两处安装; 护栏拦 IME 误发的
//      deleteContentForward 与越过光标的目标区间, 不干预组合输入 (isComposing)。
// 无框架: 直接 node test/autoclean.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app", "src", "main");
const engineSrc = fs.readFileSync(path.join(APP, "assets", "engine", "engine.html"), "utf8");
const switchSrc = fs.readFileSync(path.join(APP, "assets", "engine", "switch.html"), "utf8");
const relaySrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "RelayService.java"), "utf8");
const mainSrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 加载真代码 (autoclean.js 在无 window 环境挂到 globalThis)
require(path.join(APP, "assets", "engine", "autoclean.js"));
const DaoAutoClean = globalThis.DaoAutoClean;
ok(!!(DaoAutoClean && DaoAutoClean.create), "autoclean.js 可独立加载并暴露 DaoAutoClean.create");

const H = 3600 * 1000, DAY = 24 * H;
function makeEnv(opts) {
  opts = opts || {};
  const now = Date.now();
  const files = {};             // folder/name → content
  const calls = { purged: [], removed: [], listSessions: 0 };
  let accs = opts.accs || [{ id: "a1", email: "z@x.com", auth1: "t", orgId: "o", quota: opts.quota }];
  const sessions = opts.sessions || [];
  const N = {
    vaultReadBackup: (f, n) => files[f + "/" + n] || "",
    vaultSaveBackup: (f, n, c) => { if (opts.backupFail) return false; files[f + "/" + n] = c; return true; },
    vaultSaveBackupB64: (f, n, b) => { if (opts.backupFail) return false; files[f + "/" + n] = "B64:" + b; return true; },
    vaultDeleteBackup: (f, n) => { delete files[f + "/" + n]; return true; },
  };
  const DaoCloud = {
    sessTs: (s) => s.ts || 0,
    listSessions: async () => { calls.listSessions++; return opts.listFail ? { ok: false } : { ok: true, sessions: sessions }; },
    exportSessionZip: async (a, sid) => (opts.backupFail || (opts.failSids || []).indexOf(sid) >= 0) ? { ok: false } : { ok: true, b64: "eg==", events: 3, fileCount: 1 },
    exportSession: async (a, sid) => (opts.failSids || []).indexOf(sid) >= 0 ? { ok: false } : ({ ok: true, md: "# conv", events: 3 }),
    buildAccessGuide: () => "guide",
    listIntegrations: async () => ({ ok: false }),
    purgeSession: async (a, sid) => { calls.purged.push(sid); return { deleted: true }; },
  };
  const cfgStore = Object.assign({ autoCleanup: true, autoRemove: true, autoThreshold: 3 }, opts.cfg || {});
  const inst = DaoAutoClean.create({
    N, DaoCloud,
    cfg: (k, d) => (k in cfgStore ? cfgStore[k] : d),
    hasAuth: (a) => !!(a.auth1 && a.orgId),
    ovDollars: (q) => (q && typeof q.overageDollars === "number") ? q.overageDollars : 0,
    loadAcc: () => accs,
    saveAcc: (a) => { accs = a; },
    autoDlBlocked: () => !!opts.metered,
    onRemoved: (a) => calls.removed.push(a.id),
  });
  return { inst, calls, files, getAccs: () => accs, now };
}

(async function main() {
  const now = Date.now();
  // ── 场景 1: 归零 + 勾选移出 + 全部对话陈旧 → 备份 → 清理 → 移出库 ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, sessions: [{ devin_id: "s1", title: "老对话", ts: now - 2 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "removed", "归零+全陈旧: state=removed (" + r.state + ")");
    ok(env.calls.purged.length === 1 && env.calls.purged[0] === "s1", "归零+全陈旧: 陈旧对话已真删");
    ok(Object.keys(env.files).some((k) => k.indexOf("sess-s1.zip") >= 0), "归零+全陈旧: 移出前已落整包 ZIP 备份");
    ok(env.getAccs().length === 0, "归零+全陈旧: 账号已移出库");
    ok(env.calls.removed.length === 1, "归零+全陈旧: onRemoved 回调触发");
  }
  // ── 场景 2: 备份失败 → 绝不清理/移出 ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, backupFail: true, sessions: [{ devin_id: "s1", ts: now - 2 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "backup-fail", "备份失败: state=backup-fail (" + r.state + ")");
    ok(env.calls.purged.length === 0, "备份失败: 未清理任何对话");
    ok(env.getAccs().length === 1, "备份失败: 账号保留在库");
  }
  // ── 场景 3: 有 24h 内更新的对话 → 只清陈旧, 账号不移出 ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, sessions: [
      { devin_id: "sOld", ts: now - 2 * DAY }, { devin_id: "sLive", ts: now - H }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "cleaned", "存在 24h 内更新: state=cleaned 不移出 (" + r.state + ")");
    ok(env.calls.purged.length === 1 && env.calls.purged[0] === "sOld", "存在 24h 内更新: 只清陈旧对话");
    ok(env.getAccs().length === 1, "存在 24h 内更新: 账号保留在库");
  }
  // ── 场景 4: 额度充足 → skip, 零网络 ──
  {
    const env = makeEnv({ quota: { dPct: 60, overageDollars: 42 } });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "skip", "额度充足: skip (" + r.reason + ")");
    ok(env.calls.listSessions === 0, "额度充足: 零网络调用");
  }
  // ── 场景 5: 1h 节流 (force 跳过) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, sessions: [{ devin_id: "s1", ts: now - 2 * DAY }], cfg: { autoRemove: false } });
    const a = env.getAccs()[0];
    const r1 = await env.inst.autoCleanFor(a);
    ok(r1.state === "cleaned", "节流: 首轮 cleaned");
    const r2 = await env.inst.autoCleanFor(a);
    ok(r2.state === "skip" && /1h/.test(r2.reason), "节流: 1h 内第二轮 skip");
    const r3 = await env.inst.autoCleanFor(a, true);
    ok(r3.state === "cleaned", "节流: force=true 跳过节流");
    env.inst.resetThrottle(a.id);
    const r4 = await env.inst.autoCleanFor(a);
    ok(r4.state === "cleaned", "节流: resetThrottle 后恢复");
  }
  // ── 场景 6: 计费网络 → 自动暂缓 (force 不受限) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, metered: true, sessions: [{ devin_id: "s1", ts: now - 2 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "skip" && /WiFi/.test(r.reason), "计费网络: 自动清理暂缓");
  }
  // ── 场景 7: 对话列表获取失败 → 绝不清理/移出 (列表失败≠无对话·旧病灶: 近期活跃号未备份即被移出) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, listFail: true, sessions: [{ devin_id: "s1", ts: now - 2 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "backup-fail" && /列表/.test(r.reason), "列表失败: state=backup-fail 不清理不移出 (" + r.state + ")");
    ok(env.calls.purged.length === 0, "列表失败: 未清理任何对话");
    ok(env.getAccs().length === 1, "列表失败: 账号保留在库");
  }
  // ── 场景 8: 部分对话备份失败 → 备份未齐全·不移出 (全量备份后才移除) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, failSids: ["s2"], sessions: [
      { devin_id: "s1", ts: now - 2 * DAY }, { devin_id: "s2", ts: now - 3 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "cleaned" && /不移出/.test(r.reason), "部分备份失败: 不移出 (" + r.reason + ")");
    ok(env.calls.purged.indexOf("s2") < 0, "部分备份失败: 未备份的对话绝不清理");
    ok(env.getAccs().length === 1, "部分备份失败: 账号保留在库");
  }
  // ── 场景 9: 刚重新添加的号 (addedAt 24h 内) → 免自动移出保护 (消除「重加即被再移出」幽灵循环) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, sessions: [{ devin_id: "s1", ts: now - 2 * DAY }],
      accs: [{ id: "a1", email: "z@x.com", auth1: "t", orgId: "o", quota: { dPct: 0, overageDollars: 0 }, addedAt: now - H }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "cleaned" && /24h 保护/.test(r.reason), "新加号 24h 保护: 不移出 (" + r.reason + ")");
    ok(env.getAccs().length === 1, "新加号 24h 保护: 账号保留在库");
  }
  // ── 场景 10: 移出时落「移出记录」留底 (可追溯可恢复) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, sessions: [{ devin_id: "s1", ts: now - 2 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(r.state === "removed", "移出留底: 确已移出");
    ok(Object.keys(env.files).some((k) => k.indexOf("移出记录.json") >= 0), "移出留底: 金库落移出记录(含账号快照)");
  }
  // ── 场景 11: 已归档对话 → 登记已清理·不重复归档·不阻移出 (平台无硬删·archive 即最强清除) ──
  {
    const env = makeEnv({ quota: { dPct: 0, overageDollars: 0 }, sessions: [
      { devin_id: "sArch", ts: now - 3 * DAY, is_archived: true }, { devin_id: "sOld", ts: now - 2 * DAY }] });
    const r = await env.inst.autoCleanFor(env.getAccs()[0]);
    ok(env.calls.purged.length === 1 && env.calls.purged[0] === "sOld", "已归档: 不重复归档 (只清理未归档陈旧对话)");
    ok(r.state === "removed", "已归档: 不阻塞归零移出 (" + r.state + ")");
  }
  // ── 源级护栏: purgeSession 以 archive 为最强清除 (平台无硬删 REST 路由·DELETE 恒 404/405) ──
  {
    const cloudSrc = fs.readFileSync(path.join(APP, "assets", "engine", "devin-cloud.js"), "utf8");
    ok(/var ok = !!\(del\.ok \|\| arch\.ok\);/.test(cloudSrc), "purgeSession: archive 成功即视为已清理 (硬删为增强)");
    ok(/\/api\/v3\/organizations\/.*\?archive=true/.test(cloudSrc.replace(/"\s*\+\s*/g, "")) || /v3\/organizations\//.test(cloudSrc), "deleteSession: 带 v3 terminate+archive 兜底");
    ok(/is_archived === true/.test(fs.readFileSync(path.join(APP, "assets", "engine", "autoclean.js"), "utf8")), "autoclean: 已归档对话登记已清理·不重复归档");
  }
  // ── 源级护栏: 双端接入同一流水线 ──
  ok(/<script src="autoclean\.js">/.test(engineSrc), "engine.html 引入 autoclean.js");
  ok(/<script src="autoclean\.js">/.test(switchSrc), "switch.html 引入 autoclean.js");
  ok(/DaoAutoClean\.create\(/.test(engineSrc), "engine.html 创建共用清理实例");
  ok(/DaoAutoClean\.create\(/.test(switchSrc), "switch.html 创建共用清理实例");
  ok(/await bgAutoCleanTick\(accs\)/.test(engineSrc), "engine tick 每轮调 bgAutoCleanTick (常驻后台·不受可见性门控)");
  ok(!/async function autoCleanFor\(a, force\)\{\s*if\(!force && !_cfg/.test(switchSrc), "switch.html 旧内联流水线已收敛 (不再双份实现)");
  // RelayService 引擎桥具备备份落地能力 (与 MainActivity 同一 backups 目录)
  for (const m of ["vaultReadBackup", "vaultSaveBackup", "vaultSaveBackupB64", "vaultDeleteBackup", "netInfo"]) {
    ok(new RegExp("@JavascriptInterface public (String|boolean) " + m + "\\(").test(relaySrc), "RelayService 引擎桥: " + m);
  }
  // ── 源级护栏: 退格护栏 (左右两侧同删修复) ──
  ok(/private void installBackspaceGuard\(WebView w\)/.test(mainSrc), "MainActivity 有 installBackspaceGuard");
  ok(/installKbHelper\(v\);\s*\/\/[^\n]*\n\s*installBackspaceGuard\(v\);/.test(mainSrc), "退格护栏: onPageFinished 安装");
  ok(/installDownloadHook\(v\); installKbHelper\(v\); installBackspaceGuard\(v\);/.test(mainSrc), "退格护栏: SPA 路由后重装 (doUpdateVisitedHistory)");
  ok(/deleteContentForward'&&\(now-lastBk\)<150/.test(mainSrc), "退格护栏: 拦截紧跟退格的 IME 向前删除");
  ok(/r\.endOffset>sel\.anchorOffset/.test(mainSrc), "退格护栏: 拦截越过光标吞右侧的退格区间");
  ok(/e\.isComposing\)return/.test(mainSrc), "退格护栏: 组合输入(拼音)中不干预");
  // ── 源级护栏: 重加号消幽灵 (doAdd 落 addedAt + 立即镜像金库·不被回拉覆盖) ──
  ok(/addedAt:Date\.now\(\)/.test(switchSrc), "doAdd 落 addedAt (重加号 24h 免移出保护)");
  ok(/saveAcc\(accs\); try\{ mirrorAccountsToVault\(\); \}catch\(e\)\{\}/.test(switchSrc), "doAdd 后立即镜像金库 (重加号不被金库回拉抓回幽灵态)");
  ok(/window\.__rtBsGuard\)return/.test(mainSrc), "退格护栏: 幂等守卫");

  // ── 源级护栏: ZIP 备份增量同步 (对话有新内容 → 备份自动跟进) ──
  {
    const acSrc = fs.readFileSync(path.join(APP, "assets", "engine", "autoclean.js"), "utf8");
    ok(/ts > 0 && prev\.ts === ts/.test(acSrc), "增量备份: 无更新时间(ts=0)的会话不跳过·一律重备 (宁多备不漏备)");
    ok(/async function bgBackupTick\(accs\)/.test(engineSrc), "engine.html 常驻增量备份心跳 bgBackupTick");
    ok(/await bgBackupTick\(accs\)/.test(engineSrc), "engine tick 每轮调 bgBackupTick (不依赖切号板在前台)");
    ok(/_bgClean\.fullBackupAccount\(a\)/.test(engineSrc), "bgBackupTick 走共用 fullBackupAccount (内部按 updated_at 增量)");
  }
  // ── 增量备份行为: 对话更新时间变化 → 重新备份 ZIP (与最新内容同步) ──
  {
    const sess = [{ devin_id: "sInc", ts: now - 2 * DAY, title: "t" }];
    const env = makeEnv({ quota: { dPct: 50, overageDollars: 42 }, sessions: sess });
    const a = env.getAccs()[0];
    const bk1 = await env.inst.fullBackupAccount(a);
    ok(bk1.ok && bk1.count === 1, "增量: 首次备份落 ZIP");
    const bk2 = await env.inst.fullBackupAccount(a);
    ok(bk2.ok && bk2.count === 0, "增量: 未变更 → 廉价跳过不重备");
    sess[0].ts = now - 2 * DAY + 60000;   // 对话有新内容 → updated_at 前移
    const bk3 = await env.inst.fullBackupAccount(a);
    ok(bk3.ok && bk3.count === 1, "增量: 对话更新时间变化 → 重新备份 ZIP (跟随最新)");
    const sess2 = [{ devin_id: "sNoTs", title: "t" }];   // 列表不带任何时间字段
    const env2 = makeEnv({ quota: { dPct: 50, overageDollars: 42 }, sessions: sess2 });
    const a2 = env2.getAccs()[0];
    await env2.inst.fullBackupAccount(a2);
    const bkA = await env2.inst.fullBackupAccount(a2);
    ok(bkA.ok && bkA.count === 1, "增量: 无更新时间(ts=0) → 不跳过·每轮重备 (宁多备不漏备)");
  }

  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  console.log("\nautoclean: all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
