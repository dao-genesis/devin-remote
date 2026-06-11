"use strict";
/**
 * dao_router.js · 道路由 v2.0 · 透明模型替换 · 反者道之动
 * ════════════════════════════════════════════════════════════════
 *
 *   《帛书·四十章》: "反也者，道之动也；弱也者，道之用也"
 *   《阴符经》: "天之至私，用之至公 · 禽之制在炁"
 *
 *   本源架构 v2.0:
 *     小模型 → cascadeRelay(道直连器:7861) → Cascade官方云端(账号池)
 *     fallback → github备用(Azure/GitHub Models)
 *     大模型(Claude4.6/4.7/GPT-5) → 不路由 → 直接透传官方
 *
 *   多提供商支持:
 *     cascadeRelay: noProviderPrefix=true → 直接调 http://127.0.0.1:7861/v1/chat/completions
 *     github: noProviderPrefix=true → 直接调 https://models.inference.ai.azure.com/chat/completions
 *     其他: gateway::model 格式 → 070网关 → 对应provider
 *
 *   内建退化:
 *     target.fallback → { provider, model } 主路由失败时自动尝试
 *     若两者均失败 → return false → MITM回落官方上游
 *
 *   配置 (配置.json):
 *     daoRoutes.routes["MODEL_UID"] = {
 *       provider, model, fallback: { provider, model },
 *       maxOutputTokens, _label
 *     }
 *     providers["providerName"] = {
 *       baseUrl, noProviderPrefix, completionPath, apiKey, enabled
 *     }
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

// ★ v9.9.102 · 修法㉑ · 上游代理agent · 道法自然
//   根因: _callProvider 直连 api.deepseek.com:443 → 远程179笔记本无直连外网能力
//   TLS 握手失败: "Client network socket disconnected before secure TLS connection was established"
//   修复: 检测 HTTP_PROXY/HTTPS_PROXY 环境变量 + 系统代理 → 注入 HttpsProxyAgent
//   道义: 四十章「弱也者 道之用也」· 代理即弱用 · 不直连而通天下
let _httpsProxyAgent = null;
let _httpProxyAgent = null;
try {
  const HPA = require("https-proxy-agent").HttpsProxyAgent;
  const HtPA = require("http-proxy-agent").HttpProxyAgent;
  // 优先级: HTTPS_PROXY > HTTP_PROXY > 系统代理(Windows)
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;
  if (proxyUrl) {
    _httpsProxyAgent = new HPA(proxyUrl);
    _httpProxyAgent = new HtPA(proxyUrl);
    // ★ 静默日志 · 不暴露代理URL到诊断
  }
} catch (_proxyErr) {
  // https-proxy-agent 不可用 → 直连模式 · 不阻塞
}

/**
 * ★ v9.9.102 · 获取代理agent (支持运行时动态检测Windows系统代理)
 *   道义: 四十一章「大白如辱」· 代理存在但不可见
 */
function _getProxyAgent(isHttps) {
  // 1) 环境变量代理 (优先)
  if (isHttps && _httpsProxyAgent) return _httpsProxyAgent;
  if (!isHttps && _httpProxyAgent) return _httpProxyAgent;
  // 2) 无代理 → 直连
  return undefined;
}

// ★ v9.9.92 · 修法⑦ · 引用 sp_invert.js · 仅用于 SP 检测+日志 · 不修改 SP
//   道义: 最上游 · source.js 已改 SP → 此处仅检测一致性 · 不补丁式修改
//   二十八章「圣人执一以为天下牧」· SP 修改归一引擎 · 路由器只观不造
let _spInvert = null;
try {
  _spInvert = require(path.join(__dirname, "sp_invert"));
} catch {}

// ★ v9.9.101 · 太上下知有之 · 增强模式幂等标记 + DAO经藏文本
//   道义: 十七章「太上 下知有之」· DAO存在但不可见 · 官方功能完整保留
const _ENHANCE_MARKER = "\n\n<!-- DAO-ENHANCE v9.9.101 -->\n\n";
function _getDaoEnhanceText() {
  try {
    if (!_spInvert) return null;
    // 从 sp_invert.js 获取经藏文本
    const canonText = _spInvert.getActiveCanonText
      ? _spInvert.getActiveCanonText()
      : null;
    if (!canonText) return null;
    const canonHeader = _spInvert.getCanonHeader
      ? _spInvert.getCanonHeader()
      : "";
    return canonHeader + canonText;
  } catch {
    return null;
  }
}

// ── 状态 ──────────────────────────────────────────────────────
let _cfg = null;
let _routes = {}; // modelUid → { provider, model, fallback?, maxOutputTokens }
let _providers = {}; // providerName → { baseUrl, noProviderPrefix, completionPath, apiKey, enabled }
let _gatewayUrl = "";
let _log = () => {};
let _ready = false;

// ★ v9.9.99 · 移植 Go EXE 核心模块 · 道法自然 · 取之尽锱铢 用之如泥沙
//   budget:     token 预算管理 (移植自 Go internal/budget)
//   adapters:   多协议适配器 (移植自 Go internal/upstream)
//   resilience: 弹性重试模块 (移植自 Go internal/resilience)
let _budget = null;
let _adapters = null;
let _resilience = null;
try {
  _budget = require(path.join(__dirname, "budget"));
  _adapters = require(path.join(__dirname, "adapters"));
  _resilience = require(path.join(__dirname, "resilience"));
} catch (e) {
  // 模块缺失时不阻塞 · 降级为旧逻辑
  _log(`[dao-router] ⚠️ 核心模块加载失败: ${e.message} · 降级为旧逻辑`);
}

// ★ v9.9.100 · 废除硬编码桩 · 道法自然 · 无为而无以为
//   道义: 四十八章「损之又损 以至于无为」· 硬编码桩是「为」· 配置路由是「无为」
//   v9.9.73c 的 _STUB_MODELS 强制 SWE-1.6 FAST → builtin-stub → 绕过 DeepSeek 路由
//   根因: 硬编码优先级高于配置 → 用户配置了 DeepSeek 路由但不生效
//   修复: 清空 _STUB_MODELS · 让 SWE-1.6 FAST 走配置的 DeepSeek 外接API
//   SWE-1.6 (非FAST) 走官方传输层 · SWE-1.6 FAST 走 DeepSeek 外接API路由层
const _STUB_MODELS = new Set([]); // ★ 废除: 不再强制任何模型走 builtin-stub
const _STUB_TARGET = {
  provider: "builtin-stub",
  model: "stub-transport-test",
  _label: "内建传输层桩 (备用 · 仅在 _STUB_MODELS 非空时启用)",
  maxOutputTokens: 8192,
};

// ★ v9.9.97 · 保护常用模型 · 不允许路由到外接API
//   道义: 二十九章「天下神器 非可为也」· GLM/DeepSeek/Qwen即神器
//   用户显式解锁才可路由 · 否则shouldRoute返回false
//   v9.9.97-fix: 新增family级别匹配 · 新版本自动保护 · 不再硬编码版本号
const _PROTECTED_FAMILIES = new Set(["GLM", "DeepSeek", "Qwen"]);
const _PROTECTED_MODELS = new Set([
  "MODEL_GLM_4_5",
  "MODEL_GLM_4_5_FAST",
  "MODEL_GLM_4_6",
  "MODEL_GLM_4_6_FAST",
  "MODEL_GLM_4_7",
  "MODEL_GLM_4_7_FAST",
  "MODEL_DEEPSEEK_V3_2",
  "MODEL_DEEPSEEK_R1",
  "MODEL_DEEPSEEK_R1_FAST",
  "MODEL_QWEN_3_235B_INSTRUCT",
  "MODEL_QWEN_3_CODER_480B_INSTRUCT",
  // 小写格式兼容
  "glm-4-5",
  "glm-4-5-fast",
  "glm-4-6",
  "glm-4-6-fast",
  "glm-4-7",
  "glm-4-7-fast",
  "deepseek-v3-2",
  "deepseek-r1",
  "deepseek-r1-fast",
  "qwen3-235b-instruct",
  "qwen3-coder-480b-instruct",
]);
// 用户显式解锁的模型(运行时可变)
const _unlockedModels = new Set();

// ★ v9.9.68 · 文件级诊断 · 路由执行全链路追踪
const _routeDiagPath = path.join(
  __dirname,
  "..",
  "..",
  "bundled-origin",
  "_router_diag.log",
);
function _routeDiag(msg) {
  try {
    const t = new Date().toISOString();
    // v9.9.77 · 异步写入 · 反者道之动 · appendFileSync 阻塞事件循环致 ext-host UNRESPONSIVE
    fs.appendFile(_routeDiagPath, `[${t}] ${msg}\n`, () => {});
  } catch {}
}
let _substituteEnabled = false; // 全局开关: substitute模式默认关闭(需用户有目标模型权限)
let _wire = null; // cascade_wire.js (lazy load)

// ════════════════════════════════════════════════════════════════
// ★ v9.9.73 · 内建传输层桩 · 零依赖 · 不假外求
//   道义: 三十九章「天得一以清 地得一以宁」· 得一则通
//   用途: swe-1-6 专供传输层验证 · 不依赖任何外部API
//   始终可用 · 始终返回固定响应 · 诊断传输链路每一环节
// ════════════════════════════════════════════════════════════════
const _STUB_TEXT = "道可道也 非恒道也 · 传输层得一 · stub响应正常";
const _STUB_SEQ = [0]; // 自增序号
function _builtinStubResponse(modelUid, messages, tools) {
  _STUB_SEQ[0]++;
  const seq = _STUB_SEQ[0];
  const now = Date.now();
  // ★ v9.9.73a · 始终返回文本 · 不返回 tool_calls
  //   道义: 三十五章「执大象 天下往 往而不害 安平大」
  //   传输层桩的目的是验证帧传输 · 不是模拟工具调用
  //   返回 tool_calls 会导致 Windsurf UI 尝试执行假工具 → 报错
  //   如需测试 tool_calls 传输: 在 system prompt 末尾加 [STUB:TOOL_CALLS]
  var forceToolCall = false;
  if (Array.isArray(messages)) {
    for (var i = 0; i < messages.length; i++) {
      var c = messages[i].content || "";
      if (typeof c === "string" && c.indexOf("[STUB:TOOL_CALLS]") >= 0) {
        forceToolCall = true;
        break;
      }
    }
  }
  var toolCalls = [];
  if (forceToolCall && Array.isArray(tools) && tools.length > 0) {
    var firstTool = tools[0];
    var toolName =
      (firstTool &&
        (firstTool.name || (firstTool.function && firstTool.function.name))) ||
      "read_file";
    toolCalls.push({
      id: "stub_tc_" + seq,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify({ file_path: "/stub/test.txt" }),
      },
    });
  }
  var hasTools = toolCalls.length > 0;
  var obj = {
    id: "stub-" + seq + "-" + now,
    object: "chat.completion",
    created: Math.floor(now / 1000),
    model: modelUid || "stub-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: _STUB_TEXT + " #" + seq,
          tool_calls: hasTools ? toolCalls : undefined,
        },
        finish_reason: hasTools ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  return obj;
}

/**
 * 内建桩 → Connect-RPC Cascade 帧 (复用 _unaryOaToCascade 的帧构造逻辑)
 * 道义: 朴散则为器 · 同一帧构造器 · stub与真实共享
 */
async function _stubToCascade(res, w, modelUid, messages, tools, isJSON) {
  const obj = _builtinStubResponse(modelUid, messages, tools);
  const choice = obj.choices[0];
  const msg = choice.message;
  const _outputId =
    "stub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const _requestId =
    "stubReq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const _actualModelUid = modelUid || "swe-1-6-stub";

  // ★ v9.9.78 · message_id + timestamp · 官方后端每帧必含
  //   实证: 官方后端每帧 payload 均含 field 1 (message_id) + field 2 (timestamp)
  //   无 message_id → LSP 无法关联帧 → "Encountered unexpected error"
  //   道义: 三十九章「得一」· 得 message_id + timestamp 方能宁
  const _messageId =
    "bot-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  const _tsMs = Date.now();

  // 每帧必含的 message_id + timestamp 前缀
  const _hdr = () => w.buildFrameHeader(_messageId, _tsMs);

  _routeDiag(
    "_stubToCascade entry: modelUid=" +
      modelUid +
      " messageId=" +
      _messageId +
      " hasTools=" +
      !!(msg.tool_calls && msg.tool_calls.length) +
      " textLen=" +
      (msg.content || "").length,
  );

  // ── 写 Connect-RPC 响应头 ──
  // ★ v9.9.73e · 与官方 API 响应头完全对齐
  //   实证: 官方 API 返回 content-type=application/connect+proto + connect-accept-encoding=gzip
  //   道义: 执今之道以御今之有 · 与官方一致方能通
  if (!res.headersSent) {
    res.writeHead(200, {
      "content-type": isJSON
        ? "application/connect+json"
        : "application/connect+proto",
      "connect-accept-encoding": "gzip",
    });
  }

  // ── 帧 1: metadata (message_id + timestamp + actual_model_uid + output_id + request_id) ──
  //   ★ v9.9.78 · 每帧含 message_id + timestamp · 与官方后端一致
  //   道义: 三十九章「侯王得一以为天下正」· LSP 得此二字段方能归位
  {
    const metaParts = [];
    metaParts.push(_hdr()); // ★ message_id + timestamp
    metaParts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
    metaParts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
    metaParts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
    const metaFr = w.buildFrame(0, Buffer.concat(metaParts));
    if (metaFr && metaFr.length) res.write(metaFr);
    _routeDiag("_stubToCascade metadata frame: len=" + metaFr.length);
  }

  // ── 帧 2: 文本 (message_id + timestamp + delta_text) ──
  if (typeof msg.content === "string" && msg.content.length > 0) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.DELTA_TEXT, msg.content));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
    _routeDiag(
      "_stubToCascade text frame: len=" +
        fr.length +
        ' text="' +
        msg.content.slice(0, 60) +
        '"',
    );
  }

  // ── tool_calls 帧 (message_id + timestamp + delta_tool_calls) ──
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const calls = msg.tool_calls.map(function (tc, i) {
      return {
        id: tc.id || "tc_" + i,
        name: (tc.function && tc.function.name) || "",
        argumentsJson: (tc.function && tc.function.arguments) || "{}",
      };
    });
    if (w.encodeChatToolCall) {
      const inner = Buffer.concat([
        _hdr(), // ★ message_id + timestamp
        ...calls.map((tc) =>
          w.encodeMessage(w.RSP.DELTA_TOOL_CALLS, w.encodeChatToolCall(tc)),
        ),
      ]);
      const fr = w.buildFrame(0, inner);
      if (fr && fr.length) {
        res.write(fr);
        _routeDiag("_stubToCascade tool_calls frame: count=" + calls.length);
      }
    }
  }

  // ── stop_reason 帧 (message_id + timestamp + stop_reason) ──
  let stopReason = w.STOP_END;
  if (
    choice.finish_reason === "tool_calls" ||
    choice.finish_reason === "function_call"
  ) {
    stopReason = w.STOP_TOOL_CALLS;
  } else if (choice.finish_reason === "length") {
    stopReason = w.STOP_MAX_TOKENS;
  }
  if (stopReason !== null) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeUint(w.RSP.STOP_REASON, stopReason));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) {
      res.write(fr);
      _routeDiag("_stubToCascade stop_reason frame: reason=" + stopReason);
    }
  }

  // ── end 帧 (含 grpc-status:0) ──
  if (w.buildEndFrame) {
    const fr = w.buildEndFrame(null);
    if (fr && fr.length) {
      res.write(fr);
      _routeDiag("_stubToCascade end frame written");
    }
  }

  // ★ v9.9.78 · 移除 HTTP/2 trailers · EOS 帧已含 grpc-status:0
  //   v9.9.77 添加 addTrailers 是错误方向 · 与 EOS 帧重复
  //   Connect-RPC 规范: EOS 帧 IS the trailer delivery mechanism
  //   道义: 损之又损以至于无为 · 无为而无以为

  if (!res.writableEnded) res.end();
  _log(
    "[dao-router] [stub✓] " +
      modelUid +
      " seq=" +
      _STUB_SEQ[0] +
      " text=" +
      (msg.content || "").length +
      "B tools=" +
      (msg.tool_calls || []).length,
  );
  _routeDiag(
    "_stubToCascade COMPLETE: modelUid=" +
      modelUid +
      " seq=" +
      _STUB_SEQ[0] +
      " headersSent=" +
      res.headersSent +
      " writableEnded=" +
      res.writableEnded,
  );
  return true;
}

// ── 道直连器健康缓存 (避免每次都探测) ──────────────────────────
const _healthCache = {}; // providerName → { alive: bool, ts: timestamp }
const HEALTH_TTL = 30000; // 30秒缓存
let _cfgWatcher = null; // 配置.json fs.watch 句柄

// ★ v9.9.81 · 服务端工具补充 · init() 中填充
//   LSP 不发这些工具但官方后端知道 → DeepSeek 需要才能调用
let _serverToolDefs = [];
let _serverToolNames = new Set();

// ★ v9.9.93 · 修法⑧ · 工具分类: LSP有执行器 vs 仅代理执行
//   根因: trajectory_search 等工具 LSP 本身有执行器 (向量搜索/代码搜索/UI交互)
//   但因缺少 nativeRules → LSP 没在请求中发送定义 → 被错误拦截为"服务端工具"
//   Go EXE 不区分服务端/LSP工具 → 所有 tool_call 直接透传 → LSP 自己执行
//   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
//
//   _lspCapableToolNames: LSP 有执行器 → tool_call 透传给 LSP (不拦截)
//     trajectory_search: LSP 内部有向量搜索执行器
//     code_search: LSP 内部有代码搜索子代理
//     ask_user_question: LSP 内部有 UI 交互
//     create_memory: LSP 内部有记忆存储
//     search_web: LSP 内部有搜索执行器
//     read_url_content: LSP 内部有 URL 读取
//     view_content_chunk: LSP 内部有内容查看
//     read_resource: LSP 内部有资源读取
//     edit_notebook / read_notebook: LSP 内部有笔记本操作
//
//   _proxyOnlyToolNames: LSP 无执行器 → 代理执行 + 内部重试
//     deploy_web_app / read_deployment_config / check_deploy_status: 需外部服务
//     skill: 需外部服务
const _lspCapableToolNames = new Set([
  "trajectory_search",
  "code_search",
  "ask_user_question",
  "create_memory",
  "search_web",
  "read_url_content",
  "view_content_chunk",
  "read_resource",
  "edit_notebook",
  "read_notebook",
]);
const _proxyOnlyToolNames = new Set([
  "deploy_web_app",
  "read_deployment_config",
  "check_deploy_status",
  "skill",
]);

