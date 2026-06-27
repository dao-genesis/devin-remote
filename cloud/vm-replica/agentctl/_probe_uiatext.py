"""Standalone live reproduction of F170: uia_text reads the rendered text OUT of a
modern app via the UIA TextPattern (DocumentRange.GetText), where the native
window_text (native HWNDs only) and uia_get_value (single-line value fields) cannot
reach. Verified against Chrome navigated to a known-text page."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
from browser import Browser


def main():
    b = Browser(port=29229)
    marker = "DAOFLOW-MARKER-7"
    b.navigate(f"data:text/html,<h1>{marker}</h1><p>the%20floor%20reads%20me</p>")
    time.sleep(1.2)
    ch = next((w for w in osctl.list_windows()
               if "Chrome" in (w.get("title") or "")
               or "Chromium" in (w.get("title") or "")), None)
    if not ch:
        print("[FAIL] no chrome"); return
    txt = ""
    for _ in range(10):
        txt = osctl.uia_text(ch["id"], ctype="Document")
        if marker in txt:
            break
        time.sleep(0.5)
    print(f"uia_text(Document) [{len(txt)} chars] -> {txt[:120]!r}")
    print(f"[{'PASS' if marker in txt and 'reads me' in txt else 'FAIL'}] "
          f"uia_text reads modern-app page text via TextPattern")
    val = osctl.uia_get_value(ch["id"], ctype="Document")
    print(f"uia_get_value(Document) -> {val[:40]!r}")
    print(f"[{'PASS' if marker not in val else 'FAIL'}] "
          f"ValuePattern does NOT carry the document body (TextPattern is necessary)")
    b.navigate("about:blank")


if __name__ == "__main__":
    main()
