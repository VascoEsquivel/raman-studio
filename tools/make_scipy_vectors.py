"""Generate tests/fixtures/find_peaks_vectors.json from SciPy itself.

js/detect/find-peaks.js is a port of scipy.signal.find_peaks; this script runs
the real SciPy on synthetic signals and stores inputs, parameters and the full
outputs so the browser tests can check the port number for number.

Usage (from the repo root, with numpy + scipy installed):
    python tools/make_scipy_vectors.py

Inputs are rounded to 6 decimals *before* SciPy sees them: the fixture stays
small, and since SciPy ran on exactly the stored numbers the comparison is
still exact. Outputs are written with full round-trip precision.

Ties in `distance` priority: SciPy orders peaks with np.argsort's default
(unstable, SIMD-dependent) sort, so which of two equally high peaks survives
can differ between machines. The JS port breaks ties as a stable sort would.
Every case that uses `distance` is checked here against a stable-sort
emulation, so the fixture never pins a platform-specific tie outcome.
"""
from __future__ import annotations

import json
import math
import sys
import warnings
from pathlib import Path

import numpy as np
import scipy
from scipy.signal import find_peaks, peak_prominences, peak_widths

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "find_peaks_vectors.json"
MAX_BYTES = 300_000


def r6(a):
    """Round to 6 decimals; -0.0 becomes 0.0 so the JSON stays tidy."""
    return np.round(np.asarray(a, dtype=np.float64), 6) + 0.0


def to_py(v):
    """Turn numpy values / arrays into JSON-native Python values."""
    if isinstance(v, np.ndarray):
        if v.dtype.kind in "iub":
            return [int(t) for t in v]
        return [float(t) for t in v]
    if isinstance(v, (list, tuple)):
        return [to_py(t) for t in v]
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return float(v)
    return v


def stable_distance_keep(peaks, priority, distance):
    """_select_by_peak_distance with a stable argsort (what the JS port does)."""
    d = math.ceil(distance)
    n = len(peaks)
    keep = np.ones(n, dtype=bool)
    order = np.argsort(priority, kind="stable")
    for i in range(n - 1, -1, -1):
        j = order[i]
        if not keep[j]:
            continue
        k = j - 1
        while k >= 0 and peaks[j] - peaks[k] < d:
            keep[k] = False
            k -= 1
        k = j + 1
        while k < n and peaks[k] - peaks[j] < d:
            keep[k] = False
            k += 1
    return keep


def check_distance_ties(name, x, params, peaks):
    """Re-run find_peaks with a stable distance step and demand the same peaks."""
    if params.get("distance") is None:
        return
    p = dict(params)
    dist = p.pop("distance")
    # Same filter order as find_peaks: plateau, height, threshold first ...
    pre = dict(p)
    pre.pop("prominence", None)
    pre.pop("width", None)
    cand, _ = find_peaks(x, **{k: v for k, v in pre.items() if k not in ("wlen", "rel_height")})
    keep = stable_distance_keep(cand, x[cand], dist)
    cand = cand[keep]
    # ... then prominence and width on the survivors.
    if p.get("prominence") is not None or p.get("width") is not None:
        allp, props = find_peaks(x, prominence=(None, None), width=(None, None) if p.get("width") is not None else None,
                                 wlen=p.get("wlen"), rel_height=p.get("rel_height", 0.5))
        idx = {int(v): i for i, v in enumerate(allp)}
        sel = []
        for c in cand:
            i = idx[int(c)]
            ok = True
            for key, prop in (("prominence", "prominences"), ("width", "widths")):
                cond = p.get(key)
                if cond is None:
                    continue
                lo, hi = (cond if isinstance(cond, (list, tuple)) else (cond, None))
                val = props[prop][i]
                lo_v = lo[c] if isinstance(lo, np.ndarray) else lo
                hi_v = hi[c] if isinstance(hi, np.ndarray) else hi
                if lo_v is not None and not lo_v <= val:
                    ok = False
                if hi_v is not None and not val <= hi_v:
                    ok = False
            if ok:
                sel.append(c)
        cand = np.asarray(sel, dtype=np.intp)
    if not np.array_equal(cand, peaks):
        raise SystemExit(f"case {name!r}: SciPy's distance tie-break differs from a stable sort; "
                         "change the case so equal-height peaks do not compete")


def jsonable_params(params):
    out = {}
    for k, v in params.items():
        if isinstance(v, tuple):
            v = list(v)
        out[k] = to_py(v)
    return out


cases = []


def add_find_peaks(name, x, **params):
    x = r6(x)
    if x.size == 2 and any(isinstance(v, np.ndarray) for v in params.values()):
        raise SystemExit("per-sample borders on a 2-sample signal are ambiguous with [min, max]")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        peaks, props = find_peaks(x, **params)
        check_distance_ties(name, x, params, peaks)
    cases.append({
        "name": name,
        "fn": "find_peaks",
        "x": to_py(x),
        "params": jsonable_params(params),
        "peaks": to_py(peaks),
        "properties": {k: to_py(v) for k, v in props.items()},
    })


