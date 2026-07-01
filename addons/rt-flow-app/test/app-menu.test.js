"use strict";
// 源级护栏: 局域网外壳 app.html 的 ☰ 菜单「页面工具」与手机 APK ☰「页面」子菜单 / console.html 对齐。
// 手机版页面工具: 后退·前进·主页·页内查找·桌面版·阅读模式·夜间模式 (纯客户端·作用于当前标签)。
// 无框架: node test/app-menu.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "app.html");
const src = fs.readFileSync(HTML, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// 页面工具函数齐备 (与 console.html 同名同义)。
[["tabNav", "前进/后退"], ["tabFind", "页内查找"], ["tabDesktop", "桌面版视口"],
 ["tabReader", "阅读模式"], ["tabNight", "夜间模式"]].forEach(function (e) {
  ok(new RegExp("function\\s+" + e[0] + "\\s*\\(").test(src), "存在页面工具函数 " + e[0] + " (" + e[1] + ")");
});

// 菜单里挂上了这些页面工具项。
ok(/mi\("🔍","页内查找",\s*tabFind\)/.test(src), "菜单: 页内查找 → tabFind");
ok(/mi\("🖥","桌面版网站",\s*tabDesktop\)/.test(src), "菜单: 桌面版网站 → tabDesktop");
ok(/mi\("📖","阅读模式",\s*tabReader\)/.test(src), "菜单: 阅读模式 → tabReader");
ok(/mi\("🌙","夜间模式",\s*tabNight\)/.test(src), "菜单: 夜间模式 → tabNight");

// 桌面版为宽视口近似 (网页端无服务端 UA 切换, 与 console.html 同策略)。
ok(/t\.fr\.style\.width\s*=\s*"1280px"/.test(src), "桌面版: 等宽 1280 视口近似 (非服务端 UA)");
// 夜间模式为整帧反色滤镜 (与 console.html 同实现)。
ok(/invert\(1\) hue-rotate\(180deg\)/.test(src), "夜间模式: invert+hue-rotate 滤镜");

// 分享 / 接入链接 (与 console.html 同款): 接入链接带 session/token 供同网设备打开。
ok(/function\s+shareCurrent\s*\(/.test(src) && /mi\("📤","分享本页",\s*shareCurrent\)/.test(src),
   "菜单: 分享本页 → shareCurrent");
ok(/function\s+copyAccessLink\s*\(/.test(src) && /mi\("📋","复制接入链接",\s*copyAccessLink\)/.test(src),
   "菜单: 复制接入链接 → copyAccessLink");
ok(/session="\+encodeURIComponent\(SESSION\)\+"&token="\+encodeURIComponent\(TOKEN\)/.test(src),
   "接入链接携带 session/token (同网设备可打开同一归一网页)");

if (fails) { console.error("\napp.html ☰ 菜单页面工具对齐护栏: " + fails + " 项失败 ✗"); process.exit(1); }
console.log("\n全部通过 ✓");
