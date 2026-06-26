"""Round-33: wire the honest motion taxonomy into the LIVE act()/flow_probe path and falsifiably test
whether a FRESH, never-before-measured external drag is routed END-TO-END to the right class by the
DAEMON itself -- not reconstructed offline by this harness.

Rounds 29-32 each LOCKED one measurement on MapLibre GL + live OSM tiles:
  * round-29: the binary coherence key survives external rendering as the translation-vs-(rotation|zoom)
    discriminator (pan coherent ~0.69-0.85; flat-spin AND perspective-tilt incoherent ~0.25, cos=0.999).
  * round-30/31: a native zoom (#webzoom) and a pure CSS scale (#webscale) read divergence on synthetic
    frames but NOT full-frame externally -- the finite-frame BORDER bias buried the radial signal.
  * round-32: an INTERIOR-ONLY conformal window (flow_roi.flow_structure_roi) defeats that bias -- the
    zoom flips to divergence-dominant and cosine-separates from pan AND both rotations.

This round FUSES those two locked keys into ONE live decision (motion_class.classify, wired into
flow_probe behind classify=True) and asks the daemon to label a fresh drag end-to-end. The honest external
taxonomy is 3-way {pan, rotation, zoom}: the 4 lab GESTURES map onto 3 CLASSES because flat-rotation and
perspective-rotation are NOT pixel-separable (round-29: both pure curl, cos=0.999). We do NOT manufacture a
4th split the data does not support (為者敗之).

FRESHNESS DISCIPLINE: rounds 29-32 dragged the centred vector (cx-110,cy)->(cx+110,cy), len 220, 12 samples.
This round uses a DIFFERENT, never-measured gesture -- asymmetric anchor (cx-130,cy-22)->(cx+70,cy-22),
len 200, 10 samples -- same motion SIGN so each mode still produces its own class, but a genuinely unseen
drag. The class comes from res['motion_class']['cls'] returned BY THE DAEMON.

OBSERVATION-WINDOW GEOMETRY (diagnosed in _diag_roi_center.py, falsifiable): divergence (zoom) and curl
(rotation) are defined relative to the motion's FIXED POINT -- the MapLibre transform anchor ~ screen
centre. The interior ROI must SPAN that anchor or the local field collapses to pure translation and the
second-order curl/div residuals fall to the noise floor. An earlier run that shifted the ROI 24px OFF-CENTRE
starved webspin's curl (0.935 centred -> 0.027 off-centre) and mis-routed flat-spin to zoom. So the DRAG is
fresh but the observation window is centred on the anchor -- principled geometry locked since round-32's
centred drag, NOT a threshold tweak (為者敗之).

Falsifiable readout (measurement decides, not preference): for each of the 5 modes, does the LIVE daemon
route the fresh drag to its EXPECTED honest class? Report the per-mode hit/miss and the count; if a mode
misses, report which and why (coherence/structure values are echoed) -- no threshold massaging.
A unique ?t=<ms> query per load forces a fresh cross-document fetch (a hash-only nav re-serves a STALE page).
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom', 'webscale']
# the honest 3-way ground truth: both rotations share the rotation class (round-29: cos=0.999)
EXPECT = {'webmap': 'pan', 'webspin': 'rotation', 'webtilt': 'rotation', 'webzoom': 'zoom', 'webscale': 'zoom'}
SETTLE = 6.0
COLS = ROWS = 48
SEARCH = 4; BLOCKS = 12
SAMPLES = 10            # round-33 freshness: 10 (not 12)


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
    # observation window centred on the transform anchor (screen centre) so it spans the motion's fixed
    # point -- the curl/div residuals only survive there (see _diag_roi_center.py). The DRAG stays fresh.
    return cx, cy, [cx - 140, cy - 140, cx + 140, cy + 140]


def capture(mode):
    cx, cy, region = goto(mode)
    cyr = cy - 22   # round-33 freshness: small vertical offset on the drag (still inside the centred window)
    # round-33 freshness: asymmetric anchor, len 200 (not the centred 220), classify in the LIVE daemon
    res = post('flow_probe', x=cx - 130, y=cyr, x2=cx + 70, y2=cyr, region=region,
               cols=COLS, rows=ROWS, samples=SAMPLES, classify=True, search=SEARCH, blocks=BLOCKS)
    mc = res.get('motion_class') or {}
    return {'cls': mc.get('cls'), 'conf': mc.get('confidence'), 'coh': mc.get('coherence'),
            'sig': mc.get('roi_sig'), 'kept': mc.get('kept'), 'dropped': mc.get('dropped'),
            'gain': res.get('change', {}).get('mag', 0.0)}


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-33: does the LIVE daemon route a FRESH external drag to its honest class end-to-end? ===')
    print('   gesture: (cx-130,cy-22)->(cx+70,cy-22) len=200 samples=%d, ROI centred on anchor (UNSEEN drag in rounds 29-32)' % SAMPLES)
    print('   class comes from res["motion_class"]["cls"] computed IN the daemon (flow_probe classify=True)')
    print('   %-8s %-8s %-9s %-6s  coh    roi_sig                  kept/drop  gain' % ('mode', 'expect', 'predict', 'hit'))
    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)
    hits = 0
    for m in SURF:
        c = cap[m]; exp = EXPECT[m]; hit = (c['cls'] == exp); hits += int(hit)
        print('   %-8s %-8s %-9s %-6s  %-6s %-24s %s/%s   %6.2f'
              % (m, exp, c['cls'], 'OK' if hit else 'MISS', c['coh'], c['sig'], c['kept'], c['dropped'], c['gain']))

    print('\n=== round-33 readout (measurement decides, not preference) ===')
    print('   all 5 modes rendered (gain>1):        %s' % rendered)
    print('   fresh drags routed correctly:         %d / %d' % (hits, len(SURF)))
    print('\n=== honest conclusion ===')
    if not rendered:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag; cannot attribute end-to-end routing.')
        sys.exit(2)
    elif hits == len(SURF):
        print('   The fused taxonomy is OPERATIONAL end-to-end: the LIVE daemon routed every one of the 5 fresh,')
        print('   never-measured external drags to its honest class -- pan via the locked round-29 coherence gate,')
        print('   zoom vs rotation via the round-32 interior-only structure. The 4 gestures collapse onto the 3')
        print('   honest classes {pan, rotation, zoom} (both rotations share one class, as round-29 measured). The')
        print('   external GUI kinematics taxonomy is classified end-to-end in the live path, not just offline.')
        sys.exit(0)
    else:
        print('   PARTIAL: %d/%d fresh drags routed correctly. The misses are printed above WITH their coherence and' % (hits, len(SURF)))
        print('   interior structure so the boundary is auditable -- reported as measured, no threshold massaging.')
        sys.exit(1)


if __name__ == '__main__':
    main()
