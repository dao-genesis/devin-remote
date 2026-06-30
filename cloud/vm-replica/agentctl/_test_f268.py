"""F268 synthetic regression for `flow_residual` — no display required.

`flow_residual` finds what moves independently of the camera: it subtracts the
global affine flow field (consensus_affine, F267) from each seed's displacement
and clusters the seeds whose residual is significant into objects. Under a moving
camera, raw frame-diff (locate_change_blobs) floods — every pixel changed — and a
single-shift subtraction is wrong for a yaw; only the residual against the
modelled field isolates a strafing object. The tests assert that it:
  - reports NO object for pure egomotion (a yaw ramp with no independent motion),
  - isolates one compact object moving against a strong egomotion field, at its
    true location and with its true residual velocity, when frame-diff would see
    the whole frame moving,
  - finds an object during a still camera (field ~ 0) too,
  - separates two independently-moving objects into two clusters,
  - honours min_resid (gate) and min_cluster (a lone outlier is not an object),
  - accepts a precomputed field, drops None components, refuses on too few votes.
"""
import sys
sys.path.insert(0, ".")
import osctl

n = 0


def ok(cond, msg):
    global n
    assert cond, msg
    n += 1


def _noise(seed):
    s = seed & 0xFFFFFFFF
    while True:
        s = (1103515245 * s + 12345) & 0x7FFFFFFF
        yield (s / 0x7FFFFFFF) * 2.0 - 1.0


GRID_X = [80, 200, 320, 440, 560, 680]
GRID_Y = [40, 130, 220, 310, 400]


def ego(y, g):
    """A yaw-ramp egomotion displacement at screen-y with small jitter."""
    return (-78.0 + 0.112 * y + 1.5 * next(g), 1.0 * next(g))


# --- pure egomotion: no independent object -----------------------------------
g = _noise(1)
pan = []
for x in GRID_X:
    for y in GRID_Y:
        dx, dy = ego(y, g)
        pan.append((float(x), float(y), dx, dy))
r = osctl.flow_residual(pan, min_resid=6.0)
ok(r is not None, "pan resolves")
ok(r["objects"] == [], "pure egomotion -> no independent object (honest empty)")
ok(r["field"]["ax"][2] > 0.05, f"the field itself is the yaw ramp: {r['field']['ax'][2]:.3f}")

# --- one object moving against a strong egomotion field ----------------------
# background follows the yaw ramp; a compact cluster near (320,220) carries an
# EXTRA (+26, +16) on top of the field -> residual ~ (26,16), |r| ~ 30 px.
g = _noise(2)
scene = []
for x in GRID_X:
    for y in GRID_Y:
        dx, dy = ego(y, g)
        scene.append((float(x), float(y), dx, dy))
obj_pts = [(300, 210), (320, 210), (340, 210), (300, 230), (320, 230), (340, 230)]
for (ox, oy) in obj_pts:
    bx = -78.0 + 0.112 * oy           # the field at the object's position
    scene.append((float(ox), float(oy), bx + 26.0, 16.0))
rs = osctl.flow_residual(scene, min_resid=8.0, cluster_radius=40.0, min_cluster=3)
ok(rs is not None and len(rs["objects"]) == 1,
   f"exactly one independent object: {rs and len(rs['objects'])}")
o = rs["objects"][0]
ok(abs(o["x"] - 320) < 25 and abs(o["y"] - 220) < 25,
   f"object at its true location: ({o['x']:.0f},{o['y']:.0f})")
ok(abs(o["rdx"] - 26.0) < 5 and abs(o["rdy"] - 16.0) < 5,
   f"true residual velocity (camera removed): ({o['rdx']:.1f},{o['rdy']:.1f})")
# the discriminator: only a handful of seeds survive the field subtraction,
# whereas raw frame-diff would flag ALL of them (the whole frame is moving).
ok(rs["n_resid"] <= len(obj_pts) + 2 and rs["n"] > 30,
   f"field subtraction isolates the object: {rs['n_resid']}/{rs['n']} survive")

