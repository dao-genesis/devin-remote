"use strict";
// 源级护栏: ☰ 菜单收纳重构 + 「流量处理」面板 (traffic.html)。
// ① ☰ 菜单: 砍「上传文件到网页端」; 「无痕标签」「分享/快捷」收进「页面工具」子菜单; 新增「流量处理」;
// ② 内部页路由 rtflow://traffic → traffic.html;
// ③ 原生桥: getTrafficStats (UID 级收发字节+网络类型) / setLowDataMode / prefGet / prefSet;
// ④ traffic.html: 会话/累计流量 + 低流量模式开关 + 差分统计;
// ⑤ console.html / app.html 板块注册表含 traffic (与 APK 对齐)。
// 无框架: node test/traffic-panel.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "MainActivity.java");
const TRAFFIC = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "traffic.html");
const CONSOLE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "console.html");
const APP = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "app.html");
const java = fs.readFileSync(JAVA, "utf8");
const traffic = fs.readFileSync(TRAFFIC, "utf8");
const consoleHtml = fs.readFileSync(CONSOLE, "utf8");
const appHtml = fs.readFileSync(APP, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// ① ☰ 菜单收纳重构
ok(!/上传文件到网页端/.test(java), "☰ 已无「上传文件到网页端」(官方自带上传)");
ok(/page\.add\(0, 13, 0, "无痕标签"\)/.test(java), "「无痕标签」收进页面工具子菜单");
ok(/page\.add\(0, 30, 9, "分享本页"\)/.test(java) && /page\.add\(0, 31, 10, "复制网址"\)/.test(java) && /page\.add\(0, 32, 11, "添加到主屏"\)/.test(java),
   "「分享/快捷」三项收进页面工具子菜单");
ok(!/addSubMenu\(0, 101/.test(java), "独立「分享 / 快捷」子菜单已收编");
ok(/mu\.add\(0, 18, 8, "流量处理"\)/.test(java) && /case 18: newTab\(TRAFFIC, null\); return true;/.test(java),
   "☰ 新增「流量处理」→ rtflow://traffic");

// ② 内部页路由
ok(/static final String TRAFFIC = "rtflow:\/\/traffic";/.test(java), "常量 TRAFFIC = rtflow://traffic");
ok(/TR_URL = "file:\/\/\/android_asset\/engine\/traffic\.html";/.test(java), "TR_URL → engine/traffic.html");
ok(/else if \(TRAFFIC\.equals\(url\)\) \{ real = TR_URL; tab\.internal = true; \}/.test(java), "loadInto 路由 rtflow://traffic");

// ③ 原生桥
ok(/@JavascriptInterface public String getTrafficStats\(\)/.test(java), "桥: getTrafficStats");
ok(/android\.net\.TrafficStats\.getUidRxBytes\(uid\)/.test(java) && /getUidTxBytes\(uid\)/.test(java), "UID 级 TrafficStats 收发字节");
ok(/isActiveNetworkMetered\(\)/.test(java), "网络类型以系统 isActiveNetworkMetered() 判计费 (与系统省流量一致)");
ok(/@JavascriptInterface public void setLowDataMode\(boolean on\)/.test(java) && /@JavascriptInterface public boolean isLowDataMode\(\)/.test(java),
   "桥: setLowDataMode/isLowDataMode (SharedPreferences lowDataMode)");
ok(/@JavascriptInterface public String prefGet\(String key\)/.test(java) && /@JavascriptInterface public void prefSet\(String key, String val\)/.test(java),
   "桥: prefGet/prefSet 键值持久化");

// ④ traffic.html 面板
ok(/getTrafficStats/.test(traffic) && /setLowDataMode/.test(traffic), "面板调用 getTrafficStats/setLowDataMode");
ok(/id="lowDataToggle"/.test(traffic) && /id="wifiBackupToggle"/.test(traffic) && /id="lazyMediaToggle"/.test(traffic),
   "面板含低流量模式/仅WiFi备份/延迟媒体三开关");
ok(/id="rxSession"/.test(traffic) && /id="txSession"/.test(traffic) && /id="rxAll"/.test(traffic), "面板含会话/累计收发展示");
ok(/resetBtn/.test(traffic), "面板含累计重置");

// ④b 低流量真实生效 (根因: 8s recentConvAll 全账号轮询 → 低流量减频+缩载荷; 手动永远全量)
const SWITCH = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "switch.html");
const switchHtml = fs.readFileSync(SWITCH, "utf8");
ok(/@JavascriptInterface public void setLowDataAuto\(boolean on\)/.test(java) && /@JavascriptInterface public boolean isLowDataAuto\(\)/.test(java),
   "桥: setLowDataAuto/isLowDataAuto (自动按网络选策略)");
ok(/\\"metered\\":/.test(java) && /netInfoJson\(\)/.test(java.slice(java.indexOf("getTrafficStats"))),
   "getTrafficStats 复用 netInfoJson() 且回传 metered (计费热点可识别)");
ok(/function _lowDataOn\(\)/.test(switchHtml), "switch.html: _lowDataOn() 低流量判定 (手动优先·自动看计费)");
ok(/_lowDataOn\(\) && \(Date\.now\(\)-_lastDevRecentTs\) < _LOWDATA_POLL_MS/.test(switchHtml),
   "switch.html: 低流量下 8s 自动轮询节流到 ≥60s (force 手动不受限)");
ok(/_lowDataOn\(\) \? \{ cmd:"recentConvAll", perAcc:1, max:10, conc:2 \}/.test(switchHtml),
   "switch.html: 低流量下 recentConvAll 载荷缩到最小档");
ok(/id="lowDataAutoToggle"/.test(traffic) && /setLowDataAuto/.test(traffic), "面板含「自动低流量(按网络)」开关并落桥");
ok(/计费热点/.test(traffic), "面板明示计费热点 (WiFi 热点按计费处理)");
ok(/rtflow\.cfg\.autoBackupWifiOnly/.test(traffic), "面板「仅WiFi备份」写入引擎共用配置键 (真实生效于备份门控)");

// ⑤ 网页端对齐
ok(/\{key:"traffic", file:"traffic\.html"/.test(consoleHtml), "console.html 板块注册表含 traffic");
ok(/"traffic\.html":"traffic"/.test(consoleHtml), "console.html FILE2KEY 含 traffic");
ok(/"流量处理",\s*function\(\)\{ openPage\("traffic"\); \}/.test(consoleHtml), "console.html ☰ 菜单含「流量处理」");
ok(/\{key:"traffic", file:"traffic\.html"/.test(appHtml), "app.html 板块注册表含 traffic");
ok(!/miSub\("🔗","分享 \/ 快捷"/.test(consoleHtml), "console.html 独立「分享/快捷」子菜单已收编进页面工具");

if (fails) { console.error("\n流量处理面板护栏: " + fails + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
