"""F195 -- read drawn content by meaning through the universal copy channel.

Friction (real, this VM): LibreOffice Calc renders its cell grid as a single
*painted* custom control. There is no per-cell UIA element, so ``uia_text`` /
``uia_get_value`` over the sheet return nothing -- you can write a cell by meaning
(focus the grid by meaning, type), but you cannot *read* it back by meaning. The
content is still copyable, though: select the cell and Ctrl+C lands it on the
clipboard. ``osctl.read_selection`` is that channel -- it copies the current
selection, returns the text, and restores the prior clipboard.

Proof oracle (against real Calc, no pixels read):
  1. uia_text over the drawn grid is empty (the gap that motivates the verb).
  2. A cell written by meaning (CJK) reads back EXACTLY via read_selection.
  3. A second cell (a number) reads back EXACTLY.
  4. read_selection(restore=True) leaves the prior clipboard untouched.
  5. A multi-cell range read returns both cells' text.
Target: 5/5.
"""
import sys
import time

sys.path.insert(0, ".")
import osctl

VK_CTRL, VK_HOME, VK_ENTER, VK_DOWN, VK_SHIFT = 0x11, 0x24, 0x0D, 0x28, 0x10
CJK = "道法自然"
NUM = "31415"


def _calc():
    for w in osctl.list_windows():
        t = (w.get("title") or "")
        if "LibreOffice Calc" in t and "Untitled" in t:
            return w
    for w in osctl.list_windows():
        if "LibreOffice Calc" in (w.get("title") or ""):
            return w
    return None


def _dismiss_tip():
    for w in osctl.list_windows():
        if "Tip of the Day" in (w.get("title") or ""):
            osctl.uia_invoke(w["id"], name="OK", ctype="button", timeout=6.0)
            time.sleep(0.8)
            return


def _to_a1(wid):
    osctl.key_down(VK_CTRL); osctl.key_down(VK_HOME)
    osctl.key_up(VK_HOME); osctl.key_up(VK_CTRL)
    time.sleep(0.2)


def main():
    _dismiss_tip()
    w = _calc()
    if not w:
        print("no Calc window"); print("F195 0/5"); return
    wid = w["id"]
    checks = []

    # focus the grid by meaning
    g = osctl.uia_find(wid, ctype="table")
    if g and g.get("rect"):
        x, y, gw, gh = g["rect"]
        osctl.click(x + gw // 2, y + gh // 2)
        time.sleep(0.3)

    # write A1 (CJK) and A2 (number) by meaning + keyboard
    _to_a1(wid)
    osctl.type_unicode(CJK); time.sleep(0.15)
    osctl.key_down(VK_ENTER); osctl.key_up(VK_ENTER); time.sleep(0.2)   # -> A2
    osctl.type_unicode(NUM); time.sleep(0.15)
    osctl.key_down(VK_ENTER); osctl.key_up(VK_ENTER); time.sleep(0.2)

    # 1. the drawn grid is opaque to a meaning-read
    txt = (osctl.uia_text(wid, ctype="table") or "")
    ok1 = CJK not in txt and NUM not in txt
    checks.append(("uia_text over drawn grid is empty of cell content (the gap)",
                   ok1, "uia_text=%r" % txt[:30]))

    # 2. CJK cell reads back exactly via the copy channel
    _to_a1(wid)
    v1 = (osctl.read_selection() or "").strip()
    checks.append(("CJK cell read back exactly via read_selection",
                   v1 == CJK, "got %r" % v1))

    # 3. number cell reads back exactly
    _to_a1(wid)
    osctl.key_down(VK_DOWN); osctl.key_up(VK_DOWN); time.sleep(0.15)   # -> A2
    v2 = (osctl.read_selection() or "").strip()
    checks.append(("number cell read back exactly via read_selection",
                   v2 == NUM, "got %r" % v2))

    # 4. prior clipboard is restored
    osctl.set_clipboard("SENTINEL-PRIOR-VALUE")
    time.sleep(0.05)
    _to_a1(wid)
    v3 = (osctl.read_selection(restore=True) or "").strip()
    time.sleep(0.05)
    after = osctl.get_clipboard()
    checks.append(("read_selection restores the prior clipboard",
                   v3 == CJK and after == "SENTINEL-PRIOR-VALUE",
                   "read=%r after=%r" % (v3, after)))

    # 5. a multi-cell range read carries both cells
    _to_a1(wid)
    osctl.key_down(VK_SHIFT); osctl.key_down(VK_DOWN)
    osctl.key_up(VK_DOWN); osctl.key_up(VK_SHIFT); time.sleep(0.2)     # A1:A2
    rng = (osctl.read_selection() or "")
    checks.append(("range read carries both cells",
                   CJK in rng and NUM in rng, "got %r" % rng[:40]))

    npass = sum(1 for _, ok, _ in checks if ok)
    for name, ok, detail in checks:
        print("  %s %s :: %s" % ("PASS" if ok else "FAIL", name, detail))
    print("\nF195 %d/%d" % (npass, len(checks)))


if __name__ == "__main__":
    main()
