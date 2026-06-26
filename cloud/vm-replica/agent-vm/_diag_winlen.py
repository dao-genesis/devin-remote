"""Round-35c diagnostic: is the intermittent run-length pan flicker a SHORT-WINDOW coherence-variance
artifact, or a real renderer-driven temporal edge?

Round-35/35b found that pan's per-window classification over short 4-frame (=3-delta) sub-windows
intermittently flickers; sometimes the flip is isolated (median-3 voter fixes it) and sometimes it is a
RUN of consecutive windows (voter cannot). The coherence key has higher variance over fewer deltas, so the
falsifiable hypothesis is: the run-length flicker is the SHORT WINDOW's coherence variance, not a real
motion edge. Test it by holding the GESTURE fixed and sweeping ONLY the window length.

Method (one variable):
  * Capture ONE pan gesture per mode at high sample density (SAMPLES_HI -> many frames) ONCE.
  * Re-run temporal_consistency.classify_windows on the SAME frames at win in {4,5,6,7,8}.
  * Tabulate flicker (transitions, agreement) vs window length.

Falsifiable verdict (pre-registered, 為者敗之):
  * If flicker monotonically vanishes as win grows -> short-window variance artifact; the principled fix is
    a MINIMUM-EVIDENCE window (require >= W* frames), NOT cranking the vote radius.
  * If flicker persists even at win=8 -> a real renderer-driven temporal edge; report it as the next boundary.

vmodel.py / flow_roi.py / motion_class.py byte-for-byte untouched; pure measurement.
"""
import json, os, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import temporal_consistency as T
PORT = 9102; BASE = f'http://127.0.0.1:{PORT}'
URL = 'file:///' + os.path.join(HERE, 'web_lab.html').replace('\\', '/')
SURF = ['webmap', 'webspin', 'webtilt', 'webzoom', 'webscale']
EXPECT = {'webmap': 'pan', 'webspin': 'rotation', 'webtilt': 'rotation', 'webzoom': 'zoom', 'webscale': 'zoom'}
SETTLE = 6.0
COLS = ROWS = 48
SEARCH = 4; BLOCKS = 12
SAMPLES_HI = 16        # 16 -> 17 frames, enough to sweep win up to 8 with several windows each
WINS = [4, 5, 6, 7, 8]


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
               cols=COLS, rows=ROWS, samples=SAMPLES_HI, frames_out=True, search=SEARCH, blocks=BLOCKS)
    return res.get('raw_frames') or [], res.get('change', {}).get('mag', 0.0)


def main():
    env = dict(os.environ, VM_AGENT_PORT=str(PORT), VM_AGENT_TOKEN='', VM_AGENT_BIND='127.0.0.1')
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'vm_inner_agent.py')], env=env)
    try:
        up()
        cap = {m: capture(m) for m in SURF}
    finally:
        srv.terminate(); time.sleep(0.5)

    print('=== round-35c: flicker vs WINDOW LENGTH (gesture held fixed, win is the only variable) ===')
    print('   capture: %d frames/mode; sweep win in %s; ROI centred on anchor; LOCKED round-33 cascade' % (SAMPLES_HI + 1, WINS))
    hdr = '   %-8s %-8s |' % ('mode', 'expect') + ''.join(' w%-2d:agr/trn' % w for w in WINS)
    print(hdr)
    # tally flicker incidence per window length across modes
    flick = {w: 0 for w in WINS}
    for m in SURF:
        frames, gain = cap[m]; exp = EXPECT[m]
        row = '   %-8s %-8s |' % (m, exp)
        for w in WINS:
            if len(frames) < w:
                row += '  w%-2d:  --  ' % w; continue
            tw = T.classify_windows(frames, COLS, ROWS, win=w, search=SEARCH, blocks=BLOCKS)
            stable = (tw['modal'] == exp and tw['agreement'] == 1.0 and tw['transitions'] == 0)
            if not stable:
                flick[w] += 1
            row += ' %4.2f/%-2d%s' % (tw['agreement'], tw['transitions'], ' ' if stable else '*')
        print(row)
    print('\n   flicker incidence (modes not perfectly stable) by window length:')
    for w in WINS:
        print('      win=%d frames (%d deltas): %d / %d modes flicker' % (w, w - 1, flick[w], len(SURF)))

    print('\n=== verdict (measurement decides, not preference -- 為者敗之) ===')
    short = flick[WINS[0]]; longest = flick[WINS[-1]]
    if longest == 0 and short > 0:
        print('   Flicker VANISHES as the window lengthens: the run-length pan flip is a SHORT-WINDOW coherence-')
        print('   variance artifact, not a real motion edge. The principled fix is a MINIMUM-EVIDENCE window')
        print('   (require >= the shortest fully-stable win), NOT cranking the vote radius. Reported as measured.')
        sys.exit(0)
    elif longest > 0:
        print('   Flicker PERSISTS even at the longest window: a real renderer-driven temporal edge, not mere')
        print('   short-window variance. Recorded as the next honest boundary; no threshold massaging.')
        sys.exit(1)
    else:
        print('   No flicker at any window length on this capture (intermittent event did not fire this run).')
        sys.exit(0)


if __name__ == '__main__':
    main()