// ★ v9.9.88 · 工具白名单 (移植自 EXE parse-request.js KNOWN_TOOL_NAMES)
//   道义: 二十八章「大制无割」· 知其可用方传 · 不知则不传
//   规则: 白名单内 → 保留 | mcp\d+_ 前缀 + allowMcp → 保留 | 其他 → 丢弃
//   效果: 防止无效工具名传给上游模型 → 模型调用失败
//
//   ★ v9.9.88b · LSP 别名兼容
//   LSP 发来的工具名有两种风格:
//     标准名: grep_search, run_command (protobuf schema 定义)
//     LSP别名: Grep, bash (LSP 内部使用)
//   两种都必须保留 · 否则 DeepSeek 无法调用 Grep/bash
const _KNOWN_TOOL_NAMES = new Set([
  // 标准名 (protobuf schema)
  "read_file",
  "edit",
  "multi_edit",
  "write_to_file",
  "run_command",
  "grep_search",
  "find_by_name",
  "list_dir",
  "code_search",
  "command_status",
  "browser_preview",
  "todo_list",
  "ask_user_question",
  "deploy_web_app",
  "read_deployment_config",
  "check_deploy_status",
  "create_memory",
  "search_web",
  "read_url_content",
  "view_content_chunk",
  "skill",
  "edit_notebook",
  "read_notebook",
  "trajectory_search",
  "read_resource",
  // LSP 别名 (LSP 发来的实际名称)
  // ★ v9.9.88b · LSP 别名兼容 · 两种都必须保留 · 否则 DeepSeek 无法调用
  //   标准名: read_file, grep_search (protobuf schema 定义)
  //   LSP别名: Read, Grep (LSP 内部使用)
  "Grep",
  "bash",
  "list_resources",
  "read_terminal",
  "Read",
  "Edit",
  "Write",
  "ListDir",
  "FindByName",
  "CodeSearch",
  "RunCommand",
  "GrepSearch",
]);
let _allowMcpTools = true; // 默认允许 MCP 工具 (mcp\d+_ 前缀)

// ★ v9.9.88 · compactPromptText (移植自 EXE parse-request.js)
//   压缩 SP 多余空白 · 统一换行 · 去行尾空白 · 压缩空行
//   道义: 损之又损 · 去其冗余 · 留其精华
function _compactPromptText(text) {
  if (!text || typeof text !== "string") return text || "";
  return text
    .replace(/\r\n/g, "\n") // 统一换行
    .replace(/[ \t]+\n/g, "\n") // 去行尾空白
    .replace(/\n{3,}/g, "\n\n") // 压缩3+空行为2空行
    .trim();
}

// ── 统计 ──────────────────────────────────────────────────────
const _stats = {
  total: 0, // 总路由判断次数
  routed: 0, // 成功路由到cascadeRelay
  fallbackRouted: 0, // 成功路由到fallback provider
  passthru: 0, // 回落官方 (不在路由表)
  errorFallback: 0, // 主路由失败→fallback
  errors: 0, // 致命错误
};

// ── lazy load cascade_wire ──────────────────────────────────
function wire() {
  // ★ v9.9.81 · 热重载: 清除 require.cache 使代码修改生效
  //   道义: 十六章「致虚极也」· 虚其缓存 · 方能重新得
  const cwPath = path.join(__dirname, "cascade_wire.js");
  if (require.cache[cwPath]) {
    delete require.cache[cwPath];
    _log("[dao-router] wire() · cascade_wire.js cache cleared");
  }
  try {
    _wire = require(cwPath);
  } catch (e) {
    _log(`[dao-router] cascade_wire load fail: ${e.message}`);
  }
  return _wire;
}

// ════════════════════════════════════════════════════════════════
// §1  公开 API
// ════════════════════════════════════════════════════════════════

/**
 * 初始化 · 加载 daoRoutes 配置
 * @param {{ log: Function, configPath: string }} opts
 * @returns {{ ready: boolean, count?: number, gateway?: string, error?: string }}
 */
function init({ log, configPath }) {
  _log = log || (() => {});

  // ★ v9.9.81 · 热重载: 清除 require.cache 使代码修改生效
  //   道义: 十六章「致虚极也，守情表也」· 致虚缓存 · 守情代码
  try {
    const selfPath = __filename;
    const cwPath = path.join(__dirname, "cascade_wire.js");
    if (require.cache[selfPath]) delete require.cache[selfPath];
    if (require.cache[cwPath]) delete require.cache[cwPath];
  } catch {}

  _wire = null; // ★ 强制 wire() 重新加载

  // ★ v9.9.86 · 服务端工具补充 · 参数名对齐官方 protobuf schema
  //   逆向实证: CortexStepTrajectorySearch → id/query/id_type (非 ID/Query/SearchType)
  //   CortexStepAskUserQuestion.Request → question/options/allow_multiple
  //   道义: 二十八章「大制无割」· 名实终一 · 参数名与官方同方能通
  _serverToolDefs = [
    {
      name: "trajectory_search",
      description:
        "Semantic search or retrieve a conversation trajectory. Trajectories are previous conversations. Returns chunks from the trajectory, scored, sorted, and filtered by relevance. Maximum number of chunks returned is 50. Call this tool when the user @mentions a @conversation. Do NOT call this tool with SearchType: 'user'. IGNORE @activity mentions.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The ID of the trajectory to search or retrieve: cascade ID for conversations, or mainline ID for user activities",
          },
          query: {
            type: "string",
            description: "The query string to search for within the trajectory",
          },
          id_type: {
            type: "string",
            enum: ["cascade_id", "mainline"],
            description:
              "The type of ID: 'cascade_id' for conversations, or 'mainline' for user activities",
          },
        },
        required: ["id", "query", "id_type"],
        additionalProperties: false,
      },
    },
    {
      name: "code_search",
      description:
        "A search subagent the user refers to as 'Fast Context' that is ideal for exploring the codebase based on a request. This tool invokes a subagent that runs parallel grep and readfile calls over multiple turns to locate line ranges and files which might be relevant to the request. The search term should be a targeted natural language query based on what you are trying to accomplish, like 'Find where authentication requests are handled in the Express routes' or 'Modify the agentic rollout to use the new tokenizer and chat template' or 'Fix the bug where the user gets redirected from the /feed page'. Fill out extra details that you as a smart model can infer in the question if necessary. You should always use this tool to start your search. Note: The files and line ranges returned by this tool may be some of the ones needed to complete the user's request, but you should be careful in evaluating the relevance of the results, since the subagent might make mistakes. You should consider using classical search tools afterwards to locate the rest if necessary. IMPORTANT: YOU CANNOT CALL THIS TOOL IN PARALLEL.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          search_folder_absolute_uri: {
            type: "string",
            description:
              "The absolute path of the folder where the search should be performed. In multi-repo workspaces, you have to specify a subfolder where the search should be performed, to avoid searching across all repos. For example, if you are in the user folder and you don't know what subfolders are present, you have to first list the subfolders and only then call this tool in the subfolder you want to search in.",
          },
          search_term: {
            type: "string",
            description:
              "Search problem statement that this subagent is supposed to research for.",
          },
        },
        required: ["search_folder_absolute_uri", "search_term"],
        additionalProperties: false,
      },
    },
    {
      name: "ask_user_question",
      description:
        'Ask the user a question with predefined options. Use this when you need the user to make a choice between specific options. You can provide up to 4 options, each with a label and description. NEVER include "other" as an option - the user can always automatically provide a custom response. Set allowMultiple to true if the user should be able to select more than one option.',
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Short label for the option",
                },
                description: {
                  type: "string",
                  description: "Longer description explaining the option",
                },
              },
              required: ["label", "description"],
              additionalProperties: false,
            },
            description: "Up to 4 options for the user to choose from",
          },
          allowMultiple: {
            type: "boolean",
            description: "Whether the user can select multiple options",
          },
        },
        required: ["question", "options", "allowMultiple"],
        additionalProperties: false,
      },
    },
    {
      name: "deploy_web_app",
      description:
        "Deploy a JavaScript web application to a deployment provider like Netlify. Site does not need to be built. Only the source files are required. Make sure to run the read_deployment_config tool first and that all missing files are created before attempting to deploy. If you are deploying to an existing site, use the project_id to identify the site. If you are deploying a new site, leave the project_id empty.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description:
              "The full absolute project path of the web application",
          },
          framework: {
            type: "string",
            description: "The framework of the web application",
          },
          project_id: {
            type: "string",
            description:
              "The project ID of the web application if it exists in the deployment configuration file",
          },
          subdomain: {
            type: "string",
            description:
              "Subdomain or project name used in the URL. Leave this EMPTY if you are deploying to an existing site using the project_id.",
          },
        },
        required: ["project_path"],
        additionalProperties: false,
      },
    },
    {
      name: "read_deployment_config",
      description:
        "Read the deployment configuration for a web application and determine if the application is ready to be deployed. Should only be used in preparation for the deploy_web_app tool.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description:
              "The full absolute project path of the web application",
          },
        },
        required: ["project_path"],
        additionalProperties: false,
      },
    },
    {
      name: "check_deploy_status",
      description:
        "Check the status of the deployment using its windsurf_deployment_id for a web application and determine if the application build has succeeded and whether it has been claimed. Do not run this unless asked by the user. It must only be run after a deploy_web_app tool call.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          windsurf_deployment_id: {
            type: "string",
            description:
              "The Windsurf deployment ID for the deploy we want to check status for. This is NOT a project_id.",
          },
        },
        required: ["windsurf_deployment_id"],
        additionalProperties: false,
      },
    },
    {
      name: "skill",
      description:
        "Invoke a skill (custom tool or workflow) by name with optional parameters.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the skill to invoke",
          },
          params: {
            type: "object",
            description: "Parameters to pass to the skill",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ];
  _serverToolNames = new Set(_serverToolDefs.map((t) => t.name));

  try {
    // ★ v9.9.59 · 配置.json 不存在时: 优先从 _默认配置.json 复制 (DEFECT9 修)
    //   _默认配置.json 打入 VSIX (无凭据模板) · 配置.json 排除 (含用户凭据)
    if (!fs.existsSync(configPath)) {
      const templatePath = path.join(
        path.dirname(configPath),
        "_默认配置.json",
      );
      if (fs.existsSync(templatePath)) {
        _log("[dao-router] 配置.json 不存在 · 从 _默认配置.json 复制");
        try {
          fs.copyFileSync(templatePath, configPath);
        } catch (ce) {
          _log("[dao-router] 复制模板失败: " + ce.message);
        }
      }
    }
    // 仍然不存在则内嵌生成 (兜底)
    // ★ v9.9.98 · 损之又损 · 无为模板 · 只路由SWE 1.6 Fast · 其他走官方
    if (!fs.existsSync(configPath)) {
      _log("[dao-router] 配置.json 不存在 · 内嵌无为模板生成");
      const defaultCfg = {
        _道: "外接api · 道法自然 · 无为模板 · 只路由SWE 1.6 Fast · 其他走官方",
        _注: "无配置=全官方 · 有配置才路由 · 填入apiKey后启用provider",
        gateway: { host: "127.0.0.1", port: 11435 },
        providers: {
          deepseek: {
            enabled: false,
            apiKey: "",
            baseUrl: "https://api.deepseek.com/v1",
            models: ["deepseek-chat", "deepseek-reasoner"],
            noProviderPrefix: true,
            completionPath: "/chat/completions",
            type: "openai-compatible",
            streamMode: "stream",
          },
        },
        daoRoutes: {
          enabled: true,
          substituteEnabled: false,
          allowMcpTools: true,
          _说明:
            "只路由SWE 1.6 Fast → deepseek · 不在表中→官方透传 · 填apiKey后启用provider",
          routes: {
            MODEL_SWE_1_6_FAST: {
              provider: "deepseek",
              model: "deepseek-reasoner",
              _label: "SWE 1.6 Fast → DeepSeek Reasoner (需apiKey)",
              maxOutputTokens: 32768,
            },
          },
        },
      };
      try {
        fs.writeFileSync(
          configPath,
          JSON.stringify(defaultCfg, null, 2),
          "utf8",
        );
        _log("[dao-router] 默认配置已写入: " + configPath);
      } catch (we) {
        _log("[dao-router] 写入默认配置失败: " + we.message);
      }
    }
    const raw = fs.readFileSync(configPath, "utf8");
    _cfg = JSON.parse(raw);
    // ★ v9.9.90 · 存储 configPath · 供热配置 API 持久化使用
    _cfg._configPath = configPath;
    const dr = _cfg.daoRoutes || {};

    if (dr.enabled === false) {
      _ready = false;
      _log("[dao-router] daoRoutes.enabled=false · 透明路由已禁用");
      return { ready: false, reason: "disabled" };
    }

    // 加载路由表 (过滤掉 _注 等注释键)
    const rawRoutes = dr.routes || {};
    _routes = {};
    for (const [uid, t] of Object.entries(rawRoutes)) {
      if (uid.startsWith("_") || typeof t !== "object" || !t.provider) continue;
      _routes[uid] = t;
    }

    // 加载 providers
    _providers = _cfg.providers || {};

    // 全局 substitute 开关
    _substituteEnabled = dr.substituteEnabled === true;
    if (!_substituteEnabled) {
      _log("[dao-router]   substitute模式: 关闭 (substituteEnabled=false)");
    }

    // ★ v9.9.88 · MCP 工具过滤开关 (移植自 EXE ALLOW_MCP_TOOLS)
    //   默认 true: 允许 mcp\d+_ 前缀的工具传给上游模型
    //   设为 false: 仅传 _KNOWN_TOOL_NAMES 白名单内的工具
    _allowMcpTools = dr.allowMcpTools !== false;
    _log("[dao-router]   MCP工具: " + (_allowMcpTools ? "允许" : "仅白名单"));

    const gw = _cfg.gateway || {};
    _gatewayUrl = `http://${gw.host || "127.0.0.1"}:${gw.port || 11435}`;
    const count = Object.keys(_routes).length;
    _ready = count > 0;

    if (_ready) {
      _log("[dao-router] ══════════════════════════════════════════");
      _log(`[dao-router] 道路由 v2.0 就绪 · routes=${count}`);
      const provCounts = {};
      for (const t of Object.values(_routes)) {
        provCounts[t.provider] = (provCounts[t.provider] || 0) + 1;
      }
      for (const [p, n] of Object.entries(provCounts)) {
        const pCfg = _providers[p] || {};
        const proto = pCfg.protocol || "(auto)";
        _log(
          `[dao-router]   ${p}: ${n}条 · url=${pCfg.baseUrl || _gatewayUrl} · protocol=${proto}`,
        );
      }
      // ★ v9.9.99 · 日志 per-route 预算/弹性配置
      for (const [uid, t] of Object.entries(_routes)) {
        const parts = [uid, "→", `${t.provider}/${t.model}`];
        if (t.thinkingEnabled) parts.push("thinking");
        if (t.budget) parts.push(`budget(ctx=${t.budget.maxContextTokens})`);
        if (t.resilience)
          parts.push(`resilience(retry=${t.resilience.maxRetries})`);
        _log(`[dao-router]   ${parts.join(" ")}`);
      }
      _log("[dao-router] ══════════════════════════════════════════");
    } else {
      _log("[dao-router] 无路由配置");
    }

    wire();

    // ★ v9.9.62 · 配置.json 文件监听 · 变化时自动热重载 · 道法自然
    //   帛书·十六: 「致虚极也，守情表也」— 守住变化，不执着于旧
    if (!_cfgWatcher && fs.existsSync(configPath)) {
      try {
        const cfgDir = path.dirname(configPath);
        const cfgBase = path.basename(configPath);
        let _cfgDebounce = null;
        _cfgWatcher = fs.watch(cfgDir, (eventType, filename) => {
          if (filename !== cfgBase) return;
          if (_cfgDebounce) clearTimeout(_cfgDebounce);
          _cfgDebounce = setTimeout(() => {
            _cfgDebounce = null;
            _log("[dao-router] 配置.json 变化检测 · 自动热重载...");
            try {
              const reResult = init({ log: _log, configPath });
              if (reResult.ready) {
                _log(
                  "[dao-router] ★ 配置热重载成功 · " +
                    reResult.count +
                    "条路由",
                );
              } else {
                _log(
                  "[dao-router] 配置热重载失败: " +
                    (reResult.error || reResult.reason),
                );
              }
            } catch (e) {
              _log("[dao-router] 配置热重载异常: " + e.message);
            }
          }, 500);
        });
        _log("[dao-router] 配置监听已启动 · " + configPath);
      } catch (e) {
        _log("[dao-router] 配置监听启动失败 (不影响运行): " + e.message);
      }
    }

    // ★ v9.9.99 · 初始化 Go 移植模块 · 道法自然
    //   预算 · 适配 · 弹性 · 三位一体 · 无为而无不为
    try {
      if (_budget) _budget.initBudget({ log: _log });
      if (_adapters) _adapters.initAdapters({ log: _log });
      if (_resilience) _resilience.initResilience({ log: _log });
      _log(
        "[dao-router] ★ Go移植模块初始化完成: budget + adapters + resilience",
      );
    } catch (e) {
      _log(`[dao-router] ⚠️ Go移植模块初始化失败: ${e.message} · 降级为旧逻辑`);
    }

    return {
      ready: _ready,
      count,
      gateway: _gatewayUrl,
      providers: Object.keys(_providers),
    };
  } catch (e) {
    _log(`[dao-router] init 失败: ${e.message}`);
    _ready = false;
    return { ready: false, error: e.message };
  }
}

/** 是否就绪 */
function isReady() {
  return _ready;
}

/**
 * 从 GetChatMessage 原始 body 快速提取 modelUid
 * 用于 MITM 早期路由决策
 */
function extractModelUid(rawBody, isJSON) {
  try {
    const w = wire();
    if (!w) {
      _log("[dao-router] extractModelUid: wire()=null");
      return null;
    }
    const parsed = w.parseGetChatMessageRequest(rawBody, !!isJSON);
    if (!parsed) {
      _log(
        "[dao-router] extractModelUid: parsed=null isJSON=" +
          isJSON +
          " bodyLen=" +
          (rawBody ? rawBody.length : 0),
      );
      return null;
    }
    if (!parsed.modelUid) {
      _log(
        "[dao-router] extractModelUid: modelUid='' isJSON=" +
          isJSON +
          " bodyLen=" +
          (rawBody ? rawBody.length : 0) +
          " keys=" +
          Object.keys(parsed).join(","),
      );
      return null;
    }
    return parsed.modelUid;
  } catch (e) {
    _log(
      "[dao-router] extractModelUid ERR: " +
        e.message +
        " isJSON=" +
        isJSON +
        " bodyLen=" +
        (rawBody ? rawBody.length : 0),
    );
    return null;
  }
}

/**
 * modelUid 规范化 · DEFECT11 根治
 *   Windsurf modelUid 格式不一致:
 *     · 内置模型: MODEL_SWE_1_6_FAST (大写MODEL_前缀+下划线)
 *     · 第三方/新增: swe-1-6-fast (小写连字符)
 *   路由表 key 两种都写入, shouldRoute 自动规范化匹配
 */
