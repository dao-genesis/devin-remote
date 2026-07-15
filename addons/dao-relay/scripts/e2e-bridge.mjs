// 本地端到端验证「透明桥」: wrangler dev(Miniflare·本地 DO) + 一个模拟 agent WS。
//   1) 模拟 agent 以 /connect?session=S&token=T 连上 → DO 登记 token→session 目录
//   2) curl 恒定地址 GET /api/health(仅 Bearer, 不带 session) → Worker 按目录解析 session
//      → 帧化 POST 到配对 DO → DO 经 WS 下发 {type:request} → 模拟 agent 回 {type:response}
//   3) 断言拿回 agent 造的响应体 → 证明真·drop-in 透传闭环成立。
// 运行: (先 `npx wrangler@^3 dev --port 8787 --local`) 后 `node --experimental-websocket scripts/e2e-bridge.mjs`
const BASE = process.env.DAO_E2E_BASE || "http://127.0.0.1:8787";
const WSB = BASE.replace(/^http/, "ws");
const S = "e2e-sess-" + Math.random().toString(16).slice(2, 10);
const T = "e2e-tok-" + Math.random().toString(16).slice(2, 10);

function fail(m) { console.error("FAIL:", m); process.exit(1); }

const ws = new WebSocket(`${WSB}/connect?session=${encodeURIComponent(S)}&token=${encodeURIComponent(T)}`);
ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
  if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
  if (m.type === "request" && m.id) {
    // 模拟本机桥: 对 /api/health 回一个可识别的响应
    const body = m.path.startsWith("/api/health")
      ? { status: "ok", service: "dao-bridge", via: "e2e-mock-agent", echoPath: m.path, echoMethod: m.method }
      : { echo: m };
    ws.send(JSON.stringify({ type: "response", id: m.id, status: 200, body }));
  }
});

ws.addEventListener("open", async () => {
  await new Promise((r) => setTimeout(r, 800)); // 待 DO 登记目录
  // A) 目录自动解析(无显式 session, 仅 Bearer)
  const rA = await fetch(`${BASE}/api/health`, { headers: { Authorization: "Bearer " + T } });
  const jA = await rA.json();
  if (!(rA.status === 200 && jA.via === "e2e-mock-agent" && jA.echoMethod === "GET")) {
    fail("目录解析透传失败: " + rA.status + " " + JSON.stringify(jA));
  }
  console.log("PASS A 目录自动解析 GET /api/health →", JSON.stringify(jA));

  // B) 显式 X-Dao-Session 头
  const rB = await fetch(`${BASE}/api/native`, {
    method: "POST",
    headers: { Authorization: "Bearer " + T, "X-Dao-Session": S, "content-type": "application/json" },
    body: JSON.stringify({ m: "ping" }),
  });
  const jB = await rB.json();
  if (!(rB.status === 200 && jB.echo && jB.echo.method === "POST")) {
    fail("X-Dao-Session 透传失败: " + rB.status + " " + JSON.stringify(jB));
  }
  console.log("PASS B 显式 X-Dao-Session POST /api/native →", JSON.stringify(jB.echo.body));

  // C) 错误 token 无目录 → 502 no_agent(不静默 404, 不串到他人 DO)
  const rC = await fetch(`${BASE}/api/health`, { headers: { Authorization: "Bearer wrong-" + T } });
  const jC = await rC.json();
  if (!(rC.status === 502 && jC.error === "no_agent")) {
    fail("错误 token 应 502 no_agent, 实得: " + rC.status + " " + JSON.stringify(jC));
  }
  console.log("PASS C 未知 token → 502 no_agent(隔离正确)");

  // D) 健康路由不受影响
  const rD = await fetch(`${BASE}/health`);
  const jD = await rD.json();
  if (!(rD.status === 200 && jD.status === "ok" && jD.service === "dao-relay")) {
    fail("/health 回归失败: " + JSON.stringify(jD));
  }
  console.log("PASS D /health 回归正常 →", jD.version);

  ws.close();
  console.log("\nALL E2E PASS ✓ 透明桥闭环成立");
  process.exit(0);
});

ws.addEventListener("error", (e) => fail("ws error: " + (e.message || "connect failed")));
setTimeout(() => fail("timeout"), 15000);
