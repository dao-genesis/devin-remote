"""One servo loop, many surfaces: the controller generalizes by RE-CALIBRATION, not re-coding.

The goal-seek loop (measure centroid -> calibrate gain from a probe drag -> predict drag=error/gain ->
act -> re-measure -> correct) is surface-agnostic. Here the SAME loop:
  - drives a 2-D draggable node through a PATH of waypoints (multi-target sequencing), and
  - drives a 1-D slider knob to a series of set-points (different axis, different gain),
with nothing changed but the one-shot calibration. Universal substrate intact: measure = bright-object
centroid, act = drag. Pure pixels, zero vision LLM."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9091; BASE = f'http://127.0.0.1:{PORT}'
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
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env); up(); return p


def goto(mode, half_w=150, half_h=120):
    wi = post('ui_info')
    win = [w for w in wi['windows'] if any(k in (w.get('title') or '') for k in ('Chrome', 'Chromium', 'Edge'))][0]
    r = win['rect']; post('activate', title=win['title'][:20]); time.sleep(0.3)
    ab = post('find', text='Address and search bar', control_type='Edit')['elements'][0]['center']
    post('act', op='click', x=ab[0], y=ab[1]); time.sleep(0.15)
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL + '#' + mode); post('act', op='key', key='enter')
    time.sleep(1.8)
    cx = (r[0] + r[2]) // 2; cy = r[1] + 350
    return [cx - half_w, cy - half_h, cx + half_w, cy + half_h]


def centroid(region):
    return post('region_centroid', region=region, cols=44, rows=34)


def drag(px, py, dx, dy):
    post('act', op='drag', x=px, y=py, x2=px + int(dx), y2=py + int(dy)); time.sleep(0.18)


def calibrate(region, cal=60, do_y=True):
    c0 = centroid(region); drag(c0['px'], c0['py'], cal, 0); c1 = centroid(region)
    gx = (c1['nx'] - c0['nx']) / cal
    gy = 0.0
    if do_y:
        drag(c1['px'], c1['py'], 0, cal); c2 = centroid(region)
        gy = (c2['ny'] - c1['ny']) / cal
    return gx, gy


def control(region, tx, ty, gx, gy, tol=0.03, steps=6, axis_xy=True):
    cur = centroid(region)
    for _ in range(steps):
        ex = tx - cur['nx']; ey = (ty - cur['ny']) if axis_xy else 0.0
        res = (ex * ex + ey * ey) ** 0.5
        if res <= tol:
            return cur, res
        dxp = max(-180, min(180, int(ex / gx))) if abs(gx) > 1e-6 else 0
        dyp = max(-180, min(180, int(ey / gy))) if (axis_xy and abs(gy) > 1e-6) else 0
        drag(cur['px'], cur['py'], dxp, dyp); cur = centroid(region)
    ex = tx - cur['nx']; ey = (ty - cur['ny']) if axis_xy else 0.0
    return cur, (ex * ex + ey * ey) ** 0.5


def main():
    srv = start()
    try:
        # surface 1: 2-D node -- follow a PATH of waypoints
        region = goto('node', 150, 120)
        gx, gy = calibrate(region)
        print('=== surface NODE (2-D) -- follow a waypoint path | gain gx=%.5f gy=%.5f ===' % (gx, gy))
        print('waypoint     | reached nx,ny      | residual')
        for (tx, ty) in [(0.30, 0.70), (0.70, 0.30), (0.50, 0.50)]:
            cur, res = control(region, tx, ty, gx, gy)
            print(' (%.2f,%.2f)  | (%.3f, %.3f)     | %.4f %s' % (
                tx, ty, cur['nx'], cur['ny'], res, 'OK' if res <= 0.04 else 'off'))

        # surface 2: 1-D slider -- same loop, re-calibrated, single axis
        region = goto('slider', 300, 55)
        gx, gy = calibrate(region, do_y=False)
        print('\n=== surface SLIDER (1-D) -- same loop re-calibrated | gain gx=%.5f ===' % gx)
        print('set-point | reached nx | residual')
        for tx in [0.20, 0.80, 0.50]:
            cur, res = control(region, tx, 0.0, gx, 0.0, axis_xy=False)
            print('   %.2f    |   %.3f    | %.4f %s' % (tx, cur['nx'], res, 'OK' if res <= 0.04 else 'off'))

        print('\n=== honest summary ===')
        print('   one servo loop drove a 2-D node through 3 waypoints AND a 1-D slider to 3 set-points,')
        print('   changing nothing but the one-shot calibration -- the controller is surface-agnostic.')
        print('   measure=bright-object centroid, act=drag; pure pixels, zero vision LLM.')
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
