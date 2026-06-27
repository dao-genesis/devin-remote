"""Practice/probe (F144): can the agent click a CONTINUOUSLY moving target?

Slides a magenta square smoothly left<->right at a chosen speed (the ordinary case
of an element still easing into place) and measures HIT rate + pixel error for:

  stale  : full-screen find_color(step=1) then click   (the classic snapshot+click)
  reach0 : osctl.reach(lead=0)  — coarse acquire + foveal refine, click CURRENT pos
  reach  : osctl.reach(lead=L)  — + predict where it WILL be (predictive pursuit)

Also sweeps `lead` at one speed to calibrate the perceive->click latency.
Run: ``DISPLAY=:0 python3 _probe_reach.py``."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import Browser  # noqa: E402
import osctl  # noqa: E402

S = 70
MAG = (255, 0, 255)


def scene(speed: float) -> str:
    return (
        "data:text/html,"
        "<style>html,body{margin:0;background:%23fff;overflow:hidden}</style>"
        "<canvas id=c width=1400 height=700 style='display:block'></canvas>"
        "<script>"
        "var c=document.getElementById('c'),x=c.getContext('2d');"
        "var S=" + str(S) + ",y=300,lo=60,hi=1400-S-60,px=lo,dir=1,"
        "spd=" + str(speed) + ",last=performance.now(),cur=px;"
        "function draw(p){cur=p;x.fillStyle='%23fff';x.fillRect(0,0,1400,700);"
        "x.fillStyle='%23ff00ff';x.fillRect(p,y,S,S);}"
        "function tick(now){var dt=(now-last)/1000;last=now;px+=dir*spd*dt;"
        "if(px>hi){px=hi;dir=-1;}if(px<lo){px=lo;dir=1;}draw(px);"
        "requestAnimationFrame(tick);}draw(px);requestAnimationFrame(tick);"
        "window.__tot=0;window.__last='';window.__err=0;"
        "c.addEventListener('click',function(e){"
        "var r=c.getBoundingClientRect(),cx=e.clientX-r.left,cy=e.clientY-r.top;"
        "window.__tot++;var mid=cur+S/2;window.__err=Math.round(Math.abs(cx-mid));"
        "if(cx>=cur&&cx<=cur+S&&cy>=y&&cy<=y+S){window.__last='HIT';}"
        "else{window.__last='MISS';}});"
        "</script>")


def click_result(b: Browser) -> tuple[bool, float]:
    time.sleep(0.05)
    res = b.eval("(window.__last||'')+'|'+(window.__err||0)")
    tag, err = (res.split("|") + ["0"])[:2]
    return (tag == "HIT", float(err))


def stale_click(b: Browser) -> None:
    w, h, rgb = osctl.capture_rgb()
    loc = osctl.find_color(MAG, tol=40, rgb=rgb, size=(w, h))
    if loc:
        osctl.click(loc["x"], loc["y"])


def run(b: Browser, name: str, fn, n: int = 20) -> str:
    hits = 0
    errs = []
    for _ in range(n):
        fn()
        ok, err = click_result(b)
        hits += 1 if ok else 0
        errs.append(err)
        time.sleep(0.1)
    mean = sum(errs) / len(errs) if errs else float("nan")
    return f"  {name:8s}: {hits:2d}/{n} hit  mean|err|={mean:5.1f}px"


def main() -> None:
    b = Browser()
    for speed in (200, 450, 900, 1500):
        b.navigate(scene(speed))
        time.sleep(0.5)
        print(f"speed={speed}px/s  square={S}px")
        print(run(b, "stale", lambda: stale_click(b)))
        print(run(b, "reach0", lambda: osctl.reach(MAG, tol=40, lead=0.0)))
        print(run(b, "reach", lambda: osctl.reach(MAG, tol=40, lead=0.03)))

    # calibrate lead at a representative speed
    speed = 900
    b.navigate(scene(speed))
    time.sleep(0.5)
    print(f"lead sweep @ {speed}px/s:")
    for L in (0.0, 0.015, 0.03, 0.045, 0.06, 0.09):
        print(run(b, f"L={L:.3f}", lambda L=L: osctl.reach(MAG, tol=40, lead=L), n=15))


if __name__ == "__main__":
    main()
