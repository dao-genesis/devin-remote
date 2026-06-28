"""F206 — `wait_control` / `wait_control_gone`: semantic synchronization in time.

A GUI is a process in time *within* a window, not only at window birth. Clicking a
menu item opens a dialog whose OK button appears a beat later; a panel expands; a list
finishes loading; a "Loading…" spinner clears. The floor could wait for a whole new
*window* (`wait_window`) or for *pixels* (`wait_pixel`), but had no way to wait for a
control to become **operable by meaning** inside an existing window — so a multi-step
interaction either raced the control's birth (acted too early, found nothing) or slept
a fixed guess. `wait_control` polls `uia_find` until the control is present; its dual
`wait_control_gone` waits until one disappears (the readiness gate that is something
*leaving*). This proves both against a window that changes *after* it is already up:

  1. a control present from the start is returned immediately;
  2. a control that only appears ~1.4s later is waited for and then returned;
  3. a control that never appears returns None at the deadline (honest timeout);
  4. a spinner that is removed ~2.6s later is waited-out by wait_control_gone.

Run: ``C:\\devin\\python\\python.exe _probe_waitctl.py``
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

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = "DaoDelay_%d" % (os.getpid() % 100000)
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", os.path.join(HERE, "_fixture_delay.ps1"),
                         "-Title", TITLE])
wid = None
try:
    # find the window the instant it is born — the race wait_control must absorb
    for _ in range(40):
        time.sleep(0.2)
        c = [w for w in osctl.list_windows() if TITLE in (w.get("title") or "")]
        if c:
            wid = c[0]["id"]
            break
    osctl.activate_window(wid)

    # 1. a control present from the start returns fast
    t0 = time.time()
    f = osctl.wait_control(wid, name="field", timeout=5)
    check("control present from the start is returned quickly",
          bool(f) and f.get("name") == "field" and (time.time() - t0) < 2.0,
          f"dt={time.time()-t0:.2f}s")

    # 2. the "ready" button is NOT there yet, then appears ~1.4s later
    not_yet = osctl.uia_find(wid, name="ready")
    t0 = time.time()
    r = osctl.wait_control(wid, name="ready", timeout=6)
    dt = time.time() - t0
    check("a control that appears late is waited for, then returned",
          not_yet is None and bool(r) and r.get("name") == "ready" and dt >= 0.3,
          f"absent_at_start={not_yet is None} waited={dt:.2f}s")

    # 3. a control that never appears times out to None (honest)
    t0 = time.time()
    none = osctl.wait_control(wid, name="nonexistent_zzz", timeout=1.2)
    dt = time.time() - t0
    check("a control that never appears returns None at the deadline",
          none is None and dt >= 1.1, f"dt={dt:.2f}s")

    # 4. wait_control_gone on a PERMANENT control honestly blocks then times out
    t0 = time.time()
    stuck = osctl.wait_control_gone(wid, name="field", timeout=1.2)
    dt = time.time() - t0
    check("wait_control_gone on a control that never leaves times out False",
          stuck is False and dt >= 1.1, f"result={stuck} dt={dt:.2f}s")

    # 5. the spinner is removed ~2.6s after load — wait_control_gone reports it gone
    gone = osctl.wait_control_gone(wid, name="spinner", timeout=6)
    check("a removed control is reported gone by wait_control_gone", gone is True,
          f"gone={gone} spinner_now={osctl.uia_find(wid, name='spinner')}")
finally:
    try:
        if wid:
            osctl.close_window(wid)
    except Exception:
        pass
    try:
        proc.terminate()
    except Exception:
        pass
    time.sleep(0.4)

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