# --- object during a still camera (field ~ 0) --------------------------------
g = _noise(3)
still = []
for x in GRID_X:
    for y in GRID_Y:
        still.append((float(x), float(y), 0.8 * next(g), 0.8 * next(g)))
for (ox, oy) in [(500, 300), (520, 300), (500, 320), (520, 320)]:
    still.append((float(ox), float(oy), -20.0, 0.0))
rst = osctl.flow_residual(still, min_resid=6.0, min_cluster=3)
ok(rst is not None and len(rst["objects"]) == 1,
   f"object found under a still camera: {rst and len(rst['objects'])}")
ok(abs(rst["objects"][0]["rdx"] - (-20.0)) < 4,
   f"residual = raw motion when field~0: {rst['objects'][0]['rdx']:.1f}")

# --- two independent objects -> two clusters ---------------------------------
g = _noise(4)
two = []
for x in GRID_X:
    for y in GRID_Y:
        dx, dy = ego(y, g)
        two.append((float(x), float(y), dx, dy))
for (ox, oy) in [(140, 90), (160, 90), (140, 110), (160, 110)]:
    two.append((float(ox), float(oy), -78.0 + 0.112 * oy + 30.0, -18.0))
for (ox, oy) in [(600, 360), (620, 360), (600, 380), (620, 380)]:
    two.append((float(ox), float(oy), -78.0 + 0.112 * oy - 22.0, 20.0))
rt = osctl.flow_residual(two, min_resid=8.0, cluster_radius=45.0, min_cluster=3)
ok(rt is not None and len(rt["objects"]) == 2,
   f"two independent objects -> two clusters: {rt and len(rt['objects'])}")

# --- min_cluster: a lone outlier seed is not an object -----------------------
g = _noise(5)
lone = []
for x in GRID_X:
    for y in GRID_Y:
        dx, dy = ego(y, g)
        lone.append((float(x), float(y), dx, dy))
lone.append((350.0, 220.0, -78.0 + 0.112 * 220 + 40.0, 30.0))   # single stray
ok(osctl.flow_residual(lone, min_resid=8.0, min_cluster=3)["objects"] == [],
   "a lone residual seed is not promoted to an object")

# --- min_resid gate: a small extra motion is below threshold -----------------
g = _noise(6)
weak = []
for x in GRID_X:
    for y in GRID_Y:
        dx, dy = ego(y, g)
        weak.append((float(x), float(y), dx, dy))
for (ox, oy) in [(300, 210), (320, 210), (340, 210), (320, 230)]:
    weak.append((float(ox), float(oy), -78.0 + 0.112 * oy + 4.0, 2.0))  # |r|~4.5
ok(osctl.flow_residual(weak, min_resid=8.0, min_cluster=3)["objects"] == [],
   "residual below min_resid is not an object")
ok(len(osctl.flow_residual(weak, min_resid=3.0, min_cluster=3)["objects"]) == 1,
   "lowering min_resid surfaces the weak mover")

# --- precomputed field, hygiene, refusals ------------------------------------
fld = osctl.consensus_affine(pan, min_votes=8)
rp = osctl.flow_residual(scene, field=fld, min_resid=8.0, min_cluster=3)
ok(rp is not None and len(rp["objects"]) == 1,
   "accepts a precomputed field and finds the object")
gappy = scene + [(None, 1.0, 1.0, 1.0), (1.0, None, 1.0, 1.0),
                 (1.0, 1.0, None, 1.0), (1.0, 1.0, 1.0, None)]
ok(osctl.flow_residual(gappy, min_resid=8.0)["n"] == len(scene),
   "None components dropped")
ok(osctl.flow_residual([(0.0, 0.0, 1.0, 1.0)] * 4, min_votes=8) is None,
   "fewer than min_votes -> None")

print(f"F268 flow_residual: {n} assertions passed")
