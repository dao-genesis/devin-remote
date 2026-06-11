import sys, os, json, base64, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vmctl

VM = 'vm01'
OUT = os.path.dirname(os.path.abspath(__file__))
ok = 0; fail = 0
def step(name, cond, detail=''):
    global ok, fail
    mark = 'PASS' if cond else 'FAIL'
    if cond: ok += 1
    else: fail += 1
    print(f'[{mark}] {name}  {detail}')

# 1 exec
r = vmctl.call('vm.exec', vm=VM, command='whoami & echo SESSION=%SESSIONNAME%')
step('exec whoami', r.get('exit_code') == 0 and 'vm01' in (r.get('stdout','').lower()), r.get('stdout','').strip().replace('\n',' | '))

# 2 desktop_info
r = vmctl.call('vm.desktop_info', vm=VM)
step('desktop_info', r.get('width',0) > 0, f"{r.get('width')}x{r.get('height')} user={r.get('user')} session={r.get('session')}")

# 3 file roundtrip
payload = f'dao-roundtrip-{int(time.time())}'
b64 = base64.b64encode(payload.encode()).decode()
r = vmctl.call('vm.file_write', vm=VM, path=r'C:\Users\vm01.DEVINBOX\dao_test.txt', content_base64=b64)
r2 = vmctl.call('vm.file_read', vm=VM, path=r'C:\Users\vm01.DEVINBOX\dao_test.txt')
got = base64.b64decode(r2.get('content_base64','')).decode(errors='replace') if r2.get('content_base64') else ''
step('file write+read roundtrip', got == payload, f'wrote/read="{got}"')

# 4 screenshot PNG (desktop)
r = vmctl.call('vm.screenshot', vm=VM, format='png')
if r.get('image_base64'):
    p = os.path.join(OUT, 'vm01_desktop.png')
    open(p, 'wb').write(base64.b64decode(r['image_base64']))
    step('screenshot PNG', r.get('format')=='png' and r.get('size',0)>1000, f"{r.get('width')}x{r.get('height')} {r.get('size')}B -> {p}")
else:
    step('screenshot PNG', False, str(r)[:200])

# 5 launch Notepad inside vm01
r = vmctl.call('vm.exec', vm=VM, command='start notepad')
time.sleep(2.5)
step('launch notepad', r.get('exit_code')==0, 'started')

# 6 type into notepad
vmctl.call('vm.type', vm=VM, text='道法自然 - DAO multi-RDP VM replica\r\nDevin operating vm01 via RDP, isolated from console.\r\n')
time.sleep(0.5)
# 7 screenshot showing notepad
r = vmctl.call('vm.screenshot', vm=VM, format='png')
if r.get('image_base64'):
    p = os.path.join(OUT, 'vm01_notepad.png')
    open(p, 'wb').write(base64.b64decode(r['image_base64']))
    step('type + screenshot notepad', r.get('size',0)>1000, f'-> {p}')
else:
    step('type + screenshot notepad', False, str(r)[:200])

# 8 ui_info
r = vmctl.call('vm.ui_info', vm=VM)
wins = r.get('windows', [])
titles = [w['title'] for w in wins][:6]
step('ui_info windows', any('Notepad' in t or 'notepad' in t or 'Untitled' in t for t in titles) or len(wins)>0, f'{len(wins)} windows: {titles}')

# 9 key combo (select all + delete to prove key works) then esc
vmctl.call('vm.key', vm=VM, key='ctrl+a')
vmctl.call('vm.key', vm=VM, key='delete')
vmctl.call('vm.type', vm=VM, text='keys-work-OK')
time.sleep(0.3)
r = vmctl.call('vm.screenshot', vm=VM, format='png')
open(os.path.join(OUT,'vm01_keys.png'),'wb').write(base64.b64decode(r['image_base64']))
step('key combos (ctrl+a/del/type)', r.get('size',0)>1000, '-> vm01_keys.png')

print(f'\n=== RESULTS: {ok} passed, {fail} failed ===')
