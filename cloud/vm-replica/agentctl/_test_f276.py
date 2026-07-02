"""F276 click_verify — click, confirm the effect landed, re-click until it does.

Pure, no display: osctl.click is stubbed with a counter so we exercise the
retry/idempotence/health-signal logic without touching real input. Validates:
already-satisfied -> zero clicks (idempotent); effect after exactly K misses ->
K+... clicks and ok; never-satisfied -> ok False after `tries` presses; clicks
count reported; check polled before first press; settle=0 tight loop safe.
"""
import sys, time
sys.path.insert(0, ".")
import osctl

cv = osctl.click_verify
n = 0


def ck(cond, msg=""):
    global n
    assert cond, msg
    n += 1


# stub the real actuator: count presses, never move a mouse
presses = {"n": 0}
_orig_click = osctl.click
osctl.click = lambda x=None, y=None, right=False: presses.__setitem__("n", presses["n"] + 1)

try:
    # 1) effect already present -> returns immediately, fires zero clicks
    presses["n"] = 0
    r = cv(10, 10, check=lambda: True)
    ck(r["ok"] is True and r["clicks"] == 0, r)
    ck(presses["n"] == 0, presses)                     # never pressed

    # 2) effect appears after the FIRST press -> ok, exactly one click
    presses["n"] = 0
    state = {"lit": False}
    def check2():
        # becomes true only once at least one press has happened
        return presses["n"] >= 1
    r = cv(10, 10, check=check2, settle=0.2)
    ck(r["ok"] is True and r["clicks"] == 1, r)

    # 3) a systematic miss: takes 3 presses before it takes
    presses["n"] = 0
    def check3():
        return presses["n"] >= 3
    r = cv(10, 10, check=check3, tries=5, settle=0.1)
    ck(r["ok"] is True and r["clicks"] == 3, r)         # nagged twice more, then landed

    # 4) never lands within tries -> ok False, exactly `tries` presses fired
    presses["n"] = 0
    r = cv(10, 10, check=lambda: False, tries=4, settle=0.05)
    ck(r["ok"] is False and r["clicks"] == 4, r)
    ck(r["tries"] == 4, r)

    # 5) clicks is a health signal: first-try landing reads as 1
    presses["n"] = 0
    r = cv(10, 10, check=lambda: presses["n"] >= 1, tries=3, settle=0.1)
    ck(r["clicks"] == 1, r)

    # 6) tries floored at 1 even if caller passes 0/neg
    presses["n"] = 0
    r = cv(10, 10, check=lambda: False, tries=0, settle=0.0)
    ck(r["clicks"] == 1 and r["ok"] is False, r)        # still presses once

    # 7) settle=0 tight poll loop does not hang, returns promptly
    presses["n"] = 0
    t0 = time.monotonic()
    r = cv(10, 10, check=lambda: False, tries=2, settle=0.0)
    ck(r["clicks"] == 2 and (time.monotonic() - t0) < 1.0, r)

    # 8) right-click path also counts a press
    presses["n"] = 0
    r = cv(10, 10, check=lambda: presses["n"] >= 1, right=True)
    ck(r["ok"] is True and r["clicks"] == 1, r)

    # 9) check is consulted BEFORE first press (idempotent guard), stateful proof
    presses["n"] = 0
    seen = {"pre": None}
    def check9():
        if seen["pre"] is None:
            seen["pre"] = presses["n"]     # record press count at first consult
        return True
    r = cv(10, 10, check=check9)
    ck(seen["pre"] == 0 and r["clicks"] == 0, (seen, r))
finally:
    osctl.click = _orig_click

print(f"F276 OK: click_verify is idempotent when the effect is already present, "
      f"re-clicks a dropped actuation until it lands, gives up after `tries` with "
      f"ok=False, and reports a click count as an actuation-health signal "
      f"({n} checks)")
