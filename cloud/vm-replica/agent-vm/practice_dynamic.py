"""Round-26 live practice: the action->response motion signature (dyn) vetoes a cross-surface gain
borrow A PRIORI between look-alike surfaces -- demonstrated on REAL captured signatures.

Round-25's honest finding: orbit and pan are indistinguishable in every STATIC descriptor (centroid-
radial cross-cosine ~0.99), so a gain calibrated on one is borrowed by the other (cal_sim >= 0.6) and
the wrong size is corrected only AFTER the next drag disconfirms it (self-heal). Round-26 adds a second
key dimension measured DURING the drag: a pan TRANSLATES (one rigid shift re-aligns the frame, block-
match coherence ~1), an orbit ROTATES (no shift re-aligns, coherence ~0.2). The calibration match
becomes min(static_cos, dynamic_cos), so the borrow is gated off before it happens.

Why drive the gate directly instead of through a leave-one-out act loop: in the full act path every
surface that is itself a transfer self-calibrates, so each look-alike ends up reusing its OWN correct
gain and the cross-surface borrow never even arises (that is the system working). To ISOLATE the gate
we capture each surface's REAL dyn signature (flow_probe) and REAL motion-invariant radial key (gray),
store ONLY the trainer's calibration, then query the partner -- so the trainer's gain is the sole
candidate and cal_sim reports exactly the cross-surface match. The full act path is regression-tested
separately by practice_calibrate.py / test_calibrate_invariant.py."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel as V
PORT = 9096; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')
PAIR = ['orbit', 'pan']
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
    region = [cx - 150, cy - 120, cx + 150, cy + 120]
    return cx, cy, region


def capture(mode):
    """Real per-surface measurement: dyn signature (during a drag) + motion-invariant radial key +
    a representative gain (the drag's before/after magnitude)."""
    cx, cy, region = goto(mode)
    res = post('flow_probe', x=cx - 110, y=cy, x2=cx + 110, y2=cy, region=region, cols=16, samples=10)
    g = post('gray', region=region, cols=16, rows=16).get('gray')
    return {'dyn': res.get('motion', {}).get('sig'),
            'radial': V.context_radial(g, 16, 16) if g else [0] * 10,
            'gain': res.get('change', {}).get('mag', 0.0)}


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in PAIR}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-26: dyn vetoes cross-surface gain borrow (REAL captured signatures) ===')
    for m in PAIR:
        print('   %-6s dyn=%s radial[:4]=%s gain=%.2f'
              % (m, cap[m]['dyn'], [round(x, 3) for x in cap[m]['radial'][:4]], cap[m]['gain']))
    print('   static radial cos(orbit,pan) = %.3f   |   dynamic cos(orbit,pan) = %.3f'
          % (V.cos(cap['orbit']['radial'], cap['pan']['radial']), V.cos(cap['orbit']['dyn'], cap['pan']['dyn'])))

    results = []
    for trainer, partner in (('orbit', 'pan'), ('pan', 'orbit')):
        wm = V.WorldModel()
        wm.calibrate('drag', None, {'mag': cap[trainer]['gain']},
                     cal_ctx=cap[trainer]['radial'], dyn=cap[trainer]['dyn'])
        g25, s25 = wm._best_cal('drag', cap[partner]['radial'], dyn=None)            # round-25 (static only)
        g26, s26 = wm._best_cal('drag', cap[partner]['radial'], dyn=cap[partner]['dyn'])  # round-26 (+dyn)
        go, so = wm._best_cal('drag', cap[trainer]['radial'], dyn=cap[trainer]['dyn'])     # own reuse
        borrow25 = g25 is not None and s25 >= CAL_THR
        borrow26 = g26 is not None and s26 >= CAL_THR
        own = go is not None and so >= CAL_THR
        results.append((trainer, partner, borrow25, s25, borrow26, s26, own, so))
        print('\n-- trainer=%s  partner(look-alike)=%s --' % (trainer, partner))
        print('   round-25 (static key only): partner borrows? %-5s  cal_sim=%.3f' % (borrow25, s25))
        print('   round-26 (+dyn key)       : partner borrows? %-5s  cal_sim=%.3f  <- want False' % (borrow26, s26))
        print('   positive control (own reuse): trainer reuses? %-5s  cal_sim=%.3f  <- want True' % (own, so))

    print('\n=== honest summary ===')
    leaked25 = sum(1 for r in results if r[2])
    vetoed26 = sum(1 for r in results if not r[4])
    own_ok = sum(1 for r in results if r[6])
    print('   round-25 static key would BORROW across the look-alike on %d/%d directions (the leak)' % (leaked25, len(results)))
    print('   round-26 dyn key VETOES that borrow a priori on %d/%d directions (no self-heal needed)' % (vetoed26, len(results)))
    print('   own-gain reuse still works on %d/%d directions (dyn blocks the WRONG borrow, not the right reuse)' % (own_ok, len(results)))
    ok = leaked25 == len(results) and vetoed26 == len(results) and own_ok == len(results)
    print('   RESULT: %s' % ('PASS -- the dynamic signature separates orbit from pan a priori' if ok
                             else 'PARTIAL -- see numbers above'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
