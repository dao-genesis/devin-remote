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
  ok(sessStatus({ latest_status_contents: { enum: "awaiting_user_input" } })[0] === "awaiting", "enum=awaiting → awaiting 待输入");
  ok(sessStatus({ status: "finished" })[0] === "finished", "status=finished → finished");
  ok(sessStatus({})[0] === "idle", "空对象 → idle 空闲");
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

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
