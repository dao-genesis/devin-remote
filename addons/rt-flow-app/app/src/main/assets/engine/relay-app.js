"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// relay-app.js · APP 版「内网穿透客户端」(WebView 页内出站 WSS 连中继)
//
// 与 addons/dao-bridge/core.js 同协议、同安全边界, 区别:
//   · 命令注册表由 engine 注入 (DaoRelayApp.register), 含切号 25 RPC + 管理命令
//   · 多一条管理通道 hotpatch/persistModule → 隔隧道热修 (用户私有 token 已门禁)
//   · 跑在 WebView 页, 非 service worker; WebSocket/timer 原生可用
//
// 协议 (与 dao-relay/worker.js 完全一致):
//   出站: wss://<relay>/connect?session=<id>&token=<t>
//   入站帧: {type:'request', id, path, method, body}
//   回帧:   {type:'response', id, status, body}
// ═══════════════════════════════════════════════════════════════════════════

const DaoRelayApp = (function () {
  const COMMANDS = Object.create(null); // cmd -> async fn(args)
  let sock = null, connected = false, stopped = true;
  let cfg = { url: "", token: "", session: "" };
  let backoff = 1500, pingTimer = null, reTimer = null, connectTimer = null;
  let lastError = null, lastConnectTs = 0, lastFrameTs = 0, lastRxTs = 0;
  let onStatus = null;
  const STALE_TIMEOUT = 45000; // 连续 3× ping 周期(15s)无任何入站(连 pong 都收不到) → 判半开死链, 主动重连

  //__LIVENESS_START__ (经 test/relay-liveness.test.js 切片 eval 实测, 勿删标记)
  // 半开死链判定: 移动网/NAT 重绑/Doze 常致出站 WSS 静默失效——TCP 不发 FIN, onclose 永不触发,
  //   客户端却仍自以为 connected, 心跳 send() 进缓冲不报错 → 中继侧 socket 早死、公网侧 no_agent/超时
  //   长达数分钟。中继对每个 ping 自动回 pong → 健康连接每 15s 必有入站; 据此: 已连接却连续 staleMs
  //   无任何入站即判半开。lastRxTs===0(刚 open 未收任何帧)不误杀。
  function isHalfOpen(connected, lastRxTs, now, staleMs) {
    return !!connected && lastRxTs > 0 && (now - lastRxTs) > staleMs;
  }
  //__LIVENESS_END__
  // ── 多中继端点·自动故障转移 (国内无感: workers.dev 常被运营商 SNI 拦截,
  //    可在 url 里用逗号/空格/换行分隔多个端点, 例如自有域名镜像; 客户端逐个轮询直到连通) ──
  let candidates = [];      // [baseUrl, ...] 去尾斜杠
  let candIdx = 0;          // 当前尝试的端点下标
  let activeUrl = null;     // 当前连通的端点
  let attempts = 0;         // 累计连接尝试次数
  const BACKOFF_MIN = 1500, BACKOFF_MAX = 20000, CONNECT_TIMEOUT = 10000;

  function parseCandidates(c) {
    let list = [];
    if (Array.isArray(c.urls)) list = c.urls.slice();
    const u = (c.url || "");
    if (Array.isArray(u)) list = list.concat(u);
    else if (typeof u === "string") list = list.concat(u.split(/[\s,]+/));
    const seen = Object.create(null), out = [];
    for (let s of list) {
      s = (s || "").trim().replace(/\/$/, "");
      if (!s || !/^https?:\/\//i.test(s) || seen[s]) continue;
      seen[s] = 1; out.push(s);
    }
    return out;
  }

  function emitStatus() {
    if (typeof onStatus === "function") {
      try { onStatus({ connected, session: cfg.session, lastError, lastConnectTs, lastFrameTs, activeUrl, attempts, candidates: candidates.slice() }); } catch (e) {}
    }
  }

  // 失败时探测当前端点可达性, 把模糊的 "websocket error" 细化为可操作的诊断。
  function probeHealth(base) {
    try {
      const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      if (ctrl) setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 5000);
      fetch(base + "/health", { method: "GET", signal: ctrl ? ctrl.signal : undefined })
        .then((r) => { if (!connected) { lastError = r && r.ok ? "⚠️ 中继可达但 WSS 握手被拦截 → 请开启 VPN/科学上网后重连 (国内网络常拦截 WebSocket 升级)" : ("中继返回 " + (r && r.status) + " (请检查 token/session 是否正确)"); emitStatus(); } })
        .catch(() => { if (!connected) { lastError = "⚠️ 连不上中继 (" + shortHost(base) + ") → 请开启 VPN/科学上网后重连。国内网络会屏蔽 workers.dev, 无 VPN 时无法连通。"; emitStatus(); } });
    } catch (e) {}
  }
  function shortHost(u) { try { return new URL(u).host; } catch (e) { return u; } }

  // ═══════════════════════════════════════════════════════════════════════
  //__HUB_START__ 手机中枢 (三明治 operator→hub→agent): 让任意 PC 一行 PowerShell
  //   经手机中转接入 —— PC 不装插件, connect 领 per-agent token, poll 取命令, result 回传。
  //   与 addons/dao-bridge WorkspaceServer 同协议同语义 (见其 test/hub.test.js), 纯内存队列,
  //   跑在 RelayService 常驻 WebView 引擎单例中, 帧间状态天然持久。经 test/phone-hub.test.js 实测, 勿删标记。
  // ═══════════════════════════════════════════════════════════════════════
  var HUB_POLL_MAX = 25, HUB_HB_TIMEOUT = 90000;   // 90s 无 poll/心跳判离线
  var agentRegistry = new Map();
  function hubRandHex(n) {
    var b = null;
    try { if (typeof crypto !== "undefined" && crypto.getRandomValues) { b = new Uint8Array(n); crypto.getRandomValues(b); } } catch (e) {}
    if (!b) { b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); }
    var s = ""; for (var j = 0; j < n; j++) s += ("0" + b[j].toString(16)).slice(-2);
    return s;
  }
  function hubPsq(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'"; }
  function hubShq(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'"; }
  // 按被控端登记平台把 {type,file,args,cmd,cwd} 规范化为一条可执行命令串 (dao-bridge buildExecCommand 移植)。
  function hubBuildExec(body, posix) {
    body = body || {};
    var type = String(body.type || "shell").toLowerCase();
    var file = body.file || body.exe || body.program || "";
    var args = Array.isArray(body.args) ? body.args : [];
    var cmd = body.cmd || body.command || (body.payload && body.payload.command) || "";
    if (posix) {
      var cwdP = body.cwd ? "cd " + hubShq(body.cwd) + " && " : "";
      if (type === "detached" || type === "spawn" || body.detached) {
        var t1 = file ? hubShq(file) : cmd; var a1 = args.length ? " " + args.map(hubShq).join(" ") : "";
        return cwdP + "nohup " + t1 + a1 + " >/dev/null 2>&1 & echo \"started pid=$! file=" + (file || cmd) + "\"";
      }
      if (type === "run" || type === "file" || (file && !cmd)) {
        var a2 = args.length ? " " + args.map(hubShq).join(" ") : ""; var runner = /\.sh$/i.test(file) ? "sh " : "";
        return cwdP + runner + hubShq(file || cmd) + a2 + " 2>&1";
      }
      return cwdP + cmd;
    }
    var cwd = body.cwd ? "Set-Location -LiteralPath " + hubPsq(body.cwd) + "; " : "";
    if (type === "detached" || type === "spawn" || body.detached) {
      var tgt = file || cmd; var al = args.length ? " -ArgumentList " + args.map(hubPsq).join(",") : "";
      var win = body.show ? "" : " -WindowStyle Hidden"; var verb = body.elevate ? " -Verb RunAs" : "";
      return cwd + "$p=Start-Process -FilePath " + hubPsq(tgt) + al + win + verb + " -PassThru; 'started pid=' + $p.Id + ' file=' + " + hubPsq(tgt);
    }
    if (type === "run" || type === "file" || (file && !cmd)) {
      var al2 = args.length ? " " + args.map(hubPsq).join(" ") : "";
      return cwd + "& " + hubPsq(file || cmd) + al2 + " 2>&1 | Out-String";
    }
    if (type === "cmd" || type === "bat" || type === "batch") {
      return cwd + "& cmd.exe /d /c " + hubPsq("chcp 65001>nul & " + cmd) + " 2>&1 | Out-String";
    }
    return cwd + cmd;
  }
  function hubPlatformPosix(a) {
    var p = (a && a.sysinfo && a.sysinfo.platform) || (a && a.platform) || "win32";
    return String(p).toLowerCase() !== "win32";
  }
  function hubRegister(sysinfo) {
    sysinfo = sysinfo || {};
    var id = sysinfo.hostname || ("agent-" + hubRandHex(3));
    var token = hubRandHex(24);
    var ex = agentRegistry.get(id);
    if (ex) {
      ex.id = id; ex.token = token; ex.sysinfo = sysinfo; ex.lastSeen = Date.now(); ex.status = "online";
      ex.hostname = sysinfo.hostname || id; ex.capabilities = sysinfo.capabilities || ex.capabilities || ["shell"];
      if (!ex.queue) ex.queue = []; if (!ex.waiters) ex.waiters = [];
      if (!ex.results) ex.results = new Map(); if (!ex.resultWaiters) ex.resultWaiters = new Map();
      return ex;
    }
    var a = { id: id, token: token, sysinfo: sysinfo, hostname: sysinfo.hostname || id,
      capabilities: sysinfo.capabilities || ["shell"], connectedAt: Date.now(), lastSeen: Date.now(),
      status: "online", queue: [], waiters: [], results: new Map(), resultWaiters: new Map() };
    agentRegistry.set(id, a);
    return a;
  }
  function hubGetAgent(id) {
    if (!id) return null;
    var a = agentRegistry.get(id); if (a) { a.id = a.id || id; return a; }
    var t = String(id).toLowerCase();
    var it = agentRegistry.entries(), n;
    while (!(n = it.next()).done) { if (String(n.value[0]).toLowerCase() === t) { n.value[1].id = n.value[1].id || n.value[0]; return n.value[1]; } }
    return null;
  }
  function hubAlive(a) { var ls = typeof a.lastSeen === "number" ? a.lastSeen : 0; return Date.now() - ls < HUB_HB_TIMEOUT; }
  function hubIsSelf(id) { var k = String(id || "").toLowerCase().trim(); return k === "" || k === "self" || k === "local" || k === "phone"; }
  function hubQueue(agentId, type, payload) {
    var a = hubGetAgent(agentId); if (!a) return { err: "agent not found" };
    if (!a.queue) a.queue = []; if (!a.waiters) a.waiters = [];
    var cmdId = "cmd_" + Date.now() + "_" + hubRandHex(3);
    a.queue.push({ cmd_id: cmdId, type: type || "shell", payload: payload || {} });
    var w = a.waiters.shift(); if (w) w();
    return { cmdId: cmdId, agent: a };
  }
  function hubPoll(a, timeoutSec) {
    a.lastSeen = Date.now(); a.status = "online";
    if (!a.queue) a.queue = []; if (!a.waiters) a.waiters = [];
    var ms = Math.min(timeoutSec || HUB_POLL_MAX, HUB_POLL_MAX) * 1000;
    return new Promise(function (resolve) {
      if (a.queue.length) return resolve(a.queue.splice(0));
      var done = false, timer = null;
      var finish = function (cmds) { if (done) return; done = true; clearTimeout(timer); var i = a.waiters.indexOf(wake); if (i >= 0) a.waiters.splice(i, 1); resolve(cmds); };
      var wake = function () { finish(a.queue.splice(0)); };
      a.waiters.push(wake);
      timer = setTimeout(function () { finish([]); }, ms);
    });
  }
  function hubSubmit(a, cmdId, result) {
    a.lastSeen = Date.now();
    if (!a.results) a.results = new Map();
    a.results.set(cmdId, Object.assign({ completed_at: Date.now() }, result));
    if (a.results.size > 100) {
      var arr = Array.from(a.results.entries()).sort(function (x, y) { return (x[1].completed_at || 0) - (y[1].completed_at || 0); });
      for (var i = 0; i < a.results.size - 100; i++) a.results.delete(arr[i][0]);
    }
    var w = a.resultWaiters && a.resultWaiters.get(cmdId); if (w) w(a.results.get(cmdId));
  }
  function hubWaitResult(a, cmdId, timeoutMs) {
    return new Promise(function (resolve) {
      var ex = a.results && a.results.get(cmdId); if (ex) return resolve(ex);
      if (!a.resultWaiters) a.resultWaiters = new Map();
      var done = false, timer = null;
      var finish = function (r) { if (done) return; done = true; clearTimeout(timer); a.resultWaiters.delete(cmdId); resolve(r); };
      a.resultWaiters.set(cmdId, finish);
      timer = setTimeout(function () { finish(null); }, timeoutMs);
    });
  }
  function hubList() {
    var out = [], it = agentRegistry.entries(), n;
    while (!(n = it.next()).done) {
      var id = n.value[0], a = n.value[1], si = a.sysinfo || {};
      out.push({ id: id, hostname: a.hostname || id, status: hubAlive(a) ? "online" : "offline",
        os: si.os_version || a.os || "?", user: si.username || a.user || "?",
        capabilities: a.capabilities || ["shell"],
        last_seen: typeof a.lastSeen === "number" ? new Date(a.lastSeen).toISOString() : "",
        pending: (a.queue && a.queue.length) || 0 });
    }
    return out;
  }
  // 当前对外可达的接入端点 (relay 主域 + /relay/<session>); 被控端一行脚本据此回连。
  function hubEndpoint() {
    var base = (activeUrl || (candidates && candidates[0]) || (typeof cfg.url === "string" ? cfg.url.replace(/\/$/, "") : "")) || "";
    return base && cfg.session ? base + "/relay/" + cfg.session : "";
  }
  // 被控端一行接入 PowerShell (帧封装版: 每次调用 POST <endpoint> body={path,method,body}, Bearer=中继 token)。
  function hubBootstrapPs1(endpoint, token) {
    endpoint = endpoint || "<hub-endpoint>"; token = token || "<relay-token>";
    return "# dao 手机中枢 · 被控端一行接入 · 道生一,一命接万机\n" +
"$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'\n" +
"try{ $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8 }catch{}\n" +
"$EP='" + endpoint + "'; $TK='" + token + "'\n" +
"function Dao-Rpc($p,$o){ $f=@{path=$p;method='POST';body=$o}; $b=[Text.Encoding]::UTF8.GetBytes(($f|ConvertTo-Json -Depth 8 -Compress)); return irm $EP -Method POST -Body $b -ContentType 'application/json; charset=utf-8' -Headers @{Authorization=\"Bearer $TK\"} -TimeoutSec 35 }\n" +
"$sys=@{ hostname=$env:COMPUTERNAME; username=$env:USERNAME; platform='win32'; os_version=[Environment]::OSVersion.VersionString; ps_version=$PSVersionTable.PSVersion.ToString(); capabilities=@('shell','cmd','run','detached') }\n" +
"try { $reg = Dao-Rpc '/api/connect' @{sysinfo=$sys} } catch { Write-Host \"[dao] connect failed: $($_.Exception.Message)\" -ForegroundColor Red; return }\n" +
"$aid=$reg.agent_id; $tok=$reg.token\n" +
"Write-Host \"[dao] 已接入手机中枢 as $aid  (Ctrl+C 退出)\" -ForegroundColor Green\n" +
"while($true){\n" +
"  try{\n" +
"    $poll = Dao-Rpc '/api/poll' @{id=$aid;token=$tok;timeout=25}\n" +
"    foreach($__daoCmd in @($poll.commands)){\n" +
"      if(-not $__daoCmd){ continue }\n" +
"      $__daoCid=$__daoCmd.cmd_id; $__daoType=$__daoCmd.type; $__daoPayloadCmd=$__daoCmd.payload.command\n" +
"      $out='';$err='';$code=0; $sw=[Diagnostics.Stopwatch]::StartNew(); $global:LASTEXITCODE=0\n" +
"      try{\n" +
"        switch($__daoType){\n" +
"          'sysinfo' { $out=(Get-ComputerInfo | Out-String) }\n" +
"          default {\n" +
"            $Error.Clear(); $ErrorActionPreference='Continue'\n" +
"            $raw = & { Invoke-Expression $args[0] } $__daoPayloadCmd 2>&1\n" +
"            $ErrorActionPreference='SilentlyContinue'; $out=($raw | Out-String)\n" +
"            if($Error.Count -gt 0){ $code=1; $msgs=(@($Error|Select-Object -First 20)|ForEach-Object{$_.ToString()}) -join [Environment]::NewLine; if([string]::IsNullOrWhiteSpace($out)){$out=$msgs}else{$out=$out+[Environment]::NewLine+$msgs} }\n" +
"            if($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0){ $code=$LASTEXITCODE }\n" +
"          }\n" +
"        }\n" +
"      }catch{ $err=$_.Exception.Message; $code=1 }\n" +
"      $sw.Stop()\n" +
"      $res=@{ stdout=$out; stderr=$err; exit_code=$code; execution_time_ms=$sw.ElapsedMilliseconds }\n" +
"      try{ Dao-Rpc '/api/result' @{agent_id=$aid;token=$tok;cmd_id=$__daoCid;result=$res} | Out-Null }catch{}\n" +
"    }\n" +
"  }catch{\n" +
"    try{ $reg=Dao-Rpc '/api/connect' @{sysinfo=$sys}; $aid=$reg.agent_id; $tok=$reg.token }catch{ Start-Sleep 3 }\n" +
"  }\n" +
"}\n";
  }
  function hubRevoke(id) {
    var a = hubGetAgent(id); if (!a) return false;
    try { (a.waiters || []).slice().forEach(function (w) { try { w(); } catch (e) {} }); } catch (e) {}
    agentRegistry.delete(a.id);
    return true;
  }
  //__HUB_END__

  // ═══════════════════════════════════════════════════════════════════════
  //__CFPROV_START__ Cloudflare 一键建 Worker (可选·固定域名) —— 纯 fetch 移植自
  //   addons/dao-relay/provision.mjs (桌面版走 wrangler; 手机 WebView 无 Node,
  //   改走 CF REST 多模块上传, worker 源取自公开仓 raw)。
  //   凭证任选其一, 全程纯后端 API·零浏览器·零 CAPTCHA·零点击:
  //     ① API Token (Bearer)         —— 传字符串或 {token}
  //     ② Global API Key (email+key) —— 传 {email,key}: 用 X-Auth-Email/X-Auth-Key 头
  //   凭证仅本次内存使用, 不落盘不过中继; 成功后仅把恒定 URL 前插到 relay 端点(内置端点保留为兜底)。
  //   经 test/cf-provision.test.js 切片实测, 勿删标记。
  // ═══════════════════════════════════════════════════════════════════════
  var CF_API = "https://api.cloudflare.com/client/v4";
  var CF_WORKER_NAME = "dao-relay-do";
  var CF_SRC_BASE = "https://raw.githubusercontent.com/dao-genesis/devin-remote/main/addons/dao-relay/";
  var cfNet = null;   // 测试可注入; 运行时默认全局 fetch
  function cfFetch() { return (cfNet || fetch).apply(null, arguments); }
  var cfProv = { phase: "idle", step: 0, msg: "未配置 (使用零账号内置中继)", url: "", subdomain: "", accountId: "", error: "", ts: 0 };
  function cfSet(phase, step, msg, extra) {
    cfProv.phase = phase; cfProv.step = step; cfProv.msg = msg; cfProv.ts = Date.now();
    if (extra) Object.assign(cfProv, extra);
  }
  // 凭证→请求头: Global API Key({email,key}) 走 X-Auth-Email/X-Auth-Key; 否则 API Token 走 Bearer。
  function cfAuthHeaders(auth) {
    if (auth && typeof auth === "object") {
      if (auth.email && auth.key) return { "X-Auth-Email": auth.email, "X-Auth-Key": auth.key };
      if (auth.token) return { Authorization: "Bearer " + auth.token };
    }
    return { Authorization: "Bearer " + String(auth || "") };
  }
  function cfIsGlobalKey(auth) { return !!(auth && typeof auth === "object" && auth.email && auth.key); }
  async function cfApi(path, auth, init) {
    init = init || {};
    var headers = Object.assign({}, cfAuthHeaders(auth), init.headers || {});
    if (!(init.body instanceof FormData) && !headers["content-type"]) headers["content-type"] = "application/json";
    var r = await cfFetch(CF_API + path, Object.assign({}, init, { headers: headers }));
    var j = null; try { j = await r.json(); } catch (e) { j = {}; }
    if (!r.ok || j.success === false) {
      var msg = (j.errors && j.errors.map && j.errors.map(function (e) { return e.message; }).join("; ")) || ("HTTP " + r.status);
      var err = new Error("CF " + path + ": " + msg); err.cfStatus = r.status; throw err;
    }
    return j.result;
  }
  async function cfEnsureSubdomain(auth, accountId) {
    try {
      var r = await cfApi("/accounts/" + accountId + "/workers/subdomain", auth);
      if (r && r.subdomain) return r.subdomain;
    } catch (e) { /* 未注册 → 下方登记 */ }
    var cand = "dao-" + String(accountId).slice(0, 8);
    var put = await cfApi("/accounts/" + accountId + "/workers/subdomain", auth, { method: "PUT", body: JSON.stringify({ subdomain: cand }) });
    return (put && put.subdomain) || cand;
  }
  async function cfFetchSrc(name) {
    var r = await cfFetch(CF_SRC_BASE + name);
    if (!r.ok) throw new Error("取 worker 源失败 (" + name + ": HTTP " + r.status + ")");
    return await r.text();
  }
  function cfBuildForm(workerSrc, keysSrc, withMigration) {
    var meta = {
      main_module: "worker.js",
      compatibility_date: "2024-09-23",
      bindings: [{ type: "durable_object_namespace", name: "DAO_RELAY", class_name: "DaoRelayDO" }],
    };
    if (withMigration) meta.migrations = { new_tag: "v8", new_sqlite_classes: ["DaoRelayDO"] };
    var fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }), "metadata.json");
    fd.append("worker.js", new Blob([workerSrc], { type: "application/javascript+module" }), "worker.js");
    fd.append("keys.js", new Blob([keysSrc], { type: "application/javascript+module" }), "keys.js");
    return fd;
  }
  async function cfProvisionRun(auth) {
    var glob = cfIsGlobalKey(auth);
    cfSet("running", 1, glob ? "① 校验 Global API Key…" : "① 校验 API Token…", { error: "", url: "" });
    if (glob) {
      var u = await cfApi("/user", auth);
      if (!u || !u.email) throw new Error("Global API Key 校验失败 (邮箱/密钥不匹配)");
    } else {
      var v = await cfApi("/user/tokens/verify", auth);
      if (!v || v.status !== "active") throw new Error("token 未激活 (status=" + (v && v.status) + ")");
    }
    cfSet("running", 2, "② 读取账号…");
    var accounts = await cfApi("/accounts?per_page=50", auth);
    if (!Array.isArray(accounts) || !accounts.length) throw new Error("此 Token 读不到任何账号 (需含 Account 读取权限)");
    var accountId = accounts[0].id;
    cfSet("running", 3, "③ 登记 workers.dev 子域…", { accountId: accountId });
    var subdomain = await cfEnsureSubdomain(auth, accountId);
    var url = "https://" + CF_WORKER_NAME + "." + subdomain + ".workers.dev";
    cfSet("running", 4, "④ 取中继 Worker 源码 (公开仓最新版)…", { subdomain: subdomain });
    var workerSrc = await cfFetchSrc("worker.js");
    var keysSrc = await cfFetchSrc("keys.js");
    cfSet("running", 5, "⑤ 上传部署 Worker (Durable Object)…");
    var scriptPath = "/accounts/" + accountId + "/workers/scripts/" + CF_WORKER_NAME;
    try {
      await cfApi(scriptPath, auth, { method: "PUT", body: cfBuildForm(workerSrc, keysSrc, true) });
    } catch (e) {
      // 已部署过同 migration tag → 去掉 migrations 重传 (幂等更新)
      await cfApi(scriptPath, auth, { method: "PUT", body: cfBuildForm(workerSrc, keysSrc, false) });
    }
    cfSet("running", 6, "⑥ 开启 workers.dev 路由…");
    try { await cfApi(scriptPath + "/subdomain", auth, { method: "POST", body: JSON.stringify({ enabled: true }) }); } catch (e) { /* 部分套餐默认已开 */ }
    cfSet("running", 7, "⑦ 健康检查 (边缘传播需几秒)…", { url: url });
    var healthy = false;
    for (var i = 0; i < 8 && !healthy; i++) {
      try {
        var hr = await cfFetch(url + "/health");
        if (hr && hr.ok) { var hj = await hr.json(); if (hj && hj.status === "ok") healthy = true; }
      } catch (e) {}
      if (!healthy) await new Promise(function (s) { setTimeout(s, 3000); });
    }
    // 成功: 把恒定 URL 前插到 relay 端点 (内置端点保留为兜底), 原生落盘后重连即生效。
    var N = typeof Native !== "undefined" ? Native : {};
    var urls = [url].concat(candidates.filter(function (u) { return u !== url; }));
    try { if (N.saveRelayConfig) N.saveRelayConfig(JSON.stringify({ url: urls.join(","), token: cfg.token || "", session: cfg.session || "" })); } catch (e) {}
    cfSet("done", 8, healthy ? "✅ 恒定通道就绪: " + url : "⚠ 已部署 (边缘传播中, 稍后自动可达): " + url, { url: url, healthy: healthy });
    try { if (N.relayRestart) N.relayRestart(); } catch (e) {}
    return cfProv;
  }

  // ═══ 会话态·零浏览器·冻结免疫「自动建 Token→部署」(道法自然·操作分离·本源突破) ═══
  //   缘起: 远程从 VM 驱动手机后台标签建 Token 会卡死——后台标签的 JS event loop 被 OS 冻结
  //   (fetch/setTimeout 均不推进)。破法: 用户在 App 内浏览器登录过 Cloudflare 后, 其 dashboard
  //   会话 cookie 落在全局 CookieManager; 引擎页跑在常驻前台服务里 (永不冻结·原生 convPump 外驱),
  //   经原生 HTTP 桥 (DaoCore.httpReq·无 CORS·可设 Cookie/Origin·冻结免疫) 复刻 dashboard 前端
  //   调的同一批 /api/v4 内部接口直建 Token → 全程零可见标签·零前台·零浏览器自动化, 远程 RPC
  //   亦可后台安全跑通。与 cf-auto.js (页内注入·前台活动页) 互为两条独立路, 都收敛到 cfProvisionRun。
  //   纯函数 (cfPickGroups/cfMissingGroups/cfBuildTokenPayload/cfPickAccount) 经 cf-provision.test.js 实测。
  var CF_DASH = "https://dash.cloudflare.com";
  var CF_ACCT_GROUPS = ["Workers Scripts Write", "Account Settings Read"];
  var CF_USER_GROUPS = ["User Details Read", "Memberships Read"];
  var cfCookieFn = null;   // 测试注入; 运行时默认 Native.cookiesFor
  var cfDashFn = null;     // 测试注入; 运行时默认 DaoCore.httpReq (原生·无 CORS·冻结免疫)
  function cfNorm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  // 按名从权限组全集挑 id: 先精确, 再退「去空白·不分大小写」→ 容忍任意账号/语言环境的组名差异。
  function cfPickGroups(all, names) {
    all = Array.isArray(all) ? all : [];
    return (names || []).map(function (n) {
      for (var i = 0; i < all.length; i++) { if (all[i] && all[i].name === n) return { id: all[i].id }; }
      for (var j = 0; j < all.length; j++) { if (all[j] && cfNorm(all[j].name) === cfNorm(n)) return { id: all[j].id }; }
      return null;
    }).filter(Boolean);
  }
  function cfMissingGroups(all, names) {
    all = Array.isArray(all) ? all : [];
    return (names || []).filter(function (n) { return cfPickGroups(all, [n]).length === 0; });
  }
  // 最小权限: 账号级 Workers 脚本写 + 账号设置读; 用户级 用户详情读 + 成员读 (供 verify/accounts)。
  function cfBuildTokenPayload(o) {
    o = o || {};
    var acctG = cfPickGroups(o.groups, CF_ACCT_GROUPS);
    var userG = cfPickGroups(o.groups, CF_USER_GROUPS);
    var policies = [];
    if (acctG.length && o.accountId) { var ar = {}; ar["com.cloudflare.api.account." + o.accountId] = "*"; policies.push({ effect: "allow", resources: ar, permission_groups: acctG }); }
    if (userG.length && o.userId) { var ur = {}; ur["com.cloudflare.api.user." + o.userId] = "*"; policies.push({ effect: "allow", resources: ur, permission_groups: userG }); }
    return { name: o.name || ("dao-relay " + Date.now()), policies: policies };
  }
  // 多账号选择: 指定即取指定; 单账号自动; 多账号未指定 → 明确报错列出(不隐式冒名选第一个·道法自然)。
  function cfPickAccount(accts, wanted) {
    accts = Array.isArray(accts) ? accts : [];
    wanted = String(wanted == null ? "" : wanted).trim();
    if (wanted) {
      for (var i = 0; i < accts.length; i++) { if (accts[i] && accts[i].id === wanted) return accts[i]; }
      throw new Error("account_not_found: 指定 accountId 不在此登录态可见账号内");
    }
    if (accts.length === 1) return accts[0];
    if (!accts.length) throw new Error("no_account: 会话态读不到任何账号");
    throw new Error("multi_account: 检测到 " + accts.length + " 个账号, 请在 body.accountId 指定其一: " + accts.map(function (a) { return a && a.id; }).filter(Boolean).join(","));
  }
  function cfReadCookie(url) {
    if (cfCookieFn) return cfCookieFn(url);
    try { var Nx = (typeof Native !== "undefined") ? Native : {}; return Nx.cookiesFor ? Nx.cookiesFor(url) : ""; } catch (e) { return ""; }
  }
  // 经原生 HTTP 桥调 dashboard 同源内部接口 (带会话 cookie + Origin/Referer·无 CORS·冻结免疫)。
  async function cfDashHttp(method, apiPath, cookie, body) {
    var headers = { "Cookie": cookie, "Origin": CF_DASH, "Referer": CF_DASH + "/", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" };
    if (body != null) headers["Content-Type"] = "application/json";
    var httpFn = cfDashFn || ((typeof DaoCore !== "undefined" && DaoCore.httpReq) ? DaoCore.httpReq : null);
    if (!httpFn) throw new Error("原生 HTTP 桥不可用 (需引擎上下文·DaoCore.httpReq)");
    var res = await httpFn(method, CF_DASH + apiPath, headers, body || "");
    var status = (res && res.status) || 0;
    var j = null; try { j = JSON.parse((res && res.text) || "null"); } catch (e) { j = null; }
    if (status < 200 || status >= 400 || (j && j.success === false)) {
      var msg = (j && j.errors && j.errors.map && j.errors.map(function (e) { return e && e.message; }).filter(Boolean).join("; ")) || ("HTTP " + status);
      var err = new Error("CF dash " + apiPath + ": " + msg); err.cfStatus = status; throw err;
    }
    return j && j.result;
  }
  // 离屏真 Chromium 同源建 Token 桥 (Native.cfWebMint → window.__cfWebMintCb 回灌)。
  //   CF 机管把 dash /api/v4 与浏览器指纹 + cf_clearance + SameSite cookie 强绑; 原生 HTTP / file:// 跨站
  //   fetch 都会 403/丢 cookie。此路在常驻服务里起离屏真 Chromium 导航 dash 成同源, 页内 fetch 带齐全部
  //   cookie 过机管, 又冻结免疫。返回 {token, accountId} 或抛语义化错误 (no_cf_session/multi_account/…)。
  var cfWebMintFn = null;   // 测试注入; 运行时默认 Native.cfWebMint
  // 全局句柄: WebView 里 = window (native evaluateJavascript 回灌 window.__cfWebMintCb); node 测试里 = globalThis。
  var _G = (typeof window !== "undefined") ? window : ((typeof globalThis !== "undefined") ? globalThis : {});
  function cfWebMint(accountId) {
    return new Promise(function (resolve, reject) {
      var fn = cfWebMintFn;
      if (!fn) { try { var Nx = (typeof Native !== "undefined") ? Native : {}; fn = Nx.cfWebMint ? function (id, a) { Nx.cfWebMint(id, a); } : null; } catch (e) { fn = null; } }
      if (!fn) { reject(new Error("no_webmint_bridge")); return; }
      var id = "cfm" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      var reg = (_G.__cfWebMintReg = _G.__cfWebMintReg || {});
      _G.__cfWebMintCb = _G.__cfWebMintCb || function (rid, js) { try { var f = (_G.__cfWebMintReg || {})[rid]; if (f) f(js); } catch (e) {} };
      var to = setTimeout(function () { if (reg[id]) { delete reg[id]; reject(new Error("cf_webmint_timeout")); } }, 50000);
      reg[id] = function (js) {
        clearTimeout(to); delete reg[id];
        var o = null; try { o = (typeof js === "string") ? JSON.parse(js) : js; } catch (e) { o = null; }
        if (!o) { reject(new Error("cf_webmint_bad_result")); return; }
        if (o.error) { reject(new Error(o.error)); return; }
        if (!o.token) { reject(new Error("cf_webmint_no_token")); return; }
        resolve({ token: o.token, accountId: o.accountId || "" });
      };
      try { fn(id, accountId || ""); } catch (e) { clearTimeout(to); delete reg[id]; reject(e); }
    });
  }
  // 会话态直建 Token: 首选离屏真 Chromium 同源(过机管·冻结免疫); 桥不可用/超时才落原生 HTTP 兜底。
  async function cfMintViaCookie(opts) {
    opts = opts || {};
    var root2 = (typeof Native !== "undefined") ? Native : {};
    if (cfWebMintFn || root2.cfWebMint) {
      try { return await cfWebMint(opts.accountId || ""); }
      catch (e) {
        var msg = String(e && e.message || e);
        // 语义化业务错误直接上抛(供 UI 精准提示); 仅「桥不可用/超时/坏结果」才落原生兜底。
        if (/no_cf_session|multi_account|account_not_found|missing_perm_groups|no_account|no_token_value/.test(msg)) throw e;
      }
    }
    var cookie = String(cfReadCookie(CF_DASH) || "").trim();
    if (!cookie) throw new Error("no_cf_session: 未检测到 Cloudflare 登录态 (请先在 App 内浏览器登录一次 CF·人机验证同一道关手动过, 之后建 Token 全自动)");
    var user = await cfDashHttp("GET", "/api/v4/user", cookie);
    if (!user || !user.id) throw new Error("会话态读用户失败 (登录态可能过期, 请重新登录 CF)");
    var accts = await cfDashHttp("GET", "/api/v4/accounts?per_page=50", cookie);
    var acct = cfPickAccount(accts, opts.accountId);
    var groups = await cfDashHttp("GET", "/api/v4/user/tokens/permission_groups", cookie);
    var acctMiss = cfMissingGroups(groups, CF_ACCT_GROUPS);
    if (acctMiss.length) {
      var gn = (Array.isArray(groups) ? groups : []).map(function (g) { return g && g.name; }).filter(Boolean);
      throw new Error("missing_perm_groups: " + acctMiss.join(", ") + " (CF 回传 " + gn.length + " 组·此账号权限组名与预期不符)");
    }
    var payload = cfBuildTokenPayload({ name: "dao-relay " + Date.now(), accountId: acct.id, userId: user.id, groups: groups });
    if (!payload.policies.length) throw new Error("no_permission_groups_matched");
    var res = await cfDashHttp("POST", "/api/v4/user/tokens", cookie, JSON.stringify(payload));
    var tok = res && res.value;
    if (!tok) throw new Error("会话态建 Token 未返回 value");
    return { token: tok, accountId: acct.id };
  }
  async function cfAutoProvisionRun(opts) {
    cfSet("running", 1, "① 会话态直建 Token (零浏览器·冻结免疫)…", { error: "", url: "" });
    var minted = await cfMintViaCookie(opts || {});
    cfSet("running", 2, "② Token 已建·转入部署…", { accountId: minted.accountId });
    return await cfProvisionRun({ token: minted.token });
  }
  //__CFPROV_END__

  async function handleFrame(m) {
    const path = (m && m.path) || "/api/health";
    if (path === "/api/health") {
      return { status: 200, body: { status: "ok", service: "devin-cloud-mobile", role: "browser-tunnel", session: cfg.session, ts: Date.now(), cmds: Object.keys(COMMANDS), hub: { agents: agentRegistry.size, online: hubList().filter(function (a) { return a.status === "online"; }).length } } };
    }
    // v0.6.0 · 最大化暴露 · 不害怕方能成其大
    if (path === "/api/info" || path === "/api/device") {
      const N = typeof Native !== "undefined" ? Native : {};
      return { status: 200, body: {
        ua: navigator.userAgent, platform: navigator.platform, lang: navigator.language,
        screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio, orient: (screen.orientation||{}).type },
        engine: { cmds: Object.keys(COMMANDS), count: Object.keys(COMMANDS).length },
        relay: { connected, session: cfg.session, lastConnectTs, lastFrameTs, lastError },
        tabs: N.listTabs ? (function(){ try{ return JSON.parse(N.listTabs()||"[]"); }catch(e){ return []; } })() : [],
        ts: Date.now()
      }};
    }
    if (path === "/api/read" || path === "/api/file") {
      const name = (m.body && m.body.name) || "";
      if (!name) return { status: 400, body: { error: "need body.name" } };
      const N = typeof Native !== "undefined" ? Native : {};
      if (!N.readFile) return { status: 501, body: { error: "readFile bridge unavailable" } };
      return { status: 200, body: { name, content: N.readFile(name) } };
    }
    if (path === "/api/write") {
      const name = (m.body && m.body.name) || "";
      const content = (m.body && typeof m.body.content === "string") ? m.body.content : "";
      if (!name) return { status: 400, body: { error: "need body.name + body.content" } };
      const N = typeof Native !== "undefined" ? Native : {};
      if (!N.writeFile) return { status: 501, body: { error: "writeFile bridge unavailable" } };
      N.writeFile(name, content);
      return { status: 200, body: { ok: true, name, bytes: content.length } };
    }
    if (path === "/api/tabs" || path === "/api/ls") {
      const N = typeof Native !== "undefined" ? Native : {};
      return { status: 200, body: N.listTabs ? (function(){ try{ return JSON.parse(N.listTabs()||"[]"); }catch(e){ return []; } })() : [] };
    }
    // ── 手机中枢·被控端端点 (三明治 operator→hub→agent, per-agent token 自证) ──
    if (path === "/api/bootstrap.ps1" || path === "/bootstrap.ps1") {
      const ep = (m.body && m.body.endpoint) || hubEndpoint();
      const tk = (m.body && m.body.token) || cfg.token || "";
      return { status: 200, body: { script: hubBootstrapPs1(ep, tk), endpoint: ep } };
    }
    if (path === "/api/connect") {
      const a = hubRegister((m.body && (m.body.sysinfo || m.body)) || {});
      return { status: 200, body: { agent_id: a.id, token: a.token, server_time: new Date().toISOString() } };
    }
    if (path === "/api/poll") {
      const a = hubGetAgent(m.body && m.body.id);
      if (!a || a.token !== (m.body && m.body.token)) return { status: 401, body: { error: "unauthorized" } };
      const cmds = await hubPoll(a, parseInt((m.body && m.body.timeout), 10) || HUB_POLL_MAX);
      return { status: 200, body: { commands: cmds } };
    }
    if (path === "/api/result") {
      const a = hubGetAgent(m.body && m.body.agent_id);
      if (!a || a.token !== (m.body && m.body.token)) return { status: 401, body: { error: "unauthorized" } };
      hubSubmit(a, m.body.cmd_id, (m.body && m.body.result) || {});
      return { status: 200, body: { ok: true } };
    }
    if (path === "/api/heartbeat") {
      const a = hubGetAgent(m.body && m.body.agent_id);
      if (a && a.token === (m.body && m.body.token)) { a.lastSeen = Date.now(); a.status = "online"; }
      return { status: 200, body: { ok: true } };
    }
    if (path === "/api/agents") { return { status: 200, body: { agents: hubList() } }; }
    if (path === "/api/revoke") {
      var rid = m.body && m.body.agent_id;
      if (!rid || hubIsSelf(rid)) return { status: 400, body: { error: "need body.agent_id (被控端 id, 不可为 self)" } };
      var okRevoke = hubRevoke(rid);
      if (!okRevoke) return { status: 404, body: { error: "agent not found" } };
      return { status: 200, body: { ok: true, revoked: rid, agents: hubList() } };
    }
    if (path === "/api/cf-status") { return { status: 200, body: Object.assign({}, cfProv) }; }
    if (path === "/api/cf-provision") {
      var cb = (m && m.body) || {};
      var cfAuth = null;
      var cfEmail = String(cb.email || "").trim();
      var cfKey = String(cb.apiKey || cb.key || "").trim();
      var cfTok = String(cb.token || "").trim();
      if (cfEmail && cfKey.length >= 20) cfAuth = { email: cfEmail, key: cfKey };       // Global API Key (纯后端·零浏览器)
      else if (cfTok.length >= 20) cfAuth = { token: cfTok };                            // API Token
      if (!cfAuth) return { status: 400, body: { error: "need body.token (API Token) 或 body.email+body.apiKey (Global API Key)" } };
      if (cfProv.phase === "running") return { status: 200, body: Object.assign({ already: true }, cfProv) };
      cfProvisionRun(cfAuth).catch(function (e) { cfSet("error", cfProv.step, "✗ " + String((e && e.message) || e), { error: String((e && e.message) || e) }); });
      return { status: 200, body: { started: true, poll: "/api/cf-status" } };
    }
    // 会话态·零浏览器·冻结免疫「全自动建 Token→部署」: 无需用户提供 Token, 只要 App 内浏览器登录过 CF。
    //   body.accountId 可选 (多账号时必填其一)。远程 RPC 亦可后台安全触发 (引擎常驻前台服务·不冻结)。
    if (path === "/api/cf-autoprovision") {
      var ab = (m && m.body) || {};
      if (cfProv.phase === "running") return { status: 200, body: Object.assign({ already: true }, cfProv) };
      cfAutoProvisionRun({ accountId: String((ab && ab.accountId) || "").trim() || null })
        .catch(function (e) { cfSet("error", cfProv.step, "✗ " + String((e && e.message) || e), { error: String((e && e.message) || e) }); });
      return { status: 200, body: { started: true, poll: "/api/cf-status", mode: "cookie-session" } };
    }
    if (path === "/api/result-fetch") {
      const a = hubGetAgent(m.body && m.body.agent_id);
      if (!a) return { status: 404, body: { error: "agent not found" } };
      const r = a.results && a.results.get(m.body && m.body.cmd_id);
      if (!r) return { status: 200, body: { status: "pending", agent_id: a.id, cmd_id: m.body && m.body.cmd_id } };
      return { status: 200, body: { status: "completed", agent_id: a.id, cmd_id: m.body.cmd_id, result: r } };
    }
    if (path === "/api/broadcast") {
      const b = (m && m.body) || {};
      const ids = [], it = agentRegistry.keys(); let n;
      while (!(n = it.next()).done) {
        const tgt = hubGetAgent(n.value); if (!tgt) continue;
        const payload = { command: hubBuildExec(b, hubPlatformPosix(tgt)) };
        const qd = hubQueue(n.value, "shell", payload);
        if (!qd.err) ids.push({ agent_id: tgt.id, cmd_id: qd.cmdId });
      }
      return { status: 200, body: { dispatched: ids.length, commands: ids } };
    }
    if (path === "/api/exec" || path === "/api/exec-sync" || path === "/api/command") {
      // agent_id 指向已接入的被控端 → 转发该 PC (connect/poll/result 三明治); 空/self → 本机手机 shell。
      const aid = m.body && m.body.agent_id;
      if (aid && !hubIsSelf(aid)) {
        const sync = path === "/api/exec-sync";
        const type = String((m.body && m.body.type) || "shell").toLowerCase();
        const timeoutMs = Math.min(Number(m.body && m.body.timeout) || 60, 300) * 1000;
        const tgt = hubGetAgent(aid);
        if (!tgt) return { status: 404, body: { error: "agent not found" } };
        const ctype = type === "sysinfo" ? "sysinfo" : "shell";
        const payload = type === "sysinfo" ? {} : { command: hubBuildExec(m.body, hubPlatformPosix(tgt)) };
        const qd = hubQueue(aid, ctype, payload);
        if (qd.err) return { status: 404, body: { error: qd.err } };
        if (!sync) return { status: 200, body: { cmd_id: qd.cmdId, agent_id: qd.agent.id, type } };
        const result = await hubWaitResult(qd.agent, qd.cmdId, timeoutMs);
        if (!result) return { status: 504, body: { status: "timeout", agent_id: qd.agent.id, cmd_id: qd.cmdId } };
        return { status: 200, body: { status: "completed", agent_id: qd.agent.id, cmd_id: qd.cmdId, result } };
      }
      // ADB/AVD 级 shell (Shizuku, uid2000): Token 已在中继层鉴权 + 设备端 remoteOps 门禁; 此处直通执行真实命令。
      const N = typeof Native !== "undefined" ? Native : {};
      const c = (m.body && (m.body.command || m.body.cmd || m.body.sh || m.body.line)) || "";
      if (!c) return { status: 400, body: { error: "need body.command (shell 命令串)" } };
      if (!N.phoneShell) return { status: 501, body: { error: "shell_bridge_unavailable", hint: "phoneShell 桥未注入 (请在中继引擎上下文调用)" } };
      let raw = ""; try { raw = N.phoneShell(c); } catch (e) { return { status: 500, body: { error: String((e && e.message) || e) } }; }
      let parsed = null; try { parsed = JSON.parse(raw); } catch (e) { parsed = { ok: true, out: String(raw || "") }; }
      // Shizuku 未授权 → 引导而非 403; remoteOps 未开 → 同理由设备端返回提示。
      return { status: (parsed && parsed.ok === false) ? 200 : 200, body: parsed };
    }
    if (path === "/api/rpc") {
      const body = (m && m.body && typeof m.body === "object") ? m.body : {};
      const cmd = body.cmd || body.type;
      if (!cmd || !COMMANDS[cmd]) {
        return { status: 400, body: { error: "unknown_or_forbidden_cmd", cmd: cmd || null, allowed: Object.keys(COMMANDS) } };
      }
      try {
        const args = Object.assign({}, body); delete args.cmd; delete args.type;
        const res = await COMMANDS[cmd](args);
        return { status: 200, body: res };
      } catch (e) {
        return { status: 500, body: { error: String((e && e.message) || e), stack: e && e.stack } };
      }
    }
    // ── 网页原生直渲(零账号中继版) ──────────────────────────────────────
    //  把 APK 的「直渲」底座经中继暴露 → 任意浏览器在 srcdoc 里原生跑真实页面 (switch/cloud/tunnel/…),
    //  由浏览器自身渲染、原生交互, 彻底取代截图投屏 (无黑屏/不卡顿/反向操作即时)。
    //    /api/native — 值返回型 Native 方法 (状态/配置/金库)   /api/http — 手机侧原生 HTTP (绕 CORS, 带 auth1)
    //    /api/asset  — APK 页面/JS 资源原文 (供 srcdoc 内联)    /api/mirror — 兼容旧投屏取帧
    if (path === "/api/native" || path === "/api/http" || path === "/api/asset" || path === "/api/mirror") {
      const N = typeof Native !== "undefined" ? Native : {};
      if (!N.serveEmbed) return { status: 501, body: { error: "serveEmbed_bridge_unavailable", hint: "请在中继引擎上下文调用 (需新版 APK)" } };
      let raw = ""; try { raw = N.serveEmbed(JSON.stringify({ path: path, body: (m && m.body) || {} })); } catch (e) { return { status: 500, body: { error: String((e && e.message) || e) } }; }
      let parsed; try { parsed = JSON.parse(raw || "{}"); } catch (e) { parsed = { ok: false, error: "bad_json" }; }
      return { status: 200, body: parsed };
    }
    return { status: 404, body: { error: "not_found", path } };
  }

  // ── 统一帧处理管线 (WSS onmessage 与 serveLocal 共用) ──────────────────
  //  入站 E2E 解密 → 强制 E2E 门禁 → handleFrame → 出站重封。
  //  返回 {status, body, enc}: enc 表示该帧走了 E2E (出站 body 已是密文信封)。
  //  ③ 强制 E2E: 已配置 E2E 且用户开了「强制」时, 明文帧(未加密)被拒 → 杜绝
  //     明文驱动(如 plaintext getState) 经中继泄露账号/密码; /api/health 例外(无敏感数据, 保留存活探测)。
  async function processFrame(m) {
    if (!m || typeof m !== "object") return { status: 400, body: { error: "bad_frame" }, enc: false };
    var enc = false;
    var N = (typeof Native !== "undefined") ? Native : null;
    if (m.body && m.body.__e2e__ && N && N.e2eOpen) {
      try { var dec = N.e2eOpen(m.body.c); if (dec) { m.body = JSON.parse(dec); enc = true; } else { m.body = {}; } }
      catch (e) { m.body = {}; }
    }
    var required = false;
    try { required = !!(N && N.e2eRequired && N.e2eRequired() && N.e2eEnabled && N.e2eEnabled()); } catch (e) {}
    if (required && !enc) {
      var p = (m.path || "");
      // 门禁例外: 无账号敏感数据的存活探测 + 中枢管理/接入元数据面 (本身已受 Bearer Token 门禁,
      // 且供本机前端在开启强制 E2E 时仍能读电脑列表/取接入脚本/驱动 Cloudflare 部署)。
      var _e2eExempt = { "/api/health":1, "/api/agents":1, "/api/revoke":1, "/api/bootstrap.ps1":1, "/bootstrap.ps1":1, "/api/cf-status":1, "/api/cf-provision":1, "/api/cf-autoprovision":1 };
      if (!_e2eExempt[p]) {
        return { status: 403, body: { error: "e2e_required", hint: "本机已开启强制端到端加密: 请用 E2E Key 加密 RPC 载荷 ({__e2e__:1,c:seal(...)}) 后再发送 (明文请求已拒绝以防账号泄露)" }, enc: false };
      }
    }
    var out;
    try { out = await handleFrame(m); } catch (e) { out = { status: 500, body: { error: String((e && e.message) || e) } }; }
    var sendBody = out.body;
    // 仅对加密入站做加密出站 → 明文驱动仍得明文响应 (向后兼容)
    if (enc && N && N.e2eSeal) {
      try { var sealed = N.e2eSeal(JSON.stringify(out.body)); if (sealed) sendBody = { __e2e__: 1, c: sealed }; } catch (e) {}
    }
    return { status: out.status || 200, body: sendBody, enc: enc };
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reTimer) { clearTimeout(reTimer); reTimer = null; }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }
  function schedule() {
    if (stopped || reTimer) return;
    // 已尝试一整轮端点后再退避; 轮内快速切换下一个端点
    const oneRound = candidates.length <= 1 || (attempts % candidates.length === 0);
    const delay = oneRound ? backoff : 600;
    reTimer = setTimeout(() => { reTimer = null; if (!connected) open(); }, delay);
    if (oneRound) backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }
  function open() {
    if (stopped) return;
    if (!candidates.length) candidates = parseCandidates(cfg);
    if (!candidates.length || !cfg.token || !cfg.session) { lastError = "未配置 relay (url/token/session)"; emitStatus(); return; }
    const base = candidates[candIdx % candidates.length];
    attempts++;
    const wsUrl = base.replace(/^http/, "ws") + "/connect?session=" + encodeURIComponent(cfg.session) + "&token=" + encodeURIComponent(cfg.token);
    let mySock;
    try { mySock = new WebSocket(wsUrl); sock = mySock; } catch (e) { lastError = String((e && e.message) || e); candIdx++; probeHealth(base); schedule(); return; }
    // 连接看门狗: CONNECT_TIMEOUT 内未 open 视为该端点卡死 (GFW 常致 CONNECTING 长挂) → 关闭+切端点+重连
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (!connected && sock === mySock) {
        lastError = "连接超时 (" + shortHost(base) + " 无响应)"; probeHealth(base);
        try { mySock.close(); } catch (e) {}
        candIdx++; emitStatus(); schedule();
      }
    }, CONNECT_TIMEOUT);
    mySock.onopen = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      connected = true; backoff = BACKOFF_MIN; lastConnectTs = Date.now(); lastRxTs = Date.now(); lastError = null; activeUrl = base; emitStatus();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        // 半开死链自愈: 连续无入站(连中继自动回的 pong 都没)超阈值 → 主动关闭, 触发 onclose→重连。
        if (isHalfOpen(connected, lastRxTs, Date.now(), STALE_TIMEOUT)) {
          lastError = "心跳无回应 (疑似半开死链) → 主动重连"; emitStatus();
          try { mySock.close(); } catch (e) {}   // → onclose → schedule() 重连
          return;
        }
        try { mySock.send(JSON.stringify({ type: "ping" })); } catch (e) {}
      }, 15000);
    };
    mySock.onmessage = async (ev) => {
      lastRxTs = Date.now();   // 任何入站(含中继自动回的 pong)都刷新存活时戳 → 喂半开死链看门狗
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
      if (!m || m.type === "pong") return;
      if (m.type === "request" && m.id) {
        lastFrameTs = Date.now();
        // 入站 body 为密文信封 {__e2e__:1,c} 时由 processFrame 解密/重封 (中继全程只见密文)
        const out = await processFrame(m);
        try { mySock.send(JSON.stringify({ type: "response", id: m.id, status: out.status, body: out.body })); } catch (e) {}
      }
    };
    mySock.onclose = () => {
      if (sock !== mySock) return;
      const wasConnected = connected; connected = false;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (!wasConnected) candIdx++;   // 没连上就掉线 → 换下一个端点
      emitStatus(); schedule();
    };
    mySock.onerror = () => { if (!connected) { lastError = "WSS 握手失败 (" + shortHost(base) + ")"; } try { mySock.close(); } catch (e) {} };
  }

  // ── 路线B 本地隧道入站 ──────────────────────────────────────────────
  //  设备自带 cloudflared 快速隧道把本地 HTTP server 暴露成 https://xxx.trycloudflare.com,
  //  外部驱动直连该 URL (不经任何共享 Worker)。此处复刻 WSS onmessage 的处理:
  //  E2E 入站解密 → handleFrame → E2E 出站重封 → 返回 {status,body} 的 JSON 字符串。
  //  frameJson = {"path":"/api/rpc","method":"POST","body":{...}} (body 可为 E2E 信封)。
  async function serveLocal(frameJson) {
    let m; try { m = JSON.parse(frameJson || "{}"); } catch (e) { return JSON.stringify({ status: 400, body: { error: "bad_json" } }); }
    if (!m || typeof m !== "object") return JSON.stringify({ status: 400, body: { error: "bad_frame" } });
    lastFrameTs = Date.now();
    const out = await processFrame(m);
    // bodyText = 已序列化的 HTTP 响应体 (与 Worker 的 json(out.body) 一致); 原生层直接原样回写。
    return JSON.stringify({ status: out.status || 200, bodyText: JSON.stringify(out.body) });
  }

  return {
    register(map) { Object.assign(COMMANDS, map || {}); },
    setNetFn(fn) { cfNet = fn; },   // 测试注入 fetch (CF provisioning 切片实测用)
    setCfCookieFn(fn) { cfCookieFn = fn; },   // 测试注入 会话态 cookie 读取 (原生 Native.cookiesFor 替身)
    setCfDashFn(fn) { cfDashFn = fn; },        // 测试注入 dashboard 原生 HTTP (DaoCore.httpReq 替身)
    setCfWebMintFn(fn) { cfWebMintFn = fn; },   // 测试注入 离屏真 Chromium 同源建 Token (Native.cfWebMint 替身)
    // 纯函数·供单测直取 (会话态建 Token 编排的可验证切片)
    _cf: { pickGroups: cfPickGroups, missingGroups: cfMissingGroups, buildTokenPayload: cfBuildTokenPayload,
           pickAccount: cfPickAccount, mintViaCookie: cfMintViaCookie, autoProvisionRun: cfAutoProvisionRun },
    setStatusCb(fn) { onStatus = fn; },
    serveLocal: serveLocal,
    start(config) {
      cfg = Object.assign({}, config);
      stopped = false; backoff = BACKOFF_MIN; candIdx = 0; attempts = 0; activeUrl = null;
      candidates = parseCandidates(cfg);
      clearTimers();
      try { if (sock) sock.close(); } catch (e) {}
      open();
      return this.status();
    },
    stop() { stopped = true; clearTimers(); try { if (sock) sock.close(); } catch (e) {} connected = false; emitStatus(); },
    ensure() { if (!stopped && !connected && !reTimer && !connectTimer) open(); },
    status() {
      const primary = activeUrl || candidates[0] || (typeof cfg.url === "string" ? cfg.url.replace(/\/$/, "") : "");
      return { connected, session: cfg.session, url: primary, activeUrl, candidates: candidates.slice(), attempts,
        publicEndpoint: primary ? primary + "/relay/" + cfg.session : "", lastError, lastConnectTs, lastFrameTs, cmds: Object.keys(COMMANDS) };
    },
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = { DaoRelayApp };