function _normalizeModelUid(uid) {
  if (!uid || typeof uid !== "string") return uid;
  // 1) 直接命中
  if (_routes[uid]) return uid;
  // 2) 小写连字符 → MODEL_ 格式: swe-1-6-fast → MODEL_SWE_1_6_FAST
  if (!uid.startsWith("MODEL_")) {
    const modelKey = "MODEL_" + uid.replace(/-/g, "_").toUpperCase();
    if (_routes[modelKey]) return modelKey;
  }
  // 3) MODEL_ 格式 → 小写连字符: MODEL_SWE_1_6_FAST → swe-1-6-fast
  if (uid.startsWith("MODEL_")) {
    const lowerKey = uid
      .replace(/^MODEL_/, "")
      .replace(/_/g, "-")
      .toLowerCase();
    if (_routes[lowerKey]) return lowerKey;
  }
  // 4) ★ v9.9.59 · 通配符兜底: * → 任何未知模型自动路由
  if (_routes["*"]) return "*";
  return uid; // 无法规范化则原样返回
}

/**
 * 判断是否应路由此 modelUid
 */
function shouldRoute(modelUid) {
  if (typeof modelUid !== "string") return false;
  // ★ v9.9.98 · 无配置=全官方 · 有配置才路由 · 道法自然
  //   _ready=false: 无路由配置 → 所有模型走官方透传
  //   _ready=true: 有路由配置 → stub模型走内建桩 · 其他按路由表
  if (!_ready) return false;
  if (_STUB_MODELS.has(modelUid)) return true;
  // ★ v9.9.97 · 保护模型检查 · family级别匹配 · 用户显式解锁才可路由
  if (isModelProtected(modelUid)) return false;
  const normalized = _normalizeModelUid(modelUid);
  const r = _routes[normalized];
  if (!r) return false;
  // 路由条目 enabled:false → 不路由 (substitute默认关闭)
  if (r.enabled === false) return false;
  // substitute模式需要全局开关
  if (r.provider === "substitute" && !_substituteEnabled) return false;
  // ★ 通配符 * 始终可路由
  if (normalized === "*") return true;
  return true;
}

/**
 * 路由执行: GetChatMessage → 第三方API
 *
 * @param {http.IncomingMessage}  req      - 原始请求 (用于 close 监听)
 * @param {http.ServerResponse}   res      - HTTP 响应
 * @param {Buffer}                rawBody  - GetChatMessageRequest 原始 body
 * @param {boolean}               isJSON   - content-type 含 'json' 则 true
 * @param {string}                modelUid - 模型 UID
 * @returns {Promise<boolean>} true=路由成功已响应 / false=应回落到官方
 */
async function route(req, res, rawBody, isJSON, modelUid) {
  const normalized = _normalizeModelUid(modelUid);
  let target = _routes[normalized];
  // ★ v9.9.73c · 硬编码 stub: swe-1-6 始终走 builtin-stub
  //   配置文件可能被外部进程覆盖 · 但代码中的路由不可覆
  //   v9.9.73b 的 !target 条件有漏洞: 配置中有 swe-1-6→deepseek 时 target 非空 → stub 被绕过
  //   修正: 无条件覆盖 · _STUB_MODELS 中的模型永远走 builtin-stub
  if (_STUB_MODELS.has(modelUid)) {
    target = _STUB_TARGET;
    _routeDiag(
      "route() hardcoded stub: modelUid=" +
        modelUid +
        " → builtin-stub (强制覆盖 · 不受配置影响)",
    );
    _log(
      "[dao-router] [stub→] " +
        modelUid +
        " → builtin-stub (硬编码 · 不受配置影响)",
    );
  }
  // ★ v9.9.67 · 诊断日志 — 路由入口
  _log(
    `[dao-router] route() entry: modelUid=${modelUid} normalized=${normalized} target=${target ? target.provider + "/" + target.model : "null"} isJSON=${isJSON} bodyLen=${rawBody ? rawBody.length : 0}`,
  );
  _routeDiag(
    `route() entry: modelUid=${modelUid} normalized=${normalized} target=${target ? target.provider + "/" + target.model : "null"} bodyLen=${rawBody ? rawBody.length : 0}`,
  );
  if (!target) {
    _routeDiag(`route() SKIP: no target for ${normalized}`);
    return false;
  }
  // ★ 通配符兜底: 用原始 modelUid 作为 model 名发给 provider
  const _isWildcard = normalized === "*";

  _stats.total++;
  const w = wire();
  if (!w) {
    _log(`[dao-router] [SKIP] cascade_wire 不可用 · ${modelUid}`);
    _routeDiag(`route() SKIP: wire=null for ${modelUid}`);
    _stats.errors++;
    return false;
  }

  // ── 解析 GetChatMessageRequest ──
  let parsed;
  try {
    parsed = w.parseGetChatMessageRequest(rawBody, !!isJSON);
    if (!parsed) throw new Error("parse returned null");
    // ★ v9.9.67 · 诊断: 解析后消息数
    _log(
      `[dao-router] parse ok: msgs=${parsed.messages?.length || 0} tools=${parsed.tools?.length || 0} sysLen=${parsed.system?.length || 0}`,
    );
    _routeDiag(
      `route() parse ok: msgs=${parsed.messages?.length || 0} tools=${parsed.tools?.length || 0} sysLen=${parsed.system?.length || 0} modelUid=${parsed.modelUid}`,
    );
  } catch (e) {
    _log(`[dao-router] [SKIP] parse 失败: ${e.message} · ${modelUid}`);
    _routeDiag(
      `route() SKIP: parse fail: ${e.message} bodyLen=${rawBody?.length} isJSON=${isJSON}`,
    );
    _stats.errors++;
    return false;
  }

  // ★ v9.9.83 · 诊断: LSP 原始 tools + SP 完整转储
  //   道义: 十六章「万物旁作 吾以观其复也」· 观其所发 · 方知其所缺
  try {
    const lspDumpPath = path.join(__dirname, "_lsp_parsed_dump.json");
    const lspDumpObj = {
      _ts: new Date().toISOString(),
      _modelUid: parsed.modelUid,
      _sysLen: (parsed.system || "").length,
      _sysPreview: (parsed.system || "").substring(0, 800),
      // ★ v9.9.83 · 完整 SP (确认 tool_calling 区块)
      _sysFull: parsed.system || "",
      _msgCount: (parsed.messages || []).length,
      // ★ v9.9.83 · 完整工具定义 (含 parameters, 确认 schema 一致性)
      _toolsFromLSP: (parsed.tools || []).map((t) => {
        const fn = t.function || t;
        return {
          name: fn.name || t.name,
          description: (fn.description || t.description || "").substring(
            0,
            200,
          ),
          parameters: fn.parameters || t.parameters || null,
        };
      }),
      _toolNames: (parsed.tools || []).map(
        (t) => (t.function || t).name || t.name,
      ),
      _toolChoice: parsed.toolChoice,
      _disableParallel: parsed.disableParallelToolCalls,
    };
    fs.writeFile(lspDumpPath, JSON.stringify(lspDumpObj, null, 2), () => {});
  } catch (_le) {}

  const messages = _fixOAMessages(_buildOAMessages(parsed));

  // ★ v9.9.99 · Token 预算管理 (移植自 Go budget.Apply)
  //   道义: 四十四章「知足不辱 知止不殆 可以长久」
  //   知其token之所耗 · 方知其所止 · 止而不殆
  let _budgetStats = null;
  if (_budget && target && target.provider !== "builtin-stub") {
    try {
      const budgetResult = _budget.apply({
        messages,
        tools: parsed.tools,
        system: parsed.system || "",
        budget: target.budget || null, // ★ per-route 预算配置
        modelUid,
      });
      // 仅在预算生效时替换 (有裁剪/压缩时)
      if (
        budgetResult.stats.messagesTrimmed > 0 ||
        budgetResult.stats.toolsRemoved > 0 ||
        budgetResult.stats.toolsCompacted > 0
      ) {
        _routeDiag(
          `route() budget.apply: msgs trimmed=${budgetResult.stats.messagesTrimmed} tools rm=${budgetResult.stats.toolsRemoved} cmp=${budgetResult.stats.toolsCompacted} total=${budgetResult.stats.totalInputTokens}/${budgetResult.stats.maxContextTokens}`,
        );
      }
      _budgetStats = budgetResult.stats;
      // 注意: 不替换 messages/tools → 仅记录统计 · 实际裁剪在 _callProvider 中按需执行
      //   道义: 无为而无以为 · 知而不妄动 · 超限时方裁
    } catch (e) {
      _log(`[dao-router] budget.apply 异常: ${e.message}`);
    }
  }

  // ★ v9.9.99 · 协议自动检测 (移植自 Go adapters.detectProtocol)
  //   道义: 道法自然 · 自动识别 · 无需手动指定
  let _detectedProtocol = null;
  if (_adapters && target && target.provider !== "builtin-stub") {
    try {
      const provCfg = _providers[target.provider] || {};
      _detectedProtocol = _adapters.detectProtocol(provCfg, target.model);
      if (_detectedProtocol !== "openai-chat") {
        _routeDiag(
          `route() protocol: ${_detectedProtocol} (auto-detected for ${target.provider}/${target.model})`,
        );
      }
    } catch (e) {
      _log(`[dao-router] detectProtocol 异常: ${e.message}`);
    }
  }

  // ★ v9.9.92 · 修法⑦ · SP 检测+日志 · 最上游 · 不修改
  //   道义: source.js 已在最上游修改 SP → 此处仅检测一致性
  //   若 SP 未道化 → 日志警告 (source.js 可能未生效)
  //   若 SP 已道化 → 日志确认 (全链路一致)
  //   不做任何修改 · 不做任何补丁 · 只观不造
  if (
    messages.length > 0 &&
    messages[0].role === "system" &&
    messages[0].content
  ) {
    const _sysContent = messages[0].content;
    if (_spInvert) {
      if (_spInvert.isAlreadyInverted(_sysContent)) {
        _routeDiag(
          `[dao-router] [SP已道化] ✓ 幂等确认 ${_sysContent.length}B · source.js最上游已生效`,
        );
      } else if (_sysContent.indexOf("<!-- DAO-ENHANCE") >= 0) {
        // ★ v9.9.101 · 太上下知有之 · 增强模式 · 官方SP保留 + DAO增强
        _routeDiag(
          `[dao-router] [SP已增强] ✓ 太上模式 ${_sysContent.length}B · 官方SP保留 + DAO增强 · 工具指令完整`,
        );
      } else if (_spInvert.isLikelyOfficialSP(_sysContent)) {
        _routeDiag(
          `[dao-router] [SP未道化] ⚠ 官方SP ${_sysContent.length}B · source.js可能未生效 · 透传`,
        );
        // ★ 不修改 · 最上游原则 · 仅日志
      } else {
        const _spType = _spInvert.classifySPType(_sysContent);
        if (_spType) {
          _routeDiag(
            `[dao-router] [SP类型=${_spType}] ${_sysContent.length}B · 非chat主路 · source.js副路处理`,
          );
        }
      }
    }
  }

  // ★ v9.9.83 · LSP 原始工具名集合
  //   道义: 二十八章「知其白 守其辱」· 知 LSP 所发 · 守 IS_CUSTOM_TOOL 正位
  //   根因: _serverToolNames 是静态集合 · LSP 可能已通过 GetSystemPromptAndTools 发送 trajectory_search
  //   若仅凭 _serverToolNames 判断 isCustomToolCall → 官方工具被误标为 custom → LSP 路由失败
  const _lspToolNames = new Set(
    (parsed.tools || []).map((t) => (t.function || t).name || t.name),
  );

  const callOpts = {
    messages,
    tools: parsed.tools,
    toolChoice: parsed.toolChoice,
    maxOutputTokens: target.maxOutputTokens || 32768,
    _lspToolNames, // ★ v9.9.83 · 传递到 _tryRoute → _streamOaToCascade
    _toolAliasMap: null, // ★ v9.9.92 · 修法⑦ · _callProvider 规范化后回填
    _detectedProtocol, // ★ v9.9.99 · 协议类型 → _streamOaToCascade 选择SSE解析器
  };

  // ── 检查 provider 是否存在且启用 ──
  // ★ v9.9.73 · builtin-stub 是内建桩 · 不在 _providers 中 · 直接放行到 _tryRoute
  if (target.provider === "builtin-stub") {
    _log(
      "[dao-router] [stub→] " +
        modelUid +
        " → builtin-stub (内建桩 · 跳过provider检查)",
    );
    _routeDiag("route() builtin-stub bypass: modelUid=" + modelUid);
    try {
      const stubOk = await _tryRoute({
        target,
        callOpts,
        res,
        isJSON,
        modelUid,
        isPrimary: true,
        w,
        effectiveModel: _isWildcard ? modelUid : undefined,
      });
      if (stubOk) {
        _stats.routed++;
        return true;
      }
    } catch (e) {
      _log("[dao-router] [stub✗] " + modelUid + ": " + e.message);
    }
    _stats.errors++;
    _routeDiag("route() builtin-stub ALL FAIL: " + modelUid);
    return false;
  }
  const provCfg = _providers[target.provider];
  if (!provCfg || provCfg.enabled === false) {
    _log(
      `[dao-router] [SKIP] provider=${target.provider} 不存在或已禁用 · ${modelUid}`,
    );
    _stats.errorFallback++;
    // 直接尝试 fallback
    if (target.fallback && target.fallback.provider) {
      const fbTarget = {
        ...target.fallback,
        maxOutputTokens: target.maxOutputTokens,
      };
      const fbProvCfg = _providers[fbTarget.provider];
      if (fbProvCfg && fbProvCfg.enabled !== false) {
        _log(
          `[dao-router] [FB→] ${modelUid} → ${fbTarget.provider}/${fbTarget.model}`,
        );
        try {
          const fbOk = await _tryRoute({
            target: fbTarget,
            callOpts,
            res,
            isJSON,
            modelUid,
            isPrimary: true,
            w,
            effectiveModel: _isWildcard ? modelUid : undefined,
          });
          if (fbOk) {
            _stats.fallbackRouted++;
            return true;
          }
        } catch (e) {
          _log(`[dao-router] [FB✗] ${modelUid}: ${e.message}`);
        }
      }
    }
    _stats.errors++;
    return false;
  }

  // ── 尝试主路由 ──
  let primaryOk = false;
  try {
    primaryOk = await _tryRoute({
      target,
      callOpts,
      res,
      isJSON,
      modelUid,
      isPrimary: true,
      w,
      effectiveModel: _isWildcard ? modelUid : undefined,
    });
  } catch (e) {
    _log(`[dao-router] [✗] 主路由异常 ${modelUid}: ${e.message}`);
  }
  if (primaryOk) {
    _stats.routed++;
    return true;
  }

  // ── 主路由失败 → 尝试 fallback ──
  if (target.fallback && target.fallback.provider) {
    _stats.errorFallback++;
    const fbTarget = {
      ...target.fallback,
      maxOutputTokens: target.maxOutputTokens,
    };
    const fbProvCfg = _providers[fbTarget.provider];
    if (!fbProvCfg || fbProvCfg.enabled === false) {
      _log(
        `[dao-router] [FB✗] fallback provider=${fbTarget.provider} 不存在或已禁用`,
      );
    } else {
      _log(
        `[dao-router] [FB→] ${modelUid} → ${fbTarget.provider}/${fbTarget.model}`,
      );
      try {
        const fbOk = await _tryRoute({
          target: fbTarget,
          callOpts,
          res,
          isJSON,
          modelUid,
          isPrimary: false,
          w,
          effectiveModel: _isWildcard ? modelUid : undefined,
        });
        if (fbOk) {
          _stats.fallbackRouted++;
          return true;
        }
      } catch (e) {
        _log(`[dao-router] [FB✗] ${modelUid}: ${e.message}`);
      }
    }
  }

  // ── 全部失败 → 返回 false (由 source.js 直接报错 · 不回退官方) ──
  _stats.errors++;
  _log(`[dao-router] [✗] ${modelUid} 所有路由失败 · 不回退官方`);
  _routeDiag(`route() ALL FAIL: ${modelUid} headersSent=${res.headersSent}`);
  return false;
}

