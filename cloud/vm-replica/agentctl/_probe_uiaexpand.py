"""Standalone live reproduction of F173: uia_expand/uia_collapse open and close a
disclosure (a <details> element) by meaning via the UIA ExpandCollapsePattern, and
uia_expand_state reads the settled state. Verified against Chrome, with CDP confirming
the DOM details.open flag tracks the expand/collapse."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
from browser import Browser


def main():
    b = Browser(port=29229)
    b.navigate("data:text/html,<details id=d><summary>MORE</summary><p>hidden body</p></details>")
    time.sleep(1.2)
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    if not ch:
        print("[FAIL] no chrome"); return
    st0 = ""
    for _ in range(10):
        st0 = osctl.uia_expand_state(ch["id"], "MORE")
        if st0:
            break
        time.sleep(0.5)
    print(f"initial uia_expand_state(MORE) -> {st0!r}; CDP open={b.eval('document.getElementById(\"d\").open')}")
    print(f"[{'PASS' if st0 == 'collapsed' else 'FAIL'}] starts collapsed")
    ok = osctl.uia_expand(ch["id"], "MORE")
    time.sleep(0.4)
    opened = b.eval("document.getElementById('d').open")
    print(f"uia_expand issued -> {ok}; CDP open={opened}")
    print(f"[{'PASS' if ok is True and opened is True else 'FAIL'}] expand opens the disclosure (DOM confirms)")
    print(f"[{'PASS' if osctl.uia_expand_state(ch['id'], 'MORE') == 'expanded' else 'FAIL'}] settled state -> expanded")
    ok2 = osctl.uia_collapse(ch["id"], "MORE")
    time.sleep(0.4)
    closed = b.eval("document.getElementById('d').open")
    print(f"uia_collapse issued -> {ok2}; CDP open={closed}")
    print(f"[{'PASS' if ok2 is True and closed is False else 'FAIL'}] collapse closes the disclosure (DOM confirms)")
    b.navigate("about:blank")


if __name__ == "__main__":
    main()
