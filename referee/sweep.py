#!/usr/bin/env python3
"""Card sweep: one generated scenario per card, played in phase and in Forge, compared.

    python3 referee/sweep.py CARDS.json [--offset N] [--limit N] [--out DIR]

CARDS.json is a list of card names (most important first). For each card the sweep builds a
two-player board with the lands to pay for it and something to target on both sides, casts it
(or plays it, for a land), and lets phase pick targets ("auto_targets"). Forge then replays the
scenario with phase's picks written out, so both engines make the same choices. Results go to
DIR (default /tmp/yama-referee/sweep): scenarios/, resolved/, phase.json, forge.json,
report.json, and a summary on stdout.

An instant that counters a spell faces the opponent's Lightning Bolt (or Ambush Viper for
"creature spell"), cast first.

Skipped: X spells (each AI would pick its own X) and cards with no mana cost that aren't lands.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from compare import diff  # noqa: E402

BASIC = {"White": "Plains", "Blue": "Island", "Black": "Swamp", "Red": "Mountain", "Green": "Forest"}
COLORS = ["White", "Blue", "Black", "Red", "Green"]

# The same board for every card: something of each kind to target on both sides.
SEAT0_BOARD = ["Grizzly Bears"]
SEAT0_GRAVE = ["Hill Giant", "Divination"]
SEAT1_BOARD = ["Grizzly Bears", "Serra Angel", "Millstone", "Seal of Fire"]
SEAT1_HAND = ["Wastes", "Wastes"]
SEAT1_GRAVE = ["Hill Giant"]
# All Wastes, so searches, draws and reveals give both engines the same cards whatever they pick.
LIBRARY = ["Wastes"] * 8


def card_data_path():
    env = os.environ.get("YAMA_ENGINE_CARD_DATA")
    if env:
        return env
    # The card data must match the engine build; use the file the deploy pins.
    pin = re.search(r"^CARD_DATA=(\S+)", open(os.path.join(ROOT, "deploy", "first-time.sh")).read(), re.M)
    return os.path.join(ROOT, "data", "engine", pin.group(1))


def lands_for(cost):
    """Lands that pay this phase mana cost exactly, or None if the cost can't be paid that way."""
    if cost.get("type") != "Cost":
        return None
    lands = []
    for shard in cost.get("shards", []):
        if shard == "X":
            return None
        if shard == "Colorless":
            lands.append("Wastes")
            continue
        color = next((c for c in COLORS if c in shard), None)
        if color is None:
            return None
        if shard.startswith("Two"):
            lands.append(BASIC[color])  # {2/W} paid with W
        else:
            lands.append(BASIC[color])
    lands += ["Wastes"] * cost.get("generic", 0)
    return lands


def spell_to_counter(text):
    """The opponent's spell (and the lands to cast it) for a card that counters a spell; None when
    the card counters nothing, False when the sweep has no fitting spell."""
    t = text.lower()
    if not re.search(r"counter (up to one )?target[^.]*spell", t):
        return None
    if re.search(r"mana value [0-9x]+ or (greater|less)|activated or triggered ability", t):
        return False
    if re.search(r"target (noncreature|instant or sorcery|instant|sorcery)? ?spell", t) and "target creature spell" not in t:
        return "Lightning Bolt", ["Mountain"]
    if "target creature spell" in t:
        return "Ambush Viper", ["Forest", "Wastes"]
    return "Lightning Bolt", ["Mountain"]


def scenario_for(name, face):
    types = face["card_type"]["core_types"]
    if "Land" in types:
        step = {"seat": 0, "play": face["name"]}
        lands = []
    else:
        lands = lands_for(face["mana_cost"])
        if lands is None:
            return None
        # X in an additional cost ("pay X life") is each AI's own pick, like an X spell.
        text = face.get("oracle_text") or ""
        if any("additional cost" in s and re.search(r"\bX\b", s) for s in text.split(".")):
            return None
        step = {"seat": 0, "cast": face["name"]}
    steps = [step]
    seat0_board = list(SEAT0_BOARD)
    # Convoke and improvise are each AI's pick of what to tap; with the creature tapped, both
    # engines pay with the lands.
    if re.search(r"\b(convoke|improvise)\b", (face.get("oracle_text") or "").lower()):
        seat0_board = [{"card": c, "tapped": True} for c in SEAT0_BOARD]
    seat1_board, seat1_hand = list(SEAT1_BOARD), list(SEAT1_HAND)
    # A counterspell needs a spell to counter: the opponent casts one first, at instant speed.
    first = spell_to_counter(face.get("oracle_text") or "") if "Instant" in types else None
    if first:
        spell, its_lands = first
        seat1_board += its_lands
        seat1_hand.append(spell)
        steps.insert(0, {"seat": 1, "cast": spell})
    elif first is False:
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return {
        "name": f"card-{slug}",
        "about": f"Generated: cast {face['name']} on the standard sweep board.",
        "auto_targets": True,
        "seats": [
            {"battlefield": lands + seat0_board, "hand": [face["name"], "Wastes"], "graveyard": SEAT0_GRAVE, "library": LIBRARY},
            {"battlefield": seat1_board, "hand": seat1_hand, "graveyard": SEAT1_GRAVE, "library": LIBRARY},
        ],
        "script": steps,
    }


