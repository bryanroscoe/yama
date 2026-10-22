"""Forge lab runner: plays a deck lab schedule with Forge's AI on every seat and writes one JSON line per game,
in the same results contract as the phase lab runner (yama-lab play/src/bin/lab.rs).

  python3 scripts/sim/forge_runner.py --decks-root data/sim/decks --schedule <schedule.jsonl> --out <results.jsonl>
      [--threads N] [--skip-done] [--retry-errors] [--forge-dir DIR] [--java PATH] [--profile Default]
      [--xmx 2g] [--jvm-cpus 2] [--max-seconds S] [--keep-logs failed|all|none]
  python3 scripts/sim/forge_runner.py --check-cards [--decks-root data/sim/decks] [--schedule FILE] [--report FILE]

Forge (https://github.com/Card-Forge/forge, GPL-3.0) is run as a separate program, one JVM per game
(`java -jar forge-gui-desktop-<v>-jar-with-dependencies.jar sim ...`). Nothing of Forge's code is in this repo.
Default install: ~/Developer/forge-engine/forge-<version> (newest), Java 17 (Homebrew openjdk@17 if present,
else `java` on PATH). Java 20 and later can't stop an AI thread that overran its time (Thread.stop), so use 17.

What carries over from the schedule, and what doesn't (also written in docs/lab/forge.md):
- Decks and seats: as scheduled. Deck files are converted to Forge .dck files, cached under
  data/sim/cache/forge-decks/<deck id>.dck (rewritten when the deck file changes).
- Seed: applied (Forge `-s`, a Java long; it seeds Forge's single random source after the card database loads).
- Who goes first: Forge has no option for it. Game 1 of a Forge match picks the first player with the seeded
  random source after shuffling the libraries, so the pick depends only on the seed and the library sizes. The
  runner computes it (a port of java.util.Random) and rotates the seats it passes to Forge so that the
  schedule's seat 0 is the one Forge picks; turn order then follows the schedule's seats (0, 1, 2, 3), as in
  the phase runner. The result's first_seat is read from the game log, so a wrong prediction shows up there
  (and in the runner's log); it never changes which deck sat where in the results.
- Difficulty: Forge has no difficulty levels. Every seat plays --profile (a Forge AI profile, default "Default")
  and the result's difficulty field records that profile, not the schedule's Easy/Medium/Hard.
- max_turns: Forge has no turn cap, so the runner applies it to the log afterwards, the way the phase runner
  stops: a game still going when turn max_turns + 1 begins (turns count every player's turn) is written as
  turn_cap, with the eliminations, life totals and placements at that point. Forge's AI doesn't know about the
  cap, so this is the same game the phase runner would have stopped.
- max_actions: not applied (Forge doesn't count actions); actions is null.
- max_seconds: Forge's `-c` wall-clock limit per game (the phase runner caps CPU time instead). On the limit
  Forge stops the game; the runner writes time_cap (analysis doesn't score those). --max-seconds overrides.
  The JVM is killed if it is still running max_seconds + KILL_GRACE seconds after it started (end "error").
- Reproducibility: same seed and seats give the same game, except where Forge's 5-second per-decision AI limit
  or the wall-clock cap trips (both depend on machine load).

Result lines: engine "forge <version>", card_data "forge res <version>", runner "forge_runner.py <git sha>" or
"forge_runner.py <sha>-dirty-<hash of this file>". Forge's "Game Result"/"Match Result" lines are never trusted:
on a time-out or engine exception Forge reports every surviving player as a winner. A game is a win only with
exactly one "has won" line and no "Stopping slow match as draw" line.

Cards Forge doesn't know: every deck is checked against Forge's card scripts (res/cardsfolder) before any game.
A game with such a deck isn't played; it is written as end "error" with error "deck errors: <deck>: not in
Forge <version>: <names>" (--skip-done plays it again later, like the phase runner's deck errors). Forge's own
stderr is checked too ("An unsupported card was requested"). --check-cards reports every deck, also asking Forge
itself (one JVM that loads every name and stops before a game), and lists the cards Forge's AI is flagged as
playing badly (AI:RemoveDeck:All / Random in the card scripts; they stay in the deck).

Exit codes: 0 every game written; 1 error; 2 bad arguments; 4 some games not played because a deck file didn't
load (not written) or has cards Forge doesn't know (written as deck errors).

Per-game runner stats (wall and CPU seconds, peak memory, AI time-outs, seat rotation) go to a side file next to
--out: forge-stats-<suffix>.jsonl for results-<suffix>.jsonl (not read by analyze.py).
"""
import argparse
import gzip
import hashlib
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

CACHE = C.SIM / "cache"
DECK_CACHE = CACHE / "forge-decks"
WORK_ROOT = CACHE / "forge-work"
LOG_ROOT = CACHE / "forge-logs"
DEFAULT_FORGE_HOME = Path.home() / "Developer/forge-engine"
DEFAULT_JAVA = Path("/opt/homebrew/opt/openjdk@17/bin/java")
DECK_ERRORS = "deck errors:"
# Seconds past max_seconds before the JVM is killed: startup (5-10 s, ~60 s on a slow disk), printing the log,
# and the game thread Forge leaves running after its own time limit.
KILL_GRACE = 180
PROFILES = ("Default", "Cautious", "Reckless", "Experimental")  # fixed profiles; the Random ones draw from the seed
LIFE_START = 40
CAPTIONS = ("Game Outcome", "Match Result", "Turn", "Mulligan", "Ante", "Draft", "Zone Change", "Player Control",
            "Damage", "Life", "Land", "Discard", "Combat", "Information", "Resolve Stack", "Add To Stack",
            "Replacement Effect", "Mana", "Phase")
