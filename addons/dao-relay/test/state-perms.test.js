// state-perms.test.js — 凭据落盘守护: relay.json 含 CF 令牌/refresh_token,
//   必须 0600(仅属主可读写), 防同机他用户窃读。运行: node --test test/
import { test } from "node:test";
import assert from "node:assert";
import { statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState, stateFile } from "../provision.mjs";

test("saveState 落盘 relay.json 权限为 0600(仅属主可读写)", (t) => {
  if (process.platform === "win32") return t.skip("Windows 无 POSIX 权限位");
  const fakeHome = mkdtempSync(join(tmpdir(), "dao-relay-perms-"));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const f = saveState({ url: "https://example.test", token: "x".repeat(40) });
    assert.strictEqual(f, stateFile());
    assert.ok(f.startsWith(fakeHome), "须写入测试 HOME 而非真实 HOME");
    const mode = statSync(f).mode & 0o777;
    assert.strictEqual(mode, 0o600, `relay.json 权限应为 0600, 实为 ${mode.toString(8)}`);
  } finally {
    process.env.HOME = oldHome;
  }
});
