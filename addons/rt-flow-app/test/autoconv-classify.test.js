"use strict";
// 实测「自动化对话误判」根因回归 (问题: 本人正常英文对话被误隐 → 无法备份/追踪/查看):
//   加载真代码 devin-cloud.js 的 DaoCloud.isAutoConv, 用 app.devin.ai 实测样本断言:
//   1) Devin 自动生成的样板任务(带 `onboarding` 标签·跑在 blog-drafts-\d+ 等样板仓) → 判自动化;
//   2) 本人对话(标签 agent:*/agent-preview:*·不含 onboarding), 无论标题是否以动词起头
//      ("Fix …" / "Integrate …" / "Improve …") → 一律判本人对话, 绝不误隐;
//   3) 纯标题字符串场景: 仅「样板仓名+序号」这一强信号判自动化; 普通英文标题一律保留;
//   4) 源级护栏: 判定不得再含「动词起头」弱启发式 (AUTO_VERB 已根除)。
// 无框架: 直接 node test/autoconv-classify.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app", "src", "main");
const cloudPath = path.join(APP, "assets", "engine", "devin-cloud.js");
const cloudSrc = fs.readFileSync(cloudPath, "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 加载真代码: 提供最小 root (含 DaoCore stub), 捕获 root.DaoCloud
const root = { DaoCore: { APP: "https://app.devin.ai", httpReq: function () {}, devinJsonGet: function () {}, sleep: function () {} } };
new Function("root", cloudSrc.replace(/\}\)\(window\);\s*$/, "})(root);"))(root);
const DaoCloud = root.DaoCloud;
ok(!!(DaoCloud && typeof DaoCloud.isAutoConv === "function"), "devin-cloud.js 可加载并暴露 DaoCloud.isAutoConv");

const isAuto = DaoCloud.isAutoConv;

// ── 1) Devin 样板任务(onboarding 标签) → 自动化 (app.devin.ai 实测样本) ──
const onboarding = [
  { title: "Security scan of blog-drafts-018915", tags: ["onboarding", "agent:devin-rs"] },
  { title: "Improve error handling in blog-drafts-018915", tags: ["onboarding", "agent:devin-rs"] },
  { title: "Review recent changes in learn-cs-028834", tags: ["onboarding", "agent:devin-rs"] },
  { title: "Add test coverage for learn-cs-028834", tags: ["onboarding", "agent:devin-rs"] },
  { title: "Refactor duplicated code in learn-cs-028834", tags: ["onboarding", "agent:devin-rs"] },
];
onboarding.forEach(function (s) { ok(isAuto(s) === true, "样板任务判自动化: " + s.title); });

// ── 2) 本人对话(无 onboarding·动词起头英文) → 绝不误隐 (核心回归) ──
const mine = [
  { title: "Fix devin-remote multi-RDP credentials", tags: ["agent-preview:devin-opus-4-8", "agent:devin-rs"] },
  { title: "Integrate plugins into Windows repo", tags: ["agent:devin-rs"] },
  { title: "Improve error handling in my real project", tags: ["agent-preview:devin-opus-4-8"] },
  { title: "Update PCB project organization", tags: ["agent:devin-rs"] },
  { title: "proxy pro外接api", tags: ["agent-preview:devin-opus-4-8", "agent:devin-rs"] },
  { title: "多rdp问题", tags: ["agent:devin-rs"] },
];
mine.forEach(function (s) { ok(isAuto(s) === false, "本人对话绝不误隐: " + s.title); });

// ── 3) 纯标题字符串场景 ──
ok(isAuto("Security scan of blog-drafts-018915") === true, "字符串·样板仓名+序号 → 自动化");
ok(isAuto("Fix devin-remote multi-RDP credentials") === false, "字符串·动词起头本人对话 → 保留");
ok(isAuto("Integrate plugins into Windows repo") === false, "字符串·Integrate 起头本人对话 → 保留");
ok(isAuto("Update devin-remote dialog plugin") === false, "字符串·Update 起头本人对话 → 保留");
ok(isAuto("") === false, "空标题 → 非自动化");

// ── 4) 源级护栏: 已根除动词启发式 ──
ok(!/AUTO_VERB/.test(cloudSrc), "AUTO_VERB 动词启发式已从源码根除");
ok(/onboarding/.test(cloudSrc), "AUTO_TAG 已纳入 onboarding 标签识别");

if (failures) { console.error("\n" + failures + " 项失败"); process.exit(1); }
console.log("\n全部通过");
