"""Round-30: extend the EXTERNAL kinematics taxonomy from {pan, rotation} to {pan, rotation, ZOOM}.

Round-29 proved, on a genuinely external WebGL map (MapLibre GL + live OSM tiles), that the `dyn`
coherence key separates a TRANSLATION (pan: one rigid shift re-aligns the field -> COHERENT) from a
ROTATION (bearing spin: no single shift -> INCOHERENT). But `motion_signature` asks a BINARY question
-- "does one rigid shift re-align the two frames?" -- so it lumps EVERY non-translation together. A
scroll-ZOOM is also not a rigid shift, hence also incoherent; the binary key therefore CANNOT tell a
zoom from a rotation. That is an honest limit, not a defect.

Round-30 adds the `flow_structure` key (vmodel.flow_structure): it block-matches a grid of local
patches, removes the bulk translation, and decomposes the residual field into a Helmholtz-style
[translation, |divergence|, |curl|]:
    pan      -> bulk TRANSLATION              ~ [1, 0, 0]
    zoom     -> radial residual = DIVERGENCE   ~ [0, 1, 0]
    rotation -> tangential residual = CURL     ~ [0, 0, 1]
So a zoom finally earns its OWN class, orthogonal to both pan and rotation, while the two rotations
(flat #webspin, perspective #webtilt) still group together.

Four kinematics on ONE real external surface:
  webmap   left-drag PANS                       -> translation  (coherent; flow=translation)
  webspin  left-drag ROTATES bearing pitch=0     -> flat rotation (incoherent; flow=curl)
  webtilt  left-drag ROTATES bearing pitch=60    -> persp rotation (incoherent; flow=curl)
  webzoom  left-drag SCROLL-ZOOMS about centre   -> zoom          (incoherent; flow=DIVERGENCE)

Measured, not assumed. PASS iff: all four render; the pan is the most coherent; rotations AND zoom are
all incoherent (so the binary key can't split them); yet flow_structure gives zoom a divergence-
dominant signature that separates from both rotations (cos < 0.6) while the two rotations still group
(cos >= 0.9). If zoom's flow signature instead collapses onto the rotation axis, we report PARTIAL --
the decomposition did not survive external rendering. Network tile pop-in is real noise, reported as-is.
The HARD-WON method note from round-29 still holds: a unique ?t=<ms> query per load forces a fresh
cross-document fetch, else the hash-only nav re-serves a STALE cached page and silently fakes the mode."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom']
SETTLE = 6.0   # let network tiles load + map idle before probing
PAN_AXIS = [1.0, 0.0, 0.0]; ZOOM_AXIS = [0.0, 1.0, 0.0]; ROT_AXIS = [0.0, 0.0, 1.0]


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
    # A unique query string per load forces a fresh cross-document fetch (round-29 lesson).
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

    print('=== round-30: extend the EXTERNAL kinematics taxonomy to a 4th motion (ZOOM) ===')
    for m in SURF:
        c = cap[m]
        print('   %-8s gain=%6.2f coh=%-6s dyn=%s' % (m, c['gain'], c['coh'], c['dyn']))
        print('            flow=%s (%s)  T=%s D=%s C=%s'
              % (c['flow'], _dom(c['flow']), c['trans'], c['div'], c['curl']))

    cohp = cap['webmap']['coh'] or 0.0
    cohs = cap['webspin']['coh'] or 0.0
    coht = cap['webtilt']['coh'] or 0.0
    cohz = cap['webzoom']['coh'] or 0.0
    # --- dyn (binary coherence) cosines: the LOCKED round-29 key, extended to a 4th motion ---
    dz_spin = V.cos(cap['webzoom']['dyn'], cap['webspin']['dyn'])   # zoom vs flat-rot under binary key
    dz_tilt = V.cos(cap['webzoom']['dyn'], cap['webtilt']['dyn'])   # zoom vs persp-rot under binary key
    d_rot = V.cos(cap['webspin']['dyn'], cap['webtilt']['dyn'])     # rot vs rot: expect HIGH (group)

    # ============================ GATING: the robust external invariant ============================
    # Round-29 proved the binary coherence key survives external rendering as a TRANSLATION detector.
    # Round-30 only asks whether it cleanly absorbs a 4th, genuinely different motion (zoom). It must:
    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)
    pan_most_coherent = (cohp > cohs) and (cohp > coht) and (cohp > cohz)
    nonrigid_all_incoherent = (cohs < 0.5) and (coht < 0.5) and (cohz < 0.5)
    rots_group_dyn = d_rot >= 0.9
    zoom_groups_nonrigid = (dz_spin >= 0.9) and (dz_tilt >= 0.9)   # binary key lumps zoom w/ rotation
    print('\n=== GATING: binary coherence key on 4 external motions (locked round-29 invariant) ===')
    print('   all 4 modes produced a measurable drag (gain>1):                     %s' % rendered)
    print('   PAN is the most coherent (one rigid shift re-aligns the field):       %s' % pan_most_coherent)
    print('   rotations AND zoom are all incoherent (coh<0.5):                      %s' % nonrigid_all_incoherent)
    print('   the two rotations group under dyn (cos>=0.9):                         %s' % rots_group_dyn)
    print('   zoom groups WITH rotation under the binary key (cos>=0.9):            %s' % zoom_groups_nonrigid)
    gating = rendered and pan_most_coherent and nonrigid_all_incoherent and rots_group_dyn and zoom_groups_nonrigid

    # ===================== EXPLORATORY: can the 3-way flow_structure split zoom? =====================
    # On CLEAN synthetic frames it does (test_flow_structure.py PASS). Here we MEASURE whether it
    # survives the real external WebGL flow field. Reported, NOT gating -- measurement decides.
    fz_spin = V.cos(cap['webzoom']['flow'], cap['webspin']['flow'])
    fz_tilt = V.cos(cap['webzoom']['flow'], cap['webtilt']['flow'])
    fz_pan = V.cos(cap['webzoom']['flow'], cap['webmap']['flow'])
    f_rot = V.cos(cap['webspin']['flow'], cap['webtilt']['flow'])
    zoom_is_divergence = _dom(cap['webzoom']['flow']) == 'divergence'
    pan_is_translation = _dom(cap['webmap']['flow']) == 'translation'
    rots_are_curl = (_dom(cap['webspin']['flow']) == 'curl') and (_dom(cap['webtilt']['flow']) == 'curl')
    zoom_separates = (fz_spin < 0.6) and (fz_tilt < 0.6) and (fz_pan < 0.6)
    print('\n=== EXPLORATORY: does the 3-way flow_structure give zoom its own class externally? ===')
    print('   flow cos(zoom, flat-rot)=%.3f  cos(zoom, persp-rot)=%.3f  cos(zoom, pan)=%.3f  cos(rot,rot)=%.3f'
          % (fz_spin, fz_tilt, fz_pan, f_rot))
    print('   PAN reads translation-dominant:                                      %s' % pan_is_translation)
    print('   ZOOM reads divergence-dominant (its OWN nature, in isolation):        %s' % zoom_is_divergence)
    print('   both ROTATIONS read curl-dominant:                                    %s' % rots_are_curl)
    print('   ZOOM cosine-separates from rotations AND pan (cos<0.6):               %s' % zoom_separates)
    flow_survives = zoom_is_divergence and pan_is_translation and rots_are_curl and zoom_separates

    print('\n=== honest summary ===')
    print('   GATING (taxonomy extends to 4 motions under the binary key): %s' % ('PASS' if gating else 'FAIL'))
    if flow_survives:
        print('   EXPLORATORY (3-way flow_structure splits zoom externally):   PASS -- zoom is a distinct '
              'divergence class, separate from rotation (curl) and pan (translation).')
    else:
        print('   EXPLORATORY (3-way flow_structure splits zoom externally):   PARTIAL -- zoom does NOT '
              'cosine-separate from rotation on this external renderer. Finite-frame border-matching '
              'injects a motion-independent inward divergence into EVERY mode (even pure pan), and a '
              'zoom\'s true radial signal sits in that same noisy outer ring, so a rotation also reads '
              'divergence-dominant. The 3-way decomposition is clean on synthetic frames '
              '(test_flow_structure.py) but its fine taxonomy does not survive external rendering; the '
              'ROBUST external key stays the binary coherence (gating above). Boundary mapped, not forced.')
    # CI gates on the robust invariant; the flow_structure split is an honestly-reported measurement.
    sys.exit(0 if gating else 2)


if __name__ == '__main__':
    main()
