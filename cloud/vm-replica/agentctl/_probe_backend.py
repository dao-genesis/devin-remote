"""F192 — drive a fully *minimized* (zero on-screen pixels) window purely by meaning.

A minimized window has no clickable rect (its BoundingRectangle collapses to an
off-screen sentinel). The pixel floor (click/type/drag, and any pattern verb that
falls through to a real click) cannot reach it. The pattern channel can: UIA's
Value/Toggle/Selection/RangeValue/ExpandCollapse/Invoke/Text patterns address a
control by its provider, not its screen geometry. This proves the floor operates a
*backgrounded* GUI — the frontier the screenshot-and-click loop cannot touch."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

def fw(s):
    for w in osctl.list_windows():
        if s.lower() in (w.get("title") or "").lower():
            return w

n = fw("DaoBackend"); assert n, "WPF fixture not found"
wid = n["id"]

ok = 0; total = 0
def check(name, cond, extra=""):
    global ok, total
    total += 1
    print(("  PASS " if cond else "  FAIL ") + name + ((" :: " + extra) if extra else ""))
    if cond: ok += 1

# Minimize WITHOUT activating — the window goes fully off-screen (no pixels).
print("set_window_state minimized ->", osctl.set_window_state(wid, "minimized"))
time.sleep(0.7)
st = osctl.window_state(wid)
geo = osctl.window_geometry(wid)
print("window_state:", st, " geometry:", geo)
offscreen = (not geo) or geo.get("x", 0) < -10000 or geo.get("y", 0) < -10000
check("window is minimized (no on-screen pixels)", st == "minimized" and offscreen, f"state={st} geo={geo}")

# Now drive every pixel-free pattern modality BY MEANING, window still minimized.
# 1) ValuePattern write + read-back
osctl.uia_set_value(wid, "DAO-WHILE-MINIMIZED", name="field", ctype="edit")
v = osctl.uia_get_value(wid, name="field", ctype="edit")
check("ValuePattern set/get while minimized", v == "DAO-WHILE-MINIMIZED", repr(v))

# 2) TogglePattern
before = osctl.uia_toggle_state(wid, name="agree", ctype="checkbox")
osctl.uia_toggle(wid, name="agree", ctype="checkbox"); time.sleep(0.2)
ts = osctl.uia_toggle_state(wid, name="agree", ctype="checkbox")
check("TogglePattern flip while minimized", ts in ("on", "off") and ts != before, f"{before}->{ts}")

# 3) SelectionPattern — a ListBox row (SelectionItemPattern is pure provider, no
# popup to render, so it reaches a minimized window). A *collapsed ComboBox* item
# is deliberately NOT used here: its item is realized only by the dropdown popup,
# which needs rendering and is out of reach with zero pixels (noted boundary).
osctl.uia_select(wid, name="row-5"); time.sleep(0.2)
sel = osctl.uia_is_selected(wid, name="row-5")
check("SelectionPattern (ListBox row) while minimized", bool(sel), str(sel))

# 4) RangeValuePattern
osctl.uia_set_range_value(wid, 73, name="level", ctype="slider"); time.sleep(0.2)
rv = osctl.uia_range_value(wid, name="level", ctype="slider")
check("RangeValuePattern set while minimized", rv and abs(rv.get("value", 0) - 73) < 0.5, str(rv))

# 5) ExpandCollapsePattern (tree node)
osctl.uia_expand(wid, name="Root", ctype="treeitem"); time.sleep(0.2)
es = osctl.uia_expand_state(wid, name="Root", ctype="treeitem")
check("ExpandCollapsePattern open while minimized", es == "expanded", es)

# 6) InvokePattern — ping sets field -> PONG (pure provider call, no pixels)
osctl.uia_invoke(wid, name="ping", ctype="button"); time.sleep(0.3)
v2 = osctl.uia_get_value(wid, name="field", ctype="edit")
check("InvokePattern fire while minimized", v2 == "PONG", repr(v2))

# 7) TextPattern read of the read-only doc, still minimized
doc = osctl.uia_text(wid, name="doc", ctype="edit")
check("TextPattern read while minimized", "line beta" in doc, repr(doc[:40]))

# the window NEVER left minimized — every action above used zero pixels
st2 = osctl.window_state(wid)
check("window remained minimized throughout", st2 == "minimized", st2)

print(f"\nF192 {ok}/{total}")
