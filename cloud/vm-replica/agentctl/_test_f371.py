"""F371 regression: screen_brief lets geometry vote on relevance — controls
without a rect (no on-screen extent) are dropped when any control carries
one, and the filter stands down entirely when no control has a rect (a
backend without extents must not blank the observation).

Backend-agnostic: screen_observe is faked so the test runs without live X11."""
import osctl


def _obs(actions):
    return {"active": 1, "focus": None, "windows": [
        {"id": 1, "title": "App", "rect": (0, 0, 100, 100),
         "active": True, "opaque": False, "actions": actions}]}


MIXED = [
    {"name": "Save this search", "type": "Button", "rect": None},  # furniture
    {"name": "Stop", "type": "Button", "rect": None},              # furniture
    {"name": "Open", "type": "Button", "rect": (5, 5, 40, 20)},
    {"name": "row.txt", "type": "ListItem", "rect": (0, 30, 90, 20)},
]
NO_RECTS = [
    {"name": "Save", "type": "Button", "rect": None},
    {"name": "Cancel", "type": "Button", "rect": None},
]

orig = osctl.screen_observe
try:
    osctl.screen_observe = lambda **kw: _obs(MIXED)
    out = osctl.screen_brief()
    ctl = out.splitlines()[-1]
    assert "[Button] Open" in ctl and "[ListItem] row.txt" in ctl, ctl
    assert "Save this search" not in ctl and "Stop" not in ctl, ctl

    osctl.screen_observe = lambda **kw: _obs(NO_RECTS)
    out = osctl.screen_brief()
    ctl = out.splitlines()[-1]
    assert "[Button] Save" in ctl and "[Button] Cancel" in ctl, ctl
finally:
    osctl.screen_observe = orig

print("F371 OK: rectless controls are pruned as furniture, and the filter "
      "stands down when the backend offers no extents at all")
