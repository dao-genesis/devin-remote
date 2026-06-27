#!/usr/bin/env python3
"""F147 live friction probe: cross-window clipboard relay.

Copy content "here", paste it into a SPECIFIC other window — by identity, not by
clicking a guessed pixel. Official screenshot+click cannot do this (no window
identity, no clipboard addressing). This proves the floor fuses four faculties:
set the clipboard, address the target window by name (focus_window, F146), and
paste with the platform's terminal-paste chord (Ctrl+Shift+V on X11 terminals,
Ctrl+V on Windows consoles). The pasted payload must land — intact — in the
intended window, not whatever held focus.

Run on a machine with a desktop:  DISPLAY=:0 python3 _probe_relay.py
Needs `konsole` on Linux; uses `cmd` on Windows.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

import osctl

MARK = os.path.join(tempfile.gettempdir(), "dao_relay_probe.txt")
PAYLOAD = "DAOPAY-7c3f"
WIN = sys.platform.startswith("win")


def launch(tag, title):
    env = dict(os.environ)
    if WIN:
        env["WTAG"] = tag
        return subprocess.Popen(["cmd", "/k", "title " + title], env=env,
                                creationflags=0x00000010)
    env["XDG_RUNTIME_DIR"] = env.get("XDG_RUNTIME_DIR", "/tmp/runtime-ubuntu")
    return subprocess.Popen(
        ["konsole", "--separate", "-p", "tabtitle=" + title, "-e",
         "env", "WTAG=" + tag, "bash", "--norc", "-i"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def paste_chord():
    # A terminal does NOT paste on Ctrl+V — X11 terminals use Ctrl+Shift+V;
    # Windows consoles accept Ctrl+V. The paste chord is app-class-specific.
    if WIN:
        osctl.chord(osctl.VK_CONTROL, osctl.VK_V)
    else:
        osctl.chord(osctl.VK_CONTROL, osctl.VK_SHIFT, osctl.VK_V)


def relay():
    var = "%WTAG%" if WIN else "$WTAG"
    osctl.type_unicode("echo " + var + " ")
    time.sleep(0.1)
    paste_chord()
    time.sleep(0.2)
    osctl.type_unicode(" > " + MARK)
    osctl.tap(osctl.VK_RETURN)
    time.sleep(0.7)


def read():
    try:
        with open(MARK) as f:
            return f.read().strip()
    except OSError:
        return ""


def main():
    if not WIN and shutil.which("konsole") is None:
        print("need konsole on this Linux host")
        return 2
    procs = [launch("A", "DAOREL-A")]
    time.sleep(2.2)
    procs.append(launch("B", "DAOREL-B"))
    time.sleep(2.4)
    try:
        osctl.set_clipboard(PAYLOAD)
        time.sleep(0.15)
        wins = osctl.list_windows()
        bb = next(w for w in wins if "DAOREL-B" in (w.get("title") or ""))

        # No addressing: B holds focus, we INTEND A -> payload lands in B (wrong).
        osctl.activate_window(bb["id"])
        time.sleep(0.5)
        try:
            os.remove(MARK)
        except OSError:
            pass
        relay()
        no_addr = read()

        # Addressed: focus A by name -> payload crosses into A (right).
        try:
            os.remove(MARK)
        except OSError:
            pass
        osctl.focus_window("DAOREL-A")
        relay()
        addr = read()

        print("no-addressing relay :", repr(no_addr), "(intended A)")
        print("focus_window relay  :", repr(addr))
        ok = (not no_addr.startswith("A")) and addr == "A " + PAYLOAD
        print("PASS" if ok else "FAIL",
              "— clipboard delivered to the addressed window, not the focused one")
        return 0 if ok else 1
    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass
        if not WIN:
            os.system("pkill -9 konsole 2>/dev/null")


if __name__ == "__main__":
    raise SystemExit(main())
