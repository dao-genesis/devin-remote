"""F186 proof — the OTHER menu: right-click CONTEXT menus, reached by meaning.

F185 reached *menubar* dropdowns. A right-click context menu is the same idea with a
sharper edge: on Windows it opens in a popup window of class ``#32768`` that carries
**no title**, so ``list_windows`` (titled top-levels only) never returns it and a
``uia_find`` has no window to search — the menu is on screen yet unaddressable.

``menu_windows()`` finds those titleless popups by window *class*; ``uia_context``
right-clicks a target by meaning then walks the menu through them. This proves both
against a real native app (7-Zip), using the file list as the oracle. Run:

    C:\\devin\\python\\python.exe _probe_ctxmenu.py
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
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, ("  " + extra) if extra else ""))


def win(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title") or "").lower():
            return w
    return None


z = win("7-Zip")
if not z:
    subprocess.Popen([r"C:\Program Files\7-Zip\7zFM.exe"])
    for _ in range(20):
        time.sleep(0.5)
        z = win("7-Zip")
        if z:
            break
osctl.activate_window(z["id"])
time.sleep(0.8)


def rows():
    return [i["name"] for i in osctl.uia_find_all(z["id"], ctype="listitem") if i["name"]]


def cc(r):
    x, y, w, h = r
    return x + w // 2, y + h // 2


print("== 7-Zip :: a native context menu is titleless (#32768) ==")
# Get to the root view so 'Computer' is present.
osctl.tap(0x1B)
time.sleep(0.3)
start = rows()
if "Computer" not in start:
    # navigate up to the root (Backspace = up one level in 7-Zip)
    for _ in range(4):
        osctl.tap(0x08)
        time.sleep(0.4)
        if "Computer" in rows():
            break
    start = rows()

# 1) the menu is invisible to list_windows but visible to menu_windows
row = osctl.uia_find(z["id"], name="Computer", ctype="listitem")
before_titled = {w["id"] for w in osctl.list_windows()}
osctl.click(*cc(row["rect"]), right=True)
time.sleep(1.0)
new_titled = [w for w in osctl.list_windows() if w["id"] not in before_titled]
mw = osctl.menu_windows()
check("right-click opens NO titled window (list_windows blind)", not new_titled)
check("menu_windows() sees the titleless #32768 popup", mw, str([m["class"] for m in mw]))

# 2) its items are readable by meaning
items = []
for m in mw:
    items += [i["name"] for i in osctl.uia_find_all(m["id"], ctype="menuitem") if i["name"]]
check("context-menu items read by meaning (Open/Rename/Properties)",
      any("Open" in i for i in items) and any("Rename" in i for i in items)
      and any("Properties" in i for i in items),
      str(items[:4]))
osctl.tap(0x1B)
time.sleep(0.3)

print("== 7-Zip :: uia_context drives the menu, file list is the oracle ==")
# 3) right-click 'Computer' -> 'Open' navigates into it; the list changes to drives.
ok = osctl.uia_context(z["id"], "Computer", "Open")
time.sleep(1.2)
after = rows()
check("uia_context(Computer, Open) returned True", ok)
check("file list changed by meaning (Computer -> drives)",
      after != start and any(r.endswith(":") for r in after), str(after))

# 4) reset (navigate back up) and confirm the oracle is reversible
osctl.tap(0x08)  # Backspace = up one level
time.sleep(1.0)
check("navigated back up to root (Computer present again)", "Computer" in rows())

print("== 7-Zip :: a bogus context item fails cleanly ==")
# 5) negative — a name not on the menu returns False, no hang, no half-open menu.
check("uia_context(Computer, 'No Such Item ZZZ') -> False",
      osctl.uia_context(z["id"], "Computer", "No Such Item ZZZ") is False)
osctl.tap(0x1B)

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
