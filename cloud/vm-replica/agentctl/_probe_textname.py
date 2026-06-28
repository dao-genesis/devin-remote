"""F191 — uia_text falls back to the accessible Name for custom editors that model
no TextPattern (Notepad++/Scintilla publishes its buffer as a Pane's Name)."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

def fw(s):
    for w in osctl.list_windows():
        if s.lower() in (w.get("title") or "").lower():
            return w

ok = 0; total = 0
def check(name, cond):
    global ok, total
    total += 1
    print(("  PASS " if cond else "  FAIL ") + name)
    if cond: ok += 1

n = fw("Notepad++"); assert n, "Notepad++ not found"
wid = n["id"]
osctl.activate_window(wid); time.sleep(0.4)

# fresh buffer: select-all + delete, then type a known unicode payload
osctl.key_down(0x11); osctl.tap(0x41); osctl.key_up(0x11)   # Ctrl+A
osctl.tap(0x2E)                                             # Delete
time.sleep(0.2)
PAYLOAD = "F191 floor 道法自然 read-by-name 12345"
osctl.type_unicode(PAYLOAD)
time.sleep(0.5)

# read the editor by meaning — the Pane has NO TextPattern, only a Name
got = osctl.uia_text(wid, ctype="pane")
print("uia_text(pane) ->", repr(got[:80]))
check("editor buffer read by meaning (Name fallback)", PAYLOAD in got)

# the title's modified star is an independent oracle that the text really landed
title = fw("Notepad++")["title"]
check("buffer truly modified (title star)", title.lstrip().startswith("*"))

print(f"\nF191 {ok}/{total}")
