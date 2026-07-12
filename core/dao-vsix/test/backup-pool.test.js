// backup-pool.test.js · 出库账号本地可查/加回 护栏 (借鉴手机版·帛书「既得其母·以知其子·复守其母」)
//
// 需求: 备份网页端应展示手机/本机本地【所有历史备份】, 含已移出账号池(出库)的账号;
//   出库账号无当前序号也要能看/搜/解锁, 且可【按普通新账号】一键加回账号库。
// 本测试锁定纯逻辑:
//   ① daoBackupFolderPwd 从备份目录名 <编号?>_<邮箱本地名>_<密码?> 尽力恢复密码 (无则空)
//   ② daoAnnotateBackupPool 标注 inPool(在池) / canReAdd(可加回), 不误伤在池账号
//   ③ 当前账号池 ≠ 历史备份: 出库账号仍出现在树中且被标 inPool=false
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { transform } = require("sucrase");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("  ✓ " + msg); pass++; }

console.log("[dao-vsix 出库账号本地可查/加回 + 自动化对话隔离 · 护栏]");

function slice(name) {
    const i = src.indexOf("function " + name);
    assert.ok(i > 0, "源含 " + name);
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
        const c = src[j];
        if (c === "{") { depth++; started = true; }
        else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
}

const mod = slice("daoBackupFolderPwd") + "\n" + slice("daoAnnotateBackupPool") +
    "\nmodule.exports = { daoBackupFolderPwd, daoAnnotateBackupPool };\n";
const js = transform(mod, { transforms: ["typescript"] }).code;
const sandbox = { module: { exports: {} }, Math, Object, String, Array, Set };
// 注入池桩: 当前账号池仅含 alice(在库) + bob(在库), carol 已出库(不在池)
sandbox.loadAccountPool = () => ([{ email: "alice@dao.test", password: "x" }, { email: "bob@dao.test", password: "y" }]);
new Function("module", "exports", "Math", "Object", "String", "Array", "Set", "loadAccountPool", js)(
    sandbox.module, sandbox.module.exports, Math, Object, String, Array, Set, sandbox.loadAccountPool);
const { daoBackupFolderPwd, daoAnnotateBackupPool } = sandbox.module.exports;

// ① 密码恢复
ok(daoBackupFolderPwd("01_alice_Passw0rd", "alice@dao.test") === "Passw0rd", "编号+本地名+密码 → 恢复密码");
ok(daoBackupFolderPwd("alice_Secret123", "alice@dao.test") === "Secret123", "无编号 → 仍恢复密码");
ok(daoBackupFolderPwd("02_bob_a_b_c", "bob@dao.test") === "a_b_c", "含下划线的密码整段拼回");
ok(daoBackupFolderPwd("07_carol", "carol@dao.test") === "", "仅编号+本地名(无密码段) → 空(交由手动加回)");
ok(daoBackupFolderPwd("", "alice@dao.test") === "", "空目录名 → 空");

// ② / ③ 标注: 池外账号 inPool=false 且(有密码时)canReAdd=true; 池内不标 canReAdd
const tree = { root: "/x", accounts: [
    { account: "01_alice_pw1", email: "alice@dao.test", accountNo: 1, conversations: [] },
    { account: "05_carol_CarolPw", email: "carol@dao.test", accountNo: 0, conversations: [] },
    { account: "09_dave", email: "dave@dao.test", accountNo: 0, conversations: [] },
] };
daoAnnotateBackupPool(tree);
const byEmail = {}; tree.accounts.forEach(a => { byEmail[a.email] = a; });
ok(byEmail["alice@dao.test"].inPool === true, "在池账号 inPool=true");
ok(byEmail["carol@dao.test"].inPool === false, "出库账号 inPool=false(仍在备份树中)");
ok(byEmail["carol@dao.test"].canReAdd === true, "出库账号有可恢复密码 → 可一键加回");
ok(byEmail["dave@dao.test"].inPool === false && byEmail["dave@dao.test"].canReAdd === false,
    "出库账号无可恢复密码 → 不标可加回(引导手动)");
ok(byEmail["alice@dao.test"].canReAdd === undefined, "在池账号不标 canReAdd(不重复加回)");

// ④ 非本人自动化对话判定 (bkIsAuto · 与手机 APK devin-cloud.js isAutoConv 同源:
//    只认结构化信号 —— 标签/playbook/automation 字段/样板仓名, 绝不用动词/长度启发式)
const repoLine = src.match(/var BK_AUTO_REPO=[^\n]*/)[0];
const tagLine = src.match(/var BK_AUTO_TAG=[^\n]*/)[0];
const mod2 = repoLine + "\n" + tagLine + "\n" + slice("bkIsAuto") + "\nmodule.exports={bkIsAuto};\n";
const js2 = transform(mod2, { transforms: ["typescript"] }).code;
const sb2 = { module: { exports: {} }, String };
new Function("module", "exports", "String", js2)(sb2.module, sb2.module.exports, String);
const { bkIsAuto } = sb2.module.exports;

ok(bkIsAuto("完善二合一插件账号备份") === false, "中文标题 → 本人对话");
ok(bkIsAuto("Review PR #123 and fix CI") === false, "英文动词起头(Review) → 本人对话(不再误判)");
ok(bkIsAuto("implement backup parity") === false, "动词 implement → 本人对话(不再误判)");
ok(bkIsAuto("Fix bug in blog-drafts-42 repo") === true, "样板仓库名 blog-drafts-42 → 自动化");
ok(bkIsAuto("ab") === false, "超短名 → 本人对话(不再误判)");
ok(bkIsAuto("Devin Cloud 手机端整合方案") === false, "中英混含中文 → 本人对话");
ok(bkIsAuto("") === false, "空标题 → 非自动化(不下沉)");
ok(bkIsAuto({title:"Improve docs",tags:[{name:"onboarding"}]}) === true, "onboarding 标签 → 自动化(结构化信号)");
ok(bkIsAuto({title:"Weekly report",playbook_id:"pb-1"}) === true, "playbook_id → 自动化");
ok(bkIsAuto({title:"Nightly sync",trigger_type:"scheduled"}) === true, "scheduled 触发 → 自动化");
ok(bkIsAuto({title:"Fix login flow",tags:[{name:"agent:web"}]}) === false, "agent:* 标签 → 本人对话");

console.log("\n全部通过 (" + pass + " 项)");
