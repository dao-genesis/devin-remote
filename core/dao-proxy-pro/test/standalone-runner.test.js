"use strict";
// standalone-runner.test.js · 反代常驻守护 · 最新源扫描判定
// 根因回归: 守护必须永远选「全部 IDE 安装目录中最新版」的 source.js,
//   且蛰伏/让位逻辑依赖 cmpVer 正确性。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { scanNewestSource, cmpVer } = require("../vendor/bundled-origin/standalone-runner.js");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function mk(root, extName, layout) {
  const parts =
    layout === "one"
      ? [extName, "vendor-proxy", "vendor", "bundled-origin"]
      : [extName, "vendor", "bundled-origin"];
  const full = path.join(root, "extensions", ...parts);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, "source.js"), "// stub\n");
  return full;
}

console.log("standalone-runner.test.js · 常驻守护最新源扫描");

t("cmpVer 三元组比较", () => {
  assert.ok(cmpVer([9, 9, 361], [9, 9, 360]) > 0);
  assert.ok(cmpVer([2, 28, 11], [9, 9, 361]) < 0);
  assert.strictEqual(cmpVer([1, 2, 3], [1, 2, 3]), 0);
});

t("扫描取最新版 · 跨 dao-one/独立布局 · 忽略中间态目录", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dao-sr-"));
  const devinRoot = path.join(home, ".devin");
  mk(devinRoot, "dao.dao-one-2.28.9", "one");
  mk(devinRoot, "dao.dao-one-2.28.11", "one");
  mk(devinRoot, "dao-agi.dao-proxy-pro-9.9.342", "pro");
  mk(devinRoot, "dao.dao-one-3.0.0.obsolete", "one"); // 中间态 · 须忽略
  const origHomedir = os.homedir;
  os.homedir = () => home;
  try {
    const best = scanNewestSource();
    assert.ok(best, "应扫到源");
    assert.deepStrictEqual(best.ver, [9, 9, 342], "独立 pro 版号 9.9.342 数值最大");
    // dao-one 与独立版属不同版号体系 · 数值比较即可(与扩展侧 _scanLatestVendorDir 同法)
  } finally {
    os.homedir = origHomedir;
  }
});

t("无任何安装 → 返回 null 不抛", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dao-sr-empty-"));
  const origHomedir = os.homedir;
  os.homedir = () => home;
  try {
    assert.strictEqual(scanNewestSource(), null);
  } finally {
    os.homedir = origHomedir;
  }
});

console.log(`\n✅ 通过: ${pass}${fail ? ` · ❌ 失败: ${fail}` : ""}`);
if (fail) process.exit(1);