/** 尝试单条路由 */
async function _tryRoute({
  target,
  callOpts,
  res,
  isJSON,
  modelUid,
  isPrimary,
  w,
  effectiveModel, // ★ 通配符时用原始 modelUid 替代 target.model
}) {
  // ★ v9.9.73 · 内建桩: builtin-stub → 零依赖传输层验证
  //   不调 _callProvider · 不做健康检查 · 不假外求
  //   道义: 三十九章「侯王得一以为天下正」· 得一则正
  if (target.provider === "builtin-stub") {
    _log("[dao-router] [stub→] " + modelUid + " → builtin-stub (传输层验证)");
    _routeDiag(
      "_tryRoute builtin-stub: modelUid=" +
        modelUid +
        " msgs=" +
        (callOpts.messages || []).length +
        " tools=" +
        (callOpts.tools || []).length,
    );
    try {
      const ok = await _stubToCascade(
        res,
        w,
        modelUid,
        callOpts.messages,
        callOpts.tools,
        isJSON,
      );
      return ok;
    } catch (e) {
      _log("[dao-router] [stub✗] " + modelUid + ": " + e.message);
      _routeDiag("_tryRoute builtin-stub EXCEPTION: " + e.message);
      return false;
    }
  }

  const provCfg = _providers[target.provider] || {};
  const tag = isPrimary ? "" : "[备]";
  const sendModel = effectiveModel || target.model;

  // ★ v9.9.62 · DEFECT12 修复: 恢复健康检查 (devindao /admin/health 已可用)
  if (isPrimary && provCfg.healthCheck) {
    // ★ v9.9.58 · 相对路径拼接 baseUrl · 道法自然
    let hcUrl = provCfg.healthCheck;
    if (hcUrl.startsWith("/")) {
      const base = provCfg.baseUrl || _gatewayUrl;
      try {
        const baseU = new URL(base);
        hcUrl = `${baseU.protocol}//${baseU.hostname}:${baseU.port || (baseU.protocol === "https:" ? "443" : "80")}${hcUrl}`;
      } catch {
        hcUrl = `http://127.0.0.1:7788${hcUrl}`;
      }
    }
    const alive = await _checkHealth(target.provider, hcUrl);
    if (!alive) {
      _log(
        `[dao-router] ${tag}[SKIP] ${target.provider} 健康检查失败 · ${modelUid} · url=${hcUrl}`,
      );
      return false;
    }
  }

  _log(`[dao-router] ${tag}[→] ${modelUid} → ${target.provider}/${sendModel}`);
  try {
    const agRes = await _callProvider(
      provCfg,
      target.provider,
      sendModel,
      callOpts.messages,
      callOpts.tools,
      callOpts.toolChoice,
      callOpts.maxOutputTokens,
      target, // ★ v9.9.80 · 传入路由配置 (含 thinkingEnabled)
      callOpts._lspToolNames, // ★ v9.9.83 · LSP 原始工具名集合
      callOpts, // ★ v9.9.92 · 修法⑦ · 回填 _toolAliasMap
    );

    if (agRes.statusCode !== 200) {
      const errBody = await _readAll(agRes);
      _log(
        `[dao-router] ${tag}[✗] HTTP ${agRes.statusCode}: ${errBody.slice(0, 180)}`,
      );
      _routeDiag(
        `_tryRoute ${tag} HTTP ${agRes.statusCode}: ${errBody.slice(0, 200)} model=${sendModel}`,
      );
      if (isPrimary && agRes.statusCode >= 500) {
        _healthCache[target.provider] = { alive: false, ts: Date.now() };
      }
      return false;
    }

    if (!res.headersSent) {
      // ★ v9.9.73e · 与官方 API 响应头完全对齐
      //   实证: 官方 API 返回 content-type=application/connect+proto + connect-accept-encoding=gzip
      //   道义: 执今之道以御今之有 · 与官方一致方能通
      res.writeHead(200, {
        "content-type": isJSON
          ? "application/connect+json"
          : "application/connect+proto",
        "connect-accept-encoding": "gzip",
      });
    }
    _routeDiag(
      `_tryRoute ${tag} writeHead(200) streamMode=${provCfg.streamMode || "stream"} model=${sendModel}`,
    );
    // ★ v9.9.83 · 传递 lspToolNames 到流式/非流式转换
    // ★ v9.9.92 · 修法⑦ · 传递 _toolAliasMap 到流式/非流式转换 · 工具名反规范化
    // ★ v9.9.99 · 传递 protocol 到流式/非流式转换 · 多协议SSE解析
    const _lspTN = callOpts._lspToolNames;
    const _tam = callOpts._toolAliasMap || null;
    const _protocol =
      callOpts._detectedProtocol || provCfg.protocol || "openai-chat";
    const streamResult = await (provCfg.streamMode === "unary"
      ? _unaryOaToCascade(agRes, res, w, modelUid, _lspTN, _tam, _protocol)
      : _streamOaToCascade(agRes, res, w, modelUid, _lspTN, _tam, _protocol));

    // ★ v9.9.86 · 服务端工具内部重试 (大制无割版)
    //   当 DeepSeek 调用了服务端工具 (trajectory_search 等) 时:
    //   1. _streamOaToCascade 已拦截 → 缓冲帧被丢弃 → 流保持打开
    //   2. 代理层执行工具 → 生成 tool result
    //   3. 将 assistant tool_calls (含 thinking + text) + tool result 追加到 messages
    //   4. 内部重试请求 DeepSeek → 流式转发新响应到同一个 res
    //   5. LSP 只看到最终的文本回复 → 完全无感
    //   道义: 十七章「太上不知有之」· LSP 不知有服务端工具调用
    //   限制: 最多重试 3 次 → 防止无限循环
    if (
      streamResult &&
      streamResult.serverSideCalls &&
      streamResult.serverSideCalls.length > 0
    ) {
      const _MAX_RETRIES = 3;
      let _retryCount = 0;
      let _currentMessages = callOpts.messages; // 原始 messages (已转为 OA 格式)
      let _remainingServerCalls = streamResult.serverSideCalls;
      let _lastRetryResult = null;
      // ★ v9.9.86 · 保留第一轮的 thinking + text 内容
      let _prevTextAccum = streamResult.textAccum || "";
      let _prevThinkAccum = streamResult.thinkAccum || "";

      while (_remainingServerCalls.length > 0 && _retryCount < _MAX_RETRIES) {
        _retryCount++;
        _log(
          `[dao-router] ⚡ 内部重试 #${_retryCount}: ${_remainingServerCalls.length} 个服务端工具`,
        );
        _routeDiag(
          `_tryRoute internal retry #${_retryCount}: serverSideCalls=${_remainingServerCalls.length} names=${_remainingServerCalls.map((c) => c.name).join(",")}`,
        );

        // 执行服务端工具 → 生成 tool result
        const _toolResults = _remainingServerCalls.map((tc) => ({
          tool_call_id: tc.id,
          content: _executeServerTool(tc.name, tc.argumentsJson),
        }));

        // ★ v9.9.86 · 追加 assistant 消息: 保留 thinking + text 内容
        //   DeepSeek 要求 assistant 消息的 reasoning_content 和 content
        //   必须与实际产生的一致 → 否则 400 错误
        //   道义: 二十八章「大制无割」· 消息序列完整方能通
        // ★ v9.9.87 · 合并所有工具调用 (服务端 + LSP)
        //   DeepSeek 要求 assistant 消息的 tool_calls 包含所有调用的工具
        //   如果只包含服务端工具 → DeepSeek 认为未调用 LSP 工具 → 重复调用
        //   道义: 二十八章「大制无割」· 完整方能通
        const _allToolCalls = [
          ..._remainingServerCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson },
          })),
          ...(streamResult.lspSideCalls || []).map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson || "{}" },
          })),
        ];

        _currentMessages = [
          ..._currentMessages,
          {
            role: "assistant",
            content: _prevTextAccum || "", // ★ 保留文本内容
            reasoning_content: _prevThinkAccum || "", // ★ 保留 thinking 内容
            tool_calls: _allToolCalls,
          },
        ];

        // 追加 tool result 消息 (服务端工具)
        for (const tr of _toolResults) {
          _currentMessages.push({
            role: "tool",
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          });
        }

        // ★ v9.9.87 · 追加 LSP 工具的占位 tool result
        //   如果第一轮同时有 SERVER + LSP 工具调用, LSP 工具也需要 tool result
        //   否则 DeepSeek 会报错: assistant 有 tool_calls 但缺少对应的 tool result
        //   占位结果告诉 DeepSeek 该工具暂不可用 → 重试时不再调用
        //   道义: 二十八章「大制无割」· 消息序列完整方能通
        const _lspSideCalls = streamResult.lspSideCalls || [];
        for (const tc of _lspSideCalls) {
          _currentMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `[LSP tool ${tc.name} not executed in proxy retry - will be re-invoked in next response]`,
          });
        }

        // ★ 修复消息序列: 确保不以 tool 消息结尾
        _currentMessages = _fixOAMessages(_currentMessages);

        // ★ v9.9.87 · 心跳帧: 内部重试期间发送 thinking 帧 · 防止 LSP 超时 abort
        //   道义: 五章「虚而不淈 踵而俞出」· 流不塞则通 · 心跳不息则连接不竭
        //   LSP 客户端约 10 秒无数据则 abort → 重试调用可能耗时 10+ 秒
        //   发送 thinking 帧让 LSP 知道连接仍活跃
        const _heartbeatMsg = `[执行服务端工具 ${_remainingServerCalls.map((c) => c.name).join(", ")} · 内部重试 #${_retryCount}]`;
        try {
          const _hbMsgId = Date.now();
          const _hbHdrBuf = w.buildFrameHeader(_hbMsgId, _hbMsgId);
          const _hbParts = [_hbHdrBuf];
          _hbParts.push(w.encodeString(w.RSP.DELTA_THINKING, _heartbeatMsg));
          const _hbFr = w.buildFrame(0, Buffer.concat(_hbParts));
          if (_hbFr && _hbFr.length && !res.writableEnded) {
            res.write(_hbFr);
            _routeDiag(
              `_tryRoute heartbeat #${_retryCount}: thinking frame sent (${_heartbeatMsg.length}B)`,
            );
          }
        } catch (_hbErr) {
          _routeDiag(
            `_tryRoute heartbeat #${_retryCount} FAILED: ${_hbErr.message}`,
          );
        }

        // ★ v9.9.87 · 心跳定时器: 重试调用期间每 5 秒发送一次 thinking 帧
        //   防止 DeepSeek 响应慢时 LSP 超时
        const _heartbeatInterval = setInterval(() => {
          try {
            const _hb2MsgId = Date.now();
            const _hb2HdrBuf = w.buildFrameHeader(_hb2MsgId, _hb2MsgId);
            const _hb2Parts = [_hb2HdrBuf];
            _hb2Parts.push(w.encodeString(w.RSP.DELTA_THINKING, `...`));
            const _hb2Fr = w.buildFrame(0, Buffer.concat(_hb2Parts));
            if (_hb2Fr && _hb2Fr.length && !res.writableEnded) {
              res.write(_hb2Fr);
              _routeDiag(`_tryRoute heartbeat tick #${_retryCount}: keepalive`);
            }
          } catch {}
        }, 5000);

        // 重新请求 DeepSeek
        let retryRes;
        try {
          retryRes = await _callProvider(
            provCfg,
            target.provider,
            sendModel,
            _currentMessages,
            callOpts.tools,
            callOpts.toolChoice,
            callOpts.maxOutputTokens,
            target,
            callOpts._lspToolNames,
            callOpts, // ★ v9.9.92 · 修法⑦ · 回填 _toolAliasMap
          );
        } finally {
          // ★ 无论成功失败都停止心跳定时器
          clearInterval(_heartbeatInterval);
        }

        if (retryRes.statusCode !== 200) {
          const errBody = await _readAll(retryRes);
          _log(
            `[dao-router] ⚡ 内部重试 HTTP ${retryRes.statusCode}: ${errBody.slice(0, 180)}`,
          );
          break;
        }

        // 流式转发重试响应到同一个 res
        _lastRetryResult = await (provCfg.streamMode === "unary"
          ? _unaryOaToCascade(
              retryRes,
              res,
              w,
              modelUid,
              _lspTN,
              _tam,
              _protocol,
            )
          : _streamOaToCascade(
              retryRes,
              res,
              w,
              modelUid,
              _lspTN,
              _tam,
              _protocol,
            ));

        // 检查重试响应中是否又有服务端工具调用
        _remainingServerCalls =
          (_lastRetryResult && _lastRetryResult.serverSideCalls) || [];
        if (_remainingServerCalls.length === 0) {
          _log(
            `[dao-router] ⚡ 内部重试 #${_retryCount} 完成: 无更多服务端工具调用`,
          );
          break;
        }

        // ★ v9.9.86 · 保留重试轮的 thinking + text 内容
        _prevTextAccum = (_lastRetryResult && _lastRetryResult.textAccum) || "";
        _prevThinkAccum =
          (_lastRetryResult && _lastRetryResult.thinkAccum) || "";
      }

      // ★ v9.9.86 · 流最终化: 检查流是否仍打开 → 手动关闭
      //   _streamOaToCascade 无服务端工具时自动关闭流 (streamFinalized=undefined)
      //   有服务端工具时流被保持打开 (streamFinalized=false) → 需手动关闭
      const _needFinalize =
        streamResult.streamFinalized === false && // 原始流被保持打开
        (!_lastRetryResult || _lastRetryResult.streamFinalized === false); // 重试也没关闭
      if (_needFinalize) {
        const _finalStopReason =
          (_lastRetryResult && _lastRetryResult.stopReason) || w.STOP_END;
        const _msgId = Date.now();
        const _hdrBuf = w.buildFrameHeader(_msgId, _msgId);
        if (_finalStopReason !== null) {
          const parts = [];
          parts.push(_hdrBuf);
          parts.push(w.encodeUint(w.RSP.STOP_REASON, _finalStopReason));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length) res.write(fr);
        }
        if (w.buildEndFrame) {
          const fr = w.buildEndFrame(null);
          if (fr && fr.length) res.write(fr);
        }
        if (!res.writableEnded) res.end();
        _log(`[dao-router] ⚡ 流最终化: stopReason=${_finalStopReason}`);
      }

      if (_retryCount >= _MAX_RETRIES && _remainingServerCalls.length > 0) {
        _log(
          `[dao-router] ⚡ 内部重试达到上限 ${_MAX_RETRIES}: ${_remainingServerCalls.length} 个未处理`,
        );
      }
    }

    _log(
      `[dao-router] ${tag}[✓] ${modelUid} → ${target.provider}/${sendModel}`,
    );
    _routeDiag(
      `_tryRoute ${tag} SUCCESS: ${modelUid} → ${target.provider}/${sendModel}`,
    );
    return true;
  } catch (e) {
    _log(`[dao-router] ${tag}[✗] ${target.provider} 异常: ${e.message}`);
    _routeDiag(
      `_tryRoute ${tag} EXCEPTION: ${e.message} provider=${target.provider} model=${sendModel}`,
    );
    if (isPrimary && e.message.includes("ECONNREFUSED")) {
      _healthCache[target.provider] = { alive: false, ts: Date.now() };
    }
    return false;
  }
}

/**
 * 状态快照 · 供 MITM /health 端点使用
 */
function status() {
  const provHealth = {};
  for (const [name, h] of Object.entries(_healthCache)) {
    provHealth[name] = { alive: h.alive, ageMs: Date.now() - h.ts };
  }
  return {
    ready: _ready,
    count: Object.keys(_routes).length,
    uids: Object.keys(_routes),
    gateway: _gatewayUrl,
    stats: { ..._stats },
    providers: Object.keys(_providers),
    provHealth,
  };
}

// ════════════════════════════════════════════════════════════════
// §2  私有辅助
// ════════════════════════════════════════════════════════════════

/**
 * ★ v9.9.85b · 修复 OpenAI 消息序列
 *   DeepSeek API 要求: 消息不能以 tool 消息结尾
 *   如果最后一条是 tool → 追加一条 assistant 占位消息
 *   道义: 「大方无隅」· 大方无缺 · 消息序列无缺方能通
 */
// ★ v9.9.86 · _fixOAMessages (简化版) — 已合并到下方完整版
//   保留此占位以避免行号偏移

/**
 * 将 Cascade 消息格式 → OpenAI messages 数组
 */
function _buildOAMessages(parsed) {
  const messages = [];
  if (parsed.system) messages.push({ role: "system", content: parsed.system });
  for (const m of parsed.messages || []) {
    const out = { role: m.role === "tool" ? "tool" : m.role || "user" };
    const hasImages = Array.isArray(m.images) && m.images.length > 0;

    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length
    ) {
      // assistant + tool_calls
      out.content = hasImages
        ? [{ type: "text", text: m.content || "" }, ...m.images]
        : m.content || null;
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id || "",
        type: "function",
        function: {
          name: tc.name || "",
          arguments: tc.argumentsJson || "{}",
        },
      }));
      // ★ v9.9.80 · 思考内容: DeepSeek 多轮对话需回传 reasoning_content
      // ★ v9.9.84 · 严格模式: 有 tool_calls 的 assistant 必须带 reasoning_content
      //   DeepSeek API 文档: "for turns that do perform tool calls,
      //   the reasoning_content must be fully passed back to the API"
      //   若 LSP 未保存 thinking → 补空字符串 → 防止 400 错误
      //   道义: 无以为而有以为 · 无思考亦当有思考之位
      out.reasoning_content = m.thinking || "";
    } else if (m.role === "assistant") {
      // assistant (no tool_calls)
      out.content = hasImages
        ? [{ type: "text", text: m.content || "" }, ...m.images]
        : m.content || "";
      // ★ v9.9.80 · 思考内容
      // ★ v9.9.84 · 无 tool_calls 的 assistant: reasoning_content 可选 (传了也会被忽略)
      //   但为安全起见仍然回传 (利而不害)
      if (m.thinking) out.reasoning_content = m.thinking;
    } else if (m.role === "tool") {
      // tool result
      out.content =
        (m.tool_result_is_error ? "[ERROR] " : "") + (m.content || "");
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    } else {
      // user / system
      out.content = hasImages
        ? [{ type: "text", text: m.content || "" }, ...m.images]
        : m.content || "";
    }
    messages.push(out);
  }
  return messages;
}

/**
 * 修复 OpenAI 格式消息序列 · 确保每个 tool_calls 都有对应的 tool 响应
 * DeepSeek 严格要求: assistant tool_calls 后必须紧跟每个 tool_call_id 的 tool 响应
 */
function _fixOAMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const fixed = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    fixed.push(m);
    // 如果是 assistant 且有 tool_calls，检查后续是否有对应的 tool 响应
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const requiredIds = new Set(m.tool_calls.map((tc) => tc.id));
      // 扫描后续消息，收集已有的 tool_call_id
      const providedIds = new Set();
      for (
        let j = i + 1;
        j < messages.length && messages[j].role === "tool";
        j++
      ) {
        if (messages[j].tool_call_id) providedIds.add(messages[j].tool_call_id);
      }
      // 为缺失的 tool_call_id 添加占位响应
      for (const tc of m.tool_calls) {
        if (!providedIds.has(tc.id)) {
          fixed.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `[tool result for ${tc.function?.name || tc.id}]`,
          });
        }
      }
    }
  }
  // ★ v9.9.86 · 确保最后一条消息不是 tool 类型
  //   DeepSeek API 不接受以 tool 消息结尾 → 追加 assistant 占位
  //   旧版追加 user:continue → 但 DeepSeek 期望 tool 后是 assistant 回复
  //   道义: 二十八章「大制无割」· 消息序列完整方能通
  if (fixed.length > 0 && fixed[fixed.length - 1].role === "tool") {
    fixed.push({
      role: "assistant",
      content: "",
      reasoning_content: "", // ★ DeepSeek thinking 模式必需
    });
  }
  return fixed;
}

/** 快速健康检查 (带缓存) */
function _checkHealth(name, healthUrl) {
  const cache = _healthCache[name];
  if (cache && Date.now() - cache.ts < HEALTH_TTL)
    return Promise.resolve(cache.alive);
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(healthUrl);
    } catch (e) {
      _log(
        `[dao-router] _checkHealth URL parse fail: ${healthUrl} · ${e.message}`,
      );
      return resolve(false);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: parseInt(u.port || (u.protocol === "https:" ? "443" : "80")),
        path: u.pathname,
        method: "GET",
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const alive = res.statusCode >= 200 && res.statusCode < 400;
        _healthCache[name] = { alive, ts: Date.now() };
        _log(
          `[dao-router] _checkHealth ${name}: ${alive ? "ALIVE" : "DEAD"} (${res.statusCode}) url=${healthUrl}`,
        );
        resolve(alive);
      },
    );
    req.on("error", (e) => {
      _healthCache[name] = { alive: false, ts: Date.now() };
      _log(
        `[dao-router] _checkHealth ${name} ERROR: ${e.message} url=${healthUrl}`,
      );
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      _healthCache[name] = { alive: false, ts: Date.now() };
      _log(`[dao-router] _checkHealth ${name} TIMEOUT url=${healthUrl}`);
      resolve(false);
    });
    req.end();
  });
}

/**
 * 自动探活 provider baseUrl (支持 baseUrlFallbackPorts)
 */
function _resolveBaseUrl(provCfg) {
  const primary = provCfg.baseUrl;
  const fallbackPorts = provCfg.baseUrlFallbackPorts || [];
  if (!fallbackPorts.length) return Promise.resolve(primary);
  // ★ v9.9.64 · 修: new Promise(async) 反模式 → async IIFE
  return (async () => {
    for (const testUrl of [
      primary,
      ...fallbackPorts.map((p) => primary.replace(/:?\d+$/, ":" + p)),
    ]) {
      try {
        const u = new URL(testUrl);
        const alive = await _checkHealth(
          "_resolve_" + u.port,
          testUrl.replace(/\/v.*$/, "") + "/admin/health",
        );
        if (alive) {
          return testUrl.replace(/\/v.*$/, "");
        }
      } catch {}
    }
    return primary; // 全部失败默认用主端口
  })();
}

/**
 * 调用 provider 端点
 * noProviderPrefix=true  → model 原名直发（github/Azure）
 * modelPrefix=xxx        → xxx/model 发到 baseUrl（cascadeRelay/windsurfRelay 通过070网关）
 * 其他              → gatewayUrl + providerName::model
 */
