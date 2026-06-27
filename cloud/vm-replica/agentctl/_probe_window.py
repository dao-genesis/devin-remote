"""F146 — window addressing friction (live, this VM).

The floor's keyboard/clipboard act on *whatever window holds focus*. On a real
desktop with many apps open, that means input can silently land in the WRONG
window — exactly what the official screenshot+click cannot fix either (it clicks
a visible pixel, it cannot address a window by identity or raise an occluded one).

Two terminals are opened, each with a distinct env tag, both ready to run the
SAME typed command (which writes its own tag to a shared marker file). The
window that *receives* the keystrokes is the one whose tag lands in the marker.

- no addressing: window B is focused, we INTEND A -> marker = B   (WRONG)
- focus_window("WIN-A") first (F146)               -> marker = A   (RIGHT)
"""
import os
import sys
import subprocess
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl  # noqa: E402

MARK = "/tmp/dao_win_probe.txt"


def _launch(tag, title):
    # `--separate` forces a new top-level window; `-p tabtitle=` is the reliable
    # way to set konsole's window title (it ignores --title). `env WTAG=` makes
    # the SAME typed command echo a window-specific tag.
    return subprocess.Popen(
        ["konsole", "--separate", "-p", "tabtitle=" + title, "-e",
         "env", "WTAG=" + tag, "bash", "--norc", "-i"],
        env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":0"),
             "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", "/tmp/runtime-ubuntu")},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _read_mark():
    try:
        with open(MARK) as f:
            return f.read().strip()
    except OSError:
        return ""


def _run_cmd():
    # Type the command, then press Return as a real key — a literal '\n' in
    # type_unicode does NOT submit in a terminal (it lands as a stray newline).
    osctl.type_unicode("echo $WTAG > " + MARK)
    osctl.tap(osctl.VK_RETURN)
    time.sleep(0.5)


def main():
    procs = []
    try:
        procs.append(_launch("A", "WIN-A"))
        time.sleep(2.0)
        procs.append(_launch("B", "WIN-B"))
        time.sleep(2.2)

        wins = osctl.list_windows()
        print("windows seen:", [w["title"] for w in wins if "WIN-" in w["title"]])
        a = next((w for w in wins if "WIN-A" in w["title"]), None)
        b = next((w for w in wins if "WIN-B" in w["title"]), None)
        if not a or not b:
            print("FAIL: could not enumerate both windows"); return 1

        # --- Friction: B is the focused window; we INTEND to drive A. With no
        # window addressing the floor types into whatever is focused -> B. ---
        osctl.activate_window(b["id"]); time.sleep(0.4)
        try:
            os.remove(MARK)
        except OSError:
            pass
        _run_cmd()
        open_got = _read_mark()
        wrong = open_got != "A"
        print("no-addressing (intended A, B focused): marker =", repr(open_got),
              "-> WRONG (input went to B)" if wrong else "-> right")

        # --- Fix: address window A by name, then type -> lands in A. ---
        try:
            os.remove(MARK)
        except OSError:
            pass
        hit = osctl.focus_window("WIN-A")
        print("focus_window('WIN-A') ->", hit)
        _run_cmd()
        fixed_got = _read_mark()
        right = fixed_got == "A"
        print("with focus_window (F146): marker =", repr(fixed_got),
              "-> RIGHT (input went to A)" if right else "-> wrong")

        ok = wrong and right
        print("\nRESULT:", "PASS — addressing routes input to the intended window"
              if ok else "FAIL")
        return 0 if ok else 1
    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass
        time.sleep(0.3)
        os.system("pkill -9 konsole 2>/dev/null")


if __name__ == "__main__":
    raise SystemExit(main())
