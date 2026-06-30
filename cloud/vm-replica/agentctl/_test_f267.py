"""F267 synthetic regression for `consensus_affine` — no display required.

`consensus_affine` fits a robust affine flow field `d = c0 + c1*x + c2*y` (per
component) to position-tagged displacement votes `(x, y, dx, dy)`. It is the
model a camera rotation / perspective pan needs and that `consensus_shift`
(F265) can only reject: an OpenArena yaw produced a smooth, repeatable ramp of
horizontal displacement down the frame (top -72 px .. bottom -36 px), not one
shift and not discrete layers. The tests assert that it:
  - recovers a pure affine gradient (yaw-like) from clean votes, with the
    centre-shift `bx[0]` and the per-pixel gradient `bx[1:]` both correct,
  - degrades to a pure translation (zero gradient) when the field is a uniform
    pan, matching what `consensus_shift` reports for the same scene,
  - reproduces the real measured OpenArena ramp as a gradient, on the very same
    vote-bag where `consensus_shift` honestly returns None,
  - rejects a compact cluster of independently-moving seeds without letting them
    bend the global field (robust trimming),
  - refuses (None) on too few votes and on degenerate (single-column) geometry,
  - drops None components, and leaves a large `rms` when the votes fit no model.
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
    """Deterministic small jitter generator (LCG), no numpy / random state."""
    s = seed & 0xFFFFFFFF
    while True:
        s = (1103515245 * s + 12345) & 0x7FFFFFFF
        yield (s / 0x7FFFFFFF) * 2.0 - 1.0  # in [-1, 1]


GRID_X = [100, 250, 400, 550, 700]
GRID_Y = [53, 160, 267, 374]


# --- pure affine gradient (yaw-like): recover centre-shift + gradient ---------
# dx ramps with screen-y: dx = -78 + 0.112*y (the live OpenArena signature),
# dy ~ 0. A single global shift cannot represent this; an affine field can.
g = _noise(1)
votes = []
for x in GRID_X:
    for y in GRID_Y:
        dx = -78.0 + 0.112 * y + 1.5 * next(g)
        dy = 0.0 + 1.0 * next(g)
        votes.append((float(x), float(y), dx, dy))
r = osctl.consensus_affine(votes, min_votes=8)
ok(r is not None, "affine gradient must resolve")
ok(abs(r["ax"][2] - 0.112) < 0.02, f"dx/dy gradient ~0.112: {r['ax'][2]:.4f}")
ok(abs(r["ax"][1]) < 0.02, f"no dx/dx gradient: {r['ax'][1]:.4f}")
ok(abs(r["ax"][0] - (-78.0)) < 4.0, f"dx intercept ~-78: {r['ax'][0]:.2f}")
# bx is about the centroid: bx[0] is the shift at the frame centre.
cy = sum(GRID_Y) / len(GRID_Y)
ok(abs(r["bx"][0] - (-78.0 + 0.112 * cy)) < 3.0,
   f"centre shift ~{-78.0 + 0.112 * cy:.1f}: {r['bx'][0]:.2f}")
ok(r["support"] > 0.9 and r["rms"] < 3.0,
   f"clean fit: support={r['support']:.2f} rms={r['rms']:.2f}")
# the gradient is real, not noise: top of frame moves far more than bottom.
top = r["ax"][0] + r["ax"][2] * 0.0
bot = r["ax"][0] + r["ax"][2] * 428.0
ok(abs(top) > abs(bot) + 20.0, f"top |dx| {abs(top):.0f} >> bottom {abs(bot):.0f}")

# --- uniform pan: degrades to a pure translation (consensus_shift regime) -----
g = _noise(2)
flat = []
for x in GRID_X:
    for y in GRID_Y:
        flat.append((float(x), float(y),
                     -30.0 + 0.8 * next(g), 4.0 + 0.8 * next(g)))
rf = osctl.consensus_affine(flat, min_votes=8)
ok(rf is not None, "uniform pan resolves")
ok(abs(rf["bx"][1]) < 0.01 and abs(rf["bx"][2]) < 0.01,
   f"gradient ~0 -> pure translation: {rf['bx'][1]:.4f},{rf['bx'][2]:.4f}")
ok(abs(rf["bx"][0] - (-30.0)) < 1.5 and abs(rf["by"][0] - 4.0) < 1.5,
   f"centre shift ~(-30,4): {rf['bx'][0]:.2f},{rf['by'][0]:.2f}")
# the same scene resolves as one shift for consensus_shift; affine agrees.
cs = osctl.consensus_shift([(v[2], v[3]) for v in flat], tol=4.0)
ok(cs is not None and abs(cs["dx"] - rf["bx"][0]) < 2.0,
   f"affine centre-shift matches consensus_shift: {cs and cs['dx']:.2f}")

# --- the real OpenArena ramp: affine represents what consensus_shift rejects --
# Measured per-band median dx down the frame: -72 / -60 / -48 / -36 (IQR ~6).
g = _noise(3)
ramp = []
bands = [(53, -72.0), (160, -60.0), (267, -48.0), (374, -36.0)]
for x in GRID_X:
    for (y, dxc) in bands:
        ramp.append((float(x), float(y), dxc + 3.0 * next(g), 1.5 * next(g)))
rr = osctl.consensus_affine(ramp, min_votes=8)
ok(rr is not None, "measured ramp resolves as an affine field")
# slope across the measured bands: (-36 - -72)/(374-53) = 0.112 px per screen-y.
ok(abs(rr["ax"][2] - 0.112) < 0.03, f"ramp gradient ~0.112: {rr['ax'][2]:.4f}")
# consensus_shift, fed the same dx/dy bag, finds no majority -> honest None.
cs2 = osctl.consensus_shift([(v[2], v[3]) for v in ramp],
                            tol=8.0, min_support=0.5)
ok(cs2 is None, "consensus_shift refuses the ramp (no single shift)")

# --- robustness: an independently-moving cluster must not bend the field ------
g = _noise(4)
mixed = []
for x in GRID_X:
    for y in GRID_Y:
        mixed.append((float(x), float(y),
                      -78.0 + 0.112 * y + 1.5 * next(g), 1.0 * next(g)))
n_global = len(mixed)
# a compact object near (400, 200) moving the other way (+40 px, +20 px)
for k in range(6):
    mixed.append((400.0 + k, 200.0 + k, 40.0, 20.0))
rm = osctl.consensus_affine(mixed, min_votes=8)
ok(rm is not None, "mixed field resolves")
ok(abs(rm["ax"][2] - 0.112) < 0.03,
   f"global gradient survives the object: {rm['ax'][2]:.4f}")
ok(rm["inliers"] <= n_global and rm["support"] < 1.0,
   f"object seeds trimmed: inliers={rm['inliers']}/{rm['n']}")
ok(rm["rms"] < 4.0, f"inlier rms stays small: {rm['rms']:.2f}")

# --- refusals & input hygiene -------------------------------------------------
ok(osctl.consensus_affine([(0.0, 0.0, 1.0, 1.0)] * 4, min_votes=8) is None,
   "fewer than min_votes -> None")
# degenerate geometry: all seeds in one column -> gradient unidentifiable
col = [(100.0, float(y), -30.0, 0.0) for y in range(0, 400, 25)]
ok(osctl.consensus_affine(col, min_votes=8) is None,
   "single-column seeds -> None (gradient unidentifiable)")
# None components dropped
g = _noise(5)
gappy = []
for x in GRID_X:
    for y in GRID_Y:
        gappy.append((float(x), float(y), -78.0 + 0.112 * y, 0.0))
gappy += [(None, 10.0, 1.0, 1.0), (10.0, None, 1.0, 1.0),
          (10.0, 10.0, None, 1.0), (10.0, 10.0, 1.0, None)]
rgp = osctl.consensus_affine(gappy, min_votes=8)
ok(rgp is not None and rgp["n"] == len(GRID_X) * len(GRID_Y),
   f"None votes dropped: n={rgp and rgp['n']}")

# --- no-model votes leave a large rms (the caller's quality gate) -------------
g = _noise(6)
rand = []
for x in GRID_X:
    for y in GRID_Y:
        rand.append((float(x), float(y), 60.0 * next(g), 60.0 * next(g)))
rrand = osctl.consensus_affine(rand, min_votes=8)
ok(rrand is None or rrand["rms"] > 15.0,
   f"pure-noise votes -> large rms / None: {rrand and round(rrand['rms'], 1)}")

print(f"F267 consensus_affine: {n} assertions passed")
