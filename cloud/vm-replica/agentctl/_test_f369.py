"""F369 regression: screen_brief must project screen_observe into a compact
text block — every window titled and marked (* active, ! opaque), and the
active window's controls deduplicated by (name,type), command-like types
first, capped at max_controls, unnamed controls dropped.

Backend-agnostic: screen_observe is faked so the test runs without live X11."""
import osctl

FAKE = {
    "active": 42,
    "focus": None,
    "windows": [
        {"id": 1, "title": "Desktop", "rect": (0, 0, 100, 100),
         "active": False, "opaque": False, "actions": []},
        {"id": 7, "title": "Painted Game", "rect": (5, 5, 50, 50),
         "active": False, "opaque": True, "actions": []},
        {"id": 42, "title": "Save File — App", "rect": (10, 10, 80, 60),
         "active": True, "opaque": False, "actions": [
             # rows first in scan order — projection must not keep that order
             {"name": "a.txt", "type": "ListItem", "rect": None},
             {"name": "a.txt", "type": "DataItem", "rect": None},
             {"name": "b.txt", "type": "ListItem", "rect": None},
             {"name": "", "type": "Button", "rect": None},      # unnamed: drop
             {"name": "Save", "type": "Button", "rect": None},
             {"name": "Save", "type": "Button", "rect": None},  # dup: drop
             {"name": "Cancel", "type": "Button", "rect": None},
             {"name": "File name:", "type": "Edit", "rect": None},
         ]},
    ],
}

orig = osctl.screen_observe
osctl.screen_observe = lambda **kw: FAKE
try:
    out = osctl.screen_brief(max_controls=4)
finally:
    osctl.screen_observe = orig

lines = out.splitlines()
assert lines[0] == "WIN  Desktop (0,0 100x100)", lines[0]
assert lines[1] == "WIN! Painted Game (5,5 50x50)", lines[1]
assert lines[2] == "WIN* Save File — App (10,10 80x60)", lines[2]
ctl = lines[3]
# command-like controls outrank rows; dups and unnamed dropped; cap respected
assert ctl.strip().split(" | ")[:3] == [
    "[Button] Save", "[Button] Cancel", "[Edit] File name:"], ctl
assert ctl.count("|") == 3, ctl                     # max_controls=4 -> 4 entries
assert "DataItem" not in ctl, ctl                   # rows pruned below the cap
assert len(out.encode()) < 300, len(out.encode())   # the whole point: cheap

print("F369 OK: screen_brief projects the observation — marked titles, "
      "deduped command-first controls, capped and cheap")
