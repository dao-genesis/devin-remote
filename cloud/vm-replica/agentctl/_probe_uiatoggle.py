"""Standalone live reproduction of F171: uia_toggle flips a checkbox by meaning via
the UIA TogglePattern, and uia_toggle_state reads its state ("on"/"off") — the
semantic state verb inside modern apps. Verified against a Chrome checkbox, with CDP
confirming the DOM .checked actually flipped."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
from browser import Browser


def main():
    b = Browser(port=29229)
    b.navigate("data:text/html,<input type=checkbox id=cb><label for=cb>AGREE</label>")
    time.sleep(1.2)
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    if not ch:
        print("[FAIL] no chrome"); return
    state0 = ""
    for _ in range(10):
        state0 = osctl.uia_toggle_state(ch["id"], ctype="CheckBox")
        if state0:
            break
        time.sleep(0.5)
    print(f"initial uia_toggle_state -> {state0!r}; CDP checked={b.eval('document.getElementById(\"cb\").checked')}")
    print(f"[{'PASS' if state0 == 'off' else 'FAIL'}] reads initial state 'off'")
    ok = osctl.uia_toggle(ch["id"], ctype="CheckBox")
    time.sleep(0.4)
    checked = b.eval("document.getElementById('cb').checked")
    print(f"uia_toggle issued -> {ok}; CDP checked={checked}")
    print(f"[{'PASS' if ok is True and checked is True else 'FAIL'}] "
          f"toggle flips the checkbox (DOM confirms)")
    again = osctl.uia_toggle_state(ch["id"], ctype="CheckBox")
    print(f"[{'PASS' if again == 'on' else 'FAIL'}] settled state read agrees after flip -> {again!r}")
    b.navigate("about:blank")


if __name__ == "__main__":
    main()
