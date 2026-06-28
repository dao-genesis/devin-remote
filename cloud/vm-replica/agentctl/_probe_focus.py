"""F204 — read the **keyboard focus** desktop-wide: where will my keystrokes land?

Every locate verb (`uia_find`) answers "where is control X in window W". But a
keypress is not aimed at a control by name — it goes to whatever holds **focus**,
and that target was invisible to the floor. So after clicking a field, Tabbing, or
opening a dialog, the floor could not *verify* where its next `type_unicode` would go;
it typed blind and hoped. `uia_focused()` reads the one element that currently owns
the keyboard, across every app at once — the keyboard's twin of the mouse cursor.

This proves:
  1. focusing the text field by meaning makes ``uia_focused()`` report *that* Edit;
  2. focus is tracked live — moving it to the button reports the Button instead;
  3. ``pid`` names the owning app (here = the fixture process), so the floor can tell
     "focus is in my target" from "a dialog/other app stole it";
  4. the payoff: what ``uia_focused`` points at is genuinely where typing lands —
     type into the focused field and its value becomes the typed text.

Run: ``C:\\devin\\python\\python.exe _probe_focus.py``
"""
import os
import sys
import time
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
import osctl

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = "DaoFocus_%d" % (os.getpid() % 100000)
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", os.path.join(HERE, "_fixture_wpf.ps1"),
                         "-Title", TITLE])
wid = None
try:
    for _ in range(40):
        time.sleep(0.4)
        c = [w for w in osctl.list_windows() if TITLE in (w.get("title") or "")]
        if c:
            wid = c[0]["id"]
            break
    osctl.activate_window(wid)
    time.sleep(0.5)

    osctl.uia_focus(wid, name="field")
    time.sleep(0.4)
    f1 = osctl.uia_focused()
    check("uia_focused() reports the focused text field by meaning",
          bool(f1) and f1.get("name") == "field" and f1.get("type") == "Edit", f"{f1}")

    osctl.uia_focus(wid, name="ping")
    time.sleep(0.4)
    f2 = osctl.uia_focused()
    check("focus is tracked live — moving it to the button reports the Button",
          bool(f2) and f2.get("name") == "ping" and f2.get("type") == "Button", f"{f2}")

    check("pid names the owning app (the fixture process)",
          bool(f1) and bool(f2) and f1.get("pid") == f2.get("pid") == proc.pid,
          f"focused_pid={f1 and f1.get('pid')} proc={proc.pid}")

    check("focused element carries a screen rect (clickable target)",
          bool(f1) and f1.get("rect") and len(f1["rect"]) == 4, f"rect={f1 and f1.get('rect')}")

    # the payoff: what uia_focused points at is truly where typing lands
    osctl.uia_focus(wid, name="field")
    time.sleep(0.3)
    ft = osctl.uia_focused()
    osctl.type_unicode("dao-here")
    time.sleep(0.4)
    val = osctl.uia_get_value(wid, name="field")
    check("typing lands in whatever uia_focused points at",
          ft and ft.get("name") == "field" and val == "dao-here",
          f"focused={ft and ft.get('name')} field_value={val!r}")
finally:
    try:
        if wid:
            osctl.close_window(wid)
    except Exception:
        pass
    try:
        proc.terminate()
    except Exception:
        pass
    time.sleep(0.4)

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
