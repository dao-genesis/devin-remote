"""Parity probe: exercise the floor's own VM-operation surface live and time it,
to find where osctl can/can't replace the 'official' computer-tool stack.
Run:  DISPLAY=:0 python3 _probe_parity.py
"""
from __future__ import annotations
import time, traceback
import osctl

def t(fn):
    a = time.time()
    try:
        v = fn()
        return (time.time() - a, v, None)
    except Exception as e:
        return (time.time() - a, None, f"{type(e).__name__}: {e}")

def line(name, dt, v, err):
    if err:
        print(f"  {name:26} FAIL {dt*1e3:7.1f}ms  {err}")
    else:
        s = repr(v)
        if len(s) > 60: s = s[:57] + "..."
        print(f"  {name:26} ok   {dt*1e3:7.1f}ms  {s}")

print("== perception ==")
dt, cap, err = t(lambda: osctl.capture_rgb()); line("capture_rgb (full)", dt, (cap[0], cap[1]) if cap else None, err)
if cap:
    w, h, rgb = cap
    line("capture_rgb size", 0, (w, h, len(rgb)), None)
    dt, v, err = t(lambda: osctl.sample_color((10, 10, 60, 60))); line("sample_color", dt, v, err)
    dt, v, err = t(lambda: osctl.region_diff(osctl.crop_rgb(rgb, w, h, (0,0,200,200))[0], osctl.crop_rgb(rgb, w, h, (0,0,200,200))[0], 8)); line("region_diff(self)", dt, v, err)
dt, v, err = t(lambda: osctl.screen_size()); line("screen_size", dt, v, err)
dt, v, err = t(lambda: osctl.cursor_pos()); line("cursor_pos", dt, v, err)

print("== structured observation (AT-SPI / windows) ==")
dt, v, err = t(lambda: osctl.list_windows()); line("list_windows", dt, (len(v) if v else 0), err)
dt, obs, err = t(lambda: osctl.screen_observe()); line("screen_observe", dt, (list(obs.keys()) if isinstance(obs, dict) else obs), err)

print("== ocr / text reading ==")
if cap:
    dt, v, err = t(lambda: osctl.ocr_text(rgb, w, h, (0, 0, min(w,700), 120))); line("ocr_text(top strip)", dt, v, err)

print("== clipboard round-trip ==")
dt, v, err = t(lambda: osctl.set_clipboard("dao-parity-\u9053\u6cd5\u81ea\u7136")); line("set_clipboard(unicode)", dt, v, err)
dt, v, err = t(lambda: osctl.get_clipboard()); line("get_clipboard", dt, v, err)

print("== actuation (safe, no side effects on game) ==")
dt, v, err = t(lambda: osctl.move_rel(0, 0)); line("move_rel(0,0)", dt, v, err)
print("done")
