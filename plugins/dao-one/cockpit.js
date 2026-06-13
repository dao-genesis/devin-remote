// 道 · 归一 — 统一驾驶舱 (cockpit) 前端
// ─────────────────────────────────────────────────────────────────────────────
// 物無非彼,物無非是 —— 不再按"来源插件"排布,而按"用户意图"归一为单一界面。
// 损之又损: 用户眼前近乎无物(身/衡/意/观/深),底层三套引擎隐形协作(无不为)。
// 返回完整 webview HTML;数据与动作经 postMessage 与宿主(extension.js)单总线往来。
// ─────────────────────────────────────────────────────────────────────────────
function getCockpitHtml(nonce, cspSource) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
:root{
  --jade:#7fbf9a; --jade-dim:#5e9b79; --ink:#cfd8d3; --ink-dim:#8a948f;
  --line:rgba(127,191,154,.16); --card:rgba(127,191,154,.05);
  --warn:#e0b15a; --bad:#d97a6c; --good:#7fbf9a;
}
*{box-sizing:border-box;}
body{
  margin:0; padding:10px 10px 24px; font-family:var(--vscode-font-family);
  font-size:12.5px; color:var(--ink);
  background:transparent;
}
.hdr{display:flex;align-items:center;gap:8px;margin:2px 2px 12px;}
.mark{width:18px;height:18px;flex:0 0 auto;}
.mark circle{fill:none;stroke:var(--jade);stroke-width:7;stroke-linecap:round;
  stroke-dasharray:250;stroke-dashoffset:24;transform:rotate(-18deg);transform-origin:50% 50%;}
.mark .dot{fill:var(--jade);stroke:none;}
.title{font-weight:600;letter-spacing:2px;color:var(--ink);}
.svc{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-dim);}
.svc .led{width:7px;height:7px;border-radius:50%;background:var(--bad);box-shadow:0 0 6px var(--bad);}
.svc.on .led{background:var(--good);box-shadow:0 0 6px var(--good);}

.sec{margin:0 0 14px;}
.sec-t{font-size:10.5px;letter-spacing:3px;color:var(--jade-dim);margin:0 2px 6px;opacity:.85;}

