"""F184 proof — drive *real installed third-party apps* by meaning, exercising the
two primitives that practice on them forced into being:

  * uia_find matching on **AutomationId / HelpText**, not just Name — so icon-only
    toolbars (paint.net) whose controls have an empty Name are still addressable by
    their stable semantic handle.
  * **uia_find_all** — the plural of uia_find: read a *collection* by meaning (a
    file-manager's rows) that lives far below the top window where uia_children
    (direct children only) is blind.

Self-contained: launches the apps it needs, asserts, and reports PASS/FAIL.
Exits non-zero if any check fails. Run: python _probe_appfloor.py"""
import os, sys, time, subprocess
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

NPP_7Z = r"C:\Program Files\7-Zip\7zFM.exe"
PDN = r"C:\Program Files\paint.net\paintdotnet.exe"
PASS = FAIL = 0

def chk(cond, label, detail=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  [PASS] {label}  {detail}")
    else:    FAIL += 1; print(f"  [FAIL] {label}  {detail}")

def fw(sub):
    for w in osctl.list_windows():
        if sub.lower() in (w.get("title") or "").lower():
            return w
    return None

def ensure(sub, exe, args=None):
    w = fw(sub)
    if w: return w
    subprocess.Popen([exe] + (args or []))
    for _ in range(40):
        w = fw(sub)
        if w: return w
        time.sleep(0.5)
    return None

# ---- paint.net: address icon buttons by AutomationId (Name is empty) -----------
print("== paint.net: address-by-AutomationId (icon toolbar) ==")
p = ensure("Paint.NET", PDN)
if not p:
    chk(False, "paint.net launched")
else:
    osctl.activate_window(p["id"]); time.sleep(1.0)
    for aid in ("foreColorRectangle", "backColorRectangle", "documentListButton"):
        f = osctl.uia_find(p["id"], name=aid)
        chk(bool(f and f.get("aid") == aid and f.get("rect")),
            f"uia_find resolves nameless button by AutomationId {aid!r}",
            str(f.get("rect") if f else None))
    chk(osctl.uia_find(p["id"], name="no_such_automation_id_zzz") is None,
        "a bogus id resolves to None (no false positives)")
    # the same control's accessible Name really is empty — proves aid was essential
    fc = osctl.uia_find(p["id"], name="foreColorRectangle")
    chk(bool(fc) and (fc.get("name") or "") == "",
        "the addressed control's Name is genuinely empty (aid was required)")

# ---- 7-Zip: read a collection by meaning + navigate, with uia_find_all oracle ---
print("== 7-Zip: read+navigate a file list by meaning (uia_find_all) ==")
z = ensure("7-Zip", NPP_7Z)
if not z:
    chk(False, "7-Zip launched")
else:
    wid = z["id"]; osctl.activate_window(wid); time.sleep(0.8)
    rows0 = [i["name"] for i in osctl.uia_find_all(wid, ctype="listitem")]
    chk(len(rows0) > 0, "uia_find_all reads the file-list rows (uia_children is blind here)", str(rows0))
    comp = osctl.uia_find(wid, name="Computer", ctype="listitem")
    chk(bool(comp and comp.get("rect")), "addressed 'Computer' row by meaning", str(comp.get("rect") if comp else None))
    if comp:
        x, y, w, h = comp["rect"]
        osctl.click(x + w // 2, y + h // 2); time.sleep(0.2)
        osctl.click(x + w // 2, y + h // 2); time.sleep(1.2)
        rows1 = [i["name"] for i in osctl.uia_find_all(wid, ctype="listitem")]
        chk(rows1 and rows1 != rows0,
            "entering 'Computer' by meaning changed the list (oracle via uia_find_all)",
            f"{rows0} -> {rows1}")

print(f"\n==== {PASS} PASS / {FAIL} FAIL ====")
sys.exit(1 if FAIL else 0)
