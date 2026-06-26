"""Round-31: FALSIFIABLY isolate WHY a zoom's 3-way flow_structure did not survive external rendering.

Round-30 measured (MapLibre GL + live OSM) that the conformal flow_structure decomposition
[translation, |divergence|, |curl|] is clean on synthetic frames (zoom -> [0,1,0], rotation -> [0,0,1],
cos < 0.6) but does NOT survive a real external renderer: a native map zoom (#webzoom, map.setZoom) does
not cosine-separate from a rotation. Round-30's stated cause was finite-frame block-matching injecting a
motion-independent inward divergence at the borders (edge blocks can only match inward), so EVERY mode --
even a pure pan -- reads divergence-dominant. That was a HYPOTHESIS about the cause; round-31 TESTS it.

A native map zoom confounds TWO effects that round-30 could not separate:
  (a) BORDER GEOMETRY  -- finite-frame edge bias, shared by every mode.
  (b) VECTOR RE-LAYOUT -- map.setZoom re-tiles, re-fetches, and re-places labels at the new zoom, so the
                          flow between sub-frames is NOT a clean affine magnification (text jumps to new
                          anchor pixels, tiles pop in, raster reprojects). This warp is unique to zoom.

#webscale is the control that splits (a) from (b): it CSS-scales the already-rendered canvas about its
centre WITHOUT touching the map (no setZoom). So it is a TEXTBOOK conformal divergence field -- pure image
magnification -- that shares webzoom's exact finite-frame border geometry but has ZERO vector re-layout.

Falsifiable readout (measurement decides):
  * If #webscale ALSO fails to separate from the rotations (cos >= 0.6), the PARTIAL is pure BORDER
    GEOMETRY: even a clean divergence field cannot be split externally -> round-30's stated cause CONFIRMED.
  * If #webscale SEPARATES (cos < 0.6) where #webzoom did not, then VECTOR RE-LAYOUT -- not border
    geometry -- is what destroys the native zoom's divergence signature -> round-30's cause REFINED.
Either way the boundary is mapped honestly, not forced. Same hard-won round-29 method: a unique ?t=<ms>
query per load forces a fresh cross-document fetch (a hash-only nav silently re-serves a STALE page)."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom', 'webscale']
SETTLE = 6.0   # let network tiles load + map idle before probing


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
    nav = URL + '?t=' + str(int(time.time() * 1000)) + '#' + mode
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=nav); post('act', op='key', key='enter')
    time.sleep(SETTLE)
    cx = (r[0] + r[2]) // 2; cy = (r[1] + r[3]) // 2
    return cx, cy, [cx - 150, cy - 120, cx + 150, cy + 120]


def capture(mode):
    cx, cy, region = goto(mode)
    res = post('flow_probe', x=cx - 110, y=cy, x2=cx + 110, y2=cy, region=region, cols=16, samples=10)
    fs = res.get('flowstruct', {}) or {}
    return {'dyn': res.get('motion', {}).get('sig'),
            'coh': res.get('motion', {}).get('coherence'),
            'flow': fs.get('sig'),
            'trans': fs.get('trans'), 'div': fs.get('div'), 'curl': fs.get('curl'),
            'gain': res.get('change', {}).get('mag', 0.0)}


def _dom(sig):
    if not sig:
        return '?'
    return ['translation', 'divergence', 'curl'][max(range(3), key=lambda i: sig[i])]


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-31: isolate border-geometry vs vector-re-layout as the cause of zoom PARTIAL ===')
    for m in SURF:
        c = cap[m]
        print('   %-8s gain=%6.2f coh=%-6s dyn=%s' % (m, c['gain'], c['coh'], c['dyn']))
        print('            flow=%s (%s)  T=%s D=%s C=%s'
              % (c['flow'], _dom(c['flow']), c['trans'], c['div'], c['curl']))

    # Full flow cosine matrix among the five motions (the honest measurement).
    def fc(a, b):
        return V.cos(cap[a]['flow'], cap[b]['flow'])
    print('\n=== flow_structure cosine matrix ===')
    print('              %s' % '  '.join('%-8s' % m for m in SURF))
    for a in SURF:
        print('   %-8s %s' % (a, '  '.join('%8.3f' % fc(a, b) for b in SURF)))

    # Round-31 falsifiable readout: does the PURE image-scale (#webscale) separate from the rotations
    # where the NATIVE zoom (#webzoom) did not?
    sc_spin = fc('webscale', 'webspin'); sc_tilt = fc('webscale', 'webtilt'); sc_pan = fc('webscale', 'webmap')
    zo_spin = fc('webzoom', 'webspin'); zo_tilt = fc('webzoom', 'webtilt')
    sc_zo = fc('webscale', 'webzoom')
    scale_is_div = _dom(cap['webscale']['flow']) == 'divergence'
    scale_separates = (sc_spin < 0.6) and (sc_tilt < 0.6) and (sc_pan < 0.6)
    zoom_separates = (zo_spin < 0.6) and (zo_tilt < 0.6)
    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)

    print('\n=== round-31 readout: pure image-scale (no vector re-layout) vs native map zoom ===')
    print('   all 5 modes rendered (gain>1):                                       %s' % rendered)
    print('   #webscale reads divergence-dominant (its OWN nature):                %s' % scale_is_div)
    print('   cos(scale, flat-rot)=%.3f  cos(scale, persp-rot)=%.3f  cos(scale, pan)=%.3f' % (sc_spin, sc_tilt, sc_pan))
    print('   cos(zoom,  flat-rot)=%.3f  cos(zoom,  persp-rot)=%.3f' % (zo_spin, zo_tilt))
    print('   cos(scale, zoom)=%.3f  (high => native zoom ~ pure image scale in flow terms)' % sc_zo)
    print('   #webscale cosine-separates from rotation AND pan (cos<0.6):          %s' % scale_separates)
    print('   #webzoom  cosine-separates from the rotations (cos<0.6):             %s' % zoom_separates)

    print('\n=== honest conclusion ===')
    if not rendered:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag; cannot attribute the cause.')
    elif scale_separates and not zoom_separates:
        print('   VECTOR RE-LAYOUT is the culprit: a pure CSS image-scale -- same finite-frame border')
        print('   geometry, zero re-layout -- DOES earn its own divergence class externally (cos<0.6),')
        print('   while the native map zoom does not. MapLibre\'s re-tile/re-fetch/label-reanchor warp,')
        print('   not the border bias, is what collapses the native zoom onto the rotation axis.')
    elif not scale_separates:
        print('   BORDER GEOMETRY confirmed (round-30 cause stands): even a TEXTBOOK conformal divergence')
        print('   field (pure image-scale, no vector re-layout) fails to cosine-separate from rotation on')
        print('   a finite external frame. The limit is the rendering/finite-frame geometry, not MapLibre.')
        print('   The robust external key remains the binary motion_signature coherence (round-29).')
    else:
        print('   BOTH separate -- the external 3-way split is healthier than round-30 found; report the')
        print('   matrix above as-is and re-examine the round-30 webzoom magnitude as a confound.')
    # Non-gating exploratory measurement; exit 0 as long as the surfaces rendered (data is the product).
    sys.exit(0 if rendered else 2)


if __name__ == '__main__':
    main()