def add_prominences(name, x, peaks, wlen=None):
    x = r6(x)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        prom, lb, rb = peak_prominences(x, peaks, wlen=wlen)
    cases.append({
        "name": name, "fn": "peak_prominences", "x": to_py(x),
        "params": {"peaks": to_py(np.asarray(peaks)), "wlen": wlen},
        "result": {"prominences": to_py(prom), "left_bases": to_py(lb), "right_bases": to_py(rb)},
    })


def add_widths(name, x, peaks, rel_height=0.5, wlen=None, prominence_data=None):
    x = r6(x)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        w, wh, li, ri = peak_widths(x, peaks, rel_height=rel_height, wlen=wlen,
                                    prominence_data=prominence_data)
    params = {"peaks": to_py(np.asarray(peaks)), "rel_height": rel_height, "wlen": wlen}
    if prominence_data is not None:
        params["prominence_data"] = [to_py(np.asarray(a)) for a in prominence_data]
    cases.append({
        "name": name, "fn": "peak_widths", "x": to_py(x), "params": params,
        "result": {"widths": to_py(w), "width_heights": to_py(wh), "left_ips": to_py(li), "right_ips": to_py(ri)},
    })


def lorentz(t, x0, w):
    return 1.0 / (1.0 + 4.0 * ((t - x0) / w) ** 2)


def gauss(t, x0, w):
    return np.exp(-4.0 * math.log(2.0) * ((t - x0) / w) ** 2)


