"""Probe (F143): prove the foveated `wait_stable` no longer false-settles on a
moving target — the R18 friction.

Reproduces the R18 scene: a magenta square teleports between two far-apart spots
every 180 ms for 1.6 s, then stops at a third FINAL spot (and sets window.__settled).
A correct `wait_stable` must (a) NOT settle while it is still teleporting, and (b)
return the FINAL resting position so a click HITs. Runs the trial 5x.

Run: ``DISPLAY=:0 python3 _probe_settle.py``. Expected: every trial OK — settled,
the animation had truly finished (fin_anim=True), the click HITs, ~2.0 s, with a
handful of `saccades` (it re-acquires after each teleport and only settles at rest).
Contrast the committed F054/full-screen poll, which aliases the 180 ms teleport and
can settle mid-flight -> MISS (see JOURNAL F143)."""
import os
import sys
import time
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import Browser  # noqa: E402
import osctl  # noqa: E402

SCENE = (
    "<!doctype html><title>settle</title><style>html,body{margin:0}</style>"
    "<canvas id=c width=600 height=320 style='display:block'></canvas>"
    "<script>var c=document.getElementById('c'),x=c.getContext('2d');"
    "var S=60,A=[40,40],B=[480,220],FINAL=[250,130],cur=A,t0=Date.now(),f=0;"
    "function draw(p){cur=p;x.fillStyle='#fff';x.fillRect(0,0,600,320);"
    "x.fillStyle='#ff00ff';x.fillRect(p[0],p[1],S,S);}draw(cur);"
    "var iv=setInterval(function(){"
    "if(Date.now()-t0>1600){draw(FINAL);clearInterval(iv);window.__settled=1;return;}"
    "f^=1;draw(f?B:A);},180);"
    "c.addEventListener('click',function(e){"
    "var r=c.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;"
    "if(px>=cur[0]&&px<=cur[0]+S&&py>=cur[1]&&py<=cur[1]+S){document.title='HIT';}"
    "else{document.title='MISS';}});</script>")


def main() -> None:
    fixdir = tempfile.mkdtemp(prefix="settle_")
    path = os.path.join(fixdir, "settle.html")
    with open(path, "w") as f:
        f.write(SCENE)
    url = "file://" + path
    b = Browser()
    ok = True
    for trial in range(5):
        b.navigate(url)
        time.sleep(0.25)
        t0 = time.time()
        st = osctl.wait_stable((255, 0, 255), tol=40, timeout=6.0)
        el = time.time() - t0
        settled = bool(st and st.get("settled"))
        fin = bool(b.eval("window.__settled||0"))
        title = "?"
        hit = False
        if st:
            osctl.click(st["x"], st["y"])
            hit = b.wait_for("document.title==='HIT'", timeout=2)
            title = b.title()
        good = settled and fin and hit
        ok = ok and good
        print(f"trial{trial}: settled={settled} fin_anim={fin} hit={hit} "
              f"title={title} samples={st and st.get('samples')} "
              f"saccades={st and st.get('saccades')} t={el:.2f}s "
              f"-> {'OK' if good else 'FAIL'}")
    print("ALL OK" if ok else "SOME FAILED")


if __name__ == "__main__":
    main()
