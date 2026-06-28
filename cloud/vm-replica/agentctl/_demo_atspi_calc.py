"""F180 visual demo — drive a real GTK calculator purely by meaning, and survive
its living tree.

No screenshot, no OCR, no guessed pixel: each button is pressed by its accessible
*name* (uia_invoke), and the answer is read back from the calculator's own a11y
display (uia_children) — an oracle the floor cannot fake. Then the exact press +
re-walk sequence that used to segfault the floor is repeated in a tight loop to
show it now runs forever.
"""
import sys
import time

sys.path.insert(0, ".")
import osctl


def calc():
    for w in osctl.list_windows():
        if "calcul" in (w.get("title") or "").lower():
            return w["id"]
    return None


def show_readout(win):
    for c in osctl.uia_children(win):
        if c["ctype"] in ("label", "text") and c["name"].strip():
            # the largest plain number is the result line
            n = c["name"].strip()
            if n.replace(".", "").replace("-", "").isdigit():
                return n
    return "?"


def main():
    win = calc()
    if not win:
        print("launch gnome-calculator first")
        return 1
    osctl.activate_window(win)
    time.sleep(1.0)

    print(">> driving  4 2 × 3 + 6 =  entirely by MEANING (no pixels, no OCR)")
    for n in ["4", "2", "×", "3", "+", "6", "="]:
        ok = osctl.uia_invoke(win, name=n, ctype="push button")
        print(f"   uia_invoke({n!r}) -> {ok}")
        time.sleep(0.8)

    time.sleep(0.8)
    ans = show_readout(win)
    print(f">> the calculator's OWN display reads back: {ans}   (42*3+6 = 132)")

    print(">> now hammering  press '=' + re-walk the tree  10x — the sequence that "
          "used to segfault the floor:")
    for i in range(10):
        for n in ["8", "+", "8", "="]:
            osctl.uia_invoke(win, name=n, ctype="push button")
        k = len(osctl.uia_children(win))
        print(f"   cycle {i+1:2d}: tree re-walked, {k} controls, floor alive")
        time.sleep(0.25)
    print(">> survived every mutation — the floor reads a living tree without dying.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
