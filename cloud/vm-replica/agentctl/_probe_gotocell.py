"""Live proof for F197 — goto_cell: navigate a spreadsheet to an arbitrary cell
by reference, purely by meaning, verified by the Name Box readback.

Run against a real LibreOffice Calc window (VCL). The Name Box is a ComboBox whose
uia_focus lies (F190 family), so the verb clicks the meaning-found box and verifies
the jump via the same box's Name. This probe asserts:
  1. goto_cell reaches a near cell (B2) and the active cell really is B2.
  2. goto_cell reaches a far cell (AA30) — many columns/rows away, no per-cell element.
  3. goto_cell recovers from a half-typed in-cell edit (robustness / retry path).
  4. goto_cell rejects an impossible target gracefully (returns False, no hang).
  5. after navigating to a cell and typing a marker, read_selection reads it back
     (the move landed on a real, editable cell — not a no-op).
"""
import sys
import time

sys.path.insert(0, ".")
import osctl

VK_ESC = 0x1B


def _calc():
    for w in osctl.list_windows():
        if "calc" in (w.get("title") or "").lower():
            return w
    return None


def _active(win):
    import re
    cells = [e for e in osctl.uia_find_all(win, ctype="combobox")
             if re.match(r"^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$", (e.get("name") or "").strip())]
    cells.sort(key=lambda e: (e.get("rect") or (1 << 30, 1 << 30))[1])
    return (cells[0].get("name") if cells else "") or ""


def main():
    w = _calc()
    if not w:
        print("FAIL: no LibreOffice Calc window open")
        return 1
    win = w["id"]
    passed = 0
    total = 5

    # 1) near cell
    ok = osctl.goto_cell(win, "B2")
    a = _active(win)
    print(f"[1] goto_cell B2 -> {ok}, active={a!r}", "PASS" if ok and a == "B2" else "FAIL")
    passed += ok and a == "B2"

    # 2) far cell
    ok = osctl.goto_cell(win, "AA30")
    a = _active(win)
    print(f"[2] goto_cell AA30 -> {ok}, active={a!r}", "PASS" if ok and a == "AA30" else "FAIL")
    passed += ok and a == "AA30"

    # 3) recover from a half-typed in-cell edit
    osctl.goto_cell(win, "A1")
    osctl.type_unicode("partial-edit")  # leave the sheet mid-edit, no Enter
    time.sleep(0.3)
    ok = osctl.goto_cell(win, "D4")
    a = _active(win)
    print(f"[3] goto_cell D4 from mid-edit -> {ok}, active={a!r}", "PASS" if ok and a == "D4" else "FAIL")
    passed += ok and a == "D4"
    osctl.tap(VK_ESC)

    # 4) impossible target -> graceful False, no hang
    t0 = time.time()
    ok = osctl.goto_cell(win, "not-a-ref")
    dt = time.time() - t0
    print(f"[4] goto_cell 'not-a-ref' -> {ok} in {dt:.1f}s", "PASS" if (ok is False and dt < 6) else "FAIL")
    passed += (ok is False and dt < 6)
    osctl.tap(VK_ESC)

    # 5) the landed cell is real & editable: type a marker, read it back via F195
    marker = "F197道"
    osctl.goto_cell(win, "C7")
    time.sleep(0.4)           # let focus settle back on the grid after the jump
    osctl.tap(0x2E)           # Delete — clear any stale value so this can't false-pass
    time.sleep(0.2)
    osctl.type_unicode(marker)
    time.sleep(0.3)
    osctl.tap(0x0D)            # Enter commits the cell
    time.sleep(0.5)
    osctl.goto_cell(win, "C7")  # back onto it; selection = C7
    time.sleep(0.4)
    got = ""
    if hasattr(osctl, "read_selection"):
        got = osctl.read_selection(win) or ""
    print(f"[5] C7 marker read back -> {got!r}", "PASS" if got.strip() == marker else "FAIL")
    passed += got.strip() == marker

    print(f"\nF197 goto_cell: {passed}/{total} PASS")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