LOG_RE = re.compile(r"^(" + "|".join(re.escape(c) for c in CAPTIONS) + r"): (.*)$")
TURN_RE = re.compile(r"^Turn (\d+) \(Ai\((\d+)\)-")
LIFE_RE = re.compile(r"^Life: Ai\((\d+)\)-.* (-?\d+) > (-?\d+)$")
MENTION_RE = re.compile(r"Ai\((\d+)\)-")
OUTCOME_RE = re.compile(r"^Ai\((\d+)\)-\S* (has (?:won|lost|conceded|accepted that the game is a draw).*)$")
RESULT_MS_RE = re.compile(r"^Game Result: Game \d+ ended in (?:(\d+) ms\.|a Draw! Took (\d+) ms\.)")
UNSUPPORTED_RE = re.compile(r'^An unsupported card was requested: "(.*)" from "')
EXCEPTION_RE = re.compile(r"^(?:Exception in thread .*|(?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b.*)$")
# "Damage" lines that hit a player: "... deals 5 combat damage to Ai(3)-x." or "Ai(2)-x receives 9 poison counter".
HIT_RE = re.compile(r"damage to Ai\((\d+)\)-|^Ai\((\d+)\)-\S* receives \d+ poison")
# Log lines that can sit between two players' fatal lines when one event eliminated both (combat damage, one
# spell hitting several players); anything else between them means separate events.
TIE_CAPTIONS = {"Damage", "Life", "Zone Change", "Replacement Effect"}
NO_MENTION_CAPTIONS = {"Game Outcome", "Match Result", "Player Control"}
# A player who leaves the game during their own turn still has that turn's remaining steps logged ("Phase:
# Ai(k)-x's End step"; Forge prints "Active player is no longer in the game..."), so only the steps up to the draw
# step count as a mention: a draw from an empty library is the last thing such a player can do in their step lines.
PHASE_MENTION_STEPS = ("Untap step", "Upkeep step", "Draw step")
# Loss reasons (Forge's PlayerOutcome text) whose fatal log line can be found exactly.
LOST_LIFE = "has lost because life total reached 0"
LOST_POISON = "has lost because of obtaining 10 poison counters"
LOST_COMMANDER = "has lost due to accumulation of 21 damage from generals"


# ---------------------------------------------------------------- java.util.Random (for Forge's first player)

MASK48 = (1 << 48) - 1
MULT = 0x5DEECE66D


def _i32(x):
    x &= 0xFFFFFFFF
    return x - (1 << 32) if x & 0x80000000 else x


class JavaRandom:
    """java.util.Random, bit for bit (seed scrambling, next(bits), nextInt(bound))."""

    def __init__(self, seed):
        self.s = (seed ^ MULT) & MASK48

    def next(self, bits):
        self.s = (self.s * MULT + 0xB) & MASK48
        return _i32(self.s >> (48 - bits))

    def next_int(self, bound):
        r = self.next(31)
        m = bound - 1
        if bound & m == 0:
            return _i32((bound * r) >> 31)
        u = r
        while True:
            r = u % bound
            if _i32(u - r + m) >= 0:
                return r
            u = self.next(31)


def java_long(seed):
    seed &= (1 << 64) - 1
    return seed - (1 << 64) if seed >= 1 << 63 else seed


def forge_first_index(seed, library_sizes):
    """The 0-based position Forge's sim picks to go first in game 1, for decks passed in this order with these
    library sizes (main deck cards; commanders don't count). Forge 2.0.15: after `-s` seeds MyRandom, the only
    draws before the pick are each library's Collections.shuffle (size - 1 nextInt calls, positions in order),
    then Aggregates.random(players) = nextInt(players). Checked against 14 Forge games (2026-10-19)."""
    rnd = JavaRandom(java_long(seed))
    for size in library_sizes:
        for i in range(size, 1, -1):
            rnd.next_int(i)
    return rnd.next_int(len(library_sizes))


def seat_rotation(seed, library_sizes):
    """(r, predicted): pass schedule seat (p - r) % n at Forge position p, so Forge's first player is seat 0.
    predicted is False if no rotation lines up (then r is the best guess and first_seat shows what happened)."""
    n = len(library_sizes)
    for r in range(n):
        sizes = [library_sizes[(p - r) % n] for p in range(n)]
        if forge_first_index(seed, sizes) == r:
            return r, True
    return forge_first_index(seed, library_sizes), False


# ---------------------------------------------------------------- decks

def parse_deck(text):
    """(commanders [(qty, name)], main [(qty, name)]) by the phase runner's rules (yama_play::lab::parse_deck):
    Commander/Deck headers (and their aliases), sideboard-like sections ignored, '#' and '//' comments, '1x'."""
    section = "main"
    commanders, main = [], []
    for raw in text.splitlines():
        line = raw.strip().lstrip("﻿")
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        header = line.rstrip(":").lower()
        if header in ("commander", "commanders"):
            section = "commander"
            continue
        if header in ("deck", "main", "mainboard", "maindeck"):
            section = "main"
            continue
        if header in ("sideboard", "maybeboard", "considering", "tokens"):
            section = "ignored"
            continue
        if section == "ignored":
            continue
        parts = line.split(None, 1)
        qty, name = 1, line
        if len(parts) == 2:
            q = parts[0].rstrip("xX")
            if q.isdigit():
                qty, name = int(q), parts[1].strip()
        if not name or qty == 0:
            raise ValueError(f"bad line {raw!r}")
        (commanders if section == "commander" else main).append((qty, name))
    if not commanders:
        raise ValueError("no Commander section")
    return commanders, main


def dck_text(deck_id, commanders, main):
    name = deck_id.lower()  # Forge's AI plays any deck whose name contains "Control" as a control deck
    lines = ["[metadata]", f"Name={name}", "[Commander]"]
    lines += [f"{q} {n}" for q, n in commanders]
    lines.append("[Main]")
    lines += [f"{q} {n}" for q, n in main]
    return "\n".join(lines) + "\n"


class Deck:
    def __init__(self, deck_id, commanders, main, dck_rel):
        self.id = deck_id
        self.commanders = commanders
        self.main = main
        self.dck_rel = dck_rel  # path under DECK_CACHE, as passed to Forge's -d
        self.library = sum(q for q, _ in main)
        self.cards = self.library + sum(q for q, _ in commanders)
        self.unknown = []

    def names(self):
        return [n for _, n in self.commanders] + [n for _, n in self.main]


