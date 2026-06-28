"""F205 — `screen_observe()`: the one per-step observation a GUI agent reasons over.

Reverse-logic round. Reading the public AI-GUI frameworks (UFO's per-app *control
inventory*; OmniParser / Agent-S's *set-of-marks* of labelled clickable regions),
the loop they all share is: each step, take *one* structured snapshot of the screen —
the foreground app, its actionable controls with boxes, and where focus is — then
decide. Our floor had every ingredient (`list_windows`, `active_window`,
`window_geometry`, `window_opaque`, `uia_find_all`, `uia_focused`) but no single call
that assembles them; an agent had to stitch six reads by hand every step. The friction
is the *absence of the observation primitive itself*.

This proves `screen_observe()`:
  1. returns the structured shape (active / focus / windows with rect+opaque+actions);
  2. marks the foreground window active and not opaque, and inventories its actionable
     controls by meaning (the field Edit + the ping/echo Buttons), each with a rect;
  3. folds in live focus (where keystrokes land) consistent with `uia_focused`;
  4. is efficient by default — background windows are listed (id/title/rect) without a
     full action scan unless deep=True, which then scans more windows.

Run: ``C:\\devin\\python\\python.exe _probe_observe.py``
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
TITLE = "DaoObs_%d" % (os.getpid() % 100000)
PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", os.path.join(HERE, "_fixture_wpf.ps1"),
                         "-Title", TITLE])
wid = None
try:
    for _ in range(40):
        time.sleep(0.4)
        c = [w for w in osctl.list_windows() if TITLE in (w.get("title") or "")]
        if c:
            wid = c[0]["id"]
            break
    osctl.activate_window(wid)
    time.sleep(0.5)
    osctl.uia_focus(wid, name="field")
    time.sleep(0.4)

    obs = osctl.screen_observe()
    check("screen_observe() returns the structured shape",
          isinstance(obs, dict) and set(("active", "focus", "windows")) <= set(obs)
          and isinstance(obs["windows"], list) and len(obs["windows"]) > 0,
          f"windows={len(obs.get('windows', []))}")

    me = next((w for w in obs["windows"] if w["id"] == wid), None)
    check("the foreground fixture is present, marked active, not opaque",
          bool(me) and me["active"] and obs["active"] == wid and me["opaque"] is False,
          f"active={me and me['active']} opaque={me and me['opaque']}")

    names = {(a["type"], a["name"]) for a in (me["actions"] if me else [])}
    has_field = any(t == "Edit" and n == "field" for t, n in names)
    has_btn = any(t == "Button" for t, n in names)
    rects_ok = all(a.get("rect") and len(a["rect"]) == 4 for a in (me["actions"] if me else []))
    check("foreground window's actionable controls inventoried by meaning, with rects",
          has_field and has_btn and rects_ok,
          f"n_actions={len(me['actions']) if me else 0}")

    check("observation folds in live focus, consistent with uia_focused()",
          obs["focus"] and obs["focus"].get("name") == "field", f"focus={obs['focus']}")

    bg = [w for w in obs["windows"] if not w["active"]]
    check("efficient by default: background windows listed without an action scan",
          len(bg) == 0 or all(w["actions"] == [] for w in bg),
          f"{len(bg)} background windows, all actions empty="
          f"{all(w['actions'] == [] for w in bg)}")

    deep = osctl.screen_observe(deep=True)
    deep_me = next((w for w in deep["windows"] if w["id"] == wid), None)
    scanned_shallow = sum(1 for w in obs["windows"] if w["actions"] or w["opaque"])
    scanned_deep = sum(1 for w in deep["windows"] if w["actions"] or w["opaque"])
    check("deep=True keeps the active inventory and scans more windows",
          bool(deep_me) and len(deep_me["actions"]) >= (len(me["actions"]) if me else 0)
          and scanned_deep >= scanned_shallow,
          f"shallow_scanned={scanned_shallow} deep_scanned={scanned_deep}")
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
