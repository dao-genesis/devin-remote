"""F200 — operate an app that lives ENTIRELY in the system tray (notification area),
the deepest zero-pixel surface: it owns no top-level window at all.

F192 drove a *minimized* window by meaning; F199 drove a window on another *virtual
desktop*. Both still had a window in ``list_windows``. An app minimised to the tray
has **none** — its only presence is a NotifyIcon inside ``Shell_TrayWnd``, an untitled
shell window the floor never enumerates. So the meaning-floor's window list gives no
hint the app is even alive. This proves the floor closes that gap:

  1. the fixture has NO top-level window in list_windows (pure tray residency)
  2. tray_icons() discovers its icon by MEANING (the NotifyIcon tooltip)
  3. tray_context() right-clicks it and picks a menu item by meaning, and the effect
     lands (a sentinel file the hidden app writes) — with no visible window touched
  4. honest scope: the taskbar's own buttons (Start/Search/Task View) are NOT tray
     icons and tray_icons() excludes them.

Run: ``C:\\devin\\python\\python.exe _probe_tray.py``
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
TITLE = "DaoTray_%d" % (os.getpid() % 100000)
SENT = os.path.join(os.environ.get("TEMP", HERE), "daotray_%d.txt" % (os.getpid() % 100000))
if os.path.exists(SENT):
    os.remove(SENT)

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")


def sentinel_has(tag, tries=20):
    for _ in range(tries):
        try:
            if os.path.exists(SENT) and tag in open(SENT, encoding="utf-8").read():
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                         "-File", os.path.join(HERE, "_fixture_tray.ps1"),
                         "-Title", TITLE, "-Sentinel", SENT])
try:
    # wait for the icon to register in the tray
    icon = None
    for _ in range(40):
        time.sleep(0.4)
        for ic in osctl.tray_icons():
            if TITLE.lower() in (ic.get("name") or "").lower():
                icon = ic
                break
        if icon:
            break
    print("tray icon:", icon)

    # 1) no top-level window: the app is invisible to the window list
    titles = [(w.get("title") or "") for w in osctl.list_windows()]
    no_win = not any(TITLE.lower() in t.lower() for t in titles)
    check("app has NO top-level window (pure tray residency)", no_win,
          f"windows={titles}")

    # 2) discovered by meaning
    check("tray_icons() discovers the icon by meaning (tooltip)",
          icon is not None and TITLE.lower() in (icon.get("name") or "").lower(),
          f"name={icon.get('name') if icon else None!r}")
    check("icon carries a screen rect (loop closes to the mouse)",
          bool(icon and icon.get("rect")), f"rect={icon.get('rect') if icon else None}")

    # 3) operate it end-to-end by meaning: right-click -> 'Ping Sentinel'
    ok_ping = osctl.tray_context(TITLE, "Ping Sentinel")
    check("tray_context right-clicks + picks 'Ping Sentinel' by meaning", ok_ping)
    check("the effect landed (hidden app wrote PING) — no visible window touched",
          sentinel_has("PING"), f"sentinel={SENT}")

    # a second menu item, to show the path-walk is general
    ok_mark = osctl.tray_context(TITLE, "Mark Done")
    check("tray_context picks a different item ('Mark Done') by meaning", ok_mark)
    check("its effect landed (MARK written)", sentinel_has("MARK"))

    # 4) honest scope: the Start button is on the taskbar, not the tray
    names = [(ic.get("name") or "") for ic in osctl.tray_icons()]
    check("tray_icons excludes taskbar buttons (Start/Search/Task View)",
          not any(n in ("Start", "Task View", "Type here to search") for n in names),
          f"names={names}")

    # cleanly quit the fixture through its own tray menu (proves Quit too)
    osctl.tray_context(TITLE, "Quit")
    time.sleep(1.0)
finally:
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        if os.path.exists(SENT):
            os.remove(SENT)
    except Exception:
        pass

print(f"\n==== {len(PASS)} PASS / {len(FAIL)} FAIL ====")
sys.exit(1 if FAIL else 0)
