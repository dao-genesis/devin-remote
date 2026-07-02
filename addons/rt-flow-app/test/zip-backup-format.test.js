"use strict";
// 实测「备份单文件 ZIP 化」(道法自然·省空间省流量·功能全不变):
//   ① ZIP 真压缩: buildZipAsync 经 CompressionStream(deflate-raw) 逐条目压缩, 压不小/不可用 → STORE 原样。
//   ② 整包内读: zipReadText 直读 ZIP 内条目文本 (STORE 切片 / DEFLATE 解压), 本地数据源不再依赖散文件。
//   ③ 产物为合法 ZIP: 独立解压器(python zipfile) 全量校验并读回同样内容。
//   ④ 源级护栏: 备份走单管线 exportSessionZip(不再 md+ZIP 各下一遍), 旧散文件折入后清除,
//      读取端(localConvMd/bkOpenMd/秒拖注入) 全部兼容单包, 手动下载路径不受影响。
// 无框架: 直接 node test/zip-backup-format.test.js, 退出码非 0 即失败。
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const ENGINE = path.join(__dirname, "..", "app", "src", "main", "assets", "engine");
const cloudSrc = fs.readFileSync(path.join(ENGINE, "devin-cloud.js"), "utf8");
const switchSrc = fs.readFileSync(path.join(ENGINE, "switch.html"), "utf8");
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main", "java", "ai", "devin", "rtflow", "MainActivity.java"), "utf8");

let failures = 0;
function ok(cond, msg) { if (cond) { console.log("  ok  - " + msg); } else { failures++; console.error("  FAIL- " + msg); } }

// ── 装载真 devin-cloud.js (stub DaoCore, 只测 ZIP 底层) ──
const win = { DaoCore: { APP: "https://app.devin.ai", httpReq: async () => ({ status: 0 }), devinJsonGet: async () => ({ status: 0 }), devinJsonPost: async () => ({ status: 0 }) }, console };
new Function("window", cloudSrc + "\n//# sourceURL=devin-cloud.js")(win);
const DC = win.DaoCloud;
ok(!!DC && typeof DC.buildZipAsync === "function" && typeof DC.zipReadText === "function", "DaoCloud.buildZipAsync / zipReadText 装载");

