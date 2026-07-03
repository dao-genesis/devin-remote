// 更新说明极简化护栏: 用户只需最新版一条最少量说明, 历史版本号长列表是负担。
//   ① latest.json 的 notes 只含最新版一条 (不含任何旧版本号行)
//   ② CI 发版工作流两处回写 notes 均带「只留最新一条」截断
//   ③ APK 端 fetchUpdateInfo 对 notes 兜底截断 (镜像残留旧格式也只显示最新一条)
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}

// ① latest.json 单条
const latest = JSON.parse(fs.readFileSync(path.join(ROOT, "latest.json"), "utf8"));
ok(latest.notes.startsWith("v" + latest.versionName), "notes 以当前版本号开头");
ok(!/\nv\d+\./.test(latest.notes.slice(1)), "notes 不含任何旧版本条目");
ok(latest.notes.length < 1200, "notes 足够精简 (<1200 字符)");

// ② 工作流截断
const wf = fs.readFileSync(path.join(ROOT, "..", "..", ".github", "workflows", "android-release.yml"), "utf8");
const cuts = wf.match(/search\(\/\\nv\\d\+\\\.\/\)/g) || [];
ok(cuts.length >= 2, "android-release.yml 两处 notes 回写均带只留最新一条的截断 (found " + cuts.length + ")");

// ③ APK 端兜底
const main = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/MainActivity.java"), "utf8");
ok(/static String trimNotesLatest\(/.test(main), "MainActivity 有 trimNotesLatest");
ok(/out\.put\("notes", trimNotesLatest\(/.test(main), "fetchUpdateInfo 经 trimNotesLatest 输出 notes");

// trimNotesLatest 语义 (JS 等价复算)
function trimJs(notes) {
  const m = /\nv\d+\./.exec(notes.slice(1));
  if (m) notes = notes.slice(0, m.index + 1);
  return notes.trim();
}
ok(trimJs("v0.37.130 · 新\nv0.37.129 · 旧\nv0.37.128 · 更旧") === "v0.37.130 · 新", "截断: 多条只留第一条");
ok(trimJs("v0.37.130 · 新\n• 细节续行\nv0.37.129 · 旧") === "v0.37.130 · 新\n• 细节续行", "截断: 保留最新条的多行细节");
ok(trimJs("v0.37.130 · 单条") === "v0.37.130 · 单条", "截断: 单条原样");

console.log(failed ? `FAILED ${failed}/${passed + failed}` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
