"""Round-25 probe: print the centroid-radial cross-cosine matrix AND each surface's measured gain.

This makes the round-25 claim falsifiable. context_radial is motion-invariant (it survives a surface
transforming itself), which is exactly why it CANNOT separate surfaces that merely look alike: pairs
with radial cosine >= cal_thr (0.6) will SHARE a stored calibration. The matrix below shows which pairs
leak; the gain column shows whether such a leak is benign (similar gain) or must self-heal (divergent
gain). Pure pixels, zero vision."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as _vmodel
PORT = 9097; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')
SURFACES = ['orbit', 'pan', 'paint', 'timeline', 'node']


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


_ab = [None]


def goto(mode):
    if _ab[0] is None:
        wi = post('ui_info')
        cands = [w for w in wi['windows'] if any(k in (w.get('title') or '') for k in ('Chrome', 'Chromium', 'Edge'))]
        win = cands[0]; r = win['rect']
        post('activate', title=win['title'][:20]); time.sleep(0.3)
        ab = post('find', text='Address and search bar', control_type='Edit')
        _ab[0] = (ab['elements'][0]['center'], r)
    c, r = _ab[0]
    post('act', op='click', x=c[0], y=c[1]); time.sleep(0.15)
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL + '#' + mode); post('act', op='key', key='enter')
    time.sleep(1.8)
    cx = (r[0] + r[2]) // 2; cy = r[1] + 350
    region = [cx - 150, cy - 120, cx + 150, cy + 120]
    return cx, cy, region


def main():
    srv = start()
    rad = {}; gain = {}
    try:
        for s in SURFACES:
            cx, cy, region = goto(s)
            pre = post('gray', region=region, cols=16, rows=16)['gray']
            rad[s] = _vmodel.context_radial(pre, 16, 16)
            mags = []
            for _ in range(3):
                e = post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy,
                         expect={'effect': {'action': 'drag', 'region': region, 'learn': False}}).get('effect', {})
                if e.get('obs'):
                    mags.append(e['obs']['mag'])
                time.sleep(0.15)
            gain[s] = sum(mags) / len(mags) if mags else 0.0
    finally:
        srv.terminate(); time.sleep(0.6)

    print('=== centroid-radial cross-cosine (>=0.60 => surfaces SHARE a calibration) ===')
    print('         ' + ' '.join('%8s' % s for s in SURFACES))
    for a in SURFACES:
        row = []
        for b in SURFACES:
            row.append('%8.3f' % _vmodel.cos(rad[a], rad[b]))
        print('%-8s ' % a + ' '.join(row))
    print('\n=== measured gain (obs.mag) per surface ===')
    for s in SURFACES:
        print('   %-8s gain=%.4f' % (s, gain[s]))
    print('\n=== leaking pairs (radial>=0.60) and whether benign or must self-heal ===')
    for i, a in enumerate(SURFACES):
        for b in SURFACES[i + 1:]:
            c = _vmodel.cos(rad[a], rad[b])
            if c >= 0.60:
                ga, gb = gain[a], gain[b]
                ratio = abs(ga - gb) / max(ga, gb, 1e-6)
                tag = 'BENIGN (similar gain)' if ratio <= 0.5 else 'SELF-HEAL (divergent gain)'
                print('   %-8s ~ %-8s radial=%.3f  gain_ratio=%.3f  -> %s' % (a, b, c, ratio, tag))


if __name__ == '__main__':
    main()
