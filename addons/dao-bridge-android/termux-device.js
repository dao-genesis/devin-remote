"use strict";
// dao-bridge-android · termux-device — 通过 termux-api 采集设备信息（仅授权设备）。
// 若 termux-api 未安装则优雅降级为通用 os 信息，不抛错。
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const s = (stdout || '').trim();
      if (!s) return resolve(null);
      try { return resolve(JSON.parse(s)); } catch { return resolve(s); }
    });
  });
}

function hasTermuxApi() {
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'command -v termux-battery-status'], (err, out) => {
      resolve(!err && !!(out || '').trim());
    });
  });
}

// 通用基线（任何 Node 平台都可拿到，无需 termux-api）
function baseInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    host: os.hostname(),
    release: os.release(),
    uptime_s: Math.round(os.uptime()),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    cpus: os.cpus().length,
    node: process.version,
  };
}

// 设备信息聚合：基线 + （若可用）termux-api 的电池/网络/电话/定位
async function collect(opts) {
  const out = { base: baseInfo(), termux_api: false };
  if (!(await hasTermuxApi())) return out;
  out.termux_api = true;
  const want = (opts && opts.fields) || ['battery', 'wifi', 'telephony'];
  const tasks = [];
  if (want.includes('battery')) tasks.push(run('termux-battery-status', []).then((v) => { out.battery = v; }));
  if (want.includes('wifi')) tasks.push(run('termux-wifi-connectioninfo', []).then((v) => { out.wifi = v; }));
  if (want.includes('telephony')) tasks.push(run('termux-telephony-deviceinfo', []).then((v) => { out.telephony = v; }));
  if (want.includes('location')) tasks.push(run('termux-location', ['-p', 'network', '-r', 'last'], 15000).then((v) => { out.location = v; }));
  await Promise.all(tasks);
  return out;
}

module.exports = { collect, baseInfo, hasTermuxApi };
