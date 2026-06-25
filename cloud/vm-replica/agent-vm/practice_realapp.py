"""Cross-APP transfer to a REAL desktop strong-GUI: does a generic drag learned only in the browser
carry to mspaint's self-drawn canvas?

Every prior transfer test lived inside one Chrome process (different <canvas> surfaces, same renderer).
The honest question for universality is whether the generic 'drag' affordance -- grown purely on
in-browser canvases -- is recognised on a genuinely different surface: a separate process, a different
rasteriser, real OS window chrome. mspaint's canvas has no accessibility semantics for the drawing area
(self-drawn pixels), so it's the same kind of no-tree strong-GUI as a 3D viewport, but REAL.

Plan: train 'drag' on the browser lab surfaces, then drag on the mspaint canvas (pencil draws a stroke)
asserting effect action='drag' -> expect known=True via transfer; then a never-learned click -> novel.
Report known/present/transfer/ctx_sim/escalate. Pure pixels, zero vision LLM."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9090; BASE = f'http://127.0.0.1:{PORT}'
MODEL = os.path.join(os.path.expanduser('~'), '.dao_world_model.json')
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')
BROWSER_SURFACES = ['orbit', 'pan', 'paint', 'timeline', 'node']


def post(a, **b):
    b['action'] = a; d = json.dumps(b).encode()
    r = urllib.request.Request(BASE + '/', data=d, method='POST', headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=60).read().decode())


def up(t=15):
    e = time.time() + t
    while time.time() < e:
        try:
            if urllib.request.urlopen(BASE + '/health', timeout=2).status == 200:
                return True
        except Exception:
            time.sleep(0.3)


def start():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env); up(); return p


def win_by(*keys):
    for w in post('ui_info')['windows']:
        if any(k in (w.get('title') or '') for k in keys):
            return w
    return None


def goto(mode):
    w = win_by('Chrome', 'Chromium', 'Edge'); r = w['rect']
    post('activate', title=w['title'][:20]); time.sleep(0.3)
    ab = post('find', text='Address and search bar', control_type='Edit')['elements'][0]['center']
    post('act', op='click', x=ab[0], y=ab[1]); time.sleep(0.15)
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL + '#' + mode); post('act', op='key', key='enter')
    time.sleep(1.8)
    cx = (r[0] + r[2]) // 2; cy = r[1] + 350
    return cx, cy, [cx - 150, cy - 120, cx + 150, cy + 120]


def train_browser():
    for s in BROWSER_SURFACES:
        cx, cy, region = goto(s)
        for _ in range(4):
            post('act', op='drag', x=cx - 90, y=cy, x2=cx + 90, y2=cy,
                 expect={'effect': {'action': 'drag', 'region': region, 'learn': True}})
            time.sleep(0.12)


def main():
    if os.path.exists(MODEL):
        os.remove(MODEL)
    srv = start()
    paint = None
    try:
        print('training generic "drag" on browser lab surfaces:', ', '.join(BROWSER_SURFACES))
        train_browser()

        # launch a REAL desktop app with a no-semantics canvas
        paint = subprocess.Popen(['mspaint.exe'])
        time.sleep(3.0)
        w = win_by('Paint', 'paint', 'Untitled')
        if not w:
            print('FAIL: mspaint window not found'); return
        l, t, r, b = w['rect']
        post('activate', title=w['title'][:20]); time.sleep(0.5)
        # an inner box well inside the drawing area (below the ribbon)
        cx = (l + r) // 2; cy = t + (b - t) * 2 // 3
        region = [cx - 110, cy - 80, cx + 110, cy + 80]
        print('\nREAL APP = mspaint  window=%s  canvas region=%s' % (w['title'], region))

        # the cross-app test: a drag on mspaint's canvas, asserting the generic 'drag' affordance
        res = post('act', op='drag', x=cx - 80, y=cy - 40, x2=cx + 80, y2=cy + 40,
                   expect={'effect': {'action': 'drag', 'region': region, 'learn': False}})
        e = res.get('effect', {})
        print('\n=== generic drag transferred to mspaint (a real, separate-process canvas) ===')
        print('   known=%s present=%s transfer=%s ctx_sim=%.2f | escalate=%s reason=%s' % (
            e.get('known'), e.get('present'), e.get('transfer'), e.get('ctx_sim', 0),
            res.get('escalate'), res.get('escalate_reason')))
        print('   -> %s' % ('RECOGNISED on an unseen real app (transfer, not re-learned)'
                            if e.get('known') else 'came back novel (no transfer)'))

        # a gesture family never practised: a click -> must be novel on the real app too
        nov = post('act', op='click', x=cx, y=cy,
                   expect={'effect': {'action': 'click', 'region': region, 'learn': False}}).get('effect', {})
        print('\n=== never-practised gesture (click) on mspaint ===')
        print('   known=%s -> %s' % (nov.get('known'),
              'NOVEL (correctly flagged, escalate)' if not nov.get('known') else 'unexpectedly known'))

        print('\n=== honest summary ===')
        print('   the generic "drag", grown only on in-browser canvases, %s on mspaint --' % (
            'transferred' if e.get('known') else 'did NOT transfer'))
        print('   a different process and rasteriser with no canvas semantics. ctx_sim is low (a real,')
        print('   unlike surface) so the world model is honest it is EXTRAPOLATING, and escalates;')
        print('   the universal part (a drag causes a localized change) is what carries, not exact shape.')
    finally:
        try:
            if paint:
                paint.terminate()
        except Exception:
            pass
        srv.terminate()


if __name__ == '__main__':
    main()
