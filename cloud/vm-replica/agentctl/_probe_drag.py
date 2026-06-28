"""F190b proof — reorder a real app's items by **dragging one onto another, by meaning**.

The floor had `drag(x0,y0,x1,y1)` (a pixel stroke) but no way to say "drag *this* control
onto *that* one". `uia_drag` is that verb — the gesture dual of `uia_click`: it finds both
ends in the accessibility tree by name/role and runs a genuine press-glide-release between
them. The one real subtlety practice forced: the grip is **not** the element centre — a
track's centre is its waveform, where a press means *select*, not *move*; the reorder handle
is at the item's leading edge, so `uia_drag` grips a point just inside the top-left.

Proof on Audacity (wxWidgets): add three mono tracks, then drag the **bottom** track onto
the **top** one purely by meaning. Oracle: read the track order back — the dragged track has
moved up to the top region, and no track is lost. The change in order is the proof the drag
landed; nothing about the return code is trusted.

    C:\\devin\\python\\python.exe _probe_drag.py
"""
import re
import subprocess
import sys
import time

sys.path.insert(0, ".")
import osctl  # noqa: E402

AUD = r"C:\Program Files\Audacity\Audacity.exe"
PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    ok = bool(cond)
    PASS += ok
    FAIL += not ok
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, ("  " + extra) if extra else ""))


def win(substr, exclude="Welcome"):
    for w in osctl.list_windows():
        t = w.get("title") or ""
        if substr.lower() in t.lower() and exclude not in t:
            return w
    return None


a = win("Audacity")
if not a:
    subprocess.Popen([AUD])
    for _ in range(25):
        time.sleep(0.8)
        a = win("Audacity")
        if a:
            break
    time.sleep(2)
wel = win("Audacity", exclude="zzz")
if wel and "Welcome" in (wel.get("title") or ""):
    osctl.activate_window(wel["id"]); time.sleep(0.3)
    osctl.uia_invoke(wel["id"], name="OK") or osctl.uia_invoke(wel["id"], name="Close")
    time.sleep(0.6)
    a = win("Audacity")
osctl.activate_window(a["id"])
time.sleep(0.6)


def tracks():
    """(full UIA name, 'Audio N' id, rect) for each track, top-to-bottom."""
    out = []
    for x in osctl.uia_find_all(a["id"], ctype="custom"):
        nm = x.get("name") or ""
        m = re.search(r"Audio \d+", nm)
        if m and x.get("rect"):
            out.append((nm, m.group(), x["rect"]))
    return sorted(out, key=lambda t: t[2][1])


print("== make at least three tracks so a reorder is unambiguous ==")
for _ in range(6):
    if len(tracks()) >= 3:
        break
    osctl.uia_menu(a["id"], "Tracks", "Add New", "Mono Track")
    time.sleep(0.9)
osctl.activate_window(a["id"]); time.sleep(0.4)

before = tracks()
before_ids = [i for _, i, _ in before]
check("there are >= 3 tracks to reorder", len(before) >= 3, str(before_ids))

src_name, src_id, _ = before[-1]   # the bottom track
dst_name, dst_id, _ = before[0]    # the top track
print("== drag the bottom track %r onto the top track %r, by meaning ==" % (src_id, dst_id))
ok = osctl.uia_drag(a["id"], name=src_name, ctype="custom", to_name=dst_name, to_ctype="custom")
time.sleep(0.9)
osctl.activate_window(a["id"]); time.sleep(0.3)

after = tracks()
after_ids = [i for _, i, _ in after]
check("uia_drag(bottom -> top) returned True", ok)
check("the dragged track was the bottom one before", before_ids[-1] == src_id, str(before_ids))
check("after the drag it has moved up into the top region", src_id in after_ids and after_ids.index(src_id) <= 1, str(after_ids))
check("it is no longer the bottom track (order really changed)", after_ids[-1] != src_id)
check("no track was lost or duplicated (multiset preserved)", sorted(after_ids) == sorted(before_ids))

print("== a bogus source returns False cleanly ==")
check("uia_drag(non-existent source) -> False",
      osctl.uia_drag(a["id"], name="No Such Track ZZZ", ctype="custom",
                     to_name=dst_name, to_ctype="custom") is False)

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
