"""F243 regression: _atspi_frame_for must pick the right same-pid frame even
when accessible extents are window-local (origin 0,0) and screen-IoU is 0 for
every frame — disambiguate by the X window's size. Pure-Python, no live AT-SPI."""
import _osbackend_x11 as be


class FakeAt:
    def atspi_get_desktop(self, _):
        return "DESK"

    def atspi_accessible_get_process_id(self, app, _):
        return 100


def _install(rects, titles):
    """Patch the module helpers to model one app (pid 100) with a 'MAIN' frame
    and a 'DLG' frame; `rects` gives each frame's accessible extents."""
    tree = {"DESK": ["APP"], "APP": ["MAIN", "DLG"]}
    role = {"MAIN": "frame", "DLG": "dialog"}
    name = {"MAIN": "White to Move", "DLG": ""}
    be._acc_children = lambda at, acc: list(tree.get(acc, []))
    be._acc_role = lambda at, fr: role[fr]
    be._acc_name = lambda at, fr: name[fr]
    be._acc_rect = lambda at, fr: rects[fr]
    be._unref = lambda x: None
    be.window_pid = lambda win: 100
    be.window_text = lambda win: titles[win]
    be.window_geometry = lambda win: GEOM[win]


# dialog X window (centered, with WM decoration); main X window (decorated).
GEOM = {
    "DLGWIN": {"x": 555, "y": 562, "w": 489, "h": 60},
    "MAINWIN": {"x": 436, "y": 291, "w": 728, "h": 579},
}

# Scenario A — extents reported in WINDOW-LOCAL coords (the gnome-chess bug):
# both frames at origin (0,0); screen-IoU is 0 for every frame.
LOCAL = {"MAIN": (0, 0, 700, 550), "DLG": (0, 0, 489, 60)}
# Scenario B — extents in real SCREEN coords (well-behaved app): IoU must win.
SCREEN = {"MAIN": (436, 291, 700, 550), "DLG": (555, 562, 489, 60)}

at = FakeAt()

# A: no titles -> must fall to size-match. Dialog window must NOT read the board.
_install(LOCAL, {"DLGWIN": "", "MAINWIN": ""})
assert be._atspi_frame_for(at, "DLGWIN") == "DLG", "local-coord: dialog mis-resolved"
assert be._atspi_frame_for(at, "MAINWIN") == "MAIN", "local-coord: main mis-resolved"

# B: real screen coords -> IoU path still chooses correctly (no regression).
_install(SCREEN, {"DLGWIN": "", "MAINWIN": ""})
assert be._atspi_frame_for(at, "DLGWIN") == "DLG", "screen-coord: dialog mis-resolved"
assert be._atspi_frame_for(at, "MAINWIN") == "MAIN", "screen-coord: main mis-resolved"

# C: exact title match still short-circuits before geometry.
_install(LOCAL, {"DLGWIN": "", "MAINWIN": "White to Move"})
assert be._atspi_frame_for(at, "MAINWIN") == "MAIN", "title path broken"

print("F243 OK: dialog frames resolve by size when IoU can't; IoU & title paths intact")
