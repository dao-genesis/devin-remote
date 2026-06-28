"""F207 — `uia_set_value` must target the editable field, not its same-named caption,
and never report a false success on a read-only target.

Forward practice (real Notepad++ Replace dialog) exposed two floor bugs: its label,
ComboBox and Edit are ALL named "Replace with:". (1) `_find_ptr` returned the static
Text caption (first in tree order), so a write hit an uneditable label; (2)
`uia_set_value` then returned True having changed nothing — `SetValue` on a read-only
ValuePattern returns S_OK. The net effect: Replace All ran with an empty replacement
and deleted every "alpha" instead of replacing it. Fixes: when no `ctype` is pinned, an
exact name match on a `Text` control is held only as a fallback so an actionable
control with the same name wins; and `uia_set_value` refuses a read-only ValuePattern.

This reproduces it deterministically (a TextBlock + TextBox both named "email"; a
read-only TextBox named "locked"; a unique "solo"):
  1. set_value(name="email") writes into the TEXTBOX, not the label — read-back matches;
  2. find(name="email") returns the actionable control, not the static Text caption;
  3. set_value(name="locked") returns False (read-only) and leaves the value unchanged;
  4. set_value(name="solo") still works (no regression for unambiguous fields);
  5. disambiguation by explicit ctype still works.

Run: ``C:\\devin\\python\\python.exe _probe_setvalue.py``
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
TITLE = "DaoDup_%d" % (os.getpid() % 100000)
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", os.path.join(HERE, "_fixture_dup.ps1"),
                         "-Title", TITLE])
wid = None
try:
    for _ in range(40):
        time.sleep(0.3)
        c = [w for w in osctl.list_windows() if TITLE in (w.get("title") or "")]
        if c:
            wid = c[0]["id"]
            break
    osctl.activate_window(wid)
    time.sleep(0.5)

    # 1. write into the field that shares its name with a caption
    ok = osctl.uia_set_value(wid, "user@dao", name="email")
    box = osctl.uia_get_value(wid, name="email", ctype="Edit")
    check("set_value(name) writes into the editable field, not the same-named label",
          ok is True and box == "user@dao", f"ok={ok} box={box!r}")

    # 2. find-by-name returns the actionable control, not the static Text caption
    f = osctl.uia_find(wid, name="email")
    check("find-by-name prefers the actionable control over the Text caption",
          bool(f) and f.get("type") != "Text", f"got type={f and f.get('type')}")

    # 3. read-only target: honest False, value untouched (no false success)
    ro_ok = osctl.uia_set_value(wid, "HACKED", name="locked")
    ro_val = osctl.uia_get_value(wid, name="locked", ctype="Edit")
    check("set_value on a read-only target returns False and changes nothing",
          ro_ok is False and ro_val == "ORIG", f"ok={ro_ok} val={ro_val!r}")

    # 4. unambiguous field still works (regression)
    s_ok = osctl.uia_set_value(wid, "hello", name="solo")
    s_val = osctl.uia_get_value(wid, name="solo", ctype="Edit")
    check("an unambiguously-named field is still settable",
          s_ok is True and s_val == "hello", f"ok={s_ok} val={s_val!r}")

    # 5. explicit ctype disambiguation still works
    c_ok = osctl.uia_set_value(wid, "typed@dao", name="email", ctype="Edit")
    c_val = osctl.uia_get_value(wid, name="email", ctype="Edit")
    check("explicit ctype still targets the editable control",
          c_ok is True and c_val == "typed@dao", f"ok={c_ok} val={c_val!r}")
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
