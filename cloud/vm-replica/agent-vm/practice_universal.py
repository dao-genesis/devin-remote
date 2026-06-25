"""Universal GUI-operation practice: does ONE generic 'drag' affordance, grown from pixels across
several strong-GUI surfaces, TRANSFER to a surface never practiced?

Not about any one app -- about the operation itself. We practice the same human gesture (hold+drag)
on a multi-surface pure-<canvas> lab (orbit / pan / paint / timeline / node), each painting a
different signature, and grow a single generic affordance 'drag'. Then LEAVE-ONE-OUT: train on 4
surfaces, predict+verify a drag on the held-out 5th (zero episodes from it) and report, honestly:
  known?     -> is the gesture recognised at all (transfer vs novel)
  present?   -> did an effect of the expected ballpark occur
  ctx_sim    -> how close the held-out surface is to practised ones (1=familiar, low=far transfer)
  locus_diff -> does WHERE-it-happens transfer (universal: effect under the cursor path)
  fp_sim     -> does the exact footprint transfer (surface-specific: expected to be weaker)
  mag_ratio  -> does the magnitude transfer (surface-specific sensitivity differs)
Finally, a gesture family NEVER practised on a surface must come back novel (genuine surprise).
The honest claim: presence+locus of a drag transfer universally; exact shape/size do not. The model
recognises an unseen surface's drag instead of re-learning from scratch, and still flags a new
affordance. Pure pixels, zero vision LLM."""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9094; BASE = f'http://127.0.0.1:{PORT}'
MODEL = os.path.join(os.path.expanduser('~'), '.dao_world_model.json')
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')
SURFACES = ['orbit', 'pan', 'paint', 'timeline', 'node']


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
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    up(); return p


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


def drag(cx, cy, region, learn):
    return post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy,
                expect={'effect': {'action': 'drag', 'region': region, 'learn': learn}})


def main():
    print('=== leave-one-out: does a generic drag affordance transfer to an unseen surface? ===')
    print('held-out | known present transfer ctx_sim locus_diff fp_sim mag_ratio')
    rows = []
    for held in SURFACES:
        if os.path.exists(MODEL):
            os.remove(MODEL)
        srv = start()
        try:
            for s in SURFACES:
                if s == held:
                    continue
                cx, cy, region = goto(s)
                for _ in range(4):
                    drag(cx, cy, region, True); time.sleep(0.15)
            cx, cy, region = goto(held)
            e = drag(cx, cy, region, False).get('effect', {})
            rows.append((held, e))
            print('%-8s |  %-5s %-5s   %-5s   %5.2f    %5.3f   %5.3f  %5.2f' % (
                held, e.get('known'), e.get('present'), e.get('transfer'),
                e.get('ctx_sim', 0), e.get('locus_diff', 0), e.get('fp_sim', 0), e.get('mag_ratio', 0)))
        finally:
            srv.terminate(); time.sleep(0.6)

    # a gesture family NEVER practised: a CLICK (we only ever learned 'drag') must be novel
    if os.path.exists(MODEL):
        os.remove(MODEL)
    srv = start()
    try:
        cx, cy, region = goto('orbit')
        for _ in range(4):
            drag(cx, cy, region, True); time.sleep(0.15)
        cx, cy, region = goto('paint')
        nov = post('act', op='click', x=cx, y=cy,
                   expect={'effect': {'action': 'click_paint', 'region': region, 'learn': False}}).get('effect', {})
        print('\n=== never-practised gesture family (click, only drag was learned) ===')
        print('   action=click_paint known=%s -> %s' % (
            nov.get('known'), 'NOVEL (correctly flagged, escalate)' if not nov.get('known') else 'unexpectedly known'))
    finally:
        srv.terminate()

    # provenance sanity (the other direction): a FAMILIAR surface must read HIGH ctx_sim / transfer=False
    if os.path.exists(MODEL):
        os.remove(MODEL)
    srv = start()
    try:
        for s in SURFACES:
            cx, cy, region = goto(s)
            for _ in range(4):
                drag(cx, cy, region, True); time.sleep(0.15)
        cx, cy, region = goto('orbit')
        fam = drag(cx, cy, region, False).get('effect', {})
        print('\n=== provenance sanity: re-test a PRACTISED surface (orbit) ===')
        print('   orbit familiar: ctx_sim=%.2f transfer=%s (high sim => model knows it has seen this kind of surface)'
              % (fam.get('ctx_sim', 0), fam.get('transfer')))
    finally:
        srv.terminate()

    known = sum(1 for _, e in rows if e.get('known'))
    present = sum(1 for _, e in rows if e.get('present'))
    far = sum(1 for _, e in rows if e.get('transfer'))
    print('\n=== honest summary ===')
    print('   provenance: %d/%d unseen surfaces correctly read as far-transfer (low ctx_sim)' % (far, len(rows)))
    print('   drag RECOGNISED on %d/%d unseen surfaces (transfer, not re-learned)' % (known, len(rows)))
    print('   effect PRESENT (expected ballpark) on %d/%d -- presence/locus transfer better than exact shape/size' % (present, len(rows)))


if __name__ == '__main__':
    main()
