"""F178 visual demo — the agent operates its own GUI BY MEANING via AT-SPI.

No screenshot+OCR, no guessing pixels: the floor asks the toolkit *what* each
control is, then (1) flies the real cursor to a control located purely by its
accessible NAME, (2) presses a control by meaning and a new window is born, and
(3) types a sentence into a GTK field by meaning. Run on DISPLAY :0 with the
a11y bus up (DBUS_SESSION_BUS_ADDRESS exported)."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def win_by(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title", "") or "").lower():
            return w
    return None


def glide(x, y, steps=28, dwell=0.018):
    """Move the real cursor smoothly so the journey to a semantically-located
    control is visible on screen."""
    cx, cy = osctl.cursor_pos()
    for i in range(1, steps + 1):
        osctl.move(int(cx + (x - cx) * i / steps), int(cy + (y - cy) * i / steps))
        time.sleep(dwell)


def center(rect):
    x, y, w, h = rect
    return x + w // 2, y + h // 2


def main():
    kw = win_by("KWrite")
    if not kw:
        print("open KWrite first")
        return
    win = kw["id"]
    osctl.activate_window(win)
    time.sleep(1.0)

    print(f"uia_name -> {osctl.uia_name(win)!r}")
    print(f"uia_children -> {len(osctl.uia_children(win))} real controls inside")

    # 1. locate controls BY NAME and fly the cursor to each — meaning->geometry
    for label in ("New", "Open...", "Save", "Undo", "Redo"):
        el = osctl.uia_find(win, name=label, ctype="button")
        if el and el.get("rect"):
            print(f"  found {label!r} at {el['rect']} (by name, not by pixels)")
            glide(*center(el["rect"]))
            time.sleep(0.8)

    # 2. press 'New' BY MEANING — a fresh window appears, no click needed
    before = {w["id"] for w in osctl.list_windows() if "KWrite" in (w.get("title") or "")}
    osctl.uia_invoke(win, name="New", ctype="button")
    time.sleep(1.6)
    new = [w for w in osctl.list_windows()
           if w["id"] not in before and "KWrite" in (w.get("title") or "")]
    print(f"  uia_invoke('New') -> new window: {[w.get('title') for w in new]}")
    time.sleep(1.2)
    for w in new:
        osctl.close_window(w["id"])
    time.sleep(0.8)

    # 3. a GTK dialog typed BY MEANING — text appears with no keystrokes
    env = dict(os.environ, DISPLAY=":0")
    p = subprocess.Popen(["zenity", "--entry", "--title", "DAO-SEMANTIC",
                          "--text", "the floor types here by meaning:"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         env=env, text=True)
    for _ in range(40):
        time.sleep(0.25)
        z = win_by("DAO-SEMANTIC")
        if z:
            break
    if z:
        osctl.activate_window(z["id"])
        time.sleep(1.0)
        osctl.uia_set_value(z["id"], "operated purely by meaning — 道法自然", ctype="text")
        time.sleep(1.6)
        print(f"  uia_get_value -> {osctl.uia_get_value(z['id'], ctype='text')!r}")
        time.sleep(0.8)
        osctl.uia_invoke(z["id"], name="OK", ctype="button")
        out = (p.communicate(timeout=5)[0] or "").strip()
        print(f"  zenity stdout (independent proof) -> {out!r}")
    print("done.")


if __name__ == "__main__":
    main()
