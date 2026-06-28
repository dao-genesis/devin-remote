"""F178 write/read/invoke proof on a GTK target (full EditableText + Action).
Drive a zenity entry dialog purely by MEANING — no pixels, no keystrokes:
set the entry text, read it back, then press OK by name. zenity prints the
submitted value to stdout, which is independent ground truth."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

TITLE = "DAO-SEMANTIC"
VALUE = "operated purely by meaning"


def find_window(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title", "") or "").lower():
            return w
    return None


def main():
    env = dict(os.environ, DISPLAY=":0")
    p = subprocess.Popen(
        ["zenity", "--entry", "--title", TITLE, "--text", "type here by meaning:"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
    win = None
    for _ in range(40):
        time.sleep(0.25)
        w = find_window(TITLE)
        if w:
            win = w["id"]
            break
    if not win:
        print("[FAIL] zenity dialog never appeared")
        p.kill()
        return
    print(f"window id={win} title={find_window(TITLE)['title']!r}")

    set_ok = osctl.uia_set_value(win, VALUE, ctype="text")
    time.sleep(0.3)
    back = osctl.uia_get_value(win, ctype="text")
    print(f"[{'PASS' if set_ok else 'FAIL'}] uia_set_value typed by meaning — ok={set_ok}")
    print(f"[{'PASS' if back == VALUE else 'FAIL'}] uia_get_value reads it back — {back!r}")

    inv_ok = osctl.uia_invoke(win, name="OK", ctype="button")
    try:
        submitted = (p.communicate(timeout=5)[0] or "").strip()
    except subprocess.TimeoutExpired:
        p.kill()
        submitted = "<dialog did not submit>"
    print(f"[{'PASS' if inv_ok else 'FAIL'}] uia_invoke('OK') fired — ok={inv_ok}")
    print(f"[{'PASS' if submitted == VALUE else 'FAIL'}] zenity STDOUT proves the "
          f"semantic submit — {submitted!r}")


if __name__ == "__main__":
    main()
