"use strict";
// 万法识号 v2.7 单测 (零依赖, node 直接跑): node test/parse.test.js
// 与 rt-flow/extension.js parseAccountText 同源 —— 覆盖所有截图所列格式。
const assert = require("assert");
const path = require("path");
const { parseAccountText, exportAccountsText, isValidEmail } = require(path.join(__dirname, "..", "src", "parse.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
}
const accs = (s) => parseAccountText(s).accounts;
const first = (s) => accs(s)[0];

console.log("万法识号 · 分隔符形:");
t("空格分隔 email password", () => {
  assert.deepStrictEqual(first("a@x.com pw123"), { email: "a@x.com", password: "pw123" });
});
t("冒号分隔 email:password", () => {
  assert.deepStrictEqual(first("a@x.com:pw123"), { email: "a@x.com", password: "pw123" });
});
t("竖线分隔 email|password", () => {
  assert.deepStrictEqual(first("a@x.com|pw123"), { email: "a@x.com", password: "pw123" });
});
t("逗号分隔 email,password", () => {
  assert.deepStrictEqual(first("a@x.com,pw123"), { email: "a@x.com", password: "pw123" });
});
t("四连破折号 email----password", () => {
  assert.deepStrictEqual(first("a@x.com----pw123"), { email: "a@x.com", password: "pw123" });
});
t("制表符分隔 email\\tpassword", () => {
  assert.deepStrictEqual(first("a@x.com\tpw123"), { email: "a@x.com", password: "pw123" });
});

console.log("万法识号 · 标签形:");
t("中文标签 邮箱:/密码: 两行", () => {
  assert.deepStrictEqual(first("邮箱：a@x.com\n密码：pw123"), { email: "a@x.com", password: "pw123" });
});
t("英文标签 Email:/Password: 两行", () => {
  assert.deepStrictEqual(first("Email: a@x.com\nPassword: pw123"), { email: "a@x.com", password: "pw123" });
});
t("双标签同行 邮箱:email----密码:pass", () => {
  assert.deepStrictEqual(first("邮箱：a@x.com----密码：pw123"), { email: "a@x.com", password: "pw123" });
});
t("逆序 密码在前邮箱在后", () => {
  assert.deepStrictEqual(first("密码：pw123\n邮箱：a@x.com"), { email: "a@x.com", password: "pw123" });
});
t("卡号N:/卡密N: 编号标签", () => {
  const r = accs("卡号1：a@x.com\n卡密1：XuE2@UXoq7JD");
  assert.deepStrictEqual(r[0], { email: "a@x.com", password: "XuE2@UXoq7JD" });
});

console.log("万法识号 · 守道反者:");
t("密码含@ (标签明确) 不被误判为 email", () => {
  assert.deepStrictEqual(first("账号：a@x.com\n密码：uuCO4@7hukcO"), { email: "a@x.com", password: "uuCO4@7hukcO" });
});
t("微信尾提示 (无任何空格) 被剥离", () => {
  assert.deepStrictEqual(first("账号：a@x.com (无任何空格)\n密码：uuCO4@7hukcO"), { email: "a@x.com", password: "uuCO4@7hukcO" });
});
t("账号管理器:URL 噪声行不误伤", () => {
  const r = accs("账号管理器：https://example.com\na@x.com pw123");
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0], { email: "a@x.com", password: "pw123" });
});
t("订单编号 等模板噪声行跳过", () => {
  const r = accs("订单编号：123456\na@x.com pw123");
  assert.strictEqual(r.length, 1);
});
t("URL 行不被冒号误切", () => {
  const r = accs("https://app.devin.ai/login");
  assert.strictEqual(r.length, 0);
});

console.log("万法识号 · JSON / Token:");
t("JSON 数组批量", () => {
  const r = accs('[{"email":"a@x.com","password":"p1"},{"email":"b@y.com","password":"p2"}]');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[1], { email: "b@y.com", password: "p2" });
});
t("JSON 单行", () => {
  assert.deepStrictEqual(first('{"email":"a@x.com","password":"p1"}'), { email: "a@x.com", password: "p1" });
});
t("裸 token 被归入 tokens 非 accounts", () => {
  const r = parseAccountText("devin-session-token$abcdeftoken");
  assert.strictEqual(r.accounts.length, 0);
  assert.strictEqual(r.tokens.length, 1);
});

console.log("万法识号 · 批量 / 去噪:");
t("多行混合批量识别", () => {
  const txt = ["a@x.com p1", "邮箱：b@y.com 密码：p2", "c@z.com----p3", "# 注释行", "随便一句中文"].join("\n");
  const r = accs(txt);
  assert.strictEqual(r.length, 3);
});
t("非法 email 不入账", () => {
  assert.strictEqual(accs("notanemail pw").length, 0);
});

console.log("isValidEmail / exportAccountsText:");
t("isValidEmail 严判", () => {
  assert.strictEqual(isValidEmail("a@x.com"), true);
  assert.strictEqual(isValidEmail("a@x"), false);
  assert.strictEqual(isValidEmail("a b@x.com"), false);
});
t("exportAccountsText 往返", () => {
  const a = [{ email: "a@x.com", password: "p1", label: "主" }];
  const txt = exportAccountsText(a);
  assert.ok(txt.includes("a@x.com p1"));
  assert.deepStrictEqual(parseAccountText(txt).accounts[0], { email: "a@x.com", password: "p1" });
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
