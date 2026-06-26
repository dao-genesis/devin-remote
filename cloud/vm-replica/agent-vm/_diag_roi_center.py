"""Round-33 diagnostic (not a unit test): is the webspin->zoom miss caused by the OFF-CENTRE ROI starving
the rotational curl signal, or is it a genuine estimator failure?

Hypothesis (geometry, falsifiable): divergence (zoom) and curl (rotation) are defined relative to the
motion's FIXED POINT (the MapLibre transform anchor ~ screen centre). To read them the interior window must
SPAN that anchor. round-32's canonical drag had a centred ROI; round-33's fresh gesture shifted the ROI up
24px, pushing the anchor toward the window edge -> the local field becomes translation-dominant and the
curl/div residuals fall to the noise floor (where div happened to edge curl for webspin).

Test: for webspin AND webzoom, capture the SAME fresh drag under three ROI placements -- up (round-33),
centred (spans the anchor), down -- and print the interior [T,D,C]. If curl re-dominates for webspin and
div strengthens for webzoom only when the ROI is centred, the miss is ROI PLACEMENT, not the estimator,
and centring the observation window on the anchor is principled geometry (not threshold massaging).
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SETTLE = 6.0; COLS = ROWS = 48; SEARCH = 4; BLOCKS = 12; SAMPLES = 10


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
    return (r[0] + r[2]) // 2, (r[1] + r[3]) // 2


def probe(mode, cx, cy, region, tag):
    res = post('flow_probe', x=cx - 130, y=cy - 22, x2=cx + 70, y2=cy - 22, region=region,
               cols=COLS, rows=ROWS, samples=SAMPLES, classify=True, search=SEARCH, blocks=BLOCKS)
    mc = res.get('motion_class') or {}
    sig = mc.get('roi_sig'); print('   %-8s %-10s cls=%-8s coh=%-6s T/D/C=%s kept/drop=%s/%s'
                                   % (mode, tag, mc.get('cls'), mc.get('coherence'), sig, mc.get('kept'), mc.get('dropped')))


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        print('=== ROI-placement diagnostic: same fresh drag, three observation windows ===')
        for mode in ('webspin', 'webzoom'):
            cx, cy = goto(mode)
            probe(mode, cx, cy, [cx - 140, cy - 164, cx + 140, cy - 24], 'up(r33)')
            probe(mode, cx, cy, [cx - 140, cy - 140, cx + 140, cy + 140], 'centred')
            probe(mode, cx, cy, [cx - 140, cy + 24, cx + 140, cy + 164], 'down')
    finally:
        srv.terminate(); time.sleep(0.5)


if __name__ == '__main__':
    main()
