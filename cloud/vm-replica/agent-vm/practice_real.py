"""Round-28 dir-1: do the footprint / gain / dynamic-signature keys SURVIVE REAL rendering?

Every prior round was validated on gui_lab.html -- a clean wireframe. The honest open question is whether
the same pixel-only keys hold up when the surface is drawn like a real GUI: per-pixel procedural texture,
smooth shading, a specular highlight, vignette and anti-aliasing (real_lab.html). The kinematics are kept
identical to the lab so this isolates exactly one variable -- rendering realism.

We capture three real-rendered surfaces with the SAME live act path used in production:
  globe    -> ROTATES under drag (a shaded textured sphere)         [rotation kinematics]
  photomap -> TRANSLATES under drag (a textured satellite image)    [translation kinematics]
  terrain  -> TRANSLATES under drag (a DIFFERENT texture)           [translation kinematics]

Honest expectations:
  1. dynamic key still separates rotation from translation:  dyn cos(globe, photomap) LOW
  2. two real maps that MOVE alike are dynamic look-alikes:   dyn cos(photomap, terrain) HIGH
  3. the gate still vetoes the WRONG borrow / allows the RIGHT one under real rendering:
       store globe cal -> photomap must NOT borrow it (min(static,dyn) < thr)
       store photomap cal -> terrain MAY borrow it only if BOTH static and dyn agree
This is a measurement, not a guaranteed pass; whatever real rendering does to the keys is reported as-is."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9098; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'real_lab.html').replace('\\', '/')
SURF = ['globe', 'photomap', 'terrain']
CAL_THR = 0.6


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
    return {'dyn': res.get('motion', {}).get('sig'),
            'coh': res.get('motion', {}).get('coherence'),
            'radial': V.context_radial(g, 16, 16) if g else [0] * 10,
            'gain': res.get('change', {}).get('mag', 0.0)}


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-28 dir-1: do the keys survive REAL (textured/shaded) rendering? ===')
    for m in SURF:
        print('   %-9s gain=%6.2f  coherence=%-5s dyn=%s  radial[:4]=%s'
              % (m, cap[m]['gain'], cap[m]['coh'], cap[m]['dyn'], [round(v, 3) for v in cap[m]['radial'][:4]]))

    def sc(a, b):
        return V.cos(cap[a]['radial'], cap[b]['radial'])

    def dc(a, b):
        return V.cos(cap[a]['dyn'], cap[b]['dyn'])

    print('\n   static radial cos:  globe~photomap=%.3f  photomap~terrain=%.3f  globe~terrain=%.3f'
          % (sc('globe', 'photomap'), sc('photomap', 'terrain'), sc('globe', 'terrain')))
    print('   dynamic       cos:  globe~photomap=%.3f  photomap~terrain=%.3f  globe~terrain=%.3f'
          % (dc('globe', 'photomap'), dc('photomap', 'terrain'), dc('globe', 'terrain')))

    # the gate under real rendering: store one cal, query another with min(static,dyn)
    def borrow(trainer, partner):
        wm = V.WorldModel()
        wm.calibrate('drag', None, {'mag': cap[trainer]['gain']}, cal_ctx=cap[trainer]['radial'], dyn=cap[trainer]['dyn'])
        g, s = wm._best_cal('drag', cap[partner]['radial'], dyn=cap[partner]['dyn'])
        return (g is not None and s >= CAL_THR), s

    bw_gp, s_gp = borrow('globe', 'photomap')      # rotation->translation: want VETO (False)
    bw_pt, s_pt = borrow('photomap', 'terrain')    # translation->translation: want BORROW (True) iff also static-alike
    print('\n   gate(globe   -> photomap): borrow=%-5s cal_sim=%.3f  <- want False (rotation != translation)' % (bw_gp, s_gp))
    print('   gate(photomap-> terrain ): borrow=%-5s cal_sim=%.3f  <- want True iff they also LOOK alike' % (bw_pt, s_pt))

    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)
    sep_ok = dc('globe', 'photomap') < dc('photomap', 'terrain')   # rotation separated from the two translations
    veto_ok = not bw_gp
    print('\n=== honest summary ===')
    print('   real rendering produced a measurable drag effect on 3/3 surfaces: %s' % rendered)
    print('   dynamic key still ranks rotation(globe) apart from the two translations: %s' % sep_ok)
    print('   the WRONG borrow (rotation gain -> translating map) is vetoed under real rendering: %s' % veto_ok)
    ok = rendered and sep_ok and veto_ok
    print('   RESULT: %s' % ('PASS -- the 3 keys survive real rendering (separation + veto hold)' if ok
                             else 'PARTIAL -- real rendering degraded a key; see numbers above (honest finding)'))
    sys.exit(0 if ok else 2)


if __name__ == '__main__':
    main()
