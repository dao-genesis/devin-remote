"""Escalation policy in the act() loop: spend vision ONLY on genuine surprise.

The whole pivot rests on this gate -- a confident, world-model-vouched action returns with ZERO
vision (no PNG); only the steps the model can't vouch for escalate and attach the minimal cropped
image. This drives the loop on the pure-<canvas> lab and shows all three outcomes from real pixels:
  confident          : a drag on a familiar surface, prior held  -> escalate=False, NO image
  surprise           : a gesture family never seen here          -> escalate=True,  image attached
  low_confidence     : a recognised gesture whose outcome is off  -> escalate=True,  image attached
                       its learned prior (here: a dead-zone drag that produced no change)"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9092; BASE = f'http://127.0.0.1:{PORT}'
MODEL = os.path.join(os.path.expanduser('~'), '.dao_world_model.json')
URL = 'file:///' + os.path.join(HERE, 'gui_lab.html').replace('\\', '/')


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


def goto(mode):
    wi = post('ui_info')
    win = [w for w in wi['windows'] if any(k in (w.get('title') or '') for k in ('Chrome', 'Chromium', 'Edge'))][0]
    r = win['rect']; post('activate', title=win['title'][:20]); time.sleep(0.3)
    ab = post('find', text='Address and search bar', control_type='Edit')['elements'][0]['center']
    post('act', op='click', x=ab[0], y=ab[1]); time.sleep(0.15)
    post('act', op='key', key='ctrl+a'); post('act', op='type', text=URL + '#' + mode); post('act', op='key', key='enter')
    time.sleep(1.8)
    cx = (r[0] + r[2]) // 2; cy = r[1] + 350
    return cx, cy, [cx - 150, cy - 120, cx + 150, cy + 120]


def drag(cx, cy, region, action, learn, dead=False):
    x1 = cx - 110; y1 = cy
    if dead:  # a tiny no-op drag in a blank corner: recognised gesture, but produces no change
        x1 = region[0] + 8; y1 = region[1] + 8
        return post('act', op='drag', x=x1, y=y1, x2=x1 + 2, y2=y1 + 2,
                    expect={'effect': {'action': action, 'region': region, 'learn': learn}})
    return post('act', op='drag', x=x1, y=y1, x2=cx + 110, y2=cy,
                expect={'effect': {'action': action, 'region': region, 'learn': learn}})


def show(tag, r):
    e = r.get('effect', {})
    print('%-14s | matched=%-5s escalate=%-5s reason=%-18s image=%s | conf=%s known=%s present=%s' % (
        tag, r.get('matched'), r.get('escalate'), r.get('escalate_reason'),
        'YES' if r.get('region_png_base64') else 'no', e.get('confidence'), e.get('known'), e.get('present')))


def main():
    if os.path.exists(MODEL):
        os.remove(MODEL)
    srv = start()
    try:
        cx, cy, region = goto('orbit')
        for _ in range(6):
            drag(cx, cy, region, 'drag', True); time.sleep(0.12)
        print('=== escalation policy: vision only on genuine surprise ===')
        show('confident', drag(cx, cy, region, 'drag', False))            # familiar, prior holds
        show('surprise', drag(cx, cy, region, 'never_seen_gesture', False))  # novel action family
        show('low_confidence', drag(cx, cy, region, 'drag', False, dead=True))  # recognised, off-prior
    finally:
        srv.terminate()


if __name__ == '__main__':
    main()
