"use strict";
// 源级护栏: 国内网络资源突破链 —— 边缘中继轮换 + Cloudflare 区域层拦截识别(x-dao-proxy 印记)
//   + 浏览器 UA 过门 + DownloadManager 黑洞看门人 + 原生代取流式落盘。
// 无框架: 直接 node test/edge-route-breakout.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "app/src/main/java/ai/devin/rtflow/MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── ① 边缘中继多域名轮换: 单域名被封/限额不再拖死整条边缘通道 ──
ok(/static String\[\] edgeBaseCandidates\(\)/.test(main), "edgeBaseCandidates 存在");
ok(/LinkedHashSet<String>/.test(main.match(/static String\[\] edgeBaseCandidates[\s\S]{0,600}/)[0]), "候选去重 (LinkedHashSet)");
ok(/dao-relay\.aiotvr\.cloud/.test(main.match(/static String\[\] edgeBaseCandidates[\s\S]{0,600}/)[0]), "自有域名候选在列");
ok(/workers\.dev/.test(main.match(/static String\[\] edgeBaseCandidates[\s\S]{0,600}/)[0]), "workers.dev 兜底在列");
ok(/sEdgeIdx\+\+/.test(main), "markEdgeDead 先轮换下一域名");
ok(/sEdgeIdx % n == 0\) sEdgeDeadUntil/.test(main), "全部轮完才判边缘整体失效");
ok(/bases\[Math\.floorMod\(sEdgeIdx, bases\.length\)\]/.test(main), "edgeWrap 按轮换序取当前中继");

// ── ② Cloudflare 区域层拦截识别: 无 x-dao-proxy 印记的 4xx = 未穿透到 Worker (如 UA 完整性检查 1010) ──
ok(/code >= 400 && c\.getHeaderField\("x-dao-proxy"\) == null/.test(main), "无 x-dao-proxy 的 4xx 判为中继层错误");

// ── ③ 浏览器 UA 过门: Dalvik 默认 UA 触发 Cloudflare 完整性检查 403(1010) ──
ok(/static final String BROWSER_UA = "Mozilla\//.test(main), "BROWSER_UA 常量存在");
ok(/getRequestProperty\("User-Agent"\) == null\) c\.setRequestProperty\("User-Agent", BROWSER_UA\)/.test(main), "无转发 UA 时补浏览器 UA");
ok(/req\.addRequestHeader\("User-Agent", fUa != null \? fUa : BROWSER_UA\)/.test(main), "DownloadManager 请求恒带 UA");

// ── ④ DM 黑洞看门人: 附件/被墙宿主的 DM 下载 25s 仍 0 字节/暂停态 → 斩 DM 改走原生代取 ──
ok(/private void watchDmStall\(final long id/.test(main), "watchDmStall 存在");
ok(/watchDmStall\(id, name, fUrl, fMime\)/.test(main), "DM 入队即挂看门人");
ok(/isAttachmentDownloadUrl\(url\) \|\| blockedMediaHost\(h\)/.test(main.match(/private void watchDmStall[\s\S]{0,600}/)[0]), "只看护附件/被墙宿主");
ok(/STATUS_PAUSED \|\| got <= 0/.test(main), "暂停态或 0 字节即判黑洞");
ok(/markDirectMediaBlocked\(\);[\s\S]{0,200}nativeFetchDownload\(url, name, mime\)/.test(main.match(/private void watchDmStall[\s\S]{0,2200}/)[0]), "斩 DM 后标记被墙并改走代取");
ok(/watchDmStall\(id, name, url, mime\);\s*\/\/ 有进度/.test(main), "有进度继续看护 (防中途断流)");

// ── ⑤ 原生代取流式落盘: 大视频不整份压内存, .part 原子换名 ──
const nf = main.match(/private void nativeFetchDownload[\s\S]{0,4000}/)[0];
ok(/new File\(dir, name \+ "\.part"\)/.test(nf), "先写 .part 临时文件");
ok(/tmp\.renameTo\(f\)/.test(nf), "成功后原子换名");
ok(!/ByteArrayOutputStream bos = new ByteArrayOutputStream\(\)/.test(nf), "不再整份缓存进内存");
ok(/64L \* 1024 \* 1024/.test(nf), "超大文件不整读回内存同步系统下载");

// ── ⑥ 路由探测对准真实附件桶宿主 ──
ok(/devin-public-attachments\.s3\.dualstack\.us-west-2\.amazonaws\.com/.test(main), "探测真实附件桶宿主 (与实际下载同路)");
ok(/kickMediaRouteProbe\(\); } catch \(Throwable ignored\) {}/.test(main.match(/protected void onCreate[\s\S]{0,600}/)[0]), "开屏即探直连可达性");

if (failures) { console.error("edge-route-breakout: " + failures + " failed"); process.exit(1); }
console.log("# edge-route-breakout: all passed");
