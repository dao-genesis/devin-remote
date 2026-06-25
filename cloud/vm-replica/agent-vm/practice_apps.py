"""practice_apps.py - high-intensity multi-app practice for the predictive operation layer.

Drives several real Windows apps through act()/where_changed and records, per step, whether the
prediction matched and WHICH cheap observable carried it (control-tree vs visual vs foreground).
The point is to stress the architecture across the human-computer interaction archetypes -- text
editing, canvas drawing (no control tree), ribbon/menus, button grids, dialogs, context menus --
and surface where it breaks, with zero screenshots on the happy path.

Run inside an interactive session (console/RDP) with a desktop:
    python practice_apps.py
Pure stdlib. Launches apps and force-closes them without saving.
"""
import json, os, subprocess, sys, time, urllib.request

PORT = int(os.environ.get('PRACTICE_PORT', '9097'))
BASE = f'http://127.0.0.1:{PORT}'
HERE = os.path.dirname(os.path.abspath(__file__))


def post(action, **body):
    body['action'] = action
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/', data=data, method='POST',
                                 headers={'Content-Type': 'application/json'})
    raw = urllib.request.urlopen(req, timeout=60).read()
    return len(raw), json.loads(raw.decode('utf-8'))


def wait_up(timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if urllib.request.urlopen(BASE + '/health', timeout=2).status == 200:
                return True
        except Exception:
            time.sleep(0.3)
    return False


def _via(reasons):
    for r in reasons or []:
        if r.startswith('changed=') and '(' in r:
            return r.split('(')[1].rstrip(')')
        if r.startswith('region_changed'):
            return 'region'
        if r.startswith('foreground'):
            return 'foreground'
        if r.startswith('menu_open'):
            return 'menu'
        if r.startswith('appears') or r.startswith('disappears'):
            return 'tree-find'
        if r.startswith('value'):
            return 'value'
    return '-'


def step(rec, desc, **act_body):
    n, r = post('act', **act_body)
    matched = bool(r.get('matched'))
    rec['steps'].append({'desc': desc, 'matched': matched, 'via': _via(r.get('reasons')),
                         'attempts': r.get('attempts'), 'bytes': n})
    rec['bytes'] += n
    if matched:
        rec['matched'] += 1
    print('   [%s] %-32s via=%-8s attempts=%s' % ('OK ' if matched else 'XX ', desc, _via(r.get('reasons')), r.get('attempts')))
    time.sleep(0.15)
    return r


def kill(*imgs):
    for im in imgs:
        subprocess.run('taskkill /F /IM ' + im, shell=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def scen_notepad(W, H):
    rec = {'app': 'notepad', 'archetype': 'text-edit (control-tree)', 'steps': [], 'matched': 0, 'bytes': 0}
    post('launch', command='notepad'); time.sleep(1.5); post('activate', title='Notepad'); time.sleep(0.4)
    edit = {'class': 'Edit'}
    step(rec, 'type first line', op='type', target=edit, text='practice line 1', expect={'changed': True})
    step(rec, 'press Enter', op='key', key='enter', expect={'changed': True})
    step(rec, 'type second line', op='type', text='line 2', expect={'changed': True})
    step(rec, 'Ctrl+A select all', op='key', key='ctrl+a', expect={'region_changed': [int(W*0.0), int(H*0.1), int(W*0.9), int(H*0.9)]})
    step(rec, 'Ctrl+F open Find', op='key', key='ctrl+f', expect={'foreground': 'Find'})
    step(rec, 'Esc close Find', op='key', key='escape', expect={'foreground': 'Notepad'})
    kill('notepad.exe')
    return rec


def scen_wordpad(W, H):
    rec = {'app': 'wordpad', 'archetype': 'rich-text + ribbon', 'steps': [], 'matched': 0, 'bytes': 0}
    post('launch', command='write'); time.sleep(2.5); post('activate', title='WordPad'); time.sleep(0.5)
    step(rec, 'type text', op='type', text='dao fa zi ran', expect={'changed': True})
    step(rec, 'select all (Ctrl+A)', op='key', key='ctrl+a', expect={'region_changed': [int(W*0.05), int(H*0.2), int(W*0.95), int(H*0.6)]})
    step(rec, 'bold (Ctrl+B)', op='key', key='ctrl+b', expect={'region_changed': [int(W*0.05), int(H*0.2), int(W*0.95), int(H*0.6)]})
    step(rec, 'type after bold', op='type', text=' BOLD', expect={'changed': True})
    kill('wordpad.exe')
    return rec


def scen_mspaint(W, H):
    rec = {'app': 'mspaint', 'archetype': 'canvas (NO control tree -> visual)', 'steps': [], 'matched': 0, 'bytes': 0}
    post('launch', command='mspaint'); time.sleep(2.5); post('activate', title='Paint'); time.sleep(0.5)
    canvas = [int(W*0.3), int(H*0.4), int(W*0.7), int(H*0.75)]
    cx, cy = int(W*0.45), int(H*0.55)
    step(rec, 'draw stroke 1 (changed/visual)', op='drag', x=cx, y=cy, x2=cx+110, y2=cy+70, expect={'changed': True})
    step(rec, 'draw stroke 2 (region_changed)', op='drag', x=cx+20, y=cy+10, x2=cx+140, y2=cy-40, expect={'region_changed': canvas})
    # where_changed localization
    _, b0 = post('where_changed', region=canvas)
    post('act', op='drag', x=int(W*0.55), y=int(H*0.5), x2=int(W*0.6), y2=int(H*0.6))
    _, wc = post('where_changed', region=canvas, baseline=b0['baseline'])
    loc_ok = bool(wc.get('changed'))
    rec['steps'].append({'desc': 'where_changed localizes stroke', 'matched': loc_ok,
                         'via': 'tiles', 'attempts': 1, 'bytes': 0, 'bbox': wc.get('bbox')})
    if loc_ok:
        rec['matched'] += 1
    print('   [%s] %-32s via=tiles    bbox=%s' % ('OK ' if loc_ok else 'XX ', 'where_changed localizes stroke', wc.get('bbox')))
    kill('mspaint.exe')
    return rec


def scen_contextmenu(W, H):
    rec = {'app': 'notepad', 'archetype': 'context menu (transient #32768 popup, off-tree)', 'steps': [], 'matched': 0, 'bytes': 0}
    post('launch', command='notepad'); time.sleep(1.5); post('activate', title='Notepad'); time.sleep(0.4)
    post('act', op='type', target={'class': 'Edit'}, text='right-click me')
    ex, ey = int(W*0.4), int(H*0.4)
    step(rec, 'right-click -> menu_open', op='right_click', x=ex, y=ey, expect={'menu_open': True})
    step(rec, 'Esc -> menu closed', op='key', key='escape', expect={'menu_open': False})
    kill('notepad.exe')
    return rec


def scen_calc(W, H):
    rec = {'app': 'calc', 'archetype': 'button grid (semantic find + value)', 'steps': [], 'matched': 0, 'bytes': 0}
    post('launch', command='calc'); time.sleep(2.5)
    # calc window title is "Calculator"; activate it
    post('activate', title='Calculator'); time.sleep(0.6)
    _, f = post('find', text='Seven')
    if not f.get('count'):
        _, f = post('find', text='7')
    if not f.get('count'):
        rec['note'] = 'calculator buttons not found in control tree (skipped)'
        print('   [-- ] calculator buttons not found -> skip')
        kill('Calculator.exe', 'CalculatorApp.exe', 'win32calc.exe')
        return rec
    step(rec, "click '7'", op='click', target={'text': 'Seven'}, expect={'changed': True})
    step(rec, "click '+'", op='click', target={'text': 'Plus'}, expect={'changed': True})
    step(rec, "click '8'", op='click', target={'text': 'Eight'}, expect={'changed': True})
    step(rec, "click '='", op='click', target={'text': 'Equals'}, expect={'changed': True})
    kill('Calculator.exe', 'CalculatorApp.exe', 'win32calc.exe')
    return rec


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    report = {'session': 'practice_apps', 'scenarios': []}
    try:
        if not wait_up():
            print('agent did not start'); return
        _, di = post('desktop_info'); W, H = di['width'], di['height']
        print('screen', W, H)
        for fn in (scen_notepad, scen_wordpad, scen_mspaint, scen_contextmenu, scen_calc):
            print('\n=== %s ===' % fn.__name__)
            try:
                rec = fn(W, H)
            except Exception as e:
                rec = {'app': fn.__name__, 'error': repr(e), 'steps': [], 'matched': 0, 'bytes': 0}
                print('   ERROR', e)
            rec['total'] = len(rec['steps'])
            report['scenarios'].append(rec)
        tot = sum(r['matched'] for r in report['scenarios'])
        n = sum(r['total'] for r in report['scenarios'])
        byt = sum(r.get('bytes', 0) for r in report['scenarios'])
        report['summary'] = {'matched': tot, 'total': n, 'wire_bytes': byt,
                             'vision_calls': 0, 'screenshots': 0}
        print('\n==== SUMMARY: %d/%d predictions matched, %d wire bytes, 0 screenshots, 0 vision calls ====' % (tot, n, byt))
        out = os.path.join(HERE, 'practice_apps_result.json')
        json.dump(report, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print('wrote', out)
    finally:
        kill('notepad.exe', 'wordpad.exe', 'mspaint.exe', 'Calculator.exe', 'CalculatorApp.exe', 'win32calc.exe')
        srv.terminate()


if __name__ == '__main__':
    main()