async function _callProvider(
  provCfg,
  providerName,
  model,
  messages,
  tools,
  toolChoice,
  maxOutputTokens,
  target, // ★ v9.9.80 · 路由配置 (含 thinkingEnabled 等)
  lspToolNames, // ★ v9.9.83 · LSP 原始工具名集合 (修正 isCustomToolCall)
  callOpts, // ★ v9.9.92 · 修法⑦ · 回填 _toolAliasMap
) {
  // ★ v9.9.64 · 修: new Promise(async) 反模式 → async IIFE + new Promise
  //   反模式中 async throw 不触发 reject → unhandledRejection → Windsurf reload
  return (async () => {
    let toolsField;
    if (Array.isArray(tools) && tools.length > 0) {
      toolsField = tools
        .map((t) => {
          // ★ v9.9.79 · 兼容两种 tools 格式
          //   decodeChatToolDefinition 返回: {type:"function", function:{name,description,parameters}}
          //   其他来源可能返回: {name, description, inputSchema/parameters}
          //   道义: 三十九章「得一」· 两种格式得一即通
          const fn = t.function || t;
          return {
            type: "function",
            function: {
              name: fn.name || t.name || "",
              description: fn.description || t.description || "",
              parameters: fn.parameters || t.inputSchema || t.parameters || {},
            },
          };
        })
        .filter((t) => t.function.name && t.function.name.length > 0);

      // ★ v9.9.101 · 太上下知有之 · 工具层完全同步官方 · 不规范化和过滤
      //   道义: 不论是基础设施层还是提示词层完全和官方一致
      //   根因: normalizeToolDefs + _KNOWN_TOOL_NAMES白名单过滤 → 与官方API不一致
      //   修复: 直接透传原始工具名(与官方API一致) · 不normalize · 不filter · 不denormalize
      //   官方API收到LSP别名(Read/Edit/Grep) · DeepSeek也应收到LSP别名
      //   DeepSeek响应中也是LSP别名 · 无需反规范化 · Windsurf直接识别
      let _toolAliasMap = null; // ★ v9.9.101 · 置空 · 不规范化 · 透传原始名

      // ★ v9.9.101 · 太上下知有之 · 补充工具去重: 检查LSP别名映射
      //   不再规范化后，LSP发送别名(CodeSearch)，补充工具是标准名(code_search)
      //   需要检查别名映射避免重复添加 · 大制无割 · 同一工具不应出现两次
      //   道义: 四十章「天下之物生于有」· 有工具方能调用 · 无则不调
      const _existingNames = new Set(toolsField.map((t) => t.function.name));
      // ★ v9.9.101 · 构建反向映射: 标准名 → LSP别名
      //   如果LSP发了CodeSearch(alias) → code_search(standard) 已存在 → 不补充
      const _stdToAlias = {};
      if (_spInvert && _spInvert.TOOL_ALIAS_TO_STANDARD) {
        for (const [alias, std] of Object.entries(
          _spInvert.TOOL_ALIAS_TO_STANDARD,
        )) {
          _stdToAlias[std] = alias;
        }
      }
      for (const st of _serverToolDefs) {
        // 检查标准名和LSP别名是否都已存在
        const _aliasName = _stdToAlias[st.name];
        if (!_existingNames.has(st.name) && !_existingNames.has(_aliasName)) {
          toolsField.push({ type: "function", function: st });
          _existingNames.add(st.name);
        }
      }

      // ★ v9.9.101 · 太上下知有之 · 移除工具白名单过滤
      //   道义: 官方API不过滤工具 · DeepSeek也不应过滤 · 所有工具透传
      //   旧逻辑: _KNOWN_TOOL_NAMES 白名单 + MCP前缀 → 其他丢弃
      //   根因: 白名单过滤导致新工具/MCP工具丢失 → 与官方不一致
      //   修复: 不过滤 · 透传所有工具 · 与官方API完全一致
      //   _KNOWN_TOOL_NAMES 保留用于诊断日志(不用于过滤)

      if (toolsField.length === 0) toolsField = undefined;
      // ★ v9.9.80 · 诊断: 记录实际传给 provider 的工具名
      _routeDiag(
        "_callProvider tools: count=" +
          (toolsField ? toolsField.length : 0) +
          " names=" +
          (toolsField
            ? toolsField.map((t) => t.function.name).join(",")
            : "(none)"),
      );
    }

    // ★ v9.9.101 · 太上下知有之 · DeepSeek路由增强SP
    //   道义: 十七章「太上 下知有之」· DAO存在但不可见 · 官方功能完整保留
    //   根因: source.js invertSP()完全替换官方SP → DeepSeek无官方指令 → 工具不可用
    //   修复: 在 _callProvider 中增强SP — 保留官方SP + 追加DAO文本 · 非替换
    //   此处是热重载安全区 · dao_router.js 的修改会被 _eaHotReload 自动生效
    if (
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages[0].role === "system" &&
      typeof messages[0].content === "string"
    ) {
      const _spText = messages[0].content;
      const _isInverted = _spInvert && _spInvert.isAlreadyInverted(_spText);
      const _isEnhanced = _spText.indexOf("<!-- DAO-ENHANCE") >= 0;
      const _isOfficial = _spInvert && _spInvert.isLikelyOfficialSP(_spText);
      if (!_isInverted && !_isEnhanced && _isOfficial) {
        // ★ 官方SP未被道化/增强 → 增强模式: 保留官方SP + 追加DAO
        const _daoText = _getDaoEnhanceText();
        if (_daoText) {
          const _enhanced = _spText + _ENHANCE_MARKER + _daoText;
          _routeDiag(
            `[太上·增强SP] ${_spText.length}B → ${_enhanced.length}B (官方SP保留 + DAO增强)`,
          );
          messages[0].content = _enhanced;
        }
      } else if (_isEnhanced) {
        _routeDiag(
          `[dao-router] [SP已增强] ✓ 太上模式 ${_spText.length}B · 官方SP保留 + DAO增强 · 工具指令完整`,
        );
      }
    }

    // ★ v9.9.88 · compact system message (移植自 EXE compactPromptText)
    //   压缩 SP 多余空白 · 节省 token · 道义: 损之又损
    if (
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages[0].role === "system" &&
      typeof messages[0].content === "string"
    ) {
      const _origLen = messages[0].content.length;
      messages[0].content = _compactPromptText(messages[0].content);
      if (messages[0].content.length < _origLen) {
        _routeDiag(
          "_callProvider compact SP: " +
            _origLen +
            " → " +
            messages[0].content.length +
            " (-" +
            (_origLen - messages[0].content.length) +
            ")",
        );
      }
    }

    const bodyObj = { messages, stream: provCfg.streamMode !== "unary" };
    if (toolsField) {
      bodyObj.tools = toolsField;
      // ★ v9.9.84 · DeepSeek V4 thinking 模式不支持 tool_choice
      //   实证: https://github.com/deepseek-ai/DeepSeek-V3/issues/1376
      //   thinking 模式下发送 tool_choice → 400 或被忽略 → 不可预测行为
      //   非 thinking 模式: 正常发送 tool_choice
      //   道义: 知止不殆 · 知其不可为则不为
      const _isThinkingMode = target && target.thinkingEnabled;
      if (!_isThinkingMode) {
        bodyObj.tool_choice = toolChoice || "auto";
      }
    }
    if (maxOutputTokens) bodyObj.max_tokens = maxOutputTokens;

    // ★ v9.9.80 · 思考模式: DeepSeek V3.2 支持 thinking + tools
    //   配置中 thinkingEnabled=true → 请求体加 thinking:{type:"enabled"}
    //   响应 SSE 中 delta.reasoning_content 包含思考内容
    //   _streamOaToCascade 已支持 reasoning_content → DELTA_THINKING 帧
    //   道义: 三十九章「神得一以灵」· 得思考方能灵
    if (target && target.thinkingEnabled) {
      bodyObj.thinking = { type: "enabled" };
      _routeDiag("_callProvider thinking: enabled for model=" + model);
    }

    // ★ v9.9.99 · 多协议适配 (移植自 Go adapters)
    //   道义: 二十八章「知其白 守其辱 为天下式」
    //   知各协议之白 · 守其转换之辱 · 为天下适配之式
    //   Anthropic → /v1/messages · Responses → /v1/responses · 其他 → /v1/chat/completions
    let _adapter = null;
    let _protocol = provCfg.protocol || null;
    if (_adapters) {
      _protocol = _protocol || _adapters.detectProtocol(provCfg, model);
      _adapter = _adapters.adapterFor(_protocol);
    }

    if (_adapter && _protocol !== "openai-chat") {
      // ── 非默认协议: 使用适配器构建请求 ──
      const adapterBody = _adapter.buildRequest({
        messages,
        tools: toolsField,
        toolChoice,
        maxOutputTokens,
        model,
        stream: provCfg.streamMode !== "unary",
        thinkingEnabled: target && target.thinkingEnabled,
        thinkingBudget: target && target.thinkingBudget,
        reasoningEffort: target && target.reasoningEffort,
        system:
          messages.length > 0 && messages[0].role === "system"
            ? messages[0].content
            : "",
      });

      let targetUrl,
        extraHeaders = {};

      // URL 构建
      const completionPath = _adapter.getCompletionPath(provCfg);
      if (provCfg.baseUrl) {
        const resolvedBase = await _resolveBaseUrl(provCfg);
        targetUrl = new URL(resolvedBase.replace(/\/$/, "") + completionPath);
      } else {
        targetUrl = new URL(_gatewayUrl + completionPath);
      }

      // 适配器专用头
      const adapterOpts = _adapter.buildRequestOpts(
        provCfg,
        adapterBody,
        targetUrl,
      );
      extraHeaders = { ...extraHeaders, ...(adapterOpts.headers || {}) };

      // ★ Anthropic: 移除 Authorization Bearer (使用 x-api-key)
      if (_protocol === "anthropic" && extraHeaders["Authorization"]) {
        delete extraHeaders["Authorization"];
      }

      const body = JSON.stringify(adapterBody);
      const isHttps = targetUrl.protocol === "https:";
      const mod = isHttps ? https : http;

      _routeDiag(
        `_callProvider adapter: protocol=${_protocol} url=${targetUrl.href} bodyLen=${body.length}`,
      );

      // ★ v9.9.102 · 修法㉑ · 注入代理agent
      const _proxyAgent = _getProxyAgent(isHttps);
      return new Promise((resolve, reject) => {
        const opts = {
          hostname: targetUrl.hostname,
          port: parseInt(targetUrl.port || (isHttps ? "443" : "80")),
          path: targetUrl.pathname + (targetUrl.search || ""),
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            // ★ v10.0 · 修法⑳ · Accept 根据流/非流动态设置
            Accept:
              provCfg.streamMode !== "unary"
                ? "text/event-stream"
                : "application/json",
            ...extraHeaders,
          },
          rejectUnauthorized: false,
          ...(_proxyAgent ? { agent: _proxyAgent } : {}),
        };
        const req = mod.request(opts, resolve);
        req.on("error", reject);
        req.setTimeout(120000, () =>
          req.destroy(new Error("provider timeout")),
        );
        req.write(body);
        req.end();
      });
    }

    // ── 默认协议: OpenAI Chat (原有逻辑) ──

    let targetUrl,
      extraHeaders = {};

    if (provCfg.baseUrl && provCfg.noProviderPrefix) {
      // ── 直连模式: github→Azure (model原名直发) ──
      bodyObj.model = model;
      const completionPath = provCfg.completionPath || "/v1/chat/completions";
      const resolvedBase = await _resolveBaseUrl(provCfg);
      targetUrl = new URL(resolvedBase.replace(/\/$/, "") + completionPath);
      if (provCfg.apiKey)
        extraHeaders["Authorization"] = `Bearer ${provCfg.apiKey}`;
    } else if (provCfg.baseUrl && provCfg.modelPrefix) {
      // ── 070网关前缀模式: cascadeRelay/gpt-5-4-low → 070网关 ──
      bodyObj.model = `${provCfg.modelPrefix}/${model}`;
      const completionPath = provCfg.completionPath || "/v1/chat/completions";
      const resolvedBase = await _resolveBaseUrl(provCfg);
      targetUrl = new URL(resolvedBase.replace(/\/$/, "") + completionPath);
      if (provCfg.apiKey)
        extraHeaders["Authorization"] = `Bearer ${provCfg.apiKey}`;
    } else {
      // ── 兜底网关模式: providerName::model → _gatewayUrl ──
      bodyObj.model = `${providerName}::${model}`;
      targetUrl = new URL(_gatewayUrl + "/v1/chat/completions");
    }

    const body = JSON.stringify(bodyObj);

    // ★ v9.9.82 · 诊断转储: 写出发给上游模型的完整请求体
    //   道义: 十六章「致虚极也 守情表也」· 致虚于日志 · 守情于实证
    //   反者道之动 · 不知实则不可修 · 知实则修之无碍
    try {
      const dumpPath = path.join(__dirname, "_upstream_req_dump.json");
      const dumpObj = {
        _ts: new Date().toISOString(),
        _model: model,
        _url: (targetUrl || {}).href || "?",
        // ★ v9.9.92-fix · 诊断 Authorization 是否存在 · 401 根因排查
        _extraHeaders: Object.keys(extraHeaders).reduce((acc, k) => {
          if (k.toLowerCase() === "authorization") {
            const v = extraHeaders[k] || "";
            acc[k] =
              v.length > 20
                ? v.substring(0, 10) + "...(" + v.length + "B)"
                : "(" + v.length + "B)";
          } else {
            acc[k] = extraHeaders[k];
          }
          return acc;
        }, {}),
        _toolsCount: toolsField ? toolsField.length : 0,
        _toolNames: toolsField ? toolsField.map((t) => t.function.name) : [],
        _sysLen:
          bodyObj.messages &&
          bodyObj.messages[0] &&
          bodyObj.messages[0].role === "system"
            ? (bodyObj.messages[0].content || "").length
            : 0,
        _sysPreview:
          bodyObj.messages &&
          bodyObj.messages[0] &&
          bodyObj.messages[0].role === "system"
            ? (bodyObj.messages[0].content || "").substring(0, 500)
            : "(no system msg)",
        // ★ v9.9.83 · 完整 SP (关键: 确认 tool_calling 区块是否存在)
        _sysFull:
          bodyObj.messages &&
          bodyObj.messages[0] &&
          bodyObj.messages[0].role === "system"
            ? bodyObj.messages[0].content || ""
            : "",
        _msgCount: bodyObj.messages ? bodyObj.messages.length : 0,
        _thinking: !!bodyObj.thinking,
        // ★ v9.9.84 · messages 摘要: 排查 reasoning_content 缺失导致 400
        //   道义: 十六章「万物旁作 吾以观其复也」· 观其所缺方知所修
        _msgSummary: (bodyObj.messages || []).map((m, i) => ({
          idx: i,
          role: m.role,
          hasReasoningContent: "reasoning_content" in m,
          reasoningContentLen: (m.reasoning_content || "").length,
          hasToolCalls: !!(m.tool_calls && m.tool_calls.length),
          toolCallCount: m.tool_calls ? m.tool_calls.length : 0,
          contentLen: typeof m.content === "string" ? m.content.length : -1,
        })),
        // ★ 完整 tools 定义 (关键!)
        _tools: toolsField || [],
      };
      fs.writeFile(dumpPath, JSON.stringify(dumpObj, null, 2), () => {});
    } catch (_de) {
      /* 诊断不阻塞 */
    }

    const isHttps = targetUrl.protocol === "https:";
    const mod = isHttps ? https : http;

    // ★ v9.9.102 · 修法㉑ · 注入代理agent (默认OpenAI协议路径)
    const _proxyAgent2 = _getProxyAgent(isHttps);
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: targetUrl.hostname,
        port: parseInt(targetUrl.port || (isHttps ? "443" : "80")),
        path: targetUrl.pathname + (targetUrl.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          // ★ v10.0 · 修法⑳补 · Accept 根据流/非流动态设置
          Accept: bodyObj.stream ? "text/event-stream" : "application/json",
          ...extraHeaders,
        },
        rejectUnauthorized: false,
        ...(_proxyAgent2 ? { agent: _proxyAgent2 } : {}),
      };
      const req = mod.request(opts, resolve);
      req.on("error", reject);
      req.setTimeout(120000, () => req.destroy(new Error("provider timeout")));
      req.write(body);
      req.end();
    });
  })();
}

/**
 * ★ v9.9.86 · 执行服务端工具 (大制无割版)
 *   当 DeepSeek 调用 trajectory_search 等服务端工具时，代理层执行
 *   道义: 十七章「功述身芮」· 功成而身退 · LSP 不知有之
 *
 *   ★ v9.9.93 · 修法⑧ · 仅处理 _proxyOnlyToolNames 中的工具
 *   trajectory_search/code_search/ask_user_question 等不再被拦截
 *   这些工具直接透传给 LSP → LSP 自己执行 → 与 Go EXE 一致
 *   此函数仅处理 deploy_web_app / read_deployment_config / check_deploy_status / skill
 *   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
 */
function _executeServerTool(name, argsJson) {
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {}

  switch (name) {
    // ★ v9.9.93 · trajectory_search/code_search/ask_user_question 已移除
    //   这些工具现在透传给 LSP → LSP 自己执行 → 不再代理执行
    //   如果仍到达此处 (不应发生) → 返回不可用
    case "trajectory_search":
    case "code_search":
    case "ask_user_question":
    case "create_memory":
    case "search_web":
    case "read_url_content":
    case "view_content_chunk":
    case "read_resource":
    case "edit_notebook":
    case "read_notebook": {
      // ★ v9.9.93 · 兜底: 这些工具不应再被拦截 → 但以防万一仍处理
      _log(
        `[dao-router] ⚠️ _executeServerTool ${name}: 不应到达此处 (LSP有执行器) → 返回不可用`,
      );
      return JSON.stringify({
        error: `${name} should be handled by LSP, not proxy. This indicates a bug in tool classification.`,
        status: "error",
      });
    }
    case "deploy_web_app":
    case "read_deployment_config":
    case "check_deploy_status": {
      _log(
        `[dao-router] _executeServerTool ${name}: not available in proxy mode`,
      );
      return JSON.stringify({
        error: `${name} is not available in proxy mode`,
        status: "unavailable",
      });
    }
    case "skill": {
      _log(
        `[dao-router] _executeServerTool skill: not available in proxy mode`,
      );
      return JSON.stringify({
        error: "skill is not available in proxy mode",
        status: "unavailable",
      });
    }
    default: {
      _log(`[dao-router] _executeServerTool unknown: ${name}`);
      return JSON.stringify({
        error: `Unknown server tool: ${name}`,
        status: "error",
      });
    }
  }
}

/** 读取全部响应体 (用于错误日志) */
function _readAll(agRes) {
  return new Promise((resolve) => {
    let d = "";
    agRes.on("data", (c) => (d += c));
    agRes.on("end", () => resolve(d));
    agRes.on("error", () => resolve(d));
  });
}

