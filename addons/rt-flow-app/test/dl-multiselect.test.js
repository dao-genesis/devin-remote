"use strict";
// 源级护栏: 下载悬浮窗「多选」(对齐切号面板多选) — 打勾批量删除/上传/管理。
// ① 下载面板头部有「☑ 多选」开关, 切换 dlMultiMode 并清空选择重渲染;
// ② 多选态下每个已完成项渲染 CheckBox, 点击行/勾选框走 toggleDlSelect;
// ③ 动作条 addDlMultiBar: 已选计数 + 全选/清空/批量上传/批量删除;
// ④ batchDeleteSelectedDownloads 降序移除避免索引位移 + 删本地文件 + vaultWrite + 二次确认;
// ⑤ batchUploadSelectedDownloads 复用 uploadUrisToPage 注入链;
// ⑥ closeDownloadPanel 复位 dlMultiMode/dlSelected。
// 无框架: node test/dl-multiselect.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "MainActivity.java");
const java = fs.readFileSync(JAVA, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// ① 多选态字段 + 头部开关
ok(/private boolean dlMultiMode = false;/.test(java), "存在 dlMultiMode 字段");
ok(/private final java\.util\.Set<Integer> dlSelected = new java\.util\.LinkedHashSet<>\(\);/.test(java), "存在 dlSelected 选择集");
ok(/sel\.setText\("☑ 多选"\)/.test(java), "下载面板头部含「☑ 多选」开关");
ok(/sel\.setOnClickListener\(v -> \{ dlMultiMode = !dlMultiMode; dlSelected\.clear\(\);/.test(java),
   "多选开关: 切换 dlMultiMode + 清空选择");
ok(/head\.addView\(ttl\); head\.addView\(sel\); head\.addView\(up\); head\.addView\(close\);/.test(java),
   "头部顺序: 标题 / 多选 / 上传 / 关闭");

// ② 勾选框渲染 + 切换
ok(/if \(dlMultiMode\) addDlMultiBar\(listCol, arr\.length\(\)\);/.test(java), "多选态渲染动作条");
ok(/cb = new android\.widget\.CheckBox\(this\);/.test(java), "多选态每行渲染 CheckBox");
ok(/private void toggleDlSelect\(int recIdx, boolean on\)/.test(java), "存在 toggleDlSelect");
ok(/if \(on\) dlSelected\.add\(recIdx\); else dlSelected\.remove\(recIdx\);/.test(java), "toggleDlSelect 增删选择集");

// ③ 动作条
ok(/private void addDlMultiBar\(LinearLayout listCol, int total\)/.test(java), "存在 addDlMultiBar");
ok(/cnt\.setText\("已选 " \+ dlSelected\.size\(\) \+ "\/" \+ total\)/.test(java), "动作条显示已选计数");
ok(/Button all = chipBtnSm\("全选"\)/.test(java), "动作条含「全选」");
ok(/Button none = chipBtnSm\("清空"\)/.test(java), "动作条含「清空」");
ok(/upSel\.setOnClickListener\(v -> batchUploadSelectedDownloads\(\)\)/.test(java), "动作条「⬆」接批量上传");
ok(/del\.setOnClickListener\(v -> batchDeleteSelectedDownloads\(\)\)/.test(java), "动作条「🗑」接批量删除");

// ④ 批量删除
ok(/private void batchDeleteSelectedDownloads\(\)/.test(java), "存在 batchDeleteSelectedDownloads");
ok(/new android\.app\.AlertDialog\.Builder\(this\)\.setTitle\("批量删除"\)/.test(java), "批量删除二次确认对话框");
ok(/batchDeleteSelectedDownloads[\s\S]{0,2200}vaultWrite\("downloads", out\.toString\(\)\);/.test(java),
   "批量删除同步保险箱 vaultWrite");

// ⑤ 批量上传
ok(/private void batchUploadSelectedDownloads\(\)/.test(java), "存在 batchUploadSelectedDownloads");
ok(/batchUploadSelectedDownloads[\s\S]{0,1600}uploadUrisToPage\(uris\);/.test(java),
   "批量上传复用 uploadUrisToPage 注入链");

// ⑥ 关闭面板复位
ok(/dlPanel = null; dlListCol = null;\s*\n\s*dlMultiMode = false; dlSelected\.clear\(\);/.test(java),
   "closeDownloadPanel 复位多选态");

if (fails) { console.error("\n" + fails + " check(s) FAILED"); process.exit(1); }
console.log("\nAll dl-multiselect checks passed.");
