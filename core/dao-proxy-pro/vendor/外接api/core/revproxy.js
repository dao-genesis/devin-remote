#!/usr/bin/env node
/**
 * revproxy.js · 模型反代 (Model Reverse Proxy) · 反者道之动
 * ──────────────────────────────────────────────────────────────────────
 * 唯一职: 把「渠道配置 / 模型路由」里已接通的模型(免费 GLM / 官方家族映射 / 任意
 *         OpenAI·Anthropic 兼容渠道)反向暴露为**标准本地端点**, 脱离 Devin Desktop,
 *         供智能家居 / 本地脚本 / 其他设备直接以标准 SDK 调用。
 *
 *   入站(本地客户端)            内部                          出站(渠道配置之真上游)
 *   ─────────────────          ─────────────                 ──────────────────────
 *   POST /v1/chat/completions  → 归一 {messages,system,...} → openai-chat  /v1/chat/completions
 *   POST /v1/messages (Claude) → 经 模型路由 解析目标渠道   → anthropic    /v1/messages
 *   GET  /v1/models            → 列出可反代模型(routed)
 *
 *   道义: 四十章「反者道之动」· 官方反代是「入站→剥提示归本源→标准出站」的反向通道;
 *         与正向 source.js(Cascade→上游)同源同法, 仅方向相反。
 *
 * 鉴权: 本地客户端持 Bearer <apiKey> (或 x-api-key)。apiKey 空 → 仅 127.0.0.1 放行。
 * 配置: ~/.codeium/dao-byok/revproxy.json
 *   { enabled, apiKey, applyInvert, exposeLan, defaultMaxTokens }
 *
 * 本模块自包含(只依赖 node 内置 + 同目录 adapters.js), 由 source.js 在 /v1/* 与
 * /origin/revproxy/* 路径上委派调用。
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let _adapters = null;
function _getAdapters() {
  if (_adapters) return _adapters;
  try {
    _adapters = require(path.join(__dirname, "adapters.js"));
  } catch (e) {
    _adapters = null;
  }
  return _adapters;
}

function _byokDir() {
  const home = os.homedir();
  return home ? path.join(home, ".codeium", "dao-byok") : null;
}
function _cfgPath() {
  const d = _byokDir();
  return d ? path.join(d, "revproxy.json") : null;
}

function defaultConfig() {
  return {
    enabled: false,
    // 本地客户端鉴权 key · 空串=仅 localhost 放行 · 生成一次落盘
    apiKey: "",
    // 是否对入站 system 施「本源观照」(invertSP·剥官方着相归本源) · 默认否(透传用户提示)
    applyInvert: false,
    // 是否允许局域网(0.0.0.0)其他设备访问 · 仅状态标记, 实际监听仍由 source.js 决定
    exposeLan: false,
    defaultMaxTokens: 4096,
  };
}

function loadConfig() {
  const p = _cfgPath();
  let cfg = defaultConfig();
  try {
    if (p && fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg = Object.assign(cfg, raw || {});
    }
  } catch (_) {}
  // 首次无 key → 生成稳定本地 key 落盘 (dao-local-xxxx)
  if (!cfg.apiKey) {
    cfg.apiKey = "dao-local-" + crypto.randomBytes(12).toString("hex");
    saveConfig(cfg);
  }
  return cfg;
}

function saveConfig(cfg) {
  const d = _byokDir();
  const p = _cfgPath();
  if (!d || !p) return false;
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

// ── 鉴权 ────────────────────────────────────────────────────────────────
function _isLocal(req) {
  const a = (req.socket && req.socket.remoteAddress) || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
function _authOk(req, cfg) {
  if (!cfg.apiKey) return _isLocal(req); // 无 key → 仅本机
  const h = req.headers || {};
  const bearer = (h["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const xkey = (h["x-api-key"] || "").trim();
  const given = bearer || xkey;
  if (!given) return false;
  // 定长比较 · 防时序侧信道
  try {
    const a = Buffer.from(given);
    const b = Buffer.from(cfg.apiKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return given === cfg.apiKey;
  }
}

// ── 模型枚举 ──────────────────────────────────────────────────────────────
// 列出「已配置反代通道」的模型: 模型路由表里每条 route 即一个可对外模型。
// 另把渠道(provider)显式声明的 models 也并入(脱敏·不泄 key)。
function listModels(deps) {
  const out = [];
  const seen = new Set();
  const cfg = (deps.getEaConfig && deps.getEaConfig()) || {};
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  const providers = cfg.providers || {};
  const push = (id, owned_by, extra) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(
      Object.assign(
        {
          id,
          object: "model",
          created: 0,
          owned_by: owned_by || "dao-revproxy",
        },
        extra || {},
      ),
    );
  };
  // 1) 路由表 → 对外以 modelUid 暴露
  for (const [uid, r] of Object.entries(routes)) {
    push(uid, (r && r.provider) || "routed", {
      dao_route: { provider: r && r.provider, model: r && r.model },
    });
  }
  // 2) provider 显式 models
  for (const [name, p] of Object.entries(providers)) {
    const ms = (p && p.models) || [];
    for (const m of ms) push(m, name);
  }
  return out;
}

// ── 入站归一 ──────────────────────────────────────────────────────────────
// 把 OpenAI / Anthropic 请求体归一为内部统一结构。
function normalizeInbound(kind, body) {
  body = body || {};
  let system = "";
  let messages = [];
  if (kind === "anthropic") {
    if (typeof body.system === "string") system = body.system;
    else if (Array.isArray(body.system))
      system = body.system
        .map((b) => (b && typeof b.text === "string" ? b.text : ""))
        .join("");
    messages = (body.messages || []).map((m) => ({
      role: m.role,
      content: _flattenContent(m.content),
    }));
  } else {
    // openai-chat
    for (const m of body.messages || []) {
      if (m.role === "system") {
        system += (system ? "\n" : "") + _flattenContent(m.content);
      } else {
        messages.push({ role: m.role, content: _flattenContent(m.content) });
      }
    }
  }
  return {
    system,
    messages,
    model: body.model || "",
    stream: body.stream === true,
    tools: body.tools || null,
    maxTokens: body.max_tokens || body.maxOutputTokens || 0,
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
  };
}

function _flattenContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b.text === "string") return b.text;
        return "";
      })
      .join("");
  return "";
}

// ── 路由解析 ──────────────────────────────────────────────────────────────
// model(对外名/uid) → 真上游 {provName, provCfg, upstreamModel, proto}
function resolveTarget(model, deps) {
  const cfg = (deps.getEaConfig && deps.getEaConfig()) || {};
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  const providers = cfg.providers || {};
  let route = routes[model];
  // 经 router.resolveRoute 解析同族档位(与正向推理同一张表)
  if (!route && deps.resolveRoute) {
    try {
      const r = deps.resolveRoute(model);
      if (r && r.route) route = r.route;
    } catch (_) {}
  }
  // 直接以 provider 名作 model 前缀: "providerName/realModel"
  if (!route && model.indexOf("/") > 0) {
    const [pn, ...rest] = model.split("/");
    if (providers[pn]) route = { provider: pn, model: rest.join("/") };
  }
  if (!route) return null;
  const provName = route.provider;
  if (provName === "builtin-stub") {
    return { provName, builtin: true, route, upstreamModel: route.model };
  }
  const provCfg = providers[provName];
  if (!provCfg) return null;
  const proto =
    provCfg.protocol ||
    (provCfg.type === "anthropic" ? "anthropic" : "") ||
    (/\/v1\/messages/i.test(provCfg.completionPath || "") ? "anthropic" : "") ||
    (String(route.model || "")
      .toLowerCase()
      .startsWith("claude")
      ? "anthropic"
      : "") ||
    "openai-chat";
  return {
    provName,
    provCfg,
    proto,
    route,
    upstreamModel: route.model || model,
  };
}

// ── 上游调用(流式) ─────────────────────────────────────────────────────────
// 以目标渠道真协议发请求, 边收边把 SSE 行解析成统一 delta, 回调 onDelta。
function callUpstream(target, norm, deps, handlers) {
  const { provCfg, proto, upstreamModel } = target;
  const isAnthropic = proto === "anthropic";
  const baseUrl = (provCfg.baseUrl || "").replace(/\/$/, "");
  const completionPath =
    provCfg.completionPath ||
    (isAnthropic ? "/v1/messages" : "/v1/chat/completions");
  let url;
  try {
    url = new URL(baseUrl + completionPath);
  } catch (e) {
    handlers.onError(new Error("bad provider baseUrl: " + baseUrl));
    return;
  }
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;

  // 出站请求体 (本源观照: applyInvert 时对 system 施 invertSP)
  let sys = norm.system || "";
  if (deps.cfg && deps.cfg.applyInvert && sys && deps.invertSP) {
    try {
      sys = deps.invertSP(sys) || sys;
    } catch (_) {}
  }
  const maxTokens =
    norm.maxTokens || (deps.cfg && deps.cfg.defaultMaxTokens) || 4096;

  let payloadObj;
  if (isAnthropic) {
    payloadObj = {
      model: upstreamModel,
      max_tokens: maxTokens,
      messages: norm.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      stream: true,
    };
    if (sys) payloadObj.system = sys;
  } else {
    const oaMsgs = [];
    if (sys) oaMsgs.push({ role: "system", content: sys });
    for (const m of norm.messages) oaMsgs.push(m);
    payloadObj = {
      model: upstreamModel,
      messages: oaMsgs,
      max_tokens: maxTokens,
      stream: true,
    };
    if (typeof norm.temperature === "number")
      payloadObj.temperature = norm.temperature;
  }
  const payload = JSON.stringify(payloadObj);

  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Content-Length": String(Buffer.byteLength(payload)),
  };
  if (provCfg.apiKey) {
    if (isAnthropic) {
      headers["x-api-key"] = provCfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = "Bearer " + provCfg.apiKey;
    }
  }
  const agent = deps.getProxyAgent ? deps.getProxyAgent(isHttps) : null;
  const adp = _getAdapters();
  const adapter = adp
    ? isAnthropic
      ? adp.AnthropicAdapter
      : adp.OpenAIChatAdapter
    : null;

  const reqOpts = {
    hostname: url.hostname,
    port: parseInt(url.port || (isHttps ? "443" : "80"), 10),
    path: url.pathname + (url.search || ""),
    method: "POST",
    headers,
    timeout: 120000,
    rejectUnauthorized: false,
  };
  if (agent) reqOpts.agent = agent;

  const upReq = mod.request(reqOpts, (upRes) => {
    if (upRes.statusCode >= 400) {
      let errBody = "";
      upRes.on("data", (c) => (errBody += c));
      upRes.on("end", () =>
        handlers.onError(
          new Error("upstream " + upRes.statusCode + ": " + errBody.slice(0, 400)),
          upRes.statusCode,
        ),
      );
      return;
    }
    handlers.onOpen && handlers.onOpen();
    let buf = "";
    upRes.setEncoding("utf8");
    upRes.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        line = line.replace(/\r$/, "").trim();
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        if (!adapter) continue;
        let parsed;
        try {
          parsed = adapter.parseSSELine(data);
        } catch (_) {
          continue;
        }
        if (!parsed) continue;
        if (parsed.type === "delta") handlers.onDelta(parsed);
        else if (parsed.usage) handlers.onDelta({ usage: parsed.usage });
      }
    });
    upRes.on("end", () => handlers.onDone());
    upRes.on("error", (e) => handlers.onError(e));
  });
  upReq.on("error", (e) => handlers.onError(e));
  upReq.on("timeout", () => {
    upReq.destroy();
    handlers.onError(new Error("upstream timeout (120s)"));
  });
  upReq.end(payload);
}

// ── 出站(回客户端)编码 ───────────────────────────────────────────────────
function _genId(prefix) {
  return (prefix || "chatcmpl") + "-" + crypto.randomBytes(12).toString("hex");
}

function _emitOpenAIStream(res, model, gen) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = _genId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model };
  const send = (delta, finish) => {
    res.write(
      "data: " +
        JSON.stringify(
          Object.assign({}, base, {
            choices: [
              { index: 0, delta: delta || {}, finish_reason: finish || null },
            ],
          }),
        ) +
        "\n\n",
    );
  };
  send({ role: "assistant", content: "" });
  let finishReason = "stop";
  gen({
    onText: (t) => send({ content: t }),
    onThinking: (t) => send({ reasoning_content: t }),
    onFinish: (fr) => {
      if (fr) finishReason = fr;
    },
    onEnd: () => {
      send({}, finishReason);
      res.write("data: [DONE]\n\n");
      res.end();
    },
    onError: (msg) => {
      send({ content: "\n[dao-revproxy error] " + msg }, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
}

function _emitOpenAIUnary(res, model, gen) {
  const id = _genId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let text = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = null;
  gen({
    onText: (t) => (text += t),
    onThinking: (t) => (reasoning += t),
    onFinish: (fr) => {
      if (fr) finishReason = fr;
    },
    onUsage: (u) => (usage = u),
    onEnd: () => {
      const msg = { role: "assistant", content: text };
      if (reasoning) msg.reasoning_content = reasoning;
      const body = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: msg, finish_reason: finishReason }],
        usage: usage
          ? {
              prompt_tokens: usage.input || 0,
              completion_tokens: usage.output || 0,
              total_tokens: (usage.input || 0) + (usage.output || 0),
            }
          : undefined,
      };
      _json(res, 200, body);
    },
    onError: (msg) => _json(res, 502, { error: { message: msg } }),
  });
}

function _emitAnthropicStream(res, model, gen) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = _genId("msg");
  const ev = (type, obj) =>
    res.write("event: " + type + "\ndata: " + JSON.stringify(obj) + "\n\n");
  ev("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  ev("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  gen({
    onText: (t) =>
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: t },
      }),
    onThinking: () => {},
    onFinish: () => {},
    onEnd: () => {
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      ev("message_stop", { type: "message_stop" });
      res.end();
    },
    onError: (msg) => {
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "\n[dao-revproxy error] " + msg },
      });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_stop", { type: "message_stop" });
      res.end();
    },
  });
}

function _emitAnthropicUnary(res, model, gen) {
  const id = _genId("msg");
  let text = "";
  let usage = null;
  gen({
    onText: (t) => (text += t),
    onThinking: () => {},
    onFinish: () => {},
    onUsage: (u) => (usage = u),
    onEnd: () => {
      _json(res, 200, {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: (usage && usage.input) || 0,
          output_tokens: (usage && usage.output) || 0,
        },
      });
    },
    onError: (msg) =>
      _json(res, 502, { type: "error", error: { message: msg } }),
  });
}

function _json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(s)),
  });
  res.end(s);
}

function _readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// 把统一上游 delta 适配到客户端发射器的 generator
function _bridge(target, norm, deps) {
  return (sink) => {
    if (target.builtin) {
      // builtin-stub: 固定返回 · 验证通路
      sink.onText &&
        sink.onText("道可道也 非恒道也 · 模型反代传输层得一 · stub 正常");
      sink.onUsage && sink.onUsage({ input: 10, output: 20 });
      sink.onEnd && sink.onEnd();
      return;
    }
    callUpstream(target, norm, deps, {
      onOpen: () => {},
      onDelta: (d) => {
        if (d.content && sink.onText) sink.onText(d.content);
        if (d.thinking && sink.onThinking) sink.onThinking(d.thinking);
        if (d.finishReason && sink.onFinish) sink.onFinish(d.finishReason);
        if (d.usage && sink.onUsage) sink.onUsage(d.usage);
      },
      onDone: () => sink.onEnd && sink.onEnd(),
      onError: (e) => sink.onError && sink.onError(String((e && e.message) || e)),
    });
  };
}

// ── 主入口: 由 source.js 在 /v1/* 与 /origin/revproxy/* 委派 ──────────────────
// 返回 true 表示已处理。deps: { getEaConfig, getAvailableModels, resolveRoute,
//   invertSP, getProxyAgent, log, version }
async function handle(req, res, u, deps) {
  const p = u.pathname;
  if (!p.startsWith("/v1/") && !p.startsWith("/origin/revproxy")) return false;

  const cfg = loadConfig();
  deps = deps || {};
  deps.cfg = cfg;
  const log = deps.log || (() => {});

  // ── 控制面 (webview 用·本机) ──────────────────────────────────
  if (p === "/origin/revproxy/status" && req.method === "GET") {
    const models = listModels(deps);
    _json(res, 200, {
      ok: true,
      version: deps.version || "",
      enabled: cfg.enabled,
      applyInvert: cfg.applyInvert,
      exposeLan: cfg.exposeLan,
      hasKey: !!cfg.apiKey,
      apiKey: _isLocal(req) ? cfg.apiKey : undefined,
      port: deps.port || 0,
      endpoint: deps.port ? "http://127.0.0.1:" + deps.port + "/v1" : "",
      model_count: models.length,
      models,
    });
    return true;
  }
  if (p === "/origin/revproxy/config" && req.method === "POST") {
    if (!_isLocal(req)) {
      _json(res, 403, { ok: false, error: "localhost only" });
      return true;
    }
    let body = {};
    try {
      body = await _readBody(req);
    } catch (_) {}
    const next = Object.assign(loadConfig(), {});
    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    if (typeof body.applyInvert === "boolean")
      next.applyInvert = body.applyInvert;
    if (typeof body.exposeLan === "boolean") next.exposeLan = body.exposeLan;
    if (typeof body.defaultMaxTokens === "number")
      next.defaultMaxTokens = body.defaultMaxTokens;
    if (body.regenerateKey === true)
      next.apiKey = "dao-local-" + crypto.randomBytes(12).toString("hex");
    else if (typeof body.apiKey === "string") next.apiKey = body.apiKey;
    saveConfig(next);
    _json(res, 200, { ok: true, config: next });
    return true;
  }

  // ── 数据面 (标准 OpenAI / Anthropic) ──────────────────────────
  if (!cfg.enabled) {
    _json(res, 503, {
      error: {
        message: "模型反代未启用 · 请在「模型反代」面板开启",
        type: "revproxy_disabled",
      },
    });
    return true;
  }
  if (!_authOk(req, cfg)) {
    _json(res, 401, {
      error: { message: "未授权 · 缺少有效 Bearer key", type: "unauthorized" },
    });
    return true;
  }

  if (p === "/v1/models" && req.method === "GET") {
    _json(res, 200, { object: "list", data: listModels(deps) });
    return true;
  }

  const isOpenAIChat = p === "/v1/chat/completions" && req.method === "POST";
  const isAnthropicMsg = p === "/v1/messages" && req.method === "POST";
  if (isOpenAIChat || isAnthropicMsg) {
    let body;
    try {
      body = await _readBody(req);
    } catch (e) {
      _json(res, 400, { error: { message: "invalid JSON body" } });
      return true;
    }
    const clientKind = isAnthropicMsg ? "anthropic" : "openai";
    const norm = normalizeInbound(clientKind, body);
    if (!norm.model) {
      _json(res, 400, { error: { message: "model required" } });
      return true;
    }
    const target = resolveTarget(norm.model, deps);
    if (!target) {
      _json(res, 400, {
        error: {
          message:
            "模型 '" +
            norm.model +
            "' 未配置反代通道 · 请在「渠道配置 / 模型路由」为其指定渠道(或映射到已配置的免费渠道如 GLM)",
          type: "no_route",
        },
      });
      return true;
    }
    log(
      "[revproxy] " +
        clientKind +
        " model=" +
        norm.model +
        " → provider=" +
        target.provName +
        "/" +
        (target.upstreamModel || "") +
        " stream=" +
        norm.stream,
    );
    const gen = _bridge(target, norm, deps);
    if (clientKind === "anthropic") {
      if (norm.stream) _emitAnthropicStream(res, norm.model, gen);
      else _emitAnthropicUnary(res, norm.model, gen);
    } else {
      if (norm.stream) _emitOpenAIStream(res, norm.model, gen);
      else _emitOpenAIUnary(res, norm.model, gen);
    }
    return true;
  }

  // 兜底: /v1/* 未识别
  if (p.startsWith("/v1/")) {
    _json(res, 404, { error: { message: "unknown endpoint " + p } });
    return true;
  }
  return false;
}

module.exports = {
  handle,
  listModels,
  loadConfig,
  saveConfig,
  defaultConfig,
  normalizeInbound,
  resolveTarget,
  _cfgPath,
};
