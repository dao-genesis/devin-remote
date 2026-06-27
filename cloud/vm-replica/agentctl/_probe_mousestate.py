"""Standalone live reproduction of F158 on Windows: mouse_state() reads which
buttons are pressed + cursor pos — the button-read dual of mouse_button. Run
alone. Presses at a neutral corner and always releases."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def main():
    osctl.move(3, 3)  # neutral corner, avoid stray UI hits
    time.sleep(0.2)
    s0 = osctl.mouse_state()
    print(f"[{'PASS' if not s0['left'] else 'FAIL'}] left starts up -> {s0['left']}")
    print(f"[{'PASS' if isinstance(s0.get('pos'), tuple) else 'FAIL'}] reports cursor "
          f"pos -> {s0.get('pos')}")
    try:
        osctl._mouse_button("left", True)
        time.sleep(0.15)
        s1 = osctl.mouse_state()
        print(f"[{'PASS' if s1['left'] else 'FAIL'}] left reads PRESSED while held "
              f"-> {s1['left']}")
        print(f"[{'PASS' if not s1['right'] and not s1['middle'] else 'FAIL'}] only "
              f"left is down (right/middle up) -> r={s1['right']} m={s1['middle']}")
    finally:
        osctl._mouse_button("left", False)
        time.sleep(0.15)
    s2 = osctl.mouse_state()
    print(f"[{'PASS' if not s2['left'] else 'FAIL'}] left reads up after release "
          f"-> {s2['left']}")


if __name__ == "__main__":
    main()
