"""Standalone live reproduction of F174: uia_scroll_into_view brings an element below
the fold into the visible viewport by meaning via the UIA ScrollItemPattern — the
element-level "bring into reach". Verified against Chrome (CDP confirms scrollY moved
and the button's rect entered the viewport), and cross-floor (uia_find then returns a
rect inside the window for the pixel executor)."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
from browser import Browser


def main():
    b = Browser(port=29229)
    b.navigate("data:text/html,<button id=top>TOP</button>"
               "<div style='height:3000px'></div><button id=bot>BOTTOMBTN</button>")
    time.sleep(1.2)
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    if not ch:
        print("[FAIL] no chrome"); return
    # warm the a11y tree
    for _ in range(10):
        if osctl.uia_find(ch["id"], name="BOTTOMBTN", ctype="Button"):
            break
        time.sleep(0.5)
    top_before = b.eval("document.getElementById('bot').getBoundingClientRect().top")
    innerh = b.eval("window.innerHeight")
    print(f"before: scrollY={b.eval('window.scrollY')} bot.top={top_before} innerH={innerh}")
    print(f"[{'PASS' if top_before > innerh else 'FAIL'}] bottom button starts below the fold")
    ok = osctl.uia_scroll_into_view(ch["id"], "BOTTOMBTN", "Button")
    time.sleep(0.5)
    top_after = b.eval("document.getElementById('bot').getBoundingClientRect().top")
    print(f"uia_scroll_into_view -> {ok}; after: scrollY={b.eval('window.scrollY')} bot.top={top_after}")
    print(f"[{'PASS' if ok is True and 0 <= top_after <= innerh else 'FAIL'}] "
          f"element scrolled into the viewport")
    # cross-floor: uia_find now returns a rect inside the window for the pixel floor
    g = osctl.window_geometry(ch["id"])
    f = osctl.uia_find(ch["id"], name="BOTTOMBTN", ctype="Button")
    inside = bool(g and f and f.get("rect")
                  and g["y"] <= (f["rect"][1] + f["rect"][3]) // 2 <= g["y"] + g["h"])
    print(f"[{'PASS' if inside else 'FAIL'}] uia_find now yields an in-window rect -> {f.get('rect') if f else None}")
    b.navigate("about:blank")


if __name__ == "__main__":
    main()
