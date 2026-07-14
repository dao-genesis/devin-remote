#!/usr/bin/env node
// /shell ⬇下载悬浮窗 + 🖼本页资源悬浮窗 多选(移植手机 APK #123 下载多选) — 源级护栏
// 校验: 多选开关/勾选框/全选/清空/批量删除(二次确认)/批量传网页/批量下载/关窗复位。
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
let n = 0, fail = 0;
function ok(cond, name) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.error("  ✗ " + name); }
}

console.log("shell-multiselect (对齐手机 APK 下载悬浮窗多选)");

// ── 下载悬浮窗多选 ──
ok(src.includes('id="dlMulti"'), "dlwin: ☑多选 开关按钮存在");
ok(src.includes('id="dlMBar"'), "dlwin: 批量操作条存在");
ok(src.includes('id="dlMAll"') && src.includes('id="dlMClr"'), "dlwin: 全选/清空按钮存在");
ok(src.includes('id="dlMUp"'), "dlwin: ⬆批量传网页按钮存在");
ok(src.includes('id="dlMDel"'), "dlwin: 🗑批量删除按钮存在");
ok(/var _dlMulti\s*=\s*false\s*,\s*_dlSel\s*=\s*\{\}/.test(src), "dlwin: 多选状态 _dlMulti/_dlSel 定义");
ok(src.includes("function dlMultiToggle()"), "dlwin: dlMultiToggle 定义");
ok(src.includes("function _dlDone()"), "dlwin: _dlDone 只取已完成含路径的记录");
ok(src.includes("!d.state&&d.path"), "dlwin: 下载中/失败记录不参与多选");
ok(src.includes("data-dlck="), "dlwin: 行级勾选 data-dlck 渲染");
ok(src.includes("class=\\\"ck\\\"") || src.includes('class="ck"'), "勾选框 .ck 渲染");
ok(src.includes(".rc.sel"), "选中高亮 .rc.sel 样式存在");
ok(src.includes("'已选 '+Object.keys(_dlSel).length"), "dlwin: 已选 n/N 计数");
ok(src.includes("_dlDone().forEach(function(d){_dlSel[d.path]=1;})"), "dlwin: 全选逻辑");
ok(src.includes("确认删除 '+ps.length+' 项?"), "dlwin: 批量删除二次确认");
ok(src.includes("type:'shellDownloadDel',path:p"), "dlwin: 批量删除逐条走 shellDownloadDel");
ok(src.includes("_daoUploadToActive({kind:'file',path:p,") , "dlwin: 批量传网页复用 _daoUploadToActive");
ok(src.includes("if(_dlMulti){_dlMulti=false;_dlSel={};_dlSyncBar();}"), "dlwin: 关窗复位多选状态");
ok(src.includes("if(_dlMulti)return;var el=e.target.closest&&e.target.closest('.rc[data-dldrag]')"), "dlwin: 多选模式下禁用指针拖拽");

// ── 本页资源悬浮窗多选 ──
ok(src.includes('id="mrMulti"'), "mrwin: ☑多选 开关按钮存在");
ok(src.includes('id="mrMBar"'), "mrwin: 批量操作条存在");
ok(src.includes('id="mrMAll"') && src.includes('id="mrMClr"'), "mrwin: 全选/清空按钮存在");
ok(src.includes('id="mrMDl"'), "mrwin: ⬇批量下载按钮存在");
ok(src.includes('id="mrMCopy"'), "mrwin: 批量复制链接按钮存在");
ok(/var _mrMulti\s*=\s*false\s*,\s*_mrSel\s*=\s*\{\}/.test(src), "mrwin: 多选状态 _mrMulti/_mrSel 定义");
ok(src.includes("data-mrck="), "mrwin: 行级勾选 data-mrck 渲染");
ok(src.includes("type:'mrDownload',url:it.u,name:it.n||''});n++;"), "mrwin: 批量下载逐条走 mrDownload");
ok(src.includes("us.join('\\\\n')"), "mrwin: 批量复制多行链接(转义正确·每行一个)");
ok(src.includes("if(_mrMulti){_mrMulti=false;_mrSel={};_mrSyncBar();}"), "mrwin: 关窗复位多选状态");

// ── 模板内转义安全: 新增代码不得引入未转义的裸 \n 单反斜杠序列(模板字面量会吃掉) ──
ok(!src.includes("us.join('\\n')") || src.includes("us.join('\\\\n')"), "join 换行符在模板内双反斜杠转义");

console.log(n - fail + "/" + n + " passed");
if (fail) process.exit(1);
