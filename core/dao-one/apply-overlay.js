// 道·归 — 纯 Node 上下文级 unified-diff 应用器
// 帛·「巧拙可伏藏」: dao-vsix 源保持二合一(无 proxy), dao-one 构建期把
// proxy-fold.patch 叠加到 vendor 副本的 .ts 上再转译 → dao-one 真三合一。
// 上下文匹配(忽略绝对行号), 容许 dao-vsix 源在别处增删导致的行偏移。
"use strict";

function parseHunks(patchText) {
  const lines = patchText.split(/\r?\n/);
  const hunks = [];
  let cur = null;
  for (const ln of lines) {
    if (ln.startsWith("--- ") || ln.startsWith("+++ ")) continue;
    const m = ln.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      cur = { oldStart: parseInt(m[1], 10), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    // diff body line: first char is ' ', '-', '+', or '\' (no newline marker).
    // GNU diff 用 " "(单空格)表示空上下文行; 长度 0 的行是 EOF 末尾换行产物, 跳过。
    if (ln.length === 0) continue;
    const tag = ln[0];
    if (tag === "\\") continue; // "\ No newline at end of file"
    if (tag === " " || tag === "-" || tag === "+") {
      cur.lines.push({ tag, text: ln.slice(1) });
    }
  }
  return hunks;
}

function findBlock(srcLines, block, hintIdx) {
  // returns the index of the first line of an exact contiguous match closest to hintIdx, or -1
  if (block.length === 0) return -1;
  const matches = [];
  for (let i = 0; i + block.length <= srcLines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (srcLines[i + j] !== block[j]) { ok = false; break; }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 0) return -1;
  matches.sort((a, b) => Math.abs(a - hintIdx) - Math.abs(b - hintIdx));
  return matches[0];
}

function applyUnifiedDiff(source, patchText) {
  const eol = source.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  let srcLines = source.split(/\r?\n/);
  const hunks = parseHunks(patchText);
  for (const h of hunks) {
    const before = h.lines.filter((l) => l.tag === " " || l.tag === "-").map((l) => l.text);
    const after = h.lines.filter((l) => l.tag === " " || l.tag === "+").map((l) => l.text);
    const hint = Math.max(0, h.oldStart - 1);
    const at = findBlock(srcLines, before, hint);
    if (at < 0) {
      throw new Error("apply-overlay: hunk @ -" + h.oldStart + " context not found (before-block " + before.length + " lines)");
    }
    srcLines = srcLines.slice(0, at).concat(after, srcLines.slice(at + before.length));
  }
  return srcLines.join(eol);
}

module.exports = { applyUnifiedDiff };

if (require.main === module) {
  const fs = require("fs");
  const [, , srcPath, patchPath, outPath] = process.argv;
  const out = applyUnifiedDiff(fs.readFileSync(srcPath, "utf8"), fs.readFileSync(patchPath, "utf8"));
  if (outPath) fs.writeFileSync(outPath, out);
  else process.stdout.write(out);
}
