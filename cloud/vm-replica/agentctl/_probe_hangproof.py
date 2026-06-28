"""F194 — a READ verb must never hang the agent, even on a provider that wedges a
single COM call deep in a descendant search.

The native file-save dialog DB Browser opens carries a *virtualised shell list*
(the file browser). A descendant search across it blocks indefinitely inside one
COM call — FindAll and a hand-rolled RawViewWalker step both wedge (measured, see
JOURNAL F194), so a deadline checked *between* calls never fires. The cure is to
run every element-resolving verb on an abandonable daemon worker with its own COM
apartment + UIA (generalising F193 from invoke to all reads): a wedged worker is
abandoned and the verb returns its empty default within `_FIND_TIMEOUT`.

Proof oracle:
  * uia_get_value / uia_find / uia_text on the wedging dialog RETURN (empty),
    each in < timeout+slack, instead of never returning.
  * the agent is still alive after — a normal read on the main window still
    works fast and correct (the decorator does not break the common path).
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl
import _uia_win as U

VK_ESC = 0x1B
SLACK = U._FIND_TIMEOUT + 4.0  # a guarded call may take up to the timeout, plus slack

ok = 0; total = 0
def check(name, cond, extra=""):
    global ok, total
    total += 1
    print(("  PASS " if cond else "  FAIL ") + name + ((" :: " + extra) if extra else ""), flush=True)
    if cond: ok += 1

def fw(*subs):
    for w in osctl.list_windows():
        t = (w.get("title") or "")
        if any(s.lower() in t.lower() for s in subs):
            return w

app = fw("DB Browser", "SQLite"); assert app, "DB Browser not found"
wid = app["id"]

# Normal path still works fast: locate the New Database button by meaning.
t0 = time.time()
btn = osctl.uia_find(wid, name="New Database", ctype="button")
dt = time.time() - t0
check("normal uia_find still works + fast", bool(btn) and dt < 5.0,
      f"{btn['name'] if btn else None} in {dt:.2f}s")

# Open the wedging native file dialog by meaning (F193 returns even though modal blocks).
osctl.uia_invoke(wid, name="New Database", ctype="button", timeout=6.0)
time.sleep(1.3)
dlg = fw("Choose a filename", "save under")
check("native file dialog is up", bool(dlg), dlg["title"] if dlg else "none")
did = dlg["id"] if dlg else wid

# The crux: reads on the wedging dialog must RETURN (empty) within the timeout, not hang.
for verb, call, empty in (
    ("uia_get_value", lambda: osctl.uia_get_value(did, ctype="edit"), ""),
    ("uia_find",      lambda: osctl.uia_find(did, ctype="edit"),      None),
    ("uia_text",      lambda: osctl.uia_text(did, ctype="document"),  ""),
):
    t0 = time.time()
    r = call()
    dt = time.time() - t0
    check(f"{verb}(wedging dialog) returned within timeout (no hang)",
          dt < SLACK, f"returned={r!r} in {dt:.2f}s")

# The agent is still alive: dismiss the dialog and re-read the main window fast.
osctl.key_down(VK_ESC); osctl.key_up(VK_ESC)
time.sleep(0.8)
t0 = time.time()
again = osctl.uia_find(wid, name="New Database", ctype="button")
dt = time.time() - t0
check("agent still alive after the wedge (main window re-read works)",
      bool(again) and dt < 5.0, f"{again['name'] if again else None} in {dt:.2f}s")

print(f"\nF194 {ok}/{total}", flush=True)
sys.exit(0 if ok == total else 1)