/* 身 — identity + quota */
.id{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;}
.id-row{display:flex;align-items:baseline;gap:8px;}
.id-name{font-weight:600;color:var(--ink);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.id-org{margin-left:auto;color:var(--ink-dim);font-size:11px;white-space:nowrap;}
.id-sub{color:var(--ink-dim);font-size:10.5px;margin-top:1px;}
.q-wrap{margin-top:9px;}
.q-bar{height:6px;border-radius:4px;background:rgba(127,191,154,.12);overflow:hidden;}
.q-fill{height:100%;width:0;background:linear-gradient(90deg,var(--jade-dim),var(--jade));transition:width .5s ease;}
.q-meta{display:flex;justify-content:space-between;font-size:10.5px;color:var(--ink-dim);margin-top:4px;}
.q-fill.warn{background:linear-gradient(90deg,#caa24e,var(--warn));}
.q-fill.bad{background:linear-gradient(90deg,#b9685c,var(--bad));}

/* 衡 — balance: two glance toggles (route / backup) */
.duo{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.toggle{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 10px;cursor:pointer;transition:.15s;}
.toggle:hover{border-color:var(--jade-dim);background:rgba(127,191,154,.09);}
.toggle .k{font-size:10px;letter-spacing:2px;color:var(--ink-dim);}
.toggle .v{font-weight:600;margin-top:3px;display:flex;align-items:center;gap:6px;font-size:12.5px;}
.toggle .v .d{width:7px;height:7px;border-radius:50%;background:var(--jade);}
.toggle .v .d.off{background:var(--ink-dim);}
.toggle .hint{font-size:9.5px;color:var(--ink-dim);margin-top:2px;opacity:.8;}

/* 意 — intents */
.intent{display:flex;align-items:center;gap:11px;background:var(--card);border:1px solid var(--line);
  border-radius:10px;padding:11px 12px;cursor:pointer;margin-bottom:8px;transition:.15s;}
.intent:hover{border-color:var(--jade);background:rgba(127,191,154,.10);transform:translateY(-1px);}
.intent:active{transform:translateY(0);}
.intent .ico{width:26px;height:26px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  border-radius:8px;background:rgba(127,191,154,.12);font-size:15px;}
.intent .tx{flex:1;min-width:0;}
.intent .tx .a{font-weight:600;color:var(--ink);}
.intent .tx .b{font-size:10.5px;color:var(--ink-dim);margin-top:1px;}
.intent .chev{color:var(--jade-dim);font-size:13px;opacity:.6;}
.subs{display:none;gap:6px;flex-wrap:wrap;padding:2px 2px 10px 49px;margin-top:-4px;}
.subs.open{display:flex;}
.chip{font-size:10.5px;color:var(--ink);background:rgba(127,191,154,.08);border:1px solid var(--line);
  border-radius:14px;padding:4px 10px;cursor:pointer;transition:.12s;}
.chip:hover{border-color:var(--jade);background:rgba(127,191,154,.16);}
.chip.warn:hover{border-color:var(--warn);}
.chip.bad{color:var(--bad);} .chip.bad:hover{border-color:var(--bad);background:rgba(217,122,108,.12);}

/* 观 — counts */
.counts{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}
.cell{text-align:center;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 2px;}
.cell .n{font-size:16px;font-weight:600;color:var(--jade);}
.cell .l{font-size:9.5px;color:var(--ink-dim);margin-top:1px;}

/* 深 — drill-downs */
.deep{display:flex;gap:6px;flex-wrap:wrap;}
.deep .lk{flex:1;text-align:center;font-size:11px;color:var(--ink-dim);border:1px dashed var(--line);
  border-radius:9px;padding:8px 4px;cursor:pointer;transition:.12s;}
.deep .lk:hover{color:var(--jade);border-color:var(--jade-dim);}

.foot{text-align:center;color:var(--ink-dim);font-size:9.5px;opacity:.55;margin-top:14px;letter-spacing:1px;}
.toast{position:fixed;left:10px;right:10px;bottom:10px;background:rgba(20,28,24,.96);
  border:1px solid var(--jade-dim);border-radius:9px;padding:9px 12px;font-size:11.5px;color:var(--ink);
  opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none;z-index:9;}
.toast.show{opacity:1;transform:translateY(0);}
.toast.bad{border-color:var(--bad);}
.muted{color:var(--ink-dim);}
.spin{display:inline-block;animation:s 1s linear infinite;}@keyframes s{to{transform:rotate(360deg);}}
</style>
</head>
<body>
  <div class="hdr">
    <svg class="mark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="38"/><circle class="dot" cx="50" cy="50" r="5"/></svg>
    <span class="title">道 · 归一</span>
    <span class="svc" id="svc"><span class="led"></span><span id="svcTx">连接中…</span></span>
  </div>

  <!-- 身 -->
  <div class="sec">
    <div class="sec-t">身 · 当前</div>
    <div class="id">
      <div class="id-row"><span class="id-name" id="idName">—</span><span class="id-org" id="idOrg"></span></div>
      <div class="id-sub" id="idSub">未登录</div>
      <div class="q-wrap" id="qWrap" style="display:none">
        <div class="q-bar"><div class="q-fill" id="qFill"></div></div>
        <div class="q-meta"><span id="qLabel">额度</span><span id="qPct"></span></div>
      </div>
    </div>
  </div>

  <!-- 衡 -->
  <div class="sec">
    <div class="sec-t">衡 · 一念之转</div>
    <div class="duo">
      <div class="toggle" id="tgRoute">
        <div class="k">路由</div>
        <div class="v"><span class="d" id="rDot"></span><span id="rVal">—</span></div>
        <div class="hint" id="rHint">点按 · 道 ⇄ 官</div>
      </div>
      <div class="toggle" id="tgBackup">
        <div class="k">备份</div>
        <div class="v"><span class="d" id="bDot"></span><span id="bVal">—</span></div>
        <div class="hint" id="bHint">自动备份 · 开 ⇄ 关</div>
      </div>
    </div>
  </div>

  <!-- 意 -->
  <div class="sec">
    <div class="sec-t">意 · 一举而备</div>

    <div class="intent" data-sub="sub-id"><div class="ico">換</div>
      <div class="tx"><div class="a">换个干净身份</div><div class="b">轮转账号 · 自动备份当前 · 水无痕</div></div><div class="chev">›</div></div>
    <div class="subs" id="sub-id">
      <span class="chip" data-cmd="wam.switchAccount">切换账号</span>
      <span class="chip warn" data-intent="freshIdentity">一键净身(备份→净痕→换号)</span>
      <span class="chip" data-cmd="wam.addToken">添加账号</span>
      <span class="chip bad" data-cmd="wam.devinWipeAccount">仅净痕</span>
    </div>

    <div class="intent" data-sub="sub-route"><div class="ico">接</div>
      <div class="tx"><div class="a">接我的模型</div><div class="b">提示词隔离(本源观照) · 外接渠道路由</div></div><div class="chev">›</div></div>
    <div class="subs" id="sub-route">
      <span class="chip" data-cmd="dao.openPreview">路由真容</span>
      <span class="chip" data-cmd="dao.eaConfig">外接 API 配置</span>
      <span class="chip" data-cmd="dao.外api.toggle">外接开关</span>
      <span class="chip" data-cmd="dao.modelUnlock.toggle">模型解锁</span>
    </div>

    <div class="intent" data-sub="sub-backup"><div class="ico">备</div>
      <div class="tx"><div class="a">备份这段对话</div><div class="b">全量增量备份 · 导出 Agent MD</div></div><div class="chev">›</div></div>
    <div class="subs" id="sub-backup">
      <span class="chip" data-cmd="wam.devinBackupAll">全量备份</span>
      <span class="chip" data-cmd="wam.devinBackupAccount">备份当前</span>
      <span class="chip" data-cmd="wam.devinExportMd">导出 MD</span>
      <span class="chip" data-cmd="wam.devinSetBackupDir">备份目录</span>
    </div>

    <div class="intent" data-sub="sub-inject"><div class="ico">注</div>
      <div class="tx"><div class="a">归入 Devin</div><div class="b">知识 · 剧本 · 密钥一键注入 · 新建会话</div></div><div class="chev">›</div></div>
    <div class="subs" id="sub-inject">
      <span class="chip" data-cmd="dao.devinInject">自动注入</span>
      <span class="chip" data-cmd="dao.devinSessionCreate">新建会话</span>
      <span class="chip" data-cmd="dao.devinQuota">刷新额度</span>
      <span class="chip" data-cmd="dao.devinGitConnect">连接 Git</span>
    </div>
  </div>

  <!-- 观 -->
  <div class="sec">
    <div class="sec-t">观 · 万物在握</div>
    <div class="counts">
      <div class="cell"><div class="n" id="cSess">—</div><div class="l">会话</div></div>
      <div class="cell"><div class="n" id="cKnow">—</div><div class="l">知识</div></div>
      <div class="cell"><div class="n" id="cPlay">—</div><div class="l">剧本</div></div>
      <div class="cell"><div class="n" id="cSec">—</div><div class="l">密钥</div></div>
      <div class="cell"><div class="n" id="cGit">—</div><div class="l">Git</div></div>
    </div>
  </div>

  <!-- 深 -->
  <div class="sec">
    <div class="sec-t">深 · 按需而显</div>
    <div class="deep">
      <span class="lk" data-cmd="dao.openDashboard">面板全景</span>
      <span class="lk" data-cmd="dao.openCloudPanel">Devin 内嵌</span>
      <span class="lk" data-cmd="wam.openEditor">账号详管</span>
    </div>
  </div>

  <div class="foot">大道至简 · 无为而无不为 · 道法自然</div>
  <div class="toast" id="toast"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
function post(m){ vscode.postMessage(m); }

// 意图卡片展开/收起
document.querySelectorAll('.intent').forEach(el=>{
  el.addEventListener('click', ()=>{
    const id = el.getAttribute('data-sub'); const box = $(id);
    const open = box.classList.contains('open');
    document.querySelectorAll('.subs').forEach(s=>s.classList.remove('open'));
    if(!open) box.classList.add('open');
  });
});
// chips / deep links → 命令或编排意图
document.querySelectorAll('[data-cmd]').forEach(el=>{
  el.addEventListener('click',(e)=>{ e.stopPropagation(); post({type:'cmd', id:el.getAttribute('data-cmd')}); });
});
document.querySelectorAll('[data-intent]').forEach(el=>{
  el.addEventListener('click',(e)=>{ e.stopPropagation(); post({type:'intent', id:el.getAttribute('data-intent')}); });
});
// 衡 · 两个一念之转
$('tgRoute').addEventListener('click',()=>post({type:'route'}));
$('tgBackup').addEventListener('click',()=>post({type:'backup'}));

function setCount(id,v){ $(id).textContent = (v===null||v===undefined)?'—':v; }
function render(s){
  // 服务
  const svc=$('svc'); if(s.service&&s.service.running){svc.classList.add('on');$('svcTx').textContent=':'+s.service.port;}
  else{svc.classList.remove('on');$('svcTx').textContent='离线';}
  // 身
  if(s.id&&s.id.loggedIn){
    $('idName').textContent = s.id.email||'(已登录)';
    $('idOrg').textContent = s.id.org||'';
    $('idSub').textContent = (s.id.apiKeyType?('密钥 '+s.id.apiKeyType+' · '):'') + (s.id.accountId? s.id.accountId.slice(0,18):'');
  }else{ $('idName').textContent='未登录'; $('idOrg').textContent=''; $('idSub').textContent='点「归入 Devin」或「换身份」登录'; }
  // 额度
  if(s.quota){
    $('qWrap').style.display='block';
    const pct=Math.max(0,Math.min(100,s.quota.pct||0));
    const f=$('qFill'); f.style.width=pct+'%';
    f.className='q-fill'+(s.quota.tone==='bad'?' bad':s.quota.tone==='warn'?' warn':'');
    $('qLabel').textContent=s.quota.label||'额度';
    $('qPct').textContent=(s.quota.text!=null?s.quota.text:(pct+'%'));
  }else{ $('qWrap').style.display='none'; }
  // 衡 · 路由
  const inv = s.route && s.route.mode==='invert';
  $('rVal').textContent = inv?'本源观照':'直连官方';
  $('rDot').className='d'+(inv?'':' off');
  $('rHint').textContent = (inv?'道经置换在行':'锚云直连') + ' · 点按切换';
  // 衡 · 备份
  const ab = s.cloud && s.cloud.autoBackup;
  $('bVal').textContent = ab?'自动 · 开':'手动';
  $('bDot').className='d'+(ab?'':' off');
  // 观
  const c=s.counts||{};
  setCount('cSess',c.sessions); setCount('cKnow',c.knowledge); setCount('cPlay',c.playbooks);
  setCount('cSec',c.secrets); setCount('cGit',c.git);
}
let toastT;
function toast(text,bad){ const t=$('toast'); t.textContent=text; t.className='toast show'+(bad?' bad':'');
  clearTimeout(toastT); toastT=setTimeout(()=>t.className='toast',2600); }

window.addEventListener('message',(ev)=>{
  const m=ev.data;
  if(m.type==='state') render(m.data);
  else if(m.type==='toast') toast(m.text,m.bad);
});
post({type:'ready'});
setInterval(()=>post({type:'refresh'}), 15000);
window.addEventListener('focus',()=>post({type:'refresh'}));
</script>
</body>
</html>`;
}
module.exports = { getCockpitHtml };
