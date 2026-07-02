"use strict";
// 实测「常驻引擎·额度权威刷新」修复的真代码 (问题①②: 页签金额/状态在切号板不可见时冻结):
//   切出 engine.html 的 _pushTabQuota/_pushTabConvStatus/bgQuotaTick 函数体 eval, 注入 mock N/DaoCore, 断言:
//   1) 有活跃对话的号每轮必刷额度并推 id+小写 email 双键 "$X";
//   2) 空闲号每轮轮转 ≤10 个 (光标推进·全池周期性覆盖);
//   3) 额度未取到真值 (dPct/overageDollars 非数) → 绝不推 (永不抹掉已显金额);
//   4) 状态映射与 switch.html 同源: running→running, quota/blocked/action_required/awaiting→blocked, 优先级 quota 最高;
//   5) 源级护栏: engine tick 调 bgQuotaTick; RelayService 桥转发 setTabDollars/setTabStatus 至 MainActivity.ipc*;
//      MainActivity 具 ipcSetTabDollars/ipcSetTabStatus 且 Native 桥委托之;
//   6) 麦克风修复护栏: Manifest 声明 RECORD_AUDIO; onPermissionRequest 走 handleWebPermission 运行时授权流.
// 无框架: 直接 node test/engine-bg-quota.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app", "src", "main");
const engineSrc = fs.readFileSync(path.join(APP, "assets", "engine", "engine.html"), "utf8");
const relaySrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "RelayService.java"), "utf8");
const mainSrc = fs.readFileSync(path.join(APP, "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");
const manifest = fs.readFileSync(path.join(APP, "AndroidManifest.xml"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 切出 _pushTabQuota → bgQuotaTick 区段
const seg = engineSrc.match(/var _bgIdleCursor = 0;[\s\S]*?(?=\n\s*async function tick\(\))/);
if (!seg) { console.error("FAIL: 未找到 bgQuotaTick 区段"); process.exit(1); }

function makeModule() {
  const dolCalls = [], stCalls = [], refreshed = [];
  const accStore = {};
  const N = {
    setTabDollars: (k, v) => dolCalls.push([k, v]),
    setTabStatus: (k, nm, st) => stCalls.push([k, nm, st]),
  };
  const DaoCore = {
    refreshQuotaFor: async (id) => { refreshed.push(id); },
    findAcc: (id) => accStore[id] || null,
  };
  const factory = "(async function(){return (function(deps){\n" +
    "var N=deps.N; var DaoCore=deps.DaoCore;\n" +
    seg[0] + "\n" +
    "return { bgQuotaTick: bgQuotaTick, pushTabQuota: _pushTabQuota, pushTabConvStatus: _pushTabConvStatus, cursor: function(){return _bgIdleCursor;} };\n" +
    "})})";
  // eslint-disable-next-line no-eval
  return eval(factory)().then((f) => ({ fns: f({ N, DaoCore }), dolCalls, stCalls, refreshed, accStore }));
}

(async function main() {
  // ── 场景 1: 有额度 → 推 id + 小写 email 双键 "$X" (四舍五入) ──
  {
    const m = await makeModule();
    m.fns.pushTabQuota({ id: "a1", email: "A@X.com", quota: { dPct: 100, overageDollars: 17.7 } });
    ok(m.dolCalls.length === 2, "有额度: 推送两次 (id + 小写 email)");
    ok(m.dolCalls.some((c) => c[0] === "a1" && c[1] === "$18"), "有额度: 以 id 键推送 $18 (四舍五入)");
    ok(m.dolCalls.some((c) => c[0] === "a@x.com"), "有额度: email 键小写化");
  }
  // ── 场景 2: 未取到真值 → 绝不推 (永不抹掉已显金额) ──
  {
    const m = await makeModule();
    m.fns.pushTabQuota({ id: "a1", email: "a@x.com", quota: {} });
    m.fns.pushTabQuota({ id: "a1", email: "a@x.com", quota: { dPct: 100 } });
    ok(m.dolCalls.length === 0, "无真值 (dPct/overageDollars 非数): 不推任何键");
  }
  // ── 场景 3: 状态映射与优先级 (quota>blocked/action_required>awaiting>running) ──
  {
    const m = await makeModule();
    m.fns.pushTabConvStatus({ id: "a1", email: "a@x.com" }, [
      { reason: "running", title: "跑" }, { reason: "quota", title: "耗尽" }, { reason: "awaiting", title: "等" },
    ]);
    ok(m.stCalls.length === 2 && m.stCalls[0][1] === "耗尽" && m.stCalls[0][2] === "blocked", "优先级: quota 置顶 → blocked 映射");
    const m2 = await makeModule();
    m2.fns.pushTabConvStatus({ id: "a1" }, [{ reason: "running", title: "跑" }]);
    ok(m2.stCalls.length === 1 && m2.stCalls[0][2] === "running", "running → running 映射");
  }
  // ── 场景 4: 活跃号必刷 + 空闲号轮转 ≤10 且光标推进 ──
  {
    const m = await makeModule();
    const accs = [];
    for (let i = 0; i < 30; i++) accs.push({ id: "id" + i, email: "u" + i + "@x.com" });
    m.accStore["id0"] = { id: "id0", email: "u0@x.com", quota: { dPct: 100, overageDollars: 5 } };
    const sessions = [{ email: "u0@x.com", reason: "running", title: "T" }];
    await m.fns.bgQuotaTick(sessions, accs);
    ok(m.refreshed.includes("id0"), "活跃号 (有在跑对话) 每轮必刷");
    ok(m.refreshed.length === 11, "本轮刷新 = 1 活跃 + 10 轮转空闲 (共 11)");
    ok(m.fns.cursor() === 10, "空闲轮转光标推进 10");
    ok(m.dolCalls.some((c) => c[0] === "id0" && c[1] === "$5"), "刷毕即推该号最新美金到页签");
    const before = m.refreshed.slice();
    await m.fns.bgQuotaTick(sessions, accs);
    ok(m.refreshed.slice(before.length).some((id) => !before.includes(id) || id === "id0"), "下一轮轮转到不同空闲号 (全池周期覆盖)");
  }
  // ── 场景 5: 源级护栏 ──
  ok(/try \{ await bgQuotaTick\(r\.sessions, accs\); \} catch\(e\)\{\}/.test(engineSrc), "engine tick 每轮调 bgQuotaTick (与对话追踪同拍)");
  ok(/@JavascriptInterface public void setTabDollars\(String accountId, String dollars\) \{\s*\n\s*MainActivity m = MainActivity\.sInstance; if \(m != null\) m\.ipcSetTabDollars\(accountId, dollars\);/.test(relaySrc), "RelayService 桥转发 setTabDollars → MainActivity.ipcSetTabDollars");
  ok(/m\.ipcSetTabStatus\(accountId, convName, status\);/.test(relaySrc), "RelayService 桥转发 setTabStatus → MainActivity.ipcSetTabStatus");
  ok(/public void ipcSetTabDollars\(String accountId, String dollars\)/.test(mainSrc), "MainActivity 具公开 ipcSetTabDollars");
  ok(/public void ipcSetTabStatus\(String accountId, String convName, String status\)/.test(mainSrc), "MainActivity 具公开 ipcSetTabStatus");
  ok(/ipcSetTabDollars\(accountId, dollars\);\s*\n\s*\}/.test(mainSrc) && /setTabDollars\(String accountId, String dollars\) \{\s*\n\s*ipcSetTabDollars/.test(mainSrc), "Native 桥 setTabDollars 委托 ipc 共用入口");
  // ── 场景 6: 麦克风权限修复护栏 ──
  ok(/android\.permission\.RECORD_AUDIO/.test(manifest), "Manifest 声明 RECORD_AUDIO");
  ok(/main\.post\(\(\) -> handleWebPermission\(request\)\);/.test(mainSrc), "onPermissionRequest 走 handleWebPermission");
  ok(/RESOURCE_AUDIO_CAPTURE/.test(mainSrc) && /Manifest\.permission\.RECORD_AUDIO/.test(mainSrc), "缺 RECORD_AUDIO 运行时权限 → 先向系统申请");
  ok(/onRequestPermissionsResult/.test(mainSrc) && /pendingWebPermission/.test(mainSrc), "授权回调补发 grant (pendingWebPermission)");

  if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
  console.log("engine-bg-quota: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
