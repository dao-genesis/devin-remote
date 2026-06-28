"""F188 proof — a popup menu is a *shape*, not a class; and an honest GTK boundary.

F186 taught the floor to see a titleless context-menu window, but only by the native
``#32768`` class. Driving into the **office** domain, LibreOffice/VCL opens its context
menu in a window of class ``SALTMPSUBFRAME`` — titleless (so ``list_windows`` misses it)
**and not ``#32768``** (so the F186 ``menu_windows`` missed it too). A class allow-list is
endless; what every popup menu shares is a *shape*: a titleless, **owned** ``WS_POPUP``
window. ``menu_windows`` now recognises that shape, so one eye sees the menu of any
toolkit. This proves it on a **4th** GUI toolkit (after Qt/wx/Win32): VCL/LibreOffice —
both the menubar (``uia_menu``) and the context menu (``uia_context``), by meaning.

It also records an **honest boundary**: Inkscape (GTK) exposes *no* UIA tree at all — the
semantic floor truthfully reaches nothing where nothing is modelled (a11y, not pixels).

    C:\\devin\\python\\python.exe _probe_vcl.py
"""
import subprocess
import sys
import time

sys.path.insert(0, ".")
import osctl  # noqa: E402

CALC = r"C:\Program Files\LibreOffice\program\scalc.exe"
INKSCAPE = r"C:\Program Files\Inkscape\bin\inkscape.exe"
PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    ok = bool(cond)
    PASS += ok
    FAIL += not ok
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, ("  " + extra) if extra else ""))


def win(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title") or "").lower():
            return w
    return None


def ctx_items():
    items = []
    for m in osctl.menu_windows():
        items += [i["name"] for i in osctl.uia_find_all(m["id"], ctype="menuitem") if i["name"]]
    return items


# --- LibreOffice Calc (VCL) -------------------------------------------------- #
c = win("LibreOffice Calc")
if not c:
    subprocess.Popen([CALC])
    for _ in range(25):
        time.sleep(0.8)
        c = win("LibreOffice Calc")
        if c:
            break
    time.sleep(2)
    wel = win("Welcome to LibreOffice")
    if wel:
        osctl.activate_window(wel["id"]); time.sleep(0.3); osctl.tap(0x1B)
osctl.activate_window(c["id"])
time.sleep(0.8)

print("== VCL menu is a titleless popup of a NON-#32768 class (SALTMPSUBFRAME) ==")
tab = osctl.uia_find(c["id"], name="Sheet1", ctype="tabitem")
check("sheet tab 'Sheet1' addressable by meaning", tab and tab.get("rect"))
x, y, w, h = tab["rect"]
osctl.click(x + w // 2, y + h // 2, right=True)
time.sleep(1.0)
mw = osctl.menu_windows()
classes = [m["class"] for m in mw]
check("menu_windows sees the open VCL popup (no title, not #32768)",
      mw and any(cl != "#32768" for cl in classes), str(classes))
items = ctx_items()
osctl.tap(0x1B); time.sleep(0.3)
check("its items read by meaning (Insert/Rename/Duplicate Sheet)",
      all(any(k in i for i in items) for k in ("Insert Sheet", "Rename Sheet", "Duplicate Sheet")),
      str(items[:5]))
check("menu_windows is empty once the menu closes (no shell furniture)",
      osctl.menu_windows() == [])

print("== uia_context drives the VCL context menu by meaning (oracle: a dialog) ==")
before = {wd["id"] for wd in osctl.list_windows()}
ok = osctl.uia_context(c["id"], "Sheet1", "Insert Sheet...", ctype="tabitem")
time.sleep(1.5)
ins = win("Insert Sheet")
check("uia_context('Sheet1','Insert Sheet...') returned True", ok)
check("the Insert Sheet dialog actually opened (new window)",
      ins is not None and ins["id"] not in before)
if ins:
    osctl.activate_window(ins["id"]); time.sleep(0.2); osctl.tap(0x1B); time.sleep(0.4)
check("a bogus context path returns False cleanly",
      osctl.uia_context(c["id"], "Sheet1", "No Such Item ZZZ", ctype="tabitem") is False)
osctl.tap(0x1B)

print("== uia_menu drives the VCL menubar by meaning (4th toolkit) ==")
osctl.activate_window(c["id"]); time.sleep(0.4)
before = {wd["id"] for wd in osctl.list_windows()}
ok = osctl.uia_menu(c["id"], "Help", "About LibreOffice")
time.sleep(1.5)
ab = win("About LibreOffice")
check("uia_menu('Help','About LibreOffice') opened the About dialog",
      ok and ab is not None and ab["id"] not in before)
if ab:
    osctl.activate_window(ab["id"]); time.sleep(0.2); osctl.tap(0x1B)

# --- honest boundary: Inkscape (GTK) ----------------------------------------- #
print("== honest boundary :: Inkscape (GTK) models no UIA tree ==")
ink = win("Inkscape")
if not ink:
    subprocess.Popen([INKSCAPE])
    for _ in range(20):
        time.sleep(0.8)
        ink = win("Inkscape")
        if ink:
            break
    time.sleep(2)
if ink:
    osctl.activate_window(ink["id"]); time.sleep(0.6)
    name = osctl.uia_name(ink["id"])
    # No actionable controls of any kind are modelled — a rich GTK UI, zero a11y.
    actionable = sum(len(osctl.uia_find_all(ink["id"], ctype=ct))
                     for ct in ("button", "menubar", "menuitem", "menu", "tabitem",
                                "checkbox", "combobox", "edit", "slider", "document"))
    check("the window is found, but no actionable control is modelled (GTK has no a11y)",
          name and actionable == 0, "name=%r actionable=%d" % (name, actionable))
else:
    check("Inkscape present", False, "could not launch")

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
