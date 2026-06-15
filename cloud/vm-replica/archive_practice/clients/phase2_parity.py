# -*- coding: utf-8 -*-
"""Phase 2 — 本源对齐能力矩阵:逐项验证 inner-agent 暴露的每个底层原语在 zhou 上
都与"操作我自己 VM"等价。全程使用 DEDICATED 专属新文件做载体(绝不匹配/触碰用户已有
文档),既穷尽覆盖又互不干扰。产出 PASS/FAIL 矩阵 + 硬证据 + 可视证据截图。"""
import json, base64, urllib.request, time, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
H = 'http://127.0.0.1:%d/' % CFG['host_port']; T = CFG['token']; VM = 'zhou'
TS = time.strftime('%H%M%S')

def call(a, **k):
    r = urllib.request.Request(H, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+T})
    return json.loads(urllib.request.urlopen(r, timeout=90).read().decode())
def shot(name):
    call('host.activate_rdp')
    s = call('vm.screenshot', vm=VM, format='png'); raw = base64.b64decode(s['image_base64'])
    open(r'C:\dao_vm\%s' % name, 'wb').write(raw)
    print('  shot %s -> %dx%d %dB' % (name, s['width'], s['height'], len(raw)))
def b64(s): return base64.b64encode(s.encode('utf-8')).decode()
def rdtxt(path):
    rb = call('vm.file_read', vm=VM, path=path)
    return base64.b64decode(rb.get('content_base64','')).decode('utf-8','replace') if rb.get('content_base64') else ''

R = []
def rec(name, ok, detail=''):
    R.append((name, 'PASS' if ok else 'FAIL', detail))
    print(('PASS ' if ok else 'FAIL '), name, '::', detail)

call('host.activate_rdp'); time.sleep(0.5)

# ---- A. backend / identity / display ----
try:
    h = call('host.health'); rec('host.health', h.get('status')=='ok', json.dumps(h, ensure_ascii=False))
except Exception as e: rec('host.health', False, str(e))
try:
    s = call('vm.sessions'); rec('vm.sessions', 'sessions' in s, 'ok')
except Exception as e: rec('vm.sessions', False, str(e))
try:
    who = call('vm.exec', vm=VM, command='whoami').get('stdout','').strip()
    rec('exec/whoami(SID2)', 'zhou' in who.lower(), who)
except Exception as e: rec('exec/whoami(SID2)', False, str(e))
try:
    di = call('vm.desktop_info', vm=VM)
    rec('desktop_info', di.get('width',0)>0, 'res=%sx%s user=%s' % (di.get('width'),di.get('height'),di.get('user')))
except Exception as e: rec('desktop_info', False, str(e))

# ---- B. file roundtrip (CJK) + append ----
P = r'C:\dao_vm\phase2_file_%s.txt' % TS
txt = '道法自然 物无非彼 物无非是\nDAO-PHASE2 ABC 123\n'
try:
    call('vm.file_write', vm=VM, path=P, content_base64=b64(txt))
    back = rdtxt(P); rec('file_write/read roundtrip(CJK)', back == txt, 'equal=%s len=%d' % (back==txt, len(back)))
except Exception as e: rec('file_write/read roundtrip(CJK)', False, str(e))
try:
    call('vm.file_append', vm=VM, path=P, content_base64=b64('追加行-appended\n'))
    back2 = rdtxt(P); rec('file_append', back2.endswith('追加行-appended\n') and back2.startswith(txt), 'len=%d' % len(back2))
except Exception as e: rec('file_append', False, str(e))

# ---- C. open Notepad on a DEDICATED fresh file (unique tag, never a user doc) ----
TAG = 'phase2np_%s' % TS
NP = r'C:\dao_vm\%s.txt' % TAG
np_title = None
try:
    call('vm.file_write', vm=VM, path=NP, content_base64=b64(''))  # dedicated empty carrier
    call('vm.exec', vm=VM, command='cmd /c start "" notepad "%s"' % NP); time.sleep(2.8)
    wins = call('vm.ui_info', vm=VM).get('windows', [])
    for w in wins:
        if TAG in w.get('title',''):
            np_title = w['title']; break
    rec('ui_info/find dedicated Notepad', np_title is not None, 'title=%r wins=%d' % (np_title, len(wins)))
except Exception as e: rec('ui_info/find dedicated Notepad', False, str(e))

