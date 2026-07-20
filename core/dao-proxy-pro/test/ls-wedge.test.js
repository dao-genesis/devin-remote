"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// ls-wedge.test.js — 扩展↔LS wedge 自愈之「命令式重启 no-op 死循环」根治单测
//   (node test/ls-wedge.test.js)
//
// 根病(实证于 zhoumac 20260720T180444 日志 · LS 卡 13 分钟):
//   窗口启动期 LS "exited before sending start data" 后, codeium 扩展状态机卡
//   "Already waiting for language server start" 死循环; 此时
//   windsurf.restartLanguageServer 命令 resolve 成功但内部只记 ERROR、不生新 LS
//   → v9.9.330 wedge 自愈的命令式路径成为静默 no-op, 且 ok=true 永不落 kill 兜底
//   → 每 180s 冷却后再空转一轮 · Cascade 永停「Connecting to server…」。
//
// 药(v9.9.360): _lsWedgeStrikes 连续计数 —— 上一轮命令式自愈后心跳仍断(strike≥2)
//   = 状态机 wedge 实锤 → 跳过命令、直接 kill LS 进程令管理器重生;
//   心跳复流(ls_idle_s<90)即归零。
//
// 覆盖:
//   1. 心跳正常(idle<90) → 归零 strikes · 不触自愈
//   2. 首轮 wedge → strike=1 · 走命令式路径 · 不 kill
//   3. 冷却期内再断 → 不加 strike (去抖保持)
//   4. 冷却期满仍断 → strike=2 · 跳过命令 · 直接 kill LS 进程
//   5. 心跳复流 → strikes 归零 (下次 wedge 重新从命令式开始)
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const Module = require("module");

process.env.DAO_PP_SELFTEST = "1";

// ── 记录 executeCommand / spawn(taskkill|pkill) 调用 ──
const calls = { cmd: [], kill: [] };

// ── vscode 桩: 递归 Proxy · 但 commands.executeCommand 记录调用 ──
function makeVscodeStub() {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      if (prop === "workspaceFolders") return undefined;
      if (prop === "commands")
        return {
          executeCommand(name) {
            calls.cmd.push(name);
            return Promise.resolve();
          },
          registerCommand() { return { dispose() {} }; },
        };
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  };
  const target = function () {};
  const proxy = new Proxy(target, handler);
  return proxy;
}

// ── child_process 桩: spawn(taskkill/pkill) 记录并模拟退出 ──
const realCp = require("child_process");
const cpStub = Object.create(realCp);
cpStub.spawn = function (cmd, args, opts) {
  if (cmd === "taskkill" || cmd === "pkill") {
    calls.kill.push(cmd);
    const ee = new (require("events").EventEmitter)();
    ee.stdout = new (require("events").EventEmitter)();
    ee.stderr = new (require("events").EventEmitter)();
    setImmediate(() => ee.emit("close", 0));
    return ee;
  }
  return realCp.spawn(cmd, args, opts);
};

const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return makeVscodeStub();
  if (request === "child_process" || request === "node:child_process")
    return cpStub;
  return _origLoad.call(this, request, parent, isMain);
};

const ext = require("../extension.js");
const T = ext.__test;

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✅ ${name}`);
    });
}

const PING_WEDGE = { ok: true, uptime_s: 300, ls_idle_s: 200 };
const PING_ALIVE = { ok: true, uptime_s: 300, ls_idle_s: 3 };

(async () => {
  console.log("ls-wedge.test.js · LS wedge 自愈升级判定");
  T._lsWedge.setAnchored(true);

  await ok("心跳正常 → strikes 归零 · 不触自愈", async () => {
    T._lsWedge.strikes = 1;
    T._lsWedge.last = 0;
    await T._maybeHealLsWedge(PING_ALIVE);
    assert.strictEqual(T._lsWedge.strikes, 0);
    assert.strictEqual(calls.cmd.length, 0);
    assert.strictEqual(calls.kill.length, 0);
  });

  await ok("首轮 wedge → strike=1 · 命令式重启 · 不 kill", async () => {
    T._lsWedge.strikes = 0;
    T._lsWedge.last = 0;
    await T._maybeHealLsWedge(PING_WEDGE);
    assert.strictEqual(T._lsWedge.strikes, 1);
    assert.deepStrictEqual(calls.cmd, ["windsurf.restartLanguageServer"]);
    assert.strictEqual(calls.kill.length, 0);
  });

  await ok("冷却期内再断 → 去抖 · strike 不增", async () => {
    await T._maybeHealLsWedge(PING_WEDGE); // last 刚更新 · 冷却 180s 内
    assert.strictEqual(T._lsWedge.strikes, 1);
    assert.strictEqual(calls.cmd.length, 1);
    assert.strictEqual(calls.kill.length, 0);
  });

  await ok("冷却期满仍断 → strike=2 · 跳过命令 · 直接 kill LS", async () => {
    T._lsWedge.last = Date.now() - 181000; // 冷却期满
    await T._maybeHealLsWedge(PING_WEDGE);
    assert.strictEqual(T._lsWedge.strikes, 2);
    assert.strictEqual(calls.cmd.length, 1, "不应再走命令式路径");
    assert.deepStrictEqual(
      calls.kill,
      [process.platform === "win32" ? "taskkill" : "pkill"],
    );
  });

  await ok("心跳复流 → strikes 归零 (自愈闭环)", async () => {
    await T._maybeHealLsWedge(PING_ALIVE);
    assert.strictEqual(T._lsWedge.strikes, 0);
  });

  console.log(`\n✅ 通过: ${passed}`);
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