def load_deck(decks_root, deck_id, cache=DECK_CACHE):
    """Read deck `deck_id` (a path under decks_root without .txt) and write its cached .dck. Raises ValueError."""
    path = Path(decks_root) / f"{deck_id}.txt"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise ValueError(f"{deck_id}: can't read {path} ({e.strerror})")
    try:
        commanders, main = parse_deck(text)
    except ValueError as e:
        raise ValueError(f"{deck_id}: {e}")
    rel = f"{deck_id}.dck"
    out = Path(cache) / rel
    body = dck_text(deck_id, commanders, main)
    if not out.is_file() or out.read_text(encoding="utf-8") != body:
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + f".{os.getpid()}.tmp")
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, out)
    return Deck(deck_id, commanders, main, rel)


# ---------------------------------------------------------------- Forge install and card database

class Forge:
    def __init__(self, forge_dir, java):
        self.dir = Path(forge_dir).expanduser().resolve()
        jars = sorted(self.dir.glob("forge-gui-desktop-*-jar-with-dependencies.jar"))
        if not jars:
            raise SystemExit(f"no forge-gui-desktop-*-jar-with-dependencies.jar in {self.dir} (--forge-dir)")
        self.jar = jars[-1]
        self.version = re.match(r"forge-gui-desktop-(.+)-jar-with-dependencies\.jar", self.jar.name).group(1)
        self.res = self.dir / "res"
        if not (self.res / "cardsfolder/cardsfolder.zip").is_file():
            raise SystemExit(f"{self.res}/cardsfolder/cardsfolder.zip missing; is {self.dir} a Forge release?")
        self.java = str(java)
        self.engine = f"forge {self.version}"
        self.card_data = f"forge res {self.version}"


def default_forge_dir():
    env = os.environ.get("FORGE_DIR")
    if env:
        return env
    found = sorted(DEFAULT_FORGE_HOME.glob("forge-[0-9]*"), key=lambda p: [int(x) if x.isdigit() else 0
                                                                             for x in re.split(r"[.-]", p.name[6:])])
    return str(found[-1]) if found else str(DEFAULT_FORGE_HOME / "forge-2.0.15")


def default_java():
    env = os.environ.get("FORGE_JAVA")
    if env:
        return env
    if DEFAULT_JAVA.exists():
        return str(DEFAULT_JAVA)
    return shutil.which("java") or "java"


def java_major(java):
    """Major version of a Java binary (17 for "17.0.19", 8 for "1.8.0"), or None if it can't be read."""
    try:
        p = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r'version "(\d+)(?:\.(\d+))?', p.stderr + p.stdout)
    if not m:
        return None
    major = int(m.group(1))
    return int(m.group(2) or 0) if major == 1 else major


def norm_name(name):
    s = unicodedata.normalize("NFKD", name.replace("’", "'"))
    return "".join(ch for ch in s if not unicodedata.combining(ch)).casefold().strip()


def card_index(forge):
    """{normalized name: [card name, AI flag]} from Forge's card scripts: every face name, split cards as
    "A // B", and Universes Within flavour names (Forge resolves those too). AI flag is "All", "Random" or ""
    (AI:RemoveDeck: Forge's note that its AI plays the card badly). Cached per Forge version."""
    zpath = forge.res / "cardsfolder/cardsfolder.zip"
    st = zpath.stat()
    cache = CACHE / f"forge-card-index-{forge.version}.json"
    stamp = f"{st.st_size}:{int(st.st_mtime)}"
    if cache.is_file():
        try:
            data = json.loads(cache.read_text())
            if data.get("stamp") == stamp:
                return data["names"]
        except (OSError, ValueError):
            pass
    names = {}
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            if not info.filename.endswith(".txt"):
                continue
            text = z.read(info).decode("utf-8", "replace")
            faces = re.split(r"^ALTERNATE\s*$", text, flags=re.M)
            face_names = []
            for f in faces:
                m = re.search(r"^Name:(.+?)\s*$", f, re.M)
                if m:
                    face_names.append(m.group(1))
            if not face_names:
                continue
            canon = face_names[0]
            flag = re.search(r"^AI:RemoveDeck:(All|Random)", text, re.M)
            entry = [canon, flag.group(1) if flag else ""]
            for nm in face_names:
                names.setdefault(norm_name(nm), entry)
            mode = re.search(r"^AlternateMode:(\w+)", text, re.M)
            if mode and mode.group(1) == "Split" and len(face_names) == 2:
                names.setdefault(norm_name(" // ".join(face_names)), entry)
            for fl in re.findall(r"^Variant:[^:\n]+:FlavorName:(.+?)\s*$", text, re.M):
                names.setdefault(norm_name(fl), entry)
    cache.parent.mkdir(parents=True, exist_ok=True)
    C.write_json(cache, {"forge": forge.version, "stamp": stamp, "names": names}, indent=None)
    return names


BASICS = {"plains", "island", "swamp", "mountain", "forest", "wastes", "snow-covered plains", "snow-covered island",
          "snow-covered swamp", "snow-covered mountain", "snow-covered forest", "snow-covered wastes"}


def check_deck(deck, names):
    """Fill deck.unknown; return {"unknown": [...], "ai_all": [...], "ai_random": [...], "nonbasic": n}."""
    unknown, ai_all, ai_random, nonbasic = [], [], [], 0
    for nm in deck.names():
        e = names.get(norm_name(nm))
        if norm_name(nm) not in BASICS:
            nonbasic += 1
        if e is None:
            unknown.append(nm)
        elif e[1] == "All":
            ai_all.append(nm)
        elif e[1] == "Random":
            ai_random.append(nm)
    deck.unknown = unknown
    return {"unknown": unknown, "ai_all": ai_all, "ai_random": ai_random, "nonbasic": nonbasic}


# ---------------------------------------------------------------- runner identity

def runner_label():
    src = Path(__file__).resolve()
    h = hashlib.sha256(src.read_bytes()).hexdigest()[:8]
    try:
        sha = subprocess.run(["git", "-C", str(C.ROOT), "rev-parse", "--short", "HEAD"], capture_output=True,
                             text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(C.ROOT), "status", "--porcelain", "--", str(src)],
                               capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        # No git checkout (the saget image, yama-lab deploy/Dockerfile.forge): deploy/forge-lab.sh passes the commit
        # and whether this file differed from it; the hash is still this file's own.
        sha = os.environ.get("FORGE_RUNNER_GIT_SHA", "").strip()
        if not sha:
            return f"forge_runner.py nogit-{h}"
        dirty = os.environ.get("FORGE_RUNNER_GIT_DIRTY", "").strip() not in ("", "0")
    return f"forge_runner.py {sha}-dirty-{h}" if dirty else f"forge_runner.py {sha}"


