"use strict";
// 稳定永久序号 (用户实测: 账号移出库后其余账号序号整体平移 → 近期对话/备份网页/页签/对话文件名
//   按序号检索命中错号):
//   根治: 号一入库即领永久编号(发号器 rtflow.accNoSeq 只增不减), 移出库绝不平移、编号绝不复用;
//   存量号首次迁移按当前排序领 i+1 (与用户已熟悉的编号无缝接替); 全部序号消费点改读 a.no。
// 无框架: 直接 node test/acc-no-stable.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");
const engineSrc = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");
const daopanSrc = fs.readFileSync(path.join(ENGINE, "daopan.html"), "utf8");
const cloudSrc = fs.readFileSync(path.join(ENGINE, "cloud.html"), "utf8");
const autocleanSrc = fs.readFileSync(path.join(ENGINE, "autoclean.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(JAVA, "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 功能级: 从 switch.html 抠出 ensureAccNos 真源跑行为 ──
const m = switchSrc.match(/function ensureAccNos\(accs\)\{[\s\S]*?\n\}/);
ok(!!m, "switch.html 含 ensureAccNos 发号器");
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const ensureAccNos = new Function("localStorage", "return (" + m[0] + ")")(localStorage);

// 存量迁移: 无 no 的老池按当前排序领 i+1 (无缝接替用户熟悉的编号)
let accs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
ok(ensureAccNos(accs) === true, "存量池首次迁移返回已变更");
ok(accs.map(a => a.no).join(",") === "1,2,3,4", "存量迁移按当前排序领 1..4");
ok(store["rtflow.accNoSeq"] === "4", "发号器水位推进到 4");

// 幂等: 再跑不变
ok(ensureAccNos(accs) === false, "再跑幂等·无变更");

// 核心矛盾: 移出 2 号后其余编号绝不平移
accs.splice(1, 1);
ensureAccNos(accs);
ok(accs.map(a => a.no).join(",") === "1,3,4", "移出 2 号 → 1/3/4 号编号纹丝不动(绝不平移)");

// 编号绝不复用: 移出的是当前最大号, 新号仍领新编号(发号器只增不减)
accs.splice(2, 1);   // 移出 4 号(当前最大)
accs.push({ id: "e" });
ensureAccNos(accs);
ok(accs[2].no === 5, "移出最大号后新号领 5 (绝不复用已移出的 4 → 历史备份/文件名凭 4 永远指向原号)");
ok(store["rtflow.accNoSeq"] === "5", "发号器水位 5");

// ── 源级护栏: 全部序号消费点读稳定 no (出库不平移·各处同号) ──
ok(/function loadAcc\(\)\{ try\{ var a=JSON\.parse\(localStorage\.getItem\("rtflow\.accounts"\)\|\|"\[\]"\); if\(ensureAccNos\(a\)\) saveAcc\(a\); return a; \}/.test(switchSrc),
   "源级: switch loadAcc 读即修(迁移即持久化)");
ok(/'<span class="acc-no" title="永久编号 '\+\(a\.no\|\|i\+1\)/.test(switchSrc),
   "源级: 切号板行编号显示 a.no");
ok(/a2\.no=a\.no\|\|i\+1;/.test(switchSrc),
   "源级: 开账号页签带永久编号");
ok(/_noOf\[x\.id\]=x\.no\|\|ix\+1;/.test(switchSrc),
   "源级: 追踪轮询编号表用永久编号");
ok(/function ensureAccNos\(accs\)\{/.test(engineSrc) && /if\(ensureAccNos\(a\)\) saveAcc\(a\);/.test(engineSrc),
   "源级: engine loadAcc 同源读即修");
ok(/unlocked\.push\(\{a:accs\[i\],no:accs\[i\]\.no\|\|i\+1\}\)/.test(engineSrc),
   "源级: engine recentConvAll 用永久编号");
ok(/noOf\[k\]=\(x&&x\.no\)\|\|ix\+1;/.test(engineSrc),
   "源级: engine 金库镜像编号表用永久编号");
ok(/no:a\.no\|\|rec\.no\|\|\(accList\(\)\.indexOf\(a\)\+1\)/.test(daopanSrc) && /unlocked\.push\(\{a:all\[i\],no:all\[i\]\.no\|\|i\+1\}\)/.test(daopanSrc),
   "源级: 近期对话(daopan)用永久编号");
ok(/_libByKey\[String\(a\.email\)\.toLowerCase\(\)\]=\{acc:a,no:a\.no\|\|i\+1\}/.test(cloudSrc),
   "源级: 备份网页(cloud)账号库编号用永久编号");
ok(/no:hit\?hit\.no:\(\(rm&&rm\.account&&rm\.account\.no\)\|\|0\)/.test(cloudSrc) && /no:\(rec\.account&&rec\.account\.no\)\|\|0/.test(cloudSrc),
   "源级: 已移出账号从移出记录快照回显移出前永久编号(序号直搜含移出号)");
ok(/no: a\.no \|\| 0/.test(autocleanSrc),
   "源级: 移出记录快照留存永久编号");
ok(/var n=\(typeof a\[i\]\.no==='number'&&a\[i\]\.no>0\)\?a\[i\]\.no:\(i\+1\);/.test(mainSrc),
   "源级: 原生 sAcctNo 序号表(页签【N】/对话文件名)用永久编号");

if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
console.log("acc-no-stable: all passed");
