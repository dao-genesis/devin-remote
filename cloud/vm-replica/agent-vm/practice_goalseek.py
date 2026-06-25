"""Goal-directed control = the world model as a CONTROLLER, not just a verifier.

This closes the loop the whole pivot was about: predict-first, act only to APPROACH a goal, measure
the residual cheaply (pixels), reflex-correct, repeat -- active inference / visual servoing, zero
vision LLM. On the pure-<canvas> 'node' surface (a draggable box, no semantics) the task is: drive the
bright object's centroid to a target point.

Loop:
  1. measure the object centroid (region_centroid, cheap pixels).
  2. CALIBRATE once: drag a known vector, re-measure -> estimate the gain g (how far the object moves
     per dragged pixel). This is the forward model learned from one probe, not hard-coded.
  3. CONTROL: error = target - current; predicted drag = error / g (clamped); execute; re-measure the
     residual. If the prediction was right the error collapses in one step; if not, the residual IS the
     prediction error and the next iteration corrects it. Stop at tolerance or max steps.
Honest reporting: per-iteration residual, whether it converged, final error. No faking."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9093; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')


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
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    up(); return p


def goto(mode):
    wi = post('ui_info')
    win = [w for w in wi['windows'] if any(k in (w.get('title') or '') for k in ('Chrome', 'Chromium', 'Edge'))][0]
    r = win['rect']; post('activate', title=win['title'][:20]); time.sleep(0.3)
    ab = post('find', text='Address and search bar', control_type='Edit')['elements'][0]['center']
    post('act', op='click', x=ab[0], y=ab[1]); time.sleep(0.15)
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL + '#' + mode); post('act', op='key', key='enter')
    time.sleep(1.8)
    cx = (r[0] + r[2]) // 2; cy = r[1] + 350
    return [cx - 150, cy - 120, cx + 150, cy + 120]


def centroid(region):
    return post('region_centroid', region=region, cols=40, rows=32)


def drag(px, py, dx, dy):
    post('act', op='drag', x=px, y=py, x2=px + dx, y2=py + dy); time.sleep(0.2)


def main():
    srv = start()
    try:
        region = goto('node')
        c = centroid(region)
        print('node object found at nx=%.3f ny=%.3f mass=%.0f' % (c['nx'], c['ny'], c['mass']))

        # 2) calibrate the gain from ONE probe drag (forward model from practice, not hard-coded)
        cal = 60
        drag(c['px'], c['py'], cal, 0)
        c1 = centroid(region)
        gx = (c1['nx'] - c['nx']) / cal
        drag(c1['px'], c1['py'], 0, cal)
        c2 = centroid(region)
        gy = (c2['ny'] - c1['ny']) / cal
        print('calibrated gain: gx=%.5f gy=%.5f  (normalised centroid moved per dragged pixel)' % (gx, gy))
        if abs(gx) < 1e-5 or abs(gy) < 1e-5:
            print('FAIL: object did not respond to drag; cannot control'); return

        # 4) goal: bring the object centroid to a chosen target inside the region
        tx, ty = 0.30, 0.65
        print('\ngoal: drive object centroid to (%.2f, %.2f)' % (tx, ty))
        print('iter | nx     ny    | residual | drag(px)')
        cur = centroid(region)
        tol = 0.02
        for k in range(6):
            ex = tx - cur['nx']; ey = ty - cur['ny']
            res = (ex * ex + ey * ey) ** 0.5
            print(' %d   | %.3f %.3f | %.4f' % (k, cur['nx'], cur['ny'], res), end='')
            if res <= tol:
                print('   | -- (within tolerance, stop)'); break
            dxp = max(-160, min(160, int(ex / gx))); dyp = max(-160, min(160, int(ey / gy)))
            print('   | (%d, %d)' % (dxp, dyp))
            drag(cur['px'], cur['py'], dxp, dyp)
            cur = centroid(region)
        exf = tx - cur['nx']; eyf = ty - cur['ny']; resf = (exf * exf + eyf * eyf) ** 0.5
        print('\n=== honest result ===')
        print('   final residual = %.4f  (%s)' % (resf, 'CONVERGED to goal' if resf <= tol else 'did not fully converge'))
        print('   the world model PREDICTED the drag from a learned gain, ACTED to approach the goal,')
        print('   measured the residual in pixels, and corrected -- active inference, zero vision LLM.')
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
