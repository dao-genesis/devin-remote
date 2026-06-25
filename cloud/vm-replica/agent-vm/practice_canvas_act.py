"""End-to-end: drive the world model THROUGH the daemon act() loop (the same surface MCP exposes),
proving the pixel-only forward model verifies actions live -- learn, then predict+verify, then catch
a prediction error -- on a pure <canvas> where semantics are blind. No vision LLM on the happy path.

act(expect={'effect': {'action': 'drag_right', 'region': [...], 'learn': true}}) captures a 16x16
baseline before the op and, after it, scores the local visual change against learned episodes; a
known mismatch flips matched=False (a real prediction error) without re-issuing the non-idempotent drag.
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

PORT = 9098; BASE = f'http://127.0.0.1:{PORT}'
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


def main():
    if os.path.exists(MODEL):
        os.remove(MODEL)
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
        eff = lambda learn=True: {'effect': {'action': 'drag_right', 'region': region, 'learn': learn}}

        print('=== LEARN drag_right through act() (daemon/MCP surface) ===')
        for i in range(6):
            res = post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy, expect=eff())
            e = res.get('effect', {})
            print('   ep%d matched=%s known=%s mag=%.2f' % (i, res['matched'], e.get('known'), e['obs']['mag']))
            time.sleep(0.2)

        print('\n=== PREDICT+VERIFY a fresh rotate via act() (zero vision) ===')
        res = post('act', op='drag', x=cx - 110, y=cy, x2=cx + 110, y2=cy, expect=eff(False))
        e = res['effect']
        print('   matched=%s effect.match=%s mag=%.2f locus_diff=%.3f reasons=%s' %
              (res['matched'], e['match'], e['obs']['mag'], e.get('locus_diff'), res['reasons']))

        print('\n=== PREDICTION ERROR: dead-margin drag, asserted as drag_right ===')
        res = post('act', op='drag', x=r[0] + 40, y=cy, x2=r[0] + 150, y2=cy, expect=eff(False), retry=3)
        e = res['effect']
        print('   matched=%s effect.match=%s present=%s mag=%.2f attempts=%s reflex=%s' %
              (res['matched'], e['match'], e.get('present'), e['obs']['mag'], res['attempts'], res['reflex']))
        print('   (expect matched=False, no reflex re-drag since effect is asserted)')
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
