"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// stale-shadow.test.js — Proxy Pro · 旧独立版遮蔽新内折版之让位判定单测
//   (node test/stale-shadow.test.js)
//
// 根病(实证于 zhoumac exthost 日志 · 两套代理并存互抢):
//   独立 dao-agi.dao-proxy-pro-9.9.342 与 dao.dao-one-2.28.2 内折 proxy-pro 9.9.358
//   同时启用时, 旧独立版先占 :8957; 新内折版 EADDRINUSE → _isRemoteStale 判定:
//   ① _scanLatestVendorDir 只认 dao-proxy-pro-X.Y.Z 目录名 → 内折布局
//      (dao-one/vendor-proxy)的「更新的自己」不在候选 → 旧独立版恒为「最新」;
//   ② remote self_file 恰等于该「最新目录」/source.js → 路径全等快路径 → 恒不旧
//   → 新版永远让位于旧版 · 上一轮全部修复被旧引擎遮蔽。
//
// 药(v9.9.359): 自身(PKG_VERSION+自家 vendor)入候选; _isRemoteStale 版本先行,
//   ping.features.mode(形如 "v9.9.343-dao-fa-zi-ran")抽版可证远端严格更旧时让其退位。
//
// 覆盖:
//   1. _verFromPing: 正常/缺失/畸形
//   2. _ownVerTriple 与 package.json 一致
//   3. _scanLatestVendorDir 含自身候选(折入布局也能看见自己)
//   4. _isRemoteStale: 远端 ping 版本严格旧 → stale (即便 self_file 路径为「扫描最新」)
//   5. _isRemoteStale: 同版/更新 → 不旧 (不杀同道 · v9.9.320 语义保持)
// ═══════════════════════════════════════════════════════════════════════════
const assert = require("assert");
const path = require("path");
const Module = require("module");

process.env.DAO_PP_SELFTEST = "1";

// ── vscode 桩: 递归 Proxy(仅供 module load 期解析) ──
function makeVscodeStub() {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      if (prop === "workspaceFolders") return undefined;
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  };
  const target = function () {};
  const proxy = new Proxy(target, handler);
  return proxy;
}
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return makeVscodeStub();
  return _origLoad.call(this, request, parent, isMain);
};

const ext = require("../extension.js");
const T = ext.__test;
const PKG = require("../package.json");

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✅ ${name}`);
}

console.log("stale-shadow.test.js · 旧版遮蔽让位判定");

ok("_verFromPing 抽 features.mode 版本", () => {
  assert.deepStrictEqual(
    T._verFromPing({ features: { mode: "v9.9.343-dao-fa-zi-ran" } }),
    [9, 9, 343],
  );
  assert.strictEqual(T._verFromPing({}), null);
  assert.strictEqual(T._verFromPing(null), null);
  assert.strictEqual(T._verFromPing({ features: { mode: "dao" } }), null);
});

ok("_ownVerTriple 与 package.json 一致", () => {
  assert.deepStrictEqual(
    T._ownVerTriple(),
    String(PKG.version).split(".").map(Number),
  );
});

ok("_scanLatestVendorDir 含自身候选(折入布局可见自己)", () => {
  const best = T._scanLatestVendorDir();
  // 本仓源码目录名(dao-proxy-pro)无版本后缀 → 唯一候选即 (self)
  assert.ok(best, "应至少有自身候选");
  assert.ok(
    T._cmpVer(best.version, T._ownVerTriple()) >= 0,
    "最新候选版本必 >= 自身",
  );
});

ok("远端 ping 版本严格旧 → stale (路径全等不再豁免)", () => {
  const best = T._scanLatestVendorDir();
  const remoteSelfFile = path.join(best.path, "source.js"); // 路径全等场景
  const olderPing = { features: { mode: "v0.0.1-dao" } };
  assert.strictEqual(T._isRemoteStale(remoteSelfFile, olderPing), true);
});

ok("远端同版/更新 → 不旧 (不杀同道)", () => {
  const best = T._scanLatestVendorDir();
  const remoteSelfFile = path.join(best.path, "source.js");
  const same = { features: { mode: `v${best.version.join(".")}-dao` } };
  const newer = { features: { mode: "v999.0.0-dao" } };
  assert.strictEqual(T._isRemoteStale(remoteSelfFile, same), false);
  assert.strictEqual(T._isRemoteStale(remoteSelfFile, newer), false);
  // 无 ping 时路径全等仍豁免(旧行为保持)
  assert.strictEqual(T._isRemoteStale(remoteSelfFile, null), false);
});

console.log(`\n✅ 通过: ${passed}`);
