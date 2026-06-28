"""F190 proof — write a field by meaning where the ValuePattern *lies*.

F189 made `uia_set_value` fall back to the keyboard floor when ValuePattern.SetValue
*refused* (returned False, as on Audacity's wx number fields). But a pattern can lie the
other way: DB Browser for SQLite's SQL editor is a Qt **Scintilla** widget whose
``SetValue`` returns **success yet writes nothing** — so a verb that believed the return
code reported a write that never happened. And UIA ``SetFocus`` lies the same way on the
same widget (reports focus it did not take).

`uia_set_value` now trusts the pattern **only when a read-back confirms** the value, and
otherwise reaches for the keyboard floor focused by a **real click** on the field's centre
(a click cannot lie about focus). Oracle: type SQL by meaning, run it, and the computed
cell must appear in the results grid — proof the text truly reached the editor.

    C:\\devin\\python\\python.exe _probe_dbexec.py
"""
import os
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, ".")
import osctl  # noqa: E402

DB4 = r"C:\Program Files\DB Browser for SQLite\DB Browser for SQLite.exe"
DBF = os.path.join(os.path.expanduser("~"), "dao_demo.db")
EDITOR = ("MainWindow.centralwidget.mainTab.qt_tabwidget_stackedwidget.query.tabSqlAreas"
          ".qt_tabwidget_stackedwidget.SqlExecutionArea.splitter.widget.editEditor")
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


def run_sql(wid, sql):
    osctl.uia_set_value(wid, sql, name=EDITOR, ctype="edit")
    time.sleep(0.4)
    osctl.uia_invoke(wid, name="Execute SQL", ctype="button")
    time.sleep(1.4)
    return [x["name"] for x in osctl.uia_find_all(wid, ctype="dataitem") if x["name"]]


# a real on-disk database so the app has a query surface
if not os.path.exists(DBF):
    sqlite3.connect(DBF).close()

d = win("DB Browser")
if not d:
    subprocess.Popen([DB4, DBF])
    for _ in range(25):
        time.sleep(0.8)
        d = win("DB Browser")
        if d:
            break
    time.sleep(2)
osctl.activate_window(d["id"])
time.sleep(0.6)

print("== open the Execute SQL tab by meaning ==")
ok = osctl.uia_select(d["id"], name="Execute SQL", ctype="tabitem")
time.sleep(0.8)
check("uia_select('Execute SQL') switched the tab", ok)

print("== the Scintilla pattern LIES: SetValue returns success yet writes nothing ==")
raw_ok = osctl._uia_set_value_pattern(d["id"], "SELECT 1;", name=EDITOR, ctype="edit")
rb = osctl.uia_get_value(d["id"], name=EDITOR, ctype="edit")
check("raw ValuePattern SetValue claims success (returns True)", raw_ok is True, "raw=%r" % raw_ok)
check("yet the read-back does not confirm it (no real write)", rb != "SELECT 1;", "read=%r" % rb)

print("== uia_set_value writes by meaning anyway; the SQL runs (grid is the oracle) ==")
for sql, oracle in [("SELECT 'al'||'pha' AS v;", "alpha"),
                    ("SELECT 7*6 AS v;", "42"),
                    ("SELECT upper('dao') AS v;", "DAO")]:
    grid = run_sql(d["id"], sql)
    check("set %r by meaning -> grid shows %r" % (sql, oracle), oracle in grid, str(grid[:4]))

print("== a bogus field returns False cleanly ==")
check("uia_set_value(non-existent field) -> False",
      osctl.uia_set_value(d["id"], "x", name="No Such Field ZZZ", ctype="edit") is False)

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
