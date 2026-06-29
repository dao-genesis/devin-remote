"""Minesweeper (gnome-mines) player driven entirely by the agentctl floor.

Perception is pure vision (capture_rgb + tesseract OCR per cell); the cell grid
geometry is taken from the 64 anonymous AT-SPI buttons the GTK board exposes.
This is the hybrid that games demand: AT-SPI for *where*, pixels for *what*.
"""
import os
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:abstract=/tmp/dbus-JksQnYX22L')
import sys, time
sys.path.insert(0, '.')
import osctl


def grid_geometry():
    wid = [w for w in osctl.list_windows() if 'Mines' in (w.get('title') or '')][0]['id']
    els = osctl.uia_find_all(wid, max_scan=1500)
    cells = [e['rect'] for e in els
             if e.get('type') == 'Button' and not e.get('name')
             and e.get('rect') and e['rect'][2] < 200 and e['rect'][3] < 200]
    xs = sorted(set(r[0] for r in cells))
    ys = sorted(set(r[1] for r in cells))
    cw, ch = cells[0][2], cells[0][3]
    return wid, xs, ys, cw, ch


def _avg(rgb, W, x0, y0, x1, y1):
    rs = gs = bs = n = 0
    for yy in range(y0, y1, 3):
        for xx in range(x0, x1, 3):
            j = (yy * W + xx) * 3
            rs += rgb[j]; gs += rgb[j + 1]; bs += rgb[j + 2]; n += 1
    n = n or 1
    return rs // n, gs // n, bs // n


def _is_unrevealed(r, g, b):
    # gnome-mines unrevealed tile is grey-green ~ (176,181,171)
    return abs(r - 176) < 22 and abs(g - 181) < 22 and abs(b - 171) < 22


