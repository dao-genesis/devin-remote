"""F189 proof — write a field by meaning where ValuePattern reads but won't write.

`uia_set_value` wrote through the UIA ValuePattern only. A control may expose that
pattern for *reading* yet reject ``SetValue``: Audacity's wxWidgets number fields read
back fine but their SetValue is a silent no-op, so the floor could read a field it could
not fill. `uia_set_value` now falls back to the keyboard floor (focus → select-all →
type) when the pattern write fails — so "set this field" holds whether the toolkit models
a writable ValuePattern or only lets a person type.

Oracle: read the field back after writing; the value must be what we set.

    C:\\devin\\python\\python.exe _probe_wxset.py
"""
import subprocess
import sys
import time

sys.path.insert(0, ".")
import osctl  # noqa: E402

AUD = r"C:\Program Files\Audacity\Audacity.exe"
PASS = 0
FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    ok = bool(cond)
    PASS += ok
    FAIL += not ok
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, ("  " + extra) if extra else ""))


def win(substr, exclude="Welcome"):
    for w in osctl.list_windows():
        t = w.get("title") or ""
        if substr.lower() in t.lower() and exclude not in t:
            return w
    return None


a = win("Audacity")
if not a:
    subprocess.Popen([AUD])
    for _ in range(25):
        time.sleep(0.8)
        a = win("Audacity")
        if a:
            break
    time.sleep(2)
# dismiss the first-run welcome if present
wel = win("Audacity", exclude="zzz")
if wel and "Welcome" in (wel.get("title") or ""):
    osctl.activate_window(wel["id"]); time.sleep(0.3)
    osctl.uia_invoke(wel["id"], name="OK") or osctl.uia_invoke(wel["id"], name="Close")
    time.sleep(0.6)
    a = win("Audacity")
osctl.activate_window(a["id"])
time.sleep(0.6)

print("== open Generate ▸ Tone… by meaning (wx menu) ==")
ok = osctl.uia_menu(a["id"], "Generate", "Tone...")
time.sleep(1.4)
tn = win("Tone")
check("uia_menu('Generate','Tone...') opened the Tone dialog", ok and tn is not None)
osctl.activate_window(tn["id"]); time.sleep(0.5)

FREQ = ("Frequency (Hz):", "edit")
print("== the wx field reads via ValuePattern but rejects its SetValue ==")
before = osctl.uia_get_value(tn["id"], name=FREQ[0], ctype=FREQ[1])
check("frequency reads by meaning (ValuePattern read works)", before not in ("", None), repr(before))
raw_ok = osctl._uia_set_value_pattern(tn["id"], "111", name=FREQ[0], ctype=FREQ[1])
still = osctl.uia_get_value(tn["id"], name=FREQ[0], ctype=FREQ[1])
check("raw ValuePattern SetValue fails here (returns False, value unchanged)",
      raw_ok is False and still == before, "raw=%r value=%r" % (raw_ok, still))

print("== uia_set_value falls back to the keyboard floor and the value lands ==")
ok = osctl.uia_set_value(tn["id"], "432", name=FREQ[0], ctype=FREQ[1])
time.sleep(0.3)
after = osctl.uia_get_value(tn["id"], name=FREQ[0], ctype=FREQ[1])
check("uia_set_value('432') returned True", ok)
check("frequency now reads back '432' (write actually landed)", after == "432", repr(after))

print("== generate the tone; a track appears (the write was committed) ==")
osctl.uia_invoke(tn["id"], name="OK") or osctl.uia_invoke(tn["id"], name="Generate")
time.sleep(1.5)
osctl.activate_window(a["id"]); time.sleep(0.6)
tracks = [x["name"] for x in osctl.uia_find_all(a["id"], ctype="custom")
          if x["name"] and "Audio" in x["name"]]
check("a generated audio track is present, read by meaning", bool(tracks), str(tracks[:3]))

print("== a bogus field returns False cleanly ==")
check("uia_set_value(non-existent field) -> False",
      osctl.uia_set_value(a["id"], "x", name="No Such Field ZZZ", ctype="edit") is False)

print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
