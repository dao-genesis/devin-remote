"""Does a TEMPORAL cue separate rotate (horizontal drag) from tilt (vertical drag) on a pure
<canvas>? Sample sub-frames during the held-button drag and compute the dominant motion axis via
Lucas-Kanade optical flow.

HONEST RESULT (recorded from practice, not assumed): a single before/after frame gives ZERO
direction discrimination (magnitude/locus are phase-stable but direction-blind; signed delta is
phase-dependent; anisotropy tracks object shape). The temporal flow MOVES the needle -- tilt reads
negative (vertical) fairly reliably -- but on a continuous wireframe the rotate signal stays weak
and the margin is small and RESOLUTION-DEPENDENT (at cols=40 tilt separates, rotate is ambiguous;
at cols=64 rotate sharpens but tilt weakens). So flow_axis is shipped as an ADVISORY direction cue,
never a hard gate: it leans correctly on average but is not a confident classifier here. Robust
rotate/tilt separation on an arbitrary continuous surface needs dense/windowed flow with an explicit
rotation model, or a vision escalation. This script is the reproducible evidence for that boundary."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9099; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'canvas_lab.html').replace('\\', '/')


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


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        wi = post('ui_info')
        cands = [w for w in wi['windows'] if any(k in (w.get('title') or '') for k in ('Chrome', 'Chromium', 'Edge'))]
        if not cands:
            print('NO BROWSER'); return
        win = cands[0]; r = win['rect']
        post('activate', title=win['title'][:20]); time.sleep(0.5)
        ab = post('find', text='Address and search bar', control_type='Edit')
        c = ab['elements'][0]['center']
        post('act', op='click', x=c[0], y=c[1]); time.sleep(0.2)
        post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL); post('act', op='key', key='enter')
        time.sleep(2.5)

        cx = (r[0] + r[2]) // 2; cy = r[1] + 350
        region = [cx - 200, cy - 150, cx + 200, cy + 150]  # tight on the cube, not the empty canvas
        print('=== temporal motion axis: rotate (horizontal) vs tilt (vertical) ===')
        for label, (x, y, x2, y2) in [
                ('ROTATE drag_right ', (cx - 130, cy, cx + 130, cy)),
                ('ROTATE drag_left  ', (cx + 130, cy, cx - 130, cy)),
                ('TILT   drag_down  ', (cx, cy - 110, cx, cy + 110)),
                ('TILT   drag_up    ', (cx, cy + 110, cx, cy - 110))]:
            res = post('flow_probe', x=x, y=y, x2=x2, y2=y2, region=region, cols=40, samples=10)
            f = res.get('flow', {})
            verdict = 'rotate' if f.get('axis', 0) > 0.15 else ('tilt' if f.get('axis', 0) < -0.15 else 'ambiguous')
            print('   %s axis=%+.3f (sx=%g sy=%g pairs=%d) mag=%.2f -> %s' %
                  (label, f.get('axis', 0), f.get('sx', 0), f.get('sy', 0), f.get('pairs', 0),
                   res.get('change', {}).get('mag', 0), verdict))
            time.sleep(0.3)
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
