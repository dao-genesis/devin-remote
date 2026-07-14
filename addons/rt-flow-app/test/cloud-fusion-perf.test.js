"use strict";
// 源级护栏: 备份网页端(cloud.html)与近期对话五按钮融合 + 几百账号性能优化。
// ① 云端会话行五按钮齐平: 查看/进入/MD/传到当前页/全部文件 (与 daopan.html 近期对话同源);
// ② 本地备份行(含已移出号)也可 进入(账密快照登录)/传到当前页;
// ③ 复制账密: 一级目录 + 二级面包屑皆可复制;
// ④ 性能: 检索防抖 + 检索干草垛缓存 + 最近对话预览缓存(不再每次重渲全量同步读盘) + 分页渲染。
// 无框架: node test/cloud-fusion-perf.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const CLOUD = path.join(__dirname, "..", "app", "src", "main", "assets", "engine", "cloud.html");
const cloud = fs.readFileSync(CLOUD, "utf8");

let fails = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { console.error("  FAIL- " + msg); fails++; } }

// ① 云端会话行五按钮 (与近期对话 daopan.html 融合)
ok(/onclick="viewMd\('\+i\+',\\'conversation\\'\)">&#128065; 查看/.test(cloud), "会话行有「👁 查看」");
ok(/onclick="enterSess\('\+i\+'\)"[^>]*>&#127760; 进入/.test(cloud), "会话行有「🌐 进入」");
ok(/onclick="dlMd\('\+i\+',\\'conversation\\'\)">&#11015; MD/.test(cloud), "会话行有「⬇ MD」");
ok(/onclick="upSess\('\+i\+'\)"[^>]*>&#11014; 传到当前页/.test(cloud), "会话行有「⬆ 传到当前页」");
ok(/onclick="dlAll\('\+i\+'\)">&#128230; 全部文件/.test(cloud), "会话行有「📦 全部文件」");

// 进入 = 切号并网页端打开对话 (openAccountSession → openEntryNewTab → 顶层 postMessage 三级兜底)
ok(/function _enterAccSess\(acc, sid, title\)/.test(cloud), "存在 _enterAccSess");
ok(/N\.openAccountSession\(JSON\.stringify\(acc\), sid\)/.test(cloud), "进入走 N.openAccountSession");
ok(/N\.openEntryNewTab\(JSON\.stringify\(acc\), web\)/.test(cloud), "兜底 N.openEntryNewTab");
ok(/window\.top\.postMessage\(\{__rtflow:"openDevin"/.test(cloud), "网页端兜底 top.postMessage openDevin");

// 传到当前页 = 对话 MD(+取数指引) 投递上传框 (deliverConvFilesToPage → deliverConvToPage → daoUploadFile)
ok(/async function upSess\(i\)/.test(cloud), "存在 upSess");
ok(/N\.deliverConvFilesToPage\(JSON\.stringify\(files\)\)/.test(cloud), "投递走 N.deliverConvFilesToPage");
ok(/__rtflow:"daoUploadFile"/.test(cloud), "网页端兜底 daoUploadFile postMessage");
ok(/N\.accessGuideMd\?N\.accessGuideMd\(JSON\.stringify\(acc\), sid/.test(cloud), "附带取数指引 MD");

// ② 本地备份行(移出/未登录号): 进入 + 传到当前页
ok(/function bkEnter\(ri\)/.test(cloud) && /_enterAccSess\(CUR\.acc, s\.sid\|\|""/.test(cloud), "本地行 bkEnter → 账密快照登录进入");
ok(/async function bkUp\(ri\)/.test(cloud), "本地行 bkUp → 本地 MD 传到当前页");
ok(/canEnter=!!\(g\.acc&&g\.acc\.auth1\)/.test(cloud), "移出号有 auth1 快照才显「进入」");

// ③ 复制账密
ok(/onclick="event\.stopPropagation\(\);cpGrp\('\+i\+'\)">复制账密/.test(cloud), "一级目录可复制账密");
ok(/function cpCur\(\)\{ if\(CUR&&CUR\.acc\) cpAcc\(CUR\.acc\); \}/.test(cloud), "二级面包屑 cpCur 复制账密");
ok(/navigator\.clipboard\.writeText\(t\)/.test(cloud), "网页端剪贴板兜底");

// ④ 性能: 防抖 + 干草垛缓存 + 预览缓存 + 分页
ok(/var _qT=null;[\s\S]{0,200}setTimeout\(function\(\)\{[\s\S]{0,200}\},160\)/.test(cloud), "检索 160ms 防抖");
ok(/g\._hay==null/.test(cloud) && /g\._hay\.indexOf\(Q\)>=0/.test(cloud), "检索干草垛一次拼好缓存");
ok(/function _pvOf\(g\)\{ if\(g\._pv==null\)/.test(cloud), "最近对话预览按组缓存 (不再每次重渲全量读盘)");
ok(/var PAGE=80, LIM=PAGE;/.test(cloud) && /function moreAccts\(\)\{ LIM\+=PAGE; renderAccts\(\); \}/.test(cloud), "分页渲染 80/页");
ok(/_view\.slice\(0,LIM\)\.map/.test(cloud), "一级目录只渲当前页");
ok(/加载更多 \(当前 '\+LIM\+' \/ 共 '\+_view\.length\+'\)/.test(cloud), "有「加载更多」按钮");

// 紧凑按钮 (省空间)
ok(/\.b\{flex:1;min-width:46px;[^}]*font-size:11\.5px/.test(cloud), "按钮紧凑尺寸 (min-width 46px · 11.5px)");

if (fails) { console.error(fails + " failure(s)"); process.exit(1); }
console.log("all ok");
