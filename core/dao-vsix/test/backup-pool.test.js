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

console.log("[dao-vsix 出库账号本地可查/加回 · 护栏]");

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

console.log("\n全部通过 (" + pass + " 项)");
