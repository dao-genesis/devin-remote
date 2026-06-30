"""F259 — line_runs: maximal straight runs of equal label along the grid axes.

label_regions (F258) groups cells into connected *blobs*, but the games whose whole
rule is a straight line — connect-four (4 collinear), gomoku/five-or-more (5),
tic-tac-toe (3) — need runs, not blobs: eight-connectivity lumps a horizontal three,
the diagonal touching it and the stack above into one region and reports no line at
all. line_runs scans the four axes (h, v, d ↘, a ↙) of any reader's label grid and
returns every maximal run, so a win/threat test is one length comparison. The board
fixture below is the exact state the floor read live from gnome-four-in-a-row.
Pure-Python, no display.
"""
import osctl


def _key(run):
    return (run["direction"], run["start"], run["length"])


def main():
    # The live gnome-four-in-a-row board the floor read (R = me/red, G = computer
    # green, '.' = empty). Bottom row is "R R R G": a horizontal three -- one short
    # of a win -- that label_regions cannot see as a line.
    board = [
        ["G", ".", ".", ".", ".", ".", "."],
        ["R", ".", ".", ".", ".", ".", "."],
        ["G", ".", ".", ".", ".", ".", "."],
        ["G", "G", "G", ".", ".", ".", "."],
        ["G", "R", "R", "R", ".", ".", "."],
        ["R", "R", "R", "G", ".", ".", "."],
    ]

    runs = osctl.line_runs(board, background=".")

    # 1) the bottom-row horizontal three of R (the connect-four threat) is found as
    #    one maximal run, ordered left-to-right, length 3, with correct endpoints.
    h3 = [r for r in runs if r["direction"] == "h" and r["label"] == "R"
          and r["length"] == 3]
    # rows 4 and 5 each hold a horizontal R three.
    assert {r["start"] for r in h3} == {(4, 1), (5, 0)}, h3
    run = next(r for r in h3 if r["start"] == (5, 0))
    assert run["cells"] == [(5, 0), (5, 1), (5, 2)], run["cells"]
    assert run["start"] == (5, 0) and run["end"] == (5, 2)
    assert run["cells"][0] == run["start"] and run["cells"][-1] == run["end"]
    assert any(r["cells"] == [(4, 1), (4, 2), (4, 3)] for r in runs)
    # and a horizontal G three at (3,0)-(3,2).
    assert any(r["label"] == "G" and r["cells"] == [(3, 0), (3, 1), (3, 2)]
               for r in runs)

    # 2) the column-0 vertical: G,R,G,G,G,R top-to-bottom -> a vertical G three at
    #    rows 2-4, found once and *not* extended through the R's that bound it.
    v = [r for r in runs if r["direction"] == "v" and r["label"] == "G"]
    assert any(r["cells"] == [(2, 0), (3, 0), (4, 0)] for r in v), v
    # no vertical run swallows the bounding R at (1,0) or (5,0).
    assert all((1, 0) not in r["cells"] and (5, 0) not in r["cells"] for r in v)

    # 3) a clean win example: four R's in each of the four axes. Each must surface
    #    as exactly one run of length 4 in its own direction.
    def at(cells, lab="R", rows=5, cols=5):
        g = [["." for _ in range(cols)] for _ in range(rows)]
        for (r, c) in cells:
            g[r][c] = lab
        return g

    horiz = osctl.line_runs(at([(2, 0), (2, 1), (2, 2), (2, 3)]), background=".")
    assert [_key(r) for r in horiz] == [("h", (2, 0), 4)], horiz
    vert = osctl.line_runs(at([(0, 2), (1, 2), (2, 2), (3, 2)]), background=".")
    assert [_key(r) for r in vert] == [("v", (0, 2), 4)], vert
    down = osctl.line_runs(at([(0, 0), (1, 1), (2, 2), (3, 3)]), background=".")
    assert [_key(r) for r in down] == [("d", (0, 0), 4)], down
    anti = osctl.line_runs(at([(0, 3), (1, 2), (2, 1), (3, 0)]), background=".")
    assert [_key(r) for r in anti] == [("a", (0, 3), 4)], anti
    # the anti-diagonal run is ordered along the axis (down-left): start top-right.
    assert anti[0]["cells"] == [(0, 3), (1, 2), (2, 1), (3, 0)]

    # 4) maximality: a run of five is one run of length 5, never two overlapping
    #    fours or a four plus its sub-runs.
    five = osctl.line_runs(at([(1, 0), (1, 1), (1, 2), (1, 3), (1, 4)]),
                           background=".")
    assert len(five) == 1 and five[0]["length"] == 5, five

    # 5) min_len gates the output: a board with a two and a four yields both at
    #    min_len=2, only the four at min_len=4 (the "is there a win" query).
    mixed = at([(0, 0), (0, 1), (3, 0), (3, 1), (3, 2), (3, 3)])
    assert {r["length"] for r in osctl.line_runs(mixed, background=".",
                                                  min_len=2)} == {2, 4}
    wins = osctl.line_runs(mixed, background=".", min_len=4)
    assert [r["length"] for r in wins] == [4], wins
    # min_len=1 keeps singletons (a lone cell is a run of one).
    lone = osctl.line_runs([["X", ".", "."]], background=".", min_len=1,
                           directions=("h",))
    assert any(r["length"] == 1 and r["start"] == (0, 0) for r in lone)

    # 6) directions selects axes: the same single diagonal four is reported under
    #    'd' but vanishes when only 'h','v' are asked for.
    dgrid = at([(0, 0), (1, 1), (2, 2), (3, 3)])
    assert len(osctl.line_runs(dgrid, background=".", directions=("d",))) == 1
    assert osctl.line_runs(dgrid, background=".", directions=("h", "v")) == []

    # 7) background never forms a run (single or set), and is the only thing that
    #    bounds runs: with no background, the empty cells themselves run.
    full = [["G", "G", "_", "_"]]
    assert {r["label"] for r in osctl.line_runs(full, background="_")} == {"G"}
    none_bg = osctl.line_runs(full, directions=("h",))  # '_' now a real label
    assert any(r["label"] == "_" and r["length"] == 2 for r in none_bg)
    # background as a set excludes several labels at once.
    multi = osctl.line_runs([["A", "A", "B", "B"]], background={"B"},
                            directions=("h",))
    assert [r["label"] for r in multi] == ["A"]

    # 8) deterministic order (directions first, then start row-major) and re-run
    #    identity.
    assert osctl.line_runs(board, background=".") == runs
    order = [(r["direction"], r["start"]) for r in runs]
    # group by direction in the requested h,v,d,a order, starts ascending within.
    diridx = {"h": 0, "v": 1, "d": 2, "a": 3}
    assert order == sorted(order, key=lambda x: (diridx[x[0]], x[1])), order

    # 9) argument validation.
    for bad in (
        dict(grid=[]),
        dict(grid=[[1, 2], [3]]),            # ragged
        dict(grid=[[]]),                      # empty row
        dict(grid=board, min_len=0),
        dict(grid=board, directions=()),
        dict(grid=board, directions=("h", "z")),
    ):
        try:
            osctl.line_runs(**bad)
            raise AssertionError(f"expected ValueError for {bad}")
        except ValueError:
            pass

    print("F259 OK: line_runs finds maximal straight runs of equal label along the "
          "four grid axes (h,v,d,a) -- the live four-in-a-row threat (R R R) read as "
          "one length-3 horizontal run, a win is min_len=4, runs are maximal (a five "
          "is one run not overlapping fours), ordered along their axis with "
          "start/end endpoints, background bounds runs (single or set), directions "
          "selects axes, deterministic order, args validated")


if __name__ == "__main__":
    main()