def _classify(rgb, W, cx, cy, cw, ch):
    """Return '.', ' ', '1'..'8' or 'F' for one cell, via colour + osctl.ocr_text."""
    # centre patch colour
    r, g, b = _avg(rgb, W, cx + cw // 3, cy + ch // 3,
                   cx + 2 * cw // 3, cy + 2 * ch // 3)
    if _is_unrevealed(r, g, b):
        return '.'
    # corner stays on tile colour for a flag (dark flag sits on unrevealed bg);
    # a revealed-empty cell is tinted in the corner too.
    cr, cg, cb = _avg(rgb, W, cx + 4, cy + 4, cx + cw // 4, cy + ch // 4)
    if _is_unrevealed(cr, cg, cb):
        return 'F'
    # inset the digit crop by a fraction of the cell, not a fixed pixel margin:
    # a fixed 25/20px margin goes negative on a small (e.g. 48px) cell (F237).
    ix = max(2, int(cw * 0.25)); iy = max(2, int(ch * 0.20))
    digit = osctl.ocr_text((cx + ix, cy + iy, cw - 2 * ix, ch - 2 * iy),
                           whitelist='12345678', psm=10, scale=2,
                           rgb=rgb, size=(W, _CUR_H))
    digit = ''.join(c for c in digit if c.isdigit())
    return digit[0] if digit else ' '


_CUR_H = 0


def read_board():
    global _CUR_H
    wid, xs, ys, cw, ch = grid_geometry()
    W, H, rgb = osctl.capture_rgb()
    _CUR_H = H
    board = []
    for cy in ys:
        row = [_classify(rgb, W, cx, cy, cw, ch) for cx in xs]
        board.append(row)
    return board, xs, ys, cw, ch


def _grid_bbox(xs, ys, cw, ch):
    return (xs[0], ys[0], xs[-1] + cw - 1, ys[-1] + ch - 1)


def read_full(xs, ys, cw, ch):
    """Classify the whole board from one capture; also return that capture so a
    later :func:`read_delta` can diff against it. Returns ``(board, rgb, size)``."""
    global _CUR_H
    W, H, rgb = osctl.capture_rgb()
    _CUR_H = H
    board = [[_classify(rgb, W, cx, cy, cw, ch) for cx in xs] for cy in ys]
    return board, rgb, (W, H)


def read_delta(prev_board, prev_rgb, xs, ys, cw, ch):
    """Re-classify only the cells that changed since ``prev_rgb`` (F250).

    A mines move reveals a handful of cells (a flood-fill region) or toggles one
    flag; re-OCRing all 64 every round is the waste F250 removes. ``grid_changes``
    flags the moved cells from the two captures and we re-run ``_classify`` on
    those alone, copying the rest from ``prev_board``. Returns
    ``(board, rgb, size, n_reclassified)``."""
    global _CUR_H
    W, H, rgb = osctl.capture_rgb()
    _CUR_H = H
    bbox = _grid_bbox(xs, ys, cw, ch)
    changed = osctl.grid_changes(prev_rgb, rgb, bbox, len(xs), len(ys),
                                 (W, H), inset=0.18, tol=24, min_count=10)
    board = [row[:] for row in prev_board]
    for (r, c) in changed:
        board[r][c] = _classify(rgb, W, xs[c], ys[r], cw, ch)
    return board, rgb, (W, H), len(changed)


def print_board(board):
    for row in board:
        print(' '.join(row))


def _neighbors(r, c, R, C):
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if (dr or dc) and 0 <= r + dr < R and 0 <= c + dc < C:
                yield r + dr, c + dc


def click_cell(xs, ys, cw, ch, r, c, right=False):
    osctl.click(xs[c] + cw // 2, ys[r] + ch // 2, right=right)


def _constraints(board, flagged):
    """List of (frozenset(unknown cells), mines_remaining) per number cell."""
    R, C = len(board), len(board[0])
    cons = []
    for r in range(R):
        for c in range(C):
            v = board[r][c]
            if v not in '12345678':
                continue
            unk = frozenset((nr, nc) for nr, nc in _neighbors(r, c, R, C)
                            if board[nr][nc] == '.' and (nr, nc) not in flagged)
            flg = sum(1 for nr, nc in _neighbors(r, c, R, C)
                      if board[nr][nc] == 'F' or (nr, nc) in flagged)
            if unk:
                cons.append((unk, int(v) - flg))
    return cons


def _deduce(board, flagged, total_mines):
    """Return (to_flag, to_open) using single-cell + subset elimination +
    global mine-count endgame."""
    R, C = len(board), len(board[0])
    to_flag, to_open = set(), set()
    cons = _constraints(board, flagged)
    # single-cell rule
    for unk, mines in cons:
        if mines == len(unk):
            to_flag |= set(unk)
        elif mines == 0:
            to_open |= set(unk)
    # subset elimination: if A⊆B, then B\A holds (mB-mA) mines
    for a_unk, a_m in cons:
        for b_unk, b_m in cons:
            if a_unk < b_unk:
                diff = b_unk - a_unk
                dm = b_m - a_m
                if dm == len(diff):
                    to_flag |= diff
                elif dm == 0:
                    to_open |= diff
    # global endgame: if remaining unknown == remaining mines → all mines
    all_unk = set()
    for row_i in range(R):
        for col_i in range(C):
            if board[row_i][col_i] == '.' and (row_i, col_i) not in flagged:
                all_unk.add((row_i, col_i))
    mines_left = total_mines - len(flagged)
    if all_unk and len(all_unk) == mines_left:
        to_flag |= all_unk
    elif mines_left == 0:
        to_open |= all_unk
    to_open -= to_flag
    return to_flag, to_open


def _best_guess(board, flagged, total_mines):
    """Lowest-risk frontier cell. Probability = max constraint density over the
    constraints touching the cell; ties fall back to global mine density."""
    R, C = len(board), len(board[0])
    cons = _constraints(board, flagged)
    all_unk = [(r, c) for r in range(R) for c in range(C)
               if board[r][c] == '.' and (r, c) not in flagged]
    if not all_unk:
        return None
    mines_left = total_mines - len(flagged)
    base = mines_left / len(all_unk) if all_unk else 1.0
    best, best_p = None, 2.0
    for cell in all_unk:
        p = 0.0
        touched = False
        for unk, mines in cons:
            if cell in unk and unk:
                touched = True
                p = max(p, mines / len(unk))
        if not touched:
            p = base
        if p < best_p:
            best_p, best = p, cell
    return best


def solve(max_rounds=60, total_mines=10):
    """Play until win/loss/stuck. Returns ('win'|'lost'|'stuck'|'maxrounds',
    rounds, board).

    The board is read in full once; every later read is a F250 delta that
    re-classifies only the cells a move actually changed, instead of all R*C
    every round. ``solve.last_reclassified`` / ``solve.last_full`` report the
    cells re-classified vs the count a full re-read each round would have cost."""
    wid, xs, ys, cw, ch = grid_geometry()
    R, C = len(ys), len(xs)
    flagged = set()
    board, prev_rgb, _ = read_full(xs, ys, cw, ch)
    reclassified = R * C          # the initial full read
    full_equiv = R * C
    for rnd in range(max_rounds):
        b = [row[:] for row in board]
        for (r, c) in flagged:
            b[r][c] = 'F'
        to_flag, to_open = _deduce(b, flagged, total_mines)
        to_open -= flagged
        if not to_flag and not to_open:
            guess = _best_guess(b, flagged, total_mines)
            if guess is None:
                solve.last_reclassified = reclassified; solve.last_full = full_equiv
                return 'stuck', rnd, b
            click_cell(xs, ys, cw, ch, guess[0], guess[1], right=False)
            time.sleep(0.7)
        else:
            for (r, c) in to_flag:
                if (r, c) not in flagged:
                    click_cell(xs, ys, cw, ch, r, c, right=True)
                    flagged.add((r, c)); time.sleep(0.12)
            for (r, c) in to_open:
                click_cell(xs, ys, cw, ch, r, c, right=False)
                time.sleep(0.12)
            time.sleep(0.6)
        board, prev_rgb, _, n = read_delta(board, prev_rgb, xs, ys, cw, ch)
        reclassified += n; full_equiv += R * C
        b2 = [row[:] for row in board]
        for (r, c) in flagged:
            b2[r][c] = 'F'
        if sum(row.count('.') for row in b2) == 0:
            solve.last_reclassified = reclassified; solve.last_full = full_equiv
            return 'win', rnd, b2
    solve.last_reclassified = reclassified; solve.last_full = full_equiv
    return 'maxrounds', max_rounds, board


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'read'
    if cmd == 'read':
        t = time.time()
        board, xs, ys, cw, ch = read_board()
        print_board(board)
        print('read in %.2fs' % (time.time() - t))
    elif cmd == 'solve':
        res, rounds, board = solve()
        if board:
            print_board(board)
        print('RESULT:', res, 'rounds:', rounds)
