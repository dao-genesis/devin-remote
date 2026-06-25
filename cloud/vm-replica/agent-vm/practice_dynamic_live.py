"""Round-27 live END-TO-END: the dyn gate fires inside the FULL act path (predict-act-verify), not just
a controlled offline harness -- closing round-26's honest gap (it was proven only offline).

Round-26 proved the action->response signature separates orbit from pan, but only by driving _best_cal
directly: in the full act path every transfer surface self-calibrates, so each look-alike used its OWN
gain and the cross-surface borrow never arose. To make the gate's VETO observable live we build a proper
leave-the-look-alikes-out scenario, then A/B round-25 vs round-26 with the live `use_dyn` switch:

  phase 1  train EPISODES on pan + the non-look-alikes (paint/timeline/node), learn=True,
           calibrate=False -> the generic 'drag' affordance exists, NO gains stored. orbit is left OUT
           of episodes so it is a TRANSFER; pan is IN so orbit's footprint is still recognised (the
           |delta| footprints of the orbit/pan look-alike pair match each other, round-23).
  phase 2  probe orbit COLD (learn=False, calibrate=True): orbit is an un-calibrated transfer whose
           footprint IS recognised (via pan), so the verifying drag measures and stores orbit's
           calibration (rotational dyn) -- the sole stored gain.
  phase 3  probe the familiar pan twice (calibrate=False so it only READS the borrow decision), with
           ONLY orbit's (look-alike) calibration present:
             (a) use_dyn=False -> round-25 behaviour: static radial ~0.99 >= 0.6 -> BORROWS orbit's gain
                 (calibrated=True). The wrong size is taken; only a later drag would self-heal it.
             (b) use_dyn=True  -> round-26 behaviour: min(static, dynamic)=~0.49 < 0.6 -> VETO
                 (calibrated=False); pan refuses the wrong borrow a priori.

The two phase-3 probes are run on independent fresh models (each rebuilt through phases 1-2) so the only
difference is the dyn switch. Everything is the real act() path on the real lab; pure pixels, zero vision."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9097; BASE = f'http://127.0.0.1:{PORT}'
MODEL = os.path.join(os.path.expanduser('~'), '.dao_world_model.json')
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')
TRAIN = ['pan', 'paint', 'timeline', 'node']   # orbit left OUT -> it is the transfer that stores a cal
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


def start():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env); up(); return p


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


def drag(cx, cy, region, learn, calibrate, use_dyn):
    eff = {'action': 'drag', 'region': region, 'learn': learn, 'calibrate': calibrate, 'use_dyn': use_dyn}
    return post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy, expect={'effect': eff}).get('effect', {})


def build():
    """Fresh model; populate the 'drag' affordance on non-look-alikes (episodes only, no gains);
    then calibrate orbit cold so its (look-alike) gain is the sole stored calibration."""
    if os.path.exists(MODEL):
        os.remove(MODEL)
    srv = start()
    for s in TRAIN:
        cx, cy, region = goto(s)
        for _ in range(3):
            drag(cx, cy, region, True, False, True); time.sleep(0.1)
    cx, cy, region = goto('orbit')
    drag(cx, cy, region, False, True, True); time.sleep(0.15)   # orbit transfer stores its cal (rotational dyn)
    return srv


def probe_pan(use_dyn):
    srv = build()
    try:
        cxp, cyp, rp = goto('pan')
        return drag(cxp, cyp, rp, False, False, use_dyn)        # pan READS the borrow vs orbit's look-alike cal
    finally:
        srv.terminate(); time.sleep(0.6)


def main():
    print('=== round-27: dyn gate fires in the FULL live act path (round-25 borrow vs round-26 veto) ===')
    r25 = probe_pan(use_dyn=False)
    r26 = probe_pan(use_dyn=True)
    if os.path.exists(MODEL):
        os.remove(MODEL)

    def row(tag, r):
        print('   %-9s pan dyn=%s  cal_sim=%s  calibrated=%s  present=%s  gain_known=%s'
              % (tag, r.get('dyn'), r.get('cal_sim'), r.get('calibrated'), r.get('present'), r.get('gain_known')))
    row('round-25', r25)   # use_dyn=False: borrows orbit's gain (calibrated True, high cal_sim)
    row('round-26', r26)   # use_dyn=True : vetoes the borrow (calibrated False, cal_sim < 0.6)

    print('\n=== honest summary ===')
    borrowed = bool(r25.get('calibrated')) and float(r25.get('cal_sim') or 0) >= CAL_THR
    vetoed = (not r26.get('calibrated')) and float(r26.get('cal_sim') or 1) < CAL_THR
    print('   round-25 (no dyn): pan BORROWED orbit gain across the look-alike: %s (cal_sim %s)'
          % (borrowed, r25.get('cal_sim')))
    print('   round-26 (+dyn)  : pan VETOED that borrow a priori in the live path: %s (cal_sim %s)'
          % (vetoed, r26.get('cal_sim')))
    ok = borrowed and vetoed
    print('   RESULT: %s' % ('PASS -- the dynamic gate is no longer dormant; it fires end-to-end in act()'
                             if ok else 'PARTIAL -- see numbers above'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
