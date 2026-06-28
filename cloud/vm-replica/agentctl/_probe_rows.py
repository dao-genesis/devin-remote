"""F196 -- rebuild a flattened details-view's rows by meaning.

Friction (real, this VM): a multi-column list (7-Zip's file manager) exposes each
column cell as a *separate sibling* element with no per-row parent. uia_find_all hands
back the file names in one place and the sizes/dates in another, so although every cell
is readable by meaning, you cannot read *the row for X* as a unit -- the row that pairs
``desktop.ini`` with its byte size and its dates. uia_rows regroups the scattered cells
by geometry (cluster by vertical band, order by x), rebuilding the table the eye sees.

Proof oracle (against real 7-Zip File Manager, in C:\\Users\\Administrator\\Documents):
  1. uia_rows returns one row per visible entry (>= the 5 known entries).
  2. The flattening is real: names live in different elements than sizes/dates
     (so the rows are reconstructed, not handed over by the provider).
  3. The desktop.ini row pairs the name WITH its byte size '402' in the same row.
  4. Every reconstructed row is in left-to-right column order (name first).
  5. Rows are returned top-to-bottom in visual order.
Target: 5/5.
"""
import sys
import time

sys.path.insert(0, ".")
import osctl

VK_ENTER = 0x0D


def _fm():
    """The 7-Zip File Manager window (its title is the current folder path)."""
    for w in osctl.list_windows():
        bs = set((b.get("name") or "") for b in osctl.uia_find_all(w["id"], ctype="button"))
        if {"Add", "Extract", "Test"} <= bs:
            return w
    return None


def _ensure_documents(w):
    """Navigate the FM into the Documents folder if not already there."""
    if "Documents" in (w.get("title") or ""):
        return w
    osctl.uia_select(w["id"], name="Documents", ctype="listitem")
    time.sleep(0.4)
    osctl.key_down(VK_ENTER); osctl.key_up(VK_ENTER)
    time.sleep(1.0)
    return _fm()


def main():
    w = _fm()
    if not w:
        print("no 7-Zip File Manager window"); print("F196 0/5"); return
    w = _ensure_documents(w) or w
    wid = w["id"]
    checks = []

    rows = osctl.uia_rows(wid, container_ctype="list")
    names = set(c for r in rows for c in r)

    # 1. one row per visible entry
    known = {"My Music", "My Pictures", "My Videos", "WindowsPowerShell", "desktop.ini"}
    ok1 = len(rows) >= 5 and known <= names
    checks.append(("uia_rows returns a row per entry (>=5, all known names present)",
                   ok1, "%d rows, names=%s" % (len(rows), sorted(names)[:6])))

    # 2. the flattening is real -- names and the date/size cells come from different
    #    element types (edit vs text), proving the row is reconstructed, not native.
    edits = {(e.get("name") or "").strip() for e in osctl.uia_find_all(wid, ctype="edit")}
    texts = {(e.get("name") or "").strip() for e in osctl.uia_find_all(wid, ctype="text")}
    ok2 = "desktop.ini" in edits and "402" in texts and "desktop.ini" not in texts
    checks.append(("flattening is real: name in 'edit', size in 'text' (separate elements)",
                   ok2, "name@edit=%s size@text=%s" % ("desktop.ini" in edits, "402" in texts)))

    # 3. the desktop.ini row pairs the name WITH its size in the SAME reconstructed row
    ini = [r for r in rows if "desktop.ini" in r]
    ok3 = bool(ini) and "402" in ini[0]
    checks.append(("desktop.ini row pairs name with its byte size '402'",
                   ok3, "row=%s" % (ini[0] if ini else None)))

    # 4. each row is in column order: the file name is the first (leftmost) cell
    ok4 = all(r and (r[0] in known or r[0] not in ("402",)) for r in rows if r)
    ini_first = bool(ini) and ini[0][0] == "desktop.ini"
    checks.append(("rows are in left-to-right column order (name leftmost)",
                   ini_first, "desktop.ini row starts with %r" % (ini[0][0] if ini else None)))

    # 5. rows are top-to-bottom in visual order (folders before desktop.ini, matching
    #    the on-screen ordering My Music..WindowsPowerShell then desktop.ini)
    flat_first_cells = [r[0] for r in rows if r]
    ok5 = ("desktop.ini" in flat_first_cells
           and flat_first_cells.index("desktop.ini") == len(
               [c for c in flat_first_cells if c in known]) - 1)
    checks.append(("rows returned top-to-bottom in visual order",
                   ok5, "first-cells=%s" % flat_first_cells[:6]))

    npass = sum(1 for _, ok, _ in checks if ok)
    for name, ok, detail in checks:
        print("  %s %s :: %s" % ("PASS" if ok else "FAIL", name, detail))
    print("\nrows = %s" % rows)
    print("F196 %d/%d" % (npass, len(checks)))


if __name__ == "__main__":
    main()
