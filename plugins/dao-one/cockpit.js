// 道 · 归一 — 统一驾驶舱 (cockpit) 前端 · v3 三入口骨架
// ─────────────────────────────────────────────────────────────────────────────
// 物無非彼,物無非是 —— 不再按"来源插件"堆叠,而按"用户意图"归一为竖排三入口:
//   ① 切管 (rt-flow · 账号轮转,最常用 → 默认展开)
//   ② 路由 (dao-proxy-pro · 提示词隔离 + 外接模型路由)
//   ③ 全能板 (dao-vsix · Devin Cloud 会话/知识/剧本/密钥/Git + 备份归入)
// 顶部「身」常驻一总览(当前账号 · 剩余额度),一看便知。
// 点某一入口 → 该块横展,其余收为细条(减竖向长度)。底层三引擎隐形协作(无不为)。
// 数据与动作经 postMessage 与宿主(extension.js)单总线往来。
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
.hdr{display:flex;align-items:center;gap:8px;margin:2px 2px 10px;}
.mark{width:18px;height:18px;flex:0 0 auto;}
.mark circle{fill:none;stroke:var(--jade);stroke-width:7;stroke-linecap:round;
  stroke-dasharray:250;stroke-dashoffset:24;transform:rotate(-18deg);transform-origin:50% 50%;}
.mark .dot{fill:var(--jade);stroke:none;}
.title{font-weight:600;letter-spacing:2px;color:var(--ink);}
.svc{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-dim);}
.svc .led{width:7px;height:7px;border-radius:50%;background:var(--bad);box-shadow:0 0 6px var(--bad);}
.svc.on .led{background:var(--good);box-shadow:0 0 6px var(--good);}

