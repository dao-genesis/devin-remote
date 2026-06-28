"""F208 — read a console window's text, and make `uia_text(win)` read the window's
*primary* text instead of an arbitrary first descendant.

Forward practice on a Windows console (conhost) exposed it: the whole scrollback sits on
the console's ``Document`` (a real UIA TextPattern provider), but a type-less descendant
scan reaches a scrollbar first — so ``uia_text(win)`` with no target silently returned a
scrollbar's name (8 chars), not the buffer. The content was always reachable two honest
ways the floor already had: ``uia_text(win, ctype="Document")`` and ``read_selection``
(Ctrl+A + copy, F195). The fix makes the no-target read resolve to the primary text
container (Document -> Edit) so "read this window's text" does the obvious thing.

Asserts on a real console printing a known marker:
  1. uia_text(win, ctype="Document") reads the scrollback (marker present, large);
  2. uia_text(win) with NO target now reads it too (was a scrollbar's name);
  3. read_selection (select-all + copy) reads it — the universal opaque-surface fallback;
  4. after typing a command, the new output appears in uia_text(win).

Run: ``C:\\devin\\python\\python.exe _probe_console.py``
"""
import os
import sys
import time
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
import osctl

MARK = "DAO_CONSOLE_PROBE_%d" % (os.getpid() % 100000)
TAG = "DaoConProbe_%d" % (os.getpid() % 100000)
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")

subprocess.Popen('start "%s" cmd /k echo %s' % (TAG, MARK), shell=True)
wid = None
try:
    for _ in range(30):
        time.sleep(0.5)
        c = [w for w in osctl.list_windows() if TAG in (w.get("title") or "")]
        if c:
            wid = c[0]["id"]; break
    osctl.activate_window(wid)
    time.sleep(0.8)

    doc = osctl.uia_text(wid, ctype="Document")
    check("uia_text(ctype='Document') reads the console scrollback",
          MARK in (doc or "") and len(doc or "") > 20, f"len={len(doc or '')}")

    notarget = osctl.uia_text(wid)
    check("uia_text(win) with NO target reads the primary buffer (not a scrollbar)",
          MARK in (notarget or ""), f"len={len(notarget or '')} head={ (notarget or '')[:24]!r}")

    osctl.chord(osctl.VK_CONTROL, osctl.VK_A)
    time.sleep(0.3)
    sel = osctl.read_selection()
    check("read_selection (Ctrl+A + copy) reads the console — universal fallback",
          MARK in (sel or ""), f"len={len(sel or '')}")
    # click back into the console so the next keystrokes land at the prompt
    osctl.activate_window(wid); time.sleep(0.3)
    osctl.tap(osctl.VK_ESCAPE); time.sleep(0.2)

    osctl.type_unicode("echo RESULT_4242")
    osctl.tap(osctl.VK_RETURN)
    time.sleep(0.6)
    after = osctl.uia_text(wid)
    check("new command output appears in uia_text(win)",
          "RESULT_4242" in (after or ""), f"present={'RESULT_4242' in (after or '')}")
finally:
    try:
        if wid:
            osctl.close_window(wid)
    except Exception:
        pass
    time.sleep(0.3)

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
