"""Integration proof — Human Benchmark *Chimp Test* solved with EXISTING floor
primitives only (no new F-number). 无为而无不为: the whole game falls out of
composition; nothing was invented for it.

The Chimp Test scatters numbered tiles 1..N at arbitrary positions, then hides
every number the instant you touch the first — you must then click them in
ascending order from memory. Unlike Visual Memory (where a blob's *position* is
the whole signal), this needs to read *which number* each tile carries, so it
exercises the perception ladder's top rung:

  find_color_blobs  (F052)  -> where the white glyphs are, each with its bbox
  edge_signature    (F056)  -> a scale-free structural fingerprint of one glyph
  read_glyph        (F058)  -> classify that fingerprint against a digit atlas
  click                     -> land the move, ascending by the read number

Two wrinkles the floor already answers:

* **Multi-digit tiles.** "10", "11" ... segment into *two* white components, so
  `find_color_blobs` returns two blobs for one tile. :func:`group_tiles` re-joins
  blobs that sit within one tile's span and reads them left-to-right into a
  number — the same segment-then-read idiom `read_text` uses for canvas runs.

* **The atlas is self-supervised.** The digit atlas (``chimp_atlas.json``,
  ``{digit: edge_signature}``) was *bootstrapped from the game itself*: a handful
  of low levels were labelled once, then every higher level grows the atlas with
  no supervision — the board always shows exactly the set {1..N}, so a digit the
  atlas cannot yet name is pinned by elimination (the missing member of the set)
  and its signature captured. :func:`grow_atlas` keeps that alive at run time, so
  an atlas seeded with only 1..5 heals itself up through every digit as it plays.

Run: DISPLAY=:0 python3 _game_chimp.py
"""
import sys, os, time, json
from collections import Counter
sys.path.insert(0, ".")
import osctl

BOARD = (30, 150, 1545, 655)
WHITE = (255, 255, 255)
ATLAS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "chimp_atlas.json")


def load_atlas() -> dict:
    with open(ATLAS_PATH) as f:
        return json.load(f)


def find_glyphs(rgb, size):
    """Every white glyph on the board, each as ``{x, y, bbox}`` (F052)."""
    bl = osctl.find_color_blobs(WHITE, tol=55, search=BOARD, min_count=80,
                                step=1, rgb=rgb, size=size)
    return sorted(bl, key=lambda b: (b["y"], b["x"]))


def group_tiles(blobs):
    """Re-join the glyphs of a multi-digit tile into one left-to-right group.

    A single tile spans ~90 px; the two glyphs of a two-digit number sit ~27 px
    apart on the same row, while distinct tiles are far further apart. So blobs
    within a tile's span (dx<55, dy<28) belong to one number."""
    used = [False] * len(blobs)
    tiles = []
    for i, b in enumerate(blobs):
        if used[i]:
            continue
        grp = [b]
        used[i] = True
        for j, c in enumerate(blobs):
            if (not used[j] and abs(c["x"] - b["x"]) < 55
                    and abs(c["y"] - b["y"]) < 28):
                grp.append(c)
                used[j] = True
        grp.sort(key=lambda g: g["x"])
        tiles.append(grp)
    return tiles


def read_tile(rgb, size, tile, atlas):
    """Read one (possibly multi-glyph) tile into its integer, left-to-right."""
    digits = [min(atlas, key=lambda k: osctl.edge_hamming(
        atlas[k], osctl.edge_signature(rgb, size, g["bbox"]))) for g in tile]
    cx = sum(g["x"] for g in tile) // len(tile)
    cy = sum(g["y"] for g in tile) // len(tile)
    return "".join(digits), cx, cy


def _sig(rgb, size, g):
    return osctl.edge_signature(rgb, size, g["bbox"])


def grow_atlas(rgb, size, tiles, atlas):
    """Self-supervise one new glyph: the board is exactly {1..N}, so a digit the
    atlas cannot yet read is pinned by elimination and its signature captured.

    Two shapes occur in the Chimp Test:

    * a fresh single digit (the level's new maximum ≤ 9) makes a single-glyph
      tile read as a *duplicate* of a look-alike already in the atlas — the true
      new glyph is the duplicate whose signature sits *farthest* from that
      look-alike's atlas entry (F058: nearest wins, so the impostor is farthest);
    * a fresh digit that only ever appears *inside* a multi-digit number (``0``
      in ``"10"``) makes that tile's number fall outside {1..N}; the number's
      other glyphs are known, so the odd glyph is the one that, relabelled the
      missing digit, brings the number back into range."""
    n = len(tiles)
    reads = [read_tile(rgb, size, t, atlas) for t in tiles]
    want = set(range(1, n + 1))
    missing = sorted(want - {int(s) for s, _, _ in reads if s.isdigit()})
    if not missing:
        return False
    m = missing[0]
    if m < 10:
        dup = {v for v, c in Counter(s for s, _, _ in reads).items() if c > 1}
        cands = [t for t, (s, _, _) in zip(tiles, reads)
                 if len(t) == 1 and s in dup]
        if cands:
            far = max(cands, key=lambda t: osctl.edge_hamming(
                atlas[read_tile(rgb, size, t, atlas)[0]], _sig(rgb, size, t[0])))
            atlas[str(m)] = _sig(rgb, size, far[0])
            return True
    unknown = [str(d) for d in range(10) if str(d) not in atlas]
    miss = set(missing)
    for t, (s, _, _) in zip(tiles, reads):
        if len(t) > 1 and (not s.isdigit() or int(s) not in want):
            for gi, g in enumerate(t):
                for cd in unknown:
                    trial = list(s)
                    trial[gi] = cd
                    ts = "".join(trial)
                    if ts.isdigit() and int(ts) in miss:
                        atlas[cd] = _sig(rgb, size, g)
                        return True
    return False


def read_board(rgb, size, atlas):
    """[(number, cx, cy)] for every tile, growing the atlas if a glyph is new."""
    tiles = group_tiles(find_glyphs(rgb, size))
    for _ in range(4):                       # heal several new glyphs if needed
        if not grow_atlas(rgb, size, tiles, atlas):
            break
    out = []
    for t in tiles:
        s, cx, cy = read_tile(rgb, size, t, atlas)
        if s.isdigit():
            out.append((int(s), cx, cy))
    return out


def main(max_levels=12):
    atlas = load_atlas()
    osctl.omnibox_go("https://humanbenchmark.com/tests/chimp"); time.sleep(2.2)
    osctl.click(776, 564); time.sleep(1.4)              # Start Test

    reached = 0
    for level in range(1, max_levels + 1):
        w, h, rgb = osctl.capture_rgb()
        board = read_board(rgb, (w, h), atlas)
        order = sorted(board)
        nums = [v for v, _, _ in order]
        # a clean board is exactly 1..len(board)
        if nums != list(range(1, len(nums) + 1)) or len(nums) < 2:
            print(f"level {level}: read {nums}; stopping"); break
        print(f"level {level}: {len(nums)} tiles, read 1..{len(nums)} clean")
        for v, cx, cy in order:
            osctl.click(cx, cy); osctl.move(60, 700); time.sleep(0.14)
        reached = level
        time.sleep(1.0)
        osctl.click(776, 542); time.sleep(1.5)          # Continue

    osctl.screenshot("/tmp/chimp_result.png")
    print(f"reached level {reached}; atlas digits now {sorted(atlas)}")


if __name__ == "__main__":
    main()
