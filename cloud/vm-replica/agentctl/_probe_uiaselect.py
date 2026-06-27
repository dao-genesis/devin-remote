"""Standalone live reproduction of F172: uia_select chooses an item by meaning (a
radio button) via the UIA SelectionItemPattern, and uia_is_selected reads the settled
truth. Verified against Chrome radios, with CDP confirming which DOM radio is checked."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
from browser import Browser


def main():
    b = Browser(port=29229)
    b.navigate("data:text/html,<input type=radio name=g id=r1><label for=r1>Alpha</label>"
               "<input type=radio name=g id=r2><label for=r2>Beta</label>")
    time.sleep(1.2)
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    if not ch:
        print("[FAIL] no chrome"); return
    sel0 = None
    for _ in range(10):
        sel0 = osctl.uia_is_selected(ch["id"], "Beta", "RadioButton")
        if sel0 is not None:
            break
        time.sleep(0.5)
    print(f"initial uia_is_selected(Beta) -> {sel0!r}")
    print(f"[{'PASS' if sel0 is False else 'FAIL'}] Beta starts unselected")
    ok = osctl.uia_select(ch["id"], "Beta", "RadioButton")
    time.sleep(0.4)
    checked = b.eval("document.getElementById('r2').checked")
    print(f"uia_select(Beta) issued -> {ok}; CDP r2.checked={checked}")
    print(f"[{'PASS' if ok is True and checked is True else 'FAIL'}] "
          f"select chooses Beta by meaning (DOM confirms)")
    settled = osctl.uia_is_selected(ch["id"], "Beta", "RadioButton")
    print(f"[{'PASS' if settled is True else 'FAIL'}] settled is_selected agrees -> {settled!r}")
    b.navigate("about:blank")


if __name__ == "__main__":
    main()
