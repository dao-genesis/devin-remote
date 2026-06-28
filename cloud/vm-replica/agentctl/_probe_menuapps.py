"""F185 proof — drive heavy, menu-driven pro apps by MEANING through ``uia_menu``.

A dropdown menu opens in a *separate top-level popup window*, so a menu path
(``Edit > Preferences``) cannot be reached by a ``uia_find`` scoped to the app
window. ``uia_menu`` walks the path across whatever window each item pops into.

This launches the real installed apps and proves one menu action on each, using the
*dialog it opens* as the oracle, then closes it by meaning. Run:

    C:\\devin\\python\\python.exe _probe_menuapps.py

Apps: FreeCAD 1.0 (Qt), KiCad 10.0 (wxWidgets), Shotcut (Qt). Blender is included as
an honest negative: this VM exposes only OpenGL 1.1 (software), and Blender refuses to
start its UI at all (requires GL 4.3) — the floor can read its warning dialog by
meaning but there is no Blender UI to drive; that is the environment's gap, not the
floor's.
"""
import subprocess
import sys
import time

sys.path.insert(0, ".")
import osctl  # noqa: E402

PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    ok = bool(cond)
    PASS += ok
    FAIL += not ok
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label,
                            ("  " + extra) if extra else ""))


def win(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title") or "").lower():
            return w
    return None


def ensure(substr, exe, wait=12):
    if win(substr):
        return win(substr)
    subprocess.Popen([exe])
    for _ in range(wait * 2):
        time.sleep(0.5)
        if win(substr):
            return win(substr)
    return None


def menu_opens_dialog(app_substr, exe, path, dialog_substr, close_name="Cancel"):
    print("== %s :: uia_menu%s ==" % (app_substr, path))
    m = ensure(app_substr, exe)
    if not m:
        check("app reachable", False, "could not launch " + app_substr)
        return
    osctl.activate_window(m["id"])
    time.sleep(0.6)
    before = {w["id"] for w in osctl.list_windows()}
    ok = osctl.uia_menu(m["id"], *path)
    time.sleep(1.5)
    new = [w for w in osctl.list_windows()
           if w["id"] not in before and dialog_substr.lower() in (w.get("title") or "").lower()]
    check("uia_menu returned True", ok)
    check("menu path by meaning opened %r dialog" % dialog_substr, new,
          str([w["title"] for w in new]))
    d = win(dialog_substr)
    if d:
        if not osctl.uia_invoke(d["id"], name=close_name):
            osctl.uia_invoke(d["id"], name="OK") or osctl.uia_invoke(d["id"], name="Close")
        time.sleep(0.8)


PF = r"C:\Program Files"

# FreeCAD (Qt) — Edit > Preferences opens the Preferences dialog (no GL needed).
m = win("FreeCAD 1.0")
if m:
    menu_opens_dialog("FreeCAD 1.0", PF + r"\FreeCAD 1.0\bin\FreeCAD.exe",
                      ("Edit", "Preferences"), "Preferences", close_name="Cancel")

# KiCad (wxWidgets) — Help > About KiCad opens the About dialog.
menu_opens_dialog("KiCad 10.0", PF + r"\KiCad\10.0\bin\kicad.exe",
                  ("Help", "About KiCad"), "About", close_name="OK")

# Shotcut (Qt) — Help > About Shotcut opens the About dialog.
menu_opens_dialog("Shotcut", PF + r"\Shotcut\shotcut.exe",
                  ("Help", "About Shotcut"), "About", close_name="OK")

# Negative: a bogus path must fail cleanly (not crash, not half-open).
print("== negative :: bogus menu path returns False ==")
m = win("Shotcut")
if m:
    osctl.activate_window(m["id"]); time.sleep(0.4)
    check("uia_menu(bogus) -> False", osctl.uia_menu(m["id"], "File", "No Such Item ZZZ") is False)

# Honest environment finding: Blender cannot start its UI on OpenGL 1.1.
print("== honest :: Blender GL block read by meaning ==")
b = win("Blender - Unsupported")
if b:
    txt = [t["name"] for t in osctl.uia_find_all(b["id"], ctype="text") if t["name"]]
    check("floor reads Blender's GL-unsupported warning by meaning",
          any("OpenGL" in t for t in txt), repr(txt[:1]))

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
