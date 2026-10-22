"""Shared helpers for the deck lab scripts (schedule.py, analyze.py, report.py).

Paths, the deck index, JSON lines, seeds and small statistics. Standard library only.
"""
import json
import math
import os
import random
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIM = ROOT / "data/sim"
RUNS = SIM / "runs"
INDEX = SIM / "decks/index.json"
PLAYGROUP = SIM / "playgroup-precon-tiers-2026-10-17.json"
LAB_DOCS = ROOT / "docs/lab"

END_KINDS = ("win", "draw", "turn_cap", "action_cap", "time_cap", "panic", "error")
FAILED_ENDS = ("panic", "error")
CAP_ENDS = ("turn_cap", "action_cap", "time_cap")
DIFFICULTIES = ("Easy", "Medium", "Hard")

MASK53 = (1 << 53) - 1
MASK64 = (1 << 64) - 1


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def rel(path):
    """Path relative to the repo root when possible (for logs and JSON)."""
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def splitmix64(x):
    """One splitmix64 step: a well-mixed 64-bit value from any integer."""
    x = (x + 0x9E3779B97F4A7C15) & MASK64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return z ^ (z >> 31)


def game_seed(base_seed, n):
    """Seed for game (or template) n of a run. Masked to 53 bits so any JSON tool keeps it exact."""
    return splitmix64(splitmix64(base_seed & MASK64) ^ (n & MASK64)) & MASK53


def run_seed(base_seed, run):
    """A run's own base seed: --seed mixed with the run name, so two runs made with the same --seed
    (pilot-2 and precons-1 were) don't replay the same games under different ids."""
    h = splitmix64(base_seed & MASK64)
    for ch in run.encode():
        h = splitmix64(h ^ ch)
    return h


def load_index(path=INDEX):
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict) or "decks" not in data:
        raise SystemExit(f"{rel(path)}: expected an object with a 'decks' list")
    seen = set()
    for d in data["decks"]:
        if "id" not in d:
            raise SystemExit(f"{rel(path)}: a deck entry has no id: {d}")
        if d["id"] in seen:
            raise SystemExit(f"{rel(path)}: duplicate deck id {d['id']}")
        seen.add(d["id"])
    for x in data.get("left_out", []):
        if x.get("id") in seen:
            raise SystemExit(f"{rel(path)}: left_out id {x.get('id')} is also a deck")
        if x.get("same_as") not in seen:
            raise SystemExit(f"{rel(path)}: left_out {x.get('id')} names {x.get('same_as')!r}, which isn't a deck")
    return data


def left_out_map(index):
    """Left-out deck id -> the deck kept in its place (index.json left_out: precons whose commander and 100 cards
    equal an earlier precon's, such as Collector's Editions; precons.py writes no deck file for them). Old runs
    used their ids."""
    return {x["id"]: x["same_as"] for x in (index or {}).get("left_out", []) if x.get("id") and x.get("same_as")}


def read_jsonl(path):
    """Yield (line_number, object or None) for each non-empty line; None marks a line that isn't valid JSON."""
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield i, json.loads(line)
            except json.JSONDecodeError:
                yield i, None


def write_jsonl(path, rows):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def write_json(path, obj, indent=1):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=indent)
        f.write("\n")
    os.replace(tmp, path)


def z_for(level):
    """Two-sided normal quantile for a central interval (0.90 -> 1.6449)."""
    p = 0.5 + level / 2
    # Acklam's rational approximation, accurate to ~1e-9 (plenty here).
    a = [-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02, 1.383577518672690e02,
         -3.066479806614716e01, 2.506628277459239e00]
    b = [-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02, 6.680131188771972e01,
         -1.328068155288572e01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00, -2.549732539343734e00,
         4.374664141464968e00, 2.938163982698783e00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00, 3.754408661907416e00]
    plow = 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - plow:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def wilson(k, n, level=0.90):
    """Wilson score interval for k successes in n trials."""
    if n <= 0:
        return [None, None]
    z = z_for(level)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [max(0.0, centre - half), min(1.0, centre + half)]


def ranks(xs):
    """Average ranks (1-based), ties share the mean rank."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        mean = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[order[k]] = mean
        i = j + 1
    return r


def pearson(x, y):
    n = len(x)
    if n < 3:
        return None
    mx = sum(x) / n
    my = sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def spearman(x, y):
    if len(x) < 3:
        return None
    return pearson(ranks(x), ranks(y))


def percentile(sorted_xs, q):
    """Linear-interpolated percentile of an already sorted list (q in 0..1)."""
    if not sorted_xs:
        return None
    if len(sorted_xs) == 1:
        return sorted_xs[0]
    pos = q * (len(sorted_xs) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_xs) - 1)
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (pos - lo)


def interval(values, level=0.90):
    xs = sorted(v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v)))
    if not xs:
        return [None, None]
    a = (1 - level) / 2
    return [percentile(xs, a), percentile(xs, 1 - a)]


def rng_for(*parts):
    """A random.Random seeded from any mix of ints and strings, stable across runs and Python versions."""
    h = 0
    for p in parts:
        if isinstance(p, str):
            for ch in p.encode():
                h = splitmix64(h ^ ch)
        else:
            h = splitmix64(h ^ (int(p) & MASK64))
    return random.Random(h)
