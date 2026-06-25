"""Round-28 dir-2 RECON: measure the dynamic coherence + radial key of ALL FIVE lab surfaces, to see,
from data, which of paint/timeline/node could be recognised/calibrated and on what basis.

Prior honest finding: only orbit/pan footprints transfer; paint/timeline/node read present=False because
their |delta| footprint SHAPE genuinely differs. But the round-26 dynamic key measures KINEMATICS, not
shape -- so a surface that TRANSLATES (node moves a box, pan shifts a grid) should cohere alike even if
their static footprints differ. This recon asks: does the dynamic key open a legitimate recognition path
for node (a translation) that the static footprint alone denied? Pure measurement -- report as-is."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9099; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')
SURF = ['orbit', 'pan', 'paint', 'timeline', 'node']


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
    return cx, cy, [cx - 150, cy - 120, cx + 150, cy + 120]


def capture(mode):
    cx, cy, region = goto(mode)
    res = post('flow_probe', x=cx - 110, y=cy, x2=cx + 110, y2=cy, region=region, cols=16, samples=10)
    g = post('gray', region=region, cols=16, rows=16).get('gray')
    return {'dyn': res.get('motion', {}).get('sig'), 'coh': res.get('motion', {}).get('coherence'),
            'shift': res.get('motion', {}).get('shift'),
            'radial': V.context_radial(g, 16, 16) if g else [0] * 10,
            'gain': res.get('change', {}).get('mag', 0.0)}


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up(); cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-28 dir-2 recon: dynamic + static keys for all 5 lab surfaces ===')
    print('   %-9s %6s %5s %18s %s' % ('surface', 'gain', 'coh', 'shift', 'dyn'))
    for m in SURF:
        print('   %-9s %6.2f %5s %18s %s' % (m, cap[m]['gain'], cap[m]['coh'], cap[m]['shift'], cap[m]['dyn']))
    print('\n   pairwise  STATIC radial cos | DYNAMIC cos')
    for i in range(len(SURF)):
        for j in range(i + 1, len(SURF)):
            a, b = SURF[i], SURF[j]
            print('   %-9s ~ %-9s  static=%.3f  dynamic=%.3f'
                  % (a, b, V.cos(cap[a]['radial'], cap[b]['radial']), V.cos(cap[a]['dyn'], cap[b]['dyn'])))


if __name__ == '__main__':
    main()
