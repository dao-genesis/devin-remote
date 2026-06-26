"""Round-32: attack the round-30/31 BORDER GEOMETRY head-on and falsifiably test whether it is DEFEATABLE.

Round-30 measured (MapLibre GL + live OSM) that the conformal flow_structure 3-way split
[translation, |div|, |curl|] is clean on synthetic frames but does NOT survive external rendering: a native
map zoom (#webzoom) does not cosine-separate from a rotation. Round-31's #webscale control (pure CSS image
magnification, zero MapLibre vector re-layout) ALSO failed to separate -> the cause is finite-frame BORDER
GEOMETRY, not MapLibre re-tiling. The mechanism: a BORDER super-block, test-shifted OUTWARD, loses overlap
(its cur cells map off the pre frame); _block_ssd averages over surviving overlap only, so outward shifts
look artificially cheap and the matcher prefers an INWARD shift -> a spurious, motion-independent inward
divergence on every mode, drowning a zoom's real radial signal.

This round tests whether that bias is DEFEATABLE WITHOUT touching the locked estimator: keep ONLY INTERIOR
super-blocks whose full extent, shifted by +/-search, still lands entirely inside the frame. Such blocks
have FULL overlap at EVERY candidate shift, so the overlap-shrink bias cannot act -- the inward injection
is removed at the source (flow_roi.flow_structure_roi; same centroid-centred conformal LSQ as vmodel).

CONTROL DISCIPLINE: full-frame and ROI are computed on the SAME raw frames at IDENTICAL params (search,
blocks); the ONLY difference is which blocks enter the fit. The locked test_flow_roi proves the estimator
is sound on clean synthetic frames, so any live failure is rendering geometry, not a buggy estimator.

Falsifiable readout (measurement decides, not preference -- 為者敗之):
  * If the ROI variant SEPARATES the zoom (and the CSS scale) from BOTH rotations (cos < 0.6) where the
    full-frame variant could NOT, the round-30/31 border bias is the SOLE cause AND it is DEFEATABLE by an
    interior window -> the external 3-way taxonomy is RECOVERABLE.
  * If the ROI variant STILL fails, the finite-frame limit is deeper than edge blocks (e.g. at this block
    resolution an interior radial field is not linearly separable from a tangential one externally) -> the
    robust external key stays the round-29 binary coherence; report the boundary honestly.
A unique ?t=<ms> query per load forces a fresh cross-document fetch (a hash-only nav re-serves a STALE page)."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
import flow_roi as R
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom', 'webscale']
SETTLE = 6.0          # let network tiles load + map idle before probing
COLS = ROWS = 48      # FINE grid: dropping a thin search-cell rim still leaves wide lever arms for div/curl
SEARCH = 4; BLOCKS = 12
SAMPLES = 12


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
    return cx, cy, [cx - 140, cy - 140, cx + 140, cy + 140]   # SQUARE region -> isotropic conformal fit


def capture(mode):
    cx, cy, region = goto(mode)
    res = post('flow_probe', x=cx - 110, y=cy, x2=cx + 110, y2=cy, region=region,
               cols=COLS, rows=ROWS, samples=SAMPLES, frames_out=True)
    raw = res.get('raw_frames'); cols = res.get('cols', COLS); rows = res.get('rows', ROWS)
    full = V.flow_structure(raw, cols, rows, search=SEARCH, blocks=BLOCKS) if raw else {}
    roi = R.flow_structure_roi(raw, cols, rows, search=SEARCH, blocks=BLOCKS) if raw else {}
    return {'coh': res.get('motion', {}).get('coherence'),
            'dyn': res.get('motion', {}).get('sig'),
            'full': full.get('sig'), 'fT': full.get('trans'), 'fD': full.get('div'), 'fC': full.get('curl'),
            'roi': roi.get('sig'), 'rT': roi.get('trans'), 'rD': roi.get('div'), 'rC': roi.get('curl'),
            'kept': roi.get('kept'), 'dropped': roi.get('dropped'),
            'gain': res.get('change', {}).get('mag', 0.0)}


def _dom(sig):
    return '?' if not sig else ['translation', 'divergence', 'curl'][max(range(3), key=lambda i: sig[i])]


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-32: does an INTERIOR-ONLY (ROI) window defeat the round-30/31 border bias? ===')
    print('   grid=%dx%d  search=%d  blocks=%d  (full-frame vs interior-only, identical params)' % (COLS, ROWS, SEARCH, BLOCKS))
    for m in SURF:
        c = cap[m]
        print('   %-8s gain=%6.2f coh=%-6s  kept/dropped=%s/%s' % (m, c['gain'], c['coh'], c['kept'], c['dropped']))
        print('            full=%s (%-11s) T=%s D=%s C=%s' % (c['full'], _dom(c['full']), c['fT'], c['fD'], c['fC']))
        print('            roi =%s (%-11s) T=%s D=%s C=%s' % (c['roi'], _dom(c['roi']), c['rT'], c['rD'], c['rC']))

    def fc(key, a, b):
        return V.cos(cap[a][key], cap[b][key])
    for key, label in (('full', 'FULL-FRAME'), ('roi', 'INTERIOR-ONLY (ROI)')):
        print('\n=== %s flow_structure cosine matrix ===' % label)
        print('              %s' % '  '.join('%-8s' % m for m in SURF))
        for a in SURF:
            print('   %-8s %s' % (a, '  '.join('%8.3f' % fc(key, a, b) for b in SURF)))

    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)

    # The HONEST question is not merely "does zoom sit far from rotation" -- a zoom whose radial signal is
    # buried under the border bias collapses onto the PAN (translation) axis, which is ALSO far from rotation
    # and would pass a rotation-only test for the WRONG reason. Zoom earns its own 4th class only if it is
    # (a) DIVERGENCE-dominant and (b) cosine-separated from ALL THREE other motions (pan AND both rotations).
    OTHERS = {'webzoom': ['webmap', 'webspin', 'webtilt'], 'webscale': ['webmap', 'webspin', 'webtilt']}

    def own_class(key, x):
        sig = cap[x][key]
        div_dom = sig and sig[1] > sig[0] and sig[1] > sig[2]
        far = max(fc(key, x, o) for o in OTHERS[x]) < 0.6
        return bool(div_dom and far)
    zoom_full = own_class('full', 'webzoom'); zoom_roi = own_class('roi', 'webzoom')
    scale_full = own_class('full', 'webscale'); scale_roi = own_class('roi', 'webscale')

    print('\n=== round-32 readout: does zoom/scale earn its OWN divergence class (separate from pan AND both rotations)? ===')
    print('   all 5 modes rendered (gain>1):                              %s' % rendered)
    for x in ('webzoom', 'webscale'):
        for key, lab in (('full', 'FULL-FRAME'), ('roi', 'INTERIOR  ')):
            print('   %-9s %s dom=%-11s cos(pan)=%.3f cos(flat-rot)=%.3f cos(persp-rot)=%.3f'
                  % (x, lab, _dom(cap[x][key]), fc(key, x, 'webmap'), fc(key, x, 'webspin'), fc(key, x, 'webtilt')))
    print('   zoom  is its own divergence class (div-dom AND cos<0.6 to all 3):  full=%s  interior=%s' % (zoom_full, zoom_roi))
    print('   scale is its own divergence class (div-dom AND cos<0.6 to all 3):  full=%s  interior=%s' % (scale_full, scale_roi))

    print('\n=== honest conclusion ===')
    if not rendered:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag; cannot attribute the cause.')
    elif (zoom_roi or scale_roi) and not (zoom_full or scale_full):
        print('   BORDER GEOMETRY confirmed as the cause AND it is DEFEATABLE: on the full frame the zoom/scale')
        print('   is MISREAD as translation (the border inward-bias buries the radial signal, collapsing zoom')
        print('   onto the PAN axis), so it never stands as its own class. Dropping the edge blocks (interior-')
        print('   only, every block 4-neighboured) makes zoom AND the pure CSS scale DIVERGENCE-dominant and')
        print('   cosine-separated from pan AND both rotations -- the honest 4-way taxonomy {pan=translation,')
        print('   rotation=curl, zoom=divergence} REVIVES on a real external renderer. The round-30/31 PARTIAL')
        print('   was a finite-frame artifact, not a fundamental limit; the external taxonomy is RECOVERABLE by')
        print('   measuring on the interior. The locked round-29 coherence key is untouched (still PASS).')
    elif zoom_full or scale_full:
        print('   The full-frame field ALREADY earns the divergence class here -- re-examine vs round-30/31')
        print('   (grid/region/zoom magnitude differ); report the matrices as measured and reconcile regimes.')
    else:
        print('   BORDER GEOMETRY is NECESSARY BUT NOT SUFFICIENT: even an interior-only window (zero edge')
        print('   inward-bias) does NOT let the zoom/scale earn its own divergence class externally. The')
        print('   finite-frame limit is deeper than edge blocks. The robust external key remains the round-29')
        print('   binary coherence (pan coherent; rotation AND zoom incoherent). Reported as measured.')
    sys.exit(0 if rendered else 2)


if __name__ == '__main__':
    main()