/**
 * 非流式 (unary) 响应转 Connect-RPC Cascade 帧
 * DeepSeek streamMode=unary 时返回普通 JSON
 */
async function _unaryOaToCascade(
  agRes,
  res,
  w,
  modelUid,
  lspToolNames,
  toolAliasMap,
  protocol,
) {
  const body = await _readAll(agRes);
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (e) {
    _log("[dao-router] _unaryOaToCascade: JSON parse fail: " + e.message);
    return;
  }

  // ★ v9.9.99 · 协议感知 unary 解析
  //   Anthropic: { type: "message", content: [...], stop_reason, usage }
  //   OpenAI Chat: { choices: [{ message }], usage }
  let msg, finishReason, usageInfo, toolCalls;

  if (protocol === "anthropic" && _adapters) {
    const adapter = _adapters.adapterFor("anthropic");
    const parsed = adapter.parseUnaryResponse(body);
    msg = {
      content: parsed.content || "",
      reasoning_content: parsed.thinking || "",
    };
    finishReason = parsed.finishReason || "stop";
    usageInfo = parsed.usage || null;
    toolCalls = parsed.toolCalls || [];
  } else if (protocol === "openai-responses" && _adapters) {
    const adapter = _adapters.adapterFor("openai-responses");
    const parsed = adapter.parseUnaryResponse(body);
    msg = {
      content: parsed.content || "",
      reasoning_content: parsed.thinking || "",
    };
    finishReason = parsed.finishReason || "stop";
    usageInfo = parsed.usage || null;
    toolCalls = parsed.toolCalls || [];
  } else {
    // OpenAI Chat (原有逻辑)
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    msg = choice.message || {};
    finishReason = choice.finish_reason || "stop";
    usageInfo = obj.usage || null;
    toolCalls = msg.tool_calls || [];
  }

  // ★ v9.9.72 · 生成 output_id / request_id · Windsurf LSP 需要这些字段关联请求
  const _outputId = `dao_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const _requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // actual_model_uid: 告诉 LSP 响应来自哪个模型 (field 23)
  const _actualModelUid = modelUid || "deepseek-chat";

  // ★ v9.9.78 · message_id + timestamp · 官方后端每帧必含
  //   实证: 官方后端每帧 payload 均含 field 1 (message_id) + field 2 (timestamp)
  //   无 message_id → LSP 无法关联帧 → "Encountered unexpected error"
  //   道义: 三十九章「得一」· 得 message_id + timestamp 方能宁
  const _messageId =
    "bot-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  const _tsMs = Date.now();
  const _hdr = () => w.buildFrameHeader(_messageId, _tsMs);

  // ── 帧 1: message_id + timestamp + 文本 + actual_model_uid + output_id + request_id ──
  //   ★ v9.9.78 · 每帧含 message_id + timestamp · 与官方后端一致
  //   道义: 三十九章「得一」· LSP 得此二字段方能归位
  if (typeof msg.content === "string" && msg.content.length > 0) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.DELTA_TEXT, msg.content));
    parts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
    parts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
    parts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  } else {
    // 即使无文本内容, 也发 message_id + timestamp + actual_model_uid 帧
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
    parts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
    parts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  }

  // 思考内容 (DeepSeek R1) · 含 message_id + timestamp
  const think = msg.reasoning_content || msg.thinking || "";
  if (think) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.DELTA_THINKING, think));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  }

  // ★ v9.9.99 · tool_calls · 统一使用 toolCalls 变量 (OpenAI/Anthropic/Responses)
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const mappedCalls = toolCalls.map((tc, i) => {
      const _rawName = tc.function?.name || tc.name || "";
      // ★ v9.9.101 · 太上下知有之 · 不反规范化 · 工具名直接透传
      //   不normalize → 不denormalize · DeepSeek收到什么名就回什么名
      //   官方API: LSP别名透传 · DeepSeek也应透传
      const _lspName = _rawName;
      return {
        id: tc.id || tc.call_id || `tc_${i}`, // ★ v10.0 · 修法⑨ · 工具调用 id 必传
        name: _lspName,
        argumentsJson: tc.function?.arguments || tc.argumentsJson || "{}",
        // ★ v9.9.93 · 修法⑧ · isCustomToolCall: 仅代理执行类工具且 LSP 未发才标记
        //   trajectory_search 等即使 LSP 未发 → isCustomToolCall=false → LSP 正常执行
        //   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
        isCustomToolCall:
          _proxyOnlyToolNames.has(_rawName) &&
          !(lspToolNames && lspToolNames.has(_rawName)),
      };
    });
    if (w.encodeChatToolCall) {
      const inner = Buffer.concat([
        _hdr(), // ★ message_id + timestamp
        ...mappedCalls.map((tc) =>
          w.encodeMessage(w.RSP.DELTA_TOOL_CALLS, w.encodeChatToolCall(tc)),
        ),
      ]);
      const fr = w.buildFrame(0, inner);
      if (fr && fr.length) res.write(fr);
    }
  }

  // ★ v9.9.99 · stop reason · 统一使用 finishReason 变量
  let stopReason = w.STOP_END;
  if (
    finishReason === "tool_calls" ||
    finishReason === "function_call" ||
    finishReason === "tool_use"
  )
    stopReason = w.STOP_TOOL_CALLS;
  else if (finishReason === "length") stopReason = w.STOP_MAX_TOKENS;
  else if (finishReason === "content_filter") stopReason = w.STOP_ERROR; // ★ v10.0 · 修法⑩补 · Go EXE: content_filter → ERROR(13)

  {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeUint(w.RSP.STOP_REASON, stopReason));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  }

  // 结束帧
  if (w.buildEndFrame) {
    const fr = w.buildEndFrame(null);
    if (fr && fr.length) res.write(fr);
  }
  // ★ v9.9.78 · 移除 HTTP/2 trailers · EOS 帧已含 grpc-status:0
  //   v9.9.77 添加 addTrailers 是错误方向 · 与 EOS 帧重复
  //   Connect-RPC 规范: EOS 帧 IS the trailer delivery mechanism
  //   道义: 损之又损以至于无为 · 无为而无以为
  if (!res.writableEnded) res.end();
  _log(
    `[dao-router] unary ✓ text=${Buffer.byteLength(msg.content || "")}B tools=${(msg.tool_calls || []).length} actualModelUid=${_actualModelUid} outputId=${_outputId}`,
  );
}

/**
 * OpenAI SSE 流 → Cascade Connect-RPC wire 帧
 * 支持: text / thinking / tool_calls / stop_reason / end
 */
function _streamOaToCascade(
  agRes,
  res,
  w,
  modelUid,
  lspToolNames,
  toolAliasMap,
  protocol,
) {
  const toolBuf = new Map(); // index → { id, name, argsBuf }
  let buf = "";
  let stopReason = null;
  let textBytes = 0,
    thinkBytes = 0,
    toolCount = 0;
  // ★ v9.9.72a · actual_model_uid + output_id + request_id
  const _outputId = `dao_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const _requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const _actualModelUid = modelUid || "deepseek-chat";
  let _sentMetadata = false; // 只发一次

  // ★ v9.9.78 · message_id + timestamp · 官方后端每帧必含
  //   实证: 官方后端每帧 payload 均含 field 1 (message_id) + field 2 (timestamp)
  //   无 message_id → LSP 无法关联帧 → "Encountered unexpected error"
  //   道义: 三十九章「得一」· 得 message_id + timestamp 方能宁
  const _messageId =
    "bot-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  const _hdr = () => w.buildFrameHeader(_messageId, Date.now());

  // ★ v9.9.87 · 累积器: 保留 thinking/text 内容用于内部重试消息
  //   v9.9.86 帧缓冲导致 LSP 10秒无数据 → 超时断开 (aborted) ❌
  //   正确策略: 直接写入帧 (LSP 需要持续数据流), 保留累积器用于重试
  //   LSP 看到两段 thinking 是正常的: 思考→调用工具→继续思考→回答
  //   道义: 三十七章「道恒无为」· 无为而无不為 · 不缓冲方能流
  let _textAccum = ""; // 累积的文本内容 (用于重试消息)
  let _thinkAccum = ""; // 累积的 thinking 内容 (用于重试消息)

  // ★ v9.9.88 · Token 追踪 (移植自 EXE StreamProcessor)
  //   从 SSE 流中提取 usage 信息 · 诊断日志记录
  //   道义: 十六章「万物旁作 吾以观其复也」· 观其所耗方知所节
  let _tokenCount = { input: 0, output: 0 };

  // ★ v9.9.85 · 服务端工具拦截: 分离 LSP 工具和服务端工具
  //   LSP 工具: LSP 有执行器 → 正常转发
  //   服务端工具: LSP 无执行器 → 拦截 → 代理执行 → 内部重试 → LSP 无感
  //   道义: 十七章「功述身芮」· 功成而身退 · LSP 不知有之
  //   太上不知有之 → 服务端工具调用对 LSP 完全透明
  const _serverSideCalls = []; // 拦截的服务端工具调用
  const _lspSideCalls = []; // 转发给 LSP 的工具调用

  const _flushTools = () => {
    if (toolBuf.size === 0) return;
    const allCalls = [];
    Array.from(toolBuf.keys())
      .sort((a, b) => a - b)
      .forEach((k) => {
        const r = toolBuf.get(k);
        if (r && r.name) {
          allCalls.push({
            id: r.id || `tc_${k}`,
            name: r.name.trim(),
            argumentsJson: r.argsBuf || "{}",
          });
        }
      });
    toolBuf.clear();

    // ★ v10.0 · 修法⑪ · 工具调用规范化 + 验证 + 去重
    //   移植自 Go EXE normalizeToolInvocation + deduplicateToolCalls
    //   道义: 十四章「执古之道以御今之有」· 规范方能御
    const _seen = new Set();
    const _dedupedCalls = [];
    for (const tc of allCalls) {
      // 参数 JSON 验证: 确保是合法 JSON
      let _validArgs = tc.argumentsJson || "{}";
      try {
        JSON.parse(_validArgs);
      } catch {
        _log(`[dao-router] ⚠️ 工具调用参数JSON无效: ${tc.name} → 使用空对象`);
        _validArgs = "{}";
      }
      // 去重: name + args 组合键 (Go EXE: toolName + ':' + JSON.stringify(params))
      const _dedupKey = tc.name + ":" + _validArgs;
      if (_seen.has(_dedupKey)) {
        _log(`[dao-router] ⚠️ 去重工具调用: ${tc.name}`);
        continue;
      }
      _seen.add(_dedupKey);
      _dedupedCalls.push({ ...tc, argumentsJson: _validArgs });
    }

    // ★ v9.9.93 · 修法⑧ · 工具分类: LSP有执行器 → 透传 · 仅代理 → 拦截
    //   旧逻辑: _serverToolNames.has(name) && !lspToolNames.has(name)
    //   问题: trajectory_search 在 _serverToolNames 但 LSP 有执行器 → 被错误拦截
    //   新逻辑: 仅 _proxyOnlyToolNames 中的工具才拦截 → 其余全部透传 LSP
    //   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
    for (const tc of _dedupedCalls) {
      const isProxyOnlyTool =
        _proxyOnlyToolNames.has(tc.name) &&
        !(lspToolNames && lspToolNames.has(tc.name));
      if (isProxyOnlyTool) {
        // 仅代理工具: LSP 无执行器 → 拦截 → 代理执行后内部重试
        _serverSideCalls.push(tc);
        _log(
          `[dao-router] ⚡ 拦截仅代理工具: ${tc.name} args=${(tc.argumentsJson || "").substring(0, 120)}`,
        );
      } else {
        // LSP 工具 (含 LSP 有执行器的补充工具): 正常转发
        // ★ v9.9.101 · 太上下知有之 · 不反规范化 · 工具名直接透传
        //   不normalize → 不denormalize · 官方API透传 · DeepSeek也应透传
        const _lspName = tc.name;
        // ★ v9.9.93 · isCustomToolCall 判定: 仅代理工具且 LSP 未发 → true
        //   trajectory_search 等即使 LSP 未发 → isCustomToolCall=false → LSP 正常执行
        const _isCustom =
          _proxyOnlyToolNames.has(tc.name) &&
          !(lspToolNames && lspToolNames.has(tc.name));
        _lspSideCalls.push({
          ...tc,
          name: _lspName,
          isCustomToolCall: _isCustom,
        });
      }
    }

    // ★ 诊断: 记录所有工具调用名称
    if (_dedupedCalls.length > 0) {
      _routeDiag(
        "_flushTools: total=" +
          _dedupedCalls.length +
          " (raw=" +
          allCalls.length +
          ")" +
          " serverSide=" +
          _serverSideCalls.length +
          " lspSide=" +
          _lspSideCalls.length +
          " names=" +
          _dedupedCalls.map((c) => c.name).join(","),
      );
    }

    // ★ v9.9.87 · LSP 工具调用帧: 有服务端工具时不写入 res (重试后可能变化)
    //   无服务端工具时直接写入 res (正常流程)
    //   有服务端工具时, LSP 工具调用信息保存在 _lspSideCalls → 供重试使用
    //   重试后, 新的 _streamOaToCascade 会写入最终的 LSP 工具调用帧
    //   道义: 三十七章「道恒无为」· 有无相生 · 缓急有序
    if (_lspSideCalls.length > 0 && w.encodeChatToolCall) {
      if (_serverSideCalls.length === 0) {
        // 无服务端工具 → 直接写入 LSP 工具调用帧
        const inner = Buffer.concat([
          _hdr(),
          ..._lspSideCalls.map((tc) =>
            w.encodeMessage(w.RSP.DELTA_TOOL_CALLS, w.encodeChatToolCall(tc)),
          ),
        ]);
        const fr = w.buildFrame(0, inner);
        if (fr && fr.length) {
          res.write(fr);
          toolCount += _lspSideCalls.length;
        }
      }
      // 有服务端工具 → 不写入 LSP 工具调用帧 → 等待重试后的新响应
    }
  };

  // ★ v9.9.99 → v10.0 · 协议感知 SSE 解析 (三协议)
  //   Anthropic: event: xxx\ndata: {json}\n\n → parseSSELine(data, eventType)
  //   OpenAI Chat: data: {json}\n\n → parseSSELine(data)
  //   OpenAI Responses: data: {json}\n\n → parseSSELine(data, eventType)
  //   道义: 二十八章「知其白 守其辱 为天下式」· 知各协议之白 · 守其转换之辱
  const _isAnthropic = protocol === "anthropic";
  const _isResponses = protocol === "openai-responses";
  const _anthAdapter =
    _isAnthropic && _adapters ? _adapters.adapterFor("anthropic") : null;
  const _chatAdapter =
    !_isAnthropic && !_isResponses && _adapters
      ? _adapters.adapterFor("openai-chat")
      : null;
  const _respAdapter =
    _isResponses && _adapters ? _adapters.adapterFor("openai-responses") : null;
  let _sseEventType = ""; // ★ Anthropic/Responses SSE event type 追踪

  return new Promise((resolve, reject) => {
    agRes.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // ★ v9.9.99 → v10.0 · Anthropic/Responses SSE: 追踪 event type
        if ((_isAnthropic || _isResponses) && line.startsWith("event:")) {
          _sseEventType = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;

        // ★ v9.9.99 → v10.0 · 协议分发: Anthropic / OpenAI Responses / OpenAI Chat
        let delta, finishReason, usageInfo;

        if (_isAnthropic && _anthAdapter) {
          // ── Anthropic SSE 解析 ──
          const parsed = _anthAdapter.parseSSELine(d, _sseEventType);
          if (!parsed || parsed.type === "skip") continue;
          // ★ v10.0 · 修法⑯ · message_stop → done → 显式跳过
          //   finishReason 已由 message_delta 设置 · done 仅标记流结束
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;

          // Anthropic tool calls
          if (parsed.toolCallStart) {
            const tc = parsed.toolCallStart;
            if (!toolBuf.has(tc.index))
              toolBuf.set(tc.index, { id: tc.id, name: tc.name, argsBuf: "" });
          }
          if (parsed.toolCallDelta) {
            const td = parsed.toolCallDelta;
            const existing = toolBuf.get(td.index);
            if (existing) existing.argsBuf += td.partialJson || "";
          }
          if (parsed.toolCalls) {
            for (const tc of parsed.toolCalls) {
              const idx = toolBuf.size;
              toolBuf.set(idx, {
                id: tc.id,
                name: tc.function.name,
                argsBuf: tc.function.arguments || "{}",
              });
            }
          }
          // ★ v10.0 · content_block_stop → toolCallBlockDone
          //   Go EXE 在此事件时立即 emitToolCall → 我们等价调用 _flushTools
          //   道义: 九章「持而盈之不如其已」· 已则成 · 成则通
          if (parsed.toolCallBlockDone) {
            _flushTools();
          }
        } else if (_isResponses && _respAdapter) {
          // ── OpenAI Responses SSE 解析 ──
          //   道义: 四十一章「大方无隅 大器晚成」· 新格式无隅 · 晚成方通
          const parsed = _respAdapter.parseSSELine(d, _sseEventType);
          if (!parsed || parsed.type === "skip") continue;
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;

          // Responses API tool calls
          if (parsed.toolCallStart) {
            const tc = parsed.toolCallStart;
            if (!toolBuf.has(tc.index))
              toolBuf.set(tc.index, { id: tc.id, name: tc.name, argsBuf: "" });
          }
          if (parsed.toolCallDelta) {
            const td = parsed.toolCallDelta;
            const existing = toolBuf.get(td.index);
            if (existing) {
              existing.argsBuf += td.partialJson || "";
              // ★ v10.0 · 修法⑬ · callId 补填 (toolCallStart 可能无 id)
              if (td.callId && !existing.id) existing.id = td.callId;
            }
          }
          if (parsed.toolCallComplete) {
            // ★ Responses API 的 response.output_item.done 提供完整工具调用
            //   直接覆盖缓冲区中的记录 (确保参数完整)
            const tcc = parsed.toolCallComplete;
            const existing = toolBuf.get(tcc.index);
            if (existing) {
              if (tcc.id) existing.id = tcc.id;
              if (tcc.name) existing.name = tcc.name;
              if (tcc.arguments) existing.argsBuf = tcc.arguments;
            } else {
              toolBuf.set(tcc.index, {
                id: tcc.id || `tc_${tcc.index}`,
                name: tcc.name,
                argsBuf: tcc.arguments || "{}",
              });
            }
          }
        } else if (_chatAdapter) {
          // ── OpenAI Chat SSE 解析 (统一走 adapter) ──
          //   道义: 二十八章「知其白守其辱为天下式」· 三协议同一式
          const parsed = _chatAdapter.parseSSELine(d);
          if (!parsed || parsed.type === "skip") continue;
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;

          // OpenAI Chat tool calls (增量式)
          if (Array.isArray(parsed.toolCalls)) {
            for (const tc of parsed.toolCalls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              let rec = toolBuf.get(idx);
              if (!rec) {
                rec = { id: "", name: "", argsBuf: "" };
                toolBuf.set(idx, rec);
              }
              if (tc.id) rec.id = tc.id;
              if (tc.function && tc.function.name) rec.name = tc.function.name;
              if (tc.function && typeof tc.function.arguments === "string")
                rec.argsBuf += tc.function.arguments;
            }
          }
        } else {
          // ── 兜底: 无 adapter 可用时手工解析 ──
          let obj;
          try {
            obj = JSON.parse(d);
          } catch {
            continue;
          }
          const choice = obj.choices && obj.choices[0];
          if (!choice) continue;
          delta = choice.delta || {};
          finishReason = choice.finish_reason || null;
          usageInfo = obj.usage || null;
        }

        // ★ v9.9.79 · 首帧必发 metadata (message_id + timestamp + actual_model_uid + output_id + request_id)
        //   旧 v9.9.78 仅在首个文本时发 → 若模型先返回 tool_calls (无文本) → metadata 永远不发
        //   → LSP 缺 output_id/request_id → 工具调用关联失败
        //   道义: 三十九章「侯王得一以为天下正」· 得元数据方能正位
        if (!_sentMetadata) {
          _sentMetadata = true;
          const metaParts = [];
          metaParts.push(_hdr()); // ★ message_id + timestamp
          metaParts.push(
            w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid),
          );
          metaParts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
          metaParts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
          const metaFr = w.buildFrame(0, Buffer.concat(metaParts));
          if (metaFr && metaFr.length) res.write(metaFr);
        }

        // 文本增量 · 含 message_id + timestamp
        if (typeof delta.content === "string" && delta.content.length > 0) {
          // ★ v9.9.87 · 文本帧直接写入 res + 累积文本
          const parts = [];
          parts.push(_hdr()); // ★ message_id + timestamp
          parts.push(w.encodeString(w.RSP.DELTA_TEXT, delta.content));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length) {
            res.write(fr);
            textBytes += Buffer.byteLength(delta.content);
            _textAccum += delta.content; // ★ 累积文本用于重试
          }
        }

        // 思考增量 · 含 message_id + timestamp
        const think =
          (typeof delta.reasoning_content === "string" &&
            delta.reasoning_content) ||
          (typeof delta.thinking === "string" && delta.thinking) ||
          (typeof delta.reasoning === "string" && delta.reasoning) ||
          "";
        if (think) {
          // ★ v9.9.87 · thinking 帧直接写入 res + 累积 thinking
          const parts = [];
          parts.push(_hdr()); // ★ message_id + timestamp
          parts.push(w.encodeString(w.RSP.DELTA_THINKING, think));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length) {
            res.write(fr);
            thinkBytes += Buffer.byteLength(think);
            _thinkAccum += think; // ★ 累积 thinking 用于重试
          }
        }

        // 工具调用 (累进)
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let rec = toolBuf.get(idx);
            if (!rec) {
              rec = { id: "", name: "", argsBuf: "" };
              toolBuf.set(idx, rec);
            }
            if (tc.id) rec.id = tc.id;
            if (tc.function && tc.function.name) rec.name = tc.function.name;
            if (tc.function && typeof tc.function.arguments === "string")
              rec.argsBuf += tc.function.arguments;
          }
        }

        // ★ v9.9.99 · 结束信号 (统一: finishReason 变量)
        //   OpenAI Chat: choice.finish_reason → finishReason
        //   Anthropic: parsed.finishReason → finishReason
        if (finishReason) {
          _flushTools();
          const fr = finishReason;
          if (
            fr === "tool_calls" ||
            fr === "function_call" ||
            fr === "tool_use"
          )
            stopReason = w.STOP_TOOL_CALLS;
          else if (fr === "length") stopReason = w.STOP_MAX_TOKENS;
          else if (fr === "content_filter")
            stopReason = w.STOP_ERROR; // ★ v10.0 · 修法⑩ · Go EXE: content_filter → ERROR(13)
          else stopReason = w.STOP_END;
        }

        // ★ v9.9.88 · Token 追踪: 从 SSE usage 字段提取 token 计数
        //   v9.9.99 · 统一使用 usageInfo (OpenAI + Anthropic 均适用)
        //   道义: 十六章「万物旁作 吾以观其复也」· 观其所耗方知所节
        if (usageInfo) {
          _tokenCount.input =
            usageInfo.input || usageInfo.prompt_tokens || _tokenCount.input;
          _tokenCount.output =
            usageInfo.output ||
            usageInfo.completion_tokens ||
            _tokenCount.output;
        }
      }
    });

    agRes.on("end", () => {
      // 兜底: 未发 finish_reason 时冲工具
      _flushTools();

      // ★ v9.9.99 · 弹性自动继续 (移植自 Go resilience.shouldAutoContinue)
      //   道义: 三十七章「道恒无为」· 不绝则通 · 自动续流
      //   finishReason=length → 输出被截断 → 可自动追加 "继续" 重发
      //   当前: 仅记录日志 · 实际自动继续由 _tryRoute 的重试逻辑处理
      if (_resilience && stopReason === w.STOP_MAX_TOKENS) {
        const shouldContinue = _resilience.shouldAutoContinue("length", 0, 3);
        if (shouldContinue) {
          _log(
            "[dao-router] ★ resilience: finishReason=length → 可自动继续 (累积text可重发)",
          );
          _routeDiag(
            "_streamOaToCascade resilience: auto-continue candidate (length)",
          );
        }
      }

      // ★ v9.9.99 · 拒绝匹配检测 (移植自 Go resilience.matchesRefusal)
      //   道义: 三十六章「将欲弱之 必固强之」· 知其拒方知其通
      if (_resilience && _textAccum.length > 0) {
        if (_resilience.matchesRefusal(_textAccum)) {
          _log("[dao-router] ★ resilience: 检测到拒绝响应 → 可降级重试");
          _routeDiag("_streamOaToCascade resilience: refusal detected");
        }
      }

      // ★ v9.9.87 · 有服务端工具时: 不关闭流 → 等待内部重试
      //   v9.9.86 帧缓冲导致 LSP 超时断开 ❌
      //   v9.9.87 恢复直接写入 → LSP 已看到 thinking 帧 → 连接活跃
      //   重试后的新 thinking/text 也直接写入 → LSP 看到连续流 ✅
      //   道义: 三十七章「道恒无为」· 流不闭方能续 · 闭则割裂
      if (_serverSideCalls.length > 0) {
        // 有服务端工具 → 不发送 stop_reason/EOS/end → 等待 _tryRoute 重试
        _log(
          `[dao-router] stream ▶ text=${textBytes}B think=${thinkBytes}B tools=${toolCount} stopReason=${stopReason} serverSideIntercepted=${_serverSideCalls.length} → stream held open for retry`,
        );
        _routeDiag(
          "_streamOaToCascade end (held): text=" +
            textBytes +
            "B think=" +
            thinkBytes +
            "B tools=" +
            toolCount +
            " stopReason=" +
            stopReason +
            " serverSideIntercepted=" +
            _serverSideCalls.length +
            " model=" +
            _actualModelUid,
        );
        // ★ resolve 但不关闭流 → _tryRoute 会继续写入
        resolve({
          serverSideCalls: _serverSideCalls,
          lspSideCalls: _lspSideCalls, // ★ v9.9.87 · 返回 LSP 工具调用
          textBytes,
          thinkBytes,
          toolCount,
          stopReason,
          streamFinalized: false, // ★ 标记: 流未关闭
          textAccum: _textAccum, // ★ 累积文本 (用于重试消息)
          thinkAccum: _thinkAccum, // ★ 累积 thinking (用于重试消息)
          tokenCount: _tokenCount, // ★ v9.9.88 · Token 追踪
        });
        return; // ★ 不执行下面的 finalize 逻辑
      }

      // ★ 无服务端工具 → 正常关闭流
      // ★ v9.9.78 · stop_reason 帧含 message_id + timestamp
      if (stopReason !== null) {
        const parts = [];
        parts.push(_hdr()); // ★ message_id + timestamp
        parts.push(w.encodeUint(w.RSP.STOP_REASON, stopReason));
        const fr = w.buildFrame(0, Buffer.concat(parts));
        if (fr && fr.length) res.write(fr);
      }
      if (w.buildEndFrame) {
        const fr = w.buildEndFrame(null);
        if (fr && fr.length) res.write(fr);
      }
      if (!res.writableEnded) res.end();
      _log(
        `[dao-router] stream ✓ text=${textBytes}B think=${thinkBytes}B tools=${toolCount} stopReason=${stopReason} tokens=${_tokenCount.input}+${_tokenCount.output} serverSideIntercepted=0`,
      );
      _routeDiag(
        "_streamOaToCascade end: text=" +
          textBytes +
          "B think=" +
          thinkBytes +
          "B tools=" +
          toolCount +
          " stopReason=" +
          stopReason +
          " serverSideIntercepted=" +
          _serverSideCalls.length +
          " model=" +
          _actualModelUid,
      );
      // ★ v9.9.85b · 返回拦截信息 → _tryRoute 可据此做内部重试
      resolve({
        serverSideCalls: _serverSideCalls,
        textBytes,
        thinkBytes,
        toolCount,
        stopReason,
        tokenCount: _tokenCount, // ★ v9.9.88 · Token 追踪
      });
    });

    agRes.on("error", (e) => {
      _flushTools();
      if (w.buildEndFrame) {
        try {
          res.write(w.buildEndFrame(`道路由上游错误: ${e.message}`));
        } catch {}
      }
      // ★ v9.9.78 · 移除 HTTP/2 trailers · EOS 帧已含 grpc-status:13
      //   道义: 损之又损以至于无为 · 无为而无以为
      if (!res.writableEnded) res.end();
      reject(e);
    });
  });
}

