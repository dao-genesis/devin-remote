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

// 帛书·「曲则全」: 上下文会漂移(dao-vsix 源在别处增删/拉长某行) → 严格全块匹配
// 一行不符即整 hunk 失败, 是 dao-one 构建反复崩的根。故仿 GNU patch「fuzz」: 全块
// 匹配不中时, 渐进裁掉两端「可弃的纯上下文行」(优先裁尾, 次裁头), 只要核心改动块
// (含 - 行)与剩余锚点仍唯一命中即应用。纯插入 hunk 以前导上下文为锚, 尾随上下文可弃。
function applyUnifiedDiff(source, patchText) {
  const eol = source.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  let srcLines = source.split(/\r?\n/);
  const hunks = parseHunks(patchText);
  for (const h of hunks) {
    // 拆 hunk: 前导纯上下文 / 核心(含 -/+, 及其间夹的上下文) / 尾随纯上下文。
    let lead = 0;
    while (lead < h.lines.length && h.lines[lead].tag === " ") lead++;
    let trail = 0;
    while (trail < h.lines.length - lead && h.lines[h.lines.length - 1 - trail].tag === " ") trail++;
    const leadCtx = h.lines.slice(0, lead).map((l) => l.text);
    const trailCtx = trail ? h.lines.slice(h.lines.length - trail).map((l) => l.text) : [];
    const core = h.lines.slice(lead, h.lines.length - trail);
    const coreBefore = core.filter((l) => l.tag === " " || l.tag === "-").map((l) => l.text);
    const coreAfter = core.filter((l) => l.tag === " " || l.tag === "+").map((l) => l.text);
    const hint = Math.max(0, h.oldStart - 1);

    let applied = false;
    const maxDrop = leadCtx.length + trailCtx.length;
    // fuzz 由小到大; 同等裁剪量下优先裁尾(保前导锚)。
    for (let total = 0; total <= maxDrop && !applied; total++) {
      for (let dropTrail = Math.min(total, trailCtx.length); dropTrail >= 0 && !applied; dropTrail--) {
        const dropLead = total - dropTrail;
        if (dropLead > leadCtx.length) continue;
        const lc = leadCtx.slice(dropLead);
        const tc = trailCtx.slice(0, trailCtx.length - dropTrail);
        const before = lc.concat(coreBefore, tc);
        if (before.length === 0) continue; // 无锚不可定位
        const at = findBlock(srcLines, before, hint + dropLead);
        if (at < 0) continue;
        const after = lc.concat(coreAfter, tc);
        srcLines = srcLines.slice(0, at).concat(after, srcLines.slice(at + before.length));
        applied = true;
      }
    }
    if (!applied) {
      throw new Error(
        "apply-overlay: hunk @ -" + h.oldStart + " context not found (lead " + leadCtx.length + " trail " + trailCtx.length + " core " + coreBefore.length + ")",
      );
    }
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
