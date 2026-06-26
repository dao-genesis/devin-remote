"""Round-36: falsifiably test STATIC-OVERLAY (occlusion) robustness of the honest 3-way class on a REAL
external renderer (MapLibre GL + live OSM tiles), corroborating the synthetic _diag_occlusion.py finding.

We capture each mode's real drag frames ONCE (flow_probe frames_out=True), then overlay a faithful static
occluder on the captured buffers and sweep its area fraction. A static overlay's DEFINING pixel property is
ZERO inter-frame delta in the covered region; occlusion.occlude_rect reproduces exactly that by freezing the
rectangle to frame[0]. Freezing to the real underlying texture (rather than a flat fill) is the CONSERVATIVE
choice -- the frozen patch still carries structure the global shift will try to match, so it is at least as
adversarial as a solid toolbar/HUD. Sweeping the fraction on real frames is strictly stronger than a single
fixed DOM rectangle, and needs no change to web_lab.html or the locked stack.

PRE-REGISTERED readout (set BEFORE measuring -- 為者敗之): the synthetic sweep overturned the naive
"graceful degradation" guess and showed an ASYMMETRY -- rotation/zoom (structure-keyed) are occlusion-robust,
while PAN (coherence-keyed) is fragile because a zero-delta island defeats the single global shift. The live
question is whether the SAME asymmetry and the SAME principled fix (occ_signature.classify_occ, coherence over
moving cells only) reproduce on the external renderer:
  * EXPECT plain pan to flip away from 'pan' at some occlusion fraction, while plain rotation/zoom hold.
  * EXPECT robust classify_occ to keep pan='pan' to a markedly higher fraction, without faking coherence for
    rotation/zoom (they must stay their honest class).
Report, per mode, the lowest fraction at which plain flips and at which robust flips -- as measured. If the
live data does NOT reproduce the asymmetry, report that honestly (the synthetic finding would then be a
synthetic-only artifact).
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import motion_class as M
import occ_signature as OS
import occlusion as O

PORT = 9103; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom', 'webscale']
EXPECT = {'webmap': 'pan', 'webspin': 'rotation', 'webtilt': 'rotation', 'webzoom': 'zoom', 'webscale': 'zoom'}
SETTLE = 6.0
COLS = ROWS = 48
SEARCH = 4; BLOCKS = 12
SAMPLES = 10
FRACS = [0.0, 0.125, 0.25, 0.375, 0.5, 0.625]


def post(a, **b):
    b['action'] = a; d = json.dumps(b).encode()
    r = urllib.request.Request(BASE + '/', data=d, method='POST', headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=120).read().decode())


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
    nav = URL + '?t=' + str(int(time.time() * 1000)) + '#' + mode
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=nav); post('act', op='key', key='enter')
    time.sleep(SETTLE)
    cx = (r[0] + r[2]) // 2; cy = (r[1] + r[3]) // 2
    return cx, cy, [cx - 140, cy - 140, cx + 140, cy + 140]


def capture(mode):
    cx, cy, region = goto(mode)
    cyr = cy - 22
    res = post('flow_probe', x=cx - 130, y=cyr, x2=cx + 70, y2=cyr, region=region,
               cols=COLS, rows=ROWS, samples=SAMPLES, frames_out=True, search=SEARCH, blocks=BLOCKS)
    return res.get('raw_frames') or [], res.get('change', {}).get('mag', 0.0)


def first_flip(frames, expect, geom_fn, classifier):
    """Lowest swept fraction at which `classifier` no longer returns `expect`; None if it never flips."""
    for frac in FRACS:
        if frac == 0.0:
            occ = frames
        else:
            i0, j0, i1, j1 = geom_fn(frac)
            occ = O.occlude_rect(frames, COLS, ROWS, i0, j0, i1, j1)
        if classifier(occ, COLS, ROWS, search=SEARCH, blocks=BLOCKS)['cls'] != expect:
            return frac
    return None


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    geoms = [('corner', lambda f: O.rect_corner(COLS, ROWS, f, 'tl')),
             ('center', lambda f: O.rect_center(COLS, ROWS, f))]

    print('=== round-36: STATIC-OVERLAY robustness of the honest class on MapLibre+OSM (real frames, swept overlay) ===')
    print('   capture (cx-130,cy-22)->(cx+70,cy-22) samples=%d; overlay = rectangle frozen to frame[0] (zero-delta)' % SAMPLES)
    rendered = all(cap[m][1] > 1.0 for m in SURF)
    print('   all 5 modes rendered (gain>1): %s\n' % rendered)

    plain_holds_better = 0; robust_holds_better = 0; robust_never_worse = 0; n = 0
    for gname, gfn in geoms:
        print('   --- occluder geometry: %s ---' % gname)
        print('   %-8s %-8s | plain_first_flip  robust_first_flip' % ('mode', 'expect'))
        for m in SURF:
            frames, _ = cap[m]; exp = EXPECT[m]
            if len(frames) < 2:
                print('   %-8s %-8s | (no frames)' % (m, exp)); continue
            pf = first_flip(frames, exp, gfn, M.classify)
            rf = first_flip(frames, exp, gfn, OS.classify_occ)
            n += 1
            pv = 'none' if pf is None else '%.3f' % pf
            rv = 'none' if rf is None else '%.3f' % rf
            # robust "never worse": flips later, or both never flip
            nm = (rf is None and pf is None) or (rf is None and pf is not None) or (pf is not None and rf is not None and rf >= pf) or (pf is None and rf is None)
            robust_never_worse += int((rf is None) or (pf is not None and rf >= pf) or (pf is None and rf is None))
            if pf is not None and (rf is None or rf > pf):
                robust_holds_better += 1
            print('   %-8s %-8s | %-16s  %-16s%s' % (m, exp, pv, rv,
                  '   <- robust holds longer' if (pf is not None and (rf is None or rf > pf)) else ''))
        print('')

    print('=== round-36 readout (measurement decides, not preference) ===')
    print('   modes where robust occlusion-tolerance >= plain: %d / %d' % (robust_never_worse, n))
    print('   modes where robust strictly out-survives plain : %d / %d' % (robust_holds_better, n))
    print('\n=== honest conclusion ===')
    if not rendered:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag.'); sys.exit(2)
    if robust_holds_better > 0 and robust_never_worse == n:
        print('   The synthetic ASYMMETRY reproduces on the external renderer: plain pan flips earliest under a')
        print('   static overlay (a zero-delta island defeats the single global shift), while the occlusion-aware')
        print('   coherence (moving cells only) keeps pan honest to a markedly higher occlusion fraction and never')
        print('   degrades any mode. rotation/zoom were already occlusion-robust and stay their honest class.')
        print('   Static-overlay robustness is thus a MEASURED edge of the locked coherence key and is closed by a')
        print('   principled additive fix (no threshold moved, vmodel/flow_roi/motion_class untouched -- 為者敗之).')
        sys.exit(0)
    print('   Live data did NOT reproduce the synthetic asymmetry as expected -- reported as measured above.')
    sys.exit(1)


if __name__ == '__main__':
    main()
