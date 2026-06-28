"""F193 — a button that opens a MODAL dialog must not hang the agent.

InvokePattern::Invoke is *synchronous* in an STA: invoking a control whose handler
spins a modal dialog (DB Browser's "New Database" -> a Save file dialog) does not
return until that dialog closes, so a naive uia_invoke freezes the agent forever.
uia_invoke now dispatches on a daemon thread with a timeout: it returns promptly
(the modal is up, ready to operate) instead of hanging.

The native Win32 file dialog's virtualized shell list view stalls UIA's FindAll
(FindAll traverses the WHOLE subtree to collect matches — see the F194 frontier note
in JOURNAL), so the dialog itself is driven through the floor's *keyboard* channel.
The floor's two channels — meaning (uia_*) and keys/pixels — together complete what
either alone cannot. Oracle: the database file actually appears on disk."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

DBPATH = r"C:\Users\Administrator\daoprobe.db"
VK_CTRL, VK_A, VK_ENTER, VK_ESC = 0x11, 0x41, 0x0D, 0x1B

def fw(*subs):
    for w in osctl.list_windows():
        t = (w.get("title") or "")
        if any(s.lower() in t.lower() for s in subs):
            return w

ok = 0; total = 0
def check(name, cond, extra=""):
    global ok, total
    total += 1
    print(("  PASS " if cond else "  FAIL ") + name + ((" :: " + extra) if extra else ""), flush=True)
    if cond: ok += 1

try:
    os.remove(DBPATH)
except OSError:
    pass

app = fw("DB Browser", "SQLite"); assert app, "DB Browser not found"
wid = app["id"]

# 1) Invoke a MODAL-opening button BY MEANING — must return promptly, not hang (F193).
t0 = time.time()
r = osctl.uia_invoke(wid, name="New Database", ctype="button", timeout=6.0)
dt = time.time() - t0
check("uia_invoke(modal button) returned without hanging", dt < 9.0 and r is True, f"returned={r} in {dt:.2f}s")

time.sleep(1.2)
dlg = fw("Choose a filename", "save under")
check("modal dialog is up after invoke", bool(dlg), dlg["title"] if dlg else "no dialog")

# 2) Drive the native file dialog via the keyboard channel: select-all, type path, accept.
osctl.key_down(VK_CTRL); osctl.key_down(VK_A); osctl.key_up(VK_A); osctl.key_up(VK_CTRL)
time.sleep(0.2)
osctl.type_unicode(DBPATH)
time.sleep(0.3)
osctl.key_down(VK_ENTER); osctl.key_up(VK_ENTER)
time.sleep(2.0)

# DB Browser opens "Edit table definition" after creating the DB; dismiss it by keys.
if fw("Edit table definition"):
    osctl.key_down(VK_ESC); osctl.key_up(VK_ESC)
    time.sleep(0.8)

# 3) Oracle: the app acted — the modal is gone and the database exists on disk.
check("save dialog dismissed", not fw("Choose a filename", "save under"))
check("database file created on disk (flow completed end-to-end)", os.path.exists(DBPATH), DBPATH)

print(f"\nF193 {ok}/{total}", flush=True)
