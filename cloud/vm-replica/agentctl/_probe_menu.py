"""Standalone live reproduction of F164 on Windows: window_menu reads an app's
command vocabulary (menu tree with ids), and invoke_menu executes one by id —
no menu opened, no mouse, no focus. Verified by invoking Notepad's Time/Date
command and observing the timestamp it inserts into the Edit. Run alone."""
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def find_item(items, needle):
    for it in items:
        if needle.lower() in (it.get("label") or "").lower() and it.get("id"):
            return it
        hit = find_item(it.get("items") or [], needle)
        if hit:
            return hit
    return None


def main():
    p = subprocess.Popen(["notepad.exe"])
    osctl.wait_window("Notepad", timeout=8.0)
    time.sleep(1.0)
    note = next((w for w in osctl.list_windows()
                 if "Notepad" in (w.get("title") or "")
                 or "Untitled" in (w.get("title") or "")), None)
    try:
        if not note:
            print("[FAIL] no notepad"); return
        menu = osctl.window_menu(note["id"])
        labels = [m.get("label") for m in menu]
        print(f"top-level menu labels: {labels}")
        print(f"[{'PASS' if menu else 'FAIL'}] window_menu reads a menu tree -> {bool(menu)}")
        has = all(any(k in (l or "") for l in labels) for k in ("File", "Edit", "Help"))
        print(f"[{'PASS' if has else 'FAIL'}] it contains File/Edit/Help (the app's "
              f"command vocabulary) -> {labels}")
        td = find_item(menu, "Date")
        print(f"[{'PASS' if td else 'FAIL'}] the Time/Date command is found with an id "
              f"-> {td}")
        if not td:
            return
        edit = next((k for k in osctl.child_windows(note["id"])
                     if k["class"] == "Edit"), None)
        osctl.set_window_text(edit["id"], "")
        time.sleep(0.2)
        before = osctl.window_text(edit["id"])
        ok = osctl.invoke_menu(note["id"], td["id"])
        time.sleep(0.4)
        after = osctl.window_text(edit["id"])
        print(f"[{'PASS' if ok else 'FAIL'}] invoke_menu delivered the command -> {ok}")
        looks_like_time = bool(re.search(r"\d{1,2}:\d{2}", after))
        print(f"[{'PASS' if after and after != before and looks_like_time else 'FAIL'}] "
              f"invoking it BY ID (no menu opened, no mouse) inserted a timestamp -> "
              f"{after!r}")
    finally:
        try:
            osctl.terminate_window(note["id"]) if note else p.terminate()
        except Exception:
            p.terminate()
        os.system("taskkill /F /IM notepad.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
