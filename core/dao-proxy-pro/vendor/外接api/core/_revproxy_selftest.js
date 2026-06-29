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

  mock.close();
  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAIL");
  process.exit(failures === 0 ? 1 - 1 : 1);
})().catch((e) => {
  console.error("selftest crash:", e);
  process.exit(1);
});
