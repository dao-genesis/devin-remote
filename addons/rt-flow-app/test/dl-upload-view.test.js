"use strict";
// 源级护栏: 下载悬浮窗「上传到网页端(点击直传)」+ 面板内直看 PDF/Office。
// ① 下载项 ⋮ 菜单有「上传到网页端」且走与拖拽同一注入链 (dropFileIntoPage/dropB64FilesIntoPage);
// ② ☰ 菜单与下载面板头部有点击选文件上传入口 (uploadPicker, 不依赖拖拽);
// ③ inlineViewType 覆盖 pdf/office → 媒体悬浮窗 openPdf(原生 PdfRenderer 回推)/openOffice;
// ④ 注入 specs 携带 mime (m 字段), 二进制不再被误标 text/markdown。
// 无框架: node test/dl-upload-view.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const JAVA = path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "MainActivity.java");
const MEDIA = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "media.html");
const java = fs.readFileSync(JAVA, "utf8");
const media = fs.readFileSync(MEDIA, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// ① 下载项 ⋮ 菜单: 上传到网页端
ok(/pm\.getMenu\(\)\.add\(0, 4, 0, "⬆ 上传到网页端"\)/.test(java), "⋮ 菜单含「上传到网页端」");
ok(/case 4: uploadDownloadedToPage\(path, uri, name, mime\); return true;/.test(java), "⋮ 菜单项接 uploadDownloadedToPage");
ok(/private void uploadDownloadedToPage\(String path, String uri, String name, String mime\)/.test(java), "存在 uploadDownloadedToPage");
ok(/uploadDownloadedToPage[\s\S]{0,600}dropFileIntoPage\(web,/.test(java), "本地文件走 dropFileIntoPage 同链注入");
ok(/uploadDownloadedToPage[\s\S]{0,1600}dropB64FilesIntoPage\(fw,/.test(java), "仅剩 content:// 时读字节走 dropB64FilesIntoPage");

// ② 点击选文件上传 (不依赖拖拽)
ok(/ActivityResultLauncher<Intent> uploadPicker/.test(java), "存在 uploadPicker launcher");
ok(/private void pickUploadToPage\(\)/.test(java), "存在 pickUploadToPage (系统选择器)");
ok(/EXTRA_ALLOW_MULTIPLE, true\);\s*\n\s*uploadPicker\.launch/.test(java), "选择器支持多选");
ok(!/上传文件到网页端/.test(java) && !/case 17: pickUploadToPage\(\); return true;/.test(java),
   "☰ 菜单已砍「上传文件到网页端」(官方自带上传, 点击直传保留于下载面板 ⬆/⋮)");
ok(/up\.setText\("⬆ 上传"\)/.test(java) && /up\.setOnClickListener\(v -> pickUploadToPage\(\)\)/.test(java),
   "下载面板头部含「⬆ 上传」按钮");
ok(/private void uploadUrisToPage\(final java\.util\.List<Uri> uris\)/.test(java), "存在 uploadUrisToPage");

// ③ pdf/office 面板内直看
ok(/if \(m\.equals\("application\/pdf"\)\) return "pdf";/.test(java) && /if \(ext\.equals\("pdf"\)\) return "pdf";/.test(java),
   "inlineViewType: pdf");
ok(/if \(ext\.matches\("pptx\?\|docx\?\|xlsx\?"\)\) return "office";/.test(java), "inlineViewType: office(ppt/doc/xls)");
ok(/public void renderPdf\(final String url, final int reqId\)/.test(java), "MediaHost.renderPdf (原生 PdfRenderer)");
ok(/android\.graphics\.pdf\.PdfRenderer/.test(java) && /pdfPage\(" \+ reqId/.test(java), "PdfRenderer 逐页成图回推 pdfPage()");
ok(/public void openWith\(final String url, final String name\)/.test(java), "MediaHost.openWith (本地 Office 降级其它应用)");
ok(/function openPdf\(it\)/.test(media) && /MediaHost\.renderPdf\(it\.u, id\)/.test(media), "media.html: openPdf → renderPdf");
ok(/function pdfPage\(id,idx,total,b64\)/.test(media) && /function pdfFailed\(id,err\)/.test(media), "media.html: pdfPage/pdfFailed 回推");
ok(/function openOffice\(it\)/.test(media) && /view\.officeapps\.live\.com\/op\/embed\.aspx\?src=/.test(media),
   "media.html: openOffice 在线预览 (公网 URL)");
ok(/MediaHost\.openWith\(it\.u, it\.n\|\|""\)/.test(media), "media.html: 本地 Office → openWith 降级");
ok(/if\(it\.t==="pdf"\)\{ openPdf\(it\); return; \}/.test(media) && /if\(it\.t==="office"\)\{ openOffice\(it\); return; \}/.test(media),
   "openMediaExt 分派 pdf/office");
ok(/if\(ext==="pdf"\)\{ openPdf\(it\); return; \}/.test(media), "本页媒体列表 doView: pdf → openPdf");
ok(/if\(\/\^\(pptx\?\|docx\?\|xlsx\?\)\$\/\.test\(ext\)\)\{ openOffice\(it\); return; \}/.test(media), "本页媒体列表 doView: office → openOffice");

// ④ 注入 specs 携带 mime
ok(/var mime=s\.m\|\|\(\/\\\\\.zip\$\/i\.test\(s\.n\)\?'application\/zip':'text\/markdown'\);/.test(java),
   "dropB64FilesIntoPage: 优先取 spec.m 的真 MIME");

if (fails) { console.error(fails + " failure(s)"); process.exit(1); }
console.log("all pass");
