"""Standalone live reproduction of F175: uia_range_value reads a slider's value/min/max
and uia_set_range_value sets it to a number by meaning via the UIA RangeValuePattern —
no mouse drag. Verified against a Chrome <input type=range>, CDP confirming the DOM
.value tracks the set."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
from browser import Browser


def main():
    b = Browser(port=29229)
    b.navigate("data:text/html,<input type=range id=s min=0 max=100 value=20 aria-label=Volume>")
    time.sleep(1.2)
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    if not ch:
        print("[FAIL] no chrome"); return
    rv = None
    for _ in range(10):
        rv = osctl.uia_range_value(ch["id"], "Volume", "Slider")
        if rv is not None:
            break
        time.sleep(0.5)
    print(f"uia_range_value -> {rv}")
    print(f"[{'PASS' if rv and rv['value'] == 20 and rv['min'] == 0 and rv['max'] == 100 else 'FAIL'}] "
          f"reads value=20, min=0, max=100")
    ok = osctl.uia_set_range_value(ch["id"], 75, "Volume", "Slider")
    time.sleep(0.3)
    dom = b.eval("document.getElementById('s').value")
    print(f"uia_set_range_value(75) -> {ok}; CDP value={dom}")
    print(f"[{'PASS' if ok is True and str(dom) == '75' else 'FAIL'}] sets the slider to 75 by meaning (DOM confirms)")
    rv2 = osctl.uia_range_value(ch["id"], "Volume", "Slider")
    print(f"[{'PASS' if rv2 and rv2['value'] == 75 else 'FAIL'}] read-back agrees -> {rv2}")
    b.navigate("about:blank")


if __name__ == "__main__":
    main()
