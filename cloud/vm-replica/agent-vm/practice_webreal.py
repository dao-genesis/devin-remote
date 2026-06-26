"""Round-29: do the keys survive a GENUINELY EXTERNAL real GUI -- a third-party WebGL map?

real_lab.html (round-28) proved the keys survive realistic rendering, but it was still OUR canvas.
This points the live act() loop at web_lab.html: MapLibre GL (a third-party WebGL library) rendering
LIVE OpenStreetMap network tiles, with labels and anti-aliasing and tile pop-in.

HARD-WON METHOD NOTE (root cause of an earlier wrong conclusion). Navigating between hashes of the same
file:// URL is a same-document navigation, and the reload() it triggers re-served a STALE CACHED copy of
the page. That silently froze webtilt at pitch=0 AND made webspin run cached pan code -- so an earlier run
read the two rotations as 'coherent, grouped with the pan' and produced a (false) 'RIGID-vs-NON-RIGID,
flat-rotation-is-rigid' story. Appending a unique ?t=<ms> query forces a fresh cross-document fetch; with
clean loads the data inverts and the ORIGINAL lab result holds: dyn separates ROTATION from TRANSLATION.

Three kinematics on ONE real external surface:
  webmap   left-drag PANS                    -> translation         (one rigid shift re-aligns -> COHERENT)
  webspin  left-drag ROTATES bearing pitch=0  -> flat rotation       (rotating field, no single shift -> INCOHERENT)
  webtilt  left-drag ROTATES bearing pitch=60 -> perspective rotation (also rotating -> INCOHERENT)

Measured, not assumed: the pan is the most coherent; BOTH rotations are far less coherent and read nearly
identically in dyn (the added perspective pitch barely moves the needle -- the discriminator is
rotation-vs-translation, not the rigidity of the warp). Both rotations group together and separate from the
pan. If instead a rotation reads as coherent as the pan, the key does NOT survive external rendering and we
report PARTIAL. Network tile pop-in is real noise, reported as-is."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt']
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
    # A unique query string per load forces a fresh cross-document fetch. Without it, navigating between
    # hashes is a same-document nav whose reload() re-serves a STALE cached copy -- which silently froze
    # webtilt at pitch=0 in earlier runs and falsely read it as "rigid/coherent".
    nav = URL + '?t=' + str(int(time.time() * 1000)) + '#' + mode
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=nav); post('act', op='key', key='enter')
    time.sleep(SETTLE)
    cx = (r[0] + r[2]) // 2; cy = (r[1] + r[3]) // 2
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

    print('=== round-29: do the keys survive a real EXTERNAL third-party WebGL map? ===')
    for m in SURF:
        print('   %-8s gain=%6.2f  coherence=%-6s dyn=%s'
              % (m, cap[m]['gain'], cap[m]['coh'], cap[m]['dyn']))
    cohp = cap['webmap']['coh'] or 0.0      # pan (translation)
    cohs = cap['webspin']['coh'] or 0.0     # flat rotation
    coht = cap['webtilt']['coh'] or 0.0     # perspective rotation
    sep_flat = V.cos(cap['webmap']['dyn'], cap['webspin']['dyn'])    # pan vs flat-rot: expect LOW (rot != translation)
    sep_persp = V.cos(cap['webmap']['dyn'], cap['webtilt']['dyn'])   # pan vs persp-rot: expect LOW
    rot_group = V.cos(cap['webspin']['dyn'], cap['webtilt']['dyn'])  # flat-rot vs persp-rot: expect HIGH (both rotation)
    print('\n   dyn cos(pan,  flat-rot webspin)  = %.3f  <- expect LOW  (rotation != translation)' % sep_flat)
    print('   dyn cos(pan,  persp-rot webtilt) = %.3f  <- expect LOW  (rotation != translation)' % sep_persp)
    print('   dyn cos(flat-rot, persp-rot)     = %.3f  <- expect HIGH (both are rotation; pitch adds little)' % rot_group)

    rendered = all(cap[m]['gain'] > 1.0 for m in SURF)
    # the clean claim (== the lab orbit-vs-pan result, now external): a PAN is the most coherent (one
    # rigid shift re-aligns the field); BOTH rotations are markedly less coherent and group together in
    # dyn while separating from the pan. The extra perspective pitch is NOT the discriminator.
    pan_most_coherent = (cohp > cohs) and (cohp > coht)
    rotations_incoherent = (cohs < 0.5) and (coht < 0.5)
    rotations_group = rot_group >= 0.9
    rotations_separate_from_pan = (sep_flat < rot_group) and (sep_persp < rot_group)
    print('\n=== honest summary ===')
    print('   real external map produced a measurable drag on 3/3 modes:        %s' % rendered)
    print('   PAN is the most coherent (one rigid shift re-aligns the field):    %s' % pan_most_coherent)
    print('   BOTH rotations are incoherent (no single shift aligns a spin):     %s' % rotations_incoherent)
    print('   the two rotations group together in dyn (pitch is not the axis):   %s' % rotations_group)
    print('   rotations separate from the pan in dyn (rotation != translation):  %s' % rotations_separate_from_pan)
    ok = rendered and pan_most_coherent and rotations_incoherent and rotations_group and rotations_separate_from_pan
    print('   RESULT: %s' % (
        'PASS -- on a real external WebGL map the dyn key survives as a ROTATION-vs-TRANSLATION '
        'discriminator: the pan is coherent (one rigid shift re-aligns frames) while any bearing rotation '
        '-- flat OR perspective -- is incoherent and groups away from the pan. This reproduces the lab '
        'orbit-vs-pan result on genuinely external rendering; the perspective pitch is not the axis.' if ok
        else 'PARTIAL -- the rotation/translation separation did not fully survive external rendering; numbers above'))
    sys.exit(0 if ok else 2)


if __name__ == '__main__':
    main()
