"use strict";
// 实测 switch.html「重下载仅 WiFi」门控 (道法自然·省移动数据·功能全不变)。
//   决策: 高消耗的**自动**重下载(自动备份心跳 + 自动清理前置的完整备份)默认仅在 WiFi/不计费网络进行;
//   用户可关掉「仅WiFi自动备份」放开蜂窝; 一切**手动**(全部备份/导出全部对话/批量清理前置备份/备份库
//   下载ZIP·打开MD)恒不受限; 识别不到网络(网页外壳无原生桥/旧原生)→ 保守放行, 绝不误伤既有功能。
//   本测从真 switch.html 抽取 _cfg/_setCfg/_netInfo/_autoDlBlocked 于 vm 内实跑门控逻辑, 再加源级护栏
//   (自动路径有门控·手动路径无门控·原生 netInfo 桥就位·UI 开关就位)。无框架: node 直跑, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");
const javaSrc = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 从真 switch.html 抽取门控相关函数, 在 vm 内以真源实跑 (不复制逻辑, 防漂移) ──
function grab(re, label) { const m = switchSrc.match(re); if (!m) { failures++; console.error("  FAIL- 抽取失败: " + label); return ""; } return m[0]; }
const srcCfg      = grab(/function _cfg\(k,d\)\{[^\n]*\}/,        "_cfg");
const srcSetCfg   = grab(/function _setCfg\(k,v\)\{[^\n]*\}/,     "_setCfg");
const srcNetInfo  = grab(/function _netInfo\(\)\{[^\n]*\}/,       "_netInfo");
const srcBlocked  = grab(/function _autoDlBlocked\(\)\{[\s\S]*?\n\}/, "_autoDlBlocked");

const store = Object.create(null);
const sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON,
  localStorage: {
    getItem: function (k) { return (k in store) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  },
  N: {}   // 默认: 无 netInfo 原生桥 (模拟网页外壳/旧原生)
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext([srcCfg, srcSetCfg, srcNetInfo, srcBlocked].join("\n"), sandbox);
const { _cfg, _setCfg, _autoDlBlocked } = sandbox;
ok(typeof _autoDlBlocked === "function", "抽取 _autoDlBlocked/_cfg/_netInfo 装载");

// 默认: autoBackupWifiOnly 未设 → 默认 true (省移动数据为默认姿态)
ok(_cfg("autoBackupWifiOnly", true) === true, "默认「仅WiFi自动备份」=开 (未设即省流量)");

// 情形1: 默认(仅WiFi) + 明确计费网络(蜂窝) → 拦自动重下载
sandbox.N.netInfo = function () { return JSON.stringify({ metered: true, type: "cellular", online: true }); };
ok(_autoDlBlocked() === true, "仅WiFi + 蜂窝(metered) → 自动重下载被拦");

// 情形2: 默认(仅WiFi) + WiFi/不计费 → 放行
sandbox.N.netInfo = function () { return JSON.stringify({ metered: false, type: "wifi", online: true }); };
ok(_autoDlBlocked() === false, "仅WiFi + WiFi(非计费) → 放行");

// 情形3: 默认(仅WiFi) + 无原生桥(网页外壳/旧原生, 识别不到) → 保守放行 (绝不误伤功能)
delete sandbox.N.netInfo;
ok(_autoDlBlocked() === false, "仅WiFi + 无 netInfo 桥(未知网络) → 保守放行");

// 情形4: 用户放开蜂窝(关掉仅WiFi) + 蜂窝 → 从不拦
_setCfg("autoBackupWifiOnly", false);
sandbox.N.netInfo = function () { return JSON.stringify({ metered: true, type: "cellular", online: true }); };
ok(_autoDlBlocked() === false, "关掉仅WiFi(允许蜂窝) + 蜂窝 → 从不拦(用户可调)");
_setCfg("autoBackupWifiOnly", true);

// 情形5: metered 严格 === true 才拦 (缺字段/非布尔 → 放行, 防误伤)
sandbox.N.netInfo = function () { return JSON.stringify({ type: "unknown" }); };
ok(_autoDlBlocked() === false, "metered 缺失(非明确计费) → 放行");

// ── 源级护栏: 自动路径有门控 ──
ok(/async function autoBackupTick\(\)\{[\s\S]{0,400}?_autoDlBlocked\(\)\)\s*return/.test(switchSrc),
   "源级: 自动备份心跳 autoBackupTick 前置 _autoDlBlocked 门控");
ok(/if\(!force && _autoDlBlocked\(\)\) return/.test(switchSrc),
   "源级: autoCleanFor 仅在**自动**(!force)时门控 (手动 force=true 不受限)");
ok(/return _netInfo\(\)\.metered===true/.test(switchSrc),
   "源级: 仅在**明确**计费网络(metered===true)拦; 非计费/未知放行");

// ── 源级护栏: 手动路径**无**门控 (恒不受限) ──
const manualBlock = switchSrc.slice(switchSrc.indexOf("async function fullBackupAccount("), switchSrc.indexOf("async function autoCleanFor("));
ok(manualBlock.indexOf("fullBackupAccount") >= 0 && manualBlock.indexOf("_autoDlBlocked") < 0,
   "源级: fullBackupAccount(手动全部备份/导出/批量清理前置) 不含 _autoDlBlocked → 手动恒不受限");
ok(/async function dvBackupAll\(\)\{[\s\S]*?\}/.test(switchSrc) && !/dvBackupAll[\s\S]{0,600}_autoDlBlocked/.test(switchSrc),
   "源级: 手动「全部备份」dvBackupAll 不含门控");

// ── 源级护栏: UI 开关 + 初始化 ──
ok(/id="dvBkWifiOnly"[\s\S]{0,80}dvToggleBkWifiOnly/.test(switchSrc), "源级: 存在「仅WiFi自动备份」开关(dvBkWifiOnly)");
ok(/function dvToggleBkWifiOnly\(v\)\{[\s\S]*?autoBackupWifiOnly/.test(switchSrc), "源级: 开关写回 cfg.autoBackupWifiOnly");
ok(/getElementById\("dvBkWifiOnly"\)[\s\S]{0,60}_cfg\("autoBackupWifiOnly",true\)/.test(switchSrc), "源级: _initCfgUI 回显开关(默认开)");

// ── 源级护栏: 原生 netInfo 桥 ──
ok(/@JavascriptInterface public String netInfo\(\)/.test(javaSrc), "源级: 原生 Native.netInfo() 桥就位");
ok(/String netInfoJson\(\)/.test(javaSrc) && /isActiveNetworkMetered\(\)/.test(javaSrc),
   "源级: netInfoJson 以系统 isActiveNetworkMetered() 判计费 (与系统省流量一致)");

if (failures) { console.error("\n" + failures + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