def refused(error):
    """The engine wouldn't cast or play the scripted card (as opposed to failing later)."""
    return bool(error) and error.startswith(("phase refused CastSpell", "phase refused PlayLand",
                                             "Forge would not play step", "Forge won't let seat",
                                             "phase chose no targets"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cards")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--out", default="/tmp/yama-referee/sweep")
    args = ap.parse_args()

    card_data = card_data_path()
    print(f"card data {card_data}", file=sys.stderr)
    with open(card_data) as fh:
        db = json.load(fh)
    names = json.load(open(args.cards))[args.offset:args.offset + args.limit]

    out = args.out
    for sub in ("scenarios", "resolved"):
        shutil.rmtree(os.path.join(out, sub), ignore_errors=True)
        os.makedirs(os.path.join(out, sub))
    skipped, written = [], []
    for name in names:
        face = db.get(name.lower()) or db.get(name.split(" // ")[0].lower())
        if face is None:
            skipped.append((name, "not in phase's card data"))
            continue
        sc = scenario_for(name, face)
        if sc is None:
            skipped.append((name, "X, X in an additional cost, or no mana cost"))
            continue
        path = os.path.join(out, "scenarios", sc["name"] + ".json")
        json.dump(sc, open(path, "w"), indent=1)
        written.append(path)
    del db

    # phase picks the targets...
    phase_out = os.path.join(out, "phase.json")
    subprocess.run([os.path.join(ROOT, "target/release/referee"), "--card-data", card_data, "--out", phase_out] + written,
                   check=True, stderr=open(os.path.join(out, "phase.log"), "w"))
    phase = json.load(open(phase_out))
    resolved = []
    for path, r in zip(written, phase):
        sc = r.get("resolved") or json.load(open(path))
        rp = os.path.join(out, "resolved", os.path.basename(path))
        json.dump(sc, open(rp, "w"), indent=1)
        resolved.append(rp)

    # ...and Forge replays them.
    forge_out = os.path.join(out, "forge.json")
    referee = os.environ.get("FORGE_REFEREE", os.path.expanduser("~/Developer/forge-referee"))
    subprocess.run([os.path.join(referee, "run.sh"), forge_out] + resolved, check=True)
    forge = {r["scenario"]: r for r in json.load(open(forge_out))}

    report, counts = [], {}
    for r in phase:
        name = r["scenario"]
        f = forge.get(name, {"error": "Forge has no result"})
        p = {k: v for k, v in r.items() if k != "resolved"}
        if refused(p.get("error")) and refused(f.get("error")):
            # Both engines say the card can't be cast on this board.
            verdict = "both-refuse"
        elif f.get("error") and p.get("error"):
            verdict = "both-error"
        elif p.get("error"):
            verdict = "phase-error"
        elif f.get("error"):
            verdict = "forge-error"
        else:
            verdict = "agree" if not diff(f, p) else "differ"
        counts[verdict] = counts.get(verdict, 0) + 1
        entry = {"scenario": name, "verdict": verdict, "phase_error": p.get("error"), "forge_error": f.get("error"),
                 "ms": {"phase": p.get("ms"), "forge": f.get("ms")}}
        if verdict == "differ":
            entry["differences"] = [{"path": a, "forge": b, "phase": c} for a, b, c in diff(f, p)]
            entry["log"] = {"forge": f.get("log", []), "phase": p.get("log", [])}
        report.append(entry)
    json.dump({"skipped": skipped, "results": report}, open(os.path.join(out, "report.json"), "w"), indent=1)

    for e in report:
        if e["verdict"] != "agree":
            detail = e.get("phase_error") or e.get("forge_error") or "; ".join(
                f"{d['path']}" for d in e.get("differences", [])[:3])
            print(f"{e['verdict']:12} {e['scenario']}: {str(detail)[:160]}")
    phase_ms = sum(e["ms"]["phase"] or 0 for e in report)
    forge_ms = sum(e["ms"]["forge"] or 0 for e in report)
    print(f"\n{len(report)} run, {len(skipped)} skipped: {counts}")
    print(f"time in scenarios: phase {phase_ms} ms, forge {forge_ms} ms")


if __name__ == "__main__":
    main()