(async function () {
  // ① 压缩率: 高冗余中文长文 → DEFLATE 应显著小于原文
  const bigMd = ("# 对话全过程\n\n" + "用户: 道法自然, 无为而无不为。\nDevin: 收到, 继续推进。\n".repeat(4000));
  const rawBytes = DC.utf8Bytes(bigMd);
  const smallBin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const entries = [
    { name: "对话_人类可读.md", bytes: rawBytes },
    { name: "files/tiny.bin", bytes: smallBin }
  ];
  const zip = await DC.buildZipAsync(entries);
  ok(zip && zip.length > 0, "buildZipAsync 产出 ZIP 字节 (" + zip.length + "B)");
  ok(zip.length < rawBytes.length / 2, "真压缩生效: ZIP(" + zip.length + "B) < 原文一半(" + rawBytes.length + "B)");

  // ② 整包内读回: DEFLATE 条目 + STORE 小条目 均可读
  const b64 = DC.bytesToB64(zip);
  const back = await DC.zipReadText(b64, "对话_人类可读.md");
  ok(back === bigMd, "zipReadText 读回 DEFLATE 条目 · 内容逐字节一致");
  const miss = await DC.zipReadText(b64, "不存在.md");
  ok(miss === null, "zipReadText 未命中条目 → null (不误报)");

  // 纯 STORE 包 (老格式/无 CompressionStream 回退) 亦可读
  const storeZip = DC.buildZip([{ name: "对话_人类可读.md", bytes: DC.utf8Bytes("store 老格式内容") }]);
  ok((await DC.zipReadText(DC.bytesToB64(storeZip), "对话_人类可读.md")) === "store 老格式内容", "STORE(method 0) 包兼容读回 (老备份不受影响)");

  // ③ 独立解压器校验: python zipfile 全量 CRC 校验 + 读回同内容
  const tmp = path.join(os.tmpdir(), "dao-zip-test-" + Date.now() + ".zip");
  fs.writeFileSync(tmp, Buffer.from(zip));
  try {
    const out = cp.execFileSync("python3", ["-c", [
      "import zipfile,sys",
      "z=zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "d=z.read('对话_人类可读.md').decode('utf-8')",
      "print(len(d)); print(z.getinfo('对话_人类可读.md').compress_type)"
    ].join("\n"), tmp], { encoding: "utf8" }).trim().split("\n");
    ok(parseInt(out[0], 10) === bigMd.length, "python zipfile 独立校验通过 · 解压长度一致 (" + out[0] + ")");
    ok(out[1] === "8", "python 确认条目为 DEFLATE(method 8) 真压缩");
  } catch (e) {
    ok(false, "python zipfile 独立校验: " + e.message);
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }

  // ④ 源级护栏 · devin-cloud.js
  ok(/bytesToB64\(await buildZipAsync\(entries\)\)/.test(cloudSrc), "exportSessionZip 用 buildZipAsync (真压缩整包)");
  ok(/events: conv\.events \|\| 0/.test(cloudSrc), "exportSessionZip 回传 events (备份单管线据此定完整性)");
  ok(/zipReadText: zipReadText/.test(cloudSrc), "zipReadText 已导出 (整包内读)");

  // 源级护栏 · switch.html 备份写入端
  const bk = switchSrc.slice(switchSrc.indexOf("async function backupSessionFull"), switchSrc.indexOf("async function fullBackupAccount"));
  ok(/exportSessionZip\(a,sid\)/.test(bk), "backupSessionFull 单管线: 一次 exportSessionZip 取全 (不再 md 与 ZIP 各下一遍)");
  ok(/if\(zipOk\)/.test(bk) && /vaultDeleteBackup\(folder,"conv-"\+sid\+"\.md"\)/.test(bk), "单包落地后清除旧散文件 conv-/指引- (归纳整理)");
  ok(/if\(c&&c\.ok\)\{ evCnt=c\.events\|\|0; convOk=/.test(bk), "ZIP 失败回退老散文件写法 (绝不丢备份)");

  // 源级护栏 · switch.html 读取端 (单包兼容)
  ok(/zipReadText\(b64, ?"对话_人类可读\.md"\)/.test(switchSrc), "localConvMd 从单包内读对话MD (散文件缺失时)");
  ok(/ent && ent\.backedUpAt && \(ent\.md\|\|ent\.zip\)/.test(switchSrc), "_convSourceDecision 认可 zip-only 备份 (本地数据源无感回退不退化)");
  ok(/async function bkOpenMd\(folder, mdName, zipName\)/.test(switchSrc) && /zipReadText\(b64,"对话_人类可读\.md"\)/.test(switchSrc), "备份库「打开MD」兼容单包");
  ok(/\(s\.md\|\|s\.zip\)\?'<button class="bk-b"/.test(switchSrc), "备份库列表: zip-only 备份也有「打开MD」按钮");
  ok(/\(!ent\.md && !ent\.zip\)/.test(switchSrc), "自动清理前置校验仍认 md 或 zip 任一 (双保险不变)");

  // 手动路径不受影响
  ok(/function bkSaveZip\(folder, zipName\)/.test(switchSrc) && /async function dvConvZip\(i,did\)/.test(switchSrc), "手动 下载ZIP/打包ZIP 路径原样保留");

  // 源级护栏 · MainActivity.java (秒拖注入 + 散文件清除桥)
  ok(/public boolean vaultDeleteBackup\(String folder, String name\)/.test(mainSrc), "原生桥 vaultDeleteBackup 存在 (清除已折入散文件)");
  ok(/zipName != null && !zipName\.isEmpty\(\)\) \{\n/.test(mainSrc.replace(/\r/g, "")) && !/zipName\.isEmpty\(\) && hasFiles > 0/.test(mainSrc), "秒拖注入: 有整包即直注 ZIP (不再要求 hasFiles>0, 纯文本对话也走整包)");
  ok(/vaultReadBackup\(folder, mdName\)/.test(mainSrc), "秒拖注入: 老散文件 MD 回退保留 (旧备份兼容)");

  console.log(failures ? ("\n" + failures + " failure(s)") : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