# ---------------------------------------------------------------- one game

def placements(players, winner, out_groups):
    """Same rule as yama_play::lab::placements: winner alone; other survivors tied; then eliminated players,
    later elimination better, players eliminated by the same event tied. Seats ascending in a group."""
    out = {s for g in out_groups for s in g}
    groups = []
    if winner is not None:
        groups.append([winner])
    rest = [s for s in range(players) if s not in out and s != winner]
    if rest:
        groups.append(rest)
    for g in reversed(out_groups):
        g = sorted(s for s in g if s != winner)
        if g:
            groups.append(g)
    return groups


def new_result(job, forge, runner, profile):
    return {"game": job["game"], "seed": job["seed"], "difficulty": profile, "decks": list(job["decks"]),
            "first_seat": None, "winner": None, "placements": [], "eliminations": [], "end": "error", "turns": 0,
            "actions": None, "ms": 0, "final_life": [], "engine": forge.engine, "card_data": forge.card_data,
            "runner": runner, "error": None}


def parse_game(stdout, stderr, n, rotation, max_turns):
    """Read one Forge sim game (stdout and stderr text). Positions are Forge's (0-based Ai(k) - 1); seats are the
    schedule's: seat = (position - rotation) % n. Returns a dict of result fields plus notes."""
    seat = lambda pos: (pos - rotation) % n  # noqa: E731
    lines = stdout.splitlines()
    info = {"notes": [], "ai_timeouts": sum(1 for x in lines if x.startswith("AI eval thread at timeout")),
            "unsupported": [], "forge_turns": None}
    info["unsupported"] = sorted({m.group(1) for x in stderr.splitlines() for m in [UNSUPPORTED_RE.match(x)] if m})
    try:
        start = next(i for i, x in enumerate(lines) if x.strip() == "Simulation mode")
    except StopIteration:
        info["error"] = "Forge didn't reach simulation mode"
        return info
    for x in lines[start + 1:]:
        if x.startswith("Could not load deck - ") or x.startswith("Unknown AI profile - "):
            info["error"] = f"{DECK_ERRORS} Forge: {x.strip()}" if x.startswith("Could") else f"Forge: {x.strip()}"
            return info
    stopping = any(x.strip() == "Stopping slow match as draw" for x in lines)
    entries = []  # (caption, message)
    for x in lines[start + 1:]:
        m = LOG_RE.match(x)
        if m:
            entries.append((m.group(1), m.group(2)))
    life = [LIFE_START] * n
    turn = 0
    first_pos = None
    last_mention = {}  # pos -> entry index
    last_life = {}  # pos -> (entry index, life after) of the player's last "Life" line
    last_hit = {}  # pos -> entry index of the last "Damage" line that hit the player (damage or poison)
    turn_at = []  # entry index -> turn
    cut = None  # entry index where turn max_turns + 1 began
    life_at_cut = None
    outcomes = {}
    ms = None
    for i, (cap, msg) in enumerate(entries):
        if cap == "Turn":
            m = TURN_RE.match(msg)
            if m:
                t = int(m.group(1))
                if first_pos is None:
                    first_pos = int(m.group(2)) - 1
                if cut is None and max_turns and t > max_turns:
                    cut, life_at_cut = i, list(life)
                turn = max(turn, t)
        turn_at.append(turn)
        if cap == "Game Outcome":
            m = OUTCOME_RE.match(msg)
            if m:
                outcomes[int(m.group(1)) - 1] = m.group(2)
            continue
        if cap in NO_MENTION_CAPTIONS:
            continue
        if cap == "Life":
            m = LIFE_RE.match(msg)
            if m and 1 <= int(m.group(1)) <= n:
                life[int(m.group(1)) - 1] = int(m.group(3))
                last_life[int(m.group(1)) - 1] = (i, int(m.group(3)))
        elif cap == "Damage":
            for m in HIT_RE.finditer(msg):
                k = int(m.group(1) or m.group(2)) - 1
                if 0 <= k < n:
                    last_hit[k] = i
        elif cap == "Phase" and not msg.rstrip(".").endswith(PHASE_MENTION_STEPS):
            continue
        for m in MENTION_RE.finditer(msg):
            k = int(m.group(1)) - 1
            if 0 <= k < n:
                last_mention[k] = i
    for x in lines:
        m = RESULT_MS_RE.match(x)
        if m:
            ms = int(m.group(1) or m.group(2))
    info["forge_turns"] = turn
    info["ms"] = ms
    if first_pos is not None:
        info["first_seat"] = seat(first_pos)
        info["first_pos"] = first_pos
    if not outcomes:
        exc = last_exception(stderr)
        info["error"] = "no game outcome in Forge's output" + (f" ({exc})" if exc else "")
        return info

    won = sorted(p for p, o in outcomes.items() if o.startswith("has won"))
    opp_won = {p for p, o in outcomes.items() if o.startswith("has lost because an opponent has won")}
    drew = {p for p, o in outcomes.items() if o.startswith("has accepted that the game is a draw")}
    out = [p for p, o in outcomes.items() if (o.startswith("has lost") or o.startswith("has conceded"))
           and p not in opp_won]
    def fatal(p):
        """Entry index where player p went out. Forge logs no elimination, so: the line that did it when the loss
        reason names one (last life change, if it went to 0 or less; last poison counters; last damage or life
        change for commander damage) and it falls in the turn of the player's last mention; else the last mention
        (trigger lines can still name a player after the damage that put them out)."""
        lm = last_mention.get(p, -1)
        o = outcomes[p]
        cand = -1
        if o.startswith(LOST_LIFE):
            li = last_life.get(p)
            cand = li[0] if li and li[1] <= 0 else -1
        elif o.startswith(LOST_POISON):
            cand = last_hit.get(p, -1)
        elif o.startswith(LOST_COMMANDER):
            cand = max(last_hit.get(p, -1), last_life.get(p, (-1, 0))[0])
        return cand if 0 <= cand <= lm and turn_at[cand] == turn_at[lm] else lm

    fatal_at = {p: fatal(p) for p in out}
    capped = cut is not None
    if capped:
        out = [p for p in out if fatal_at[p] < cut]
    order = sorted(out, key=lambda p: (fatal_at[p], p))
    groups = []
    for p in order:
        i = fatal_at[p]
        if groups:
            j = fatal_at[groups[-1][-1]]
            between = entries[j + 1:i] if 0 <= j < i else []
            if i >= 0 and j >= 0 and turn_at[i] == turn_at[j] and all(c in TIE_CAPTIONS for c, _ in between):
                groups[-1].append(p)
                continue
        groups.append([p])
    info["eliminations"] = [{"seat": seat(p), "turn": turn_at[fatal_at[p]] if fatal_at[p] >= 0 else 0}
                            for g in groups for p in g]
    seat_groups = [[seat(p) for p in g] for g in groups]
    info["final_life"] = [0] * n
    for pos in range(n):
        info["final_life"][seat(pos)] = (life_at_cut if capped else life)[pos]
    info["turns"] = max_turns if capped else turn

    exc = last_exception(stderr)
    if capped:
        end, winner = "turn_cap", None
        info["notes"].append(f"Forge played on to turn {turn}; cut at turn {max_turns} (max_turns)")
    elif stopping:
        end, winner = "time_cap", None
    elif len(won) == 1:
        end, winner = "win", seat(won[0])
    elif not won and (drew or len(out) == n or len(out) + len(opp_won) == n):
        end, winner = "draw", None
    else:
        end, winner = "error", None
        info["error"] = (f"engine error: {exc}" if exc else
                         f"unclear outcome: {len(won)} players reported as winners without a time-out")
    info["end"] = end
    info["winner"] = winner
    if end != "error":
        info["placements"] = placements(n, winner, seat_groups)
    return info


