// dao-bridge · 公网中枢（VPS/服务器形态 · 有公网 IP 时用）
// 道法自然 · 中枢在有公网 IP 的机器上直接监听 → 被控端(用户台式机)一行 PowerShell/sh 接入,
// 操控端(云端 Agent)经同一中枢的 /api/exec-sync?agent_id=<host> 桥接驱动被控端。
//
// 与 agent.js 的区别：agent.js 是"被控本机 + 出站快速隧道/持久 Worker"形态（无公网 IP 的家用机）；
// 本文件是"中枢"形态——机器自带公网 IP，直接 0.0.0.0 监听当集散点，无需 cloudflared、无需 Worker DO，
// 被控端与操控端都直连本中枢。长轮询 HTTP（/api/connect→/api/poll→/api/result）比 WS 中继稳健得多。
//
// 复用 core.js 的全部中枢逻辑（DaoHub：登记/队列/结果/唤醒 + exec-sync 跨平台路由 + bootstrap 脚本）。
// 唯一差异：监听地址可配（默认 0.0.0.0）、publicUrl 由环境显式给出（供 bootstrap 脚本注入接入 URL）。
//
// 配置（优先级：环境变量 > 默认）：
//   DAO_TOKEN       操作端 master token（必填；缺失则随机生成并打印）
//   DAO_PORT        监听端口（默认 9930，避开被控插件本地 9920）
//   DAO_BIND        监听地址（默认 0.0.0.0）
//   DAO_PUBLIC_URL  对外接入 URL（默认 http://<外网IP或hostname>:<port>；bootstrap 脚本注入此值）
//   DAO_ROOT        中枢本机工作根目录（默认用户目录）
'use strict';
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const core = require('./core.js');

function envToken() {
  const t = process.env.DAO_TOKEN;
  if (t && t.length >= 8) return t;
  const gen = 'dao-hub-' + crypto.randomBytes(16).toString('hex');
  console.log('[dao-hub] 未提供 DAO_TOKEN，已随机生成（仅本进程内存·请记下用于操作端鉴权）:\n  ' + gen);
  return gen;
}

function firstPublicIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return os.hostname();
}

const PORT = Number(process.env.DAO_PORT || 9930);
const BIND = process.env.DAO_BIND || '0.0.0.0';
const ROOT = process.env.DAO_ROOT || os.homedir();
const TOKEN = envToken();
const PUBLIC_URL = (process.env.DAO_PUBLIC_URL || ('http://' + firstPublicIPv4() + ':' + PORT)).replace(/\/+$/, '');

// 单一 host 对象贯穿所有请求 → core.getHub(host) 复用同一 DaoHub 实例，被控端登记态跨请求存活。
const host = {
  workspaceRoot: () => ROOT,
  info: () => ({ host: os.hostname(), platform: process.platform, role: 'hub', workspace: [ROOT], public_url: PUBLIC_URL }),
  publicUrl: () => PUBLIC_URL,
  log: (m) => console.log('[dao-hub] ' + m),
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', PUBLIC_URL);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const out = await core.handleRoute(host, url.pathname, req.method || 'GET', req.headers, raw, TOKEN);
      if (out.raw !== undefined) {
        res.writeHead(out.status, { 'Content-Type': out.contentType || 'text/plain; charset=utf-8' });
        res.end(out.raw);
      } else {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body, null, 2));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
});

server.listen(PORT, BIND, () => {
  console.log('[dao-hub] 公网中枢已监听 http://' + BIND + ':' + PORT + '  (role=hub host=' + os.hostname() + ')');
  console.log('[dao-hub] 对外接入 URL: ' + PUBLIC_URL);
  console.log('[dao-hub] 被控端一行接入(Windows):  iwr ' + PUBLIC_URL + '/api/bootstrap.ps1 | iex');
  console.log('[dao-hub] 被控端一行接入(Linux/mac): curl -fsSL ' + PUBLIC_URL + '/api/bootstrap.sh | sh');
  console.log('[dao-hub] 操作端驱动: POST ' + PUBLIC_URL + '/api/exec-sync  (Authorization: Bearer <DAO_TOKEN>, body {agent_id,cmd|type,...})');
});

process.on('SIGINT', () => { try { server.close(); } catch (e) {} process.exit(0); });