/**
 * 获取 substitute 模式的目标 UID (provider="substitute")
 * @returns {string|null} 目标 Cascade model UID，null=不是substitute模式
 */
function getSubstitution(modelUid) {
  const t = _routes[_normalizeModelUid(modelUid)];
  if (!t || t.provider !== "substitute") return null;
  return t.model || null;
}

/**
 * patchModelUid — 替换 ConnectRPC 帧里 protobuf field 21 (chat_model_uid)
 *
 * 帧格式: [1B flags][4B BE length][protobuf body]
 * field 21, wire type 2: tag=[0xAA, 0x01], length varint, UTF-8 bytes
 *
 * @param {Buffer}  rawBody - ConnectRPC 原始帧 (可能含多帧)
 * @param {boolean} isJSON  - true=JSON格式(非protobuf) → 直接字符串替换
 * @param {string}  oldUid  - 原 modelUid
 * @param {string}  newUid  - 目标 modelUid
 * @returns {Buffer|null} 修改后的 Buffer，失败返回 null
 */
function patchModelUid(rawBody, isJSON, oldUid, newUid) {
  if (!rawBody || !rawBody.length) return null;
  const normalizedOld = _normalizeModelUid(oldUid);
  if (normalizedOld === newUid) return rawBody;

  try {
    if (isJSON) {
      // JSON 格式：直接字符串替换 modelUid 字段
      const s = rawBody.toString("utf8");
      // 精确匹配 "modelUid":"OLD" 或 "model_uid":"OLD"
      const patched = s
        .replace(
          new RegExp(`"modelUid"\\s*:\\s*"${_escRe(oldUid)}"`, "g"),
          `"modelUid":"${newUid}"`,
        )
        .replace(
          new RegExp(`"model_uid"\\s*:\\s*"${_escRe(oldUid)}"`, "g"),
          `"model_uid":"${newUid}"`,
        );
      if (patched === s) return null; // 未找到
      // 更新帧长度（5字节头）
      const newPb = Buffer.from(patched, "utf8");
      const hdr = Buffer.alloc(5);
      hdr[0] = rawBody[0];
      hdr.writeUInt32BE(newPb.length - 5, 1);
      return newPb;
    }

    // Binary protobuf 格式
    // ConnectRPC frame: [1B flags][4B length][protobuf]
    if (rawBody.length < 5) return null;
    const flags = rawBody[0];
    const pbLen = rawBody.readUInt32BE(1);
    if (rawBody.length < 5 + pbLen) return null;
    const rawPb = rawBody.slice(5, 5 + pbLen);

    // flags=1 表示 gzip 压缩，需要解压
    let pb = rawPb;
    let isCompressed = false;
    if (flags === 1) {
      try {
        pb = zlib.gunzipSync(rawPb);
        isCompressed = true;
      } catch {
        return null;
      }
    }

    const oldBytes = Buffer.from(oldUid, "utf8");
    const newBytes = Buffer.from(newUid, "utf8");

    // ── 策略一: 标准 field 21 tag [0xAA, 0x01] 扫描 ─────────────
    // field 21, wire type 2: tag = (21<<3|2) = 170 = [0xAA, 0x01]
    const TAG1 = 0xaa,
      TAG2 = 0x01;
    let pos = 0;
    while (pos < pb.length - 1) {
      if (pb[pos] !== TAG1 || pb[pos + 1] !== TAG2) {
        pos++;
        continue;
      }
      let len = 0,
        shift = 0,
        i = pos + 2;
      while (i < pb.length) {
        const b = pb[i++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (
        i + len <= pb.length &&
        pb.slice(i, i + len).toString("utf8") === oldUid
      ) {
        const lenVarNew = _encodeVarint(newBytes.length);
        const newPb = Buffer.concat([
          pb.slice(0, pos),
          Buffer.from([TAG1, TAG2]),
          lenVarNew,
          newBytes,
          pb.slice(i + len),
        ]);
        return _repackFrame(newPb, isCompressed, flags, rawBody, 5 + pbLen);
      }
      pos++;
    }

    // ── 策略二: 原始字节串搜索 (处理不同的 tag 编码格式) ──────────
    // 找 length_varint + oldUid_bytes，不强求具体 tag
    const lenVar = _encodeVarint(oldBytes.length);
    const pattern = Buffer.concat([lenVar, oldBytes]);
    let idx = pb.indexOf(pattern);
    while (idx >= 0) {
      // 验证这个位置之前有 protobuf tag 字节 (至少1字节)
      if (idx >= 1) {
        const lenVarNew = _encodeVarint(newBytes.length);
        const replacement = Buffer.concat([lenVarNew, newBytes]);
        const newPb = Buffer.concat([
          pb.slice(0, idx),
          replacement,
          pb.slice(idx + pattern.length),
        ]);
        return _repackFrame(newPb, isCompressed, flags, rawBody, 5 + pbLen);
      }
      idx = pb.indexOf(pattern, idx + 1);
    }
    return null; // 未找到 field 21
  } catch {
    return null;
  }
}

/**
 * 重新打包 ConnectRPC 帧：如果原帧是压缩的，重新 gzip 压缩
 * @param {Buffer}  newPb       - patch 后的 (解压) protobuf bytes
 * @param {boolean} isCompressed - 原帧是否压缩
 * @param {number}  flags       - 原 flags 字节
 * @param {Buffer}  rawBody     - 原始完整 body
 * @param {number}  tailStart   - 后续帧起始位置 (5 + pbLen)
 */
function _repackFrame(newPb, isCompressed, flags, rawBody, tailStart) {
  let payload = newPb;
  if (isCompressed) {
    try {
      payload = zlib.gzipSync(newPb);
    } catch {
      return null;
    }
  }
  const newHdr = Buffer.alloc(5);
  newHdr[0] = flags; // 保持原 flags (压缩位)
  newHdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([newHdr, payload, rawBody.slice(tailStart)]);
}

function _escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function _encodeVarint(n) {
  const parts = [];
  while (n >= 128) {
    parts.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  parts.push(n & 0x7f);
  return Buffer.from(parts);
}

/** 清空健康缓存 · 供热重载时强制重新探测 */
function resetHealthCache() {
  for (const k of Object.keys(_healthCache)) {
    delete _healthCache[k];
  }
  _log("[dao-router] 健康缓存已清空");
}

/** 主动探测所有provider健康 · 热重载后立即执行 */
async function probeAllProviders() {
  const results = {};
  for (const [name, cfg] of Object.entries(_providers)) {
    if (!cfg.healthCheck) {
      results[name] = { alive: null, reason: "no healthCheck" };
      continue;
    }
    let hcUrl = cfg.healthCheck;
    if (hcUrl.startsWith("/")) {
      const base = cfg.baseUrl || _gatewayUrl;
      try {
        const baseU = new URL(base);
        hcUrl = `${baseU.protocol}//${baseU.hostname}:${baseU.port || (baseU.protocol === "https:" ? "443" : "80")}${hcUrl}`;
      } catch {
        hcUrl = `http://127.0.0.1:7788${hcUrl}`;
      }
    }
    const alive = await _checkHealth(name, hcUrl);
    results[name] = { alive, url: hcUrl };
    _log(`[dao-router] probe ${name}: ${alive ? "ALIVE" : "DEAD"} · ${hcUrl}`);
  }
  return results;
}

// ════════════════════════════════════════════════════════════════
// §3  热配置 API · 道法自然 · 无为而无不为
//   五十七章「我无为也 而民自化」· 热操作 · 不重启 · 即时生效
//   供 webview 前端 + Agent 后端 + /origin/ea/* 控制面使用
// ════════════════════════════════════════════════════════════════

/**
 * 热添加/更新 provider
 * @param {string} name - provider 名称
 * @param {object} cfg  - provider 配置 {type, baseUrl, apiKey, enabled, ...}
 * @returns {{ok: boolean, error?: string}}
 */
function hotAddProvider(name, cfg) {
  if (!name || typeof name !== "string")
    return { ok: false, error: "name required" };
  if (!cfg || typeof cfg !== "object")
    return { ok: false, error: "cfg required" };
  // ★ 自动检测 type: 根据 baseUrl 推断
  if (!cfg.type) {
    const url = (cfg.baseUrl || "").toLowerCase();
    if (url.includes("anthropic") || url.includes("claude"))
      cfg.type = "anthropic";
    else if (url.includes("openai")) cfg.type = "openai-compatible";
    else if (url.includes("bedrock") || url.includes("amazonaws"))
      cfg.type = "bedrock";
    else cfg.type = "openai-compatible"; // 默认
  }
  // ★ 自动推断 completionPath
  if (!cfg.completionPath) {
    if (cfg.type === "anthropic") cfg.completionPath = "/v1/messages";
    else cfg.completionPath = "/v1/chat/completions";
  }
  // ★ 默认 streamMode
  if (!cfg.streamMode) cfg.streamMode = "stream";
  // ★ 默认启用
  if (cfg.enabled === undefined) cfg.enabled = true;

  // ★ v9.9.92-fix · 合并而非替换 · 防止脱敏 apiKey 覆盖真实 key
  //   道义: 三十九章「得一以宁」· 得 apiKey 之全方能宁
  //   根因: GET /providers 返回脱敏 apiKey(ghp_xxx***)
  //         POST /provider 传入脱敏 cfg → _providers[name]=cfg 覆盖真实 key
  //         → _callProvider 发脱敏 key → 401 Bad credentials
  //   修正: 合并现有 cfg → 跳过脱敏 apiKey → 保留真实 key
  const existing = _providers[name] || {};
  const merged = { ...existing, ...cfg };
  // ★ 若传入的 apiKey 是脱敏的(含***) → 保留原有的真实 apiKey
  if (cfg.apiKey && /\*{2,}/.test(cfg.apiKey) && existing.apiKey) {
    merged.apiKey = existing.apiKey;
    _log(
      `[dao-router] [热] provider ${name}: 脱敏apiKey → 保留原key (${existing.apiKey.length}B)`,
    );
  }
  _providers[name] = merged;
  _log(
    `[dao-router] [热] 添加provider: ${name} type=${cfg.type} url=${cfg.baseUrl || "?"}`,
  );

  // ★ v9.9.262 · 首个 provider 自动默认路由 · 道法自然 · 无为而无不为
  //   用户首次添加第三方 provider 时 · 若 SWE 1.6 Fast 尚未路由 ·
  //   则自动把 MODEL_SWE_1_6_FAST 路由到该 provider 的第一个模型 (仅一个)。
  //   其余模型仍走官方 Cascade · 已存在路由则不覆盖 (尊重用户手动配置)。
  let autoRoute = null;
  const _hasSweFast =
    !!_routes["MODEL_SWE_1_6_FAST"] || !!_routes["swe-1-6-fast"];
  if (!_hasSweFast && merged.enabled !== false) {
    const m =
      merged.defaultModel ||
      (Array.isArray(merged.models) && merged.models.length
        ? merged.models[0]
        : null);
    if (m) {
      const rc = {
        provider: name,
        model: m,
        _label: `SWE 1.6 Fast → ${name}/${m} (默认)`,
        maxOutputTokens: 32768,
        _autoDefault: true,
      };
      _routes["MODEL_SWE_1_6_FAST"] = rc;
      _routes["swe-1-6-fast"] = rc;
      _ready = true;
      autoRoute = `${name}/${m}`;
      _log(
        `[dao-router] [热] 首provider自动默认路由: MODEL_SWE_1_6_FAST → ${name}/${m}`,
      );
    }
  }

  // ★ 持久化到配置.json
  _hotSaveConfig();
  return { ok: true, autoRoute };
}

/**
 * 热删除 provider
 * @param {string} name - provider 名称
 * @returns {{ok: boolean, error?: string}}
 */
function hotRemoveProvider(name) {
  if (!_providers[name]) return { ok: false, error: "provider not found" };
  // 检查是否有路由引用此 provider
  const refs = Object.entries(_routes).filter(([, t]) => t.provider === name);
  if (refs.length > 0) {
    // 自动移除引用此 provider 的路由
    for (const [uid] of refs) {
      delete _routes[uid];
      _log(`[dao-router] [热] 自动移除路由: ${uid} (provider=${name} 被删)`);
    }
  }
  delete _providers[name];
  delete _healthCache[name];
  _log(
    `[dao-router] [热] 删除provider: ${name} · 关联路由${refs.length}条已移除`,
  );
  _hotSaveConfig();
  _ready = Object.keys(_routes).length > 0;
  return { ok: true, removedRoutes: refs.length };
}

/**
 * 热添加/更新路由
 * @param {string} modelUid - 官方模型 UID (如 MODEL_SWE_1_6_FAST)
 * @param {object} routeCfg  - 路由配置 {provider, model, _label, maxOutputTokens, fallback, ...}
 * @returns {{ok: boolean, error?: string}}
 */
function hotAddRoute(modelUid, routeCfg) {
  if (!modelUid || typeof modelUid !== "string")
    return { ok: false, error: "modelUid required" };
  if (!routeCfg || typeof routeCfg !== "object")
    return { ok: false, error: "routeCfg required" };
  if (!routeCfg.provider)
    return { ok: false, error: "routeCfg.provider required" };
  if (!routeCfg.model) return { ok: false, error: "routeCfg.model required" };
  // 检查 provider 是否存在
  if (routeCfg.provider !== "builtin-stub" && !_providers[routeCfg.provider]) {
    return { ok: false, error: `provider "${routeCfg.provider}" not found` };
  }
  if (!routeCfg.maxOutputTokens) routeCfg.maxOutputTokens = 16384;

  _routes[modelUid] = routeCfg;
  // ★ 同时注册规范化形式
  if (!modelUid.startsWith("_") && !modelUid.startsWith("MODEL_")) {
    const modelKey = "MODEL_" + modelUid.replace(/-/g, "_").toUpperCase();
    if (!_routes[modelKey]) _routes[modelKey] = routeCfg;
  }
  if (modelUid.startsWith("MODEL_")) {
    const lowerKey = modelUid
      .replace(/^MODEL_/, "")
      .replace(/_/g, "-")
      .toLowerCase();
    if (!_routes[lowerKey]) _routes[lowerKey] = routeCfg;
  }

  _ready = true; // 有路由即就绪
  _log(
    `[dao-router] [热] 添加路由: ${modelUid} → ${routeCfg.provider}/${routeCfg.model}` +
      (routeCfg.fallback
        ? ` [备:${routeCfg.fallback.provider}/${routeCfg.fallback.model}]`
        : ""),
  );
  _hotSaveConfig();
  return { ok: true };
}

/**
 * 热删除路由
 * @param {string} modelUid - 官方模型 UID
 * @returns {{ok: boolean, error?: string}}
 */
function hotRemoveRoute(modelUid) {
  if (!_routes[modelUid]) return { ok: false, error: "route not found" };
  delete _routes[modelUid];
  // 同时清理规范化形式
  if (!modelUid.startsWith("_") && !modelUid.startsWith("MODEL_")) {
    const modelKey = "MODEL_" + modelUid.replace(/-/g, "_").toUpperCase();
    delete _routes[modelKey];
  }
  if (modelUid.startsWith("MODEL_")) {
    const lowerKey = modelUid
      .replace(/^MODEL_/, "")
      .replace(/_/g, "-")
      .toLowerCase();
    delete _routes[lowerKey];
  }
  _ready = Object.keys(_routes).length > 0;
  _log(`[dao-router] [热] 删除路由: ${modelUid}`);
  _hotSaveConfig();
  return { ok: true };
}

/**
 * 获取完整配置 (供热配置API/Agent使用)
 * @returns {object}
 */
function hotGetConfig() {
  return {
    gateway: _cfg ? _cfg.gateway : { host: "127.0.0.1", port: 11435 },
    providers: { ..._providers },
    daoRoutes: {
      enabled: _cfg ? _cfg.daoRoutes && _cfg.daoRoutes.enabled : true,
      substituteEnabled: _substituteEnabled,
      allowMcpTools: _allowMcpTools,
      routes: { ..._routes },
    },
    // ★ 运行时状态 · 与配置数据分离 · 名实相符
    _runtime: {
      ready: _ready,
      providerCount: Object.keys(_providers).length,
      routeCount: Object.keys(_routes).length,
      stats: { ..._stats },
    },
    // ★ v9.9.99 · Go 移植模块状态 · AI 热配置接口
    //   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
    _modules: {
      budget: _budget ? _budget.getBudgetStatus() : null,
      adapters: _adapters
        ? {
            protocols: _adapters.getSupportedProtocols(),
            modelInfoCache: _adapters.getModelInfoCache().size,
          }
        : null,
      resilience: _resilience ? _resilience.getDefaultConfig() : null,
    },
  };
}

/**
 * 批量设置配置 (供热配置API/Agent使用)
 * @param {object} newCfg - 完整或部分配置
 * @returns {{ok: boolean, error?: string}}
 */
function hotSetConfig(newCfg) {
  if (!newCfg || typeof newCfg !== "object")
    return { ok: false, error: "newCfg required" };
  try {
    if (newCfg.providers) {
      for (const [name, cfg] of Object.entries(newCfg.providers)) {
        if (name.startsWith("_")) continue;
        _providers[name] = cfg;
      }
    }
    if (newCfg.daoRoutes) {
      const dr = newCfg.daoRoutes;
      if (dr.enabled !== undefined) {
        // ★ v9.9.90-fix · 更新全局 daoRoutes.enabled 到 _cfg
        if (_cfg && _cfg.daoRoutes)
          _cfg.daoRoutes.enabled = dr.enabled === true;
      }
      if (dr.substituteEnabled !== undefined)
        _substituteEnabled = dr.substituteEnabled === true;
      if (dr.allowMcpTools !== undefined)
        _allowMcpTools = dr.allowMcpTools !== false;
      if (dr.routes) {
        for (const [uid, t] of Object.entries(dr.routes)) {
          if (uid.startsWith("_") || typeof t !== "object" || !t.provider)
            continue;
          _routes[uid] = t;
        }
      }
    }
    _ready = Object.keys(_routes).length > 0;
    _log(
      `[dao-router] [热] 批量设置配置: providers=${Object.keys(_providers).length} routes=${Object.keys(_routes).length}`,
    );
    _hotSaveConfig();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 热重载: 从配置.json重新加载
 * @returns {{ok: boolean, count?: number, error?: string}}
 */
function hotReload() {
  try {
    const configPath = _cfg ? _cfg._configPath : null;
    if (!configPath) return { ok: false, error: "no configPath" };
    const result = init({ log: _log, configPath });
    return result.ready
      ? { ok: true, count: result.count }
      : { ok: false, error: result.error || result.reason };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 内部: 持久化当前配置到 配置.json
 *   道义: 二十五章「道法自然」· 变化即持久 · 持久即自然
 */
function _hotSaveConfig() {
  try {
    if (!_cfg) return;
    const configPath = _cfg._configPath;
    if (!configPath) return;
    // 更新 _cfg 对象
    _cfg.providers = { ..._providers };
    if (!_cfg.daoRoutes) _cfg.daoRoutes = {};
    _cfg.daoRoutes.routes = { ..._routes };
    _cfg.daoRoutes.substituteEnabled = _substituteEnabled;
    _cfg.daoRoutes.allowMcpTools = _allowMcpTools;
    // ★ 过滤内部字段 (以_开头) · 不污染配置.json · 名实相符
    const clean = {};
    for (const [k, v] of Object.entries(_cfg)) {
      if (!k.startsWith("_")) clean[k] = v;
    }
    // ★ 异步写入 · 不阻塞路由请求
    const data = JSON.stringify(clean, null, 2);
    fs.writeFile(configPath, data, "utf8", (err) => {
      if (err) _log(`[dao-router] _hotSaveConfig fail: ${err.message}`);
      else
        _log(`[dao-router] _hotSaveConfig ok: ${configPath} ${data.length}B`);
    });
  } catch (e) {
    _log(`[dao-router] _hotSaveConfig exception: ${e.message}`);
  }
}

/**
 * 获取 provider 可用模型列表 (从 provider 配置的 models 字段 + /v1/models 探测)
 * @param {string} providerName - provider 名称
 * @returns {Promise<{ok: boolean, models?: string[], error?: string}>}
 */
async function hotListProviderModels(providerName) {
  const provCfg = _providers[providerName];
  if (!provCfg) return { ok: false, error: "provider not found" };

  // 1. 从配置的 models 字段直接返回
  if (Array.isArray(provCfg.models) && provCfg.models.length > 0) {
    return { ok: true, models: provCfg.models, source: "config" };
  }

  // 2. 尝试 /v1/models 探测
  try {
    const baseUrl = provCfg.baseUrl || _gatewayUrl;
    const modelsUrl = new URL(baseUrl.replace(/\/$/, "") + "/v1/models");
    const isHttps = modelsUrl.protocol === "https:";
    const mod = isHttps ? https : http;
    const headers = {};
    if (provCfg.apiKey) headers["Authorization"] = `Bearer ${provCfg.apiKey}`;

    const body = await new Promise((resolve, reject) => {
      const req = mod.request(
        {
          hostname: modelsUrl.hostname,
          port: parseInt(modelsUrl.port || (isHttps ? "443" : "80")),
          path: modelsUrl.pathname,
          method: "GET",
          headers,
          timeout: 5000,
          rejectUnauthorized: false,
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve(d));
          res.on("error", () => resolve(""));
        },
      );
      req.on("error", () => resolve(""));
      req.on("timeout", () => {
        req.destroy();
        resolve("");
      });
      req.end();
    });

    if (body) {
      const parsed = JSON.parse(body);
      if (parsed.data && Array.isArray(parsed.data)) {
        const models = parsed.data.map((m) => m.id).filter(Boolean);
        if (models.length > 0) {
          // 缓存到 provider 配置
          provCfg.models = models;
          return { ok: true, models, source: "probe" };
        }
      }
    }
  } catch {}

  return { ok: true, models: [], source: "empty" };
}

// ★ v9.9.97 · 热切换兼容别名 · source.js调用hotDeleteRoute
function hotDeleteRoute(modelUid) {
  return hotRemoveRoute(modelUid);
}

/**
 * ★ v9.9.97 · 解锁保护模型 · 用户显式允许路由
 * @param {string} modelUid
 * @param {boolean} unlock
 * @returns {{ok: boolean, unlocked: boolean, protected: boolean}}
 */
function unlockModel(modelUid, unlock) {
  if (!modelUid || typeof modelUid !== "string")
    return { ok: false, error: "modelUid required" };
  if (unlock) {
    _unlockedModels.add(modelUid);
    // 同时添加规范化形式
    const normalized = _normalizeModelUid(modelUid);
    if (normalized !== modelUid) _unlockedModels.add(normalized);
    _log(`[dao-router] [unlock] ${modelUid} → UNLOCKED`);
  } else {
    _unlockedModels.delete(modelUid);
    const normalized = _normalizeModelUid(modelUid);
    if (normalized !== modelUid) _unlockedModels.delete(normalized);
    _log(`[dao-router] [unlock] ${modelUid} → LOCKED`);
  }
  return {
    ok: true,
    unlocked: unlock,
    protected:
      _PROTECTED_MODELS.has(modelUid) && !_unlockedModels.has(modelUid),
  };
}

/**
 * ★ v9.9.97 · 检查模型是否被保护
 * @param {string} modelUid
 * @returns {boolean}
 */
function isModelProtected(modelUid) {
  if (!modelUid) return false;
  if (_unlockedModels.has(modelUid)) return false;
  // 1. 精确匹配
  if (_PROTECTED_MODELS.has(modelUid)) return true;
  // 2. ★ v9.9.97-fix · family级别匹配: glm-5-1, deepseek-v4, qwen3-coder 等新版本自动保护
  const lower = modelUid.toLowerCase();
  if (lower.startsWith("glm") || lower.startsWith("model_glm")) return true;
  if (lower.startsWith("deepseek") || lower.startsWith("model_deepseek"))
    return true;
  if (lower.startsWith("qwen") || lower.startsWith("model_qwen")) return true;
  return false;
}

// ════════════════════════════════════════════════════════════════
// ★ v9.9.99 · AI 热配置接口 · 移植自 Go EXE 核心模块
//   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
//   二十八章「知其白 守其辱 为天下式」· 开放一切底层 · 为天下式
// ════════════════════════════════════════════════════════════════

/**
 * ★ AI接口: 设置预算参数
 *   AI/Cascade Code 可辅助用户热配置 token 预算
 * @param {string} key - 预算参数名 (maxContextTokens, maxOutputTokens, etc.)
 * @param {*} value - 参数值
 * @returns {{ok: boolean, error?: string}}
 */
function hotSetBudgetParam(key, value) {
  if (!_budget) return { ok: false, error: "budget module not loaded" };
  return _budget.setBudgetConfig(key, value);
}

/**
 * ★ AI接口: 获取预算状态
 * @returns {object|null}
 */
function hotGetBudgetStatus() {
  if (!_budget) return null;
  return _budget.getBudgetStatus();
}

/**
 * ★ AI接口: 计算 token 数
 *   AI可辅助用户了解消息/工具的 token 消耗
 * @param {string} text - 要计算的文本
 * @param {string} [encoder] - 编码器名 (o200k_base, cl100k_base, p50k_base)
 * @returns {{tokens: number, encoder: string}}
 */
function hotCountTokens(text, encoder) {
  if (!_budget) return { tokens: -1, encoder: "unavailable" };
  return {
    tokens: _budget.countTokens(text, encoder || "o200k_base"),
    encoder: _budget.getBudgetStatus().encoder,
  };
}

/**
 * ★ AI接口: 检测协议类型
 *   AI可辅助用户配置 provider 的协议类型
 * @param {string} providerName - provider 名称
 * @returns {{protocol: string, supported: string[]}}
 */
function hotDetectProtocol(providerName) {
  if (!_adapters)
    return { protocol: "openai-chat", supported: ["openai-chat"] };
  const provCfg = _providers[providerName] || {};
  const model = (provCfg.models && provCfg.models[0]) || "";
  return {
    protocol: _adapters.detectProtocol(provCfg, model),
    supported: _adapters.getSupportedProtocols(),
  };
}

/**
 * ★ AI接口: 获取模型上下文长度
 * @param {string} model - 模型名称
 * @returns {{contextLength: number}}
 */
function hotGetModelContextLength(model) {
  if (!_adapters) return { contextLength: 128000 };
  return { contextLength: _adapters.pickContextLength(model) };
}

/**
 * ★ AI接口: 设置弹性配置
 * @param {string} key - 配置项名
 * @param {*} value - 配置值
 * @returns {{ok: boolean, error?: string}}
 */
function hotSetResilienceParam(key, value) {
  if (!_resilience) return { ok: false, error: "resilience module not loaded" };
  const cfg = _resilience.getDefaultConfig();
  if (!(key in cfg)) return { ok: false, error: `unknown key: ${key}` };
  // 注意: 弹性配置是运行时的 · 不持久化
  _log(`[dao-router] [热] resilience.${key} = ${JSON.stringify(value)}`);
  return { ok: true };
}

/**
 * ★ AI接口: 检测文本是否为拒绝响应
 * @param {string} text - 响应文本
 * @returns {{isRefusal: boolean}}
 */
function hotDetectRefusal(text) {
  if (!_resilience) return { isRefusal: false };
  return { isRefusal: _resilience.matchesRefusal(text) };
}

/**
 * ★ AI接口: 压缩 JSON Schema
 *   AI可辅助用户优化工具定义的 Schema
 * @param {object} schema - JSON Schema 对象
 * @param {boolean} [stripDoc] - 是否剥离文档字段
 * @returns {object}
 */
function hotCompactSchema(schema, stripDoc) {
  if (!_budget) return schema;
  return _budget.compactJSONSchema(schema, stripDoc !== false);
}

module.exports = {
  init,
  isReady,
  extractModelUid,
  shouldRoute,
  route,
  status,
  getSubstitution,
  patchModelUid,
  resetHealthCache,
  probeAllProviders,
  // ★ 热配置 API · 道法自然
  hotAddProvider,
  hotRemoveProvider,
  hotAddRoute,
  hotRemoveRoute,
  hotDeleteRoute,
  hotGetConfig,
  hotSetConfig,
  hotReload,
  hotListProviderModels,
  // ★ v9.9.97 · 保护模型 API
  unlockModel,
  isModelProtected,
  // ★ v9.9.99 · AI 热配置接口 · Go 移植模块
  //   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
  hotSetBudgetParam,
  hotGetBudgetStatus,
  hotCountTokens,
  hotDetectProtocol,
  hotGetModelContextLength,
  hotSetResilienceParam,
  hotDetectRefusal,
  hotCompactSchema,
};
