"""Live probe: drive a momentum knob to a target band with the KEYBOARD only.

The honest question (keyboard twin of F144 reach): a control that moves only
while an arrow key is held, and *coasts* after release (momentum), cannot be hit
open-loop. From one snapshot you can compute the distance and hold the key for an
estimated time — but acceleration + post-release coasting are unknown, so you
overshoot. The eye/hand does it closed-loop: a ballistic hold while watching, then
small corrective impulses (saccade-and-correct). This probe A/Bs:

  open  : read once, hold ArrowRight/Left for a distance-estimated duration, stop.
  servo : hold toward the goal while *perceiving the knob by pixels* at a fast
          poll; release once the predicted stop (pos + v*coast) reaches the band;
          then nudge with short taps until inside.

Both use the SAME real OS keyboard (osctl over XTEST); the page only scores.
"""
import time
import osctl
from browser import Browser

SCENE = (
    "<!doctype html><title>steer</title>"
    "<style>html,body{margin:0;overflow:hidden;background:#fff}</style>"
    "<canvas id=c width=1200 height=300 style='display:block'></canvas>"
    "<script>"
    "var c=document.getElementById('c'),x=c.getContext('2d');"
    "var W=1200,KN=44,y=130,px=80,vx=0,dir=0,ACC=2600,FR=4.0,MAXV=1400;"
    "var TW=70,T=Math.round(520+Math.random()*560);"  # target band start
    "var last=performance.now();"
    "function draw(){x.fillStyle='#fff';x.fillRect(0,0,W,300);"
    "x.fillStyle='#00c000';x.fillRect(T,y-20,TW,KN+40);"     # green target band
    "x.fillStyle='#ff00ff';x.fillRect(px,y,KN,KN);}"        # magenta knob
    "function step(now){var dt=Math.min(0.05,(now-last)/1000);last=now;"
    "vx+=dir*ACC*dt;"                                         # accelerate while held
    "if(dir===0){var d=Math.exp(-FR*dt);vx*=d;if(Math.abs(vx)<2)vx=0;}"  # coast/decay
    "if(vx>MAXV)vx=MAXV;if(vx<-MAXV)vx=-MAXV;"
    "px+=vx*dt;if(px<0){px=0;vx=0;}if(px>W-KN){px=W-KN;vx=0;}"
    "draw();requestAnimationFrame(step);}"
    "addEventListener('keydown',function(e){"
    "if(e.key==='ArrowRight'){dir=1;e.preventDefault();}"
    "else if(e.key==='ArrowLeft'){dir=-1;e.preventDefault();}});"
    "addEventListener('keyup',function(e){"
    "if(e.key==='ArrowRight'||e.key==='ArrowLeft'){dir=0;e.preventDefault();}});"
    "draw();requestAnimationFrame(step);"
    "window.__st=function(){return {px:px,vx:vx,t:T,tw:TW,kn:KN};};"
    "</script>"
)

MAG = (255, 0, 255)


def knob_x(b):
    """Score-only readout of the knob's left edge from the page (truth)."""
    s = b.eval("window.__st()")
    return s


def perceive_knob_x():
    """Perceive the knob's CENTRE x purely by pixels (our perception channel)."""
    w, h, rgb = osctl.capture_rgb()
    loc = osctl.find_color(MAG, tol=40, rgb=rgb, size=(w, h), step=4)
    if loc is None:
        return None
    # refine in the fovea for an accurate centre
    f = osctl.foveate(MAG, (loc["x"], loc["y"]), radius=80, tol=40) or loc
    return f["x"]


def settle(b, timeout=2.0):
    """Wait until the knob has coasted to a stop; return final state."""
    t = time.time()
    while time.time() - t < timeout:
        s = b.eval("window.__st()")
        if abs(s["vx"]) < 2:
            return s
        time.sleep(0.03)
    return b.eval("window.__st()")


def goal_center_px(s):
    # the knob's LEFT x that centres it in the band
    return s["t"] + s["tw"] / 2 - s["kn"] / 2


def focus_page(b):
    # OS-click the canvas to give Chrome keyboard focus (mouse+keyboard fusion)
    osctl.click(400, 300)
    time.sleep(0.15)


def reset(b):
    b.navigate("about:blank")
    b.navigate(_scene_url)
    time.sleep(0.3)
    focus_page(b)