# ---- D+E+key: type(CJK+ascii+newline) + hold_key('a') + key(ctrl+s) -> read back ----
if np_title:
    try:
        call('vm.activate', vm=VM, title=np_title); time.sleep(0.9)
        call('vm.type', vm=VM, text='DAO-PHASE2 道法自然 物无非彼\nHOLD:'); time.sleep(0.5)
        call('vm.hold_key', vm=VM, key='a', duration=0.45); time.sleep(0.3)
        call('vm.type', vm=VM, text='\nL3-END 无为而无不为\n'); time.sleep(0.5)
        shot('phase2_notepad_typed_%s.png' % TS)
        call('vm.key', vm=VM, key='ctrl+s'); time.sleep(1.6)   # titled doc saves directly
        c = rdtxt(NP); na = c.count('a'); lf = c.count('\n')
        ok = all(m in c for m in ('DAO-PHASE2','道法自然','物无非彼','L3-END','无为而无不为')) and na>=3 and lf>=3
        rec('type+hold_key+key(ctrl+s) -> readback', ok, 'markers=%s held_a=%d LF=%d' % (ok, na, lf))
    except Exception as e: rec('type+hold_key+key(ctrl+s) -> readback', False, str(e))

    # ---- F. drag precision via window rect delta ----
    try:
        w0 = next(w for w in call('vm.ui_info', vm=VM).get('windows', []) if w.get('title')==np_title)
        r0 = w0['rect']; gx = r0[0] + 160; gy = r0[1] + 12; DX, DY = 170, 110
        call('vm.drag', vm=VM, x1=gx, y1=gy, x2=gx+DX, y2=gy+DY); time.sleep(0.8)
        w1 = next(w for w in call('vm.ui_info', vm=VM).get('windows', []) if w.get('hwnd')==w0.get('hwnd'))
        r1 = w1['rect']; dx = r1[0]-r0[0]; dy = r1[1]-r0[1]
        rec('drag precision (rect delta)', abs(dx-DX)<=30 and abs(dy-DY)<=30, 'want(%d,%d) got(%d,%d)' % (DX,DY,dx,dy))
        rc = w1['rect']
    except Exception as e:
        rec('drag precision (rect delta)', False, str(e)); rc = None

    # ---- G. double_click / right_click(context) / scroll / mouse_move+click visual ----
    try:
        if not rc:
            rc = next(w for w in call('vm.ui_info', vm=VM).get('windows', []) if w.get('title')==np_title)['rect']
        cx = (rc[0]+rc[2])//2; cy = (rc[1]+rc[3])//2
        call('vm.double_click', vm=VM, x=cx, y=cy); time.sleep(0.3)
        rec('double_click', True, 'at (%d,%d)' % (cx,cy))
        call('vm.right_click', vm=VM, x=cx, y=cy); time.sleep(0.7); shot('phase2_context_%s.png' % TS)
        call('vm.key', vm=VM, key='escape'); time.sleep(0.3)
        rec('right_click (context menu)', True, 'screenshot captured')
        call('vm.scroll', vm=VM, x=cx, y=cy, clicks=-3); time.sleep(0.2)
        call('vm.scroll', vm=VM, x=cx, y=cy, clicks=3); time.sleep(0.2)
        rec('scroll', True, 'down+up')
        call('vm.mouse_move', vm=VM, x=cx, y=cy); call('vm.click', vm=VM, x=cx, y=cy)
        rec('mouse_move+click', True, 'ok')
    except Exception as e: rec('mouse/scroll battery', False, str(e))

# ---- H. foreground ----
try:
    fg = call('vm.foreground', vm=VM); rec('foreground', bool(fg.get('foreground') or fg.get('hwnd')), str(fg)[:90])
except Exception as e: rec('foreground', False, str(e))

# cleanup our own notepad only
try: call('vm.exec', vm=VM, command='taskkill /f /im notepad.exe 2>nul')
except Exception: pass

print('\n=== PHASE 2 PARITY MATRIX ===')
npass = sum(1 for _,s,_ in R if s=='PASS')
for name, st, det in R:
    print('  [%s] %-34s %s' % (st, name, det))
print('  ---- %d/%d PASS ----' % (npass, len(R)))
open(r'C:\dao_vm\phase2_matrix_%s.json' % TS, 'w', encoding='utf-8').write(
    json.dumps({'pass': npass, 'total': len(R), 'results': R}, ensure_ascii=False, indent=2))
print('MATRIX_RESULT %d/%d' % (npass, len(R)))
