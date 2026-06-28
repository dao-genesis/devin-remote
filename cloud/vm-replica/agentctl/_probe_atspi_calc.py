"""F180 — surviving a live, mutating accessible tree (gnome-calculator).

Driving a real GTK app by meaning surfaced a hard friction: pressing the
calculator's buttons rebuilds its accessible tree, and the floor's depth-first
walk would then read / unref a node whose remote peer had already been torn down
— a use-after-free that segfaulted the whole process (GLib: "invalid unclassed
pointer in cast to 'AtspiObject'", "g_object_unref: old_ref > 0").

The fix is a STATE_DEFUNCT guard in the walk. This probe proves two things at
once: arithmetic driven purely by meaning is correct (independent oracle: the
calculator's own readout), and re-walking the tree after the mutation no longer
crashes — even under a tight stress loop that interleaves presses and walks.
"""
import sys
import time

sys.path.insert(0, ".")
import osctl


def _calc():
    for w in osctl.list_windows():
        if "calcul" in (w.get("title") or "").lower():
            return w["id"]
    return None


def press(win, n):
    assert osctl.uia_invoke(win, name=n, ctype="push button"), f"press {n!r} failed"
    time.sleep(0.18)


def readout(win):
    """The calculator's own answer, read back through the semantic floor."""
    vals = []
    for c in osctl.uia_children(win):
        if c["ctype"] in ("label", "text") and c["name"].strip():
            vals.append(c["name"].strip())
    return vals


def main():
    win = _calc()
    if not win:
        print("NO CALCULATOR WINDOW — launch gnome-calculator first")
        return 1

    passes = 0

    # PROOF 1: arithmetic by meaning, checked against the app's own readout.
    # 123 x 8 = 984 — a value unlikely to appear by accident in history.
    osctl.uia_invoke(win, name="Clear", ctype="push button")
    time.sleep(0.2)
    for n in ["1", "2", "3", "×", "8", "="]:
        press(win, n)
    time.sleep(0.4)
    vals = readout(win)
    assert "984" in vals, f"expected 984 in the calculator readout, got {vals}"
    print(f"[PASS] 123 × 8 driven by meaning; the calculator's own readout shows 984 — {vals}")
    passes += 1

    # PROOF 2: the mutation race no longer segfaults. Interleave presses (which
    # rebuild the tree) with full re-walks, many times. Before the fix this
    # crashed within a couple of iterations.
    for i in range(12):
        press(win, "7")
        press(win, "+")
        press(win, "9")
        press(win, "=")            # 16 — tears down / rebuilds subtrees
        n = len(osctl.uia_children(win))   # re-walk the freshly mutated tree
        assert n > 0, "re-walk returned nothing"
        osctl.uia_invoke(win, name="Clear", ctype="push button")
    print(f"[PASS] 12 interleaved press+rewalk cycles on the live tree — no segfault, "
          f"floor stable through every mutation")
    passes += 1

    print(f"\n{passes}/2 — the floor drives a real GTK app by meaning and survives the "
          f"living, changing tree underneath it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
