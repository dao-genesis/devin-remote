"""Round-37: falsifiably test CONCURRENT MULTI-REGION detection on a REAL external renderer (MapLibre GL +
live OSM tiles), corroborating the synthetic _diag_multiregion.py finding.

We capture each pure mode's real drag frames ONCE (flow_probe frames_out=True), then SPATIALLY COMPOSITE two
real fields into one buffer (left region from mode A, right region from mode B) with multiregion.compose_lr/
compose_tb. Each region therefore carries the GENUINE externally-rendered pixels and genuine motion of its
source -- a faithful model of a split-screen / picture-in-picture surface where two sub-regions move
independently at the same time. This needs no change to web_lab.html or the locked stack.

PRE-REGISTERED readout (set BEFORE measuring -- 為者敗之): the synthetic sweep showed the RAW single-model
residual r_norm does NOT separate single from composite (a pure curved rotation/zoom already leaves a large
residual purely from integer-displacement quantization), but the quantization-robust residual-DROP gain DOES
(single pan/rotation/zoom gain ~<=0.06; composites ~>=0.27). The live question is whether that SAME
separation reproduces on the external renderer:
  * EXPECT each pure captured mode to read LOW gain (single-model assumption holds) -> is_composite False.
  * EXPECT every two-mode composite to read HIGHER gain -> is_composite True at the measured 0.15 gate.
Report, per case, the raw gain and the composite flag as measured. If the live data does NOT reproduce the
separation, report that honestly (the synthetic finding would then be a synthetic-only artifact).
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import multiregion as MR

PORT = 9104; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webzoom']
PURE_CLS = {'webmap': 'pan', 'webspin': 'rotation', 'webzoom': 'zoom'}
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
    return res.get('raw_frames') or [], res.get('change', {}).get('mag', 0.0)


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-37: CONCURRENT MULTI-REGION detection on MapLibre+OSM (real frames, spatial composite) ===')
    print('   capture (cx-130,cy-22)->(cx+70,cy-22) samples=%d; composite = left region mode A | right region mode B' % SAMPLES)
    rendered = all(cap[m][1] > 1.0 for m in SURF)
    print('   all %d pure modes rendered (gain>1): %s\n' % (len(SURF), rendered))

    fr = {m: cap[m][0] for m in SURF}
    ok = all(len(fr[m]) >= 2 for m in SURF)
    if not rendered or not ok:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag.'); sys.exit(2)

    print('   --- PURE single modes (single-model assumption holds) ---')
    print('   %-22s gain    composite?  (expect False)' % 'case')
    single_gmax = 0.0; single_bad = 0
    for m in SURF:
        res = MR.is_composite(fr[m], COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        single_gmax = max(single_gmax, res['gain'])
        single_bad += int(res['composite'])
        print('   %-22s %.4f  %-10s%s' % ('%s (%s)' % (m, PURE_CLS[m]), res['gain'],
              str(res['composite']), '   <- FALSE POSITIVE' if res['composite'] else ''))

    pairs = [('webmap', 'webzoom', 'lr'), ('webmap', 'webspin', 'lr'),
             ('webspin', 'webzoom', 'lr'), ('webzoom', 'webspin', 'tb'),
             ('webmap', 'webzoom', 'tb')]
    print('\n   --- CONCURRENT composites (single-model assumption violated) ---')
    print('   %-22s gain    composite?  (expect True)' % 'case')
    comp_gmin = 1e9; comp_missed = 0; ncomp = 0
    for a, b, how in pairs:
        comp = (MR.compose_lr if how == 'lr' else MR.compose_tb)(fr[a], fr[b], COLS, ROWS)
        res = MR.is_composite(comp, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        comp_gmin = min(comp_gmin, res['gain']); ncomp += 1
        comp_missed += int(not res['composite'])
        name = '%s|%s [%s]' % (PURE_CLS[a], PURE_CLS[b], how)
        print('   %-22s %.4f  %-10s%s' % (name, res['gain'], str(res['composite']),
              '   <- MISSED' if not res['composite'] else ''))

    print('\n=== round-37 readout (measurement decides, not preference) ===')
    print('   max pure-mode gain      = %.4f  (false positives: %d/%d)' % (single_gmax, single_bad, len(SURF)))
    print('   min composite gain      = %.4f  (missed: %d/%d)' % (comp_gmin, comp_missed, ncomp))
    print('   separated by 0.15 gate  = %s (gap %.4f)'
          % ('YES' if comp_gmin > single_gmax else 'NO', comp_gmin - single_gmax))
    print('\n=== honest conclusion ===')
    if single_bad == 0 and comp_missed == 0 and comp_gmin > single_gmax:
        print('   The synthetic separation reproduces on the external renderer: every pure mode reads LOW residual-')
        print('   drop gain (one conformal model explains it -- the single-model assumption holds), while every two-')
        print('   region composite reads HIGHER gain (splitting along its boundary collapses the residual the single')
        print('   model could not). Concurrent multi-region motion is thus HONESTLY DETECTABLE as a composite field')
        print('   via a quantization-robust residual-drop, additively (vmodel/flow_roi/motion_class untouched -- 為者敗之).')
        sys.exit(0)
    print('   Live data did NOT cleanly reproduce the synthetic separation -- reported as measured above.')
    sys.exit(1)


if __name__ == '__main__':
    main()
