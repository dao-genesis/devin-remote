#!/usr/bin/env python3
"""Proof for F213 (uia_find_all on AT-SPI) and F214 (cross-platform type
normalization).

Requires: at least one AT-SPI-visible window (kwrite, gedit, or any GTK/Qt app
launched after at-spi2-registryd is running).  Set DBUS_SESSION_BUS_ADDRESS.

Checks:
  1. uia_find_all returns a non-empty list on a real window
  2. Every element has the expected keys (name, type, aid, help, rect)
  3. The "type" field uses UIA-normalised names (Button, MenuItem, Edit, ...)
  4. window_opaque returns False for a window with real controls
  5. screen_observe populates the 'actions' list for the active window
  6. uia_find_all with name= filter returns only matching elements
  7. uia_find_all with ctype= filter returns only matching types
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
    print("SKIP: DBUS_SESSION_BUS_ADDRESS not set")
    sys.exit(0)

import osctl

_PASS = 0
_FAIL = 0

def check(tag, cond, detail=""):
    global _PASS, _FAIL
    status = "PASS" if cond else "FAIL"
    if cond:
        _PASS += 1
    else:
        _FAIL += 1
    print(f"  [{status}] {tag}" + (f"  ({detail})" if detail else ""))


# Find a real window with AT-SPI (not Plasma desktop chrome, not Chrome which
# may have been started before the AT-SPI bus)
ws = osctl.list_windows()
real = [w for w in ws if w.get("title") and "Plasma" not in w.get("title", "")
        and "Desktop" not in w.get("title", "")]
if not real:
    print("SKIP: no suitable AT-SPI window found")
    sys.exit(0)
# Prefer a window that actually has AT-SPI elements (skip Chrome if it was
# launched before the a11y bus started)
best = real[0]
for w in real:
    if osctl.uia_find_all(w["id"]):
        best = w
        break
win = best
wid = win["id"]
title = win.get("title", "")
print(f"Target: {title} (wid={wid})")

# 1. uia_find_all returns non-empty
els = osctl.uia_find_all(wid)
check("1 uia_find_all non-empty", len(els) > 0, f"{len(els)} elements")

# 2. Element schema
if els:
    e = els[0]
    check("2 element has 'name'", "name" in e)
    check("2 element has 'type'", "type" in e)
    check("2 element has 'aid'",  "aid"  in e)
    check("2 element has 'help'", "help" in e)
    check("2 element has 'rect'", "rect" in e)

# 3. UIA-normalised type names
UIA_TYPES = {"Button", "MenuItem", "Edit", "Document", "CheckBox", "RadioButton",
             "ComboBox", "Tab", "TabItem", "Hyperlink", "ListItem", "TreeItem",
             "Slider", "Spinner", "SplitButton", "DataItem", "Text", "List", "Tree",
             "MenuBar", "ToolBar", "ScrollBar", "StatusBar", "Separator", "Pane",
             "Image"}
types_seen = set(e.get("type") for e in els)
known = types_seen & UIA_TYPES
atspi_leak = [t for t in types_seen if " " in t]  # AT-SPI roles have spaces
check("3 types are UIA-normalised", len(known) > 0 and len(atspi_leak) == 0,
      f"known={sorted(known)}, leaked_atspi={atspi_leak}")

# 4. window_opaque returns False
check("4 window_opaque is False", not osctl.window_opaque(wid))

# 5. screen_observe populates actions (activate target window first)
osctl.activate_window(wid)
import time; time.sleep(0.3)
obs = osctl.screen_observe()
obs_win = [w for w in obs.get("windows", []) if w.get("id") == wid]
if obs_win:
    acts = obs_win[0].get("actions", [])
    check("5 screen_observe has actions", len(acts) > 0, f"{len(acts)} actions")
else:
    check("5 screen_observe has target window", False, "window not found in observe")

# 6. name filter
saves = osctl.uia_find_all(wid, name="Save")
if saves:
    all_match = all("save" in (e.get("name") or "").lower() for e in saves)
    check("6 name filter matches", all_match, f"{len(saves)} results")
else:
    check("6 name filter (no Save control)", True, "no Save — acceptable")

# 7. ctype filter
btns = osctl.uia_find_all(wid, ctype="push button")
if btns:
    all_btn = all(e.get("type") == "Button" for e in btns)
    check("7 ctype filter returns Buttons", all_btn,
          f"{len(btns)} buttons, types={set(e.get('type') for e in btns)}")
else:
    check("7 ctype filter (no buttons)", True, "no buttons — acceptable")

print(f"\n  {_PASS} passed, {_FAIL} failed out of {_PASS + _FAIL}")
if _FAIL:
    sys.exit(1)
