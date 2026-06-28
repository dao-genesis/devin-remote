"""F187 proof — "choose-one" by meaning where the control has no SelectionItemPattern.

`uia_select` spoke only SelectionItemPattern. A Qt `QTabBar` tab means exactly
"choose this page" yet models **only InvokePattern** — so `uia_select` returned False
and the floor could not switch a tab by meaning in a whole class of real apps
(DB Browser, and Qt apps generally). `uia_select` now falls back to invoking the
element when the selection pattern is absent/fails — the same human gesture.

Oracle: DB Browser's data grid (`sages` table) exists only on the *Browse Data* tab,
so finding a known cell by meaning proves which tab is live. Run:

    C:\\devin\\python\\python.exe _probe_qttabs.py
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, ".")
import osctl  # noqa: E402

DBEXE = r"C:\Program Files\DB Browser for SQLite\DB Browser for SQLite.exe"
DBFILE = r"C:\Users\Administrator\dao_demo.db"
PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    ok = bool(cond)
    PASS += ok
    FAIL += not ok
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, ("  " + extra) if extra else ""))


def win(substr):
    for w in osctl.list_windows():
        if substr.lower() in (w.get("title") or "").lower():
            return w
    return None


# Build the demo db if missing.
if not os.path.exists(DBFILE):
    import sqlite3
    c = sqlite3.connect(DBFILE)
    c.execute("CREATE TABLE sages(id INTEGER PRIMARY KEY, name TEXT, saying TEXT)")
    c.executemany("INSERT INTO sages(name,saying) VALUES(?,?)",
                  [("Laozi", "wuwei"), ("Zhuangzi", "free"), ("Confucius", "learn")])
    c.commit()
    c.close()

d = win("DB Browser")
if not d:
    subprocess.Popen([DBEXE, DBFILE])
    for _ in range(20):
        time.sleep(0.6)
        d = win("DB Browser")
        if d:
            break
    time.sleep(2)
osctl.activate_window(d["id"])
time.sleep(1)


def grid_has(cell):
    return osctl.uia_find(d["id"], name=cell, ctype="dataitem") is not None


print("== DB Browser (Qt) :: a tab means 'choose me' but has no SelectionItemPattern ==")
# 1) the read dual is None — the tab does NOT model SelectionItemPattern at all.
osctl.uia_select(d["id"], name="Browse Data", ctype="tabitem")
time.sleep(0.6)
check("Qt tab exposes no SelectionItemPattern (uia_is_selected is None)",
      osctl.uia_is_selected(d["id"], name="Browse Data", ctype="tabitem") is None)

print("== uia_select drives the Qt tab by meaning (Invoke fallback) ==")
# 2) leave Browse Data -> the grid's cells disappear.
ok1 = osctl.uia_select(d["id"], name="Execute SQL", ctype="tabitem")
time.sleep(0.9)
check("uia_select('Execute SQL') returned True", ok1)
check("grid gone after leaving Browse Data (cell 'Laozi' not found)", not grid_has("Laozi"))

# 3) return to Browse Data by meaning -> the grid's cells come back.
ok2 = osctl.uia_select(d["id"], name="Browse Data", ctype="tabitem")
time.sleep(0.9)
check("uia_select('Browse Data') returned True", ok2)
check("grid back after selecting Browse Data (cell 'Laozi' found)", grid_has("Laozi"))

print("== a grid cell is read by meaning; a bogus tab fails cleanly ==")
# 4) the data grid itself is fully addressable by meaning (no new verb needed).
cells = [c["name"] for c in osctl.uia_find_all(d["id"], ctype="dataitem") if c["name"]]
check("grid cells read by meaning (Laozi/Zhuangzi/Confucius)",
      all(n in cells for n in ("Laozi", "Zhuangzi", "Confucius")), str(cells[:6]))
# 5) negative — a tab that does not exist returns False.
check("uia_select('No Such Tab ZZZ') -> False",
      osctl.uia_select(d["id"], name="No Such Tab ZZZ", ctype="tabitem") is False)

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