def last_exception(stderr):
    """The last Java exception line on stderr: the one that ended the game, if any (Forge prints the ones its AI
    caught during the game first, and the one that escaped the game after it)."""
    found = [x.strip() for x in stderr.splitlines() if EXCEPTION_RE.match(x.strip())]
    return found[-1] if found else None


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


class Runner:
    def __init__(self, args, forge, decks, runner):
        self.args = args
        self.forge = forge
        self.decks = decks
        self.runner = runner
        self.live = set()
        self.lock = threading.Lock()
        self.stopping = False
        self.work = queue.Queue()
        WORK_ROOT.mkdir(parents=True, exist_ok=True)
        self.work_dirs = []
        for n in range(args.threads):
            w = Path(tempfile.mkdtemp(prefix=f"w{n}-", dir=WORK_ROOT))
            (w / "userdata").mkdir()
            (w / "cache").mkdir()
            (w / "res").symlink_to(forge.res)
            (w / "forge.profile.properties").write_text(f"userDir={w}/userdata/\ncacheDir={w}/cache/\n")
            self.work_dirs.append(w)
            self.work.put(w)

    def cleanup(self):
        if self.args.keep_work:
            return
        for w in self.work_dirs:
            shutil.rmtree(w, ignore_errors=True)

    def kill_all(self):
        self.stopping = True
        with self.lock:
            for p in list(self.live):
                kill_group(p)

    def play(self, job):
        """Run one game; return (result dict, stats dict)."""
        args, forge = self.args, self.forge
        res = new_result(job, forge, self.runner, args.profile)
        decks = [self.decks[d] for d in job["decks"]]
        n = len(decks)
        rotation, predicted = seat_rotation(job["seed"], [d.library for d in decks])
        order = [decks[(p - rotation) % n] for p in range(n)]
        cap = args.max_seconds or int(job["max_seconds"])
        cmd = [forge.java, f"-Xmx{args.xmx}", "-Dfile.encoding=UTF-8", "-Djava.awt.headless=true"]
        if args.jvm_cpus:
            cmd.append(f"-XX:ActiveProcessorCount={args.jvm_cpus}")
        cmd += ["-jar", str(forge.jar), "sim", "-f", "Commander", "-D", str(DECK_CACHE), "-d"]
        cmd += [d.dck_rel for d in order]
        cmd += ["-n", "1", "-s", str(java_long(job["seed"])), "-c", str(cap), "-a"] + [args.profile] * n
        stats = {"game": job["game"], "rotation": rotation, "rotation_predicted": predicted, "cap_s": cap}
        w = self.work.get()
        try:
            out_path, err_path = w / "game.out", w / "game.err"
            t0 = time.monotonic()
            with open(out_path, "wb") as fo, open(err_path, "wb") as fe:
                if self.stopping:
                    raise KeyboardInterrupt
                proc = subprocess.Popen(cmd, cwd=w, stdout=fo, stderr=fe, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
                with self.lock:
                    self.live.add(proc)
                killed = threading.Event()

                def on_timeout():
                    killed.set()
                    kill_group(proc)
                timer = threading.Timer(cap + KILL_GRACE, on_timeout)
                timer.daemon = True
                timer.start()
                try:
                    _, status, ru = os.wait4(proc.pid, 0)
                finally:
                    timer.cancel()
                    with self.lock:
                        self.live.discard(proc)
                proc.returncode = os.waitstatus_to_exitcode(status)
                kill_group(proc)  # anything the JVM left behind in its group
            wall = time.monotonic() - t0
            rss = ru.ru_maxrss if sys.platform == "darwin" else ru.ru_maxrss * 1024
            stats.update({"wall_s": round(wall, 2), "cpu_s": round(ru.ru_utime + ru.ru_stime, 2),
                          "rss_mb": round(rss / 2**20), "exit": proc.returncode})
            stdout = out_path.read_text(encoding="utf-8", errors="replace")
            stderr = err_path.read_text(encoding="utf-8", errors="replace")
            if self.stopping:
                raise KeyboardInterrupt
            info = parse_game(stdout, stderr, n, rotation, int(job["max_turns"]))
            for k in ("first_seat", "winner", "placements", "eliminations", "end", "turns", "final_life"):
                if k in info:
                    res[k] = info[k]
            res["ms"] = info.get("ms") if info.get("ms") is not None else int(wall * 1000)
            if info.get("unsupported"):
                res["end"], res["placements"], res["winner"] = "error", [], None
                res["error"] = (f"{DECK_ERRORS} Forge {forge.version} doesn't support: "
                                + "; ".join(info["unsupported"]))
            elif killed.is_set():
                res["end"], res["placements"], res["winner"] = "error", [], None
                res["error"] = (f"killed: Forge still running {cap + KILL_GRACE}s after start "
                                f"(its own time limit, -c, is {cap}s)")
            elif info.get("error"):
                res["end"], res["placements"], res["winner"] = "error", [], None
                res["error"] = info["error"]
                if proc.returncode not in (0, None):
                    res["error"] += f" (exit {proc.returncode})"
                tail = [x for x in stderr.splitlines() if x.strip() and "was not assigned to any set" not in x]
                if tail and "no game outcome" in res["error"]:
                    res["error"] += " | stderr: " + " / ".join(tail[-3:])[:400]
            stats.update({"ai_timeouts": info.get("ai_timeouts", 0), "forge_turns": info.get("forge_turns"),
                          "notes": info.get("notes", [])})
            if res["first_seat"] not in (None, 0):
                stats["notes"].append(f"first player was seat {res['first_seat']}, not seat 0 "
                                      f"(Forge position {info.get('first_pos')}, rotation {rotation})")
            self.keep_log(job["game"], res, stats, out_path, err_path)
        finally:
            self.work.put(w)
        return res, stats

    def keep_log(self, game, res, stats, out_path, err_path):
        mode = self.args.keep_logs
        unusual = res["end"] not in ("win", "draw") or stats.get("notes") or stats.get("ai_timeouts")
        if mode == "none" or (mode == "failed" and not unusual):
            return
        d = self.args.logs_dir
        d.mkdir(parents=True, exist_ok=True)
        for src, ext in ((out_path, "out"), (err_path, "err")):
            with open(src, "rb") as fi, gzip.open(d / f"{game}.{ext}.gz", "wb") as fo:
                shutil.copyfileobj(fi, fo)


# ---------------------------------------------------------------- schedule, resume

def read_schedule(path):
    jobs, seen = [], set()
    with open(path) as f:
        for ln, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                j = json.loads(line)
            except json.JSONDecodeError as e:
                raise SystemExit(f"{path} line {ln}: {e}")
            for k in ("game", "seed", "decks", "max_turns", "max_seconds"):
                if k not in j:
                    raise SystemExit(f"{path} line {ln}: no {k}")
            if not isinstance(j["decks"], list) or not 2 <= len(j["decks"]) <= 6:
                raise SystemExit(f"{path} line {ln}: game {j['game']}: a Commander game here has 2 to 6 decks")
            if j["game"] in seen:
                raise SystemExit(f"{path} line {ln}: game id {j['game']!r} appears twice")
            seen.add(j["game"])
            jobs.append(j)
    return jobs


def done_games(path, retry_before=None):
    """(ids played, ids whose only lines get replayed). Drops a partial last line left by a kill. Deck-error lines
    never count as played; with retry_before, error/panic lines that start before that byte offset don't either."""
    p = Path(path)
    if not p.is_file():
        return set(), set()
    data = p.read_bytes()
    keep = data.rfind(b"\n") + 1
    if keep < len(data):
        print(f"forge: dropped a partial last line ({len(data) - keep} bytes) from {path}", file=sys.stderr)
        with open(p, "r+b") as f:
            f.truncate(keep)
    ids, retry = set(), set()
    offset = 0
    for raw in data[:keep].split(b"\n"):
        start = offset
        offset += len(raw) + 1
        if not raw.strip():
            continue
        try:
            v = json.loads(raw)
        except ValueError:
            print(f"forge: warning: unreadable line in {path} ignored", file=sys.stderr)
            continue
        gid = v.get("game")
        if not isinstance(gid, str):
            continue
        err = v.get("error") or ""
        failed = v.get("end") in ("error", "panic")
        if err.startswith(DECK_ERRORS) or (failed and retry_before is not None and start < retry_before):
            retry.add(gid)
        else:
            ids.add(gid)
    return ids, retry - ids


def stats_path(out):
    out = Path(out)
    name = out.name
    return out.with_name("forge-stats" + name[len("results"):] if name.startswith("results") else "forge-stats-" + name)


def line_of(res):
    return json.dumps(res, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------- card check mode

def forge_load_check(forge, names, args):
    """Ask Forge itself: load one deck holding every name, then a missing second deck so no game starts. Returns
    the names Forge reports as unsupported, or None if the check couldn't run."""
    tmp = Path(tempfile.mkdtemp(prefix="forge-check-", dir=CACHE))
    try:
        (tmp / "work").mkdir()
        (tmp / "work/res").symlink_to(forge.res)
        (tmp / "work/forge.profile.properties").write_text(f"userDir={tmp}/work/u/\ncacheDir={tmp}/work/c/\n")
        body = "[metadata]\nName=check\n[Commander]\n1 Sol Ring\n[Main]\n" + "".join(f"1 {x}\n" for x in names)
        (tmp / "all.dck").write_text(body, encoding="utf-8")
        cmd = [forge.java, f"-Xmx{args.xmx}", "-Dfile.encoding=UTF-8", "-Djava.awt.headless=true", "-jar",
               str(forge.jar), "sim", "-f", "Commander", "-D", str(tmp), "-d", "all.dck", "no-such-deck.dck", "-n", "1"]
        p = subprocess.run(cmd, cwd=tmp / "work", capture_output=True, text=True, timeout=600)
        if "Simulation mode" not in p.stdout:
            print(f"forge: card check with Forge didn't start (exit {p.returncode}): {p.stderr[-400:]}", file=sys.stderr)
            return None
        return sorted({m.group(1) for x in p.stderr.splitlines() for m in [UNSUPPORTED_RE.match(x)] if m})
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"forge: card check with Forge failed: {e}", file=sys.stderr)
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_cards(args, forge):
    root = Path(args.decks_root)
    if args.schedule:
        ids = sorted({d for j in read_schedule(args.schedule) for d in j["decks"]})
    else:
        ids = sorted(str(p.relative_to(root).with_suffix("")) for p in root.rglob("*.txt"))
    names = card_index(forge)
    index = C.load_index(args.index) if Path(args.index).is_file() else {"decks": []}
    meta = {d["id"]: d for d in index["decks"]}
    rows, bad, all_names, deck_names = [], [], set(), {}
    for deck_id in ids:
        try:
            deck = load_deck(root, deck_id)
        except ValueError as e:
            bad.append(str(e))
            continue
        r = check_deck(deck, names)
        deck_names[deck_id] = set(deck.names())
        all_names.update(deck_names[deck_id])
        m = meta.get(deck_id, {})
        rows.append({"id": deck_id, "name": m.get("name"), "set": m.get("set"), "kind": m.get("kind"),
                     "cards": deck.cards, "nonbasic": r["nonbasic"], "missing": r["unknown"],
                     "ai_remove_all": r["ai_all"], "ai_remove_random": r["ai_random"]})
    forge_says = None if args.no_forge_check else forge_load_check(forge, sorted(all_names), args)
    py_missing = {x for r in rows for x in r["missing"]}
    agree = None
    if forge_says is not None:
        agree = {"forge_unsupported": forge_says, "only_forge": sorted(set(forge_says) - py_missing),
                 "only_index": sorted(py_missing - set(forge_says))}
        for r in rows:  # Forge's own answer wins
            r["missing"] = sorted(deck_names[r["id"]] & set(forge_says))
    missing_decks = [r for r in rows if r["missing"]]
    print(f"forge {forge.version}: {len(rows)} decks checked ({len(all_names)} distinct names); "
          f"{len(missing_decks)} with cards Forge doesn't know" + (f"; {len(bad)} unreadable" if bad else ""))
    for r in missing_decks:
        print(f"  {r['id']}: {'; '.join(r['missing'])}")
    for b in bad:
        print(f"  unreadable: {b}")
    if agree is not None:
        print(f"  Forge's own load check: {len(agree['forge_unsupported'])} names unsupported"
              + (f"; differs from the script index: only Forge {agree['only_forge']}, only index {agree['only_index']}"
                 if agree["only_forge"] or agree["only_index"] else "; same as the script index"))
    flagged = sorted(rows, key=lambda r: -len(r["ai_remove_all"]))
    alls = [len(r["ai_remove_all"]) for r in rows]
    if alls:
        print(f"  AI:RemoveDeck:All cards per deck (Forge's AI plays them badly): median "
              f"{sorted(alls)[len(alls) // 2]}, max {max(alls)} ({flagged[0]['id']})")
    if args.report:
        rep = {"engine": forge.engine, "card_data": forge.card_data, "checked": date.today().isoformat(),
               "forge_dir": str(forge.dir), "decks_root": C.rel(root),
               "method": ("Every name in each deck file looked up in Forge's card scripts (res/cardsfolder/"
                          "cardsfolder.zip: face names, split cards as 'A // B', Universes Within flavour names; "
                          "case and accents ignored), then confirmed by Forge itself loading one deck with every "
                          "name (stderr 'An unsupported card was requested'). ai_remove_all / ai_remove_random: "
                          "cards whose script has AI:RemoveDeck:All / Random, Forge's note that its AI plays them "
                          "badly; they stay in the deck in sim games."),
               "forge_load_check": agree, "unreadable": bad, "decks": rows}
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        C.write_json(Path(args.report), rep)
        print(f"  wrote {C.rel(args.report)}")
    return 4 if missing_decks or bad else 0


# ---------------------------------------------------------------- main

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--decks-root", default=str(C.SIM / "decks"))
    p.add_argument("--schedule")
    p.add_argument("--out")
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--skip-done", action="store_true")
    p.add_argument("--retry-errors", action="store_true")
    p.add_argument("--forge-dir", default=None, help="Forge release directory (default: newest "
                   "~/Developer/forge-engine/forge-*, or $FORGE_DIR)")
    p.add_argument("--java", default=None, help="Java 17 binary (default: Homebrew openjdk@17, $FORGE_JAVA, or java)")
    p.add_argument("--profile", default="Default", choices=PROFILES, help="Forge AI profile on every seat")
    p.add_argument("--xmx", default="2g", help="JVM heap per game")
    p.add_argument("--jvm-cpus", type=int, default=2, help="-XX:ActiveProcessorCount per JVM (0: JVM default)")
    p.add_argument("--max-seconds", type=int, default=None, help="Forge's wall-clock limit per game (default: the "
                   "schedule's max_seconds)")
    p.add_argument("--keep-logs", choices=["failed", "all", "none"], default="failed",
                   help="keep Forge's output (gzipped) for unusual games, every game, or none")
    p.add_argument("--logs-dir", default=None, help="default data/sim/cache/forge-logs/<out's directory name>")
    p.add_argument("--keep-work", action="store_true", help="keep the per-thread Forge working directories")
    p.add_argument("--limit", type=int, default=None, help="play at most this many games (after --skip-done)")
    p.add_argument("--check-cards", action="store_true", help="check decks against Forge's card database and exit")
    p.add_argument("--no-forge-check", action="store_true", help="--check-cards: skip asking Forge itself")
    p.add_argument("--report", default=None, help="--check-cards: write a JSON report here")
    p.add_argument("--index", default=str(C.INDEX))
    args = p.parse_args(argv)

    forge = Forge(args.forge_dir or default_forge_dir(), args.java or default_java())
    if args.check_cards:
        return check_cards(args, forge)
    if not args.schedule or not args.out:
        p.error("--schedule and --out are required (or --check-cards)")
    if args.threads < 1:
        p.error("--threads must be positive")
    if args.retry_errors and not args.skip_done:
        p.error("--retry-errors only makes sense with --skip-done")
    out = Path(args.out)
    args.logs_dir = Path(args.logs_dir) if args.logs_dir else LOG_ROOT / out.resolve().parent.name

    jobs = read_schedule(args.schedule)
    scheduled = len(jobs)
    skipped = 0
    if args.skip_done:
        retry_before = out.stat().st_size if (args.retry_errors and out.is_file()) else None
        done, replays = done_games(out, retry_before)
        jobs = [j for j in jobs if j["game"] not in done]
        skipped = scheduled - len(jobs)
        if replays & {j["game"] for j in jobs}:
            print(f"forge: {len(replays & {j['game'] for j in jobs})} games have only a failed result so far "
                  "(deck errors, or --retry-errors) and are played again", file=sys.stderr)
    elif out.is_file() and out.stat().st_size > 0:
        raise SystemExit(f"{out} already has results; pass --skip-done to resume it, or choose a new --out")
    if args.limit is not None:
        jobs = jobs[:args.limit]
    runner = runner_label()
    print(f"forge: runner {runner}, {forge.engine} ({forge.jar.name}, java {forge.java}); {scheduled} games "
          f"scheduled, {skipped} already done, {len(jobs)} to play on {args.threads} threads", file=sys.stderr)
    if not jobs:
        return 0
    major = java_major(forge.java)
    if major is None or major >= 20:
        print(f"forge: warning: {forge.java} is Java {major or '(version unreadable)'}; use Java 17: from Java 20 on, "
              "Forge can't stop an AI decision that runs out of time and that thread keeps burning a core "
              "(--java, $FORGE_JAVA)", file=sys.stderr)

    # Decks: read, convert, check against Forge's card database.
    names = card_index(forge)
    decks, bad = {}, {}
    for deck_id in sorted({d for j in jobs for d in j["decks"]}):
        try:
            decks[deck_id] = load_deck(args.decks_root, deck_id)
        except ValueError as e:
            bad[deck_id] = str(e)
            print(f"forge: deck error: {e}", file=sys.stderr)
            continue
        check_deck(decks[deck_id], names)
        if decks[deck_id].cards != 100:
            print(f"forge: warning: {deck_id} has {decks[deck_id].cards} cards, not 100", file=sys.stderr)
    unknown = {d: x.unknown for d, x in decks.items() if x.unknown}
    for d, u in unknown.items():
        print(f"forge: {d}: not in Forge {forge.version}'s card database: {'; '.join(u)}", file=sys.stderr)
    print(f"forge: {len(decks) + len(bad)} decks, {len(bad)} unreadable, {len(unknown)} with cards Forge doesn't know",
          file=sys.stderr)
    if bad and len(bad) == len(decks) + len(bad):
        raise SystemExit(f"no deck loaded; check --decks-root {args.decks_root}; nothing was written")
    unplayable = [j["game"] for j in jobs if any(d in bad for d in j["decks"])]
    if unplayable:
        print(f"forge: {len(unplayable)} games not played because a deck file didn't load (not written; fix the "
              f"decks and rerun with --skip-done): {', '.join(unplayable[:10])}{', ...' if len(unplayable) > 10 else ''}",
              file=sys.stderr)
    jobs = [j for j in jobs if j["game"] not in set(unplayable)]
    deck_code = 4 if (unplayable or unknown) else 0

    out.parent.mkdir(parents=True, exist_ok=True)
    fout = open(out, "a", encoding="utf-8")
    fstats = open(stats_path(out), "a", encoding="utf-8")
    ends = {}
    written = played = 0
    t_start = time.monotonic()

    def take(res, stats):
        nonlocal written, played
        fout.write(line_of(res) + "\n")
        fout.flush()
        fstats.write(json.dumps(stats, separators=(",", ":")) + "\n")
        fstats.flush()
        written += 1
        played += "wall_s" in stats  # deck-error lines aren't games Forge played
        ends[res["end"]] = ends.get(res["end"], 0) + 1
        rate = played / max((time.monotonic() - t_start) / 3600, 1e-9)
        extra = []
        if stats.get("wall_s") is not None:
            extra.append(f"{stats['wall_s']:.1f}s wall, {stats.get('cpu_s', 0):.0f}s cpu, {stats.get('rss_mb', 0)} MB")
        if stats.get("ai_timeouts"):
            extra.append(f"{stats['ai_timeouts']} AI time-outs")
        extra += stats.get("notes", [])
        if res["error"]:
            extra.append(res["error"][:200])
        print(f"forge: {written + skipped}/{scheduled} done ({skipped} skipped) | {rate:.1f} games/h | {res['game']} "
              f"{res['end']} turn {res['turns']} | {' | '.join(extra)} | "
              + ", ".join(f"{k} {v}" for k, v in sorted(ends.items())), file=sys.stderr)

    playable = []
    for j in jobs:
        miss = [f"{d}: not in Forge {forge.version}: {'; '.join(unknown[d])}" for d in dict.fromkeys(j["decks"])
                if d in unknown]
        if miss:
            res = new_result(j, forge, runner, args.profile)
            res["error"] = f"{DECK_ERRORS} " + " | ".join(miss)
            take(res, {"game": j["game"], "skipped": "unknown cards"})
        else:
            playable.append(j)

    if threading.current_thread() is threading.main_thread():
        # The JVMs run in their own sessions, so a plain kill of this script would leave them playing on until
        # their own time limit: treat SIGTERM like Ctrl-C (kill the running games, write nothing for them).
        def on_term(_signum, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, on_term)
    r = Runner(args, forge, decks, runner)
    interrupted = False
    try:
        with ThreadPoolExecutor(max_workers=args.threads) as ex:
            futs = {ex.submit(r.play, j): j for j in playable}
            try:
                for fut in as_completed(futs):
                    j = futs[fut]
                    try:
                        res, stats = fut.result()
                    except KeyboardInterrupt:
                        continue
                    except Exception as e:  # a runner bug in one game must not lose the others
                        res = new_result(j, forge, runner, args.profile)
                        res["error"] = f"runner error: {type(e).__name__}: {e}"
                        stats = {"game": j["game"], "runner_error": str(e)}
                    take(res, stats)
            except KeyboardInterrupt:
                interrupted = True
                print("forge: interrupted; killing running games (they are not written)", file=sys.stderr)
                r.kill_all()
                for f in futs:
                    f.cancel()
    finally:
        r.cleanup()
        fout.close()
        fstats.close()
    mins = (time.monotonic() - t_start) / 60
    print(f"forge: finished {written} of {len(jobs)} games in {mins:.1f} min "
          f"({played / max(mins / 60, 1e-9):.1f} games/h played): " + ", ".join(f"{k} {v}" for k, v in sorted(ends.items())),
          file=sys.stderr)
    if interrupted:
        return 130
    if deck_code:
        print("forge: exit code 4: games with decks that didn't load or that Forge doesn't fully know", file=sys.stderr)
    return deck_code


if __name__ == "__main__":
    sys.exit(main())