def run_open(b):
    """Open-loop: one reading, hold for an estimated duration, stop, let it coast."""
    s = b.eval("window.__st()")
    gc = goal_center_px(s)
    here = s["px"]
    dist = gc - here
    key = osctl.VK_RIGHT if dist > 0 else osctl.VK_LEFT
    # estimate: with accel ACC from rest, time to cover dist ignoring coast.
    # t = sqrt(2*dist/ACC). This is the honest naive model.
    dur = (2 * abs(dist) / 2600.0) ** 0.5
    osctl.key_hold(key, duration=dur)
    fin = settle(b)
    return abs(fin["px"] - goal_center_px(fin)) <= fin["tw"] / 2, \
        fin["px"] - goal_center_px(fin)


def run_servo(b):
    """Closed-loop: ballistic hold while perceiving by pixels, predictive release,
    then small corrective taps until the knob centre is inside the band."""
    s = b.eval("window.__st()")
    gc_px = goal_center_px(s)                  # goal in page coords (left edge)
    # map: perceive gives a SCREEN centre x; we steer in screen space by sign only,
    # using the page readout for the stop test is cheating, so use pixels:
    # convert goal to screen by sampling once (knob page-left -> screen-centre).
    p0_screen = perceive_knob_x()
    s0 = b.eval("window.__st()")
    # screen_centre = a*page_left + b ; knob centre offset = kn/2. Solve a,b with
    # one point + known scale 1.0 (canvas not zoomed) -> a=1, b=screen-page_left.
    off = p0_screen - s0["px"]
    goal_screen = gc_px + off
    # ballistic phase: hold toward goal, watch by pixels, release predictively.
    cur = perceive_knob_x()
    key = osctl.VK_RIGHT if goal_screen > cur else osctl.VK_LEFT
    sign = 1 if key == osctl.VK_RIGHT else -1
    osctl.key_down(key)
    prev = cur
    tprev = time.time()
    try:
        while True:
            time.sleep(0.012)
            now_p = perceive_knob_x()
            if now_p is None:
                continue
            tn = time.time()
            v = (now_p - prev) / (tn - tprev) if tn > tprev else 0.0
            prev, tprev = now_p, tn
            remaining = (goal_screen - now_p) * sign
            # predicted coast distance after release ~ v^2/(2*decel); FR-decay ~ v/FR.
            coast = abs(v) / 4.0
            if remaining <= coast:
                break
            if remaining <= 0:
                break
    finally:
        osctl.key_up(key)
    settle(b)
    # corrective phase: short taps until inside the band (re-perceive each time).
    for _ in range(8):
        fin = b.eval("window.__st()")
        err = fin["px"] - goal_center_px(fin)
        if abs(err) <= fin["tw"] / 2:
            break
        osctl.key_hold(osctl.VK_LEFT if err > 0 else osctl.VK_RIGHT, duration=0.02)
        settle(b)
    fin = settle(b)
    return abs(fin["px"] - goal_center_px(fin)) <= fin["tw"] / 2, \
        fin["px"] - goal_center_px(fin)


GREEN = (0, 192, 0)


def run_prim(b):
    """Use the shipped osctl.steer primitive, perceiving BOTH knob and goal band
    purely by pixels (no DOM for control; page used only to score)."""
    w, h, rgb = osctl.capture_rgb()
    band = osctl.find_color(GREEN, tol=40, rgb=rgb, size=(w, h), step=4)
    if band is None:
        return False, 9999
    goal = band["x"]                       # screen x of the band centre
    half = (band["bbox"][2] - band["bbox"][0]) / 2
    r = osctl.steer(MAG, goal, axis="x", band=max(12, half * 0.6), coast=0.25)
    fin = settle(b)
    return abs(fin["px"] - goal_center_px(fin)) <= fin["tw"] / 2, \
        fin["px"] - goal_center_px(fin)


_scene_url = None


def main():
    global _scene_url
    b = Browser()
    import tempfile
    import os
    fd, path = tempfile.mkstemp(suffix=".html", prefix="steer_")
    os.write(fd, SCENE.encode())
    os.close(fd)
    _scene_url = "file://" + path

    for name, fn in (("open ", run_open), ("servo", run_servo), ("steer", run_prim)):
        hits = 0
        errs = []
        n = 12
        for _ in range(n):
            reset(b)
            ok, err = fn(b)
            hits += 1 if ok else 0
            errs.append(abs(err))
        print(f"  {name} : {hits:2d}/{n} in-band  mean|err|={sum(errs)/len(errs):6.1f}px")
    b.close()


if __name__ == "__main__":
    main()
