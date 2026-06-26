"""Round-34: falsifiably test whether a PERSPECTIVE tilt (#webtilt) carries an anisotropic
foreshortening signature -- nonzero SHEAR -- that a FLAT spin (#webspin) does not, on the real
MapLibre GL + live OSM surface.

THE STANDING BOUNDARY. Rounds 29-33 settled an honest 3-way external taxonomy {pan, rotation, zoom}.
The 4 lab gestures collapse to 3 classes because flat-spin and perspective-tilt are NOT separable at
any key measured so far: round-29 cos(flat-rot, persp-rot) = 0.999 on the binary coherence key, and the
round-32 INTERIOR conformal structure reads both as pure curl. The conformal fit
  f = a + s*(r-rbar) + w*perp(r-rbar)   (4 DOF: translation + isotropic scale + rotation)
has zero shear BY CONSTRUCTION -- so it literally cannot see the one thing that physically separates a
tilt from a spin.

THE FALSIFIABLE MECHANISM. A flat bearing change is a pure rotation (div=0, curl=theta, shear=0). A
perspective pitch change foreshortens the ground plane: rows toward the horizon compress harder than
rows toward the camera -- a non-uniform (anisotropic) vertical scale, i.e. nonzero shear in the full
local Jacobian. flow_affine.flow_structure_affine fits that full affine on the SAME round-32 interior
block field (border bias already removed) and reads [T, |D|, |C|, shear]. So:
  * if #webtilt's interior shear is MATERIALLY larger than #webspin's AND the 4-vectors cosine-separate
    (cos < 0.6) where the 3-vectors did not -> the honest taxonomy recovers a 4th class.
  * if shear is noise-level for BOTH, or both spin AND tilt carry it equally -> 3-way is the TRUE
    external ceiling, reported unforced (為者敗之 -- no threshold massage to manufacture a 4th class).

HOW. Same live scaffold as practice_webclass.py (round-33): spawn the daemon, drive each mode with a
fresh asymmetric drag, but request frames_out=True and run flow_structure_affine HERE on the returned
raw frames (purely additive; vm_inner_agent/vmodel/flow_roi unchanged). Observation window centred on
the transform anchor (screen centre) so curl/div/shear residuals survive (round-33 geometry lesson).
A unique ?t=<ms> per load forces a fresh cross-document fetch (a hash-only nav re-serves a STALE page).
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
import flow_affine as A
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom', 'webscale']
EXPECT_DOM = {'webmap': 0, 'webspin': 2, 'webtilt': None, 'webzoom': 1, 'webscale': 1}  # index into [T,D,C,S]
SETTLE = 6.0
COLS = ROWS = 48
SEARCH = 4; BLOCKS = 12
SAMPLES = 10


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
    frames = res.get('raw_frames') or []
    gain = res.get('change', {}).get('mag', 0.0)
    if len(frames) < 2:
        return {'sig': [0, 0, 0, 0], 'shear': 0.0, 'div': 0.0, 'curl': 0.0, 'kept': 0, 'gain': gain}
    a = A.flow_structure_affine(frames, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
    a['gain'] = gain
    return a


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-34: does perspective TILT carry anisotropic SHEAR that flat SPIN lacks? (real MapLibre+OSM) ===')
    print('   full-affine fit on the round-32 interior field; signature = [T, |D|, |C|, shear]')
    print('   %-9s %-26s %7s %7s %7s %7s  kept  gain' % ('mode', 'sig=[T,D,C,shear]', 'trans', 'div', 'curl', 'shear'))
    for m in SURF:
        c = cap[m]
        print('   %-9s %-26s %7.2f %7.2f %7.2f %7.2f  %4s %6.1f'
              % (m, str(c['sig']), c['trans'], c['div'], c['curl'], c['shear'], c['kept'] // max(1, SAMPLES), c['gain']))

    spin = cap['webspin']; tilt = cap['webtilt']
    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)
    shear_spin = spin['shear']; shear_tilt = tilt['shear']
    sig_spin = spin['sig']; sig_tilt = tilt['sig']
    cos_st = V.cos(sig_tilt, sig_spin)
    # falsifiable, pre-registered readout: tilt must carry MATERIALLY more shear AND the 4-vectors must
    # cosine-separate where the 3-vectors did not. Pre-registered margins, NOT fitted post-hoc.
    margin = shear_tilt - shear_spin
    shear_sep = (shear_tilt > 0.15 and margin >= 0.10)   # tilt shear is real and clearly exceeds spin's
    cos_sep = (cos_st < 0.6)                               # the full 4-vectors actually separate

    print('\n=== round-34 readout (measurement decides, not preference) ===')
    print('   all 5 modes rendered (gain>1):   %s' % rendered)
    print('   flat-spin  shear:                %.3f   sig=%s' % (shear_spin, sig_spin))
    print('   persp-tilt shear:                %.3f   sig=%s' % (shear_tilt, sig_tilt))
    print('   shear margin (tilt - spin):      %.3f   (pre-registered separable if tilt>0.15 AND margin>=0.10)' % margin)
    print('   cos(tilt, spin) on 4-vectors:    %.3f   (pre-registered separable if < 0.6)' % cos_st)

    print('\n=== honest conclusion ===')
    if not rendered:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag; cannot attribute the shear reading.')
        sys.exit(2)
    elif shear_sep and cos_sep:
        print('   The 4th axis RECOVERS: perspective tilt carries an anisotropic foreshortening shear that flat')
        print('   spin does not, and the full-affine 4-vectors cosine-separate where the conformal 3-vectors did')
        print('   not (round-29 cos=0.999). The honest external taxonomy can grow to {pan, flat-rot, persp-rot,')
        print('   zoom}. Next: wire shear into the live classifier as a 4th-class gate.')
        sys.exit(0)
    else:
        print('   3-way is the TRUE external ceiling: the perspective tilt does NOT carry a shear that materially')
        print('   exceeds the flat spin at our measurement layer (margin %.3f, cos %.3f). Flat-rotation and' % (margin, cos_st))
        print('   perspective-rotation remain pixel-indistinguishable; both honestly stay in the single rotation')
        print('   class. Reported as measured -- no threshold massaged to manufacture a 4th class (為者敗之).')
        sys.exit(1)


if __name__ == '__main__':
    main()
