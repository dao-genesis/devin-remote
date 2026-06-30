"""Sudoku (gnome-sudoku) player driven entirely by the agentctl floor.

gnome-sudoku draws its 9x9 grid on a custom widget: AT-SPI exposes the toolbar
buttons but *not* the 81 cells or their digits, so the board is read purely by
vision. The grid geometry is recovered by ``osctl.detect_grid`` scoped to the
Sudoku window rect (``window_geometry`` -- no hard-coded screen pixels, robust
to any window size/position), then ``osctl.ocr_grid`` lifts the givens off the
detected ``xs``/``ys`` edges in one ink-gated pass. Solve with backtracking, then
drive the empties back in with ``click`` + ``type_unicode``. The hybrid games
demand: AT-SPI to find the window, pixels for the board, synthetic input to play.

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


def detect_board():
    """Locate the 9x9 lattice with the floor's detect_grid, scoped to the
    gnome-sudoku window rect -- no hard-coded screen pixels, so it survives the
    window being moved or the board drawn at any size. Returns the detect_grid
    dict (bbox + true xs/ys edges)."""
    win = next((w['id'] for w in osctl.list_windows()
                if (w.get('title') or '') == 'Sudoku'), None)
    if win is None:
        raise RuntimeError("Sudoku window not found")
    geom = osctl.window_geometry(win)
    if not geom:
        raise RuntimeError("no window geometry for Sudoku window")
    # search the window interior, below the ~44px header bar
    search = (geom['x'], geom['y'] + 44, geom['x'] + geom['w'], geom['y'] + geom['h'])
    grid = osctl.detect_grid(search)
    if not grid or grid['cols'] != 9 or grid['rows'] != 9:
        got = grid and (grid['cols'], grid['rows'])
        raise RuntimeError(f"board lattice not 9x9: {got}")
    return grid


class Board:
    def __init__(self):
        g = detect_board()
        self.bbox, self.xs, self.ys = g['bbox'], g['xs'], g['ys']

    def center(self, r, c):
        return ((self.xs[c] + self.xs[c + 1]) // 2,
                (self.ys[r] + self.ys[r + 1]) // 2)

    def read(self):
        """Read the 9x9 board in one ink-gated pass via osctl.ocr_grid off the
        detected xs/ys edges: the gate leaves blanks empty (no empty-cell
        hallucination, no wasted OCR) and only the givens reach tesseract,
        whitelisted to digits in psm=6 (F251)."""
        _grab()
        grid = osctl.ocr_grid(self.bbox, 9, 9, rgb=RGB, size=(W, H),
                              xs=self.xs, ys=self.ys,
                              whitelist='123456789', psm=6, scale=4)
        out = []
        for row in grid:
            line = []
            for s in row:
                d = ''.join(ch for ch in s if ch.isdigit())
                line.append(int(d[0]) if d else 0)
            out.append(line)
        return out


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
