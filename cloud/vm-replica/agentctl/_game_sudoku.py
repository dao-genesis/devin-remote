"""Sudoku (gnome-sudoku) player driven entirely by the agentctl floor.

gnome-sudoku draws its 9x9 grid on a custom widget: AT-SPI exposes the toolbar
buttons but *not* the 81 cells or their digits, so the board is read purely by
vision. The cold-start reader ``osctl.ocr_text`` (tesseract) lifts each given
digit; the grid geometry is recovered from the four heavy 3x3 box-border lines
the board draws (no hard-coded pixels). Solve with backtracking, then drive the
empties back in with ``click`` + ``type_unicode``. The hybrid games demand:
AT-SPI to find the window, pixels for the board, synthetic input to play.

Two readout lessons that matter for any self-drawn fixed-font glyph grid:
  * feed tesseract the *greyscale* crop, never a hard 1-bit threshold -- the
    anti-aliased edges are what it keys on (binarising dropped 4/6/8/9 entirely);
  * use ``psm=6`` (a text block), not ``psm=10`` (a lone char): on these tight
    digit crops psm=10 silently drops the round glyphs while psm=6 reads them.
With both, the board reads 81/81 through the existing primitive -- no new OCR.
"""
import os
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:abstract=/tmp/dbus-JksQnYX22L')
import sys, time, copy
sys.path.insert(0, '.')
import osctl

DARK = 100          # grid-line / glyph luma threshold
W = H = 0
RGB = b''


def _grab():
    global W, H, RGB
    W, H, RGB = osctl.capture_rgb(0, 0, 1600, 1200)


def _ensure_started():
    for w in osctl.list_windows():
        if (w.get('title') or '') != 'Select Difficulty':
            continue
        for e in osctl.uia_find_all(w['id'], max_scan=2000):
            if e.get('name') == 'Easy':
                x, y, w0, h0 = e['rect']
                osctl.click(x + w0 // 2, y + h0 // 2)
                time.sleep(1.5)
                return


def _lum(x, y):
    i = (y * W + x) * 3
    return (RGB[i] * 299 + RGB[i + 1] * 587 + RGB[i + 2] * 114) // 1000


def _runs(vals, gap=3):
    """Collapse a sorted list of coords into the centres of contiguous runs."""
    out, cur = [], [vals[0]]
    for v in vals[1:]:
        if v - cur[-1] <= gap:
            cur.append(v)
        else:
            out.append((cur[0] + cur[-1]) // 2)
            cur = [v]
    out.append((cur[0] + cur[-1]) // 2)
    return out


def detect_board():
    """Find board origin + cell size from the heavy 3x3 box-border lines.

    The thin per-cell separators are light grey; only the four box borders are
    dark across the whole board, so a 'mostly dark over the board span' column /
    row test isolates exactly the bounding 4 verticals + 4 horizontals."""
    _grab()
    # coarse board bbox: any dark pixel cluster near screen centre
    ys = range(280, 920, 2)
    cols = [x for x in range(420, 1160)
            if sum(1 for y in ys if _lum(x, y) < DARK) > 180]
    xs = range(480, 1100, 2)
    rows = [y for y in range(280, 920)
            if sum(1 for x in xs if _lum(x, y) < DARK) > 180]
    vx, hy = _runs(cols), _runs(rows)
    if len(vx) < 4 or len(hy) < 4:
        raise RuntimeError(f"board borders not found: vx={vx} hy={hy}")
    x0, x1 = vx[0], vx[-1]
    y0, y1 = hy[0], hy[-1]
    return x0, y0, (x1 - x0) / 9.0, (y1 - y0) / 9.0


class Board:
    def __init__(self):
        self.x0, self.y0, self.cw, self.ch = detect_board()

    def center(self, r, c):
        return int(self.x0 + self.cw * (c + 0.5)), int(self.y0 + self.ch * (r + 0.5))

    def _dark(self, r, c, m=20):
        cx, cy = self.center(r, c)
        return sum(1 for yy in range(cy - m, cy + m) for xx in range(cx - m, cx + m)
                   if _lum(xx, yy) < 110)

    def read_cell(self, r, c):
        if self._dark(r, c) < 20:
            return 0
        cx, cy = self.center(r, c)
        t = osctl.ocr_text(region=(cx - 24, cy - 24, 48, 48), whitelist='123456789',
                           psm=6, scale=4, rgb=RGB, size=(W, H))
        d = ''.join(ch for ch in t if ch.isdigit())
        return int(d[0]) if d else 0

    def read(self):
        _grab()
        return [[self.read_cell(r, c) for c in range(9)] for r in range(9)]


def _ok(g, r, c, v):
    for i in range(9):
        if g[r][i] == v or g[i][c] == v:
            return False
    br, bc = (r // 3) * 3, (c // 3) * 3
    for i in range(br, br + 3):
        for j in range(bc, bc + 3):
            if g[i][j] == v:
                return False
    return True


def solve(g):
    for r in range(9):
        for c in range(9):
            if g[r][c] == 0:
                for v in range(1, 10):
                    if _ok(g, r, c, v):
                        g[r][c] = v
                        if solve(g):
                            return True
                        g[r][c] = 0
                return False
    return True


def play(verbose=True):
    _ensure_started()
    b = Board()
    given = b.read()
    if verbose:
        print("READ:")
        for row in given:
            print(''.join(str(v) if v else '.' for v in row))
    sol = copy.deepcopy(given)
    if not solve(sol):
        raise RuntimeError("no solution -- board misread")
    if verbose:
        print("SOLUTION:")
        for row in sol:
            print(''.join(map(str, row)))
    filled = 0
    for r in range(9):
        for c in range(9):
            if given[r][c] == 0:
                x, y = b.center(r, c)
                osctl.click(x, y)
                time.sleep(0.05)
                osctl.type_unicode(str(sol[r][c]))
                time.sleep(0.05)
                filled += 1
    if verbose:
        print(f"filled {filled} cells")
    return b, given, sol


if __name__ == '__main__':
    play()
