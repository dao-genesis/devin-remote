#!/usr/bin/env node
/**
 * _revproxy_selftest.js · 模型反代自检
 * 起一个 mock 上游(OpenAI兼容 SSE) → 经 revproxy.handle 验证:
 *   /v1/models · /v1/chat/completions (stream+unary) · /v1/messages (stream+unary)
 * 零网络外发(mock 监听 127.0.0.1)。退出码 0=全过。
 */
"use strict";
const http = require("http");
const assert = require("assert");
const revproxy = require("./revproxy.js");

// ── 临时配置: 用临时 HOME 隔离 ~/.codeium/dao-byok/revproxy.json ──
const os = require("os");
const fs = require("fs");
const path = require("path");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "revproxy-st-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

let failures = 0;
function ok(name, cond) {
  if (cond) console.log("  ✓ " + name);
  else {
    console.error("  ✗ " + name);
    failures++;
  }
}

// mock 上游: OpenAI 兼容 /v1/chat/completions (stream) + anthropic /v1/messages
function startMockUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const body = JSON.parse(b || "{}");
        if (req.url === "/v1/chat/completions") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const id = "up-1";
          for (const tok of ["你好", "，", "道", "可道"]) {
            res.write(
              "data: " +
                JSON.stringify({
                  id,
                  choices: [{ index: 0, delta: { content: tok } }],
                }) +
                "\n\n",
            );
          }
          res.write(
            "data: " +
              JSON.stringify({
                id,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 4 },
              }) +
              "\n\n",
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (req.url === "/v1/messages") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            "event: content_block_delta\ndata: " +
              JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "claude-hi" },
              }) +
              "\n\n",
          );
          res.write(
            "event: message_delta\ndata: " +
              JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
              }) +
              "\n\n",
          );
          res.end();
        } else {
          res.writeHead(404);
          res.end("nope");
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// 伪 res: 收集写出
function fakeRes() {
  const r = {
    _status: 0,
    _headers: {},
    _chunks: [],
    writeHead(code, hdr) {
      this._status = code;
      Object.assign(this._headers, hdr || {});
    },
    setHeader(k, v) {
      this._headers[k] = v;
    },
    write(s) {
      this._chunks.push(s);
      return true;
    },
    end(s) {
      if (s) this._chunks.push(s);
      this._done = true;
      if (this._onDone) this._onDone();
    },
    get body() {
      return this._chunks.join("");
    },
  };
  return r;
}

function fakeReq(method, url, bodyObj) {
  const listeners = {};
  const req = {
    method,
    url,
    headers: { authorization: "Bearer " + KEY },
    socket: { remoteAddress: "127.0.0.1" },
    on(ev, cb) {
      listeners[ev] = cb;
      return req;
    },
  };
  process.nextTick(() => {
    if (bodyObj && listeners.data)
      listeners.data(Buffer.from(JSON.stringify(bodyObj)));
    if (listeners.end) listeners.end();
  });
  return req;
}

function call(method, urlPath, bodyObj, deps) {
  const res = fakeRes();
  const u = require("url").parse(urlPath, true);
  return new Promise((resolve, reject) => {
    res._onDone = () => resolve(res);
    revproxy
      .handle(fakeReq(method, urlPath, bodyObj), res, u, deps)
      .then((handled) => {
        if (!handled) reject(new Error("not handled: " + urlPath));
        if (res._done) resolve(res);
      })
      .catch(reject);
  });
}

let KEY = "";

(async () => {
  const mock = await startMockUpstream();
  const port = mock.address().port;
  const baseUrl = "http://127.0.0.1:" + port;

  // 配置: enable + 路由 glm-test → openai 渠道; claude-test → anthropic 渠道
  const cfg = revproxy.loadConfig();
  cfg.enabled = true;
  revproxy.saveConfig(cfg);
  KEY = cfg.apiKey;

  const eaConfig = {
    providers: {
      glmprov: {
        baseUrl,
        apiKey: "sk-test",
        completionPath: "/v1/chat/completions",
        protocol: "openai-chat",
        models: ["glm-test"],
      },
      claudeprov: {
        baseUrl,
        apiKey: "sk-test",
        completionPath: "/v1/messages",
        protocol: "anthropic",
        models: ["claude-test"],
      },
    },
    daoRoutes: {
      routes: {
        "glm-test": { provider: "glmprov", model: "glm-4-flash" },
        "claude-test": { provider: "claudeprov", model: "claude-3-haiku" },
      },
    },
  };
  const deps = {
    getEaConfig: () => eaConfig,
    getAvailableModels: () => [],
    resolveRoute: () => null,
    invertSP: (s) => s,
    getProxyAgent: () => null,
    log: () => {},
    version: "test",
    port: 9999,
  };

  console.log("[1] /v1/models");
  let r = await call("GET", "/v1/models", null, deps);
  let j = JSON.parse(r.body);
  ok("models lists glm-test", j.data.some((m) => m.id === "glm-test"));
  ok("models lists claude-test", j.data.some((m) => m.id === "claude-test"));

  console.log("[2] OpenAI non-stream");
  r = await call(
    "POST",
    "/v1/chat/completions",
    { model: "glm-test", messages: [{ role: "user", content: "hi" }] },
    deps,
  );
  j = JSON.parse(r.body);
  ok("oa unary content joined", j.choices[0].message.content === "你好，道可道");
  ok("oa unary finish stop", j.choices[0].finish_reason === "stop");
  ok("oa unary usage", j.usage && j.usage.completion_tokens === 4);

  console.log("[3] OpenAI stream");
  r = await call(
    "POST",
    "/v1/chat/completions",
    { model: "glm-test", stream: true, messages: [{ role: "user", content: "hi" }] },
    deps,
  );
  ok("oa stream has chunks", /chat\.completion\.chunk/.test(r.body));
  ok("oa stream content tokens", /你好/.test(r.body) && /可道/.test(r.body));
  ok("oa stream DONE", /data: \[DONE\]/.test(r.body));

  console.log("[4] Anthropic non-stream");
  r = await call(
    "POST",
    "/v1/messages",
    { model: "claude-test", max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
    deps,
  );
  j = JSON.parse(r.body);
  ok("anthropic unary text", j.content[0].text === "claude-hi");
  ok("anthropic unary type", j.type === "message");

  console.log("[5] Anthropic stream");
  r = await call(
    "POST",
    "/v1/messages",
    {
      model: "claude-test",
      stream: true,
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    },
    deps,
  );
  ok("anthropic stream message_start", /message_start/.test(r.body));
  ok("anthropic stream text_delta", /claude-hi/.test(r.body));
  ok("anthropic stream message_stop", /message_stop/.test(r.body));

  console.log("[6] unknown model → 400 no_route");
  r = await call(
    "POST",
    "/v1/chat/completions",
    { model: "nope-xyz", messages: [{ role: "user", content: "hi" }] },
    deps,
  );
  j = JSON.parse(r.body);
  ok("no_route error", r._status === 400 && j.error.type === "no_route");

  console.log("[7] auth: bad key → 401");
  {
    const res = fakeRes();
    const u = require("url").parse("/v1/models", true);
    const badReq = {
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer WRONG" },
      socket: { remoteAddress: "10.0.0.5" },
      on(ev, cb) {
        if (ev === "end") process.nextTick(cb);
        return this;
      },
    };
    await revproxy.handle(badReq, res, u, deps);
    ok("bad key 401", res._status === 401);
  }

  // ── 全量枚举 + 绿红着色 + 官方直通 ───────────────────────────────
  const catalog = [
    {
      modelUid: "swe-1-6",
      label: "SWE-1.6",
      provider: "MODEL_PROVIDER_WINDSURF",
      creditMultiplier: 0.5,
      modelCostTier: "MODEL_COST_TIER_FREE",
    },
    {
      modelUid: "claude-opus-4-7-medium",
      label: "Claude Opus 4.7 Medium",
      provider: "MODEL_PROVIDER_ANTHROPIC",
      creditMultiplier: 10,
      modelCostTier: "MODEL_COST_TIER_MEDIUM",
    },
  ];
  const depsFull = Object.assign({}, deps, {
    getModelCatalog: () => catalog,
    getOfficialFamilies: () => [],
  });

  console.log("[8] 全量枚举: 官方目录并入 + 绿红着色");
  revproxy.setPremiumQuota("exhausted");
  r = await call("GET", "/v1/models", null, depsFull);
  j = JSON.parse(r.body);
  const mFree = j.data.find((m) => m.id === "swe-1-6");
  const mPrem = j.data.find((m) => m.id === "claude-opus-4-7-medium");
  const mChan = j.data.find((m) => m.id === "glm-test");
  ok("枚举含官方免费 swe-1-6", !!mFree);
  ok("免费档=绿(免费·官方直通)", mFree && mFree.color === "green" && mFree.status === "free");
  ok("付费档配额耗尽=红", mPrem && mPrem.color === "red" && mPrem.status === "exhausted");
  ok("已配渠道=绿(channel)", mChan && mChan.color === "green" && mChan.status === "channel");
  const rs = await call("GET", "/origin/revproxy/status", null, depsFull);
  const js = JSON.parse(rs.body);
  ok("status 含统计 stats.green/red", typeof js.stats.green === "number" && js.stats.red >= 1);
  ok("status 回传 premiumQuota", js.premiumQuota === "exhausted");

  console.log("[9] 付费配额=ok 时官方付费转绿");
  revproxy.setPremiumQuota("ok");
  r = await call("GET", "/v1/models", null, depsFull);
  j = JSON.parse(r.body);
  ok(
    "配额 ok → 付费档绿",
    j.data.find((m) => m.id === "claude-opus-4-7-medium").color === "green",
  );

  console.log("[10] 官方直通: 未配渠道的官方模型不再 no_route");
  let officialCalled = null;
  const depsOfficial = Object.assign({}, depsFull, {
    officialChat: (target, norm, sink) => {
      officialCalled = { model: target.upstreamModel, free: target.free };
      sink.onText("官方直通回包·得一");
      sink.onEnd();
      return Promise.resolve({ ok: true, quota: "ok" });
    },
  });
  r = await call(
    "POST",
    "/v1/chat/completions",
    { model: "swe-1-6", messages: [{ role: "user", content: "测试免费模型反代" }] },
    depsOfficial,
  );
  j = JSON.parse(r.body);
  ok("免费官方模型经 officialChat", !!officialCalled && officialCalled.free === true);
  ok("官方直通回包内容", /官方直通回包/.test(j.choices[0].message.content));

  console.log("[11] 无 officialChat 时官方模型返回明确预热提示(非伪成功)");
  r = await call(
    "POST",
    "/v1/chat/completions",
    { model: "swe-1-6", stream: true, messages: [{ role: "user", content: "hi" }] },
    depsFull,
  );
  ok("预热提示经错误流回传", /预热|officialChat|未就绪/.test(r.body));

  console.log("[12] 官方直通捕获帧解析: 末条消息正文整体换为 newText(逐字节保形)");
  {
    const SRC = require("../../bundled-origin/source.js")._test;
    const { _pbTag, _pbEncVarint, _swapLastUserMsg, parseFrames, parseProto, _findMsgsArray, _msgContentInfo } = SRC;
    const strF = (f, s) => {
      const b = Buffer.from(s, "utf8");
      return Buffer.concat([_pbTag(f, 2), _pbEncVarint(b.length), b]);
    };
    const varF = (f, v) => Buffer.concat([_pbTag(f, 0), _pbEncVarint(v)]);
    const wrap = (f, body) => Buffer.concat([_pbTag(f, 2), _pbEncVarint(body.length), body]);
    const frameOf = (payload) => {
      const h = Buffer.alloc(5);
      h[0] = 0;
      h.writeUInt32BE(payload.length, 1);
      return Buffer.concat([h, payload]);
    };
    const lastContent = (frame) => {
      const top = parseProto(parseFrames(frame)[0].payload);
      const fnd = _findMsgsArray(top);
      return _msgContentInfo(fnd.arr[fnd.arr.length - 1]).text;
    };
    // 新 wire: 消息数组=field3, 每条 role=field2(varint) + content=field3(string)
    const longTxt = "<additional_metadata>\nNOTE: open files\n" + "x".repeat(300) + "\n用户问题";
    const newWire = Buffer.concat([
      wrap(3, Buffer.concat([varF(2, 1), strF(3, "old user A")])),
      wrap(3, Buffer.concat([varF(2, 1), strF(3, longTxt)])),
    ]);
    const f1 = _swapLastUserMsg(frameOf(newWire), "PINGPONG_NEW");
    ok("新wire(field3)末条正文被换", f1 && lastContent(f1) === "PINGPONG_NEW");
    ok("新wire首条正文保持原样", f1 && /old user A/.test(f1.toString("utf8")) && !/x{300}/.test(f1.toString("utf8")));
    // 老 wire: 消息数组=field2, content=field2
    const oldWire = Buffer.concat([
      wrap(2, Buffer.concat([varF(1, 1), strF(2, "first turn")])),
      wrap(2, Buffer.concat([varF(1, 1), strF(2, "second turn long " + "y".repeat(250))])),
    ]);
    const f2 = _swapLastUserMsg(frameOf(oldWire), "PINGPONG_OLD");
    ok("老wire(field2)末条正文被换", f2 && lastContent(f2) === "PINGPONG_OLD");
    // 空/坏帧不崩
    ok("空帧返回 null 不崩", _swapLastUserMsg(Buffer.alloc(0), "x") === null);

    // 回包解码: Connect end-stream 帧(gzip)载 JSON quota 错误 → parseFrames 解压 + JSON.parse 取 error
    const zlib = require("zlib");
    const errJson = JSON.stringify({ error: { code: "failed_precondition", message: "Your daily usage quota has been exhausted." } });
    const gz = zlib.gzipSync(Buffer.from(errJson, "utf8"));
    const esHdr = Buffer.alloc(5);
    esHdr[0] = 0x03; // bit0=compressed + bit1=end-stream
    esHdr.writeUInt32BE(gz.length, 1);
    const esFrame = Buffer.concat([esHdr, gz]);
    const dec = parseFrames(esFrame);
    ok("end-stream gzip 帧被解压", dec.length === 1 && /quota has been exhausted/.test(dec[0].payload.toString("utf8")));
    let parsedErr = null;
    try { parsedErr = JSON.parse(dec[0].payload.toString("utf8")).error; } catch (_) {}
    ok("end-stream JSON error 可解析", parsedErr && parsedErr.code === "failed_precondition");
    ok("quota 信号正则命中 exhausted", /quota|exhaust|precondition/i.test((parsedErr.code || "") + " " + (parsedErr.message || "")));
  }

  revproxy.setPremiumQuota("unknown");
  mock.close();
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAIL");
  process.exit(failures === 0 ? 1 - 1 : 1);
})().catch((e) => {
  console.error("selftest crash:", e);
  process.exit(1);
});
