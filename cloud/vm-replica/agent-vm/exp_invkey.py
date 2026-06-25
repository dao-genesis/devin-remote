"""Round-25 experiment (not a CI test): does an ORDER-STATISTIC context key survive a surface
transforming itself, while still telling the 5 surfaces apart?

For each surface we capture the region gray BEFORE a drag and AFTER it (the drag rotates orbit / slides
pan -- a self-transform). We then compare two keys:
  context_fp  -- spatial (round-23): cell i,j carries the value at that location
  context_inv -- order-statistic (round-25): sorted/quantile profile, permutation-invariant
We report, per key:
  self  = cos(pre, post) per surface  -> how STABLE the key is across the surface moving (want high)
  cross = cos(pre_a, pre_b) over surface pairs -> how SEPARATED surfaces stay (want low)
A good calibration key maximises self while keeping cross below the reuse threshold (0.6)."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9096; BASE = f'http://127.0.0.1:{PORT}'
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


def gray(region):
    return post('gray', region=region, cols=16, rows=16)['gray']


def drag(cx, cy):
    post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy)


def main():
    srv = start()
    pre = {}; post_ = {}
    try:
        for s in SURFACES:
            cx, cy, region = goto(s)
            pre[s] = gray(region); time.sleep(0.1)
            drag(cx, cy); time.sleep(0.25)
            post_[s] = gray(region)
    finally:
        srv.terminate(); time.sleep(0.5)

    def fp(g):
        return V.context_fp(g, 16, 16)

    def inv(g):
        return V.context_inv(g, 16, 16)

    def rad(g):
        return V.context_radial(g, 16, 16)

    print('=== self-similarity across the drag (surface transforms itself) -- want HIGH ===')
    print('surface  | context_fp | context_inv | context_radial')
    for s in SURFACES:
        print('%-8s |   %.3f    |   %.3f     |   %.3f' % (
            s, V.cos(fp(pre[s]), fp(post_[s])), V.cos(inv(pre[s]), inv(post_[s])), V.cos(rad(pre[s]), rad(post_[s]))))

    print('\n=== cross-surface similarity (pre frames) -- want LOW (< 0.6 reuse thr) ===')
    print('pair             | context_fp | context_inv | context_radial')
    mx_fp = mx_inv = mx_rad = 0.0
    for i in range(len(SURFACES)):
        for j in range(i + 1, len(SURFACES)):
            a, b = SURFACES[i], SURFACES[j]
            cfp = V.cos(fp(pre[a]), fp(pre[b])); cinv = V.cos(inv(pre[a]), inv(pre[b])); crad = V.cos(rad(pre[a]), rad(pre[b]))
            mx_fp = max(mx_fp, cfp); mx_inv = max(mx_inv, cinv); mx_rad = max(mx_rad, crad)
            print('%-16s |   %.3f    |   %.3f     |   %.3f' % (a + '/' + b, cfp, cinv, crad))
    print('\nmax cross  context_fp=%.3f  context_inv=%.3f  context_radial=%.3f  (< 0.6 avoids gain leak)'
          % (mx_fp, mx_inv, mx_rad))
    print('min self   context_fp=%.3f  context_inv=%.3f  context_radial=%.3f  (>= 0.6 keeps gain reusable)'
          % (min(V.cos(fp(pre[s]), fp(post_[s])) for s in SURFACES),
             min(V.cos(inv(pre[s]), inv(post_[s])) for s in SURFACES),
             min(V.cos(rad(pre[s]), rad(post_[s])) for s in SURFACES)))


if __name__ == '__main__':
    main()
