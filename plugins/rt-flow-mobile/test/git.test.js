"use strict";
// git.test.js · Git 模块纯函数单测 (classifyRegisteredState 归一判据)
const assert = require("assert");
global.atob = (b) => Buffer.from(b, "base64").toString("binary");
require("../src/cloud.js");
require("../src/git.js");
const G = globalThis.DaoGit;

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log("  \u2713 " + name); pass++; } catch (e) { console.log("  \u2717 " + name + "\n      " + e.message); fail++; } }

console.log("classifyRegisteredState (Git 归一判据):");
t("无连接 → ghost (平台孤儿态)", () => {
  assert.strictEqual(G.classifyRegisteredState({ connections: [] }), "ghost");
  assert.strictEqual(G.classifyRegisteredState({}), "ghost");
});
t("github_app(OAuth) → app (绝不主动断)", () => {
  assert.strictEqual(G.classifyRegisteredState({ connections: [{ type: "github_app", name: "x" }], hasRepos: true }), "app");
});
t("已归一同主且有仓库 → existing (幂等成功)", () => {
  assert.strictEqual(G.classifyRegisteredState({ ownerLogin: "me", connections: [{ type: "github_individual_token", name: "me-conn" }], hasRepos: true }), "existing");
});
t("individual_token 连别身份/0仓库 → reinject (断净重注)", () => {
  assert.strictEqual(G.classifyRegisteredState({ ownerLogin: "me", connections: [{ type: "github_individual_token", name: "other" }], hasRepos: false }), "reinject");
  assert.strictEqual(G.classifyRegisteredState({ ownerLogin: "me", connections: [{ type: "github_individual_token", name: "me-conn" }], hasRepos: false }), "reinject");
});
t("模块导出齐备 (连接/断开/PAT/状态)", () => {
  for (const fn of ["connectWithPat", "robustDisconnectGit", "gitStatus", "injectGitHubPAT", "ensureGithubPatSecret", "disconnectGitHubUser"])
    assert.strictEqual(typeof G[fn], "function", "缺 " + fn);
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
