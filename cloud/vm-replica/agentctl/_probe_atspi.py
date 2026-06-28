"""Live reproduction of F178 on Linux/X11: the semantic floor reaches INSIDE a
modern toolkit app via AT-SPI — the dual of Windows UIA. On a Qt app (KWrite)
the X server sees only a window title and opaque sub-windows; AT-SPI lets the
floor perceive the real controls and act on them BY MEANING — no pixels.

Pre: a KWrite window open on DISPLAY :0 with QT a11y on, and the a11y bus up
(DBUS_SESSION_BUS_ADDRESS exported). Run alone."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def find_window(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title", "") or "").lower():
            return w
    return None


def main():
    w = find_window("KWrite")
    if not w:
        print("[FAIL] no KWrite window found — open one first")
        return
    win = w["id"]
    print(f"window id={win} title={w.get('title')!r}")

    # 1. the frame's accessible name, read from the toolkit's own a11y
    nm = osctl.uia_name(win)
    print(f"[{'PASS' if nm else 'FAIL'}] uia_name reads the frame — {nm!r}")

    # 2. enumerate the REAL controls inside (invisible to child_windows)
    kids = osctl.uia_children(win)
    names = {k["name"] for k in kids if k["name"]}
    have = {"File", "Edit", "Save", "Open..."} & names
    print(f"[{'PASS' if len(have) >= 3 else 'FAIL'}] uia_children sees inside the "
          f"toolkit — {len(kids)} controls incl {sorted(have)}")

    # 3. find a control by meaning -> screen geometry (bridge to the pixel floor)
    save = osctl.uia_find(win, name="Save", ctype="button")
    okrect = bool(save and save.get("rect") and save["rect"][2] > 0)
    print(f"[{'PASS' if okrect else 'FAIL'}] uia_find('Save', button) -> rect — {save}")

    # 4. INVOKE a control by meaning — press 'New' (no pixels): a fresh
    #    'Untitled' KWrite window must appear, observed independently via the WM.
    before = {x["id"] for x in osctl.list_windows() if "KWrite" in (x.get("title") or "")}
    inv_ok = osctl.uia_invoke(win, name="New", ctype="button")
    time.sleep(1.0)
    after = {x["id"] for x in osctl.list_windows() if "KWrite" in (x.get("title") or "")}
    new_win = after - before
    print(f"[{'PASS' if inv_ok else 'FAIL'}] uia_invoke('New') fired — ok={inv_ok}")
    titles = [x.get("title") for x in osctl.list_windows() if x["id"] in new_win]
    print(f"[{'PASS' if new_win else 'FAIL'}] a NEW window appeared from the "
          f"semantic press — {titles}")
    for wid in new_win:                       # tidy up the spawned window
        try:
            osctl.close_window(wid)
        except Exception:
            pass


if __name__ == "__main__":
    main()
