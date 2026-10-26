# Referee: phase checked against Forge

Each scenario sets up a board, plays a few scripted moves, and records the final state. The same scenario runs in phase (Yama's engine) and in Forge, and `compare.py` reports where they disagree. A disagreement is a question for the Comprehensive Rules, not a verdict: Forge is sometimes the one that's wrong.

```
referee/run.sh                      # every scenario
referee/run.sh referee/scenarios/rest-in-peace-bolt.json
```

Results go to `/tmp/yama-referee` (`forge.json`, `phase.json`, `report.json` with both engines' game logs). The exit status is 1 when any scenario differs or errors.

## Setup

- **phase runner:** `cargo build --release -p yama-play --bin referee` (`play/src/bin/referee.rs`). It reads the engine card data in `data/engine/`.
- **Forge runner:** `~/Developer/forge-referee` (or `FORGE_REFEREE`), outside this repo, built with its `build.sh` against a Forge release (`FORGE_DIR`, default `~/Developer/forge-engine/forge-2.0.15`) and Java 17. It uses Forge as a library, so it lives apart from Yama and phase; no Forge code is in this repo.

## Scenarios

`scenarios/*.json`:

```json
{
  "name": "rest-in-peace-bolt",
  "about": "What the scenario tests, with the rule.",
  "format": "standard",          // or "commander"
  "active": 0,                   // whose turn; default 0
  "phase": "main1",              // upkeep, draw, main1, main2, end
  "seats": [
    { "life": 20,
      "battlefield": ["Mountain", { "card": "Grizzly Bears", "tapped": true, "sick": true, "damage": 1, "counters": { "+1/+1": 2 } }],
      "hand": ["Lightning Bolt"], "graveyard": [], "exile": [],
      "library": ["Island", "Swamp"] },          // top first
    {}
  ],
  "script": [
    { "seat": 0, "cast": "Lightning Bolt", "targets": [{ "seat": 1, "card": "Grizzly Bears" }] },
    { "seat": 0, "activate": "Prodigal Pyromancer", "ability": 0, "targets": [{ "seat": 1 }] }
  ]
}
```

- The board is placed directly: nothing triggers for it. Permanents start untapped and without summoning sickness unless the spec says otherwise.
- A step runs when its seat next has priority. `ability` counts the card's activated abilities in printed order, leaving out mana abilities. A target is a seat (a player) or a card that seat controls; `"zone"` finds it in another zone.
- Everything the script doesn't decide, mana payment included, is each engine's own AI. Seats never start anything themselves. The run stops when the script is done and the stack is empty.
- No combat yet: nobody attacks or blocks.
- `{"seat": 0, "play": "Forest"}` plays a land. A step may give `"modes": [0, 2]` (printed order) for a modal spell.
- `"trigger_targets": [{"source": "Shriekmaw", "targets": [...]}]` gives a triggered ability's targets, used by the first trigger from that card that targets; `"trigger_modes"` the same for a triggered or activated ability's modes; `"named_choices": [{"kind": "creature_type" | "color" | "card_name", "value": ...}]` answers "choose a ..." in order.
- `"auto_targets": true` lets the phase runner make those choices itself by a fixed rule (an opponent's creature first, the creature type most of your creatures share, ...) and report the scenario with them written out as `resolved`; the Forge run then replays that, so both engines choose alike. Scripted casts pay the printed cost (no kicker, evoke or other alternative cost) and play a card's front face.

## Card sweep

Recreate the weighted card list from the real-deck corpus with the existing deck
files (each card counts once per deck, basic lands excluded):

```sh
python3 referee/corpus.py --decks-root ../commander-decks/data/sim/decks --out /tmp/yama-corpus.json
python3 referee/sweep.py /tmp/yama-corpus.json --limit 10000 --out /tmp/yama-referee/sweep
```

`corpus.py` also accepts `--card-data FILE --compare PREVIOUS_FILE --report FILE`
to compare explicit unsupported effects, warnings and missing names. Those are
parser diagnostics, not a rules-correctness percentage. The dated baseline and
recovery results are in [the recovery report](../docs/engine-recovery-2026-10-25.md).

`python3 referee/sweep.py CARDS.json [--offset N] [--limit N] [--out DIR]` generates one scenario per card (a fixed two-player board with the lands for the card's cost and something of each kind to target; all-Wastes libraries so searches and draws can't differ), runs phase with `auto_targets`, has Forge replay the resolved scenarios, and reports per card: agree, differ, phase-error, forge-error, both-error. X spells and X in additional costs are skipped. The card data must match the engine build: both scripts use the file `deploy/first-time.sh` pins unless `YAMA_ENGINE_CARD_DATA` says otherwise.

The final state lists, per seat: life, poison, hand, graveyard and exile (sorted names), library size, and each permanent it controls (name, owner, tapped, power, toughness and damage for creatures, counters, token, what it's attached to); plus the stack, phase, turn and whether the game is over. Forge's token names drop "Token".

## From a difference to a fix (clean room)

phase is MIT and we send fixes upstream, so no Forge code or card script may reach phase, even rewritten. Three roles, kept apart:

1. **Referee keeper** maintains `forge-referee`, which means reading Forge's API. This role never writes specs or phase code.
2. **Spec writer** gets a difference from `report.json` (the scenario, both final states, both game logs), the cards' Oracle text and the Comprehensive Rules. Never Forge's source or card scripts. Writes `referee/specs/<scenario>.md`: what should happen, which engine is right, and the rule numbers that say so. If the rules side with phase, the spec says so and the difference is noted as a Forge bug.
3. **Implementer** gets the spec and phase's code and fixes phase, adding a phase test whose expected values come from the spec. That test doesn't need Forge, so it can go upstream with the fix.

Agents in one role don't take on another for the same difference.
