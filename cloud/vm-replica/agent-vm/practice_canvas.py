"""Practice on a PURE-CANVAS app (3D-viewport proxy) where semantics are blind, growing a
pixel-only visual world model from experience and using it to VERIFY outcomes -- no vision LLM.

Demonstrates the kernel the root critique demands:
  1. LEARN   : repeat a drag (rotate the viewport); accumulate (context, action, effect) episodes.
  2. PREDICT : for a fresh drag, predict the change it SHOULD cause and verify the actual outcome
               against that expectation -- a hit costs ~0 (no screenshot to an LLM).
  3. NO-OP   : a negligible drag fails to match the learned rotate effect -> correctly 'no effect'.
  4. SURPRISE: a click that paints produces a DIFFERENT effect; against the rotate expectation it
               scores low (genuine surprise) -- and is itself learnable as a new affordance.
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vmodel

PORT = 9095; BASE = f'http://127.0.0.1:{PORT}'
COLS = ROWS = 16
URL = 'file:///' + os.path.join(HERE, 'canvas_lab.html').replace('\\', '/')
MODEL = os.path.join(os.path.expanduser('~'), '.dao_world_model.json')


def post(a, **b):
    b['action'] = a; d = json.dumps(b).encode()
    r = urllib.request.Request(BASE + '/', data=d, method='POST', headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=60).read().decode('utf-8'))


def up(t=15):
    e = time.time() + t
    while time.time() < e:
        try:
            if urllib.request.urlopen(BASE + '/health', timeout=2).status == 200:
                return True
        except Exception:
            time.sleep(0.3)


def feat(region):
    g = post('observe', region=region, tiles=True, cols=COLS, rows=ROWS)
    return g['tiles']['gray']


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        wi = post('ui_info')
        cands = [w for w in wi['windows'] if any(k in (w.get('title') or '') for k in ('Chrome', 'Chromium', 'Edge'))]
        if not cands:
            print('NO BROWSER'); return
        win = cands[0]; r = win['rect']
        post('activate', title=win['title'][:20]); time.sleep(0.5)
        ab = post('find', text='Address and search bar', control_type='Edit')
        c = ab['elements'][0]['center']
        post('act', op='click', x=c[0], y=c[1]); time.sleep(0.2)
        post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL); post('act', op='key', key='enter')
        time.sleep(2.5)

        region = [r[0], r[1] + 140, r[2], min(r[3], r[1] + 560)]
        cx = (r[0] + r[2]) // 2; cy = r[1] + 350
        wm = vmodel.WorldModel(MODEL)

        def rotate(dx=110):
            pre = feat(region)
            post('act', op='drag', x=cx - dx, y=cy, x2=cx + dx, y2=cy); time.sleep(0.35)
            cur = feat(region)
            return pre, cur, vmodel.change_descriptor(pre, cur, COLS, ROWS), vmodel.context_fp(pre, COLS, ROWS)

        print('=== 1. LEARN: drag-to-rotate (growing the affordance from practice) ===')
        for i in range(6):
            pre, cur, desc, ctx = rotate()
            wm.record('drag_right', ctx, desc)
            print('   ep%d  mag=%.2f centroid=(%.2f,%.2f)  aniso=%+.3f' %
                  (i, desc['mag'], desc['cx'], desc['cy'], desc['aniso']))
        print('   learned episodes for drag_right:', wm.seen('drag_right'))

        print('\n=== 2. PREDICT + VERIFY a fresh rotate (zero vision) ===')
        pre = feat(region); ctx = vmodel.context_fp(pre, COLS, ROWS)
        pred = wm.predict('drag_right', ctx)
        post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy); time.sleep(0.35)
        obs = vmodel.change_descriptor(pre, feat(region), COLS, ROWS)
        v = wm.verify('drag_right', ctx, obs)
        print('   rotate obs: mag=%.2f aniso=%+.3f (learned aniso~%+.3f)  -> MATCH=%s' %
              (obs['mag'], obs['aniso'], pred.get('aniso', 0.0), v['match']))

        print('\n=== 3. NO-OP: a drag on the dead margin (off-canvas) -> absent ===')
        pre = feat(region); ctx = vmodel.context_fp(pre, COLS, ROWS)
        post('act', op='drag', x=r[0] + 40, y=cy, x2=r[0] + 150, y2=cy); time.sleep(0.35)
        obs = vmodel.change_descriptor(pre, feat(region), COLS, ROWS)
        v = wm.verify('drag_right', ctx, obs)
        print('   observed mag=%.2f  present=%s  -> MATCH=%s (expect absent / False)' %
              (obs['mag'], v['present'], v['match']))

        print('\n=== 4. DIFFERENT EFFECT: paint a mark in a corner -> rejected ===')
        pre = feat(region); ctx = vmodel.context_fp(pre, COLS, ROWS)
        # click near the canvas top-left to paint a big dot far from the cube centre
        post('act', op='click', x=r[0] + (r[2] - r[0]) // 2 - 230, y=r[1] + 200); time.sleep(0.35)
        obs = vmodel.change_descriptor(pre, feat(region), COLS, ROWS)
        v = wm.verify('drag_right', ctx, obs)
        print('   paint obs: mag=%.2f centroid=(%.2f,%.2f) locus_diff=%.3f -> MATCH=%s (rejected: smaller + different locus)' %
              (obs['mag'], obs['cx'], obs['cy'], v['locus_diff'], v['match']))

        print('\n=== 5. HONEST BOUNDARY: vertical drag = tilt (same size & locus as rotate) ===')
        pre = feat(region); ctx = vmodel.context_fp(pre, COLS, ROWS)
        post('act', op='drag', x=cx, y=cy - 90, x2=cx, y2=cy + 90); time.sleep(0.35)
        obs = vmodel.change_descriptor(pre, feat(region), COLS, ROWS)
        v = wm.verify('drag_right', ctx, obs)
        print('   tilt obs: mag=%.2f locus_diff=%.3f present=%s MATCH=%s' %
              (obs['mag'], v['locus_diff'], v['present'], v['match']))
        print('   direction advisory: sfp_sim=%.3f aniso_diff=%.3f' % (v['sfp_sim'], v['aniso_diff']))
        print('   -> cheap features CANNOT separate tilt from rotate (same size+locus); deciding')
        print('      direction needs temporal/optical-flow or a vision escalation. Recorded as novel.')
        wm.record('drag_down', ctx, obs)

        wm.save()
        print('\nworld model persisted:', MODEL, ' total episodes:', len(wm.ep))
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
