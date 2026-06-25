"""Round-26 empirical: does the ACTION->RESPONSE motion signature separate look-alike surfaces that
no static appearance key could (orbit vs pan)?

Round-25 (exp_invkey/exp_selfheal) measured that orbit and pan are near-identical in EVERY static
descriptor -- pooled fp, order-statistic, centroid-radial all read cross-cosine >= 0.96 -- so a gain
calibration keyed on appearance leaks between them and has to be healed after the fact. The claim of
round-26 is that they are separable by HOW THEY MOVE: a panned grid translates rigidly, an orbited
cube rotates. This script drags each surface while sampling sub-frames (flow_probe), decomposes the
flow field into translation/rotation/divergence/residual (motion_signature), and prints BOTH the
dynamic cross-cosine matrix and -- for contrast -- the static centroid-radial cross-cosine matrix.
Pure pixels, zero vision. The recorded numbers are the evidence (or refutation) for round-26."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as _vmodel
PORT = 9094; BASE = f'http://127.0.0.1:{PORT}'
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
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    sigs = {}; radial = {}
    try:
        up()
        print('=== round-26: action->response motion signature per surface (horizontal drag) ===')
        print('surface  | trans_exp affine_exp  rot     | mag    | sig (L2: t_exp, affine_extra, unexpl)')
        for s in SURFACES:
            cx, cy, region = goto(s)
            res = post('flow_probe', x=cx - 110, y=cy, x2=cx + 110, y2=cy, region=region, cols=16, samples=8)
            m = res.get('motion', {})
            sigs[s] = m.get('sig') or [0, 0, 0]
            # static centroid-radial key of the pre-drag frame, for the contrast matrix
            g = post('gray', region=region, cols=16, rows=16).get('gray')
            radial[s] = _vmodel.context_radial(g, 16, 16) if g else [0] * 10
            print('%-8s | %8.3f  %8.3f  %7.4f | %.2f | %s' % (
                s, m.get('trans_exp', 0), m.get('affine_exp', 0), m.get('rot', 0),
                res.get('change', {}).get('mag', 0), sigs[s]))
            time.sleep(0.2)

        def matrix(title, vecs, hi):
            print('\n%s' % title)
            print('         ' + ' '.join('%-8s' % s for s in SURFACES))
            for a in SURFACES:
                row = []
                for b in SURFACES:
                    c = _vmodel.cos(vecs[a], vecs[b])
                    row.append('%6.3f%s' % (c, '*' if (a != b and c >= hi) else ' '))
                print('%-8s ' % a + ' '.join('%-8s' % v for v in row))

        matrix('DYNAMIC motion-signature cross-cosine (round-26; * = look-alike >=0.90):', sigs, 0.90)
        matrix('STATIC centroid-radial cross-cosine (round-25; * = conflated >=0.90):', radial, 0.90)
        print('\n=== honest read ===')
        od = _vmodel.cos(sigs['orbit'], sigs['pan']); orad = _vmodel.cos(radial['orbit'], radial['pan'])
        print('   orbit~pan  DYNAMIC cos=%.3f   vs   STATIC radial cos=%.3f' % (od, orad))
        print('   round-26 wins iff the dynamic cos DROPS below the static one enough to gate borrowing')
        print('   (min(static,dynamic) < cal_thr=0.6 => orbit gain is NOT borrowed by pan a priori)')
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
