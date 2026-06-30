"""Live connect-four driven entirely by the floor's perception + line_runs (F259).

Each turn: read the 7x6 board with sample_grid -> {R,G,.} label grid, then use
line_runs to (1) win if a drop completes a 4-run, (2) else block the opponent's
4-run, (3) else play the column that most extends my own longest run. The move
selection is one call to line_runs per candidate column -- the N-in-a-row predicate
the primitive exists for. No bespoke line scan anywhere in this driver.
"""
import sys
import time

import osctl

WID = int(sys.argv[1]) if len(sys.argv) > 1 else None
COLX = [566, 638, 710, 782, 854, 926, 998]
BBOX = (530, 400, 1035, 843)
COLS, ROWS = 7, 6


def read_board():
    w, h, rgb = osctl.capture_rgb()
    g = osctl.sample_grid(BBOX, COLS, ROWS, rgb=rgb, size=(w, h),
                          inset=0.30, stat="mode")

    def lab(c):
        r, gg, b = c["r"], c["g"], c["b"]
        if r < 45 and gg < 45 and b < 45:
            return "."
        return "G" if gg > r and gg > b else "R"
    return [[lab(c) for c in row] for row in g]


def landing(board, col):
    """Row a disc dropped in col would land on, or None if the column is full."""
    for r in range(ROWS - 1, -1, -1):
        if board[r][col] == ".":
            return r
    return None


def best_run_after(board, col, who):
    """Longest run of `who` through the cell a drop in col would occupy."""
    r = landing(board, col)
    if r is None:
        return -1
    trial = [row[:] for row in board]
    trial[r][col] = who
    best = 0
    for run in osctl.line_runs(trial, background="."):
        if run["label"] == who and (r, col) in run["cells"]:
            best = max(best, run["length"])
    return best


def choose(board):
    playable = [c for c in range(COLS) if landing(board, c) is not None]
    # 1) win now.
    for c in playable:
        if best_run_after(board, c, "R") >= 4:
            return c, "WIN"
    # 2) block the opponent's win.
    for c in playable:
        if best_run_after(board, c, "G") >= 4:
            return c, "BLOCK"
    # 3) extend my own longest run; prefer central columns to break ties.
    central = sorted(playable, key=lambda c: abs(c - 3))
    return max(central, key=lambda c: best_run_after(board, c, "R")), "EXTEND"


def main():
    for move in range(1, 22):
        board = read_board()
        runs = osctl.line_runs(board, background=".")
        my_max = max([r["length"] for r in runs if r["label"] == "R"], default=0)
        op_max = max([r["length"] for r in runs if r["label"] == "G"], default=0)
        print(f"-- move {move}: my longest R run={my_max}, opp G run={op_max}")
        if my_max >= 4:
            print("RESULT: I made four-in-a-row (line_runs detected the win)")
            return
        if op_max >= 4:
            print("RESULT: opponent reached four")
            return
        col, why = choose(board)
        print(f"   drop column {col} ({why})")
        if WID:
            osctl.activate_window(WID)
        osctl.click(COLX[col], 600)
        time.sleep(1.6)
    print("RESULT: move budget exhausted")


if __name__ == "__main__":
    main()
