"""bench_predictive.py - Closed-loop benchmark: predictive operation layer vs the
classic "screenshot -> coords -> screenshot to verify" loop, on a real Notepad workload.

It starts a local vm_inner_agent (operating THIS interactive session's desktop), drives a
fixed GUI task two ways, and reports the three axes that matter:
  * wire bytes the agent/LLM must consume (PNG screenshots vs compact signatures)
  * vision/LLM round-trips (2 per step for screenshot+verify vs 0 on the predictive happy path)
  * wall-clock latency

Run inside an interactive session (console/RDP), with a desktop:
    python bench_predictive.py
Pure stdlib; launches notepad and closes it without saving.
"""
import json, os, subprocess, sys, time, urllib.request, socket

PORT = int(os.environ.get('BENCH_PORT', '9099'))
BASE = f'http://127.0.0.1:{PORT}'
HERE = os.path.dirname(os.path.abspath(__file__))


def _post(action, **body):
    body['action'] = action
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + '/', data=data, method='POST',
                                 headers={'Content-Type': 'application/json'})
    raw = urllib.request.urlopen(req, timeout=60).read()
    return len(raw), json.loads(raw.decode('utf-8'))


def _wait_up(timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(BASE + '/health', timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def _free_port(p):
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', p)); s.close(); return True
    except Exception:
        return False


# ---- the fixed task: 6 logical GUI steps on Notepad ----
# Each step is something a real agent would do; we run it both ways.
TASK = [
    ('type_line1', 'type a line into the editor'),
    ('newline',    'press Enter'),
    ('type_line2', 'type a second line'),
    ('select_all', 'Ctrl+A select all'),
    ('open_find',  'Ctrl+F open Find dialog'),
    ('close_find', 'Esc close Find dialog'),
]


def run_baseline(edit_center):
    """Classic loop cost model: for EACH step the LLM needs a screenshot to decide AND a
    screenshot to verify the result => 2 vision calls + 2 PNG payloads per step. We perform
    the same real input so the desktop ends in the same state."""
    cx, cy = edit_center
    bytes_total = 0; vision_calls = 0; shots = 0
    t0 = time.time()
    # focus editor once
    _post('click', x=cx, y=cy); time.sleep(0.1)
    for key, _desc in TASK:
        # (1) screenshot to DECIDE
        n, r = _post('screenshot', format='png'); bytes_total += n; shots += 1; vision_calls += 1
        # (2) the action
        if key == 'type_line1':
            _post('type', text='predictive coding line 1')
        elif key == 'newline':
            _post('key', key='enter')
        elif key == 'type_line2':
            _post('type', text='line 2 \u9053\u6cd5\u81ea\u7136')
        elif key == 'select_all':
            _post('key', key='ctrl+a')
        elif key == 'open_find':
            _post('key', key='ctrl+f')
        elif key == 'close_find':
            _post('key', key='escape')
        time.sleep(0.15)
        # (3) screenshot to VERIFY
        n, r = _post('screenshot', format='png'); bytes_total += n; shots += 1; vision_calls += 1
    return {'mode': 'baseline_screenshot_click', 'seconds': round(time.time() - t0, 2),
            'wire_bytes': bytes_total, 'screenshots': shots, 'vision_calls': vision_calls,
            'matched': None}


def run_predictive(edit_query, edit_rect):
    """Predictive layer: one act() per step carrying a predicted outcome; verification is
    LOCAL (signatures), no screenshots, no per-step vision calls on the happy path.

    Note the predicate choice: typing/Enter mutate the control-tree (text) => 'changed';
    Ctrl+A only repaints a selection highlight (no tree delta) => the cheap observable is a
    region perceptual-hash ('region_changed'); dialogs flip the foreground window."""
    bytes_total = 0; vision_calls = 0; shots = 0; matched = 0
    steps = [
        {'op': 'type', 'target': edit_query, 'text': 'predictive coding line 1',
         'expect': {'changed': True}},
        {'op': 'key', 'key': 'enter', 'expect': {'changed': True}},
        {'op': 'type', 'text': 'line 2 \u9053\u6cd5\u81ea\u7136', 'expect': {'changed': True}},
        {'op': 'key', 'key': 'ctrl+a', 'expect': {'region_changed': edit_rect}},
        {'op': 'key', 'key': 'ctrl+f', 'expect': {'foreground': 'Find'}},
        {'op': 'key', 'key': 'escape', 'expect': {'foreground': 'Notepad'}},
    ]
    t0 = time.time()
    for st in steps:
        n, r = _post('act', **st)
        bytes_total += n
        if r.get('matched'):
            matched += 1
        if r.get('region_png_base64'):  # escalation => a (cropped) vision payload
            shots += 1; vision_calls += 1
    return {'mode': 'predictive_op_layer', 'seconds': round(time.time() - t0, 2),
            'wire_bytes': bytes_total, 'screenshots': shots, 'vision_calls': vision_calls,
            'matched': f'{matched}/{len(steps)}'}


def main():
    if not _free_port(PORT):
        print(f'port {PORT} busy; set BENCH_PORT', file=sys.stderr); return 2
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        if not _wait_up():
            print('inner agent did not come up', file=sys.stderr); return 2
        # fresh Notepad
        _post('launch', command='notepad')
        time.sleep(1.5)
        _post('activate', title='Notepad'); time.sleep(0.3)
        # locate the editor control (RichEdit on Win11 Notepad, Edit on classic)
        _, f = _post('find', **{'class': 'Edit'})
        if not f.get('elements'):
            _, f = _post('find', **{'class': 'RichEdit'})
        if not f.get('elements'):
            # fall back to the Notepad window center
            _, info = _post('ui_info')
            win = next((w for w in info.get('windows', []) if 'Notepad' in (w.get('title') or '')), None)
            if not win:
                print('no Notepad window', file=sys.stderr); return 2
            r = win['rect']; center = [(r[0] + r[2]) // 2, (r[1] + r[3]) // 2]
            edit_query = {'x': center[0], 'y': center[1]}; edit_rect = r
        else:
            e = f['elements'][0]; center = e['center']
            edit_query = {'class': e['class']}; edit_rect = e['rect']

        pred = run_predictive(edit_query, edit_rect)
        # reset editor for the baseline pass
        _post('click', x=center[0], y=center[1]); _post('key', key='ctrl+a'); _post('key', key='delete')
        base = run_baseline(center)

        report = {'task_steps': len(TASK), 'baseline': base, 'predictive': pred,
                  'gains': {
                      'wire_bytes_x': round(base['wire_bytes'] / max(pred['wire_bytes'], 1), 1),
                      'vision_calls': f"{base['vision_calls']} -> {pred['vision_calls']}",
                      'screenshots': f"{base['screenshots']} -> {pred['screenshots']}",
                      'latency_x': round(base['seconds'] / max(pred['seconds'], 0.01), 1)}}
        print(json.dumps(report, ensure_ascii=False, indent=2))
        out = os.path.join(HERE, 'bench_predictive_result.json')
        open(out, 'w', encoding='utf-8').write(json.dumps(report, ensure_ascii=False, indent=2))
        print('\nwrote', out)
        return 0
    finally:
        try:
            subprocess.run('taskkill /F /IM notepad.exe', shell=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        srv.terminate()


if __name__ == '__main__':
    sys.exit(main())
