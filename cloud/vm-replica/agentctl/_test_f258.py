"""F258 — label_regions: connected-components on a label grid (labels -> objects).

Every floor reader turns pixels into a per-cell label grid (sample_grid -> colour,
ocr_grid -> text, classify_grid -> sprite). But a game object is rarely one cell: a
swell-foop move is a connected group of same-colour tiles, a klotski piece spans
cells, a mines flood pocket is a blob. label_regions is the missing layer that
groups adjacent equal-label cells into objects, so each game stops hand-rolling the
same flood fill. Pure-Python, no display.
"""
import osctl


def _bylabel(regions):
    out = {}
    for reg in regions:
        out.setdefault(reg["label"], []).append(reg)
    return out


def main():
    # A swell-foop-like colour grid (B blue, G green, Y yellow).
    grid = [
        ["B", "B", "B", "G", "B", "Y"],
        ["G", "G", "G", "B", "Y", "Y"],
        ["B", "G", "Y", "B", "B", "B"],
        ["B", "G", "B", "B", "G", "G"],
        ["Y", "B", "B", "B", "Y", "B"],
    ]

    regs = osctl.label_regions(grid, connectivity=4)

    # 1) every cell lands in exactly one region; sizes sum to the cell count.
    assert sum(r["size"] for r in regs) == 5 * 6
    seen = set()
    for r in regs:
        for cell in r["cells"]:
            assert cell not in seen, ("cell in two regions", cell)
            seen.add(cell)
    assert len(seen) == 30

    # 2) the top-left B's form one 4-connected region of exactly {(0,0),(0,1),
    #    (0,2)} -- it does NOT leak into (2,0) below because (1,0) is G.
    top_b = next(r for r in regs if (0, 0) in r["cells"])
    assert top_b["label"] == "B"
    assert set(top_b["cells"]) == {(0, 0), (0, 1), (0, 2)}, top_b["cells"]
    assert top_b["bbox"] == (0, 0, 0, 2)

    # 3) the big G in column 1 (rows 1..3) joins the row-1 G run -> a connected
    #    L/T of {(1,0),(1,1),(1,2),(2,1),(3,1)}; size 5, bbox spans rows 1-3.
    gcol = next(r for r in regs if (3, 1) in r["cells"])
    assert gcol["label"] == "G"
    assert set(gcol["cells"]) == {(1, 0), (1, 1), (1, 2), (2, 1), (3, 1)}
    assert gcol["size"] == 5
    assert gcol["bbox"] == (1, 0, 3, 2)

    # 4) cells[0] is row-major minimal and always an in-region cell -> a safe
    #    click target even for a non-convex shape, where a bbox centre can fall in
    #    the hole. A ring of A's around a '.' hole: cells[0] is on the ring, but
    #    the bbox centre (1,1) is the hole (not in the region).
    ring = [["A", "A", "A"], ["A", ".", "A"], ["A", "A", "A"]]
    ra = osctl.label_regions(ring, background=".")
    assert len(ra) == 1 and ra[0]["size"] == 8
    assert ra[0]["cells"][0] == (0, 0)
    assert (1, 1) not in ra[0]["cells"], "bbox centre is the hole, cells[0] is safe"
    assert gcol["cells"][0] == (1, 0)

    # 5) deterministic + first-appearance order: regions appear in row-major scan
    #    order of their first cell, and a re-run is identical.
    firsts = [r["cells"][0] for r in regs]
    assert firsts == sorted(firsts), ("regions not in first-appearance order", firsts)
    assert osctl.label_regions(grid, connectivity=4) == regs

    # 6) connectivity matters: a diagonal-only contact splits under 4 but joins
    #    under 8.
    diag = [["X", "."], [".", "X"]]
    r4 = [r for r in osctl.label_regions(diag, background=".", connectivity=4)]
    r8 = [r for r in osctl.label_regions(diag, background=".", connectivity=8)]
    assert len(r4) == 2 and all(r["size"] == 1 for r in r4), "4-conn splits diagonal"
    assert len(r8) == 1 and r8[0]["size"] == 2, "8-conn joins diagonal"

    # 7) background labels are never grouped (and never appear as regions).
    board = [
        ["R", "R", "_"],
        ["_", "R", "B"],
        ["B", "B", "_"],
    ]
    rr = osctl.label_regions(board, background="_")
    assert all(r["label"] != "_" for r in rr), "background must not form regions"
    assert sum(r["size"] for r in rr) == 6, "the three '_' cells are excluded"
    bylab = _bylabel(rr)
    # the R's: (0,0),(0,1),(1,1) connect; B's: (1,2) alone and (2,0),(2,1) -> 2 B regions
    assert len(bylab["R"]) == 1 and bylab["R"][0]["size"] == 3
    assert len(bylab["B"]) == 2
    assert sorted(r["size"] for r in bylab["B"]) == [1, 2]

    # 8) background may be a set/list of labels.
    multi = osctl.label_regions(board, background={"_", "B"})
    assert {r["label"] for r in multi} == {"R"}

    # 9) it composes with a reader's output: snap sample_grid colours to palette
    #    labels, then label_regions gives the clickable swell-foop groups. Here we
    #    simulate the reader output directly and assert the largest clickable group.
    biggest = max(regs, key=lambda r: r["size"])
    assert biggest["size"] >= 5, biggest

    # 10) argument validation.
    for bad in (
        dict(grid=[]),
        dict(grid=[[1, 2], [3]]),          # ragged
        dict(grid=[[]]),                    # empty row
        dict(grid=grid, connectivity=6),
    ):
        try:
            osctl.label_regions(**bad)
            raise AssertionError(f"expected ValueError for {bad}")
        except ValueError:
            pass

    print("F258 OK: label_regions floods a label grid into connected same-label "
          "objects ({label,cells,size,bbox}) -- every cell in exactly one region, "
          "4- vs 8-connectivity splits/joins diagonals, background labels excluded "
          "(single or set), cells[0] a safe in-region click target, deterministic "
          "first-appearance order, composes with any reader, args validated")


if __name__ == "__main__":
    main()