/* 身 — 常驻一总览: 账号 + 余额 */
.id{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 12px;}
.id-row{display:flex;align-items:baseline;gap:8px;}
.id-name{font-weight:600;color:var(--ink);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.id-bal{margin-left:auto;color:var(--jade);font-size:13px;font-weight:600;white-space:nowrap;}
.id-sub{color:var(--ink-dim);font-size:10.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.q-wrap{margin-top:8px;}
.q-bar{height:5px;border-radius:4px;background:rgba(127,191,154,.12);overflow:hidden;}
.q-fill{height:100%;width:0;background:linear-gradient(90deg,var(--jade-dim),var(--jade));transition:width .5s ease;}
.q-fill.warn{background:linear-gradient(90deg,#caa24e,var(--warn));}
.q-fill.bad{background:linear-gradient(90deg,#b9685c,var(--bad));}

/* 三入口 · 竖排,点击横展 */
.entries{display:flex;flex-direction:column;gap:8px;}
.entry{border:1px solid var(--line);border-radius:11px;background:var(--card);overflow:hidden;transition:.15s;}
.entry.active{border-color:var(--jade-dim);background:rgba(127,191,154,.07);}
.entry-h{display:flex;align-items:center;gap:11px;padding:11px 12px;cursor:pointer;transition:.12s;}
.entry-h:hover{background:rgba(127,191,154,.09);}
.entry-h .ico{width:28px;height:28px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  border-radius:8px;background:rgba(127,191,154,.12);font-size:15px;color:var(--jade);}
.entry.active .entry-h .ico{background:var(--jade);color:#0d1411;}
.entry-h .tx{flex:1;min-width:0;}
.entry-h .tx .a{font-weight:600;color:var(--ink);display:flex;align-items:center;gap:6px;}
.entry-h .tx .a .tag{font-size:9px;letter-spacing:1px;color:var(--ink-dim);border:1px solid var(--line);border-radius:6px;padding:0 5px;}
.entry-h .tx .b{font-size:10.5px;color:var(--ink-dim);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.entry-h .chev{color:var(--jade-dim);font-size:13px;transition:.2s;}
.entry.active .entry-h .chev{transform:rotate(90deg);}
.entry-b{display:none;padding:2px 12px 13px;}
.entry.active .entry-b{display:block;}

/* 段标 */
.sub-t{font-size:10px;letter-spacing:2px;color:var(--jade-dim);margin:11px 1px 6px;opacity:.85;}

/* 状态行(衡): 路由 / 备份 / 轮转 */
.duo{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.toggle{background:rgba(127,191,154,.04);border:1px solid var(--line);border-radius:9px;padding:8px 10px;cursor:pointer;transition:.15s;}
.toggle:hover{border-color:var(--jade-dim);background:rgba(127,191,154,.10);}
.toggle .k{font-size:9.5px;letter-spacing:2px;color:var(--ink-dim);}
.toggle .v{font-weight:600;margin-top:3px;display:flex;align-items:center;gap:6px;font-size:12px;}
.toggle .v .d{width:7px;height:7px;border-radius:50%;background:var(--jade);}
.toggle .v .d.off{background:var(--ink-dim);}
.toggle .hint{font-size:9px;color:var(--ink-dim);margin-top:2px;opacity:.8;}

/* 动作 chips */
.chips{display:flex;gap:6px;flex-wrap:wrap;}
.chip{font-size:10.5px;color:var(--ink);background:rgba(127,191,154,.08);border:1px solid var(--line);
  border-radius:14px;padding:5px 11px;cursor:pointer;transition:.12s;}
.chip:hover{border-color:var(--jade);background:rgba(127,191,154,.16);}
.chip.warn:hover{border-color:var(--warn);}
.chip.bad{color:var(--bad);} .chip.bad:hover{border-color:var(--bad);background:rgba(217,122,108,.12);}

/* 主账号粘贴 (B2) */
.paste{margin-top:4px;}
.paste textarea{width:100%;resize:none;height:34px;background:rgba(0,0,0,.18);color:var(--ink);
  border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);}
.paste textarea:focus{outline:none;border-color:var(--jade-dim);}
.paste .row{display:flex;gap:6px;margin-top:6px;align-items:center;}
.paste .btn{flex:0 0 auto;font-size:10.5px;color:#0d1411;background:var(--jade);border:none;
  border-radius:8px;padding:6px 13px;cursor:pointer;font-weight:600;}
.paste .btn:hover{background:var(--jade-dim);}
.paste .ph{font-size:9px;color:var(--ink-dim);opacity:.8;}

/* 观 — counts */
.counts{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}
.cell{text-align:center;background:rgba(127,191,154,.04);border:1px solid var(--line);border-radius:9px;padding:8px 2px;}
.cell .n{font-size:15px;font-weight:600;color:var(--jade);}
.cell .l{font-size:9px;color:var(--ink-dim);margin-top:1px;}

.foot{text-align:center;color:var(--ink-dim);font-size:9.5px;opacity:.55;margin-top:14px;letter-spacing:1px;}
.toast{position:fixed;left:10px;right:10px;bottom:10px;background:rgba(20,28,24,.96);
  border:1px solid var(--jade-dim);border-radius:9px;padding:9px 12px;font-size:11.5px;color:var(--ink);
  opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none;z-index:9;}
.toast.show{opacity:1;transform:translateY(0);}
.toast.bad{border-color:var(--bad);}
</style>
</head>
<body>
  <div class="hdr">
    <svg class="mark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="38"/><circle class="dot" cx="50" cy="50" r="5"/></svg>
    <span class="title">道 · 归一</span>
    <span class="svc" id="svc"><span class="led"></span><span id="svcTx">连接中…</span></span>
  </div>

  <!-- 身 · 常驻一总览 -->
  <div class="id">
    <div class="id-row"><span class="id-name" id="idName">—</span><span class="id-bal" id="idBal"></span></div>
    <div class="id-sub" id="idSub">未登录</div>
    <div class="q-wrap" id="qWrap" style="display:none">
      <div class="q-bar"><div class="q-fill" id="qFill"></div></div>
    </div>
  </div>

  <!-- 三入口 -->
  <div class="entries">

    <!-- ① 切管 (rt-flow WAM) · 默认 -->
    <div class="entry active" data-entry="wam">
      <div class="entry-h">
        <div class="ico">管</div>
        <div class="tx"><div class="a">切管 <span class="tag">rt-flow</span></div><div class="b">账号轮转 · 主账号一键换 · 备份净身</div></div>
        <div class="chev">›</div>
      </div>
      <div class="entry-b">
        <div class="sub-t">主账号 · 粘贴即换(账密合一行)</div>
        <div class="paste">
          <textarea id="pasteIn" placeholder="email:password (或 token / 凭据)" spellcheck="false"></textarea>
          <div class="row"><button class="btn" id="pasteBtn">粘贴即换</button><span class="ph">格式同 rt-flow 复制导出 · 粘贴后即刷新</span></div>
        </div>

        <div class="sub-t">轮转 · 一念之转</div>
        <div class="duo">
          <div class="toggle" id="tgRotate">
            <div class="k">自动轮转</div>
            <div class="v"><span class="d" id="rotDot"></span><span id="rotVal">—</span></div>
            <div class="hint">余量耗尽自动换号</div>
          </div>
          <div class="toggle" id="tgBackup">
            <div class="k">备份</div>
            <div class="v"><span class="d" id="bDot"></span><span id="bVal">—</span></div>
            <div class="hint">自动备份 · 开 ⇄ 关</div>
          </div>
        </div>

        <div class="sub-t">动作</div>
        <div class="chips">
          <span class="chip" data-cmd="wam.switchAccount">切换账号</span>
          <span class="chip" data-cmd="wam.panicSwitch">紧急切换</span>
          <span class="chip" data-cmd="wam.addAccount">添加账号</span>
          <span class="chip warn" data-intent="freshIdentity">一键净身</span>
          <span class="chip" data-cmd="wam.openEditor">账号详管</span>
        </div>
      </div>
    </div>

    <!-- ② 路由 (dao-proxy-pro) -->
    <div class="entry" data-entry="proxy">
      <div class="entry-h">
        <div class="ico">路</div>
        <div class="tx"><div class="a">路由 <span class="tag">Proxy Pro</span></div><div class="b">提示词隔离(本源观照) · 外接模型路由</div></div>
        <div class="chev">›</div>
      </div>
      <div class="entry-b">
        <div class="sub-t">一念之转</div>
        <div class="duo">
          <div class="toggle" id="tgRoute">
            <div class="k">路由</div>
            <div class="v"><span class="d" id="rDot"></span><span id="rVal">—</span></div>
            <div class="hint" id="rHint">点按 · 道 ⇄ 官</div>
          </div>
          <div class="toggle" id="tgExtApi">
            <div class="k">外接 API</div>
            <div class="v"><span class="d" id="eDot"></span><span id="eVal">—</span></div>
            <div class="hint">第三方模型渠道</div>
          </div>
        </div>

        <div class="sub-t">模型路由 · 拖排 · 1:1 对</div>
        <div class="chips">
          <span class="chip" data-cmd="dao.openPreview">路由真容(拖排/1:1)</span>
          <span class="chip" data-cmd="dao.eaConfig">外接 API 配置</span>
          <span class="chip" data-cmd="dao.modelUnlock.toggle">模型解锁</span>
          <span class="chip" data-cmd="dao.toggleMode">切模式 道⇄官</span>
        </div>
      </div>
    </div>

    <!-- ③ 全能板 (dao-vsix · Devin Cloud) -->
    <div class="entry" data-entry="cloud">
      <div class="entry-h">
        <div class="ico">板</div>
        <div class="tx"><div class="a">全能板 <span class="tag">Devin Cloud</span></div><div class="b">会话 · 知识 · 剧本 · 密钥 · Git · 备份归入</div></div>
        <div class="chev">›</div>
      </div>
      <div class="entry-b">
        <div class="sub-t">观 · 万物在握</div>
        <div class="counts">
          <div class="cell"><div class="n" id="cSess">—</div><div class="l">会话</div></div>
          <div class="cell"><div class="n" id="cKnow">—</div><div class="l">知识</div></div>
          <div class="cell"><div class="n" id="cPlay">—</div><div class="l">剧本</div></div>
          <div class="cell"><div class="n" id="cSec">—</div><div class="l">密钥</div></div>
          <div class="cell"><div class="n" id="cGit">—</div><div class="l">Git</div></div>
        </div>

        <div class="sub-t">归入 Devin</div>
        <div class="chips">
          <span class="chip" data-cmd="dao.devinInject">自动注入</span>
          <span class="chip" data-cmd="dao.devinSessionCreate">新建会话</span>
          <span class="chip" data-cmd="dao.devinGitConnect">连接 Git</span>
          <span class="chip" data-cmd="dao.devinQuota">刷新额度</span>
        </div>

        <div class="sub-t">备份这段对话</div>
        <div class="chips">
          <span class="chip" data-cmd="wam.devinBackupAll">全量备份</span>
          <span class="chip" data-cmd="wam.devinBackupAccount">备份当前</span>
          <span class="chip" data-cmd="wam.devinExportMd">导出 MD</span>
          <span class="chip" data-cmd="wam.devinSetBackupDir">备份目录</span>
        </div>

        <div class="sub-t">深 · 按需而显</div>
        <div class="chips">
          <span class="chip" data-cmd="dao.openDashboard">面板全景</span>
          <span class="chip" data-cmd="dao.openCloudPanel">Devin 内嵌</span>
        </div>
      </div>
    </div>

  </div>

  <div class="foot">大道至简 · 无为而无不为 · 道法自然</div>
  <div class="toast" id="toast"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
function post(m){ vscode.postMessage(m); }

// 三入口: 点击头部 → 激活该块,其余收起(单活)
document.querySelectorAll('.entry-h').forEach(h=>{
  h.addEventListener('click',()=>{
    const entry = h.parentElement;
    if(entry.classList.contains('active')) return;
    document.querySelectorAll('.entry').forEach(e=>e.classList.remove('active'));
    entry.classList.add('active');
    try{ vscode.setState({ active: entry.getAttribute('data-entry') }); }catch(_){}
  });
});
// 恢复上次激活的入口
try{ const st=vscode.getState(); if(st&&st.active){
  document.querySelectorAll('.entry').forEach(e=>{
    e.classList.toggle('active', e.getAttribute('data-entry')===st.active);
  });
} }catch(_){}

// chips → 命令或编排意图
document.querySelectorAll('[data-cmd]').forEach(el=>{
  el.addEventListener('click',(e)=>{ e.stopPropagation(); post({type:'cmd', id:el.getAttribute('data-cmd')}); });
});
document.querySelectorAll('[data-intent]').forEach(el=>{
  el.addEventListener('click',(e)=>{ e.stopPropagation(); post({type:'intent', id:el.getAttribute('data-intent')}); });
});
// 主账号粘贴即换 (B2)
$('pasteBtn').addEventListener('click',()=>{
  const v = $('pasteIn').value.trim();
  if(!v){ toast('先粘贴 账号:密码 一行', true); return; }
  post({type:'pasteAccount', text:v});
  $('pasteIn').value='';
});
// 一念之转
$('tgRoute').addEventListener('click',()=>post({type:'route'}));
$('tgBackup').addEventListener('click',()=>post({type:'backup'}));
$('tgRotate').addEventListener('click',()=>post({type:'rotate'}));
$('tgExtApi').addEventListener('click',()=>post({type:'cmd', id:'dao.外api.toggle'}));

function setCount(id,v){ $(id).textContent = (v===null||v===undefined)?'—':v; }
function render(s){
  // 服务
  const svc=$('svc'); if(s.service&&s.service.running){svc.classList.add('on');$('svcTx').textContent=':'+s.service.port;}
  else{svc.classList.remove('on');$('svcTx').textContent='离线';}
  // 身
  if(s.id&&s.id.loggedIn){
    $('idName').textContent = s.id.email||'(已登录)';
    $('idSub').textContent = (s.id.org?(s.id.org+' · '):'') + (s.id.apiKeyType?('密钥 '+s.id.apiKeyType):'') ;
  }else{ $('idName').textContent='未登录'; $('idSub').textContent='点「切管」粘贴主账号,或「全能板 · 自动注入」登录'; }
  // 余额(只显美元余量 → 退化为额度百分比) (B2)
  if(s.quota){
    $('qWrap').style.display='block';
    const pct=Math.max(0,Math.min(100,s.quota.pct||0));
    const f=$('qFill'); f.style.width=pct+'%';
    f.className='q-fill'+(s.quota.tone==='bad'?' bad':s.quota.tone==='warn'?' warn':'');
    $('idBal').textContent = (s.quota.balance!=null? s.quota.balance : (s.quota.text!=null?s.quota.text:(pct+'%')));
  }else{ $('qWrap').style.display='none'; $('idBal').textContent=''; }
  // 路由
  const inv = s.route && s.route.mode==='invert';
  $('rVal').textContent = inv?'本源观照':'直连官方';
  $('rDot').className='d'+(inv?'':' off');
  $('rHint').textContent = (inv?'道经置换在行':'锚云直连') + ' · 点按切换';
  // 外接 API
  const ext = s.route && s.route.extApi;
  $('eVal').textContent = ext?'开':'关';
  $('eDot').className='d'+(ext?'':' off');
  // 备份
  const ab = s.cloud && s.cloud.autoBackup;
  $('bVal').textContent = ab?'自动 · 开':'手动';
  $('bDot').className='d'+(ab?'':' off');
  // 轮转
  const ar = s.cloud && s.cloud.autoRotate;
  $('rotVal').textContent = ar?'开':'关';
  $('rotDot').className='d'+(ar?'':' off');
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
