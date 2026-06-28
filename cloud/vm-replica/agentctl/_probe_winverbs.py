"""The Windows semantic-floor proof: exercise every uia_* verb against a freshly
launched WPF fixture (full native UIA), each checked through its read-dual so a
wrong COM vtable index surfaces. Self-contained: launches its own uniquely-titled
fixture and closes it at the end. Run: ``python _probe_winverbs.py``."""
import os, sys, time, traceback, subprocess
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")

def find_win(sub):
    for w in osctl.list_windows():
        if sub.lower() in (w.get("title") or "").lower():
            return w["id"]
    return None

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = sys.argv[1] if len(sys.argv) > 1 else ("DaoWpf_%d" % (os.getpid() % 100000))
_own = len(sys.argv) <= 1
if _own:
    subprocess.Popen(["powershell", "-ExecutionPolicy", "Bypass", "-File",
                      os.path.join(HERE, "_fixture_wpf.ps1"), "-Title", TITLE])
wid = None
for _ in range(40):
    wid = find_win(TITLE)
    if wid: break
    time.sleep(0.5)
if not wid:
    print("FIXTURE WINDOW NOT FOUND"); sys.exit(2)
print("fixture window id:", wid)
osctl.activate_window(wid); time.sleep(0.4)

print("\n=== children ===")
for c in osctl.uia_children(wid):
    print("  ", c)

print("\n=== Edit: set_value / get_value ===")
osctl.uia_set_value(wid, "héllo 道 42", name="field", ctype="edit")
time.sleep(0.2)
v = osctl.uia_get_value(wid, name="field", ctype="edit")
check("edit.set/get value", v == "héllo 道 42", repr(v))

print("\n=== CheckBox: toggle / toggle_state ===")
s0 = osctl.uia_toggle_state(wid, ctype="checkbox")
osctl.uia_toggle(wid, ctype="checkbox"); time.sleep(0.3)
s1 = osctl.uia_toggle_state(wid, ctype="checkbox")
check("checkbox.toggle flips state", s0 != s1 and s1 in ("on","off"), f"{s0!r}->{s1!r}")

print("\n=== ComboBox: expand / expand_state / collapse ===")
e0 = osctl.uia_expand_state(wid, ctype="combobox")
osctl.uia_expand(wid, ctype="combobox"); time.sleep(0.4)
e1 = osctl.uia_expand_state(wid, ctype="combobox")
check("combobox.expand -> expanded", e1 == "expanded", f"{e0!r}->{e1!r}")
osctl.uia_collapse(wid, ctype="combobox"); time.sleep(0.3)
e2 = osctl.uia_expand_state(wid, ctype="combobox")
check("combobox.collapse -> collapsed", e2 == "collapsed", f"->{e2!r}")

print("\n=== ListBox: find_item (virtualized) / select / is_selected ===")
# row-38 is below the fold: in a virtualized list it has no UIA element until the
# container is asked to realize it (F183). uia_find can't see it; uia_find_item can.
check("virtualized row-38 invisible to uia_find",
      osctl.uia_find(wid, name="row-38", ctype="listitem") is None)
it = osctl.uia_find_item(wid, "row-38", container_ctype="list")
check("find_item realizes row-38 with rect",
      isinstance(it, dict) and it.get("name") == "row-38" and it.get("rect"), str(it))
time.sleep(0.3)
osctl.uia_select(wid, name="row-38", ctype="listitem"); time.sleep(0.3)
sel = osctl.uia_is_selected(wid, name="row-38", ctype="listitem")
check("realized row-38 select -> is_selected", sel is True, str(sel))
check("find_item on missing item -> None",
      osctl.uia_find_item(wid, "row-999", container_ctype="list") is None)
sc = osctl.uia_scroll_into_view(wid, name="row-3", ctype="listitem")
check("realized item scroll_into_view issued", sc is True, str(sc))

print("\n=== TrackBar: range_value / set_range_value ===")
rv0 = osctl.uia_range_value(wid, ctype="slider")
ok = osctl.uia_set_range_value(wid, 75, ctype="slider"); time.sleep(0.3)
rv1 = osctl.uia_range_value(wid, ctype="slider")
check("slider.range_value read", isinstance(rv0, dict) and rv0.get("max") == 100, str(rv0))
check("slider.set_range_value -> 75", ok and rv1 and abs(rv1.get("value",-1)-75) < 1.5, str(rv1))

print("\n=== TreeView node: expand / expand_state / collapse ===")
te0 = osctl.uia_expand_state(wid, name="Root", ctype="treeitem")
osctl.uia_expand(wid, name="Root", ctype="treeitem"); time.sleep(0.3)
te1 = osctl.uia_expand_state(wid, name="Root", ctype="treeitem")
check("treeitem.expand -> expanded", te1 == "expanded", f"{te0!r}->{te1!r}")
osctl.uia_collapse(wid, name="Root", ctype="treeitem"); time.sleep(0.3)
te2 = osctl.uia_expand_state(wid, name="Root", ctype="treeitem")
check("treeitem.collapse -> collapsed", te2 == "collapsed", f"->{te2!r}")

print("\n=== Button: invoke (writes PONG into 'field') ===")
osctl.uia_set_value(wid, "idle", name="field", ctype="edit"); time.sleep(0.2)
osctl.uia_invoke(wid, name="ping", ctype="button"); time.sleep(0.3)
res = osctl.uia_get_value(wid, name="field", ctype="edit")
check("button.invoke -> field PONG", "PONG" in (res or ""), repr(res))

print("\n=== Text region: uia_text ===")
doc = osctl.uia_text(wid, name="doc", ctype="edit")
check("uia_text reads multiline + unicode", "道法自然" in (doc or "") and "alpha" in (doc or ""), repr(doc)[:80])

if _own:
    try:
        osctl.close_window(wid)
    except Exception:
        pass

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
if FAIL:
    print("FAILED:", FAIL); sys.exit(1)
