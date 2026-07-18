// One-off driver: browseExecJs on a tab and print the resolved value.
// execJs resolves the JS expression's value (async promise NOT awaited by the bridge),
// so for async work use the kick+read pattern: first call sets window.__R, second reads it.
// Usage: node cf-drive.mjs <session> <token> <tabIndex> '<js expression>'
import { spawnSync } from "node:child_process";
const [,, S, T, TAB, JS] = process.argv;
const frame = JSON.stringify({ path: "/api/rpc", body: { cmd: "browseExecJs", tabIndex: Number(TAB), js: JS } });
const r = spawnSync("node", ["dao-mesh-rpc.mjs", S, T, frame], { cwd: import.meta.dirname, encoding: "utf8", timeout: 90000 });
const out = (r.stdout || "").split("\n").filter(Boolean);
const line = out[out.length - 1] || "";
try {
  const o = JSON.parse(line);
  if (o.raw) { const raw = JSON.parse(o.raw); let b; try { b = JSON.parse(raw.bodyText); } catch { b = raw; } console.log(JSON.stringify(b)); }
  else console.log(JSON.stringify(o));
} catch { console.log("PARSE_FAIL:", line, "STDERR:", (r.stderr||"").slice(-300)); }
