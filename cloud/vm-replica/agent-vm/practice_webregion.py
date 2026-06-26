"""Round-38: falsifiably test BOUNDARY LOCALIZATION + per-region PARSE on a REAL external renderer
(MapLibre GL + live OSM tiles), corroborating the synthetic _diag_region_parse.py finding.

We capture each pure mode's real drag frames ONCE (flow_probe frames_out=True), then SPATIALLY COMPOSITE two
real fields at a KNOWN split position (left region from mode A, right from mode B). Each region carries the
GENUINE externally-rendered pixels/motion of its source. We then ask region_parse to (1) recover the split
axis+position over the fixed dyadic ladder, and (2) crop along that boundary and label each side with the
LOCKED motion_class -- exactly the human-level "left pane is scrolling, right pane is zooming, split ~60%"
parse.

PRE-REGISTERED readout (set BEFORE measuring -- 為者敗之):
  * EXPECT each pure captured mode to read LOW gain -> NO boundary declared, whole-frame label correct.
  * EXPECT each pan-INVOLVED composite to recover the true axis and a position within one ladder step
    (1/8) of ground truth, and to label each crop with its source motion.
  * HONEST CAVEAT (from round-37 + synthetic): a curved|curved composite (rotation|zoom) may alias LOW on
    the live renderer and fail to localise; cropping also halves a region's extent so per-region confidence
    may drop even when the label is right. Report whatever the live data shows; do NOT tune to a verdict.
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import multiregion as MR
import region_parse as RP

PORT = 9105; BASE = f'http://127.0.0.1:{PORT}'
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

    print('=== round-38: BOUNDARY LOCALIZATION + per-region PARSE on MapLibre+OSM (real frames) ===')
    rendered = all(cap[m][1] > 1.0 for m in SURF)
    fr = {m: cap[m][0] for m in SURF}
    ok = all(len(fr[m]) >= 2 for m in SURF)
    print('   all %d pure modes rendered: %s\n' % (len(SURF), rendered and ok))
    if not rendered or not ok:
        print('   INCONCLUSIVE -- not every mode produced a measurable drag (GUI/renderer unavailable).')
        sys.exit(2)

    # singles: no boundary, whole-frame label correct
    print('   --- PURE single modes (expect NO boundary; whole-frame label correct) ---')
    single_bad = 0
    for m in SURF:
        res = RP.parse_regions(fr[m], COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        whole = res['regions'][0]
        good = (not res['composite']) and whole['cls'] == PURE_CLS[m]
        single_bad += int(not good)
        print('   %-18s gain=%.4f composite=%s  whole=%s (truth %s)%s'
              % (m, res['gain'], res['composite'], whole['cls'], PURE_CLS[m],
                 '' if good else '   <- WRONG'))

    # composites at known splits: recover axis+position and per-region labels
    specs = [
        ('webmap', 'webzoom', 'vert', 0.5), ('webmap', 'webzoom', 'vert', 0.625),
        ('webmap', 'webspin', 'vert', 0.5), ('webzoom', 'webspin', 'horz', 0.5),
        ('webspin', 'webzoom', 'vert', 0.5),  # curved|curved -- pre-registered HARD
    ]
    print('\n   --- COMPOSITES (recover axis@position + per-region label) ---')
    loc_bad = 0; ncomp = 0
    for a, b, orient, frac in specs:
        comp = (MR.compose_lr if orient == 'vert' else MR.compose_tb)(fr[a], fr[b], COLS, ROWS, frac)
        res = RP.parse_regions(comp, COLS, ROWS, search=SEARCH, blocks=BLOCKS)
        ncomp += 1
        truth = '%s|%s %s@%.3f' % (PURE_CLS[a], PURE_CLS[b], orient, frac)
        if res['composite'] and res.get('orientation') == orient and abs((res.get('frac') or 0) - frac) <= 0.125 + 1e-9:
            regs = res['regions']
            lab = '%s=%s %s=%s' % (regs[0]['span'], regs[0]['cls'], regs[1]['span'], regs[1]['cls'])
            cls_ok = (regs[0]['cls'] == PURE_CLS[a] and regs[1]['cls'] == PURE_CLS[b])
            loc_bad += int(not cls_ok)
            print('   %-26s -> comp=True axis=%s frac=%.3f gain=%.3f  %s  cls_ok=%s'
                  % (truth, res['orientation'], res['frac'], res['gain'], lab, cls_ok))
        else:
            loc_bad += 1
            print('   %-26s -> comp=%s axis=%s frac=%s gain=%.3f   <- NOT LOCALISED'
                  % (truth, res['composite'], res.get('orientation'), res.get('frac'), res['gain']))

    print('\n=== round-38 readout (measurement decides, not preference -- 為者敗之) ===')
    print('   pure-mode false boundaries : %d/%d' % (single_bad, len(SURF)))
    print('   composites mis-parsed      : %d/%d  (curved|curved expected among the hard ones)' % (loc_bad, ncomp))
    if single_bad == 0 and loc_bad == 0:
        print('   The synthetic parse reproduces live: no boundary on pure modes, and every composite is localised')
        print('   to its true axis/position with each region correctly labelled by the LOCKED classifier.')
        sys.exit(0)
    print('   Live did NOT fully reproduce the synthetic parse -- reported as measured above (honest ceiling).')
    sys.exit(1)


if __name__ == '__main__':
    main()
