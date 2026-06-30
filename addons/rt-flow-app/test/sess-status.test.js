"use strict";
// 实测 switch.html 会话状态机真代码 (问题② 额度耗尽误判为「完成」/ 问题③ 状态准确度)。
//   切出 _lscOf + QUOTA_RE + sessStatus 函数体 eval, 断言逆流官方 latest_status_contents 各标识:
//   1) reason 命中额度耗尽 → exhausted「额度耗尽」, 绝不当 finished「完成」(即便 status=finished/suspended);
//   2) user_action_required 非空 → blocked「待处理」;
//   3) 报错/卡住 → blocked; 待输入 → awaiting; 进行中 → running; 终态 → finished;
//   4) 终态字段里藏额度信号 (status/activity_status/current_activity) 仍判 exhausted (反者道之动);
//   5) latest_status_contents 是 JSON 字符串时也能解析。
//   源级护栏: 状态传播 (_pollOneAcc 计 exhausted + 触发 _quotaAlert; trkHtml/paintRowRun 渲染; refineStuck quota→exhausted)。
// 无框架: 直接 node test/sess-status.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// 切出 _lscOf 到 sessId 之前 (含 QUOTA_RE + sessStatus)。
const seg = switchSrc.match(/function _lscOf\(s\)\{[\s\S]*?(?=function sessId)/);
if (!seg) { console.error("FAIL: 未找到 _lscOf/sessStatus 区段"); process.exit(1); }
const sessStatus = eval("(function(){\n" + seg[0] + "\nreturn sessStatus;})()");
// 同段已含账号级额度对账 quotaLive + sessStatusA (插于 sessStatus 与 sessId 之间)
const quotaLive  = eval("(function(){\n" + seg[0] + "\nreturn quotaLive;})()");
const sessStatusA = eval("(function(){\n" + seg[0] + "\nreturn sessStatusA;})()");

// ── 问题② 核心: 额度耗尽必须单列 exhausted, 绝不当「完成」 ──
{
  // 图中真实情形: 会话已 finished/suspended, 但 reason 揭示是配额耗尽
  ok(sessStatus({ status: "finished", latest_status_contents: { enum: "finished", reason: "out_of_quota" } })[0] === "exhausted",
     "finished + reason=out_of_quota → exhausted (绝不误判完成)");
  ok(sessStatus({ status: "suspended", latest_status_contents: { reason: "usage_limit_exceeded" } })[0] === "exhausted",
     "suspended + reason=usage_limit_exceeded → exhausted");
  ok(sessStatus({ latest_status_contents: { reason: "Devin went to sleep because your usage quota has been exceeded" } })[0] === "exhausted",
     "reason 含 'usage quota has been exceeded' 自然语句 → exhausted");
  ok(sessStatus({ status: "finished", latest_status_contents: { enum: "finished", reason: "task_completed" } })[0] === "finished",
     "finished + reason=task_completed (无额度信号) → finished 完成");
}

// ── 问题③ 准确度: 各状态精准区分 ──
{
  ok(sessStatus({ latest_status_contents: { enum: "running" } })[0] === "running", "enum=running → running");
  ok(sessStatus({ status: "working", activity_status: "executing" })[0] === "running", "working/executing → running");
  ok(sessStatus({ latest_status_contents: { enum: "blocked", user_action_required: "respond" } })[0] === "blocked", "user_action_required 非空 → blocked 待处理");
  ok(sessStatus({ latest_status_contents: { user_action_required: "needs_input" } })[1] === "待处理", "user_action_required → 标签 待处理");
  ok(sessStatus({ latest_status_contents: { enum: "error" } })[0] === "blocked", "enum=error → blocked 卡住");
  ok(sessStatus({ latest_status_contents: { reason: "fatal error occurred" } })[0] === "blocked", "reason 含 error → blocked");
  ok(sessStatus({ latest_status_contents: { reason: "session interrupted by user" } })[0] === "blocked", "reason 含 interrupt → blocked 中断");
  ok(sessStatus({ latest_status_contents: { reason: "connection timed out" } })[0] === "blocked", "reason 含 timed out → blocked 超时");
  ok(sessStatus({ latest_status_contents: { reason: "session disconnected" } })[0] === "blocked", "reason 含 disconnect → blocked 断连");
  ok(sessStatus({ latest_status_contents: { reason: "aborted by system" } })[0] === "blocked", "reason 含 abort → blocked 中止");
  ok(sessStatus({ latest_status_contents: { enum: "timeout" } })[0] === "blocked", "enum=timeout → blocked 超时");
  ok(sessStatus({ latest_status_contents: { reason: "limit reached for this period" } })[0] === "exhausted", "reason 含 limit.*reach → exhausted");
  ok(sessStatus({ latest_status_contents: { reason: "no credits remaining" } })[0] === "exhausted", "reason 含 no.*remain → exhausted (二次检测)");
  ok(sessStatus({ latest_status_contents: { enum: "awaiting_user_input" } })[0] === "awaiting", "enum=awaiting → awaiting 待输入");
  ok(sessStatus({ status: "finished" })[0] === "finished", "status=finished → finished");
  ok(sessStatus({})[0] === "idle", "空对象 → idle 空闲");
}

// ── 新增: 中断/超时/断连 等非正常终止检测 (用户反馈: 对话中断后很久才识别) ──
{
  ok(sessStatus({ latest_status_contents: { enum: "interrupted" } })[0] === "blocked", "enum=interrupted → blocked");
  ok(sessStatus({ latest_status_contents: { reason: "timeout while waiting for response" } })[0] === "blocked", "reason 含 timeout → blocked");
  ok(sessStatus({ latest_status_contents: { reason: "connection aborted" } })[0] === "blocked", "reason 含 abort → blocked");
}

// ── 根因修复: en="blocked" 不得在 ③ 处短路, 须让 reason 决定精确分类 ──
//   旧版 ③ 把 reason 报错 与 en 卡住 合在同一 || 中: en="blocked" 命中即返回 blocked,
//   致 ③b(额度二次) 与 ④(待输入) 永远跑不到 → 阻塞中实为「待输入/额度耗尽」者被误标「卡住」。
{
  // en=blocked + reason 揭示额度 → 应 exhausted (不是 blocked)
  ok(sessStatus({ status_enum: "blocked", latest_status_contents: { enum: "blocked", reason: "credit limit reached" } })[0] === "exhausted",
     "en=blocked + reason='credit limit reached' → exhausted (③b 不被 en 短路)");
  ok(sessStatus({ status_enum: "blocked", latest_status_contents: { enum: "blocked", reason: "allowance depleted" } })[0] === "exhausted",
     "en=blocked + reason='allowance depleted' → exhausted");
  // en=blocked + reason 揭示待输入 → 应 awaiting (不是 blocked)
  ok(sessStatus({ status_enum: "blocked", latest_status_contents: { enum: "blocked", reason: "waiting for user input" } })[0] === "awaiting",
     "en=blocked + reason='waiting for user input' → awaiting (④ 不被 en 短路)");
  ok(sessStatus({ status_enum: "blocked", latest_status_contents: { enum: "blocked", reason: "asking the user a question" } })[0] === "awaiting",
     "en=blocked + reason='asking the user a question' → awaiting");
  // en=blocked + reason 空 / 无具体分类 → 仍兜底 blocked (③c)
  ok(sessStatus({ status_enum: "blocked", latest_status_contents: { enum: "blocked" } })[0] === "blocked",
     "en=blocked + reason 空 → blocked 兜底(③c)");
  ok(sessStatus({ status_enum: "blocked", latest_status_contents: { enum: "blocked", reason: "internal error" } })[0] === "blocked",
     "en=blocked + reason='internal error' → blocked (③ reason 报错)");
}

// ── 反者道之动: 终态但额度信号藏在 status/activity/current_activity ──
{
  ok(sessStatus({ status: "suspended out_of_quota", latest_status_contents: { enum: "suspended" } })[0] === "exhausted",
     "终态 + status 串含额度信号 → exhausted");
  ok(sessStatus({ status: "finished", activity_status: "no credit remaining", latest_status_contents: { enum: "finished" } })[0] === "exhausted",
     "终态 + activity_status 含 'no credit' → exhausted");
}

// ── 优先级: 额度耗尽 > 待处理 (即便两信号同现) ──
{
  ok(sessStatus({ latest_status_contents: { reason: "out_of_quota", user_action_required: "respond" } })[0] === "exhausted",
     "reason 额度 + user_action_required 同现 → 额度耗尽优先");
}

// ── latest_status_contents 为 JSON 字符串 ──
{
  ok(sessStatus({ latest_status_contents: JSON.stringify({ reason: "out_of_quota" }) })[0] === "exhausted",
     "latest_status_contents 是 JSON 字符串也能解析 → exhausted");
}

// ══ 账号级额度对账 (本轮根因·根治「满额号被陈旧会话 reason=out_of_quota 误标额度耗尽」) ══
// quotaLive: 实时额度判活
{
  ok(quotaLive({ dPct: 100, overageDollars: 68.57 }) === true, "dPct=100 满额 + $68.57 → 有额度(true)");
  ok(quotaLive({ dPct: 100, overageDollars: 0 }) === true, "dPct=100 (日免费配额满) 即便 $0 → 有额度(true·可用免费配额)");
  ok(quotaLive({ dPct: 0, wPct: 30, overageDollars: 0 }) === true, "日配额耗尽但周配额 30% 余 → 有额度(true)");
  ok(quotaLive({ dPct: 0, wPct: 0, overageDollars: 12.5 }) === true, "日/周配额耗尽但 $12.5 余 → 有额度(true)");
  ok(quotaLive({ dPct: 0, wPct: 0, overageDollars: 0 }) === false, "日/周配额=0 且 $0 → 确无额度(false·真耗尽)");
  ok(quotaLive({ dPct: 0 }) === null, "dPct=0 但美金未知 → 不确定(null·保守)");
  ok(quotaLive({}) === null, "无任何额度字段 → 不确定(null)");
  ok(quotaLive(null) === null, "quota 缺失 → null");
}
// sessStatusA: 账号实时额度纠偏陈旧会话原因
{
  const sleptConv = { status: "suspended", latest_status_contents: { reason: "out_of_quota" } };
  ok(sessStatus(sleptConv)[0] === "exhausted", "前提: 该会话裸判(无账号上下文) = exhausted");
  ok(sessStatusA(sleptConv, { quota: { dPct: 100, overageDollars: 68.57 } })[0] === "finished",
     "核心: 满额$68的号·会话历史 out_of_quota → 对账降级为 finished (不误标额度耗尽)");
  ok(sessStatusA(sleptConv, { quota: { dPct: 100, overageDollars: 0 } })[0] === "finished",
     "dPct=100 日免费配额满 → 降级 finished (即便 $0)");
  ok(sessStatusA(sleptConv, { quota: { dPct: 0, wPct: 0, overageDollars: 0 } })[0] === "exhausted",
     "真耗尽号(日/周=0·$0) → 保留 exhausted 额度耗尽");
  ok(sessStatusA(sleptConv, { quota: { dPct: 0 } })[0] === "exhausted",
     "额度未知(null·保守) → 保留官方 exhausted 信号");
  ok(sessStatusA(sleptConv, null)[0] === "exhausted", "无账号上下文 → 保留 exhausted");
  // 非耗尽分类不受影响
  ok(sessStatusA({ latest_status_contents: { enum: "running" } }, { quota: { dPct: 100 } })[0] === "running",
     "running 会话不受额度对账影响");
  ok(sessStatusA({ latest_status_contents: { user_action_required: "respond" } }, { quota: { dPct: 100 } })[0] === "blocked",
     "blocked/待处理 不受额度对账影响");
}
// 源级护栏: 各聚合站点确实走账号级对账 (满额号绝不误报)
ok(/function quotaLive\(q\)\{/.test(switchSrc) && /function sessStatusA\(s,acct\)\{/.test(switchSrc),
   "源级: switch.html 内联 quotaLive + sessStatusA 账号级对账");
ok(/var c=sessStatusA\(s,a\)\[0\]/.test(switchSrc),
   "源级: dvOverviewHtml 统计走 sessStatusA(账号级对账)");
ok(/var ssr=sessStatusA\(s,a\);/.test(switchSrc),
   "源级: _pollOneAcc(通知源) 走 sessStatusA → 满额号不触发 _quotaAlert");
// (devin-cloud.js / engine.html 的账号级对账源级护栏在文件末尾 cloudSrc/engineSrc 声明后断言)

// ── 源级护栏: 状态变化即时通知 (对话中断/卡住/额度耗尽即时弹通知) ──
ok(/function _stateChangeAlert\(a, item\)/.test(switchSrc),
   "源级: 存在 _stateChangeAlert 状态变化即时通知函数");
ok(/_stateAlertTs\[key\]/.test(switchSrc),
   "源级: _stateChangeAlert 按 uuid+cls 节流 (2分钟不重复)");
ok(/items\.forEach\(function\(it\)\{ if\(it\.cls==="blocked"\|\|it\.cls==="exhausted"\) try\{ _stateChangeAlert/.test(switchSrc),
   "源级: _pollOneAcc 对 blocked/exhausted 项即时触发 _stateChangeAlert");
ok(/if\(!wasBlocked\) try\{ _stateChangeAlert/.test(switchSrc),
   "源级: _applyFresh(网页镜像端) 新出现的 blocked/exhausted 触发 _stateChangeAlert");

// ── 源级护栏: 状态传播链完整 ──
ok(/cls!=="running"&&cls!=="awaiting"&&cls!=="blocked"&&cls!=="exhausted"/.test(switchSrc),
   "源级: _pollOneAcc 收集 exhausted 项 (不被过滤丢弃)");
ok(/if\(exhausted>0\)\{[\s\S]*?_quotaAlert\(a,exhausted,/.test(switchSrc),
   "源级: _pollOneAcc 检测到 exhausted 即触发 _quotaAlert(带对话名)");
ok(/function _quotaAlert\(a, cnt, convName\)/.test(switchSrc),
   "源级: 存在额度耗尽通知函数 _quotaAlert(消息主体用对话名)");
ok(/_quotaAlertTs\[a\.id\]/.test(switchSrc),
   "源级: _quotaAlert 按账号节流 (_quotaAlertTs)");
ok(/totalExh\+=\(st\.exhausted\|\|0\)/.test(switchSrc),
   "源级: trkHtml 汇总 exhausted 计数");
ok(/额度耗尽<b style="color:#ff9d4d">'\+totalExh/.test(switchSrc),
   "源级: trkHtml 顶栏显示「额度耗尽」橙色计数");
ok(/it\.cls==="exhausted"\?"exhausted"/.test(switchSrc),
   "源级: trkHtml 行项映射 exhausted CSS 类");
ok(/st\.exhausted\?'<span class="exh"/.test(switchSrc) || /\(st\.exhausted\|\|0\)\?'<span class="exh"/.test(switchSrc),
   "源级: paintRowRun 行内显示 exhausted 指示");
ok(/rec\.reason==="quota"\)\?"exhausted":"blocked"/.test(switchSrc),
   "源级: refineStuck 事件流命中额度 → exhausted (而非 blocked)");

// ── 源级护栏: 标签/通知「最新对话名优先」(用户要求·防漂移) ──
ok(/function _sessTs\(s\)/.test(switchSrc),
   "源级: 存在 _sessTs 会话活跃时间戳解析(择取最新对话)");
ok(/var latestName="", latestTs=-1/.test(switchSrc),
   "源级: _pollOneAcc 计算该账号最新对话名 latestName");
ok(/var nm = top \? \(top\.title\|\|""\) : latestName/.test(switchSrc),
   "源级: 无需关注对话时标签回退「最新对话名」而非空(空才由原生回退账号名)");
ok(/items:items,latest:latestName/.test(switchSrc) && /items:\[\],latest:latestName/.test(switchSrc),
   "源级: _trk 持久化 latest(活跃与墓碑两态皆带最新对话名)");
ok(/else \{ nm=st\.latest\|\|""; stt="finished"; if\(!nm\) return; \}/.test(switchSrc),
   "源级: _repushTabsFromTrk 空闲账号即刻重显缓存最新对话名");
ok(/function _convNameOf\(a\)/.test(switchSrc),
   "源级: 存在 _convNameOf 统一取「对话名为消息主体」");
ok(/_bigAlert\("⚠ "\+_convNameOf\(a\)\+" 额度仅/.test(switchSrc),
   "源级: 低额提醒以对话名为主体(不前缀账号名)");

// 设备态刷新: 已移出金库的号连墓碑一并清除 → _trk 号数与金库恒等(不积陈迹·知止不殆)
ok(/loadAcc\(\)\.forEach\(function\(a\)\{ var k=String\(\(a&&\(a\.email\|\|a\.id\)\)\|\|""\)\.toLowerCase\(\)/.test(switchSrc),
   "源级: _deviceRecentRefresh 以金库邮箱集为准");
ok(/if\(_vn && !_vault\[e\] && !fresh\[e\]\)\{ delete _trk\[e\]; return; \}/.test(switchSrc),
   "源级: _trk 中不在金库且本轮无 active 的陈迹号被剪除(号数与金库齐平)");

// 设备态刷新看门狗: 中继久悬不决时硬期限强制解锁 _devRecentBusy → 刷新永不被单次悬挂永久拖死(失同步之根)
ok(/var _rbWatch=setTimeout\(function\(\)\{ _devRecentBusy=false;/.test(switchSrc),
   "源级: _deviceRecentRefresh 设独立看门狗硬期限解锁 busy(防永久卡死刷新)");
ok(/function _rbDone\(\)\{ try\{ clearTimeout\(_rbWatch\); \}catch\(_e\)\{\} _devRecentBusy=false; \}/.test(switchSrc) &&
   /\}, function\(\)\{ _rbDone\(\);/.test(switchSrc),
   "源级: 成功/失败两路均经 _rbDone 清看门狗并解锁(不重复·不遗漏)");

// ── 公网单网页 ≈ APK 数据齐平: 四处收口护栏 (本轮 v0.37.100) ──────────────────
const cloudSrc  = fs.readFileSync(path.join(ENGINE, "devin-cloud.js"), "utf8");
const engineSrc = fs.readFileSync(path.join(ENGINE, "engine.html"), "utf8");
const daopanSrc = fs.readFileSync(path.join(ENGINE, "daopan.html"), "utf8");
const consoleSrc= fs.readFileSync(path.join(ENGINE, "console.html"), "utf8");

// ① canonical sessStatus 为共享单一真源 (web/device 共用 → 与 APK 完全一致)
ok(/function sessStatus\(s\)/.test(cloudSrc) && /sessStatus:\s*sessStatus/.test(cloudSrc),
   "源级: devin-cloud.js 导出 canonical sessStatus (单一真源)");
// ①' 账号级额度对账跨文件护栏 (本轮根因·此处 cloudSrc/engineSrc 已声明)
ok(/function quotaLive\(q\)/.test(cloudSrc) && /quotaLive:\s*quotaLive,\s*sessStatusA:\s*sessStatusA/.test(cloudSrc),
   "源级: devin-cloud.js 导出 canonical quotaLive + sessStatusA");
ok(/DaoCloud\.sessStatusA\?DaoCloud\.sessStatusA\(s,u\.a\)/.test(engineSrc),
   "源级: engine.html recentConvAll 每条走账号级对账 sessStatusA(满额号不误标耗尽)");
ok(/var _qLive=\(DaoCloud\.quotaLive\?DaoCloud\.quotaLive\(acc\.quota\)/.test(engineSrc) &&
   /QUOTA_RE\.test\(qsig\) && qLive!==true/.test(engineSrc),
   "源级: engine.html convReasonOf 满额号(quotaLive===true)不计 quota 耗尽");
{
  const seg3 = cloudSrc.match(/function quotaLive\(q\)[\s\S]*?\n\s*(?=root\.DaoCloud)/);
  if (!seg3) { console.error("FAIL: devin-cloud.js 未找到 quotaLive/sessStatusA 区段"); process.exit(1); }
  const cloudQuotaLive = eval("(function(){\n" + seg3[0] + "\nreturn quotaLive;})()");
  ok(cloudQuotaLive({ dPct: 100, overageDollars: 68.57 }) === true, "devin-cloud.quotaLive: 满额 → true");
  ok(cloudQuotaLive({ dPct: 0, wPct: 0, overageDollars: 0 }) === false, "devin-cloud.quotaLive: 真耗尽 → false");
  ok(cloudQuotaLive({ dPct: 0 }) === null, "devin-cloud.quotaLive: 美金未知 → null (保守)");
}
{
  const seg2 = cloudSrc.match(/var QUOTA_RE\s*=[\s\S]*?\n\s*(?=root\.DaoCloud)/);
  if (!seg2) { console.error("FAIL: devin-cloud.js 未找到 sessStatus 区段"); process.exit(1); }
  const ss = eval("(function(){\n" + seg2[0] + "\nreturn sessStatus;})()");
  ok(ss({ status:"finished", latest_status_contents:{ reason:"out_of_quota" } })[0] === "exhausted",
     "devin-cloud.sessStatus: finished+out_of_quota → exhausted (与 switch.html 同判)");
  ok(ss({ latest_status_contents:{ user_action_required:true } })[0] === "blocked",
     "devin-cloud.sessStatus: user_action_required → blocked");
  ok(ss({ latest_status_contents:{ enum:"running" } })[0] === "running",
     "devin-cloud.sessStatus: enum=running → running");
  // 同根因修复: en=blocked 不短路, reason 决定精确分类
  ok(ss({ latest_status_contents:{ enum:"blocked", reason:"credit limit reached" } })[0] === "exhausted",
     "devin-cloud.sessStatus: en=blocked + reason 额度 → exhausted (不被 en 短路)");
  ok(ss({ latest_status_contents:{ enum:"blocked", reason:"waiting for user input" } })[0] === "awaiting",
     "devin-cloud.sessStatus: en=blocked + reason 待输入 → awaiting");
  ok(ss({ latest_status_contents:{ enum:"blocked" } })[0] === "blocked",
     "devin-cloud.sessStatus: en=blocked + reason 空 → blocked 兜底");
}

// ② engine.html 设备命令 recentConvAll: 原生 6 路并发聚合一次返回, 每条带 canonical [cls,label]
ok(/recentConvAll:\s*async function\(a\)/.test(engineSrc),
   "源级: engine.html 存在设备命令 recentConvAll (原生跨号聚合)");
ok(/DaoCloud\.sessStatus\?DaoCloud\.sessStatus\(s\)/.test(engineSrc),
   "源级: recentConvAll 每条带 canonical sessStatus 的 [cls,label]");
ok(/return\s*\{\s*ok:true,\s*total:[\s\S]*?list:\s*out\.slice/.test(engineSrc),
   "源级: recentConvAll 返回 {ok,total,accounts,list} 一帧取齐");

// ③ daopan.html 公网端: 一次 RPC 从设备聚合 (秒出·不再逐号穿透卡 0/N)
ok(/function _relayRPC\(cmd, args, timeoutMs\)/.test(daopanSrc) && /__rtRelay/.test(daopanSrc),
   "源级: daopan.html _relayRPC 经父页失效转移通道 __rtRelay 调设备命令");
ok(/async function _recentViaDevice\(\)/.test(daopanSrc) && /recentConvAll/.test(daopanSrc),
   "源级: daopan.html _recentViaDevice 调 recentConvAll");
ok(/if\(IS_WEB\)\{\s*try\{\s*if\(await _recentViaDevice\(\)\)\{\s*_busy=false;\s*return;\s*\}/.test(daopanSrc),
   "源级: loadRecent 公网优先一次 RPC 聚合, 失败再回退逐号 (兜底)");
ok(/it\.cls\|\|stClass\(it\.status\)/.test(daopanSrc) && /it\.label\|\|it\.status/.test(daopanSrc),
   "源级: daopan 渲染用 canonical cls/label (回退旧 stClass)");

// ④ console.html 上传通道收口: 跨标签解析目标 + drop 事件兜底
ok(/function _uploadTargetTab\(\)/.test(consoleSrc),
   "源级: console.html _uploadTargetTab 遍历所有 web 标签 (不死盯活动标签)");
ok(/for\(var i=tabs\.length-1;i>=0;i--\)\{ var x=tabs\[i\]; if\(x&&x\.kind==="web"&&_docOf\(x\)\) return x;/.test(consoleSrc),
   "源级: _uploadTargetTab 回退最近一个可同源注入的 web 标签");
ok(/function _fireDrop\(win, doc, file\)/.test(consoleSrc) && /\["dragenter","dragover","drop"\]/.test(consoleSrc),
   "源级: console.html _fireDrop 对输入区派发 DataTransfer drop 兜底 (无 input 时)");
ok(/}\s*else if\(_fireDrop\(win, doc, file\)\)\{/.test(consoleSrc),
   "源级: injectFileToActiveTab 无 <input type=file> 时走 _fireDrop 兜底");
ok(/if\(tabs\[active\]!==t\)\{ try\{ selectTab\(t\.id\)/.test(consoleSrc),
   "源级: 注入前切到目标标签让用户看见落入 (全服通悬浮窗覆盖切号面板时仍准)");

// ⑤ SWR 热刷新: 后台重验内容变化时自动重建板块 iframe (开即最新·根治「更新后仍坏」)
ok(/var ASSET_REVAL_MS\s*=\s*5\*1000/.test(consoleSrc),
   "源级: console.html ASSET_REVAL_MS = 5s (缩短重验阈值·快速检测部署更新)");
ok(/function _hotReloadBoard\(file\)/.test(consoleSrc),
   "源级: console.html 存在 _hotReloadBoard (重验发现变化时就地热刷板块 iframe)");
ok(/if\(prev!=null && prev!==txt\) _hotReloadBoard\(name\)/.test(consoleSrc),
   "源级: _netAsset 重验后比对内容·变化时触发热刷 (道法自然·更新后开即新)");

// ══ 对话生命周期分类器 (本轮根因·纯函数单测·正本清源) ══════════════════════════
//   engine.html 新增 convReasonOf(活跃 reason 或 "")/convTerminalOf(精确终态), 切片哨兵 _convClassifyEnd 之前。
//   切出函数体 eval, 断言: 活跃判分(quota/action_required/blocked/awaiting/running) 与 switch.html sessStatus 同源;
//   终态判分(interrupted/expired/suspended/stopped/archived/finished) 精确分流 → tick 据此发不同「已结束」通知。
{
  const segC = engineSrc.match(/function convReasonOf\(s, o, qLive\)\{[\s\S]*?(?=function _convClassifyEnd)/);
  if (!segC) { console.error("FAIL: engine.html 未找到 convReasonOf/convTerminalOf 区段"); process.exit(1); }
  const convReasonOf   = eval("(function(){\n" + segC[0] + "\nreturn convReasonOf;})()");
  const convTerminalOf = eval("(function(){\n" + segC[0] + "\nreturn convTerminalOf;})()");

  // —— 活跃态分类 (返回 reason 非空 → 仍在追踪) ——
  ok(convReasonOf({ status:"finished" }, { enum:"finished", reason:"out_of_quota" }, false) === "quota",
     "convReasonOf: reason=out_of_quota + 账号无实时额度 → quota");
  ok(convReasonOf({ status:"finished" }, { enum:"finished", reason:"out_of_quota" }, true) === "",
     "convReasonOf: reason=out_of_quota 但账号满额(qLive=true) → 不计 quota(返回 '')");
  ok(convReasonOf({}, { user_action_required:"respond" }, null) === "action_required",
     "convReasonOf: user_action_required 非空 → action_required");
  ok(convReasonOf({}, { reason:"fatal error occurred" }, null) === "blocked",
     "convReasonOf: reason 含 error → blocked");
  ok(convReasonOf({}, { reason:"session interrupted by user" }, null) === "blocked",
     "convReasonOf: reason 含 interrupt → blocked");
  ok(convReasonOf({}, { enum:"awaiting_user_input" }, null) === "awaiting",
     "convReasonOf: enum=awaiting → awaiting");
  ok(convReasonOf({}, { reason:"waiting for user input" }, null) === "awaiting",
     "convReasonOf: reason 待输入 → awaiting");
  ok(convReasonOf({ status:"working" }, { enum:"running" }, null) === "running",
     "convReasonOf: enum=running → running");
  ok(convReasonOf({}, { enum:"blocked" }, null) === "blocked",
     "convReasonOf: enum=blocked + reason 空 → blocked 兜底");
  // —— 续跑/思考/流式 等活跃枚举 (本轮根因: 旧版仅认 run|working|active|execut → 续跑对话不亮绿灯) ——
  ok(convReasonOf({}, { enum:"resumed" }, null) === "running",
     "convReasonOf: enum=resumed(续跑) → running (根治续跑不亮绿灯)");
  ok(convReasonOf({}, { enum:"in_progress" }, null) === "running",
     "convReasonOf: enum=in_progress → running");
  ok(convReasonOf({}, { enum:"thinking" }, null) === "running",
     "convReasonOf: enum=thinking → running");
  ok(convReasonOf({}, { enum:"streaming" }, null) === "running",
     "convReasonOf: enum=streaming → running");
  ok(convReasonOf({ activity_status:"coding" }, {}, null) === "running",
     "convReasonOf: activity_status=coding(顶层活动字段) → running (与 sessStatus 同源查活动字段)");
  ok(convReasonOf({ current_activity:"started" }, {}, null) === "running",
     "convReasonOf: current_activity=started → running");
  // 续跑判活优先于「曾完成」叙事: 续跑后 enum 非终态即判活, 终态字段才归 ''
  ok(convReasonOf({}, { enum:"in_progress", reason:"resumed after completion" }, null) === "running",
     "convReasonOf: in_progress(续跑) 即便 reason 提及 completion 也判 running(枚举非终态)");
  // 终态/空 → 返回 ""(非活跃·交 convTerminalOf 判终态)
  ok(convReasonOf({ status:"finished" }, { enum:"finished", reason:"task_completed" }, null) === "",
     "convReasonOf: 正常完成(无活跃信号) → '' (转终态判定)");
  ok(convReasonOf({ status:"expired" }, { enum:"expired" }, null) === "",
     "convReasonOf: expired → '' (转终态判定)");
  ok(convReasonOf({}, {}, null) === "", "convReasonOf: 空 → ''");

  // —— 终态精确分流 (convReasonOf 返回 '' 后调用) ——
  ok(convTerminalOf({ status:"finished" }, { enum:"finished", reason:"crashed unexpectedly" }) === "interrupted",
     "convTerminalOf: reason 含 crash → interrupted 中断");
  ok(convTerminalOf({ status:"finished" }, { reason:"connection timeout" }) === "interrupted",
     "convTerminalOf: reason 含 timeout → interrupted");
  ok(convTerminalOf({ status:"expired" }, { enum:"expired" }) === "expired",
     "convTerminalOf: status/enum=expired → expired 过期");
  ok(convTerminalOf({ status:"suspended" }, { reason:"user_inactivity" }) === "suspended",
     "convTerminalOf: suspended/user_inactivity → suspended 挂起");
  ok(convTerminalOf({ is_archived:true }, { enum:"finished" }) === "archived",
     "convTerminalOf: is_archived=true → archived 归档");
  ok(convTerminalOf({ status:"finished" }, { reason:"cancelled by user" }) === "stopped",
     "convTerminalOf: reason 含 cancel → stopped 停止");
  ok(convTerminalOf({ status:"finished" }, { enum:"finished", reason:"task_completed" }) === "finished",
     "convTerminalOf: 正常完成 → finished");
  ok(convTerminalOf({}, {}) === "finished", "convTerminalOf: 无信号 → finished 兜底");
  // 优先级: 中断 > 过期 > 挂起 > 归档 > 停止 > 完成
  ok(convTerminalOf({ status:"expired" }, { reason:"crashed" }) === "interrupted",
     "convTerminalOf: 中断信号优先于 expired 顶层");
}

// ── 源级护栏: trackStuck 闭环结束反馈 (ended/scanned 返回·watchSids 入参) ──
ok(/trackStuck:\s*async function\(opt\)/.test(engineSrc),
   "源级: trackStuck 接受 opt 入参");
ok(/var watch=Object\.create\(null\); \(opt&&opt\.watchSids\|\|\[\]\)\.forEach/.test(engineSrc),
   "源级: trackStuck 从 opt.watchSids 建上轮追踪 sid 集(只对其登记终态)");
ok(/var ended=\[\], scanned=Object\.create\(null\)/.test(engineSrc),
   "源级: trackStuck 维护 ended(曾追踪→终态) + scanned(本轮扫描成功账号)");
ok(/scanned\[String\(acc\.email\|\|""\)\.toLowerCase\(\)\]=1/.test(engineSrc),
   "源级: scanAcc 成功即登记 scanned (供 tick 结束判定门控·防扫描失败误报)");
ok(/var reason=convReasonOf\(s, o, _qLive\)/.test(engineSrc),
   "源级: scanAcc 用 convReasonOf 判活跃 reason");
ok(/\} else if\(watch\[sid\]\)\{[\s\S]*?ended\.push\(\{[\s\S]*?term:convTerminalOf\(s,o\)\}\)/.test(engineSrc),
   "源级: 上轮追踪、本轮非活跃 → ended.push 精确终态 convTerminalOf");
ok(/return \{ok:true, count:hits\.length, actionRequired:need\.length, needAttention:need, sessions:hits, ended:ended, scanned:Object\.keys\(scanned\)\}/.test(engineSrc),
   "源级: trackStuck 返回 sessions + ended + scanned");

// ── 源级护栏: tick 闭环 (新对话/新内容/精确终态/扫描门控) ──
ok(/var coldStart = !prev \|\| !Object\.keys\(prev\)\.length/.test(engineSrc),
   "源级: tick 冷启判定(prev 空只播种·不刷屏「新对话」)");
ok(/CMDS\.trackStuck\(\{ watchSids: Object\.keys\(prev\) \}\)/.test(engineSrc),
   "源级: tick 把上轮 sid 集作为 watchSids 传入 trackStuck");
ok(/\(r\.scanned\|\|\[\]\)\.forEach\(function\(e\)\{ scanned\[String\(e\)\.toLowerCase\(\)\]=1; \}\)/.test(engineSrc),
   "源级: tick 提取 r.scanned 成功账号集(门控结束判定)");
// 新对话/续跑/新内容 → 仅追踪+标签变绿·不发消息提示(用户要求·静默)。next[sid] 登记状态供金库/网页镜像。
ok(/next\[sid\] = \{ phase: c\.phase, title: c\.title, email: c\.email, ts: now, msgId: c\.msgId, reason: c\.reason \}/.test(engineSrc),
   "源级: tick 仍登记 next[sid] 状态(驱动标签变绿·与通知解耦)");
ok(!/🆕 新对话/.test(engineSrc),
   "源级: 新对话静默·不发 🆕 通知(用户要求·只追踪+变绿)");
ok(!/🟢 对话继续/.test(engineSrc),
   "源级: 续跑复活静默·不发 🟢 通知(状态反映由 next[sid]+金库复活剪枝承担)");
ok(!/💬 已继续/.test(engineSrc),
   "源级: 新内容静默·不发 💬 通知(用户要求·不刷屏)");
// 金库续跑剪枝: 复活会话即刻从「最近结束」撤销
ok(/var activeSids=Object\.create\(null\); \(sessions\|\|\[\]\)\.forEach\(function\(s\)\{ if\(s&&s\.sid\) activeSids\[s\.sid\]=1; \}\)/.test(engineSrc),
   "源级: _mirrorTickToVault 收集本轮活跃 sid 集(供续跑剪枝)");
ok(/if\(activeSids\[k\] \|\| now-\(\(ev\[k\]&&ev\[k\]\.ts\)\|\|0\)>=ENDED_HOLD_MS\) delete ev\[k\]/.test(engineSrc),
   "源级: 续跑会话即刻从 rtflow.trk.ended 撤销终态(根治「续跑仍显示已结束」)");

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