def build():
    rs = np.random.default_rng(20261002)

    # --- random noise -------------------------------------------------------
    noise = rs.normal(size=240)
    add_find_peaks("noise: bare local maxima", noise)
    add_find_peaks("noise: height scalar", noise, height=0.5)
    add_find_peaks("noise: height interval", noise, height=(0.0, 1.5))
    add_find_peaks("noise: height upper bound only", noise, height=(None, 0.0))
    add_find_peaks("noise: threshold scalar", noise, threshold=0.3)
    add_find_peaks("noise: threshold interval", noise, threshold=(0.1, 1.0))
    add_find_peaks("noise: distance integer", noise, distance=5)
    add_find_peaks("noise: distance fractional (rounded up)", noise, distance=2.5)
    add_find_peaks("noise: prominence scalar", noise, prominence=1.0)
    add_find_peaks("noise: prominence interval", noise, prominence=(0.5, 2.0))
    add_find_peaks("noise: prominence open interval", noise, prominence=(None, None))
    add_find_peaks("noise: width scalar", noise, width=2)
    add_find_peaks("noise: width interval + rel_height 0.75", noise, width=(1.0, 5.0), rel_height=0.75)
    add_find_peaks("noise: wlen 7 + prominence", noise, prominence=(None, None), wlen=7)
    add_find_peaks("noise: wlen 10.5 (ceil 11) + prominence + width", noise, prominence=0.3,
                   width=(None, None), wlen=10.5)
    add_find_peaks("noise: wlen 2 (even, smallest)", noise, prominence=(None, None), width=(None, None), wlen=2)
    add_find_peaks("noise: all filters", noise, height=(-0.5, None), threshold=(0.0, None), distance=3,
                   prominence=(0.2, None), width=(0.5, None), rel_height=0.6)

    # Random walk: long monotone runs exercise the base search far from the peak.
    walk = np.cumsum(rs.normal(size=400))
    add_find_peaks("random walk: prominence 2", walk, prominence=2.0)
    add_find_peaks("random walk: prominence + wlen 41 + width", walk, prominence=1.0, wlen=41, width=(None, None))

    # --- smooth multi-peak spectra -----------------------------------------
    t = np.linspace(0.0, 599.0, 600)
    spec = (3.0 * lorentz(t, 80, 14) + 1.2 * gauss(t, 150, 30) + 2.0 * lorentz(t, 230, 8)
            + 0.6 * gauss(t, 260, 12) + 1.5 * lorentz(t, 400, 40) + 0.8 * gauss(t, 520, 6))
    add_find_peaks("smooth spectrum: prominence + width", spec, prominence=0.05, width=3)
    add_find_peaks("smooth spectrum: rel_height 1.0", spec, prominence=0.01, width=(None, None), rel_height=1.0)
    add_find_peaks("smooth spectrum: rel_height 0 (zero widths)", spec, width=(None, None), rel_height=0.0)
    add_find_peaks("smooth spectrum: rel_height 1.5 (below base)", spec, width=(None, None), rel_height=1.5)
    noisy = spec + 0.02 * rs.normal(size=spec.size) + 0.001 * t
    add_find_peaks("noisy spectrum on slope: every filter", noisy, height=0.1, threshold=(None, 0.5), distance=12,
                   prominence=(0.1, 10.0), width=(2.0, 200.0), rel_height=0.5, wlen=151)
    add_find_peaks("noisy spectrum: per-sample height border", noisy,
                   height=np.linspace(0.2, 1.0, noisy.size), prominence=(None, None))
    add_find_peaks("noisy spectrum: per-sample prominence interval", noisy,
                   prominence=(np.full(noisy.size, 0.05), np.linspace(5.0, 0.5, noisy.size)))

    # --- plateaus -----------------------------------------------------------
    plateau = np.array([0, 1, 1, 0, 2, 2, 2, 0, 1, 3, 3, 3, 3, 1, 0, 4, 4, 4, 4, 4, 0, 2, 5, 5, 5, 5, 5, 5, 2,
                        1, 3, 1, 0, 2, 2, 3, 3, 1, 6, 6, 6, 6, 6, 6, 6, 0], dtype=float)
    add_find_peaks("plateaus: sizes reported", plateau, plateau_size=(None, None))
    add_find_peaks("plateaus: plateau_size scalar 2", plateau, plateau_size=2)
    add_find_peaks("plateaus: plateau_size interval [2, 4]", plateau, plateau_size=(2, 4))
    add_find_peaks("plateaus: plateau + prominence + width", plateau, plateau_size=(None, None),
                   prominence=(None, None), width=(None, None))
    add_find_peaks("plateaus: distance + threshold", plateau, distance=4, threshold=(None, None),
                   plateau_size=(1, None))
    # Plateaus that run into the signal edges never count as maxima.
    edges = np.array([5, 5, 5, 1, 2, 3, 2, 4, 4, 0, 1, 7, 7, 7], dtype=float)
    add_find_peaks("plateaus touching both edges", edges, plateau_size=(None, None), prominence=(None, None))

    # --- edges, constant, monotone, tiny -----------------------------------
    edge_sig = np.array([9.0, 1.0, 3.0, 2.0, 5.0, 4.0, 8.0, 0.5, 9.5])
    add_find_peaks("global maxima at the edges are not peaks", edge_sig, prominence=(None, None),
                   width=(None, None), height=(None, None), threshold=(None, None))
    add_find_peaks("constant signal", np.full(50, 3.25), prominence=(None, None), width=(None, None),
                   plateau_size=(None, None))
    add_find_peaks("monotone increasing", np.linspace(0, 1, 30), prominence=0.0)
    add_find_peaks("three samples", np.array([0.0, 1.0, 0.0]), prominence=(None, None), width=(None, None),
                   threshold=(None, None))
    add_find_peaks("two samples", np.array([0.0, 1.0]), prominence=(None, None))
    add_find_peaks("empty signal", np.array([]), height=0, prominence=(None, None), width=(None, None))

    # --- quantised data: ties everywhere in base and edge searches ----------
    quant = np.round(4 * np.sin(np.arange(300) / 7.0) + 2 * np.sin(np.arange(300) / 2.3)
                     + rs.normal(size=300))
    add_find_peaks("quantised: prominence + width + wlen", quant, prominence=1, width=(None, None), wlen=25)
    add_find_peaks("quantised: plateau_size + rel_height 0.3", quant, plateau_size=(None, None),
                   width=(1, None), rel_height=0.3)
    # Equal heights spaced evenly: SciPy's argsort is the identity here, so its
    # tie outcome equals the stable one and the case is portable.
    ties = np.zeros(41)
    ties[2:40:3] = 1.0
    add_find_peaks("equal heights within distance", ties, distance=4)

    # --- standalone peak_prominences / peak_widths --------------------------
    add_prominences("prominences: arbitrary indices incl. edges and slopes", spec,
                    [0, 10, 80, 150, 231, 300, 599])
    add_prominences("prominences: wlen 3.1 (ceil 4 → window 5)", noise, list(range(1, 239, 7)), wlen=3.1)
    add_prominences("prominences: wlen larger than the signal", noise, [10, 50, 200], wlen=1000)
    # Index 150 is not a maximum of the noisy trace (prominence 0, width 0):
    # the degenerate path is part of what the port must reproduce.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        pdata = peak_prominences(r6(noisy), [80, 150, 230, 400], wlen=101)
    add_widths("widths: given prominence data", noisy, [80, 150, 230, 400], rel_height=0.5,
               prominence_data=pdata)
    add_widths("widths: computed with wlen", walk, list(np.nonzero(np.diff(np.sign(np.diff(r6(walk)))) < 0)[0] + 1),
               rel_height=0.8, wlen=21)


def main() -> int:
    build()
    doc = {
        "about": "scipy.signal find_peaks / peak_prominences / peak_widths reference outputs "
                 "for js/detect/find-peaks.js. Generated by tools/make_scipy_vectors.py; do not edit.",
        "scipy": scipy.__version__,
        "numpy": np.__version__,
        "cases": cases,
    }
    text = json.dumps(doc, separators=(",", ":"), allow_nan=False)
    if len(text) > MAX_BYTES:
        print(f"fixture too large: {len(text)} bytes", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(cases)} cases, {len(text)} bytes, scipy {scipy.__version__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
