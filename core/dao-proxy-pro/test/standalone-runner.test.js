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

function mk(root, extName, layout, ver) {
  const parts =
    layout === "one"
      ? [extName, "vendor-proxy", "vendor", "bundled-origin"]
      : [extName, "vendor", "bundled-origin"];
  const full = path.join(root, "extensions", ...parts);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(
    path.join(full, "source.js"),
    `const ORIGIN_VERSION_BASE = "v${ver}"; // stub\n`,
  );
  return full;
}

console.log("standalone-runner.test.js · 常驻守护最新源扫描");

t("cmpVer 三元组比较", () => {
  assert.ok(cmpVer([9, 9, 361], [9, 9, 360]) > 0);
  assert.ok(cmpVer([2, 28, 11], [9, 9, 361]) < 0);
  assert.strictEqual(cmpVer([1, 2, 3], [1, 2, 3]), 0);
});

t("扫描取最新版(按内容 ORIGIN_VERSION_BASE · 非目录名) · 忽略中间态目录", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dao-sr-"));
  const devinRoot = path.join(home, ".devin");
  const vscodeRoot = path.join(home, ".vscode");
  // 根因回归: dao-one 目录版号 2.x 体系低于陈年独立版 9.9.342 目录号,
  // 但其内折 source 实为 9.9.361 —— 必须按内容版号选中 dao-one 内折源
  mk(devinRoot, "dao.dao-one-2.28.9", "one", "9.9.361");
  mk(vscodeRoot, "dao-agi.dao-proxy-pro-9.9.342", "pro", "9.9.342");
  mk(devinRoot, "dao.dao-one-3.0.0.obsolete", "one", "9.9.999"); // 中间态 · 须忽略
  const origHomedir = os.homedir;
  os.homedir = () => home;
  try {
    const best = scanNewestSource();
    assert.ok(best, "应扫到源");
    assert.deepStrictEqual(best.ver, [9, 9, 361], "内容版号最新者胜(dao-one 内折)");
    assert.ok(best.file.includes("dao-one-2.28.9"), "选中 dao-one 内折源");
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
